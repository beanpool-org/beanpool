/**
 * Pillar Sync Engine — Delta-Only Background Sync
 *
 * This is the core of the Pillar Toggle. It runs as a background task
 * and performs incremental MST (Merkle Search Tree) comparison with
 * the BeanPool node.
 *
 * Rules:
 * 1. FAIL FAST — If sync takes > 20 seconds, checkpoint and abort.
 * 2. DELTA ONLY — Compare hashes first, only pull changed data.
 * 3. PRUNING — Keep only current state + last ~1,000 transactions.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { BeanPoolMerkleTree } from '@beanpool/core';
import { applyDelta, fetchFriendsFromServer, getDb } from '../utils/db';
import { getDatabaseFilenameForNode } from '../utils/nodes';

const SYNC_TIMEOUT_MS = 20_000;
const MAX_STORED_TRANSACTIONS = 1000;
const StorageKeysConfig = {
    MERKLE_ROOT: 'merkle-root',
    LAST_SYNC: 'last-sync',
    ACCOUNTS: 'accounts',
    TRANSACTIONS: 'transactions',
    SYNC_CHECKPOINT: 'checkpoint',
};

export async function getSyncCursorKey(keyId: string): Promise<string> {
    const url = await AsyncStorage.getItem('beanpool_anchor_url');
    return `pillar_sync_${getDatabaseFilenameForNode(url)}_${keyId}`;
}

export interface SyncResult {
    success: boolean;
    merkleRoot: string | null;
    deltaCount: number;
    durationMs: number;
    aborted: boolean;
    errorMessage?: string;
}

/**
 * Discover the BeanPool node URL.
 * Tries beanpool.local first, then falls back to saved address.
 */
async function discoverAnchor(): Promise<string | null> {
    const candidates: string[] = [];
    
    // Explicit saved anchor takes absolute priority
    try {
        const savedAnchor = await AsyncStorage.getItem('beanpool_anchor_url');
        if (savedAnchor) {
            // NEVER fallback to a different community if an explicit anchor has been set via Invite.
            return savedAnchor;
        }
    } catch (e) {}

    if (__DEV__) {
        candidates.push(
            // Local development (Highest Priority)
            'https://beanpool.local:8443',
            'http://beanpool.local:8080',
            'http://localhost:8080',
            'http://127.0.0.1:8080',
            'http://10.0.2.2:8080',
            'https://localhost:8443',
            'https://127.0.0.1:8443',
            'https://10.0.2.2:8443',
            'http://localhost:8080',
            'http://127.0.0.1:8080',
            'http://10.0.2.2:8080',
        );

        // Attempt to derive Expo LAN IP for physical dev devices
        const hostUri = Constants.experienceUrl || Constants.expoConfig?.hostUri;
        if (hostUri) {
            // hostUri is usually something like "192.168.1.100:8081"
            const match = hostUri.match(/([0-9.]+):/);
            if (match && match[1]) {
                candidates.push(`https://${match[1]}:8443`);
                candidates.push(`http://${match[1]}:8080`);
            }
        }
    }

    // Clear saved node address temporarily to force Azure discovery
    await AsyncStorage.removeItem('pillar:anchor-url');

    for (const url of candidates) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        try {
            const res = await fetch(`${url}/api/community/health`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (res.ok) {
                // Any 200 OK response from /api/community/health means the node is BeanPool aware.
                // Cache the successful URL
                await AsyncStorage.setItem('beanpool_anchor_url', url);
                return url;
            }
        } catch (e) {
            clearTimeout(timeoutId);
            // Ignore fetch errors
        }
    }

    return null;
}

let isSyncing = false;

/**
 * Perform the delta-only sync.
 * Returns immediately if hashes match (0 bytes transferred).
 */
export async function performSync(): Promise<SyncResult> {
    if (isSyncing) return { success: false, merkleRoot: null, deltaCount: 0, durationMs: 0, aborted: true, errorMessage: 'Already syncing' };
    isSyncing = true;
    const startTime = Date.now();
    const deadline = startTime + SYNC_TIMEOUT_MS;

    const result: SyncResult = {
        success: false,
        merkleRoot: null,
        deltaCount: 0,
        durationMs: 0,
        aborted: false,
    };

    try {
        // Step 1: Discover BeanPool Node
        console.log('[Pillar Sync] Discovering anchor node...');
        const anchorUrl = await discoverAnchor();
        if (!anchorUrl) {
            console.warn('[Pillar Sync] ❌ No anchor found — all candidates failed');
            result.durationMs = Date.now() - startTime;
            result.errorMessage = 'All node URLs failed the health check connection.';
            return result;
        }
        console.log(`[Pillar Sync] ✅ Anchor discovered: ${anchorUrl}`);

        // Step 2: Fetch Posts and Balance directly via standard REST APIs
        let identityRaw = null;
        try {
            const SecureStore = require('expo-secure-store');
            identityRaw = await SecureStore.getItemAsync('sovereign-identity');
        } catch (e) {
            console.error('[Pillar Sync] Failed to get identity from SecureStore', e);
        }

        let pubKey = '';
        if (identityRaw) {
            try {
                const id = JSON.parse(identityRaw);
                pubKey = id.publicKey;
                
                // Heal offline profile edits BEFORE downloading old state from server.
                // This is the recovery path behind the "saved locally, will publish when you
                // reconnect" promise, so failures are logged loudly (not silently swallowed)
                // and we confirm the node actually stored the avatar before clearing the flag.
                const pendingSync = await AsyncStorage.getItem('pending_profile_sync');
                if (pendingSync === 'true') {
                    try {
                        const { getMemberProfile } = await import('../utils/db');
                        const profile = await getMemberProfile(pubKey);
                        if (!profile) {
                            // Nothing to publish — clear the stale flag so it doesn't loop forever.
                            console.warn('[Pillar Sync] Profile heal: pending flag set but no local profile found — clearing stale flag');
                            await AsyncStorage.removeItem('pending_profile_sync');
                        } else {
                            const { buildSignedHeaders } = require('../utils/crypto');
                            const payloadObj = {
                                publicKey: pubKey,
                                avatar: profile.avatar_url,
                                bio: profile.bio,
                                contact: profile.contact_value ? { value: profile.contact_value, visibility: profile.contact_visibility || 'community' } : null,
                                callsign: profile.callsign,
                            };
                            const bodyString = JSON.stringify(payloadObj);
                            const headers = await buildSignedHeaders('POST', '/api/profile/update', bodyString, id.privateKey, pubKey);
                            const res = await fetch(`${anchorUrl}/api/profile/update`, {
                                method: 'POST',
                                headers,
                                body: bodyString
                            });
                            if (res.ok) {
                                // A 200 alone isn't proof: if we sent an avatar but the node came
                                // back with none, the write didn't take — keep the flag and retry
                                // rather than silently giving up (this is what stranded Jay's pic).
                                const localAvatar = profile.avatar_url || null;
                                let avatarPersisted = true;
                                try {
                                    const data = await res.json();
                                    const savedAvatar = (data?.profile?.avatar) || null;
                                    if (localAvatar && !savedAvatar) avatarPersisted = false;
                                } catch { /* non-JSON body — trust the 2xx */ }
                                if (avatarPersisted) {
                                    await AsyncStorage.removeItem('pending_profile_sync');
                                    console.log('[Pillar Sync] Successfully healed pending profile sync');
                                } else {
                                    console.warn('[Pillar Sync] Profile heal: node accepted the request but did not store the avatar — keeping pending flag for retry');
                                }
                            } else {
                                const errText = await res.text().catch(() => '');
                                console.warn(`[Pillar Sync] Profile heal rejected (HTTP ${res.status}) — will retry next sync:`, errText.slice(0, 200));
                            }
                        }
                    } catch (healErr) {
                        console.warn('[Pillar Sync] Profile heal attempt failed (will retry next sync):', healErr);
                    }
                }
            } catch (e) {}
        }

        // Fetch both sets concurrently
        
        let lastSyncParam = '';
        let incrementalSinceIso = '';
        try {
            const kLastSync = await getSyncCursorKey(StorageKeysConfig.LAST_SYNC);
            const lastSync = await AsyncStorage.getItem(kLastSync);
            if (lastSync) {
                // Incorporate a 5-minute time buffer to account for clock drift between client and server
                const driftAdjusted = Math.max(0, parseInt(lastSync, 10) - 300_000);
                // Convert numeric timestamp to ISO-8601 string for SQLite comparison
                incrementalSinceIso = new Date(driftAdjusted).toISOString();
                lastSyncParam = `&updatedAfter=${encodeURIComponent(incrementalSinceIso)}`;
            }
        } catch (e) {}

        const kLastMembersSync = await getSyncCursorKey('members_last_sync');
        const lastMembersSync = await AsyncStorage.getItem(kLastMembersSync);
        
        let localMembersCount = 0;
        try {
            const database = await getDb();
            const membersRow = await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM members');
            localMembersCount = membersRow?.count || 0;
        } catch (e) {
            console.error('[Pillar Sync] Failed to query local members count', e);
        }

        const shouldFetchMembers = !lastMembersSync || 
                                   (Date.now() - parseInt(lastMembersSync, 10)) > 3600_000 ||
                                   localMembersCount === 0;

        const postsController = new AbortController();
        const balanceController = new AbortController();
        const postsTimeout = setTimeout(() => postsController.abort(), 30000); // Extended for heavy initial payloads
        const balanceTimeout = setTimeout(() => balanceController.abort(), 30000);

        let postsData = [];
        try {
            const postsRes = await fetch(`${anchorUrl}/api/marketplace/posts?limit=1000&sync=true${lastSyncParam}&_t=${Date.now()}`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                signal: postsController.signal
            });
            if (!postsRes.ok) {
                clearTimeout(postsTimeout);
                clearTimeout(balanceTimeout);
                result.durationMs = Date.now() - startTime;
                result.errorMessage = `Posts fetch failed with status: ${postsRes.status}`;
                return result;
            }
            postsData = await postsRes.json();
            console.log(`[Pillar Sync] Received ${Array.isArray(postsData) ? postsData.length : 'non-array'} posts from server`);
        } catch (e: any) {
            clearTimeout(postsTimeout);
            clearTimeout(balanceTimeout);
            result.durationMs = Date.now() - startTime;
            result.errorMessage = `Posts fetch exception: ${e.message || e}`;
            return result;
        }

        const delta: any = {
            posts: Array.isArray(postsData) ? postsData : [],
            accounts: [],
            transactions: [],
            members: [],
            projects: []
        };

        // Fetch balance
        if (pubKey) {
            try {
                const balanceRes = await fetch(`${anchorUrl}/api/ledger/balance/${pubKey}?_t=${Date.now()}`, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                    signal: balanceController.signal
                });
                if (balanceRes.ok) {
                    const balData = await balanceRes.json();
                    delta.accounts.push({
                        public_key: pubKey,
                        balance: balData.balance || 0,
                        last_demurrage_epoch: balData.last_demurrage_epoch || 0
                    });
                }
            } catch (e) {
                console.warn('[Pillar Sync] Balance fetch failed:', e);
            }
        }

        // Fetch directory (members)
        if (shouldFetchMembers) {
            try {
                const directoryRes = await fetch(`${anchorUrl}/api/members?_t=${Date.now()}`, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                    signal: postsController.signal
                });
                if (directoryRes && directoryRes.ok) {
                    const dirData = await directoryRes.json();
                    if (Array.isArray(dirData)) {
                        delta.members = dirData;
                        // This /api/members fetch returns the FULL directory (no cursor), so it's
                        // safe for applyDelta to garbage-collect local members absent from it.
                        // applyDelta only GCs when this flag is set — a partial member list never
                        // triggers deletion.
                        delta.membersComplete = true;
                        await AsyncStorage.setItem(kLastMembersSync, String(Date.now()));
                    }
                }
            } catch (e) {
                console.warn('[Pillar Sync] Members fetch failed:', e);
            }
        } else if (incrementalSinceIso) {
            // Incremental member delta — runs every sync cycle the full snapshot above does NOT,
            // so new members and avatar/profile changes propagate within seconds (the WebSocket
            // already triggers a sync on member_joined/profile_updated). This is a PARTIAL list,
            // so we must NOT set membersComplete — otherwise applyDelta would garbage-collect
            // every local member absent from this small delta.
            try {
                const deltaRes = await fetch(`${anchorUrl}/api/members?updatedAfter=${encodeURIComponent(incrementalSinceIso)}&_t=${Date.now()}`, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                    signal: postsController.signal
                });
                if (deltaRes && deltaRes.ok) {
                    const deltaData = await deltaRes.json();
                    if (Array.isArray(deltaData) && deltaData.length > 0) {
                        delta.members = deltaData;
                        // membersComplete intentionally left unset (partial list → no GC).
                    }
                }
            } catch (e) {
                console.warn('[Pillar Sync] Incremental members fetch failed:', e);
            }
        }

        // Fetch projects
        try {
            const projectsRes = await fetch(`${anchorUrl}/api/crowdfund/projects?limit=1000${lastSyncParam}&_t=${Date.now()}`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                signal: postsController.signal
            });
            if (projectsRes && projectsRes.ok) {
                const projData = await projectsRes.json();
                if (projData && Array.isArray(projData.projects)) {
                    delta.projects = projData.projects;
                    if (projData.maxProjectExpiryDays) {
                        await AsyncStorage.setItem('beanpool_max_expiry_days', String(projData.maxProjectExpiryDays));
                    }
                } else if (Array.isArray(projData)) {
                    delta.projects = projData;
                }
            }
        } catch (e) {
            console.warn('[Pillar Sync] Projects fetch failed:', e);
        }

        // Fetch transactions
        if (pubKey) {
            try {
                const txRes = await fetch(`${anchorUrl}/api/ledger/transactions?publicKey=${pubKey}&limit=200&_t=${Date.now()}`, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                    signal: balanceController.signal
                });
                if (txRes && txRes.ok) {
                    const txData = await txRes.json();
                    if (Array.isArray(txData)) {
                        delta.transactions = txData;
                    }
                }
            } catch (e) {
                console.warn('[Pillar Sync] Transactions fetch failed:', e);
            }
        }

        // Fetch marketplace transactions
        if (pubKey) {
            try {
                const mkptxRes = await fetch(`${anchorUrl}/api/marketplace/transactions?publicKey=${pubKey}&limit=50&_t=${Date.now()}`, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                    signal: postsController.signal
                });
                if (mkptxRes && mkptxRes.ok) {
                    const mkptxData = await mkptxRes.json();
                    console.log(`[Pillar Sync] Fetched ${mkptxData?.length} marketplaceTransactions from server`);
                    if (Array.isArray(mkptxData)) {
                        delta.marketplaceTransactions = mkptxData;
                    }
                } else if (mkptxRes && !mkptxRes.ok) {
                    console.warn(`[Pillar Sync] market transactions fetch failed: status ${mkptxRes.status}`);
                }
            } catch (e) {
                console.warn('[Pillar Sync] Marketplace transactions fetch failed:', e);
            }
        }

        // Fetch friends
        if (pubKey) {
            try {
                const friendsData = await fetchFriendsFromServer(pubKey);
                if (Array.isArray(friendsData)) {
                    delta.friends = friendsData;
                }
            } catch (e) {
                console.warn('[Pillar Sync] Friends fetch failed:', e);
            }
        }

        clearTimeout(postsTimeout);
        clearTimeout(balanceTimeout);

        // Gate applyDelta per table: skip any table whose fetched payload is identical
        // to what we last applied. applyDelta rewrites every row it's given inside one
        // lock-held transaction, and re-applying unchanged data on every WS-triggered
        // cycle was the main writer starving the sync lock (2026-07-18 on-device logs
        // showed 24-minute queue waits). Cheap string hash — worst case on a collision
        // is one skipped no-op apply.
        const gatedDelta: any = {};
        for (const [table, payload] of Object.entries(delta)) {
            if (payload === undefined || table === 'membersComplete') continue;
            const fp = _fingerprint(JSON.stringify(payload));
            if (_lastAppliedFingerprints[`${anchorUrl}:${table}`] !== fp) {
                gatedDelta[table] = payload;
                _lastAppliedFingerprints[`${anchorUrl}:${table}`] = fp;
            }
        }
        // The full-directory GC flag must travel with the members table it describes.
        if (gatedDelta.members && delta.membersComplete) gatedDelta.membersComplete = true;

        // Apply physical updates to local Native device SQLite Matrix
        if (Object.keys(gatedDelta).length > 0) {
            await applyDelta(gatedDelta);
        }

        // Notify active screens to re-render only when something actually changed —
        // an unconditional emit here made every mounted screen reload every cycle.
        if (gatedDelta.posts?.length > 0 || gatedDelta.projects?.length > 0 || gatedDelta.accounts?.length > 0 || gatedDelta.transactions?.length > 0 || gatedDelta.marketplaceTransactions?.length > 0 || gatedDelta.members?.length > 0 || gatedDelta.friends?.length > 0) {
            try {
                const { DeviceEventEmitter } = require('react-native');
                DeviceEventEmitter.emit('sync_data_updated');
            } catch (e) {}
        }

        // Step 3: Success — save timestamp
        const kLastSync = await getSyncCursorKey(StorageKeysConfig.LAST_SYNC);
        const kCheckpoint = await getSyncCursorKey(StorageKeysConfig.SYNC_CHECKPOINT);
        await AsyncStorage.setItem(kLastSync, String(Date.now()));
        await AsyncStorage.removeItem(kCheckpoint);

        result.success = true;
        result.deltaCount = delta.posts.length + delta.accounts.length;
        result.durationMs = Date.now() - startTime;
        return result;

    } catch (err: any) {
        console.log('[Pillar Sync] Offline or Sync Error:', err.message || err);
        result.durationMs = Date.now() - startTime;
        result.errorMessage = String(err?.message || err);
        return result;
    } finally {
        isSyncing = false;
    }
}

export async function getLastSyncTime(): Promise<number | null> {
    const kLastSync = await getSyncCursorKey(StorageKeysConfig.LAST_SYNC);
    const raw = await AsyncStorage.getItem(kLastSync);
    return raw ? Number(raw) : null;
}

/**
 * Get cached accounts for offline display.
 */
export async function getCachedAccounts(): Promise<any[]> {
    const kAccounts = await getSyncCursorKey(StorageKeysConfig.ACCOUNTS);
    const raw = await AsyncStorage.getItem(kAccounts);
    return raw ? JSON.parse(raw) : [];
}

/**
 * Get cached transactions (pruned to ~1,000).
 */
export async function getCachedTransactions(): Promise<any[]> {
    const kTransactions = await getSyncCursorKey(StorageKeysConfig.TRANSACTIONS);
    const raw = await AsyncStorage.getItem(kTransactions);
    return raw ? JSON.parse(raw) : [];
}

// Per-node, per-table hash of the last payload handed to applyDelta (see the gate
// in performSync). In-memory only — first sync after a cold start always applies.
const _lastAppliedFingerprints: Record<string, number> = {};
function _fingerprint(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; // djb2
    return h;
}

let syncPromise: Promise<SyncResult> | null = null;
let needsAnotherSync = false;
let debounceTimeoutId: NodeJS.Timeout | null = null;

/**
 * Coordinated request wrapper. Ensures that only one performSync executes at a time,
 * and debounces rapid consecutive calls (e.g. WebSocket updates) with a 150ms window.
 * If another sync is requested while one is already running, it queues a single trailing
 * sync to execute after the current sync finishes, ensuring no events are missed.
 */
export async function requestSync(): Promise<void> {
    if (syncPromise) {
        needsAnotherSync = true;
        return;
    }

    if (debounceTimeoutId) {
        clearTimeout(debounceTimeoutId);
        debounceTimeoutId = null;
    }

    return new Promise<void>((resolve) => {
        debounceTimeoutId = setTimeout(() => {
            debounceTimeoutId = null;

            if (syncPromise) {
                needsAnotherSync = true;
                resolve();
                return;
            }

            console.log('[Sync Queue] Starting debounced sync...');
            syncPromise = performSync().catch(err => {
                console.error('[Sync Queue] Sync failed:', err);
                return { success: false, merkleRoot: null, deltaCount: 0, durationMs: 0, aborted: false, errorMessage: String(err) };
            }).finally(() => {
                syncPromise = null;
                if (needsAnotherSync) {
                    needsAnotherSync = false;
                    // Protective 2000ms cooldown delay to prevent infinite consecutive trailing sync loops
                    setTimeout(() => {
                        requestSync();
                    }, 2000);
                }
            });

            syncPromise.then(() => resolve());
        }, 150);
    });
}


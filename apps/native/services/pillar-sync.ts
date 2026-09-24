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
import { BeanPoolMerkleTree, LIVE_POST_TYPES, type LivePostChange } from '@beanpool/core';
import { applyDelta, fetchFriendsFromServer, getDb, localPostTies } from '../utils/db';
import { getDatabaseFilenameForNode } from '../utils/nodes';
import { EVENT_TYPES_QUERY } from '../utils/events';
import { shouldBlockCleartextNodeUrl } from '../utils/node-url';

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
            // Block insecure cleartext HTTP connections to public nodes
            if (shouldBlockCleartextNodeUrl(savedAnchor)) {
                console.warn('[Pillar Sync] 🚫 Blocked cleartext public node URL:', savedAnchor);
                return null;
            }
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
        const hostUri = Constants.expoConfig?.hostUri;
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

    const safeCandidates = candidates.filter(url => !shouldBlockCleartextNodeUrl(url));

    if (safeCandidates.length === 0) {
        return null;
    }

    const controllers: AbortController[] = [];
    try {
        const winningUrl = await Promise.any(
            safeCandidates.map(async (url) => {
                const controller = new AbortController();
                controllers.push(controller);
                const timeoutId = setTimeout(() => controller.abort(), 3000);
                try {
                    const res = await fetch(`${url}/api/community/health`, {
                        method: 'GET',
                        headers: { 'Accept': 'application/json' },
                        signal: controller.signal
                    });
                    if (res.ok) {
                        return url;
                    }
                    throw new Error(`Health check failed with status ${res.status}`);
                } finally {
                    clearTimeout(timeoutId);
                }
            })
        );

        // Any 200 OK response from /api/community/health means the node is BeanPool aware.
        // Cache the successful URL
        await AsyncStorage.setItem('beanpool_anchor_url', winningUrl);
        return winningUrl;
    } catch (e) {
        // Promise.any rejects with AggregateError when all candidates fail
        return null;
    } finally {
        controllers.forEach((c) => c.abort());
    }
}

let isSyncing = false;

// ===================== LIVE LISTING CHANGES =====================
//
// The node sends the whole listing with `new_post` / `post_updated` (and the id with `post_removed`). A public
// offer or need is written straight into the cache here instead of running a catch-up sync for it: one new
// listing used to send every open phone back to the node for every pillar below. The rule for what qualifies
// is @beanpool/core `livePostChange`; services/ws-client.ts routes to this.
//
// A pushed change never moves the sync cursor — the next real sync still asks for everything since the last
// real one, and reconciles anything a push missed. The catch-up sync remains the backstop on reconnect, on
// foreground and on its periodic tick.

// Changes applied, in order, so a cycle in flight can replay the ones that landed after it began. Bounded: a
// cycle that outlives this many pushes leaves the rest to the next cycle.
const LIVE_LOG_MAX = 500;
let liveSeq = 0;
const liveLog: Array<{ seq: number; change: LivePostChange }> = [];

function liveChangesSince(mark: number): { liveChanges?: LivePostChange[] } {
    const changes = liveLog.filter(e => e.seq > mark).map(e => e.change);
    return changes.length > 0 ? { liveChanges: changes } : {};
}

/**
 * Write a pushed listing change into this phone's cache, through applyDelta. Returns false — and writes
 * nothing — when the change should go through the full catch-up sync as it always did:
 *   - the socket's node is no longer the active one (the cache belongs to another community now);
 *   - it is this member's own listing, one they accepted, one they have an open deal on or a conversation
 *     about: one person, not a crowd, and their deals, chats and offer gate need the sync, not just the row;
 *   - a removal of a cached event or poll, whose removal means more than a cancelled row (an event's chat
 *     goes read-only; the rule for pushes is offers and needs only).
 * Throws only if the write itself fails; the caller then rings the doorbell instead.
 */
export async function applyLivePostChange(
    change: LivePostChange,
    ctx: { anchorUrl: string | null; selfPubkey: string | null },
): Promise<boolean> {
    if (!ctx.anchorUrl) return false;
    const expectedDbName = getDatabaseFilenameForNode(ctx.anchorUrl);
    const activeAnchor = await AsyncStorage.getItem('beanpool_anchor_url');
    if (getDatabaseFilenameForNode(activeAnchor) !== expectedDbName) return false;

    const self = ctx.selfPubkey;
    const postId = change.kind === 'upsert' ? change.post.id : change.id;
    if (change.kind === 'upsert' && self && (change.post.authorPublicKey === self || change.post.acceptedBy === self)) return false;
    const ties = await localPostTies(postId);
    if (ties.openDeal || ties.conversation) return false;
    if (self && ties.authorPubkey === self) return false;
    if (change.kind === 'remove' && ties.type !== null && !LIVE_POST_TYPES.has(ties.type)) return false;

    liveLog.push({ seq: ++liveSeq, change });
    if (liveLog.length > LIVE_LOG_MAX) liveLog.splice(0, liveLog.length - LIVE_LOG_MAX);
    await applyDelta({ liveChanges: [change] }, expectedDbName);
    return true;
}

/** DeviceEventEmitter event fired when a performSync cycle ends, with `{ success: boolean }`. */
export const PILLAR_SYNC_ENDED = 'pillar_sync_ended';

/**
 * True while a sync is queued (debounce window) or running. The market uses it so a sync that is
 * still downloading on a slow connection is not reported as "trouble connecting".
 */
export function isPillarSyncActive(): boolean {
    return isSyncing || syncPromise !== null || debounceTimeoutId !== null;
}

/**
 * Perform the delta-only sync.
 * Returns immediately if hashes match (0 bytes transferred).
 */
export async function performSync(onProgress?: (step: number, total: number, stage: string) => void): Promise<SyncResult> {
    if (isSyncing) return { success: false, merkleRoot: null, deltaCount: 0, durationMs: 0, aborted: true, errorMessage: 'Already syncing' };
    isSyncing = true;
    const startTime = Date.now();
    const deadline = startTime + SYNC_TIMEOUT_MS;
    // Pushed listing changes applied after this point are replayed over this cycle's writes (liveChangesSince).
    const liveMark = liveSeq;

    onProgress?.(1, 5, 'Discovering Node Connection...');

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
        // Pin this sync to the node it started on. Everything fetched below
        // belongs to `anchorUrl`; if the user switches communities mid-sync we
        // must NOT apply it to the newly-active node's local DB.
        const expectedDbName = getDatabaseFilenameForNode(anchorUrl);

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
                        // Delegate to the single canonical-aware publisher: it verifies
                        // the node actually stored the avatar before clearing the flag,
                        // and falls back to the canonical picture when THIS node's local
                        // row has none yet (e.g. a freshly-joined second community).
                        const { pushProfileToServer } = await import('../utils/db');
                        const ok = await pushProfileToServer();
                        console.log(ok
                            ? '[Pillar Sync] Successfully healed pending profile sync'
                            : '[Pillar Sync] Profile heal deferred — will retry next sync');
                    } catch (healErr) {
                        console.warn('[Pillar Sync] Profile heal attempt failed (will retry next sync):', healErr);
                    }
                }
            } catch (e) {}
        }

        onProgress?.(2, 5, 'Synchronizing Members & Profiles...');
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

        // If the local posts cache is empty (fresh install, recovery/restore, or a wipe
        // that left the sync cursor behind), an incremental `updatedAfter` fetch would
        // return only recently-changed posts and the market would look empty/incomplete.
        // Force a full re-pull in that case so a wiped cache heals in one sync — this also
        // re-enables the fast-first-paint below. Steady state (posts present) stays incremental.
        // The local count only matters when we already hold a sync cursor; without one it's a
        // full pull regardless, so skip the extra COUNT query on every cursor-less cycle.
        let localPostsCount = 0;
        if (lastSyncParam) {
            try {
                const database = await getDb();
                const postsRow = await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM posts');
                localPostsCount = postsRow?.count || 0;
            } catch (e) {}
        }
        const postsIsIncremental = !!lastSyncParam && localPostsCount > 0;
        const postsSyncParam = postsIsIncremental ? lastSyncParam : '';

        // Each request gets its own 30s budget (extended for heavy initial payloads), started when
        // THAT request starts. Two controllers armed at the top of the cycle used to be shared by
        // every fetch below, so on a slow connection a 29s posts download spent the whole budget and
        // balance, members, projects and both transaction fetches were aborted by us within a second
        // (measured on the emulator, 2026-09-18) — the market then waited for another full cycle.
        const timeouts = requestTimeouts();

        // Tables whose change-status was already decided from the RAW response text
        // this cycle — the stringify gate before applyDelta must not re-hash them.
        const rawGated = new Set<string>();

        let postsData: any;
        try {
            // `types=` opts in to events (docs/events-on-the-map.md §2.6). Without it the node leaves them out, which
            // is what keeps builds that predate events from ever caching one.
            const postsRes = await fetch(`${anchorUrl}/api/marketplace/posts?limit=1000&sync=true&${EVENT_TYPES_QUERY}${postsSyncParam}`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                signal: timeouts.signal(30000)
            });
            if (!postsRes.ok) {
                timeouts.clear();
                result.durationMs = Date.now() - startTime;
                result.errorMessage = `Posts fetch failed with status: ${postsRes.status}`;
                return result;
            }
            postsData = await parseIfChanged(postsRes, anchorUrl, 'posts', rawGated);
            if (postsData !== undefined) {
                console.log(`[Pillar Sync] Received ${Array.isArray(postsData) ? postsData.length : 'non-array'} posts from server`);
            }
        } catch (e: any) {
            timeouts.clear();
            result.durationMs = Date.now() - startTime;
            result.errorMessage = `Posts fetch exception: ${e.message || e}`;
            return result;
        }

        // Tables are added to the delta ONLY when their payload actually changed —
        // applyDelta skips absent tables, so an unchanged fetch costs no parse, no
        // lock and no re-apply.
        const delta: any = {
            accounts: []
        };
        if (Array.isArray(postsData)) delta.posts = postsData;

        // Fast first paint: on the FIRST (full) sync for this node the marketplace is
        // still showing its loading spinner, and the remaining pillars below (balance,
        // members, crowdfund, transactions, ratings) can add several seconds on a slow
        // node before the single end-of-cycle applyDelta runs. Write the posts to SQLite
        // and tell the marketplace to render NOW, then drop them from the batch so we
        // don't re-write the same rows (the double-apply that historically starved the
        // sync lock). Runs only on a FULL posts fetch (first sync, or a healed empty cache)
        // — steady-state incremental cycles keep the single batched apply untouched.
        // Tables applied THIS cycle OUTSIDE the batch (the early fast-paint write).
        // If the batch below fails we must invalidate these fingerprints too —
        // otherwise a write that recorded its fingerprint but didn't durably land
        // (e.g. applyDelta's node-switch contamination guard returned early) would be
        // treated as applied and skipped forever.
        const earlyApplied = new Set<string>();
        if (!postsIsIncremental && Array.isArray(postsData) && postsData.length > 0) {
            try {
                await applyDelta({ posts: postsData, ...liveChangesSince(liveMark) }, expectedDbName);
                earlyApplied.add('posts');
                delete delta.posts;
                rawGated.delete('posts');
                const { DeviceEventEmitter } = require('react-native');
                DeviceEventEmitter.emit('sync_data_updated');
            } catch (e) {
                console.warn('[Pillar Sync] Early posts apply failed (will apply in batch):', e);
            }
        }

        // Fetch balance
        if (pubKey) {
            try {
                const balanceRes = await fetch(`${anchorUrl}/api/ledger/balance/${pubKey}`, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                    signal: timeouts.signal(30000)
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
                const directoryRes = await fetch(`${anchorUrl}/api/members`, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                    signal: timeouts.signal(30000)
                });
                if (directoryRes && directoryRes.ok) {
                    const dirData = await parseIfChanged(directoryRes, anchorUrl, 'members', rawGated);
                    if (dirData !== undefined && Array.isArray(dirData)) {
                        delta.members = dirData;
                        // This /api/members fetch returns the FULL directory (no cursor), so it's
                        // safe for applyDelta to garbage-collect local members absent from it.
                        // applyDelta only GCs when this flag is set — a partial member list never
                        // triggers deletion.
                        delta.membersComplete = true;
                    }
                    // An unchanged directory still counts as a completed hourly check.
                    await AsyncStorage.setItem(kLastMembersSync, String(Date.now()));
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
                const deltaRes = await fetch(`${anchorUrl}/api/members?updatedAfter=${encodeURIComponent(incrementalSinceIso)}`, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                    signal: timeouts.signal(30000)
                });
                if (deltaRes && deltaRes.ok) {
                    // Separate fingerprint key from the full directory (different payload
                    // shape); usually returns [] which the raw gate skips outright. No
                    // rawGated entry — small payloads go through the stringify gate.
                    const deltaData = await parseIfChanged(deltaRes, anchorUrl, 'membersDelta');
                    if (deltaData !== undefined && Array.isArray(deltaData) && deltaData.length > 0) {
                        delta.members = deltaData;
                        // membersComplete intentionally left unset (partial list → no GC).
                    }
                }
            } catch (e) {
                console.warn('[Pillar Sync] Incremental members fetch failed:', e);
            }
        }

        onProgress?.(3, 5, 'Synchronizing Active Posts & Projects...');
        // Fetch projects
        try {
            const projectsRes = await fetch(`${anchorUrl}/api/crowdfund/projects?limit=1000${lastSyncParam}`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                signal: timeouts.signal(30000)
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
                const txRes = await fetch(`${anchorUrl}/api/ledger/transactions?publicKey=${pubKey}&limit=1000`, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                    signal: timeouts.signal(30000)
                });
                if (txRes && txRes.ok) {
                    const txData = await parseIfChanged(txRes, anchorUrl, 'transactions', rawGated);
                    if (txData !== undefined && Array.isArray(txData)) {
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
                const mkptxRes = await fetch(`${anchorUrl}/api/marketplace/transactions?publicKey=${pubKey}&limit=50`, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                    signal: timeouts.signal(30000)
                });
                if (mkptxRes && mkptxRes.ok) {
                    // The heaviest payload of the sync (measured 9.8MB with embedded
                    // cover images) — skipping the parse when unchanged is the
                    // difference between a frozen UI and a no-op.
                    const mkptxData = await parseIfChanged(mkptxRes, anchorUrl, 'marketplaceTransactions', rawGated);
                    if (mkptxData !== undefined) {
                        console.log(`[Pillar Sync] Fetched ${mkptxData?.length} marketplaceTransactions from server`);
                    }
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

        onProgress?.(4, 5, 'Synchronizing Transactions, Ratings & Reviews...');

        // Fetch ratings (preserves review status across database resets)
        if (pubKey) {
            try {
                const [receivedRes, givenRes] = await Promise.all([
                    fetch(`${anchorUrl}/api/ratings/${pubKey}`),
                    fetch(`${anchorUrl}/api/ratings/${pubKey}?direction=given`)
                ]);
                const rList: any[] = [];
                if (receivedRes && receivedRes.ok) {
                    const data = await receivedRes.json();
                    if (Array.isArray(data?.ratings)) rList.push(...data.ratings);
                }
                if (givenRes && givenRes.ok) {
                    const data = await givenRes.json();
                    if (Array.isArray(data?.ratings)) rList.push(...data.ratings);
                }
                if (rList.length > 0) {
                    delta.ratings = rList;
                }
            } catch (e) {
                console.warn('[Pillar Sync] Ratings fetch failed:', e);
            }
        }

        timeouts.clear();

        // Abort if the user switched communities while this sync was in flight:
        // everything fetched belongs to `anchorUrl`, and applying it now would
        // contaminate the newly-active node's local DB. Bail BEFORE advancing the
        // per-table fingerprints so this node re-syncs cleanly on its next cycle.
        const activeAnchorNow = await AsyncStorage.getItem('beanpool_anchor_url');
        if (getDatabaseFilenameForNode(activeAnchorNow) !== expectedDbName) {
            console.warn(`[Pillar Sync] Node switched mid-sync (${anchorUrl} → ${activeAnchorNow}); discarding fetched delta to avoid cross-node contamination.`);
            result.aborted = true;
            result.errorMessage = 'Node switched during sync';
            result.durationMs = Date.now() - startTime;
            return result;
        }

        // Gate applyDelta per table: skip any table whose fetched payload is identical
        // to what we last applied. applyDelta rewrites every row it's given inside one
        // lock-held transaction, and re-applying unchanged data on every WS-triggered
        // cycle was the main writer starving the sync lock (2026-07-18 on-device logs
        // showed 24-minute queue waits). Cheap string hash — worst case on a collision
        // is one skipped no-op apply.
        const gatedDelta: any = {};
        for (const [table, payload] of Object.entries(delta)) {
            if (payload === undefined || table === 'membersComplete') continue;
            // Raw-gated tables were already proven changed from the response text —
            // re-serializing a multi-MB payload here would block the JS thread.
            if (rawGated.has(table)) {
                gatedDelta[table] = payload;
                continue;
            }
            const fp = _fingerprint(JSON.stringify(payload));
            if (_lastAppliedFingerprints[`${anchorUrl}:${table}`] !== fp) {
                gatedDelta[table] = payload;
                _lastAppliedFingerprints[`${anchorUrl}:${table}`] = fp;
            }
        }
        // The full-directory GC flag must travel with the members table it describes.
        if (gatedDelta.members && delta.membersComplete) gatedDelta.membersComplete = true;
        // Listings the node pushed while this cycle was in flight. Its posts pull may have left before them, and
        // applyDelta writes these after `posts`, so a push is never undone by the older copy this cycle carries.
        // Not a table: never fingerprinted, never a reason to tell the screens something changed.
        Object.assign(gatedDelta, liveChangesSince(liveMark));

        onProgress?.(5, 5, 'Finalizing Local SQLite Database Cache...');
        // Apply physical updates to local Native device SQLite Matrix
        if (Object.keys(gatedDelta).length > 0) {
            try {
                await applyDelta(gatedDelta, expectedDbName);
            } catch (applyErr) {
                // parseIfChanged / the stringify gate already recorded these payloads'
                // fingerprints as "applied". If the write actually failed (e.g. a DB
                // closing mid wipe/restore), leaving those fingerprints in place makes
                // the NEXT sync treat the unchanged payload as up-to-date and skip it
                // forever — the marketplace then stays permanently empty despite the
                // server having posts. Invalidate the fingerprints for every table we
                // tried to write this cycle — the batch AND the early fast-paint apply
                // — so the next sync re-fetches and re-applies.
                for (const table of new Set([...Object.keys(gatedDelta), ...earlyApplied])) {
                    delete _lastAppliedFingerprints[`raw:${anchorUrl}:${table}`];
                    delete _lastAppliedFingerprints[`${anchorUrl}:${table}`];
                }
                throw applyErr;
            }
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

        // A completed pillar cycle means the marketplace posts have actually been fetched
        // and written — the true "the market has loaded" signal, as opposed to a fast
        // messages/balance sync that also fires 'sync_data_updated'. Emitted unconditionally
        // on success so the marketplace dismisses its spinner even when the market is
        // genuinely empty. Kept separate from 'sync_data_updated' (which fires only when
        // data changed and drives list refreshes).
        try {
            const { DeviceEventEmitter } = require('react-native');
            DeviceEventEmitter.emit('pillar_sync_done');
        } catch (e) {}

        result.success = true;
        result.deltaCount = (delta.posts?.length || 0) + (delta.accounts?.length || 0);
        result.durationMs = Date.now() - startTime;
        return result;

    } catch (err: any) {
        console.log('[Pillar Sync] Offline or Sync Error:', err.message || err);
        result.durationMs = Date.now() - startTime;
        result.errorMessage = String(err?.message || err);
        return result;
    } finally {
        isSyncing = false;
        // Every finished cycle, success or not, so a screen waiting on the first sync can tell
        // "still working on a slow connection" from "this cycle failed". Emitted after isSyncing
        // is cleared.
        try {
            const { DeviceEventEmitter } = require('react-native');
            DeviceEventEmitter.emit(PILLAR_SYNC_ENDED, { success: result.success });
        } catch (e) {}
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

/**
 * Reset all in-memory payload fingerprints. Must be called when clearing or resetting
 * the local SQLite database so the subsequent sync doesn't skip applying payloads.
 */
export function resetSyncFingerprints() {
    for (const key of Object.keys(_lastAppliedFingerprints)) {
        delete _lastAppliedFingerprints[key];
    }
}

function _fingerprint(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; // djb2
    return h;
}

// Parse a fetch response only when its RAW text differs from the last payload we
// applied for this table. Hashing the raw string costs ~10ms/MB; JSON.parse of a
// multi-MB payload freezes the phone's JS thread for seconds — which is what
// delayed the send button and dropped typed characters in chat. Returns undefined
// when unchanged (caller leaves the table out of the delta). Keys are namespaced
// 'raw:' so they never collide with the stringify-gate keys; tables verified here
// are added to `rawGated` so the stringify gate doesn't re-hash the same payload.
async function parseIfChanged(res: { text(): Promise<string> }, anchorUrl: string, table: string, rawGated?: Set<string>): Promise<any | undefined> {
    const raw = await res.text();
    const key = `raw:${anchorUrl}:${table}`;
    const fp = _fingerprint(raw);
    if (_lastAppliedFingerprints[key] === fp) return undefined;
    _lastAppliedFingerprints[key] = fp;
    rawGated?.add(table);
    return JSON.parse(raw);
}

/**
 * Per-request abort timers for one sync cycle. A timer starts when its request starts and is left
 * running until `clear()`, so it also bounds reading that request's body; firing after the request
 * has finished aborts nothing.
 */
function requestTimeouts() {
    const timers: ReturnType<typeof setTimeout>[] = [];
    return {
        signal(ms: number): AbortSignal {
            const controller = new AbortController();
            timers.push(setTimeout(() => controller.abort(), ms));
            return controller.signal;
        },
        clear() {
            timers.forEach(clearTimeout);
            timers.length = 0;
        },
    };
}

let syncPromise: Promise<SyncResult> | null = null;
let needsAnotherSync = false;
// `ReturnType<typeof setTimeout>` rather than `NodeJS.Timeout`: React Native's own types return
// a number here, Node's return a Timeout object, and which one wins depends on whether anything
// in the workspace has pulled @types/node into scope. Adding a test runner to this app did
// exactly that. This spelling is correct under either.
let debounceTimeoutId: ReturnType<typeof setTimeout> | null = null;

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


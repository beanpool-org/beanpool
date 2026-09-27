/**
 * The people a member has blocked, kept on this phone under the account that blocked them.
 *
 * One list per account (storage-keys.ts `blockedUsersStoreKey`), of the blocked people's keys only. Every read and
 * write is for the account the phone holds now; with none, the list is empty and nothing can be blocked. When the
 * phone's account changes (identity.ts announces every write of its key, account-on-phone.ts), the list in memory goes
 * and the screens get {@link BLOCKLIST_UPDATED_EVENT} with the new account's list, without a restart.
 *
 * An account that leaves the phone (Sign Out, Replace, the node-mismatch delete) keeps its list here under its own key:
 * restored, it has its blocks back, and no other account on the phone ever reads them. Wiping the list instead would
 * unblock everyone a member had blocked, without telling them, the moment they signed out and back in (Marty,
 * 2026-09-27: the list is the account's).
 *
 * Builds before this one kept one list for the whole phone. It moves under the account on the phone when this build
 * starts ({@link moveAtStart}), before anything can change that account.
 *
 * A block also reports the person to the community's moderators (Apple Guideline 1.2). A report the node didn't take is
 * queued under the account that made it and retried when the app comes back ({@link retryPendingReports}). A node files
 * a report as whoever signs it, so a report goes out only signed by the key that made it ({@link sendReport}): never by
 * the next account on the phone.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { DeviceEventEmitter } from 'react-native';
import { onAccountOnPhone } from './account-on-phone';
import { loadIdentity } from './identity';
import { signedPost } from './node-post';
import { blockedUsersStoreKey, PENDING_ABUSE_REPORTS_STORE_KEY, pendingAbuseReportsStoreKey } from './storage-keys';

export const BLOCKLIST_UPDATED_EVENT = 'beanpool_blocklist_updated';

/** The list the builds before this one kept for the whole phone (AsyncStorage, and SecureStore before that). */
const PHONE_WIDE_LIST_KEY = 'beanpool_blocked_users';
/** Set once the phone-wide list has gone to an account: it is never read again. */
const PHONE_WIDE_LIST_MOVED_KEY = 'beanpool_blocked_users_moved';
const ANCHOR_STORE_KEY = 'beanpool_anchor_url';
const REPORTS_PATH = '/api/reports';
const REPORT_TIMEOUT_MS = 12000;

interface PendingReport {
    reporterPubkey: string;
    targetPubkey: string;
    reason: string;
    postId?: string;
    timestamp: number;
}

/** The account the phone holds, as far as this module knows: undefined until it has been read or announced. */
let knownOwner: string | null | undefined;
/** The list in memory, and whose it is. */
let cached: { owner: string; list: string[] } | null = null;
/** Goes up with each account change, so what was read for the account before never lands as the next one's. */
let accountGeneration = 0;
let phoneWideListMoved = false;
/** The move of the phone-wide list under way, if any: one at a time, so it goes to one account only. */
let movingPhoneWideList: Promise<void> | null = null;
/** The account the phone held as this build started, read at that moment: the phone-wide list is its. */
let ownerAtStart: string | null = null;

onAccountOnPhone((publicKey) => {
    // The same account written again (a new name, its words added): nothing changes.
    if (publicKey === knownOwner) return;
    accountGeneration += 1;
    knownOwner = publicKey;
    cached = null;
    const generation = accountGeneration;
    void getBlockedUsers().then((list) => {
        if (generation === accountGeneration) DeviceEventEmitter.emit(BLOCKLIST_UPDATED_EVENT, list);
    });
});

/** Begun as this module loads, which is at app start (`_layout.tsx` imports it); every other move waits for it. */
const startedMove: Promise<void> = moveAtStart();

/** The public key of the account the phone holds, or null when it holds none. */
async function accountOnPhone(): Promise<string | null> {
    if (knownOwner !== undefined) return knownOwner;
    const generation = accountGeneration;
    const owner = (await loadIdentity())?.publicKey || null;
    // An account change announced while reading is the answer now.
    if (generation !== accountGeneration) return knownOwner ?? null;
    // No key read is not remembered: a read that failed is tried again next time.
    if (owner) knownOwner = owner;
    return owner;
}

function parseKeys(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
    } catch {
        return [];
    }
}

/**
 * The list the builds before this one kept for the whole phone goes to the account on the phone when this build starts,
 * and the old keys go. Once: a marker says it is done, so a copy that could not be deleted is never handed to a later
 * account.
 *
 * At start, not at the first list read: a phone can start on a screen that reads no list (a half-finished join wizard
 * opens Welcome) and Replace its account from there. Moved at the first read, the old list would go to the replacing
 * account, and the member whose blocks they are would find them gone (confirmation review 4113557050). The account is
 * read at the moment the app starts, and an account written while that read is out doesn't change the answer.
 */
async function moveAtStart(): Promise<void> {
    try {
        ownerAtStart = (await loadIdentity())?.publicKey || null;
        if (ownerAtStart) await moveOnce(ownerAtStart);
    } catch (e) {
        console.warn('[blocklist] Could not move the phone-wide list at start; the first list read tries again', e);
    }
}

/**
 * Every list read and "Unblock All" first waits for the move begun at start. If that didn't happen (the phone held no
 * account then, or storage failed), it happens now, still for the account on the phone at start when there was one,
 * and only once however many callers race.
 *
 * A phone with no account at start leaves the list where it is until one appears, and it goes to that account. Such a
 * list was left by an older build's Sign Out, and the next account is likeliest the same member restoring theirs:
 * dropping the list would silently unblock everyone they blocked, the outcome Marty ranked worse. The other outcome, a
 * new account getting it, is what the older build did anyway; it happens at most once per phone, and that account sees
 * the list in Settings and can clear it.
 */
async function movePhoneWideList(owner: string): Promise<void> {
    await startedMove;
    if (phoneWideListMoved) return;
    if (!movingPhoneWideList) {
        movingPhoneWideList = moveOnce(ownerAtStart ?? owner).finally(() => {
            movingPhoneWideList = null;
        });
    }
    return movingPhoneWideList;
}

async function moveOnce(owner: string): Promise<void> {
    if (await AsyncStorage.getItem(PHONE_WIDE_LIST_MOVED_KEY)) {
        phoneWideListMoved = true;
        return;
    }
    // The SecureStore copy counts only when AsyncStorage has none, as it did when the list was read from there.
    const phoneWide = (await AsyncStorage.getItem(PHONE_WIDE_LIST_KEY))
        || (await SecureStore.getItemAsync(PHONE_WIDE_LIST_KEY).catch(() => null));
    const inherited = parseKeys(phoneWide);
    if (inherited.length > 0) {
        const key = blockedUsersStoreKey(owner);
        const own = parseKeys(await AsyncStorage.getItem(key));
        await AsyncStorage.setItem(key, JSON.stringify([...new Set([...own, ...inherited])]));
    }
    await AsyncStorage.setItem(PHONE_WIDE_LIST_MOVED_KEY, '1');
    phoneWideListMoved = true;
    await AsyncStorage.removeItem(PHONE_WIDE_LIST_KEY);
    await SecureStore.deleteItemAsync(PHONE_WIDE_LIST_KEY).catch(() => {});
}

/** `owner`'s list: the one in memory when it is theirs, otherwise read from the phone. */
async function listOf(owner: string): Promise<string[]> {
    if (cached?.owner === owner) return cached.list;
    await movePhoneWideList(owner);
    return parseKeys(await AsyncStorage.getItem(blockedUsersStoreKey(owner)));
}

/**
 * The public keys the account on this phone has blocked; empty when the phone holds no account.
 * Uses AsyncStorage for unbounded capacity (avoiding SecureStore 2KB limits).
 */
export async function getBlockedUsers(): Promise<string[]> {
    try {
        // A read the phone's account changed under answers for the account on the phone now, never the one before.
        for (;;) {
            const owner = await accountOnPhone();
            if (!owner) return [];
            if (cached?.owner === owner) return cached.list;
            const generation = accountGeneration;
            const list = await listOf(owner);
            if (generation === accountGeneration) {
                cached = { owner, list };
                return list;
            }
        }
    } catch (e) {
        console.error('[blocklist] Failed to read blocked users from AsyncStorage', e);
    }
    return [];
}

/**
 * Asynchronously checks if a given user is blocked.
 */
export async function isUserBlocked(pubkey: string): Promise<boolean> {
    const list = await getBlockedUsers();
    return list.includes(pubkey);
}

/**
 * Blocks a user for the account on this phone, notifies server moderation (per Apple Guideline 1.2) in that account's
 * name, queues a report the node didn't take for retry, and dispatches a global event for immediate UI updates.
 * With no account on the phone, nothing is blocked.
 */
export async function blockUser(
    targetPubkey: string,
    reporterPubkey?: string,
    reason: string = 'User Blocked by Member',
    postId?: string
): Promise<boolean> {
    if (!targetPubkey) return false;

    try {
        const owner = await accountOnPhone();
        if (!owner) return false;
        const generation = accountGeneration;
        const list = await listOf(owner);
        if (!list.includes(targetPubkey)) {
            const newList = [...list, targetPubkey];
            await AsyncStorage.setItem(blockedUsersStoreKey(owner), JSON.stringify(newList));
            if (generation === accountGeneration) cached = { owner, list: newList };

            // Apple Guideline 1.2: Blocking must notify developer of inappropriate content
            if (reporterPubkey && reporterPubkey !== owner) {
                console.warn('[blocklist] Not reporting the block: the reporter is not the account on this phone');
            } else if (reporterPubkey) {
                const report: PendingReport = { reporterPubkey, targetPubkey, reason, postId, timestamp: Date.now() };
                try {
                    if (!(await sendReport(report))) await queueReportForRetry(report);
                } catch (err) {
                    console.warn('[blocklist] Failed to send reportAbuse to server on block, queuing for retry:', err);
                    await queueReportForRetry(report);
                }
            }

            if (generation === accountGeneration) DeviceEventEmitter.emit(BLOCKLIST_UPDATED_EVENT, newList);
            return true;
        }
    } catch (e) {
        console.error('[blocklist] Failed to block user', e);
    }
    return false;
}

/**
 * Unblocks a single user for the account on this phone, and dispatches a global event.
 */
export async function unblockUser(targetPubkey: string): Promise<boolean> {
    if (!targetPubkey) return false;

    try {
        const owner = await accountOnPhone();
        if (!owner) return false;
        const generation = accountGeneration;
        const list = await listOf(owner);
        if (list.includes(targetPubkey)) {
            const newList = list.filter(pk => pk !== targetPubkey);
            await AsyncStorage.setItem(blockedUsersStoreKey(owner), JSON.stringify(newList));
            if (generation === accountGeneration) {
                cached = { owner, list: newList };
                DeviceEventEmitter.emit(BLOCKLIST_UPDATED_EVENT, newList);
            }
            return true;
        }
    } catch (e) {
        console.error('[blocklist] Failed to unblock user', e);
    }
    return false;
}

/**
 * Clears the account on this phone's whole blocklist in a single operation ("Unblock All").
 * Prevents thread blocking and O(N) storage writes when unblocking all users.
 */
export async function clearBlocklist(): Promise<boolean> {
    try {
        const owner = await accountOnPhone();
        if (!owner) return false;
        const generation = accountGeneration;
        // First, so a list an older build kept can't come back after it.
        await movePhoneWideList(owner);
        await AsyncStorage.removeItem(blockedUsersStoreKey(owner));
        if (generation === accountGeneration) {
            cached = { owner, list: [] };
            DeviceEventEmitter.emit(BLOCKLIST_UPDATED_EVENT, []);
        }
        return true;
    } catch (e) {
        console.error('[blocklist] Failed to clear blocklist', e);
        return false;
    }
}

const REPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_PENDING_REPORTS = 50;

function parseReports(raw: string | null): PendingReport[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((p): p is PendingReport =>
            !!p && typeof p.reporterPubkey === 'string' && typeof p.targetPubkey === 'string' && typeof p.timestamp === 'number');
    } catch {
        return [];
    }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('The community did not answer in time.')), ms);
    });
    return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Send one report to the community the phone is set to, signed by the key that made it: the phone's key is loaded,
 * checked to be the reporter's, and that same key signs. False, with nothing sent, when the phone holds another account
 * or none. Throws when the community can't be reached or doesn't take the report.
 */
async function sendReport(report: PendingReport): Promise<boolean> {
    const signer = await loadIdentity();
    if (!signer?.privateKey || signer.publicKey !== report.reporterPubkey) return false;
    const anchorUrl = await AsyncStorage.getItem(ANCHOR_STORE_KEY);
    if (!anchorUrl) throw new Error('You are off-grid. Please connect to a BeanPool Node to perform this action.');
    const body = {
        reporterPubkey: report.reporterPubkey,
        targetPubkey: report.targetPubkey,
        reason: report.reason,
        targetPostId: report.postId,
    };
    const res = await withTimeout(signedPost(anchorUrl, REPORTS_PATH, body, signer), REPORT_TIMEOUT_MS);
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    return true;
}

/**
 * Queues a moderation report locally, under the account that made it, to retry when network is restored.
 * Deduplicates by targetPubkey, enforces a 7-day TTL, and caps at 50 entries.
 */
async function queueReportForRetry(report: PendingReport) {
    try {
        const key = pendingAbuseReportsStoreKey(report.reporterPubkey);
        let pending = parseReports(await AsyncStorage.getItem(key));
        // TTL: drop reports older than 7 days
        const now = Date.now();
        pending = pending.filter(p => now - p.timestamp < REPORT_TTL_MS);
        // Deduplicate: keep only the latest report per target
        pending = pending.filter(p => p.targetPubkey !== report.targetPubkey);
        // Cap queue size
        if (pending.length >= MAX_PENDING_REPORTS) pending.shift();
        pending.push(report);
        await AsyncStorage.setItem(key, JSON.stringify(pending));
    } catch (e) {
        console.error('[blocklist] Failed to queue report for retry', e);
    }
}

/**
 * The one offline queue the builds before this one kept for the whole phone: the reports `owner` made move into its own
 * queue, and the old queue goes. Any others were made by another account, which this phone can't sign for, and are
 * dropped (that build's Sign Out and Replace wiped the queue anyway).
 */
async function movePhoneWideReports(owner: string): Promise<void> {
    const raw = await AsyncStorage.getItem(PENDING_ABUSE_REPORTS_STORE_KEY);
    if (raw === null) return;
    const theirs = parseReports(raw).filter(p => p.reporterPubkey === owner);
    if (theirs.length > 0) {
        const key = pendingAbuseReportsStoreKey(owner);
        const own = parseReports(await AsyncStorage.getItem(key));
        const queued = new Set(own.map(p => p.targetPubkey));
        await AsyncStorage.setItem(key, JSON.stringify([...own, ...theirs.filter(p => !queued.has(p.targetPubkey))]));
    }
    await AsyncStorage.removeItem(PENDING_ABUSE_REPORTS_STORE_KEY);
}

/**
 * Retries sending the reports the account on this phone queued offline. Another account's queue waits on the phone for
 * that account, and a report goes out only while its own account is still on the phone (see {@link sendReport}).
 */
export async function retryPendingReports(): Promise<void> {
    try {
        const owner = await accountOnPhone();
        if (!owner) return;
        await movePhoneWideReports(owner);
        const key = pendingAbuseReportsStoreKey(owner);
        const stored = parseReports(await AsyncStorage.getItem(key));
        if (!stored.length) {
            await AsyncStorage.removeItem(key);
            return;
        }

        // Prune stale reports, and any this account didn't make, before retrying
        const now = Date.now();
        const pending = stored.filter(p => now - p.timestamp < REPORT_TTL_MS && p.reporterPubkey === owner);

        const remaining: PendingReport[] = [];
        for (const item of pending) {
            try {
                // False when the account changed while the queue was being sent: the report waits for its account.
                if (!(await sendReport(item))) remaining.push(item);
            } catch {
                remaining.push(item);
            }
        }

        if (remaining.length === 0) {
            await AsyncStorage.removeItem(key);
        } else if (remaining.length !== stored.length) {
            await AsyncStorage.setItem(key, JSON.stringify(remaining));
        }
    } catch (e) {
        console.error('[blocklist] Error retrying pending reports', e);
    }
}

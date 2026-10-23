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
 * Builds before this one kept one list, and one queue of offline reports, for the whole phone. They move under the
 * account on the phone when this build starts ({@link moveAtStart}), before anything can change that account.
 *
 * A block also reports the person to the moderators of the community the member blocked them in (Apple Guideline 1.2).
 * A report the node didn't take is queued under the account that made it, with that community, and retried when the
 * app comes back ({@link retryPendingReports}). It goes only to that community, whichever the phone is set to by then,
 * and only signed by the key that made it ({@link sendReport}): a node files a report as whoever signs it, so never by
 * the next account on the phone.
 *
 * And the community keeps the block for the account (POST /api/blocks, the web app's route, apps/server routes/blocks.ts),
 * so it stops delivering the blocked member's messages (Marty, 23 Oct, design message-a-friend Q5): {@link syncBlocks}
 * brings the list the community the phone is set to keeps for the account in line with the phone's, after each block and
 * unblock, at start and as the app comes back. The phone's own list stays the one the screens read: it holds offline,
 * and on a community whose node has no block list.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { DeviceEventEmitter } from 'react-native';
import { onAccountOnPhone } from './account-on-phone';
import { loadIdentity } from './identity';
import { signedPost } from './node-post';
import { isGuestNode } from './nodes';
import { blockedUsersStoreKey, communityBlocksStoreKey, PENDING_ABUSE_REPORTS_STORE_KEY, pendingAbuseReportsStoreKey } from './storage-keys';

export const BLOCKLIST_UPDATED_EVENT = 'beanpool_blocklist_updated';

/** The list the builds before this one kept for the whole phone (AsyncStorage, and SecureStore before that). */
const PHONE_WIDE_LIST_KEY = 'beanpool_blocked_users';
/** Set once the phone-wide list and queue have gone to an account: they are never read again. */
const PHONE_WIDE_MOVED_KEY = 'beanpool_blocked_users_moved';
const ANCHOR_STORE_KEY = 'beanpool_anchor_url';
const REPORTS_PATH = '/api/reports';
const REPORT_TIMEOUT_MS = 12000;

interface PendingReport {
    reporterPubkey: string;
    /** The community the member blocked at, where the report was made: the only one it is ever sent to. */
    community: string;
    targetPubkey: string;
    reason: string;
    postId?: string;
    timestamp: number;
}

/** A queued report as stored: the builds before this one named no community. */
type StoredReport = Omit<PendingReport, 'community'> & { community?: string };

/** The account the phone holds, as far as this module knows: undefined until it has been read or announced. */
let knownOwner: string | null | undefined;
/** The list in memory, and whose it is. */
let cached: { owner: string; list: string[] } | null = null;
/** Goes up with each account change, so what was read for the account before never lands as the next one's. */
let accountGeneration = 0;
let phoneWideMoved = false;
/** The move of the phone-wide list and queue under way, if any: one at a time, so they go to one account only. */
let movingPhoneWide: Promise<void> | null = null;
/**
 * The account the phone held as this build started, and the community it was set to, both read at that moment: the
 * phone-wide list and queue are that account's, and the queued reports were made at that community.
 */
let atStart: { owner: string | null; community: string | null } = { owner: null, community: null };

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
 * The list and the queue of offline reports the builds before this one kept for the whole phone go to the account on
 * the phone when this build starts, and the old keys go. Once: a marker says it is done, so a copy that could not be
 * deleted is never handed to a later account.
 *
 * At start, not at the first list read: a phone can start on a screen that reads no list (a half-finished join wizard
 * opens Welcome) and Replace its account from there. Moved at the first read, the old list would go to the replacing
 * account, and the member whose blocks they are would find them gone (confirmation review 4113557050). The account and
 * its community are read at the moment the app starts, and an account written while those reads are out doesn't change
 * the answer.
 */
async function moveAtStart(): Promise<void> {
    try {
        // A community that can't be read is none: the old reports are dropped, and the account is still the one at start.
        const [identity, community] = await Promise.all([
            loadIdentity(),
            AsyncStorage.getItem(ANCHOR_STORE_KEY).catch(() => null),
        ]);
        atStart = { owner: identity?.publicKey || null, community };
        if (atStart.owner) await moveOnce(atStart.owner);
    } catch (e) {
        console.warn('[blocklist] Could not move the phone-wide list at start; the first list read tries again', e);
    }
}

/**
 * Every list read, "Unblock All" and report retry first waits for the move begun at start. If that didn't happen (the
 * phone held no account then, or storage failed), it happens now, still for the account on the phone at start when
 * there was one, and only once however many callers race.
 *
 * A phone with no account at start leaves the list where it is until one appears, and it goes to that account. Such a
 * list was left by an older build's Sign Out, and the next account is likeliest the same member restoring theirs:
 * dropping the list would silently unblock everyone they blocked, the outcome Marty ranked worse. The other outcome, a
 * new account getting it, is what the older build did anyway; it happens at most once per phone, and that account sees
 * the list in Settings and can clear it.
 */
async function movePhoneWide(owner: string): Promise<void> {
    await startedMove;
    if (phoneWideMoved) return;
    if (!movingPhoneWide) {
        movingPhoneWide = moveOnce(atStart.owner ?? owner).finally(() => {
            movingPhoneWide = null;
        });
    }
    return movingPhoneWide;
}

async function moveOnce(owner: string): Promise<void> {
    if (await AsyncStorage.getItem(PHONE_WIDE_MOVED_KEY)) {
        phoneWideMoved = true;
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
    await movePhoneWideReports(owner, atStart.community);
    await AsyncStorage.setItem(PHONE_WIDE_MOVED_KEY, '1');
    phoneWideMoved = true;
    await AsyncStorage.removeItem(PHONE_WIDE_LIST_KEY);
    await AsyncStorage.removeItem(PENDING_ABUSE_REPORTS_STORE_KEY);
    await SecureStore.deleteItemAsync(PHONE_WIDE_LIST_KEY).catch(() => {});
}

/** `owner`'s list: the one in memory when it is theirs, otherwise read from the phone. */
async function listOf(owner: string): Promise<string[]> {
    if (cached?.owner === owner) return cached.list;
    await movePhoneWide(owner);
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
            if (generation === accountGeneration) {
                cached = { owner, list: newList };
                DeviceEventEmitter.emit(BLOCKLIST_UPDATED_EVENT, newList);
            }

            // Blocked on the phone already: the block goes to the community without waiting for its answer, nor for a
            // sync already under way. The report goes side by side, and is sent or queued before this returns.
            void syncBlocks();
            await reportBlock(owner, targetPubkey, reporterPubkey, reason, postId);
            return true;
        }
    } catch (e) {
        console.error('[blocklist] Failed to block user', e);
    }
    return false;
}

/**
 * Apple Guideline 1.2: Blocking must notify developer of inappropriate content. The report a block of `targetPubkey` by
 * `owner` sends, when it names a reporter: queued when the node didn't take it.
 */
async function reportBlock(owner: string, targetPubkey: string, reporterPubkey: string | undefined, reason: string, postId?: string): Promise<void> {
    if (reporterPubkey && reporterPubkey !== owner) {
        console.warn('[blocklist] Not reporting the block: the reporter is not the account on this phone');
    } else if (reporterPubkey) {
        // Made at the community the phone is set to now, where the member blocked, and sent only there.
        const community = await AsyncStorage.getItem(ANCHOR_STORE_KEY);
        if (!community) {
            console.warn('[blocklist] Not reporting the block: the phone is set to no community');
        } else {
            const report: PendingReport = { reporterPubkey, community, targetPubkey, reason, postId, timestamp: Date.now() };
            try {
                if (!(await sendReport(report))) await queueReportForRetry(report);
            } catch (err) {
                if (isFinalReportRefusal(err)) {
                    // Refused for good (a post no longer there): the block stands, nothing is queued.
                    console.warn('[blocklist] The community refused the report sent with the block; not retrying:', err);
                } else {
                    console.warn('[blocklist] Failed to send reportAbuse to server on block, queuing for retry:', err);
                    await queueReportForRetry(report);
                }
            }
        }
    }
}

/**
 * Unblocks a single user for the account on this phone, takes it off the community's list ({@link syncBlocks}), and
 * dispatches a global event.
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
            // Unblocked on the phone already: the community hears of it without this waiting for its answer.
            void syncBlocks();
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
        await movePhoneWide(owner);
        await AsyncStorage.removeItem(blockedUsersStoreKey(owner));
        if (generation === accountGeneration) {
            cached = { owner, list: [] };
            DeviceEventEmitter.emit(BLOCKLIST_UPDATED_EVENT, []);
        }
        // Takes off the community's list each block this phone sent there, even one the web app had made too (the community
        // keeps one list), and no other: a block made only in the web app stays. One request each, not waited for, so the
        // list on screen empties at once.
        void syncBlocks();
        return true;
    } catch (e) {
        console.error('[blocklist] Failed to clear blocklist', e);
        return false;
    }
}

// ── the list the community keeps for the account ─────────────────────────────────────────────────────────────────

const BLOCKS_PATH = '/api/blocks';
const BLOCKS_REMOVE_PATH = '/api/blocks/remove';
/** The most keys a community keeps on one member's list (apps/server engine/member-blocks.ts MEMBER_BLOCKS_MAX), and so the most one request names. */
const COMMUNITY_BLOCKS_MAX = 500;
/** How long a community that refused a change for good, or has no block list (a node from before it), is left alone. */
const BLOCKS_WAIT_MS = 24 * 60 * 60 * 1000;
/** A key as every community keeps it (apps/server engine/member-key.ts): one in any other spelling, or the owner's own, has the whole list refused. */
const MEMBER_KEY = /^[0-9a-f]{64}$/;
/**
 * A change's 403 from a community the account is no member of: none yet (routes/blocks.ts, apps/server engine/members.ts
 * NOT_A_MEMBER_CODE), or none now, its account there closed (`account_closed`, the signature gate's, https-server.ts:
 * removed, or deleted by its owner). Such a community keeps no list for the account: a closed account's went with it
 * (state-engine.ts adminPruneUser, purgeMemberSelf: dropBlocksOf).
 */
const NO_MEMBER_CODES: ReadonlySet<string> = new Set(['not_a_member', 'account_closed']);
/**
 * At most this many block requests a minute: a quarter of what a community takes from one member (the gateway's 120 a
 * minute, apps/server gateway-rate-limit.ts), so a first sync with many keys the community has no row for, each sent on
 * its own, or an Unblock All, never leaves the app's own requests answered 429. Measured on a real node before this: 150
 * such keys sent 121 requests in 0.6 s, and the 121st, and the member's next read of their chats, were answered 429.
 */
const BLOCK_REQUESTS_PER_MINUTE = 30;
const MINUTE_MS = 60 * 1000;

/**
 * What this phone knows of one community's list for one account: `on`, keys this phone put there that the community's
 * answer showed it holds; `sent`, keys sent whose answer never came, which it may hold. After a refusal asking again
 * won't soon change: `waitUntil`, when it may be asked anything again (it has no block list, or refused a removal);
 * `addsWaitUntil`, when it may be sent blocks again (it refused one), while unblocks still go.
 */
interface BlocksAt {
    on: string[];
    sent: string[];
    waitUntil?: number;
    addsWaitUntil?: number;
}

/**
 * What a change met: the keys on the community's list after it; `later`, ask again at the next sync (no answer);
 * `no member`, the account is no member there, yet or now ({@link NO_MEMBER_CODES}), so it keeps no list for it; `no
 * list`, a node with no block list (404, 405), where no change can land; `refused`, any other refusal (another 403, the
 * community's limit).
 */
type ChangeAnswer = string[] | 'later' | 'no member' | 'no list' | 'refused';

let syncing: Promise<void> = Promise.resolve();
/** When each block request of the last minute went, oldest first. */
let requestsSentAt: number[] = [];
/** The sync set for when there is room for another request, if one is. */
let syncWhenRoom: ReturnType<typeof setTimeout> | null = null;

/**
 * Brings the block list the community the phone is set to keeps for the account on the phone (routes/blocks.ts) in line
 * with the phone's: each key on the phone's list that the community hasn't answered it holds is added, and each this
 * phone put there that is no longer on the phone's list is taken off. A key this phone never sent (a block made only in
 * the web app) is never touched; one it sent comes off when the member unblocks it on the phone, even if the web app had
 * blocked it too, since the community keeps one list for the member. Nothing is sent when nothing changed.
 *
 * - Each community the member is on with this phone gets the phone's list; the first time, every block from before this
 *   build, in one request (a key the community has no row for, which a list skips, goes again on its own, as the web
 *   app's move sends it). An unblock reaches each community this phone put that block on, when the phone is next there.
 * - A community the phone visits as a guest (nodes.ts markGuestNode: "Guest view first", Add & Connect) is sent nothing:
 *   the account is no member there, and the list is the member's own business. Joining there clears the mark, and the
 *   next sync sends the list.
 * - No answer (no connection, a timeout, a server error, 401, 408, 425, 429): asked again at the next sync. A block whose
 *   answer never came may be on the list, so it is taken off all the same when the member unblocks.
 * - A community that has the account as no member, yet or now (403 not_a_member, or account_closed: removed, or deleted by
 *   its owner), keeps no list for it: nothing this phone sent counts as on its list any more
 *   ({@link communityKeepsNoBlocks}), and it is asked again at the next sync. So a member who joins there, or whom a
 *   vote brings back, has the whole list sent then, not a day later and not never.
 * - A node with no block list (404, 405): that community is not asked again for a day. Any other refusal (a 403, the
 *   community's limit) of a block: it is sent no blocks for a day, but unblocks still go, so the blocked member's lines
 *   are withheld no longer than the member wants (the limit's own answer is "Unblock someone to block another"); of an
 *   unblock: it is asked nothing for a day. The phone's own block stands throughout.
 * - Only ever the account's own: sent to the community the phone is set to as the sync starts, each request signed by the
 *   key of the account whose list it is, and only while that account is on the phone. One sync at a time.
 * - At most {@link BLOCK_REQUESTS_PER_MINUTE} requests a minute: past that, the sync stops, and the next one starts by
 *   itself as soon as there is room.
 */
export function syncBlocks(): Promise<void> {
    // After the one before it, however that ended: a sync that failed never stops the next.
    const run = syncing.then(syncBlocksOnce, syncBlocksOnce);
    syncing = run;
    return run;
}

/** For tests: settles once every sync begun so far has ended. Block, Unblock and Unblock All begin one and don't wait for it. */
export function blockSyncsEndedForTests(): Promise<void> {
    return syncing;
}

async function syncBlocksOnce(): Promise<void> {
    try {
        const owner = await accountOnPhone();
        if (!owner) return;
        const anchor = await AsyncStorage.getItem(ANCHOR_STORE_KEY);
        const community = anchor?.replace(/\/+$/, '');
        if (!anchor || !community) return;
        // Marked as the visit wrote the address, with or without its trailing slash.
        for (const url of new Set([anchor, community, `${community}/`])) {
            if (await isGuestNode(url)) return;
        }
        const list = await listOf(owner);
        const storeKey = communityBlocksStoreKey(owner);
        const record = parseCommunityBlocks(await AsyncStorage.getItem(storeKey));
        const at: BlocksAt = record[community] ?? { on: [], sent: [] };
        const now = Date.now();
        if (at.waitUntil !== undefined && now < at.waitUntil) return;
        delete at.waitUntil;
        if (at.addsWaitUntil !== undefined && now >= at.addsWaitUntil) delete at.addsWaitUntil;
        const save = async () => {
            record[community] = at;
            await AsyncStorage.setItem(storeKey, JSON.stringify(record));
        };
        const waitADay = async (what: 'waitUntil' | 'addsWaitUntil') => {
            at[what] = Date.now() + BLOCKS_WAIT_MS;
            await save();
        };
        // A refused block holds back the blocks only; a node with no block list, everything.
        const addRefused = (answer: 'no list' | 'refused') => waitADay(answer === 'no list' ? 'waitUntil' : 'addsWaitUntil');
        const noMember = async () => {
            keepsNone(at);
            await save();
        };
        const took = (keys: string[]) => {
            at.on = [...new Set([...at.on, ...keys])];
            at.sent = at.sent.filter(k => !keys.includes(k));
        };

        for (const key of [...new Set([...at.on, ...at.sent])]) {
            if (list.includes(key)) continue;
            const answer = await sendBlockChange(owner, community, BLOCKS_REMOVE_PATH, { targetPubkey: key });
            if (answer === 'later') return;
            if (answer === 'no member') return noMember();
            if (answer === 'no list' || answer === 'refused') return waitADay('waitUntil');
            at.on = at.on.filter(k => k !== key);
            at.sent = at.sent.filter(k => k !== key);
            await save();
        }

        if (at.addsWaitUntil !== undefined) return;
        const adds = [...new Set(list)].filter(k => MEMBER_KEY.test(k) && k !== owner && !at.on.includes(k));
        if (adds.length === 0) return;
        // Written down before they go: one whose answer never comes may be on the list, and an unblock takes it off.
        at.sent = [...new Set([...at.sent, ...adds])];
        await save();
        const alone: string[] = adds.length === 1 ? [adds[0]] : [];
        for (let i = 0; adds.length > 1 && i < adds.length; i += COMMUNITY_BLOCKS_MAX) {
            const batch = adds.slice(i, i + COMMUNITY_BLOCKS_MAX);
            const answer = await sendBlockChange(owner, community, BLOCKS_PATH, { targetPubkeys: batch });
            if (answer === 'later') return;
            if (answer === 'no member') return noMember();
            if (answer === 'no list' || answer === 'refused') return addRefused(answer);
            took(batch.filter(k => answer.includes(k)));
            alone.push(...batch.filter(k => !answer.includes(k)));
            await save();
        }
        // One key on its own is taken whether or not the community has a row for it (routes/blocks.ts).
        for (const key of alone) {
            const answer = await sendBlockChange(owner, community, BLOCKS_PATH, { targetPubkey: key });
            if (answer === 'later') return;
            if (answer === 'no member') return noMember();
            if (answer === 'no list' || answer === 'refused') return addRefused(answer);
            took([key]);
            await save();
        }
    } catch (e) {
        console.warn('[blocklist] Could not bring the community\'s block list in line with this phone\'s; tried again at the next sync', e);
    }
}

/**
 * One change to `community`'s list for `owner`, signed by `owner`'s key, which must be the one on the phone: when it
 * isn't, nothing is sent, and the change waits for its account (`later`).
 */
async function sendBlockChange(owner: string, community: string, path: string, body: Record<string, unknown>): Promise<ChangeAnswer> {
    const signer = await loadIdentity();
    if (!signer?.privateKey || signer.publicKey !== owner) return 'later';
    if (!roomForARequest()) return 'later';
    // One deadline over the request and the reading of its answer, and the request aborted at it (as purgeAccountOnNode
    // does, node-post.ts): fetch can settle as the headers arrive, and React Native's never gives up by itself, so an
    // answer whose body stalled after them would hold this sync, and every one queued behind it, until the app closed.
    const controller = new AbortController();
    let res: Response;
    let text: string;
    try {
        ({ res, text } = await withTimeout((async () => {
            const answer = await signedPost(community, path, body, signer, controller.signal);
            return { res: answer, text: await answer.text() };
        })(), REPORT_TIMEOUT_MS));
    } catch {
        // Not left running behind the next sync.
        controller.abort();
        return 'later';
    }
    if (res.ok) {
        // Only the node's own answer counts: a 200 from something in front of it (a Wi-Fi login page) took nothing.
        try {
            const parsed = JSON.parse(text);
            if (parsed?.success === true && Array.isArray(parsed.blocked)) {
                return parsed.blocked.map((b: { publicKey?: unknown } | null) => b?.publicKey).filter((k: unknown): k is string => typeof k === 'string');
            }
        } catch {
            // Not JSON: not the node's answer.
        }
        return 'later';
    }
    if (res.status === 404 || res.status === 405) return 'no list';
    // No member there, yet or now: nothing about the change itself.
    const code = changeErrorCode(text);
    if (res.status === 403 && code !== null && NO_MEMBER_CODES.has(code)) return 'no member';
    return res.status >= 400 && res.status < 500 && ![401, 408, 425, 429].includes(res.status) ? 'refused' : 'later';
}

/**
 * Room for one more block request this minute ({@link BLOCK_REQUESTS_PER_MINUTE}), counted when there is. When there
 * isn't, a sync is set for the moment there will be, and the change waits for it.
 */
function roomForARequest(): boolean {
    const now = Date.now();
    // A clock set back counts nothing sent in the future it came from.
    requestsSentAt = requestsSentAt.filter(t => t <= now && now - t < MINUTE_MS);
    if (requestsSentAt.length < BLOCK_REQUESTS_PER_MINUTE) {
        requestsSentAt.push(now);
        return true;
    }
    if (!syncWhenRoom) {
        syncWhenRoom = setTimeout(() => {
            syncWhenRoom = null;
            void syncBlocks();
        }, requestsSentAt[0] + MINUTE_MS - now);
    }
    return false;
}

/**
 * The community keeps no list for the account now: nothing this phone sent counts as on it, so the next sync sends every
 * block again. Each key sent stays one it may hold, so an unblock still takes it off. A wait stays: it was about the node
 * (no block list, its limit), not about the account.
 */
function keepsNone(at: BlocksAt): void {
    at.sent = [...new Set([...at.on, ...at.sent])];
    at.on = [];
}

/**
 * The phone has heard, for certain, that the account `publicKey` is no member of `community`, so that community keeps no
 * block list for it: its membership check answered that the key is a stranger there or its account closed
 * (app/NodeStatusContext.tsx), or the account has just joined there as a new member (db.ts `redeemInvite`). A list the
 * community had is gone: removed accounts' and deleted ones' go with them (server adminPruneUser, purgeMemberSelf), and a
 * node set up again at the address never had one. So nothing this phone sent there counts as on its list any more, and
 * the next sync there, once the account is a member (it joins, or a vote brings it back), sends the whole list again.
 *
 * After any sync under way, as a sync is, so none writes back what it read before. Never throws, and never waited for by
 * those callers: they go on at once.
 */
export function communityKeepsNoBlocks(publicKey: string, community: string): Promise<void> {
    const forget = async () => {
        try {
            const here = sameCommunity(community);
            const storeKey = communityBlocksStoreKey(publicKey);
            const record = parseCommunityBlocks(await AsyncStorage.getItem(storeKey));
            const entries = Object.entries(record).filter(([url, at]) => here(url) && at.on.length > 0);
            if (entries.length === 0) return;
            for (const [, at] of entries) keepsNone(at);
            await AsyncStorage.setItem(storeKey, JSON.stringify(record));
        } catch (e) {
            console.warn('[blocklist] Could not forget what a community that keeps no list held; the next refusal there does', e);
        }
    };
    const run = syncing.then(forget, forget);
    syncing = run;
    return run;
}

/** Whether a record's address is `community`'s: the same, whatever its case and trailing slash. */
function sameCommunity(community: string): (url: string) => boolean {
    const plain = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase();
    const address = plain(community);
    return (url) => plain(url) === address;
}

/** The `code` in a block route's JSON refusal (routes/blocks.ts), or null for anything else. */
function changeErrorCode(text: string): string | null {
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed.code === 'string' ? parsed.code : null;
    } catch {
        return null;
    }
}

function keysIn(v: unknown): string[] {
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
}

function parseCommunityBlocks(raw: string | null): Record<string, BlocksAt> {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out: Record<string, BlocksAt> = {};
        for (const [community, value] of Object.entries(parsed as Record<string, Partial<BlocksAt> | null>)) {
            if (!value || typeof value !== 'object') continue;
            out[community] = { on: keysIn(value.on), sent: keysIn(value.sent) };
            if (typeof value.waitUntil === 'number') out[community].waitUntil = value.waitUntil;
            if (typeof value.addsWaitUntil === 'number') out[community].addsWaitUntil = value.addsWaitUntil;
        }
        return out;
    } catch {
        return {};
    }
}

const REPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_PENDING_REPORTS = 50;

function parseReports(raw: string | null): StoredReport[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((p): p is StoredReport =>
            !!p && typeof p.reporterPubkey === 'string' && typeof p.targetPubkey === 'string' && typeof p.timestamp === 'number'
            && (p.community === undefined || typeof p.community === 'string'));
    } catch {
        return [];
    }
}

/** The same report twice: one member, one person, one community. */
function sameReport(a: StoredReport, b: StoredReport): boolean {
    return a.targetPubkey === b.targetPubkey && a.community === b.community;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('The community did not answer in time.')), ms);
    });
    return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Send one report to the community it was made at, signed by the key that made it: the phone's key is loaded, checked
 * to be the reporter's, and that same key signs. Whichever community the phone is set to now plays no part: a report
 * made at one community never reaches another's moderators, not after the member signs out and restores onto another,
 * nor in the moment Replace has written the next account's community and not yet its key (confirmation review
 * 4113557097). False, with nothing sent, when the phone holds another account or none. Throws when the community can't
 * be reached or doesn't take the report.
 */
async function sendReport(report: PendingReport): Promise<boolean> {
    const signer = await loadIdentity();
    if (!signer?.privateKey || signer.publicKey !== report.reporterPubkey) return false;
    const body = {
        reporterPubkey: report.reporterPubkey,
        targetPubkey: report.targetPubkey,
        reason: report.reason,
        targetPostId: report.postId,
    };
    const res = await withTimeout(signedPost(report.community, REPORTS_PATH, body, signer), REPORT_TIMEOUT_MS);
    if (!res.ok) throw new ReportRefused(res.status, await nodeErrorCode(res));
    return true;
}

/** The error code in the answer's JSON body, or null for anything else (an HTML page, text, nothing, no code). */
async function nodeErrorCode(res: Response): Promise<string | null> {
    try {
        const parsed = JSON.parse(await res.text());
        return parsed && typeof parsed.error === 'string' ? parsed.error : null;
    } catch {
        return null;
    }
}

/**
 * The refusals the node's report route (apps/server/src/routes/community.ts, POST /api/reports) gives for a report
 * itself, which asking again can't change. Anything not listed here is not known to be the node's answer.
 */
const FINAL_REPORT_ERRORS: ReadonlySet<string> = new Set([
    'not_found',
    'own_item',
    'pulse_report_names_a_post',
    'targetPostId must be a string',
    'targetPulseItemId must be a non-empty string',
    'reporterPubkey, targetPubkey, and a non-empty string reason are required',
    'Failed — must be a registered member, cannot report yourself',
]);

/**
 * The answer was not a yes: `status` says whether asking again could change that, and `code` is the node's own error
 * code when its JSON body carried one (null when something else answered).
 */
class ReportRefused extends Error {
    constructor(readonly status: number, readonly code: string | null = null) {
        super(`Server returned ${status}`);
    }
}

/**
 * Whether the community itself refused this report for good, so asking again changes nothing. Only the node's own
 * answer counts: a 4xx (not 401, a phone clock that is off, nor 408, 425 or 429, a timeout and the hourly limit) whose
 * JSON body carries one of the error codes the report route gives. A 404 is what a block on a post meets when the post
 * is no longer at the community: the block stays, and the report is not kept to be sent again every start for 7 days.
 * A 4xx from something in front of the node (Cloudflare's HTML 403, a tunnel's bare 404, a stranger's server at an old
 * address) clears once the name is fixed, so it is retried like a 5xx or no answer, until the 7-day limit.
 */
export function isFinalReportRefusal(err: unknown): boolean {
    if (!(err instanceof ReportRefused)) return false;
    if (!(err.status >= 400 && err.status < 500) || [401, 408, 425, 429].includes(err.status)) return false;
    return err.code !== null && FINAL_REPORT_ERRORS.has(err.code);
}

/**
 * Queues a moderation report locally, under the account that made it and with the community it was made at, to retry
 * when network is restored. Deduplicates by target and community, enforces a 7-day TTL, and caps at 50 entries.
 */
async function queueReportForRetry(report: PendingReport) {
    try {
        const key = pendingAbuseReportsStoreKey(report.reporterPubkey);
        let pending = parseReports(await AsyncStorage.getItem(key));
        // TTL: drop reports older than 7 days
        const now = Date.now();
        pending = pending.filter(p => now - p.timestamp < REPORT_TTL_MS);
        // Deduplicate: keep only the latest report per target at each community
        pending = pending.filter(p => !sameReport(p, report));
        // Cap queue size
        if (pending.length >= MAX_PENDING_REPORTS) pending.shift();
        pending.push(report);
        await AsyncStorage.setItem(key, JSON.stringify(pending));
    } catch (e) {
        console.error('[blocklist] Failed to queue report for retry', e);
    }
}

/**
 * Part of the move at start ({@link moveOnce}): of the one offline queue the builds before this one kept for the whole
 * phone, the reports `owner` made move into its own queue (the old queue goes with the old list). Any others were made
 * by another account, which this phone can't sign for, and are dropped (that build's Sign Out and Replace wiped the
 * queue anyway).
 *
 * That build's reports name no community: it sent them to the one the phone was set to, and that is `community`, the
 * one it was set to as this build started. Each is stamped with it here, so it is sent only there, never to a community
 * the phone is set to later. With none set then, they have nowhere to go and are dropped.
 */
async function movePhoneWideReports(owner: string, community: string | null): Promise<void> {
    const raw = await AsyncStorage.getItem(PENDING_ABUSE_REPORTS_STORE_KEY);
    if (raw === null || !community) return;
    const theirs = parseReports(raw)
        .filter(p => p.reporterPubkey === owner)
        .map((p): PendingReport => ({ ...p, community }));
    if (theirs.length === 0) return;
    const key = pendingAbuseReportsStoreKey(owner);
    const own = parseReports(await AsyncStorage.getItem(key));
    await AsyncStorage.setItem(key, JSON.stringify([...own, ...theirs.filter(p => !own.some(q => sameReport(p, q)))]));
}

/**
 * Retries sending the reports the account on this phone queued offline, each to the community it was made at. Another
 * account's queue waits on the phone for that account, and a report goes out only while its own account is still on
 * the phone (see {@link sendReport}).
 */
export async function retryPendingReports(): Promise<void> {
    try {
        const owner = await accountOnPhone();
        if (!owner) return;
        await movePhoneWide(owner);
        const key = pendingAbuseReportsStoreKey(owner);
        const stored = parseReports(await AsyncStorage.getItem(key));
        if (!stored.length) {
            await AsyncStorage.removeItem(key);
            return;
        }

        // Prune stale reports, any this account didn't make, and any that name no community to send them to, before
        // retrying
        const now = Date.now();
        const pending = stored.filter((p): p is PendingReport =>
            now - p.timestamp < REPORT_TTL_MS && p.reporterPubkey === owner && !!p.community);

        const remaining: PendingReport[] = [];
        for (const item of pending) {
            try {
                // False when the account changed while the queue was being sent: the report waits for its account.
                if (!(await sendReport(item))) remaining.push(item);
            } catch (err) {
                // Refused for good (a post no longer there): dropped, not sent again at every start for 7 days.
                if (!isFinalReportRefusal(err)) remaining.push(item);
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

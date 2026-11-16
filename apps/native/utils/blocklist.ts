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
 * so it stops delivering the blocked member's messages (Marty, 23 Oct, design message-a-friend Q5).
 *
 * The community's list is the truth about a block; the phone's list is derived (review of #3268, round 4). What the
 * phone keeps is the member's own changes, each block and unblock in the order they made them (storage-keys.ts
 * `blockChangesStoreKey`): the queue the community hears ({@link syncBlocks}), which holds offline and shows on every
 * screen at once. Every answer the community gives, to a change or to a read ({@link followRekeyedBlocks}), names the
 * keys on its list, which keys a re-key made one person (`formerKeys`) and the person a change was of (`person`), and
 * the phone takes from it which keys are one person (`blockedKeyChainsStoreKey`) and what the community holds of its
 * own (`communityBlocksStoreKey`), never assuming either. The list the screens read is then, for each person, the
 * member's latest change of any of their keys ({@link derive}): every key of a blocked person, Settings shows each once
 * ({@link getBlockedPeople}), and an unblock of any key lifts them all. A change the community has not yet answered is
 * never undone by an answer, and one it confirmed is never brought back: answers change only what the phone knows of
 * the community, and the next sync sends what still differs. One writer ({@link serially}) reads and writes these
 * stores, so no answer lands on a change made while it was out.
 *
 * A block made in the web app alone is the web app's: the phone neither shows it nor takes it off, and an Unblock All
 * on the phone leaves it. A block of the phone's that the community no longer holds (an unblock in the web app, a list
 * the node lost) is sent again: the member's change on the phone stands until they change it there.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { DeviceEventEmitter } from 'react-native';
import { onAccountOnPhone } from './account-on-phone';
import { loadIdentity } from './identity';
import { signedGet, signedPost } from './node-post';
import { isGuestNode } from './nodes';
import { blockChangesStoreKey, blockedKeyChainsStoreKey, blockedUsersStoreKey, communityBlocksStoreKey, PENDING_ABUSE_REPORTS_STORE_KEY, pendingAbuseReportsStoreKey } from './storage-keys';

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

/** The keys a person on the list is known by (storage-keys.ts blockedKeyChainsStoreKey): a key a re-key put in place of others → those others. */
type KeyChains = Record<string, string[]>;

function parseChains(raw: string | null): KeyChains {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const chains: KeyChains = {};
        for (const [key, formers] of Object.entries(parsed as Record<string, unknown>)) {
            if (Array.isArray(formers)) chains[key] = formers.filter((f): f is string => typeof f === 'string');
        }
        return chains;
    } catch {
        return {};
    }
}

/** Every key the person known by `key` is known by on the chains, `key` among them: the chains that share a key, joined. */
function personKeys(key: string, chains: KeyChains): Set<string> {
    const keys = new Set([key]);
    for (let grew = true; grew;) {
        grew = false;
        for (const [now, formers] of Object.entries(chains)) {
            const chain = [now, ...formers];
            if (chain.some(k => keys.has(k)) && chain.some(k => !keys.has(k))) {
                chain.forEach(k => keys.add(k));
                grew = true;
            }
        }
    }
    return keys;
}

/** `list` with each person on it once, under the key they hold now: the one of theirs on the list no re-key replaced. */
function onePerPerson(list: readonly string[], chains: KeyChains): string[] {
    const replaced = new Set(Object.values(chains).flat());
    const seen = new Set<string>();
    const people: string[] = [];
    for (const key of list) {
        if (seen.has(key)) continue;
        const person = personKeys(key, chains);
        person.forEach(k => seen.add(k));
        people.push(list.find(k => person.has(k) && !replaced.has(k)) ?? key);
    }
    return people;
}

// ── the account's block stores, and their one writer ─────────────────────────────────────────────────────────────

/** One change the member made of one key on this phone: a block or an unblock, and its place in the order they made them. */
interface Change {
    blocked: boolean;
    n: number;
}

/** The member's latest change of each key (storage-keys.ts blockChangesStoreKey), and the place the next change takes. */
interface Changes {
    next: number;
    of: Record<string, Change>;
}

/** What the phone keeps of one account's blocks: the list the screens read, which keys are one person, and the changes. */
interface Blocks {
    list: string[];
    chains: KeyChains;
    changes: Changes;
}

/**
 * The most changes kept. A block's change stays while the person is blocked; past this many, the oldest unblocks go
 * first (an unblock matters after its own sync only when a key it named turns out to be one person with a key blocked
 * before it, and the community says so at that key's first answer).
 */
const CHANGES_MAX = 1000;

function parseChanges(raw: string | null): Changes {
    const none: Changes = { next: 0, of: {} };
    if (!raw) return none;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return none;
        const of: Record<string, Change> = {};
        let next = Number.isSafeInteger(parsed.next) && parsed.next >= 0 ? parsed.next : 0;
        for (const [key, c] of Object.entries((parsed.of ?? {}) as Record<string, Partial<Change> | null>)) {
            if (!c || typeof c.blocked !== 'boolean' || !Number.isSafeInteger(c.n)) continue;
            of[key] = { blocked: c.blocked, n: c.n as number };
            next = Math.max(next, (c.n as number) + 1);
        }
        return { next, of };
    } catch {
        return none;
    }
}

/** Records the member's change of `keys`, as one change in the order: the newest. */
function recordChange(changes: Changes, keys: readonly string[], blocked: boolean): void {
    const n = changes.next;
    changes.next += 1;
    for (const key of keys) changes.of[key] = { blocked, n };
    const unblocks = Object.entries(changes.of).filter(([, c]) => !c.blocked).sort((a, b) => a[1].n - b[1].n);
    for (let over = Object.keys(changes.of).length - CHANGES_MAX, i = 0; over > 0 && i < unblocks.length; over--, i++) {
        delete changes.of[unblocks[i][0]];
    }
}

/**
 * Whether the person known by these keys is blocked: as the member's latest change of any of their keys says; a key on
 * the list the member made no change of here (a block from before this build, the move of the phone-wide list) counts as
 * blocked before every change. Null when the phone has no word of them at all.
 */
function personBlocked(person: ReadonlySet<string>, list: readonly string[], changes: Changes): boolean | null {
    let latest: Change | undefined;
    for (const key of person) {
        const change = changes.of[key];
        if (change && (!latest || change.n > latest.n)) latest = change;
    }
    if (latest) return latest.blocked;
    return list.some(k => person.has(k)) ? true : null;
}

/**
 * The list the screens read: every key of each person the member's changes say is blocked, and none of anyone else's.
 * Each person is every key the community has named as theirs (`chains`), so the same changes give the same list however
 * the keys and the re-keys arrived, and a person the community later names as one with a key the member changed after
 * takes that later change. In the order the keys were listed, a person's other keys after them.
 */
function derive(list: readonly string[], chains: KeyChains, changes: Changes): string[] {
    const out: string[] = [];
    const done = new Set<string>();
    for (const key of [...list, ...Object.keys(changes.of)]) {
        if (done.has(key)) continue;
        const person = personKeys(key, chains);
        person.forEach(k => done.add(k));
        if (personBlocked(person, list, changes) !== true) continue;
        for (const k of [...list.filter(l => person.has(l)), ...person]) if (!out.includes(k)) out.push(k);
    }
    return out;
}

let writing: Promise<unknown> = Promise.resolve();

/**
 * The one writer of the account's block stores (the list, its chains, its changes, and the record of what each community
 * holds): each read-then-write runs whole, after the one before it, and none spans a request to a community. So Block and
 * Unblock never wait for a community's answer, and an answer never lands on what a change made while it was out: each
 * reads again first (round 4 of #3268's review: the follow and Block each read, waited, then wrote, and an unblock made in
 * between was written over).
 */
function serially<T>(work: () => Promise<T>): Promise<T> {
    const run = writing.then(work, work);
    writing = run.catch(() => undefined);
    return run;
}

/** `owner`'s block stores, the list as its changes say. Only inside {@link serially}. */
async function readBlocks(owner: string): Promise<Blocks> {
    await movePhoneWide(owner);
    const [list, chains, changes] = await Promise.all([
        AsyncStorage.getItem(blockedUsersStoreKey(owner)),
        AsyncStorage.getItem(blockedKeyChainsStoreKey(owner)),
        AsyncStorage.getItem(blockChangesStoreKey(owner)),
    ]);
    const blocks = { list: parseKeys(list), chains: parseChains(chains), changes: parseChanges(changes) };
    blocks.list = derive(blocks.list, blocks.chains, blocks.changes);
    return blocks;
}

/** What {@link saveBlocks} compares with, to write only what changed. */
function asRead(blocks: Blocks): { list: string[]; chains: string; changes: string } {
    return { list: [...blocks.list], chains: JSON.stringify(blocks.chains), changes: JSON.stringify(blocks.changes) };
}

/**
 * Writes what changed of `owner`'s stores, the changes first and the list, as they say, last; and when the account is
 * still the one on the phone, the list in memory, and the screens hear of a list that changed. Only inside {@link serially}.
 */
async function saveBlocks(owner: string, blocks: Blocks, was: ReturnType<typeof asRead>): Promise<void> {
    const changes = JSON.stringify(blocks.changes);
    const chains = JSON.stringify(blocks.chains);
    if (changes !== was.changes) await AsyncStorage.setItem(blockChangesStoreKey(owner), changes);
    if (chains !== was.chains) await AsyncStorage.setItem(blockedKeyChainsStoreKey(owner), chains);
    blocks.list = derive(blocks.list, blocks.chains, blocks.changes);
    const changed = blocks.list.length !== was.list.length || blocks.list.some((k, i) => k !== was.list[i]);
    if (changed) await AsyncStorage.setItem(blockedUsersStoreKey(owner), JSON.stringify(blocks.list));
    if ((await accountOnPhone()) !== owner) return;
    cached = { owner, list: blocks.list };
    if (changed) DeviceEventEmitter.emit(BLOCKLIST_UPDATED_EVENT, blocks.list);
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
            const list = await serially(async () => {
                const { list: read } = await readBlocks(owner);
                if (generation === accountGeneration) cached = { owner, list: read };
                return read;
            });
            if (generation === accountGeneration) return list;
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
 * The people the account on this phone has blocked, each once, by the key they hold now (Settings' Manage Blocked Users):
 * a person re-keyed since is on the list under each of their keys, and one Unblock lifts them all.
 */
export async function getBlockedPeople(): Promise<string[]> {
    try {
        const owner = await accountOnPhone();
        if (!owner) return [];
        const { list, chains } = await serially(() => readBlocks(owner));
        return onePerPerson(list, chains);
    } catch (e) {
        console.error('[blocklist] Failed to read the blocked people', e);
        return [];
    }
}

/**
 * Blocks a user for the account on this phone, notifies server moderation (per Apple Guideline 1.2) in that account's
 * name, queues a report the node didn't take for retry, and dispatches a global event for immediate UI updates.
 * With no account on the phone, nothing is blocked. The block stands on the phone at once, as a change the community
 * hears next ({@link syncBlocks}); its answer names every key the person is known by, and the list follows.
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
        const made = await serially(async () => {
            const blocks = await readBlocks(owner);
            if (blocks.list.includes(targetPubkey)) return false;
            const was = asRead(blocks);
            recordChange(blocks.changes, [targetPubkey], true);
            await saveBlocks(owner, blocks, was);
            return true;
        });
        if (made) {
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
 * Unblocks a person for the account on this phone: the change is of the person, so every key the phone knows them by
 * comes off the list, and so does any key the community later names as theirs ({@link derive}). Takes them off the
 * community's list ({@link syncBlocks}), and dispatches a global event.
 */
export async function unblockUser(targetPubkey: string): Promise<boolean> {
    if (!targetPubkey) return false;

    try {
        const owner = await accountOnPhone();
        if (!owner) return false;
        const made = await serially(async () => {
            const blocks = await readBlocks(owner);
            const person = personKeys(targetPubkey, blocks.chains);
            if (!blocks.list.some(k => person.has(k))) return false;
            const was = asRead(blocks);
            recordChange(blocks.changes, [targetPubkey], false);
            await saveBlocks(owner, blocks, was);
            return true;
        });
        // Unblocked on the phone already: the community hears of it without this waiting for its answer.
        if (made) void syncBlocks();
        return made;
    } catch (e) {
        console.error('[blocklist] Failed to unblock user', e);
    }
    return false;
}

/**
 * Clears the account on this phone's whole blocklist in a single operation ("Unblock All"): one change, an unblock of
 * everyone on it, the newest in the order.
 */
export async function clearBlocklist(): Promise<boolean> {
    try {
        const owner = await accountOnPhone();
        if (!owner) return false;
        await serially(async () => {
            const blocks = await readBlocks(owner);
            const was = asRead(blocks);
            const blocked = Object.entries(blocks.changes.of).filter(([, c]) => c.blocked).map(([k]) => k);
            recordChange(blocks.changes, [...new Set([...blocks.list, ...blocked])], false);
            await saveBlocks(owner, blocks, was);
        });
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
 * What a change met: the community's list after it; `later`, ask again at the next sync (no answer);
 * `no member`, the account is no member there, yet or now ({@link NO_MEMBER_CODES}), so it keeps no list for it; `no
 * list`, a node with no block list (404, 405), where no change can land; `refused`, any other refusal (another 403, the
 * community's limit).
 */
type ChangeAnswer = ListAnswer | 'later' | 'no member' | 'no list' | 'refused';

/** A community's list, as its answer gives it ({@link listAnswerOf}). */
interface ListAnswer {
    keys: string[];
    formerKeys: Record<string, string[]>;
    person: string[] | null;
}

let syncing: Promise<void> = Promise.resolve();
/** When each block request of the last minute went, oldest first. */
let requestsSentAt: number[] = [];
/** The sync set for when there is room for another request, if one is. */
let syncWhenRoom: ReturnType<typeof setTimeout> | null = null;

/**
 * Brings the block list the community the phone is set to keeps for the account on the phone (routes/blocks.ts) in line
 * with the member's changes, person by person ({@link planChange}): each person the member blocks whom the community's
 * last answer didn't show it holds is sent, and each this phone put there whom the member no longer blocks is taken off.
 * Each answer is taken before the next change is planned ({@link reconcile}): it names the person's keys, so two keys
 * the phone hadn't known were one person take the member's later change, as the community would have taken the changes
 * in their order. A person this phone never sent (a block made only in the web app) is never touched; one it sent comes
 * off when the member unblocks them on the phone, even if the web app had blocked them too, since the community keeps
 * one list for the member. Nothing is sent when nothing changed.
 *
 * - Each community the member is on with this phone gets the phone's list; the first time, every block from before this
 *   build, in one request (a key the community has no row for, which a list skips, goes again on its own, as the web
 *   app's move sends it). An unblock reaches each community this phone put that block on, when the phone is next there.
 * - A community the phone visits as a guest (nodes.ts markGuestNode: "Guest view first", Add & Connect) is sent nothing:
 *   the account is no member there, and the list is the member's own business. Joining there clears the mark (every
 *   invite join: db.ts redeemInvite), and the next sync sends the list.
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
        const community = await communityToSync();
        if (!community) return;
        // Each change at most once a sync: one the community's answer leaves undone waits for the next.
        const tried = new Set<string>();
        for (;;) {
            const change = await serially(() => planChange(owner, community, tried));
            if (!change) return;
            const answer = await sendBlockChange(owner, community, change.path, change.body);
            if (!(await serially(() => takeAnswer(owner, community, change, answer)))) return;
        }
    } catch (e) {
        console.warn('[blocklist] Could not bring the community\'s block list in line with this phone\'s; tried again at the next sync', e);
    }
}

/** The community the phone is set to, as its records name it, or null with none, or on a guest visit there. */
async function communityToSync(): Promise<string | null> {
    const anchor = await AsyncStorage.getItem(ANCHOR_STORE_KEY);
    const community = anchor?.replace(/\/+$/, '');
    if (!anchor || !community) return null;
    // Marked as the visit wrote the address, with or without its trailing slash.
    for (const url of new Set([anchor, community, `${community}/`])) {
        if (await isGuestNode(url)) return null;
    }
    return community;
}

/** One change to send: where, its body, the keys it names, and whether it blocks. */
interface PlannedChange {
    path: string;
    body: Record<string, unknown>;
    keys: string[];
    adds: boolean;
}

async function recordOf(owner: string, community: string): Promise<{ record: Record<string, BlocksAt>; at: BlocksAt }> {
    const record = parseCommunityBlocks(await AsyncStorage.getItem(communityBlocksStoreKey(owner)));
    return { record, at: record[community] ?? { on: [], sent: [] } };
}

async function saveRecord(owner: string, record: Record<string, BlocksAt>, community: string, at: BlocksAt): Promise<void> {
    record[community] = at;
    await AsyncStorage.setItem(communityBlocksStoreKey(owner), JSON.stringify(record));
}

/** Each person among `keys`, once: every key the chains join to one of them. In the order the keys come. */
function peopleOf(keys: readonly string[], chains: KeyChains): Set<string>[] {
    const people: Set<string>[] = [];
    const done = new Set<string>();
    for (const key of keys) {
        if (done.has(key)) continue;
        const person = personKeys(key, chains);
        person.forEach(k => done.add(k));
        people.push(person);
    }
    return people;
}

/** The key a person holds now, as far as the phone knows: one of theirs no re-key replaced, on the list if one is. */
function keyNow(person: ReadonlySet<string>, blocks: Blocks): string | undefined {
    const replaced = new Set(Object.values(blocks.chains).flat());
    const keys = [...blocks.list.filter(k => person.has(k)), ...person];
    return keys.find(k => !replaced.has(k)) ?? keys[0];
}

/**
 * The next change `community`'s list needs to say what the phone's does, person by person: first an unblock of a person
 * the member no longer blocks, by a key this phone put there (or sent, its answer lost); then a block of each person the
 * member blocks whom the community's last answer didn't show it holds. Several blocks go first in one request (the
 * community takes only keys it has a row for), and each it didn't take on its own. Null when nothing is left, or the
 * community is waited for. A block about to go is written down first: one whose answer never comes may be on the list,
 * and an unblock takes it off.
 */
async function planChange(owner: string, community: string, tried: Set<string>): Promise<PlannedChange | null> {
    const blocks = await readBlocks(owner);
    const { record, at } = await recordOf(owner, community);
    const now = Date.now();
    if (at.waitUntil !== undefined && now < at.waitUntil) return null;
    let dirty = at.waitUntil !== undefined;
    delete at.waitUntil;
    if (at.addsWaitUntil !== undefined && now >= at.addsWaitUntil) {
        delete at.addsWaitUntil;
        dirty = true;
    }
    const people = peopleOf([...blocks.list, ...Object.keys(blocks.changes.of), ...at.on, ...at.sent], blocks.chains);
    const blocked = (person: Set<string>) => blocks.list.some(k => person.has(k));
    let change: PlannedChange | null = null;
    for (const person of people) {
        if (blocked(person)) continue;
        const key = [...at.on, ...at.sent].find(k => person.has(k) && !tried.has(`unblock ${k}`));
        if (key) {
            tried.add(`unblock ${key}`);
            change = { path: BLOCKS_REMOVE_PATH, body: { targetPubkey: key }, keys: [key], adds: false };
            break;
        }
    }
    if (!change && at.addsWaitUntil === undefined) {
        const adds = people.filter(p => blocked(p) && !at.on.some(k => p.has(k)))
            .map(p => keyNow(p, blocks))
            .filter((k): k is string => !!k && MEMBER_KEY.test(k) && k !== owner);
        const together = adds.filter(k => !tried.has(`together ${k}`) && !tried.has(`alone ${k}`)).slice(0, COMMUNITY_BLOCKS_MAX);
        const alone = adds.find(k => !tried.has(`alone ${k}`));
        if (together.length > 1) {
            together.forEach(k => tried.add(`together ${k}`));
            change = { path: BLOCKS_PATH, body: { targetPubkeys: together }, keys: together, adds: true };
        } else if (alone) {
            // One key on its own is taken whether or not the community has a row for it (routes/blocks.ts).
            tried.add(`alone ${alone}`);
            change = { path: BLOCKS_PATH, body: { targetPubkey: alone }, keys: [alone], adds: true };
        }
    }
    if (change?.adds) {
        at.sent = [...new Set([...at.sent, ...change.keys])];
        dirty = true;
    }
    if (dirty) await saveRecord(owner, record, community, at);
    return change;
}

/**
 * What a change's answer means for the phone, read again first (a Block or an Unblock made while it was out stands).
 * The community's list: the phone learns from it which keys are one person, and what the community holds of this
 * phone's ({@link reconcile}). A refusal: the waits {@link syncBlocks} describes. True when the sync goes on.
 */
async function takeAnswer(owner: string, community: string, change: PlannedChange, answer: ChangeAnswer): Promise<boolean> {
    if (answer === 'later') return false;
    const { record, at } = await recordOf(owner, community);
    if (answer === 'no member') {
        keepsNone(at);
        await saveRecord(owner, record, community, at);
        return false;
    }
    if (answer === 'no list' || answer === 'refused') {
        // A refused block holds back the blocks only; a node with no block list, or a refused unblock, everything.
        at[change.adds && answer === 'refused' ? 'addsWaitUntil' : 'waitUntil'] = Date.now() + BLOCKS_WAIT_MS;
        await saveRecord(owner, record, community, at);
        return false;
    }
    const blocks = await readBlocks(owner);
    const was = asRead(blocks);
    reconcile(owner, blocks, at, answer, change.adds ? change.keys : []);
    await saveBlocks(owner, blocks, was);
    await saveRecord(owner, record, community, at);
    return true;
}

/**
 * The community's answer (any change's, or its read) is the truth about its list, and about whom a re-key made one person
 * (apps/server routes/blocks.ts): the phone learns from `person` and `formerKeys` which keys are one person, for anyone
 * it has blocked, unblocked or put there, and the list it shows follows ({@link derive}); and what the community holds
 * of this phone's is what the answer lists, never what was assumed: `on` is each key on it of a person this phone put
 * there, blocks, or just sent, and nothing is left in doubt (`sent`). A block of the member's the community no longer
 * holds is sent again; a person the member unblocked that it still holds is taken off. The member's own changes are
 * never changed here.
 */
function reconcile(owner: string, blocks: Blocks, at: BlocksAt, answer: ListAnswer, sentNow: readonly string[]): void {
    const stake = new Set([...blocks.list, ...Object.keys(blocks.changes.of), ...at.on, ...at.sent, ...sentNow]);
    const learn = (chain: readonly string[]) => {
        const [now, ...formers] = chain;
        if (!now || formers.length === 0 || chain.includes(owner) || !chain.some(k => stake.has(k))) return;
        const known = blocks.chains[now] ?? [];
        const more = formers.filter(f => f !== now && !known.includes(f));
        if (more.length > 0) blocks.chains[now] = [...known, ...more];
    };
    if (answer.person) learn(answer.person);
    for (const [now, formers] of Object.entries(answer.formerKeys)) if (answer.keys.includes(now)) learn([now, ...formers]);
    const shown = derive(blocks.list, blocks.chains, blocks.changes);
    const ours = new Set([...at.on, ...at.sent, ...sentNow, ...shown]);
    at.on = answer.keys.filter(k => [...personKeys(k, blocks.chains)].some(p => ours.has(p)));
    at.sent = [];
}

/**
 * The community's read of the account's list (GET /api/blocks), taken as any change's answer is ({@link reconcile}): after
 * an admin re-keys someone the member blocked (they lost their phone), the community moved its copy of the block to their
 * new key (apps/server engine/member-blocks.ts moveBlocks) and names the old key as its former one, so the phone's list
 * holds the person under every key they are known by, and every screen that reads one key (the DM's thread and Talk, a
 * profile, the market, the forum) holds the block (review of #3268, finding 2; the DM screens also hold it before this
 * runs, utils/dm-blocked.ts). It also finds what the community no longer holds of this phone's, and the next sync sends
 * it again. Nothing is reported, and nothing is sent but the one read.
 *
 * Only while the account has a block here or on the community's list from this phone, only for the account on the phone
 * at the community it is set to, never on a guest visit, and one at a time with every sync ({@link syncBlocks}). It runs
 * at start, on each return and every 5 minutes (app/_layout.tsx), just before the sync.
 */
export function followRekeyedBlocks(): Promise<void> {
    const run = syncing.then(followOnce, followOnce);
    syncing = run;
    return run;
}

async function followOnce(): Promise<void> {
    try {
        const owner = await accountOnPhone();
        if (!owner) return;
        const community = await communityToSync();
        if (!community) return;
        const ask = await serially(async () => {
            const { list } = await readBlocks(owner);
            const { at } = await recordOf(owner, community);
            if (list.length + at.on.length + at.sent.length === 0) return false;
            return at.waitUntil === undefined || Date.now() >= at.waitUntil;
        });
        if (!ask) return;
        const answer = await readList(owner, community);
        if (!answer) return;
        await serially(async () => {
            const blocks = await readBlocks(owner);
            const was = asRead(blocks);
            const { record, at } = await recordOf(owner, community);
            reconcile(owner, blocks, at, answer, []);
            await saveBlocks(owner, blocks, was);
            await saveRecord(owner, record, community, at);
        });
    } catch (e) {
        console.warn('[blocklist] Could not read the community\'s block list; tried again at the next sync', e);
    }
}

/**
 * The community's read of `owner`'s list, or null when it couldn't be read, or isn't the node's answer. Counted with the
 * block requests ({@link roomForARequest}).
 */
async function readList(owner: string, community: string): Promise<ListAnswer | null> {
    const signer = await loadIdentity();
    if (!signer?.privateKey || signer.publicKey !== owner) return null;
    if (!roomForARequest()) return null;
    const controller = new AbortController();
    try {
        const { res, text } = await withTimeout((async () => {
            const answer = await signedGet(community, BLOCKS_PATH, signer, controller.signal);
            return { res: answer, text: await answer.text() };
        })(), REPORT_TIMEOUT_MS);
        if (!res.ok) return null;
        return listAnswerOf(JSON.parse(text));
    } catch {
        // Not left running behind the next sync.
        controller.abort();
        return null;
    }
}

/**
 * The list in a community's answer (routes/blocks.ts): the keys on it; for each, the keys a re-key replaced with it; and,
 * for a change of one key, every key of the person it changed, their key now first. Null for anything that isn't a list:
 * not the node's answer. Keys not in the one spelling are dropped. A node from before former keys names none.
 */
function listAnswerOf(answer: unknown): ListAnswer | null {
    const parsed = answer as { blocked?: unknown; formerKeys?: unknown; person?: unknown } | null;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.blocked)) return null;
    const isKey = (k: unknown): k is string => typeof k === 'string' && MEMBER_KEY.test(k);
    const keys = parsed.blocked.map((b: { publicKey?: unknown } | null) => b?.publicKey).filter((k: unknown): k is string => typeof k === 'string');
    const formerKeys: Record<string, string[]> = {};
    const named = parsed.formerKeys;
    if (named && typeof named === 'object' && !Array.isArray(named)) {
        for (const [key, formers] of Object.entries(named as Record<string, unknown>)) {
            if (!isKey(key) || !Array.isArray(formers)) continue;
            const valid = formers.filter(isKey);
            if (valid.length > 0) formerKeys[key] = valid;
        }
    }
    const person = Array.isArray(parsed.person) && parsed.person.length > 0 && parsed.person.every(isKey) ? parsed.person as string[] : null;
    return { keys, formerKeys, person };
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
            const list = parsed?.success === true ? listAnswerOf(parsed) : null;
            if (list) return list;
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
            await serially(async () => {
                const record = parseCommunityBlocks(await AsyncStorage.getItem(storeKey));
                const entries = Object.entries(record).filter(([url, at]) => here(url) && at.on.length > 0);
                if (entries.length === 0) return;
                for (const [, at] of entries) keepsNone(at);
                await AsyncStorage.setItem(storeKey, JSON.stringify(record));
            });
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

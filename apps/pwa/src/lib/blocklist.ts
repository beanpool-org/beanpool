/**
 * The member's block list (Marty's card web-blocklist-where, 2026-09-27: "The community keeps it for the account").
 *
 * The community keeps it for the signed-in account (GET and POST /api/blocks, apps/server routes/blocks.ts), so it comes
 * back on any browser after signing in, and nothing about it stays on a shared computer: this module holds it in the
 * page's memory only. It is read from the node once the account is known (startBlocklist), again whenever the node rings
 * (lib/blocklist-doorbell: this member's list changed elsewhere, or the socket opened again), and replaced by the node's
 * own answer to each change. A change shows only once the node has taken it: blockUser, unblockUser and clearBlocklist
 * throw a BlocklistError, in plain words, when it didn't, and the list stays as the node has it.
 *
 * A list kept in this browser by a build from before (bp_blocked_users, and the older beanpool_blocked_users) belongs to
 * whoever is signed in when this build first reads the node's list, as #1225 decided for the phone. It is moved up to the
 * node, and a key leaves it only once the node's list holds that key, or the member unblocks them; until then it still
 * hides whom it names, and the next read tries again. Of a list, the node takes only the keys it has a row for, so each of
 * the rest (an author from a connected community's board, blocked through the Market's peer browse) goes up on its own,
 * as a block made now does. Past the node's limit, the newest it has room for go up and the rest wait here, still
 * blocked, until the member makes room (getBlocklistFullNote says so where they block). Sign-out clears them with the
 * rest of this browser's storage, as before.
 *
 * Another tab may change that list at any time: one still on the build from before (open since the deploy, it keeps
 * blocking in this browser), or one on this build moving or unblocking. So the list is read again from the browser before
 * every change made to it, and a change removes only the keys it is about; this page's copy is for showing, never for
 * writing back. The browser tells this page when another tab changed it, and the page reads the node's list again then.
 *
 * Nothing leaves the screens before the node says so. A block another tab added to that list shows at once; one it took
 * off stays shown until the node answers a request this page made after seeing it go (that tab may have moved it up, and
 * the node's list this page holds is older). And a read that was on its way when the member blocked, unblocked or cleared
 * here drops its answer, which may be older than the node's answer to that change, and reads again.
 *
 * A report a block sends that can't reach the node waits in memory for the next try (retryPendingReports), not in the
 * browser; a queue an older build left in localStorage (bp_pending_abuse_reports) is taken into memory and deleted. Once
 * the account is known, only its own reports are sent.
 */
import { reportAbuse, getBlockList, addToBlockList, removeFromBlockList, clearBlockList, type BlockList } from './api';
import { BLOCKLIST_DOORBELL_EVENT } from './blocklist-doorbell';

/** Where a build from before kept the list in this browser: read once, moved up to the node, deleted. */
export const BLOCKLIST_STORAGE_KEY = 'bp_blocked_users';
export const LEGACY_BLOCKLIST_KEY = 'beanpool_blocked_users';
/** Where a build from before queued reports in this browser: taken into memory once, deleted. */
export const PENDING_REPORTS_KEY = 'bp_pending_abuse_reports';
export const BLOCKLIST_UPDATED_EVENT = 'bp_blocklist_updated';

const MEMBER_KEY = /^[0-9a-f]{64}$/;

export interface PendingReport {
    reporterPubkey: string;
    targetPubkey: string;
    reason: string;
    postId?: string;
    timestamp: number;
}

/** A read or a change of the list the node did not take. `message` is for the member, as it stands. */
export class BlocklistError extends Error {
    constructor(message: string, readonly status?: number, readonly code?: string) {
        super(message);
        this.name = 'BlocklistError';
    }
}

const UNREACHABLE = {
    read: 'Couldn’t load your blocked members from your community. Check your connection and try again.',
    block: 'Couldn’t reach your community, so they are not blocked. Check your connection and try again.',
    unblock: 'Couldn’t reach your community, so they are still blocked. Check your connection and try again.',
    clear: 'Couldn’t reach your community, so nobody was unblocked. Check your connection and try again.',
} as const;

/** What the member is told: the node's own words when it answered and refused, else that it couldn't be reached. */
function toBlocklistError(e: unknown, action: keyof typeof UNREACHABLE): BlocklistError {
    const status = (e as { status?: number } | null)?.status;
    const code = (e as { code?: string } | null)?.code;
    const said = e instanceof Error ? e.message : '';
    if (typeof status === 'number' && status >= 400 && status < 500 && said) return new BlocklistError(said, status, code);
    return new BlocklistError(UNREACHABLE[action], status, code);
}

// ── the list, in this page's memory ─────────────────────────────────────────────────────────────

/** The account whose list this is (startBlocklist). */
let owner: string | null = null;
/** The node's list for `owner`, as it last answered, and how many it may hold. */
let nodeList: string[] = [];
let nodeMax = 0;
/** Whether the node's list has been read for `owner`. */
let loaded = false;
/** Why the last read failed, until one succeeds. */
let readError: BlocklistError | null = null;
/**
 * This page's copy of a list from before still in this browser, not yet moved up, for showing: undefined until read (or
 * once another tab changed it), null when there is none. Never written back: see readStoredList and keepStoredList.
 */
let localList: string[] | null | undefined;
/**
 * Blocks this page showed that left the list kept in this browser through another tab (it moved them up, or the member
 * unblocked them there), or that a read's move took off it with an answer this page then did not take; each with the tick
 * it left at. The node's list this page holds may be older than that tab's move, so each stays shown until this page takes
 * an answer from the node asked for after that tick. A change seen in the browser may show a block at once, but only the
 * node's answer takes one off the screens, so a block the node holds is never shown gone, even for a moment.
 */
const leaving = new Map<string, number>();
/** This page's clock: it ticks as a request to the node is made, and as blocks join `leaving`. */
let ticks = 0;
/**
 * How many answers from the node this page has taken: a read, a block, an unblock, Unblock All. A read during which this
 * moved may be older than what was taken meanwhile: it drops its answer, and one more read follows.
 */
let answers = 0;
/** What the screens see: the node's list, anything still waiting to move up, and anything `leaving`. */
let current: string[] = [];

let reading: Promise<string[]> | null = null;
let readAgain = false;

/** Keys moved up to the node by this build, stored in localStorage so other tabs coordinate without mistaking move deletions for unblocks. */
export const MOVED_STORAGE_KEY = 'bp_moved_blocks';
const localMoved = new Set<string>();
const explicitUnblocks = new Set<string>();
let clearedAll = false;

function storedMovedList(): Set<string> {
    try {
        if (typeof localStorage === 'undefined') return new Set();
        const raw = localStorage.getItem(MOVED_STORAGE_KEY);
        if (!raw) return new Set();
        const parsed = JSON.parse(raw);
        return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []);
    } catch {
        return new Set();
    }
}

function isKeyMoved(key: string): boolean {
    return localMoved.has(key) || storedMovedList().has(key);
}

function recordMovedKeys(keys: string[]): void {
    if (keys.length === 0) return;
    keys.forEach(k => localMoved.add(k));
    try {
        if (typeof localStorage === 'undefined') return;
        const current = storedMovedList();
        keys.forEach(k => current.add(k));
        localStorage.setItem(MOVED_STORAGE_KEY, JSON.stringify([...current]));
    } catch (e) {
        console.warn('[blocklist] Could not record moved keys', e);
    }
}

function unrecordMovedKey(key: string): void {
    localMoved.delete(key);
    try {
        if (typeof localStorage === 'undefined') return;
        const current = storedMovedList();
        if (current.delete(key)) {
            if (current.size === 0) {
                localStorage.removeItem(MOVED_STORAGE_KEY);
            } else {
                localStorage.setItem(MOVED_STORAGE_KEY, JSON.stringify([...current]));
            }
        }
    } catch (e) {
        console.warn('[blocklist] Could not update moved keys', e);
    }
}

function clearMovedKeys(): void {
    localMoved.clear();
    try {
        if (typeof localStorage === 'undefined') return;
        localStorage.removeItem(MOVED_STORAGE_KEY);
    } catch (e) {
        console.warn('[blocklist] Could not clear moved keys', e);
    }
}

/** This page's copy of the list from before, read from the browser only when there is none yet. For showing. */
function readLocalList(): string[] | null {
    return localList !== undefined ? localList : readStoredList();
}

/**
 * The list from before as the browser holds it now (another tab may have changed it since this page last looked). A block
 * gone from it since this page's copy went through another tab (this page's own changes set its copy themselves): it joins
 * `leaving`, even when this page's node list still holds it. That list may be older than a read already on its way, whose
 * answer can lack the block (unblocked elsewhere, then moved up again by another tab), so only an answer asked after this
 * tick settles it (#1246's review, 4115106774). A block already shown stays shown; the cost is at most the follow-up read.
 */
function readStoredList(): string[] | null {
    const before = localList;
    localList = storedList();
    if (before) {
        const still = new Set(localList ?? []);
        const tick = ++ticks;
        for (const k of before) {
            if (isWaiting(k) && !still.has(k)) {
                leaving.set(k, tick);
                if (!isKeyMoved(k)) {
                    explicitUnblocks.add(k);
                }
            }
        }
    }
    return localList;
}

function storedList(): string[] | null {
    try {
        if (typeof localStorage === 'undefined') return null;
        const found: string[] = [];
        let any = false;
        for (const key of [BLOCKLIST_STORAGE_KEY, LEGACY_BLOCKLIST_KEY]) {
            const raw = localStorage.getItem(key);
            if (raw === null) continue;
            any = true;
            try {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) for (const k of parsed) if (typeof k === 'string' && !found.includes(k)) found.push(k);
            } catch { /* not a list: nothing in it to keep */ }
        }
        return any ? found : null;
    } catch (e) {
        console.warn('[blocklist] Could not read the list this browser kept before', e);
        return null;
    }
}

/** A key in the list from before that is still a block to keep: well spelled, and not the member themself. */
function isWaiting(k: string): boolean {
    return MEMBER_KEY.test(k) && k !== owner;
}

/**
 * Takes keys off the list from before, as the browser holds it NOW: only those `gone` names (the node's list holds them,
 * or the member unblocked them). Every other block stays, whoever wrote it: a tab on the build from before may have added
 * one since this page last looked, and another tab may have taken one off, which stays off. Read and written with nothing
 * awaited in between. Deleted, both keys, once nothing is left. Answers the blocks it took off.
 */
function keepStoredList(gone: (k: string) => boolean): string[] {
    const stored = readStoredList();
    if (stored === null) return [];
    const keys = stored.filter(k => isWaiting(k) && !gone(k));
    localList = keys.length > 0 ? keys : null;
    try {
        if (typeof localStorage === 'undefined') return [];
        if (keys.length === 0) {
            localStorage.removeItem(BLOCKLIST_STORAGE_KEY);
            localStorage.removeItem(LEGACY_BLOCKLIST_KEY);
        } else {
            const json = JSON.stringify(keys);
            if (localStorage.getItem(BLOCKLIST_STORAGE_KEY) !== json) localStorage.setItem(BLOCKLIST_STORAGE_KEY, json);
            localStorage.removeItem(LEGACY_BLOCKLIST_KEY);
        }
    } catch (e) {
        console.warn('[blocklist] Could not keep what is left of the list this browser kept before; this page still hides them', e);
    }
    return stored.filter(k => isWaiting(k) && gone(k));
}

/** The keys a node's answer holds. */
function heldBy(res: BlockList): Set<string> {
    return new Set(Array.isArray(res?.blocked) ? res.blocked.map(b => b.publicKey) : []);
}

function recompute(): void {
    const local = readLocalList() ?? [];
    current = [...new Set([...nodeList, ...local, ...leaving.keys()])];
}

function emit(): void {
    recompute();
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(BLOCKLIST_UPDATED_EVENT, { detail: current }));
    }
}

/** The node's answer to a request made at tick `asked`: it settles every block that joined `leaving` before then. */
function takeNodeAnswer(res: BlockList, asked: number): void {
    nodeList = Array.isArray(res?.blocked) ? res.blocked.map(b => b.publicKey).filter((k): k is string => typeof k === 'string') : [];
    nodeMax = typeof res?.max === 'number' ? res.max : 0;
    loaded = true;
    readError = null;
    answers++;
    for (const [k, left] of leaving) if (left < asked) leaving.delete(k);
}

/** The keys this member has blocked, for the screens that hide them. */
export function getBlockedUsers(): string[] {
    if (localList === undefined) recompute();
    return current;
}

export function isUserBlocked(pubkey: string): boolean {
    if (!pubkey) return false;
    return getBlockedUsers().includes(pubkey);
}

/** Whether the node's list has been read, and why the last read failed (for Settings, which must not say "none" then). */
export function getBlocklistStatus(): { loaded: boolean; error: string | null } {
    return { loaded, error: readError?.message ?? null };
}

/**
 * What to tell the member, where they block, while blocks from before wait in this browser because their list on the
 * community is full; null otherwise. Those blocks still hold here, and go up once they unblock someone.
 */
export function getBlocklistFullNote(): string | null {
    if (!loaded || nodeMax <= 0 || nodeList.length < nodeMax) return null;
    const onNode = new Set(nodeList);
    const n = (readLocalList() ?? []).filter(k => isWaiting(k) && !onNode.has(k)).length;
    if (n === 0) return null;
    return n === 1
        ? 'Your block list is full, so 1 block is kept in this browser only. Unblock someone to make room for it.'
        : `Your block list is full, so ${n} blocks are kept in this browser only. Unblock someone to make room for them.`;
}

/**
 * The list this browser kept before, moved up to the node for the signed-in account. Answers the node's list after it:
 * the move's last answer, or `res` when there was nothing to move or the node didn't take it (what is left then stays,
 * and the next read tries again).
 *
 * Of a list the node takes only the keys it has a row for (routes/blocks.ts), so each key still missing from its answer
 * then goes up on its own, which takes any key, as a block made now does: a member's blocks are never dropped with
 * nothing said. The first that doesn't go (the node unreachable, or the list full, 409 block_limit) stops the rest, since
 * they would meet the same. When the list has no room for them all, the newest go up.
 *
 * The browser's list is read again before each key goes on its own, so a key another tab unblocked meanwhile is not sent,
 * and again at the end: what another tab added meanwhile (a tab still on the build from before, blocking there) goes up
 * too, once. At the end only the keys the node's last answer holds leave the browser's list (keepStoredList). What is left
 * (no room, the node unreachable) stays there, still hiding whom it names, and the next read (the node's doorbell, the
 * socket back, the next page) sends it the same way. `moved` is what left the browser's list, the node holding it.
 */
async function moveLocalListUp(res: BlockList): Promise<{ res: BlockList; moved: string[] }> {
    if (readStoredList() === null) return { res, moved: [] };
    let now = res;
    /** The keys this move has sent, or found no room for: what another tab adds meanwhile is new to it. */
    const seen = new Set<string>();
    moving: for (;;) {
        const have = heldBy(now);
        const fresh = (readStoredList() ?? []).filter(k => isWaiting(k) && !have.has(k) && !seen.has(k));
        if (fresh.length === 0) break;
        fresh.forEach(k => seen.add(k));
        const room = Math.max(0, (now.max ?? 0) - have.size);
        const going = fresh.slice(Math.max(0, fresh.length - room));
        if (going.length < fresh.length) {
            console.warn(`[blocklist] ${fresh.length - going.length} of the blocks this browser kept don't fit in your list on the community; they stay here, still blocked, until there is room.`);
        }
        if (going.length === 0) break;
        const still = new Set(readStoredList() ?? []);
        const send = going.filter(k => still.has(k) && !explicitUnblocks.has(k) && !clearedAll);
        if (send.length > 0) {
            try {
                now = await addToBlockList(send);
            } catch (e) {
                console.warn('[blocklist] The community did not take the list this browser kept; it stays here and is tried again', e);
                break;
            }
        }
        if (clearedAll) {
            try {
                now = await clearBlockList();
                leaving.clear();
                explicitUnblocks.clear();
                clearedAll = false;
            } catch (e) {
                console.warn('[blocklist] Could not send clear to the community for clear during move', e);
            }
        } else {
            for (const k of going) {
                if (explicitUnblocks.has(k) && heldBy(now).has(k)) {
                    try {
                        now = await removeFromBlockList(k);
                        leaving.delete(k);
                    } catch (e) {
                        console.warn('[blocklist] Could not send unblock to the community for key unblocked during move', e);
                        now = { ...now, blocked: (now.blocked ?? []).filter(b => b.publicKey !== k) };
                        readAgain = true;
                    }
                }
            }
        }
        const taken = heldBy(now);
        for (const k of going) {
            if (taken.has(k) || !readStoredList()?.includes(k) || explicitUnblocks.has(k) || clearedAll) continue;
            try {
                now = await addToBlockList(k);
            } catch (e) {
                console.warn('[blocklist] Some of the blocks this browser kept did not go up to the community; they stay here and are tried again', e);
                break moving;
            }
            if ((clearedAll || explicitUnblocks.has(k)) && heldBy(now).has(k)) {
                try {
                    now = await removeFromBlockList(k);
                    leaving.delete(k);
                } catch (e) {
                    console.warn('[blocklist] Could not send unblock to the community for key unblocked during move', e);
                    now = { ...now, blocked: (now.blocked ?? []).filter(b => b.publicKey !== k) };
                    readAgain = true;
                }
            }
        }
    }
    const held = heldBy(now);
    const stored = readStoredList() ?? [];
    const moving = stored.filter(k => isWaiting(k) && held.has(k));
    recordMovedKeys(moving);
    const moved = keepStoredList(k => held.has(k));
    return { res: now, moved };
}

/**
 * Reads the node's list for the signed-in account (moving up a list this browser kept before, once), and tells the
 * screens. One read at a time: a call during a read is answered by it, and one more read follows, so a change rung in the
 * meantime is not missed. Rejects with a BlocklistError when the node can't be read; the list then stays as it was.
 *
 * A block, an unblock or Unblock All this page made while the read was on its way stands: the node's answer to it may be
 * newer than the read's, so the read drops its own and one more follows. So does a block another tab took off the
 * browser's list meanwhile (`leaving`): the read's answer may be older than that tab's move.
 */
export function loadBlocklist(): Promise<string[]> {
    if (reading) {
        readAgain = true;
        return reading;
    }
    const forOwner = owner;
    // What another tab took off the browser's list before this read asks, this read's answer settles.
    readStoredList();
    const asked = ++ticks;
    const answersBefore = answers;
    reading = (async () => {
        try {
            const { res, moved } = await moveLocalListUp(await getBlockList());
            if (owner !== forOwner) return current;
            const shown = { list: current.join(), loaded, error: readError };
            if (answers === answersBefore) {
                takeNodeAnswer(res, asked);
            } else {
                // What this read moved up stays shown until the read that follows.
                const tick = ++ticks;
                for (const k of moved) if (!nodeList.includes(k)) leaving.set(k, tick);
                readAgain = true;
            }
            for (const left of leaving.values()) if (left > asked) readAgain = true;
            recompute();
            // Only a read that changed something tells the screens: each time they are told, the open Messages page reads
            // the member list and its conversations again.
            if (current.join() !== shown.list || !shown.loaded || shown.error) emit();
            return current;
        } catch (e) {
            if (owner === forOwner) {
                readError = toBlocklistError(e, 'read');
                emit();
            }
            throw readError ?? toBlocklistError(e, 'read');
        } finally {
            reading = null;
            explicitUnblocks.clear();
            if (readAgain) {
                readAgain = false;
                loadBlocklist().catch(() => { /* told through getBlocklistStatus */ });
            }
        }
    })();
    return reading;
}

/**
 * The signed-in account's list, from now on: read from the node now and again whenever it rings. Returns the stop, for
 * when the account goes (the page reloads at sign-out anyway).
 */
export function startBlocklist(ownerPubkey: string): () => void {
    if (owner !== ownerPubkey) {
        owner = ownerPubkey;
        nodeList = [];
        nodeMax = 0;
        loaded = false;
        readError = null;
        leaving.clear();
        explicitUnblocks.clear();
        clearedAll = false;
        emit();
    }
    const read = () => { loadBlocklist().catch(() => { /* told through getBlocklistStatus */ }); };
    // Another tab changed the list from before kept in this browser (a block or an unblock in a tab still on the build
    // from before, or this build's move there): show what it added now, and read again, which sends up what is new. What
    // it took off stays shown (`leaving`) until the node answers that read: that tab may have moved it up.
    const changedElsewhere = (e: StorageEvent) => {
        if (e.key !== null && e.key !== BLOCKLIST_STORAGE_KEY && e.key !== LEGACY_BLOCKLIST_KEY) return;
        const before = current.join();
        readStoredList();
        recompute();
        if (current.join() !== before) emit();
        read();
    };
    read();
    if (typeof window === 'undefined') return () => {};
    window.addEventListener(BLOCKLIST_DOORBELL_EVENT, read);
    window.addEventListener('storage', changedElsewhere);
    return () => {
        window.removeEventListener(BLOCKLIST_DOORBELL_EVENT, read);
        window.removeEventListener('storage', changedElsewhere);
    };
}

// ── changes, each shown only once the node has taken it ────────────────────────────────────────

/**
 * Blocks a member: the node keeps it for this account, then a report goes to the community's moderators (queued in
 * memory if it can't go now), and the screens are told. Resolves true once the block is in place; throws a
 * BlocklistError, with nothing changed here, when the node didn't take it.
 */
export async function blockUser(
    targetPubkey: string,
    reporterPubkey?: string,
    reason: string = 'User Blocked by Member',
    postId?: string
): Promise<boolean> {
    if (!targetPubkey) return false;
    explicitUnblocks.delete(targetPubkey);
    clearedAll = false;
    const asked = ++ticks;
    let res: BlockList & { added: string[] };
    try {
        res = await addToBlockList(targetPubkey);
    } catch (e) {
        throw toBlocklistError(e, 'block');
    }
    takeNodeAnswer(res, asked);
    emit();
    if (reporterPubkey && Array.isArray(res.added) && res.added.includes(targetPubkey)) {
        try {
            await reportAbuse(reporterPubkey, targetPubkey, reason, postId);
        } catch (err) {
            console.warn('[blocklist] Failed to send reportAbuse on block, queuing for retry:', err);
            queueReportForRetry({ reporterPubkey, targetPubkey, reason, postId, timestamp: Date.now() });
        }
    }
    return true;
}

/** Unblocks a member. Resolves once the node has; throws a BlocklistError, with nothing changed here, when it didn't. */
export async function unblockUser(targetPubkey: string): Promise<boolean> {
    if (!targetPubkey) return false;
    explicitUnblocks.add(targetPubkey);
    const asked = ++ticks;
    let res: BlockList & { removed: boolean };
    try {
        res = await removeFromBlockList(targetPubkey);
    } catch (e) {
        explicitUnblocks.delete(targetPubkey);
        throw toBlocklistError(e, 'unblock');
    }
    // A block still waiting to move up from this browser goes too, or it would be moved up again.
    // Whatever else is there stays, whoever wrote it.
    keepStoredList(k => k === targetPubkey);
    takeNodeAnswer(res, asked);
    leaving.delete(targetPubkey);
    unrecordMovedKey(targetPubkey);
    if (!reading) explicitUnblocks.delete(targetPubkey);
    emit();
    return true;
}

/** Unblock All. Resolves once the node has; throws a BlocklistError, with nothing changed here, when it didn't. */
export async function clearBlocklist(): Promise<void> {
    // Everyone the member saw blocked goes, those still waiting in this browser too. A block another tab makes while this
    // is on its way stays, and goes up with the next read.
    const shown = new Set(getBlockedUsers());
    clearedAll = true;
    const asked = ++ticks;
    let res: BlockList;
    try {
        res = await clearBlockList();
    } catch (e) {
        clearedAll = false;
        throw toBlocklistError(e, 'clear');
    }
    keepStoredList(k => shown.has(k));
    takeNodeAnswer(res, asked);
    for (const k of shown) leaving.delete(k);
    clearMovedKeys();
    explicitUnblocks.clear();
    clearedAll = false;
    emit();
}

// ── reports that could not go when the block was made ─────────────────────────────────────────

const REPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_PENDING_REPORTS = 50;

/** Reports waiting for the next try, in this page's memory only. */
let pendingReports: PendingReport[] = [];

/** A queue a build from before kept in localStorage: taken into memory once, and deleted. */
function takeStoredReports(): void {
    try {
        if (typeof localStorage === 'undefined') return;
        const raw = localStorage.getItem(PENDING_REPORTS_KEY);
        if (raw === null) return;
        localStorage.removeItem(PENDING_REPORTS_KEY);
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) for (const p of parsed) if (p && typeof p.targetPubkey === 'string') queueReportForRetry(p as PendingReport);
    } catch (e) {
        console.warn('[blocklist] Could not read the reports this browser queued before', e);
    }
}

/**
 * Queues a moderation report in memory to retry when the network is back.
 * Deduplicates by targetPubkey, enforces a 7-day TTL, and caps at 50 entries.
 */
export function queueReportForRetry(report: PendingReport) {
    const now = Date.now();
    pendingReports = pendingReports
        .filter(p => now - p.timestamp < REPORT_TTL_MS)
        .filter(p => p.targetPubkey !== report.targetPubkey);
    if (pendingReports.length >= MAX_PENDING_REPORTS) pendingReports.shift();
    pendingReports.push(report);
}

/** The reports waiting in memory (for tests and diagnostics). */
export function getPendingReports(): PendingReport[] {
    return [...pendingReports];
}

/**
 * Retries sending queued reports to the server. Once the signed-in account is known (startBlocklist), only its own go: the
 * node refuses a report that names anyone else as its reporter, so one an older build queued here for another account
 * stays in this page's memory, unsent, and goes with the page.
 */
export async function retryPendingReports(): Promise<void> {
    takeStoredReports();
    const now = Date.now();
    const live = pendingReports.filter(p => now - p.timestamp < REPORT_TTL_MS);
    const due = owner ? live.filter(p => p.reporterPubkey === owner) : live;
    pendingReports = owner ? live.filter(p => p.reporterPubkey !== owner) : [];
    for (const item of due) {
        try {
            await reportAbuse(item.reporterPubkey, item.targetPubkey, item.reason, item.postId);
        } catch {
            queueReportForRetry(item);
        }
    }
}

/** Subscribes to changes of the list in this page. */
export function onBlocklistUpdated(callback: (blocked: string[]) => void): () => void {
    if (typeof window === 'undefined') return () => {};
    const handle = (e: Event) => {
        const detail = (e as CustomEvent).detail;
        callback(Array.isArray(detail) ? detail : getBlockedUsers());
    };
    window.addEventListener(BLOCKLIST_UPDATED_EVENT, handle);
    return () => window.removeEventListener(BLOCKLIST_UPDATED_EVENT, handle);
}

/** Tests only: forget everything in memory, as a new page would. */
export function resetBlocklistForTests(): void {
    owner = null;
    nodeList = [];
    nodeMax = 0;
    loaded = false;
    readError = null;
    localList = undefined;
    leaving.clear();
    ticks = 0;
    answers = 0;
    current = [];
    reading = null;
    readAgain = false;
    pendingReports = [];
    clearMovedKeys();
    explicitUnblocks.clear();
    clearedAll = false;
}

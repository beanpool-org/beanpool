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
 * here drops its answer, which may be older than the node's answer to that change, and reads again. The answer to a change
 * that comes back after the answer to a request made later is older too: the newer stands, and a block only the older
 * holds stays shown until the read that follows (takeNodeAnswer).
 *
 * An unblock or Unblock All the member makes in this page while the move is on its way stands, even when it reaches the
 * node before the move's list does: the move sends no key the member is unblocking here, and once one of its adds has
 * answered, it takes off again each key that add blocked after the member unblocked them here (director's call f8,
 * 2026-09-28). Only what the member did in this page counts, kept in its memory: a key missing from the browser's list is
 * never taken to mean they unblocked it, so this page never sends a remove or Unblock All they didn't ask for here. An
 * unblock made in another tab while this page's move is on its way can be undone by it; that errs toward blocked, and the
 * member sees the block and can lift it again.
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
/**
 * The tick the newest answer this page has taken was asked at. The answer to a request made before it that comes back
 * after it (that request was slower) is older, and is not taken over it (takeNodeAnswer).
 */
let takenAsked = 0;
/**
 * Each key the member unblocked in this page (Unblock All: each key it lifted) and the node took, with the tick the latest
 * such unblock was asked at: an older answer that still holds that key doesn't show it again (takeNodeAnswer). In this
 * page's memory only.
 */
const unblockedHere = new Map<string, number>();
/** What the screens see: the node's list, anything still waiting to move up, and anything `leaving`. */
let current: string[] = [];

let reading: Promise<string[]> | null = null;
let readAgain = false;

/** A block or an unblock the member asked for in this page: of one key, or of everyone shown (Unblock All). */
interface Asked {
    unblock: boolean;
    keys: ReadonlySet<string>;
    /** Settles true once the node has taken it, false when it didn't. */
    taken: Promise<boolean>;
}
/**
 * The unblocks and Unblock Alls the member sent from this page that the node hasn't answered yet. The move sends none of
 * the keys they are about: a list of keys sent after them could reach the node after them.
 */
const unblocksOnTheirWay = new Set<ReadonlySet<string>>();
/**
 * What the member asked for in this page, in order, while one of the move's adds is on its way, and after it answers until
 * all they asked meanwhile has answered too; null otherwise (one read at a time, so one add at most). That add may reach
 * the node after an unblock sent later, and block again whom the member just unblocked here.
 */
let askedDuringAdd: Asked[] | null = null;
/**
 * Keys a move's add blocked again after the member unblocked them in this page, each with the node's stamp on that block
 * (blockedAt): this page takes each off again (sendOwed), and keeps it here until the node has answered that it did. One
 * that doesn't go is sent again by the next read, unless by then the node no longer holds that block (it went, or the key
 * was blocked again since, with a new stamp) or the member has blocked them again here. In this page's memory only, never
 * in the browser: a reload forgets it, and the block the move made then stays, shown, for the member to lift again.
 */
const owed = new Map<string, string | undefined>();
/** The removes of `owed` on their way: a block of the same key made here waits for its own, so it lands after it. */
const owedOnTheirWay = new Map<string, Promise<unknown>>();

/**
 * Notes a block or an unblock the member asks for in this page, as it is sent: for the move's add on its way, if any, and
 * (an unblock) so the move sends none of its keys until the node has answered. Returns the settle, told whether the node
 * took it.
 */
function noteAsked(unblock: boolean, keys: ReadonlySet<string>): (taken: boolean) => void {
    let settle: (taken: boolean) => void = () => {};
    const taken = new Promise<boolean>(r => { settle = r; });
    askedDuringAdd?.push({ unblock, keys, taken });
    if (unblock) unblocksOnTheirWay.add(keys);
    return took => {
        unblocksOnTheirWay.delete(keys);
        settle(took);
    };
}

function isBeingUnblocked(k: string): boolean {
    for (const keys of unblocksOnTheirWay) if (keys.has(k)) return true;
    return false;
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
        for (const k of before) if (isWaiting(k) && !still.has(k)) leaving.set(k, tick);
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

/**
 * The node's answer to a request made at tick `asked`, taken when that request was made after the one whose answer was
 * taken last: it settles every block that joined `leaving` before then. Answers whether it was taken.
 *
 * An answer to a request made before that one, coming back after it (its request was slower), is older: the newer answer
 * stands, and a block it holds is never taken off the screens by the older (#1269's review, 5861163950). The two requests
 * may still have crossed on the way, the older reaching the node last, so a block the older answer holds that the newer
 * doesn't stays shown (`leaving`), unless the member has unblocked that key here since (a block made here since shows
 * through its own answer). When the older answer says anything else the newer doesn't, one more read, asked after both,
 * settles which is right.
 */
function takeNodeAnswer(res: BlockList, asked: number): boolean {
    const keys = Array.isArray(res?.blocked) ? res.blocked.map(b => b.publicKey).filter((k): k is string => typeof k === 'string') : [];
    if (asked < takenAsked) {
        const newer = new Set(nodeList);
        const older = new Set(keys);
        const tick = ++ticks;
        let differs = false;
        for (const k of older) {
            if (newer.has(k)) continue;
            if ((unblockedHere.get(k) ?? 0) > asked) continue;
            leaving.set(k, tick);
            differs = true;
        }
        for (const k of newer) if (!older.has(k)) differs = true;
        if (differs) loadBlocklist().catch(() => { /* told through getBlocklistStatus */ });
        return false;
    }
    nodeList = keys;
    nodeMax = typeof res?.max === 'number' ? res.max : 0;
    loaded = true;
    readError = null;
    answers++;
    takenAsked = asked;
    for (const [k, left] of leaving) if (left < asked) leaving.delete(k);
    return true;
}

/** Notes the member's unblock of `k` here, asked at tick `asked`, once the node has taken it. */
function noteUnblockedHere(k: string, asked: number): void {
    if ((unblockedHere.get(k) ?? 0) < asked) unblockedHere.set(k, asked);
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
 *
 * A key the member is unblocking in this page is not sent (the next read sends it if the node didn't take that unblock),
 * and each add the move sends goes through sendMoveAdd, which takes off again what it blocked after an unblock made here.
 */
async function moveLocalListUp(res: BlockList): Promise<{ res: BlockList; moved: string[] }> {
    if (readStoredList() === null) return { res, moved: [] };
    const forOwner = owner;
    let now = res;
    /** The keys this move has sent, or found no room for: what another tab adds meanwhile is new to it. */
    const seen = new Set<string>();
    moving: for (;;) {
        const have = heldBy(now);
        const fresh = (readStoredList() ?? []).filter(k => isWaiting(k) && !have.has(k) && !seen.has(k) && !isBeingUnblocked(k));
        if (fresh.length === 0) break;
        fresh.forEach(k => seen.add(k));
        const room = Math.max(0, (now.max ?? 0) - have.size);
        const going = fresh.slice(Math.max(0, fresh.length - room));
        if (going.length < fresh.length) {
            console.warn(`[blocklist] ${fresh.length - going.length} of the blocks this browser kept don't fit in your list on the community; they stay here, still blocked, until there is room.`);
        }
        if (going.length === 0) break;
        try {
            now = await sendMoveAdd(going, forOwner);
        } catch (e) {
            console.warn('[blocklist] The community did not take the list this browser kept; it stays here and is tried again', e);
            break;
        }
        const taken = heldBy(now);
        for (const k of going) {
            if (taken.has(k) || !readStoredList()?.includes(k) || isBeingUnblocked(k)) continue;
            try {
                now = await sendMoveAdd(k, forOwner);
            } catch (e) {
                console.warn('[blocklist] Some of the blocks this browser kept did not go up to the community; they stay here and are tried again', e);
                break moving;
            }
        }
    }
    const held = heldBy(now);
    const moved = keepStoredList(k => held.has(k));
    return { res: now, moved };
}

/**
 * Sends one of the move's adds (a list of keys, or one key), and answers the node's list after it. Once it has answered,
 * each key it blocked that the member unblocked in this page while it was on its way (their last word on that key here,
 * as the node took it: a block made here after the unblock stands, even one made once the add has answered and before the
 * unblock has) is owed, and taken off again (sendOwed): the member's remove may have reached the node before this add did.
 * An unblock made here after the add answered needs nothing more: it lands after it. Only a key this add itself blocked
 * (its `added`): one it found blocked already was blocked by someone else, or the member's remove is yet to land. Nothing
 * is owed once another account has signed in here, whose list any request now changes.
 *
 * Rejects as the add did, owing nothing: without its answer this page can't tell a block the add made from one made since
 * elsewhere, so the add, if it did reach the node, may have blocked again whom the member unblocked here. That errs toward
 * blocked, and the next read shows it.
 */
async function sendMoveAdd(keys: string | string[], forOwner: string | null): Promise<BlockList> {
    const sent = new Set(Array.isArray(keys) ? keys : [keys]);
    const asked: Asked[] = [];
    askedDuringAdd = asked;
    let res: BlockList & { added?: string[] };
    let about = false;
    const unblocked = new Set<string>();
    try {
        res = await addToBlockList(keys);
        // What the member asks for here from now on reaches the node after this add: their later word, noted until all
        // they asked before has answered, so a block they make meanwhile is never taken off below (#1269's 4117304623).
        const answered = asked.length;
        for (let i = 0; i < asked.length; i++) {
            const a = asked[i];
            if (![...a.keys].some(k => sent.has(k))) continue;
            about = true;
            if (!(await a.taken)) continue;
            for (const k of a.keys) {
                if (!sent.has(k)) continue;
                // An unblock sent after this add answered lands after it, and takes them off itself.
                if (a.unblock && i < answered) unblocked.add(k);
                else unblocked.delete(k);
            }
        }
    } finally {
        if (askedDuringAdd === asked) askedDuringAdd = null;
    }
    if (!about || owner !== forOwner) return res;
    const added = Array.isArray(res.added) ? new Set(res.added) : sent;
    const stamps = new Map(Array.isArray(res.blocked) ? res.blocked.map(b => [b.publicKey, b.blockedAt] as const) : []);
    for (const k of unblocked) if (added.has(k)) owed.set(k, stamps.get(k));
    return owed.size > 0 ? sendOwed(res, forOwner) : res;
}

/**
 * Sends the removes this page owes (`owed`), one at a time, given the node's list as `now` has it, and answers the node's
 * list after them. One the node no longer needs, because it doesn't hold that block (it went, or holds a newer one of the
 * same key), is let go unsent. The first that doesn't go stops the rest: they stay owed, and the next read sends them.
 */
async function sendOwed(now: BlockList, forOwner: string | null): Promise<BlockList> {
    for (const [k, stamp] of [...owed]) {
        if (owner !== forOwner) break;
        // Blocked again here meanwhile: the member's last word.
        if (!owed.has(k)) continue;
        const held = Array.isArray(now?.blocked) ? now.blocked.find(b => b.publicKey === k) : undefined;
        if (!held || (stamp !== undefined && held.blockedAt !== stamp)) {
            owed.delete(k);
            continue;
        }
        const going = removeFromBlockList(k);
        owedOnTheirWay.set(k, going);
        try {
            now = await going;
            owed.delete(k);
        } catch (e) {
            console.warn('[blocklist] Could not unblock again someone the move blocked after the member unblocked them here; the next read tries again', e);
            break;
        } finally {
            if (owedOnTheirWay.get(k) === going) owedOnTheirWay.delete(k);
        }
    }
    return now;
}

/**
 * Reads the node's list for the signed-in account (sending first any remove this page still owes, then moving up a list
 * this browser kept before, once), and tells the screens. One read at a time: a call during a read is answered by it, and
 * one more read follows, so a change rung in the meantime is not missed. Rejects with a BlocklistError when the node
 * can't be read; the list then stays as it was.
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
            const read = await getBlockList();
            const { res, moved } = await moveLocalListUp(owed.size > 0 ? await sendOwed(read, forOwner) : read);
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
        // What the account before is owed is for its list, and every request now changes this one's.
        owed.clear();
        unblockedHere.clear();
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
    // The member's last word on them is this block: a remove this page still owes them is let go, and one on its way lands
    // first.
    owed.delete(targetPubkey);
    const unblocking = owedOnTheirWay.get(targetPubkey);
    if (unblocking) await unblocking.catch(() => { /* the block goes either way */ });
    const asked = ++ticks;
    const settle = noteAsked(false, new Set([targetPubkey]));
    let res: BlockList & { added: string[] };
    try {
        res = await addToBlockList(targetPubkey);
    } catch (e) {
        settle(false);
        throw toBlocklistError(e, 'block');
    }
    settle(true);
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
    const asked = ++ticks;
    const settle = noteAsked(true, new Set([targetPubkey]));
    let res: BlockList & { removed: boolean };
    try {
        res = await removeFromBlockList(targetPubkey);
    } catch (e) {
        settle(false);
        throw toBlocklistError(e, 'unblock');
    }
    settle(true);
    noteUnblockedHere(targetPubkey, asked);
    // A block still waiting to move up from this browser goes too, or it would be moved up again; so do those the node now
    // holds. Whatever else is there stays, whoever wrote it.
    const held = heldBy(res);
    keepStoredList(k => k === targetPubkey || held.has(k));
    takeNodeAnswer(res, asked);
    leaving.delete(targetPubkey);
    emit();
    return true;
}

/** Unblock All. Resolves once the node has; throws a BlocklistError, with nothing changed here, when it didn't. */
export async function clearBlocklist(): Promise<void> {
    // Everyone the member saw blocked goes, those still waiting in this browser too. A block another tab makes while this
    // is on its way stays, and goes up with the next read.
    const shown = new Set(getBlockedUsers());
    const asked = ++ticks;
    const settle = noteAsked(true, shown);
    let res: BlockList;
    try {
        res = await clearBlockList();
    } catch (e) {
        settle(false);
        throw toBlocklistError(e, 'clear');
    }
    settle(true);
    for (const k of shown) noteUnblockedHere(k, asked);
    const held = heldBy(res);
    keepStoredList(k => shown.has(k) || held.has(k));
    takeNodeAnswer(res, asked);
    for (const k of shown) leaving.delete(k);
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
    takenAsked = 0;
    unblockedHere.clear();
    current = [];
    reading = null;
    readAgain = false;
    unblocksOnTheirWay.clear();
    askedDuringAdd = null;
    owed.clear();
    owedOnTheirWay.clear();
    pendingReports = [];
}

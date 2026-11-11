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
 * Nothing leaves the screens before the node says so. A read that was on its way when the member blocked, unblocked or
 * cleared here drops its answer, which may be older than the node's answer to that change, and reads again. The answer to
 * a change that comes back after the answer to a request made later is older too: the newer stands. Two requests on their
 * way together may cross before they reach the node, so a block either answer holds stays shown until a read asked after
 * both has answered, unless the member unblocked them here (takeNodeAnswer).
 *
 * A report a block sends that can't reach the node waits in memory for the next try (retryPendingReports). Once the
 * account is known, only its own reports are sent.
 */
import { t, word } from '@beanpool/core';
import { reportAbuse, getBlockList, addToBlockList, removeFromBlockList, clearBlockList, type BlockList } from './api';
import { BLOCKLIST_DOORBELL_EVENT } from './blocklist-doorbell';

export const BLOCKLIST_UPDATED_EVENT = 'bp_blocklist_updated';

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

/** word() keys: each is drawn through t() when the error is made, so in the language the member reads then. */
const UNREACHABLE = {
    read: word('Couldn’t load your blocked members from your community. Check your connection and try again.'),
    block: word('Couldn’t reach your community, so they are not blocked. Check your connection and try again.'),
    unblock: word('Couldn’t reach your community, so they are still blocked. Check your connection and try again.'),
    clear: word('Couldn’t reach your community, so nobody was unblocked. Check your connection and try again.'),
} as const;

/**
 * What the member is told: the node's own words when it answered and refused (already in the member's language when the
 * node has them), else that it couldn't be reached, in the member's language.
 */
function toBlocklistError(e: unknown, action: keyof typeof UNREACHABLE): BlocklistError {
    const status = (e as { status?: number } | null)?.status;
    const code = (e as { code?: string } | null)?.code;
    const said = e instanceof Error ? e.message : '';
    if (typeof status === 'number' && status >= 400 && status < 500 && said) return new BlocklistError(said, status, code);
    return new BlocklistError(t(UNREACHABLE[action]), status, code);
}

// ── the list, in this page's memory ─────────────────────────────────────────────────────────────

/** The account whose list this is (startBlocklist). */
let owner: string | null = null;
/** The node's list for `owner`, as it last answered. */
let nodeList: string[] = [];
/** Whether the node's list has been read for `owner`. */
let loaded = false;
/** Why the last read failed, until one succeeds. */
let readError: BlocklistError | null = null;
/**
 * Blocks this page showed that the node's list this page holds no longer has, because an older answer crossed a newer one
 * on its way; each with the tick it left at. Each stays shown until this page takes an answer from the node asked for after
 * that tick: only the node's answer takes a block off the screens, so a block the node holds is never shown gone, even for
 * a moment.
 */
const leaving = new Map<string, number>();
/** This page's clock: it ticks as a request to the node is made, as blocks join `leaving`, and as an answer is taken. */
let ticks = 0;
/**
 * How many answers from the node this page has taken: a read, a block, an unblock, Unblock All. A read during which this
 * moved may be older than what was taken meanwhile: it drops its answer, and one more read follows.
 */
let answers = 0;
/**
 * The tick the newest answer this page has taken was asked at, and the tick it was taken at. The answer to a request made
 * before it that comes back after it (that request was slower) is older, and is not taken over it; one to a request made
 * before it came back was on its way with it (takeNodeAnswer).
 */
let takenAsked = 0;
let takenAt = 0;
/**
 * Each key the member unblocked in this page (Unblock All: each key it lifted) and the node took, with the tick the latest
 * such unblock was asked at: an older answer that still holds that key doesn't show it again (takeNodeAnswer). In this
 * page's memory only.
 */
const unblockedHere = new Map<string, number>();
/** What the screens see: the node's list, and anything `leaving`. */
let current: string[] = [];

let reading: Promise<string[]> | null = null;
let readAgain = false;

function recompute(): void {
    current = [...new Set([...nodeList, ...leaving.keys()])];
}

function emit(): void {
    recompute();
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(BLOCKLIST_UPDATED_EVENT, { detail: current }));
    }
}

/**
 * The node's answer to a request made at tick `asked`, taken when that request was made after the one whose answer was
 * taken last: it settles every block that joined `leaving` before then. When it was made before that answer came back,
 * the two were on their way together and may have crossed, this one reaching the node first: a block the answer taken
 * before holds that this one doesn't stays shown (`leaving`), unless this request was the member's unblock of it, and one
 * more read settles which is right.
 *
 * An answer to a request made before that one, coming back after it (its request was slower), is older: the newer answer
 * stands, and a block it holds is never taken off the screens by the older (#1269's review, 5861163950). The two requests
 * may still have crossed on the way, the older reaching the node last, so a block the older answer holds that the newer
 * doesn't stays shown (`leaving`), unless the member has unblocked that key here since (a block made here since shows
 * through its own answer). When the older answer says anything else the newer doesn't, one more read, asked after both,
 * settles which is right.
 */
function takeNodeAnswer(res: BlockList, asked: number): void {
    const keys = Array.isArray(res?.blocked) ? res.blocked.map(b => b.publicKey).filter((k): k is string => typeof k === 'string') : [];
    if (asked < takenAsked) {
        const newer = new Set(nodeList);
        const older = new Set(keys);
        const tick = ++ticks;
        let differs = false;
        // What the older request itself added (the node's `added`): a block of a key the member unblocked here since that
        // reached the node after the unblock, so the node holds it again and the page must say so (#1278 review 4119489106).
        const added = (res as { added?: unknown })?.added;
        const addedByIt = new Set(Array.isArray(added) ? added : []);
        for (const k of older) {
            if (newer.has(k)) continue;
            if ((unblockedHere.get(k) ?? 0) > asked && !addedByIt.has(k)) continue;
            leaving.set(k, tick);
            differs = true;
        }
        for (const k of newer) if (!older.has(k)) differs = true;
        if (differs) loadBlocklist().catch(() => { /* told through getBlocklistStatus */ });
        return;
    }
    let readAfter = false;
    if (asked < takenAt) {
        const now = new Set(keys);
        const tick = ++ticks;
        for (const k of nodeList) {
            if (now.has(k) || (unblockedHere.get(k) ?? 0) >= asked) continue;
            leaving.set(k, tick);
            readAfter = true;
        }
    }
    nodeList = keys;
    loaded = true;
    readError = null;
    answers++;
    takenAsked = asked;
    takenAt = ++ticks;
    for (const [k, left] of leaving) if (left < asked) leaving.delete(k);
    // Asked once this answer is taken, so the read doesn't drop its own answer for it.
    if (readAfter) loadBlocklist().catch(() => { /* told through getBlocklistStatus */ });
}

/** Notes the member's unblock of `k` here, asked at tick `asked`, once the node has taken it. */
function noteUnblockedHere(k: string, asked: number): void {
    if ((unblockedHere.get(k) ?? 0) < asked) unblockedHere.set(k, asked);
}

/** The keys this member has blocked, for the screens that hide them. */
export function getBlockedUsers(): string[] {
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
 * Reads the node's list for the signed-in account, and tells the screens. One read at a time: a call during a read is
 * answered by it, and one more read follows, so a change rung in the meantime is not missed. Rejects with a BlocklistError
 * when the node can't be read; the list then stays as it was.
 *
 * A block, an unblock or Unblock All this page made while the read was on its way stands: the node's answer to it may be
 * newer than the read's, so the read drops its own and one more follows. So does a block still `leaving`: the read's
 * answer may be older than the answer that put it there.
 */
export function loadBlocklist(): Promise<string[]> {
    if (reading) {
        readAgain = true;
        return reading;
    }
    const forOwner = owner;
    const asked = ++ticks;
    const answersBefore = answers;
    reading = (async () => {
        try {
            const res = await getBlockList();
            if (owner !== forOwner) return current;
            const shown = { list: current.join(), loaded, error: readError };
            if (answers === answersBefore) {
                takeNodeAnswer(res, asked);
            } else {
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
        loaded = false;
        readError = null;
        leaving.clear();
        unblockedHere.clear();
        emit();
    }
    const read = () => { loadBlocklist().catch(() => { /* told through getBlocklistStatus */ }); };
    read();
    if (typeof window === 'undefined') return () => {};
    window.addEventListener(BLOCKLIST_DOORBELL_EVENT, read);
    return () => window.removeEventListener(BLOCKLIST_DOORBELL_EVENT, read);
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
    const asked = ++ticks;
    let res: BlockList & { removed: boolean };
    try {
        res = await removeFromBlockList(targetPubkey);
    } catch (e) {
        throw toBlocklistError(e, 'unblock');
    }
    noteUnblockedHere(targetPubkey, asked);
    takeNodeAnswer(res, asked);
    leaving.delete(targetPubkey);
    emit();
    return true;
}

/** Unblock All. Resolves once the node has; throws a BlocklistError, with nothing changed here, when it didn't. */
export async function clearBlocklist(): Promise<void> {
    // Everyone the member saw blocked goes. A block made elsewhere while this is on its way stays, and shows with the next read.
    const shown = new Set(getBlockedUsers());
    const asked = ++ticks;
    let res: BlockList;
    try {
        res = await clearBlockList();
    } catch (e) {
        throw toBlocklistError(e, 'clear');
    }
    for (const k of shown) noteUnblockedHere(k, asked);
    takeNodeAnswer(res, asked);
    for (const k of shown) leaving.delete(k);
    emit();
}

// ── reports that could not go when the block was made ─────────────────────────────────────────

const REPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_PENDING_REPORTS = 50;

/** Reports waiting for the next try, in this page's memory only. */
let pendingReports: PendingReport[] = [];

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
 * node refuses a report that names anyone else as its reporter.
 */
export async function retryPendingReports(): Promise<void> {
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
    loaded = false;
    readError = null;
    leaving.clear();
    ticks = 0;
    answers = 0;
    takenAsked = 0;
    takenAt = 0;
    unblockedHere.clear();
    current = [];
    reading = null;
    readAgain = false;
    pendingReports = [];
}

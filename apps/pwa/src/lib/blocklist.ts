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
 * node once and the local keys deleted, only when the node has taken it; until then it still hides whom it names, and
 * the next read tries again. Past the node's limit, the newest it has room for go up.
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
/** The node's list for `owner`, as it last answered. */
let nodeList: string[] = [];
/** Whether the node's list has been read for `owner`. */
let loaded = false;
/** Why the last read failed, until one succeeds. */
let readError: BlocklistError | null = null;
/** A list from before still in this browser, not yet moved up: undefined until read, null once there is none. */
let localList: string[] | null | undefined;
/** What the screens see: the node's list and anything still waiting to move up. */
let current: string[] = [];

let reading: Promise<string[]> | null = null;
let readAgain = false;

function readLocalList(): string[] | null {
    if (localList !== undefined) return localList;
    localList = null;
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
        localList = any ? found : null;
    } catch (e) {
        console.warn('[blocklist] Could not read the list this browser kept before', e);
    }
    return localList;
}

function forgetLocalList(): void {
    localList = null;
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.removeItem(BLOCKLIST_STORAGE_KEY);
            localStorage.removeItem(LEGACY_BLOCKLIST_KEY);
        }
    } catch (e) {
        console.warn('[blocklist] Could not delete the list this browser kept before', e);
    }
}

function recompute(): void {
    const local = readLocalList() ?? [];
    current = [...new Set([...nodeList, ...local])];
}

function emit(): void {
    recompute();
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(BLOCKLIST_UPDATED_EVENT, { detail: current }));
    }
}

function takeNodeAnswer(res: BlockList): void {
    nodeList = Array.isArray(res?.blocked) ? res.blocked.map(b => b.publicKey).filter((k): k is string => typeof k === 'string') : [];
    loaded = true;
    readError = null;
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
 * The list this browser kept before, moved up to the node for the signed-in account. Answers the node's list after it:
 * the move's answer, or `res` when there was nothing to move or the node didn't take it (the local list then stays, and
 * the next read tries again).
 */
async function moveLocalListUp(res: BlockList): Promise<BlockList> {
    const local = readLocalList();
    if (local === null) return res;
    const have = new Set(res.blocked.map(b => b.publicKey));
    let moving = local.filter(k => MEMBER_KEY.test(k) && k !== owner && !have.has(k));
    const room = Math.max(0, (res.max ?? 0) - res.blocked.length);
    if (moving.length > room) {
        console.warn(`[blocklist] ${moving.length - room} of the ${moving.length} blocks this browser kept don't fit in your list on the community; the newest go up.`);
        moving = moving.slice(moving.length - room);
    }
    if (moving.length === 0) {
        forgetLocalList();
        return res;
    }
    try {
        const moved = await addToBlockList(moving);
        forgetLocalList();
        return moved;
    } catch (e) {
        console.warn('[blocklist] The community did not take the list this browser kept; it stays here and is tried again', e);
        return res;
    }
}

/**
 * Reads the node's list for the signed-in account (moving up a list this browser kept before, once), and tells the
 * screens. One read at a time: a call during a read is answered by it, and one more read follows, so a change rung in the
 * meantime is not missed. Rejects with a BlocklistError when the node can't be read; the list then stays as it was.
 */
export function loadBlocklist(): Promise<string[]> {
    if (reading) {
        readAgain = true;
        return reading;
    }
    const forOwner = owner;
    reading = (async () => {
        try {
            const res = await moveLocalListUp(await getBlockList());
            if (owner !== forOwner) return current;
            takeNodeAnswer(res);
            emit();
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
    let res: BlockList & { added: string[] };
    try {
        res = await addToBlockList(targetPubkey);
    } catch (e) {
        throw toBlocklistError(e, 'block');
    }
    takeNodeAnswer(res);
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
    let res: BlockList & { removed: boolean };
    try {
        res = await removeFromBlockList(targetPubkey);
    } catch (e) {
        throw toBlocklistError(e, 'unblock');
    }
    // A block still waiting to move up from this browser goes too, or it would be moved up again.
    const local = readLocalList();
    if (local?.includes(targetPubkey)) {
        localList = local.filter(k => k !== targetPubkey);
        try {
            if (typeof localStorage !== 'undefined') localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify(localList));
            if (typeof localStorage !== 'undefined') localStorage.removeItem(LEGACY_BLOCKLIST_KEY);
        } catch { /* the in-memory list is what the screens read */ }
    }
    takeNodeAnswer(res);
    emit();
    return true;
}

/** Unblock All. Resolves once the node has; throws a BlocklistError, with nothing changed here, when it didn't. */
export async function clearBlocklist(): Promise<void> {
    let res: BlockList;
    try {
        res = await clearBlockList();
    } catch (e) {
        throw toBlocklistError(e, 'clear');
    }
    if (readLocalList() !== null) forgetLocalList();
    takeNodeAnswer(res);
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
    loaded = false;
    readError = null;
    localList = undefined;
    current = [];
    reading = null;
    readAgain = false;
    pendingReports = [];
}

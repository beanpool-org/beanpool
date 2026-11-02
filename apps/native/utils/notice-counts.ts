/**
 * What waits at each community this phone keeps, as far as the phone has heard: the little numbers on the BeanPool sheet's
 * community rows (app/beanpool.tsx; Marty, 24 Oct: "at the very least the node list should have little numbers if there
 * are notifications on a node"), and the other communities' part of the app-icon badge (other-communities-unread.ts).
 *
 * It has two sources (scratch/fable-design/DESIGN-cross-community-chat-fable.md R6, R7). The notices the phone already
 * holds: a push its own community signed for this account (push-notice-check.ts `verifiedNotice`), whether it came while
 * the app was open (the notification handler), sits in the phone's notification list as the app opens or comes back, or was
 * tapped (push-notice-switch.ts). And each community's own unread count, as it last answered a round
 * ({@link noteServerUnread}).
 *
 * - **A community's answer is its number**, and the notices count afresh from there. Between rounds the number is the
 *   larger of the two, never their sum ({@link readNoticeCounts}): a push and the count that holds it are one message.
 * - **The community in use never counts.** Its notices are noted as seen all the same, so they don't count either once
 *   the member moves on and they still sit in the phone's notification list.
 * - **A community's count goes back to nothing as it becomes the one in use** ({@link clearActiveCount}, on every switch:
 *   community-switch.ts), and what it last said goes with it.
 * - **Each notice counts once**, by its id, however many ways it reaches the phone. Ids are kept as long as a notice can
 *   still pass the check (its lifetime and the clock skew), at most {@link SEEN_MAX} a community.
 * - **A restart keeps them** ({@link NOTICE_COUNTS_STORE_KEY}); the account leaving the phone takes them with it
 *   (identity.ts `wipeIdentityScopedStorage`), and a community the phone forgets takes its own.
 *
 * Writes are ordered against each other here, the wipe's ({@link forgetNoticeCounts}) too; nothing else writes that key.
 */
import { PUSH_NOTICE_CLOCK_SKEW_SECONDS, PUSH_NOTICE_LIFETIME_SECONDS } from '@beanpool/core';
import { communityAddress } from './push-pins';
import { NOTICE_COUNTS_STORE_KEY, SAVED_NODES_STORE_KEY } from './storage-keys';
import { onCommunitySwitched } from './community-switch';

export { NOTICE_COUNTS_STORE_KEY };

const ANCHOR_STORE_KEY = 'beanpool_anchor_url';
/** As long as a notice can pass the check (push-notice-check.ts keeps its own ledger as long). */
const SEEN_KEEP_SECONDS = PUSH_NOTICE_LIFETIME_SECONDS + PUSH_NOTICE_CLOCK_SKEW_SECONDS;
/** The most ids kept a community; the oldest go first. More than the 100 a member's node keeps for 7 days. */
const SEEN_MAX = 500;

interface Storage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}

/**
 * A community's count, the notices it has seen (id → when the phone noted it, whole seconds), its own unread count as it
 * last answered a round, and what a rise is measured from: how many of those lines it said a push would have told
 * ({@link noteServerUnread}). The last two are absent until it answers, and again after a switch to it.
 */
interface Tally { n: number; seen: Record<string, number>; server?: number; alerts?: number }
type Tallies = Record<string, Tally>;

function parse(raw: string | null): Tallies {
    const out: Tallies = {};
    try {
        const parsed = JSON.parse(raw ?? '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
        for (const [community, v] of Object.entries(parsed as Record<string, unknown>)) {
            const at = communityAddress(community);
            const tally = v && typeof v === 'object' ? v as { n?: unknown; seen?: unknown; server?: unknown; alerts?: unknown } : null;
            if (!at || !tally) continue;
            const seen: Record<string, number> = {};
            if (tally.seen && typeof tally.seen === 'object') {
                for (const [id, t] of Object.entries(tally.seen as Record<string, unknown>)) {
                    if (typeof t === 'number' && Number.isSafeInteger(t)) seen[id] = t;
                }
            }
            const n = typeof tally.n === 'number' && Number.isSafeInteger(tally.n) && tally.n > 0 ? tally.n : 0;
            out[at] = { n, seen };
            if (typeof tally.server === 'number' && Number.isSafeInteger(tally.server) && tally.server >= 0) out[at].server = tally.server;
            if (typeof tally.alerts === 'number' && Number.isSafeInteger(tally.alerts) && tally.alerts >= 0) out[at].alerts = tally.alerts;
        }
    } catch {
        // Counts that can't be read are none: a number shown wrong is worse than none.
    }
    return out;
}

/** The communities the phone keeps (the one it is set to, and its saved list), or null when the list can't be read. */
function keptCommunities(anchor: string | null, rawSaved: string | null): Set<string> | null {
    let saved: unknown;
    try {
        saved = JSON.parse(rawSaved ?? '[]');
    } catch {
        return null;
    }
    if (!Array.isArray(saved)) return null;
    const urls = [anchor, ...saved.map((n) => (n && typeof n === 'object' ? (n as { url?: unknown }).url : null))];
    return new Set(urls.map(communityAddress).filter((c): c is string => c !== null));
}

const listeners = new Set<() => void>();

/** Called after each change of the counts. Returns the unsubscribe. */
export function onNoticeCounts(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

function changed(): void {
    for (const listener of [...listeners]) {
        try { listener(); } catch { /* one listener's trouble is not the count's */ }
    }
}

let writes: Promise<unknown> = Promise.resolve();

/**
 * Read the counts, let `change` alter them (it is told the community in use, and those the phone keeps: null when that list
 * can't be read), and write them back if it did, after any change under way. Resolves to whether that all held. Never
 * throws: a count that can't be kept is logged, and the numbers stay as they were.
 */
function update(storage: Storage, change: (tallies: Tallies, active: string | null, kept: Set<string> | null) => boolean): Promise<boolean> {
    const next = writes.then(async () => {
        const raw = await storage.getItem(NOTICE_COUNTS_STORE_KEY);
        const anchor = communityAddress(await storage.getItem(ANCHOR_STORE_KEY));
        const tallies = parse(raw);
        const kept = keptCommunities(anchor, await storage.getItem(SAVED_NODES_STORE_KEY));
        let dirty = change(tallies, anchor, kept);
        // A community the phone no longer keeps takes its count with it (not when the list can't be read: a list that
        // can't be read says nothing about what was forgotten).
        if (kept) for (const c of Object.keys(tallies)) if (!kept.has(c)) { delete tallies[c]; dirty = true; }
        if (dirty) {
            await storage.setItem(NOTICE_COUNTS_STORE_KEY, JSON.stringify(tallies));
            changed();
        }
        return true;
    }).catch((e) => {
        console.warn('[Notices] A community\'s count of notices could not be kept', e);
        return false;
    });
    writes = next;
    return next;
}

/**
 * Notice `id` from `community` reached the phone: counted for that community, unless it is the one in use, or this notice
 * was counted (or seen there) before. Only for a notice the phone checked first (push-notice-check.ts `verifiedNotice`, or
 * a tap's `checkTap`). Never throws.
 */
export async function countNotice(storage: Storage, community: string, id: string, now: number = Math.floor(Date.now() / 1000)): Promise<void> {
    await update(storage, (tallies, active) => {
        const at = communityAddress(community);
        if (!at) return false;
        const tally = tallies[at] ?? { n: 0, seen: {} };
        if (id in tally.seen) return false;
        tally.seen[id] = now;
        const kept = Object.entries(tally.seen).filter(([, t]) => now - t <= SEEN_KEEP_SECONDS).sort((a, b) => b[1] - a[1]);
        tally.seen = Object.fromEntries(kept.slice(0, SEEN_MAX));
        if (at !== active) tally.n += 1;
        tallies[at] = tally;
        return true;
    });
}

/**
 * `community` answered a round with its own unread count: that is its number from now on, and the notices count afresh from
 * there. `alerts` is how many of those lines it says a push would have told; a node too old to say gives `unread` here.
 * Resolves to whether `alerts` rose on what it last said, written down before it says so, so one rise is one caller's to
 * tell and nobody tells it twice (two rounds at once, or a write that failed): a line in a muted chat moves the number and
 * tells nobody. A community that has said nothing since it was last in use is compared with none waiting. Nothing for the
 * community in use (the member moved there while it answered) or one the phone doesn't keep. Never throws.
 */
export async function noteServerUnread(storage: Storage, community: string, unread: number, alerts: number = unread): Promise<boolean> {
    let rose = false;
    const held = await update(storage, (tallies, active, kept) => {
        const at = communityAddress(community);
        if (!at || at === active || !kept?.has(at)) return false;
        const tally = tallies[at] ?? { n: 0, seen: {} };
        const same = tally.server === unread && tally.alerts === alerts && tally.n === 0;
        rose = alerts > (tally.alerts ?? 0);
        tally.server = unread;
        tally.alerts = alerts;
        tally.n = 0;
        tallies[at] = tally;
        return !same;
    });
    return held && rose;
}

/**
 * These communities show no number from now on, of either kind: the rounds don't ask them (alerts off, a look, one that
 * says this account isn't theirs). The notices they sent stay noted as seen. Never throws.
 */
export async function dropCounts(storage: Storage, communities: readonly string[]): Promise<void> {
    await update(storage, (tallies) => {
        let dirty = false;
        for (const community of communities) {
            const at = communityAddress(community);
            const tally = at ? tallies[at] : undefined;
            if (!tally || (tally.n === 0 && tally.server === undefined)) continue;
            tally.n = 0;
            delete tally.server;
            delete tally.alerts;
            dirty = true;
        }
        return dirty;
    });
}

/**
 * The community the phone is set to is open: its count goes back to nothing, and what it last said with it. Its notices stay
 * noted as seen, so one still in the phone's notification list doesn't count again once the member moves on. Never throws.
 */
export async function clearActiveCount(storage: Storage): Promise<void> {
    await update(storage, (tallies, active) => {
        const tally = active ? tallies[active] : undefined;
        if (!tally || (tally.n === 0 && tally.server === undefined)) return false;
        tally.n = 0;
        delete tally.server;
        delete tally.alerts;
        return true;
    });
}

/**
 * Each community's number, by its address (push-pins.ts `communityAddress`), after any change under way: the larger of its
 * push tally and what it last said, only for the communities the phone keeps, never the one in use, and none at 0. Empty
 * when they can't be read.
 */
export async function readNoticeCounts(storage: Pick<Storage, 'getItem'>): Promise<Record<string, number>> {
    await writes;
    try {
        const tallies = parse(await storage.getItem(NOTICE_COUNTS_STORE_KEY));
        const anchor = communityAddress(await storage.getItem(ANCHOR_STORE_KEY));
        const kept = keptCommunities(anchor, await storage.getItem(SAVED_NODES_STORE_KEY));
        const out: Record<string, number> = {};
        for (const [c, tally] of Object.entries(tallies)) {
            const number = Math.max(tally.n, tally.server ?? 0);
            if (c !== anchor && number > 0 && (!kept || kept.has(c))) out[c] = number;
        }
        return out;
    } catch {
        return {};
    }
}

/** Every number {@link readNoticeCounts} gives, added up: the other communities' part of the app-icon badge. */
export async function noticeCountsSum(storage: Pick<Storage, 'getItem'>): Promise<number> {
    return Object.values(await readNoticeCounts(storage)).reduce((sum, n) => sum + n, 0);
}

/** A community's count from {@link readNoticeCounts}, for its saved address however it was written. */
export function noticeCountFor(counts: Record<string, number>, url: string): number {
    const at = communityAddress(url);
    return (at && counts[at]) || 0;
}

/**
 * The account leaves the phone (identity.ts `wipeIdentityScopedStorage`): its counts go, after any change under way, so
 * none lands after them and brings them back. Never throws.
 */
export function forgetNoticeCounts(storage: { removeItem(key: string): Promise<void> }): Promise<void> {
    const next = writes.then(() => storage.removeItem(NOTICE_COUNTS_STORE_KEY)).then(changed).catch((e) => {
        console.warn('[Notices] The counts of notices could not be removed', e);
    });
    writes = next;
    return next;
}

/**
 * Clears the count of the community the phone is set to now, and again after every switch (community-switch.ts: every
 * write of the phone's community says so). Returns the way to stop.
 */
export function watchNoticeCounts(storage: Storage): () => void {
    void clearActiveCount(storage);
    return onCommunitySwitched(() => { void clearActiveCount(storage); });
}

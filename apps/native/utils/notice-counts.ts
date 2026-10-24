/**
 * How many notices each community this phone keeps sent the account on it since the member last had that community open:
 * the little numbers on the BeanPool sheet's community rows (app/beanpool.tsx; Marty, 24 Oct: "at the very least the node
 * list should have little numbers if there are notifications on a node").
 *
 * Counted on the phone alone, from notices it already holds: a push its own community signed for this account
 * (push-notice-check.ts `verifiedNotice`), whether it came while the app was open (the notification handler), sits in the
 * phone's notification list as the app opens or comes back, or was tapped (push-notice-switch.ts). Nothing is asked of any
 * community for these numbers: no request, no polling, nothing for a community to learn, no battery spent.
 *
 * - **The community in use never counts.** Its notices are noted as seen all the same, so they don't count either once
 *   the member moves on and they still sit in the phone's notification list.
 * - **A community's count goes back to nothing as it becomes the one in use** ({@link clearActiveCount}, on every switch:
 *   community-switch.ts).
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

/** A community's count, and the notices it has seen: id → when the phone noted it (whole seconds). */
interface Tally { n: number; seen: Record<string, number> }
type Tallies = Record<string, Tally>;

function parse(raw: string | null): Tallies {
    const out: Tallies = {};
    try {
        const parsed = JSON.parse(raw ?? '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
        for (const [community, v] of Object.entries(parsed as Record<string, unknown>)) {
            const at = communityAddress(community);
            const tally = v && typeof v === 'object' ? v as { n?: unknown; seen?: unknown } : null;
            if (!at || !tally) continue;
            const seen: Record<string, number> = {};
            if (tally.seen && typeof tally.seen === 'object') {
                for (const [id, t] of Object.entries(tally.seen as Record<string, unknown>)) {
                    if (typeof t === 'number' && Number.isSafeInteger(t)) seen[id] = t;
                }
            }
            const n = typeof tally.n === 'number' && Number.isSafeInteger(tally.n) && tally.n > 0 ? tally.n : 0;
            out[at] = { n, seen };
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
 * Read the counts, let `change` alter them, and write them back if it did, after any change under way. Never throws: a
 * count that can't be kept is logged, and the numbers stay as they were.
 */
function update(storage: Storage, change: (tallies: Tallies, active: string | null) => boolean): Promise<void> {
    const next = writes.then(async () => {
        const raw = await storage.getItem(NOTICE_COUNTS_STORE_KEY);
        const anchor = communityAddress(await storage.getItem(ANCHOR_STORE_KEY));
        const tallies = parse(raw);
        let dirty = change(tallies, anchor);
        // A community the phone no longer keeps takes its count with it (not when the list can't be read: a list that
        // can't be read says nothing about what was forgotten).
        const kept = keptCommunities(anchor, await storage.getItem(SAVED_NODES_STORE_KEY));
        if (kept) for (const c of Object.keys(tallies)) if (!kept.has(c)) { delete tallies[c]; dirty = true; }
        if (!dirty) return;
        await storage.setItem(NOTICE_COUNTS_STORE_KEY, JSON.stringify(tallies));
        changed();
    }).catch((e) => {
        console.warn('[Notices] A community\'s count of notices could not be kept', e);
    });
    writes = next;
    return next;
}

/**
 * Notice `id` from `community` reached the phone: counted for that community, unless it is the one in use, or this notice
 * was counted (or seen there) before. Only for a notice the phone checked first (push-notice-check.ts `verifiedNotice`, or
 * a tap's `checkTap`). Never throws.
 */
export function countNotice(storage: Storage, community: string, id: string, now: number = Math.floor(Date.now() / 1000)): Promise<void> {
    return update(storage, (tallies, active) => {
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
 * The community the phone is set to is open: its count goes back to nothing. Its notices stay noted as seen, so one still
 * in the phone's notification list doesn't count again once the member moves on. Never throws.
 */
export function clearActiveCount(storage: Storage): Promise<void> {
    return update(storage, (tallies, active) => {
        const tally = active ? tallies[active] : undefined;
        if (!tally || tally.n === 0) return false;
        tally.n = 0;
        return true;
    });
}

/**
 * Each community's count, by its address (push-pins.ts `communityAddress`), after any change under way: only the
 * communities the phone keeps, never the one in use, and none at 0. Empty when they can't be read.
 */
export async function readNoticeCounts(storage: Pick<Storage, 'getItem'>): Promise<Record<string, number>> {
    await writes;
    try {
        const tallies = parse(await storage.getItem(NOTICE_COUNTS_STORE_KEY));
        const anchor = communityAddress(await storage.getItem(ANCHOR_STORE_KEY));
        const kept = keptCommunities(anchor, await storage.getItem(SAVED_NODES_STORE_KEY));
        const out: Record<string, number> = {};
        for (const [c, tally] of Object.entries(tallies)) {
            if (c !== anchor && tally.n > 0 && (!kept || kept.has(c))) out[c] = tally.n;
        }
        return out;
    } catch {
        return {};
    }
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

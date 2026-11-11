/**
 * When a page that is waiting for a yes asks the community again (both apps; Damo, 9 Nov 2026: "he didn't see the admin
 * acceptance because the PWA doesn't automatically refresh the page"). The yes must show itself within seconds while the
 * page is on screen, so the schedule is quick at first and slows as the wait goes on:
 *
 *   - every 20 s for the first 10 minutes, every 60 s until the hour, every 5 minutes after, each wait jittered ±20% so a
 *     hundred waiting tabs do not ask in the same second;
 *   - never while the page is hidden or the app is in the background (the timer is put away, not just skipped);
 *   - at once when the page comes back to the front (visibilitychange, window focus, app foreground), and at once on
 *     Check again. Coming back from hidden also starts the quick rhythm over: someone is looking at the page again, so a
 *     yes that comes a minute later should show within about 20 s, however long the page was open before;
 *   - one request in flight at a time: a wake or a Check again while a read is out joins it;
 *   - slower when the community is struggling: a failed read doubles the wait (to 5 minutes); a 429 waits at least a
 *     minute and at least its Retry-After (held to an hour), and a page brought to the front does not break that wait.
 *
 * The watcher knows nothing of React, the DOM or the network: the page gives it `read` (which updates the page's own state
 * and says what it heard, as a {@link KnockWatchTick}) and tells it when the page is shown or hidden. What a status read
 * costs the community is the route's: one signed GET answered from one row (apps/server/src/routes/knocks.ts), so the
 * schedule above is the whole of the load an open request adds.
 */

/** How long after the page began to watch each rhythm lasts, and the wait in it. */
export const KNOCK_WATCH_FAST_MS = 20_000;
export const KNOCK_WATCH_FAST_FOR_MS = 10 * 60_000;
export const KNOCK_WATCH_MEDIUM_MS = 60_000;
export const KNOCK_WATCH_MEDIUM_FOR_MS = 60 * 60_000;
export const KNOCK_WATCH_SLOW_MS = 5 * 60_000;
/** Each wait is its base ±20%. */
export const KNOCK_WATCH_JITTER = 0.2;
/** A failed read doubles the wait, to this. */
export const KNOCK_WATCH_BACKOFF_CAP_MS = 5 * 60_000;
/** A 429 waits at least this, and at least its Retry-After. */
export const KNOCK_WATCH_LIMITED_FLOOR_MS = 60_000;
/** A Retry-After longer than this is held to it. */
export const KNOCK_WATCH_RETRY_AFTER_CAP_MS = 60 * 60_000;
/** A wake within this long of the last read is the same moment (a focus event right behind a visibilitychange). */
export const KNOCK_WATCH_WAKE_GAP_MS = 2_000;

/** The wait before the next read, before jitter, for a page that has been watching this long. */
export function knockWatchBaseMs(watchedMs: number): number {
    if (watchedMs < KNOCK_WATCH_FAST_FOR_MS) return KNOCK_WATCH_FAST_MS;
    if (watchedMs < KNOCK_WATCH_MEDIUM_FOR_MS) return KNOCK_WATCH_MEDIUM_MS;
    return KNOCK_WATCH_SLOW_MS;
}

/** What a read heard, for the schedule: not what the community said (the page keeps that). */
export type KnockWatchTick =
    /** A request is still open there: ask again on the schedule. */
    | { kind: 'open' }
    /** Nothing left to wait for (a yes, or nothing open, or a refusal that will not change): stop asking. */
    | { kind: 'settled' }
    /** No answer, or a server error: ask again, slower. */
    | { kind: 'failed' }
    /** A 429: ask again no sooner than `retryAfterSeconds` (when it said), and no sooner than a minute. */
    | { kind: 'limited'; retryAfterSeconds: number | null };

/** Seconds from a `Retry-After` header (whole seconds, or an HTTP date), or null when it names no wait. */
export function retryAfterSecondsOf(header: string | null | undefined, now: number = Date.now()): number | null {
    const raw = (header ?? '').trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return Number(raw);
    const at = Date.parse(raw);
    return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
}

/** The shape both apps' status results share (web lib/knock.ts, phone utils/knock.ts), as far as the schedule needs. */
export interface KnockReadLike {
    ok: boolean;
    value?: { status: string };
    kind?: string;
    status?: number;
    retryAfterSeconds?: number | null;
}

/**
 * A status read, as the schedule sees it. Pending keeps the wait open; a yes or nothing open ends it. A 429 slows it,
 * with its Retry-After; a server error or an unreachable community is tried again, slower. Any other refusal (a key a
 * re-key replaced, a 4xx) will not change by asking again, so it ends the wait: the page shows the community's words and
 * Check again still reads.
 */
export function knockTickOf(read: KnockReadLike): KnockWatchTick {
    if (read.ok) return read.value?.status === 'pending' ? { kind: 'open' } : { kind: 'settled' };
    if (read.kind === 'no_address') return { kind: 'settled' };
    if (read.kind === 'unreachable') return { kind: 'failed' };
    if (read.status === 429) return { kind: 'limited', retryAfterSeconds: typeof read.retryAfterSeconds === 'number' ? read.retryAfterSeconds : null };
    if (typeof read.status === 'number' && read.status >= 400 && read.status < 500 && read.status !== 408) return { kind: 'settled' };
    return { kind: 'failed' };
}

/** Several communities read at once: the one that must slow us wins, then a failure, then open, then settled. */
export function combineKnockTicks(ticks: readonly KnockWatchTick[]): KnockWatchTick {
    const limited = ticks.filter((t): t is Extract<KnockWatchTick, { kind: 'limited' }> => t.kind === 'limited');
    if (limited.length) {
        const waits = limited.map(t => t.retryAfterSeconds).filter((n): n is number => typeof n === 'number');
        return { kind: 'limited', retryAfterSeconds: waits.length ? Math.max(...waits) : null };
    }
    if (ticks.some(t => t.kind === 'failed')) return { kind: 'failed' };
    if (ticks.some(t => t.kind === 'open')) return { kind: 'open' };
    return { kind: 'settled' };
}

export interface KnockStatusWatcher {
    /** Begin (or begin again): read at once if shown, then on the schedule. */
    start(): void;
    /** Stop for good until start(): no timer, and a read still out schedules nothing. */
    stop(): void;
    /** The page was shown (true) or hidden (false). Hidden puts the timer away; shown reads at once. */
    setVisible(visible: boolean): void;
    /** The page came back to the front (window focus, app foreground): read at once. */
    wake(): void;
    /** Check again: read now, joining a read already out. Resolves when that read has finished. */
    readNow(): Promise<void>;
}

export interface KnockStatusWatcherOptions {
    /** One round of reading. It updates the page's own state and says what it heard. A throw is a failed read. */
    read: () => Promise<KnockWatchTick>;
    /** Whether the page is shown when the watcher is made (default yes). */
    visible?: boolean;
    now?: () => number;
    random?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

export function createKnockStatusWatcher(options: KnockStatusWatcherOptions): KnockStatusWatcher {
    const now = options.now ?? (() => Date.now());
    const random = options.random ?? (() => Math.random());
    const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

    let visible = options.visible ?? true;
    let running = false;
    let settled = false;
    let startedAt = 0;
    /** When the last read began; null before the first. */
    let lastReadAt: number | null = null;
    /** A 429 told us to wait until then. */
    let notBefore = 0;
    let failures = 0;
    let timer: unknown = null;
    let inFlight: Promise<void> | null = null;
    /** Bumped by every start(): a read from an earlier one does not steer this one. */
    let generation = 0;

    const jittered = (ms: number) => Math.max(1, Math.round(ms * (1 - KNOCK_WATCH_JITTER + 2 * KNOCK_WATCH_JITTER * random())));
    const backoff = (base: number) => Math.min(KNOCK_WATCH_BACKOFF_CAP_MS, base * 2 ** failures);

    const unschedule = () => {
        if (timer !== null) clearTimer(timer);
        timer = null;
    };
    const schedule = (ms: number) => {
        unschedule();
        if (!running || !visible || settled) return;
        timer = setTimer(() => { timer = null; void read(); }, ms);
    };

    const heard = (tick: KnockWatchTick) => {
        if (tick.kind === 'settled') {
            settled = true;
            failures = 0;
            unschedule();
            return;
        }
        settled = false;
        const base = knockWatchBaseMs(now() - startedAt);
        if (tick.kind === 'open') {
            failures = 0;
            schedule(jittered(base));
        } else if (tick.kind === 'failed') {
            failures += 1;
            schedule(jittered(backoff(base)));
        } else {
            failures += 1;
            const told = tick.retryAfterSeconds !== null && Number.isFinite(tick.retryAfterSeconds) && tick.retryAfterSeconds > 0
                ? Math.min(KNOCK_WATCH_RETRY_AFTER_CAP_MS, tick.retryAfterSeconds * 1000)
                : 0;
            const wait = Math.max(told, jittered(Math.max(KNOCK_WATCH_LIMITED_FLOOR_MS, backoff(base))));
            notBefore = now() + wait;
            schedule(wait);
        }
    };

    /**
     * One read at a time: a call while one is out is that one. The read itself is called a moment later (never inside the
     * caller's own call), so a `read` that throws at once is still a failed read and never leaves this one marked as out.
     */
    const read = (): Promise<void> => {
        if (inFlight) return inFlight;
        unschedule();
        lastReadAt = now();
        const mine = generation;
        const turn = Promise.resolve()
            .then(() => options.read())
            .catch((): KnockWatchTick => ({ kind: 'failed' }))
            .then(tick => {
                inFlight = null;
                // A read that began before a stop or a restart tells the schedule nothing.
                if (running && mine === generation) heard(tick);
            });
        inFlight = turn;
        return turn;
    };

    return {
        start() {
            unschedule();
            running = true;
            settled = false;
            failures = 0;
            notBefore = 0;
            startedAt = now();
            generation += 1;
            if (!visible) return;
            // A read already out (an earlier start's, or Check again's) finishes first: still one request at a time.
            if (inFlight) {
                const mine = generation;
                void inFlight.then(() => { if (running && mine === generation && visible) void read(); });
            } else {
                void read();
            }
        },
        stop() {
            running = false;
            unschedule();
        },
        setVisible(next) {
            if (next === visible) return;
            visible = next;
            if (!visible) { unschedule(); return; }
            // Looked at again: a new sitting, so the quick rhythm (a window focus on a page already in front is not).
            startedAt = now();
            if (!running || settled || inFlight) return;
            // Told to wait by a 429: the wait stands, shown or not.
            if (now() < notBefore) { schedule(notBefore - now()); return; }
            void read();
        },
        wake() {
            if (!running || !visible || settled) return;
            if (inFlight) return;
            if (now() < notBefore) return;
            if (lastReadAt !== null && now() - lastReadAt < KNOCK_WATCH_WAKE_GAP_MS) return;
            void read();
        },
        readNow() {
            return read();
        },
    };
}

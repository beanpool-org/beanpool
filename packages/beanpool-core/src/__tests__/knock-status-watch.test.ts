/**
 * A request to join waits for a yes, and the yes must show itself while the page is on screen (Damo, 9 Nov 2026: "he didn't
 * see the admin acceptance because the PWA doesn't automatically refresh"). One watcher decides when the page asks again,
 * on both apps: every 20 s for the first 10 minutes, every 60 s for the first hour, every 5 minutes after, jittered; never
 * while hidden; at once when the page comes back; one read at a time; slower on a failure and on a 429. Fake timers: no
 * network, no real waiting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    KNOCK_WATCH_BACKOFF_CAP_MS, KNOCK_WATCH_FAST_FOR_MS, KNOCK_WATCH_FAST_MS, KNOCK_WATCH_LIMITED_FLOOR_MS, KNOCK_WATCH_MEDIUM_FOR_MS,
    KNOCK_WATCH_MEDIUM_MS, KNOCK_WATCH_SLOW_MS, KNOCK_WATCH_WAKE_GAP_MS,
    combineKnockTicks, createKnockStatusWatcher, knockTickOf, knockWatchBaseMs, retryAfterSecondsOf, type KnockWatchTick,
} from '../knock-status-watch.js';

const OPEN: KnockWatchTick = { kind: 'open' };
const SETTLED: KnockWatchTick = { kind: 'settled' };

/** A watcher whose reads are a script: each call takes the next tick (the last one repeats). Jitter is off (random 0.5). */
function scripted(ticks: KnockWatchTick[], opts: { visible?: boolean } = {}) {
    let i = 0;
    const read = vi.fn(async () => ticks[Math.min(i++, ticks.length - 1)]);
    const watcher = createKnockStatusWatcher({ read, random: () => 0.5, visible: opts.visible });
    return { read, watcher };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-09T10:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('the schedule', () => {
    it('is 20 s for the first 10 minutes, 60 s to the hour, 5 minutes after', () => {
        expect(knockWatchBaseMs(0)).toBe(20_000);
        expect(knockWatchBaseMs(KNOCK_WATCH_FAST_FOR_MS - 1)).toBe(KNOCK_WATCH_FAST_MS);
        expect(knockWatchBaseMs(KNOCK_WATCH_FAST_FOR_MS)).toBe(KNOCK_WATCH_MEDIUM_MS);
        expect(knockWatchBaseMs(KNOCK_WATCH_MEDIUM_FOR_MS - 1)).toBe(60_000);
        expect(knockWatchBaseMs(KNOCK_WATCH_MEDIUM_FOR_MS)).toBe(KNOCK_WATCH_SLOW_MS);
        expect(knockWatchBaseMs(24 * 3_600_000)).toBe(5 * 60_000);
    });

    it('reads at once on start, then every 20 s, then every 60 s, then every 5 minutes', async () => {
        const startedAt = Date.now();
        const at: number[] = [];
        const read = vi.fn(async (): Promise<KnockWatchTick> => { at.push(Date.now() - startedAt); return OPEN; });
        const watcher = createKnockStatusWatcher({ read, random: () => 0.5 });
        watcher.start();
        await vi.advanceTimersByTimeAsync(2 * 3_600_000);
        watcher.stop();

        expect(at[0]).toBe(0);
        expect(at[1]).toBe(20_000);
        // Every gap is the base for how long the page has been watching when the read before it ended.
        for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBe(knockWatchBaseMs(at[i - 1]));
        // 10 minutes in: reads at 0, 20, …, 600 s (31), then once a minute to the hour, then every 5 minutes.
        expect(at.filter(t => t <= KNOCK_WATCH_FAST_FOR_MS)).toHaveLength(31);
        expect(at.filter(t => t > KNOCK_WATCH_FAST_FOR_MS && t <= KNOCK_WATCH_MEDIUM_FOR_MS)).toHaveLength(50);
        expect(at.filter(t => t > KNOCK_WATCH_MEDIUM_FOR_MS).length).toBeGreaterThanOrEqual(12);
        expect(at.at(-1)! - at.at(-2)!).toBe(KNOCK_WATCH_SLOW_MS);
    });

    it('is jittered by up to 20% either way, so a hundred tabs do not ask in the same second', async () => {
        for (const [random, expected] of [[0, 16_000], [0.999999, 24_000], [0.5, 20_000]] as const) {
            const read = vi.fn(async () => OPEN);
            const watcher = createKnockStatusWatcher({ read, random: () => random });
            watcher.start();
            await vi.advanceTimersByTimeAsync(0);
            expect(read).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(expected - 1);
            expect(read).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(read).toHaveBeenCalledTimes(2);
            watcher.stop();
        }
    });
});

describe('a yes, and the end of the wait', () => {
    it('stops asking once the answer is settled (a yes, or nothing open)', async () => {
        const { read, watcher } = scripted([OPEN, OPEN, SETTLED]);
        watcher.start();
        await vi.advanceTimersByTimeAsync(40_000);
        expect(read).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(KNOCK_WATCH_FAST_FOR_MS);
        expect(read).toHaveBeenCalledTimes(3);
        watcher.stop();
    });

    it('start() begins again after a stop or a settled answer (Ask again)', async () => {
        const { read, watcher } = scripted([SETTLED, OPEN]);
        watcher.start();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(read).toHaveBeenCalledTimes(1);
        watcher.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(read).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(read).toHaveBeenCalledTimes(3);
        watcher.stop();
    });

    it('a restart waits for a read already out, and that read does not end the new run', async () => {
        const finishers: Array<(t: KnockWatchTick) => void> = [];
        const read = vi.fn(() => new Promise<KnockWatchTick>(r => { finishers.push(r); }));
        const watcher = createKnockStatusWatcher({ read, random: () => 0.5 });
        watcher.start();
        await vi.advanceTimersByTimeAsync(0);
        watcher.start(); // Ask again, while the first read is still out
        await vi.advanceTimersByTimeAsync(0);
        expect(read).toHaveBeenCalledTimes(1);
        finishers[0](SETTLED); // the old answer: nothing open
        await vi.advanceTimersByTimeAsync(0);
        expect(read).toHaveBeenCalledTimes(2); // the restart's own read
        finishers[1](OPEN);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(read).toHaveBeenCalledTimes(3); // and the run goes on
        watcher.stop();
    });

    it('a stopped watcher asks nothing more, and a read finishing after the stop schedules nothing', async () => {
        let finish!: (t: KnockWatchTick) => void;
        const read = vi.fn(() => new Promise<KnockWatchTick>(r => { finish = r; }));
        const watcher = createKnockStatusWatcher({ read, random: () => 0.5 });
        watcher.start();
        await vi.advanceTimersByTimeAsync(0);
        watcher.stop();
        finish(OPEN);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(read).toHaveBeenCalledTimes(1);
    });
});

describe('hidden: no requests', () => {
    it('a hidden page makes no requests: the timer is put away and nothing is read until it is back', async () => {
        const { read, watcher } = scripted([OPEN]);
        watcher.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(read).toHaveBeenCalledTimes(1);

        watcher.setVisible(false);
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        expect(read).toHaveBeenCalledTimes(1);

        watcher.setVisible(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(read).toHaveBeenCalledTimes(2);
        watcher.stop();
    });

    it('started hidden: no read until it is shown, then one at once', async () => {
        const { read, watcher } = scripted([OPEN], { visible: false });
        watcher.start();
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(read).not.toHaveBeenCalled();
        watcher.setVisible(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(read).toHaveBeenCalledTimes(1);
        watcher.stop();
    });

    it('a read already out when the page is hidden may finish, and schedules nothing while hidden', async () => {
        let finish!: (t: KnockWatchTick) => void;
        const read = vi.fn(() => new Promise<KnockWatchTick>(r => { finish = r; }));
        const watcher = createKnockStatusWatcher({ read, random: () => 0.5 });
        watcher.start();
        await vi.advanceTimersByTimeAsync(0);
        watcher.setVisible(false);
        finish(OPEN);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(read).toHaveBeenCalledTimes(1);
        watcher.stop();
    });
});

describe('someone is looking again', () => {
    it('coming back to a page that has been open for hours starts the quick rhythm again: the yes that comes a minute later shows within about 20 s', async () => {
        const at: number[] = [];
        const startedAt = Date.now();
        const read = vi.fn(async (): Promise<KnockWatchTick> => { at.push(Date.now() - startedAt); return OPEN; });
        const watcher = createKnockStatusWatcher({ read, random: () => 0.5 });
        watcher.start();
        await vi.advanceTimersByTimeAsync(2 * 3_600_000); // two hours open and watched: the slow rhythm, every 5 minutes
        expect(at.at(-1)! - at.at(-2)!).toBe(KNOCK_WATCH_SLOW_MS);

        watcher.setVisible(false);
        await vi.advanceTimersByTimeAsync(3 * 3_600_000);
        read.mockClear();
        at.length = 0;
        watcher.setVisible(true); // the member picks the phone up
        await vi.advanceTimersByTimeAsync(60_000);
        // A read at once, then every 20 s: not one every 5 minutes.
        expect(at.map(t => t - at[0])).toEqual([0, 20_000, 40_000, 60_000]);
        watcher.stop();
    });

    it('a window focus on a page already in front is the same sitting: it does not start the quick rhythm again', async () => {
        const { read, watcher } = scripted([OPEN]);
        watcher.start();
        await vi.advanceTimersByTimeAsync(2 * 3_600_000 + 100_000); // a read landed at 2 h exactly; the next is due 200 s on
        read.mockClear();
        watcher.wake();
        await vi.advanceTimersByTimeAsync(0);
        expect(read).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(KNOCK_WATCH_SLOW_MS - 1);
        expect(read).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(read).toHaveBeenCalledTimes(2);
        watcher.stop();
    });
});

describe('back in front: read at once', () => {
    it('wake() reads at once, and a second one within 2 s is the same moment', async () => {
        const { read, watcher } = scripted([OPEN]);
        watcher.start();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(read).toHaveBeenCalledTimes(1);
        watcher.wake();
        await vi.advanceTimersByTimeAsync(0);
        expect(read).toHaveBeenCalledTimes(2);
        // A focus event right behind a visibilitychange: one read, not two.
        watcher.wake();
        await vi.advanceTimersByTimeAsync(KNOCK_WATCH_WAKE_GAP_MS - 1);
        expect(read).toHaveBeenCalledTimes(2);
        watcher.stop();
    });

    it('wake() restarts the schedule: the next scheduled read is a full period after it', async () => {
        const { read, watcher } = scripted([OPEN]);
        watcher.start();
        await vi.advanceTimersByTimeAsync(15_000);
        watcher.wake();
        await vi.advanceTimersByTimeAsync(0);
        expect(read).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(19_999);
        expect(read).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(read).toHaveBeenCalledTimes(3);
        watcher.stop();
    });

    it('wake() does nothing while hidden, or once settled, or before start', async () => {
        const hidden = scripted([OPEN], { visible: false });
        hidden.watcher.start();
        hidden.watcher.wake();
        await vi.advanceTimersByTimeAsync(0);
        expect(hidden.read).not.toHaveBeenCalled();

        const settled = scripted([SETTLED]);
        settled.watcher.start();
        await vi.advanceTimersByTimeAsync(0);
        settled.watcher.wake();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(settled.read).toHaveBeenCalledTimes(1);

        const idle = scripted([OPEN]);
        idle.watcher.wake();
        await vi.advanceTimersByTimeAsync(0);
        expect(idle.read).not.toHaveBeenCalled();
    });
});

describe('one request at a time', () => {
    it('a wake or a Check again while a read is out joins it: no second request', async () => {
        let finish!: (t: KnockWatchTick) => void;
        const read = vi.fn(() => new Promise<KnockWatchTick>(r => { finish = r; }));
        const watcher = createKnockStatusWatcher({ read, random: () => 0.5 });
        watcher.start();
        await vi.advanceTimersByTimeAsync(5_000);
        watcher.wake();
        const manual = watcher.readNow();
        expect(read).toHaveBeenCalledTimes(1);
        finish(OPEN);
        await manual;
        expect(read).toHaveBeenCalledTimes(1);
        watcher.stop();
    });

    it('a slow read pushes the next one back: the period starts when the read ends', async () => {
        const read = vi.fn(async () => { await new Promise(r => setTimeout(r, 15_000)); return OPEN; });
        const watcher = createKnockStatusWatcher({ read, random: () => 0.5 });
        watcher.start();
        await vi.advanceTimersByTimeAsync(15_000);
        expect(read).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(19_999);
        expect(read).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(read).toHaveBeenCalledTimes(2);
        watcher.stop();
    });

    it('readNow() reads at once and returns when the read has finished', async () => {
        const { read, watcher } = scripted([OPEN]);
        await watcher.readNow();
        expect(read).toHaveBeenCalledTimes(1);
    });
});

describe('slower when the community is struggling', () => {
    it('a failed read doubles the wait each time, to 5 minutes, and a good read puts it back', async () => {
        const { read, watcher } = scripted([{ kind: 'failed' }, { kind: 'failed' }, { kind: 'failed' }, OPEN]);
        watcher.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(read).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(39_999);
        expect(read).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(read).toHaveBeenCalledTimes(2); // after 40 s
        await vi.advanceTimersByTimeAsync(79_999);
        expect(read).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(read).toHaveBeenCalledTimes(3); // after 80 s more
        await vi.advanceTimersByTimeAsync(159_999);
        expect(read).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(1);
        expect(read).toHaveBeenCalledTimes(4); // after 160 s more: now a good read
        await vi.advanceTimersByTimeAsync(20_000);
        expect(read).toHaveBeenCalledTimes(5); // back to the 20 s rhythm
        watcher.stop();
    });

    it('never waits longer than 5 minutes however long it keeps failing', async () => {
        const at: number[] = [];
        const failing = vi.fn(async (): Promise<KnockWatchTick> => { at.push(Date.now()); return { kind: 'failed' }; });
        const watcher = createKnockStatusWatcher({ read: failing, random: () => 0.5 });
        watcher.start();
        await vi.advanceTimersByTimeAsync(3 * 3_600_000);
        watcher.stop();
        const gaps = at.slice(1).map((t, i) => t - at[i]);
        expect(gaps.slice(0, 4)).toEqual([40_000, 80_000, 160_000, KNOCK_WATCH_BACKOFF_CAP_MS]);
        expect(Math.max(...gaps)).toBe(KNOCK_WATCH_BACKOFF_CAP_MS);
    });

    it('a 429 with a Retry-After waits at least that long, even if a tab is brought to the front', async () => {
        const { read, watcher } = scripted([{ kind: 'limited', retryAfterSeconds: 300 }, OPEN]);
        watcher.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(read).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(120_000);
        watcher.wake();
        await vi.advanceTimersByTimeAsync(0);
        expect(read).toHaveBeenCalledTimes(1); // told to wait 300 s: the wake does not break it
        await vi.advanceTimersByTimeAsync(179_999);
        expect(read).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(read).toHaveBeenCalledTimes(2);
        watcher.stop();
    });

    it('a 429 with no Retry-After waits at least a minute, and backs off if it is told again', async () => {
        const { read, watcher } = scripted([{ kind: 'limited', retryAfterSeconds: null }, { kind: 'limited', retryAfterSeconds: null }, OPEN]);
        watcher.start();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(KNOCK_WATCH_LIMITED_FLOOR_MS - 1);
        expect(read).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(read).toHaveBeenCalledTimes(2);
        // The second 429 backs off further (20 s base, doubled twice: 80 s), not just the minute.
        await vi.advanceTimersByTimeAsync(79_999);
        expect(read).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(read).toHaveBeenCalledTimes(3);
        watcher.stop();
    });

    it('a Retry-After longer than an hour is held to an hour', async () => {
        const { read, watcher } = scripted([{ kind: 'limited', retryAfterSeconds: 999_999 }, OPEN]);
        watcher.start();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(60 * 60_000 - 1);
        expect(read).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(read).toHaveBeenCalledTimes(2);
        watcher.stop();
    });

    it('a read that throws is a failed read, not a stopped watcher', async () => {
        let n = 0;
        const read = vi.fn(async (): Promise<KnockWatchTick> => { if (n++ === 0) throw new Error('boom'); return OPEN; });
        const watcher = createKnockStatusWatcher({ read, random: () => 0.5 });
        watcher.start();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(40_000);
        expect(read).toHaveBeenCalledTimes(2);
        watcher.stop();
    });
});

describe('Retry-After', () => {
    it('is whole seconds, or an HTTP date, or nothing', () => {
        const now = Date.parse('2026-11-09T10:00:00Z');
        expect(retryAfterSecondsOf('120', now)).toBe(120);
        expect(retryAfterSecondsOf(' 7 ', now)).toBe(7);
        expect(retryAfterSecondsOf('Mon, 09 Nov 2026 10:02:00 GMT', now)).toBe(120);
        expect(retryAfterSecondsOf('Mon, 09 Nov 2026 09:00:00 GMT', now)).toBe(0);
        expect(retryAfterSecondsOf('soon', now)).toBeNull();
        expect(retryAfterSecondsOf('', now)).toBeNull();
        expect(retryAfterSecondsOf(null, now)).toBeNull();
        expect(retryAfterSecondsOf(undefined, now)).toBeNull();
    });
});

describe('what a status read means for the wait', () => {
    const pending = { ok: true, value: { status: 'pending' } } as const;
    it('pending keeps the wait open; a yes or nothing open settles it', () => {
        expect(knockTickOf(pending)).toEqual(OPEN);
        expect(knockTickOf({ ok: true, value: { status: 'approved' } })).toEqual(SETTLED);
        expect(knockTickOf({ ok: true, value: { status: 'none' } })).toEqual(SETTLED);
    });
    it('a 429 is limited, with its Retry-After; a 5xx and an unreachable community are failed', () => {
        expect(knockTickOf({ ok: false, kind: 'refused', status: 429, retryAfterSeconds: 90 })).toEqual({ kind: 'limited', retryAfterSeconds: 90 });
        expect(knockTickOf({ ok: false, kind: 'refused', status: 429 })).toEqual({ kind: 'limited', retryAfterSeconds: null });
        expect(knockTickOf({ ok: false, kind: 'refused', status: 503 })).toEqual({ kind: 'failed' });
        expect(knockTickOf({ ok: false, kind: 'unreachable' })).toEqual({ kind: 'failed' });
    });
    it('a refusal that will not change (403 key replaced, 404) settles: nothing more will come of asking', () => {
        expect(knockTickOf({ ok: false, kind: 'refused', status: 403 })).toEqual(SETTLED);
        expect(knockTickOf({ ok: false, kind: 'no_address' })).toEqual(SETTLED);
    });
    it('several communities in one read: the one that must slow us wins, then a failure, then open, then settled', () => {
        expect(combineKnockTicks([])).toEqual(SETTLED);
        expect(combineKnockTicks([SETTLED, SETTLED])).toEqual(SETTLED);
        expect(combineKnockTicks([SETTLED, OPEN])).toEqual(OPEN);
        expect(combineKnockTicks([OPEN, { kind: 'failed' }])).toEqual({ kind: 'failed' });
        expect(combineKnockTicks([{ kind: 'failed' }, { kind: 'limited', retryAfterSeconds: 30 }, OPEN])).toEqual({ kind: 'limited', retryAfterSeconds: 30 });
        expect(combineKnockTicks([{ kind: 'limited', retryAfterSeconds: 30 }, { kind: 'limited', retryAfterSeconds: 120 }])).toEqual({ kind: 'limited', retryAfterSeconds: 120 });
        expect(combineKnockTicks([{ kind: 'limited', retryAfterSeconds: null }, { kind: 'limited', retryAfterSeconds: 120 }])).toEqual({ kind: 'limited', retryAfterSeconds: 120 });
    });
});

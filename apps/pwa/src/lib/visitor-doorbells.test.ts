import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    createVisitorDoorbells,
    VISITOR_READ_WINDOW_MS,
    VISITOR_READ_JITTER_MS,
    VISITOR_RETURN_JITTER_MS,
} from './visitor-doorbells';

describe('a visitor lobby\'s doorbells (lib/visitor-doorbells)', () => {
    let hidden: boolean;
    let rand: number;
    let pending: Array<() => void>;
    let read: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.useFakeTimers();
        hidden = false;
        rand = 0.5;
        pending = [];
        read = vi.fn(() => new Promise<void>((resolve) => { pending.push(resolve); }));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const make = () => createVisitorDoorbells({ read, isHidden: () => hidden, random: () => rand });

    /** Ends the read under way, and lets what it asks for next be armed. */
    async function finishRead(): Promise<void> {
        pending.shift()?.();
        await vi.advanceTimersByTimeAsync(0);
    }

    it('the numbers: a 5 s window, up to 10 s of each tab\'s own on top, and up to 1.5 s on coming back', () => {
        expect(VISITOR_READ_WINDOW_MS).toBe(5_000);
        expect(VISITOR_READ_JITTER_MS).toBe(10_000);
        expect(VISITOR_RETURN_JITTER_MS).toBe(1_500);
    });

    it('fifty doorbells in two seconds are one read, at the window\'s end plus the jitter', async () => {
        rand = 0.3; // 3 s of jitter
        const bells = make();
        for (let i = 0; i < 50; i++) {
            bells.ring();
            await vi.advanceTimersByTimeAsync(40);
        }
        // 2 s in, and until 5 s + 3 s after the first doorbell: nothing.
        await vi.advanceTimersByTimeAsync(8_000 - 2_000 - 1);
        expect(read).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(read).toHaveBeenCalledTimes(1);

        await finishRead();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it.each([
        [0, 5_000],
        [0.5, 10_000],
        [0.9999, 14_999],
    ])('the jitter stays in its bounds: random %s reads at %s ms', async (r, at) => {
        rand = r;
        const bells = make();
        bells.ring();
        await vi.advanceTimersByTimeAsync(at - 1);
        expect(read).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('a random outside [0, 1) is held to the bounds, never a read sooner than the window or later than 15 s', async () => {
        for (const [r, at] of [[-3, 5_000], [NaN, 5_000], [7, 15_000]] as const) {
            read.mockClear();
            rand = r;
            const bells = make();
            bells.ring();
            await vi.advanceTimersByTimeAsync(at - 1);
            expect(read).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(read).toHaveBeenCalledTimes(1);
            await finishRead();
        }
    });

    it('a hidden tab reads nothing, and reads once when it comes back, within the short jitter', async () => {
        hidden = true;
        const bells = make();
        for (let i = 0; i < 20; i++) {
            bells.ring();
            await vi.advanceTimersByTimeAsync(3_000);
        }
        await vi.advanceTimersByTimeAsync(300_000);
        expect(read).not.toHaveBeenCalled();

        rand = 0.9999;
        hidden = false;
        bells.visible();
        await vi.advanceTimersByTimeAsync(VISITOR_RETURN_JITTER_MS - 1);
        expect(read).toHaveBeenCalledTimes(1);
        await finishRead();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('a read waiting when the tab is hidden is held, and taken on return', async () => {
        const bells = make();
        bells.ring();
        await vi.advanceTimersByTimeAsync(2_000);
        hidden = true;
        bells.hidden();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(read).not.toHaveBeenCalled();

        rand = 0;
        hidden = false;
        bells.visible();
        await vi.advanceTimersByTimeAsync(1);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('a tab that was hidden with nothing rung reads nothing on return', async () => {
        const bells = make();
        hidden = true;
        bells.hidden();
        hidden = false;
        bells.visible();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(read).not.toHaveBeenCalled();
    });

    it('a timer that fires in a hidden tab (no hidden() heard) reads nothing, and the return takes it', async () => {
        const bells = make();
        bells.ring();
        hidden = true;
        await vi.advanceTimersByTimeAsync(20_000);
        expect(read).not.toHaveBeenCalled();
        hidden = false;
        bells.visible();
        await vi.advanceTimersByTimeAsync(VISITOR_RETURN_JITTER_MS);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('a doorbell during a read has it read exactly once more after it, paced again, never alongside', async () => {
        rand = 0;
        const bells = make();
        bells.ring();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(read).toHaveBeenCalledTimes(1);

        // Three doorbells while the read is under way, and a long while with it still under way.
        bells.ring();
        bells.ring();
        await vi.advanceTimersByTimeAsync(30_000);
        bells.ring();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(read).toHaveBeenCalledTimes(1);

        await finishRead();
        // Not straight after: the next read keeps the window, so a busy node never has a tab reading back to back.
        await vi.advanceTimersByTimeAsync(4_999);
        expect(read).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(read).toHaveBeenCalledTimes(2);

        await finishRead();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('a read that fails still ends, and a doorbell during it is still read after', async () => {
        rand = 0;
        let fail!: (e: Error) => void;
        read.mockImplementationOnce(() => new Promise<void>((_, reject) => { fail = reject; }));
        const bells = make();
        bells.ring();
        await vi.advanceTimersByTimeAsync(5_000);
        bells.ring();
        fail(new Error('offline'));
        await vi.advanceTimersByTimeAsync(5_000);
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('a read that throws before it starts still ends', async () => {
        rand = 0;
        read.mockImplementationOnce(() => { throw new Error('no'); });
        const bells = make();
        bells.ring();
        await vi.advanceTimersByTimeAsync(5_000);
        bells.ring();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('reset drops a read waiting and a stale mark, and a read under way then asks for nothing more', async () => {
        rand = 0;
        const bells = make();
        bells.ring();
        bells.reset();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(read).not.toHaveBeenCalled();

        bells.ring();
        await vi.advanceTimersByTimeAsync(5_000);
        bells.ring(); // stale, under way
        bells.reset();
        await finishRead();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(read).toHaveBeenCalledTimes(1);

        // And it works as new afterwards.
        bells.ring();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(read).toHaveBeenCalledTimes(2);
    });
});

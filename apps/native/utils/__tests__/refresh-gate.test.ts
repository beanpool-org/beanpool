import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRefreshGate } from '../refresh-gate';

describe('createRefreshGate: the header asks the node at most once per gap', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
    afterEach(() => { vi.useRealTimers(); });

    it('runs the first ask at once', () => {
        const run = vi.fn();
        createRefreshGate(15_000, run).request();
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('folds a burst inside the gap into one trailing ask at the end of the gap', () => {
        const run = vi.fn();
        const gate = createRefreshGate(15_000, run);
        gate.request();
        for (let i = 0; i < 20; i++) { vi.advanceTimersByTime(500); gate.request(); }
        expect(run).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(15_000 - 10_000);
        expect(run).toHaveBeenCalledTimes(2);
        vi.advanceTimersByTime(60_000);
        expect(run).toHaveBeenCalledTimes(2);
    });

    it('a ws nudge every 3 s for a minute asks the node 4 or 5 times, not 20', () => {
        const run = vi.fn();
        const gate = createRefreshGate(15_000, run);
        for (let t = 0; t < 60_000; t += 3_000) { gate.request(); vi.advanceTimersByTime(3_000); }
        expect(run.mock.calls.length).toBeLessThanOrEqual(5);
        expect(run.mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    it('asks again at once after the gap has passed', () => {
        const run = vi.fn();
        const gate = createRefreshGate(15_000, run);
        gate.request();
        vi.advanceTimersByTime(16_000);
        gate.request();
        expect(run).toHaveBeenCalledTimes(2);
    });

    it('cancel drops a pending trailing ask', () => {
        const run = vi.fn();
        const gate = createRefreshGate(15_000, run);
        gate.request();
        gate.request();
        gate.cancel();
        vi.advanceTimersByTime(30_000);
        expect(run).toHaveBeenCalledTimes(1);
    });
});

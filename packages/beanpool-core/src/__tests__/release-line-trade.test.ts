import { describe, it, expect } from 'vitest';
import { nearestFinishedTrade } from '../release-line-trade.js';

type Row = { id: string; completedAt?: string | null };
const at = (r: Row) => r.completedAt;

// One offer bought twice by the same person: the node lists trades newest first.
const t2: Row = { id: 't2', completedAt: '2026-09-20T00:00:00.000Z' };
const t1: Row = { id: 't1', completedAt: '2026-09-10T00:00:00.000Z' };

describe('nearestFinishedTrade: an old release line is the trade that finished with it', () => {
    it('each line takes its own trade, whatever order the trades are listed in', () => {
        expect(nearestFinishedTrade([t2, t1], '2026-09-10T00:00:00.120Z', at)?.id).toBe('t1');
        expect(nearestFinishedTrade([t2, t1], '2026-09-20T00:00:00.080Z', at)?.id).toBe('t2');
        expect(nearestFinishedTrade([t1, t2], '2026-09-10T00:00:00.120Z', at)?.id).toBe('t1');
        expect(nearestFinishedTrade([t1, t2], '2026-09-20T00:00:00.080Z', at)?.id).toBe('t2');
    });

    it('the line a little after or a little before its trade still finds it', () => {
        expect(nearestFinishedTrade([t2, t1], '2026-09-09T23:59:59.900Z', at)?.id).toBe('t1');
        expect(nearestFinishedTrade([t2, t1], '2026-09-20T00:00:01.000Z', at)?.id).toBe('t2');
    });

    it('a line time it cannot read: the first candidate, as before', () => {
        expect(nearestFinishedTrade([t2, t1], undefined, at)?.id).toBe('t2');
        expect(nearestFinishedTrade([t2, t1], null, at)?.id).toBe('t2');
        expect(nearestFinishedTrade([t2, t1], '10:42 am', at)?.id).toBe('t2');
    });

    it('a candidate with no readable time loses to one that has it, and is taken when it is the only one', () => {
        const blank: Row = { id: 'blank', completedAt: null };
        expect(nearestFinishedTrade([blank, t1], '2026-09-10T00:00:00Z', at)?.id).toBe('t1');
        expect(nearestFinishedTrade([t1, blank], '2026-09-10T00:00:00Z', at)?.id).toBe('t1');
        expect(nearestFinishedTrade([blank], '2026-09-10T00:00:00Z', at)?.id).toBe('blank');
    });

    it('nothing to choose from: nothing', () => {
        expect(nearestFinishedTrade([], '2026-09-10T00:00:00Z', at)).toBeUndefined();
    });

    it('the phone\'s SQLite times (with milliseconds and Z) read the same', () => {
        const rows = [{ id: 'a', completedAt: '2026-10-14T03:00:00.000Z' }, { id: 'b', completedAt: '2026-10-01T03:00:00.000Z' }];
        expect(nearestFinishedTrade(rows, '2026-10-01T03:00:00.004Z', at)?.id).toBe('b');
    });
});

import { describe, expect, it, vi, afterEach } from 'vitest';
import { archetypeIsNewer, archetypeToCarry, newestArchetype, parseArchetype, publicArchetype, scoreQuiz } from '../archetypes.js';

// One working style across a member's communities (scratch/fable-design/DESIGN-archetype-across-fable.md, slice S1). What
// a community is sent says less than it did: a day, never a millisecond that matches across communities.

const result = (takenOn: string | null, primary = 'sage') => JSON.stringify({ primary, secondary: 'weaver', mode: 'quick', ...(takenOn ? { takenOn } : {}) });
const stamped = (updatedAt: string, primary = 'sage') => JSON.stringify({ primary, secondary: 'weaver', mode: 'quick', updatedAt });

afterEach(() => { vi.useRealTimers(); });

describe('the public form', () => {
    it('is the type, the wing, the mode and the day, and nothing else', () => {
        vi.useFakeTimers({ now: new Date('2026-11-03T04:05:06.789Z') });
        const sent = JSON.parse(publicArchetype(scoreQuiz(['sage', 'sage', 'weaver'], 'deep')));
        expect(sent).toEqual({ primary: 'sage', secondary: 'weaver', mode: 'deep', takenOn: '2026-11-03' });
    });

    it('an older result is cut to its day: its stamp and its scores never go', () => {
        const old = parseArchetype(JSON.stringify({ primary: 'sage', secondary: 'weaver', mode: 'quick', scores: { sage: 3 }, updatedAt: '2026-10-01T23:59:58.123Z' }))!;
        const sent = publicArchetype(old);
        expect(JSON.parse(sent)).toEqual({ primary: 'sage', secondary: 'weaver', mode: 'quick', takenOn: '2026-10-01' });
        expect(sent).not.toMatch(/\d{2}:\d{2}/);
    });

    it('a result with no date says none: a day is never made up', () => {
        const sent = JSON.parse(publicArchetype(parseArchetype('sage')!));
        expect(sent).toMatchObject({ primary: 'sage', mode: 'quick' });
        expect(sent).not.toHaveProperty('takenOn');
    });
});

describe('scoreQuiz and parseArchetype', () => {
    it('a quiz is stamped with the day and no clock', () => {
        vi.useFakeTimers({ now: new Date('2026-11-03T04:05:06.789Z') });
        const scored = scoreQuiz(['sage'], 'quick');
        expect(scored.takenOn).toBe('2026-11-03');
        expect(scored).not.toHaveProperty('updatedAt');
    });

    it('reads a day, and an older result\'s stamp as its day', () => {
        expect(parseArchetype(result('2026-11-02'))?.takenOn).toBe('2026-11-02');
        expect(parseArchetype(stamped('2026-10-01T23:59:58.123Z'))?.takenOn).toBe('2026-10-01');
    });

    it('a result with no date, a bare key or a day that is no day has no day: it does not read as taken today', () => {
        expect(parseArchetype(result(null))?.takenOn).toBeUndefined();
        expect(parseArchetype('sage')?.takenOn).toBeUndefined();
        expect(parseArchetype('"sage"')?.takenOn).toBeUndefined();
        expect(parseArchetype(result('next tuesday'))?.takenOn).toBeUndefined();
        expect(parseArchetype(result('2026-13-45'))?.takenOn).toBeUndefined();
        expect(parseArchetype(stamped('not a stamp'))?.takenOn).toBeUndefined();
    });

    it('an older app can still read what is sent now', () => {
        const parsed = parseArchetype(publicArchetype({ primary: 'sage', secondary: 'weaver', mode: 'deep', takenOn: '2026-11-02' }));
        expect(parsed).toMatchObject({ primary: 'sage', secondary: 'weaver', mode: 'deep' });
    });
});

describe('newest wins', () => {
    it('a later day beats an earlier one, in either form', () => {
        expect(archetypeIsNewer(result('2026-11-03'), result('2026-11-02'))).toBe(true);
        expect(archetypeIsNewer(result('2026-11-03'), stamped('2026-11-02T23:59:59.000Z'))).toBe(true);
        expect(archetypeIsNewer(stamped('2026-11-03T00:00:00.000Z'), result('2026-11-02'))).toBe(true);
    });

    it('never an older one and never on a tie, the same-day stamp included', () => {
        expect(archetypeIsNewer(result('2026-11-01'), result('2026-11-02'))).toBe(false);
        expect(archetypeIsNewer(result('2026-11-02'), result('2026-11-02'))).toBe(false);
        expect(archetypeIsNewer(stamped('2026-11-02T23:00:00.000Z'), stamped('2026-11-02T01:00:00.000Z'))).toBe(false);
    });

    it('anything readable goes over nothing, and a dated result over an undated one, but never the other way', () => {
        expect(archetypeIsNewer(result('2026-11-02'), null)).toBe(true);
        expect(archetypeIsNewer(result(null), null)).toBe(true);
        expect(archetypeIsNewer(result('2026-11-02'), 'not a result')).toBe(true);
        expect(archetypeIsNewer(result('2026-11-02'), result(null))).toBe(true);
        expect(archetypeIsNewer(result(null), result('2026-11-02'))).toBe(false);
        expect(archetypeIsNewer(result(null), result(null))).toBe(false);
    });

    it('nothing and garbage are never newer', () => {
        expect(archetypeIsNewer(null, result('2026-11-02'))).toBe(false);
        expect(archetypeIsNewer(undefined, null)).toBe(false);
        expect(archetypeIsNewer('not a result', null)).toBe(false);
    });

    it('newestArchetype keeps the first unless the second is newer', () => {
        const a = result('2026-11-02', 'sage');
        const b = result('2026-11-03', 'spark');
        expect(newestArchetype(a, b)).toBe(b);
        expect(newestArchetype(b, a)).toBe(b);
        expect(newestArchetype(a, result('2026-11-02', 'spark'))).toBe(a);
        expect(newestArchetype(null, a)).toBe(a);
        expect(newestArchetype(a, null)).toBe(a);
        expect(newestArchetype(null, null)).toBeNull();
    });
});

describe('what a Save or a catch-up carries', () => {
    it('the device copy in its public form when newer than the row, its scores and any stamp left behind', () => {
        const device = JSON.stringify({ primary: 'spark', secondary: 'sage', mode: 'deep', scores: { spark: 9 }, takenOn: '2026-11-03' });
        expect(JSON.parse(archetypeToCarry(device, result('2026-11-02'))!)).toEqual({ primary: 'spark', secondary: 'sage', mode: 'deep', takenOn: '2026-11-03' });
    });

    it('a row with nothing takes the device copy; a member with no device copy carries nothing', () => {
        expect(JSON.parse(archetypeToCarry(stamped('2026-11-02T01:02:03.000Z'), null)!).takenOn).toBe('2026-11-02');
        expect(archetypeToCarry(null, null)).toBeNull();
        expect(archetypeToCarry(null, result('2026-11-02'))).toBeNull();
    });

    it('never an older copy, never on a tie: the row stands', () => {
        expect(archetypeToCarry(result('2026-11-01'), result('2026-11-02'))).toBeNull();
        expect(archetypeToCarry(result('2026-11-02', 'spark'), result('2026-11-02'))).toBeNull();
    });
});

/**
 * Settings → Diagnostics' compare with the node (#3292): a count the node left out (Share Member Count off, and this
 * reader not answered as a member) stays null, is never compared, and never reads as 0. utils/shared-figure.ts.
 */
import { describe, expect, it } from 'vitest';
import { inSyncWith, remoteStatsFrom, sharedFigure } from '../shared-figure';

describe('sharedFigure', () => {
    it('a number as given, 0 included; anything else is null', () => {
        expect(sharedFigure(14)).toBe(14);
        expect(sharedFigure(0)).toBe(0);
        for (const left of [undefined, null, '14', NaN, Infinity, {}, []]) expect(sharedFigure(left)).toBeNull();
    });
});

describe('remoteStatsFrom: the node info as Diagnostics compares it', () => {
    it("a member's read: the counts as given; the member's own count of ledger lines in place of the node's trades", () => {
        expect(remoteStatsFrom({ memberCount: 14, postCount: 30, transactionCount: 9 }, null)).toEqual({ members: 14, posts: 30, transactions: 9 });
        expect(remoteStatsFrom({ memberCount: 14, postCount: 30, transactionCount: 9 }, 3)).toEqual({ members: 14, posts: 30, transactions: 3 });
    });
    it('counts left out: null each, never 0; the own count still stands where it was read', () => {
        expect(remoteStatsFrom({ commonsBalance_c: 0 }, null)).toEqual({ members: null, posts: null, transactions: null });
        expect(remoteStatsFrom({ commonsBalance_c: 0 }, 2)).toEqual({ members: null, posts: null, transactions: 2 });
        expect(remoteStatsFrom(null, null)).toEqual({ members: null, posts: null, transactions: null });
    });
});

describe('inSyncWith: only the counts the node gave are compared', () => {
    const local = { members: 12, posts: 30 };
    it('no answer from the node: nothing to compare', () => {
        expect(inSyncWith(local, null)).toBe(true);
    });
    it('every count left out: in sync, not "Out of Sync" against a 0 the node never said', () => {
        expect(inSyncWith(local, { members: null, posts: null, transactions: null })).toBe(true);
    });
    it('a count given that differs: out of sync; one left out does not count either way', () => {
        expect(inSyncWith(local, { members: 14, posts: 30, transactions: 9 })).toBe(false);
        expect(inSyncWith(local, { members: null, posts: 31, transactions: null })).toBe(false);
        expect(inSyncWith(local, { members: 12, posts: null, transactions: null })).toBe(true);
    });
    it("no local figures but the node answered: out of sync, as before", () => {
        expect(inSyncWith(null, { members: 14, posts: 30, transactions: 9 })).toBe(false);
    });
});

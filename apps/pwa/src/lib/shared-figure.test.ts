/**
 * A count the node left out stays null, never 0 (#3292: Share Member Count off, and a reader the node does not answer as a
 * member). lib/shared-figure.ts, and Settings → Diagnostics' read of the node's counts (lib/api.ts getNodeStats).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./identity', () => ({ loadIdentity: vi.fn(async () => null) }));
vi.mock('./node-version-gate', () => ({ refuseIfNodeTooOld: vi.fn(async () => {}) }));

import { healthFigures, sharedFigure } from './shared-figure';
import { getNodeStats } from './api';

afterEach(() => { vi.unstubAllGlobals(); });

describe('sharedFigure', () => {
    it('a number as given, 0 included; anything else is null', () => {
        expect(sharedFigure(14)).toBe(14);
        expect(sharedFigure(0)).toBe(0);
        for (const left of [undefined, null, '14', NaN, Infinity, {}, []]) expect(sharedFigure(left)).toBeNull();
    });
});

describe('healthFigures: what the header panel reads out of the health answer', () => {
    it("the node's tree and activity, or the flat counts where an answer has them", () => {
        expect(healthFigures({ tree: { totalMembers: 14 }, activity: { totalPosts: 30 } })).toEqual({ members: 14, posts: 30 });
        expect(healthFigures({ memberCount: 3, postCount: 0 })).toEqual({ members: 3, posts: 0 });
    });
    it('an answer without them (switch off, read as a stranger), or none at all: null, never 0', () => {
        expect(healthFigures({ activity: {} })).toEqual({ members: null, posts: null });
        expect(healthFigures({ tree: null, activity: null })).toEqual({ members: null, posts: null });
        expect(healthFigures(null)).toEqual({ members: null, posts: null });
    });
});

describe("getNodeStats: Settings → Diagnostics' counts", () => {
    const answer = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));

    it('each count the node left out is null', async () => {
        answer({ version: '1.4.7', activity: {} });
        expect(await getNodeStats()).toEqual({ members: null, posts: null, transactions: null });
    });
    it('the counts a member reads, as given', async () => {
        answer({ tree: { totalMembers: 14 }, activity: { totalPosts: 30, totalTransactions: 9 } });
        expect(await getNodeStats()).toEqual({ members: 14, posts: 30, transactions: 9 });
    });
    it('no answer: null, as before', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
        expect(await getNodeStats()).toBeNull();
    });
});

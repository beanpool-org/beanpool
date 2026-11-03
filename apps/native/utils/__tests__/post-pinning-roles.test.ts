/**
 * Pinning S2 fix round 1 (#2769): who is offered the "···", what a failed pin says, and the Market's pinned block as ONE
 * pure rule the screen and this test share (utils/pins.ts).
 */
import { describe, it, expect } from 'vitest';
import { mayPinHere, mayTakePinOff, showPinMenu, pinFailureText, anyLivePin, marketPins, type PinRole } from '../pins';
import { feedPostVisible, type MarketFilterState } from '../market-filters';

const ROLES: PinRole[] = ['owner', 'admin', 'moderator', null, undefined];

describe('who may pin and who may take a pin off (design §2.3, question 5)', () => {
    it('pinning is an owner or an admin only', () => {
        expect(ROLES.map(r => mayPinHere(r))).toEqual([true, true, false, false, false]);
    });
    it('taking a pin off adds the post author', () => {
        expect(mayTakePinOff('owner', false)).toBe(true);
        expect(mayTakePinOff('admin', false)).toBe(true);
        expect(mayTakePinOff(null, true)).toBe(true);
        expect(mayTakePinOff('moderator', false)).toBe(false);
        expect(mayTakePinOff(null, false)).toBe(false);
    });
});

describe('the "···" is drawn for the right readers only', () => {
    const draw = (role: PinRole, pinned: boolean, isAuthor: boolean, pinsOn = true) => showPinMenu({ pinsOn, role, pinned, isAuthor });

    it('an owner and an admin see it, pinned or not, author or not', () => {
        for (const role of ['owner', 'admin'] as const) {
            for (const pinned of [true, false]) for (const isAuthor of [true, false]) expect(draw(role, pinned, isAuthor)).toBe(true);
        }
    });
    it('a plain member sees none on a post that is not theirs, pinned or not', () => {
        expect(draw(null, false, false)).toBe(false);
        expect(draw(null, true, false)).toBe(false);
        expect(draw(undefined, true, false)).toBe(false);
    });
    it('a moderator is a plain member here', () => {
        expect(draw('moderator', false, false)).toBe(false);
        expect(draw('moderator', true, false)).toBe(false);
    });
    it("the author sees it only while their post is pinned (Take the pin off); they cannot pin, so nothing is there before", () => {
        expect(draw(null, true, true)).toBe(true);
        expect(draw(null, false, true)).toBe(false);
        expect(draw('moderator', false, true)).toBe(false);
    });
    it('nobody sees it where pins are off', () => {
        for (const role of ROLES) expect(draw(role, true, true, false)).toBe(false);
    });
});

describe('a failed pin is worded for the member', () => {
    it("shows the node's own sentence as given (the phone sent X-Language, so it is in their language)", () => {
        const err = Object.assign(new Error('Three posts are pinned already. Take one off first.'), { status: 409, nodeAnswered: true });
        expect(pinFailureText(err, 'Failed to pin post')).toBe('Three posts are pinned already. Take one off first.');
    });
    it("puts db.ts's own sentence through the signed-request words, like every other send", () => {
        expect(pinFailureText(new Error('Server returned 502'), 'Failed to pin post')).toBe('Server returned 502');
    });
    it('uses the caller\'s fallback (already through t()) when there is no message at all', () => {
        expect(pinFailureText(new Error(''), 'Failed to unpin post')).toBe('Failed to unpin post');
        expect(pinFailureText(undefined, 'Failed to pin post')).toBe('Failed to pin post');
        expect(pinFailureText({}, 'Failed to pin post')).toBe('Failed to pin post');
    });
});

describe('the Market clock runs only while a pin is live', () => {
    const now = Date.parse('2026-11-03T12:00:00Z');
    const live = { id: 'a', type: 'offer', status: 'active', active: 1, pinned_until: new Date(now + 3_600_000).toISOString() };
    const ended = { id: 'b', type: 'offer', status: 'active', active: 1, pinned_until: new Date(now - 3_600_000).toISOString() };
    const plain = { id: 'c', type: 'offer', status: 'active', active: 1 };

    it('false for a Market with no pin, an ended pin, or nothing', () => {
        expect(anyLivePin([], now)).toBe(false);
        expect(anyLivePin([plain], now)).toBe(false);
        expect(anyLivePin([plain, ended], now)).toBe(false);
    });
    it('true as soon as one is live, and false again once it has ended by the clock', () => {
        expect(anyLivePin([plain, live], now)).toBe(true);
        expect(anyLivePin([plain, live], now + 2 * 3_600_000)).toBe(false);
    });
});

describe('marketPins: the pinned block, one rule for the screen and this test', () => {
    const now = Date.parse('2026-11-03T12:00:00Z');
    const future = new Date(now + 86_400_000).toISOString();
    const pin = (id: string, type: string, pinnedAt: string, extra: Record<string, unknown> = {}) =>
        ({ id, type, status: 'active', active: 1, pinned_until: future, pinned_at: pinnedAt, created_at: '2026-11-01', ...extra });
    const posts = [
        pin('p1', 'offer', '2026-11-03T09:00:00Z'),
        pin('p2', 'need', '2026-11-03T11:00:00Z'),
        pin('p3', 'event', '2026-11-03T10:00:00Z', { event_start_at: future }),
        pin('p4', 'offer', '2026-11-03T08:00:00Z'),
        { id: 'reg1', type: 'offer', status: 'active', active: 1, created_at: '2026-11-03T05:00:00Z' },
    ];
    const state = (over: Partial<MarketFilterState> = {}): MarketFilterState => ({
        type: 'all', category: 'all', eventWindow: 'all', trust: 'all', beansOnly: false, radiusKm: null, center: null, groupId: 'all', ...over,
    });
    const ctx = { blockedUsers: [] as string[], favCategories: [] as string[] };
    const run = (over: Partial<MarketFilterState> = {}, o: { narrowed?: boolean; filtered?: any[]; visible?: (p: any) => boolean } = {}) =>
        marketPins<any>({
            basePosts: posts, filtered: o.filtered ?? posts, narrowed: o.narrowed ?? false, now,
            visible: o.visible ?? (p => feedPostVisible(p, state(over), ctx)),
        });

    it('up to 3 live pins, newest pin first, the fourth left in the list', () => {
        const r = run();
        expect(r.pinned.map(p => p.id)).toEqual(['p2', 'p3', 'p1']);
        expect(r.rest.map(p => p.id)).toEqual(['p4', 'reg1']);
    });
    it("follows the member's type filter", () => {
        const r = run({ type: 'offers' });
        expect(r.pinned.map(p => p.id)).toEqual(['p1', 'p4']);
    });
    it('no pinned block while the list is narrowed (search, tag, distance); the list is untouched', () => {
        const r = run({}, { narrowed: true });
        expect(r.pinned).toEqual([]);
        expect(r.rest.map(p => p.id)).toEqual(posts.map(p => p.id));
    });
    it('a pin is never drawn twice, and both parts are counted for the fill, the empty state and the examples', () => {
        const r = run();
        expect(new Set([...r.rest, ...r.pinned].map(p => p.id)).size).toBe(posts.length);
        expect(r.allMatching.length).toBe(5);
        expect(r.realMatchingCount).toBe(5);
    });
    it('when every matching post is pinned, the list is empty but the count is not', () => {
        const r = marketPins<any>({ basePosts: [posts[0]], filtered: [posts[0]], narrowed: false, now, visible: () => true });
        expect(r.rest).toEqual([]);
        expect(r.pinned.map(p => p.id)).toEqual(['p1']);
        expect(r.realMatchingCount).toBe(1);
    });
    it('a post the screen says is not visible (the Daily Pulse) is never pinned', () => {
        const r = run({}, { visible: p => p.id !== 'p2' });
        expect(r.pinned.map(p => p.id)).toEqual(['p3', 'p1', 'p4']);
    });
    it('a pin that has ended by the clock is not in the block', () => {
        const r = marketPins<any>({ basePosts: posts, filtered: posts, narrowed: false, now: now + 2 * 86_400_000, visible: () => true });
        expect(r.pinned).toEqual([]);
        expect(r.rest.length).toBe(5);
    });
});

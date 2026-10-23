import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ signedGet: async () => ({ ok: false }), signedRequestWithMethod: async () => ({}) }));

import { faceFormOf, faceSaveOf, featuredShelf, leadsIt, mayManage, refusalWords, savesAnything } from '../enterprise-manage';
import type { ShopListing } from '../shop';

/**
 * The keepers' console's own rules (slice S7, utils/enterprise-manage.ts): who may open it, what one Save sends, and the
 * Featured shelf as the node counts it. The screens that draw them are enterprise-manage-render.test.ts.
 */
const DETAIL = {
    name: 'Hill Bakery', purpose: 'Bread for the valley', about: 'We bake on Saturdays.', isLeadOrSoleKeeperOrAdmin: true,
    shop: { id: 'shop-1', kind: 'baking', howToDeal: 'Pick up at the hall.' },
};
const offer = (id: string, over: Partial<ShopListing> = {}): ShopListing => ({
    id, title: id, status: 'active', lendable: false, shopId: 'shop-1', audienceScope: 'public', originNode: null, photo: null, featuredAt: null, ...over,
});

describe('who may open the console', () => {
    it('a keeper of it; whom the node says leads it or administers the node; nobody else', () => {
        expect(mayManage({ isLeadOrSoleKeeperOrAdmin: false }, true)).toBe(true);
        expect(mayManage({ isLeadOrSoleKeeperOrAdmin: true }, false)).toBe(true);
        expect(mayManage({ isLeadOrSoleKeeperOrAdmin: false }, false)).toBe(false);
        expect(mayManage(null, false)).toBe(false);
        expect(leadsIt(DETAIL)).toBe(true);
        expect(leadsIt({ ...DETAIL, isLeadOrSoleKeeperOrAdmin: 'yes' })).toBe(false);
    });
});

describe('what one Save sends', () => {
    const before = faceFormOf(DETAIL);

    it('the form as the detail has it, its kind and how we deal from its shop', () => {
        expect(before).toEqual({ name: 'Hill Bakery', purpose: 'Bread for the valley', about: 'We bake on Saturdays.', kind: 'baking', howToDeal: 'Pick up at the hall.', logo: null });
        expect(faceFormOf({ name: 'X', shop: null })).toEqual({ name: 'X', purpose: '', about: '', kind: null, howToDeal: '', logo: null });
        expect(faceFormOf({ shop: { kind: 'not-a-kind' } }).kind).toBeNull();
    });

    it('nothing changed sends nothing; spaces typed around the words are no change', () => {
        expect(savesAnything(faceSaveOf(before, before, true))).toBe(false);
        expect(savesAnything(faceSaveOf(before, { ...before, name: ' Hill Bakery ', about: 'We bake on Saturdays.  ' }, true))).toBe(false);
    });

    it('each changed field to its own route, trimmed: the face to the profile, its kind and how we deal to its shop', () => {
        const draft = { ...before, name: ' Hill Bakery and Mill ', about: 'Saturdays and Wednesdays.', kind: 'food' as const, howToDeal: '', logo: 'data:image/jpeg;base64,AA' };
        expect(faceSaveOf(before, draft, true)).toEqual({
            face: { name: 'Hill Bakery and Mill', about: 'Saturdays and Wednesdays.', avatar: 'data:image/jpeg;base64,AA' },
            shop: { kind: 'food', howToDeal: null },
        });
    });

    it('a keeper who does not lead it sends no name or purpose, whatever the form holds', () => {
        const draft = { ...before, name: 'Renamed', purpose: 'Something else', about: 'New words.' };
        expect(faceSaveOf(before, draft, false)).toEqual({ face: { about: 'New words.' }, shop: {} });
    });

    it('About emptied goes as empty words, which the node clears; a kind taken off goes as none', () => {
        expect(faceSaveOf(before, { ...before, about: '   ', kind: null }, false)).toEqual({ face: { about: '' }, shop: { kind: null } });
    });
});

describe('the Featured shelf', () => {
    it('its Offers in its shop that hold a place, how many are on the shelf, and its live ones outside it', () => {
        const shelf = featuredShelf([
            offer('a', { featuredAt: '2026-10-20T00:00:00.000Z' }),
            offer('b', { status: 'pending' }),
            offer('c', { status: 'paused', featuredAt: '2026-10-19T00:00:00.000Z' }),
            offer('d', { status: 'completed', featuredAt: '2026-10-18T00:00:00.000Z' }),
            offer('e', { shopId: null }),
            offer('f', { shopId: null, audienceScope: 'group' }),
            offer('g', { shopId: null, originNode: 'elsewhere' }),
            offer('h', { shopId: 'another-shop' }),
        ], 'shop-1');
        expect(shelf.inShop.map((o) => o.id)).toEqual(['a', 'b', 'c']);
        expect(shelf.featured).toBe(2);
        expect(shelf.full).toBe(false);
        expect(shelf.outside.map((o) => o.id)).toEqual(['e', 'h']);
    });

    it('six on it is full; no shop is an empty shelf', () => {
        const six = Array.from({ length: 7 }, (_, i) => offer(`o${i}`, { featuredAt: i < 6 ? '2026-10-20T00:00:00.000Z' : null }));
        expect(featuredShelf(six, 'shop-1')).toMatchObject({ featured: 6, full: true });
        expect(featuredShelf(six, null)).toEqual({ inShop: [], featured: 0, full: false, outside: [] });
    });
});

describe('a refusal in words', () => {
    it("the node's own sentence when it answered; else that the community couldn't be reached", () => {
        expect(refusalWords(Object.assign(new Error('That name is already taken here. Pick another.'), { status: 409 }))).toBe('That name is already taken here. Pick another.');
        expect(refusalWords(new TypeError('Network request failed'))).toBe("Your community couldn't be reached. Try again.");
        expect(refusalWords(Object.assign(new Error('Request failed: 502'), { status: 502, unsaid: true }))).toBe("Your community couldn't be reached. Try again.");
    });
});

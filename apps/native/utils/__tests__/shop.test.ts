/**
 * The phone's side of a member's shop (slice S4′ of scratch/tools/DESIGN-tool-template-fable.md §6; the shop model of
 * DESIGN-shops-and-tools-fable.md §9.1 and Marty's additions of 19 Oct 2026): utils/shop.ts reads and changes the member's
 * own shop through the node's routes (apps/server routes/shops.ts) in their real shapes, and says it in words; and
 * utils/shop-choice.ts carries the List sheet's "Put this in your shop" to the Offer the map's composer posts (the
 * composer is map.tsx's, read and never edited, so the choice rides beside its draft, never in it).
 *
 * The node's answers differ in shape: PUT /api/shops/mine says which Offers it moved as id lists, the close says how many
 * as numbers. The phone reads both as a count either way ({@link movedCount}), so neither shape is depended on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguage } from '@beanpool/core';

const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => store.map.get(k) ?? null,
        setItem: async (k: string, v: string) => { store.map.set(k, v); },
        removeItem: async (k: string) => { store.map.delete(k); },
    },
}));
const node = vi.hoisted(() => ({
    gets: [] as string[],
    writes: [] as Array<{ method: string; path: string; body: unknown }>,
    get: null as null | ((path: string) => { status: number; json?: unknown } | 'down'),
    write: null as null | ((method: string, path: string, body: unknown) => unknown),
}));
vi.mock('../db', () => ({
    signedGet: async (path: string) => {
        node.gets.push(path);
        const a = node.get?.(path) ?? { status: 404 };
        if (a === 'down') throw new TypeError('Network request failed');
        return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.json ?? null };
    },
    signedRequestWithMethod: async (method: string, path: string, body: unknown) => {
        node.writes.push({ method, path, body });
        return node.write?.(method, path, body);
    },
}));

import {
    SHOP_KIND_WORDS, addOffersToMyShop, backOnChoices, changeMyShop, closeMyShop, localDay, movedCount, offersToAdd, readListingShopId,
    readMyLiveOffers, readMyShop, readShop, readShopListings, shopCountsLine, shopStateLine, shopTitle,
} from '../shop';
import { SHOP_CHOICE_HOLDS_MS, SHOP_CHOICE_KEY, clearShopChoice, peekShopChoice, rememberShopChoice, shopChoiceHolds } from '../shop-choice';
import { SHOP_KINDS } from '@beanpool/core';

const COUNTS = { things: 3, available: 2, toBorrow: 1, toBuy: 2, out: 1, newThisWeek: 1 };
const SHOP = {
    id: 'shop-1', kind: 'tools', counts: COUNTS, name: "Dave's Tool Shed", ownerPublicKey: 'dave', ownerName: 'Dave', enterprise: false,
    blurb: 'Drills and ladders.', howToDeal: 'Front gate.', paused: false, backOn: null, openedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
};

beforeEach(() => {
    store.map.clear();
    node.gets.length = 0;
    node.writes.length = 0;
    node.get = null;
    node.write = null;
    setLanguage('en');
});
afterEach(() => setLanguage('en'));

describe('a shop as the node sends it, read tolerantly', () => {
    it('keeps what the phone draws, and nothing it can\'t trust', () => {
        expect(readShop(SHOP)).toEqual({
            id: 'shop-1', name: "Dave's Tool Shed", ownerName: 'Dave', kind: 'tools', blurb: 'Drills and ladders.', howToDeal: 'Front gate.',
            counts: COUNTS, paused: false, backOn: null,
        });
        // A kind no build knows is none; counts missing or odd are 0; a back-on day that is no day is none.
        expect(readShop({ ...SHOP, kind: 'weapons', counts: { things: 'many' }, backOn: 'soon' })).toMatchObject({
            kind: null, counts: { things: 0, available: 0, toBorrow: 0, toBuy: 0, out: 0, newThisWeek: 0 }, backOn: null,
        });
        expect(readShop({ ...SHOP, name: '   ' })?.name).toBeNull();
        for (const bad of [null, 'shop', {}, { id: '' }, { id: 12 }]) expect(readShop(bad)).toBeNull();
    });

    it('every one of the fourteen kinds has an emoji and its words', () => {
        expect(Object.keys(SHOP_KIND_WORDS).sort()).toEqual([...SHOP_KINDS].sort());
        for (const k of SHOP_KINDS) {
            expect(SHOP_KIND_WORDS[k].emoji.length).toBeGreaterThan(0);
            expect(SHOP_KIND_WORDS[k].name).toMatch(/^[A-Z]/);
        }
    });
});

describe('the member\'s own shop, read', () => {
    it('none, open, an older node, no answer, a refusal', async () => {
        node.get = () => ({ status: 200, json: { shop: null } });
        expect(await readMyShop()).toEqual({ state: 'none' });
        node.get = () => ({ status: 200, json: { shop: SHOP } });
        expect(await readMyShop()).toEqual({ state: 'open', shop: readShop(SHOP) });
        node.get = () => ({ status: 404 });
        expect(await readMyShop()).toEqual({ state: 'older' });
        node.get = () => 'down';
        expect(await readMyShop()).toEqual({ state: 'offline' });
        node.get = () => ({ status: 403, json: { error: 'Read access requires a member identity' } });
        expect(await readMyShop()).toEqual({ state: 'offline' });
        expect(node.gets.every((p) => p === '/api/shops/mine')).toBe(true);
    });

    it('its listings, the owner\'s read (paused ones too), and the member\'s live Offers that could go in', async () => {
        const rows = [
            { id: 'a', title: 'Drill', type: 'offer', status: 'active', shopId: 'shop-1', lendable: true, photos: ['https://n/a.jpg'] },
            { id: 'b', title: 'Tent', type: 'offer', status: 'paused', shopId: 'shop-1' },
            { id: 'c', title: 'Couch', type: 'offer', status: 'active' },
            { id: 'd', title: 'Saw', type: 'offer', status: 'pending' },
            { id: 'e', title: 'For the group', type: 'offer', status: 'active', audienceScope: 'group' },
            { id: 'f', title: 'From a peer', type: 'offer', status: 'active', originNode: 'peer-1' },
            { id: 'g', title: 'Done', type: 'offer', status: 'completed' },
            { id: 'h', title: 'A need', type: 'need', status: 'active' },
            { id: 'i', title: 'Mine, paused', type: 'offer', status: 'paused' },
        ];
        node.get = () => ({ status: 200, json: rows });
        const inShop = await readShopListings('shop-1', 'dave');
        expect(node.gets[0]).toBe('/api/marketplace/posts?shop=shop-1&author=dave&type=offer&limit=200');
        expect(inShop?.map((l) => [l.id, l.status, l.lendable, l.photo])).toEqual([
            ['a', 'active', true, 'https://n/a.jpg'], ['b', 'paused', false, null],
            ['c', 'active', false, null], ['d', 'pending', false, null], ['e', 'active', false, null], ['f', 'active', false, null],
            ['g', 'completed', false, null], ['i', 'paused', false, null],
        ]);
        const mine = await readMyLiveOffers('dave');
        expect(node.gets[1]).toBe('/api/marketplace/posts?author=dave&type=offer&limit=200');
        // What "Add my live Offers" offers: live (on the board, or in a deal), for everyone, this community's, not in the shop.
        expect(offersToAdd(mine ?? [], 'shop-1').map((l) => l.id)).toEqual(['c', 'd']);
        node.get = () => 'down';
        expect(await readShopListings('shop-1', 'dave')).toBeNull();
    });

    it('which shop one listing is in, as the node says now', async () => {
        node.get = () => ({ status: 200, json: [{ id: 'a', type: 'offer', status: 'active', shopId: 'shop-1' }] });
        expect(await readListingShopId('a')).toBe('shop-1');
        expect(node.gets[0]).toBe('/api/marketplace/posts?id=a');
        node.get = () => ({ status: 200, json: [{ id: 'a', type: 'offer', status: 'active' }] });
        expect(await readListingShopId('a')).toBeNull();
        node.get = () => 'down';
        expect(await readListingShopId('a')).toBeUndefined();
    });
});

describe('the member\'s own shop, changed', () => {
    it('a PUT names only what changes; the Offers it moved are read as a count, as ids or as a number', async () => {
        node.write = () => ({ success: true, shop: { ...SHOP, paused: true }, paused: ['a', 'b'], resumed: [] });
        const done = await changeMyShop({ paused: true, backOn: '2026-11-03' });
        expect(node.writes).toEqual([{ method: 'PUT', path: '/api/shops/mine', body: { paused: true, backOn: '2026-11-03' } }]);
        expect(done).toEqual({ shop: readShop({ ...SHOP, paused: true }), paused: 2, resumed: 0 });
        node.write = () => ({ success: true, shop: SHOP, paused: 0, resumed: 3 });
        expect(await changeMyShop({ paused: false })).toMatchObject({ paused: 0, resumed: 3 });
    });

    it('opening one is a PUT with nothing in it', async () => {
        node.write = () => ({ success: true, shop: { ...SHOP, name: null }, paused: [], resumed: [] });
        const done = await changeMyShop({});
        expect(node.writes[0]).toEqual({ method: 'PUT', path: '/api/shops/mine', body: {} });
        expect(done.shop.name).toBeNull();
    });

    it('a close says how many, as numbers or as ids, and sends endOffers only when asked', async () => {
        node.write = () => ({ success: true, shopId: 'shop-1', cleared: 4, ended: 0, resumed: 2 });
        expect(await closeMyShop(false)).toEqual({ cleared: 4, ended: 0, resumed: 2 });
        node.write = () => ({ success: true, shopId: 'shop-1', cleared: ['a', 'b', 'c'], ended: ['a', 'b'], resumed: [] });
        expect(await closeMyShop(true)).toEqual({ cleared: 3, ended: 2, resumed: 0 });
        expect(node.writes.map((w) => [w.method, w.path, w.body])).toEqual([
            ['POST', '/api/shops/mine/close', { endOffers: false }], ['POST', '/api/shops/mine/close', { endOffers: true }],
        ]);
    });

    it('"Add my live Offers" sends the ids and reads how many went in', async () => {
        node.write = () => ({ success: true, added: ['c', 'd'] });
        expect(await addOffersToMyShop(['c', 'd'])).toBe(2);
        expect(node.writes[0]).toEqual({ method: 'POST', path: '/api/shops/mine/offers', body: { postIds: ['c', 'd'] } });
    });

    it("a refusal comes back as the node's own sentence, its status and its code", async () => {
        node.write = () => { throw Object.assign(new Error("Finish or cancel the 2 open deals on this shop's things first."), { status: 409, code: 'shop_deals_open' }); };
        await expect(closeMyShop(false)).rejects.toMatchObject({ message: "Finish or cancel the 2 open deals on this shop's things first.", status: 409, code: 'shop_deals_open' });
    });

    it('movedCount: a number, a list of ids, or nothing', () => {
        expect([movedCount(3), movedCount(['a', 'b']), movedCount(0), movedCount([]), movedCount(undefined), movedCount(-2), movedCount('x'), movedCount(2.7)])
            .toEqual([3, 2, 0, 0, 0, 0, 0, 2]);
    });
});

describe('the words', () => {
    it("a shop's title: its own name, else \"<owner>'s shop\"", () => {
        expect(shopTitle({ name: "Dave's Tool Shed", ownerName: 'Dave' })).toBe("Dave's Tool Shed");
        expect(shopTitle({ name: null, ownerName: 'Ana' })).toBe("Ana's shop");
    });

    it('the counts line, and closed for now with or without its day', () => {
        expect(shopCountsLine(COUNTS)).toBe('3 things · 1 out');
        expect(shopCountsLine({ ...COUNTS, things: 1, out: 0 })).toBe('1 thing');
        expect(shopCountsLine({ ...COUNTS, things: 0, out: 0 })).toBe('Nothing in it yet');
        expect(shopStateLine({ paused: true, backOn: '2026-11-03', counts: COUNTS })).toBe('Closed for now · back Tue 3 Nov');
        expect(shopStateLine({ paused: true, backOn: null, counts: COUNTS })).toBe('Closed for now');
        expect(shopStateLine({ paused: false, backOn: null, counts: COUNTS })).toBe('3 things · 1 out');
    });

    it('the back-on choices are days on the member\'s own clock', () => {
        const now = new Date(2026, 9, 23, 23, 30); // 23 Oct, half past eleven at night, here
        expect(localDay(now)).toBe('2026-10-23');
        expect(backOnChoices(now).map((c) => [c.id, c.day])).toEqual([
            ['none', null], ['week', '2026-10-30'], ['fortnight', '2026-11-06'], ['month', '2026-11-22'],
        ]);
    });
});

describe('"Put this in your shop" from the List sheet to the composer\'s Offer', () => {
    const NOW = Date.parse('2026-10-23T08:00:00.000Z');
    const HERE = 'https://mullum.example';
    const offer = { type: 'offer', title: 'Cordless drill' };

    it('remembered beside the draft, for this community; off forgets it', async () => {
        await rememberShopChoice(HERE, 'Cordless drill', true, NOW);
        expect(JSON.parse(store.map.get(SHOP_CHOICE_KEY)!)).toEqual({ anchorUrl: HERE, title: 'Cordless drill', savedAt: NOW });
        expect(await peekShopChoice()).toEqual({ anchorUrl: HERE, title: 'Cordless drill', savedAt: NOW });
        await rememberShopChoice(HERE, 'Cordless drill', false, NOW);
        expect(store.map.has(SHOP_CHOICE_KEY)).toBe(false);
        await rememberShopChoice(HERE, 'Ladder', true, NOW);
        await clearShopChoice();
        expect(await peekShopChoice()).toBeNull();
    });

    it('holds only for that Offer: same community, same title (spaces and case aside), for everyone, within a day', () => {
        const choice = { anchorUrl: HERE, title: 'Cordless drill', savedAt: NOW };
        expect(shopChoiceHolds(choice, offer, HERE, NOW + 60_000)).toBe(true);
        expect(shopChoiceHolds(choice, { ...offer, title: '  cordless  DRILL ' }, HERE, NOW)).toBe(true);
        expect(shopChoiceHolds(choice, offer, HERE, NOW + SHOP_CHOICE_HOLDS_MS)).toBe(true);
        expect(shopChoiceHolds(choice, offer, HERE, NOW + SHOP_CHOICE_HOLDS_MS + 1)).toBe(false);
        expect(shopChoiceHolds(choice, offer, 'https://castlemaine.example', NOW)).toBe(false);
        expect(shopChoiceHolds(choice, { ...offer, title: 'Couch' }, HERE, NOW)).toBe(false);
        expect(shopChoiceHolds(choice, { ...offer, type: 'need' }, HERE, NOW)).toBe(false);
        expect(shopChoiceHolds(choice, { ...offer, audienceScope: 'group' }, HERE, NOW)).toBe(false);
        expect(shopChoiceHolds(choice, { ...offer, targetPubkey: 'someone' }, HERE, NOW)).toBe(false);
        // A choice from a clock ahead of this one, or anything that isn't one, holds for nothing.
        expect(shopChoiceHolds({ ...choice, savedAt: NOW + 3_600_000 }, offer, HERE, NOW)).toBe(false);
        for (const bad of [null, 'x', {}, { ...choice, title: '' }, { ...choice, savedAt: 'soon' }]) expect(shopChoiceHolds(bad, offer, HERE, NOW)).toBe(false);
    });
});

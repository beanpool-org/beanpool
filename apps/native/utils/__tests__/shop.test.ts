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
    get: null as null | ((path: string) => { status: number; json?: unknown } | 'down' | 'never'),
    signals: [] as Array<AbortSignal | undefined>,
    write: null as null | ((method: string, path: string, body: unknown) => unknown),
    writeSignals: [] as Array<AbortSignal | undefined>,
}));
vi.mock('../db', () => ({
    signedGet: async (path: string, options?: { signal?: AbortSignal }) => {
        node.gets.push(path);
        node.signals.push(options?.signal);
        const a = node.get?.(path) ?? { status: 404 };
        if (a === 'down') throw new TypeError('Network request failed');
        // A link that takes the request and never answers: only letting it go (the fetch's signal) settles it, as fetch does.
        if (a === 'never') {
            return new Promise<never>((_, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
        }
        return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.json ?? null };
    },
    signedRequestWithMethod: async (method: string, path: string, body: unknown, opts?: { signal?: AbortSignal }) => {
        node.writes.push({ method, path, body });
        node.writeSignals.push(opts?.signal);
        const a = node.write?.(method, path, body);
        if (a === 'never') {
            return new Promise<never>((_, reject) => opts?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
        }
        return a;
    },
}));

import {
    SHOP_KIND_WORDS, addOffersToMyShop, backOnChoices, changeMyShop, closeMyShop, localDay, movedCount, offersToAdd, readListingShopId,
    SHOP_TOGGLE_READ_MS, readEnterpriseOffers, readMyLiveOffers, readMyShop, readShop, readShopListings, shopCountsLine, shopStateLine, shopTitle,
} from '../shop';
import { SHOP_CHOICE_HOLDS_MS, SHOP_CHOICE_KEY, SHOP_COMPOSER_WAIT_MS, clearShopChoice, peekShopChoice, rememberShopChoice, shopChoiceFor } from '../shop-choice';
import { SHOP_KINDS } from '@beanpool/core';

const COUNTS = { things: 3, available: 2, toBorrow: 1, toBuy: 2, out: 1, newThisWeek: 1 };
const SHOP = {
    id: 'shop-1', kind: 'tools', counts: COUNTS, name: "Dave's Tool Shed", ownerPublicKey: 'dave', ownerName: 'Dave', enterprise: false,
    blurb: 'Drills and ladders.', howToDeal: 'Front gate.', paused: false, backOn: null, openedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
};

beforeEach(() => {
    store.map.clear();
    node.gets.length = 0;
    node.signals.length = 0;
    node.writes.length = 0;
    node.writeSignals.length = 0;
    node.get = null;
    node.write = null;
    setLanguage('en');
});
afterEach(() => setLanguage('en'));

describe('a shop as the node sends it, read tolerantly', () => {
    it('keeps what the phone draws, and nothing it can\'t trust', () => {
        expect(readShop(SHOP)).toEqual({
            id: 'shop-1', name: "Dave's Tool Shed", ownerName: 'Dave', kind: 'tools', blurb: 'Drills and ladders.', howToDeal: 'Front gate.',
            counts: COUNTS, paused: false, backOn: null, photoUrl: null,
        });
        // Its banner photo's address, as the node gave it (keyed); none sent, or empty, is none.
        expect(readShop({ ...SHOP, photoUrl: '/api/shops/shop-1/photo?v=ab&k=K' })?.photoUrl).toBe('/api/shops/shop-1/photo?v=ab&k=K');
        expect(readShop({ ...SHOP, photoUrl: '' })?.photoUrl).toBeNull();
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

    it("with a limit (the List sheet's): a node that never answers is let go at it, as no answer; one that answers is read", async () => {
        vi.useFakeTimers();
        try {
            node.get = () => 'never';
            let read: unknown = 'waiting';
            const reading = readMyShop({ timeoutMs: SHOP_TOGGLE_READ_MS }).then((r) => { read = r; });
            await vi.advanceTimersByTimeAsync(SHOP_TOGGLE_READ_MS - 1);
            expect(read).toBe('waiting');
            expect(node.signals.at(-1)?.aborted).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            await reading;
            expect(read).toEqual({ state: 'offline' });
            expect(node.signals.at(-1)?.aborted).toBe(true);
            node.get = () => ({ status: 200, json: { shop: SHOP } });
            expect(await readMyShop({ timeoutMs: SHOP_TOGGLE_READ_MS })).toEqual({ state: 'open', shop: readShop(SHOP) });
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
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

    // Only the keepers' console asks for the enterprise's own view; its public page reads as every member does
    // (shopfront.test.ts, readOwnerListings), a keeper too (PR #2405 review 4355985890).
    it("an enterprise's Offers in the keepers' console: its keeper's view, asked for", async () => {
        node.get = () => ({ status: 200, json: [{ id: 'a', title: 'Drill', type: 'offer', status: 'paused', shopId: 'shop-1' }] });
        const got = await readEnterpriseOffers('e'.repeat(64));
        expect(node.gets[0]).toBe(`/api/marketplace/posts?author=${'e'.repeat(64)}&keeper=1&type=offer&limit=200`);
        expect(got?.map((l) => [l.id, l.status])).toEqual([['a', 'paused']]);
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

    it("with a limit, a change that never answers (a stalled line) is let go at it and says the community couldn't be reached", async () => {
        vi.useFakeTimers();
        try {
            node.write = () => 'never';
            let settled: unknown = 'waiting';
            const opening = changeMyShop({}, { timeoutMs: SHOP_COMPOSER_WAIT_MS }).then((r) => { settled = r; }, (e) => { settled = e; });
            expect(node.writeSignals[0]).toBeInstanceOf(AbortSignal);
            await vi.advanceTimersByTimeAsync(SHOP_COMPOSER_WAIT_MS - 1);
            expect(settled).toBe('waiting');
            await vi.advanceTimersByTimeAsync(1);
            await vi.waitFor(() => expect(settled).toBeInstanceOf(Error));
            await opening;
            expect((settled as Error).message).toBe("Your community couldn't be reached. Try again.");
            expect(node.writeSignals[0]?.aborted).toBe(true);
            // An answer in time: no timer is left behind.
            node.write = () => ({ success: true, shop: SHOP, paused: [], resumed: [] });
            expect((await changeMyShop({}, { timeoutMs: SHOP_COMPOSER_WAIT_MS })).shop.id).toBe('shop-1');
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
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

    it("an answer without the node's words (a proxy's 502 page, an empty 500) says the community couldn't be reached, never \"Request failed: 502\"", async () => {
        const REACHED = "Your community couldn't be reached. Try again.";
        node.write = () => { throw Object.assign(new Error('Request failed: 502'), { status: 502, unsaid: true }); };
        for (const change of [() => changeMyShop({}), () => closeMyShop(false), () => addOffersToMyShop(['c'])]) {
            const err = await change().catch((e) => e);
            expect(err).toBeInstanceOf(Error);
            expect(err).toMatchObject({ message: REACHED, status: 502, unsaid: true });
        }
        node.write = () => { throw Object.assign(new Error('Request failed: 500'), { status: 500, unsaid: true, code: 'shop_unknown' }); };
        await expect(changeMyShop({ name: 'Shed' })).rejects.toMatchObject({ message: REACHED, status: 500, unsaid: true, code: 'shop_unknown' });
        expect(node.writes.map((w) => `${w.method} ${w.path}`)).toEqual([
            'PUT /api/shops/mine', 'POST /api/shops/mine/close', 'POST /api/shops/mine/offers', 'PUT /api/shops/mine',
        ]);
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
    // Two of the tool's photos as the composer carries them (data URIs, tools/photos.ts toolPhotoDataUri).
    const PHOTO_A = `data:image/jpeg;base64,/9j/4AAQ${'A'.repeat(4000)}QUJD`;
    const PHOTO_B = `data:image/jpeg;base64,/9j/4AAQ${'A'.repeat(4000)}REVG`;
    /** What the List sheet handed the composer: the tool's title, its words and its photos. */
    const LISTED = { title: 'Cordless drill', description: 'Makita 18V, two batteries.', photos: [PHOTO_A] };
    /** The composer's Offer as createPost gets it (map.tsx handleSubmit: its photos as a JSON list, or null). */
    const composed = (o: Record<string, unknown> = {}) => ({ type: 'offer', title: LISTED.title, description: LISTED.description, photos: JSON.stringify([PHOTO_A]), ...o });
    const kept = async () => { await rememberShopChoice(HERE, LISTED, true, NOW); return peekShopChoice(); };

    it("remembered beside the draft, for this community, by the tool's title, words and a key for each photo; off forgets it", async () => {
        await rememberShopChoice(HERE, LISTED, true, NOW);
        const choice = JSON.parse(store.map.get(SHOP_CHOICE_KEY)!);
        expect(choice).toEqual({ anchorUrl: HERE, title: 'Cordless drill', words: 'Makita 18V, two batteries.', photos: [expect.any(String)], savedAt: NOW });
        // A key, never the photo itself: the choice stays small. Another photo has another key.
        expect(choice.photos[0].length).toBeLessThan(40);
        expect(await peekShopChoice()).toEqual(choice);
        await rememberShopChoice(HERE, { ...LISTED, photos: [PHOTO_B] }, true, NOW);
        expect(JSON.parse(store.map.get(SHOP_CHOICE_KEY)!).photos[0]).not.toBe(choice.photos[0]);
        await rememberShopChoice(HERE, LISTED, false, NOW);
        expect(store.map.has(SHOP_CHOICE_KEY)).toBe(false);
        await rememberShopChoice(HERE, { title: 'Ladder' }, true, NOW);
        expect(JSON.parse(store.map.get(SHOP_CHOICE_KEY)!)).toEqual({ anchorUrl: HERE, title: 'Ladder', words: '', photos: [], savedAt: NOW });
        await clearShopChoice();
        expect(await peekShopChoice()).toBeNull();
    });

    it('holds only for that Offer: same community, same title (spaces and case aside), for everyone, within a day', () => {
        // A choice kept by a build from before its words and photos: known by its title alone.
        const choice = { anchorUrl: HERE, title: 'Cordless drill', savedAt: NOW };
        expect(shopChoiceFor(choice, offer, HERE, NOW + 60_000)).toBe('shop');
        expect(shopChoiceFor(choice, { ...offer, title: '  cordless  DRILL ' }, HERE, NOW)).toBe('shop');
        expect(shopChoiceFor(choice, offer, HERE, NOW + SHOP_CHOICE_HOLDS_MS)).toBe('shop');
        // Not in the shop, and the member is told: its Offer past the day, or another Offer posted here while it waited.
        expect(shopChoiceFor(choice, offer, HERE, NOW + SHOP_CHOICE_HOLDS_MS + 1)).toBe('say');
        expect(shopChoiceFor(choice, { ...offer, title: 'Couch' }, HERE, NOW)).toBe('say');
        // Nothing to say: another community's choice, a Need, a group's or one person's Offer (another form posts those).
        expect(shopChoiceFor(choice, offer, 'https://castlemaine.example', NOW)).toBe('none');
        expect(shopChoiceFor(choice, { ...offer, type: 'need' }, HERE, NOW)).toBe('none');
        expect(shopChoiceFor(choice, { ...offer, audienceScope: 'group' }, HERE, NOW)).toBe('none');
        expect(shopChoiceFor(choice, { ...offer, targetPubkey: 'someone' }, HERE, NOW)).toBe('none');
        // A choice from a clock ahead of this one puts nothing in, and is said; anything that isn't one is nothing.
        expect(shopChoiceFor({ ...choice, savedAt: NOW + 3_600_000 }, offer, HERE, NOW)).toBe('say');
        for (const bad of [null, 'x', {}, { ...choice, title: '' }, { ...choice, savedAt: 'soon' }]) expect(shopChoiceFor(bad, offer, HERE, NOW)).toBe('none');
    });

    it("an edit in the composer keeps it: with its title changed, the Offer is still known by the tool's words or photos", async () => {
        const choice = await kept();
        expect(shopChoiceFor(choice, composed(), HERE, NOW + 60_000)).toBe('shop');
        // The review's case: "Cordless drill" listed from a tool, its title changed in the composer.
        expect(shopChoiceFor(choice, composed({ title: 'Cordless drill (Makita)' }), HERE, NOW)).toBe('shop');
        expect(shopChoiceFor(choice, composed({ title: 'Drill', description: 'Lent out by the day.' }), HERE, NOW)).toBe('shop');
        expect(shopChoiceFor(choice, composed({ title: 'Drill', photos: JSON.stringify([PHOTO_B, PHOTO_A]) }), HERE, NOW)).toBe('shop');
        expect(shopChoiceFor(choice, composed({ title: 'Drill', photos: [PHOTO_A] }), HERE, NOW)).toBe('shop');
        expect(shopChoiceFor(choice, composed({ title: 'Drill', photos: null }), HERE, NOW)).toBe('shop');
        expect(shopChoiceFor(choice, composed({ title: 'Drill', description: '  makita 18V,   two BATTERIES. ', photos: null }), HERE, NOW)).toBe('shop');
        expect(shopChoiceFor(choice, composed({ description: 'x', photos: null }), HERE, NOW)).toBe('shop');
    });

    it('changed past knowing: title, words and photos all different, it is up outside the shop and the member is told', async () => {
        const choice = await kept();
        expect(shopChoiceFor(choice, composed({ title: 'Couch', description: 'Comfy.', photos: JSON.stringify([PHOTO_B]) }), HERE, NOW)).toBe('say');
        expect(shopChoiceFor(choice, composed({ title: 'Couch', description: 'Comfy.', photos: null }), HERE, NOW)).toBe('say');
        // Empty words know nothing: a tool with no words and no photos is known by its title alone.
        const bare = { anchorUrl: HERE, title: 'Cordless drill', words: '', photos: [], savedAt: NOW };
        expect(shopChoiceFor(bare, composed({ title: 'Drill', description: '', photos: null }), HERE, NOW)).toBe('say');
        // Past the day, an Offer that isn't its own is nothing to say: the choice is stale.
        expect(shopChoiceFor(choice, composed({ title: 'Couch', description: 'Comfy.', photos: null }), HERE, NOW + SHOP_CHOICE_HOLDS_MS + 1)).toBe('none');
    });
});

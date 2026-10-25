/**
 * The shopfront's logic on the phone (slice S5 of scratch/tools/DESIGN-shops-round3-enterprise-shopfront-fable.md §3, §6,
 * on round 2's shop page, DESIGN-shops-and-tools-fable.md §8): utils/shopfront.ts reads what the node sends for a shop's
 * page and an enterprise's (GET /api/treasury/:t, GET /api/shops/:id, the listings with `author=` or `shop=`) and says it
 * in words. Both pages draw from it, so they say the same thing the same way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHOP_FEATURED_MAX, pseudoLocalise, setLanguage } from '@beanpool/core';

const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => store.map.get(k) ?? null,
        setItem: async (k: string, v: string) => { store.map.set(k, v); },
        removeItem: async (k: string) => { store.map.delete(k); },
    },
}));
const node = vi.hoisted(() => ({ gets: [] as string[], get: null as null | ((path: string) => { status: number; json?: unknown } | 'down') }));
vi.mock('../db', () => ({
    signedGet: async (path: string) => {
        node.gets.push(path);
        const a = node.get?.(path) ?? { status: 404 };
        if (a === 'down') throw new TypeError('Network request failed');
        return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.json ?? null };
    },
}));

import {
    featuredOf, keeperBadgeLine, leadKeeperOf, messageLabel, moneyLine, readKeepers, readOwnerListings, readShopfrontListing,
    readShopfrontShop, readShopListingsForReader, readShopPage, readsAsMember, shopSectionsOf, sinceLine, listingPriceLine,
    type ShopfrontListing,
} from '../shopfront';

const NODE = 'https://mullum.example';
const offer = (over: Record<string, unknown> = {}) => ({
    id: 'p1', type: 'offer', category: 'repairs', title: 'Puncture fixed', description: '', credits: 5, priceType: 'fixed',
    status: 'active', authorPublicKey: 'e'.repeat(64), authorCallsign: 'Lou Repairs', createdAt: '2026-10-20T10:00:00.000Z',
    photos: ['/api/marketplace/posts/p1/photos/0'], ...over,
});
const listing = (over: Record<string, unknown> = {}) => readShopfrontListing(offer(over), NODE) as ShopfrontListing;

beforeEach(() => {
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    node.gets.length = 0;
    node.get = null;
    setLanguage('en');
});
afterEach(() => setLanguage('en'));

describe('a listing as the shopfront draws it', () => {
    it('reads an Offer or a Need, its first photo on the node, its stamp and its shop', () => {
        const l = listing({ featuredAt: '2026-10-22T09:00:00.000Z', shopId: 's1', lendable: true });
        expect(l).toMatchObject({
            id: 'p1', type: 'offer', title: 'Puncture fixed', category: 'repairs', credits: 5, priceType: 'fixed', status: 'active',
            lendable: true, featuredAt: '2026-10-22T09:00:00.000Z', shopId: 's1', photo: `${NODE}/api/marketplace/posts/p1/photos/0`,
        });
        expect(listing({ type: 'need' }).type).toBe('need');
        // A photo already on a node, or none at all.
        expect(listing({ photos: ['https://other.example/x.jpg'] }).photo).toBe('https://other.example/x.jpg');
        expect(listing({ photos: [] }).photo).toBeNull();
        expect(listing({ photos: undefined }).photo).toBeNull();
    });
    it('is none for an event, a poll, or anything that is no listing', () => {
        expect(readShopfrontListing(offer({ type: 'event' }), NODE)).toBeNull();
        expect(readShopfrontListing(offer({ type: 'poll' }), NODE)).toBeNull();
        expect(readShopfrontListing(offer({ id: '' }), NODE)).toBeNull();
        expect(readShopfrontListing(null, NODE)).toBeNull();
        expect(readShopfrontListing('x', NODE)).toBeNull();
    });
});

describe('Featured: the shelf', () => {
    it('the live featured Offers, the latest featured first, at most six', () => {
        const rows = Array.from({ length: 8 }, (_, i) => listing({ id: `f${i}`, featuredAt: `2026-10-1${i}T00:00:00.000Z` }));
        const got = featuredOf([...rows, listing({ id: 'plain' })]);
        expect(got.map(l => l.id)).toEqual(['f7', 'f6', 'f5', 'f4', 'f3', 'f2']);
        expect(got).toHaveLength(SHOP_FEATURED_MAX);
    });
    it('never a paused or ended one, nor a Need', () => {
        const got = featuredOf([
            listing({ id: 'a', featuredAt: '2026-10-10T00:00:00.000Z', status: 'paused' }),
            listing({ id: 'b', featuredAt: '2026-10-10T00:00:00.000Z', status: 'completed' }),
            listing({ id: 'c', featuredAt: '2026-10-10T00:00:00.000Z', type: 'need' }),
            listing({ id: 'd', featuredAt: '2026-10-10T00:00:00.000Z', status: 'pending' }),
        ]);
        expect(got.map(l => l.id)).toEqual(['d']);
    });
});

describe('the sections', () => {
    it('to buy, book a time, to borrow, then what it is looking for; empty ones are left out', () => {
        const sections = shopSectionsOf([
            listing({ id: 'buy1' }),
            listing({ id: 'hour', priceType: 'hourly' }),
            listing({ id: 'lend', lendable: true, priceType: 'daily' }),
            listing({ id: 'buy2', priceType: 'fixed', status: 'pending' }),
            listing({ id: 'need', type: 'need' }),
            listing({ id: 'off', status: 'paused' }),
            listing({ id: 'gone', status: 'completed' }),
        ]);
        expect(sections.map(s => s.id)).toEqual(['toBuy', 'byTime', 'toBorrow', 'lookingFor']);
        expect(sections.map(s => s.listings.map(l => l.id))).toEqual([['buy1', 'buy2'], ['hour'], ['lend'], ['need']]);
        expect(sections.map(s => s.title)).toEqual(['To buy (2)', 'Book a time (1)', 'To borrow (1)', 'Looking for (1)']);
        expect(shopSectionsOf([listing({ id: 'x' })]).map(s => s.id)).toEqual(['toBuy']);
        expect(shopSectionsOf([])).toEqual([]);
    });
    it('a price in words: a total, by the time, or none where the community shows no Beans', () => {
        expect(listingPriceLine(listing({ credits: 5 }), true)).toBe('5 🫘');
        expect(listingPriceLine(listing({ credits: 3, priceType: 'hourly' }), true)).toBe('3 🫘 an hour');
        expect(listingPriceLine(listing({ credits: 20, priceType: 'daily' }), true)).toBe('20 🫘 a day');
        expect(listingPriceLine(listing({ credits: 0 }), true)).toBe('Free');
        expect(listingPriceLine(listing({ credits: 5 }), false)).toBeNull();
    });
});

describe('the keepers', () => {
    const raw = [
        { publicKey: 'k'.repeat(64), callsign: 'Rachel', role: 'admin', avatarUrl: '/api/avatar/kkk', tier: 'Newcomer', rating: { average: 0, count: 0 }, trades: 2, offerCategories: ['food'] },
        { publicKey: 'd'.repeat(64), callsign: 'Damo', role: 'lead', avatarUrl: null, tier: 'Resident', rating: { average: 4.6, count: 9 }, trades: 14, offerCategories: [] },
        { publicKey: 's'.repeat(64), callsign: 'Sam', role: 'admin', suspended: true },
    ];
    it('the lead first, each with their badges as the node sends them', () => {
        const keepers = readKeepers(raw);
        expect(keepers.map(k => k.callsign)).toEqual(['Damo', 'Rachel', 'Sam']);
        expect(keepers[0]).toMatchObject({ isLead: true, tier: 'Resident', rating: { average: 4.6, count: 9 }, trades: 14 });
        expect(keepers[2]).toMatchObject({ isLead: false, suspended: true, tier: null, rating: null, trades: null });
        expect(readKeepers(undefined)).toEqual([]);
        expect(readKeepers([{ callsign: 'no key' }])).toEqual([]);
    });
    it('a badge line: tier, stars, trades; none for a reader the node gave no badges', () => {
        const [damo, rachel, sam] = readKeepers(raw);
        expect(keeperBadgeLine(damo)).toBe('🏠 Resident · ★★★★★ · 14 trades');
        expect(keeperBadgeLine(rachel)).toBe('🌱 Newcomer · 2 trades');
        expect(keeperBadgeLine({ ...rachel, trades: 1 })).toBe('🌱 Newcomer · 1 trade');
        expect(keeperBadgeLine(sam)).toBeNull();
    });
    it('the lead keeper to message: the lead, else the only keeper, else nobody', () => {
        expect(leadKeeperOf(readKeepers(raw))?.callsign).toBe('Damo');
        expect(leadKeeperOf(readKeepers([raw[0]]))?.callsign).toBe('Rachel');
        expect(leadKeeperOf(readKeepers([raw[0], raw[2]]))).toBeNull();
        expect(messageLabel('Damo', 'enterprise')).toBe('Message Damo (lead keeper)');
        expect(messageLabel('Damo', 'project')).toBe('Message Damo (leader)');
        expect(messageLabel('Dave', 'shop')).toBe('Message Dave');
    });
});

describe('the lines', () => {
    it('since, in the month and year; the money in one line', () => {
        expect(sinceLine('2026-09-03T10:00:00.000Z')).toBe('since Sep 2026');
        expect(sinceLine(null)).toBeNull();
        expect(sinceLine('not a date')).toBeNull();
        expect(moneyLine(12, 50)).toBe('12 🫘 · credit line 50 🫘');
        expect(moneyLine(-3.5, 0)).toBe('-3.5 🫘 · credit line 0 🫘');
    });
    it('every word through t(): the pseudo-locale', () => {
        setLanguage('xx' as never);
        expect(moneyLine(12, 50)).toBe(pseudoLocalise('{balance} 🫘 · credit line {credit} 🫘').replace('{balance}', '12').replace('{credit}', '50'));
        expect(messageLabel('Damo', 'enterprise')).toBe(pseudoLocalise('Message {name} (lead keeper)').replace('{name}', 'Damo'));
        expect(shopSectionsOf([listing()])[0].title).toBe(pseudoLocalise('To buy ({n})').replace('{n}', '1'));
    });
});

describe("who reads the page as a member", () => {
    it("a node with the shopfront says it by the keepers' categories; an older node reads as before", () => {
        expect(readsAsMember({ about: null, since: '2026-09-01', offerCategories: [] })).toBe(true);
        expect(readsAsMember({ about: null, since: '2026-09-01' })).toBe(false);
        expect(readsAsMember({ purpose: 'Older node, no shopfront' })).toBe(true);
        expect(readsAsMember(null)).toBe(false);
    });
});

describe('the reads', () => {
    it("an owner's listings: every listing of theirs on the node, with photos on it", async () => {
        node.get = () => ({ status: 200, json: [offer(), offer({ id: 'p2', type: 'event' }), offer({ id: 'p3', type: 'need' })] });
        const got = await readOwnerListings('e'.repeat(64));
        expect(node.gets).toEqual([`/api/marketplace/posts?author=${'e'.repeat(64)}&limit=200`]);
        expect(got?.map(l => l.id)).toEqual(['p1', 'p3']);
        expect(got?.[0].photo).toBe(`${NODE}/api/marketplace/posts/p1/photos/0`);
    });
    it("a shop's listings as a reader sees them: its Offers", async () => {
        node.get = () => ({ status: 200, json: [offer({ shopId: 's1' })] });
        const got = await readShopListingsForReader('s1');
        expect(node.gets).toEqual(['/api/marketplace/posts?shop=s1&type=offer&limit=200']);
        expect(got?.map(l => l.id)).toEqual(['p1']);
    });
    it('no answer is null, never an empty shop', async () => {
        node.get = () => 'down';
        expect(await readOwnerListings('e'.repeat(64))).toBeNull();
        node.get = () => ({ status: 500 });
        expect(await readShopListingsForReader('s1')).toBeNull();
        node.get = () => ({ status: 200, json: { not: 'a list' } });
        expect(await readShopListingsForReader('s1')).toBeNull();
    });
    it("a shop's page: a member's shop, an enterprise's, a visitor's view, none, or no answer", async () => {
        const memberShop = { id: 's1', category: 'tools', counts: { things: 3 }, name: null, ownerPublicKey: 'o'.repeat(64), ownerName: 'Dave', enterprise: false, blurb: 'Tools to lend.', howToDeal: 'Knock first.', paused: false, backOn: null };
        node.get = () => ({ status: 200, json: memberShop });
        expect(await readShopPage('s1')).toEqual({ state: 'shop', shop: readShopfrontShop(memberShop) });
        expect(node.gets).toEqual(['/api/shops/s1']);
        expect(readShopfrontShop(memberShop)).toMatchObject({ id: 's1', category: 'tools', ownerPublicKey: 'o'.repeat(64), ownerName: 'Dave', enterprise: false, howToDeal: 'Knock first.' });
        node.get = () => ({ status: 200, json: { ...memberShop, enterprise: true, name: 'Lou Repairs' } });
        expect(await readShopPage('s1')).toEqual({ state: 'enterprise', ownerPublicKey: 'o'.repeat(64), name: 'Lou Repairs' });
        node.get = () => ({ status: 200, json: { id: 's1', category: 'tools', counts: { things: 3 } } });
        expect(await readShopPage('s1')).toEqual({ state: 'visitor' });
        node.get = () => ({ status: 404, json: { code: 'shop_not_found' } });
        expect(await readShopPage('s1')).toEqual({ state: 'none' });
        node.get = () => 'down';
        expect(await readShopPage('s1')).toEqual({ state: 'offline' });
    });
});

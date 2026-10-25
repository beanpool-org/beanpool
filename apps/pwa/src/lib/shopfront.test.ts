/**
 * The shopfront's logic on the web (slice S8 of scratch/tools/DESIGN-shops-round3-enterprise-shopfront-fable.md §3, §6): lib/shopfront.ts
 * reads what the node sends for an enterprise's page (GET /api/treasury/:t, the listings with `author=`) and says it in
 * words, the phone's words (apps/native/utils/shopfront.ts), so the two apps say the same thing the same way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHOP_FEATURED_MAX, pseudoLocalise, setLanguage } from '@beanpool/core';
import * as api from './api';
import {
    categoryEmoji, categoryLabel, categorySinceLine, faceChanges, featuredOf, keeperBadgeLine, keeperRoleWord, leadKeeperOf, listingPriceLine,
    listingStateLine, listingsFromDetailPosts, messageLabel, moneyLine, readKeepers, readOwnerListings, readShopfrontListing, readsAsMember,
    shelfLine, shelfOf, shopCategoryLabel, shopCategoryOf, shopSectionsOf, sinceLine, type ShopfrontListing,
} from './shopfront';

const offer = (over: Record<string, unknown> = {}) => ({
    id: 'p1', type: 'offer', category: 'tools', title: 'Puncture fixed', description: '', credits: 5, priceType: 'fixed',
    status: 'active', authorPublicKey: 'e'.repeat(64), authorCallsign: 'Lou Repairs', createdAt: '2026-10-20T10:00:00.000Z',
    audienceScope: 'public', photos: ['/api/marketplace/posts/p1/photos/0'], ...over,
});
const listing = (over: Record<string, unknown> = {}) => readShopfrontListing(offer(over)) as ShopfrontListing;

beforeEach(() => { vi.restoreAllMocks(); setLanguage('en'); });
afterEach(() => setLanguage('en'));

describe('a listing as the shopfront draws it', () => {
    it('reads an Offer or a Need, its first photo on this node as the node sends it, its stamp and its shop', () => {
        const l = listing({ featuredAt: '2026-10-22T09:00:00.000Z', shopId: 's1', lendable: true });
        expect(l).toMatchObject({
            id: 'p1', type: 'offer', title: 'Puncture fixed', category: 'tools', credits: 5, priceType: 'fixed', status: 'active',
            lendable: true, featuredAt: '2026-10-22T09:00:00.000Z', shopId: 's1', photo: '/api/marketplace/posts/p1/photos/0', audienceScope: 'public',
        });
        expect(listing({ type: 'need' }).type).toBe('need');
        expect(listing({ photos: [] }).photo).toBeNull();
        expect(listing({ photos: undefined }).photo).toBeNull();
    });
    it('reads authorTierCredit from authorEnergyCycled when numeric and finite', () => {
        expect(listing({ authorEnergyCycled: 120 }).authorTierCredit).toBe(120);
        expect(listing({ authorEnergyCycled: 0 }).authorTierCredit).toBe(0);
        expect(listing({ authorEnergyCycled: null }).authorTierCredit).toBeNull();
        expect(listing({ authorEnergyCycled: '100' }).authorTierCredit).toBeNull();
        expect(listing({ authorEnergyCycled: NaN }).authorTierCredit).toBeNull();
    });
    it('is none for an event, a poll, or anything that is no listing', () => {
        expect(readShopfrontListing(offer({ type: 'event' }))).toBeNull();
        expect(readShopfrontListing(offer({ type: 'poll' }))).toBeNull();
        expect(readShopfrontListing(offer({ id: '' }))).toBeNull();
        expect(readShopfrontListing(null)).toBeNull();
        expect(readShopfrontListing('x')).toBeNull();
    });
    it("the detail's own text listings stand in when the listings with photos can't be read", () => {
        const got = listingsFromDetailPosts([{ id: 'p9', type: 'offer', category: 'food', title: 'Eggs', credits: 4, price_type: 'hourly', status: 'active' }, { id: '' }]);
        expect(got).toHaveLength(1);
        expect(got[0]).toMatchObject({ id: 'p9', priceType: 'hourly', photo: null, featuredAt: null });
        expect(listingsFromDetailPosts(undefined)).toEqual([]);
    });
});

describe('Featured: the shelf', () => {
    it('the live featured Offers, the latest featured first, at most six', () => {
        const rows = Array.from({ length: 8 }, (_, i) => listing({ id: `f${i}`, featuredAt: `2026-10-1${i}T00:00:00.000Z` }));
        const got = featuredOf([...rows, listing({ id: 'plain' })]);
        expect(got.map((l) => l.id)).toEqual(['f7', 'f6', 'f5', 'f4', 'f3', 'f2']);
        expect(got).toHaveLength(SHOP_FEATURED_MAX);
    });
    it('never a paused or ended one, nor a Need', () => {
        const got = featuredOf([
            listing({ id: 'a', featuredAt: '2026-10-10T00:00:00.000Z', status: 'paused' }),
            listing({ id: 'b', featuredAt: '2026-10-10T00:00:00.000Z', status: 'completed' }),
            listing({ id: 'c', featuredAt: '2026-10-10T00:00:00.000Z', type: 'need' }),
            listing({ id: 'd', featuredAt: '2026-10-10T00:00:00.000Z', status: 'pending' }),
        ]);
        expect(got.map((l) => l.id)).toEqual(['d']);
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
        expect(sections.map((s) => s.id)).toEqual(['toBuy', 'byTime', 'toBorrow', 'lookingFor']);
        expect(sections.map((s) => s.listings.map((l) => l.id))).toEqual([['buy1', 'buy2'], ['hour'], ['lend'], ['need']]);
        expect(sections.map((s) => s.title)).toEqual(['To buy (2)', 'Book a time (1)', 'To borrow (1)', 'Looking for (1)']);
        expect(shopSectionsOf([])).toEqual([]);
    });
    it('a price in words: a total, by the time, or none where the community shows no Beans; what a listing is doing now', () => {
        expect(listingPriceLine(listing({ credits: 5 }), true)).toBe('5 🫘');
        expect(listingPriceLine(listing({ credits: 3, priceType: 'hourly' }), true)).toBe('3 🫘 an hour');
        expect(listingPriceLine(listing({ credits: 20, priceType: 'daily' }), true)).toBe('20 🫘 a day');
        expect(listingPriceLine(listing({ credits: 0 }), true)).toBe('Free');
        expect(listingPriceLine(listing({ credits: 5 }), false)).toBeNull();
        expect(listingStateLine(listing({ status: 'pending' }))).toBe('In a deal');
        expect(listingStateLine(listing({ status: 'pending', lendable: true }))).toBe('Out on loan');
        expect(listingStateLine(listing())).toBeNull();
    });
    it("a category's emoji and its name; an older id is today's", () => {
        expect(categoryEmoji('tools')).toBe('🛠️');
        expect(categoryLabel('tools')).toBe('Tools');
        expect(categoryEmoji('tools_hardware')).toBe('🛠️');
        expect(categoryLabel('tools_hardware')).toBe('Tools');
        expect(categoryEmoji(null)).toBe('🌱');
    });
});

describe('the keepers', () => {
    const raw = [
        { publicKey: 'k'.repeat(64), callsign: 'Rachel', role: 'admin', avatarUrl: '/api/avatar/kkk', tier: 'Newcomer', rating: { average: 0, count: 0 }, trades: 2, offerCategories: ['food'] },
        { publicKey: 'd'.repeat(64), callsign: 'Damo', role: 'lead', avatarUrl: null, tier: 'Resident', rating: { average: 4.6, count: 9 }, trades: 14, offerCategories: [] },
        { pubkey: 's'.repeat(64), callsign: 'Sam', role: 'admin', suspended: true, backing: 20 },
    ];
    it('the lead first, each with their badges and backing as the node sends them; an older key field read too', () => {
        const keepers = readKeepers(raw);
        expect(keepers.map((k) => k.callsign)).toEqual(['Damo', 'Rachel', 'Sam']);
        expect(keepers[0]).toMatchObject({ isLead: true, tier: 'Resident', rating: { average: 4.6, count: 9 }, trades: 14 });
        expect(keepers[2]).toMatchObject({ publicKey: 's'.repeat(64), isLead: false, suspended: true, tier: null, rating: null, trades: null, backing: 20 });
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
    it('the lead keeper to message: the lead, else the only keeper, else nobody; a part in its kind\'s words', () => {
        expect(leadKeeperOf(readKeepers(raw))?.callsign).toBe('Damo');
        expect(leadKeeperOf(readKeepers([raw[0]]))?.callsign).toBe('Rachel');
        expect(leadKeeperOf(readKeepers([raw[0], raw[2]]))).toBeNull();
        expect(messageLabel('Damo', 'enterprise')).toBe('Message Damo (lead keeper)');
        expect(messageLabel('Damo', 'project')).toBe('Message Damo (leader)');
        expect(keeperRoleWord(false, true)).toBe('Lead keeper');
        expect(keeperRoleWord(true, false)).toBe('Collaborator');
    });
});

describe('the lines', () => {
    it("its category and since, in one line, as its listings show the category; since in the month and year; the money in one line", () => {
        expect(shopCategoryOf({ category: 'tech' })).toBe('tech');
        expect(shopCategoryOf({ category: 'spaceships' })).toBeNull();
        expect(shopCategoryOf({ kind: 'repairs' })).toBeNull();
        expect(shopCategoryOf(null)).toBeNull();
        expect(shopCategoryLabel('tech')).toBe(`${categoryEmoji('tech')} ${categoryLabel('tech')}`);
        expect(shopCategoryLabel('tech')).toBe('💻 Tech & Digital');
        expect(sinceLine('2026-09-03T10:00:00.000Z')).toBe('since Sep 2026');
        expect(sinceLine(null)).toBeNull();
        expect(sinceLine('not a date')).toBeNull();
        expect(categorySinceLine('tech', 'since Sep 2026')).toBe('💻 Tech & Digital · since Sep 2026');
        expect(categorySinceLine(null, null)).toBeNull();
        expect(moneyLine(12, 50)).toBe('12 🫘 · credit line 50 🫘');
    });
    it('every word through t(): the pseudo-locale', () => {
        setLanguage('xx' as never);
        expect(moneyLine(12, 50)).toBe(pseudoLocalise('{balance} 🫘 · credit line {credit} 🫘').replace('{balance}', '12').replace('{credit}', '50'));
        expect(messageLabel('Damo', 'enterprise')).toBe(pseudoLocalise('Message {name} (lead keeper)').replace('{name}', 'Damo'));
        expect(shopSectionsOf([listing()])[0].title).toBe(pseudoLocalise('To buy ({n})').replace('{n}', '1'));
        expect(shelfLine(2)).toBe(pseudoLocalise('{n} of {max} on the shelf').replace('{n}', '2').replace('{max}', '6'));
    });
});

describe('who reads the page as a member', () => {
    it("a node with the shopfront says it by the keepers' categories; an older node reads as before", () => {
        expect(readsAsMember({ about: null, since: '2026-09-01', offerCategories: [] })).toBe(true);
        expect(readsAsMember({ about: null, since: '2026-09-01' })).toBe(false);
        expect(readsAsMember({ purpose: 'Older node, no shopfront' })).toBe(true);
        expect(readsAsMember(null)).toBe(false);
    });
});

describe('the keepers\' console: the shelf and the face', () => {
    it('its live Offers in its shop, how many are featured, and its live Offers for everyone that are not in it yet', () => {
        const rows = [
            listing({ id: 'p1', shopId: 's1', featuredAt: '2026-10-22T00:00:00.000Z' }),
            listing({ id: 'p3', shopId: 's1' }),
            listing({ id: 'p4', shopId: 's1', status: 'pending' }),
            listing({ id: 'p5', shopId: null }),
            listing({ id: 'p6', shopId: null, audienceScope: 'group' }),
            listing({ id: 'p7', shopId: 's1', status: 'paused', featuredAt: '2026-10-21T00:00:00.000Z' }),
            listing({ id: 'n1', type: 'need' }),
        ];
        const shelf = shelfOf(rows, 's1');
        expect(shelf.inShop.map((l) => l.id)).toEqual(['p1', 'p3', 'p4']);
        // A paused one keeps its place on the shelf (the node counts it: a resume never makes seven).
        expect(shelf.featured).toBe(2);
        expect(shelf.outside.map((l) => l.id)).toEqual(['p5']);
        expect(shelfOf(rows, null).inShop).toEqual([]);
        expect(shelfLine(2)).toBe('2 of 6 on the shelf');
    });
    it('only what changed goes, each to its own route; the name and purpose only from the lead', () => {
        const was = { name: 'Hill Bakery', purpose: 'Bread', about: 'We bake.', category: 'food' as const, howToDeal: 'Saturdays.' };
        expect(faceChanges(was, { ...was }, { lead: true, shop: true })).toEqual({ profile: {}, shop: {} });
        expect(faceChanges(was, { ...was, name: ' Hill Mill ', category: 'goods' }, { lead: true, shop: true })).toEqual({ profile: { name: 'Hill Mill' }, shop: { category: 'goods' } });
        expect(faceChanges(was, { ...was, name: 'Hill Mill', about: 'New.' }, { lead: false, shop: true })).toEqual({ profile: { about: 'New.' }, shop: {} });
        expect(faceChanges(was, { ...was, howToDeal: '', category: null }, { lead: true, shop: false })).toEqual({ profile: {}, shop: {} });
        expect(faceChanges(was, { ...was, howToDeal: '' }, { lead: true, shop: true })).toEqual({ profile: {}, shop: { howToDeal: null } });
        expect(faceChanges(was, { ...was, avatar: 'data:image/jpeg;base64,/9j/AAAA' }, { lead: false, shop: true })).toEqual({ profile: { avatar: 'data:image/jpeg;base64,/9j/AAAA' }, shop: {} });
    });
});

describe('the reads', () => {
    it("an owner's listings: every listing of theirs on the node, with photos on it", async () => {
        const spy = vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([offer(), offer({ id: 'p2', type: 'event' }), offer({ id: 'p3', type: 'need' })] as any);
        const got = await readOwnerListings('e'.repeat(64));
        expect(spy).toHaveBeenCalledWith({ author: 'e'.repeat(64), limit: 200 });
        expect(got?.map((l) => l.id)).toEqual(['p1', 'p3']);
    });
    it('no answer is null, never an empty shop', async () => {
        vi.spyOn(api, 'getMarketplacePosts').mockRejectedValue(new TypeError('Failed to fetch'));
        expect(await readOwnerListings('e'.repeat(64))).toBeNull();
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue({ not: 'a list' } as any);
        expect(await readOwnerListings('e'.repeat(64))).toBeNull();
    });
});

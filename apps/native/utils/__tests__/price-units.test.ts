/**
 * Phone (Native) price unit labels and old-node feature gating:
 * verifies readNodeProfile reads `priceUnitsKgYear`, old nodes hide yearly and per_kg,
 * every unit has its label on phone cards/Home/shopfront, and all deal screens use priceUnitTakesQuantity.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, DeviceEventEmitter: { addListener: vi.fn(), emit: vi.fn() } }));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(len)) }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
}));
vi.mock('../db', () => ({ signedGet: vi.fn() }));

import { PRICE_UNITS, priceUnitsOffered, setLanguage, type PriceUnit } from '@beanpool/core';
import { readNodeProfile } from '../node-profile';
import { askedUnit } from '../home-cards';
import { listingPriceLine, shopSectionsOf, type ShopfrontListing } from '../shopfront';

afterEach(() => setLanguage('en'));

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf-8');

const shopListing = (overrides: Partial<ShopfrontListing> = {}): ShopfrontListing => ({
    id: 'p1',
    type: 'offer',
    title: 'Apples',
    category: 'food',
    price_c: 1000,
    priceType: 'fixed',
    status: 'active',
    lendable: false,
    featuredAt: null,
    shopId: null,
    photo: null,
    authorTierCredit: null,
    ...overrides,
});

describe('phone reads priceUnitsKgYear from node features and hides new units on older nodes', () => {
    it('hears priceUnitsKgYear: true and offers all 8 units for Offer and 7 for Need in exact order', () => {
        const profile = readNodeProfile({
            profile: 'local',
            features: { beans: true, escrow: true, perItem: true, priceUnitsKgYear: true },
        })!;
        expect(profile.features.priceUnitsKgYear).toBe(true);
        expect(priceUnitsOffered(profile.features, 'offer')).toEqual([
            'fixed', 'each', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'per_kg',
        ]);
        expect(priceUnitsOffered(profile.features, 'need')).toEqual([
            'fixed', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'per_kg',
        ]);
    });

    it('hides yearly and per_kg when the node features omit priceUnitsKgYear or say false', () => {
        for (const features of [{ beans: true, perItem: true }, { beans: true, priceUnitsKgYear: false }, { beans: true, priceUnitsKgYear: 'true' }]) {
            const profile = readNodeProfile({ profile: 'local', features })!;
            expect(priceUnitsOffered(profile.features, 'offer')).not.toContain('yearly');
            expect(priceUnitsOffered(profile.features, 'offer')).not.toContain('per_kg');
            expect(priceUnitsOffered(profile.features, 'need')).not.toContain('yearly');
            expect(priceUnitsOffered(profile.features, 'need')).not.toContain('per_kg');
        }
        expect(priceUnitsOffered(readNodeProfile({})!.features, 'offer')).not.toContain('yearly');
        expect(priceUnitsOffered(readNodeProfile({})!.features, 'offer')).not.toContain('per_kg');
    });
});

describe('phone labels for every price unit (old and new)', () => {
    it('askedUnit covers every unit in PRICE_UNITS', () => {
        const expected: Record<PriceUnit, string> = {
            fixed: '',
            each: '',
            hourly: '/Hr',
            daily: '/Dy',
            weekly: '/Wk',
            monthly: '/Mo',
            yearly: '/Yr',
            per_kg: '/kg',
        };
        for (const unit of PRICE_UNITS) {
            expect(askedUnit(unit), unit).toBe(expected[unit]);
        }
        expect(askedUnit('unknown')).toBe('');
    });

    it('shopfront listingPriceLine and sections handle yearly (byTime) and per_kg (toBuy) with Beans word', () => {
        expect(listingPriceLine(shopListing({ priceType: 'yearly' }), true)).toBe('10 Beans a year');
        expect(listingPriceLine(shopListing({ priceType: 'per_kg' }), true)).toBe('10 Beans a kilo');
        expect(listingPriceLine(shopListing({ priceType: 'yearly' }), true)).not.toContain('🫘');
        expect(listingPriceLine(shopListing({ priceType: 'per_kg' }), true)).not.toContain('🫘');

        const sections = shopSectionsOf([
            shopListing({ id: 'yr', priceType: 'yearly' }),
            shopListing({ id: 'kg', priceType: 'per_kg' }),
        ]);
        expect(sections.find((s) => s.id === 'byTime')?.listings.map((l) => l.id)).toEqual(['yr']);
        expect(sections.find((s) => s.id === 'toBuy')?.listings.map((l) => l.id)).toEqual(['kg']);
    });

    it('phone screens exhaustively handle yearly and per_kg and use priceUnitTakesQuantity for deal prompts', () => {
        const newListing = read('../../app/new-listing.tsx');
        const postDetail = read('../../app/post/[id].tsx');
        const market = read('../../app/(tabs)/market.tsx');
        const preview = read('../../components/MapPreviewCard.tsx');
        const chat = read('../../app/chat/[id].tsx');
        const groupPost = read('../../app/group-post.tsx');
        const treasuryPost = read('../../app/treasury-post.tsx');
        const treasuryManage = read('../../app/treasury-manage.tsx');

        expect(newListing).toContain("case 'yearly': return t('/ Yr'");
        expect(newListing).toContain("case 'per_kg': return t('/ kg'");
        expect(postDetail).toContain("case 'yearly': return t('/ Yr'");
        expect(postDetail).toContain("case 'per_kg': return t('/ kg'");
        expect(postDetail).toContain('priceUnitTakesQuantity(post.price_type)');
        expect(market).toContain("case 'yearly': return t('/Yr'");
        expect(market).toContain("case 'per_kg': return t('/kg'");
        expect(preview).toContain("case 'yearly': return t('/Yr'");
        expect(preview).toContain("case 'per_kg': return t('/kg'");
        expect(chat).toContain("case 'yearly':");
        expect(chat).toContain("case 'per_kg':");
        expect(groupPost).toContain('priceUnitsOffered(nodeProfile?.features, type)');
        expect(treasuryPost).toContain('priceUnitsOffered(nodeProfile?.features,');
        expect(treasuryManage).toContain('priceUnitTakesQuantity(d.price_type)');
    });
});

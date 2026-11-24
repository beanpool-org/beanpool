/**
 * Phone (Native) price unit words and old-node feature gating, by what the functions return (no source text is read):
 * readNodeProfile reads `priceUnitsKgYear`, old nodes hide yearly and per_kg, and every unit has its Home and shopfront
 * line and its own deal words (utils/price-unit-words.ts). The listing screen itself is rendered for every unit in
 * post-detail-words-render.test.ts ("every price unit, taken up on the phone"), and an enterprise's release in
 * enterprise-manage-render.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, DeviceEventEmitter: { addListener: vi.fn(), emit: vi.fn() } }));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(len)) }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
}));
vi.mock('../db', () => ({ signedGet: vi.fn() }));

import { PRICE_UNITS, dealAmountFor, dealQuantityUnit, priceUnitTakesQuantity, priceUnitsOffered, setLanguage, type PriceUnit } from '@beanpool/core';
import {
    committedOfferWords, confirmWorkedLabel, enterpriseWorkedCopy, netWords, priceUnitWords, requestedNeedWords, requestQuantityWords, trustCommitmentCopy,
} from '../price-unit-words';
import { readNodeProfile } from '../node-profile';
import { askedUnit } from '../home-cards';
import { listingPriceLine, shopSectionsOf, type ShopfrontListing } from '../shopfront';

afterEach(() => setLanguage('en'));

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

    it('table: every unit has its own deal words on the phone (take-up box, commitment, request, release label, keeper prompt)', () => {
        // One row per unit: what app/post/[id].tsx and app/treasury-manage.tsx draw for it (utils/price-unit-words.ts).
        const expected: Record<PriceUnit, {
            suffix: string; box: string; a11y: string; placeholder: string; offer: string; need: string; request: string; release: string; heading: string; prompt: string;
        }> = {
            fixed: { suffix: '', box: 'TRUST COMMITMENT (UNITS)', a11y: 'Trust commitment in units', placeholder: 'Units', offer: 'You have committed 18.75 credits to a Trust Wallet for this offer.', need: 'You have requested to earn 18.75 credits (18.47 net after 1.5% transaction fee) {owned} for fulfilling this need.', request: '', release: 'CONFIRM ACTUAL UNITS WORKED', heading: 'Confirm Units Worked', prompt: 'Enter actual units worked for "Eggs":' },
            each: { suffix: '', box: 'TRUST COMMITMENT (UNITS)', a11y: 'Trust commitment in units', placeholder: 'Units', offer: 'You have committed 18.75 credits to a Trust Wallet for this offer.', need: 'You have requested to earn 18.75 credits (18.47 net after 1.5% transaction fee) {owned} for fulfilling this need.', request: '', release: 'CONFIRM ACTUAL UNITS WORKED', heading: 'Confirm Units Worked', prompt: 'Enter actual units worked for "Eggs":' },
            hourly: { suffix: '/ Hr', box: 'TRUST COMMITMENT (HOURS)', a11y: 'Trust commitment in hours', placeholder: 'Hours', offer: 'You have committed 18.75 credits (2.5 hours) to a Trust Wallet for this offer.', need: 'You have requested to earn 18.75 credits (2.5 hours) (18.47 net after 1.5% transaction fee) {owned} for fulfilling this need.', request: '2.5 hours estimated', release: 'CONFIRM ACTUAL HOURS WORKED', heading: 'Confirm Hours Worked', prompt: 'Enter actual hours worked for "Eggs":' },
            daily: { suffix: '/ Dy', box: 'TRUST COMMITMENT (DAYS)', a11y: 'Trust commitment in days', placeholder: 'Days', offer: 'You have committed 18.75 credits (2.5 days) to a Trust Wallet for this offer.', need: 'You have requested to earn 18.75 credits (2.5 days) (18.47 net after 1.5% transaction fee) {owned} for fulfilling this need.', request: '2.5 days', release: 'CONFIRM ACTUAL DAYS WORKED', heading: 'Confirm Days Worked', prompt: 'Enter actual days worked for "Eggs":' },
            weekly: { suffix: '/ Wk', box: 'TRUST COMMITMENT (WEEKS)', a11y: 'Trust commitment in weeks', placeholder: 'Weeks', offer: 'You have committed 18.75 credits (2.5 weeks) to a Trust Wallet for this offer.', need: 'You have requested to earn 18.75 credits (2.5 weeks) (18.47 net after 1.5% transaction fee) {owned} for fulfilling this need.', request: '2.5 weeks', release: 'CONFIRM ACTUAL WEEKS WORKED', heading: 'Confirm Weeks Worked', prompt: 'Enter actual weeks worked for "Eggs":' },
            monthly: { suffix: '/ Mo', box: 'TRUST COMMITMENT (MONTHS)', a11y: 'Trust commitment in months', placeholder: 'Months', offer: 'You have committed 18.75 credits (2.5 months) to a Trust Wallet for this offer.', need: 'You have requested to earn 18.75 credits (2.5 months) (18.47 net after 1.5% transaction fee) {owned} for fulfilling this need.', request: '2.5 months', release: 'CONFIRM ACTUAL MONTHS WORKED', heading: 'Confirm Months Worked', prompt: 'Enter actual months worked for "Eggs":' },
            yearly: { suffix: '/ Yr', box: 'TRUST COMMITMENT (YEARS)', a11y: 'Trust commitment in years', placeholder: 'Years', offer: 'You have committed 18.75 credits (2.5 years) to a Trust Wallet for this offer.', need: 'You have requested to earn 18.75 credits (2.5 years) (18.47 net after 1.5% transaction fee) {owned} for fulfilling this need.', request: '2.5 years', release: 'CONFIRM ACTUAL YEARS WORKED', heading: 'Confirm Years Worked', prompt: 'Enter actual years worked for "Eggs":' },
            per_kg: { suffix: '/ kg', box: 'WEIGHT (KILOS)', a11y: 'Weight in kilos', placeholder: 'Kilos', offer: 'You have committed 18.75 credits (2.5 kilos) to a Trust Wallet for this offer.', need: 'You have requested to earn 18.75 credits (2.5 kilos) (18.47 net after 1.5% transaction fee) {owned} for fulfilling this need.', request: '2.5 kilos', release: 'CONFIRM ACTUAL WEIGHT (KILOS)', heading: 'Confirm Weight (Kilos)', prompt: 'Enter the actual weight in kilos for "Eggs":' },
        };
        expect(Object.keys(expected)).toEqual([...PRICE_UNITS]);
        for (const unit of PRICE_UNITS) {
            const row = expected[unit];
            // 2.5 at 7.50 Beans each: 18.75 held (core dealAmountFor), 18.47 net of the Commons fee (core feeOf).
            const held = dealAmountFor(750, 2.5);
            expect(held).toBe(1875);
            expect(priceUnitWords(unit), unit).toBe(row.suffix);
            expect(trustCommitmentCopy(unit), unit).toEqual({ label: row.box, accessibilityLabel: row.a11y, placeholder: row.placeholder });
            expect(committedOfferWords(dealQuantityUnit(unit), 2.5, held), unit).toBe(row.offer);
            expect(requestedNeedWords(dealQuantityUnit(unit), 2.5, held), unit).toBe(row.need);
            expect(requestQuantityWords(dealQuantityUnit(unit), false, 2.5), unit).toBe(row.request);
            expect(confirmWorkedLabel(unit), unit).toBe(row.release);
            const keeper = enterpriseWorkedCopy(unit, 'Eggs');
            expect([keeper.heading, keeper.prompt], unit).toEqual([row.heading, row.prompt]);
            expect(row.request !== '', `${unit} names its quantity`).toBe(priceUnitTakesQuantity(unit));
        }
        expect(committedOfferWords('kilo', 1, 750)).toBe('You have committed 7.50 credits (1 kilo) to a Trust Wallet for this offer.');
        expect(enterpriseWorkedCopy('per_kg', 'Eggs').invalidMessage).toBe('Please enter a valid positive number of kilos.');
        expect(trustCommitmentCopy('per_litre').label).toBe('TRUST COMMITMENT (UNITS)');
        expect(netWords(null)).toBe('—');
    });
});

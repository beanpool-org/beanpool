import { describe, it, expect } from 'vitest';
import {
    PROTOCOL_CONSTANTS, KNOWN_FLOOR_DEFAULT, CREDIT_CAP_DEFAULT, CREDIT_CAP_MAX,
    creditAllowance, usableAllowance, knownGrantFor, enterpriseKnownShare, offerCapForCount,
} from '../protocol';

describe('the known floor (community modes slice 4)', () => {
    it('ships 1,000 Beans known floor and a 2,000 cap settable to 5,000', () => {
        expect(KNOWN_FLOOR_DEFAULT).toBe(1000);
        expect(CREDIT_CAP_DEFAULT).toBe(PROTOCOL_CONSTANTS.CREDIT_FLOOR_CAP);
        expect(CREDIT_CAP_MAX).toBe(5000);
    });

    it('an unconfirmed member (or known mode off) gets today\'s formula exactly', () => {
        for (const [v, e, g] of [[0, 0, 0], [25, 0, 0], [100, 1920, 0], [50, 300, 1400], [0, 1920, 1400]]) {
            expect(creditAllowance({ vouch: v, earned: e, granted: g, knownGrant: 0, cap: CREDIT_CAP_DEFAULT }))
                .toBe(Math.min(PROTOCOL_CONSTANTS.CREDIT_FLOOR_CAP, v + e + g));
        }
    });

    it('a confirmed member adds the known grant, capped by the community cap', () => {
        expect(creditAllowance({ vouch: 0, earned: 0, granted: 0, knownGrant: 1000, cap: 2000 })).toBe(1000);
        expect(creditAllowance({ vouch: 50, earned: 1500, granted: 0, knownGrant: 1000, cap: 2000 })).toBe(2000);
        expect(creditAllowance({ vouch: 50, earned: 1500, granted: 0, knownGrant: 3000, cap: 5000 })).toBe(4550);
        expect(creditAllowance({ vouch: 0, earned: 1920, granted: 0, knownGrant: 5000, cap: 5000 })).toBe(5000);
    });

    it('the known grant: knownFloor when confirmed with the dial on, else 0; an exception overrides it up to the cap', () => {
        expect(knownGrantFor({ dialOn: true, confirmed: true, knownFloor: 1000, cap: 2000 })).toBe(1000);
        expect(knownGrantFor({ dialOn: true, confirmed: false, knownFloor: 1000, cap: 2000 })).toBe(0);
        expect(knownGrantFor({ dialOn: false, confirmed: true, knownFloor: 1000, cap: 2000 })).toBe(0);
        // lowered (a training limit) and frozen
        expect(knownGrantFor({ dialOn: true, confirmed: true, knownFloor: 1000, cap: 2000, exception: { amount: 300 } })).toBe(300);
        expect(knownGrantFor({ dialOn: true, confirmed: true, knownFloor: 1000, cap: 2000, exception: { frozen: true } })).toBe(0);
        // raised above knownFloor only to the cap
        expect(knownGrantFor({ dialOn: true, confirmed: true, knownFloor: 1000, cap: 2000, exception: { amount: 1800 } })).toBe(1800);
        expect(knownGrantFor({ dialOn: true, confirmed: true, knownFloor: 1000, cap: 2000, exception: { amount: 9000 } })).toBe(2000);
        // an exception never applies to an unconfirmed member or with the dial off
        expect(knownGrantFor({ dialOn: true, confirmed: false, knownFloor: 1000, cap: 2000, exception: { amount: 1800 } })).toBe(0);
        expect(knownGrantFor({ dialOn: false, confirmed: true, knownFloor: 1000, cap: 2000, exception: { amount: 1800 } })).toBe(0);
    });

    it('one band for the known part: any live offer unlocks all of it, none unlocks none; the earned part keeps its bands', () => {
        // nothing known: identical to today's covenant
        for (let n = 0; n <= 6; n++) {
            for (const other of [0, 150, 700, 1920, 2000]) {
                expect(usableAllowance({ knownGrant: 0, otherAllowance: other, cap: 2000, liveOffers: n }))
                    .toBe(Math.min(other, offerCapForCount(n)));
            }
        }
        expect(usableAllowance({ knownGrant: 1000, otherAllowance: 0, cap: 2000, liveOffers: 0 })).toBe(0);
        expect(usableAllowance({ knownGrant: 1000, otherAllowance: 0, cap: 2000, liveOffers: 1 })).toBe(1000);
        // 1 offer: all 1,000 known + the 200 band of the earned 700
        expect(usableAllowance({ knownGrant: 1000, otherAllowance: 700, cap: 2000, liveOffers: 1 })).toBe(1200);
        // 3 offers: 1,000 known + 700 earned (band 1,000), within the 2,000 cap
        expect(usableAllowance({ knownGrant: 1000, otherAllowance: 700, cap: 2000, liveOffers: 3 })).toBe(1700);
        // the cap bounds the sum
        expect(usableAllowance({ knownGrant: 1500, otherAllowance: 1920, cap: 2000, liveOffers: 5 })).toBe(2000);
        // 0 offers with earned trust: only the earned band (0)
        expect(usableAllowance({ knownGrant: 1000, otherAllowance: 700, cap: 2000, liveOffers: 0 })).toBe(0);
    });

    it('an enterprise counts half of each confirmed keeper\'s known grant', () => {
        expect(enterpriseKnownShare([1000, 0, 501])).toBe(500 + 0 + 250);
        expect(enterpriseKnownShare([])).toBe(0);
    });
});

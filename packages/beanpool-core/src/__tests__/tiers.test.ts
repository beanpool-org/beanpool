/**
 * Trust tiers — one table, one boundary rule. The apps, the server and admin views all read TIER_LEVELS /
 * tierForCredit, so these tests pin the table to the floor thresholds getTier has always used and to the
 * admin grants in docs/trust-model-v3.md (Resident 200, Steward 600, Elder 1400).
 */
import { describe, it, expect } from 'vitest';
import {
    PROTOCOL_CONSTANTS, TIER_LEVELS, genesisBadgeFor, getTier, tierForCredit, withBadge, tierIndexForCredit, tierIndexForName,
} from '../protocol.js';

// Credit in whole hundredths (hundredths.ts): 200 Beans is 20000, and one hundredth below a tier is the tier before it.
const BOUNDARIES: Array<[number, string]> = [
    [0, 'Newcomer'], [19999, 'Newcomer'], [20000, 'Resident'], [59999, 'Resident'],
    [60000, 'Steward'], [139999, 'Steward'], [140000, 'Elder'], [200000, 'Elder'],
];

describe('TIER_LEVELS', () => {
    it('starts each tier where the floor thresholds put it', () => {
        const c = PROTOCOL_CONSTANTS;
        expect(TIER_LEVELS.map(t => [t.name, t.minCredit])).toEqual([
            ['Newcomer', 0],
            ['Resident', c.CREDIT_BASE_FLOOR - c.GHOST_THRESHOLD],
            ['Steward', c.CREDIT_BASE_FLOOR - c.RESIDENT_THRESHOLD],
            ['Elder', c.CREDIT_BASE_FLOOR - c.STEWARD_THRESHOLD],
        ]);
        expect(TIER_LEVELS.map(t => t.minCredit)).toEqual([0, 20000, 60000, 140000]);
    });

    it('a genesis invite gives a badge, never credit: core keeps no credit figure for a tier', () => {
        expect(genesisBadgeFor('standard')).toBeNull();
        expect(genesisBadgeFor('trusted')).toBe('Resident');
        expect(genesisBadgeFor('ambassador')).toBe('Steward');
        expect(genesisBadgeFor('elder')).toBe('Elder');
        expect(Object.keys(PROTOCOL_CONSTANTS).filter(k => /GENESIS/.test(k))).toEqual([]);
    });

    it('a badge shows the higher of itself and what the member did, never lower', () => {
        expect(withBadge(getTier(0), null).name).toBe('Newcomer');
        expect(withBadge(getTier(0), 'Resident').name).toBe('Resident');
        expect(withBadge(getTier(0), 'Elder')).toEqual({ name: 'Elder', emoji: TIER_LEVELS[3].emoji });
        // A member whose trades made them a Steward keeps Steward under a Resident badge.
        expect(withBadge(tierForCredit(TIER_LEVELS[2].minCredit), 'Resident').name).toBe('Steward');
    });

    it('Newcomer shows the seedling', () => {
        expect(TIER_LEVELS[0].emoji).toBe('🌱');
        expect(getTier(0).emoji).toBe('🌱');
    });
});

describe('tierForCredit', () => {
    it.each(BOUNDARIES)('credit %i → %s', (credit, name) => {
        expect(tierForCredit(credit).name).toBe(name);
        expect(TIER_LEVELS[tierIndexForCredit(credit)].name).toBe(name);
    });

    it('agrees with getTier(floor) on both sides of every boundary', () => {
        for (let credit = 0; credit <= 200000; credit += 50) {
            expect(getTier(PROTOCOL_CONSTANTS.CREDIT_BASE_FLOOR - credit).name).toBe(tierForCredit(credit).name);
        }
    });

    it('treats nonsense as Newcomer', () => {
        expect(tierForCredit(NaN).name).toBe('Newcomer');
        expect(tierForCredit(-5000).name).toBe('Newcomer');
    });
});

describe('getTier', () => {
    it('returns a badge only — nothing a caller could gate on', () => {
        expect(Object.keys(getTier(-140000)).sort()).toEqual(['emoji', 'name']);
    });
});

describe('tierIndexForName', () => {
    it('finds each tier and rejects anything else', () => {
        expect(TIER_LEVELS.map(t => tierIndexForName(t.name))).toEqual([0, 1, 2, 3]);
        expect(tierIndexForName('Ghost')).toBe(-1);
        expect(tierIndexForName(undefined)).toBe(-1);
    });
});

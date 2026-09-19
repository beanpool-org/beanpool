/**
 * Trust tiers — one table, one boundary rule. The apps, the server and admin views all read TIER_LEVELS /
 * tierForCredit, so these tests pin the table to the floor thresholds getTier has always used and to the
 * admin grants in docs/trust-model-v3.md (Resident 200, Steward 600, Elder 1400).
 */
import { describe, it, expect } from 'vitest';
import {
    PROTOCOL_CONSTANTS, TIER_LEVELS, getTier, grantedCreditForTier, tierForCredit, tierIndexForCredit, tierIndexForName,
} from '../protocol.js';

const BOUNDARIES: Array<[number, string]> = [
    [0, 'Newcomer'], [199, 'Newcomer'], [200, 'Resident'], [599, 'Resident'],
    [600, 'Steward'], [1399, 'Steward'], [1400, 'Elder'], [2000, 'Elder'],
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
        expect(TIER_LEVELS.map(t => t.minCredit)).toEqual([0, 200, 600, 1400]);
    });

    it('an admin tier badge lands exactly on that tier', () => {
        for (const t of TIER_LEVELS) {
            expect(tierForCredit(grantedCreditForTier(t.name)).name).toBe(t.name);
        }
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
        for (let credit = 0; credit <= 2000; credit += 0.5) {
            expect(getTier(PROTOCOL_CONSTANTS.CREDIT_BASE_FLOOR - credit).name).toBe(tierForCredit(credit).name);
        }
    });

    it('treats nonsense as Newcomer', () => {
        expect(tierForCredit(NaN).name).toBe('Newcomer');
        expect(tierForCredit(-50).name).toBe('Newcomer');
    });
});

describe('getTier', () => {
    it('returns a badge only — nothing a caller could gate on', () => {
        expect(Object.keys(getTier(-1400)).sort()).toEqual(['emoji', 'name']);
    });
});

describe('tierIndexForName', () => {
    it('finds each tier and rejects anything else', () => {
        expect(TIER_LEVELS.map(t => tierIndexForName(t.name))).toEqual([0, 1, 2, 3]);
        expect(tierIndexForName('Ghost')).toBe(-1);
        expect(tierIndexForName(undefined)).toBe(-1);
    });
});

import { describe, it, expect } from 'vitest';
import { getTrustTier, isElder } from './PostAuthorTrust';

describe('PostAuthorTrust utilities', () => {
    describe('getTrustTier', () => {
        it('returns New tier for default parameter (undefined)', () => {
            const tier = getTrustTier();
            expect(tier.label).toBe('New');
            expect(tier.emoji).toBe('🌱');
            expect(tier.min).toBe(0);
        });

        it('returns New tier for 0 <= energyCycled < 1000', () => {
            expect(getTrustTier(0).label).toBe('New');
            expect(getTrustTier(500).label).toBe('New');
            expect(getTrustTier(999).label).toBe('New');
        });

        it('returns Member tier for 1000 <= energyCycled < 5000', () => {
            const tierMin = getTrustTier(1000);
            expect(tierMin.label).toBe('Member');
            expect(tierMin.emoji).toBe('🌿');
            expect(tierMin.min).toBe(1000);

            expect(getTrustTier(2500).label).toBe('Member');
            expect(getTrustTier(4999).label).toBe('Member');
        });

        it('returns Trusted tier for 5000 <= energyCycled < 10000', () => {
            const tierMin = getTrustTier(5000);
            expect(tierMin.label).toBe('Trusted');
            expect(tierMin.emoji).toBe('🌳');
            expect(tierMin.min).toBe(5000);

            expect(getTrustTier(7500).label).toBe('Trusted');
            expect(getTrustTier(9999).label).toBe('Trusted');
        });

        it('returns Elder tier for energyCycled >= 10000', () => {
            const tierMin = getTrustTier(10000);
            expect(tierMin.label).toBe('Elder');
            expect(tierMin.emoji).toBe('⛰️');
            expect(tierMin.min).toBe(10000);

            expect(getTrustTier(25000).label).toBe('Elder');
        });

        it('returns New tier for negative numbers', () => {
            expect(getTrustTier(-10).label).toBe('New');
            expect(getTrustTier(-1000).label).toBe('New');
        });
    });

    describe('isElder', () => {
        it('returns false for default parameter (undefined)', () => {
            expect(isElder()).toBe(false);
        });

        it('returns false for energyCycled < 10000', () => {
            expect(isElder(0)).toBe(false);
            expect(isElder(5000)).toBe(false);
            expect(isElder(9999)).toBe(false);
        });

        it('returns true for energyCycled >= 10000', () => {
            expect(isElder(10000)).toBe(true);
            expect(isElder(15000)).toBe(true);
        });

        it('returns false for negative values', () => {
            expect(isElder(-1)).toBe(false);
        });
    });
});

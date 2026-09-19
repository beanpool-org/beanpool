/**
 * Trust tiers on the phone come from @beanpool/core — the card badge, the Elder card, the Market trust
 * filter and the Newcomer label colour. Before this, the cards started Resident/Steward/Elder at
 * 120/520/1320 and the Ledger at 180/580/1380, against the node's 200/600/1400.
 */

import { describe, it, expect } from 'vitest';
import { PROTOCOL_CONSTANTS, TIER_LEVELS, getTier, tierForCredit } from '@beanpool/core';
import { getTrustTier, isElder } from '../trust-tier';
import { feedPostVisible, DEFAULT_MARKET_FILTERS } from '../market-filters';
import { lightColors, earthColors, slateColors, darkColors } from '../../constants/colors';

const BOUNDARIES = [0, 199, 200, 599, 600, 1399, 1400, 2000];
const coreTier = (credit: number) => getTier(PROTOCOL_CONSTANTS.CREDIT_BASE_FLOOR - credit).name;

describe('the card badge', () => {
    it.each(BOUNDARIES)('credit %i gives the node\'s tier', (credit) => {
        expect(getTrustTier(credit).name).toBe(coreTier(credit));
        expect(getTrustTier(credit).label).toBe(coreTier(credit));
        expect(getTrustTier(credit).token).toBe(coreTier(credit).toLowerCase());
    });

    it('starts each tier where the node does', () => {
        expect([199, 200, 599, 600, 1399, 1400].map(c => getTrustTier(c).name))
            .toEqual(['Newcomer', 'Resident', 'Resident', 'Steward', 'Steward', 'Elder']);
    });

    it('shows the core emoji, 🌱 for a Newcomer', () => {
        expect(getTrustTier(0).emoji).toBe('🌱');
        for (const t of TIER_LEVELS) expect(getTrustTier(t.minCredit).emoji).toBe(t.emoji);
    });

    it('gives Elder card treatment from 1400 exactly', () => {
        expect(isElder(1399)).toBe(false);
        expect(isElder(1400)).toBe(true);
    });
});

describe('the Market trust filter', () => {
    const at = (credit: number) => ({ id: `c${credit}`, type: 'offer', category: 'food', status: 'active', author_pubkey: `pk${credit}`, author_energy_cycled: credit });
    const feed = BOUNDARIES.map(at);
    const ctx = { blockedUsers: [] as string[], favCategories: [], nowMs: Date.now() };
    const shown = (trust: string) => feed.filter(p => feedPostVisible(p, { ...DEFAULT_MARKET_FILTERS, trust }, ctx)).map(p => p.author_energy_cycled);
    const rank = (credit: number) => TIER_LEVELS.findIndex(t => t.name === tierForCredit(credit).name);

    it('"Newcomers" is exactly the Newcomer tier', () => {
        expect(shown('new')).toEqual(BOUNDARIES.filter(c => coreTier(c) === 'Newcomer'));
    });

    it.each([['resident', 1], ['steward', 2], ['elder', 3]] as const)('"%s" is that tier and above', (trust, min) => {
        expect(shown(trust)).toEqual(BOUNDARIES.filter(c => rank(c) >= min));
    });
});

describe('the Newcomer label', () => {
    // WCAG 2 relative luminance. The label is 10px bold, so it needs the full 4.5:1.
    const lum = (hex: string) => {
        const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
            .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string) => {
        const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
    };

    it.each([['classic', lightColors], ['earth', earthColors], ['slate', slateColors], ['dark', darkColors]] as const)(
        '%s palette reads at 4.5:1 or better', (_name, palette) => {
            const { fg, bg } = palette.trust.newcomer;
            expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
        });
});

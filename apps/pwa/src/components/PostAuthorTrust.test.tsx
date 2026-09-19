/**
 * The PWA's card tier is the node's tier (@beanpool/core). Before, the cards used their own table —
 * New / Member / Trusted / Elder at 0 / 1000 / 5000 / 10000 — so nobody was ever shown as an Elder.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PROTOCOL_CONSTANTS, TIER_LEVELS, getTier } from '@beanpool/core';
import { PostAuthorTrust, getTrustTier, isElder } from './PostAuthorTrust';

const coreTier = (credit: number) => getTier(PROTOCOL_CONSTANTS.CREDIT_BASE_FLOOR - credit).name;

describe('PostAuthorTrust tier', () => {
    it.each([0, 199, 200, 599, 600, 1399, 1400, 2000])('credit %i gives the node\'s tier', (credit) => {
        expect(getTrustTier(credit).name).toBe(coreTier(credit));
        expect(getTrustTier(credit).label).toBe(coreTier(credit));
    });

    it('starts each tier where the node does', () => {
        expect([199, 200, 599, 600, 1399, 1400].map(c => getTrustTier(c).name))
            .toEqual(['Newcomer', 'Resident', 'Resident', 'Steward', 'Steward', 'Elder']);
    });

    it('uses the core emoji, 🌱 for a Newcomer', () => {
        for (const t of TIER_LEVELS) expect(getTrustTier(t.minCredit).emoji).toBe(t.emoji);
        expect(getTrustTier(0).emoji).toBe('🌱');
    });

    it('treats 1400 and up as Elder', () => {
        expect(isElder(1399)).toBe(false);
        expect(isElder(1400)).toBe(true);
    });

    it('labels the full card with the node\'s tier name', () => {
        render(<PostAuthorTrust callsign="Rowan" energyCycled={600} />);
        expect(screen.getByText('Steward')).toBeInTheDocument();
    });
});

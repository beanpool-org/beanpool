/**
 * The PWA's card tier is the node's tier (@beanpool/core). Before, the cards used their own table —
 * New / Member / Trusted / Elder at 0 / 1000 / 5000 / 10000 — so nobody was ever shown as an Elder.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PROTOCOL_CONSTANTS, TIER_LEVELS, getTier } from '@beanpool/core';
import { PostAuthorTrust, getTrustTier, isElder } from './PostAuthorTrust';
import { resolveAvatarUrl } from '../lib/avatar';

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

    // Where Beans are marked (the global node) a tier can't be earned, so no card shows one (global previews audit, item 2).
    it.each(['full', 'compact'] as const)('%s: no tier badge with showTier false; the name stays', (mode) => {
        render(<PostAuthorTrust callsign="Rowan" energyCycled={0} mode={mode} showTier={false} />);
        expect(screen.queryByTestId('author-tier')).toBeNull();
        expect(screen.queryByText('🌱')).toBeNull();
        expect(screen.queryByText('Newcomer')).toBeNull();
        expect(screen.getByText('Rowan')).toBeInTheDocument();
    });

    it.each(['full', 'compact'] as const)('%s: the tier badge by default, as before', (mode) => {
        render(<PostAuthorTrust callsign="Rowan" energyCycled={0} mode={mode} />);
        expect(screen.getByTestId('author-tier')).toHaveTextContent('🌱');
    });

    it('the tier\'s name and the profile button\'s label in the member\'s language; the callsign as written', async () => {
        const { setLanguage } = await import('@beanpool/core');
        try {
            setLanguage('pt', [{ 'Steward\u0004trust tier': 'Guardião', "View {name}'s profile": 'Ver o perfil de {name}' }]);
            render(<PostAuthorTrust callsign="Rowan" energyCycled={600} publicKey={'b'.repeat(64)} onOpenProfile={() => {}} />);
            expect(screen.getByTestId('author-tier')).toHaveTextContent('Guardião');
            expect(screen.getByRole('button', { name: 'Ver o perfil de Rowan' })).toBeInTheDocument();
        } finally {
            setLanguage('en');
        }
    });
});

// Pictures S4 (Marty: never a bare initial): an author with no photo shows the ready-made picture their key picks, on
// both card sizes, as the phone's author line does.
describe('PostAuthorTrust face', () => {
    const KEY = 'a1'.repeat(32);
    it.each(['full', 'compact'] as const)('%s: no photo, so the key\'s ready-made picture, never the initial', (mode) => {
        const { container } = render(<PostAuthorTrust callsign="Rowan" publicKey={KEY} avatarUrl={null} mode={mode} />);
        expect(screen.queryByText('R')).toBeNull();
        const img = container.querySelector('img');
        expect(img?.getAttribute('src')).toBe(resolveAvatarUrl(null, KEY));
        expect(img?.getAttribute('src')).toMatch(/^\/avatars\/avatar_[a-z_]+\.jpg$/);
    });

    it('a photo is drawn as it was', () => {
        const { container } = render(<PostAuthorTrust callsign="Rowan" publicKey={KEY} avatarUrl="/api/avatar/abc?v=1" />);
        expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/avatar/abc?v=1');
    });
});

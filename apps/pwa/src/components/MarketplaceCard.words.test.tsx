/**
 * A Market card in the member's language (words S3, web sweep W1): in the grid (with and without a photo), list and
 * compact layouts, an Offer and a Need, a Daily Pulse card, and the paused / pending / recurring / founding / cash-too /
 * group-only / own-card marks, every word on it came through t() (the phone's market.tsx keys where the English is the
 * same), its price with the Beans sign. The title, description, names, group and community names are theirs.
 *
 * The author chip is PostAuthorTrust's (another component, its own sweep): drawn here as the name alone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-xx.test-support';
import { MARKETPLACE_CATEGORIES, type MarketplacePost } from '../lib/marketplace';

vi.mock('./PostAuthorTrust', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./PostAuthorTrust')>()),
    PostAuthorTrust: ({ callsign, isFounding }: { callsign: string; isFounding?: boolean }) => (
        <span data-testid="author">{callsign}{isFounding ? ' 🔑' : ''}</span>
    ),
}));

import { MarketplaceCard } from './MarketplaceCard';

const base = {
    id: 'p1', type: 'offer', category: 'food', title: 'Sourdough loaf', description: 'Baked this morning', price_c: 1200,
    priceType: 'hourly', authorPublicKey: 'a'.repeat(64), authorCallsign: 'Kofi', active: true, status: 'active',
    createdAt: new Date().toISOString(),
} as unknown as MarketplacePost;
const marked = {
    ...base, repeatable: true, cashAlsoNeeded: true, authorFoundingNeeded: true, audienceScope: 'group', targetGroupName: 'Garden club',
} as MarketplacePost;
const withPhoto = { ...marked, photos: ['/api/marketplace/posts/p1/photos/0?v=1'] } as MarketplacePost;
const need = { ...base, id: 'p2', type: 'need', category: 'tools', title: 'Borrow a ladder', description: '', status: 'pending', priceType: 'daily' } as MarketplacePost;
const paused = { ...base, id: 'p3', status: 'paused', priceType: 'monthly', price_c: 250 } as MarketplacePost;
const pulse = { ...base, id: 'p4', authorCallsign: 'Daily Pulse', title: 'On sharing', description: 'A thought for today' } as MarketplacePost;
const others = ['Sourdough loaf', 'Baked this morning', 'Kofi', 'Garden club', 'Borrow a ladder', 'On sharing', 'A thought for today', 'Daily Pulse', 'mullum'];

const LAYOUTS = ['grid', 'list', 'compact'] as const;

afterEach(() => { cleanup(); backToEnglish(); });

describe('a Market card in the pseudo-locale', () => {
    it.each(LAYOUTS)('%s: an Offer with every mark, a Need, a paused card and a Pulse card', async (viewMode) => {
        await showIn('xx');
        render(
            <div>
                <MarketplaceCard post={marked} viewMode={viewMode} distanceKm={2.4} remoteNode="mullum" isOwnPost authorEnergy={10000000} />
                <MarketplaceCard post={withPhoto} viewMode={viewMode} distanceKm={0.42} />
                <MarketplaceCard post={need} viewMode={viewMode} distanceKm={12} />
                <MarketplaceCard post={paused} viewMode={viewMode} />
                <MarketplaceCard post={pulse} viewMode={viewMode} />
            </div>,
        );
        expect(screen.getAllByText('Sourdough loaf').length).toBeGreaterThan(0);
        expect(screen.getAllByAltText(xx('B')).length).toBeGreaterThan(0);
        expect(bracketed()).toBeGreaterThan(5);
        expect(bypassing(document.body, { others })).toEqual([]);
    });

    it('the marks read their own words', async () => {
        await showIn('xx');
        render(
            <div>
                <MarketplaceCard post={withPhoto} viewMode="grid" />
                <MarketplaceCard post={need} viewMode="grid" />
                {/* A grid tile's row 4 holds one chip (G2): the group lock beats RECURRING on `withPhoto`, so this one carries it. */}
                <MarketplaceCard post={{ ...base, id: 'p5', repeatable: true } as MarketplacePost} viewMode="grid" />
                <MarketplaceCard post={marked} viewMode="list" isOwnPost distanceKm={2.4} />
                <MarketplaceCard post={marked} viewMode="compact" isOwnPost authorEnergy={10000000} />
            </div>,
        );
        // The photo is part of the card (4 Nov): it names the listing, and there is no enlarge button on a card.
        expect(screen.getByAltText('Sourdough loaf')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /enlarged/ })).toBeNull();
        expect(screen.getAllByText(xx('↻ RECURRING')).length).toBeGreaterThan(1);
        expect(screen.getByText(xx('⏳ PENDING'))).toBeInTheDocument();
        expect(screen.getByText(xx('💸 CASH TOO')).getAttribute('title')).toBe(xx('Cash also needed for fuel or materials — agreed in chat'));
        // The grid tile's row-4 chip is the one chip now (G2), as the list card's is: both read their own words.
        expect(screen.getAllByText(xx('🔒 Only {group} can see this').replace('{group}', 'Garden club'), { selector: '.rounded-md' }).length).toBeGreaterThan(1);
        expect(screen.getByText(xx('{distance} km').replace('{distance}', '2.4'))).toBeInTheDocument();
        expect(screen.getByText(xx('Food & Produce'))).toBeInTheDocument();
        expect(screen.getAllByText(xx('/hr')).length).toBeGreaterThan(0);
        expect(screen.getByText(xx('👤 (You)')).parentElement!.textContent).toContain(xx('by {name} ⛰️ {you}').replace('{name}', 'Kofi').split('{you}')[0]);
        expect(bypassing(document.body, { others })).toEqual([]);
    });

    it('in English nothing is bracketed, and the words are as they were', () => {
        render(
            <div>
                <MarketplaceCard post={withPhoto} viewMode="grid" distanceKm={0.42} />
                <MarketplaceCard post={need} viewMode="grid" />
                <MarketplaceCard post={marked} viewMode="list" isOwnPost distanceKm={2.4} />
                <MarketplaceCard post={paused} viewMode="list" />
                <MarketplaceCard post={marked} viewMode="compact" isOwnPost authorEnergy={10000000} />
                <MarketplaceCard post={pulse} viewMode="grid" />
            </div>,
        );
        expect(bracketed()).toBe(0);
        expect(screen.getByText('👤 (You)').parentElement!.textContent).toMatch(/^by Kofi ⛰️ 👤 \(You\)/);
        expect(screen.getAllByText(/🔑/).length).toBeGreaterThan(0);
        expect(screen.getAllByText('🔒 Only Garden club can see this').length).toBeGreaterThan(0);
        expect(screen.getByText('💸 CASH TOO')).toHaveAttribute('title', 'Cash also needed for fuel or materials — agreed in chat');
        expect(screen.getByText('⏳ PENDING')).toBeInTheDocument();
        // The list card's chips are the style box's (W2, DESIGN-card-style-box-fable.md §1.2): the same keys, their capitals from
        // core's upperCase(), never from a CSS rule that cannot capitalise Turkish or Greek.
        expect(screen.getByText('⏸ PAUSED')).toBeInTheDocument();
        expect(screen.getByText('👤 YOU')).toBeInTheDocument();
        // The grid's Pulse pill is the one chip now (G2), its capitals from core's upperCase(), as the list card's (W2).
        expect(screen.getByText('🗞️ DAILY PULSE')).toBeInTheDocument();
        // The grid's DAILY PULSE foot label left the tile in G2 (DESIGN-market-grid-sizes-fable.md §2.2): the pill says it.
        expect(screen.queryByText('DAILY PULSE')).toBeNull();
        expect(screen.queryByText('VIEW')).toBeNull();
        expect(screen.queryByText('No description provided.')).toBeNull();
        expect(screen.getByText('420 m')).toBeInTheDocument();
        expect(screen.getByText('2.4 km')).toBeInTheDocument();
        // 250 hundredths, written as formatHundredths writes them: two decimals whenever there are cents.
        expect(screen.getByText('2.50')).toBeInTheDocument();
        expect(screen.getByText('/mo')).toBeInTheDocument();
        expect(screen.getByText('/day')).toBeInTheDocument();
        // The compact row's type chip is the box's one chip now (C1), its capitals from core's upperCase() as the list card's and
        // the tile's (W2, G2), not the lowercase key under a CSS `uppercase` rule.
        expect(screen.getAllByText('OFFER').length).toBeGreaterThan(0);
        expect(screen.queryByText('offer')).toBeNull();
        expect(screen.getAllByAltText('B').length).toBeGreaterThan(0);
        expect(screen.getByAltText('Sourdough loaf')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /enlarged/ })).toBeNull();
    });

    it('every category reads lib/marketplace.ts\'s own name, as before', () => {
        render(
            <div>
                {MARKETPLACE_CATEGORIES.map((c) => <MarketplaceCard key={c.id} post={{ ...base, id: c.id, category: c.id } as MarketplacePost} viewMode="list" />)}
            </div>,
        );
        for (const c of MARKETPLACE_CATEGORIES) expect(screen.getByText(c.label)).toBeInTheDocument();
    });
});

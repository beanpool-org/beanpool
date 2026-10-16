/**
 * Where Beans live in a local community for this reader (the global node: lib/features `marked`), a Market card shows
 * no Beans as live: no price pill, no "🌱 FOUNDING TRADE", no tier badge. There every price reads 0 and every author is
 * a Newcomer with a founding trade to make, which can't happen on that node (global previews audit, item 1,
 * B6-market-cards-320.png). A local node's card is unchanged, in all four layouts.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarketplaceCard } from './MarketplaceCard';
import type { MarketplacePost } from '../lib/marketplace';

const base = {
    id: 'p1', type: 'offer', category: 'food', title: 'Sourdough loaf', description: 'Baked this morning', credits: 12,
    priceType: 'fixed', authorPublicKey: 'a'.repeat(64), authorCallsign: 'Kofi', active: true, status: 'active',
    createdAt: new Date().toISOString(), authorFoundingNeeded: true,
} as unknown as MarketplacePost;
const withPhoto = { ...base, photos: ['/api/marketplace/posts/p1/photos/0?v=1&k=K'] } as MarketplacePost;

// The four layouts: grid with a photo, grid without, list, compact.
const LAYOUTS = [
    ['grid with a photo', withPhoto, 'grid'],
    ['grid without a photo', base, 'grid'],
    ['list', base, 'list'],
    ['compact', base, 'compact'],
] as const;

const price = () => screen.queryByText('12');
const founding = () => screen.queryByText(/FOUNDING/);
const tier = () => screen.queryByTestId('author-tier');

describe('MarketplaceCard where Beans are marked (the global node)', () => {
    it.each(LAYOUTS)('%s: no price, no FOUNDING chip, no tier badge', (_name, post, viewMode) => {
        render(<MarketplaceCard post={post} viewMode={viewMode} beansMarked />);
        expect(screen.getByText('Sourdough loaf')).toBeInTheDocument();
        expect(price()).toBeNull();
        expect(screen.queryByAltText('B')).toBeNull();
        expect(founding()).toBeNull();
        expect(tier()).toBeNull();
        expect(screen.queryByText('Newcomer')).toBeNull();
    });

    it('an Elder author gets no Elder look either (a tier is Beans)', () => {
        render(<MarketplaceCard post={base} viewMode="compact" authorEnergy={100000} beansMarked />);
        expect(screen.queryByText(/⛰️/)).toBeNull();
    });
});

describe('MarketplaceCard on a local node (Beans live): unchanged', () => {
    it.each(LAYOUTS)('%s: the price and the FOUNDING chip', (_name, post, viewMode) => {
        render(<MarketplaceCard post={post} viewMode={viewMode} />);
        expect(price()).not.toBeNull();
        expect(founding()).not.toBeNull();
    });

    it.each(['grid', 'list'] as const)('%s: the author\'s tier badge', (viewMode) => {
        render(<MarketplaceCard post={base} viewMode={viewMode} />);
        expect(tier()).not.toBeNull();
    });

    it('an Elder author keeps the Elder mark', () => {
        render(<MarketplaceCard post={base} viewMode="compact" authorEnergy={100000} />);
        expect(screen.getByText(/⛰️/)).toBeInTheDocument();
    });
});

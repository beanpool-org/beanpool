/**
 * A listing priced at 0 Beans reads Free on a Market card (core listing-price.ts; Marty, 9 Nov), in all four layouts the web draws
 * (grid with and without a photo, list, compact) and on the map's pop-up card, which is this same card: "Free" for an Offer and for a
 * Need, whatever the price unit, with no Beans sign and no unit, and a screen reader reads "Free", not "0 B". A listing with a price
 * is unchanged, and where Beans are marked (the global node) there is no price at all, free or not.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarketplaceCard } from './MarketplaceCard';
import type { MarketplacePost } from '../lib/marketplace';

const post = (over: Record<string, unknown> = {}) => ({
    id: 'p1', type: 'offer', category: 'food', title: 'Invites to harvest any sort of spray free food', description: 'Come and pick', price_c: 0,
    priceType: 'fixed', authorPublicKey: 'a'.repeat(64), authorCallsign: 'Kofi', active: true, status: 'active',
    createdAt: new Date().toISOString(), photos: ['/api/marketplace/posts/p1/photos/0?v=1&k=K'], ...over,
}) as unknown as MarketplacePost;

const LAYOUTS = ['grid', 'list', 'compact'] as const;
const UNITS = ['fixed', 'hourly', 'daily', 'weekly', 'monthly'] as const;

describe('MarketplaceCard: a listing at 0 reads Free', () => {
    for (const type of ['offer', 'need']) {
        for (const viewMode of LAYOUTS) {
            it(`${type}, ${viewMode}: Free, no Beans sign, no figure`, () => {
                const { container } = render(<MarketplaceCard post={post({ type })} viewMode={viewMode} />);
                expect(screen.getByText('Free')).toBeInTheDocument();
                expect(screen.queryByAltText('B')).toBeNull();
                // The only text that is not the title, the chips or the author is the price: no "0" anywhere in it.
                const priceNode = screen.getByText('Free');
                expect(priceNode.textContent).toBe('Free');
                expect(priceNode.closest('[data-testid="listing-list-price"]')?.querySelector('img') ?? null).toBeNull();
                expect(container.textContent).not.toMatch(/(^|\s)0(\s|$)/);
            });
        }
    }

    it.each(UNITS)('priced %s at 0: Free, never "Free /hr" (grid, list, compact)', (priceType) => {
        for (const viewMode of LAYOUTS) {
            const { container, unmount } = render(<MarketplaceCard post={post({ priceType })} viewMode={viewMode} />);
            expect(screen.getByText('Free')).toBeInTheDocument();
            expect(container.textContent).not.toMatch(/\/(hr|day|wk|mo)/i);
            unmount();
        }
    });

    it('the list card keeps the price in its own place: the floated price node holds Free', () => {
        render(<MarketplaceCard post={post()} viewMode="list" />);
        expect(screen.getByTestId('listing-list-price')).toHaveTextContent(/^Free$/);
    });
});

describe('MarketplaceCard: a listing with a price, or with none sent, is unchanged', () => {
    it.each(LAYOUTS)('%s: 12 with its Beans sign', (viewMode) => {
        render(<MarketplaceCard post={post({ price_c: 1200 })} viewMode={viewMode} />);
        expect(screen.getByText('12')).toBeInTheDocument();
        expect(screen.getByAltText('B')).toBeInTheDocument();
        expect(screen.queryByText('Free')).toBeNull();
    });

    it('an hourly price keeps its unit', () => {
        render(<MarketplaceCard post={post({ price_c: 2000, priceType: 'hourly' })} viewMode="list" />);
        expect(screen.getByTestId('listing-list-price')).toHaveTextContent('20');
        expect(screen.getByTestId('listing-list-price')).toHaveTextContent('/hr');
    });

    it('a price the node did not send keeps its "?" and is not Free', () => {
        render(<MarketplaceCard post={post({ price_c: undefined })} viewMode="list" />);
        expect(screen.getByTestId('listing-list-price')).toHaveTextContent('?');
        expect(screen.queryByText('Free')).toBeNull();
    });

    it.each(LAYOUTS)('%s, Beans marked (the global node): no price at all, not even Free', (viewMode) => {
        render(<MarketplaceCard post={post()} viewMode={viewMode} beansMarked />);
        expect(screen.queryByText('Free')).toBeNull();
        expect(screen.queryByAltText('B')).toBeNull();
    });
});

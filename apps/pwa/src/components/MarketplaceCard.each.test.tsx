/**
 * An Offer priced for each one on the web's Market card (core per-item.ts; DESIGN-per-item-price-fable.md §2.1, slice P2), in the
 * three sizes the web draws (grid, list, compact; the map's pop-up is the list card): "300 [bean] each" in the price's place, how
 * many are left and the price for all of them as whole phrases, and the grid's one chip in RECURRING's place. Rob's panels:
 * 300 Beans each, 20 of them, or all 20 for 5,500. Each check names the change that turns it red.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarketplaceCard } from './MarketplaceCard';
import type { MarketplacePost } from '../lib/marketplace';

const post = (over: Record<string, unknown> = {}) => ({
    id: 'p1', type: 'offer', category: 'tools', title: 'Solar panels', description: 'Second-hand', price_c: 30000,
    priceType: 'each', unitsLeft: 20, lot: { units: 20, price_c: 550000 }, authorPublicKey: 'a'.repeat(64), authorCallsign: 'Rob',
    active: true, status: 'active', createdAt: new Date().toISOString(), photos: [], ...over,
}) as unknown as MarketplacePost;

const LAYOUTS = ['grid', 'list', 'compact'] as const;
const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ').trim();
/** The lines of a stacked price: each child block's own words (blocks stack, so their text is not run together on screen). */
const lines = (el: HTMLElement) => Array.from(el.children).map((c) => text(c as HTMLElement));

describe('the grid tile', () => {
    it('the pill says "300 [bean] each" with "all 5,500" under it; the chip says 20 LEFT (red if either is dropped)', () => {
        render(<MarketplaceCard post={post()} viewMode="grid" />);
        const pill = screen.getByTestId('grid-each-price');
        expect(lines(pill)).toEqual(['300 each', 'all 5,500']);
        expect(within(pill).getAllByAltText('B')).toHaveLength(2);
        expect(screen.getByTestId('card-stock-chip')).toHaveTextContent('20 LEFT');
    });
    it('one taken singly: the price for all is gone from the pill and the chip says 19 LEFT (red if the lot is not tied to the count)', () => {
        render(<MarketplaceCard post={post({ unitsLeft: 19 })} viewMode="grid" />);
        expect(text(screen.getByTestId('grid-each-price'))).toBe('300 each');
        expect(screen.getByTestId('card-stock-chip')).toHaveTextContent('19 LEFT');
    });
    it('no price for all set: one line in the pill', () => {
        render(<MarketplaceCard post={post({ lot: null })} viewMode="grid" />);
        expect(text(screen.getByTestId('grid-each-price'))).toBe('300 each');
    });
    it('none left with deals open: ALL TAKEN FOR NOW in the warning chip, and the pill still has the price', () => {
        render(<MarketplaceCard post={post({ unitsLeft: 0 })} viewMode="grid" />);
        expect(screen.getByTestId('card-stock-chip')).toHaveTextContent('ALL TAKEN FOR NOW');
        expect(text(screen.getByTestId('grid-each-price'))).toBe('300 each');
    });
    it('a free one: "Free" in the price place, no Beans sign, 20 LEFT in the chip', () => {
        render(<MarketplaceCard post={post({ price_c: 0, lot: null })} viewMode="grid" />);
        expect(screen.getByText('Free')).toBeInTheDocument();
        expect(screen.queryByAltText('B')).toBeNull();
        expect(screen.getByTestId('card-stock-chip')).toHaveTextContent('20 LEFT');
    });
    it('a deal, a pause or a group lock takes the chip first (the box\'s order: deal > paused > group lock > stock)', () => {
        render(<MarketplaceCard post={post()} viewMode="grid" dealChip="in-trust" />);
        expect(screen.queryByTestId('card-stock-chip')).toBeNull();
        expect(screen.getByTestId('card-deal-chip')).toBeInTheDocument();
    });
});

describe('the list card (and the map pop-up, which is this card)', () => {
    it('the price is at the row\'s end and the line under the title is two whole phrases (red if the line is glued or cut)', () => {
        render(<MarketplaceCard post={post()} viewMode="list" />);
        expect(text(screen.getByTestId('listing-list-price'))).toBe('300 each');
        const line = screen.getByTestId('listing-list-each-line');
        expect(text(line)).toBe('20 left · or all for 5,500');
        // Each phrase is its own no-wrap box, so a narrow screen breaks between them, never inside one.
        const phrases = line.querySelectorAll('span.whitespace-nowrap');
        expect(Array.from(phrases).map((p) => text(p as HTMLElement))).toEqual(['20 left', 'or all for 5,500']);
        expect(line.className).not.toMatch(/truncate|line-clamp/);
    });
    it('19 left: one phrase', () => {
        render(<MarketplaceCard post={post({ unitsLeft: 19 })} viewMode="list" popUp />);
        expect(text(screen.getByTestId('listing-list-each-line'))).toBe('19 left');
    });
    it('all taken for now: words, not a count', () => {
        render(<MarketplaceCard post={post({ unitsLeft: 0 })} viewMode="list" />);
        expect(text(screen.getByTestId('listing-list-each-line'))).toBe('All taken for now');
    });
    it('no RECURRING chip on it (Each is never Repeatable) and no "/hr" or other unit after the price', () => {
        render(<MarketplaceCard post={post()} viewMode="list" />);
        expect(screen.queryByText(/RECURRING/)).toBeNull();
        expect(screen.getByTestId('listing-list-price').textContent).not.toMatch(/\//);
    });
});

describe('the compact row', () => {
    it('the end column: "300 each" with "all 5,500" under it; the by-line carries "20 left"', () => {
        render(<MarketplaceCard post={post()} viewMode="compact" />);
        expect(lines(screen.getByTestId('compact-each-price'))).toEqual(['300 each', 'all 5,500']);
        expect(screen.getByTestId('compact-each-all')).toHaveTextContent('all 5,500');
        expect(screen.getByTestId('card-stock')).toHaveTextContent('20 left');
    });
    it('19 left: no line for all', () => {
        render(<MarketplaceCard post={post({ unitsLeft: 19 })} viewMode="compact" />);
        expect(screen.queryByTestId('compact-each-all')).toBeNull();
        expect(screen.getByTestId('card-stock')).toHaveTextContent('19 left');
    });
});

describe('where the price is not shown there is no count, and any other listing is unchanged', () => {
    it.each(LAYOUTS)('%s, Beans marked (the global node): no price, no count, no price for all', (viewMode) => {
        const { container } = render(<MarketplaceCard post={post()} viewMode={viewMode} beansMarked />);
        expect(container.textContent).not.toMatch(/left|LEFT|each|all for|5,500/);
        expect(screen.queryByAltText('B')).toBeNull();
    });
    it.each(LAYOUTS)('%s, a member\'s copy on the global community: its line only, never a count', (viewMode) => {
        const copy = { shownCopy: true, shownFrom: { host: 'byron.example', postId: null, name: 'Byron', url: 'https://byron.example', door: 'ask' }, shownPrice: '30000 each' };
        const { container } = render(<MarketplaceCard post={post({ ...copy, unitsLeft: undefined, lot: undefined })} viewMode={viewMode} />);
        expect(container.textContent).toContain('300 Beans each in Byron');
        expect(container.textContent).not.toMatch(/ left|LEFT|all for/);
    });
    it.each(LAYOUTS)('%s, a fixed price and an hourly one are drawn as they were', (viewMode) => {
        const { container, unmount } = render(<MarketplaceCard post={post({ priceType: 'fixed', price_c: 1200, unitsLeft: undefined, lot: undefined })} viewMode={viewMode} />);
        expect(screen.getByText('12')).toBeInTheDocument();
        expect(container.querySelector('[data-testid="listing-list-each-line"],[data-testid="card-stock-chip"],[data-testid="card-stock"]')).toBeNull();
        unmount();
        render(<MarketplaceCard post={post({ priceType: 'hourly', price_c: 2000, unitsLeft: undefined, lot: undefined })} viewMode={viewMode} />);
        expect(screen.getByText(/\/hr/)).toBeInTheDocument();
    });
    it('a listing of an older node that sent no count reads as it always did: the bare figure', () => {
        render(<MarketplaceCard post={post({ unitsLeft: undefined, lot: undefined })} viewMode="list" />);
        expect(screen.queryByTestId('listing-list-each-line')).toBeNull();
        expect(screen.getByTestId('listing-list-price')).toHaveTextContent('300');
    });
});

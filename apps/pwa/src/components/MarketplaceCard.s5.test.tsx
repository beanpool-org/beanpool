import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarketplaceCard } from './MarketplaceCard';
import type { MarketplacePost } from '../lib/marketplace';
import { GRID_ROW, GRID_SCRIM_PILL, GRID_TEXT, GRID_TITLE, gridChip, gridTile } from './market-card-shell';

const basePost: MarketplacePost = {
    id: 'post-s5-1',
    type: 'offer',
    category: 'food',
    title: 'Fresh organic sourdough bread baked daily for the whole neighbourhood',
    description: 'Crispy crust and soft inside.',
    price_c: 1000,
    priceType: 'fixed',
    authorPublicKey: 'a'.repeat(64),
    authorCallsign: 'Alice',
    active: true,
    status: 'active',
    createdAt: new Date().toISOString(),
    photos: ['/api/marketplace/posts/post-s5-1/photos/0'],
} as unknown as MarketplacePost;

describe('MarketplaceCard S5 design requirements', () => {
    it('a pending recurring own listing shows PENDING only (precedence PENDING > YOU > RECURRING)', () => {
        const post = {
            ...basePost,
            status: 'pending' as const,
            repeatable: true,
        };
        render(<MarketplaceCard post={post} viewMode="grid" isOwnPost />);

        // Must show PENDING
        expect(screen.getByText(/PENDING/)).toBeInTheDocument();
        // Must NOT show YOU or RECURRING
        expect(screen.queryByText(/YOU/)).toBeNull();
        expect(screen.queryByText(/RECURRING/)).toBeNull();
    });

    it('YOU beats RECURRING when active and own', () => {
        const post = {
            ...basePost,
            status: 'active' as const,
            repeatable: true,
        };
        render(<MarketplaceCard post={post} viewMode="grid" isOwnPost />);

        // Must show YOU
        expect(screen.getByText(/YOU/)).toBeInTheDocument();
        // Must NOT show RECURRING or PENDING
        expect(screen.queryByText(/RECURRING/)).toBeNull();
        expect(screen.queryByText(/PENDING/)).toBeNull();
    });

    it('founding shows on the author line (🔑) and not on the photo', () => {
        const post = {
            ...basePost,
            authorFoundingNeeded: true,
        };
        const { container } = render(<MarketplaceCard post={post} viewMode="grid" />);

        // Photo overlay should not contain FOUNDING TRADE
        expect(screen.queryByText('🌱 FOUNDING TRADE')).toBeNull();
        expect(screen.queryByText('🔑 FOUNDING TRADE')).toBeNull();
        // The author line must show the founding mark (🔑)
        const authorLine = container.querySelector('[data-testid="author-founding"]');
        expect(authorLine).not.toBeNull();
        expect(authorLine?.textContent).toContain('🔑');
        expect(authorLine?.textContent).not.toContain('🌱');
    });

    it('founding shows in list view on the author line as 🔑 FOUNDING', () => {
        const post = {
            ...basePost,
            authorFoundingNeeded: true,
        };
        const { container } = render(<MarketplaceCard post={post} viewMode="list" />);
        const authorLine = container.querySelector('[data-testid="author-founding"]');
        expect(authorLine).not.toBeNull();
        expect(authorLine?.textContent).toContain('🔑 FOUNDING');
    });

    it('no description line and no VIEW on a non-Pulse grid card', () => {
        const post = {
            ...basePost,
            description: 'This is a description that should not appear on grid card.',
        };
        render(<MarketplaceCard post={post} viewMode="grid" />);

        // No VIEW button
        expect(screen.queryByText('VIEW')).toBeNull();
        // No description line
        expect(screen.queryByText('This is a description that should not appear on grid card.')).toBeNull();
        expect(screen.queryByText('No description provided.')).toBeNull();
    });

    // G2 (DESIGN-market-grid-sizes-fable.md §2.2): the Pulse tile's four rows are its title (two), its pill, and one line of
    // its news. The DAILY PULSE foot label (a div that looked like a button and was not one) leaves the tile: the pill says it.
    it('Daily Pulse grid tile: its title, its pill and one line of its news, and no DAILY PULSE foot label', () => {
        const pulsePost = {
            ...basePost,
            authorCallsign: 'Daily Pulse',
            id: 'daily-pulse',
            title: 'Daily Pulse 27 Oct',
            description: 'Today in the community',
        } as unknown as MarketplacePost;
        const { getByTestId } = render(<MarketplaceCard post={pulsePost} viewMode="grid" />);

        const block = getByTestId('grid-text-block');
        const rows = Array.from(block.children) as HTMLElement[];
        expect(rows.map(r => r.textContent)).toEqual(['Daily Pulse 27 Oct', '🗞️ DAILY PULSE', 'Today in the community']);
        expect(screen.getByText('Today in the community').className).toContain('truncate');
        expect(screen.queryByText('DAILY PULSE')).toBeNull();
    });

    it('title clamps to two lines in grid mode', () => {
        render(<MarketplaceCard post={basePost} viewMode="grid" />);
        const titleEl = screen.getByText(basePost.title);
        expect(titleEl.className).toContain('line-clamp-2');
    });

    // W2 of the style box (DESIGN-card-style-box-fable.md §1.1): the list photo is 80 wide and the card's full height, at
    // least 80 (flush under the card's left corners, no longer an 80 x 80 square inset in padding).
    it('list thumb is 80 px wide, at least 80 tall, and stretched to the card (w-20 min-h-20 self-stretch)', () => {
        const { container } = render(<MarketplaceCard post={basePost} viewMode="list" />);
        const thumbContainer = container.querySelector('.w-20.min-h-20.self-stretch');
        expect(thumbContainer).not.toBeNull();
        expect(container.querySelector('.w-20.h-20')).toBeNull();
    });

    it('grid card picture wrapper has 4:3 aspect ratio (aspect-[4/3]) and crop anchored to top third (market-card-43)', () => {
        const { container } = render(<MarketplaceCard post={basePost} viewMode="grid" />);
        const mediaBox = container.querySelector('.aspect-\\[4\\/3\\]');
        expect(mediaBox).toBeInTheDocument();
        expect(container.querySelector('.aspect-square')).toBeNull();

        const img = container.querySelector('img[src*="/api/marketplace/posts"]');
        expect(img).toHaveStyle({ objectPosition: '50% 33%' });
    });

    it('grid card moves RECURRING under the picture so overlays fit (market-card-43)', () => {
        const post = {
            ...basePost,
            status: 'active' as const,
            repeatable: true,
        };
        const { container } = render(<MarketplaceCard post={post} viewMode="grid" />);
        const recurringPill = screen.getByText('↻ RECURRING');
        expect(recurringPill).toBeInTheDocument();

        const badgeRow = container.querySelector('[data-testid="grid-badge-row"]');
        expect(badgeRow?.textContent).not.toContain('RECURRING');
    });
});

// G2 (DESIGN-market-grid-sizes-fable.md §2.2): the grid tile is a lattice cell. The tile fills its cell; under the photo a
// fixed block of four rows: the title (two), who, and row 4, one line: how far, then at most one chip by deal › paused ›
// group lock › RECURRING. 📌 PINNED is on the photo's foot, with the status chip and the price. jsdom does no layout: the
// heights themselves are measured in e2e/market-grid-shots.mjs.
describe('MarketplaceCard grid tile on the lattice (G2)', () => {
    const tile = (el: HTMLElement) => el.querySelector('[data-testid="listing-grid-tile"]') as HTMLElement;

    it('fills its cell, and its text block is the fixed four-row block', () => {
        const { container, getByTestId } = render(<MarketplaceCard post={basePost} viewMode="grid" distanceKm={2.4} />);
        expect(tile(container).className.startsWith(gridTile())).toBe(true);
        expect(tile(container).className).toMatch(/(^|\s)h-full(\s|$)/);
        const block = getByTestId('grid-text-block');
        expect(block.className).toBe(GRID_TEXT);
        const rows = Array.from(block.children) as HTMLElement[];
        // Rows 1-2 the title (two reserved), row 3 who, row 4 the one line.
        expect(rows).toHaveLength(3);
        expect(rows[0].tagName).toBe('H3');
        expect(rows[0].className.startsWith(GRID_TITLE)).toBe(true);
        expect(rows[1].className).toBe(GRID_ROW);
        expect(rows[2].className).toBe(GRID_ROW);
        expect(rows[2].getAttribute('data-testid')).toBe('grid-row-4');
        expect(rows[2].textContent).toBe('📍2.4 km');
    });

    it('row 4 holds how far and at most ONE chip, by deal › paused › group lock › RECURRING', () => {
        const row4 = (props: Partial<React.ComponentProps<typeof MarketplaceCard>>, extra: Record<string, unknown> = {}) => {
            const { getByTestId, unmount } = render(<MarketplaceCard post={{ ...basePost, ...extra } as MarketplacePost} viewMode="grid" distanceKm={3} {...props} />);
            const row = getByTestId('grid-row-4');
            const out = { text: row.textContent, chips: Array.from(row.children).length - 1, last: row.lastElementChild as HTMLElement };
            unmount();
            return out;
        };
        const everything = { repeatable: true, status: 'paused', audienceScope: 'group', targetGroupName: 'Gardeners' };
        const deal = row4({ dealChip: 'in-trust' }, everything);
        expect(deal.text).toBe('📍3.0 km🤝 IN TRUST');
        expect(deal.chips).toBe(1);
        expect(deal.last.getAttribute('data-testid')).toBe('card-deal-chip');
        expect(deal.last.className).toBe(gridChip('ok'));
        expect(row4({}, everything).text).toBe('📍3.0 km⏸ PAUSED');
        expect(row4({}, { ...everything, status: 'active' }).text).toBe('📍3.0 km🔒 Only Gardeners can see this');
        const recurring = row4({}, { repeatable: true });
        expect(recurring.text).toBe('📍3.0 km↻ RECURRING');
        expect(recurring.last.className).toBe(gridChip('quiet'));
        // Nothing to say: the row is there, blank, so the block keeps its four rows.
        expect(row4({ distanceKm: null }).text).toBe('');
    });

    it('📌 PINNED is a scrim pill on the photo\'s foot, after the status chip, before the price; not under the photo', () => {
        const pinned = {
            ...basePost, pinnedAt: new Date().toISOString(), pinnedUntil: new Date(Date.now() + 86_400_000).toISOString(),
        } as unknown as MarketplacePost;
        const { getByTestId } = render(<MarketplaceCard post={pinned} viewMode="grid" isOwnPost />);
        const foot = getByTestId('grid-badge-row');
        const chipEl = getByTestId('card-pinned-chip');
        expect(chipEl.parentElement).toBe(foot);
        expect(chipEl.className).toBe(GRID_SCRIM_PILL);
        expect(Array.from(foot.children).map(c => c.textContent)).toEqual(['👤 YOU', '📌 PINNED', '10']);
        expect(getByTestId('grid-text-block').textContent).not.toContain('PINNED');
    });

});

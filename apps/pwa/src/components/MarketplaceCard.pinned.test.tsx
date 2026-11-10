import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarketplaceCard } from './MarketplaceCard';

describe('MarketplaceCard pinned chip', () => {
    const futureDate = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    const pastDate = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

    const basePost: any = {
        id: 'post-1',
        title: 'Homemade Jam',
        type: 'offer',
        category: 'food',
        price_c: 300,
        priceType: 'fixed',
        status: 'active',
        active: true,
        authorCallsign: 'Alice',
        authorPublicKey: 'alice-key',
        createdAt: '2026-11-01T00:00:00Z',
    };

    it('renders 📌 PINNED chip when post is live pinned in list view', () => {
        const post = { ...basePost, pinnedUntil: futureDate, pinnedAt: '2026-11-01T00:00:00Z' };
        render(<MarketplaceCard post={post} viewMode="list" />);
        const chip = screen.getByTestId('card-pinned-chip');
        expect(chip).toBeInTheDocument();
        expect(chip).toHaveTextContent('📌 PINNED');
    });

    it('renders 📌 PINNED chip in compact view', () => {
        const post = { ...basePost, pinnedUntil: futureDate, pinnedAt: '2026-11-01T00:00:00Z' };
        render(<MarketplaceCard post={post} viewMode="compact" />);
        const chip = screen.getByTestId('card-pinned-chip');
        expect(chip).toBeInTheDocument();
        expect(chip).toHaveTextContent('📌 PINNED');
    });

    it('renders 📌 PINNED chip in grid view', () => {
        const post = { ...basePost, pinnedUntil: futureDate, pinnedAt: '2026-11-01T00:00:00Z' };
        render(<MarketplaceCard post={post} viewMode="grid" />);
        const chip = screen.getByTestId('card-pinned-chip');
        expect(chip).toBeInTheDocument();
        expect(chip).toHaveTextContent('📌 PINNED');
        // G2 (DESIGN-market-grid-sizes-fable.md §2.1, §2.2): on the photo's foot, as the phone draws it, not a row under the
        // photo (that row made a pinned tile 30 px taller than its neighbour).
        expect(chip.parentElement).toBe(screen.getByTestId('grid-badge-row'));
    });

    it('does NOT render 📌 PINNED chip when pin has expired', () => {
        const post = { ...basePost, pinnedUntil: pastDate, pinnedAt: '2026-10-25T00:00:00Z' };
        render(<MarketplaceCard post={post} viewMode="list" />);
        expect(screen.queryByTestId('card-pinned-chip')).not.toBeInTheDocument();
    });

    it('does NOT render 📌 PINNED chip when post is paused', () => {
        const post = { ...basePost, status: 'paused', active: false, pinnedUntil: futureDate };
        render(<MarketplaceCard post={post} viewMode="list" />);
        expect(screen.queryByTestId('card-pinned-chip')).not.toBeInTheDocument();
    });
});

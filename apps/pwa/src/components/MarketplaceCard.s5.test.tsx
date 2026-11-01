import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarketplaceCard } from './MarketplaceCard';
import type { MarketplacePost } from '../lib/marketplace';

const basePost: MarketplacePost = {
    id: 'post-s5-1',
    type: 'offer',
    category: 'food',
    title: 'Fresh organic sourdough bread baked daily for the whole neighbourhood',
    description: 'Crispy crust and soft inside.',
    credits: 10,
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

    it('Daily Pulse grid card keeps its look with description and DAILY PULSE button', () => {
        const pulsePost = {
            ...basePost,
            authorCallsign: 'Daily Pulse',
            id: 'daily-pulse',
            title: 'Daily Pulse 27 Oct',
            description: 'Today in the community',
        } as unknown as MarketplacePost;
        render(<MarketplaceCard post={pulsePost} viewMode="grid" />);

        expect(screen.getByText('DAILY PULSE')).toBeInTheDocument();
        expect(screen.getByText('Today in the community')).toBeInTheDocument();
    });

    it('title clamps to two lines in grid mode', () => {
        render(<MarketplaceCard post={basePost} viewMode="grid" />);
        const titleEl = screen.getByText(basePost.title);
        expect(titleEl.className).toContain('line-clamp-2');
    });

    it('list thumb is 80 px (w-20 h-20)', () => {
        const { container } = render(<MarketplaceCard post={basePost} viewMode="list" />);
        // The thumbnail container in list mode
        const thumbContainer = container.querySelector('.w-20.h-20');
        expect(thumbContainer).not.toBeNull();
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

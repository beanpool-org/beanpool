import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { VisitorCard, VisitorPostDetail } from './VisitorListing';
import type { MarketplacePost } from '../lib/api';

const postWithoutPhoto: MarketplacePost = {
    id: 'p-1',
    type: 'offer',
    category: 'food',
    title: 'Duck eggs',
    description: 'Fresh from the farm',
    credits: 4,
    priceType: 'fixed',
    authorPublicKey: 'a'.repeat(64),
    authorCallsign: 'Farmer',
    createdAt: '2026-10-01T00:00:00.000Z',
    active: true,
    status: 'active',
    photos: [],
} as unknown as MarketplacePost;

describe('VisitorListing category tile', () => {
    it('VisitorCard with no photo renders CategoryTile', () => {
        render(<VisitorCard post={postWithoutPhoto} beans={true} distanceKm={5} onOpen={vi.fn()} />);
        const card = screen.getByTestId('visitor-card');
        expect(within(card).getByTestId('category-tile')).toBeInTheDocument();
    });

    it('VisitorPostDetail with no photo renders banner CategoryTile above title', () => {
        render(<VisitorPostDetail post={postWithoutPhoto} beans={true} distanceKm={5} onBack={vi.fn()} onJoin={vi.fn()} />);
        const detail = screen.getByTestId('visitor-detail');
        expect(within(detail).getByTestId('category-tile')).toBeInTheDocument();
    });

    it('VisitorPostDetail uses full width on narrow screens and caps at readable max-w-3xl on wide screens', () => {
        render(<VisitorPostDetail post={postWithoutPhoto} beans={true} distanceKm={5} onBack={vi.fn()} onJoin={vi.fn()} />);
        const detail = screen.getByTestId('visitor-detail');
        const classes = detail.className.split(/\s+/);
        expect(classes).toContain('w-full');
        expect(classes).toContain('max-w-3xl');
        expect(classes).toContain('mx-auto');
    });

    it('VisitorPostDetail with photos uses responsive two-column grid on wide screens', () => {
        const postWithPhoto = { ...postWithoutPhoto, photos: ['/photo1.jpg'] };
        render(<VisitorPostDetail post={postWithPhoto} beans={true} distanceKm={5} onBack={vi.fn()} onJoin={vi.fn()} />);
        const photosEl = screen.getByTestId('visitor-detail-photos');
        const container = photosEl.parentElement as HTMLElement;
        const classes = container.className.split(/\s+/);
        expect(classes).toContain('md:grid');
        expect(classes).toContain('md:grid-cols-2');
    });

    it('VisitorPostDetail keeps the phone order: title, photos, then the words, and the DOM says the same', () => {
        const postWithPhoto = { ...postWithoutPhoto, photos: ['/photo1.jpg'] };
        render(<VisitorPostDetail post={postWithPhoto} beans={true} distanceKm={5} onBack={vi.fn()} onJoin={vi.fn()} />);
        const title = screen.getByRole('heading', { name: 'Duck eggs' });
        const photosEl = screen.getByTestId('visitor-detail-photos');
        const words = screen.getByText('Fresh from the farm');
        expect(title.compareDocumentPosition(photosEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(photosEl.compareDocumentPosition(words) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // order-* would move them on screen and leave the DOM behind: a screen reader then reads another order.
        expect(screen.getByTestId('visitor-detail').innerHTML).not.toMatch(/\border-\d/);
    });

    it('VisitorPostDetail leaves the photo column at its full height on wide screens, with no inner scroll', () => {
        const postWithPhoto = { ...postWithoutPhoto, photos: ['/photo1.jpg', '/photo2.jpg'] };
        render(<VisitorPostDetail post={postWithPhoto} beans={true} distanceKm={5} onBack={vi.fn()} onJoin={vi.fn()} />);
        const classes = screen.getByTestId('visitor-detail-photos').className.split(/\s+/);
        expect(classes).toContain('md:overflow-visible');
        expect(classes).not.toContain('md:overflow-y-auto');
    });
});

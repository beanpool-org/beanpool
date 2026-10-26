import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { VisitorCard, VisitorPostDetail } from './VisitorListing';
import type { MarketplacePost } from '../lib/marketplace';

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
});

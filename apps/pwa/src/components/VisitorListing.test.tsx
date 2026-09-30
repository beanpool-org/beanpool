import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { VisitorCard, VisitorPostDetail } from './VisitorListing';
import type { MarketplacePost } from '../lib/api';

const dummyPost: MarketplacePost = {
    id: 'post-1',
    authorPublicKey: 'pk-1',
    authorCallsign: 'Baker',
    type: 'offer',
    title: 'Fresh Sourdough Loaf',
    description: 'Baked this morning with organic flour.',
    category: 'food',
    credits: 5,
    priceType: 'fixed',
    active: true,
    status: 'active',
    repeatable: false,
    photos: ['https://example.com/photo.jpg'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
};

describe('VisitorListing Component Accessibility & Focus Rings', () => {
    describe('VisitorCard', () => {
        it('renders with focus-visible ring classes and correct aria-label', () => {
            const onOpen = vi.fn();
            render(<VisitorCard post={dummyPost} beans={true} distanceKm={2} onOpen={onOpen} />);

            const cardButton = screen.getByTestId('visitor-card');
            expect(cardButton).toHaveClass('focus-visible:ring-2');
            expect(cardButton).toHaveClass('focus-visible:ring-nature-500');
            expect(cardButton).toHaveAttribute('aria-label');

            fireEvent.click(cardButton);
            expect(onOpen).toHaveBeenCalledTimes(1);
        });
    });

    describe('VisitorPostDetail', () => {
        it('renders back and join buttons with focus-visible ring classes and triggers handlers', () => {
            const onBack = vi.fn();
            const onJoin = vi.fn();

            render(
                <VisitorPostDetail
                    post={dummyPost}
                    beans={true}
                    distanceKm={2}
                    onBack={onBack}
                    onJoin={onJoin}
                />
            );

            const backButton = screen.getByRole('button', { name: /back to market/i });
            expect(backButton).toHaveClass('focus-visible:ring-2');
            expect(backButton).toHaveClass('focus-visible:ring-nature-500');

            fireEvent.click(backButton);
            expect(onBack).toHaveBeenCalledTimes(1);

            const joinButton = screen.getByTestId('visitor-join');
            expect(joinButton).toHaveClass('focus-visible:ring-2');
            expect(joinButton).toHaveClass('focus-visible:ring-blue-500');

            fireEvent.click(joinButton);
            expect(onJoin).toHaveBeenCalledTimes(1);
        });
    });
});

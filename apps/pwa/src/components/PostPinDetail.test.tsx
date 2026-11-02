import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PostPinDetail } from './PostPinDetail';
import type { MarketplacePost } from '../lib/api';
import * as api from '../lib/api';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        unpinMarketplacePost: vi.fn(),
        pinMarketplacePost: vi.fn(),
    };
});

describe('PostPinDetail', () => {
    const now = Date.now();
    const futureDate = new Date(now + 3 * 86_400_000).toISOString();
    const pastDate = new Date(now - 86_400_000).toISOString();

    const authorIdentity = {
        publicKey: 'author-key-123',
        secretKey: 'sec',
    };

    const adminIdentity = {
        publicKey: 'admin-key-456',
        secretKey: 'sec',
    };

    const regularIdentity = {
        publicKey: 'regular-key-789',
        secretKey: 'sec',
    };

    const pinnedPost: MarketplacePost = {
        id: 'post-1',
        type: 'offer',
        category: 'goods',
        repeatable: false,
        title: 'Sourdough starter',
        description: 'Active culture',
        credits: 5,
        priceType: 'fixed',
        status: 'active',
        active: true,
        authorPublicKey: 'author-key-123',
        authorCallsign: 'Baker',
        createdAt: new Date(now - 10000).toISOString(),
        updatedAt: new Date(now - 10000).toISOString(),
        pinnedUntil: futureDate,
        pinnedAt: new Date(now - 5000).toISOString(),
    };

    const unpinnedPost: MarketplacePost = {
        ...pinnedPost,
        id: 'post-2',
        pinnedUntil: null,
        pinnedAt: null,
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders the community pin banner on a live pinned post', () => {
        render(
            <PostPinDetail
                post={pinnedPost}
                identity={regularIdentity as any}
                isOwnerOrAdmin={false}
                featuresPins={true}
                onPostUpdated={vi.fn()}
            />
        );

        expect(screen.getByTestId('post-pinned-detail-banner')).toBeInTheDocument();
        expect(screen.getByTestId('post-pinned-detail-line')).toHaveTextContent(/Pinned by your community/);
    });

    it('does NOT render pin banner when post has no pin or pin has expired', () => {
        const expiredPost = { ...pinnedPost, pinnedUntil: pastDate };
        render(
            <PostPinDetail
                post={expiredPost}
                identity={regularIdentity as any}
                isOwnerOrAdmin={false}
                featuresPins={true}
                onPostUpdated={vi.fn()}
            />
        );

        expect(screen.queryByTestId('post-pinned-detail-banner')).not.toBeInTheDocument();
    });

    it('shows Take the pin off to the author of the post', async () => {
        const onPostUpdated = vi.fn();
        vi.mocked(api.unpinMarketplacePost).mockResolvedValueOnce({ success: true } as any);

        render(
            <PostPinDetail
                post={pinnedPost}
                identity={authorIdentity as any}
                isOwnerOrAdmin={false}
                featuresPins={true}
                onPostUpdated={onPostUpdated}
            />
        );

        const takeOffBtn = screen.getByTestId('take-pin-off-inline-btn');
        expect(takeOffBtn).toBeInTheDocument();

        fireEvent.click(takeOffBtn);

        await waitFor(() => {
            expect(api.unpinMarketplacePost).toHaveBeenCalledWith('post-1');
            expect(onPostUpdated).toHaveBeenCalledWith(expect.objectContaining({
                id: 'post-1',
                pinnedUntil: null,
                pinnedAt: null,
            }));
        });
    });

    it('shows Take the pin off to an owner/admin', () => {
        render(
            <PostPinDetail
                post={pinnedPost}
                identity={adminIdentity as any}
                isOwnerOrAdmin={true}
                featuresPins={true}
                onPostUpdated={vi.fn()}
            />
        );

        expect(screen.getByTestId('take-pin-off-inline-btn')).toBeInTheDocument();
    });

    it('does NOT show Take the pin off or Options menu to a regular member who is not author', () => {
        render(
            <PostPinDetail
                post={pinnedPost}
                identity={regularIdentity as any}
                isOwnerOrAdmin={false}
                featuresPins={true}
                onPostUpdated={vi.fn()}
            />
        );

        expect(screen.queryByTestId('take-pin-off-inline-btn')).not.toBeInTheDocument();
        expect(screen.queryByTestId('post-menu-trigger')).not.toBeInTheDocument();
    });

    it('never offers Pin to the top if features.pins is false (node refusal gate)', () => {
        render(
            <PostPinDetail
                post={unpinnedPost}
                identity={adminIdentity as any}
                isOwnerOrAdmin={true}
                featuresPins={false}
                onPostUpdated={vi.fn()}
            />
        );

        // Can not pin because featuresPins is false
        expect(screen.queryByTestId('post-menu-trigger')).not.toBeInTheDocument();
    });

    it('offers Pin to the top in Options menu for admin when features.pins is true', async () => {
        render(
            <PostPinDetail
                post={unpinnedPost}
                identity={adminIdentity as any}
                isOwnerOrAdmin={true}
                featuresPins={true}
                onPostUpdated={vi.fn()}
            />
        );

        const menuTrigger = screen.getByTestId('post-menu-trigger');
        expect(menuTrigger).toBeInTheDocument();

        fireEvent.click(menuTrigger);
        expect(screen.getByTestId('menu-pin-post')).toHaveTextContent(/Pin to the top/);
    });

    it('closes menu on Escape key and restores focus', () => {
        render(
            <PostPinDetail
                post={unpinnedPost}
                identity={adminIdentity as any}
                isOwnerOrAdmin={true}
                featuresPins={true}
                onPostUpdated={vi.fn()}
            />
        );

        const menuTrigger = screen.getByTestId('post-menu-trigger');
        fireEvent.click(menuTrigger);
        expect(screen.getByTestId('post-actions-menu')).toBeInTheDocument();

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByTestId('post-actions-menu')).not.toBeInTheDocument();
    });
});

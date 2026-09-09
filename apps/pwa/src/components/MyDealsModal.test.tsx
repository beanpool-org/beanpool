import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MyDealsModal } from './MyDealsModal';

describe('MyDealsModal Component & Keyboard Accessibility', () => {
    const mockIdentity = { publicKey: 'user-pubkey-123' };

    const mockPosts = [
        {
            id: 'post-1',
            title: 'Organic Sourdough Bread',
            description: 'Freshly baked sourdough loaf',
            category: 'food',
            type: 'offer' as const,
            credits: 15,
            priceType: 'fixed' as const,
            photos: ['/api/marketplace/posts/post-1/photos/0'],
            authorPublicKey: 'user-pubkey-123',
            authorCallsign: 'baker-alice',
            status: 'active' as const,
            active: true,
            repeatable: false,
            createdAt: new Date().toISOString(),
        },
    ];

    const mockTransactions = [
        {
            id: 'tx-1',
            postId: 'post-2',
            postTitle: 'Heirloom Tomato Seeds',
            buyerPublicKey: 'user-pubkey-123',
            buyerCallsign: 'gardener-bob',
            sellerPublicKey: 'seller-pubkey-456',
            sellerCallsign: 'seed-keeper',
            credits: 10,
            status: 'pending',
            createdAt: new Date().toISOString(),
            coverImage: '/api/marketplace/posts/post-2/photos/0',
        },
    ];

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('does not render when visible is false or identity is null', () => {
        const { rerender } = render(
            <MyDealsModal
                visible={false}
                identity={mockIdentity}
                onClose={vi.fn()}
                posts={mockPosts}
                transactions={mockTransactions}
            />
        );
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

        rerender(
            <MyDealsModal
                visible={true}
                identity={null}
                onClose={vi.fn()}
                posts={mockPosts}
                transactions={mockTransactions}
            />
        );
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('renders with role="dialog", aria-modal="true", and accessible title', () => {
        render(
            <MyDealsModal
                visible={true}
                identity={mockIdentity}
                onClose={vi.fn()}
                posts={mockPosts}
                transactions={mockTransactions}
            />
        );
        const dialog = screen.getByRole('dialog', { name: 'My Deals' });
        expect(dialog).toBeInTheDocument();
        expect(dialog).toHaveAttribute('aria-modal', 'true');
    });

    it('opens lightbox on Enter/Space on active post photo and prevents card navigation', () => {
        const onNavigate = vi.fn();
        const onClose = vi.fn();

        render(
            <MyDealsModal
                visible={true}
                identity={mockIdentity}
                initialTab="active"
                onClose={onClose}
                onNavigateToPost={onNavigate}
                posts={mockPosts}
                transactions={mockTransactions}
            />
        );

        const photoBtn = screen.getByRole('button', { name: 'View enlarged photo: Organic Sourdough Bread' });
        expect(photoBtn).toBeInTheDocument();

        // Pressing Enter on the photo button
        fireEvent.keyDown(photoBtn, { key: 'Enter' });

        // Lightbox should open
        expect(screen.getByRole('dialog', { name: 'Photo viewer: Organic Sourdough Bread' })).toBeInTheDocument();

        // Card navigation and modal close must NOT have been triggered
        expect(onNavigate).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it('opens lightbox on Enter/Space on pending transaction photo and prevents card navigation', () => {
        const onNavigate = vi.fn();
        const onClose = vi.fn();

        render(
            <MyDealsModal
                visible={true}
                identity={mockIdentity}
                initialTab="pending"
                onClose={onClose}
                onNavigateToPost={onNavigate}
                posts={mockPosts}
                transactions={mockTransactions}
            />
        );

        const photoBtn = screen.getByRole('button', { name: 'View enlarged photo: Heirloom Tomato Seeds' });
        expect(photoBtn).toBeInTheDocument();

        // Pressing Space on the photo button
        fireEvent.keyDown(photoBtn, { key: ' ' });

        // Lightbox should open
        expect(screen.getByRole('dialog', { name: 'Photo viewer: Heirloom Tomato Seeds' })).toBeInTheDocument();

        // Deal navigation and modal close must NOT have been triggered
        expect(onNavigate).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it('unambiguous Escape handling: first Escape closes lightbox, second Escape closes deals modal', () => {
        const onClose = vi.fn();

        render(
            <MyDealsModal
                visible={true}
                identity={mockIdentity}
                initialTab="active"
                onClose={onClose}
                posts={mockPosts}
                transactions={mockTransactions}
            />
        );

        const photoBtn = screen.getByRole('button', { name: 'View enlarged photo: Organic Sourdough Bread' });
        fireEvent.click(photoBtn);

        // Lightbox is now open
        expect(screen.getByRole('dialog', { name: 'Photo viewer: Organic Sourdough Bread' })).toBeInTheDocument();

        // First Escape: closes the photo viewer
        fireEvent.keyDown(window, { key: 'Escape' });

        // Lightbox dialog should now be gone
        expect(screen.queryByRole('dialog', { name: 'Photo viewer: Organic Sourdough Bread' })).not.toBeInTheDocument();

        // But MyDealsModal must STILL be open! onClose was NOT called yet!
        expect(screen.getByRole('dialog', { name: 'My Deals' })).toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();

        // Second Escape: closes MyDealsModal
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('clicking lightbox backdrop closes lightbox but does NOT close MyDealsModal', () => {
        const onClose = vi.fn();

        render(
            <MyDealsModal
                visible={true}
                identity={mockIdentity}
                initialTab="active"
                onClose={onClose}
                posts={mockPosts}
                transactions={mockTransactions}
            />
        );

        const photoBtn = screen.getByRole('button', { name: 'View enlarged photo: Organic Sourdough Bread' });
        fireEvent.click(photoBtn);

        const lightboxDialog = screen.getByRole('dialog', { name: 'Photo viewer: Organic Sourdough Bread' });
        expect(lightboxDialog).toBeInTheDocument();

        // Click backdrop of the lightbox
        fireEvent.click(lightboxDialog);

        // Lightbox closes
        expect(screen.queryByRole('dialog', { name: 'Photo viewer: Organic Sourdough Bread' })).not.toBeInTheDocument();

        // My Deals modal is still open, onClose not called
        expect(screen.getByRole('dialog', { name: 'My Deals' })).toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();
    });

    it('traps focus within MyDealsModal when open and restores focus when closed', () => {
        const triggerBtn = document.createElement('button');
        triggerBtn.textContent = 'Open Deals';
        document.body.appendChild(triggerBtn);
        triggerBtn.focus();

        const { unmount } = render(
            <MyDealsModal
                visible={true}
                identity={mockIdentity}
                initialTab="active"
                onClose={vi.fn()}
                posts={mockPosts}
                transactions={mockTransactions}
            />
        );

        const closeBtn = screen.getByRole('button', { name: 'Close My Deals' });
        const allButtons = screen.getAllByRole('button');
        const lastBtn = allButtons[allButtons.length - 1];

        // Shift+Tab from closeBtn wraps to last focusable element
        closeBtn.focus();
        fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(lastBtn);

        // Tab from lastBtn wraps back to first element (closeBtn)
        lastBtn.focus();
        fireEvent.keyDown(window, { key: 'Tab', shiftKey: false });
        expect(document.activeElement).toBe(closeBtn);

        unmount();
        // Focus restored to trigger
        expect(document.activeElement).toBe(triggerBtn);
        document.body.removeChild(triggerBtn);
    });
});

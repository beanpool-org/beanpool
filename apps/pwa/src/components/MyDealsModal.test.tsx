import React from 'react';
import { render, screen, fireEvent, createEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MyDealsModal } from './MyDealsModal';
import type { MarketplaceTransaction } from '../lib/api';

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
            status: 'pending' as const,
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

    describe('preview mode', () => {
        it('renders the sample deals and the strip when preview is true, even without passed posts/transactions', () => {
            render(
                <MyDealsModal
                    visible={true}
                    identity={mockIdentity}
                    preview={true}
                    onClose={vi.fn()}
                />
            );

            expect(screen.getByRole('dialog', { name: 'My Deals' })).toBeInTheDocument();
            expect(screen.getByTestId('deals-preview-head')).toBeInTheDocument();
            expect(screen.getByTestId('sample-deal-sample-deal-shelves')).toBeInTheDocument();
            expect(screen.getByTestId('sample-deal-sample-deal-bike')).toBeInTheDocument();
        });

        it('opens the local community sheet when a deal card is clicked in preview', async () => {
            render(
                <MyDealsModal
                    visible={true}
                    identity={mockIdentity}
                    preview={true}
                    onClose={vi.fn()}
                />
            );

            const card = screen.getByTestId('sample-deal-sample-deal-shelves');
            fireEvent.click(card);

            expect(await screen.findByTestId('local-community-sheet')).toBeInTheDocument();
            fireEvent.click(screen.getByRole('button', { name: 'Close' }));
            expect(screen.queryByTestId('local-community-sheet')).not.toBeInTheDocument();
        });

        it('local mode (preview=false) remains unchanged and does not render the preview head', () => {
            render(
                <MyDealsModal
                    visible={true}
                    identity={mockIdentity}
                    preview={false}
                    onClose={vi.fn()}
                    posts={mockPosts}
                    transactions={mockTransactions}
                />
            );

            expect(screen.getByRole('dialog', { name: 'My Deals' })).toBeInTheDocument();
            expect(screen.queryByTestId('deals-preview-head')).not.toBeInTheDocument();
            expect(screen.getByTestId('deal-card-tx-1')).toBeInTheDocument();
        });

        it('local mode pins base tab contents, badge 4, raw status chip words and colours', () => {
            const ana = { publicKey: 'pubkey-ana' };
            const kofi = { publicKey: 'pubkey-kofi' };
            const mere = { publicKey: 'pubkey-mere' };
            const tama = { publicKey: 'pubkey-tama' };

            const seededPosts = [
                { id: 'p-couch', type: 'need' as const, title: 'Help moving a couch', authorPublicKey: ana.publicKey, authorCallsign: 'Ana', status: 'active' as const, credits: 30, photos: [], createdAt: '2026-10-10T00:00:00Z', category: 'services', description: '', priceType: 'fixed' as const, active: true, repeatable: false },
                { id: 'p-bike', type: 'offer' as const, title: 'Bike tune-up', authorPublicKey: kofi.publicKey, authorCallsign: 'Kofi', status: 'pending' as const, acceptedBy: ana.publicKey, credits: 20, photos: [], createdAt: '2026-10-10T00:00:00Z', category: 'services', description: '', priceType: 'fixed' as const, active: true, repeatable: false },
                { id: 'p-mend', type: 'offer' as const, title: 'Mending jackets', authorPublicKey: ana.publicKey, authorCallsign: 'Ana', status: 'active' as const, credits: 15, photos: [], createdAt: '2026-10-10T00:00:00Z', category: 'services', description: '', priceType: 'fixed' as const, active: true, repeatable: true },
                { id: 'p-weed', type: 'need' as const, title: 'Weed the veggie patch', authorPublicKey: tama.publicKey, authorCallsign: 'Tama', status: 'pending' as const, acceptedBy: ana.publicKey, credits: 10, photos: [], createdAt: '2026-10-10T00:00:00Z', category: 'services', description: '', priceType: 'fixed' as const, active: true, repeatable: false },
                { id: 'p-bread', type: 'offer' as const, title: 'Rye bread', authorPublicKey: mere.publicKey, authorCallsign: 'Mere', status: 'active' as const, credits: 8, photos: [], createdAt: '2026-10-10T00:00:00Z', category: 'services', description: '', priceType: 'fixed' as const, active: true, repeatable: false },
            ];

            const seededTransactions: MarketplaceTransaction[] = [
                { id: 'tx-requested-mine', postId: 'p-couch', postTitle: 'Help moving a couch', buyerPublicKey: ana.publicKey, buyerCallsign: 'Ana', sellerPublicKey: kofi.publicKey, sellerCallsign: 'Kofi', credits: 30, status: 'requested', createdAt: '2026-10-16T00:00:00Z' },
                { id: 'tx-pending-buy', postId: 'p-bike', postTitle: 'Bike tune-up', buyerPublicKey: ana.publicKey, buyerCallsign: 'Ana', sellerPublicKey: kofi.publicKey, sellerCallsign: 'Kofi', credits: 20, status: 'pending', createdAt: '2026-10-15T00:00:00Z' },
                { id: 'tx-completed-sold', postId: 'p-mend', postTitle: 'Mending jackets', buyerPublicKey: mere.publicKey, buyerCallsign: 'Mere', sellerPublicKey: ana.publicKey, sellerCallsign: 'Ana', credits: 15, status: 'completed', createdAt: '2026-10-09T00:00:00Z' },
                { id: 'tx-requested-theirs', postId: 'p-mend', postTitle: 'Mending jackets', buyerPublicKey: mere.publicKey, buyerCallsign: 'Mere', sellerPublicKey: ana.publicKey, sellerCallsign: 'Ana', credits: 15, status: 'requested', createdAt: '2026-10-16T12:00:00Z' },
                { id: 'tx-pending-sell', postId: 'p-weed', postTitle: 'Weed the veggie patch', buyerPublicKey: tama.publicKey, buyerCallsign: 'Tama', sellerPublicKey: ana.publicKey, sellerCallsign: 'Ana', credits: 10, status: 'pending', createdAt: '2026-10-14T00:00:00Z' },
                { id: 'tx-cancelled', postId: 'p-bread', postTitle: 'Rye bread', buyerPublicKey: ana.publicKey, buyerCallsign: 'Ana', sellerPublicKey: mere.publicKey, sellerCallsign: 'Mere', credits: 8, status: 'cancelled', createdAt: '2026-10-11T00:00:00Z' },
                { id: 'tx-requested-asked', postId: 'p-bread', postTitle: 'Rye bread', buyerPublicKey: ana.publicKey, buyerCallsign: 'Ana', sellerPublicKey: mere.publicKey, sellerCallsign: 'Mere', credits: 8, status: 'requested', createdAt: '2026-10-16T18:00:00Z' },
            ];

            render(
                <MyDealsModal
                    visible={true}
                    identity={ana}
                    preview={false}
                    onClose={vi.fn()}
                    posts={seededPosts}
                    transactions={seededTransactions}
                />
            );

            // Badge for In Progress is 4 (2 pending posts + 2 pending txs)
            const inProgressTab = screen.getByRole('button', { name: /In Progress/ });
            expect(inProgressTab).toHaveTextContent('4');

            // In Progress shows exactly the 2 pending transactions: Bike tune-up and Weed the veggie patch
            expect(screen.getByText('Bike tune-up')).toBeInTheDocument();
            expect(screen.getByText('Weed the veggie patch')).toBeInTheDocument();
            // Requested deals do not show on In Progress
            expect(screen.queryByText('Help moving a couch')).not.toBeInTheDocument();

            // Status chip says raw "pending" (not Action Required or Held in Trust), in the warn colours
            const chips = screen.getAllByText('pending');
            expect(chips.length).toBe(2);
            for (const chip of chips) expect(chip).toHaveClass('bg-bp-chip-warn-tint', 'text-bp-chip-warn-ink');
            // The buyer's amount is red, the seller's emerald
            expect(screen.getByText('- 20')).toHaveClass('text-red-500', 'dark:text-red-300');
            expect(screen.getByText('+ 10')).toHaveClass('text-emerald-500', 'dark:text-emerald-400');

            // Partner line is present on In Progress with bold callsign
            expect(screen.getByText(/Bought from/)).toBeInTheDocument();
            expect(screen.getByText('Kofi')).toHaveClass('font-bold');
            expect(screen.getByText(/Sold to/)).toBeInTheDocument();
            expect(screen.getByText('Tama')).toHaveClass('font-bold');

            // Switch to My Posts tab
            fireEvent.click(screen.getByRole('button', { name: /My Posts/ }));
            // Shows active posts authored by Ana: Help moving a couch and Mending jackets
            expect(screen.getByText('Help moving a couch')).toBeInTheDocument();
            expect(screen.getByText('Mending jackets')).toBeInTheDocument();
            // Does NOT show Rye bread (Ana only requested it)
            expect(screen.queryByText('Rye bread')).not.toBeInTheDocument();
            // Shows 🟢 Active, never Action Required or Awaiting Approval
            expect(screen.getAllByText('🟢 Active')).toHaveLength(2);
            expect(screen.queryByText(/Action Required/)).not.toBeInTheDocument();
            expect(screen.queryByText(/Awaiting Approval/)).not.toBeInTheDocument();

            // Switch to History tab
            fireEvent.click(screen.getByRole('button', { name: /History/ }));
            // Completed and cancelled show in History
            expect(screen.getByText('Mending jackets')).toBeInTheDocument();
            expect(screen.getByText('Rye bread')).toBeInTheDocument();
            expect(screen.getByText('completed')).toHaveClass('bg-bp-chip-ok-tint', 'text-bp-chip-ok-ink');
            expect(screen.getByText('cancelled')).toHaveClass('bg-nature-200', 'text-nature-700');
            // A cancelled deal is greyed, as before the preview came
            expect(screen.getByText('cancelled').closest('[data-testid^="deal-card-"]')).toHaveClass('opacity-60', 'grayscale-[50%]');
            expect(screen.getByText('- 8')).toHaveClass('text-red-500');
            expect(screen.getByText('+ 15')).toHaveClass('text-emerald-500');
        });

        it('local mode, a member with nothing yet: each tab\'s empty state as before, My Posts\' "+ Create a Post" button too', () => {
            const onClose = vi.fn();
            render(<MyDealsModal visible identity={mockIdentity} onClose={onClose} posts={[]} transactions={[]} />);
            expect(screen.getByText('No deals in progress')).toBeInTheDocument();
            expect(screen.getByText('Accepted deals will appear here while they are held in trust.')).toBeInTheDocument();
            fireEvent.click(screen.getByRole('button', { name: /^My Posts/ }));
            expect(screen.getByText('No active posts')).toBeInTheDocument();
            const create = screen.getByRole('button', { name: '+ Create a Post' });
            expect(create.className).toBe('px-6 py-2.5 rounded-xl bg-indigo-600 text-white font-bold text-sm shadow-md hover:bg-indigo-700 transition-colors');
            fireEvent.click(screen.getByRole('button', { name: /^History/ }));
            expect(screen.getByText('No history yet')).toBeInTheDocument();
            expect(screen.getByText('Completed or cancelled deals will show up here.')).toBeInTheDocument();
        });

        it('local mode: Leave Review works from the keyboard (its card leaves the key alone); a pending card still opens its post', () => {
            const onPromptReview = vi.fn();
            const onNavigateToPost = vi.fn();
            const onClose = vi.fn();
            const done = { ...mockTransactions[0], id: 'tx-done', status: 'completed' as const, ratedByBuyer: false };
            render(
                <MyDealsModal visible identity={mockIdentity} onClose={onClose} posts={[]} transactions={[mockTransactions[0], done]}
                    initialTab="history" onPromptReview={onPromptReview} onNavigateToPost={onNavigateToPost} />
            );
            const leaveReview = screen.getByRole('button', { name: 'Leave Review' });
            for (const key of ['Enter', ' ']) {
                const ev = createEvent.keyDown(leaveReview, { key });
                fireEvent(leaveReview, ev);
                expect(ev.defaultPrevented, key).toBe(false);
            }
            fireEvent.click(leaveReview);
            expect(onPromptReview).toHaveBeenCalledWith({ txId: 'tx-done', targetPubkey: 'seller-pubkey-456', targetCallsign: 'seed-keeper', targetRole: 'provider' });

            fireEvent.click(screen.getByRole('button', { name: /^In Progress/ }));
            const pending = screen.getByRole('button', { name: 'View deal: Heirloom Tomato Seeds' });
            const ev = createEvent.keyDown(pending, { key: 'Enter' });
            fireEvent(pending, ev);
            expect(ev.defaultPrevented).toBe(true);
            expect(onNavigateToPost).toHaveBeenCalledWith('post-2', 'tx-1');
        });

        it('preview: a card tap leaves focus in its sheet, and closing the sheet gives focus back to the card', async () => {
            render(<MyDealsModal visible identity={mockIdentity} preview onClose={vi.fn()} />);
            await new Promise(r => setTimeout(r, 50));
            const card = screen.getByTestId('sample-deal-sample-deal-shelves');
            fireEvent.click(card);
            const sheet = await screen.findByTestId('local-community-sheet');
            await new Promise(r => setTimeout(r, 50));
            expect(sheet.contains(document.activeElement)).toBe(true);
            fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
            expect(document.activeElement).toBe(card);
        });

        it('preview: Escape on a marker\'s own sheet or Start screen closes only that; My Deals stays open', async () => {
            const onClose = vi.fn();
            render(<MyDealsModal visible identity={mockIdentity} preview onClose={onClose} />);
            const bike = screen.getByTestId('sample-deal-sample-deal-bike');
            fireEvent.click(within(bike).getByTestId('local-community-action'));
            expect(await screen.findByTestId('local-community-sheet')).toBeInTheDocument();
            fireEvent.keyDown(window, { key: 'Escape' });
            expect(screen.queryByTestId('local-community-sheet')).toBeNull();
            expect(onClose).not.toHaveBeenCalled();

            fireEvent.click(within(bike).getByTestId('local-community-action'));
            fireEvent.click(await screen.findByTestId('local-community-start'));
            expect(await screen.findByTestId('start-community-screen')).toBeInTheDocument();
            fireEvent.keyDown(window, { key: 'Escape' });
            expect(screen.queryByTestId('start-community-screen')).toBeNull();
            expect(onClose).not.toHaveBeenCalled();

            // With no sheet open, Escape closes My Deals as before
            fireEvent.keyDown(window, { key: 'Escape' });
            expect(onClose).toHaveBeenCalledTimes(1);
        });

        it('preview: Tab and Shift+Tab loop inside card sheet and marker sheet; Escape returns focus to card or marker', async () => {
            const onClose = vi.fn();
            render(<MyDealsModal visible identity={mockIdentity} preview onClose={onClose} />);
            await new Promise(r => setTimeout(r, 50));

            // 1. Card's sheet
            const shelvesCard = screen.getByTestId('sample-deal-sample-deal-shelves');
            fireEvent.click(shelvesCard);
            const cardSheet = await screen.findByTestId('local-community-sheet');
            expect(cardSheet).toBeInTheDocument();

            const cardButtons = Array.from(cardSheet.querySelectorAll<HTMLElement>('button:not([disabled])'));
            const cardFirst = cardButtons[0];
            const cardLast = cardButtons[cardButtons.length - 1];

            // Shift+Tab from first lands on last
            cardFirst.focus();
            fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
            expect(document.activeElement).toBe(cardLast);

            // Tab from last lands on first
            cardLast.focus();
            fireEvent.keyDown(document, { key: 'Tab', shiftKey: false });
            expect(document.activeElement).toBe(cardFirst);

            // Escape returns focus to the card
            fireEvent.keyDown(document, { key: 'Escape' });
            expect(screen.queryByTestId('local-community-sheet')).toBeNull();
            expect(document.activeElement).toBe(shelvesCard);

            // 2. Marker's sheet (inside a card)
            const bike = screen.getByTestId('sample-deal-sample-deal-bike');
            const marker = within(bike).getByTestId('local-community-action');
            marker.focus();
            fireEvent.click(marker);

            const markerSheet = await screen.findByTestId('local-community-sheet');
            expect(markerSheet).toBeInTheDocument();

            const markerButtons = Array.from(markerSheet.querySelectorAll<HTMLElement>('button:not([disabled])'));
            const markerFirst = markerButtons[0];
            const markerLast = markerButtons[markerButtons.length - 1];

            // Shift+Tab from first lands on last
            markerFirst.focus();
            fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
            expect(document.activeElement).toBe(markerLast);

            // Tab from last lands on first
            markerLast.focus();
            fireEvent.keyDown(document, { key: 'Tab', shiftKey: false });
            expect(document.activeElement).toBe(markerFirst);

            // Escape returns focus to the marker
            fireEvent.keyDown(document, { key: 'Escape' });
            expect(screen.queryByTestId('local-community-sheet')).toBeNull();
            expect(document.activeElement).toBe(marker);
        });

        it('preview: keys on a marker, or inside its sheet, are that button\'s, never swallowed by the card', async () => {
            render(<MyDealsModal visible identity={mockIdentity} preview onClose={vi.fn()} />);
            const bike = screen.getByTestId('sample-deal-sample-deal-bike');
            const action = within(bike).getByTestId('local-community-action');
            for (const key of ['Enter', ' ']) {
                const ev = createEvent.keyDown(action, { key });
                fireEvent(action, ev);
                expect(ev.defaultPrevented, key).toBe(false);
                expect(screen.queryByTestId('local-community-sheet'), key).toBeNull();
            }
            fireEvent.click(action);
            const start = await screen.findByTestId('local-community-start');
            const ev = createEvent.keyDown(start, { key: 'Enter' });
            fireEvent(start, ev);
            expect(ev.defaultPrevented).toBe(false);
            expect(screen.getAllByTestId('local-community-sheet')).toHaveLength(1);
            // The card itself still opens its sheet from the keyboard
            fireEvent.click(within(screen.getByTestId('local-community-sheet')).getByRole('button', { name: 'Close' }));
            const cardEv = createEvent.keyDown(bike, { key: 'Enter' });
            fireEvent(bike, cardEv);
            expect(cardEv.defaultPrevented).toBe(true);
            expect(await screen.findByTestId('local-community-sheet')).toBeInTheDocument();
        });
    });
});


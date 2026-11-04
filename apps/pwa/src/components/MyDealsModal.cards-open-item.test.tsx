/**
 * Your deals: a row's photo is part of the row (Marty, 4 Nov 2026: "regardless of whether you click on the image or the
 * description it should bring up the card that you can then click on to get a larger image - address this across all cards").
 *
 * A press anywhere on a row, the photo included, does what a press on the row does: it opens the deal (In Progress), the
 * post (My Posts), or, in the preview, the local-community sheet. The row is the one accessible element and reads out as the
 * deal; there is no "View enlarged photo" button and no photo viewer from Your deals. The enlarge lives on the post's own
 * page (MarketplacePage: "View enlarged photo {n} of {total}"), where the row takes the member.
 *
 * Same pattern as MarketplacePage.cards-open-item.test.tsx (#2839).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import type { MarketplacePost, MarketplaceTransaction } from '../lib/api';

// The sample deals carry no photos; the preview's photo boxes are reached by giving them one.
vi.mock('./ShowcasePreviews', async (importOriginal) => {
    const real = await importOriginal<typeof import('./ShowcasePreviews')>();
    return {
        ...real,
        sampleDeals: (now?: number) => {
            const sample = real.sampleDeals(now);
            return {
                ...sample,
                posts: sample.posts.map(p => ({ ...p, photos: [`/api/marketplace/posts/${p.id}/photos/0`] })),
                transactions: sample.transactions.map(x => ({ ...x, coverImage: `/api/marketplace/posts/${x.postId}/photos/0` })),
            };
        },
    };
});

import { MyDealsModal } from './MyDealsModal';
import { SAMPLE_DEALS_ME, sampleDeals } from './ShowcasePreviews';

const ME = 'user-pubkey-123';
const identity = { publicKey: ME };

const POSTS: MarketplacePost[] = [{
    id: 'post-1', title: 'Organic Sourdough Bread', description: '', category: 'food', type: 'offer', credits: 15, priceType: 'fixed',
    photos: ['/api/marketplace/posts/post-1/photos/0', '/api/marketplace/posts/post-1/photos/1'], authorPublicKey: ME, authorCallsign: 'baker-alice',
    status: 'active', active: true, repeatable: false, createdAt: '2026-10-10T00:00:00Z',
}];
const heldDeal = {
    id: 'tx-held', postId: 'post-2', postTitle: 'Heirloom Tomato Seeds', buyerPublicKey: ME, buyerCallsign: 'gardener-bob',
    sellerPublicKey: 'seller-pubkey-456', sellerCallsign: 'seed-keeper', credits: 10, status: 'pending', createdAt: '2026-10-15T12:00:00Z',
    coverImage: '/api/marketplace/posts/post-2/photos/0',
} as MarketplaceTransaction;
const doneDeal = {
    ...heldDeal, id: 'tx-done', postId: 'post-3', postTitle: 'Rye bread', status: 'completed', ratedByBuyer: true, ratedBySeller: true,
    coverImage: '/api/marketplace/posts/post-3/photos/0',
} as MarketplaceTransaction;

function drawLocal(tab: 'active' | 'pending' | 'history') {
    const onNavigateToPost = vi.fn();
    const onClose = vi.fn();
    render(<MyDealsModal visible identity={identity} onClose={onClose} posts={POSTS} transactions={[heldDeal, doneDeal]}
        initialTab={tab} onNavigateToPost={onNavigateToPost} onPromptReview={() => {}} />);
    return { onNavigateToPost, onClose };
}

const noPhotoViewer = () => {
    expect(screen.queryByRole('button', { name: /View enlarged photo/ })).toBeNull();
    expect(screen.queryByRole('dialog', { name: /Photo viewer/ })).toBeNull();
};

afterEach(() => { cleanup(); });

describe('Your deals: a row\'s photo opens what the row opens', () => {
    it('In Progress: a press on the photo opens the deal; the row is one element named for the deal, with no enlarge button', () => {
        const { onNavigateToPost, onClose } = drawLocal('pending');
        const row = screen.getByRole('button', { name: 'View deal: Heirloom Tomato Seeds' });
        // One accessible element per row: nothing inside it is a button, the photo included.
        expect(within(row).queryAllByRole('button')).toEqual([]);
        noPhotoViewer();
        const photo = within(row).getByAltText('Cover');
        expect(photo.closest('button')).toBeNull();
        fireEvent.click(photo);
        expect(onNavigateToPost).toHaveBeenCalledTimes(1);
        expect(onNavigateToPost).toHaveBeenCalledWith('post-2', 'tx-held');
        expect(onClose).toHaveBeenCalledTimes(1);
        noPhotoViewer();
    });

    it('In Progress: Enter on the photo is the row\'s Enter; it opens the deal and no photo viewer', () => {
        const { onNavigateToPost } = drawLocal('pending');
        const photo = within(screen.getByRole('button', { name: 'View deal: Heirloom Tomato Seeds' })).getByAltText('Cover');
        const ev = createEvent.keyDown(photo, { key: 'Enter' });
        fireEvent(photo, ev);
        expect(ev.defaultPrevented).toBe(true);
        expect(onNavigateToPost).toHaveBeenCalledTimes(1);
        expect(onNavigateToPost).toHaveBeenCalledWith('post-2', 'tx-held');
        noPhotoViewer();
    });

    it('My Posts: a press on the photo opens the post; the row is one element named for the post', () => {
        const { onNavigateToPost, onClose } = drawLocal('active');
        const row = screen.getByRole('button', { name: 'View post: Organic Sourdough Bread' });
        expect(within(row).queryAllByRole('button')).toEqual([]);
        noPhotoViewer();
        fireEvent.click(within(row).getByAltText('Cover'));
        expect(onNavigateToPost).toHaveBeenCalledTimes(1);
        expect(onNavigateToPost).toHaveBeenCalledWith('post-1');
        expect(onClose).toHaveBeenCalledTimes(1);
        noPhotoViewer();
    });

    it('Escape after a press on a photo closes Your deals at once: there is no photo viewer to close first', () => {
        const { onClose } = drawLocal('active');
        fireEvent.click(within(screen.getByRole('button', { name: 'View post: Organic Sourdough Bread' })).getByAltText('Cover'));
        onClose.mockClear(); // the press itself closes Your deals to open the post; this counts only the key
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('History: a finished deal opens nothing today, and its photo is not a button that opens a viewer', () => {
        const { onNavigateToPost, onClose } = drawLocal('history');
        const row = screen.getByTestId('deal-card-tx-done');
        expect(row.getAttribute('role')).toBeNull();
        noPhotoViewer();
        fireEvent.click(within(row).getByAltText('Cover'));
        expect(onNavigateToPost).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        noPhotoViewer();
    });
});

describe('Your deals in preview: a row\'s photo opens what the row opens', () => {
    it('In Progress: a press on the photo opens the local-community sheet, as a press on the row does, and no photo viewer', async () => {
        render(<MyDealsModal visible identity={null} preview onClose={() => {}} />);
        const sample = sampleDeals();
        const shelves = sample.transactions.find(x => x.status === 'requested')!;
        const row = screen.getByRole('button', { name: shelves.postTitle });
        // The row holds its marker button ("Approve and hold in trust"), and no button for the photo.
        expect(within(row).queryByRole('button', { name: /enlarged/ })).toBeNull();
        noPhotoViewer();
        const photo = within(row).getByAltText('Cover');
        expect(photo.closest('button')).toBeNull();
        fireEvent.click(photo);
        expect(await screen.findByTestId('local-community-sheet')).toBeInTheDocument();
        noPhotoViewer();
    });

    it('My Posts: a press on the photo opens the local-community sheet; the row is named for the post', async () => {
        render(<MyDealsModal visible identity={null} preview onClose={() => {}} />);
        const mine = sampleDeals().posts.find(p => p.authorPublicKey === SAMPLE_DEALS_ME.publicKey)!;
        fireEvent.click(screen.getByRole('button', { name: /My Posts/ }));
        const row = screen.getByRole('button', { name: mine.title });
        noPhotoViewer();
        const photo = within(row).getByAltText('Cover');
        expect(photo.closest('button')).toBeNull();
        fireEvent.click(photo);
        expect(await screen.findByTestId('local-community-sheet')).toBeInTheDocument();
        noPhotoViewer();
    });
});

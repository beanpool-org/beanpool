/**
 * Your deals in the member's language (words S3, web sweep W1): every tab (In Progress, My Posts, History and its
 * filters), each tab's empty state, a deal's status badge, its date (core's formatDate, as the phone's MyDealsSheet),
 * "Bought from / Sold to {who}" as ONE sentence with the name bold inside it, the photo buttons and the Beans sign.
 * Listing titles and names are the members' own, shown as written.
 *
 * Preview (a node where escrow is off): the card's own words are checked; the local-community marker, its sheet and
 * the sample header are other components (LocalCommunityMark, ShowcasePreviews), drawn here as stand-ins.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { MarketplacePost, MarketplaceTransaction } from '../lib/api';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-xx.test-support';

vi.mock('./LocalCommunityMark', () => ({
    LocalCommunityAction: ({ label }: { label: string }) => <button type="button" data-testid="local-community-action">{label}</button>,
    LocalCommunityStrip: () => null,
    LocalCommunitySheet: () => <div data-testid="local-community-sheet" />,
}));
vi.mock('./StartCommunityScreen', () => ({ StartCommunityScreen: () => null }));
vi.mock('./ShowcasePreviews', async (importOriginal) => ({ ...(await importOriginal<typeof import('./ShowcasePreviews')>()), SampleHeader: () => null }));

import { MyDealsModal } from './MyDealsModal';
import { sampleDeals } from './ShowcasePreviews';

const ana = 'pubkey-ana';
const kofi = 'pubkey-kofi';
const mere = 'pubkey-mere';
const tama = 'pubkey-tama';
const post = (p: Partial<MarketplacePost>) => ({
    category: 'services', description: '', priceType: 'fixed', active: true, repeatable: false, photos: [], createdAt: '2026-10-10T00:00:00Z', ...p,
}) as MarketplacePost;

const POSTS = [
    post({ id: 'p-couch', type: 'need', title: 'Help moving a couch', authorPublicKey: ana, authorCallsign: 'Ana', status: 'active', credits: 30, photos: ['/api/marketplace/posts/p-couch/photos/0'] }),
    post({ id: 'p-mend', type: 'offer', title: 'Mending jackets', authorPublicKey: ana, authorCallsign: 'Ana', status: 'active', credits: 15 }),
    post({ id: 'p-bike', type: 'offer', title: 'Bike tune-up', authorPublicKey: kofi, authorCallsign: 'Kofi', status: 'pending', acceptedBy: ana, credits: 20 }),
];
const TXS: MarketplaceTransaction[] = [
    { id: 'tx-pending-buy', postId: 'p-bike', postTitle: 'Bike tune-up', buyerPublicKey: ana, buyerCallsign: 'Ana', sellerPublicKey: kofi, sellerCallsign: 'Kofi', credits: 20, status: 'pending', createdAt: '2026-10-15T12:00:00Z', coverImage: '/api/marketplace/posts/p-bike/photos/0' } as MarketplaceTransaction,
    { id: 'tx-pending-sell', postId: 'p-weed', postTitle: 'Weed the veggie patch', buyerPublicKey: tama, buyerCallsign: 'Tama', sellerPublicKey: ana, sellerCallsign: 'Ana', credits: 10, status: 'pending', createdAt: '2026-10-14T00:00:00Z' },
    { id: 'tx-completed-sold', postId: 'p-mend', postTitle: 'Mending jackets', buyerPublicKey: mere, buyerCallsign: 'Mere', sellerPublicKey: ana, sellerCallsign: 'Ana', credits: 15, status: 'completed', createdAt: '2026-10-09T00:00:00Z' },
    { id: 'tx-cancelled', postId: 'p-bread', postTitle: 'Rye bread', buyerPublicKey: ana, buyerCallsign: 'Ana', sellerPublicKey: mere, sellerCallsign: 'Mere', credits: 8, status: 'cancelled', createdAt: '2026-10-11T00:00:00Z' },
    { id: 'tx-rejected', postId: 'p-bread', postTitle: 'Rye bread', buyerPublicKey: ana, buyerCallsign: 'Ana', sellerPublicKey: mere, sellerCallsign: 'Mere', credits: 8, status: 'rejected', createdAt: '2026-10-12T00:00:00Z' },
];
const others = ['Help moving a couch', 'Mending jackets', 'Bike tune-up', 'Weed the veggie patch', 'Rye bread', 'Ana', 'Kofi', 'Mere', 'Tama'];

function drawLocal(posts = POSTS, transactions = TXS) {
    render(<MyDealsModal visible identity={{ publicKey: ana }} onClose={() => {}} posts={posts} transactions={transactions} onPromptReview={() => {}} onNavigateToPost={() => {}} />);
}

afterEach(() => { cleanup(); backToEnglish(); });

describe('Your deals in the pseudo-locale', () => {
    it('every tab and filter of a local node: the words through t(), the names and titles theirs', async () => {
        await showIn('xx');
        drawLocal();
        const dialog = screen.getByRole('dialog', { name: xx('Your deals') });

        // In Progress: the status badge, the date, the partner sentence with the name bold inside it.
        expect(screen.getAllByText(xx('pending'))).toHaveLength(2);
        expect(screen.getByText('Kofi').closest('p')!.textContent).toBe(xx('Bought from {who}').replace('{who}', 'Kofi'));
        expect(screen.getByText('Kofi')).toHaveClass('font-bold');
        expect(screen.getByText('Tama').closest('p')!.textContent).toBe(xx('Sold to {who}').replace('{who}', 'Tama'));
        expect(screen.getByText(xx('15 Oct 2026'))).toBeInTheDocument();
        expect(screen.getByTestId('deal-card-tx-pending-buy').getAttribute('aria-label')).toBe(xx('View deal: {title}').replace('{title}', 'Bike tune-up'));
        expect(bracketed(dialog)).toBeGreaterThan(8);
        expect(bypassing(document.body, { others })).toEqual([]);

        // My Posts.
        fireEvent.click(screen.getByRole('button', { name: new RegExp(xx('My Posts').replace(/[[\]~]/g, '.')) }));
        expect(screen.getAllByText(xx('🟢 Active'))).toHaveLength(2);
        expect(screen.getByText(xx('need'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('View enlarged photo: {title}').replace('{title}', 'Help moving a couch') })).toBeInTheDocument();
        expect(bypassing(document.body, { others })).toEqual([]);

        // History, all three filters: completed (with Leave Review), cancelled, rejected.
        fireEvent.click(screen.getByRole('button', { name: new RegExp(xx('History').replace(/[[\]~]/g, '.')) }));
        expect(screen.getByText(xx('completed'))).toBeInTheDocument();
        expect(screen.getByText(xx('cancelled'))).toBeInTheDocument();
        expect(screen.getByText(xx('rejected'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('Leave Review') })).toBeInTheDocument();
        expect(bypassing(document.body, { others })).toEqual([]);
        fireEvent.click(screen.getByRole('button', { name: xx('Received') }));
        expect(bypassing(document.body, { others })).toEqual([]);
        fireEvent.click(screen.getByRole('button', { name: xx('Given') }));
        expect(screen.getByText(xx('completed'))).toBeInTheDocument();
        expect(bypassing(document.body, { others })).toEqual([]);
    });

    it('each tab empty: its own words', async () => {
        await showIn('xx');
        drawLocal([], []);
        expect(screen.getByText(xx('No deals in progress'))).toBeInTheDocument();
        expect(bypassing(document.body)).toEqual([]);
        fireEvent.click(screen.getByRole('button', { name: new RegExp(xx('My Posts').replace(/[[\]~]/g, '.')) }));
        expect(screen.getByRole('button', { name: xx('+ Create a Post') })).toBeInTheDocument();
        expect(bypassing(document.body)).toEqual([]);
        fireEvent.click(screen.getByRole('button', { name: new RegExp(xx('History').replace(/[[\]~]/g, '.')) }));
        expect(screen.getByText(xx('Completed or cancelled deals will show up here.'))).toBeInTheDocument();
        expect(bypassing(document.body)).toEqual([]);
    });

    it('preview: the sample cards\' own words through t() on every tab', async () => {
        await showIn('xx');
        // The sample's titles and names come from ShowcasePreviews.sampleDeals() as written there: they stand in for
        // a member's listing and a neighbour's name, so they are read here as members' words.
        const sample = sampleDeals();
        const sampleWords = [...new Set(sample.transactions.flatMap(t => [t.postTitle, t.buyerCallsign, t.sellerCallsign]).concat(sample.posts.map(p => p.title)))]
            .filter((w): w is string => typeof w === 'string');
        render(<MyDealsModal visible identity={null} preview onClose={() => {}} />);
        const card = screen.getByTestId('sample-deal-sample-deal-shelves');
        expect(within(card).getByText(xx('A neighbour offered to do this. Approve to hold the Beans safely.'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: sampleWords })).toEqual([]);
        fireEvent.click(screen.getByRole('button', { name: new RegExp(xx('My Posts').replace(/[[\]~]/g, '.')) }));
        expect(bypassing(document.body, { others: sampleWords })).toEqual([]);
        fireEvent.click(screen.getByRole('button', { name: new RegExp(xx('History').replace(/[[\]~]/g, '.')) }));
        expect(screen.getByRole('button', { name: xx('Leave Review') })).toBeInTheDocument();
        expect(bypassing(document.body, { others: sampleWords })).toEqual([]);
    });

    it('in English nothing is bracketed, and the words are as they were', () => {
        drawLocal();
        expect(bracketed()).toBe(0);
        expect(screen.getAllByText('pending')).toHaveLength(2);
        expect(screen.getByText('Kofi').closest('p')!.textContent).toBe('Bought from Kofi');
        expect(screen.getByText('Tama').closest('p')!.textContent).toBe('Sold to Tama');
        // The date as core writes it, as the phone's Your deals does (it was the browser's toLocaleDateString()).
        expect(screen.getByText('15 Oct 2026')).toBeInTheDocument();
        expect(screen.getByText('- 20')).toBeInTheDocument();
        expect(screen.getAllByAltText('B').length).toBeGreaterThan(0);
        expect(screen.getByAltText('Cover')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'View enlarged photo: Bike tune-up' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /My Posts/ }));
        expect(screen.getByText('need')).toBeInTheDocument();
        expect(screen.getByTestId('deal-card-p-couch').getAttribute('aria-label')).toBe('View post: Help moving a couch');
        fireEvent.click(screen.getByRole('button', { name: /History/ }));
        expect(screen.getByRole('button', { name: 'Leave Review' })).toBeInTheDocument();
        expect(screen.getByText('rejected')).toBeInTheDocument();
    });
});

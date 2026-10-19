/**
 * A Pulse card in the member's language (words S3, web sweep W1): its own words (the author line, the category, the
 * owner's Hide and Delete with their questions, the report flag) through t(), the same keys as the phone's card. The
 * item's title and the neighbour's name are theirs, and a platform's brand (YouTube) reads as written in every language.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PulseFeedCard } from './PulseFeedCard';
import { type PulseFeedItem } from '../lib/api';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-xx.test-support';

vi.mock('../lib/api', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/api')>()),
    reportAbuse: vi.fn().mockResolvedValue({ success: true }),
}));

const HOUR = 3600 * 1000;
const item: PulseFeedItem = {
    id: 'pulse-123',
    ownerPubkey: 'pubkey-owner',
    url: 'https://youtube.com/watch?v=12345',
    platform: 'youtube',
    category: 'food',
    title: 'Community Gardening Workshop',
    thumbnailUrl: null,
    callsign: 'GreenThumb',
    // An avatar, so the card shows no initial: a lone letter of the name would read as a word outside t().
    avatarUrl: 'bundled://leaf',
    source: 'user',
    isVerified: true,
    publishedAt: new Date(Date.now() - 3 * HOUR).toISOString(),
};

/** What the neighbour wrote, and the platform's brand name, shown as written. */
const OTHERS = ['Community Gardening Workshop', 'GreenThumb', 'YouTube'];

afterEach(() => { cleanup(); backToEnglish(); });

describe('a Pulse card in the pseudo-locale', () => {
    it("the owner's card and its two questions: every word came through t()", async () => {
        await showIn('xx');
        render(<PulseFeedCard item={item} currentPubkey="pubkey-owner" onMute={vi.fn()} onDelete={vi.fn()} />);
        expect(bracketed()).toBeGreaterThan(3);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        expect(screen.getByText(xx('{n}h ago').replace('{n}', '3'), { exact: false })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: xx('Hide this item from feed') }));
        expect(screen.getByRole('dialog')).toHaveTextContent(xx('Hide this post from feed?'));
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        fireEvent.click(screen.getByRole('button', { name: xx('Keep post') }));

        fireEvent.click(screen.getByRole('button', { name: xx('Delete this post') }));
        expect(screen.getByRole('dialog')).toHaveTextContent(xx('Delete this post?'));
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
    });

    it("someone else's card: the flag and the report card it opens", async () => {
        await showIn('xx');
        render(<PulseFeedCard item={{ ...item, title: null, publishedAt: null } as any} currentPubkey="pubkey-viewer" />);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(xx('View post on {platform}').replace('{platform}', 'YouTube'));

        fireEvent.click(screen.getByRole('button', { name: xx('Report this post') }));
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
    });
});

describe('a Pulse card in English', () => {
    it('in English nothing is bracketed, and the words are as they were', () => {
        render(<PulseFeedCard item={item} currentPubkey="pubkey-owner" onMute={vi.fn()} onDelete={vi.fn()} />);
        expect(bracketed()).toBe(0);
        expect(screen.getByRole('article').getAttribute('aria-label')).toBe('Community Gardening Workshop by GreenThumb on YouTube');
        expect(screen.getByRole('button', { name: "View GreenThumb's public profile" })).toHaveTextContent('· 3h ago');
        expect(screen.getByTitle('Category: Food & growing')).toBeInTheDocument();
        expect(screen.getByText('Open on YouTube', { exact: false }).textContent).toBe('Open on YouTube ↗');

        fireEvent.click(screen.getByRole('button', { name: 'Hide this item from feed' }));
        expect(screen.getByText(/will no longer be visible/).textContent)
            .toBe('"Community Gardening Workshop" will no longer be visible to your neighbours on the community feed.');
        fireEvent.click(screen.getByRole('button', { name: 'Keep post' }));
        fireEvent.click(screen.getByRole('button', { name: 'Delete this post' }));
        expect(screen.getByText(/permanently removed/).textContent).toBe('"Community Gardening Workshop" will be permanently removed from The Pulse.');
        expect(screen.getByRole('button', { name: 'Delete permanently' })).toBeInTheDocument();
    });
});

/**
 * The Pulse page in the member's language (words S3, web sweep W1): the heading, the lanes, the category chips (core's
 * word() labels), the empty and failed states and the feed's cards through t(), the phone's keys. What neighbours and
 * local sources posted (titles, names) is theirs, and a platform's brand reads as written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PulsePage } from './PulsePage';
import { getPulseFeed, type PulseFeedItem } from '../lib/api';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-xx.test-support';

vi.mock('../lib/api', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/api')>()),
    getPulseFeed: vi.fn(),
    getMemberChannels: vi.fn().mockResolvedValue({ channels: [] }),
    getPulseNudges: vi.fn().mockResolvedValue({ nudges: [] }),
    mutePulseItem: vi.fn().mockResolvedValue({ success: true }),
    deletePulseItem: vi.fn().mockResolvedValue({ success: true }),
}));

const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' };
const item = (over: Partial<PulseFeedItem>): PulseFeedItem => ({
    id: 'p1', ownerPubkey: 'owner-1', url: 'https://youtube.com/watch?v=1', platform: 'youtube', category: 'food',
    title: 'Seed saving at the hall', thumbnailUrl: null, callsign: 'GreenThumb', avatarUrl: 'bundled://leaf',
    source: 'user', isVerified: false, publishedAt: null, ...over,
} as PulseFeedItem);

const ITEMS = [
    item({}),
    item({ id: 'p2', title: 'Road closure on Main St', callsign: 'Shire Council', ownerPubkey: 'council', source: 'official', isOfficial: true } as any),
];
/** What neighbours and the local source posted, and the platform's brand name, shown as written. */
const OTHERS = ['Seed saving at the hall', 'GreenThumb', 'Road closure on Main St', 'Shire Council', 'YouTube'];

beforeEach(() => { vi.mocked(getPulseFeed).mockReset(); });
afterEach(() => { cleanup(); backToEnglish(); });

describe('the Pulse page in the pseudo-locale', () => {
    it('the feed with both lanes, then the local lane: every word came through t()', async () => {
        vi.mocked(getPulseFeed).mockResolvedValue({ items: ITEMS, nextCursor: 'more' } as any);
        await showIn('xx');
        render(<PulsePage identity={identity} onOpenProfile={vi.fn()} />);
        expect(await screen.findByText('Seed saving at the hall')).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(xx('The Pulse'));
        expect(screen.getByRole('button', { name: xx('Load more posts') })).toBeInTheDocument();
        expect(bracketed()).toBeGreaterThan(10);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);

        fireEvent.click(screen.getByText(xx('Local')).closest('button')!);
        expect(await screen.findByText('Road closure on Main St')).toBeInTheDocument();
        expect(screen.getByText(xx('News and notices from around the shire'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
    });

    it('the quiet feed, a category with nothing in it, and a failed read', async () => {
        vi.mocked(getPulseFeed).mockResolvedValue({ items: [], nextCursor: null } as any);
        await showIn('xx');
        render(<PulsePage identity={identity} onOpenProfile={vi.fn()} />);
        expect(await screen.findByText(xx('The Pulse is quiet right now'))).toBeInTheDocument();
        expect(bypassing(document.body)).toEqual([]);

        fireEvent.click(screen.getByText(xx('Food & growing')).closest('button')!);
        expect(await screen.findByText(xx('No posts in this category yet'))).toBeInTheDocument();
        expect(bypassing(document.body)).toEqual([]);

        vi.mocked(getPulseFeed).mockRejectedValue(new Error(''));
        fireEvent.click(screen.getByText(xx('All')).closest('button')!);
        expect(await screen.findByText(xx('Could not load community feed.'))).toBeInTheDocument();
        expect(bypassing(document.body)).toEqual([]);
    });
});

describe('the Pulse page in English', () => {
    it('in English nothing is bracketed, and the words are as they were', async () => {
        vi.mocked(getPulseFeed).mockResolvedValue({ items: ITEMS, nextCursor: null } as any);
        render(<PulsePage identity={identity} onOpenProfile={vi.fn()} />);
        expect(await screen.findByText('Seed saving at the hall')).toBeInTheDocument();
        expect(bracketed()).toBe(0);
        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('The Pulse');
        expect(screen.getByText('What your neighbours are creating and sharing')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Neighbours/ }).textContent).toBe('👥 Neighbours1');
        expect(screen.getByRole('button', { name: /Local/ }).textContent).toBe('📰 Local1');
        expect(screen.getByRole('button', { name: 'Manage your channels' }).textContent).toBe('+ Channels');
        // The chip (the card below says its category too).
        expect(screen.getAllByText('Food & growing')[0].closest('button')!.textContent).toBe('🌱Food & growing');
    });
});

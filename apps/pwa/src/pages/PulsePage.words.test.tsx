/**
 * The Pulse page in the member's language (words S3, web sweep W1): the heading, the lanes, the category chips (core's
 * word() labels), the empty and failed states and the feed's cards through t(), the phone's keys. What neighbours and
 * local sources posted (titles, names) is theirs, and a platform's brand reads as written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PulsePage } from './PulsePage';
import { getPulseFeed, getPulseNudges, type PulseFeedItem } from '../lib/api';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-xx.test-support';

vi.mock('../lib/api', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/api')>()),
    getPulseFeed: vi.fn(),
    getMemberChannels: vi.fn().mockResolvedValue({ channels: [] }),
    getPulseNudges: vi.fn().mockResolvedValue({ nudges: [] }),
    mutePulseItem: vi.fn().mockResolvedValue({ success: true }),
    deletePulseItem: vi.fn().mockResolvedValue({ success: true }),
}));
// The add screen is its own page with its own tests (PulseIntakePage.words.test.tsx): here only that the button opens it.
vi.mock('./PulseIntakePage', () => ({ PulseIntakePage: () => <div data-testid="pulse-intake-page" /> }));

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
        expect(await screen.findByText(xx('Nothing new this week.'))).toBeInTheDocument();
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
        expect(screen.getByRole('button', { name: 'Manage your channels' }).textContent).toBe('Your channels');
        // The chip (the card below says its category too).
        expect(screen.getAllByText('Food & growing')[0].closest('button')!.textContent).toBe('🌱Food & growing');
    });
});

// DESIGN-pulse-home-fable.md §3.2, §3.4, §3.8 (P3; Marty's picks of 14 Nov 2026): one obvious add button, Your channels, a
// quiet week that asks nothing and points at the Learn chip, and no Add to Pulse on the worldwide community.
describe('the Pulse page: one add button, Your channels, a quiet week (P3)', () => {
    const adds = () => screen.queryAllByRole('button', { name: 'Add to Pulse' });

    it('one add button, bottom right, opening the add screen', async () => {
        vi.mocked(getPulseFeed).mockResolvedValue({ items: ITEMS, nextCursor: null } as any);
        render(<PulsePage identity={identity} onOpenProfile={vi.fn()} profile="local" />);
        expect(await screen.findByText('Seed saving at the hall')).toBeInTheDocument();
        expect(adds()).toHaveLength(1);
        expect(adds()[0]).toHaveAttribute('data-testid', 'pulse-add');
        expect(adds()[0].className).toMatch(/\bfixed\b/);
        expect(adds()[0].className).toMatch(/\bright-/);
        fireEvent.click(adds()[0]);
        expect(screen.getByTestId('pulse-intake-page')).toBeInTheDocument();
    });

    it('a quiet week: two plain sentences, the add button in the middle (still the only one), the Learn line opens Learn', async () => {
        vi.mocked(getPulseFeed).mockResolvedValue({ items: [], nextCursor: null } as any);
        render(<PulsePage identity={identity} onOpenProfile={vi.fn()} profile="local" />);
        expect(await screen.findByText('Nothing new this week.')).toBeInTheDocument();
        expect(screen.getByText('Have a video, a song, a blog or photos of your own? Add a link and your neighbours see it here.')).toBeInTheDocument();
        expect(screen.queryByText('The Pulse is quiet right now')).toBeNull();
        expect(document.body.textContent).not.toContain('once syndicated');
        expect(adds()).toHaveLength(1);
        expect(adds()[0]).toHaveAttribute('data-testid', 'pulse-add-quiet');
        // The web has no Learn lane (its "Learn" is the Local knowledge page): the line names the chip it opens.
        expect(document.body.textContent).not.toContain('Learn lane');
        fireEvent.click(screen.getByRole('button', { name: 'Nothing to add? Tap How it works for short videos about BeanPool.' }));
        await waitFor(() => expect(vi.mocked(getPulseFeed)).toHaveBeenLastCalledWith(expect.objectContaining({ category: 'learn' })));
    });

    it('on the worldwide community: no Add to Pulse at all, and a quiet week leads to How it works', async () => {
        vi.mocked(getPulseFeed).mockResolvedValue({ items: ITEMS, nextCursor: null } as any);
        render(<PulsePage identity={identity} onOpenProfile={vi.fn()} profile="global" />);
        expect(await screen.findByText('Seed saving at the hall')).toBeInTheDocument();
        expect(adds()).toHaveLength(0);
        expect(screen.getByRole('button', { name: 'Manage your channels' })).toBeInTheDocument();
        cleanup();

        vi.mocked(getPulseFeed).mockResolvedValue({ items: [], nextCursor: null } as any);
        render(<PulsePage identity={identity} onOpenProfile={vi.fn()} profile="global" />);
        expect(await screen.findByText('Nothing new this week.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Tap How it works for short videos about BeanPool.' })).toBeInTheDocument();
        expect(document.body.textContent).not.toContain('Learn lane');
        expect(adds()).toHaveLength(0);
        expect(document.body.textContent).not.toContain('Add a link');
    });

    it('a feed that would not load says so and Retry, never "Nothing new this week": that would be a guess', async () => {
        vi.mocked(getPulseFeed).mockRejectedValue(new Error(''));
        render(<PulsePage identity={identity} onOpenProfile={vi.fn()} profile="local" />);
        expect(await screen.findByText('Could not load community feed.')).toBeInTheDocument();
        expect(screen.queryByText('Nothing new this week.')).toBeNull();
        // The add button stays where it always is: adding does not need the feed.
        expect(adds()).toHaveLength(1);
        expect(adds()[0]).toHaveAttribute('data-testid', 'pulse-add');
    });

    /** A class list's own z-index (Tailwind `z-N` or `z-[N]`, no variant), or 0 for none: how two fixed boxes stack. */
    const zOf = (el: Element): number => {
        for (const c of el.className.split(/\s+/)) {
            const m = /^z-(?:\[(\d+)\]|(\d+))$/.exec(c);
            if (m) return Number(m[1] ?? m[2]);
        }
        return 0;
    };
    /** Classes that give an element a stacking context of its own, which would keep a dialog's z-index inside it. */
    const STACKS = /(^|:)(z-|isolate|transform|-?translate-|-?scale-|-?rotate-|opacity-|blur|filter|backdrop-|will-change)/;

    it("Add to Pulse stays under the cards' own dialogs: an open Hide or Delete dims it and its backdrop takes the tap", async () => {
        // Review of 24850a67: the button (fixed, later in the page) was z-50 like the cards' inline dialogs, so it drew
        // bright over their backdrop and could take a tap meant for the dialog.
        vi.mocked(getPulseFeed).mockResolvedValue({ items: [item({ ownerPubkey: 'me-pk' })], nextCursor: null } as any);
        render(<PulsePage identity={identity} onOpenProfile={vi.fn()} profile="local" />);
        expect(await screen.findByText('Seed saving at the hall')).toBeInTheDocument();
        const add = screen.getByTestId('pulse-add');
        const page = add.parentElement!;
        for (const [opens, title] of [['Hide this item from feed', 'Hide this post from feed?'], ['Delete this post', 'Delete this post?']]) {
            fireEvent.click(screen.getByRole('button', { name: opens }));
            const backdrop = screen.getByRole('dialog', { name: title }).parentElement!;
            expect(backdrop.className).toMatch(/\bfixed\b/);
            expect(page.contains(backdrop)).toBe(true);
            expect(zOf(add)).toBeLessThan(zOf(backdrop));
            // The two compare in one stacking context: nothing between the dialog and the page makes one of its own.
            for (let el = backdrop.parentElement; el && el !== page; el = el.parentElement) {
                expect(el.className.split(/\s+/).filter(c => STACKS.test(c)), `<${el.tagName.toLowerCase()}> would hold the dialog under the button`).toEqual([]);
            }
            fireEvent.click(backdrop);
            expect(screen.queryByRole('dialog', { name: title })).toBeNull();
        }
    });

    it("on the worldwide community the page asks nothing: no nudges (a clipboard link's own Add to Pulse, a channel's Share)", async () => {
        const nudge = { channelId: 'ch1', platform: 'youtube', handle: '@me', currentCount: 5, postCountSeen: 3, newPostsCount: 2 };
        vi.mocked(getPulseNudges).mockClear();
        vi.mocked(getPulseNudges).mockResolvedValue({ nudges: [nudge] } as any);
        vi.mocked(getPulseFeed).mockResolvedValue({ items: ITEMS, nextCursor: null } as any);
        render(<PulsePage identity={identity} onOpenProfile={vi.fn()} profile="local" />);
        expect(await screen.findByText('Seed saving at the hall')).toBeInTheDocument();
        // On a local community the nudge shows (after its short wait), as before.
        expect(await screen.findByText("You've posted 2 new things on YouTube since your last visit.", undefined, { timeout: 3000 })).toBeInTheDocument();
        cleanup();

        vi.mocked(getPulseNudges).mockClear();
        render(<PulsePage identity={identity} onOpenProfile={vi.fn()} profile="global" />);
        expect(await screen.findByText('Seed saving at the hall')).toBeInTheDocument();
        await new Promise(resolve => setTimeout(resolve, 1500)); // past the nudges' own 800 ms wait
        expect(vi.mocked(getPulseNudges)).not.toHaveBeenCalled();
        expect(screen.queryByText("You've posted 2 new things on YouTube since your last visit.")).toBeNull();
        expect(screen.queryAllByRole('button', { name: 'Add to Pulse' })).toHaveLength(0);
        // Your channels, the path that was there before, still opens on the worldwide community.
        expect(screen.getByRole('button', { name: 'Manage your channels' })).toBeInTheDocument();
        vi.mocked(getPulseNudges).mockResolvedValue({ nudges: [] } as any);
    });

    it('in the pseudo-locale every new word came through t(), local and worldwide', async () => {
        vi.mocked(getPulseFeed).mockResolvedValue({ items: [], nextCursor: null } as any);
        await showIn('xx');
        render(<PulsePage identity={identity} onOpenProfile={vi.fn()} profile="local" />);
        expect(await screen.findByText(xx('Nothing new this week.'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('Add to Pulse') })).toBeInTheDocument();
        expect(bypassing(document.body)).toEqual([]);
        cleanup();
        render(<PulsePage identity={identity} onOpenProfile={vi.fn()} profile="global" />);
        expect(await screen.findByText(xx('Tap {chip} for short videos about BeanPool.').replace('{chip}', xx('How it works')))).toBeInTheDocument();
        expect(bypassing(document.body)).toEqual([]);
    });
});

/**
 * Local knowledge on the web's Pulse (slice KP, apps; DESIGN-local-knowledge-amend-fable.md §2.12, §3.8): the page asks the
 * node for knowledge cards (`with=knowledge`), draws the card with its own component in the feed's own order between the
 * creators' cards, under the Neighbours lane; its rows open the page in Learn and its foot opens Learn. A day's card can move
 * between two page reads (the KP node review note), so the list keeps the newest copy and never two cards for one day.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PulseKnowledgeCard, PulseKnowledgePost } from '@beanpool/core';
import { PulsePage } from './PulsePage';
import { getPulseFeed, type PulseFeedItem } from '../lib/api';
import type { BeanPoolIdentity } from '../lib/identity';

vi.mock('../lib/api', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/api')>()),
    getPulseFeed: vi.fn(),
    getMemberChannels: vi.fn().mockResolvedValue({ channels: [] }),
    getPulseNudges: vi.fn().mockResolvedValue({ nudges: [] }),
    mutePulseItem: vi.fn().mockResolvedValue({ success: true }),
    deletePulseItem: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('./PulseIntakePage', () => ({ PulseIntakePage: () => <div data-testid="pulse-intake-page" /> }));

const identity = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' } as unknown as BeanPoolIdentity;
const creator = (id: string, title: string, over: Partial<PulseFeedItem> = {}): PulseFeedItem => ({
    id, ownerPubkey: `owner-${id}`, url: `https://youtube.com/watch?v=${id}`, platform: 'youtube', category: 'food',
    title, thumbnailUrl: null, callsign: `Maker ${id}`, avatarUrl: 'bundled://leaf', source: 'oauth', isVerified: false,
    publishedAt: '2026-11-15T01:00:00.000Z', ...over,
});
const page = (id: string, title: string, over: Partial<PulseKnowledgePost> = {}): PulseKnowledgePost => ({
    id, title, topic: 'local-services', line: 'The first line.', photo: null, by: null, gathered: false, ...over,
});
const know = (day: string, posts: PulseKnowledgePost[], count = posts.length): PulseKnowledgeCard => ({
    id: `know_${day}`, source: 'knowledge', platform: 'beanpool', category: 'knowledge', url: null, thumbnailUrl: null,
    ownerPubkey: '', callsign: '', avatarUrl: null, isVerified: false, title: posts[0].title,
    publishedAt: `${day}T00:30:00.000Z`, knowledge: { count, posts },
});
const feed = (items: unknown[], nextCursor: string | null = null) => ({ items: items as PulseFeedItem[], nextCursor });

/** The cards in the order the list draws them: a knowledge card by its head, a creator's by its title. */
function drawn(): string[] {
    return Array.from(document.querySelectorAll('article')).map((a) =>
        a.getAttribute('data-testid') === 'pulse-knowledge-card'
            ? `knowledge: ${within(a).getByTestId('pulse-knowledge-head').querySelector('p')?.textContent}`
            : `creator: ${a.querySelector('h3')?.textContent}`);
}

beforeEach(() => { vi.mocked(getPulseFeed).mockReset(); });
afterEach(() => { cleanup(); });

describe('the Pulse asks for knowledge cards', () => {
    it('the feed read under All sends with=knowledge, and so does Load more', async () => {
        vi.mocked(getPulseFeed)
            .mockResolvedValueOnce(feed([creator('a', 'Seed saving at the hall')], 'c1'))
            .mockResolvedValueOnce(feed([creator('b', 'Repair café')]));
        render(<PulsePage identity={identity} onOpenProfile={vi.fn()} />);
        await screen.findByText('Seed saving at the hall');
        expect(vi.mocked(getPulseFeed).mock.calls[0][0]).toMatchObject({ withKnowledge: true });
        fireEvent.click(screen.getByRole('button', { name: 'Load more posts' }));
        await screen.findByText('Repair café');
        expect(vi.mocked(getPulseFeed).mock.calls[1][0]).toMatchObject({ withKnowledge: true, cursor: 'c1' });
    });
});

describe('the knowledge card in the list', () => {
    it('one page: drawn between two creators\' cards, in the feed\'s order, under Neighbours; the row opens the page, the foot Learn', async () => {
        const onNavigate = vi.fn();
        vi.mocked(getPulseFeed).mockResolvedValue(feed([
            creator('a', 'Seed saving at the hall'),
            know('2026-11-15', [page('k1', 'How recycling works at the tip', { by: 'Ada' })]),
            creator('b', 'Road closure on Main St', { source: 'official', isOfficial: true } as Partial<PulseFeedItem>),
            creator('c', 'Repair café'),
        ]));
        render(<PulsePage identity={identity} onOpenProfile={vi.fn()} onNavigate={onNavigate} />);
        await screen.findByText('Seed saving at the hall');
        expect(drawn()).toEqual(['creator: Seed saving at the hall', 'knowledge: New local knowledge', 'creator: Repair café']);
        // The creator's card is not used for it: no face, no "Open on" link, no Hide or report.
        const card = screen.getByTestId('pulse-knowledge-card');
        expect(within(card).queryByRole('link')).toBeNull();
        expect(within(card).queryByText('⚑')).toBeNull();

        fireEvent.click(within(card).getByRole('button', { name: 'New local knowledge: How recycling works at the tip. Opens it in Learn.' }));
        expect(onNavigate).toHaveBeenLastCalledWith('learn-page', 'k1');
        fireEvent.click(within(card).getByTestId('pulse-knowledge-open-learn'));
        expect(onNavigate).toHaveBeenLastCalledWith('learn');

        // The Local lane holds the local source only: the knowledge card stays with the neighbours.
        fireEvent.click(screen.getByText('Local').closest('button')!);
        await screen.findByText('Road closure on Main St');
        expect(screen.queryByTestId('pulse-knowledge-card')).toBeNull();
    });

    it('several the same day: one grouped card between two creators\' cards; "and {n} more ›" opens Learn', async () => {
        const onNavigate = vi.fn();
        vi.mocked(getPulseFeed).mockResolvedValue(feed([
            creator('a', 'Seed saving at the hall'),
            know('2026-11-15', [page('k1', 'How recycling works at the tip'), page('k2', 'Who to call when the river rises'), page('k3', 'Bus times')], 8),
            creator('c', 'Repair café'),
        ]));
        render(<PulsePage identity={identity} onOpenProfile={vi.fn()} onNavigate={onNavigate} />);
        await screen.findByText('Seed saving at the hall');
        expect(drawn()).toEqual(['creator: Seed saving at the hall', 'knowledge: 8 new in Local knowledge', 'creator: Repair café']);
        fireEvent.click(screen.getAllByTestId('pulse-knowledge-row')[2]);
        expect(onNavigate).toHaveBeenLastCalledWith('learn-page', 'k3');
        fireEvent.click(screen.getByTestId('pulse-knowledge-more'));
        expect(onNavigate).toHaveBeenLastCalledWith('learn');
    });

    it('a day\'s card that moved to the next page between reads shows once, the newest copy, where that read put it', async () => {
        vi.mocked(getPulseFeed)
            .mockResolvedValueOnce(feed([
                creator('a', 'Seed saving at the hall'),
                know('2026-11-14', [page('k1', 'How recycling works at the tip'), page('k2', 'Bus times')], 2),
                creator('b', 'Repair café'),
            ], 'c1'))
            // A takedown between the reads: the day now has one page, and its card sorts older, onto this page.
            .mockResolvedValueOnce(feed([
                creator('c', 'Choir practice'),
                know('2026-11-14', [page('k2', 'Bus times')], 1),
                creator('d', 'Seed swap'),
            ]));
        render(<PulsePage identity={identity} onOpenProfile={vi.fn()} />);
        await screen.findByText('Seed saving at the hall');
        expect(screen.getAllByTestId('pulse-knowledge-card')).toHaveLength(1);
        fireEvent.click(screen.getByRole('button', { name: 'Load more posts' }));
        await screen.findByText('Choir practice');
        await waitFor(() => expect(drawn()).toEqual([
            'creator: Seed saving at the hall', 'creator: Repair café', 'creator: Choir practice', 'knowledge: New local knowledge', 'creator: Seed swap',
        ]));
        expect(screen.getAllByTestId('pulse-knowledge-card')).toHaveLength(1);
        expect(screen.queryByText('How recycling works at the tip')).toBeNull();
        expect(screen.getByText('Bus times')).toBeInTheDocument();
    });

    it('two days\' cards stay two cards; a creator\'s item a page repeats is drawn once', async () => {
        vi.mocked(getPulseFeed)
            .mockResolvedValueOnce(feed([know('2026-11-15', [page('k1', 'How recycling works at the tip')]), creator('a', 'Seed saving at the hall')], 'c1'))
            .mockResolvedValueOnce(feed([creator('a', 'Seed saving at the hall'), know('2026-11-13', [page('k9', 'Bus times')])]));
        render(<PulsePage identity={identity} onOpenProfile={vi.fn()} />);
        await screen.findByText('Seed saving at the hall');
        fireEvent.click(screen.getByRole('button', { name: 'Load more posts' }));
        await screen.findByText('Bus times');
        expect(drawn()).toEqual(['knowledge: New local knowledge', 'creator: Seed saving at the hall', 'knowledge: New local knowledge']);
    });

    it('a feed with only a knowledge card is no quiet week: the card shows, with the one add button in its corner', async () => {
        vi.mocked(getPulseFeed).mockResolvedValue(feed([know('2026-11-15', [page('k1', 'How recycling works at the tip')])]));
        render(<PulsePage identity={identity} onOpenProfile={vi.fn()} />);
        expect(await screen.findByTestId('pulse-knowledge-card')).toBeInTheDocument();
        expect(screen.queryByText('Nothing new this week.')).toBeNull();
        expect(screen.getByTestId('pulse-add')).toBeInTheDocument();
    });
});

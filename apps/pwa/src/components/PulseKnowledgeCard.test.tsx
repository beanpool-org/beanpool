/**
 * Local knowledge's card on the web's Pulse (slice KP; DESIGN-local-knowledge-amend-fable.md §3.8): no face and no profile,
 * no ⚑ and no Hide; one page reads "New local knowledge" with its topic chip and "by {name}" when a member wrote it; several
 * the same day read "{n} new in Local knowledge" with three rows and "and {n} more ›"; rows open the page in the app and the
 * foot "Open Learn ›" opens Learn. The taps and spoken lines are the design's, the same as the phone's card: one page, the
 * head and the row are one tap to the page; several, the head is a tap to Learn. Nothing is fetched from outside.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { PulseKnowledgeCard as Card, PulseKnowledgePost } from '@beanpool/core';
import { PulseKnowledgeCard } from './PulseKnowledgeCard';

const HOUR = 3600 * 1000;
const post = (over: Partial<PulseKnowledgePost> = {}): PulseKnowledgePost => ({
    id: 'k1', title: 'How recycling works at the tip', topic: 'local-services', line: 'Bring glass, cans and paper sorted.',
    photo: null, by: null, gathered: false, ...over,
});
const card = (posts: PulseKnowledgePost[], count = posts.length): Card => ({
    id: 'know_2026-11-15', source: 'knowledge', platform: 'beanpool', category: 'knowledge', url: null, thumbnailUrl: null,
    ownerPubkey: '', callsign: '', avatarUrl: null, isVerified: false, title: posts[0]?.title ?? '',
    publishedAt: new Date(Date.now() - 2 * HOUR).toISOString(), knowledge: { count, posts },
});

afterEach(() => { cleanup(); });

describe('the knowledge card, one page', () => {
    it('heads "New local knowledge" with the 📖 tile and the time, the topic chip on the right, and no face, ⚑ or Hide', () => {
        render(<PulseKnowledgeCard card={card([post({ by: 'Ada' })])} onOpenPage={vi.fn()} onOpenLearn={vi.fn()} />);
        const head = screen.getByTestId('pulse-knowledge-head');
        expect(head).toHaveTextContent('New local knowledge');
        expect(head).toHaveTextContent('2h ago');
        expect(within(head).getByTestId('pulse-knowledge-tile').textContent).toBe('📖');
        expect(screen.getByTestId('pulse-knowledge-topic').textContent).toBe('LOCAL SERVICES');
        expect(document.querySelector('img')).toBeNull();
        expect(screen.queryByText('⚑')).toBeNull();
        expect(screen.queryByRole('button', { name: /hide|report|profile/i })).toBeNull();
        expect(screen.getByTestId('pulse-knowledge-card').textContent).not.toMatch(/↗|YouTube/);
    });

    it('the head and the row are one tap to the page, speaking the design\'s line; it shows the first line and "by {name}"', () => {
        const onOpenPage = vi.fn();
        const onOpenLearn = vi.fn();
        render(<PulseKnowledgeCard card={card([post({ by: 'Ada' })])} onOpenPage={onOpenPage} onOpenLearn={onOpenLearn} />);
        const row = screen.getByRole('button', { name: 'New local knowledge: How recycling works at the tip. Opens it in Learn.' });
        expect(row).toHaveTextContent('How recycling works at the tip');
        expect(row).toHaveTextContent('Bring glass, cans and paper sorted.');
        expect(row).toHaveTextContent('by Ada');
        expect(row).toContainElement(screen.getByTestId('pulse-knowledge-head'));
        fireEvent.click(row);
        expect(onOpenPage).toHaveBeenCalledWith('k1');
        expect(onOpenLearn).not.toHaveBeenCalled();
    });

    it('the foot "Open Learn ›" (spoken "Open Learn") opens Learn, and there are exactly two things to tap', () => {
        const onOpenLearn = vi.fn();
        render(<PulseKnowledgeCard card={card([post()])} onOpenPage={vi.fn()} onOpenLearn={onOpenLearn} />);
        const foot = screen.getByTestId('pulse-knowledge-open-learn');
        expect(foot.textContent).toBe('Open Learn ›');
        expect(foot).toBe(screen.getByRole('button', { name: 'Open Learn' }));
        fireEvent.click(foot);
        expect(onOpenLearn).toHaveBeenCalledTimes(1);
        expect(screen.getAllByRole('button')).toHaveLength(2);
    });

    it('no name on a page gathered with the assistant; the topic\'s tile stands in for a missing photo', () => {
        render(<PulseKnowledgeCard card={card([post({ by: 'Ada', gathered: true, topic: 'emergencies' })])} onOpenPage={vi.fn()} onOpenLearn={vi.fn()} />);
        expect(screen.getByTestId('pulse-knowledge-card').textContent).not.toMatch(/by Ada/);
        expect(screen.getByTestId('learn-topic-tile').textContent).toBe('🚨');
    });

    it('draws the page\'s own photo through the web\'s image allow-list, and never an address it refuses', () => {
        const { unmount } = render(<PulseKnowledgeCard card={card([post({ photo: '/uploads/tip.jpg' })])} onOpenPage={vi.fn()} onOpenLearn={vi.fn()} />);
        expect(document.querySelector('img')?.getAttribute('src')).toContain('/uploads/tip.jpg');
        unmount();
        render(<PulseKnowledgeCard card={card([post({ photo: 'http://tracker.example/p.png' })])} onOpenPage={vi.fn()} onOpenLearn={vi.fn()} />);
        expect(document.querySelector('img')).toBeNull();
        expect(screen.getByTestId('learn-topic-tile')).toBeInTheDocument();
    });
});

describe('the knowledge card, several the same day', () => {
    const posts = [
        post({ id: 'a', by: 'Ada' }),
        post({ id: 'b', title: 'Who to call when the river rises', topic: 'emergencies' }),
        post({ id: 'c', title: 'The library\'s opening hours', topic: 'places-history' }),
    ];

    it('heads "{n} new in Local knowledge", three rows each opening its page (spoken "Local knowledge: {title}"), no chip and no name', () => {
        const onOpenPage = vi.fn();
        render(<PulseKnowledgeCard card={card(posts, 8)} onOpenPage={onOpenPage} onOpenLearn={vi.fn()} />);
        expect(screen.getByTestId('pulse-knowledge-head')).toHaveTextContent('8 new in Local knowledge');
        expect(screen.queryByTestId('pulse-knowledge-topic')).toBeNull();
        expect(screen.getByTestId('pulse-knowledge-card').textContent).not.toMatch(/by Ada/);
        const rows = screen.getAllByTestId('pulse-knowledge-row');
        expect(rows.map((r) => r.textContent)).toEqual([
            expect.stringContaining('How recycling works at the tip'),
            expect.stringContaining('Who to call when the river rises'),
            expect.stringContaining('The library\'s opening hours'),
        ]);
        expect(rows[1]).toBe(screen.getByRole('button', { name: 'Local knowledge: Who to call when the river rises' }));
        fireEvent.click(rows[1]);
        expect(onOpenPage).toHaveBeenCalledWith('b');
    });

    it('the head ("{n} new in Local knowledge. Opens Learn."), "and {n} more ›" ("{n} more in Learn") and the foot all open Learn', () => {
        const onOpenLearn = vi.fn();
        const onOpenPage = vi.fn();
        render(<PulseKnowledgeCard card={card(posts, 8)} onOpenPage={onOpenPage} onOpenLearn={onOpenLearn} />);
        const head = screen.getByRole('button', { name: '8 new in Local knowledge. Opens Learn.' });
        expect(head).toBe(screen.getByTestId('pulse-knowledge-head'));
        fireEvent.click(head);
        const more = screen.getByTestId('pulse-knowledge-more');
        expect(more.textContent).toBe('and 5 more ›');
        expect(more).toBe(screen.getByRole('button', { name: '5 more in Learn' }));
        fireEvent.click(more);
        fireEvent.click(screen.getByRole('button', { name: 'Open Learn' }));
        expect(onOpenLearn).toHaveBeenCalledTimes(3);
        expect(onOpenPage).not.toHaveBeenCalled();
        // The head, three rows, "and 5 more ›" and the foot.
        expect(screen.getAllByRole('button')).toHaveLength(6);
    });

    it('two the same day: two rows and no "and {n} more"', () => {
        render(<PulseKnowledgeCard card={card(posts.slice(0, 2))} onOpenPage={vi.fn()} onOpenLearn={vi.fn()} />);
        expect(screen.getByTestId('pulse-knowledge-head')).toHaveTextContent('2 new in Local knowledge');
        expect(screen.getAllByTestId('pulse-knowledge-row')).toHaveLength(2);
        expect(screen.queryByTestId('pulse-knowledge-more')).toBeNull();
    });

    it('a card with no pages draws nothing', () => {
        const { container } = render(<PulseKnowledgeCard card={card([], 0)} onOpenPage={vi.fn()} onOpenLearn={vi.fn()} />);
        expect(container.innerHTML).toBe('');
    });
});

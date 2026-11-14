/**
 * Local knowledge's card on the Pulse in the pseudo-locale (slice KP): every word the card says came through t() / tn(), the
 * phone's keys (core's PULSE_KNOWLEDGE_CARD_WORDS), its spoken lines too. What members wrote (titles, first lines, names) is
 * theirs and shows as written.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { PulseKnowledgeCard as Card, PulseKnowledgePost } from '@beanpool/core';
import { PulseKnowledgeCard } from './PulseKnowledgeCard';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-xx.test-support';

const HOUR = 3600 * 1000;
const post = (over: Partial<PulseKnowledgePost> = {}): PulseKnowledgePost => ({
    id: 'k1', title: 'How recycling works at the tip', topic: 'local-services', line: 'Bring glass, cans and paper sorted.',
    photo: null, by: 'Ada', gathered: false, ...over,
});
const card = (posts: PulseKnowledgePost[], count = posts.length): Card => ({
    id: 'know_2026-11-15', source: 'knowledge', platform: 'beanpool', category: 'knowledge', url: null, thumbnailUrl: null,
    ownerPubkey: '', callsign: '', avatarUrl: null, isVerified: false, title: posts[0]?.title ?? '',
    publishedAt: new Date(Date.now() - 3 * HOUR).toISOString(), knowledge: { count, posts },
});

/** What members wrote: the pages' titles, their first lines, a writer's name. */
const OTHERS = ['How recycling works at the tip', 'Who to call when the river rises', 'The library\'s opening hours', 'Bring glass, cans and paper sorted.', 'Ada'];

afterEach(() => { cleanup(); backToEnglish(); });

describe('the knowledge card in the pseudo-locale', () => {
    it('one page: the head, the time, the topic chip, "by {name}", the foot and the row\'s spoken line', async () => {
        await showIn('xx');
        render(<PulseKnowledgeCard card={card([post()])} onOpenPage={vi.fn()} onOpenLearn={vi.fn()} />);
        expect(bracketed()).toBeGreaterThan(3);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        expect(screen.getByTestId('pulse-knowledge-head')).toHaveTextContent(xx('New local knowledge'));
        expect(screen.getByTestId('pulse-knowledge-head')).toHaveTextContent(xx('{n}h ago').replace('{n}', '3'));
        expect(screen.getByText(xx('by {name}').replace('{name}', 'Ada'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('New local knowledge: {title}. Opens it in Learn.').replace('{title}', 'How recycling works at the tip') })).toBeInTheDocument();
        expect(screen.getByTestId('pulse-knowledge-open-learn')).toHaveTextContent(xx('Open Learn'));
    });

    it('several the same day: the head, three rows, "and {n} more" and the foot\'s spoken line', async () => {
        await showIn('xx');
        const posts = [post({ id: 'a' }), post({ id: 'b', title: 'Who to call when the river rises', by: null }), post({ id: 'c', title: 'The library\'s opening hours', by: null })];
        render(<PulseKnowledgeCard card={card(posts, 6)} onOpenPage={vi.fn()} onOpenLearn={vi.fn()} />);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        expect(screen.getByTestId('pulse-knowledge-head')).toHaveTextContent(xx('{n} new in Local knowledge').replace('{n}', '6'));
        expect(screen.getByTestId('pulse-knowledge-more')).toHaveTextContent(xx('and {n} more').replace('{n}', '3'));
        expect(screen.getByRole('button', { name: xx('{n} new in Local knowledge. Opens Learn.').replace('{n}', '6') })).toBeInTheDocument();
    });

    it('in English nothing is bracketed', () => {
        render(<PulseKnowledgeCard card={card([post()])} onOpenPage={vi.fn()} onOpenLearn={vi.fn()} />);
        expect(bracketed()).toBe(0);
        expect(screen.getByTestId('pulse-knowledge-head')).toHaveTextContent('New local knowledge');
    });
});

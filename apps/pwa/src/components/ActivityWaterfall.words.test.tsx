/**
 * Community activity in the member's language (words S3, web sweep W1): each line is ONE sentence through t(), with the
 * members' names as parts of it (the phone's components/ActivityWaterfall.tsx keys where the English is the same), in
 * the full view, the Live Pulse strip (drawn, screen-reader and hover lines), the empty, loading and members-only
 * states. Names, listing titles and a rating's comment are the members' own, shown as written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-xx.test-support';

let mockFeed: unknown[] = [];
let pending = false;
vi.mock('../lib/api', () => ({
    getActivityFeedApi: vi.fn(async () => (pending ? new Promise(() => {}) : { feed: mockFeed })),
}));
vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));

import { ActivityWaterfall } from './ActivityWaterfall';

const now = new Date().toISOString();
const FEED = [
    { id: 1, eventType: 'member_joined', actorPubkey: 'pk-bob', actorCallsign: 'Bob', createdAt: now },
    { id: 2, eventType: 'trade_completed', actorPubkey: 'pk-sam', actorCallsign: 'Sam', targetPubkey: 'pk-bea', targetCallsign: 'Bea', metadata: { postId: 'post-2', postTitle: 'Bike repair', credits: 12 }, createdAt: now },
    { id: 3, eventType: 'rating_given', actorPubkey: 'pk-rae', actorCallsign: 'Rae', targetPubkey: 'pk-tia', targetCallsign: 'Tia', metadata: { stars: 3, comment: 'Fast and friendly' }, createdAt: now },
    { id: 4, eventType: 'post_created', actorPubkey: 'pk-damo', actorCallsign: 'Damo', metadata: { postId: 'post-1', title: 'Record Fair', credits: 5 }, createdAt: now },
    { id: 5, eventType: 'dispute_resolved', actorPubkey: 'pk-admin', actorCallsign: 'Admin', metadata: {}, createdAt: now },
];
const others = ['Bob', 'Sam', 'Bea', 'Rae', 'Tia', 'Damo', 'Bike repair', 'Fast and friendly', 'Record Fair'];

async function draw(ui: React.ReactElement) {
    await act(async () => { render(ui); });
}

beforeEach(() => { mockFeed = FEED; pending = false; });
afterEach(() => { cleanup(); backToEnglish(); });

describe('community activity in the pseudo-locale', () => {
    it('the full view: every line one sentence, the names theirs', async () => {
        await showIn('xx');
        await draw(<ActivityWaterfall isFullView isMember />);
        expect(await screen.findByText(xx('Recent Community Life'))).toBeInTheDocument();
        expect(screen.getByText('Bob').closest('p')!.textContent).toBe(xx('{actor} joined the community').replace('{actor}', 'Bob'));
        expect(screen.getByText('Sam').closest('p')!.textContent).toBe(`${xx('{actor} completed a trade with {target}').replace('{actor}', 'Sam').replace('{target}', 'Bea')}(🫘 12)`);
        expect(screen.getByRole('img').getAttribute('aria-label')).toBe(xx('{n} out of 5 stars').replace('{n}', '3'));
        expect(bracketed()).toBeGreaterThan(6);
        expect(bypassing(document.body, { others })).toEqual([]);
    });

    it('the Live Pulse strip: the chips, what a screen reader hears and the hover line', async () => {
        await showIn('xx');
        await draw(<ActivityWaterfall isFullView={false} isMember onOpenPost={() => {}} onOpenProfile={() => {}} />);
        expect(await screen.findByText(xx('Live Pulse'))).toBeInTheDocument();
        expect(screen.getAllByRole('button')).toHaveLength(4);
        expect(screen.getByText(xx('Dispute resolved'))).toBeInTheDocument();
        expect(bracketed()).toBeGreaterThan(8);
        expect(bypassing(document.body, { others })).toEqual([]);
    });

    it('a chip with no names falls back to the words for someone', async () => {
        await showIn('xx');
        mockFeed = [{ id: 9, eventType: 'trade_completed', actorPubkey: 'pk-x', createdAt: now }];
        await draw(<ActivityWaterfall isFullView={false} isMember />);
        expect(await screen.findByText(xx('{actor} traded').replace('{actor}', xx('Someone')))).toBeInTheDocument();
        expect(bypassing(document.body)).toEqual([]);
    });

    it('the empty, loading and members-only states', async () => {
        await showIn('xx');
        mockFeed = [];
        await draw(<ActivityWaterfall isFullView isMember />);
        expect(await screen.findByText(xx('Welcome to the Community'))).toBeInTheDocument();
        expect(bypassing(document.body)).toEqual([]);
        cleanup();

        pending = true;
        await draw(<ActivityWaterfall isFullView isMember />);
        expect(screen.getByText(xx('Tuning into community pulse...'))).toBeInTheDocument();
        expect(bypassing(document.body)).toEqual([]);
        cleanup();

        await draw(<ActivityWaterfall isFullView isMember={false} />);
        expect(screen.getByText(xx('Community activity is for members'))).toBeInTheDocument();
        expect(bracketed()).toBe(2);
        expect(bypassing(document.body)).toEqual([]);
    });

    it('in English nothing is bracketed, and the words are as they were', async () => {
        await draw(<ActivityWaterfall isFullView isMember />);
        expect(await screen.findByText('Recent Community Life')).toBeInTheDocument();
        expect(bracketed()).toBe(0);
        expect(screen.getByText('Bob').closest('p')!.textContent).toBe('Bob joined the community');
        expect(screen.getByText('Sam').closest('p')!.textContent).toBe('Sam completed a trade with Bea(🫘 12)');
        expect(screen.getByText('Rae').closest('p')!.textContent).toBe('Rae rated Tia ★★★"Fast and friendly"');
        expect(screen.getByText('Damo').closest('p')!.textContent).toBe('Damo posted "Record Fair" for 🫘 5');
        expect(screen.getByRole('img', { name: '3 out of 5 stars' })).toBeInTheDocument();
        expect(screen.getAllByText('just now').length).toBeGreaterThan(0);
        cleanup();

        await draw(<ActivityWaterfall isFullView={false} isMember onOpenPost={() => {}} onOpenProfile={() => {}} />);
        expect(await screen.findByRole('button', { name: 'Bob joined the community, just now — open' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Rae rated Tia: “Fast and friendly”, just now — open' })).toBeInTheDocument();
        expect(screen.getByText('A trade dispute was resolved, just now')).toHaveClass('sr-only');
        expect(screen.getByText('Sam traded')).toBeInTheDocument();
    });
});

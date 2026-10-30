import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import React from 'react';

/**
 * The full "Recent Community Life" list (Marty, 30 Oct: "we need it clickable"): every row with somewhere to go is one real
 * button that opens it by the same rule as the Live Pulse chips (core's activityTarget); a row with nothing to open stays text.
 */
const now = new Date().toISOString();
const items = {
    joined: { id: 10, eventType: 'member_joined', actorPubkey: 'pk-bob', actorCallsign: 'Bob', metadata: {}, createdAt: now },
    posted: { id: 11, eventType: 'post_created', actorPubkey: 'pk-damo', actorCallsign: 'Damo', metadata: { postId: 'post-1', title: 'Record Fair' }, createdAt: now },
    traded: {
        id: 12, eventType: 'trade_completed', actorPubkey: 'pk-sam', actorCallsign: 'Sam', targetPubkey: 'pk-bea', targetCallsign: 'Bea',
        metadata: { postId: 'post-2', credits: 12 }, createdAt: now,
    },
    tradedNoListing: {
        id: 13, eventType: 'trade_completed', actorPubkey: 'pk-sam', actorCallsign: 'Sam', targetPubkey: 'pk-bea', targetCallsign: 'Bea',
        metadata: { credits: 12 }, createdAt: now,
    },
    rated: {
        id: 14, eventType: 'rating_given', actorPubkey: 'pk-rae', actorCallsign: 'Rae', targetPubkey: 'pk-tia', targetCallsign: 'Tia',
        metadata: { stars: 3, comment: 'Fast and friendly' }, createdAt: now,
    },
    postedNoId: { id: 15, eventType: 'post_created', actorPubkey: 'pk-damo', actorCallsign: 'Damo', metadata: { title: 'Old listing' }, createdAt: now },
    dispute: { id: 16, eventType: 'dispute_resolved', actorPubkey: 'pk-admin', actorCallsign: 'Admin', targetPubkey: 'pk-bea', metadata: { postId: 'post-3' }, createdAt: now },
};
let mockFeed: any[] = [];

vi.mock('../lib/api', () => ({
    getActivityFeedApi: vi.fn(async () => ({ feed: mockFeed })),
}));
vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));

import { ActivityWaterfall } from './ActivityWaterfall';

describe('ActivityWaterfall full list rows', () => {
    let onOpenPost: ReturnType<typeof vi.fn>;
    let onOpenProfile: ReturnType<typeof vi.fn>;

    async function renderFull(props: Partial<React.ComponentProps<typeof ActivityWaterfall>> = {}) {
        let container!: HTMLElement;
        await act(async () => {
            ({ container } = render(<ActivityWaterfall isFullView={true} isMember={true} onOpenPost={onOpenPost} onOpenProfile={onOpenProfile} {...props} />));
        });
        return container;
    }

    beforeEach(() => {
        onOpenPost = vi.fn();
        onOpenProfile = vi.fn();
        mockFeed = [];
    });

    it('a post row opens that post, and its name is the row\'s own sentence', async () => {
        mockFeed = [items.posted];
        await renderFull();
        const row = await screen.findByRole('button', { name: /Damo posted "Record Fair"/ });
        fireEvent.click(row);
        expect(onOpenPost).toHaveBeenCalledWith('post-1');
        expect(onOpenProfile).not.toHaveBeenCalled();
    });

    it('a joined row opens the member\'s profile', async () => {
        mockFeed = [items.joined];
        await renderFull();
        fireEvent.click(await screen.findByRole('button', { name: /Bob joined the community/ }));
        expect(onOpenProfile).toHaveBeenCalledWith('pk-bob');
        expect(onOpenPost).not.toHaveBeenCalled();
    });

    it('a trade opens its listing; with no listing it opens the other member', async () => {
        mockFeed = [items.traded];
        await renderFull();
        fireEvent.click(await screen.findByRole('button', { name: /Sam completed a trade with Bea/ }));
        expect(onOpenPost).toHaveBeenCalledWith('post-2');

        mockFeed = [items.tradedNoListing];
        document.body.innerHTML = '';
        await renderFull();
        fireEvent.click(await screen.findByRole('button', { name: /Sam completed a trade with Bea/ }));
        expect(onOpenProfile).toHaveBeenCalledWith('pk-bea');
    });

    it('a rating opens the rated member, and the stars stay readable in its name', async () => {
        mockFeed = [items.rated];
        await renderFull();
        const row = await screen.findByRole('button', { name: /Rae rated Tia.*3 out of 5 stars/ });
        fireEvent.click(row);
        expect(onOpenProfile).toHaveBeenCalledWith('pk-tia');
    });

    it('a rating the viewer received opens the rater, not the viewer\'s own profile', async () => {
        mockFeed = [items.rated];
        await renderFull({ viewerPubkey: 'pk-tia' });
        fireEvent.click(await screen.findByRole('button', { name: /Rae rated Tia/ }));
        expect(onOpenProfile).toHaveBeenCalledWith('pk-rae');
        expect(onOpenProfile).not.toHaveBeenCalledWith('pk-tia');
    });

    it('a row with no target is not a button', async () => {
        mockFeed = [items.postedNoId, items.dispute];
        const container = await renderFull();
        expect(await screen.findByText('Old listing')).toBeTruthy();
        expect(screen.queryByRole('button')).toBeNull();
        expect(container.querySelector('.cursor-pointer')).toBeNull();
        // The admin who ruled is never put in front of the members.
        expect(container.textContent).not.toContain('Admin');
    });

    it('every actionable row is a real, focusable, 44 px button', async () => {
        mockFeed = [items.joined, items.posted, items.traded, items.rated, items.postedNoId, items.dispute];
        const container = await renderFull();
        const rows = await screen.findAllByRole('button');
        expect(rows).toHaveLength(4);
        for (const row of rows) {
            expect(row.tagName).toBe('BUTTON');
            expect(row.getAttribute('tabindex')).toBeNull();
            expect(row.className).toContain('min-h-[44px]');
        }
        // The six rows are all still there; only four are controls.
        expect(container.querySelectorAll('.space-y-2\\.5 > *')).toHaveLength(6);
    });

    it('without handlers no row pretends to be a control (a caller that passes none)', async () => {
        mockFeed = [items.joined, items.posted];
        await renderFull({ onOpenPost: undefined, onOpenProfile: undefined });
        expect(await screen.findByText('Bob')).toBeTruthy();
        expect(screen.queryByRole('button')).toBeNull();
    });

    it('a visitor is unchanged: no fetch, no rows, no buttons', async () => {
        await renderFull({ isMember: false });
        expect(screen.getByText('Community activity is for members')).toBeTruthy();
        expect(screen.queryByRole('button')).toBeNull();
    });

    it('the compact strip still opens a post', async () => {
        mockFeed = [items.posted];
        await renderFull({ isFullView: false });
        fireEvent.click(await screen.findByRole('button', { name: /Damo posted: Record Fair/ }));
        expect(onOpenPost).toHaveBeenCalledWith('post-1');
    });
});

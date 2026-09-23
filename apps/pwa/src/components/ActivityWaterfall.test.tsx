import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import React from 'react';

// The node serves /api/activity/feed to members only. A guest must not be sent to fetch a 403 on
// every poll, and must not be told "you're among the first here, create an offer" either.
const mockJoinItem = {
    id: 1,
    eventType: 'member_joined',
    actorPubkey: 'pk',
    actorCallsign: 'Bob',
    createdAt: new Date().toISOString(),
};
let mockFeed: any[] = [mockJoinItem];

vi.mock('../lib/api', () => ({
    getActivityFeedApi: vi.fn(async () => ({ feed: mockFeed })),
}));
vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));

import { getActivityFeedApi } from '../lib/api';
import { ActivityWaterfall } from './ActivityWaterfall';

describe('ActivityWaterfall membership', () => {
    beforeEach(() => {
        (getActivityFeedApi as any).mockClear();
        mockFeed = [mockJoinItem];
    });

    it('a guest never fetches the feed and the full view says it is for members', async () => {
        await act(async () => {
            render(<ActivityWaterfall isFullView={true} isMember={false} />);
        });
        expect(getActivityFeedApi).not.toHaveBeenCalled();
        expect(screen.getByText('Community activity is for members')).toBeTruthy();
        expect(screen.queryByText(/among the first here/)).toBeNull();
    });

    it('a guest sees no compact strip at all', async () => {
        let container!: HTMLElement;
        await act(async () => {
            ({ container } = render(<ActivityWaterfall isFullView={false} isMember={false} />));
        });
        expect(getActivityFeedApi).not.toHaveBeenCalled();
        expect(container.innerHTML).toBe('');
    });

    it('waits while membership is unknown, then fetches once it is confirmed', async () => {
        let rerender!: (ui: React.ReactElement) => void;
        await act(async () => {
            ({ rerender } = render(<ActivityWaterfall isFullView={true} isMember={null} />));
        });
        expect(getActivityFeedApi).not.toHaveBeenCalled();
        await act(async () => {
            rerender(<ActivityWaterfall isFullView={true} isMember={true} />);
        });
        expect(getActivityFeedApi).toHaveBeenCalledTimes(1);
        expect(await screen.findByText('Bob')).toBeTruthy();
    });
});

/**
 * Live Pulse strip: every item with somewhere to go is a real control, and a chip reveals the rest
 * of its line on hover or keyboard focus (Damo, 2026-09-23).
 */
describe('ActivityWaterfall Live Pulse strip', () => {
    const now = new Date().toISOString();

    const items = {
        joined: {
            id: 10,
            eventType: 'member_joined',
            actorPubkey: 'pk-bob',
            actorCallsign: 'Bob',
            metadata: { callsign: 'Bob' },
            createdAt: now,
        },
        posted: {
            id: 11,
            eventType: 'post_created',
            actorPubkey: 'pk-damo',
            actorCallsign: 'Damo',
            metadata: { postId: 'post-1', title: 'Record Fair', type: 'offer' },
            createdAt: now,
        },
        traded: {
            id: 12,
            eventType: 'trade_completed',
            actorPubkey: 'pk-sam',
            actorCallsign: 'Sam',
            targetPubkey: 'pk-bea',
            targetCallsign: 'Bea',
            metadata: { postId: 'post-2', postTitle: 'Bike repair', credits: 12 },
            createdAt: now,
        },
        rated: {
            id: 13,
            eventType: 'rating_given',
            actorPubkey: 'pk-rae',
            actorCallsign: 'Rae',
            targetPubkey: 'pk-tia',
            targetCallsign: 'Tia',
            metadata: { stars: 3, comment: 'Fast and friendly' },
            createdAt: now,
        },
        dispute: {
            id: 14,
            eventType: 'dispute_resolved',
            actorPubkey: 'pk-admin',
            actorCallsign: 'Admin',
            targetPubkey: 'pk-bea',
            targetCallsign: 'Bea',
            metadata: { postId: 'post-3', resolution: 'refund' },
            createdAt: now,
        },
    };

    let onOpenPost: ReturnType<typeof vi.fn>;
    let onOpenProfile: ReturnType<typeof vi.fn>;

    async function renderStrip() {
        let container!: HTMLElement;
        await act(async () => {
            ({ container } = render(
                <ActivityWaterfall
                    isFullView={false}
                    isMember={true}
                    onOpenPost={onOpenPost}
                    onOpenProfile={onOpenProfile}
                />
            ));
        });
        return container;
    }

    /** jsdom lays nothing out, so the widths that decide whether a chip can scroll are stated here. */
    function setWidths(chip: Element, { track, viewport }: { track: number; viewport: number }) {
        const viewportEl = chip.querySelector('.pulse-chip-viewport')!;
        const trackEl = chip.querySelector('.pulse-chip-track')!;
        Object.defineProperty(viewportEl, 'clientWidth', { value: viewport, configurable: true });
        Object.defineProperty(trackEl, 'scrollWidth', { value: track, configurable: true });
        return viewportEl;
    }

    beforeEach(() => {
        (getActivityFeedApi as any).mockClear();
        onOpenPost = vi.fn();
        onOpenProfile = vi.fn();
        mockFeed = [mockJoinItem];
    });

    afterEach(() => {
        delete (window as any).matchMedia;
    });

    it('a member joining opens their profile', async () => {
        mockFeed = [items.joined];
        await renderStrip();
        const chip = await screen.findByRole('button', { name: /Bob joined the community/ });
        fireEvent.click(chip);
        expect(onOpenProfile).toHaveBeenCalledWith('pk-bob');
        expect(onOpenPost).not.toHaveBeenCalled();
    });

    it('a post opens that post', async () => {
        mockFeed = [items.posted];
        await renderStrip();
        const chip = await screen.findByRole('button', { name: /Damo posted: Record Fair/ });
        fireEvent.click(chip);
        expect(onOpenPost).toHaveBeenCalledWith('post-1');
        expect(onOpenProfile).not.toHaveBeenCalled();
    });

    it('a completed trade opens the listing it carries', async () => {
        mockFeed = [items.traded];
        await renderStrip();
        const chip = await screen.findByRole('button', { name: /Sam traded with Bea: Bike repair/ });
        fireEvent.click(chip);
        expect(onOpenPost).toHaveBeenCalledWith('post-2');
    });

    it('a completed trade with no listing opens the other member', async () => {
        mockFeed = [{ ...items.traded, metadata: { credits: 12 } }];
        await renderStrip();
        const chip = await screen.findByRole('button', { name: /Sam traded with Bea/ });
        fireEvent.click(chip);
        expect(onOpenProfile).toHaveBeenCalledWith('pk-bea');
        expect(onOpenPost).not.toHaveBeenCalled();
    });

    it('a rating opens the rated member, the item carrying no listing', async () => {
        mockFeed = [items.rated];
        await renderStrip();
        const chip = await screen.findByRole('button', { name: /Rae rated Tia/ });
        fireEvent.click(chip);
        expect(onOpenProfile).toHaveBeenCalledWith('pk-tia');
        expect(onOpenPost).not.toHaveBeenCalled();
    });

    it('every chip with a destination is focusable', async () => {
        mockFeed = [items.joined, items.posted, items.traded, items.rated];
        await renderStrip();
        const chips = await screen.findAllByRole('button');
        expect(chips).toHaveLength(4);
        for (const chip of chips) {
            expect(chip.tagName).toBe('BUTTON');
            // A <button> is in the tab order; nothing here may take it back out.
            expect(chip.getAttribute('tabindex')).toBeNull();
            expect(chip).not.toBeDisabled();
        }
    });

    it('an item with nothing to open is not a button', async () => {
        mockFeed = [items.dispute];
        let container!: HTMLElement;
        await act(async () => {
            ({ container } = render(
                <ActivityWaterfall
                    isFullView={false}
                    isMember={true}
                    onOpenPost={onOpenPost}
                    onOpenProfile={onOpenProfile}
                />
            ));
        });
        expect(await screen.findByText('Dispute resolved')).toBeTruthy();
        expect(screen.queryByRole('button')).toBeNull();
        expect(container.querySelector('.pulse-chip-viewport')).toBeTruthy();
        // It must not be dressed up as one either, nor name the admin who ruled.
        expect(container.querySelector('.cursor-pointer')).toBeNull();
        expect(container.textContent).not.toContain('Admin');
    });

    it('hover and focus scroll a chip only when its full line overflows', async () => {
        mockFeed = [items.posted];
        const container = await renderStrip();
        const chip = await screen.findByRole('button', { name: /Damo posted: Record Fair/ });
        const viewport = setWidths(chip, { track: 220, viewport: 90 });

        expect(viewport.classList.contains('is-scrolling')).toBe(false);

        fireEvent.mouseOver(chip);
        expect(viewport.classList.contains('is-scrolling')).toBe(true);
        expect((viewport as HTMLElement).style.getPropertyValue('--pulse-overflow')).toBe('130px');

        fireEvent.mouseOut(chip);
        expect(viewport.classList.contains('is-scrolling')).toBe(false);

        fireEvent.focus(chip);
        expect(viewport.classList.contains('is-scrolling')).toBe(true);

        fireEvent.blur(chip);
        expect(viewport.classList.contains('is-scrolling')).toBe(false);
        expect(container.querySelectorAll('.is-scrolling')).toHaveLength(0);
    });

    it('a chip whose line fits never scrolls', async () => {
        mockFeed = [items.joined];
        await renderStrip();
        const chip = await screen.findByRole('button', { name: /Bob joined the community/ });
        const viewport = setWidths(chip, { track: 80, viewport: 80 });

        fireEvent.mouseOver(chip);
        expect(viewport.classList.contains('is-scrolling')).toBe(false);
        fireEvent.focus(chip);
        expect(viewport.classList.contains('is-scrolling')).toBe(false);
    });

    it('under prefers-reduced-motion nothing scrolls and the full line is a tooltip', async () => {
        (window as any).matchMedia = vi.fn((query: string) => ({
            matches: query.includes('prefers-reduced-motion'),
            media: query,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        }));

        mockFeed = [items.posted];
        await renderStrip();
        const chip = await screen.findByRole('button', { name: /Damo posted: Record Fair/ });
        const viewport = setWidths(chip, { track: 220, viewport: 90 });

        fireEvent.mouseOver(chip);
        expect(viewport.classList.contains('is-scrolling')).toBe(false);
        fireEvent.focus(chip);
        expect(viewport.classList.contains('is-scrolling')).toBe(false);
        expect(chip.getAttribute('title')).toBe('Damo posted: Record Fair');
    });
});

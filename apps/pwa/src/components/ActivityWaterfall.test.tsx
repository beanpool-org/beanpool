import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';

// The node serves /api/activity/feed to members only. A guest must not be sent to fetch a 403 on
// every poll, and must not be told "you're among the first here, create an offer" either.
vi.mock('../lib/api', () => ({
    getActivityFeedApi: vi.fn(async () => ({
        feed: [{ id: 1, eventType: 'member_joined', actorPubkey: 'pk', actorCallsign: 'Bob', createdAt: new Date().toISOString() }],
    })),
}));
vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));

import { getActivityFeedApi } from '../lib/api';
import { ActivityWaterfall } from './ActivityWaterfall';

describe('ActivityWaterfall membership', () => {
    beforeEach(() => {
        (getActivityFeedApi as any).mockClear();
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

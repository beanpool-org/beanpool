import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { ModerationPauseCard, pausedUntil, isUntilLifted } from './ModerationPauseCard';
import * as api from '../lib/api';
import type { CommunityStanding } from '../lib/api';

const standing = (mute: CommunityStanding['mute']): CommunityStanding => ({
    publicKey: 'me',
    probation: { onProbation: false, exemptBecause: 'off', ageEndsAt: null, keptPosts: 0, keptPostsNeeded: 3,
        limits: { posts: { limit: 3, used: 0, resetsAt: null }, photos: { limit: 5, used: 0, resetsAt: null }, new_dm_recipients: { limit: 10, used: 0, resetsAt: null } } },
    mute,
});
const DAY = 24 * 60 * 60 * 1000;

describe('ModerationPauseCard: "Posting paused" (GET /api/community/me mute)', () => {
    beforeEach(() => { vi.restoreAllMocks(); });

    it('paused until a moderator lifts it: says so plainly, and what they can still do', async () => {
        vi.spyOn(api, 'getCommunityMe').mockResolvedValue(standing({ muted: true, until: '9999-12-31T23:59:59.999Z' }));
        render(<ModerationPauseCard />);
        const card = await screen.findByTestId('moderation-pause-card');
        expect(screen.getByRole('heading', { name: /Posting paused/ })).toBeInTheDocument();
        expect(screen.getByTestId('moderation-pause-until')).toHaveTextContent(
            'The community’s moderators have paused your posting. You can’t post or send messages here until a moderator lifts this.');
        expect(card).toHaveTextContent('You can still read, edit your profile and leave.');
    });

    it('paused until a time: says when, and how long that is', async () => {
        const until = new Date(Date.now() + 3 * DAY).toISOString();
        vi.spyOn(api, 'getCommunityMe').mockResolvedValue(standing({ muted: true, until }));
        render(<ModerationPauseCard />);
        const line = await screen.findByTestId('moderation-pause-until');
        expect(line).toHaveTextContent(/You can’t post or send messages here until .+ \(in about 3 days\)\./);
        expect(line).not.toHaveTextContent('a moderator lifts this');
    });

    it('renders nothing when not paused, for an older node (404), or offline', async () => {
        for (const answer of [
            () => Promise.resolve(standing({ muted: false, until: null })),
            () => Promise.reject(Object.assign(new Error('Request failed: 404'), { status: 404 })),
            () => Promise.reject(new Error('Failed to fetch')),
        ]) {
            const spy = vi.spyOn(api, 'getCommunityMe').mockImplementation(answer);
            const { unmount } = render(<ModerationPauseCard />);
            await waitFor(() => expect(spy).toHaveBeenCalled());
            await new Promise(r => setTimeout(r, 10));
            expect(screen.queryByTestId('moderation-pause-card')).toBeNull();
            unmount();
            spy.mockRestore();
        }
    });

    it('reads again when told to (a pause or a lift was just shown)', async () => {
        const spy = vi.spyOn(api, 'getCommunityMe').mockResolvedValue(standing({ muted: false, until: null }));
        const { rerender } = render(<ModerationPauseCard refreshKey={0} />);
        await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
        spy.mockResolvedValue(standing({ muted: true, until: '9999-12-31T23:59:59.999Z' }));
        rerender(<ModerationPauseCard refreshKey={1} />);
        expect(await screen.findByTestId('moderation-pause-card')).toBeInTheDocument();
    });

    it('words the end of a pause from the node\'s value', () => {
        expect(isUntilLifted('9999-12-31T23:59:59.999Z')).toBe(true);
        expect(isUntilLifted(null)).toBe(true);
        expect(isUntilLifted('not a date')).toBe(true);
        expect(pausedUntil('9999-12-31T23:59:59.999Z')).toBe('until a moderator lifts this');
        const now = Date.parse('2026-09-26T00:00:00.000Z');
        expect(pausedUntil('2026-09-26T05:00:00.000Z', now)).toMatch(/^until .+ \(in about 5 hours\)$/);
    });
});

import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { NewAccountCard, inAbout, ruleSentence } from './NewAccountCard';
import * as api from '../lib/api';
import type { CommunityStanding } from '../lib/api';

const HOUR = 60 * 60 * 1000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

function standing(over: Partial<CommunityStanding['probation']> = {}): CommunityStanding {
    return {
        publicKey: 'me',
        probation: {
            onProbation: true,
            exemptBecause: null,
            ageEndsAt: inHours(50),
            keptPosts: 1,
            keptPostsNeeded: 3,
            limits: {
                posts: { limit: 3, used: 1, remaining: 2, resetsAt: inHours(5) },
                photos: { limit: 5, used: 5, remaining: 0, resetsAt: inHours(5) },
                new_dm_recipients: { limit: 10, used: 0, remaining: 10, resetsAt: null },
            },
            endsWhen: { hours: 72, keptPosts: 3 },
            ...over,
        },
        mute: { muted: false, until: null },
    };
}

describe('NewAccountCard: "Your account is new" (G11-e)', () => {
    beforeEach(() => { vi.restoreAllMocks(); });

    it('on probation: each limit with what is left and when more comes back, and the rule in #1133\'s words', async () => {
        vi.spyOn(api, 'getCommunityMe').mockResolvedValue(standing());
        render(<NewAccountCard />);
        const card = await screen.findByTestId('new-account-card');
        expect(within(card).getByRole('heading', { name: /Your account is new/ })).toBeInTheDocument();

        const posts = within(card).getByTestId('new-account-limit-posts');
        expect(posts).toHaveTextContent('Posts');
        expect(posts).toHaveTextContent('2 of 3 left');
        expect(posts).toHaveTextContent('One more comes back in about 5 hours.');

        // None left: the node's own phrasing for when it lets up.
        const photos = within(card).getByTestId('new-account-limit-photos');
        expect(photos).toHaveTextContent('0 of 5 left');
        expect(photos).toHaveTextContent('You can add more in about 5 hours.');

        // Nothing used: nothing to come back.
        const dms = within(card).getByTestId('new-account-limit-new_dm_recipients');
        expect(dms).toHaveTextContent('New people to message');
        expect(dms).toHaveTextContent('10 of 10 left');
        expect(dms).not.toHaveTextContent('comes back');

        const rule = within(card).getByTestId('new-account-rule');
        expect(rule).toHaveTextContent('New accounts have these limits for their first 3 days, and until 3 of their posts have stayed up.');
        expect(rule).toHaveTextContent('Your first 3 days end in about 2 days.');
        expect(rule).toHaveTextContent('So far 1 of your posts has stayed up, of the 3 needed.');
        expect(card).toHaveTextContent('Replying to someone who wrote to you first is never limited.');
    });

    it('builds the rule from the node\'s numbers, not a sentence baked into the app', () => {
        expect(ruleSentence({ ...standing().probation, endsWhen: { hours: 48, keptPosts: 5 } }))
            .toBe('New accounts have these limits for their first 2 days, and until 5 of their posts have stayed up.');
        // An older node without endsWhen: its 72 hours, and the kept posts it does send.
        expect(ruleSentence({ ...standing().probation, endsWhen: undefined, keptPostsNeeded: 3 }))
            .toBe('New accounts have these limits for their first 3 days, and until 3 of their posts have stayed up.');
    });

    it('an older node without `remaining` (#1133): what is left comes from limit less used, and none left still reads as none', async () => {
        vi.spyOn(api, 'getCommunityMe').mockResolvedValue(standing({
            limits: {
                posts: { limit: 3, used: 1, resetsAt: inHours(5) },
                photos: { limit: 5, used: 5, resetsAt: inHours(5) },
                new_dm_recipients: { limit: 10, used: 0, resetsAt: null },
            },
        }));
        render(<NewAccountCard />);
        const card = await screen.findByTestId('new-account-card');

        const posts = within(card).getByTestId('new-account-limit-posts');
        expect(posts).toHaveTextContent('2 of 3 left');
        expect(posts).toHaveTextContent('One more comes back in about 5 hours.');

        const photos = within(card).getByTestId('new-account-limit-photos');
        expect(photos).toHaveTextContent('0 of 5 left');
        expect(photos).toHaveTextContent('You can add more in about 5 hours.');
        expect(photos).not.toHaveTextContent('One more comes back');
        expect(photos.querySelector('.whitespace-nowrap')).toHaveClass('font-bold', 'text-amber-700');

        expect(within(card).getByTestId('new-account-limit-new_dm_recipients')).toHaveTextContent('10 of 10 left');
    });

    it('says the first days are over once they are, while the kept posts still hold it', async () => {
        vi.spyOn(api, 'getCommunityMe').mockResolvedValue(standing({ ageEndsAt: inHours(-1), keptPosts: 2 }));
        render(<NewAccountCard />);
        expect(await screen.findByTestId('new-account-rule')).toHaveTextContent('Your first 3 days are over. So far 2 of your posts have stayed up, of the 3 needed.');
    });

    it('shows nothing once the node says probation is over, is off here, or the member holds a role', async () => {
        for (const over of [
            { onProbation: false, exemptBecause: null },
            { onProbation: false, exemptBecause: 'off' as const },
            { onProbation: false, exemptBecause: 'role' as const },
        ]) {
            const read = vi.spyOn(api, 'getCommunityMe').mockResolvedValue(standing(over));
            const { container, unmount } = render(<NewAccountCard />);
            await waitFor(() => expect(read).toHaveBeenCalled());
            await Promise.resolve();
            expect(container).toBeEmptyDOMElement();
            unmount();
            vi.restoreAllMocks();
        }
    });

    it('shows nothing when the read fails: an older node (404), a guest (403), offline', async () => {
        for (const status of [404, 403, undefined]) {
            const err = Object.assign(new Error('nope'), status ? { status } : {});
            const read = vi.spyOn(api, 'getCommunityMe').mockRejectedValue(err);
            const { container, unmount } = render(<NewAccountCard />);
            await waitFor(() => expect(read).toHaveBeenCalled());
            await Promise.resolve();
            expect(container).toBeEmptyDOMElement();
            unmount();
            vi.restoreAllMocks();
        }
    });

    it('has a close button only where one is given, and reads again when refreshKey changes', async () => {
        const read = vi.spyOn(api, 'getCommunityMe').mockResolvedValue(standing());
        const onClose = vi.fn();
        const { rerender } = render(<NewAccountCard onClose={onClose} refreshKey={1} />);
        await screen.findByTestId('new-account-card');
        fireEvent.click(screen.getByRole('button', { name: 'Hide this for now' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        rerender(<NewAccountCard onClose={onClose} refreshKey={2} />);
        await waitFor(() => expect(read).toHaveBeenCalledTimes(2));

        rerender(<NewAccountCard refreshKey={2} />);
        expect(screen.queryByRole('button', { name: 'Hide this for now' })).toBeNull();
    });

    it('fits a 320px screen at 1.3x text: labels wrap, and nothing asks for a sideways scroll', async () => {
        vi.spyOn(api, 'getCommunityMe').mockResolvedValue(standing());
        render(<NewAccountCard onClose={() => {}} />);
        const card = await screen.findByTestId('new-account-card');
        expect(card).toHaveClass('min-w-0');
        expect(card.className).not.toMatch(/\b(w-\[\d+px\]|min-w-\[\d+px\]|overflow-x-(auto|scroll))\b/);
        for (const row of card.querySelectorAll('li')) {
            expect(row.firstElementChild).toHaveClass('flex-wrap');
            // Only the short "2 of 3 left" keeps to one line; the labels and sentences wrap.
            expect(row.querySelectorAll('.whitespace-nowrap').length).toBeLessThanOrEqual(1);
            expect(row.querySelector('.whitespace-nowrap')?.textContent).toMatch(/^\d+ of \d+ left$/);
        }
        for (const p of card.querySelectorAll('p')) expect(p).toHaveClass('break-words');
    });

    it('inAbout reads like the node\'s refusals', () => {
        const now = Date.parse('2026-09-26T00:00:00Z');
        expect(inAbout('2026-09-26T00:00:30Z', now)).toBe('in about a minute');
        expect(inAbout('2026-09-26T00:20:00Z', now)).toBe('in about 20 minutes');
        expect(inAbout('2026-09-26T01:00:00Z', now)).toBe('in about an hour');
        expect(inAbout('2026-09-26T05:00:00Z', now)).toBe('in about 5 hours');
        expect(inAbout('2026-09-28T02:00:00Z', now)).toBe('in about 2 days');
    });
});

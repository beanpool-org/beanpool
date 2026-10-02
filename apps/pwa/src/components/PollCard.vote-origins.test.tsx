/**
 * Where a poll's votes came from (FABLE-sec-global-abuse LOW-7): on the global community the node says how many of a
 * public poll's votes came from new or 12-word accounts, and, with enough on each side, how many of each answer's
 * (apps/server engine/probation.ts pollVotesFromNewOrWords), once an anonymous poll has closed. The card says so in
 * @beanpool/core's words, and only then: never while the poll is open, never on an open vote, whatever arrives. Every vote
 * still counts and shows; nobody is named; nothing is said where the node says nothing.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PollCard } from './PollCard';
import * as api from '../lib/api';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return { ...actual, votePoll: vi.fn(), closePoll: vi.fn() };
});

const identity: any = { publicKey: 'voter_me', privateKey: 'priv_me', callsign: 'Me' };

function poll(extra: Record<string, unknown> = {}, options?: any[]): any {
    return {
        id: 'post_poll_origins', type: 'poll', category: 'community', title: 'Should the lobby have a weekly swap day?',
        authorPublicKey: 'author_pk', authorCallsign: 'Pia', createdAt: new Date().toISOString(), status: 'completed', active: true,
        credits: 0, priceType: 'fixed', repeatable: false, pollOpenVote: false,
        // Closed: its time has passed. The node says where the votes came from only then.
        pollClosesAt: new Date(Date.now() - 86_400_000).toISOString(),
        pollOptions: options ?? [
            { id: 'opt_yes', text: 'Yes', votes: 7, percentage: 58, newOrWordsVotes: 4 },
            { id: 'opt_no', text: 'No', votes: 3, percentage: 25, newOrWordsVotes: 1 },
            { id: 'opt_maybe', text: 'Maybe', votes: 2, percentage: 17, newOrWordsVotes: 0 },
        ],
        totalVotes: 12,
        pollNewOrWordsVotes: 5,
        ...extra,
    };
}
const optionButton = (text: string) => screen.getByText(text).closest('button') as HTMLElement;
/** The same poll still open, as it reads before its time is up. */
const OPEN = { status: 'active', pollClosesAt: new Date(Date.now() + 7 * 86_400_000).toISOString() };

describe('PollCard: where the votes came from', () => {
    afterEach(() => { document.documentElement.style.fontSize = ''; });

    it('once closed, the poll says how many of its votes came from new or 12-word accounts, and each answer its own share', () => {
        render(<PollCard post={poll()} identity={identity} informal />);
        expect(screen.getByTestId('poll-vote-origins')).toHaveTextContent('5 of 12 votes came from new or 12-word accounts');
        expect(within(optionButton('Yes')).getByTestId('poll-option-origins')).toHaveTextContent('4 of these 7 from new or 12-word accounts');
        expect(within(optionButton('No')).getByTestId('poll-option-origins')).toHaveTextContent('1 of these 3 from a new or 12-word account');
        // An answer none of them chose says nothing.
        expect(within(optionButton('Maybe')).queryByTestId('poll-option-origins')).toBeNull();
        // Every vote still shows: the counts and the turnout are the node's, untouched.
        expect(screen.getByText('58%')).toBeInTheDocument();
        expect(screen.getByText('(7)')).toBeInTheDocument();
        expect(screen.getByText(/12 votes cast/)).toBeInTheDocument();
        // A screen reader hears an answer's share with the answer.
        expect(optionButton('Yes')).toHaveAccessibleName(/Yes.*58%.*\(7\).*4 of these 7 from new or 12-word accounts/);
    });

    it('without the split (too few on one side), the total only', () => {
        const opts = [
            { id: 'opt_yes', text: 'Yes', votes: 3, percentage: 60 },
            { id: 'opt_no', text: 'No', votes: 2, percentage: 40 },
        ];
        render(<PollCard post={poll({ totalVotes: 5, pollNewOrWordsVotes: 1 }, opts)} identity={identity} informal />);
        expect(screen.getByTestId('poll-vote-origins')).toHaveTextContent('1 of 5 votes came from a new or 12-word account');
        expect(screen.queryAllByTestId('poll-option-origins')).toHaveLength(0);
    });

    it('nothing where none came from them, or the node says nothing (a local community, a group\'s poll)', () => {
        const none = render(<PollCard post={poll({ pollNewOrWordsVotes: 0 }, [{ id: 'opt_yes', text: 'Yes', votes: 12, percentage: 100, newOrWordsVotes: 0 }])} identity={identity} informal />);
        expect(screen.queryByTestId('poll-vote-origins')).toBeNull();
        expect(screen.queryAllByTestId('poll-option-origins')).toHaveLength(0);
        none.unmount();
        const { pollNewOrWordsVotes: _n, ...local } = poll({}, [{ id: 'opt_yes', text: 'Yes', votes: 7, percentage: 58 }, { id: 'opt_no', text: 'No', votes: 5, percentage: 42 }]);
        render(<PollCard post={local} identity={identity} />);
        expect(screen.queryByTestId('poll-vote-origins')).toBeNull();
        expect(screen.queryAllByTestId('poll-option-origins')).toHaveLength(0);
        expect(screen.queryByText(/12-word/)).toBeNull();
    });

    it('while the poll is open, nothing about where the votes came from, whatever arrives: no line, no placeholder', () => {
        // Its own close button, or its time: either way the card is open now. Even a count that came with it (an older node,
        // an old cached copy) says nothing, so re-reading after each vote can't say each vote's kind.
        for (const extra of [OPEN, { status: 'active', pollClosesAt: undefined }]) {
            const view = render(<PollCard post={poll(extra)} identity={identity} informal />);
            expect(screen.queryByTestId('poll-vote-origins')).toBeNull();
            expect(screen.queryAllByTestId('poll-option-origins')).toHaveLength(0);
            expect(document.body.textContent).not.toMatch(/12-word|new account|came from/);
            // Every vote still shows.
            expect(screen.getByText('(7)')).toBeInTheDocument();
            view.unmount();
        }
        render(<PollCard post={poll(OPEN)} visitor informal />);
        expect(document.body.textContent).not.toMatch(/12-word|new account|came from/);
    });

    it('never on an open vote, open or closed: it names its voters, so a count of kinds would say which each is', () => {
        const voters = [{ voterPubkey: 'v1', voterCallsign: 'Quill', optionId: 'opt_yes', createdAt: new Date().toISOString() }];
        for (const extra of [{ pollOpenVote: true, pollVotes: voters }, { ...OPEN, pollOpenVote: true, pollVotes: voters }]) {
            const view = render(<PollCard post={poll(extra)} identity={identity} informal />);
            expect(screen.queryByTestId('poll-vote-origins')).toBeNull();
            expect(screen.queryAllByTestId('poll-option-origins')).toHaveLength(0);
            expect(document.body.textContent).not.toMatch(/12-word|came from/);
            view.unmount();
        }
    });

    it('a visitor reads the same lines', () => {
        render(<PollCard post={poll()} visitor informal />);
        expect(screen.getByTestId('poll-vote-origins')).toHaveTextContent('5 of 12 votes came from new or 12-word accounts');
        expect(screen.getAllByTestId('poll-option-origins').map(e => e.textContent)).toEqual([
            '4 of these 7 from new or 12-word accounts', '1 of these 3 from a new or 12-word account',
        ]);
    });

    it('a vote on an open poll says nothing about them, even if the answer carried some', async () => {
        const after = poll({ ...OPEN, totalVotes: 13, pollNewOrWordsVotes: 6, userVotedOptionId: 'opt_maybe' }, [
            { id: 'opt_yes', text: 'Yes', votes: 7, percentage: 54, newOrWordsVotes: 4 },
            { id: 'opt_no', text: 'No', votes: 3, percentage: 23, newOrWordsVotes: 1 },
            { id: 'opt_maybe', text: 'Maybe', votes: 3, percentage: 23, newOrWordsVotes: 1 },
        ]);
        vi.mocked(api.votePoll).mockResolvedValue({ success: true, post: after } as any);
        render(<PollCard post={poll(OPEN)} identity={identity} informal />);
        fireEvent.click(optionButton('Maybe'));
        await waitFor(() => expect(screen.getByText(/13 votes cast/)).toBeInTheDocument());
        expect(screen.queryByTestId('poll-vote-origins')).toBeNull();
        expect(screen.queryAllByTestId('poll-option-origins')).toHaveLength(0);
    });

    it('fits a 320px screen at 1.3x text: the lines wrap, in the list and in the grid', () => {
        Object.defineProperty(window, 'innerWidth', { value: 320, configurable: true, writable: true });
        document.documentElement.style.fontSize = '130%';
        for (const viewMode of ['list', 'grid'] as const) {
            const view = render(<div style={{ width: 320 }}><PollCard post={poll()} identity={identity} informal viewMode={viewMode} /></div>);
            const lines = [screen.getByTestId('poll-vote-origins'), ...screen.getAllByTestId('poll-option-origins')];
            expect(lines.length).toBeGreaterThan(1);
            for (const line of lines) {
                expect(line).toHaveClass('break-words');
                // Sized in rem, so the 130% text setting scales it: a size in px would stay put.
                expect(line.className).toMatch(/\btext-\[[\d.]+rem\]/);
                expect(line.className).not.toMatch(/\btext-\[\d+px\]/);
                expect(line.className).not.toMatch(/\b(truncate|whitespace-nowrap|w-\[\d+px\]|min-w-\[\d+px\])\b/);
            }
            // An answer's line sits under the answer, on a line of its own, not squeezed beside the counts.
            for (const line of screen.getAllByTestId('poll-option-origins')) expect(line).toHaveClass('block');
            view.unmount();
        }
    });
});

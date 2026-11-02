// @vitest-environment jsdom
/**
 * The web poll card's typed Other (@beanpool/core poll-other): picking Other asks for a line and says not to put a name; an
 * anonymous poll says the answer is final and then only that it was given; the panel of words is the maker's and the owners'.
 * The node decides who reads: these hold what the card asks and says.
 */
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { POLL_OTHER_WORDS_MAX } from '@beanpool/core';
import { PollCard } from './PollCard';
import * as api from '../lib/api';

vi.mock('../lib/api', async () => ({
    ...(await vi.importActual('../lib/api')),
    votePoll: vi.fn(), closePoll: vi.fn(), myNodeRoleOnce: vi.fn(),
    getPollOtherAnswers: vi.fn(), reportPollOtherAnswer: vi.fn(), removePollOtherAnswer: vi.fn(),
}));

const me: any = { publicKey: 'me', privateKey: 'p', callsign: 'Me' };
const other = { id: 'opt_other_ab', text: 'Other', other: true, votes: 2, percentage: 40 };
const poll = (extra: Record<string, unknown> = {}): any => ({
    id: 'poll_1', type: 'poll', category: 'community', title: 'What is missing?', description: '', authorPublicKey: 'maker', authorCallsign: 'Mo',
    createdAt: new Date().toISOString(), status: 'active', active: true, credits: 0, priceType: 'fixed', repeatable: false,
    pollOptions: [{ id: 'opt_1', text: 'Buses', votes: 3, percentage: 60 }, other], totalVotes: 5,
    pollClosesAt: new Date(Date.now() + 86_400_000).toISOString(), pollOpenVote: false, ...extra,
});

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.myNodeRoleOnce).mockResolvedValue(null);
    vi.mocked(api.votePoll).mockResolvedValue({ success: true, post: poll({ pollAnswered: true }) } as any);
});
afterEach(cleanup);

describe('answering Other', () => {
    it('asks for a line, says not to put a name, and sends the words with Other', async () => {
        render(<PollCard post={poll()} identity={me} />);
        expect(screen.queryByTestId('poll-other-box')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /Other/ }));
        expect(api.votePoll).not.toHaveBeenCalled();
        expect(screen.getByTestId('poll-other-no-name').textContent).toBe("Don't put your name");
        const box = screen.getByTestId('poll-other-words') as HTMLInputElement;
        expect(box.maxLength).toBe(POLL_OTHER_WORDS_MAX);
        const send = screen.getByTestId('poll-other-send') as HTMLButtonElement;
        expect(send.disabled).toBe(true);
        fireEvent.change(box, { target: { value: '  A Sunday bus  ' } });
        fireEvent.click(send);
        await waitFor(() => expect(api.votePoll).toHaveBeenCalledWith('poll_1', 'opt_other_ab', 'A Sunday bus'));
        await waitFor(() => expect(screen.getByTestId('poll-answered')).toBeTruthy());
    });

    it('a plain answer goes at one tap, with no words', async () => {
        render(<PollCard post={poll()} identity={me} />);
        fireEvent.click(screen.getByRole('button', { name: /Buses/ }));
        await waitFor(() => expect(api.votePoll).toHaveBeenCalledWith('poll_1', 'opt_1'));
    });

    it('keeps the words when the node refuses them', async () => {
        vi.mocked(api.votePoll).mockRejectedValue(new Error('A typed answer is at most 140 characters'));
        render(<PollCard post={poll()} identity={me} />);
        fireEvent.click(screen.getByRole('button', { name: /Other/ }));
        fireEvent.change(screen.getByTestId('poll-other-words'), { target: { value: 'kept' } });
        fireEvent.click(screen.getByTestId('poll-other-send'));
        await screen.findByText('A typed answer is at most 140 characters');
        expect((screen.getByTestId('poll-other-words') as HTMLInputElement).value).toBe('kept');
    });

    it('a sealed poll says the answer is final, and never that a re-vote overwrites', () => {
        render(<PollCard post={poll()} identity={me} />);
        expect(screen.getByText(/Your answer is final/)).toBeTruthy();
        expect(screen.queryByText(/Re-voting overwrites/)).toBeNull();
    });

    it('once answered it says so, ticks nothing and locks every answer', () => {
        render(<PollCard post={poll({ pollAnswered: true })} identity={me} />);
        expect(screen.getByTestId('poll-answered')).toBeTruthy();
        for (const b of screen.getAllByRole('button', { pressed: false })) expect((b as HTMLButtonElement).disabled).toBe(true);
        expect(screen.queryByRole('button', { pressed: true })).toBeNull();
    });

    it('an open vote keeps its re-vote, and no finality line', () => {
        render(<PollCard post={poll({ pollOpenVote: true, userVotedOptionId: 'opt_1' })} identity={me} />);
        expect(screen.getByText(/Re-voting overwrites/)).toBeTruthy();
        expect(screen.queryByText(/Your answer is final/)).toBeNull();
        expect((screen.getByRole('button', { name: /Other/ }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('everyone sees the count for Other; a visitor has nothing to press', () => {
        render(<PollCard post={poll()} visitor />);
        expect(screen.getByText('(2)')).toBeTruthy();
        expect(screen.queryByTestId('poll-other-box')).toBeNull();
        expect(screen.queryByTestId('poll-other-answers')).toBeNull();
    });

    it('a poll that offers no Other shows no box and asks the node nothing', async () => {
        render(<PollCard post={poll({ pollOptions: [{ id: 'opt_1', text: 'Buses' }, { id: 'opt_2', text: 'Beans' }] })} identity={me} />);
        expect(screen.queryByTestId('poll-other-answers')).toBeNull();
        expect(screen.queryByText(/Your answer is final/)).toBeNull();
        expect(api.myNodeRoleOnce).not.toHaveBeenCalled();
    });
});

describe('the words', () => {
    const read = (extra: Partial<api.PollOtherRead> = {}): api.PollOtherRead => ({ state: 'open', count: 2, answers: [{ id: 'a1', words: 'A Sunday bus', reported: false }], removed: 0, canRemove: false, ...extra });

    it('a member has no panel', async () => {
        render(<PollCard post={poll()} identity={me} />);
        await waitFor(() => expect(api.myNodeRoleOnce).toHaveBeenCalled());
        expect(screen.queryByTestId('poll-other-answers')).toBeNull();
        expect(api.getPollOtherAnswers).not.toHaveBeenCalled();
    });

    it('the maker opens the panel; held, it says when they come', async () => {
        vi.mocked(api.getPollOtherAnswers).mockResolvedValue(read({ state: 'held', answers: [] }));
        render(<PollCard post={poll({ authorPublicKey: 'me' })} identity={me} />);
        expect(api.getPollOtherAnswers).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: /Read the typed answers/ }));
        expect((await screen.findByTestId('poll-other-held')).textContent).toMatch(/once the poll closes/);
    });

    it('the maker reads a line and can report it, not remove it', async () => {
        vi.mocked(api.getPollOtherAnswers).mockResolvedValue(read());
        render(<PollCard post={poll({ authorPublicKey: 'me', status: 'completed' })} identity={me} />);
        fireEvent.click(screen.getByRole('button', { name: /Read the typed answers/ }));
        await screen.findByText('A Sunday bus');
        expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Report' }));
        await waitFor(() => expect(api.reportPollOtherAnswer).toHaveBeenCalledWith('poll_1', 'a1'));
    });

    it('an owner who did not make it gets the panel, and can remove a line', async () => {
        vi.mocked(api.myNodeRoleOnce).mockResolvedValue('owner');
        vi.mocked(api.getPollOtherAnswers).mockResolvedValue(read({ canRemove: true }));
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        render(<PollCard post={poll({ status: 'completed' })} identity={me} />);
        fireEvent.click(await screen.findByRole('button', { name: /Read the typed answers/ }));
        await screen.findByText('A Sunday bus');
        fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
        await waitFor(() => expect(api.removePollOtherAnswer).toHaveBeenCalledWith('poll_1', 'a1'));
    });

    it('an owner sees which line was reported, beside Remove', async () => {
        vi.mocked(api.myNodeRoleOnce).mockResolvedValue('owner');
        vi.mocked(api.getPollOtherAnswers).mockResolvedValue(read({
            canRemove: true,
            answers: [{ id: 'a1', words: 'A Sunday bus', reported: false }, { id: 'a2', words: 'A rude line', reported: true }],
        }));
        render(<PollCard post={poll({ status: 'completed' })} identity={me} />);
        fireEvent.click(await screen.findByRole('button', { name: /Read the typed answers/ }));
        await screen.findByText('A rude line');
        const [plainLine, reportedLine] = screen.getAllByTestId('poll-other-line');
        expect(plainLine!.textContent).not.toMatch(/Reported/);
        expect(reportedLine!.textContent).toMatch(/Reported/);
        expect(within(reportedLine!).getByRole('button', { name: 'Remove' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Report' })).toBeNull();
    });

    it('the maker sees a line they reported, and cannot report it twice', async () => {
        vi.mocked(api.getPollOtherAnswers).mockResolvedValue(read({ answers: [{ id: 'a1', words: 'A rude line', reported: true }] }));
        render(<PollCard post={poll({ authorPublicKey: 'me', status: 'completed' })} identity={me} />);
        fireEvent.click(screen.getByRole('button', { name: /Read the typed answers/ }));
        await screen.findByText('A rude line');
        expect(screen.getByTestId('poll-other-line').textContent).toMatch(/Reported/);
        expect(screen.queryByRole('button', { name: 'Report' })).toBeNull();
    });

    it('an admin gets no panel', async () => {
        vi.mocked(api.myNodeRoleOnce).mockResolvedValue('admin');
        render(<PollCard post={poll()} identity={me} />);
        await waitFor(() => expect(api.myNodeRoleOnce).toHaveBeenCalled());
        await Promise.resolve();
        expect(screen.queryByTestId('poll-other-answers')).toBeNull();
    });
});

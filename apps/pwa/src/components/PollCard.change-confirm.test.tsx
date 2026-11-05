import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PollCard } from './PollCard';
import * as api from '../lib/api';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        votePoll: vi.fn(),
        closePoll: vi.fn(),
    };
});

describe('PollCard vote change confirmation (web)', () => {
    const mockPost: any = {
        id: 'post_poll_123',
        type: 'poll',
        category: 'community',
        title: 'Community Garden Tool Shed Location',
        description: 'Should we build the new tool shed by the north gate or south barn?',
        authorPublicKey: 'author_pubkey_1',
        authorCallsign: 'Alice',
        createdAt: new Date().toISOString(),
        status: 'active',
        active: true,
        credits: 0,
        priceType: 'fixed',
        repeatable: false,
        pollOptions: [
            { id: 'opt_1', text: 'North Gate', votes: 3, percentage: 60 },
            { id: 'opt_2', text: 'South Barn', votes: 2, percentage: 40 },
            { id: 'opt_other_1', text: 'Other', other: true, votes: 0, percentage: 0 },
        ],
        pollClosesAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        totalVotes: 5,
        userVotedOptionId: 'opt_1',
        pollOpenVote: true,
        pollVotes: [
            { voterPubkey: 'voter1', voterCallsign: 'Bob', optionId: 'opt_1', createdAt: new Date().toISOString() },
            { voterPubkey: 'voter2', voterCallsign: 'Charlie', optionId: 'opt_2', createdAt: new Date().toISOString() },
        ],
    };

    const mockIdentity: any = {
        publicKey: 'voter_me',
        privateKey: 'priv_me',
        callsign: 'Me',
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('(a) voted A, press B -> the dialog shows, votePoll NOT called', async () => {
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
        render(<PollCard post={mockPost} identity={mockIdentity} />);

        const southBarnButton = screen.getByText('South Barn').closest('button');
        expect(southBarnButton).not.toBeNull();
        fireEvent.click(southBarnButton!);

        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(confirmSpy).toHaveBeenCalledWith('You voted for “North Gate”. Change it to “South Barn”?');
        expect(api.votePoll).not.toHaveBeenCalled();
    });

    it('(b) confirm -> votePoll(post, B) called once', async () => {
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
        vi.mocked(api.votePoll).mockResolvedValueOnce({
            success: true,
            post: { ...mockPost, userVotedOptionId: 'opt_2' },
        } as any);

        render(<PollCard post={mockPost} identity={mockIdentity} />);

        const southBarnButton = screen.getByText('South Barn').closest('button');
        fireEvent.click(southBarnButton!);

        expect(confirmSpy).toHaveBeenCalledTimes(1);
        await waitFor(() => {
            expect(api.votePoll).toHaveBeenCalledTimes(1);
            expect(api.votePoll).toHaveBeenCalledWith('post_poll_123', 'opt_2');
        });
    });

    it('(c) "Keep my vote" -> not called, A still shown voted', async () => {
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
        render(<PollCard post={mockPost} identity={mockIdentity} />);

        const southBarnButton = screen.getByText('South Barn').closest('button');
        fireEvent.click(southBarnButton!);

        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(api.votePoll).not.toHaveBeenCalled();

        const northGateButton = screen.getByText('North Gate').closest('button');
        expect(northGateButton).toHaveAttribute('aria-pressed', 'true');
        expect(northGateButton?.textContent).toContain('✓');
    });

    it('(d) first vote -> no dialog, called at once', async () => {
        const confirmSpy = vi.spyOn(window, 'confirm');
        vi.mocked(api.votePoll).mockResolvedValueOnce({
            success: true,
            post: { ...mockPost, userVotedOptionId: 'opt_2' },
        } as any);

        render(<PollCard post={{ ...mockPost, userVotedOptionId: null }} identity={mockIdentity} />);

        const southBarnButton = screen.getByText('South Barn').closest('button');
        fireEvent.click(southBarnButton!);

        expect(confirmSpy).not.toHaveBeenCalled();
        await waitFor(() => {
            expect(api.votePoll).toHaveBeenCalledTimes(1);
            expect(api.votePoll).toHaveBeenCalledWith('post_poll_123', 'opt_2');
        });
    });

    it('(e) sealed poll answered -> still disabled, no dialog', async () => {
        const confirmSpy = vi.spyOn(window, 'confirm');
        render(<PollCard post={{ ...mockPost, pollOpenVote: false, pollAnswered: true, userVotedOptionId: 'opt_1' }} identity={mockIdentity} />);

        const southBarnButton = screen.getByText('South Barn').closest('button');
        expect(southBarnButton).toBeDisabled();

        fireEvent.click(southBarnButton!);
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(api.votePoll).not.toHaveBeenCalled();
    });

    it('(f) Other answer while voted on another option -> asks', async () => {
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
        render(<PollCard post={mockPost} identity={mockIdentity} />);

        const otherButton = screen.getByText('Other').closest('button');
        fireEvent.click(otherButton!);

        const input = screen.getByTestId('poll-other-words');
        fireEvent.change(input, { target: { value: 'By the greenhouse' } });

        const sendButton = screen.getByTestId('poll-other-send');
        fireEvent.click(sendButton);

        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(confirmSpy).toHaveBeenCalledWith('You voted for “North Gate”. Change it to “Other”?');
        expect(api.votePoll).not.toHaveBeenCalled();

        confirmSpy.mockReturnValue(true);
        vi.mocked(api.votePoll).mockResolvedValueOnce({
            success: true,
            post: { ...mockPost, userVotedOptionId: 'opt_other_1' },
        } as any);

        fireEvent.click(sendButton);
        await waitFor(() => {
            expect(api.votePoll).toHaveBeenCalledWith('post_poll_123', 'opt_other_1', 'By the greenhouse');
        });
    });
});

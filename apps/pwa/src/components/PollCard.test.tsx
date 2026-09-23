import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
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

describe('PollCard (PWA)', () => {
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
        ],
        pollClosesAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        totalVotes: 5,
        userVotedOptionId: 'opt_1',
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

    it('renders question, context description, turnout, and options with vote counts', () => {
        render(<PollCard post={mockPost} identity={mockIdentity} />);

        expect(screen.getByText('Community Garden Tool Shed Location')).toBeInTheDocument();
        expect(screen.getByText(/Should we build the new tool shed/)).toBeInTheDocument();
        expect(screen.getByText('North Gate')).toBeInTheDocument();
        expect(screen.getByText('South Barn')).toBeInTheDocument();
        expect(screen.getByText('60%')).toBeInTheDocument();
        expect(screen.getByText('40%')).toBeInTheDocument();
        expect(screen.getByText(/5 votes cast/)).toBeInTheDocument();
    });

    it('says the ballot is open before anyone votes', () => {
        render(<PollCard post={mockPost} identity={mockIdentity} />);
        expect(screen.getByTestId('poll-open-ballot-note').textContent).toContain('Your vote is visible to members');
    });

    it('submits a vote when an option is tapped', async () => {
        const onVoteSuccess = vi.fn();
        const updatedPost = {
            ...mockPost,
            totalVotes: 6,
            userVotedOptionId: 'opt_2',
            pollOptions: [
                { id: 'opt_1', text: 'North Gate', votes: 2, percentage: 33 },
                { id: 'opt_2', text: 'South Barn', votes: 4, percentage: 67 },
            ],
        };
        vi.mocked(api.votePoll).mockResolvedValueOnce({ success: true, post: updatedPost } as any);

        render(<PollCard post={mockPost} identity={mockIdentity} onVoteSuccess={onVoteSuccess} />);

        const southBarnButton = screen.getByText('South Barn').closest('button');
        expect(southBarnButton).not.toBeNull();
        fireEvent.click(southBarnButton!);

        await waitFor(() => {
            expect(api.votePoll).toHaveBeenCalledWith('post_poll_123', 'opt_2');
            expect(onVoteSuccess).toHaveBeenCalled();
        });
    });

    it('toggles the public village voter ballot', () => {
        render(<PollCard post={mockPost} identity={mockIdentity} />);

        expect(screen.queryByText('Public Village Ballot')).not.toBeInTheDocument();

        const toggleBtn = screen.getByText(/Show Voters/);
        fireEvent.click(toggleBtn);

        expect(screen.getByText('Public Village Ballot')).toBeInTheDocument();
        expect(screen.getByText('Bob')).toBeInTheDocument();
        expect(screen.getByText('Charlie')).toBeInTheDocument();

        fireEvent.click(screen.getByText(/Hide Voters/));
        expect(screen.queryByText('Public Village Ballot')).not.toBeInTheDocument();
    });

    it('shows closed badge and disables voting when poll is completed', () => {
        const closedPost = {
            ...mockPost,
            status: 'completed',
        };

        render(<PollCard post={closedPost} identity={mockIdentity} />);

        expect(screen.getByText('Closed')).toBeInTheDocument();
        const buttons = screen.getAllByRole('button');
        // Options should be disabled
        const optionButtons = buttons.filter(b => b.textContent?.includes('North Gate') || b.textContent?.includes('South Barn'));
        expect(optionButtons.every(b => b.hasAttribute('disabled'))).toBe(true);
    });

    it('wraps decorative emojis in aria-hidden="true" and provides focus ring classes on options', () => {
        const { container } = render(<PollCard post={mockPost} identity={mockIdentity} />);

        const hiddenEmojis = Array.from(container.querySelectorAll('[aria-hidden="true"]'));
        const emojiElements = hiddenEmojis.filter(el => el.textContent?.includes('🗳️'));
        expect(emojiElements.length).toBeGreaterThan(0);

        const optionButton = screen.getByText('North Gate').closest('button');
        expect(optionButton).toHaveClass('focus-visible:ring-2');
    });
});

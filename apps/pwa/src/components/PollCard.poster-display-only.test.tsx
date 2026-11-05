/**
 * A small card never opens its poster's profile (Marty, 4 Nov 2026: "from small cards you should be able to click anywhere on
 * the card ... Once they are in the item and then they click on the person that is a good time to go to the profile").
 *
 * The poll in the Market's list or grid is a small card: its poster is shown (avatar and name), not pressed. The poll's own page
 * hands the card `onOpenProfile`, and there the poster is a button that opens the profile.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { PollCard } from './PollCard';

vi.mock('../lib/api', async () => ({ ...(await vi.importActual<typeof import('../lib/api')>('../lib/api')), votePoll: vi.fn(), closePoll: vi.fn() }));

const post: any = {
    id: 'poll-1', type: 'poll', category: 'community', title: 'Where does the tool shed go?', description: 'North gate or south barn',
    authorPublicKey: 'alice-pk', authorCallsign: 'Alice', createdAt: new Date().toISOString(), status: 'active', active: true,
    credits: 0, priceType: 'fixed', repeatable: false,
    pollOptions: [{ id: 'a', text: 'North gate', votes: 1, percentage: 50 }, { id: 'b', text: 'South barn', votes: 1, percentage: 50 }],
    pollClosesAt: new Date(Date.now() + 86_400_000).toISOString(), totalVotes: 2, userVotedOptionId: null,
};
const me: any = { publicKey: 'me-pk', privateKey: 'k', callsign: 'Me' };

afterEach(cleanup);

describe('the poll card\'s poster', () => {
    it.each(['grid', 'list'] as const)('%s card: the poster is shown, with nothing to press to reach their profile', (viewMode) => {
        render(<PollCard post={post} identity={me} viewMode={viewMode} />);
        expect(screen.getByText('Alice')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: "View Alice's profile" })).toBeNull();
        expect(screen.getByTestId('poll-author')).toBeInTheDocument();
    });

    // Since C1 the compact view's poll is a compact row (the question, its status, your answer): no poster on it, and still
    // nothing on it that opens a profile; its one button opens the poll.
    it('compact row: no poster, and nothing to press to reach their profile', () => {
        render(<PollCard post={post} identity={me} viewMode="compact" onOpen={vi.fn()} />);
        expect(screen.queryByText('Alice')).toBeNull();
        expect(screen.queryByRole('button', { name: "View Alice's profile" })).toBeNull();
        expect(screen.getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual([expect.stringMatching(/^Open poll: /)]);
    });

    it('the poll\'s own page: the poster is a button that opens their profile', () => {
        const onOpenProfile = vi.fn();
        render(<PollCard post={post} identity={me} onOpenProfile={onOpenProfile} />);
        fireEvent.click(screen.getByRole('button', { name: "View Alice's profile" }));
        expect(onOpenProfile).toHaveBeenCalledWith('alice-pk');
    });
});

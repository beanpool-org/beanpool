/**
 * The poll in the Market GRID (Marty, 5 Nov 2026: "yes two wide it is but make sure it filled correctly. we dont want 2 wide
 * with heaps of space"): two cells wide and one tile row tall at every column count, a read-only summary that fills its box,
 * and one button that opens the full poll. No vote controls on the tile; the answers that fit, then "+N more"; the card's
 * own ✓ (never on a sealed poll), a sealed poll's "You answered ✓", a closed poll's "Closed · 3 votes" and "See results ›".
 *
 * jsdom does no layout, so the answers' room is given here (its height and the page's text size); e2e/market-grid-shots.mjs
 * measures the real tile beside its row partners.
 */
import { act, render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PollGridTile } from './PollGridTile';
import { GRID_POLL_CELL } from './market-card-shell';
import * as api from '../lib/api';

// The card's own vote call (PollCard's usePollVote), stood in for: nothing here talks to a node.
vi.mock('../lib/api', async () => ({ ...(await vi.importActual<object>('../lib/api')), votePoll: vi.fn(), closePoll: vi.fn() }));

const DAY = 86_400_000;
const four = [
    { id: 'a', text: 'Better matches with what people need', votes: 1, percentage: 100 },
    { id: 'b', text: 'Faster responses when I post an offer', votes: 0, percentage: 0 },
    { id: 'c', text: 'A clearer idea of what beans are worth', votes: 0, percentage: 0 },
    { id: 'd', text: "Not sure yet. I'm still finding my feet", votes: 0, percentage: 0 },
];
const poll: any = {
    id: 'poll-grid', type: 'poll', category: 'community', title: 'What would make trading with beans easier for you?',
    authorPublicKey: 'damo-pk', authorCallsign: 'Damo (The IT guy)', createdAt: new Date().toISOString(), status: 'active', active: true,
    pollOptions: four, pollClosesAt: new Date(Date.now() + 10 * DAY + 3_600_000).toISOString(), totalVotes: 1, userVotedOptionId: null,
    pollOpenVote: false,
};

/** The answers' room as the page lays it out: `height` px tall, at 16 px text. */
let room = 0;
let observers: Array<() => void> = [];
/**
 * Each answer's words as the page lays them out at 320 px: a row holds `fits` characters of them (about what a 320 px
 * window's tile holds at 12 px bold), so longer words are wider inside their box than it is, and cut with "…".
 */
let fits = Infinity;
const wordsBox = (el: HTMLElement) => el.getAttribute('data-testid') === 'poll-grid-answer-words';
beforeEach(() => {
    room = 0;
    fits = Infinity;
    observers = [];
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
        configurable: true,
        get(this: HTMLElement) { return this.getAttribute('data-testid') === 'poll-grid-answers' ? room : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        get(this: HTMLElement) { return wordsBox(this) ? Math.min(this.textContent!.length, fits) * 7 : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
        configurable: true,
        get(this: HTMLElement) { return wordsBox(this) ? this.textContent!.length * 7 : 0; },
    });
    vi.stubGlobal('ResizeObserver', class {
        constructor(private cb: () => void) { observers.push(() => this.cb()); }
        observe() {}
        disconnect() {}
    });
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as any).clientHeight;
    delete (HTMLElement.prototype as any).clientWidth;
    delete (HTMLElement.prototype as any).scrollWidth;
});

const draw = (post: any = poll, onOpen = vi.fn(), informal = false) => {
    render(<PollGridTile post={post} onOpen={onOpen} informal={informal} />);
    return onOpen;
};
const answers = () => screen.queryAllByTestId('poll-grid-answer').map(a => a.textContent);

describe('the grid\'s poll tile', () => {
    it('is two cells wide at every column count and one row tall, its height a tile\'s (never the poll\'s own)', () => {
        draw();
        const cell = screen.getByTestId('poll-grid-cell');
        expect(cell.className).toBe(GRID_POLL_CELL);
        const spans = cell.className.split(/\s+/).filter(c => /(col|row)-span-/.test(c));
        // 2, 3, 4 and 5 columns: the one span holds at every breakpoint, and never a row span.
        expect(spans).toEqual(['col-span-2']);
        // The cell's height is the invisible tile's; the poll is laid over it.
        expect(screen.getByTestId('poll-grid-ghost').getAttribute('aria-hidden')).toBe('true');
        expect(screen.getByTestId('poll-grid-tile').className).toMatch(/(^|\s)absolute inset-0(\s|$)/);
    });

    it('has no vote controls: the whole tile is the one button, and it reads out as the poll', () => {
        draw();
        const buttons = screen.getAllByRole('button');
        expect(buttons).toHaveLength(1);
        expect(buttons[0]).toBe(screen.getByTestId('poll-grid-tile'));
        expect(buttons[0].getAttribute('aria-label')).toBe('Poll: What would make trading with beans easier for you?. 4 answers, 1 vote. Opens to vote');
        expect(screen.queryByRole('progressbar')).toBeNull();
        expect(document.querySelector('input, select, textarea, button')).toBeNull();
    });

    it('a click anywhere, Enter or Space opens the poll', () => {
        const onOpen = draw();
        fireEvent.click(screen.getByText('Better matches with what people need'));
        fireEvent.click(screen.getByText('Damo (The IT guy)'));
        fireEvent.keyDown(screen.getByTestId('poll-grid-tile'), { key: 'Enter' });
        fireEvent.keyDown(screen.getByTestId('poll-grid-tile'), { key: ' ' });
        fireEvent.keyDown(screen.getByTestId('poll-grid-tile'), { key: 'a' });
        expect(onOpen).toHaveBeenCalledTimes(4);
    });

    it('draws the header, the question, every answer that fits with its percentage, and the footer', () => {
        room = 200; // room for 8 rows of 22 with 4 between
        draw();
        const head = screen.getByTestId('poll-grid-head');
        expect(within(head).getByTestId('poll-badge').textContent).toBe('🗳️ POLL');
        expect(within(head).getByTestId('poll-status').textContent).toBe('Closes in 10d');
        expect(within(head).getByText('Damo (The IT guy)')).toBeInTheDocument();
        expect(screen.getByTestId('poll-grid-question').className).toContain('line-clamp-2');
        expect(answers()).toEqual([
            'Better matches with what people need100%', 'Faster responses when I post an offer0%',
            'A clearer idea of what beans are worth0%', "Not sure yet. I'm still finding my feet0%",
        ]);
        expect(screen.queryByTestId('poll-grid-more')).toBeNull();
        expect(screen.getByTestId('poll-grid-summary').textContent).toBe('1 vote · Anonymous');
        expect(screen.getByTestId('poll-grid-action').textContent).toBe('Tap to vote ›');
    });

    it('"+N more" when the room cannot hold every answer: the leading ones by votes, then the card\'s order', () => {
        room = 74; // three rows of 22 with 4 between: two answers and "+2 more"
        draw({ ...poll, pollOptions: [four[1], four[2], { ...four[3], votes: 2, percentage: 67 }, { ...four[0], votes: 1, percentage: 33 }], totalVotes: 3 });
        expect(answers()).toEqual(["Not sure yet. I'm still finding my feet67%", 'Better matches with what people need33%']);
        expect(screen.getByTestId('poll-grid-more').textContent).toBe('+2 more');
        // The room grows (a wider window): every answer again, in the card's order.
        room = 200;
        act(() => { for (const o of observers) o(); });
        expect(answers()).toHaveLength(4);
        expect(screen.queryByTestId('poll-grid-more')).toBeNull();
    });

    it('a larger text setting makes the rows taller, so fewer fit', () => {
        room = 74;
        document.documentElement.style.fontSize = '20.8px'; // 1.3x
        try {
            draw();
            // A row is 28.6 px and a gap 5.2: two rows in 74, one answer and "+3 more".
            expect(answers()).toHaveLength(1);
            expect(screen.getByTestId('poll-grid-more').textContent).toBe('+3 more');
        } finally {
            document.documentElement.style.fontSize = '';
        }
    });

    it('a two-answer poll gives its question three lines', () => {
        draw({ ...poll, pollOptions: four.slice(0, 2) });
        expect(screen.getByTestId('poll-grid-question').className).toContain('line-clamp-3');
    });

    it('the ✓ on the member\'s own answer, as the card shows it', () => {
        room = 200;
        draw({ ...poll, userVotedOptionId: 'b' });
        expect(screen.getAllByTestId('poll-grid-chosen')).toHaveLength(1);
        const chosen = screen.getAllByTestId('poll-grid-answer').find(a => a.getAttribute('data-chosen') === 'true')!;
        expect(chosen.textContent).toBe('Faster responses when I post an offer0% ✓');
        expect(screen.getByTestId('poll-grid-action').textContent).toBe('Tap to vote ›');
    });

    it('a sealed poll the member answered: "You answered ✓" in the footer and no ✓ on a row', () => {
        room = 200;
        const sealed = { ...poll, pollOptions: [...four, { id: 'o', text: 'Other', other: true, votes: 0, percentage: 0 }], pollAnswered: true, userVotedOptionId: 'b' };
        draw(sealed);
        expect(screen.queryByTestId('poll-grid-chosen')).toBeNull();
        expect(screen.getByTestId('poll-grid-action').textContent).toBe('You answered ✓');
        expect(screen.getByTestId('poll-grid-action').getAttribute('data-kind')).toBe('answered');
    });

    it('a closed poll: the Closed chip, "Closed · 3 votes", and "See results ›", never "Tap to vote"', () => {
        draw({ ...poll, status: 'completed', totalVotes: 3 });
        expect(screen.getByTestId('poll-status').textContent).toBe('Closed');
        expect(screen.getByTestId('poll-grid-summary').textContent).toBe('Closed · 3 votes');
        expect(screen.getByTestId('poll-grid-action').textContent).toBe('See results ›');
        expect(screen.queryByText(/Tap to vote/)).toBeNull();
        expect(screen.getByTestId('poll-grid-tile').getAttribute('aria-label')).toMatch(/Opens the results$/);
    });

    it('an open vote says so, short, as the card\'s privacy line does', () => {
        draw({ ...poll, pollOpenVote: true, totalVotes: 2 });
        expect(screen.getByTestId('poll-grid-summary').textContent).toBe('2 votes · Open vote');
    });

    it('on the global community, the card\'s note that it decides nothing', () => {
        draw(poll, vi.fn(), true);
        expect(screen.getByTestId('poll-informal-note').textContent).toBe('💬 An informal poll; it decides nothing');
    });

    it('a pinned poll shows the pin', () => {
        draw({ ...poll, pinnedAt: new Date().toISOString(), pinnedUntil: new Date(Date.now() + 3 * DAY).toISOString() });
        expect(screen.getByTestId('poll-pinned-chip').textContent).toBe('📌');
    });
});

/**
 * Voted in the tile when the WHOLE poll is in front of the member (Marty and Damo, 6 Nov 2026: "if there are 2+ more it should
 * jump to the card mandatory so you are presented with all answers. Otherwise the poll will be loaded"); otherwise the tile
 * opens the poll's page, as before.
 */
describe('the grid\'s poll tile, voted in place', () => {
    const me: any = { publicKey: 'me-pk', privateKey: 'me-priv', callsign: 'Me' };
    /** A short poll: three answers, every one whole in a 320 px tile. */
    const short: any = {
        ...poll, id: 'poll-short', title: 'Market day?', totalVotes: 5,
        pollOptions: [
            { id: 's1', text: 'Saturday', votes: 3, percentage: 60 },
            { id: 's2', text: 'Sunday', votes: 2, percentage: 40 },
            { id: 's3', text: 'Either', votes: 0, percentage: 0 },
        ],
    };
    const votePoll = vi.mocked(api.votePoll);
    beforeEach(() => {
        votePoll.mockReset();
        fits = 24;
    });
    const drawAs = (post: any, opts: { identity?: any; member?: boolean; onVoteSuccess?: () => void } = { identity: me }) => {
        const onOpen = vi.fn();
        render(<PollGridTile post={post} onOpen={onOpen} identity={opts.identity} member={opts.member} onVoteSuccess={opts.onVoteSuccess} />);
        return onOpen;
    };
    const tile = () => screen.getByTestId('poll-grid-tile');
    const answerButton = (name: RegExp) => screen.getByRole('button', { name });

    it('a short poll, all of it in the tile: tapping an answer votes it once by the card\'s own call, and opens nothing', async () => {
        room = 3 * 44 + 2 * 4; // three rows a finger's press tall, and the gaps
        const onVoteSuccess = vi.fn();
        votePoll.mockResolvedValue({ post: { ...short, totalVotes: 6, userVotedOptionId: 's2', pollOptions: [
            { id: 's1', text: 'Saturday', votes: 3, percentage: 50 }, { id: 's2', text: 'Sunday', votes: 3, percentage: 50 }, { id: 's3', text: 'Either', votes: 0, percentage: 0 },
        ] } } as any);
        const onOpen = drawAs(short, { identity: me, onVoteSuccess });
        expect(tile().getAttribute('data-votable')).toBe('true');
        // The tile is no button now: its answers are, each named as the vote it casts, and the footer opens the poll.
        expect(tile().getAttribute('role')).toBeNull();
        expect(screen.getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual([
            'Vote: Saturday, 60%', 'Vote: Sunday, 40%', 'Vote: Either, 0%', 'Open poll: Market day?',
        ]);
        // Each row a finger's press tall at least.
        for (const b of screen.getAllByTestId('poll-grid-answer')) expect(b.style.minHeight).toBe('44px');
        expect(screen.getByTestId('poll-grid-action').textContent).toBe('Tap an answer to vote · Open poll ›');

        await act(async () => { fireEvent.click(answerButton(/^Vote: Sunday/)); });
        expect(votePoll).toHaveBeenCalledTimes(1);
        expect(votePoll).toHaveBeenCalledWith('poll-short', 's2');
        expect(onOpen).not.toHaveBeenCalled();
        expect(onVoteSuccess).toHaveBeenCalledTimes(1);
        // The bars and the ✓ follow the node's answer, in place.
        const chosen = screen.getAllByTestId('poll-grid-answer').find(a => a.getAttribute('data-chosen') === 'true')!;
        expect(chosen.textContent).toBe('Sunday50% ✓');
        expect(chosen.getAttribute('aria-pressed')).toBe('true');
    });

    it('the question, the author and the footer still open the poll; the footer by Enter and Space too', () => {
        room = 200;
        const onOpen = drawAs(short);
        fireEvent.click(screen.getByTestId('poll-grid-question'));
        fireEvent.click(screen.getByText('Damo (The IT guy)'));
        const foot = screen.getByRole('button', { name: 'Open poll: Market day?' });
        expect(foot.getAttribute('tabindex')).toBe('0');
        fireEvent.click(foot);
        fireEvent.keyDown(foot, { key: 'Enter' });
        fireEvent.keyDown(foot, { key: ' ' });
        expect(onOpen).toHaveBeenCalledTimes(5);
        expect(votePoll).not.toHaveBeenCalled();
    });

    it('an answer row is a real button, in the tab order', () => {
        room = 200;
        drawAs(short);
        const b = answerButton(/^Vote: Saturday/);
        expect(b.tagName).toBe('BUTTON');
        expect(b.getAttribute('type')).toBe('button');
        b.focus();
        expect(document.activeElement).toBe(b);
    });

    it('a poll with a "+N more" row never votes: the whole tile opens the page', () => {
        room = 74; // three one-line rows: two answers and "+2 more"
        fits = Infinity;
        const onOpen = drawAs({ ...poll, pollOptions: four });
        expect(screen.getByTestId('poll-grid-more').textContent).toBe('+2 more');
        expect(tile().getAttribute('data-votable')).toBe('false');
        expect(tile().getAttribute('data-vote-block')).toBe('more');
        expect(screen.getAllByRole('button')).toEqual([tile()]);
        fireEvent.click(screen.getAllByTestId('poll-grid-answer')[0]);
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(votePoll).not.toHaveBeenCalled();
        expect(screen.getByTestId('poll-grid-action').textContent).toBe('Tap to vote ›');
    });

    it('an answer cut at 320 px never votes: the whole tile opens the page', () => {
        room = 200;
        // "Better matches with what people need" is wider than a 320 px row holds (24 characters here): cut with "…".
        const onOpen = drawAs({ ...short, pollOptions: [...short.pollOptions.slice(0, 2), { id: 's3', text: 'Better matches with what people need', votes: 0, percentage: 0 }] });
        expect(tile().getAttribute('data-vote-block')).toBe('cut');
        expect(screen.getAllByRole('button')).toEqual([tile()]);
        fireEvent.click(screen.getByText('Better matches with what people need'));
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(votePoll).not.toHaveBeenCalled();
    });

    it('rows that cannot each be a finger\'s press tall never vote', () => {
        room = 3 * 44 + 2 * 4 - 1;
        drawAs(short);
        expect(tile().getAttribute('data-vote-block')).toBe('small');
        expect(screen.getAllByRole('button')).toEqual([tile()]);
    });

    it('a poll with a typed Other opens the page, where its line to type is', () => {
        room = 200;
        const onOpen = drawAs({ ...short, pollOpenVote: true, pollOptions: [...short.pollOptions.slice(0, 2), { id: 'o', text: 'Other', other: true, votes: 0, percentage: 0 }] });
        expect(tile().getAttribute('data-vote-block')).toBe('other');
        fireEvent.click(screen.getByText('Saturday'));
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(votePoll).not.toHaveBeenCalled();
    });

    it('a sealed poll the member answered opens the page', () => {
        room = 200;
        drawAs({ ...short, pollAnswered: true, pollOptions: [...short.pollOptions.slice(0, 2), { id: 'o', text: 'Other', other: true, votes: 0, percentage: 0 }] });
        // Sealed (anonymous, with Other) and answered: the footer says so, and the tile only opens.
        expect(tile().getAttribute('data-votable')).toBe('false');
        expect(screen.getByTestId('poll-grid-action').textContent).toBe('You answered ✓');
        expect(screen.getAllByRole('button')).toEqual([tile()]);
    });

    it('a closed poll opens the page (its results)', () => {
        room = 200;
        const onOpen = drawAs({ ...short, status: 'completed' });
        expect(tile().getAttribute('data-vote-block')).toBe('closed');
        expect(screen.getByTestId('poll-grid-action').textContent).toBe('See results ›');
        fireEvent.click(screen.getByText('Sunday'));
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(votePoll).not.toHaveBeenCalled();
    });

    it('a reader who is not signed in, or not a member here, opens the page', () => {
        room = 200;
        drawAs(short, { identity: null });
        expect(tile().getAttribute('data-vote-block')).toBe('member');
        cleanup();
        drawAs(short, { identity: me, member: false });
        expect(tile().getAttribute('data-vote-block')).toBe('member');
    });

    it('a change of vote asks first, as the card does; Keep my vote sends nothing, Change sends it', async () => {
        room = 200;
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
        try {
            drawAs({ ...short, userVotedOptionId: 's1' });
            await act(async () => { fireEvent.click(answerButton(/^Vote: Sunday/)); });
            expect(confirm).toHaveBeenCalledWith('You voted for “Saturday”. Change it to “Sunday”?');
            expect(votePoll).not.toHaveBeenCalled();
            confirm.mockReturnValue(true);
            votePoll.mockResolvedValue({ post: { ...short, userVotedOptionId: 's2' } } as any);
            await act(async () => { fireEvent.click(answerButton(/^Vote: Sunday/)); });
            expect(votePoll).toHaveBeenCalledTimes(1);
            expect(votePoll).toHaveBeenCalledWith('poll-short', 's2');
        } finally {
            confirm.mockRestore();
        }
    });

    it('a vote the node refuses says so on the footer\'s line, and nothing is marked chosen', async () => {
        room = 200;
        votePoll.mockRejectedValue(new Error('Could not record your vote.'));
        drawAs(short);
        await act(async () => { fireEvent.click(answerButton(/^Vote: Saturday/)); });
        expect(screen.getByRole('alert').textContent).toBe('Could not record your vote.');
        expect(screen.queryAllByTestId('poll-grid-chosen')).toHaveLength(0);
    });
});

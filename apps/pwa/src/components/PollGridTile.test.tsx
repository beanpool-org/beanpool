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
beforeEach(() => {
    room = 0;
    observers = [];
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
        configurable: true,
        get(this: HTMLElement) { return this.getAttribute('data-testid') === 'poll-grid-answers' ? room : 0; },
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

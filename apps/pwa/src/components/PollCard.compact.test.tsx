/**
 * The poll in the Market's compact view is a compact row like a listing's (slice C1, DESIGN-card-style-box-fable.md §2 row
 * "Compact row, poll"; the phone's #2903): the poll's tile, the question, its quiet status, and the member's own answer ✓ as
 * its mark (none on a sealed poll, where the node cannot say which). The row is one button that opens the poll's page; the
 * answers, Close Poll and the voters are on that page and never reachable from the row. And the poll's card is on the style
 * box (the table's Poll row): corners 14, padding 12, the box's chips, the status quiet.
 */
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { PollCard } from './PollCard';
import { MarketplaceCard } from './MarketplaceCard';
import * as api from '../lib/api';
import { CARD_INK, COMPACT_END, COMPACT_LINE, COMPACT_MARK, COMPACT_PICTURE, COMPACT_ROW, COMPACT_TITLE, COMPACT_WORD, LIST_TYPE, POLL_CARD, chip } from './market-card-shell';

vi.mock('../lib/api', async () => ({
    ...(await vi.importActual<typeof import('../lib/api')>('../lib/api')),
    votePoll: vi.fn(), closePoll: vi.fn(), myNodeRoleOnce: vi.fn(async () => null),
}));

const DAY = 86_400_000;
const poll: any = {
    id: 'poll-row', type: 'poll', category: 'community', title: 'What would make trading here easier for you this month?',
    description: 'Tell us what to build next', authorPublicKey: 'alice-pk', authorCallsign: 'Alice', createdAt: new Date().toISOString(),
    status: 'active', active: true, credits: 0, priceType: 'fixed', repeatable: false,
    pollOptions: [
        { id: 'a', text: 'Better matches between offers and needs', votes: 3, percentage: 60 },
        { id: 'b', text: 'More events', votes: 2, percentage: 40 },
    ],
    pollClosesAt: new Date(Date.now() + 11 * DAY + 3_600_000).toISOString(), totalVotes: 5, userVotedOptionId: null, pollOpenVote: false,
};
const withOther = [...poll.pollOptions, { id: 'o', text: 'Other', other: true, votes: 1, percentage: 10 }];
const me: any = { publicKey: 'me-pk', privateKey: 'k', callsign: 'Me' };
const pinnedAt = { pinnedAt: new Date().toISOString(), pinnedUntil: new Date(Date.now() + 3 * DAY).toISOString() };

const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
const has = (el: Element, s: string) => s.split(/\s+/).every(c => classes(el).includes(c));

afterEach(() => { cleanup(); document.documentElement.style.fontSize = ''; vi.mocked(api.votePoll).mockReset(); });

function renderRow(post: any, onOpen: () => void = vi.fn(), identity: any = me) {
    document.documentElement.style.fontSize = '130%';
    return render(<div style={{ width: 320 }}><PollCard post={post} identity={identity} viewMode="compact" onOpen={onOpen} /></div>);
}

describe('the poll\'s compact row (C1)', () => {
    it('is the listing\'s row: its frame, a 32 px picture slot holding the poll\'s tile, the title, POLL at the end', () => {
        renderRow(poll);
        const row = screen.getByTestId('poll-compact-row');
        expect(has(row, COMPACT_ROW)).toBe(true);
        const picture = screen.getByTestId('compact-picture');
        expect(picture.className).toBe(COMPACT_PICTURE);
        expect(picture.textContent).toBe('🗳️');
        expect(screen.getByTestId('poll-row-question').className).toBe(`block ${COMPACT_TITLE}`);
        expect(screen.getByTestId('poll-row-question').textContent).toBe(poll.title);
        const badge = screen.getByTestId('poll-badge');
        expect(badge.className).toBe(chip('poll'));
        expect(badge.textContent).toBe('🗳️ POLL');
        expect(badge.parentElement!.className).toBe(COMPACT_END);
        // The listing's row, from the same frame.
        render(<MarketplaceCard post={{ ...poll, type: 'offer', category: 'tools', photos: [] }} viewMode="compact" />);
        expect(has(screen.getByTestId('listing-compact-row'), COMPACT_ROW)).toBe(true);
    });

    it('lays out one row: the question, the status line and at most the mark line, each one line', () => {
        renderRow({ ...poll, ...pinnedAt, userVotedOptionId: 'a' });
        const text = screen.getByTestId('poll-row-question').parentElement!;
        expect(Array.from(text.children).map(c => c.getAttribute('data-testid'))).toEqual(['poll-row-question', 'poll-compact-line', 'poll-mark']);
        expect(classes(screen.getByTestId('poll-row-question'))).toContain('truncate');
        expect(has(screen.getByTestId('poll-compact-line'), COMPACT_LINE)).toBe(true);
        // The mark is one line: the answer gives way ("…"), the ✓ stays whole.
        const mark = screen.getByTestId('poll-mark');
        expect(has(mark, `flex min-w-0 ${COMPACT_MARK}`)).toBe(true);
        const [answer, tick] = Array.from(mark.children);
        expect(classes(answer)).toEqual(expect.arrayContaining(['truncate', 'min-w-0']));
        expect(classes(tick)).toContain('shrink-0');
    });

    it('line two: 📌 PINNED in the accent ink, then the quiet status', () => {
        renderRow({ ...poll, ...pinnedAt });
        const line = screen.getByTestId('poll-compact-line');
        expect(line.textContent).toBe('📌 PINNED · Closes in 11d');
        expect(has(line, CARD_INK.secondary)).toBe(true);
        expect(within(line).getByTestId('poll-pinned-chip').className).toBe(COMPACT_WORD.pinned);
        cleanup();
        renderRow({ ...poll, status: 'completed' });
        expect(screen.getByTestId('poll-compact-line').textContent).toBe('Closed');
    });

    it('the mark is the chosen answer ✓; Other\'s own word when the member chose Other on an open vote', () => {
        renderRow({ ...poll, userVotedOptionId: 'a' });
        expect(screen.getByTestId('poll-mark').textContent).toBe('Better matches between offers and needs ✓');
        expect(screen.getByTestId('poll-compact-row').getAttribute('aria-label'))
            .toBe(`Open poll: ${poll.title}, Closes in 11d, Better matches between offers and needs ✓`);
        cleanup();
        renderRow({ ...poll, pollOptions: withOther, pollOpenVote: true, userVotedOptionId: 'o' });
        expect(screen.getByTestId('poll-mark').textContent).toBe('Other ✓');
    });

    it('no mark when the member has not answered, nor on a sealed poll (anonymous with Other), even one they answered', () => {
        renderRow(poll);
        expect(screen.queryByTestId('poll-mark')).toBeNull();
        cleanup();
        // Sealed: the node cannot say which answer was theirs, so the row names none (the page says they answered).
        renderRow({ ...poll, pollOptions: withOther, pollOpenVote: false, pollAnswered: true, userVotedOptionId: 'a' });
        expect(screen.queryByTestId('poll-mark')).toBeNull();
        expect(screen.getByTestId('poll-compact-row').getAttribute('aria-label')).toBe(`Open poll: ${poll.title}, Closes in 11d`);
    });

    it('no vote control is reachable from the row: no answer, no Other, no Close Poll, no voters; one button, which opens the poll', () => {
        const onOpen = vi.fn();
        // The poll's own maker, on an open vote with voters and Other: everything the card could offer.
        renderRow({ ...poll, authorPublicKey: me.publicKey, pollOptions: withOther, pollOpenVote: true, userVotedOptionId: 'b',
            pollVotes: [{ voterPubkey: 'v1', voterCallsign: 'Bob', optionId: 'a', createdAt: new Date().toISOString() }] }, onOpen);
        const buttons = screen.getAllByRole('button');
        expect(buttons).toEqual([screen.getByTestId('poll-compact-row')]);
        expect(screen.queryByRole('progressbar')).toBeNull();
        expect(screen.queryByRole('textbox')).toBeNull();
        expect(screen.queryByText('Close Poll')).toBeNull();
        expect(screen.queryByText(/Show Voters/)).toBeNull();
        // The answers the member did not choose are not on the row (the chosen one is, as the mark).
        expect(screen.queryByText('Better matches between offers and needs')).toBeNull();
        expect(screen.getByTestId('poll-mark').textContent).toBe('More events ✓');
        expect(screen.getByTestId('poll-compact-row').querySelectorAll('button, input, a, [role="button"]').length).toBe(0);
        fireEvent.click(screen.getByTestId('poll-compact-row'));
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(api.votePoll).not.toHaveBeenCalled();
    });
});

describe('the poll card on the style box (C1, the table\'s Poll row)', () => {
    it('corners 14, the 1 px outline, the card ground, 12 of padding; no purple band', () => {
        render(<PollCard post={poll} identity={me} viewMode="list" />);
        const card = screen.getByTestId('poll-card');
        expect(card.className).toBe(POLL_CARD);
        expect(classes(card)).toEqual(expect.arrayContaining(['rounded-[14px]', 'border', 'p-3', 'bg-[var(--bg-card)]']));
        expect(card.className).not.toMatch(/purple-|border-2|rounded-2xl|p-4|nature-950/);
    });

    it('the chips are the box\'s: 📌 PINNED, POLL in the plum, the status quiet and in the words\' own case', () => {
        render(<PollCard post={{ ...poll, ...pinnedAt }} identity={me} viewMode="list" />);
        expect(screen.getByTestId('poll-pinned-chip').className).toBe(chip('pinned'));
        expect(screen.getByTestId('poll-badge').className).toBe(chip('poll'));
        const status = screen.getByTestId('poll-status');
        expect(status.className).toBe(chip('quiet'));
        expect(status.textContent).toBe('Closes in 11d');
        const chips = status.parentElement!;
        expect(Array.from(chips.children).map(c => c.getAttribute('data-testid'))).toEqual(['poll-pinned-chip', 'poll-badge', 'poll-status']);
    });

    it('the question is the list card\'s loud line, 16/900', () => {
        render(<PollCard post={poll} identity={me} viewMode="list" />);
        const question = screen.getByRole('heading', { name: poll.title });
        expect(has(question, LIST_TYPE.loud)).toBe(true);
        // The answers are still on the card in the list and the grid.
        expect(screen.getByRole('button', { name: /Better matches/ })).toBeInTheDocument();
    });
});

/**
 * The poll's tile in the Market GRID, one set of rules for the phone and the web (Marty, 5 Nov 2026: "yes two wide it is but
 * make sure it filled correctly. we dont want 2 wide with heaps of space"; "2 wide breaks up the monotony of the market place").
 *
 * In the grid a poll is two cells wide and ONE tile row tall, a read-only summary of the poll that fills that box, and a tap
 * anywhere opens the full poll, where it is voted (as an item's tile opens the item). The list keeps the full votable card.
 *
 *   header    🗳️ POLL · Closes in 10d · 📌                👤 the author
 *   question  the title, 2 lines at most (3 when the poll has only 2 answers)
 *   answers   one line each, the result bar behind; they share the room between the question and the footer: each grows up
 *             to ROW_GROW times its one-line height, then the rows spread evenly. When the room cannot hold every answer at
 *             one line, as many as fit are shown (the leading answers by votes, then in the card's order) and "+N more" is
 *             the last row.
 *   footer    "1 vote · Anonymous"  ...  "Tap to vote ›"
 *
 * What it shows is the card's own: the percentages as PollCard shows them, before voting too; the ✓ on the member's answer
 * only where the card shows it (never on a sealed poll, whose answer the node cannot name); a sealed poll they answered says
 * "You answered ✓"; a closed poll says Closed and "See results ›". No vote controls: the tile is one button.
 *
 * Pure: no React, no I/O. The apps measure the answers' room (the web's ResizeObserver, the phone's onLayout) and draw.
 */

import { t, tn } from './words.js';

/** The tile's numbers: the phone's in dp at 1x text (scaled with the text), the web's in rem. */
export const POLL_GRID_TILE = {
    /** The question's lines at most; when the poll has only two answers there is room for one more. */
    questionLines: 2,
    questionLinesFewAnswers: 3,
    /** One answer row's height at one line: the phone's dp at 1x, the web's rem. */
    rowHeight: 22,
    rowHeightRem: 1.375,
    /** Between two answer rows. */
    rowGap: 4,
    rowGapRem: 0.25,
    /** An answer row grows to this many times its one-line height at most; past it the rows spread evenly. */
    rowGrow: 1.6,
} as const;

/** An answer as the poll's card holds it (the node's poll_options entry). */
export interface PollTileOption {
    id?: string;
    text?: string;
    votes?: number;
    percentage?: number;
    /** The maker's Other (poll-other.ts): its words are the app's "Other", never what someone typed. */
    other?: boolean;
}

/** One answer row on the tile. */
export interface PollTileAnswer {
    /** The answer's id, or its place when it has none. */
    key: string;
    /** Its place in the card's order. */
    index: number;
    option: PollTileOption;
    /** The card's own percentage: the node's, else the share of the votes, rounded. */
    pct: number;
    votes: number;
    /** The member's own answer, where the card shows it (never on a sealed poll). */
    chosen: boolean;
}

/** The card's percentage for one answer (PollCard on both apps). */
export function pollTilePercent(option: PollTileOption, totalVotes: number): number {
    if (typeof option.percentage === 'number' && Number.isFinite(option.percentage)) return option.percentage;
    return totalVotes > 0 ? Math.round(((option.votes || 0) / totalVotes) * 100) : 0;
}

/** The poll's total, as the card counts it: the node's, else the answers' votes added up. */
export function pollTileTotal(options: readonly PollTileOption[], totalVotes?: number | null): number {
    if (typeof totalVotes === 'number' && Number.isFinite(totalVotes)) return totalVotes;
    return options.reduce((sum, o) => sum + (o.votes || 0), 0);
}

/** The question's lines at most: 2, or 3 when there are only two answers to show. */
export function pollTileQuestionLines(answerCount: number): number {
    return answerCount <= 2 ? POLL_GRID_TILE.questionLinesFewAnswers : POLL_GRID_TILE.questionLines;
}

/**
 * How many one-line answer rows fit a block `room` tall, rows `row` tall with `gap` between them (all in the same unit).
 * Null when nothing is measured yet (a room or a row that is not a positive number): the tile then lists every answer.
 * Half a pixel of slack, so a block that is a rounding short of a row still holds it.
 */
export function pollTileRowsThatFit(room: number, row: number, gap: number): number | null {
    if (!(room > 0) || !(row > 0)) return null;
    const between = gap > 0 ? gap : 0;
    return Math.max(0, Math.floor((room + between + 0.5) / (row + between)));
}

/**
 * What the tile lists. `fit` = the rows that fit (pollTileRowsThatFit), or null before it is measured. Every answer fits: all
 * of them, in the card's order. They do not: as many as fit less one (at least none), the leading answers by votes and then
 * in the card's order, and `more` = how many are left, the "+N more" row.
 */
export function pollTileAnswers(
    options: readonly PollTileOption[],
    { totalVotes, userVotedOptionId, sealed, fit }: { totalVotes?: number | null; userVotedOptionId?: string | null; sealed: boolean; fit: number | null },
): { answers: PollTileAnswer[]; more: number } {
    const total = pollTileTotal(options, totalVotes);
    const all: PollTileAnswer[] = options.map((option, index) => ({
        key: option.id || String(index),
        index,
        option,
        pct: pollTilePercent(option, total),
        votes: option.votes ?? 0,
        chosen: !sealed && Boolean(userVotedOptionId) && option.id === userVotedOptionId,
    }));
    if (fit === null || fit >= all.length) return { answers: all, more: 0 };
    const shown = Math.max(0, fit - 1);
    const leading = [...all].sort((a, b) => (b.votes - a.votes) || (b.pct - a.pct) || (a.index - b.index)).slice(0, shown);
    return { answers: leading, more: all.length - shown };
}

/** The "+N more" row. */
export function pollTileMore(n: number): string {
    return tn(n, '+{n} more', '+{n} more');
}

/** The footer's left: the turnout and the ballot (Anonymous / Open vote), or Closed and the turnout. */
export function pollTileSummary({ totalVotes, closed, openVote }: { totalVotes: number; closed: boolean; openVote: boolean }): string {
    if (closed) return tn(totalVotes, 'Closed · {n} vote', 'Closed · {n} votes');
    return openVote
        ? tn(totalVotes, '{n} vote · Open vote', '{n} votes · Open vote')
        : tn(totalVotes, '{n} vote · Anonymous', '{n} votes · Anonymous');
}

/** The footer's right: what a tap does, or that a sealed poll has the member's answer. */
export function pollTileAction({ closed, answered }: { closed: boolean; answered: boolean }): { kind: 'vote' | 'results' | 'answered'; words: string } {
    if (closed) return { kind: 'results', words: t('See results ›') };
    if (answered) return { kind: 'answered', words: t('You answered ✓') };
    return { kind: 'vote', words: t('Tap to vote ›') };
}

/** The tile's one label, as a screen reader reads the button: the question, its answers and votes, and what it opens. */
export function pollTileLabel({ question, answerCount, totalVotes, closed }: { question: string; answerCount: number; totalVotes: number; closed: boolean }): string {
    const answers = tn(answerCount, '{n} answer', '{n} answers');
    const votes = tn(totalVotes, '{n} vote', '{n} votes');
    return closed
        ? t('Poll: {question}. {answers}, {votes}. Opens the results', { question, answers, votes })
        : t('Poll: {question}. {answers}, {votes}. Opens to vote', { question, answers, votes });
}

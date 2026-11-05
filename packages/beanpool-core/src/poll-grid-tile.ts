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
 * "You answered ✓"; a closed poll says Closed and "See results ›".
 *
 * Voted in the tile (Marty and Damo, 6 Nov 2026: "if there are 2+ more it should jump to the card mandatory so you are
 * presented with all answers. Otherwise the poll will be loaded"): only when the WHOLE poll is in front of the member
 * (pollTileVoteBlock). Then each answer row is a button that votes as the card does, and the question, the author and the
 * footer ("Tap an answer to vote · Open poll ›") open the poll. Otherwise the tile is one button that opens it, as before.
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

/**
 * How far an answer row may grow, in one-line heights, for the rows the tile shows (its answers and a "+N more"): 1.6x from
 * four rows up (POLL_GRID_TILE.rowGrow); a short poll's rows further, 2x for three and 2.4x for one or two. At 1.6x a two-answer
 * poll left 43 px blank bands in a 1920 px window's tile (market-grid-shots.mjs, 5 Nov 2026): "we dont want 2 wide with heaps of
 * space". The rows are bars either way; a short poll's are fatter ones.
 */
export function pollTileRowGrow(rows: number): number {
    if (rows <= 2) return 2.4;
    if (rows === 3) return 2;
    return POLL_GRID_TILE.rowGrow;
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

/**
 * The footer's right: what a tap does, or that a sealed poll has the member's answer. On a tile voted in place (`votable`,
 * pollTileVoteBlock) it says both, "Tap an answer to vote · Open poll ›": `hint` is the first half, which gives way (cut with
 * "…") when the line is short of room, and `words` the second, which never does. The turnout beside them gives way first.
 */
export function pollTileAction({ closed, answered, votable = false }: { closed: boolean; answered: boolean; votable?: boolean }): { kind: 'vote' | 'results' | 'answered' | 'here'; words: string; hint?: string } {
    if (closed) return { kind: 'results', words: t('See results ›') };
    if (answered) return { kind: 'answered', words: t('You answered ✓') };
    if (votable) return { kind: 'here', hint: t('Tap an answer to vote'), words: t('Open poll ›') };
    return { kind: 'vote', words: t('Tap to vote ›') };
}

/**
 * The least height of an answer row that is a button (px on the web, dp on the phone): a finger's press. An answer row is a
 * button only when every row can be this tall in the answers' room (pollTilePressesFit), so the tile never offers presses
 * smaller than a finger.
 */
export const POLL_TILE_PRESS = 44;

/**
 * Whether `rows` answer rows, each POLL_TILE_PRESS tall with `gap` between them, fit a room `room` tall (one unit, px or dp).
 * False until the room is measured. Half a pixel of slack, as pollTileRowsThatFit.
 */
export function pollTilePressesFit(room: number, rows: number, gap: number): boolean {
    if (!(room > 0) || !(rows > 0)) return false;
    return room + 0.5 >= rows * POLL_TILE_PRESS + (rows - 1) * Math.max(0, gap);
}

/** Why a tile is not voted in place; null when it is. */
export type PollTileVoteBlock =
    /** The poll has closed: its results only. */
    | 'closed'
    /** Not signed in as a member here: the page says how to join. */
    | 'member'
    /** The poll offers a typed Other: its line to type is on the page. */
    | 'other'
    /** A sealed poll the member has answered: their answer is final. */
    | 'answered'
    /** The answers' room is not measured yet. */
    | 'unmeasured'
    /** Some answer is hidden behind "+N more": the page shows them all, so no answer is chosen unseen. */
    | 'more'
    /** Some answer's words are cut ("…"): the page shows them whole. */
    | 'cut'
    /** The rows cannot each be a finger's press tall (POLL_TILE_PRESS) in the room. */
    | 'small';

/** What the tile knows when it decides whether it is voted in place. */
export interface PollTileVoteFacts {
    closed: boolean;
    /** Signed in, and a member of this community. */
    canVote: boolean;
    /** The poll offers a typed Other (pollOtherOption). */
    other: boolean;
    /** pollIsSealed, and the member has answered it. */
    sealed: boolean;
    answered: boolean;
    /** The answers' room has been measured (and, where the app measures words, every shown answer's words too). */
    measured: boolean;
    /** How many answers are behind "+N more" (pollTileAnswers). */
    more: number;
    /** Some shown answer's words do not fit its row (the web's scrollWidth past its clientWidth, the phone's laid-out lines). */
    cut: boolean;
    /** Every shown answer row can be POLL_TILE_PRESS tall (pollTilePressesFit). */
    pressesFit: boolean;
}

/**
 * Whether the grid's poll tile is voted in place, and if not, why (Marty and Damo, 6 Nov 2026: the whole poll in front of the
 * member, or the page). One rule for both apps. The tile is voted in place only when ALL hold:
 *   1. every answer is shown (no "+N more" row);
 *   2. no answer's words are cut;
 *   3. the poll has no typed Other;
 *   4. it is not a sealed poll the member has answered, and it has not closed;
 *   5. the member can vote here (signed in, a member);
 * and the room is measured, and every row can be a finger's press tall. Otherwise a tap anywhere opens the poll's page.
 */
export function pollTileVoteBlock(f: PollTileVoteFacts): PollTileVoteBlock | null {
    if (f.closed) return 'closed';
    if (!f.canVote) return 'member';
    if (f.other) return 'other';
    if (f.sealed && f.answered) return 'answered';
    if (!f.measured) return 'unmeasured';
    if (f.more > 0) return 'more';
    if (f.cut) return 'cut';
    if (!f.pressesFit) return 'small';
    return null;
}

/** An answer row's name as a screen reader reads its button on a tile voted in place: "Vote: Saturday, 60%". */
export function pollTileAnswerLabel(answer: string, pct: number): string {
    return t('Vote: {answer}, {rate}%', { answer, rate: pct });
}

/** The footer's name as a screen reader reads it on a tile voted in place: it opens the poll's page. */
export function pollTileOpenLabel(question: string): string {
    return t('Open poll: {title}', { title: question });
}

/** The tile's one label, as a screen reader reads the button: the question, its answers and votes, and what it opens. */
export function pollTileLabel({ question, answerCount, totalVotes, closed }: { question: string; answerCount: number; totalVotes: number; closed: boolean }): string {
    const answers = tn(answerCount, '{n} answer', '{n} answers');
    const votes = tn(totalVotes, '{n} vote', '{n} votes');
    return closed
        ? t('Poll: {question}. {answers}, {votes}. Opens the results', { question, answers, votes })
        : t('Poll: {question}. {answers}, {votes}. Opens to vote', { question, answers, votes });
}

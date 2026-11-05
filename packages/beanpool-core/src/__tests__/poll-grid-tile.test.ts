import { describe, expect, it } from 'vitest';
import {
    POLL_GRID_TILE, pollTileAction, pollTileAnswers, pollTileLabel, pollTileMore, pollTilePercent, pollTileQuestionLines, pollTileRowGrow,
    pollTileRowsThatFit, pollTileSummary, pollTileTotal,
} from '../poll-grid-tile.js';

/**
 * The poll's tile in the Market grid (Marty, 5 Nov 2026: "yes two wide it is but make sure it filled correctly"): two cells
 * wide, one tile row tall, the answers that fit and "+N more", the card's own percentages and ✓, and words that say what a tap
 * does. One set of rules for both apps.
 */
const four = [
    { id: 'a', text: 'Better matches with what people need', votes: 1 },
    { id: 'b', text: 'Faster responses when I post an offer', votes: 0 },
    { id: 'c', text: 'A clearer idea of what beans are worth', votes: 3 },
    { id: 'd', text: "Not sure yet. I'm still finding my feet", votes: 3 },
];

describe('pollTileRowsThatFit: one-line rows in the answers\' room', () => {
    it('counts rows and the gaps between them', () => {
        // 22 a row, 4 between: 3 rows need 3 x 22 + 2 x 4 = 74.
        expect(pollTileRowsThatFit(74, 22, 4)).toBe(3);
        expect(pollTileRowsThatFit(73.6, 22, 4)).toBe(3);
        expect(pollTileRowsThatFit(73, 22, 4)).toBe(2);
        expect(pollTileRowsThatFit(21, 22, 4)).toBe(0);
        expect(pollTileRowsThatFit(500, 22, 4)).toBe(19);
    });

    it('is null until something is measured', () => {
        expect(pollTileRowsThatFit(0, 22, 4)).toBeNull();
        expect(pollTileRowsThatFit(Number.NaN, 22, 4)).toBeNull();
        expect(pollTileRowsThatFit(80, 0, 4)).toBeNull();
    });

    it('the phone and the web rows are one row: 22 dp at 1x, 1.375rem (22 px at 16 px text); they grow 1.6x at most', () => {
        expect(POLL_GRID_TILE.rowHeightRem * 16).toBe(POLL_GRID_TILE.rowHeight);
        expect(POLL_GRID_TILE.rowGapRem * 16).toBe(POLL_GRID_TILE.rowGap);
        expect(POLL_GRID_TILE.rowGrow).toBe(1.6);
    });

    it('rows grow 1.6x from four up, a short poll\'s further, so two answers still fill a wide tile', () => {
        expect([1, 2, 3, 4, 6, 9].map(pollTileRowGrow)).toEqual([2.4, 2.4, 2, 1.6, 1.6, 1.6]);
    });
});

describe('pollTileAnswers: what the tile lists', () => {
    it('every answer, in the card\'s order, when they all fit or nothing is measured yet', () => {
        for (const fit of [null, 4, 9]) {
            const { answers, more } = pollTileAnswers(four, { totalVotes: 7, sealed: false, fit });
            expect(answers.map(a => a.key)).toEqual(['a', 'b', 'c', 'd']);
            expect(more).toBe(0);
        }
    });

    it('when they do not fit: the leading answers by votes, then in the card\'s order, and "+N more" as the last row', () => {
        // Three rows fit: two answers and "+2 more". c and d tie on 3 votes: c comes first in the card.
        const three = pollTileAnswers(four, { totalVotes: 7, sealed: false, fit: 3 });
        expect(three.answers.map(a => a.key)).toEqual(['c', 'd']);
        expect(three.more).toBe(2);
        const two = pollTileAnswers(four, { totalVotes: 7, sealed: false, fit: 2 });
        expect(two.answers.map(a => a.key)).toEqual(['c']);
        expect(two.more).toBe(3);
        // A row or none: "+4 more" alone, never an answer cut off under the footer.
        expect(pollTileAnswers(four, { totalVotes: 7, sealed: false, fit: 1 })).toEqual({ answers: [], more: 4 });
        expect(pollTileAnswers(four, { totalVotes: 7, sealed: false, fit: 0 })).toEqual({ answers: [], more: 4 });
    });

    it('with no votes the leading answers are the card\'s first ones', () => {
        const none = four.map(o => ({ ...o, votes: 0 }));
        expect(pollTileAnswers(none, { totalVotes: 0, sealed: false, fit: 3 }).answers.map(a => a.key)).toEqual(['a', 'b']);
    });

    it('the card\'s percentages: the node\'s, else the share of the votes, rounded; 0 before anyone votes', () => {
        expect(pollTilePercent({ votes: 1, percentage: 100 }, 1)).toBe(100);
        expect(pollTilePercent({ votes: 1 }, 3)).toBe(33);
        expect(pollTilePercent({ votes: 0 }, 0)).toBe(0);
        expect(pollTileAnswers(four, { totalVotes: 7, sealed: false, fit: null }).answers.map(a => a.pct)).toEqual([14, 0, 43, 43]);
        expect(pollTileTotal(four)).toBe(7);
        expect(pollTileTotal(four, 9)).toBe(9);
    });

    it('the ✓ on the member\'s own answer, never on a sealed poll (its answer cannot be named)', () => {
        const mine = pollTileAnswers(four, { totalVotes: 7, userVotedOptionId: 'b', sealed: false, fit: null });
        expect(mine.answers.filter(a => a.chosen).map(a => a.key)).toEqual(['b']);
        const sealed = pollTileAnswers(four, { totalVotes: 7, userVotedOptionId: 'b', sealed: true, fit: null });
        expect(sealed.answers.some(a => a.chosen)).toBe(false);
        expect(pollTileAnswers(four, { totalVotes: 7, sealed: false, fit: null }).answers.some(a => a.chosen)).toBe(false);
    });
});

describe('the tile\'s words', () => {
    it('the question has 2 lines, 3 when there are only 2 answers', () => {
        expect(pollTileQuestionLines(2)).toBe(3);
        expect(pollTileQuestionLines(4)).toBe(2);
        expect(pollTileQuestionLines(6)).toBe(2);
    });

    it('the footer: the turnout and the ballot, or Closed and the turnout', () => {
        expect(pollTileSummary({ totalVotes: 1, closed: false, openVote: false })).toBe('1 vote · Anonymous');
        expect(pollTileSummary({ totalVotes: 4, closed: false, openVote: true })).toBe('4 votes · Open vote');
        expect(pollTileSummary({ totalVotes: 3, closed: true, openVote: false })).toBe('Closed · 3 votes');
    });

    it('what a tap does: vote, see a closed poll\'s results, or a sealed poll that has the member\'s answer', () => {
        expect(pollTileAction({ closed: false, answered: false })).toEqual({ kind: 'vote', words: 'Tap to vote ›' });
        expect(pollTileAction({ closed: true, answered: false })).toEqual({ kind: 'results', words: 'See results ›' });
        expect(pollTileAction({ closed: true, answered: true })).toEqual({ kind: 'results', words: 'See results ›' });
        expect(pollTileAction({ closed: false, answered: true })).toEqual({ kind: 'answered', words: 'You answered ✓' });
    });

    it('"+N more" and the one label a screen reader reads', () => {
        expect(pollTileMore(2)).toBe('+2 more');
        expect(pollTileLabel({ question: 'What next?', answerCount: 4, totalVotes: 1, closed: false }))
            .toBe('Poll: What next?. 4 answers, 1 vote. Opens to vote');
        expect(pollTileLabel({ question: 'What next', answerCount: 2, totalVotes: 3, closed: true }))
            .toBe('Poll: What next. 2 answers, 3 votes. Opens the results');
    });
});

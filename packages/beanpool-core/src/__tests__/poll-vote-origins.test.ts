import { describe, it, expect } from 'vitest';
import { pollVoteOriginsLine, pollOptionOriginsLine } from '../poll-vote-origins.js';

describe("a poll's line: how many of its votes came from new or 12-word accounts", () => {
    it('says the count out of the total', () => {
        expect(pollVoteOriginsLine(12, 6)).toBe('6 of 12 votes came from new or 12-word accounts');
        expect(pollVoteOriginsLine(12, 1)).toBe('1 of 12 votes came from a new or 12-word account');
    });
    it('all of them, and the one vote', () => {
        expect(pollVoteOriginsLine(3, 3)).toBe('All 3 votes came from new or 12-word accounts');
        expect(pollVoteOriginsLine(1, 1)).toBe('The 1 vote came from a new or 12-word account');
    });
    it('nothing when none did, or the node says nothing', () => {
        expect(pollVoteOriginsLine(12, 0)).toBeNull();
        expect(pollVoteOriginsLine(12, undefined)).toBeNull();
        expect(pollVoteOriginsLine(12, null)).toBeNull();
        expect(pollVoteOriginsLine(0, 0)).toBeNull();
        expect(pollVoteOriginsLine(12, Number.NaN)).toBeNull();
    });
    it('never more than the total, whatever arrives', () => {
        expect(pollVoteOriginsLine(2, 5)).toBe('All 2 votes came from new or 12-word accounts');
        expect(pollVoteOriginsLine(undefined, 5)).toBeNull();
    });
});

describe("an option's line", () => {
    it('says how many of its votes', () => {
        expect(pollOptionOriginsLine(7, 4)).toBe('4 of these 7 from new or 12-word accounts');
        expect(pollOptionOriginsLine(3, 1)).toBe('1 of these 3 from a new or 12-word account');
        expect(pollOptionOriginsLine(2, 2)).toBe('All 2 from new or 12-word accounts');
        expect(pollOptionOriginsLine(1, 1)).toBe('This 1 from a new or 12-word account');
    });
    it('nothing where the node gives no split, or none came from them', () => {
        expect(pollOptionOriginsLine(7, undefined)).toBeNull();
        expect(pollOptionOriginsLine(7, 0)).toBeNull();
        expect(pollOptionOriginsLine(0, 0)).toBeNull();
    });
});

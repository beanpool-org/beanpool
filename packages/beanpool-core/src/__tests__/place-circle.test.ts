import { describe, expect, it } from 'vitest';
import { GROUP_KIND_CIRCLE, PLACE_CIRCLE_WORDS, circleKnockLine, circleKnockTrouble, groupClosedShown } from '../place-circle.js';
import { t } from '../words.js';

describe('what a knock\'s answer means for Ask to join', () => {
    it.each([429, 500, 502, 503, 504, 520])('a %i says nothing about this person: the button stays for another tap', status => {
        expect(circleKnockTrouble({ kind: 'refused', status })).toBe('later');
    });

    it('so does no answer at all, and an address that may yet be mended', () => {
        expect(circleKnockTrouble({ kind: 'unreachable' })).toBe('later');
        expect(circleKnockTrouble({ kind: 'no_address' })).toBe('later');
    });

    it.each([400, 403, 404, 409])('a %i is the community\'s answer, and another tap would not change it', status => {
        expect(circleKnockTrouble({ kind: 'refused', status })).toBe('refused');
    });

    it.each(['waiting', 'invited', 'member'])('%s is no trouble', kind => {
        expect(circleKnockTrouble({ kind })).toBeNull();
    });

    it('each trouble has its line, and no trouble has none', () => {
        expect(circleKnockLine('later')).toBe(t(PLACE_CIRCLE_WORDS.knockLater));
        expect(circleKnockLine('refused')).toBe(t(PLACE_CIRCLE_WORDS.knockRefused));
        expect(circleKnockLine(null)).toBeNull();
        expect(circleKnockLine(undefined)).toBeNull();
    });
});

describe('what is said of a closed group', () => {
    const byVote = "Closed by its members' vote";

    it('a circle closes by itself, so it never says anyone voted', () => {
        const said = groupClosedShown({ kind: GROUP_KIND_CIRCLE }, byVote);
        expect(said).toBe(t(PLACE_CIRCLE_WORDS.closed));
        expect(said).not.toMatch(/vote/i);
    });

    it('any other group keeps the words that place gave it', () => {
        expect(groupClosedShown({ kind: null }, byVote)).toBe(byVote);
        expect(groupClosedShown({}, byVote)).toBe(byVote);
    });
});

/**
 * Local knowledge's waiting list in core (slice K3; DESIGN-local-knowledge-fable.md §2.4, §3.4, §5 as amended): the
 * member's limits, the words of the answer a member keeps, the Needs-you line, and the two push kinds. The node writes each
 * in English and an app the same from the same facts in its member's language, so every sentence goes through t().
 */
import { describe, expect, it } from 'vitest';
import {
    KNOWLEDGE_DECLINE_REASONS,
    KNOWLEDGE_DRAFT_LIMITS,
    KNOWLEDGE_DRAFT_WORDS,
    KNOWLEDGE_LIMITS,
    PUSH_NOTICE_KINDS,
    PUSH_NOTICE_TITLE,
    isPushNoticeKind,
    knowledgeAnswerNotice,
    knowledgeToCheckLine,
    pushNoticeWords,
    wordsFor,
} from '../index.js';

const EN = wordsFor('en');
const XX = wordsFor('xx');

describe("a member's limits", () => {
    it('3 waiting, 5 sent in any 24 hours, an answer kept 30 days; fixed', () => {
        expect(KNOWLEDGE_DRAFT_LIMITS).toEqual({ waiting: 3, perDay: 5, answeredDays: 30 });
        expect(Object.isFrozen(KNOWLEDGE_DRAFT_LIMITS)).toBe(true);
    });
});

describe('the answer a member keeps', () => {
    it('added: the title and thanks, naming nobody who answered', () => {
        expect(knowledgeAnswerNotice({ outcome: 'approved', title: 'How the tip works' }, EN)).toEqual({
            title: 'Your local knowledge is in',
            body: '"How the tip works" is now in Learn. Thank you.',
        });
    });

    it("not added: the reason's label, then the owner's or admin's own words when they wrote some", () => {
        const withWords = knowledgeAnswerNotice({ outcome: 'declined', title: 'Gossip', reason: 'person', words: '  Places, not people. ' }, EN);
        expect(withWords).toEqual({ title: "Your local knowledge wasn't added", body: `"Gossip" wasn't added. Reason: It's about a person. Places, not people.` });
        const without = knowledgeAnswerNotice({ outcome: 'declined', title: 'Again', reason: 'duplicate', words: '   ' }, EN);
        expect(without.body).toBe(`"Again" wasn't added. Reason: We already have this.`);
    });

    it('an unknown reason reads as "Another reason", never as nothing', () => {
        expect(knowledgeAnswerNotice({ outcome: 'declined', title: 'X', reason: 'boring' }, EN).body).toBe(`"X" wasn't added. Reason: Another reason.`);
        expect(KNOWLEDGE_DECLINE_REASONS[KNOWLEDGE_DECLINE_REASONS.length - 1].id).toBe('other');
    });

    it("a long title and the admin's 200 characters fit the 400 a kept notice holds in the commonest case", () => {
        const body = knowledgeAnswerNotice({ outcome: 'declined', title: 't'.repeat(KNOWLEDGE_LIMITS.title), reason: 'unchecked', words: 'w'.repeat(KNOWLEDGE_LIMITS.reasonWords) }, EN).body;
        expect(body.length).toBeLessThanOrEqual(400);
    });

    it("is written in the reader's language: every sentence goes through t() (the xx pseudo-language), the title and words as written", () => {
        const added = knowledgeAnswerNotice({ outcome: 'approved', title: 'Tip' }, XX);
        expect(added.title).not.toBe(KNOWLEDGE_DRAFT_WORDS.addedTitle);
        expect(added.body).toContain('Tip');
        const not = knowledgeAnswerNotice({ outcome: 'declined', title: 'Tip', reason: 'copied', words: 'Mine' }, XX);
        expect(not.body).toContain('Tip');
        expect(not.body).toContain('Mine');
        expect(not.body).not.toContain('It looks copied');
    });
});

describe("the owners' and admins' Needs-you line", () => {
    it('a count, never a name', () => {
        expect(knowledgeToCheckLine(3, EN)).toBe('Local knowledge to check: 3');
        expect(knowledgeToCheckLine(1, XX)).not.toBe('Local knowledge to check: 1');
        expect(knowledgeToCheckLine(1, XX)).toContain('1');
    });

    it("the push's details name who and what, landing in Learn", () => {
        expect(EN.t(KNOWLEDGE_DRAFT_WORDS.suggestedBody, { name: 'Mel', title: 'Tip' })).toBe('Mel suggested local knowledge: "Tip". Check it in Learn.');
    });
});

describe('the two push kinds', () => {
    it('land on Home, where Learn opens, with fixed words: no name, title, reason or answer on a lock screen', () => {
        for (const kind of ['community.knowledge', 'community.knowledge-answer'] as const) {
            expect(isPushNoticeKind(kind)).toBe(true);
            expect(PUSH_NOTICE_KINDS[kind].tab).toBe('home');
            expect(pushNoticeWords(kind).title).toBe(PUSH_NOTICE_TITLE);
            expect(pushNoticeWords(kind).body).not.toMatch(/"|added|declined|reason/i);
        }
        expect(pushNoticeWords('community.knowledge').body).toBe('A member suggested local knowledge for you to check.');
        expect(pushNoticeWords('community.knowledge-answer').body).toBe('Your local knowledge suggestion has an answer.');
    });
});

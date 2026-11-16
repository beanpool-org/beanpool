/**
 * Local knowledge in core, recognition (slice K8; DESIGN-local-knowledge-fable.md §2.10, §3.7): the badge's numbers and name,
 * the Thank words, and who is offered Thank, which both apps read (the phone's KnowledgeDetail, the web's LearnPage), so the
 * rule is one table here. Whether the member can send yet is never asked: the Send form says so in today's words.
 */
import { describe, expect, it } from 'vitest';
import {
    KNOWLEDGE_NAMES, KNOWLEDGE_THANK, LOCAL_GUIDE_BADGE, LOCAL_GUIDE_EMOJI, LOCAL_GUIDE_HELPED, LOCAL_GUIDE_WORDS, LOCAL_GUIDE_PAGES, isLocalGuide, knowledgeThankNote,
    knowledgeThankOffered, pseudoLocalise, setLanguage, t, wordsFor,
} from '../index.js';

describe('the Local guide badge', () => {
    it('is 3 pages of one\'s own, each helped by 3 members, and named "local-guide" on the wire', () => {
        expect([LOCAL_GUIDE_PAGES, LOCAL_GUIDE_HELPED, LOCAL_GUIDE_BADGE]).toEqual([3, 3, 'local-guide']);
        // The line both apps draw: the badge's emoji and its name, one sentence for the translators.
        expect(t(LOCAL_GUIDE_WORDS.line)).toBe('🗺️ Local guide');
        expect(t(LOCAL_GUIDE_WORDS.line)).toBe(`${LOCAL_GUIDE_EMOJI} ${t(KNOWLEDGE_NAMES.badge)}`);
    });

    it.each([
        [['local-guide'], true], [['local-guide', 'other'], true], [[], false], [['other'], false],
        [undefined, false], [null, false], ['local-guide', false], [{ 0: 'local-guide' }, false],
    ] as const)('isLocalGuide(%j) is %s: anything but a list holding it reads as no badge', (badges, yes) => {
        expect(isLocalGuide(badges)).toBe(yes);
    });
});

describe('Thank', () => {
    type Facts = Parameters<typeof knowledgeThankOffered>[0];
    const base: Facts = { signedIn: true, live: true, beansLive: true, own: false, gathered: false, writer: 'ada-pk' };
    // [what differs from a member reading someone else's page on a live Learn where Beans are live, offered?]
    const TABLE: Array<[string, Partial<Facts>, boolean]> = [
        ['a member, someone else\'s page', {}, true],
        ['the writer themselves', { own: true }, false],
        ['a visitor (no key)', { signedIn: false }, false],
        ['Learn not live (off, or the preview)', { live: false }, false],
        ['Beans not live (off, or the preview)', { beansLive: false }, false],
        ['gathered with the assistant', { gathered: true }, false],
        ['no writer named', { writer: '' }, false],
        ['a writer that is null', { writer: null }, false],
    ];
    it.each(TABLE)('%s: offered %s', (_name, over, offered) => {
        expect(knowledgeThankOffered({ ...base, ...over })).toBe(offered);
    });

    it('the button and the note, word for word, in the reader\'s language', () => {
        expect(t(KNOWLEDGE_THANK.button, { name: 'Ada' })).toBe('🫘 Thank Ada');
        expect(knowledgeThankNote('How recycling works at the tip')).toBe('Thanks for "How recycling works at the tip"');
        expect(knowledgeThankNote('Tip', wordsFor('en'))).toBe('Thanks for "Tip"');
        // Through the words layer: a pseudo-language draws both, so neither is bare English in an app.
        setLanguage('xx' as never);
        try {
            expect(t(KNOWLEDGE_THANK.button, { name: 'Ada' })).toBe(pseudoLocalise('🫘 Thank {name}').replace('{name}', 'Ada'));
        } finally {
            setLanguage('en');
        }
    });
});

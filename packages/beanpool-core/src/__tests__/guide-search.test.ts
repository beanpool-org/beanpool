import { describe, expect, it } from 'vitest';
import { searchGuide, type Guide, type GuidePage } from '../member-guide.js';

// How the guide's search orders pages (the phone and the web app share this one function). What the real pages rank is
// pinned on the pages in apps/native/utils/__tests__/guide.test.ts; this is the rule, on a small guide whose pages mimic
// the case that broke it: a page for the people who give credit says "gift" in nearly every paragraph, and the page a
// member wants, "Sending a gift", says it a few times.

const page = (slug: string, title: string, summary: string, paragraphs: string[]): GuidePage => ({
    slug, title, summary, section: 'about', related: [], blocks: paragraphs.map(text => ({ type: 'p' as const, text })),
});
const guide = (...guides: GuidePage[]): Guide => ({
    schema: 2, version: 1, hash: 'h',
    sections: [{ id: 'about', title: 'About', summary: 'S', slugs: guides.map(g => g.slug) }],
    guides,
});

const REPEATS = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}: a gift of Beans, and what a gift changes; give a gift and the gift counts.`);
const GIVER = page('credit-risk', 'Credit risk: what it reads', 'What the people who give credit see.', REPEATS);
const MEMBER = page('gifts', 'Sending a gift', 'Send beans to someone, with no trade.', ['A gift cannot be taken back.', 'Gifts have no fee.']);
const OTHER = page('how-it-works', 'How it works', 'Beans, trading and offers.', ['Beans move between members.']);

describe('searchGuide: the page named for what is typed comes first', () => {
    it('a page that only repeats the word in its body does not outrank the page whose title has it', () => {
        const g = guide(GIVER, MEMBER, OTHER);
        const byBody = searchGuide(g, 'gift').find(r => r.page.slug === 'credit-risk')!;
        const byTitle = searchGuide(g, 'gift').find(r => r.page.slug === 'gifts')!;
        // The giver page really scores higher on the word, so only the order puts the member's page first.
        expect(byBody.score).toBeGreaterThan(byTitle.score);
        expect(searchGuide(g, 'gift').map(r => r.page.slug)).toEqual(['gifts', 'credit-risk']);
    });

    it('with every word typed, the page whose title or summary covers more of them leads', () => {
        const g = guide(GIVER, MEMBER, OTHER);
        // "give" is in the giver page's summary, "beans" in the member page's; only "gift" (the synonym of "give") in its title.
        expect(searchGuide(g, 'give beans')[0].page.slug).toBe('gifts');
        expect(searchGuide(g, 'send a gift')[0].page.slug).toBe('gifts');
    });

    it('between pages named alike the old order stands: the higher score first', () => {
        const events = page('events', 'Events', 'Meet up.', Array.from({ length: 8 }, () => 'An event on the map. Add an event.'));
        const eventChat = page('event-chat', 'Event chat', 'Talk about it.', ['Chat about an event.']);
        expect(searchGuide(guide(eventChat, events), 'event').map(r => r.page.slug)).toEqual(['events', 'event-chat']);
    });

    it('a page that has the word only in its body still comes after, and is still found', () => {
        const g = guide(GIVER, OTHER);
        expect(searchGuide(g, 'gift').map(r => r.page.slug)).toEqual(['credit-risk']);
        expect(searchGuide(g, 'credit risk')[0].page.slug).toBe('credit-risk');
    });
});

describe('searchGuide: a plural finds the singular word', () => {
    it('"gifts" finds "gift" and leads like it', () => {
        const g = guide(GIVER, MEMBER, OTHER);
        expect(searchGuide(g, 'gifts').map(r => r.page.slug)).toEqual(['gifts', 'credit-risk']);
    });

    it('only the whole word: "beans" does not find every word that starts with "bean"', () => {
        const g = guide(
            page('a', 'Alpha', 'S', ['BeanPool is a network.']),
            page('b', 'Beta', 'S', ['Spend your Beans here.']),
        );
        expect(searchGuide(g, 'beans').map(r => r.page.slug)).toEqual(['b']);
        // ...but a singular word on a page is found by its plural.
        expect(searchGuide(guide(page('c', 'Gamma', 'S', ['One bean is enough.'])), 'beans').map(r => r.page.slug)).toEqual(['c']);
    });

    it('a word that ends in "ss", or has only three letters, is searched as typed', () => {
        // Cut to "clas" and "bu", the words of page a would be found; as typed, only page b has them.
        const g = guide(page('a', 'Alpha', 'S', ['A clas and a bu.']), page('b', 'Beta', 'S', ['A class and a bus.']));
        expect(searchGuide(g, 'class').map(r => r.page.slug)).toEqual(['b']);
        expect(searchGuide(g, 'bus').map(r => r.page.slug)).toEqual(['b']);
    });
});

/**
 * Local knowledge in core (slice K0; DESIGN-local-knowledge-fable.md as amended): the topics, the limits, the reasons, the
 * order Learn lists in, the feature's mode, and the two guards core holds (the map never pins one; the chooser's line).
 */
import { describe, expect, it } from 'vitest';
import {
    BRAND_COLOURS,
    KNOWLEDGE_DECLINE_REASONS,
    KNOWLEDGE_LIMITS,
    KNOWLEDGE_TOPICS,
    KNOWLEDGE_TYPE,
    LEGACY_CATEGORY_ALIASES,
    POST_TYPE_LINES,
    PRICING_CATEGORIES,
    SAMPLE_COMMUNITY,
    brandContrastPairs,
    compareKnowledge,
    isKnowledgeTopic,
    isPulseKnowledgeCard,
    isSampleId,
    knowledgeFeatureMode,
    knowledgeFirstLine,
    knowledgeTopicRank,
    marketPinMatchesFilter,
    sortKnowledge,
    visibleMarketPins,
} from '../index.js';

describe('the topics', () => {
    it('are seven, in the fixed order, Emergencies first, with unique ids', () => {
        expect(KNOWLEDGE_TOPICS.map((t) => t.id)).toEqual([
            'emergencies', 'local-services', 'getting-around', 'growing-animals', 'health-help', 'places-history', 'good-to-know',
        ]);
        expect(KNOWLEDGE_TOPICS[0].label).toBe('Emergencies');
    });

    it('no topic id is a listing category or a legacy alias, so no listing read takes one for its own', () => {
        const listing = new Set([...PRICING_CATEGORIES.map((c) => c.id), ...Object.keys(LEGACY_CATEGORY_ALIASES)]);
        for (const t of KNOWLEDGE_TOPICS) expect(listing.has(t.id), t.id).toBe(false);
        // And fits a listing's category column (LISTING_CATEGORY_LIMIT, 50).
        for (const t of KNOWLEDGE_TOPICS) expect(t.id.length).toBeLessThanOrEqual(50);
    });

    it('draws on an API 26 phone: no glyph newer than Unicode 7 (no 🧭)', () => {
        // Each glyph's first code point, against the newest it may be: everything here is from Unicode 7.0 (2014) or older.
        const newest7 = new Set([0x1f6a8, 0x1f6b0, 0x1f68c, 0x1f33f, 0x26d1, 0x1f3de, 0x1f4a1]);
        for (const t of KNOWLEDGE_TOPICS) expect(newest7.has(t.emoji.codePointAt(0)!), `${t.id} ${t.emoji}`).toBe(true);
        expect(KNOWLEDGE_TOPICS.some((t) => t.emoji.includes('🧭'))).toBe(false);
    });

    it('isKnowledgeTopic and the rank read only the seven', () => {
        expect(isKnowledgeTopic('emergencies')).toBe(true);
        expect(isKnowledgeTopic('food')).toBe(false);
        expect(isKnowledgeTopic(undefined)).toBe(false);
        expect(knowledgeTopicRank('emergencies')).toBe(0);
        expect(knowledgeTopicRank('good-to-know')).toBe(6);
        expect(knowledgeTopicRank('nope')).toBe(7);
    });
});

describe('the limits and the reasons', () => {
    it('are the design\'s numbers', () => {
        expect(KNOWLEDGE_LIMITS).toMatchObject({ title: 80, body: 3000, place: 80, sources: 5, sourceUrl: 500, sourceLabel: 80, outdatedNote: 140, changeNote: 300, reasonWords: 200, photos: 3 });
        expect(Object.isFrozen(KNOWLEDGE_LIMITS)).toBe(true);
    });

    it('"Not this one" has six reasons, "Another reason" last', () => {
        expect(KNOWLEDGE_DECLINE_REASONS.map((r) => r.id)).toEqual(['person', 'copied', 'unchecked', 'duplicate', 'elsewhere', 'other']);
        expect(KNOWLEDGE_DECLINE_REASONS[5].label).toBe('Another reason');
    });
});

describe("Learn's order: never by date", () => {
    const row = (title: string, topic: string, more: { pinned?: boolean; helped?: number; outdated?: boolean } = {}) => ({ title, topic, ...more });

    it('topics in their fixed order; out of date last in a topic; then pinned, most helped, title A to Z', () => {
        const rows = [
            row('Zebra crossing', 'getting-around'),
            row('Old bus times', 'getting-around', { outdated: true, pinned: true, helped: 99 }),
            row('Apple trees', 'growing-animals', { helped: 1 }),
            row('Bins', 'local-services', { helped: 3 }),
            row('Alpha', 'local-services', { helped: 3 }),
            row('Pinned one', 'local-services', { pinned: true }),
            row('Flood line', 'emergencies'),
            row('Most helped', 'local-services', { helped: 40 }),
        ];
        expect(sortKnowledge(rows).map((r) => r.title)).toEqual([
            'Flood line',
            'Pinned one', 'Most helped', 'Alpha', 'Bins',
            'Zebra crossing', 'Old bus times',
            'Apple trees',
        ]);
        // The list given is not changed.
        expect(rows[0].title).toBe('Zebra crossing');
    });

    it("takes the reader's own collation for titles", () => {
        const reversed = (a: string, b: string) => b.localeCompare(a);
        const rows = [row('a', 'emergencies'), row('b', 'emergencies')];
        expect(sortKnowledge(rows, reversed).map((r) => r.title)).toEqual(['b', 'a']);
        expect(compareKnowledge(rows[0], rows[1])).toBeLessThan(0);
    });
});

describe('the first line a row shows', () => {
    it('is the body up to its first line break, trimmed', () => {
        expect(knowledgeFirstLine('  Call the council first.\nThen the rest.')).toBe('Call the council first.');
        expect(knowledgeFirstLine('One line')).toBe('One line');
        expect(knowledgeFirstLine('')).toBe('');
    });
});

describe('the feature: on only where the node says so', () => {
    it('a node from before Learn (no key) has none: hidden, not on', () => {
        expect(knowledgeFeatureMode({ beans: true })).toBe('hidden');
        expect(knowledgeFeatureMode(undefined)).toBe('hidden');
        expect(knowledgeFeatureMode({ knowledge: false })).toBe('hidden');
    });

    it('true is live; off on a node that shows previews (the global community) is a preview', () => {
        expect(knowledgeFeatureMode({ knowledge: true })).toBe('live');
        expect(knowledgeFeatureMode({ knowledge: false, showcase: true })).toBe('preview');
        expect(knowledgeFeatureMode({ showcase: true })).toBe('preview');
    });
});

describe('the guards core holds', () => {
    it('the map never pins a knowledge post, under any filter, even one with a place', () => {
        const post = { type: KNOWLEDGE_TYPE, status: 'active', category: 'emergencies', lat: -28.5, lng: 153.5 };
        for (const type of ['all', 'offers', 'needs', 'events'] as const) {
            expect(marketPinMatchesFilter(post, { type, category: 'all', eventWindow: 'all' }), type).toBe(false);
        }
        expect(visibleMarketPins([post], { type: 'all', category: 'all', eventWindow: 'all' })).toEqual([]);
        // An Offer beside it still pins.
        expect(visibleMarketPins([{ ...post, type: 'offer' }], { type: 'all', category: 'all', eventWindow: 'all' })).toHaveLength(1);
    });

    it("the kind has its chooser line beside the other four", () => {
        expect(POST_TYPE_LINES.knowledge).toBe('Something worth knowing about this place');
        expect(Object.keys(POST_TYPE_LINES)).toEqual(['offer', 'need', 'poll', 'event', 'knowledge']);
    });

    it('the learn colour role is teal and reads at AA in both themes', () => {
        expect(BRAND_COLOURS.chip.learn).toEqual({ tint: BRAND_COLOURS.card.teal.tint, ink: BRAND_COLOURS.card.teal.ink });
        expect(BRAND_COLOURS.ink.learn).toEqual(BRAND_COLOURS.chip.learn.ink);
        const pairs = brandContrastPairs().filter((p) => p.role === 'chip.learn' || p.role === 'ink.learn');
        expect(pairs.length).toBeGreaterThan(2);
        for (const p of pairs) expect(p.ratio, `${p.theme} ${p.role} ${p.pair}`).toBeGreaterThanOrEqual(4.5);
    });
});

describe("Example Valley's three pages", () => {
    it('one per topic, each a sample id, a real topic, no source and no name', () => {
        const pages = SAMPLE_COMMUNITY.knowledge;
        expect(pages).toHaveLength(3);
        for (const p of pages) {
            expect(isSampleId(p.id), p.id).toBe(true);
            expect(isKnowledgeTopic(p.topic), p.topic).toBe(true);
            expect(p.title.length).toBeLessThanOrEqual(KNOWLEDGE_LIMITS.title);
            expect(p.body.length).toBeLessThanOrEqual(KNOWLEDGE_LIMITS.body);
            expect('sources' in p).toBe(false);
        }
        expect(new Set(pages.map((p) => p.topic)).size).toBe(3);
        expect(Object.isFrozen(pages)).toBe(true);
    });
});

describe('the Pulse card', () => {
    it('is told apart by its source alone', () => {
        expect(isPulseKnowledgeCard({ source: 'knowledge', id: 'know_2026-11-11' })).toBe(true);
        expect(isPulseKnowledgeCard({ source: 'oauth' })).toBe(false);
        expect(isPulseKnowledgeCard(null)).toBe(false);
    });
});

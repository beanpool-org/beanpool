import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_FRONT_ROWS, KNOWLEDGE_SEARCH_MAX, KNOWLEDGE_TOPIC_PAGE, KNOWLEDGE_TOPICS, SAMPLE_COMMUNITY } from '@beanpool/core';
import { learnFront, learnRows, learnSearch, learnTopic, pageShows, rowOfPage, searchTerms, type KnowledgePage } from '../learn-copy';
import { samplePages } from '../../components/showcase/sample-screens';

// Learn on the phone reads the phone's own copy of the pages and must read as the node's own front does
// (apps/server engine/knowledge.ts): the same row, the same order, the same scoring.

const NOW = Date.parse('2026-11-12T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

let n = 0;
function page(over: Partial<KnowledgePage> & { knowledge?: KnowledgePage['knowledge'] } = {}): KnowledgePage {
    n += 1;
    const { knowledge, ...rest } = over;
    return {
        id: `k${n}`,
        title: `Page ${n}`,
        description: `First line ${n}\nThe rest of the body.`,
        category: 'good-to-know',
        status: 'active',
        createdAt: iso(100),
        knowledge: { sources: [], place: null, checkedAt: iso(10), helped: 0, ...knowledge },
        ...rest,
    };
}

describe('a row is what the row card draws, never the body', () => {
    it("carries the first line, the topic, the first photo, the checked date, the helped count and the two marks", () => {
        const row = rowOfPage(page({
            id: 'a', title: 'How recycling works', description: 'Sort it at home.\nGlass in the blue bin.\nPaint goes to the shed.',
            category: 'local-services', photos: ['/p/1.jpg', '/p/2.jpg'],
            pinnedUntil: new Date(NOW + DAY).toISOString(),
            knowledge: { checkedAt: iso(3), helped: 7, outdatedAt: iso(1) },
        }), NOW);
        expect(row).toEqual({
            id: 'a', title: 'How recycling works', line: 'Sort it at home.', topic: 'local-services', photo: '/p/1.jpg',
            checkedAt: iso(3), helped: 7, pinned: true, outdated: true,
        });
        expect(JSON.stringify(row)).not.toContain('Glass in the blue bin');
    });

    it('has no photo for a page without one, and a pin that has ended is not a pin', () => {
        const row = rowOfPage(page({ pinnedUntil: new Date(NOW - 1000).toISOString() }), NOW);
        expect(row.photo).toBeNull();
        expect(row.pinned).toBe(false);
        expect(row.outdated).toBe(false);
    });
});

describe('which pages show', () => {
    it('leaves out a page the node tombstoned, paused or hid by reports', () => {
        expect(pageShows(page())).toBe(true);
        expect(pageShows(page({ active: 0 }))).toBe(false);
        expect(pageShows(page({ active: false }))).toBe(false);
        expect(pageShows(page({ status: 'paused' }))).toBe(false);
        expect(pageShows(page({ hiddenByReportsAt: iso(1) }))).toBe(false);
        expect(pageShows({} as KnowledgePage)).toBe(false);
    });
});

describe("Learn's order: topics as listed, then not-out-of-date, pinned, most helped, title A to Z, never by date", () => {
    it('puts the topics in their fixed order with Emergencies first, whatever order the pages came in', () => {
        const pages = [
            page({ title: 'Z', category: 'good-to-know' }),
            page({ title: 'Y', category: 'emergencies' }),
            page({ title: 'X', category: 'getting-around' }),
        ];
        expect(learnRows(pages, NOW).map((r) => r.topic)).toEqual(['emergencies', 'getting-around', 'good-to-know']);
    });

    it('inside a topic: a page marked out of date last, pinned first, then most helped, then title', () => {
        const topic = 'local-services';
        const rows = learnRows([
            page({ title: 'Old and stale', category: topic, knowledge: { helped: 99, outdatedAt: iso(2) } }),
            page({ title: 'Beta', category: topic, knowledge: { helped: 5 } }),
            page({ title: 'Alpha', category: topic, knowledge: { helped: 5 } }),
            page({ title: 'Popular', category: topic, knowledge: { helped: 40 } }),
            page({ title: 'Pinned but unhelpful', category: topic, pinnedUntil: new Date(NOW + DAY).toISOString(), knowledge: { helped: 0 } }),
        ], NOW);
        expect(rows.map((r) => r.title)).toEqual(['Pinned but unhelpful', 'Popular', 'Alpha', 'Beta', 'Old and stale']);
    });

    it('never orders by date: the newest page does not lead', () => {
        const rows = learnRows([
            page({ title: 'Newest', category: 'emergencies', createdAt: iso(0), knowledge: { checkedAt: iso(0) } }),
            page({ title: 'Aardvark', category: 'emergencies', createdAt: iso(900), knowledge: { checkedAt: iso(900) } }),
        ], NOW);
        expect(rows.map((r) => r.title)).toEqual(['Aardvark', 'Newest']);
    });
});

describe('the front: pinned pages, then each topic that holds something, three rows a topic', () => {
    it('counts every page of a topic and shows only the first three; an empty topic is not listed', () => {
        const pages = [
            ...Array.from({ length: 5 }, (_, i) => page({ title: `Service ${i}`, category: 'local-services' })),
            page({ title: 'River', category: 'emergencies' }),
        ];
        const front = learnFront(pages, NOW);
        expect(front.total).toBe(6);
        expect(front.topics.map((t) => t.id)).toEqual(['emergencies', 'local-services']);
        const services = front.topics.find((t) => t.id === 'local-services')!;
        expect(services.count).toBe(5);
        expect(services.rows).toHaveLength(KNOWLEDGE_FRONT_ROWS);
        expect(front.pinned).toEqual([]);
    });

    it('lists a pinned page under pinned and in its topic too', () => {
        const front = learnFront([page({ id: 'p', title: 'Pinned', category: 'emergencies', pinnedUntil: new Date(NOW + DAY).toISOString() })], NOW);
        expect(front.pinned.map((r) => r.id)).toEqual(['p']);
        expect(front.topics[0].rows.map((r) => r.id)).toEqual(['p']);
    });

    it('is empty with no pages, and a tombstoned page is not counted', () => {
        expect(learnFront([], NOW)).toEqual({ total: 0, pinned: [], topics: [] });
        expect(learnFront([page({ active: 0 })], NOW).total).toBe(0);
    });
});

describe('one topic, paged as the node pages it', () => {
    it('answers every row of the topic in order, with the offset of the next page when there is one', () => {
        const pages = Array.from({ length: KNOWLEDGE_TOPIC_PAGE + 5 }, (_, i) => page({ title: `T${String(i).padStart(3, '0')}`, category: 'getting-around' }));
        const first = learnTopic(pages, 'getting-around', 0, NOW);
        expect(first.count).toBe(KNOWLEDGE_TOPIC_PAGE + 5);
        expect(first.rows).toHaveLength(KNOWLEDGE_TOPIC_PAGE);
        expect(first.next).toBe(KNOWLEDGE_TOPIC_PAGE);
        const second = learnTopic(pages, 'getting-around', KNOWLEDGE_TOPIC_PAGE, NOW);
        expect(second.rows).toHaveLength(5);
        expect(second.next).toBeNull();
        expect(learnTopic(pages, 'emergencies', 0, NOW)).toEqual({ topic: 'emergencies', count: 0, rows: [], next: null });
    });
});

describe('the offline search: a plain match over the copy, scored as the node scores it', () => {
    const pages = [
        page({ id: 'body', title: 'Opening hours', description: 'Closed on Mondays. Bring your recycling sorted.', category: 'good-to-know' }),
        page({ id: 'title', title: 'Recycling at the tip', description: 'Glass and cans.', category: 'local-services' }),
        page({ id: 'place', title: 'Green waste', description: 'Free on the first weekend.', category: 'local-services', knowledge: { place: 'The recycling shed by the gate' } }),
        page({ id: 'none', title: 'Bus times', description: 'Weekdays at 8 and 1.', category: 'getting-around' }),
    ];

    it('ranks a word in the title above one in the place above one in the body', () => {
        const found = learnSearch(pages, 'recycling', NOW);
        expect(found.rows.map((r) => r.id)).toEqual(['title', 'place', 'body']);
        expect(found.total).toBe(3);
    });

    it("finds a page by its topic's words, so 'flood' finds an Emergencies page whatever its title says", () => {
        const found = learnSearch([page({ id: 'e', title: 'Who to call', description: 'The council roads line.', category: 'emergencies' })], 'flood', NOW);
        expect(found.rows.map((r) => r.id)).toEqual(['e']);
    });

    it('matches any of several words, the one that holds more ranks higher', () => {
        const found = learnSearch(pages, 'recycling glass', NOW);
        expect(found.rows[0].id).toBe('title');
    });

    it('is case-blind, ignores extra spaces, and matches a script written without spaces', () => {
        expect(learnSearch(pages, '  RECYCLING  ', NOW).total).toBe(3);
        expect(searchTerms('  a  b ')).toEqual(['a', 'b']);
        const cjk = [page({ id: 'cjk', title: '回収センターの場所', description: '月曜は休み。', category: 'local-services' })];
        expect(learnSearch(cjk, '回収', NOW).rows.map((r) => r.id)).toEqual(['cjk']);
    });

    it('finds nothing for no words or for words nowhere, and a tombstoned page never matches', () => {
        expect(learnSearch(pages, '', NOW)).toEqual({ total: 0, rows: [] });
        expect(learnSearch(pages, 'zzzz', NOW).total).toBe(0);
        expect(learnSearch([page({ title: 'Recycling', active: 0 })], 'recycling', NOW).total).toBe(0);
    });

    it('answers at most the node’s most matches', () => {
        const many = Array.from({ length: KNOWLEDGE_SEARCH_MAX + 10 }, (_, i) => page({ title: `Tip ${i}`, category: 'good-to-know' }));
        const found = learnSearch(many, 'tip', NOW);
        expect(found.total).toBe(KNOWLEDGE_SEARCH_MAX + 10);
        expect(found.rows).toHaveLength(KNOWLEDGE_SEARCH_MAX);
    });
});

describe("Example Valley's pages for the worldwide community's preview", () => {
    it('are the three samples, one per topic, with sample ids and no source and no writer', () => {
        const samples = samplePages(NOW);
        expect(samples).toHaveLength(SAMPLE_COMMUNITY.knowledge.length);
        expect(samples.map((s) => s.id)).toEqual(SAMPLE_COMMUNITY.knowledge.map((s) => s.id));
        for (const s of samples) {
            expect(s.id.startsWith('sample-')).toBe(true);
            expect(s.knowledge?.sources).toEqual([]);
            expect(s.authorPublicKey).toBeUndefined();
        }
        const front = learnFront(samples, NOW);
        expect(front.total).toBe(3);
        expect(front.topics.map((t) => t.id)).toEqual(['emergencies', 'local-services', 'getting-around']);
    });

    it('cover only topics Learn has', () => {
        const known = new Set(KNOWLEDGE_TOPICS.map((t) => t.id as string));
        for (const s of samplePages(NOW)) expect(known.has(s.category)).toBe(true);
    });
});

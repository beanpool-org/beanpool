/**
 * Learn's reads and rules on the web (slice K2): the four reads ask the node's routes and nothing else; the lists are made
 * by core's order rule, so a preview reads as a node does; a page's date, host and link are what a member sees before they tap.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { KNOWLEDGE_TOPICS, KNOWLEDGE_TOPIC_PAGE, KNOWLEDGE_SEARCH_MAX, livePostChange, marketPinMatchesFilter } from '@beanpool/core';
import * as api from './api';
import {
    checkedOverAYear, getLearnFront, getLearnPost, getLearnTopic, learnFrontOf, learnRowOf, learnSearchOf, learnTopicOf, monthYear,
    safeSourceUrl, searchLearn, showsLearn, sourceHost, type LearnPost,
} from './learn';
import { sampleLearnPosts } from '../components/ShowcasePreviews';
import { CLIENT_POST_TYPES } from './events';

const NOW = Date.parse('2026-11-12T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function page(id: string, extra: Partial<LearnPost> & { helped?: number; place?: string | null; outdated?: boolean } = {}): LearnPost {
    const { helped = 0, place = null, outdated = false, ...rest } = extra;
    return {
        id, type: 'knowledge', category: 'good-to-know', title: `Title ${id}`, description: `First line of ${id}\nThe rest of ${id}, which a row never carries.`,
        authorPublicKey: 'ada-pk', authorCallsign: 'Ada', createdAt: '2026-10-01T00:00:00.000Z', status: 'active', photos: [],
        knowledge: { sources: [], place, lang: null, checkedAt: '2026-10-20T00:00:00.000Z', outdatedAt: outdated ? '2026-11-01T00:00:00.000Z' : null, outdatedNote: null, helped, gathered: false },
        ...rest,
    };
}

let request: MockInstance<typeof api.request>;
beforeEach(() => { request = vi.spyOn(api, 'request'); });
afterEach(() => { vi.restoreAllMocks(); });

describe('the four reads', () => {
    it('Learn\'s front is one signed GET of the front route', async () => {
        request.mockResolvedValue({ total: 0, pinned: [], topics: [] });
        await getLearnFront();
        expect(request).toHaveBeenCalledWith('GET', '/api/knowledge/front');
    });

    it('a topic names the topic and where its page starts', async () => {
        request.mockResolvedValue({ topic: 'emergencies', count: 0, rows: [], next: null });
        await getLearnTopic('emergencies');
        await getLearnTopic('local-services', 50);
        expect(request.mock.calls.map((c) => c[1])).toEqual([
            '/api/knowledge/front?topic=emergencies&offset=0',
            '/api/knowledge/front?topic=local-services&offset=50',
        ]);
    });

    it('a search sends the trimmed words, encoded, at most 100 characters', async () => {
        request.mockResolvedValue({ total: 0, rows: [] });
        await searchLearn('  tip & bins  ');
        await searchLearn('x'.repeat(150));
        const paths = request.mock.calls.map((c) => String(c[1]));
        expect(paths[0]).toBe('/api/knowledge/front?q=tip+%26+bins');
        expect(decodeURIComponent(paths[1].split('q=')[1])).toHaveLength(100);
    });

    it('a page whole is read by id and names the type, so the node gives it', async () => {
        const post = page('a');
        request.mockResolvedValue([post]);
        expect(await getLearnPost('a')).toEqual(post);
        expect(request).toHaveBeenCalledWith('GET', '/api/marketplace/posts?type=knowledge&id=a');
    });

    it('is null for anything that is not that page of Local knowledge', async () => {
        const listing = { ...page('a'), type: 'offer' };
        const noFields = { ...page('a'), knowledge: undefined };
        for (const answer of [[], [listing], [noFields], [page('other')], null, 'nope', {}]) {
            request.mockResolvedValueOnce(answer);
            expect(await getLearnPost('a')).toBeNull();
        }
    });
});

describe('a row', () => {
    it('is what the card draws: the first line, never the body', () => {
        const row = learnRowOf(page('a', { helped: 4, photos: ['/p/1.jpg', '/p/2.jpg'] }), NOW);
        expect(row).toEqual({
            id: 'a', title: 'Title a', line: 'First line of a', topic: 'good-to-know', photo: '/p/1.jpg',
            checkedAt: '2026-10-20T00:00:00.000Z', helped: 4, pinned: false, outdated: false,
        });
        expect(JSON.stringify(row)).not.toContain('which a row never carries');
    });

    it('is pinned while the pin runs, marked while a mark stands, and checked when it was made if never checked', () => {
        const pinned = learnRowOf(page('p', { pinnedUntil: new Date(NOW + DAY).toISOString() }), NOW);
        const lapsed = learnRowOf(page('l', { pinnedUntil: new Date(NOW - DAY).toISOString() }), NOW);
        expect(pinned.pinned).toBe(true);
        expect(lapsed.pinned).toBe(false);
        expect(learnRowOf(page('o', { outdated: true }), NOW).outdated).toBe(true);
        const never = page('n');
        never.knowledge.checkedAt = undefined as never;
        expect(learnRowOf(never, NOW).checkedAt).toBe(never.createdAt);
    });
});

describe('Learn\'s front from pages in hand', () => {
    it('groups by topic in core\'s order (Emergencies first), drops empty topics, and shows three rows with the true count', () => {
        const posts = [
            page('g1', { category: 'good-to-know' }),
            ...['e1', 'e2', 'e3', 'e4', 'e5'].map((id) => page(id, { category: 'emergencies' })),
            page('s1', { category: 'local-services' }),
        ];
        const front = learnFrontOf(posts, NOW);
        expect(front.total).toBe(7);
        expect(front.topics.map((t) => t.id)).toEqual(['emergencies', 'local-services', 'good-to-know']);
        expect(front.topics[0].count).toBe(5);
        expect(front.topics[0].rows).toHaveLength(3);
        expect(front.topics.map((t) => t.id)).toEqual(KNOWLEDGE_TOPICS.map((t) => t.id).filter((id) => ['emergencies', 'local-services', 'good-to-know'].includes(id)));
    });

    it('orders inside a topic: marked out of date last, then pinned, then most helped, then the title A to Z; never by date', () => {
        const posts = [
            page('z', { title: 'Zebra', helped: 5 }),
            page('a', { title: 'Apple', helped: 5 }),
            page('top', { title: 'Most helped', helped: 9 }),
            page('old', { title: 'Marked', helped: 99, outdated: true }),
            page('pin', { title: 'Pinned', helped: 0, pinnedUntil: new Date(NOW + DAY).toISOString() }),
        ];
        posts[0].knowledge.checkedAt = '2026-11-11T00:00:00.000Z'; // the newest: still not first
        const topic = learnTopicOf(posts, 'good-to-know', 0, NOW);
        expect(topic.rows.map((r) => r.title)).toEqual(['Pinned', 'Most helped', 'Apple', 'Zebra', 'Marked']);
        expect(learnFrontOf(posts, NOW).pinned.map((r) => r.title)).toEqual(['Pinned']);
    });

    it('pages a topic 50 at a time: next is where the following page starts, and null at the end', () => {
        const posts = Array.from({ length: KNOWLEDGE_TOPIC_PAGE + 5 }, (_, i) => page(`p${String(i).padStart(3, '0')}`, { title: `T${String(i).padStart(3, '0')}` }));
        const first = learnTopicOf(posts, 'good-to-know', 0, NOW);
        expect(first.rows).toHaveLength(KNOWLEDGE_TOPIC_PAGE);
        expect(first.next).toBe(KNOWLEDGE_TOPIC_PAGE);
        expect(first.count).toBe(KNOWLEDGE_TOPIC_PAGE + 5);
        const second = learnTopicOf(posts, 'good-to-know', first.next!, NOW);
        expect(second.rows).toHaveLength(5);
        expect(second.next).toBeNull();
        expect(learnTopicOf(posts, 'emergencies', 0, NOW)).toMatchObject({ count: 0, rows: [], next: null });
    });
});

describe('a plain search over pages in hand', () => {
    const posts = [
        page('body', { title: 'Collection days', description: 'Bins go out on Tuesday. The tip is closed on Mondays.', category: 'local-services' }),
        page('title', { title: 'How the tip works', description: 'Sort glass from cans.', category: 'local-services' }),
        page('place', { title: 'Green waste', description: 'Free on the first weekend.', category: 'local-services', place: 'The tip on the quarry road' }),
        page('none', { title: 'The bus', description: 'Leaves at eight.', category: 'getting-around' }),
    ];

    it('puts a word in the title before the place, and the place before the body', () => {
        const found = learnSearchOf(posts, 'tip', NOW);
        expect(found.rows.map((r) => r.id)).toEqual(['title', 'place', 'body']);
        expect(found.total).toBe(3);
    });

    it('finds a page by its topic\'s own words, as the node does: "flood" reaches Emergencies whatever the title says', () => {
        const flood = [page('creek', { title: 'Who to call at the creek', description: 'Ring the council.', category: 'emergencies' })];
        expect(learnSearchOf(flood, 'flood', NOW).rows.map((r) => r.id)).toEqual(['creek']);
        expect(learnSearchOf(flood, 'bicycle', NOW).total).toBe(0);
    });

    it('asks for nothing with no words, and answers at most KNOWLEDGE_SEARCH_MAX rows with the true total', () => {
        expect(learnSearchOf(posts, '   ', NOW)).toEqual({ total: 0, rows: [] });
        const many = Array.from({ length: KNOWLEDGE_SEARCH_MAX + 4 }, (_, i) => page(`m${i}`, { title: `Tip ${i}` }));
        const found = learnSearchOf(many, 'tip', NOW);
        expect(found.total).toBe(KNOWLEDGE_SEARCH_MAX + 4);
        expect(found.rows).toHaveLength(KNOWLEDGE_SEARCH_MAX);
    });
});

describe('what a page says about itself', () => {
    it('"Checked" is a month and a year', () => {
        expect(monthYear('2026-11-12T10:00:00.000Z')).toBe('Nov 2026');
        expect(monthYear('not a date')).toBe('');
    });

    it('is over a year old only after a year', () => {
        expect(checkedOverAYear(new Date(NOW - 366 * DAY).toISOString(), NOW)).toBe(true);
        expect(checkedOverAYear(new Date(NOW - 364 * DAY).toISOString(), NOW)).toBe(false);
        expect(checkedOverAYear('garbage', NOW)).toBe(false);
    });

    it('a source opens only as http or https; a script, data or file address is not a link', () => {
        expect(safeSourceUrl('https://council.example/waste')).toBe('https://council.example/waste');
        expect(safeSourceUrl('http://council.example/')).toBe('http://council.example/');
        for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'ftp://x.example/', 'council.example', '']) {
            expect(safeSourceUrl(bad), bad).toBeNull();
        }
    });

    it('shows the host a source lives on, without www or the path', () => {
        expect(sourceHost('https://www.council.example/waste/tip?x=1')).toBe('council.example');
        expect(sourceHost('http://roads.council.example:8080/a')).toBe('roads.council.example:8080');
        expect(sourceHost('not a url')).toBe('not a url');
    });

    it('lets the member in for a live community and for the preview, not for a hidden one', () => {
        expect(['live', 'read-only', 'preview'].every((m) => showsLearn(m as never))).toBe(true);
        expect(showsLearn('hidden')).toBe(false);
    });
});

describe('Example Valley\'s pages', () => {
    it('are three, one a topic, named by nobody, with no source and no photo, each checked the days ago the sample says', () => {
        const pages = sampleLearnPosts(NOW);
        expect(pages).toHaveLength(3);
        expect(pages.every((p) => p.id.startsWith('sample-') && p.authorPublicKey === '' && p.knowledge.sources.length === 0 && (p.photos ?? []).length === 0)).toBe(true);
        expect(pages.map((p) => p.category)).toEqual(['emergencies', 'local-services', 'getting-around']);
        expect(Date.parse(pages[0].knowledge.checkedAt)).toBe(NOW - 20 * DAY);
        expect(learnFrontOf(pages, NOW).topics.map((t) => t.id)).toEqual(['emergencies', 'local-services', 'getting-around']);
    });
});

describe('the Market and the map hold no page of Local knowledge', () => {
    it('the Market\'s own list of kinds never names it, and so asks the node for none', () => {
        expect(CLIENT_POST_TYPES.split(',')).toEqual(['offer', 'need', 'poll', 'event']);
    });

    it('a page\'s doorbell on the socket is no change to apply to a list: every app runs its own sync', () => {
        const doorbell = { id: 'k1', type: 'knowledge', audienceScope: 'public', updatedAt: '2026-11-12T00:00:00.000Z' };
        expect(livePostChange({ type: 'new_post', post: doorbell })).toBeNull();
        expect(livePostChange({ type: 'post_updated', post: doorbell })).toBeNull();
    });

    it('a pin is never drawn for one, on any map filter', () => {
        for (const type of ['all', 'offers', 'needs', 'events'] as const) {
            expect(marketPinMatchesFilter({ type: 'knowledge', status: 'active', lat: 1, lng: 1 }, { type, category: 'all' } as never), type).toBe(false);
        }
    });
});

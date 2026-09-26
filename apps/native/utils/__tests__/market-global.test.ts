/**
 * The Market on a node with Beans off, the worldwide community (utils/market-global.ts): no Beans anywhere on it,
 * nearest first, and local communities exactly as they were.
 *
 * The Market screen itself can't be drawn here (vitest.config.ts: logic, not screens), so the last block reads the
 * screens' source and checks that every place a Beans figure is drawn is behind the rule tested above it.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';

// Device modules, stubbed at the boundary (vitest.config.ts): the signer's random bytes and the phone's storage.
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(len)) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
}));
import * as path from 'node:path';
import {
    marketShowsBeans, marketExtras, marketSearchDistanceParams, nearestFirst, marketFeedSections, sortsByDistance,
    NO_BEANS_TERMS, NO_BEANS_EDIT_NOTE, NEAREST_FIRST_HEADING,
} from '../market-global';
import { readNodeProfile, type NodeProfile } from '../node-profile';
import { START_COMMUNITY_COPY, communityDetailsText, canCopyDetails } from '../start-community';
import { KNOCK_MESSAGES } from '../knock';
import { WANTS_TO_JOIN_HELP } from '../knock-inbox';

const GLOBAL = readNodeProfile({ profile: 'global', features: { beans: false, escrow: false, distanceSearch: true } })!;
const LOCAL = readNodeProfile({ profile: 'local', features: { beans: true, escrow: true, distanceSearch: false } })!;
const OLD = readNodeProfile({})!;

describe('Beans on the Market', () => {
    it('are shown on every local community, and on a node that says nothing (every node before profiles)', () => {
        expect(marketShowsBeans(LOCAL.features)).toBe(true);
        expect(marketShowsBeans(OLD.features)).toBe(true);
        expect(marketShowsBeans(null)).toBe(true);
        expect(marketExtras(['distance', 'trust', 'beans'], LOCAL.features)).toEqual(['distance', 'trust', 'beans']);
    });

    it('are not shown where the node says Beans are off: no price, no "Beans only" filter', () => {
        expect(marketShowsBeans(GLOBAL.features)).toBe(false);
        expect(marketExtras(['distance', 'trust', 'beans'], GLOBAL.features)).toEqual(['distance', 'trust']);
    });

    it('where a price was, the post says free, a swap, or ask, without a word of Beans', () => {
        expect(NO_BEANS_TERMS.value).toBe('Free, a swap, or ask');
        for (const text of [NO_BEANS_TERMS.label, NO_BEANS_TERMS.value, NO_BEANS_EDIT_NOTE]) expect(text).not.toMatch(/bean|🫘|credit/i);
        expect(NO_BEANS_TERMS.note).not.toMatch(/🫘|credit/i);
    });

    it('nothing the global community’s new screens say mentions Beans or credits', () => {
        const texts = [
            START_COMMUNITY_COPY.title, START_COMMUNITY_COPY.intro, START_COMMUNITY_COPY.after, START_COMMUNITY_COPY.website,
            START_COMMUNITY_COPY.copyButton, START_COMMUNITY_COPY.copied, ...START_COMMUNITY_COPY.ways.flatMap(w => [w.title, w.body]),
            ...Object.values(KNOCK_MESSAGES),
        ];
        for (const t of texts) expect(t).not.toMatch(/\bbeans?\b|🫘|credit/i);
        // Seen by members of a LOCAL community, where Beans are fine, but it has no reason to mention them either.
        expect(WANTS_TO_JOIN_HELP).not.toMatch(/bean/i);
    });
});

describe('nearest first', () => {
    const here = { lat: -28.55, lng: 153.5 }; // Mullumbimby
    const posts = [
        { id: 'melbourne', type: 'offer', lat: -37.81, lng: 144.96, created_at: '2026-09-26T08:00:00Z' },
        { id: 'noplace', type: 'offer', lat: null, lng: null, created_at: '2026-09-26T08:00:00Z' },
        { id: 'byron', type: 'need', lat: -28.64, lng: 153.61, created_at: '2026-09-20T08:00:00Z' },
        { id: 'zero', type: 'offer', lat: 0, lng: 0, created_at: '2026-09-26T08:00:00Z' },
        { id: 'brisbane', type: 'offer', lat: -27.47, lng: 153.03, created_at: '2026-09-25T08:00:00Z' },
        { id: 'event', type: 'event', lat: -28.55, lng: 153.5, event_start_at: '2026-10-01T08:00:00Z' },
    ];

    it('orders by distance from the member, places unknown (or 0,0) last in their own order', () => {
        expect(nearestFirst(posts.filter(p => p.type !== 'event'), here).map(p => p.id)).toEqual(['byron', 'brisbane', 'melbourne', 'noplace', 'zero']);
    });

    it('the global feed: events first as everywhere, then every listing nearest first under one heading', () => {
        const sections = marketFeedSections(posts, GLOBAL, here, Date.parse('2026-09-26T12:00:00Z'));
        expect(sections.map(s => s.title)).toEqual(['Upcoming events', NEAREST_FIRST_HEADING]);
        expect(sections[1].posts.map(p => p.id)).toEqual(['byron', 'brisbane', 'melbourne', 'noplace', 'zero']);
    });

    it('a local community, or no location yet: the day headings, as before', () => {
        const now = Date.parse('2026-09-26T12:00:00Z');
        const byDay = ['Upcoming events', 'Today', 'Yesterday', 'This Week'];
        expect(marketFeedSections(posts, LOCAL, here, now).map(s => s.title)).toEqual(byDay);
        expect(marketFeedSections(posts, GLOBAL, null, now).map(s => s.title)).toEqual(byDay);
        expect(marketFeedSections(posts, null, here, now).map(s => s.title)).toEqual(byDay);
    });

    it('the Market search asks for distance order only where the node sorts by it and the phone knows where it is', () => {
        expect(sortsByDistance(GLOBAL)).toBe(true);
        expect(marketSearchDistanceParams(GLOBAL, here)).toBe('&lat=-28.5500&lng=153.5000&sort=distance');
        expect(marketSearchDistanceParams(GLOBAL, null)).toBe('');
        expect(marketSearchDistanceParams(LOCAL, here)).toBe('');
        expect(marketSearchDistanceParams(null as unknown as NodeProfile, here)).toBe('');
    });
});

describe('start a community', () => {
    it('copies the details as plain lines, leaving out what is empty', () => {
        expect(communityDetailsText({ name: ' Valley  Commons ', place: 'Mullumbimby', contact: '', organiser: 'Robin' }))
            .toBe('Community name: Valley Commons\nPlace: Mullumbimby\nOrganiser: Robin');
        expect(canCopyDetails({ name: 'V', place: '', contact: '' })).toBe(false);
        expect(canCopyDetails({ name: 'Va', place: '', contact: '' })).toBe(true);
    });
});

describe('the screens draw Beans only behind that rule (source check)', () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf-8');

    it('the Market: every Beans figure, the "Beans only" chip and the first-offer quest are gated', () => {
        const src = read('../../app/(tabs)/index.tsx');
        const lines = src.split('\n');
        const currency = lines.flatMap((l, i) => (l.includes('<CurrencyDisplay') ? [i] : []));
        expect(currency.length).toBe(3);
        for (const i of currency) {
            // The condition that draws it sits on one of the few lines above the tag.
            expect(lines.slice(Math.max(0, i - 3), i).join('\n')).toContain('showsBeans');
        }
        expect(src).toContain("{rowExtras.includes('beans') && (");
        expect(src).not.toContain("secondRow.extras.includes('beans')");
        expect(src).toContain('{showFirstOfferQuest && showsBeans && !categoryPanel.open && (');
        expect(src).toContain('{isGlobal && !categoryPanel.open && <FindCommunityCard point={myLocation} />}');
    });

    it('a post’s page: the price card and the edit form’s price field are gated, and there is no escrow accept', () => {
        const src = read('../../app/post/[id].tsx');
        const lines = src.split('\n');
        const i = lines.findIndex(l => l.includes('<CurrencyDisplay amount={post.credits}'));
        expect(i).toBeGreaterThan(0);
        // The card's condition, then its View, label and row, then the figure.
        expect(lines.slice(i - 5, i).join('\n')).toContain('{!isPulsePost && showsBeans && (');
        expect(src).toContain('{!showsBeans ? (');
        expect(src).toContain("credits: showsBeans ? Number(editCredits) || 0 : 0,");
        expect(src).toContain('!isOwnPost && post.status === \'active\' && !isAcceptedByMe && escrowOn && (');
    });
});

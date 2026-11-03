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
    nearbyCircle, newestWithinLine, distancesFrom, marketStream,
    NO_BEANS_TERMS, NO_BEANS_EDIT_NOTE,
    postFormCredits, postFormPriceType, postFormPriceMissing, postFormPriceInvalid, postFormSubmitLabel, type PostFormState,
} from '../market-global';
import { readNodeProfile, nodeProfileIsFresh, NODE_PROFILE_FRESH_MS, type NodeProfile } from '../node-profile';
import { START_COMMUNITY_COPY, RUN_A_NODE_URL, communityDetailsText, canCopyDetails, runANodeUrl, runANodeLabel } from '../start-community';
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

describe('the map’s Offer/Need form where there are no Beans (map.tsx)', () => {
    // Today's rules, as map.tsx wrote them inline before a node could have Beans off. Every local community, and a
    // node that says nothing about Beans, must get exactly these.
    const today = {
        credits: (f: string) => Number(f) || 0,
        missing: (f: string) => f === '',
        invalid: (f: string) => f.trim() === '' || isNaN(Number(f)),
        label: (s: PostFormState) => s.posting ? 'Posting...'
            : s.needBlocked ? '🟢 List an Offer first to post Needs'
            : (!s.category) ? '📂 Select a category'
            : (!s.hasLocation) ? '📍 Set a location'
            : (s.photoCount < 1) ? '📷 Add a photo'
            : (s.credits === '') ? '💰 Set a price'
            : (!s.title.trim() || !s.description.trim()) ? '✏️ Fill required fields'
            : `Post ${s.postType === 'offer' ? 'Offer' : 'Need'}`,
    };
    const fields = ['', '0', '12', '12.5', ' 7 ', ' ', 'abc', '-3', '1e3'];
    const priceTypes = ['fixed', 'hourly', 'daily', 'weekly', 'monthly'];
    const ready: PostFormState = {
        posting: false, needBlocked: false, postType: 'offer', category: 'food', hasLocation: true, photoCount: 1,
        credits: '', title: 'Sourdough loaf', description: 'Baked Saturday',
    };
    // Every state the button can be in.
    const states: PostFormState[] = [];
    for (const posting of [false, true]) for (const needBlocked of [false, true]) for (const postType of ['offer', 'need'] as const)
        for (const category of ['', 'food']) for (const hasLocation of [false, true]) for (const photoCount of [0, 1, 5])
            for (const credits of ['', '0', '12']) for (const title of ['', ' ', 'Bread']) for (const description of ['', 'Fresh'])
                states.push({ posting, needBlocked, postType, category, hasLocation, photoCount, credits, title, description });

    it('Beans off: the post goes up at 0 Beans and a total price, whatever the field held', () => {
        const pickedOffer = String(40);        // onSelectOfferItem: setPostCredits(String(effectivePrice))
        const draft = { postCredits: '25' };   // a draft saved with a price, restored by setPostCredits(d.postCredits || '')
        for (const f of ['', '12', pickedOffer, draft.postCredits || '', ...fields]) {
            expect(postFormCredits(f, GLOBAL.features)).toBe(0);
        }
        for (const t of priceTypes) expect(postFormPriceType(t, GLOBAL.features)).toBe('fixed');
    });

    it('Beans off: the price is never missing or wrong, and the button never asks for one', () => {
        for (const f of ['', '12', ...fields]) {
            expect(postFormPriceMissing(f, GLOBAL.features)).toBe(false);
            expect(postFormPriceInvalid(f, GLOBAL.features)).toBe(false);
        }
        expect(postFormSubmitLabel(ready, GLOBAL.features)).toBe('Post Offer');
        expect(postFormSubmitLabel({ ...ready, postType: 'need' }, GLOBAL.features)).toBe('Post Need');
        for (const s of states) {
            const label = postFormSubmitLabel(s, GLOBAL.features);
            expect(label).not.toMatch(/price|bean/i);
            // The same button as today with the price step skipped.
            expect(label).toBe(today.label({ ...s, credits: '12' }));
        }
    });

    it('Beans on, or a node that says nothing: exactly today’s form', () => {
        for (const features of [LOCAL.features, OLD.features, null, undefined]) {
            expect(postFormPriceMissing('', features)).toBe(true);
            expect(postFormPriceInvalid('', features)).toBe(true);
            expect(postFormCredits('12', features)).toBe(12);
            expect(postFormSubmitLabel(ready, features)).toBe('💰 Set a price');
            for (const f of fields) {
                expect(postFormCredits(f, features)).toBe(today.credits(f));
                expect(postFormPriceMissing(f, features)).toBe(today.missing(f));
                expect(postFormPriceInvalid(f, features)).toBe(today.invalid(f));
            }
            for (const t of priceTypes) expect(postFormPriceType(t, features)).toBe(t);
            for (const s of states) expect(postFormSubmitLabel(s, features)).toBe(today.label(s));
        }
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
        { id: 'event', type: 'event', lat: -28.55, lng: 153.5, created_at: '2026-09-26T08:00:00Z', event_start_at: '2026-10-01T08:00:00Z' },
    ];

    it('orders by distance from the member, places unknown (or 0,0) last in their own order', () => {
        expect(nearestFirst(posts.filter(p => p.type !== 'event'), here).map(p => p.id)).toEqual(['byron', 'brisbane', 'melbourne', 'noplace', 'zero']);
    });

    // The headings Upcoming events, Polls and Nearest first are gone (Market order, DESIGN-market-order-fable.md): every
    // community is newest listed first under the day headings, and the worldwide one is that order inside a circle.
    const BY_AREA = readNodeProfile({ profile: 'global', features: { beans: false, distanceSearch: true, nearbyListings: { radiusKm: 250, max: 500 } } })!;
    const now = Date.parse('2026-09-26T12:00:00Z');
    const idsOf = (sections: Array<{ posts: Array<{ id: string }> }>) => sections.flatMap(s => s.posts.map(p => p.id));

    it('the worldwide feed is the same newest-listed order under the day headings, with no nearest-first heading', () => {
        const sections = marketFeedSections(posts, GLOBAL, here, now);
        // Newest listed first (ties by id, newest first), under the day headings and no others.
        expect(idsOf(sections)).toEqual(['zero', 'noplace', 'melbourne', 'event', 'brisbane', 'byron']);
        for (const gone of ['Polls', 'Upcoming events', 'Nearest first']) expect(sections.map(s => s.title)).not.toContain(gone);
        expect(sections.every(s => ['Today', 'Yesterday', 'This Week', 'Older Listings'].includes(s.title))).toBe(true);
    });

    it('polls and events are in the days they were listed, not under headings of their own', () => {
        const withPolls = [
            ...posts,
            { id: 'poll-new', type: 'poll', lat: null, lng: null, created_at: '2026-09-26T09:00:00Z' },
            { id: 'poll-old', type: 'poll', lat: null, lng: null, created_at: '2026-09-20T09:00:00Z' },
        ];
        const sections = marketFeedSections(withPolls, GLOBAL, here, now);
        for (const gone of ['Polls', 'Upcoming events', 'Nearest first']) expect(sections.map(s => s.title)).not.toContain(gone);
        const all = idsOf(sections);
        expect(all).toHaveLength(withPolls.length);
        expect(all.indexOf('poll-new')).toBeLessThan(all.indexOf('poll-old'));
    });

    it("on a node that gives phones the listings near an area, the order is cut to the radius of the member's area", () => {
        const ids = idsOf(marketFeedSections(posts, BY_AREA, here, now));
        // Melbourne is about 1,200 km away. No place (and 0,0), an event here, Brisbane (about 100 km) and Byron stay.
        expect(ids).not.toContain('melbourne');
        expect([...ids].sort()).toEqual(['brisbane', 'byron', 'event', 'noplace', 'zero']);
        // No area known: no cut. A node without the feature: no cut.
        expect(idsOf(marketFeedSections(posts, BY_AREA, null, now))).toContain('melbourne');
        expect(idsOf(marketFeedSections(posts, GLOBAL, here, now))).toContain('melbourne');
    });

    it("the member's own listing is never cut, however far", () => {
        const mine = { id: 'mine', type: 'offer', author_pubkey: 'me', lat: -37.81, lng: 144.96, created_at: '2026-09-26T08:00:00Z' };
        const ids = idsOf(marketFeedSections([mine, ...posts], BY_AREA, here, now, 'me'));
        expect(ids).toContain('mine');
        expect(ids).not.toContain('melbourne');
    });

    it("a post tied to the member (a deal, a chat, an answer) is never cut, however far, and keeps its newest-first place", () => {
        const kept = new Set(['melbourne']);
        const ids = idsOf(marketFeedSections(posts, BY_AREA, here, now, 'me', kept));
        // Melbourne (about 1,200 km) stays because it is tied; without the tie it goes. The order is the same newest-first order.
        expect(ids).toEqual(['zero', 'noplace', 'melbourne', 'event', 'brisbane', 'byron']);
        expect(idsOf(marketFeedSections(posts, BY_AREA, here, now, 'me', new Set()))).not.toContain('melbourne');
        expect(idsOf(marketFeedSections(posts, BY_AREA, here, now, 'me', null))).not.toContain('melbourne');
        // Only the tied one is spared: a far post that is not tied is still cut.
        const ids2 = idsOf(marketFeedSections([...posts, { id: 'perth', type: 'offer', lat: -31.95, lng: 115.86, created_at: '2026-09-26T07:00:00Z' }], BY_AREA, here, now, 'me', kept));
        expect(ids2).toContain('melbourne');
        expect(ids2).not.toContain('perth');
    });

    it('a local community, or no area yet, keeps every post', () => {
        for (const profile of [LOCAL, GLOBAL, null]) {
            expect(idsOf(marketFeedSections(posts, profile, here, now))).toHaveLength(posts.length);
        }
    });

    it('the circle is there only where the node has the feature and the member an area', () => {
        expect(nearbyCircle(BY_AREA, here)).toEqual({ area: here, radiusKm: 250 });
        expect(nearbyCircle(BY_AREA, null)).toBeNull();
        expect(nearbyCircle(GLOBAL, here)).toBeNull();
        expect(nearbyCircle(LOCAL, here)).toBeNull();
        expect(nearbyCircle(null, here)).toBeNull();
    });

    it('says the line in English with the radius, and measures each placed post from the area', () => {
        expect(newestWithinLine({ area: here, radiusKm: 250 })).toBe('Newest within 250 km of your area.');
        const d = distancesFrom(posts, here);
        expect(d.get('event')).toBeCloseTo(0, 5);
        expect(d.get('byron')).toBeGreaterThan(5);
        expect(d.get('byron')).toBeLessThan(20);
        expect(d.has('noplace')).toBe(false);
        expect(d.has('zero')).toBe(false);
    });

    it('under Events it is soonest first, under a search the order given stands, and the Daily Pulse leads either way', () => {
        const ev = (id: string, start: string) => ({ id, type: 'event', created_at: '2026-09-01T00:00:00Z', event_start_at: start });
        const pulse = { id: 'pulse', type: 'offer', author_callsign: 'Daily Pulse', created_at: '2026-09-01T00:00:00Z' };
        const listed = [ev('later', '2026-10-05T10:00:00Z'), ev('soon', '2026-09-28T10:00:00Z'), pulse];
        expect(marketStream(listed, now, { eventsOnly: true }).map(p => p.id)).toEqual(['pulse', 'soon', 'later']);
        expect(marketStream(listed, now, { narrowedBySearch: true }).map(p => p.id)).toEqual(['pulse', 'later', 'soon']);
    });

    it('the Market search asks for distance order only where the node sorts by it and the phone knows where it is', () => {
        expect(sortsByDistance(GLOBAL)).toBe(true);
        expect(marketSearchDistanceParams(GLOBAL, here)).toBe('&lat=-28.55&lng=153.50&sort=distance');
        expect(marketSearchDistanceParams(GLOBAL, null)).toBe('');
        expect(marketSearchDistanceParams(LOCAL, here)).toBe('');
        expect(marketSearchDistanceParams(null as unknown as NodeProfile, here)).toBe('');
    });

    // scratch/fable-redo/verdict-privacy.md §6 (N5): the read sends no radius, the phone orders the list itself
    // (nearestFirst) and shows its own distances, so the node needs only to about a kilometre of the last GPS fix.
    it('the phone\'s position goes to the node to two decimals (about a kilometre), never its GPS precision', () => {
        expect(marketSearchDistanceParams(GLOBAL, { lat: -28.612345678, lng: 153.598765432 })).toBe('&lat=-28.61&lng=153.60&sort=distance');
        expect(marketSearchDistanceParams(GLOBAL, { lat: 51.507351, lng: -0.127758 })).toBe('&lat=51.51&lng=-0.13&sort=distance');
    });
});

describe('the screens’ copy of the profile', () => {
    it('is used without asking the node while under an hour old; missing or older, the node is asked', () => {
        const now = Date.parse('2026-09-26T12:00:00Z');
        const at = (ms: number) => ({ ...GLOBAL, checkedAt: new Date(now - ms).toISOString() });
        expect(nodeProfileIsFresh(at(0), now)).toBe(true);
        expect(nodeProfileIsFresh(at(NODE_PROFILE_FRESH_MS - 1), now)).toBe(true);
        expect(nodeProfileIsFresh(at(NODE_PROFILE_FRESH_MS), now)).toBe(false);
        expect(nodeProfileIsFresh(at(-60_000), now)).toBe(false);
        expect(nodeProfileIsFresh({ ...GLOBAL, checkedAt: 'never' }, now)).toBe(false);
        expect(nodeProfileIsFresh(null, now)).toBe(false);
    });
});

describe('start a community', () => {
    it('copies the details as plain lines, leaving out what is empty', () => {
        expect(communityDetailsText({ name: ' Valley  Commons ', place: 'Mullumbimby', contact: '', organiser: 'Robin' }))
            .toBe('Community name: Valley Commons\nPlace: Mullumbimby\nOrganiser: Robin');
        expect(canCopyDetails({ name: 'V', place: '', contact: '' })).toBe(false);
        expect(canCopyDetails({ name: 'Va', place: '', contact: '' })).toBe(true);
    });

    // No domain lock-in: "How to run a node" opens the community's own page when its node names one
    // (GET /api/community/info's `startCommunityUrl`, apps/server config/start-community.ts), beanpool.org's only without one.
    it('opens the page the community\'s node names, and says where; beanpool.org\'s only when it names none', () => {
        const own = readNodeProfile({ ...GLOBAL_INFO_FOR_START, startCommunityUrl: 'https://start.example.org/run' })!;
        expect(runANodeUrl(own)).toBe('https://start.example.org/run');
        expect(runANodeLabel(runANodeUrl(own))).toBe('How to run a node, on start.example.org');
        const none = readNodeProfile(GLOBAL_INFO_FOR_START)!;
        expect(runANodeUrl(none)).toBe(RUN_A_NODE_URL);
        expect(RUN_A_NODE_URL).toBe('https://beanpool.org/start');
        expect(runANodeLabel(runANodeUrl(none))).toBe(START_COMMUNITY_COPY.website);
        expect(runANodeUrl(null)).toBe(RUN_A_NODE_URL);
        // Only an address an app may open for a stranger, as the server's own rule says: https, a host, no user name.
        for (const bad of ['http://start.example.org/run', 'javascript:alert(1)', 'https://me:pw@start.example.org/', 'https://a b.org/', '', 42, null]) {
            expect(runANodeUrl(readNodeProfile({ ...GLOBAL_INFO_FOR_START, startCommunityUrl: bad })), String(bad)).toBe(RUN_A_NODE_URL);
        }
        expect(runANodeUrl(readNodeProfile({ ...GLOBAL_INFO_FOR_START, startCommunityUrl: 'https://x.org/' + 'a'.repeat(300) }))).toBe(RUN_A_NODE_URL);
    });

    it('the screen opens that page, from the community it is on (source check)', () => {
        const screen = fs.readFileSync(path.resolve(__dirname, '../../app/start-community.tsx'), 'utf-8');
        expect(screen).toMatch(/const runANode = runANodeUrl\(useNodeProfile\(\)\);/);
        expect(screen).toMatch(/WebBrowser\.openBrowserAsync\(runANode\)/);
        expect(screen).toMatch(/\{runANodeLabel\(runANode\)\}/);
        expect(screen).not.toMatch(/RUN_A_NODE_URL/);
    });
});

const GLOBAL_INFO_FOR_START = { profile: 'global', features: { beans: false, showcase: true } };

describe('the screens draw Beans only behind that rule (source check)', () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf-8');

    it('the Market: every Beans figure, the "Beans only" chip and the first-offer quest are gated', () => {
        const src = read('../../app/(tabs)/market.tsx');
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
    });

    it('the Market no longer draws Find your community: it is a Home card since H4 (components/home/FindCommunityBody.tsx)', () => {
        const src = read('../../app/(tabs)/market.tsx');
        expect(src).not.toMatch(/FindCommunity/);
        expect(src).not.toMatch(/fabStepsAside|onCardActionsAt/);
        expect(fs.existsSync(path.resolve(__dirname, '../../components/FindCommunityCard.tsx'))).toBe(false);
        // Home draws it, from its own answer (no request of its own), in its `find` card only.
        const home = read('../../app/(tabs)/index.tsx');
        expect(home.match(/<FindCommunityBody /g)).toHaveLength(1);
        expect(home).toMatch(/case 'find': \{[\s\S]*?readGlobalHome\(c\.find\)[\s\S]*?<FindCommunityBody /);
        expect(read('../../components/home/FindCommunityBody.tsx')).not.toMatch(/fetchGlobalHome/);
    });

    it('a post’s page: the price card and the edit form’s price field are gated, and there is no escrow accept', () => {
        const src = read('../../app/post/[id].tsx');
        const lines = src.split('\n');
        const i = lines.findIndex(l => l.includes('<CurrencyDisplay amount={post.credits}'));
        expect(i).toBeGreaterThan(0);
        // The card's condition, then its View, label and row, then the figure.
        expect(lines.slice(i - 5, i).join('\n')).toContain('{!isPulsePost && showsBeans && (');
        expect(src).toContain('{!showsBeans ? (');
        // Beans off: no price is read, and the post is saved at 0 (the price read in the language's way since #2202).
        expect(src).toContain('const price = showsBeans ? parseAmount(editCredits, undefined, ANY_DECIMALS) : null;');
        expect(src).toContain('credits: price?.ok ? price.value : 0,');
        expect(src).toContain('!isOwnPost && post.status === \'active\' && !isAcceptedByMe && escrowOn && (');
    });

    it('the map: the Offer/Need form’s price section and the preview’s amount are gated, and the post goes up at 0', () => {
        // The preview's amount is the map's (map.tsx); the form is its own screen since MAP-FORM (app/new-listing.tsx).
        const map = read('../../app/(tabs)/map.tsx').split('\n');
        const currency = map.flatMap((l, i) => (l.includes('<CurrencyDisplay') ? [i] : []));
        expect(currency.length).toBe(1);
        for (const i of currency) expect(map.slice(Math.max(0, i - 3), i).join('\n')).toMatch(/\{showsBeans && (!previewCopy && )?\(/);
        const src = read('../../app/new-listing.tsx');
        const lines = src.split('\n');
        expect(lines.some(l => l.includes('<CurrencyDisplay'))).toBe(false);
        // The price section, from its gate to its end: the field, the unit button, FREE, the pricing guide, the fee.
        const open = lines.findIndex(l => l.trim() === '{showsBeans && (<>');
        const close = lines.findIndex((l, i) => i > open && l.trim() === '</>)}');
        expect(open).toBeGreaterThan(0);
        expect(close).toBeGreaterThan(open);
        const section = lines.slice(open, close).join('\n');
        // Its words go through t() (words S3m): the same parts in their t() form, each once; the fee in each of its sentences.
        for (const part of ["accessibilityLabel={t('Price')}", "{ fixed: t('Total', undefined, 'price unit'), hourly: t('/ Hr', undefined, 'price per hour')", ">{t('FREE')}</Text>", 'onPress={showPricingGuide}', '1.5% fee: You will receive', '1.5% fee: Fulfiller receives', '1.5% transaction fee']) {
            expect(section).toContain(part);
            expect(src.split(part).length).toBe(2);
        }
        // Where the section was, the note the edit form shows (post/[id].tsx).
        expect(lines.slice(open - 4, open).join('\n')).toContain('{!showsBeans && (');
        expect(lines.slice(open - 4, open).join('\n')).toContain('{t(LINES.noBeansEditNote)}');
        expect(src).toContain('const LINES = { noBeansEditNote: NO_BEANS_EDIT_NOTE };');
        // What the form submits and when it lets a member post: the helpers above, not the field.
        expect(src).toContain("if (postFormPriceInvalid(postCredits, nodeFeatures)) errors.add('credits');");
        expect(src).toContain('credits: postFormCredits(postCredits, nodeFeatures),');
        expect(src).toContain('price_type: postFormPriceType(postPriceType, nodeFeatures),');
        expect(src).toContain('const submitLabel = postFormSubmitLabel(');
        expect(src).toContain('postFormPriceMissing(postCredits, nodeFeatures)');
        expect(src).not.toContain("postCredits === ''");
        expect(src).not.toContain('Set a price');
        expect(src).not.toContain('Number(postCredits)');
    });
});

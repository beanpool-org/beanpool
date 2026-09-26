/**
 * The global community's directory, read by the phone (utils/community-directory.ts): which addresses a knock may
 * ever go to, what the "Find your community" card says in each state, and the requests the card and the Find a
 * community screen make (apps/server/src/routes/global-directory.ts, G5).
 *
 * Nothing here contacts a node: `fetch` is a stub that records each request and answers as the global node would.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
}));

import { getPublicKey } from '@noble/ed25519';
import { bytesToHex } from '../crypto';
import {
    communityOrigin, readCommunity, readGlobalHome, fetchCommunities, fetchGlobalHome, watchPlace, unwatchPlace,
    findCommunityCardCopy, communityFacts, communityLabel, DIRECTORY_MESSAGES, type GlobalHome, type Fetched,
} from '../community-directory';
import { GLOBAL_NODE_URL } from '../node-profile';
import type { BeanPoolIdentity } from '../identity';

interface Sent { url: string; method: string; headers: Record<string, string>; body?: string }
let sent: Sent[] = [];
let answer: (req: Sent) => { status: number; body?: unknown } = () => ({ status: 500 });

beforeEach(() => {
    sent = [];
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
        const req = { url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body };
        sent.push(req);
        const a = answer(req);
        return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
    });
});

async function member(): Promise<BeanPoolIdentity> {
    const seed = new Uint8Array(randomBytes(32));
    return { publicKey: bytesToHex(await getPublicKey(seed)), privateKey: bytesToHex(seed), callsign: 'Robin' } as BeanPoolIdentity;
}

const row = (over: Record<string, unknown> = {}) => ({
    key: 'node-1', name: 'Mullumbimby', url: 'https://mullum.beanpool.org', lat: -28.55, lng: 153.5, radiusKm: 20,
    memberCount: 40, contactEmail: null, contactPhone: null, updatedAt: null, distanceKm: 12.3, ...over,
});

describe('a community’s address', () => {
    it('is an https host name’s origin, and nothing else', () => {
        expect(communityOrigin('https://mullum.beanpool.org')).toBe('https://mullum.beanpool.org');
        expect(communityOrigin('https://Mullum.BeanPool.org/some/path?q=1#x')).toBe('https://mullum.beanpool.org');
        expect(communityOrigin('https://node.example.org:8443/')).toBe('https://node.example.org:8443');
        for (const bad of ['http://mullum.beanpool.org', 'https://10.0.0.5', 'https://localhost', 'javascript:alert(1)',
            '/api/x', 'https://user:pw@mullum.beanpool.org', 'https://user.name:1234@mullum.beanpool.org',
            'https://evil.example.org@mullum.beanpool.org', 'https://-bad-.org', 42, null, undefined]) {
            expect(communityOrigin(bad)).toBeNull();
        }
    });

    it('is never the global node: nobody knocks on the lobby', () => {
        expect(communityOrigin(GLOBAL_NODE_URL)).toBeNull();
        expect(communityOrigin('https://global.beanpool.org/api/join/knock')).toBeNull();
        expect(readCommunity(row({ url: GLOBAL_NODE_URL }))?.url).toBeNull();
    });

    it('a row with a bad field keeps the rest, and a row with no key is dropped', () => {
        expect(readCommunity(row({ url: 'http://x.org', lat: 200, memberCount: -3, name: '‮evil‬  name' }))).toMatchObject({
            key: 'node-1', url: null, lat: null, lng: null, memberCount: null, name: 'evil name',
        });
        expect(readCommunity(row({ key: '' }))).toBeNull();
        expect(readCommunity('nope')).toBeNull();
    });
});

describe('the requests', () => {
    it('communities near a point go to the global node, public, nearest first by the point', async () => {
        answer = () => ({ status: 200, body: { communities: [row()], total: 1 } });
        const r = await fetchCommunities({ point: { lat: -28.55123, lng: 153.49876 }, q: ' Mullum ', limit: 20 });
        expect(r).toEqual({ ok: true, value: { communities: [readCommunity(row())], total: 1 } });
        expect(sent[0].url).toBe(`${GLOBAL_NODE_URL}/api/global/communities?lat=-28.5512&lng=153.4988&q=Mullum&limit=20`);
        expect(sent[0].headers['X-Signature']).toBeUndefined();
    });

    it('a local community (404 feature_off) is "unavailable"; a 5xx is refused in its words; no answer is unreachable', async () => {
        answer = () => ({ status: 404, body: { error: 'Not on this node', code: 'feature_off' } });
        expect(await fetchCommunities()).toEqual({ ok: false, kind: 'unavailable', message: 'Not on this node' });
        answer = () => ({ status: 503, body: { error: 'Busy, try again soon' } });
        expect(await fetchCommunities()).toEqual({ ok: false, kind: 'refused', status: 503, message: 'Busy, try again soon' });
        (globalThis as any).fetch = vi.fn(async () => { throw new Error('offline'); });
        expect(await fetchCommunities()).toEqual({ ok: false, kind: 'unreachable', message: DIRECTORY_MESSAGES.unreachable });
    });

    it('the card’s one request is signed by the member over the path alone (the node verifies ctx.path)', async () => {
        const me = await member();
        answer = () => ({ status: 200, body: { point: 'request', communities: [row()], communityCount: 10, nearbyPosts: { radiusKm: 50, count: 3, more: false }, watches: [], knock: null } });
        const r = await fetchGlobalHome({ lat: 1, lng: 2 }, me);
        expect(r.ok).toBe(true);
        expect(sent[0].url).toBe(`${GLOBAL_NODE_URL}/api/global/home?lat=1.0000&lng=2.0000`);
        expect(sent[0].headers['X-Public-Key']).toBe(me.publicKey);
        expect(sent[0].headers['X-Signature']).toBeTruthy();
    });

    it('watching a place is a signed POST of the point; stopping is a signed DELETE of the watch', async () => {
        const me = await member();
        answer = () => ({ status: 200, body: { success: true, watch: { id: 'w1', lat: -28.6, lng: 153.5, radiusKm: 50, createdAt: 'x' }, created: true } });
        expect(await watchPlace(me, { lat: -28.55, lng: 153.5 })).toEqual({ ok: true, value: { id: 'w1', lat: -28.6, lng: 153.5, radiusKm: 50, createdAt: 'x' } });
        expect(sent[0]).toMatchObject({ url: `${GLOBAL_NODE_URL}/api/global/watches`, method: 'POST' });
        expect(JSON.parse(sent[0].body!)).toEqual({ lat: -28.55, lng: 153.5 });
        expect(sent[0].headers['X-Public-Key']).toBe(me.publicKey);
        answer = () => ({ status: 409, body: { error: 'You can watch up to 3 places. Remove one to watch another.', code: 'watch_limit' } });
        expect(await watchPlace(me, { lat: 0.1, lng: 0.1 })).toEqual({ ok: false, kind: 'refused', status: 409, message: 'You can watch up to 3 places. Remove one to watch another.' });
        answer = () => ({ status: 200, body: { success: true } });
        expect(await unwatchPlace(me, 'w 1')).toEqual({ ok: true, value: true });
        expect(sent[2]).toMatchObject({ url: `${GLOBAL_NODE_URL}/api/global/watches/w%201`, method: 'DELETE' });
    });
});

describe('the "Find your community" card, in each state', () => {
    const home = (over: Partial<GlobalHome>): Fetched<GlobalHome> => ({
        ok: true, value: { point: 'request', communities: [], communityCount: 0, nearbyPosts: null, watches: null, ...over },
    });

    it('loading', () => {
        expect(findCommunityCardCopy(null, true)).toEqual({ title: 'Find your community', body: 'Looking for communities near you…' });
    });

    it('an error says what went wrong, in the node’s words where it gave them', () => {
        expect(findCommunityCardCopy({ ok: false, kind: 'unreachable', message: DIRECTORY_MESSAGES.unreachable }, true).body)
            .toBe(DIRECTORY_MESSAGES.unreachable);
    });

    it('communities near you: the nearest by name and distance', () => {
        const c = [readCommunity(row())!, readCommunity(row({ key: 'n2', name: 'Byron', distanceKm: 30 }))!];
        expect(findCommunityCardCopy(home({ communities: c }), true).body)
            .toBe('Mullumbimby is 12 km away, and 1 more nearby. Ask to join, and trade with your neighbours there.');
    });

    it('no point yet: how many are listed, and a nudge to share a location', () => {
        expect(findCommunityCardCopy(home({ point: null, communityCount: 10 }), false).body)
            .toBe('10 communities are listed. Share your location to see the nearest.');
    });

    it('nothing near: start one, or be told', () => {
        expect(findCommunityCardCopy(home({ communityCount: 10 }), true).body)
            .toBe('No community is listed near you yet. Start one, or ask to be told when one starts here.');
    });

    it('says nothing of Beans in any state (there are none on the global node)', () => {
        const states = [
            findCommunityCardCopy(null, true),
            findCommunityCardCopy(home({ communities: [readCommunity(row())!] }), true),
            findCommunityCardCopy(home({ point: null, communityCount: 1 }), false),
            findCommunityCardCopy(home({}), true),
        ];
        for (const s of states) expect(`${s.title} ${s.body}`).not.toMatch(/bean|🫘/i);
    });

    it('facts and labels', () => {
        expect(communityFacts({ distanceKm: 0.4, memberCount: 1 })).toBe('Less than 1 km away · 1 member');
        expect(communityFacts({ distanceKm: 8.26, memberCount: 40 })).toBe('8.3 km away · 40 members');
        expect(communityFacts({ distanceKm: 1280.4, memberCount: null })).toBe('1,280 km away');
        expect(communityFacts({ distanceKm: null, memberCount: null })).toBe('');
        expect(communityLabel({ name: null })).toBe('A community');
    });

    it('reads the card’s answer, dropping what isn’t what it claims', () => {
        expect(readGlobalHome({ point: 'elsewhere', communities: [row(), { nope: 1 }], communityCount: 'x', nearbyPosts: { count: 3 }, watches: 'no' }))
            .toEqual({ point: null, communities: [readCommunity(row())], communityCount: 0, nearbyPosts: null, watches: null });
        expect(readGlobalHome({})).toBeNull();
    });
});

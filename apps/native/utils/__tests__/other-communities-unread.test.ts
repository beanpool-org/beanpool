/**
 * The rounds that ask the phone's other communities how many messages wait there, the phone's own notice where no push can
 * have said so, and the badge's sum (scratch/fable-design/DESIGN-cross-community-chat-fable.md R4, R5, R7, slice S1.3;
 * utils/other-communities-unread.ts). This is what fixes Damo's phone: no Play services, so no push, and until now nothing
 * asked the communities it wasn't set to.
 *
 * Real modules throughout: the storage code, the push record's readers, the counts, the tap's check. Each community is a
 * fake per address that answers `GET /api/me/unread` as the server does (apps/server routes/messaging.ts, pinned over HTTP by
 * test-unread-count.ts) and checks the signature with core and noble (server-signature-check.ts), never the app's own code.
 * Nothing contacts a node, and nothing is posted on a phone: `post` records.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import nodeCrypto from 'node:crypto';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
const mem = vi.hoisted(() => ({ async: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.async.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
        getAllKeys: vi.fn(async () => [...mem.async.keys()]),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async () => null),
    setItemAsync: vi.fn(async () => {}),
    deleteItemAsync: vi.fn(async () => {}),
}));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { clearActiveCount, countNotice, dropCounts, noticeCountsSum, readNoticeCounts } from '../notice-counts';
import { markAlertsOff } from '../push-alerts-off';
import {
    askOtherCommunities, keepsOtherCommunities, noticesAfterSync, NOT_THEIRS_WAIT_MS, roundWhileOpen, showUnreadSum, UNREAD_ROUND_GAP_MS, UNREAD_ROUND_SIZE,
    type PhoneNotices, type RoundDeps,
} from '../other-communities-unread';
import { followTap, type NoticeRoute } from '../push-notice-check';
import { PUSH_ALERTS_OFF_STORE_KEY, PUSH_REGISTERED_AT_STORE_KEY, PUSH_REGISTRATIONS_DUE_STORE_KEY, SAVED_NODES_STORE_KEY, UNREAD_ROUNDS_STORE_KEY } from '../storage-keys';
import type { LocalNotice } from '../sync-notices';
import { boundSignatureValid } from './server-signature-check';

const ANCHOR = 'beanpool_anchor_url';
const GUESTS = 'beanpool_guest_nodes';
const HOME = 'https://home.example.org';
const CASTLEMAINE = 'https://castlemaine.example.org';
const BYRON = 'https://byron.example.net';

type Account = { publicKey: string; privateKey: string };
function account(): Account {
    const seed = nodeCrypto.randomBytes(32);
    return { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: seed.toString('hex') };
}

/** How a community answers: its counts, a refusal, no connection, or nothing until the phone gives up. */
type Answer = { unread: number; requests?: number; alerts?: unknown } | { status: number; body?: unknown } | 'down' | 'never';
interface Asked { community: string; path: string; signed: boolean; method: string; headers: Record<string, string>; body: unknown }

let kim: Account;
let answers: Map<string, Answer>;
let asked: Asked[];
let posted: LocalNotice[];
let badges: number[];
let clock: number;

/** The phone keeps these communities, set to the first; a name given is the one it saved. */
function keep(...communities: Array<string | [string, string]>): void {
    const rows = communities.map((c) => (Array.isArray(c) ? { url: c[0], alias: c[1] } : { url: c }));
    mem.async.set(ANCHOR, rows[0].url);
    mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify(rows));
}

/** The phone holds a token, and it landed at these communities (push-registrations.ts: on the record, nothing due). */
function pushLanded(...communities: string[]): void {
    mem.async.set(PUSH_REGISTERED_AT_STORE_KEY, JSON.stringify(communities));
}

const deps = (over: Partial<RoundDeps> = {}): RoundDeps => ({
    storage: AsyncStorage,
    account: kim,
    post: async (n) => { posted.push(n); },
    setBadge: async (n) => { badges.push(n); },
    now: clock,
    ...over,
});

/** A round, as far from the last as rounds are let be. */
async function round(over: Partial<RoundDeps> = {}): Promise<number> {
    clock += UNREAD_ROUND_GAP_MS;
    return askOtherCommunities(deps(over));
}

/** A round with the app closed (the background sync's). */
const closedRound = (over: Partial<RoundDeps> = {}) => round({ closed: true, ...over });

const askedOf = (community: string) => asked.filter((a) => a.community === community);
const unreadAsks = () => asked.filter((a) => a.path === '/api/me/unread');

beforeEach(() => {
    mem.async.clear();
    kim = account();
    answers = new Map();
    asked = [];
    posted = [];
    badges = [];
    clock = 1_800_000_000_000;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const signer = headers['X-Public-Key'];
        const method = init?.method ?? 'GET';
        const signed = !!signer && boundSignatureValid({ url: String(input), method, headers, body: String(init?.body ?? '') }, signer);
        asked.push({ community: url.origin, path: `${url.pathname}${url.search}`, signed, method, headers, body: init?.body });
        if (url.pathname !== '/api/me/unread') return new Response('{}', { status: 404 });
        const a = answers.get(url.origin) ?? 'down';
        if (a === 'down') throw new TypeError('Network request failed');
        if (a === 'never') {
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
            });
        }
        if ('status' in a) return new Response(JSON.stringify(a.body ?? {}), { status: a.status });
        if (!signed) return new Response(JSON.stringify({ error: 'A signed request is required' }), { status: 401 });
        // `alerts` is `unread` unless a test says otherwise; set to undefined, it isn't sent: a node from before it.
        const alerts = 'alerts' in a ? a.alerts : a.unread;
        return new Response(JSON.stringify({ unread: a.unread, alerts, requests: a.requests ?? 0, asOf: new Date(clock).toISOString() }), { status: 200 });
    }));
});

afterEach(async () => {
    // A test that stopped part-way lets its round reach its deadline: one left waiting would hold up every later round.
    if (vi.isFakeTimers()) await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('bounded work on an old phone', () => {
    const towns = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((t) => `https://${t}.example.org`);

    it('six per round, and every community gets its turn: eight others take two rounds, in order, then it comes round again', async () => {
        expect(UNREAD_ROUND_SIZE).toBe(6);
        keep(HOME, ...towns);
        for (const t of towns) answers.set(t, { unread: 0 });

        await round();
        expect(unreadAsks().map((a) => a.community)).toEqual(towns.slice(0, 6));
        asked = [];
        await round();
        expect(unreadAsks().map((a) => a.community)).toEqual([...towns.slice(6), ...towns.slice(0, 4)]);
        asked = [];
        await round();
        expect(unreadAsks().map((a) => a.community)).toEqual(towns.slice(4, 8).concat(towns.slice(0, 2)));
    });

    it('the turn survives the app being killed, and a community coming or going takes nobody\'s turn', async () => {
        keep(HOME, ...towns.slice(0, 7));
        await round();
        expect(unreadAsks().at(-1)?.community).toBe(towns[5]);
        asked = [];
        vi.resetModules();
        const again = await import('../other-communities-unread');
        clock += again.UNREAD_ROUND_GAP_MS;
        await again.askOtherCommunities(deps());
        expect(unreadAsks()[0].community).toBe(towns[6]);

        // The last one asked (e) is forgotten: the next goes on from where it stood in the order.
        expect(unreadAsks().at(-1)?.community).toBe(towns[4]);
        asked = [];
        keep(HOME, ...towns.slice(0, 4), towns[5]);
        await round();
        expect(unreadAsks().map((a) => a.community)).toEqual([towns[5], towns[0], towns[1], towns[2], towns[3]]);
    });

    it('all at once under one deadline, however many don\'t answer: not one deadline each', async () => {
        keep(HOME, ...towns.slice(0, 6));
        for (const t of towns.slice(0, 6)) answers.set(t, 'never');
        const started = Date.now();
        await round({ timeoutMs: 200 });
        expect(unreadAsks()).toHaveLength(6);
        expect(Date.now() - started).toBeLessThan(700);
    });

    it('the deadline shared with the sync\'s notices ends the round when it ends, well before the round\'s own', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, 'never');
        const shared = new AbortController();
        vi.useFakeTimers({ now: clock });
        const settled = vi.fn();
        void round({ signal: shared.signal }).then(settled);
        await vi.advanceTimersByTimeAsync(3000);
        expect(settled).not.toHaveBeenCalled();
        shared.abort();
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toHaveBeenCalledWith(0);
    });

    it('the whole background sync still ends at 8 seconds with every read hanging: the round adds nothing to the ceiling', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, 'never');
        // The sync's own reads hang as well.
        const hanging = vi.mocked(fetch).getMockImplementation()!;
        let syncReads = 0;
        vi.mocked(fetch).mockImplementation(async (input, init) => {
            if (!String(input).startsWith(HOME)) return hanging(input, init);
            syncReads++;
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
            });
        });
        const phone: PhoneNotices = { mayNotify: async () => true, post: async () => {}, setBadge: async () => {} };
        vi.useFakeTimers({ now: clock });
        const settled = vi.fn();
        void noticesAfterSync({ storage: AsyncStorage, account: kim, phone }).then(settled);
        await vi.advanceTimersByTimeAsync(7999);
        expect(askedOf(CASTLEMAINE)).toHaveLength(1);
        expect(syncReads).toBeGreaterThan(0);
        expect(settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toHaveBeenCalledWith(0);
    });

    it('a slow community doesn\'t hold back a quick one\'s notice', async () => {
        keep(HOME, CASTLEMAINE, BYRON);
        answers.set(CASTLEMAINE, { unread: 1 });
        answers.set(BYRON, 'never');
        vi.useFakeTimers({ now: clock });
        const going = round();
        await vi.advanceTimersByTimeAsync(1);
        expect(posted).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(8000);
        await going;
    });

    it('at most every 5 minutes, whatever brings the member back; a timer running a moment early still gets its turn', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { unread: 0 });
        await askOtherCommunities(deps());
        await askOtherCommunities(deps({ now: clock + 60_000 }));
        await askOtherCommunities(deps({ now: clock + UNREAD_ROUND_GAP_MS - 1 }));
        expect(unreadAsks()).toHaveLength(1);
        // The 5-minute tick, a few milliseconds short.
        await askOtherCommunities(deps({ now: clock + 5 * 60 * 1000 - 20 }));
        expect(unreadAsks()).toHaveLength(2);
    });

    it('a clock set back doesn\'t stop the rounds for as long as it went back', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { unread: 0 });
        await askOtherCommunities(deps());
        await askOtherCommunities(deps({ now: clock - 24 * 60 * 60 * 1000 }));
        expect(unreadAsks()).toHaveLength(2);
    });

    it('two asked at once are one round: one question to each community, one notice', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { unread: 2 });
        clock += UNREAD_ROUND_GAP_MS;
        await Promise.all([askOtherCommunities(deps()), askOtherCommunities(deps())]);
        expect(unreadAsks()).toHaveLength(1);
        expect(posted).toHaveLength(1);
    });

    it('a phone with one community asks nothing and leaves its badge alone: that is its push\'s', async () => {
        keep(HOME);
        expect(await round()).toBe(0);
        expect(asked).toEqual([]);
        expect(badges).toEqual([]);
        expect(mem.async.has(UNREAD_ROUNDS_STORE_KEY)).toBe(false);
        expect(await keepsOtherCommunities(AsyncStorage)).toBe(false);
    });
});

describe('a rise posts one notice, once', () => {
    it('a rise posts once; the same count again posts nothing; a fall posts nothing; a rise after it posts again', async () => {
        keep(HOME, [CASTLEMAINE, 'Castlemaine']);
        const seen: number[] = [];
        for (const unread of [2, 2, 1, 1, 3]) {
            answers.set(CASTLEMAINE, { unread });
            await round();
            seen.push(posted.length);
        }
        expect(seen).toEqual([1, 1, 1, 1, 2]);
    });

    it('what waited before this phone first asked is told too, one notice: this is the DM Damo never heard of', async () => {
        keep(HOME, [CASTLEMAINE, 'Castlemaine'], [BYRON, 'Byron']);
        answers.set(CASTLEMAINE, { unread: 9 });
        answers.set(BYRON, { unread: 0 });
        expect(await round()).toBe(1);
        expect(posted.map((n) => n.body)).toEqual(['You have new messages in Castlemaine']);
    });

    it('survives the app being killed: a count already told is not told again', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { unread: 4 });
        await round();
        vi.resetModules();
        const again = await import('../other-communities-unread');
        clock += again.UNREAD_ROUND_GAP_MS;
        expect(await again.askOtherCommunities(deps())).toBe(0);
        expect(posted).toHaveLength(1);
    });

    it('a notice that couldn\'t be posted is not posted again later (never twice, even at that cost), and the round goes on', async () => {
        keep(HOME, CASTLEMAINE, BYRON);
        answers.set(CASTLEMAINE, { unread: 1 });
        answers.set(BYRON, { unread: 1 });
        await round({ post: async () => { throw new Error('the phone said no'); } });
        expect(badges).toEqual([2]);
        await round();
        expect(posted).toEqual([]);
    });

    it('a count that can\'t be written down tells nobody: it would be told again every round', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { unread: 1 });
        const real = vi.mocked(AsyncStorage.setItem).getMockImplementation()!;
        vi.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => {
            if (key === 'beanpool_notice_counts') throw new Error('disk full');
            await real(key, value);
        });
        expect(await round()).toBe(0);
        vi.mocked(AsyncStorage.setItem).mockImplementation(real);
        expect(posted).toEqual([]);
    });

    it('back from a community, what has come since it was left is new: its count starts again at the switch, so a rise isn\'t mistaken for a fall', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { unread: 3 });
        await round();
        // In Castlemaine, the member reads all three, and comes back.
        mem.async.set(ANCHOR, CASTLEMAINE);
        await clearActiveCount(AsyncStorage);
        mem.async.set(ANCHOR, HOME);
        // One new message: fewer than the 3 last seen, and news all the same.
        answers.set(CASTLEMAINE, { unread: 1 });
        await round();
        expect(posted).toHaveLength(2);
    });
});

describe('silent where a push is: the notice rises on what the node would have pushed about', () => {
    it('a rise in `unread` alone posts nothing: a muted chat, Direct Messages off, an event\'s chat. The number and the badge still move', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { unread: 1, alerts: 0 });
        await round();
        answers.set(CASTLEMAINE, { unread: 4, alerts: 0 });
        await round();
        expect(posted).toEqual([]);
        expect(await readNoticeCounts(AsyncStorage)).toEqual({ [CASTLEMAINE]: 4 });
        expect(badges).toEqual([1, 4]);
    });

    it('a rise in what would have pushed posts once, whatever `unread` does; a fall posts nothing; a rise after it posts again', async () => {
        keep(HOME, CASTLEMAINE);
        const seen: number[] = [];
        for (const [unread, alerts] of [[5, 2], [5, 2], [7, 2], [3, 1], [3, 2]]) {
            answers.set(CASTLEMAINE, { unread, alerts });
            await round();
            seen.push(posted.length);
        }
        expect(seen).toEqual([1, 1, 1, 1, 2]);
    });

    it('a node too old to send it is taken at its `unread`, that community alone', async () => {
        keep(HOME, CASTLEMAINE, BYRON);
        answers.set(CASTLEMAINE, { unread: 2, alerts: undefined });
        answers.set(BYRON, { unread: 2, alerts: 0 });
        await round();
        expect(posted.map((n) => n.data.url)).toEqual([CASTLEMAINE]);
    });

    it.each([['words', 'many'], ['a negative', -1], ['a fraction', 1.5], ['null', null]])('%s for it is as good as not sent', async (_, alerts) => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { unread: 2, alerts });
        await round();
        expect(posted).toHaveLength(1);
        expect(await noticeCountsSum(AsyncStorage)).toBe(2);
    });

    it('a server updated between rounds tells nothing new because of it, and what it says from then on counts', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { unread: 3, alerts: undefined });
        await round();
        expect(posted).toHaveLength(1);
        answers.set(CASTLEMAINE, { unread: 3, alerts: 1 });
        await round();
        expect(posted).toHaveLength(1);
        answers.set(CASTLEMAINE, { unread: 4, alerts: 2 });
        await round();
        expect(posted).toHaveLength(2);
    });
});

describe('no double notice: the phone\'s own notice only where no push can have said it', () => {
    it('no token: the notice', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { unread: 1 });
        await round();
        expect(posted).toHaveLength(1);
    });

    it('a token landed at that community: no notice, and the number still moves', async () => {
        keep(HOME, CASTLEMAINE);
        pushLanded(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { unread: 1 });
        await round();
        expect(posted).toEqual([]);
        expect(await readNoticeCounts(AsyncStorage)).toEqual({ [CASTLEMAINE]: 1 });
        expect(badges).toEqual([1]);
    });

    it('a token that landed elsewhere, or is still due here, is no push from here: the notice', async () => {
        keep(HOME, CASTLEMAINE, BYRON);
        pushLanded(HOME, BYRON);
        mem.async.set(PUSH_REGISTRATIONS_DUE_STORE_KEY, JSON.stringify([{ publicKey: kim.publicKey.toLowerCase(), community: BYRON, refusals: 1, retryAt: 0 }]));
        answers.set(CASTLEMAINE, { unread: 1 });
        answers.set(BYRON, { unread: 1 });
        await round();
        expect(posted.map((n) => n.data.url).sort()).toEqual([BYRON, CASTLEMAINE].sort());
    });

    it('a phone that loses its push starts from what it last saw, so old news isn\'t told', async () => {
        keep(HOME, CASTLEMAINE);
        pushLanded(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { unread: 5 });
        await round();
        mem.async.delete(PUSH_REGISTERED_AT_STORE_KEY);
        await round();
        expect(posted).toEqual([]);
    });
});

describe('a community that doesn\'t answer costs a timeout, not a retry storm', () => {
    it.each([
        ['no connection', 'down'],
        ['an error', { status: 500 }],
        ['an older node with no such route', { status: 404 }],
        ['a captive portal\'s 200', { status: 200, body: { page: 'sign in' } }],
        ['a count that is no count', { status: 200, body: { unread: -1 } }],
        ['a fractional count', { status: 200, body: { unread: 2.5 } }],
        ['a clock the node refuses', { status: 401 }],
        ['a 403 that says nothing of membership', { status: 403, body: { error: 'nonce spent' } }],
    ] as Array<[string, Answer]>)('a down count posts nothing and keeps the number: %s', async (_name, answer) => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { unread: 2 });
        await round();
        asked = [];
        posted = [];
        answers.set(CASTLEMAINE, answer);
        await round();
        expect(posted).toEqual([]);
        expect(await readNoticeCounts(AsyncStorage)).toEqual({ [CASTLEMAINE]: 2 });
        expect(unreadAsks()).toHaveLength(1);

        // Back up with the same count: nothing to tell. A failed look was no fall.
        answers.set(CASTLEMAINE, { unread: 2 });
        await round();
        expect(posted).toEqual([]);
    });

    it('one community down holds up no other', async () => {
        keep(HOME, CASTLEMAINE, BYRON);
        answers.set(CASTLEMAINE, 'down');
        answers.set(BYRON, { unread: 1 });
        await round();
        expect(posted.map((n) => n.data.url)).toEqual([BYRON]);
    });
});

describe('what is asked, and of whom', () => {
    it('a signed GET of the counts route, for that community\'s own host, with no body and no query, and nothing of any other community', async () => {
        keep(HOME, CASTLEMAINE, BYRON);
        answers.set(CASTLEMAINE, { unread: 1 });
        answers.set(BYRON, { unread: 1 });
        await round();
        expect(asked.map((a) => a.path)).toEqual(['/api/me/unread', '/api/me/unread']);
        for (const a of asked) {
            expect(a.signed).toBe(true);
            expect(a.method).toBe('GET');
            expect(a.body).toBeUndefined();
            expect(a.headers['X-Public-Key']).toBe(kim.publicKey);
            const other = a.community === CASTLEMAINE ? BYRON : CASTLEMAINE;
            expect(JSON.stringify(a.headers)).not.toContain(new URL(other).host);
            expect(JSON.stringify(a.headers)).not.toContain(new URL(HOME).host);
        }
    });

    it('the community in use is never asked: its socket and its push say what happens there', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(HOME, { unread: 7 });
        answers.set(CASTLEMAINE, { unread: 0 });
        await round();
        expect(askedOf(HOME)).toEqual([]);
    });

    it('not one the phone only looks at as a guest, not one with alerts off, and neither shows a number any more', async () => {
        keep(HOME, CASTLEMAINE, BYRON);
        answers.set(CASTLEMAINE, { unread: 3 });
        answers.set(BYRON, { unread: 4 });
        await round();
        expect(await noticeCountsSum(AsyncStorage)).toBe(7);

        asked = [];
        mem.async.set(GUESTS, JSON.stringify([CASTLEMAINE]));
        mem.async.set(PUSH_ALERTS_OFF_STORE_KEY, JSON.stringify([BYRON]));
        await round();
        expect(unreadAsks()).toEqual([]);
        expect(await readNoticeCounts(AsyncStorage)).toEqual({});
        expect(badges.at(-1)).toBe(0);
    });

    it('not one forgotten: nothing reaches a community the phone doesn\'t keep', async () => {
        keep(HOME, CASTLEMAINE, BYRON);
        answers.set(CASTLEMAINE, { unread: 1 });
        await round();
        asked = [];
        keep(HOME, CASTLEMAINE);
        await round();
        expect(askedOf(BYRON)).toEqual([]);
    });

    it('a community that says the account isn\'t theirs loses its number and is left alone for the wait, then asked once', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { unread: 2 });
        await round();
        asked = [];
        posted = [];
        answers.set(CASTLEMAINE, { status: 403, body: { code: 'not_a_member' } });
        await round();
        expect(unreadAsks()).toHaveLength(1);
        expect(await readNoticeCounts(AsyncStorage)).toEqual({});

        asked = [];
        for (let i = 0; i < 5; i++) await round();
        expect(unreadAsks()).toEqual([]);
        clock += NOT_THEIRS_WAIT_MS;
        await round();
        expect(unreadAsks()).toHaveLength(1);
    });

    it.each(['account_closed', 'key_invalidated'])('so does one that says %s', async (code) => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { status: 403, body: { code } });
        await round();
        asked = [];
        await round();
        expect(unreadAsks()).toEqual([]);
    });

    it('a server from before bound signatures is never asked: it has no such route, and its signature would name no host', async () => {
        mem.async.set(ANCHOR, HOME);
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: HOME }, { url: CASTLEMAINE, requestSigning: 1 }, { url: BYRON, requestSigning: 2 }]));
        answers.set(BYRON, { unread: 0 });
        await round();
        expect(unreadAsks().map((a) => a.community)).toEqual([BYRON]);
    });

    it('a community that became the one in use while it answered writes nothing and tells nobody', async () => {
        keep(HOME, CASTLEMAINE);
        const answering = vi.fn(async () => {
            mem.async.set(ANCHOR, CASTLEMAINE);
            return new Response(JSON.stringify({ unread: 5, requests: 0 }), { status: 200 });
        });
        vi.stubGlobal('fetch', answering);
        await round();
        expect(answering).toHaveBeenCalledTimes(1);
        expect(posted).toEqual([]);
        expect(await readNoticeCounts(AsyncStorage)).toEqual({});
    });

    it('an account that left the phone while they answered leaves nothing behind: no notice, no number, no list of who said no', async () => {
        keep(HOME, CASTLEMAINE, BYRON);
        const answering = vi.fn(async (input: RequestInfo | URL) => {
            // Sign Out's wipe (identity.ts wipeIdentityScopedStorage), the rounds' own note with the rest.
            mem.async.delete(ANCHOR);
            mem.async.delete(SAVED_NODES_STORE_KEY);
            mem.async.delete(UNREAD_ROUNDS_STORE_KEY);
            return String(input).startsWith(CASTLEMAINE)
                ? new Response(JSON.stringify({ unread: 5, requests: 0 }), { status: 200 })
                : new Response(JSON.stringify({ code: 'not_a_member' }), { status: 403 });
        });
        vi.stubGlobal('fetch', answering);
        await round();
        expect(answering).toHaveBeenCalledTimes(2);
        expect(posted).toEqual([]);
        expect(await readNoticeCounts(AsyncStorage)).toEqual({});
        expect(mem.async.has(UNREAD_ROUNDS_STORE_KEY)).toBe(false);
    });

    it('Sign Out takes what the rounds kept: it names where the account belongs', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { status: 403, body: { code: 'not_a_member' } });
        await round();
        expect(mem.async.get(UNREAD_ROUNDS_STORE_KEY)).toContain(CASTLEMAINE);
        const { wipeIdentityScopedStorage } = await import('../identity');
        await wipeIdentityScopedStorage(AsyncStorage as never, { deleteSecret: async () => undefined });
        expect(mem.async.has(UNREAD_ROUNDS_STORE_KEY)).toBe(false);
    });

    it('nothing at all without an account on the phone', async () => {
        keep(HOME, CASTLEMAINE);
        expect(await round({ account: null })).toBe(0);
        expect(asked).toEqual([]);
        expect(badges).toEqual([]);
    });

    it('rounds belong to the account: another key on the phone starts afresh', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { status: 403, body: { code: 'not_a_member' } });
        await round();
        asked = [];
        answers.set(CASTLEMAINE, { unread: 0 });
        await round({ account: account() });
        expect(unreadAsks()).toHaveLength(1);
    });
});

describe('the notice says what the design lets it say, and no more', () => {
    it('fixed words, the saved name, a tap\'s target; no count, no message, no person', async () => {
        keep(HOME, [CASTLEMAINE, 'Castlemaine']);
        answers.set(CASTLEMAINE, { unread: 3, requests: 2 });
        await round();
        expect(posted).toEqual([{
            title: 'BeanPool',
            body: 'You have new messages in Castlemaine',
            data: { bpLocal: 1, type: 'unread-elsewhere', url: CASTLEMAINE },
        }]);
    });

    it('with no saved name, the community\'s host; a long or broken name stays one short line', async () => {
        keep(HOME, CASTLEMAINE, [BYRON, `Byron\nBay ${'x'.repeat(200)}`]);
        answers.set(CASTLEMAINE, { unread: 1 });
        answers.set(BYRON, { unread: 1 });
        await round();
        const body = (url: string) => posted.find((n) => n.data.url === url)!.body;
        expect(body(CASTLEMAINE)).toBe(`You have new messages in ${new URL(CASTLEMAINE).host}`);
        expect(body(BYRON)).not.toContain('\n');
        expect(body(BYRON).length).toBeLessThan(100);
    });
});

describe('requests aren\'t unread: nothing until accepted (Marty, 1 Nov)', () => {
    it('a request waiting makes no notice, no number and no badge', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { unread: 0, requests: 4 });
        await round();
        expect(posted).toEqual([]);
        expect(await readNoticeCounts(AsyncStorage)).toEqual({});
        expect(badges).toEqual([0]);
    });
});

describe('permissions only when asked (Marty, standing)', () => {
    const phone = (over: Partial<PhoneNotices>): PhoneNotices => ({
        mayNotify: async () => true,
        post: async (n) => { posted.push(n); },
        setBadge: async (n) => { badges.push(n); },
        ...over,
    });

    it('no permission, in the background: the count, the numbers and the badge move, nothing shows, and the sync\'s own notices wait', async () => {
        keep(HOME, [CASTLEMAINE, 'Castlemaine']);
        answers.set(HOME, { unread: 1 });
        answers.set(CASTLEMAINE, { unread: 2 });
        const n = await noticesAfterSync({ storage: AsyncStorage, account: kim, phone: phone({ mayNotify: async () => false }) });
        expect(n).toBe(0);
        expect(posted).toEqual([]);
        expect(badges).toEqual([3]);
        expect(await readNoticeCounts(AsyncStorage)).toEqual({ [CASTLEMAINE]: 2 });
        // The community in use is asked its count, and nothing else: the sync's own notices wait.
        expect(askedOf(HOME).map((a) => a.path)).toEqual(['/api/me/unread']);
    });

    it('no permission, while open: the same', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { unread: 2 });
        await roundWhileOpen(AsyncStorage, kim, phone({ mayNotify: async () => false }));
        expect(posted).toEqual([]);
        expect(badges).toEqual([2]);
    });

    it('turned on later, only what is new is told', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { unread: 2 });
        await round({ post: null });
        answers.set(CASTLEMAINE, { unread: 2 });
        await round();
        expect(posted).toEqual([]);
        answers.set(CASTLEMAINE, { unread: 3 });
        await round();
        expect(posted).toHaveLength(1);
    });

    it('nothing here can prompt: the phone is only asked what it already allows', () => {
        const read = (file: string) => fs.readFileSync(path.resolve(__dirname, file), 'utf8');
        expect(read('../other-communities-unread.ts')).not.toMatch(/requestPermissions/);
        const service = read('../../services/push-notifications.ts');
        const start = service.indexOf('const phoneNotices');
        expect(service.slice(start, service.indexOf('};', start))).toContain('getPermissionsAsync');
        expect(service.slice(start, service.indexOf('};', start))).not.toContain('requestPermissions');
        const asks = service.match(/requestPermissionsAsync/g) ?? [];
        expect(asks).toHaveLength(1);
    });
});

describe('the app-icon badge is the sum', () => {
    it('every community that answered, added up, and the one in use as it answered itself while the app is closed', async () => {
        keep(HOME, CASTLEMAINE, BYRON);
        answers.set(HOME, { unread: 2 });
        answers.set(CASTLEMAINE, { unread: 3 });
        answers.set(BYRON, { unread: 4 });
        await closedRound();
        expect(badges).toEqual([9]);
    });

    it('a push and the count that holds it are one message, not two', async () => {
        keep(HOME, CASTLEMAINE);
        pushLanded(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { unread: 2 });
        await round();
        await countNotice(AsyncStorage, CASTLEMAINE, 'push-1');
        expect(await noticeCountsSum(AsyncStorage)).toBe(2);
    });

    it('a community down keeps its part in the sum', async () => {
        keep(HOME, CASTLEMAINE, BYRON);
        answers.set(CASTLEMAINE, { unread: 3 });
        answers.set(BYRON, { unread: 1 });
        await round();
        answers.set(CASTLEMAINE, 'down');
        answers.set(BYRON, { unread: 0 });
        await round();
        expect(badges).toEqual([4, 3]);
    });

    it.each([
        ['down', 'down'],
        ['refusing for some other reason', { status: 500 }],
        ['answering with no count', { status: 200, body: { unread: 'many' } }],
    ] as Array<[string, Answer]>)('the community in use %s leaves the badge as it was, not lower than the truth', async (_, answer) => {
        keep(HOME, CASTLEMAINE);
        answers.set(HOME, answer);
        answers.set(CASTLEMAINE, { unread: 3 });
        await closedRound();
        expect(badges).toEqual([]);
        expect(await readNoticeCounts(AsyncStorage)).toEqual({ [CASTLEMAINE]: 3 });
    });

    it('nothing is ever read from a copy nobody refreshed: the round has no way to', () => {
        const read = (file: string) => fs.readFileSync(path.resolve(__dirname, file), 'utf8');
        expect(read('../other-communities-unread.ts')).not.toMatch(/getGlobalUnreadCount/);
        expect(read('../../services/push-notifications.ts')).not.toMatch(/getGlobalUnreadCount/);
    });

    it('while the app is open, what the phone knows, asking nobody; the community in use isn\'t in it, as ever', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { unread: 3 });
        await round();
        asked = [];
        badges = [];
        await showUnreadSum(AsyncStorage, async (n) => { badges.push(n); });
        expect(badges).toEqual([3]);
        expect(asked).toEqual([]);
    });

    it('a switch takes the community now in use out of the sum', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { unread: 3 });
        await round();
        badges = [];
        mem.async.set(ANCHOR, CASTLEMAINE);
        await clearActiveCount(AsyncStorage);
        await showUnreadSum(AsyncStorage, async (n) => { badges.push(n); });
        expect(badges).toEqual([0]);
    });

    it('a phone with one community is left to its push\'s badge', async () => {
        keep(HOME);
        await showUnreadSum(AsyncStorage, async (n) => { badges.push(n); });
        expect(badges).toEqual([]);
    });

    it('a push\'s own number doesn\'t reach the icon on a phone that keeps its own sum', () => {
        const service = fs.readFileSync(path.resolve(__dirname, '../../services/push-notifications.ts'), 'utf8');
        expect(service).toContain('const pushBadge = show && !await keepsOtherCommunities(AsyncStorage);');
        expect(service).toContain('shouldSetBadge: pushBadge');
        expect(service).not.toContain('shouldSetBadge: show');
    });

    it('only while the app is really open: iOS can start it in the background, and the root layout runs then too', () => {
        const service = fs.readFileSync(path.resolve(__dirname, '../../services/push-notifications.ts'), 'utf8');
        const body = (name: string) => service.slice(service.indexOf(`export ${name}`), service.indexOf('\n}\n', service.indexOf(`export ${name}`)));
        expect(body('async function showBadgeSum')).toContain("AppState.currentState !== 'active'");
        expect(body('async function askOtherCommunitiesNow')).toContain("AppState.currentState !== 'active'");
    });
});

describe('the community in use, while the app is closed: no socket, and the phone\'s copy is from when it closed', () => {
    const phone = (): PhoneNotices => ({ mayNotify: async () => true, post: async (n) => { posted.push(n); }, setBadge: async (n) => { badges.push(n); } });

    it('the review\'s reproduction: two DMs wait, its push set the icon to 2, and a background round leaves it at 2', async () => {
        keep(HOME, CASTLEMAINE);
        pushLanded(HOME, CASTLEMAINE);
        answers.set(HOME, { unread: 2 });
        answers.set(CASTLEMAINE, { unread: 0 });
        await closedRound();
        expect(badges).toEqual([2]);
        expect(posted).toEqual([]);
    });

    it('the same with it silent: no write at all, as the review asks, and the others still move', async () => {
        keep(HOME, CASTLEMAINE);
        pushLanded(HOME, CASTLEMAINE);
        answers.set(HOME, 'down');
        answers.set(CASTLEMAINE, { unread: 3 });
        await closedRound();
        expect(badges).toEqual([]);
        expect(await noticeCountsSum(AsyncStorage)).toBe(3);
    });

    it('a DM there with no push: one notice in the app\'s own words, and the badge. This is the DM that went unheard', async () => {
        keep([HOME, 'Home'], CASTLEMAINE);
        answers.set(HOME, { unread: 1 });
        answers.set(CASTLEMAINE, { unread: 0 });
        expect(await closedRound()).toBe(1);
        expect(posted).toHaveLength(1);
        expect(posted[0].title).toBe('BeanPool');
        expect(posted[0].body).toBe('You have new messages in Home');
        expect(posted[0].data).toEqual({ bpLocal: 1, type: 'unread-elsewhere', url: HOME });
        expect(badges).toEqual([1]);
    });

    it('through the whole background sync, not only a round', async () => {
        keep([HOME, 'Home'], CASTLEMAINE);
        answers.set(HOME, { unread: 1 });
        answers.set(CASTLEMAINE, { unread: 0 });
        expect(await noticesAfterSync({ storage: AsyncStorage, account: kim, phone: phone() })).toBe(1);
        expect(posted.map((n) => n.body)).toEqual(['You have new messages in Home']);
        expect(badges).toEqual([1]);
    });

    it('a phone with one community and no push is told as well: nothing else can', async () => {
        keep([HOME, 'Home']);
        answers.set(HOME, { unread: 1 });
        await closedRound();
        expect(posted.map((n) => n.body)).toEqual(['You have new messages in Home']);
        expect(badges).toEqual([1]);
    });

    it('a phone with one community whose push landed is left to that push: nothing asked, no badge written', async () => {
        keep(HOME);
        pushLanded(HOME);
        expect(await closedRound()).toBe(0);
        expect(asked).toEqual([]);
        expect(badges).toEqual([]);
        expect(mem.async.has(UNREAD_ROUNDS_STORE_KEY)).toBe(false);
    });

    it('a phone with one community with alerts off there, or on old signing: nothing asked, no badge written', async () => {
        keep(HOME);
        mem.async.set(PUSH_ALERTS_OFF_STORE_KEY, JSON.stringify([HOME]));
        await closedRound();
        mem.async.delete(PUSH_ALERTS_OFF_STORE_KEY);
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: HOME, requestSigning: 1 }]));
        await closedRound();
        expect(asked).toEqual([]);
        expect(badges).toEqual([]);
    });

    it('a rise posts once; the same count posts nothing, a kill between them included; a fall posts nothing; a rise after it posts again', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { unread: 0 });
        const seen: number[] = [];
        for (const unread of [2, 2, 1, 1, 3]) {
            answers.set(HOME, { unread });
            await closedRound();
            vi.resetModules();
            seen.push(posted.length);
        }
        expect(seen).toEqual([1, 1, 1, 1, 2]);
    });

    it('a mute holds here too: a rise in `unread` alone moves the badge and tells nobody', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(HOME, { unread: 5, alerts: 1 });
        answers.set(CASTLEMAINE, { unread: 0 });
        await closedRound();
        answers.set(HOME, { unread: 7, alerts: 1 });
        await closedRound();
        expect(posted).toHaveLength(1);
        expect(badges).toEqual([5, 7]);
    });

    it('where its push landed, no second line on the lock screen', async () => {
        keep(HOME, CASTLEMAINE);
        pushLanded(HOME);
        answers.set(HOME, { unread: 2 });
        await closedRound();
        expect(posted).toEqual([]);
    });

    it('read with the app open, the next line is still a rise: 1 is not less than the 2 no round saw go', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(HOME, { unread: 2 });
        answers.set(CASTLEMAINE, { unread: 0 });
        await closedRound();
        expect(posted).toHaveLength(1);
        await round();
        answers.set(HOME, { unread: 1 });
        await closedRound();
        expect(posted).toHaveLength(2);
    });

    it('that holds if the app opens inside the 5 minutes, and on a phone with one community', async () => {
        keep(HOME);
        answers.set(HOME, { unread: 2 });
        await closedRound();
        expect(posted).toHaveLength(1);
        await askOtherCommunities(deps());
        answers.set(HOME, { unread: 1 });
        await closedRound();
        expect(posted).toHaveLength(2);
    });

    it('a closed round still going as the app opens can\'t write what the open round forgot', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { unread: 0 });
        let answer: (r: Response) => void = () => {};
        const before = vi.mocked(fetch).getMockImplementation()!;
        vi.mocked(fetch).mockImplementation(async (input, init) => (String(input).startsWith(HOME)
            ? new Promise<Response>((resolve) => { answer = resolve; })
            : before(input, init)));
        const closing = closedRound();
        await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(2));
        const opening = roundWhileOpen(AsyncStorage, kim, phone());
        await Promise.resolve();
        answer(new Response(JSON.stringify({ unread: 2, alerts: 2, requests: 0 }), { status: 200 }));
        await closing;
        await opening;
        expect(JSON.parse(mem.async.get(UNREAD_ROUNDS_STORE_KEY) ?? '{}').inUse).toBeNull();
    });

    it('it is one of the six: five others go with it, and their turn goes on from where it stood', async () => {
        const towns = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((t) => `https://${t}.example.org`);
        keep(HOME, ...towns);
        answers.set(HOME, { unread: 0 });
        for (const t of towns) answers.set(t, { unread: 0 });
        const others = () => unreadAsks().map((a) => a.community).filter((c) => c !== HOME);

        await closedRound();
        expect(unreadAsks()).toHaveLength(UNREAD_ROUND_SIZE);
        expect(askedOf(HOME)).toHaveLength(1);
        expect(others()).toEqual(towns.slice(0, 5));
        asked = [];
        await closedRound();
        expect(askedOf(HOME)).toHaveLength(1);
        expect(others()).toEqual([...towns.slice(5), ...towns.slice(0, 2)]);
        asked = [];
        await round();
        expect(askedOf(HOME)).toEqual([]);
        expect(others()).toEqual([...towns.slice(2, 8)]);
    });

    it('under the sync\'s one deadline: with it hanging the task still ends at 8 seconds, a quick community\'s notice goes, and the badge stays', async () => {
        keep(HOME, [CASTLEMAINE, 'Castlemaine']);
        answers.set(HOME, 'never');
        answers.set(CASTLEMAINE, { unread: 1 });
        vi.useFakeTimers({ now: clock });
        const settled = vi.fn();
        void noticesAfterSync({ storage: AsyncStorage, account: kim, phone: phone() }).then(settled);
        await vi.advanceTimersByTimeAsync(7999);
        expect(unreadAsks().map((a) => a.community).sort()).toEqual([CASTLEMAINE, HOME]);
        expect(settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toHaveBeenCalledWith(1);
        expect(badges).toEqual([]);
    });

    it('one that says the account isn\'t theirs: none in the badge, and left alone for the wait', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(HOME, { status: 403, body: { code: 'not_a_member' } });
        answers.set(CASTLEMAINE, { unread: 2 });
        await closedRound();
        expect(badges).toEqual([2]);
        asked = [];
        await closedRound();
        expect(askedOf(HOME)).toEqual([]);
        expect(badges).toEqual([2, 2]);
    });

    it('one on old signing isn\'t asked, so there is no number for it: the badge stays as it was', async () => {
        mem.async.set(ANCHOR, HOME);
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: HOME, requestSigning: 1 }, { url: CASTLEMAINE }]));
        answers.set(CASTLEMAINE, { unread: 2 });
        await closedRound();
        expect(askedOf(HOME)).toEqual([]);
        expect(badges).toEqual([]);
    });

    it('one with alerts off isn\'t asked, and has no part in the badge', async () => {
        keep(HOME, CASTLEMAINE);
        mem.async.set(PUSH_ALERTS_OFF_STORE_KEY, JSON.stringify([HOME]));
        answers.set(CASTLEMAINE, { unread: 2 });
        await closedRound();
        expect(askedOf(HOME)).toEqual([]);
        expect(badges).toEqual([2]);
    });

    it('an account that left the phone while it answered leaves nothing behind', async () => {
        keep(HOME, CASTLEMAINE);
        vi.stubGlobal('fetch', vi.fn(async () => {
            mem.async.delete(ANCHOR);
            mem.async.delete(SAVED_NODES_STORE_KEY);
            mem.async.delete(UNREAD_ROUNDS_STORE_KEY);
            return new Response(JSON.stringify({ unread: 5, alerts: 5, requests: 0 }), { status: 200 });
        }));
        await closedRound();
        expect(posted).toEqual([]);
        expect(mem.async.has(UNREAD_ROUNDS_STORE_KEY)).toBe(false);
    });

    it('a rise that can\'t be written down tells nobody: it would be told again every round', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(HOME, { unread: 2 });
        answers.set(CASTLEMAINE, { unread: 0 });
        let writes = 0;
        const failing = {
            ...AsyncStorage,
            getItem: AsyncStorage.getItem,
            setItem: async (key: string, value: string) => {
                if (key === UNREAD_ROUNDS_STORE_KEY && ++writes === 2) throw new Error('storage full');
                return AsyncStorage.setItem(key, value);
            },
        };
        await closedRound({ storage: failing });
        expect(posted).toEqual([]);
        expect(badges).toEqual([2]);
    });

    it('rounds belong to the account: another key starts from nothing', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(HOME, { unread: 2 });
        answers.set(CASTLEMAINE, { unread: 0 });
        await closedRound();
        expect(posted).toHaveLength(1);
        await closedRound({ account: account() });
        expect(posted).toHaveLength(2);
    });

    it('a tap opens its Chat, with no switch: it is already there', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(HOME, { unread: 1 });
        answers.set(CASTLEMAINE, { unread: 0 });
        await closedRound();
        const opened: string[] = [];
        const went: NoticeRoute[] = [];
        await followTap({ identifier: 'n', remote: false, title: 'BeanPool', body: 'x', data: posted[0].data }, {
            storage: AsyncStorage, account: kim, openIn: async (community) => { opened.push(community); },
        }, (route) => { went.push(route); });
        expect(went).toEqual(['/(tabs)/chats']);
        expect(opened).toEqual([]);
    });
});

describe('one community saved in two spellings is one community', () => {
    const SPELT = 'https://Home.example.org';
    const twice = (extra: object[] = []) => {
        mem.async.set(ANCHOR, SPELT);
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: SPELT, alias: 'Home' }, { url: HOME }, ...extra]));
    };

    it('the review\'s reproduction, open: no question and no notice for the community the phone is on, and its badge left alone', async () => {
        twice();
        answers.set(HOME, { unread: 3 });
        await round();
        expect(asked).toEqual([]);
        expect(posted).toEqual([]);
        expect(badges).toEqual([]);
    });

    it('the review\'s reproduction, closed: asked once, and a badge of 3 for 3 unread, not 6', async () => {
        twice();
        answers.set(HOME, { unread: 3 });
        await closedRound();
        expect(unreadAsks()).toHaveLength(1);
        expect(badges).toEqual([3]);
        expect(await noticeCountsSum(AsyncStorage)).toBe(0);
    });

    it.each([['capitals', SPELT], ['the default port', `${HOME}:443`], ['a trailing slash', `${HOME}/`]])('%s make it no other community', async (_, spelling) => {
        mem.async.set(ANCHOR, HOME);
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: spelling }]));
        expect(await keepsOtherCommunities(AsyncStorage)).toBe(false);
    });

    it('a real other community on the list is still another', async () => {
        twice([{ url: CASTLEMAINE }]);
        expect(await keepsOtherCommunities(AsyncStorage)).toBe(true);
        answers.set(CASTLEMAINE, { unread: 1 });
        await round();
        expect(unreadAsks().map((a) => a.community)).toEqual([CASTLEMAINE]);
    });

    it('another community saved twice is asked once, told of once, and counted once', async () => {
        mem.async.set(ANCHOR, HOME);
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: HOME }, { url: CASTLEMAINE }, { url: 'https://Castlemaine.example.org' }]));
        answers.set(CASTLEMAINE, { unread: 2 });
        await round();
        expect(unreadAsks()).toHaveLength(1);
        expect(posted).toHaveLength(1);
        expect(badges).toEqual([2]);
    });

    it('old signing on either spelling stands for the community', async () => {
        mem.async.set(ANCHOR, SPELT);
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: HOME, requestSigning: 1 }, { url: SPELT }, { url: CASTLEMAINE }]));
        answers.set(CASTLEMAINE, { unread: 1 });
        await closedRound();
        expect(unreadAsks().map((a) => a.community)).toEqual([CASTLEMAINE]);
    });
});

describe('a tap goes where the notice said', () => {
    const local = (data: Record<string, unknown>) => ({ identifier: nodeCrypto.randomUUID(), remote: false, title: 'BeanPool', body: 'x', data });
    let opened: Array<{ community: string; id: string | null; route: NoticeRoute }>;
    let went: NoticeRoute[];
    const tap = (n: ReturnType<typeof local>) => followTap(n, {
        storage: AsyncStorage,
        account: kim,
        openIn: async (community, id, route) => { opened.push({ community, id, route: await route() }); },
    }, (route) => { went.push(route); });

    beforeEach(() => {
        opened = [];
        went = [];
    });

    it('the community named, through the one switch, then its Chat: no id, so nothing is counted', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { unread: 1 });
        await round();
        await tap(local(posted[0].data));
        expect(opened).toEqual([{ community: CASTLEMAINE, id: null, route: '/(tabs)/chats' }]);
        expect(went).toEqual([]);
    });

    it('already there: its Chat, with no switch', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { unread: 1 });
        await round();
        mem.async.set(ANCHOR, CASTLEMAINE);
        await tap(local(posted[0].data));
        expect(went).toEqual(['/(tabs)/chats']);
        expect(opened).toEqual([]);
    });

    it('a community since forgotten: nothing, and no warning', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { unread: 1 });
        await round();
        keep(HOME);
        const decision = await tap(local(posted[0].data));
        expect(decision).toEqual({ kind: 'nothing', reason: 'local' });
        expect(opened).toEqual([]);
        expect(went).toEqual([]);
    });

    it('only the app\'s own notice does this: a push dressed as one moves nothing', async () => {
        keep(HOME, CASTLEMAINE);
        const forged = { ...local({ bpLocal: 1, type: 'unread-elsewhere', url: CASTLEMAINE }), remote: true };
        const decision = await tap(forged);
        expect(decision.kind).not.toBe('unread');
        expect(opened).toEqual([]);
        expect(went).toEqual([]);
    });
});

describe('wired in where the design says', () => {
    const layout = fs.readFileSync(path.resolve(__dirname, '../../app/_layout.tsx'), 'utf8');
    const between = (from: string, to: string) => layout.slice(layout.indexOf(from), layout.indexOf(to, layout.indexOf(from)));

    it('as the app opens, with the 5-minute tick, and as it comes back', () => {
        expect(between('// Set up foreground polling fallback', '}, 300000);')).toContain('void askOtherCommunitiesNow();');
        expect(between('// App state listener to trigger sync', 'appState.current = nextAppState;')).toContain('void askOtherCommunitiesNow();');
        expect(layout.slice(0, layout.indexOf('// Set up foreground polling fallback'))).toContain('void askOtherCommunitiesNow();');
    });

    it('with the background sync, through the notices that share its deadline', () => {
        const task = fs.readFileSync(path.resolve(__dirname, '../../services/background-task.ts'), 'utf8');
        expect(task).toContain('await postNoticesAfterSync()');
        const service = fs.readFileSync(path.resolve(__dirname, '../../services/push-notifications.ts'), 'utf8');
        expect(service).toContain('return await noticesAfterSync({');
    });
});

describe('alerts turned off while a round is out (PR #2772 review, finding 2)', () => {
    /** The next answer from `community` waits until `release()`: the member's switch lands first. */
    function holdAnswers(community: string) {
        const real = fetch as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let entered = 0;
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            if (new URL(String(input)).origin === community) { entered += 1; await gate; }
            return real(input, init);
        }));
        return { release, entered: () => entered };
    }

    it('the answer that comes after the switch went off is not counted, not told, and the number stays cleared', async () => {
        keep(HOME, [CASTLEMAINE, 'Castlemaine']);
        answers.set(CASTLEMAINE, { unread: 5 });
        const held = holdAnswers(CASTLEMAINE);
        const running = round();
        await vi.waitFor(() => expect(held.entered()).toBe(1));
        // The sheet's switch: the list first, then the number goes.
        await markAlertsOff(CASTLEMAINE);
        await dropCounts(AsyncStorage, [CASTLEMAINE]);
        held.release();
        expect(await running).toBe(0);
        expect(posted).toEqual([]);
        expect(await readNoticeCounts(AsyncStorage)).toEqual({});
        expect(badges).toEqual([0]);
    });

    it('the same round with the switch still on counts and tells, so the check above could fail', async () => {
        keep(HOME, [CASTLEMAINE, 'Castlemaine']);
        answers.set(CASTLEMAINE, { unread: 5 });
        const held = holdAnswers(CASTLEMAINE);
        const running = round();
        await vi.waitFor(() => expect(held.entered()).toBe(1));
        held.release();
        expect(await running).toBe(1);
        expect(posted).toHaveLength(1);
        expect(await readNoticeCounts(AsyncStorage)).toEqual({ [CASTLEMAINE]: 5 });
    });

    it('the community in use, answering after its alerts went off, adds nothing to the badge', async () => {
        keep(HOME, [CASTLEMAINE, 'Castlemaine']);
        answers.set(HOME, { unread: 4 });
        answers.set(CASTLEMAINE, { unread: 0 });
        const held = holdAnswers(HOME);
        const running = closedRound();
        await vi.waitFor(() => expect(held.entered()).toBe(1));
        await markAlertsOff(HOME);
        held.release();
        await running;
        expect(posted).toEqual([]);
        expect(badges[badges.length - 1]).toBe(0);
    });
});

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
import { clearActiveCount, countNotice, noticeCountsSum, readNoticeCounts } from '../notice-counts';
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
type Answer = { unread: number; requests?: number } | { status: number; body?: unknown } | 'down' | 'never';
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
        return new Response(JSON.stringify({ unread: a.unread, requests: a.requests ?? 0, asOf: new Date(clock).toISOString() }), { status: 200 });
    }));
});

afterEach(() => {
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
            mem.async.delete(ANCHOR);
            mem.async.delete(SAVED_NODES_STORE_KEY);
            return String(input).startsWith(CASTLEMAINE)
                ? new Response(JSON.stringify({ unread: 5, requests: 0 }), { status: 200 })
                : new Response(JSON.stringify({ code: 'not_a_member' }), { status: 403 });
        });
        vi.stubGlobal('fetch', answering);
        await round();
        expect(answering).toHaveBeenCalledTimes(2);
        expect(posted).toEqual([]);
        expect(mem.async.get(UNREAD_ROUNDS_STORE_KEY)).not.toContain('notTheirs":{"');
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
        answers.set(CASTLEMAINE, { unread: 2 });
        const n = await noticesAfterSync({ storage: AsyncStorage, account: kim, phone: phone({ mayNotify: async () => false }), activeUnread: async () => 0 });
        expect(n).toBe(0);
        expect(posted).toEqual([]);
        expect(badges).toEqual([2]);
        expect(await readNoticeCounts(AsyncStorage)).toEqual({ [CASTLEMAINE]: 2 });
        expect(askedOf(HOME)).toEqual([]);
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
    it('every community that answered, added up, and the one in use as the phone\'s copy counts it while the app is closed', async () => {
        keep(HOME, CASTLEMAINE, BYRON);
        answers.set(CASTLEMAINE, { unread: 3 });
        answers.set(BYRON, { unread: 4 });
        await round({ activeUnread: async () => 2 });
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

    it('a count of the community in use that can\'t be read leaves the badge as it was, not lower than the truth', async () => {
        keep(HOME, CASTLEMAINE);
        answers.set(CASTLEMAINE, { unread: 3 });
        await round({ activeUnread: async () => { throw new Error('no database'); } });
        expect(badges).toEqual([]);
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

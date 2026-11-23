/**
 * Every list the phone reads from a node lets its caller go at a deadline (#3309 max re-check, triage 46), and a read its
 * caller already bounds keeps that budget and no other (#3376 max review B1, N1, N2).
 *
 * React Native's fetch never gives up by itself: a read asked with no signal (fetchGroups, a treasury's ledger, a group's
 * roster, the forum's reads) held its caller for as long as the network did. Those get a backstop, LIST_READ_BACKSTOP_MS
 * (60 s, long enough that no real list misses it on a slow line). A read whose caller passes its own signal (core's 30 s
 * for a tool's copy and its deals, syncMessages' 10 s and 5 s, a chat's 12 s poll) keeps exactly that, as before: the phone
 * and the web agree again. React Native's fetch resolves only once the whole body has arrived, so on the phone a budget on
 * the answer is the body's too; the body reads under the backstop are bounded as well, for a fetch that streams.
 *
 * 1. One table, the backstop's (close the class): each list read in utils/db.ts with no budget of its own x a server that
 *    never answers, and one that answers its headers and never ends the body. The fetch ignores its abort signal, as a
 *    fetch that never gives up does, and every deadline is shortened to 80 ms. Each row asserts that the read asked that
 *    server (the row is not vacuous), that it settled at its deadline (not before, so the deadline ended it, and not left
 *    waiting), and that the sync lock is free after.
 * 2. On a fake clock, with the real budgets and a fetch that gives up on its abort (as React Native's does): a caller's own
 *    30 s is honoured at 15 s (tools/node-copy's real read, and core's withinAnswerTime as tools/builder.ts asks), a whole
 *    list answering at 15 s is read, syncMessages' own 10 s still cuts a busy network's wait, a read the backstop ends says
 *    the words for no answer, and a roster that gives up leaves the group's card.
 * 3. The class's guard over the source.
 *
 * The phone's real schema over an in-memory SQLite (node:sqlite), as message-sync-read-worked.test.ts runs it.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import Module from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const h = vi.hoisted(() => ({
    cacheDir: '',
    store: new Map<string, string>(),
    me: { publicKey: 'pk-me', privateKey: '' },
    /** This phone's copy of the node's profile: none, unless a row reads the whole members' directory. */
    profile: null as null | { features: Record<string, unknown> },
}));

// tools/node-copy (a row below reads a tool's copy through it) imports react-native's Platform; db.ts requires it lazily.
vi.mock('react-native', () => ({
    Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
    DeviceEventEmitter: { emit: () => {}, addListener: () => ({ remove: () => {} }) },
}));
vi.mock('expo-sqlite', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const sql = new DatabaseSync(':memory:');
    const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
    const adapter = {
        runAsync: vi.fn(async (q: string, p?: unknown) => {
            const r = sql.prepare(q).run(...params(p));
            return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
        }),
        execAsync: vi.fn(async (q: string) => { sql.exec(q); }),
        getAllAsync: vi.fn(async (q: string, p?: unknown) => sql.prepare(q).all(...params(p))),
        getFirstAsync: vi.fn(async (q: string, p?: unknown) => sql.prepare(q).get(...params(p)) ?? null),
        closeAsync: vi.fn(async () => {}),
        withTransactionAsync: vi.fn(async (cb: () => Promise<void>) => { await cb(); }),
    };
    return { openDatabaseAsync: vi.fn(async () => adapter) };
});
vi.mock('expo-file-system/legacy', async () => {
    const nodeFs = await import('node:fs');
    const nodeOs = await import('node:os');
    const nodePath = await import('node:path');
    if (!h.cacheDir) h.cacheDir = nodeFs.mkdtempSync(nodePath.join(process.env.TMPDIR || nodeOs.tmpdir(), 'bp-list-deadlines-'));
    const local = (uri: string) => decodeURI(uri).replace(/^file:\/\//, '');
    return {
        cacheDirectory: `file://${h.cacheDir}/`,
        documentDirectory: `file://${h.cacheDir}/doc/`,
        getInfoAsync: vi.fn(async (uri: string) => ({ exists: nodeFs.existsSync(local(uri)) })),
        deleteAsync: vi.fn(async (uri: string) => { nodeFs.rmSync(local(uri), { force: true, recursive: true }); }),
        makeDirectoryAsync: vi.fn(async (uri: string) => { nodeFs.mkdirSync(local(uri), { recursive: true }); }),
        writeAsStringAsync: vi.fn(async (uri: string, data: string) => { nodeFs.writeFileSync(local(uri), data); }),
        readAsStringAsync: vi.fn(async (uri: string) => (nodeFs.existsSync(local(uri)) ? nodeFs.readFileSync(local(uri), 'utf8') : '')),
        readDirectoryAsync: vi.fn(async (uri: string) => (nodeFs.existsSync(local(uri)) ? nodeFs.readdirSync(local(uri)) : [])),
        moveAsync: vi.fn(async () => {}),
    };
});
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => h.store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { h.store.set(k, String(v)); }),
        removeItem: vi.fn(async (k: string) => { h.store.delete(k); }),
        getAllKeys: vi.fn(async () => [...h.store.keys()]),
        multiRemove: vi.fn(async (ks: string[]) => { for (const k of ks) h.store.delete(k); }),
    },
}));
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID, getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ ...h.me, callsign: 'Me' })) }));
vi.mock('../node-profile', async (orig) => ({ ...(await orig<any>()), getCachedNodeProfile: vi.fn(async () => h.profile) }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));

import { TOOL_COPY_ANSWER_MS, withinAnswerTime } from '@beanpool/core';
import * as db from '../db';
import { CACHE_NAMES_DONE_KEY } from '../cache-file-migration';

const realLoad = (Module as any)._load;
beforeAll(() => {
    (Module as any)._load = function (request: string, ...rest: any[]) {
        if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {}, addListener: () => ({ remove: () => {} }) }, Platform: { OS: 'android' } };
        return realLoad.call(this, request, ...rest);
    };
});
afterAll(() => {
    (Module as any)._load = realLoad;
    db._setReadDeadlineForTests(null);
    if (h.cacheDir) fs.rmSync(h.cacheDir, { recursive: true, force: true });
});

const ANCHOR = 'https://riverside.example';
const PEER = 'pk-peer';
/** Every deadline of ours in the table (the backstop's 60 s, getReachablePeers' 10 s), shortened to it. */
const DEADLINE_MS = 80;
/** How long a row waits for a read that should have given up at DEADLINE_MS before it calls it hung. */
const STILL_WAITING_MS = 3_000;
/** What a read our deadline ended throws (db.ts READ_GAVE_UP_TEXT): the words both screens already show for no answer. */
const NO_ANSWER = 'Could not reach the node.';

// ── The node: it answers every read at once, except the row's, which it never answers or whose body never ends ─────────

type Hang = 'never answers' | 'never ends the body';
const node = { hung: null as RegExp | null, hang: 'never answers' as Hang, asked: [] as string[], signedOnly: false };

function answer(status: number, body: unknown) {
    const text = JSON.stringify(body);
    const res: any = { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
    res.clone = () => answer(status, body);
    return res;
}
const never = () => new Promise<never>(() => {});
function hung(): Promise<any> {
    if (node.hang === 'never answers') return never();
    const res: any = { ok: true, status: 200, headers: { get: () => null }, json: never, text: never, arrayBuffer: never, blob: never };
    res.clone = () => res;
    return Promise.resolve(res);
}

/** The other answers a row's read needs on its way to the read that hangs. */
function quick(pathname: string): any {
    if (/^\/api\/messages\/conversations\/[^/]+$/.test(pathname)) {
        return answer(200, { conversations: [{ id: 'chat-1', type: 'group_thread', name: 'chat-1', participants: [h.me.publicKey, PEER], createdBy: PEER, createdAt: '2026-11-20T00:00:00.000Z' }], totalUnread: 0, deletedAccounts: [] });
    }
    // A signed read refused for its signature (a phone clock that's off): getDecisions reads the list unsigned then.
    if (node.signedOnly && pathname === '/api/commons/decisions') return answer(401, { error: 'bad signature' });
    return answer(404, { error: 'not here' });
}

const fetchMock = vi.fn(async (url: string, init: any = {}) => {
    const u = new URL(url);
    node.asked.push(u.pathname);
    const signed = !!init?.headers?.['X-Signed'];
    if (node.hung?.test(u.pathname) && !(node.signedOnly && signed)) return hung();
    return quick(u.pathname);
});

beforeEach(async () => {
    h.store.clear();
    h.store.set(CACHE_NAMES_DONE_KEY, '1');
    h.store.set('beanpool_anchor_url', ANCHOR);
    node.hung = null;
    node.hang = 'never answers';
    node.asked = [];
    node.signedOnly = false;
    h.profile = null;
    (globalThis as any).fetch = fetchMock;
    db._setReadDeadlineForTests(DEADLINE_MS);
    await db.getDb();
});

// ── 1. The backstop's table ────────────────────────────────────────────────────────────────────────────────────────

/** [the read, the call, the path it reads that the node holds up, set-up]. */
type Row = [string, () => Promise<unknown>, RegExp, (() => void)?];
const ROWS: Row[] = [
    ['fetchGroups', () => db.fetchGroups(), /^\/api\/groups$/],
    ['fetchYourGroups', () => db.fetchYourGroups(), /^\/api\/your-groups$/],
    ['fetchHeldYourGroups', () => db.fetchHeldYourGroups(h.me.publicKey, ANCHOR), /^\/api\/your-groups$/],
    ['fetchGroupDetails: the group and its members', () => db.fetchGroupDetails('g1'), /^\/api\/groups\/g1(\/members)?$/],
    ['fetchGroupInvitations', () => db.fetchGroupInvitations('g1'), /^\/api\/groups\/g1\/invitations$/],
    ['getGroupChat', () => db.getGroupChat('g1'), /^\/api\/groups\/g1\/chat$/],
    ['getGroupActiveMembers', () => db.getGroupActiveMembers('g1'), /^\/api\/groups\/g1\/members$/],
    ['getGroupDecisions', () => db.getGroupDecisions('g1'), /^\/api\/groups\/g1\/decisions$/],
    ['getEnterpriseChat', () => db.getEnterpriseChat('t1'), /^\/api\/enterprise\/t1\/thread$/],
    ['getEnterpriseThread', () => db.getEnterpriseThread('t1'), /^\/api\/treasury\/t1\/thread$/],
    ['getEnterpriseDecisions', () => db.getEnterpriseDecisions('t1'), /^\/api\/enterprise\/t1\/decisions$/],
    ['getEnterpriseKeeperRequests', () => db.getEnterpriseKeeperRequests('t1'), /^\/api\/enterprise\/t1\/keepers\/requests$/],
    ['getEnterpriseLedger', () => db.getEnterpriseLedger('t1'), /^\/api\/enterprise\/t1\/ledger$/],
    ['getTreasuryPledges', () => db.getTreasuryPledges('t1'), /^\/api\/treasury\/t1\/pledges$/],
    ['getTreasuries (unsigned)', () => db.getTreasuries(), /^\/api\/treasuries$/],
    ['getDealsFor', () => db.getDealsFor(h.me.publicKey), /^\/api\/marketplace\/transactions$/],
    ['getDecisions', () => db.getDecisions(), /^\/api\/commons\/decisions$/],
    ['getDecisions: the unsigned read after a 401', () => db.getDecisions(), /^\/api\/commons\/decisions$/, () => { node.signedOnly = true; }],
    ['getDecisionJury', () => db.getDecisionJury('d1'), /^\/api\/commons\/decisions\/d1\/jury$/],
    ['getEventChat', () => db.getEventChat('p1'), /^\/api\/marketplace\/posts\/p1\/chat$/],
    ['getPollOtherAnswers', () => db.getPollOtherAnswers('p1'), /^\/api\/marketplace\/posts\/p1\/other-answers$/],
    ['fetchEventZones', () => db.fetchEventZones(), /^\/api\/events\/zones$/],
    ['fetchMyEvents', () => db.fetchMyEvents(), /^\/api\/events\/mine$/],
    ['getBills', () => db.getBills(), /^\/api\/bills$/],
    ['getMemberRatings', () => db.getMemberRatings(PEER), /^\/api\/ratings\/pk-peer$/],
    ['getRatingsGiven', () => db.getRatingsGiven(h.me.publicKey), /^\/api\/ratings\/pk-me$/],
    ['fetchAddedYou', () => db.fetchAddedYou(), /^\/api\/friends\/added-you$/],
    ['fetchFriendsFromServer', () => db.fetchFriendsFromServer(h.me.publicKey), /^\/api\/friends\/pk-me$/],
    ['getInvitablePeople', () => db.getInvitablePeople(), /^\/api\/community\/members$/],
    ['getReachablePeers (unsigned, its own 10 s)', () => db.getReachablePeers(), /^\/api\/federation\/reachable-peers$/],
    ['signedRequestWithMethod GET (a forum read: its search)', () => db.signedRequestWithMethod('GET', '/api/forum/search?q=soil', undefined, { withStatus: true }), /^\/api\/forum\/search$/],
];
const HANGS: Hang[] = ['never answers', 'never ends the body'];
const CASES = ROWS.flatMap(([name, call, at, setUp]) => HANGS.map((hang) => [name, hang, call, at, setUp] as const));

describe('every list the phone reads with no budget of its own gives up at the backstop, on its answer and its body (#3309 re-check, triage 46)', () => {
    it.each(CASES)('%s, a server that %s: gives up at its deadline, and the sync lock is free', async (_name, hang, call, at, setUp) => {
        setUp?.();
        node.hung = at;
        node.hang = hang;
        const started = Date.now();
        const settled = call().then(() => Date.now() - started, () => Date.now() - started);
        const took = await Promise.race([settled, new Promise<'still waiting'>((r) => setTimeout(() => r('still waiting'), STILL_WAITING_MS))]);
        expect(node.asked.some((p) => at.test(p)), 'the read asked the server it waits on').toBe(true);
        expect(took, 'settled').not.toBe('still waiting');
        // Ended by its deadline: not before it, so no other failure ended it.
        expect(took as number).toBeGreaterThanOrEqual(DEADLINE_MS - 5);
        expect(db._syncLockHeldForTests(), 'the sync lock').toBe(false);
    });

    it('control: an answer inside the deadline is read as before', async () => {
        db._setReadDeadlineForTests(5_000);
        fetchMock.mockImplementationOnce(async (url: string) => {
            node.asked.push(new URL(url).pathname);
            await new Promise((r) => setTimeout(r, 40));
            return answer(200, [{ id: 'g1', name: 'Garden', slug: 'garden', createdBy: PEER, createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z', memberCount: 2 }]);
        });
        const groups = await db.fetchGroups();
        expect(groups.map((g) => g.id)).toEqual(['g1']);
    });

    it('a read the backstop ends says the words for no answer, never a raw "timed out" (#3376 max review N4)', async () => {
        node.hung = /^\/api\/groups\/g1\/chat$/;
        const ended = await db.signedGet('/api/groups/g1/chat?limit=1').then(() => null, (e: any) => e?.message);
        expect(ended).toBe(NO_ANSWER);
    });

    // #3376 max review B1: a caller's own signal is its read's budget and the only one. The shortened deadline here (80 ms)
    // stands for the backstop: a read with its own signal answering after it is read, never cut by ours.
    it.each([
        ['signedGet', (signal: AbortSignal) => db.signedGet('/api/groups/g1/chat?limit=1', { signal }).then((r) => r.json())],
        ['signedRequestWithMethod GET', (signal: AbortSignal) => db.signedRequestWithMethod('GET', '/api/groups/g1/chat?limit=1', undefined, { withStatus: true, signal })],
    ] as const)('%s with the caller\'s own signal: no deadline of ours on it; an answer after the backstop\'s time is read', async (_name, read) => {
        fetchMock.mockImplementationOnce(async (url: string) => {
            node.asked.push(new URL(url).pathname);
            await new Promise((r) => setTimeout(r, DEADLINE_MS * 3));
            return answer(200, { messages: [{ id: 'm1' }] });
        });
        const body: any = await read(new AbortController().signal);
        expect(node.asked).toContain('/api/groups/g1/chat');
        expect(body?.messages?.map((m: any) => m.id)).toEqual(['m1']);
    });

    it('a caller\'s own abort is handed to the fetch as it is: the read ends then, as an AbortError', async () => {
        db._setReadDeadlineForTests(5_000);
        fetchMock.mockImplementationOnce(async (url: string, init: any) => {
            node.asked.push(new URL(url).pathname);
            return new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))));
        });
        const stop = new AbortController();
        const reading = db.signedGet('/api/groups/g1/chat?limit=1', { signal: stop.signal }).then(() => null, (e: any) => ({ name: e?.name }));
        setTimeout(() => stop.abort(), 30);
        expect((await reading)?.name).toBe('AbortError');
    });

    it('a busy network\'s 429 page that never ends is let go at the first ask\'s deadline (its copy\'s body is under it too): the one wait, then the one ask again', async () => {
        const page: any = { ok: false, status: 429, headers: { get: (k: string) => (k === 'Retry-After' ? '1' : null) }, json: never, text: never };
        page.clone = () => ({ ...page, clone: undefined });
        fetchMock.mockImplementationOnce(async (url: string) => { node.asked.push(new URL(url).pathname); return page; });
        const started = Date.now();
        const res = await db.signedGet('/api/groups/g1/chat?limit=1');
        const took = Date.now() - started;
        expect(res.status, 'the second ask\'s answer').toBe(404);
        expect(node.asked.filter((p) => p === '/api/groups/g1/chat').length).toBe(2);
        // The first ask's deadline (its copy's body), then the busy network's 1 s wait.
        expect(took).toBeGreaterThanOrEqual(DEADLINE_MS + 1_000 - 5);
    });
});

// ── 2. The real budgets, on a fake clock ─────────────────────────────────────────────────────────────────────────────

/**
 * `call` on a fake clock (setTimeout's), with the real budgets (the backstop's 60 s, core's 30 s, syncMessages' 10 s): one
 * shortened deadline for every read, as the table above sets, would hide a read cut by a budget that isn't its own. The
 * clock turns 250 ms at a time, with a real turn of the loop between (a dynamic import, the file system), until the call
 * settles, or throws past `capMs`. `tookMs`: the fake time it took.
 */
async function onFakeClock<T>(call: () => Promise<T>, capMs: number): Promise<{ value?: T; error?: unknown; tookMs: number }> {
    db._setReadDeadlineForTests(null);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
        const out: { done?: { value?: T; error?: unknown } } = {};
        call().then((value) => { out.done = { value }; }, (error) => { out.done = { error }; });
        let tookMs = 0;
        while (!out.done && tookMs < capMs) {
            await vi.advanceTimersByTimeAsync(250);
            tookMs += 250;
            await new Promise((r) => setImmediate(r));
        }
        if (!out.done) throw new Error(`still waiting after ${capMs} ms`);
        return { ...out.done, tookMs };
    } finally {
        vi.useRealTimers();
    }
}

/** A fake-clock wait of `ms`, then `then()`. */
const after = <T,>(ms: number, then: () => T) => new Promise<T>((r) => setTimeout(() => r(then()), ms));

/** What a fetch that gives up on its abort throws (React Native's does). */
const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });

/**
 * A node on the fake clock whose fetch gives up on its abort, as React Native's does: `routes` answers the paths it names
 * (by pathname), everything else at once (quick).
 */
function nodeOnFakeClock(routes: Record<string, () => Promise<any>>) {
    return vi.fn(async (url: string, init: any = {}) => {
        const u = new URL(url);
        node.asked.push(u.pathname);
        const signal: AbortSignal | undefined = init?.signal;
        if (signal?.aborted) throw abortError();
        const route = routes[u.pathname];
        const answered = route ? route() : Promise.resolve(quick(u.pathname));
        if (!signal) return answered;
        return new Promise((resolve, reject) => {
            const stop = () => reject(abortError());
            signal.addEventListener('abort', stop, { once: true });
            answered.then((v) => { signal.removeEventListener('abort', stop); resolve(v); }, reject);
        });
    });
}

/** A busy network's 429 (Cloudflare's page, not the node's JSON), naming a wait of `seconds`. */
function busyPage(seconds: number): any {
    const busy: any = { ok: false, status: 429, headers: { get: (k: string) => (k === 'Retry-After' ? String(seconds) : null) }, text: async () => '<html>error code: 1015</html>', json: async () => { throw new SyntaxError('not JSON'); } };
    busy.clone = () => ({ ...busy });
    return busy;
}

const GROUP = { id: 'g1', name: 'Garden', slug: 'garden', createdBy: PEER, createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z', memberCount: 2 };

describe('a read its caller bounds keeps that budget and no other; a whole list has the backstop\'s 60 s (#3376 max review B1, N1, N2)', () => {
    it('the backstop is 60 s, and a tool\'s copy has core\'s 30 s', () => {
        expect(db.LIST_READ_BACKSTOP_MS).toBe(60_000);
        expect(TOOL_COPY_ANSWER_MS).toBe(30_000);
    });

    it('a tool\'s copy (tools/node-copy\'s own read, under core\'s 30 s): the node answers at 15 s, and the copy is read', async () => {
        const { phoneToolNode } = await import('../../tools/node-copy');
        (globalThis as any).fetch = nodeOnFakeClock({ '/api/tools/garden-planner': () => after(15_000, () => answer(200, { doc: { beds: 3 } })) });
        const copy = phoneToolNode({ kind: 'member', publicKey: h.me.publicKey }, 'garden-planner', async () => true);
        const { value, error, tookMs } = await onFakeClock(() => copy.get(), 60_000);
        expect(error).toBeUndefined();
        expect(tookMs).toBeGreaterThanOrEqual(15_000);
        expect(value).toEqual({ status: 200, json: { doc: { beds: 3 } } });
    });

    it('a tool\'s copy the node never answers is let go at core\'s 30 s (no answer), not at the backstop', async () => {
        const { phoneToolNode } = await import('../../tools/node-copy');
        (globalThis as any).fetch = nodeOnFakeClock({ '/api/tools/garden-planner': never });
        const copy = phoneToolNode({ kind: 'member', publicKey: h.me.publicKey }, 'garden-planner', async () => true);
        // Settled before the backstop's 60 s could have ended it.
        const { value, tookMs } = await onFakeClock(() => copy.get(), 45_000);
        expect(node.asked).toContain('/api/tools/garden-planner');
        expect(tookMs).toBeGreaterThanOrEqual(TOOL_COPY_ANSWER_MS);
        expect(value).toBeNull();
    });

    it('a tool\'s deals and its Offer (tools/builder.ts: signedGet under core\'s withinAnswerTime): a page answered at 15 s is read', async () => {
        (globalThis as any).fetch = nodeOnFakeClock({ '/api/marketplace/transactions': () => after(15_000, () => answer(200, [{ id: 'deal-1' }])) });
        const { value, error, tookMs } = await onFakeClock(() => withinAnswerTime(async (signal) => {
            const res = await db.signedGet('/api/marketplace/transactions?publicKey=pk-me&limit=200&offset=0', { signal });
            return res.json();
        }), 60_000);
        expect(error).toBeUndefined();
        expect(tookMs).toBeGreaterThanOrEqual(15_000);
        expect(value).toEqual([{ id: 'deal-1' }]);
    });

    it('syncMessages: a busy network\'s 20 s wait on the chat list is still cut at the list\'s own 10 s, as before (false)', async () => {
        (globalThis as any).fetch = nodeOnFakeClock({ [`/api/messages/conversations/${h.me.publicKey}`]: async () => busyPage(20) });
        // Settled before the 20 s wait ended: the list's own budget cut it.
        const { value, error, tookMs } = await onFakeClock(() => db.syncMessages(h.me.publicKey), 18_000);
        expect(error).toBeUndefined();
        expect(node.asked).toContain(`/api/messages/conversations/${h.me.publicKey}`);
        expect(tookMs).toBeGreaterThanOrEqual(10_000);
        expect(value, 'the read worked').toBe(false);
        expect(node.asked, 'no chat\'s page asked on a list not read').not.toContain('/api/messages/chat-1');
        expect(db._syncLockHeldForTests(), 'the sync lock').toBe(false);
    });

    // #3376 max review N1: whole lists that had no deadline at all. Each answers at 15 s, past the 12 s they were given.
    const WHOLE_LISTS: Array<[string, string, () => Promise<any>, (v: any) => void]> = [
        ['a treasury\'s ledger, the "All" period (every entry since the start, no paging)', '/api/enterprise/t1/ledger', () => db.getEnterpriseLedger('t1'), (v) => expect(v?.entries?.map((e: any) => e.id)).toEqual(['e1'])],
        ['fetchGroups', '/api/groups', () => db.fetchGroups(), (v) => expect(v.map((g: any) => g.id)).toEqual(['g1'])],
        ['getInvitablePeople', '/api/community/members', () => db.getInvitablePeople(), (v) => expect(v.map((p: any) => p.publicKey)).toEqual([PEER])],
        ['a forum read (signedRequestWithMethod GET)', '/api/forum/search', () => db.signedRequestWithMethod('GET', '/api/forum/search?q=soil', undefined, { withStatus: true }), (v) => expect(v?.topics?.map((t: any) => t.id)).toEqual(['f1'])],
        ['fetchGroupDetails\' roster (the group at once)', '/api/groups/g1/members', () => db.fetchGroupDetails('g1'), (v) => expect(v?.members?.map((m: any) => m.publicKey)).toEqual([PEER])],
    ];
    const WHOLE_LIST_BODIES: Record<string, unknown> = {
        '/api/enterprise/t1/ledger': { entries: [{ id: 'e1' }] },
        '/api/groups': [GROUP],
        '/api/community/members': [{ publicKey: PEER, callsign: 'Rhea', status: 'active' }],
        '/api/forum/search': { topics: [{ id: 'f1' }] },
        '/api/groups/g1/members': [{ publicKey: PEER, role: 'member', status: 'active' }],
    };
    it.each(WHOLE_LISTS)('a whole list answering at 15 s is read: %s', async (_name, at, call, check) => {
        (globalThis as any).fetch = nodeOnFakeClock({
            [at]: () => after(15_000, () => answer(200, WHOLE_LIST_BODIES[at])),
            '/api/groups/g1': async () => answer(200, GROUP),
        });
        const { value, error, tookMs } = await onFakeClock(call, 120_000);
        expect(error).toBeUndefined();
        expect(node.asked).toContain(at);
        expect(tookMs).toBeGreaterThanOrEqual(15_000);
        check(value);
    });

    it('a ledger the network never answers is let go at the backstop, not before, with the words the screen shows for no answer', async () => {
        (globalThis as any).fetch = nodeOnFakeClock({ '/api/enterprise/t1/ledger': never });
        const { error, tookMs } = await onFakeClock(() => db.getEnterpriseLedger('t1'), 120_000);
        expect(tookMs).toBeGreaterThanOrEqual(db.LIST_READ_BACKSTOP_MS);
        expect((error as Error)?.message).toBe(NO_ANSWER);
    });

    it('fetchGroupDetails: a roster that never answers is let go at the backstop, and the card still shows without it (members null)', async () => {
        (globalThis as any).fetch = nodeOnFakeClock({ '/api/groups/g1': async () => answer(200, GROUP), '/api/groups/g1/members': never });
        const { value, error, tookMs } = await onFakeClock(() => db.fetchGroupDetails('g1'), 120_000);
        expect(error).toBeUndefined();
        expect(node.asked).toContain('/api/groups/g1/members');
        expect(tookMs).toBeGreaterThanOrEqual(db.LIST_READ_BACKSTOP_MS);
        expect((value as any)?.group?.name).toBe('Garden');
        expect((value as any)?.members).toBeNull();
        expect((value as any)?.rosterRefused).toBe(false);
    });

    it('fetchGroupDetails: a busy network\'s wait and a slow second ask on the group\'s read never cost the roster, read at once, its body', async () => {
        let groupAsks = 0;
        (globalThis as any).fetch = nodeOnFakeClock({
            // A 20 s wait, then a second ask answered at 45 s: 65 s in all, past the roster's 60 s.
            '/api/groups/g1': async () => (++groupAsks === 1 ? busyPage(20) : after(45_000, () => answer(200, GROUP))),
            '/api/groups/g1/members': async () => answer(200, [{ publicKey: PEER, role: 'member' }]),
        });
        const { value, error, tookMs } = await onFakeClock(() => db.fetchGroupDetails('g1'), 120_000);
        expect(error).toBeUndefined();
        // The wait and the second ask happened (the row is not vacuous): past the roster's 60 s.
        expect(groupAsks).toBe(2);
        expect(tookMs).toBeGreaterThanOrEqual(65_000);
        expect((value as any)?.group?.name).toBe('Garden');
        expect((value as any)?.members?.map((m: any) => m.publicKey)).toEqual([PEER]);
    });
});

// ── 3. The class, in the source ──────────────────────────────────────────────────────────────────────────────────────

describe('the class, in utils/db.ts: no read the phone makes there is left without a deadline', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'db.ts'), 'utf8');
    const lines = source.split('\n');
    /** Each call's text from its line to its closing paren (enough to read its options). */
    const callAt = (i: number) => lines.slice(i, i + 12).join('\n');

    it('signedGet leaves a read its caller bounds to that budget, and puts each other ask under readWithDeadline, but one asked with no deadline', () => {
        const body = source.slice(source.indexOf('export async function signedGet('), source.indexOf('export const LIST_READ_BACKSTOP_MS'));
        expect(body).toContain('deadlineMs === null || (deadlineMs === undefined && signal) ? ask(signal) : readWithDeadline(ask, { signal, deadlineMs });');
        expect(body.match(/\bask\(/g)?.length, 'ask is called only through once').toBe(1);
        expect(body.match(/\bonce\(options\?\.signal\)/g)?.length).toBe(2);
    });

    it('each answer\'s body is read before any other read is asked (#3376 decide): a read\'s deadline never runs on through another\'s', () => {
        const isRead = (l: string) => /\b(signedGet|readWithDeadline)\(/.test(l) && !/^\s*(\/\/|\*)/.test(l) && !/function (signedGet|readWithDeadline)\(/.test(l);
        const across: string[] = [];
        let answers = 0;
        lines.forEach((l, i) => {
            const m = l.match(/(\w+)\s*=\s*await\s+(?:untilAborted\()?(?:signedGet|readWithDeadline)\(/);
            if (!m) return;
            answers++;
            // Under its caller's own timer (a controller's signal): no deadline of ours runs on its body (syncMessages,
            // a chat's poll, as on main; React Native's fetch hands the answer over with its whole body).
            if (/\bsignal:\s*\w+\.signal\b/.test(callAt(i).split(';')[0])) return;
            const body = new RegExp(`\\b${m[1]}\\b\\s*\\??\\.\\s*(json|text|arrayBuffer|blob|clone)\\(`);
            // The answer dropped for another in its place (getDecisions' unsigned read after a 401): its body is never read.
            const replaced = new RegExp(`(^|[^.\\w])${m[1]}\\s*=\\s*await\\s+(signedGet|readWithDeadline)\\(`);
            for (let j = i + 1; j < Math.min(lines.length, i + 80) && !/^(export )?(async )?function /.test(lines[j]); j++) {
                if (body.test(lines[j]) || replaced.test(lines[j])) break;
                if (isRead(lines[j])) { across.push(`${i + 1} (${m[1]}) waits on ${j + 1}: ${lines[j].trim()}`); break; }
            }
        });
        expect(answers, 'the answers this reads (not vacuous)').toBeGreaterThan(40);
        expect(across).toEqual([]);
        // Reads asked together (fetchGroupDetails): each one's body in its own .then, never after the others are in.
        /** The array handed to Promise.all, to its own closing bracket. */
        const handed = (rest: string) => {
            let depth = 1;
            for (let k = 0; k < rest.length; k++) {
                if (rest[k] === '[') depth++;
                else if (rest[k] === ']' && --depth === 0) return rest.slice(0, k);
            }
            return rest;
        };
        const together = source.split('Promise.all([').slice(1).map(handed).filter((b) => /\bsignedGet\(/.test(b));
        expect(together.length, 'fetchGroupDetails asks its two reads together (not vacuous)').toBeGreaterThanOrEqual(1);
        for (const block of together) {
            for (const ask of block.split(/\bsignedGet\(/).slice(1)) {
                expect(ask, 'a read asked together reads its body in its own .then').toMatch(/\.then\(async \(res\) =>[\s\S]*\bres\.json\(/);
            }
        }
    });

    it('only a photo\'s or a voice line\'s bytes are read with no deadline', () => {
        const noDeadline = lines.map((l, i) => [l, i] as const).filter(([l]) => /deadlineMs:\s*(null|ATTACHMENT_NO_DEADLINE)/.test(l));
        expect(noDeadline.length).toBe(3);
        for (const [l] of noDeadline) expect(l).toMatch(/\/attachment`/);
    });

    it('every other fetch is under readWithDeadline, a write, or one named read of a single thing', () => {
        /** Reads of one thing, not a list, each under its own budget or none, as before this slice. */
        const SINGLE_READS = [
            '/api/marketplace/posts?id=', // one listing, by id
            '/api/ledger/balance/', // one balance
            '/api/invite/check?code=', // one invite code (its own 10 s controller)
        ];
        const loose: string[] = [];
        lines.forEach((l, i) => {
            if (!/(^|[^.\w])fetch\(/.test(l) || /readWithDeadline\(\(signal\) => fetch\(/.test(l) || /^\s*(\/\/|\*)/.test(l)) return;
            const call = callAt(i);
            if (/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/.test(call)) return;
            // A write whose method is named by its caller (an event date's skip, POST or DELETE): it sends a body.
            if (/\n\s*method,\n[\s\S]*?\bbody: bodyString,\n/.test(call)) return;
            // signedRequestWithMethod's ask: a write, a GET its caller bounds with its own signal, or a GET under the backstop.
            if (/const ask = \(signal: AbortSignal \| undefined\) => fetch\(`\$\{anchorUrl\}\$\{endpoint\}`/.test(l)
                && source.includes("const res = method === 'GET' && !opts?.signal ? await readWithDeadline(ask) : await ask(opts?.signal);")) return;
            if (/fetch\(`\$\{anchorUrl\}\$\{path\}`, \{\n\s*method: 'GET',/.test(call)) return; // signedGet's own ask
            if (SINGLE_READS.some((p) => l.includes(p))) return;
            // The callsign read: one name, its 8 s controller cleared only after the body was read.
            if (/const res = await fetch\(url, \{/.test(l) && /signal: controller\.signal/.test(call) && source.includes('callsign')) return;
            loose.push(`${i + 1}: ${l.trim()}`);
        });
        expect(loose).toEqual([]);
    });
});

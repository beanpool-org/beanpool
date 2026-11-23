/**
 * Every list the phone reads from a node gives up at its deadline, on the answer AND on the answer's body (#3309 max
 * re-check, triage 46; the in-place request list's 12 s deadline, requests-in-place-wrong-file.test.ts, as the model).
 * React Native's fetch never gives up by itself: syncMessages cleared its 10 s timer once the headers came, then read the
 * body with no deadline, and fetchGroups asked with no signal at all, so a server that went quiet held the read, and the
 * caller waiting on it, for good.
 *
 * One table (close the class): each list read in utils/db.ts x a server that never answers, and one that answers its
 * headers and never ends the body. Each row asserts that the read asked that server (the row is not vacuous), that it
 * settled at its deadline (not before, so it was the deadline that ended it, and not left waiting), and that the sync
 * lock is free after. The fetch here ignores its abort signal, as a fetch that never gives up does. Then the class's
 * guard over the source: every read through signedGet is under the deadline (only a photo's or a voice line's bytes ask
 * for none), and every other fetch db.ts makes is under readWithDeadline, a write, or one named read of a single thing.
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
/** Every read's deadline here (each one's own, 10 s, 5 s or 12 s, scaled to it). */
const DEADLINE_MS = 80;
/** How long a row waits for a read that should have given up at DEADLINE_MS before it calls it hung. */
const STILL_WAITING_MS = 3_000;

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

// ── The table ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** [the read, the call, the path it reads that the node holds up, set-up]. */
type Row = [string, () => Promise<unknown>, RegExp, (() => void)?];
const ROWS: Row[] = [
    ['syncMessages: the chat list', () => db.syncMessages(h.me.publicKey), /^\/api\/messages\/conversations\/pk-me$/],
    ['syncMessages: a chat\'s page', () => db.syncMessages(h.me.publicKey), /^\/api\/messages\/chat-1$/],
    ['syncMessages: the whole members\' directory', () => db.syncMessages(h.me.publicKey), /^\/api\/members$/, () => { h.profile = { features: {} }; }],
    ['syncSingleConversation: the chat\'s page', () => db.syncSingleConversation('chat-1'), /^\/api\/messages\/chat-1$/],
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
    ['getReachablePeers (unsigned)', () => db.getReachablePeers(), /^\/api\/federation\/reachable-peers$/],
    ['signedRequestWithMethod GET (the forum\'s search)', () => db.signedRequestWithMethod('GET', '/api/forum/search?q=soil', undefined, { withStatus: true }), /^\/api\/forum\/search$/],
];
const HANGS: Hang[] = ['never answers', 'never ends the body'];
const CASES = ROWS.flatMap(([name, call, at, setUp]) => HANGS.map((hang) => [name, hang, call, at, setUp] as const));

describe('every list the phone reads gives up at its deadline, on its answer and its body (#3309 re-check, triage 46)', () => {
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

    it('a chat\'s poll held up by a body that never ends lets go of its turn: the next poll asks again (syncSingleConversation)', async () => {
        node.hung = /^\/api\/messages\/chat-1$/;
        node.hang = 'never ends the body';
        await db.syncSingleConversation('chat-1');
        const asks = () => node.asked.filter((p) => p === '/api/messages/chat-1').length;
        expect(asks()).toBe(1);
        await db.syncSingleConversation('chat-1');
        expect(asks()).toBe(2);
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

    it('a caller\'s own abort still ends the read at once, long before its deadline, as an AbortError', async () => {
        node.hung = /^\/api\/groups\/g1\/chat$/;
        const stop = new AbortController();
        db._setReadDeadlineForTests(5_000);
        const reading = db.signedGet('/api/groups/g1/chat?limit=1', { signal: stop.signal }).then(() => null, (e: any) => ({ name: e?.name }));
        setTimeout(() => stop.abort(), 30);
        const ended = await reading;
        // An AbortError, never the deadline's "timed out": the caller's abort ended it, not its 5 s.
        expect(ended?.name).toBe('AbortError');
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

// ── The class, in the source ──────────────────────────────────────────────────────────────────────────────────────────

describe('the class, in utils/db.ts: no read the phone makes there is left without a deadline', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'db.ts'), 'utf8');
    const lines = source.split('\n');
    /** Each call's text from its line to its closing paren (enough to read its options). */
    const callAt = (i: number) => lines.slice(i, i + 12).join('\n');

    it('signedGet puts each ask under readWithDeadline, but one asked with no deadline', () => {
        const body = source.slice(source.indexOf('export async function signedGet('), source.indexOf('export const READ_DEADLINE_MS'));
        expect(body).toContain('options?.deadlineMs === null ? ask(signal) : readWithDeadline(ask, { signal, deadlineMs: options?.deadlineMs });');
        expect(body.match(/\bask\(/g)?.length, 'ask is called only through once').toBe(1);
        expect(body.match(/\bonce\(options\?\.signal\)/g)?.length).toBe(2);
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
            // signedRequestWithMethod's ask: a write, or a GET (the forum's search) asked under readWithDeadline.
            if (/const ask = \(signal: AbortSignal \| undefined\) => fetch\(`\$\{anchorUrl\}\$\{endpoint\}`/.test(l)
                && source.includes("const res = method === 'GET' ? await readWithDeadline(ask, { signal: opts?.signal }) : await ask(opts?.signal);")) return;
            if (/fetch\(`\$\{anchorUrl\}\$\{path\}`, \{\n\s*method: 'GET',/.test(call)) return; // signedGet's own ask
            if (SINGLE_READS.some((p) => l.includes(p))) return;
            // The callsign read: one name, its 8 s controller cleared only after the body was read.
            if (/const res = await fetch\(url, \{/.test(l) && /signal: controller\.signal/.test(call) && source.includes('callsign')) return;
            loose.push(`${i + 1}: ${l.trim()}`);
        });
        expect(loose).toEqual([]);
    });
});

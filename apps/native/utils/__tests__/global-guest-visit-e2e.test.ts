/**
 * Guest view first (utils/global-guest-visit.ts; Marty, board 21 Oct 2026) against a REAL global-profile node on this
 * machine: apps/server/src/phone-door-test-harness.ts (the real HTTPS server, signature middleware, membership probe,
 * posts route with its visitors' view, and the door), started from the packages' sources and killed by its PID, as
 * utils/__tests__/global-entry-e2e.test.ts does. The phone is its own code: the visit with its real dependencies (the door
 * check, the probe, the guest mark, the saved list, the switch into its own copy), performSync writing the real schema
 * into an in-memory SQLite, and the door's 12-words join with the key on the phone.
 *
 *   1. A member of a local community (Riverside, never contacted) taps the global row: the node is asked (door, then the
 *      probe, signed), says stranger, and the phone is on it as a guest: marked before it moved, in the saved list. The
 *      key stored on the phone is byte for byte what it was, and the node holds no member, no join and no account for it:
 *      looking makes nothing.
 *   2. The guest's sync: the node sends the visitors' view of the listings (no author), and the phone keeps it (a guest
 *      expects it, posts-view.ts). The guest view is what it says it is.
 *   3. Join from there (the header's Join pill → People → the door): the SAME key joins through the door, the phone's key
 *      unchanged, and the door's entry clears the guest mark.
 *   4. The member's first sync after that writes the member's view over every row the guest kept (it is a whole read by
 *      area), so a member who looked first never keeps listings without their people.
 *
 * Nothing else is contacted: the phone's fetch is held to this node's address and throws for anything else.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import Module from 'node:module';

(globalThis as any).__DEV__ = false;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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

const mem = vi.hoisted(() => ({ async: new Map<string, string>(), secure: new Map<string, string>() }));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(async () => adapter) }));
vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
}));
vi.mock('expo-linking', () => ({ addEventListener: vi.fn(() => ({ remove: vi.fn() })), openURL: vi.fn(async () => undefined) }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn(), openBrowserAsync: vi.fn(), dismissAuthSession: vi.fn(), dismissBrowser: vi.fn(async () => undefined) }));
vi.mock('expo-apple-authentication', () => ({ isAvailableAsync: vi.fn(async () => false), signInAsync: vi.fn(), AppleAuthenticationScope: { EMAIL: 0, FULL_NAME: 1 } }));
vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))),
    randomUUID: vi.fn(() => randomUUID()),
    digest: vi.fn(async (_algorithm: string, data: Uint8Array) => {
        const out = createHash('sha256').update(data).digest();
        return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    }),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.async.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.async.set(k, String(v)); }),
        removeItem: vi.fn(async (k: string) => { mem.async.delete(k); }),
        getAllKeys: vi.fn(async () => [...mem.async.keys()]),
        multiRemove: vi.fn(async (ks: string[]) => { for (const k of ks) mem.async.delete(k); }),
        multiGet: vi.fn(async (ks: string[]) => ks.map(k => [k, mem.async.get(k) ?? null])),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => mem.secure.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { mem.secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { mem.secure.delete(key); }),
}));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/',
    getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    makeDirectoryAsync: vi.fn().mockResolvedValue(undefined),
    writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));

import { createIdentity, loadIdentity, type BeanPoolIdentity } from '../identity';
import { buildSignedHeaders } from '../crypto';
import { closeDB, initDB } from '../db';
import { visitGlobalAsGuest } from '../global-guest-visit';
import { accountKeyForDoor, enterOpenDoorCommunity } from '../global-join-existing';
import { checkNameAtDoor, submitWordsJoin } from '../global-join';
import { startDoorWork, type DoorWorkRun } from '../door-work';
import { addSavedNode, clearGuestNode } from '../nodes';
import { SAVED_NODES_STORE_KEY } from '../storage-keys';
import { performSync, resetSyncFingerprints } from '../../services/pillar-sync';
import { noVault } from './fake-vault';

const SERVER_DIR = fileURLToPath(new URL('../../../server/', import.meta.url).href);
const START_MS = 120_000;
const STEP_MS = 120_000;
const RIVERSIDE = 'https://riverside.example';
const ANCHOR = 'beanpool_anchor_url';
const GUESTS = 'beanpool_guest_nodes';

let node: ChildProcessWithoutNullStreams;
let dataDir: string;
let URL_BASE = '';
const replies = new Map<number, (r: { result?: any; error?: string }) => void>();
let nextId = 1;
const realFetch = globalThis.fetch;
const sent: { method: string; path: string; status: number; signed: boolean }[] = [];
const elsewhere: string[] = [];
const runs: DoorWorkRun[] = [];
let me: BeanPoolIdentity | null = null;
const AUTHOR = randomBytes(32).toString('hex');

function control<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        replies.set(id, (r) => (r.error ? reject(new Error(r.error)) : resolve(r.result as T)));
        node.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
}

/** A sync cycle, as the app runs one (react-native's emitter loaded by require inside the sync, stubbed). */
async function sync() {
    const nodeLoad = (Module as any)._load;
    (Module as any)._load = function (request: string, ...rest: unknown[]) {
        return request === 'react-native' ? { DeviceEventEmitter: { emit: () => {} } } : nodeLoad.call(this, request, ...rest);
    };
    try {
        return await performSync();
    } finally {
        (Module as any)._load = nodeLoad;
    }
}

beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'global-guest-visit-e2e-'));
    node = spawn(process.execPath, ['--import', 'tsx', 'src/phone-door-test-harness.ts'], {
        cwd: SERVER_DIR,
        env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, TSX_TSCONFIG_PATH: 'tsconfig.phone-door-test-harness.json' },
        stdio: 'pipe',
    });
    let out = '';
    let log = '';
    const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the test node did not start in time:\n${log.slice(-3000)}`)), START_MS - 5_000);
        node.stdout.on('data', (chunk: Buffer) => {
            out += chunk.toString();
            log += chunk.toString();
            let nl: number;
            while ((nl = out.indexOf('\n')) >= 0) {
                const line = out.slice(0, nl);
                out = out.slice(nl + 1);
                const started = /^PHONE-DOOR-NODE-PORT (\d+)$/.exec(line);
                if (started) { clearTimeout(timer); resolve(Number(started[1])); }
                const reply = /^PHONE-DOOR-NODE-REPLY (.*)$/.exec(line);
                if (reply) {
                    const r = JSON.parse(reply[1]) as { id: number; result?: unknown; error?: string };
                    replies.get(r.id)?.(r);
                    replies.delete(r.id);
                }
            }
        });
        node.stderr.on('data', (chunk: Buffer) => { log += chunk.toString(); });
        node.on('exit', (code) => reject(new Error(`the test node exited (${code}):\n${log.slice(-3000)}`)));
    });
    URL_BASE = `https://127.0.0.1:${port}`;

    // The phone reaches this node and nothing else. Its GETs to the community it is ON are signed with its key, as the app's
    // request signing does (utils/node-request-signing.ts); a request that signs itself (the probe, the door) goes as it is.
    globalThis.fetch = (async (input: any, init?: any) => {
        const href = String(input instanceof Request ? input.url : input);
        if (!href.startsWith(`${URL_BASE}/`)) {
            elsewhere.push(href);
            throw new TypeError(`Network request failed: the phone contacted ${href}`);
        }
        const method = String(init?.method ?? 'GET').toUpperCase();
        const headers: Record<string, string> = { ...(init?.headers ?? {}) };
        const signedItself = Object.keys(headers).some(h => /signature/i.test(h));
        const onIt = mem.async.get(ANCHOR) === URL_BASE;
        if (method === 'GET' && me && onIt && !signedItself) {
            Object.assign(headers, await buildSignedHeaders('GET', href, '', me.privateKey, me.publicKey));
        }
        const { signal: _drop, ...rest } = init ?? {};
        const res = await realFetch(href, { ...rest, method, headers });
        sent.push({ method, path: new URL(href).pathname, status: res.status, signed: Object.keys(headers).some(h => /signature/i.test(h)) });
        return res;
    }) as typeof fetch;

    await control('limiters');
    // A member of the global community with three listings, listed a day ago.
    await control('join', { key: AUTHOR, callsign: 'Author' });
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    await control('listings', { rows: ['g-1', 'g-2', 'g-3'].map((id, i) => ({ id, author: AUTHOR, at: dayAgo, lat: -28.6 + i * 0.01, lng: 153.6 })) });
}, START_MS);

afterAll(async () => {
    for (const run of runs) run.cancel();
    globalThis.fetch = realFetch;
    if (node && node.exitCode === null) {
        node.stdin.write(`${JSON.stringify({ id: 0, cmd: 'quit' })}\n`);
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => { node.kill('SIGKILL'); resolve(); }, 5_000);
            node.on('exit', () => { clearTimeout(timer); resolve(); });
        });
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    expect(elsewhere).toEqual([]);
}, START_MS);

let keyBefore: Map<string, string>;
const authorsOnPhone = () => (sql.prepare("SELECT id, author_pubkey FROM posts WHERE id LIKE 'g-%' ORDER BY id").all() as { id: string; author_pubkey: string }[]);

describe('guest view first, against a real global-profile node', () => {
    it('1. the global row\'s tap: asked first, a stranger, on it as a guest (marked before it moved); the key untouched, the node holds nothing for it', async () => {
        noVault();
        mem.async.clear();
        mem.secure.clear();
        me = await createIdentity('Damo');
        keyBefore = new Map(mem.secure);
        mem.async.set(ANCHOR, RIVERSIDE);
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: RIVERSIDE, alias: 'Riverside', lastConnected: '2026-10-01T00:00:00.000Z' }]));
        // Riverside's copy is the one open, as on the phone before the tap.
        await initDB();
        sent.length = 0;

        const answer = await visitGlobalAsGuest({ publicKey: me.publicKey, privateKey: me.privateKey }, URL_BASE);
        expect(answer).toEqual({ kind: 'guest' });
        // The door was asked first, unsigned; then the probe, signed by the key; nothing else, and nothing sent to change anything.
        expect(sent.map(s => `${s.method} ${s.path} ${s.status}${s.signed ? ' signed' : ''}`)).toEqual([
            'GET /api/community/info 200',
            `GET /api/community/membership/${me.publicKey} 200 signed`,
        ]);
        // On it as a guest: in use, marked, saved; Riverside still in the list.
        expect(mem.async.get(ANCHOR)).toBe(URL_BASE);
        expect(JSON.parse(mem.async.get(GUESTS) ?? '[]')).toEqual([URL_BASE]);
        expect(JSON.parse(mem.async.get(SAVED_NODES_STORE_KEY) ?? '[]').map((n: { url: string }) => n.url)).toEqual([RIVERSIDE, URL_BASE]);
        // No key made, replaced or removed: the phone's key store is exactly as it was, and it is the same account.
        expect(new Map(mem.secure)).toEqual(keyBefore);
        expect((await loadIdentity())?.publicKey).toBe(me.publicKey);
        // Looking made nothing on the node: no member, no join, no account.
        expect((await control('member', { key: me.publicKey })).member ?? null).toBeNull();
        const [accounts] = await control<any[]>('sql', { sql: 'SELECT COUNT(*) AS n FROM accounts WHERE public_key = ?', params: [me.publicKey], all: true });
        expect(accounts.n).toBe(0);
    }, STEP_MS);

    it('2. the guest\'s sync: the node sends the visitors\' view (no author), and the phone keeps it', async () => {
        resetSyncFingerprints();
        sent.length = 0;
        await sync();
        const reads = sent.filter(s => s.path === '/api/marketplace/posts');
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.every(r => r.status === 200 && r.signed)).toBe(true);
        // The listings, each without the person (G9a): the guest view is what it says it is.
        expect(authorsOnPhone()).toEqual([
            { id: 'g-1', author_pubkey: 'hidden' }, { id: 'g-2', author_pubkey: 'hidden' }, { id: 'g-3', author_pubkey: 'hidden' },
        ]);
        expect(new Map(mem.secure)).toEqual(keyBefore);
    }, STEP_MS);

    it('3. Join from the guest view: the SAME key joins through the door, and the door\'s entry clears the guest mark', async () => {
        await control('limiters');
        const account = await accountKeyForDoor();
        expect(account?.identity.publicKey).toBe(me!.publicKey);
        expect(account?.createdHere).toBe(false);
        const run = startDoorWork({ url: URL_BASE, identity: account!.identity, door: 'words' });
        runs.push(run);
        expect(await checkNameAtDoor(URL_BASE, 'Damo', account!)).toEqual({ kind: 'free' });
        expect((await run.solution()).kind).toBe('solved');
        expect(await submitWordsJoin(URL_BASE, account!.identity, 'Damo', run)).toMatchObject({ kind: 'joined', callsign: 'Damo' });
        expect((await control('member', { key: me!.publicKey })).member).toMatchObject({ status: 'active', callsign: 'Damo' });

        // The door's entry, as join-open-door.tsx runs it after a join (its own sync left to the next cycle here).
        await enterOpenDoorCommunity(URL_BASE, undefined, { closeDB, initDB, addSavedNode, clearGuestNode, requestSync: async () => ({}) as any });
        expect(JSON.parse(mem.async.get(GUESTS) ?? '[]')).toEqual([]);
        expect(mem.async.get(ANCHOR)).toBe(URL_BASE);
        expect(new Map(mem.secure)).toEqual(keyBefore);
        expect((await loadIdentity())?.publicKey).toBe(me!.publicKey);
    }, STEP_MS);

    it('4. the member\'s first sync after it: the member\'s view over the guest\'s rows (a whole read by area), never the guest\'s left behind', async () => {
        // The cursor the guest's sync left is still there: this is the app's next cycle, nothing reset by hand.
        expect([...mem.async.keys()].some(k => k.startsWith('pillar_sync_') && k.endsWith('_last-sync'))).toBe(true);
        sent.length = 0;
        await sync();
        const reads = sent.filter(s => s.path === '/api/marketplace/posts');
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.every(r => r.status === 200 && r.signed)).toBe(true);
        expect(authorsOnPhone()).toEqual([
            { id: 'g-1', author_pubkey: AUTHOR }, { id: 'g-2', author_pubkey: AUTHOR }, { id: 'g-3', author_pubkey: AUTHOR },
        ]);
    }, STEP_MS);
});

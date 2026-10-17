/**
 * Global entry P1 against a REAL global-profile node on this machine (DESIGN-global-entry-fable.md §F, P1 row): the phone's
 * own code for the not-recognised screen and the global standing rule, measured against
 * apps/server/src/phone-door-test-harness.ts (the real HTTPS server, signature middleware, membership probe and door
 * routes), started from the packages' sources and killed by its PID, as utils/__tests__/global-door-e2e.test.ts does.
 *
 *   1. Damo's case. A member of a local community (Riverside, never contacted here) holds a key the global-profile node
 *      has never seen. Reconnect to that node: it is asked first (askBeforeSwitch), answers "stranger", and NOTHING moves:
 *      the phone's community and its saved list read back from AsyncStorage exactly as before. The node's own profile
 *      makes the page `open` (mismatchPlan); the one rule says `join` (global-entry.ts), from the node's probe, with the
 *      saved list never consulted.
 *   2. Join with this account lands as the SAME key: the door is the 12-words way with the key on the phone (join-global.tsx's
 *      path: accountKeyForDoor, the signed name check, the door's work, the join). The node keeps a member under that very
 *      key; the phone's stored key is unchanged; the probe now says member, and the rule says `member`.
 *   3. A refusing node of the other kind: a moderator closes that account. Reconnect is answered 403 `account_closed`, read
 *      as a definite answer (the closed page), and again nothing moves.
 *
 * Nothing else is contacted: the phone's fetch is held to this node's address and throws for anything else.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

(globalThis as any).__DEV__ = false;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
}));
vi.mock('expo-linking', () => ({ addEventListener: vi.fn(() => ({ remove: vi.fn() })), openURL: vi.fn(async () => undefined) }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn(), openBrowserAsync: vi.fn(), dismissAuthSession: vi.fn(), dismissBrowser: vi.fn(async () => undefined) }));
vi.mock('expo-apple-authentication', () => ({ isAvailableAsync: vi.fn(async () => false), signInAsync: vi.fn(), AppleAuthenticationScope: { EMAIL: 0, FULL_NAME: 1 } }));
vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))),
    digest: vi.fn(async (_algorithm: string, data: Uint8Array) => {
        const out = createHash('sha256').update(data).digest();
        return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    }),
}));
const mem = vi.hoisted(() => ({ async: new Map<string, string>(), secure: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.async.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => mem.secure.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { mem.secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { mem.secure.delete(key); }),
}));
// The phone's database is never opened here: a switch would load it, and this test proves there is none.
const switched = vi.hoisted(() => ({ db: 0 }));
vi.mock('../db', () => ({
    closeDB: vi.fn(async () => { switched.db++; }),
    initDB: vi.fn(async () => { switched.db++; }),
}));

import { createIdentity, loadIdentity, type BeanPoolIdentity } from '../identity';
import { checkGlobalDoor } from '../node-profile';
import { checkNameAtDoor, submitWordsJoin } from '../global-join';
import { startDoorWork, type DoorWorkRun } from '../door-work';
import { accountKeyForDoor } from '../global-join-existing';
import { askBeforeSwitch } from '../reconnect';
import { mismatchPlan } from '../mismatch-plan';
import { askGlobalStanding, doorStateFromCheck, globalEntryState } from '../global-entry';
import { getSavedNodes } from '../nodes';
import { SAVED_NODES_STORE_KEY } from '../storage-keys';
import { noVault } from './fake-vault';

const SERVER_DIR = fileURLToPath(new URL('../../../server/', import.meta.url).href);
const START_MS = 120_000;
const STEP_MS = 120_000;
const RIVERSIDE = 'https://riverside.example';
const ANCHOR = 'beanpool_anchor_url';

let node: ChildProcessWithoutNullStreams;
let dataDir: string;
let URL_BASE = '';
const replies = new Map<number, (r: { result?: any; error?: string }) => void>();
let nextId = 1;
const realFetch = globalThis.fetch;
const sent: { method: string; path: string; status: number; signed: boolean }[] = [];
const elsewhere: string[] = [];
const runs: DoorWorkRun[] = [];

function control<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        replies.set(id, (r) => (r.error ? reject(new Error(r.error)) : resolve(r.result as T)));
        node.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
}

beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'global-entry-e2e-'));
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

    // The phone reaches this node and nothing else: Riverside, the community it is on, is never asked.
    globalThis.fetch = (async (input: any, init?: any) => {
        const href = String(input instanceof Request ? input.url : input);
        if (!href.startsWith(`${URL_BASE}/`)) {
            elsewhere.push(href);
            throw new TypeError(`Network request failed: the phone contacted ${href}`);
        }
        const res = await realFetch(input, init);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        sent.push({ method: String(init?.method ?? 'GET'), path: new URL(href).pathname, status: res.status, signed: Object.keys(headers).some(h => /signature/i.test(h)) });
        return res;
    }) as typeof fetch;
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

beforeEach(async () => {
    noVault();
    await control('limiters');
});

/** What the phone holds, read back from storage: the community in use, the saved list, the guest marks. */
async function phoneState() {
    return {
        anchor: mem.async.get(ANCHOR) ?? null,
        stored: JSON.parse(mem.async.get(SAVED_NODES_STORE_KEY) ?? '[]').map((n: { url: string }) => n.url),
        // As the next screen to read the list sees it (nodes.ts' auto-migration of the anchor included).
        listed: (await getSavedNodes()).map(n => n.url),
        guests: mem.async.get('beanpool_guest_nodes') ?? null,
    };
}
const BEFORE = { anchor: RIVERSIDE, stored: [RIVERSIDE], listed: [RIVERSIDE], guests: null };

let damo: BeanPoolIdentity;

describe('global entry P1 against a real global-profile node', () => {
    it("1. Damo's case: a stranger key Reconnects to the open-door node → asked first, nothing moves, the page is open, the rule says join", async () => {
        mem.async.clear();
        mem.secure.clear();
        damo = await createIdentity('Damo');
        mem.async.set(ANCHOR, RIVERSIDE);
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: RIVERSIDE, alias: 'Riverside', lastConnected: '2026-10-01T00:00:00.000Z' }]));
        expect(await phoneState()).toEqual(BEFORE);

        const answer = await askBeforeSwitch(URL_BASE, damo);
        expect(answer.kind).toBe('stranger');
        if (answer.kind !== 'stranger') throw new Error('expected stranger');
        expect(answer.reachable).toBe(true);
        expect(answer.profile?.profile).toBe('global');
        // The harness stands in for global.beanpool.org (the door screen takes only that address until P5).
        expect(mismatchPlan({ recognition: 'stranger', profile: answer.profile, reachable: answer.reachable, doorScreenTakes: true }).page).toBe('open');

        // Nothing moved: read back from AsyncStorage.
        expect(await phoneState()).toEqual(BEFORE);
        expect(switched.db).toBe(0);
        // The probe went first, signed by the key, and was answered.
        const probe = sent.find(s => s.path === `/api/community/membership/${damo.publicKey}`);
        expect(probe).toMatchObject({ method: 'GET', status: 200, signed: true });

        // The one rule, from the node's own answers (the list never asked).
        const standing = await askGlobalStanding(damo, undefined, URL_BASE);
        expect(standing).toEqual({ standing: 'stranger', closed: false, answered: true });
        const door = doorStateFromCheck(await checkGlobalDoor(URL_BASE));
        expect(door).toBe('open');
        expect(globalEntryState({ account: true, standing: standing.standing, door, closedHere: false, saved: false })).toBe('join');
        expect(await phoneState()).toEqual(BEFORE);
    }, STEP_MS);

    it('2. Join with this account lands as the SAME key: the node keeps a member under it; the phone\'s key is unchanged', async () => {
        const account = await accountKeyForDoor();
        expect(account).not.toBeNull();
        expect(account!.identity.publicKey).toBe(damo.publicKey);
        expect(account!.createdHere).toBe(false);

        const run = startDoorWork({ url: URL_BASE, identity: account!.identity, door: 'words' });
        runs.push(run);
        expect(await checkNameAtDoor(URL_BASE, 'Damo', account!)).toEqual({ kind: 'free' });
        expect((await run.solution()).kind).toBe('solved');
        const joined = await submitWordsJoin(URL_BASE, account!.identity, 'Damo', run);
        expect(joined).toMatchObject({ kind: 'joined', callsign: 'Damo' });

        const row = await control('member', { key: damo.publicKey });
        expect(row.member).toMatchObject({ status: 'active', callsign: 'Damo' });
        expect((await loadIdentity())?.publicKey).toBe(damo.publicKey);

        const standing = await askGlobalStanding(damo, undefined, URL_BASE);
        expect(standing.standing).toBe('member');
        expect(globalEntryState({ account: true, standing: standing.standing, door: 'open', closedHere: false, saved: false })).toBe('member');
        // The join itself moved nothing on the phone either (the switch to it is join-global.tsx's, after this).
        expect(await phoneState()).toEqual(BEFORE);
    }, STEP_MS);

    it('3. the node closes that account: Reconnect is answered account_closed → the closed page, and nothing moves', async () => {
        await control('prune', { key: damo.publicKey });
        const answer = await askBeforeSwitch(URL_BASE, damo);
        expect(answer.kind).toBe('closed');
        if (answer.kind !== 'closed') throw new Error('expected closed');
        expect(mismatchPlan({ recognition: 'closed', profile: answer.profile, reachable: answer.reachable, doorScreenTakes: true }).page).toBe('closed');
        expect(await phoneState()).toEqual(BEFORE);
        expect(switched.db).toBe(0);
        const last = [...sent].reverse().find(s => s.path === `/api/community/membership/${damo.publicKey}`);
        expect(last).toMatchObject({ status: 403, signed: true });

        // The rule reads it too, and remembers it (the door is no longer offered to this key).
        const remembered: string[] = [];
        const standing = await askGlobalStanding(damo, {
            probe: (await import('../membership-probe')).fetchMembership,
            rememberClosed: async (k) => { remembered.push(k); },
        }, URL_BASE);
        expect(standing).toMatchObject({ closed: true, answered: true });
        expect(remembered).toEqual([damo.publicKey]);
    }, STEP_MS);
});

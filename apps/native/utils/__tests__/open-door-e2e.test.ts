/**
 * Global entry P5 against a REAL global-profile node on another host name (DESIGN-global-entry-fable.md §F, P5 row; decision
 * 6): a self-hoster's open community, not ours. apps/server/src/phone-door-test-harness.ts (the real HTTPS server, signature
 * middleware, membership probe and door routes), named "Riverbend Open" by its operator (BEANPOOL_NODE_NAME) and reached at
 * `https://localhost:<port>`, never at global.beanpool.org, started from the packages' sources and killed by its PID, as
 * utils/__tests__/global-entry-e2e.test.ts does.
 *
 *   1. A member of a local community (Riverside, never contacted) holds a key this node has never seen. Reconnect asks it
 *      first (askBeforeSwitch): "stranger", and nothing moves on the phone. The node's own profile makes the not-recognised
 *      screen's page `open`, because the door screen takes its address (utils/open-door.ts doorNodeAt), and Join goes to THIS
 *      node's door (`/join-open-door?node=<its address>`), under the name it answers itself. Before P5 the door screen took
 *      only the global community's address, and the page was `invite`.
 *   2. Join with this account, as app/join-open-door.tsx runs it for that address: the door's check, the key on the phone,
 *      the signed name check, the door's work, the join, then the switch. The node keeps a member under the SAME key; the
 *      phone's stored key is unchanged; the phone is now on THAT node, which its saved list keeps under its own name,
 *      beside Riverside, untouched.
 *   3. The door screen's words there are the node's own: never "the global community".
 *
 * Nothing else is contacted: the phone's fetch is held to this node's address and throws for anything else, the global
 * community's included.
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
// The phone's database is never opened here: the switch closes and opens it, counted.
const switched = vi.hoisted(() => ({ db: 0 }));
vi.mock('../db', () => ({
    closeDB: vi.fn(async () => { switched.db++; }),
    initDB: vi.fn(async () => { switched.db++; }),
}));

import { createIdentity, loadIdentity, type BeanPoolIdentity } from '../identity';
import { checkGlobalDoor, wordsDoorOn } from '../node-profile';
import { checkNameAtDoor, submitWordsJoin } from '../global-join';
import { startDoorWork, type DoorWorkRun } from '../door-work';
import { accountKeyForDoor, finishJoinFromAccount } from '../global-join-existing';
import { askBeforeSwitch } from '../reconnect';
import { mismatchPlan } from '../mismatch-plan';
import { fetchMembership } from '../membership-probe';
import { membershipAnswerOf } from '../membership-answer';
import { addSavedNode, clearGuestNode, getSavedNodes } from '../nodes';
import { askCommunityName } from '../community-name';
import { doorNodeAt, doorNodeFromParam, openDoorHref } from '../open-door';
import { doorKeeperWords, doorRefusalWords, doorScreenWords, joinedTitle, placeAt } from '../open-door-words';
import { SAVED_NODES_STORE_KEY } from '../storage-keys';
import { GLOBAL_NODE_URL } from '../global-node-url';
import { noVault } from './fake-vault';

const SERVER_DIR = fileURLToPath(new URL('../../../server/', import.meta.url).href);
const START_MS = 120_000;
const STEP_MS = 120_000;
const RIVERSIDE = 'https://riverside.example';
const ANCHOR = 'beanpool_anchor_url';
const NODE_NAME = 'Riverbend Open';

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
    dataDir = mkdtempSync(join(tmpdir(), 'open-door-e2e-'));
    node = spawn(process.execPath, ['--import', 'tsx', 'src/phone-door-test-harness.ts'], {
        cwd: SERVER_DIR,
        env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, TSX_TSCONFIG_PATH: 'tsconfig.phone-door-test-harness.json', BEANPOOL_NODE_NAME: NODE_NAME },
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
    // Another host name than the global community's: the community's own address, as a self-hoster's would be.
    URL_BASE = `https://localhost:${port}`;

    // The phone reaches this node and nothing else: not Riverside, the community it is on, and not global.beanpool.org.
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
        stored: JSON.parse(mem.async.get(SAVED_NODES_STORE_KEY) ?? '[]').map((n: { url: string; alias?: string }) => [n.url, n.alias ?? null]),
        guests: mem.async.get('beanpool_guest_nodes') ?? null,
    };
}
const BEFORE = { anchor: RIVERSIDE, stored: [[RIVERSIDE, 'Riverside']], guests: null };

let riverMember: BeanPoolIdentity;

describe("global entry P5: a self-hoster's open community on its own host name, through the same door", () => {
    it('1. a stranger key Reconnects to it → asked first, nothing moves; the page is open and Join goes to THIS node\'s door, by its own name', async () => {
        mem.async.clear();
        mem.secure.clear();
        riverMember = await createIdentity('Wren');
        mem.async.set(ANCHOR, RIVERSIDE);
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: RIVERSIDE, alias: 'Riverside', lastConnected: '2026-10-01T00:00:00.000Z' }]));
        expect(await phoneState()).toEqual(BEFORE);

        const answer = await askBeforeSwitch(URL_BASE, riverMember);
        expect(answer.kind).toBe('stranger');
        if (answer.kind !== 'stranger') throw new Error('expected stranger');
        expect(answer.reachable).toBe(true);
        expect(answer.profile?.profile).toBe('global');
        expect(answer.profile?.features.openJoin).toBe(true);
        expect(await phoneState()).toEqual(BEFORE);
        expect(switched.db).toBe(0);

        // The door screen takes this address: not the global community's, and nothing about our domain.
        const door = doorNodeAt(URL_BASE);
        expect(door).toEqual({ url: URL_BASE, global: false });
        expect(URL_BASE).not.toContain('beanpool.org');
        // So the not-recognised screen's page is `open` (node-mismatch.tsx passes doorNodeAt(pageUrl) !== null). Before P5 it
        // passed "is it the global community's address?", which said no here, and the page was `invite`.
        expect(mismatchPlan({ recognition: 'stranger', profile: answer.profile, reachable: answer.reachable, doorScreenTakes: door !== null }).page).toBe('open');
        expect(mismatchPlan({ recognition: 'stranger', profile: answer.profile, reachable: answer.reachable, doorScreenTakes: URL_BASE === GLOBAL_NODE_URL }).page).toBe('invite');
        // Join goes to THIS node's door, and the screen it opens reads the same address back.
        const href = openDoorHref(URL_BASE);
        expect(href).toEqual({ pathname: '/join-open-door', params: { node: URL_BASE } });
        expect(doorNodeFromParam(typeof href === 'string' ? undefined : href.params.node)).toEqual({ url: URL_BASE, global: false });
        // Under the name the node answers itself (the operator's), unsigned.
        expect(await askCommunityName(URL_BASE)).toBe(NODE_NAME);
        expect(sent.find(s => s.path === '/api/community/health')).toMatchObject({ method: 'GET', status: 200, signed: false });
        expect(await phoneState()).toEqual(BEFORE);
    }, STEP_MS);

    it('2. Join with this account at that door lands as the SAME key on THAT node; the phone moves there, Riverside kept', async () => {
        // The door's check, as the screen runs it for this address.
        const check = await checkGlobalDoor(URL_BASE);
        expect(check.ok).toBe(true);
        if (!check.ok) throw new Error('expected an open door');
        expect(wordsDoorOn(check.profile.features)).toBe(true);

        const account = await accountKeyForDoor();
        expect(account).not.toBeNull();
        expect(account!.identity.publicKey).toBe(riverMember.publicKey);
        expect(account!.createdHere).toBe(false);

        const run = startDoorWork({ url: URL_BASE, identity: account!.identity, door: 'words' });
        runs.push(run);
        expect(await checkNameAtDoor(URL_BASE, 'Wren', account!)).toEqual({ kind: 'free' });
        expect((await run.solution()).kind).toBe('solved');
        const joined = await submitWordsJoin(URL_BASE, account!.identity, 'Wren', run);
        expect(joined).toMatchObject({ kind: 'joined', callsign: 'Wren' });
        if (joined.kind !== 'joined') throw new Error('expected joined');

        // The node keeps a member under the very key the phone holds; the phone's key is unchanged.
        const row = await control('member', { key: riverMember.publicKey });
        expect(row.member).toMatchObject({ status: 'active', callsign: 'Wren' });
        expect((await loadIdentity())?.publicKey).toBe(riverMember.publicKey);
        expect(await membershipAnswerOf(await fetchMembership(URL_BASE, riverMember))).toEqual({ kind: 'member' });

        // Then the screen's finish, at this door: the phone switches to THIS node and keeps it by its own name.
        const finished = await finishJoinFromAccount(joined, account!, 'Wren', {
            at: { url: URL_BASE, name: NODE_NAME },
            deps: {
                closeDB: (await import('../db')).closeDB,
                initDB: (await import('../db')).initDB,
                addSavedNode,
                clearGuestNode,
                requestSync: async () => {},
            },
        });
        expect(finished?.name).toBe('Wren');
        expect(await phoneState()).toEqual({
            anchor: URL_BASE,
            stored: [[RIVERSIDE, 'Riverside'], [URL_BASE, NODE_NAME]],
            guests: null,
        });
        expect((await getSavedNodes()).map(n => n.url)).toEqual([RIVERSIDE, URL_BASE]);
        expect(switched.db).toBe(2);
        // The same key, still: nothing was made, written or replaced.
        expect((await loadIdentity())?.publicKey).toBe(riverMember.publicKey);
    }, STEP_MS);

    it('3. the door\'s words there are the node\'s own name, never the global community', async () => {
        const place = placeAt(URL_BASE, NODE_NAME);
        const said = [
            ...Object.values(doorScreenWords(place)),
            ...Object.values(doorKeeperWords(place, 'community')),
            ...Object.values(doorKeeperWords(place, 'vault')),
            doorRefusalWords('unreachable', place), doorRefusalWords('not_global', place), doorRefusalWords('door_closed', place),
            joinedTitle(place, "You're in the global community"),
        ];
        for (const line of said) expect(line, line).not.toMatch(/global community/i);
        expect(doorScreenWords(place).title).toBe(`Join ${NODE_NAME}`);
        expect(doorScreenWords(place).nameLabel).toBe(`Your name in ${NODE_NAME}`);
        expect(joinedTitle(place, "You're in the global community")).toBe(`You're in ${NODE_NAME}`);
        // Its host, shown under the title, so the member sees where they are joining.
        expect(place.host).toBe(URL_BASE.replace('https://', ''));
    }, STEP_MS);
});

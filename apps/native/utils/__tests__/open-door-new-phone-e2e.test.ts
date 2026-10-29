/**
 * Another community's open door takes a phone with NO account, end to end (DESIGN-account-without-global-fable.md §2.3 and
 * §5's S2 row; slice S2). apps/server/src/phone-door-test-harness.ts (the real HTTPS server, signature middleware and door
 * routes) with the global profile, named "Riverbend Open" by its operator: a self-hoster's open community, listed nowhere of
 * ours, reached at `https://localhost:<port>` and at `https://127.0.0.1:<port>`, never at global.beanpool.org, started from
 * the packages' sources and killed by its PID, as open-door-e2e.test.ts does. The server is unchanged by S2.
 *
 *   1. A phone that holds nothing gets the community's door link. The router opens the door screen with that address
 *      (before S2: the first screen, and nothing of this community), and the root guard leaves it there with no identity.
 *      The door's check says open with the 12-words way; the key rule at THIS address makes a key in memory; the work and
 *      the signed name check run for it. Nothing is on the phone yet.
 *   2. Join: the key and the door's record are on the phone before the join is sent. The node takes the join and the
 *      answer is lost on its way back. The key and the record stay (the node holds the key), and leaving the door takes
 *      nothing off. After a restart the root guard holds the phone to this door and welcome hands it back here, at this
 *      address; the same key joins again and the node answers `already_member`: in. The phone then holds the key under the
 *      node's name, its anchor is this community, its saved list names it, and the wizard's record is at Your Photo here
 *      with the words as new: the welcome screen shows them at Safety Backup. On the node: a member under that key.
 *   3. A second new phone at the same community's bare IP address: in, at that address, with its own new key.
 *
 * Nothing else is contacted: the phone's fetch is held to this node's two addresses and throws for anything else, the
 * global community's and the key vault's included.
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

import { loadIdentity } from '../identity';
import { checkGlobalDoor, wordsDoorOn } from '../node-profile';
import { checkNameAtDoor, joinedUnderNodeName, submitWordsJoin } from '../global-join';
import { startDoorWork, type DoorWorkRun } from '../door-work';
import { commitOpenDoorKey, finishOpenDoorJoin, openDoorKeyForThisPhone, releaseOpenDoorKey } from '../open-door-key';
import { doorJoinOut, doorResumeUrl, getPendingOnboarding, resumePlan, wizardHold } from '../onboarding-state';
import { doorLinkFromSystemPath, doorLinkRoute, doorNodeAt, openDoorHref } from '../open-door';
import { setupRedirect } from '../auth-return';
import { fetchMembership } from '../membership-probe';
import { membershipAnswerOf } from '../membership-answer';
import { askCommunityName } from '../community-name';
import { getSavedNodes } from '../nodes';
import { SAVED_NODES_STORE_KEY } from '../storage-keys';

const SERVER_DIR = fileURLToPath(new URL('../../../server/', import.meta.url).href);
const START_MS = 120_000;
const STEP_MS = 120_000;
const ANCHOR = 'beanpool_anchor_url';
const NODE_NAME = 'Riverbend Open';

let node: ChildProcessWithoutNullStreams;
let dataDir: string;
let URL_BASE = '';
let URL_IP = '';
const replies = new Map<number, (r: { result?: any; error?: string }) => void>();
let nextId = 1;
const realFetch = globalThis.fetch;
const sent: { method: string; origin: string; path: string; status: number }[] = [];
const elsewhere: string[] = [];
const runs: DoorWorkRun[] = [];
/** The next join's answer is lost on its way back: the node has taken it, the phone hears nothing. */
let loseNextJoinAnswer = false;

function control<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        replies.set(id, (r) => (r.error ? reject(new Error(r.error)) : resolve(r.result as T)));
        node.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
}

beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'open-door-new-phone-e2e-'));
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
    // The community's own addresses, as a self-hoster's would be: a name, and a bare IP. Nothing of ours.
    URL_BASE = `https://localhost:${port}`;
    URL_IP = `https://127.0.0.1:${port}`;

    globalThis.fetch = (async (input: any, init?: any) => {
        const href = String(input instanceof Request ? input.url : input);
        if (!href.startsWith(`${URL_BASE}/`) && !href.startsWith(`${URL_IP}/`)) {
            elsewhere.push(href);
            throw new TypeError(`Network request failed: the phone contacted ${href}`);
        }
        const res = await realFetch(input, init);
        const u = new URL(href);
        const method = String(init?.method ?? 'GET');
        sent.push({ method, origin: u.origin, path: u.pathname, status: res.status });
        if (loseNextJoinAnswer && method === 'POST' && u.pathname === '/api/join') {
            loseNextJoinAnswer = false;
            throw new TypeError('Network request failed');
        }
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
    await control('limiters');
});

/** The door's 12-words work for `key` at `url`, solved. */
async function solvedWork(url: string, identity: Parameters<typeof startDoorWork>[0]['identity']): Promise<DoorWorkRun> {
    const run = startDoorWork({ url, identity, door: 'words' });
    runs.push(run);
    expect((await run.solution()).kind).toBe('solved');
    return run;
}

/** Step 1's key: made in memory and held by the door screen (its `key` state) until Join. */
let doorKey: Awaited<ReturnType<typeof openDoorKeyForThisPhone>>;

describe("another community's open door takes a phone with no account, at its own address (S2)", () => {
    it('1. its link on a phone that holds nothing opens THIS door, which the guard leaves; the key is made in memory and nothing is written', async () => {
        mem.async.clear();
        mem.secure.clear();
        const link = doorLinkFromSystemPath(`beanpool://join-open-door?node=${encodeURIComponent(URL_BASE)}`)!;
        expect(link.node).toEqual({ url: URL_BASE, global: false });
        const route = doorLinkRoute(link, { account: false, wizardPending: false }, true, Date.now());
        expect(route).toBe(`/join-open-door?node=${encodeURIComponent(URL_BASE)}&from=link`);
        expect(setupRedirect(['join-open-door'], { hasIdentity: false, pendingOnboarding: false })).toBeNull();

        const check = await checkGlobalDoor(URL_BASE);
        expect(check.ok).toBe(true);
        if (!check.ok) throw new Error('expected an open door');
        expect(wordsDoorOn(check.profile.features)).toBe(true);
        expect(await askCommunityName(URL_BASE)).toBe(NODE_NAME);

        const key = await openDoorKeyForThisPhone(URL_BASE);
        expect(key.createdHere).toBe(true);
        await solvedWork(URL_BASE, key.identity);
        expect(await checkNameAtDoor(URL_BASE, 'Wren', key)).toEqual({ kind: 'free' });
        // Read, checked and worked for: nothing on the phone, and nothing of this key on the node.
        expect(mem.secure.size).toBe(0);
        expect(await getPendingOnboarding()).toBeNull();
        expect(mem.async.get(ANCHOR)).toBeUndefined();
        expect((await control('member', { key: key.identity.publicKey })).member).toBeNull();
        doorKey = key;
    }, STEP_MS);

    it('2. Join: on the phone before it goes; its answer lost, the key is kept and the phone comes back HERE; the same key is in, and the wizard shows its words', async () => {
        // Asked again at Join with the key the screen holds: that one, never a second.
        const key = await openDoorKeyForThisPhone(URL_BASE, doorKey);
        expect(key).toBe(doorKey);
        const run = await solvedWork(URL_BASE, key.identity);

        const identity = await commitOpenDoorKey(URL_BASE, key, 'Wren');
        expect((await loadIdentity())?.publicKey).toBe(key.identity.publicKey);
        expect(await getPendingOnboarding()).toMatchObject({ step: 'globalJoin', flow: 'global', anchorUrl: URL_BASE, freshKey: key.identity.publicKey, joinsOut: 0 });
        loseNextJoinAnswer = true;
        expect((await submitWordsJoin(URL_BASE, identity, 'Wren', run)).kind).toBe('unreachable');
        // The node took it.
        expect((await control('member', { key: key.identity.publicKey })).member).toMatchObject({ status: 'active', callsign: 'Wren' });
        // The phone kept the key and its record, counted out; leaving the door takes nothing off.
        expect(await getPendingOnboarding()).toMatchObject({ joinsOut: 1 });
        expect(await releaseOpenDoorKey(URL_BASE, key)).toBe(false);
        expect((await loadIdentity())?.publicKey).toBe(key.identity.publicKey);

        // A restart: the app holds the key now; the guard keeps this door and welcome, and welcome hands the join back HERE.
        const record = await getPendingOnboarding();
        expect(doorJoinOut(record)).toBe(true);
        expect(wizardHold(record)).toBe('door');
        expect(setupRedirect(['join-open-door'], { hasIdentity: true, pendingOnboarding: true, doorOut: true })).toBeNull();
        expect(setupRedirect(['(tabs)'], { hasIdentity: true, pendingOnboarding: true, doorOut: true })).toBe('/welcome');
        const plan = resumePlan(record, await loadIdentity());
        expect(doorResumeUrl(plan)).toBe(URL_BASE);
        expect(openDoorHref(URL_BASE)).toEqual({ pathname: '/join-open-door', params: { node: URL_BASE } });

        // Back at the door: the same key, still this door's own; its name is free to it (its own); the door's work.
        const again = await openDoorKeyForThisPhone(URL_BASE);
        expect(again.identity.publicKey).toBe(key.identity.publicKey);
        expect(again.createdHere).toBe(true);
        expect(await checkNameAtDoor(URL_BASE, 'Wren', again)).toEqual({ kind: 'free' });
        const retry = startDoorWork({ url: URL_BASE, identity: again.identity, door: 'words' });
        runs.push(retry);
        const ready = await retry.solution();
        // The node knows the key: its work route answers that it is a member (409 already_member), which the screen
        // (handleWordsJoin → afterAnswer) takes as in, with a key it made: finishNewAccount. No second join is sent.
        expect(ready).toMatchObject({ kind: 'refused', answer: { kind: 'joined' } });
        if (ready.kind !== 'refused' || ready.answer.kind !== 'joined') throw new Error('expected in');
        const answer = ready.answer;
        expect(sent.filter(s => s.path === '/api/join').map(s => s.status)).toEqual([200]);

        const named = await joinedUnderNodeName(URL_BASE, answer, { ...again.identity, callsign: 'Wren' });
        const kept = await finishOpenDoorJoin(URL_BASE, named, { enrolment: answer.enrolment, way: 'words', communityName: NODE_NAME });
        expect(kept).toMatchObject({ publicKey: key.identity.publicKey, callsign: 'Wren' });
        expect((await loadIdentity())?.publicKey).toBe(key.identity.publicKey);
        expect(mem.async.get(ANCHOR)).toBe(URL_BASE);
        expect(JSON.parse(mem.async.get(SAVED_NODES_STORE_KEY) ?? '[]').map((n: { url: string; alias?: string }) => [n.url, n.alias])).toEqual([[URL_BASE, NODE_NAME]]);
        const wizard = await getPendingOnboarding();
        expect(wizard).toMatchObject({ step: 'profileSetup', flow: 'global', anchorUrl: URL_BASE, redeemed: true, newKey: key.identity.publicKey, joinDoor: 'words' });
        expect(resumePlan(wizard, await loadIdentity())).toMatchObject({ action: 'resume', mode: 'profileSetup', anchorUrl: URL_BASE, newKey: true });
        expect(wizardHold(wizard)).toBe('wizard');
        expect(await membershipAnswerOf(await fetchMembership(URL_BASE, kept))).toEqual({ kind: 'member' });
    }, STEP_MS);

    it('3. a second new phone at the community\'s bare IP address: in there, with its own new key', async () => {
        mem.async.clear();
        mem.secure.clear();
        const door = doorNodeAt(URL_IP);
        expect(door).toEqual({ url: URL_IP, global: false });
        const key = await openDoorKeyForThisPhone(URL_IP);
        expect(key.createdHere).toBe(true);
        expect(key.identity.publicKey).not.toBe(doorKey.identity.publicKey);
        const run = await solvedWork(URL_IP, key.identity);
        expect(await checkNameAtDoor(URL_IP, 'Kea', key)).toEqual({ kind: 'free' });
        const answer = await submitWordsJoin(URL_IP, await commitOpenDoorKey(URL_IP, key, 'Kea'), 'Kea', run);
        expect(answer).toMatchObject({ kind: 'joined', callsign: 'Kea' });
        if (answer.kind !== 'joined') throw new Error('expected joined');
        await finishOpenDoorJoin(URL_IP, await joinedUnderNodeName(URL_IP, answer, { ...key.identity, callsign: 'Kea' }), { enrolment: null, way: 'words', communityName: null });
        expect(mem.async.get(ANCHOR)).toBe(URL_IP);
        expect((await getSavedNodes()).map(n => n.url)).toEqual([URL_IP]);
        expect((await control('member', { key: key.identity.publicKey })).member).toMatchObject({ status: 'active', callsign: 'Kea' });
        expect(new Set(sent.map(s => s.origin))).toEqual(new Set([URL_BASE, URL_IP]));
    }, STEP_MS);
});

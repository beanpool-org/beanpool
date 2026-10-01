/**
 * The phone's own door code against a REAL global-profile node on this machine (two-doors design §7.3, phone part):
 * apps/server/src/phone-door-test-node.ts, the real HTTPS server, signature middleware, door routes and door work,
 * started from the packages' sources and killed by its PID. Memory `phone-e2e-localhost-nodes`.
 *
 *   1. a global-profile node says it has the 12-words door, and the phone's door check reads it so
 *   2. a 12-words join end to end: the phone's work on expo-crypto (Node's native SHA-256 here), the signed name check,
 *      the join; the node keeps a `words` member on the 12-words rules
 *   3. then a sign-in added later (a build without a vault: the copy rides in the link): the node's row becomes the
 *      provider's, the usual new-account limits apply, and a second account can't take that sign-in
 *   4. then a removed newcomer's network: a moderator removes a 12-words newcomer, and the next 12-words join from the
 *      same network is asked a raised level (4); the phone does it, says the busy sentence with its own estimate on
 *      the way, and joins
 *   5. the sign-in door at ordinary rates: its work route says none, and a sign-in join goes through as before
 *
 * Nothing else is contacted: the phone's fetch is held to this node's address and throws for anything else, the node's
 * own fetch refuses every host but this machine, and the provider's sheet is a stub minting tokens with a key the node
 * was given at start.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, sign as rsaSign, type KeyObject } from 'node:crypto';
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
    // expo-crypto 55's digest: one native SHA-256, answered with a promise of an ArrayBuffer.
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
/** The provider's sheet: a Google token for `sub`, carrying the nonce it was given, signed with the key the node trusts. */
const google = vi.hoisted(() => ({ sub: 'e2e-google-sub-1', mint: null as null | ((sub: string, nonce: string) => string), opened: 0 }));
vi.mock('../sso-signin', async (importOriginal) => {
    const real = await importOriginal<typeof import('../sso-signin')>();
    const sheet = async (nonce: string) => {
        google.opened++;
        return { idToken: google.mint!(google.sub, nonce), nonce };
    };
    return {
        ...real,
        signInWithGoogle: vi.fn(sheet),
        signInWithProvider: vi.fn(async (provider: string, nonce: string) => {
            if (provider !== 'google') throw new Error('only Google here');
            return { provider, ...await sheet(nonce) };
        }),
    };
});

import { draftIdentity, type BeanPoolIdentity } from '../identity';
import { checkGlobalDoor, wordsDoorOn } from '../node-profile';
import {
    checkNameAtDoor,
    commitJoinKey,
    doorMessage,
    joinKeyForThisPhone,
    signInAtDoor,
    submitJoin,
    submitWordsJoin,
    type DoorAnswer,
} from '../global-join';
import { BUSY_LEVEL, busyLevelSentence, startDoorWork, type DoorWorkRun, type DoorWorkState } from '../door-work';
import { linkSignIn } from '../join-link';
import { noVault } from './fake-vault';

const SERVER_DIR = fileURLToPath(new URL('../../../server/', import.meta.url).href);
const GOOGLE_KID = 'phone-door-e2e-google';
const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
const START_MS = 120_000;
const STEP_MS = 120_000;

let node: ChildProcessWithoutNullStreams;
let dataDir: string;
let URL_BASE = '';
let googleKey: KeyObject;
const replies = new Map<number, (r: { result?: any; error?: string }) => void>();
let nextId = 1;
const realFetch = globalThis.fetch;
/** Every request the phone made, and anything it tried to send elsewhere (which would fail the run). */
const sent: { method: string; path: string; status: number }[] = [];
const elsewhere: string[] = [];
const runs: DoorWorkRun[] = [];

function control<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        replies.set(id, (r) => (r.error ? reject(new Error(r.error)) : resolve(r.result as T)));
        node.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
}

function mintGoogle(sub: string, nonce: string): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const head = b64({ alg: 'RS256', kid: GOOGLE_KID, typ: 'JWT' });
    const body = b64({ iss: 'https://accounts.google.com', aud: GOOGLE_AUD, sub, email_verified: true, iat: now, exp: now + 3600, nonce });
    return `${head}.${body}.${rsaSign('RSA-SHA256', Buffer.from(`${head}.${body}`), googleKey).toString('base64url')}`;
}

beforeAll(async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    googleKey = pair.privateKey;
    google.mint = mintGoogle;
    const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: GOOGLE_KID, alg: 'RS256', use: 'sig' };
    dataDir = mkdtempSync(join(tmpdir(), 'phone-door-e2e-'));
    node = spawn(process.execPath, ['--import', 'tsx', 'src/phone-door-test-node.ts'], {
        cwd: SERVER_DIR,
        env: {
            ...process.env,
            BEANPOOL_DATA_DIR: dataDir,
            PHONE_DOOR_GOOGLE_JWK: JSON.stringify(jwk),
            // From the packages' sources: never waits on, or races, a build of core, engine or signin.
            TSX_TSCONFIG_PATH: 'tsconfig.phone-door-test-node.json',
        },
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
        node.stderr.on('data', (chunk: Buffer) => {
            log += chunk.toString();
            if (/BLOCKED-FETCH/.test(chunk.toString())) elsewhere.push(`node: ${chunk.toString().trim()}`);
        });
        node.on('exit', (code) => reject(new Error(`the test node exited (${code}):\n${log.slice(-3000)}`)));
    });
    URL_BASE = `https://127.0.0.1:${port}`;

    // The phone reaches this node and nothing else.
    globalThis.fetch = (async (input: any, init?: any) => {
        const href = String(input instanceof Request ? input.url : input);
        if (!href.startsWith(`${URL_BASE}/`)) {
            elsewhere.push(href);
            throw new TypeError(`Network request failed: the phone contacted ${href}`);
        }
        const res = await realFetch(input, init);
        sent.push({ method: String(init?.method ?? 'GET'), path: new URL(href).pathname, status: res.status });
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

/** A new phone: nothing stored. */
function newPhone(): void {
    mem.async.clear();
    mem.secure.clear();
}

/** The welcome screen's 12-words way, step by step, as app/welcome.tsx calls it. */
async function joinByWords(name: string, onState?: (s: DoorWorkState) => void) {
    const key = await joinKeyForThisPhone();
    const run = startDoorWork({ url: URL_BASE, identity: key.identity, door: 'words', onChange: onState });
    runs.push(run);
    const check = await checkNameAtDoor(URL_BASE, name, key);
    const ready = await run.solution();
    const identity = await commitJoinKey(key, name);
    const answer = await submitWordsJoin(URL_BASE, identity, name, run);
    return { key, identity, check, ready, answer, run };
}

let first: BeanPoolIdentity;

describe('the phone\'s door against a real global-profile node', () => {
    it('1. the node says it has the 12-words door, and the phone\'s check reads it so', async () => {
        const check = await checkGlobalDoor(URL_BASE);
        expect(check.ok).toBe(true);
        if (check.ok) {
            expect(check.profile.profile).toBe('global');
            expect(wordsDoorOn(check.profile.features)).toBe(true);
        }
    }, STEP_MS);

    it('2. a 12-words join, end to end: work, a signed name check, the join; a `words` member on the 12-words rules', async () => {
        newPhone();
        const states: DoorWorkState[] = [];
        const { identity, check, ready, answer } = await joinByWords('Ana Words', s => states.push(s));
        expect(check).toEqual({ kind: 'free' });
        expect(ready.kind).toBe('solved');
        expect(states.find(s => s.phase === 'solving')?.level).toBe(0);
        expect(answer).toMatchObject({ kind: 'joined', callsign: 'Ana Words' });
        first = identity;

        const row = await control('member', { key: identity.publicKey });
        expect(row.member).toMatchObject({ status: 'active', invited_by: 'open:words', callsign: 'Ana Words' });
        expect(row.join).toMatchObject({ provider: 'words' });
        expect(row.join.join_hash).toMatch(/^words:/);
        expect((await control('probation', { key: identity.publicKey })).rules).toBe('words');

        // Only the door's routes, each answered: the work, the name check, the join.
        const paths = sent.map(s => `${s.method} ${s.path} ${s.status}`);
        expect(paths).toContain('POST /api/join/work 200');
        expect(paths.some(p => /^GET \/api\/members\/callsign-available\/Ana%20Words 200$/.test(p))).toBe(true);
        expect(paths).toContain('POST /api/join 200');
    }, STEP_MS);

    it('3. then a sign-in added later: the row becomes Google\'s, the usual limits apply; the same sign-in can\'t go to a second account', async () => {
        const answer = await linkSignIn({ url: URL_BASE, identity: first, provider: 'google', phoneLock: null });
        expect(answer).toMatchObject({ kind: 'linked', provider: 'google', enrolment: { enrolledSso: ['google'] } });
        const row = await control('member', { key: first.publicKey });
        expect(row.join.provider).toBe('google');
        expect((await control('probation', { key: first.publicKey })).rules).toBe('ordinary');

        // Again: it has one now.
        const again = await linkSignIn({ url: URL_BASE, identity: first, provider: 'google', phoneLock: null });
        expect(again).toMatchObject({ kind: 'refused', reason: 'already_linked' });

        // A second 12-words member tries the same Google account: refused, in words, and nothing changed.
        newPhone();
        await control('limiters');
        const second = await joinByWords('Ben Words');
        expect(second.answer.kind).toBe('joined');
        const taken = await linkSignIn({ url: URL_BASE, identity: second.identity, provider: 'google', phoneLock: null });
        expect(taken).toMatchObject({ kind: 'refused', reason: 'already_joined' });
        if (taken.kind === 'refused') expect(taken.message).toMatch(/already the sign-in of another BeanPool account/);
        expect((await control('member', { key: second.identity.publicKey })).join.provider).toBe('words');
    }, STEP_MS);

    it('4. then a removed newcomer\'s network: the next 12-words join from it is asked level 4; the phone does it, says so with its own estimate, and joins', async () => {
        // A moderator removes a 12-words newcomer minutes after they joined from this network (design §2.4).
        newPhone();
        await control('limiters');
        const removed = await joinByWords('Cal Removed');
        expect(removed.answer.kind).toBe('joined');
        await control('prune', { key: removed.identity.publicKey });
        expect((await control('member', { key: removed.identity.publicKey })).join.ip_kept_until).toBeTruthy();

        // A new phone on the same network.
        newPhone();
        await control('limiters');
        const states: DoorWorkState[] = [];
        const started = Date.now();
        const next = await joinByWords('Dee Raised', s => states.push(s));
        const solving = states.find(s => s.phase === 'solving');
        expect(solving?.level).toBe(4);
        expect(solving!.level!).toBeGreaterThanOrEqual(BUSY_LEVEL);
        // The phone timed its first part and could say how long, from level 3, with the sign-in door beside it.
        const timed = states.find(s => s.phase === 'solving' && s.estimateMs !== null);
        expect(timed?.estimateMs).toBeGreaterThan(0);
        const sentence = busyLevelSentence({ ...timed!, phase: 'solving' }, timed!.startedAt!);
        expect(sentence).toMatch(/^Lots of people are joining right now\. Setting up a 12-words account will take about .+ on this phone\. Or sign in to join now\.$/);
        expect(next.answer).toMatchObject({ kind: 'joined', callsign: 'Dee Raised' });
        console.log(`[e2e] level-4 join from a removed newcomer's network: ${Date.now() - started} ms (estimate ${timed?.estimateMs} ms)`);
    }, STEP_MS);

    it('5. the sign-in door at ordinary rates: its work route says none, and the join goes through as before', async () => {
        newPhone();
        await control('limiters');
        google.sub = 'e2e-google-sub-2';
        const key = await joinKeyForThisPhone();
        const run = startDoorWork({ url: URL_BASE, identity: key.identity, door: 'sign-in' });
        runs.push(run);
        expect(await run.solution()).toEqual({ kind: 'none' });
        const signedIn = await signInAtDoor('google', URL_BASE, key.identity);
        if (signedIn.kind !== 'signed_in') throw new Error(`no sign-in: ${JSON.stringify(signedIn)}`);
        const identity = await commitJoinKey(key, 'Eve Google');
        const answer: DoorAnswer = await submitJoin(URL_BASE, identity, 'Eve Google', signedIn.signin, { work: run });
        expect(answer.kind, answer.kind === 'joined' ? '' : doorMessage(answer)).toBe('joined');
        expect((await control('member', { key: identity.publicKey })).join.provider).toBe('google');
    }, STEP_MS);

    it('a key that never joined can\'t add a sign-in: said in words', async () => {
        const stranger = await draftIdentity();
        const answer = await linkSignIn({ url: URL_BASE, identity: stranger, provider: 'google', phoneLock: null });
        expect(answer.kind).toBe('refused');
        if (answer.kind === 'refused') expect(answer.message).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
    }, STEP_MS);
});

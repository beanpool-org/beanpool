/**
 * The phone's own door code against a REAL global-profile node on this machine (two-doors design §7.3, phone part):
 * apps/server/src/phone-door-test-harness.ts, the real HTTPS server, signature middleware, door routes and door work,
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
 *   6. the 12-words ceiling refuses, then is lifted: Join inside a minute says when and sends nothing; Join after it
 *      sends `POST /api/join/work` again, and joins (PR #1452 review, finding 1)
 *   7. a phone clock 6 minutes off: the node's 401 at the work route and at the 12-words join reads "check the date and
 *      time", never "sign in again" (finding 3)
 *   8. a removed member adding a sign-in: `account_closed` in its own sentence, never "try again later" (finding 4)
 *   9. a 12-words account on ANOTHER phone: the node's /api/community/me says `words`, so the card and Add a sign-in
 *      show there; refused while suspended, in a sentence; gone once a sign-in is added (#1454 review, finding 2)
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
import { BUSY_LEVEL, busyLevelSentence, fetchDoorWork, startDoorWork, type DoorWorkRun, type DoorWorkState } from '../door-work';
import { linkSignIn } from '../join-link';
import { askOneWayBackStanding, oneWayBackFromNode, oneWayBackPlace, readOneWayBack } from '../one-way-back';
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
/** Every request the phone made, and anything it tried to send elsewhere (which fails the run). */
const sent: { method: string; path: string; status: number }[] = [];
const elsewhere: string[] = [];
/** What the node's own guard refused (a background job of the node, never the phone's): reported, contacted nobody. */
const nodeBlocked: string[] = [];
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
    node = spawn(process.execPath, ['--import', 'tsx', 'src/phone-door-test-harness.ts'], {
        cwd: SERVER_DIR,
        env: {
            ...process.env,
            BEANPOOL_DATA_DIR: dataDir,
            PHONE_DOOR_GOOGLE_JWK: JSON.stringify(jwk),
            // From the packages' sources: never waits on, or races, a build of core, engine or signin.
            TSX_TSCONFIG_PATH: 'tsconfig.phone-door-test-harness.json',
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
            if (/BLOCKED-FETCH/.test(chunk.toString())) nodeBlocked.push(chunk.toString().trim());
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
    if (nodeBlocked.length) console.log(`[e2e] the test node's guard refused (nothing was contacted): ${nodeBlocked.join('; ')}`);
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
/** Step 3's second 12-words member (still on the 12-words rules), and step 4's removed one. */
let ben: BeanPoolIdentity;
let cal: BeanPoolIdentity;

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
        ben = second.identity;
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
        cal = removed.identity;
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

    it('6. the 12-words ceiling, then lifted: Join inside a minute says when and sends nothing; after it, POST /api/join/work, and in', async () => {
        newPhone();
        await control('limiters');
        // Every 12-words join above came from this one address: a ceiling of 1 an hour is already reached.
        await control('doorNumber', { name: 'wordsPerHour', value: '1' });
        let skew = 0;
        const phoneNow = () => Date.now() + skew;
        const key = await joinKeyForThisPhone();
        const run = startDoorWork({ url: URL_BASE, identity: key.identity, door: 'words', now: phoneNow });
        runs.push(run);
        const refused = await run.solution();
        expect(refused).toMatchObject({ kind: 'refused', answer: { kind: 'rate_limited', door: 'words' } });
        if (refused.kind === 'refused') expect(doorMessage(refused.answer as Exclude<DoorAnswer, { kind: 'joined' }>)).toMatch(/^A very large number of 12-words accounts were made from your network in the last hour\. Sign in to join now, or try again (in \d+ minutes?|in about an hour)\.$/);
        const workAsks = () => sent.filter(r => r.method === 'POST' && r.path === '/api/join/work').length;
        const asked = workAsks();

        // The operator lifts the ceiling. Two Joins inside the minute: the sentence again, nothing sent.
        await control('doorNumber', { name: 'wordsPerHour', value: '500' });
        skew = 10_000;
        expect((await run.solution()).kind).toBe('refused');
        skew = 40_000;
        expect((await run.solution()).kind).toBe('refused');
        expect(workAsks()).toBe(asked);

        // A minute on, Join asks the node again: the work comes, it's done, and the 12-words join goes in.
        skew = 61_000;
        const ready = await run.solution();
        expect(ready.kind).toBe('solved');
        expect(workAsks()).toBe(asked + 1);
        expect(sent.filter(r => r.path === '/api/join/work').at(-1)?.status).toBe(200);
        const identity = await commitJoinKey(key, 'Fay Lifted');
        expect(await submitWordsJoin(URL_BASE, identity, 'Fay Lifted', run)).toMatchObject({ kind: 'joined', callsign: 'Fay Lifted' });
    }, STEP_MS);

    it('7. a phone clock 6 minutes off: "check the date and time" at the work route and at the 12-words join; never "sign in again"', async () => {
        newPhone();
        await control('limiters');
        const key = await joinKeyForThisPhone();
        // The work route, signed with the wrong time.
        vi.useFakeTimers({ now: Date.now() + 6 * 60_000, toFake: ['Date'] });
        let work;
        try {
            work = await fetchDoorWork(URL_BASE, key.identity, 'words');
        } finally {
            vi.useRealTimers();
        }
        expect(work).toMatchObject({ kind: 'refused', answer: { kind: 'phone_clock' } });
        expect(sent.at(-1)).toMatchObject({ path: '/api/join/work', status: 401 });

        // Work done with the right time; then the join, signed with the wrong one.
        const run = startDoorWork({ url: URL_BASE, identity: key.identity, door: 'words' });
        runs.push(run);
        const solvedFirst = await run.solution();
        expect(solvedFirst.kind, JSON.stringify(solvedFirst)).toBe('solved');
        const identity = await commitJoinKey(key, 'Gus Clock');
        vi.useFakeTimers({ now: Date.now() + 6 * 60_000, toFake: ['Date'] });
        let answer: DoorAnswer;
        try {
            answer = await submitWordsJoin(URL_BASE, identity, 'Gus Clock', run);
        } finally {
            vi.useRealTimers();
        }
        expect(sent.at(-1)).toMatchObject({ path: '/api/join', status: 401 });
        expect(answer.kind).toBe('phone_clock');
        for (const said of [answer, (work as { answer: DoorAnswer }).answer]) {
            const message = doorMessage(said as Exclude<DoorAnswer, { kind: 'joined' }>);
            expect(message).toMatch(/date and time/);
            expect(message).not.toMatch(/sign in again/i);
        }
        expect((await control('member', { key: identity.publicKey })).member).toBeNull();
    }, STEP_MS);

    it('8. a removed member adding a sign-in: its own sentence, never "try again later"', async () => {
        const answer = await linkSignIn({ url: URL_BASE, identity: cal, provider: 'google', phoneLock: null });
        expect(sent.at(-1)).toMatchObject({ path: '/api/join/link/sso-nonce', status: 403 });
        expect(answer).toMatchObject({ kind: 'refused', reason: 'account_closed' });
        if (answer.kind === 'refused') {
            expect(answer.message).toMatch(/was closed/);
            expect(answer.message).not.toMatch(/try again/i);
        }
    }, STEP_MS);

    it('9. a 12-words account on another phone: the node says words, so Add a sign-in shows; refused while suspended; gone once added', async () => {
        // Ben's account, restored on a phone that never made his join: no record here.
        newPhone();
        await control('limiters');
        expect(await readOneWayBack(ben.publicKey)).toBeNull();
        /** The node's word on Ben's account (never `not_member` here: he is a member). */
        const word = async () => {
            const a = await askOneWayBackStanding(URL_BASE, ben);
            if (a === 'not_member') throw new Error('the node says Ben is not a member');
            return a;
        };
        const standing = await word();
        expect(sent.at(-1)).toMatchObject({ method: 'GET', path: '/api/community/me', status: 200 });
        expect(standing?.words).toBe(true);
        expect(Math.abs((standing?.joinedAt ?? 0) - Date.now())).toBeLessThan(STEP_MS * 10);
        const record = await oneWayBackFromNode(ben.publicKey, URL_BASE, standing);
        expect(oneWayBackPlace(record, Date.now(), false)).toBe('card');

        // Suspended: the card still says so (the node still says 12 words), and adding a sign-in is refused in a sentence.
        await control('status', { key: ben.publicKey, status: 'suspended' });
        expect((await word())?.words).toBe(true);
        google.sub = 'e2e-google-sub-ben';
        const refused = await linkSignIn({ url: URL_BASE, identity: ben, provider: 'google', phoneLock: null });
        expect(refused).toMatchObject({ kind: 'refused', reason: 'not_a_member' });
        if (refused.kind === 'refused') {
            expect(refused.message).toMatch(/suspended/);
            expect(refused.message).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
        }
        expect((await control('member', { key: ben.publicKey })).join.provider).toBe('words');

        // Active again: added from this phone; the node then says so, and the card goes.
        await control('status', { key: ben.publicKey, status: 'active' });
        await control('limiters');
        expect(await linkSignIn({ url: URL_BASE, identity: ben, provider: 'google', phoneLock: null })).toMatchObject({ kind: 'linked' });
        const after = await word();
        expect(after).toEqual({ words: false, joinedAt: null });
        expect(oneWayBackPlace(await oneWayBackFromNode(ben.publicKey, URL_BASE, after), Date.now(), false)).toBe('none');
    }, STEP_MS);

    it('a key that never joined can\'t add a sign-in: said in words', async () => {
        const stranger = await draftIdentity();
        // Not a member there: the node's 403 is its own word (the card keeps it like any answer: re-review finding 3).
        expect(await askOneWayBackStanding(URL_BASE, stranger)).toBe('not_member');
        const answer = await linkSignIn({ url: URL_BASE, identity: stranger, provider: 'google', phoneLock: null });
        expect(answer.kind).toBe('refused');
        if (answer.kind === 'refused') expect(answer.message).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
    }, STEP_MS);
});

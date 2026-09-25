/**
 * GitHub sign-in runs through the node (A2a).
 *
 * The phone used to run GitHub's device flow itself and hand the node the access token it got. GitHub
 * OAuth Apps are not OIDC: `/user` answers for a token minted for ANY app, so a node that trusted a
 * token handed to it would release a member's sealed seed to whoever held one. Since S2 (#1115) the
 * node runs the device flow and the phone only ever talks to the node: `start` answers the code the
 * member types at GitHub, `poll { sessionId }` answers pending / ok / denied / expired, and the deposit
 * or recovery that follows carries `proof: { sessionId }`, never a token.
 *
 * Nothing here contacts a node or GitHub. `node-post` and the request signing are real, so every
 * request the app makes goes through the `fetch` stub below, which plays the node and refuses (and
 * records) anything addressed elsewhere. That is what lets these tests say "no request to github.com
 * or api.github.com" rather than "the function we mocked was not called".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sealSeedToSso } from '@beanpool/core';

(globalThis as any).__DEV__ = false;

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
}));
vi.mock('expo-linking', () => ({
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    openURL: vi.fn(async () => undefined),
}));
vi.mock('expo-web-browser', () => ({
    openAuthSessionAsync: vi.fn(),
    openBrowserAsync: vi.fn(),
    dismissAuthSession: vi.fn(),
    dismissBrowser: vi.fn(async () => undefined),
}));
vi.mock('expo-apple-authentication', () => ({
    isAvailableAsync: vi.fn(async () => false),
    signInAsync: vi.fn(),
    AppleAuthenticationScope: { EMAIL: 0, FULL_NAME: 1 },
}));
vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(len).fill(9)),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async () => null),
        setItem: vi.fn(async () => undefined),
        removeItem: vi.fn(async () => undefined),
    },
}));
vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(async () => null),
    setItemAsync: vi.fn(async () => undefined),
    deleteItemAsync: vi.fn(async () => undefined),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { SsoSignInError, startSsoSignIn } from '../sso-signin';
import { recoverAccountWithSso, waitingOnGithub } from '../sso-recovery';
import { seedToKeypair } from '../crypto';

const NODE = 'https://test.example';
const GITHUB_UPDATE_MESSAGE =
    "This community's server needs an update before GitHub sign-in works. Use Google, Apple or your 12 words for now.";

const MEMBER = {
    publicKey: 'aa'.repeat(32),
    privateKey: '07'.repeat(32),
    callsign: 'member',
    createdAt: '2026-09-25T00:00:00Z',
} as any;

type Answer = { status: number; body?: unknown; headers?: Record<string, string> };
type Route = Answer | Answer[] | ((body: any) => Answer);
interface Seen { url: string; path: string; body: any; at: number }

function answer({ status, body = {}, headers = {} }: Answer): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(headers),
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

/**
 * Play the node. A list answers in order and then repeats its last entry. A request to any other host
 * is recorded and fails as a network error would, so a test that expects none can check for it.
 */
function installNode(routes: Record<string, Route>): Seen[] {
    const seen: Seen[] = [];
    const queues = new Map<string, Route>(
        Object.entries(routes).map(([path, r]) => [path, Array.isArray(r) ? [...r] : r]),
    );
    globalThis.fetch = vi.fn(async (input: any, init?: any) => {
        const url = String(input);
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        const path = url.startsWith(NODE) ? url.slice(NODE.length) : url;
        seen.push({ url, path, body, at: Date.now() });
        if (!url.startsWith(`${NODE}/`)) throw new TypeError(`Network request failed: the app contacted ${url}`);
        const route = queues.get(path);
        if (!route) return answer({ status: 404, body: { error: 'Not Found' } });
        if (Array.isArray(route)) return answer(route.length > 1 ? route.shift()! : route[0]);
        return answer(typeof route === 'function' ? route(body) : route);
    }) as any;
    return seen;
}

/** Every request that went anywhere but the node. */
function offNode(seen: Seen[]): string[] {
    return seen.map((s) => s.url).filter((u) => !u.startsWith(`${NODE}/`));
}

function toGithub(seen: Seen[]): string[] {
    return seen.map((s) => s.url).filter((u) => {
        try {
            const host = new URL(u).hostname;
            return host === 'github.com' || host.endsWith('.github.com');
        } catch {
            return false;
        }
    });
}

const START = {
    sessionId: 'node-session-1',
    userCode: 'WXYZ-9876',
    verificationUri: 'https://github.com/login/device',
    expiresInSeconds: 900,
    intervalSeconds: 5,
};
const PENDING: Answer = { status: 200, body: { status: 'pending', intervalSeconds: 5 } };
const OK: Answer = { status: 200, body: { status: 'ok', sub: '987654', email: 'dev@example.com' } };
const NONCE: Answer = {
    status: 200,
    body: { nonce: 'node-nonce-1', expiresInSeconds: 600, providers: ['google', 'facebook', 'github'], githubFlow: 'node' },
};
const OUTAGE = 'GitHub could not be reached. Please try again in a minute.';

const MEMBER_START = '/api/recovery/sso/github/start';
const MEMBER_POLL = '/api/recovery/sso/github/poll';

function polls(seen: Seen[], path = MEMBER_POLL): Seen[] {
    return seen.filter((s) => s.path === path);
}

let originalFetch: typeof fetch;
beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
});

/** Start a member's GitHub sign-in and let `ms` of waiting pass. */
async function memberSignIn(ms: number, signal?: AbortSignal) {
    const prompts: Array<{ userCode: string; verificationUri: string }> = [];
    const outcome = startSsoSignIn('github', NODE, MEMBER, (p) => prompts.push(p), signal)
        .then((value) => ({ value, error: undefined as unknown }), (error) => ({ value: undefined, error }));
    await vi.advanceTimersByTimeAsync(ms);
    return { prompts, outcome };
}

describe("a member's GitHub sign-in runs through the node", () => {
    it('shows the code and address from the node, polls the node until ok, and never contacts GitHub', async () => {
        const seen = installNode({
            '/api/recovery/sso-nonce': NONCE,
            [MEMBER_START]: { status: 200, body: START },
            [MEMBER_POLL]: [PENDING, PENDING, OK],
        });

        const { prompts, outcome } = await memberSignIn(20_000);
        const { value, error } = await outcome;

        expect(error).toBeUndefined();
        expect(value).toEqual({ provider: 'github', sessionId: 'node-session-1', sub: '987654', email: 'dev@example.com' });
        // What the member is shown is exactly what the node answered.
        expect(prompts).toEqual([{ userCode: 'WXYZ-9876', verificationUri: 'https://github.com/login/device' }]);
        expect(polls(seen)).toHaveLength(3);
        for (const p of polls(seen)) expect(p.body).toEqual({ sessionId: 'node-session-1' });
        // No second nonce: GitHub's proof is the node's session, so there is nothing to re-mint.
        expect(seen.filter((s) => s.path === '/api/recovery/sso-nonce')).toHaveLength(1);
        expect(toGithub(seen)).toEqual([]);
        expect(offNode(seen)).toEqual([]);
    });

    it("waits the node's interval before each poll, and the longer one it answers after GitHub slows it down", async () => {
        const seen = installNode({
            '/api/recovery/sso-nonce': NONCE,
            [MEMBER_START]: { status: 200, body: START },
            [MEMBER_POLL]: [{ status: 200, body: { status: 'pending', intervalSeconds: 10 } }, OK],
        });
        const startedAt = Date.now();

        const { outcome } = await memberSignIn(30_000);
        expect((await outcome).error).toBeUndefined();

        const [first, second] = polls(seen);
        expect(first.at - startedAt).toBe(5_000);
        expect(second.at - first.at).toBe(10_000);
    });

    it('treats a poll answered 429 as still pending: waits Retry-After and polls again', async () => {
        const seen = installNode({
            '/api/recovery/sso-nonce': NONCE,
            [MEMBER_START]: { status: 200, body: START },
            [MEMBER_POLL]: [
                { status: 429, body: { error: 'Too many GitHub sign-in checks from this address. Try again in 7s' }, headers: { 'Retry-After': '7' } },
                OK,
            ],
        });

        const { outcome } = await memberSignIn(5_000);
        expect(polls(seen)).toHaveLength(1);
        // Not the 5 s interval: the node said 7.
        await vi.advanceTimersByTimeAsync(6_999);
        expect(polls(seen)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(polls(seen)).toHaveLength(2);

        const { value, error } = await outcome;
        expect(error).toBeUndefined();
        expect(value).toMatchObject({ provider: 'github', sessionId: 'node-session-1', sub: '987654' });
        const [first, second] = polls(seen);
        expect(second.at - first.at).toBe(7_000);
    });

    it('never fails a sign-in on 429s, however many: a sixth phone on one wifi just waits longer', async () => {
        const busy: Answer = { status: 429, body: { error: 'Too many' }, headers: { 'Retry-After': '60' } };
        const seen = installNode({
            '/api/recovery/sso-nonce': NONCE,
            [MEMBER_START]: { status: 200, body: START },
            [MEMBER_POLL]: [...Array.from({ length: 8 }, () => busy), OK],
        });

        const { outcome } = await memberSignIn(10 * 60_000);
        const { value, error } = await outcome;

        expect(error).toBeUndefined();
        expect(value).toMatchObject({ sessionId: 'node-session-1', sub: '987654' });
        expect(polls(seen)).toHaveLength(9);
    });

    it('waits the interval when a 429 carries no Retry-After', async () => {
        const seen = installNode({
            '/api/recovery/sso-nonce': NONCE,
            [MEMBER_START]: { status: 200, body: START },
            [MEMBER_POLL]: [{ status: 429, body: { error: 'Too many' } }, OK],
        });

        const { outcome } = await memberSignIn(20_000);
        expect((await outcome).error).toBeUndefined();
        const [first, second] = polls(seen);
        expect(second.at - first.at).toBe(5_000);
    });

    it('stops polling at once when the member cancels, and leaves the session to expire on the node', async () => {
        const seen = installNode({
            '/api/recovery/sso-nonce': NONCE,
            [MEMBER_START]: { status: 200, body: START },
            [MEMBER_POLL]: [PENDING],
        });
        const abort = new AbortController();

        const { outcome } = await memberSignIn(12_000, abort.signal);
        expect(polls(seen)).toHaveLength(2);
        abort.abort();
        const { error } = await outcome;

        expect(error).toBeInstanceOf(SsoSignInError);
        expect((error as SsoSignInError).reason).toBe('cancelled');
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(polls(seen)).toHaveLength(2);
        // Nothing asks the node to cancel: an unfinished session is not a proof, and it expires there.
        expect(seen.map((s) => s.path).filter((p) => ![MEMBER_START, MEMBER_POLL, '/api/recovery/sso-nonce'].includes(p))).toEqual([]);
    });

    it('a cancel while a poll is still in flight does not wait for it', async () => {
        installNode({
            '/api/recovery/sso-nonce': NONCE,
            [MEMBER_START]: { status: 200, body: START },
        });
        const abort = new AbortController();
        // Every poll hangs: the node never answers.
        const nodeFetch = globalThis.fetch;
        globalThis.fetch = vi.fn((input: any, init?: any) =>
            String(input).endsWith(MEMBER_POLL) ? new Promise<Response>(() => {}) : nodeFetch(input, init)) as any;

        const { outcome } = await memberSignIn(6_000, abort.signal);
        abort.abort();
        const { error } = await outcome;

        expect((error as SsoSignInError).reason).toBe('cancelled');
    });

    it('reads denied as a cancel, not an error', async () => {
        installNode({
            '/api/recovery/sso-nonce': NONCE,
            [MEMBER_START]: { status: 200, body: START },
            [MEMBER_POLL]: [PENDING, { status: 200, body: { status: 'denied' } }],
        });

        const { outcome } = await memberSignIn(20_000);
        const { error } = await outcome;

        expect(error).toBeInstanceOf(SsoSignInError);
        expect((error as SsoSignInError).reason).toBe('cancelled');
        expect((error as Error).message).toBe('Sign-in was cancelled.');
    });

    it('says plainly that the code ran out when the node answers expired', async () => {
        installNode({
            '/api/recovery/sso-nonce': NONCE,
            [MEMBER_START]: { status: 200, body: START },
            [MEMBER_POLL]: [{ status: 200, body: { status: 'expired' } }],
        });

        const { outcome } = await memberSignIn(6_000);
        const { error } = await outcome;

        expect((error as SsoSignInError).reason).toBe('provider');
        expect((error as Error).message).toBe('The GitHub code ran out before it was entered. Try again.');
    });

    it("gives the node's try-again message when GitHub is out (503) at the start, and polls nothing", async () => {
        const seen = installNode({
            '/api/recovery/sso-nonce': NONCE,
            [MEMBER_START]: { status: 503, body: { error: OUTAGE, code: 'sign_in_unavailable' } },
        });

        const { prompts, outcome } = await memberSignIn(60_000);
        const { error } = await outcome;

        expect((error as SsoSignInError).reason).toBe('provider');
        expect((error as Error).message).toBe(OUTAGE);
        expect(prompts).toEqual([]);
        expect(polls(seen)).toEqual([]);
    });

    it("gives the node's try-again message when a poll is answered with the outage (503)", async () => {
        const seen = installNode({
            '/api/recovery/sso-nonce': NONCE,
            [MEMBER_START]: { status: 200, body: START },
            [MEMBER_POLL]: [PENDING, { status: 503, body: { error: OUTAGE, code: 'sign_in_unavailable' } }],
        });

        const { outcome } = await memberSignIn(60_000);
        const { error } = await outcome;

        expect((error as SsoSignInError).reason).toBe('provider');
        expect((error as Error).message).toBe(OUTAGE);
        expect(polls(seen)).toHaveLength(2);
    });

    it('keeps waiting through a dropped poll: no answer is not a failed sign-in', async () => {
        const seen = installNode({
            '/api/recovery/sso-nonce': NONCE,
            [MEMBER_START]: { status: 200, body: START },
            [MEMBER_POLL]: [{ status: 502, body: {} }, OK],
        });
        const nodeFetch = globalThis.fetch;
        let dropped = false;
        globalThis.fetch = vi.fn((input: any, init?: any) => {
            if (!dropped && String(input).endsWith(MEMBER_POLL)) {
                dropped = true;
                return Promise.reject(new TypeError('Network request failed'));
            }
            return nodeFetch(input, init);
        }) as any;

        const { outcome } = await memberSignIn(30_000);
        const { value, error } = await outcome;

        expect(error).toBeUndefined();
        expect(value).toMatchObject({ sessionId: 'node-session-1', sub: '987654' });
        // The network error, then a gateway 502 while the node was briefly unreachable, then ok.
        expect(polls(seen)).toHaveLength(2);
    });

    it("refuses on a node that does not run GitHub sign-in itself, with the update message, and asks GitHub nothing", async () => {
        const { githubFlow: _dropped, ...oldNode } = NONCE.body as Record<string, unknown>;
        const seen = installNode({
            '/api/recovery/sso-nonce': { status: 200, body: oldNode },
            [MEMBER_START]: { status: 200, body: START },
        });

        const { prompts, outcome } = await memberSignIn(60_000);
        const { error } = await outcome;

        expect(error).toBeInstanceOf(SsoSignInError);
        expect((error as SsoSignInError).reason).toBe('unsupported');
        expect((error as Error).message).toBe(GITHUB_UPDATE_MESSAGE);
        expect(prompts).toEqual([]);
        expect(seen.map((s) => s.path)).toEqual(['/api/recovery/sso-nonce']);
        expect(toGithub(seen)).toEqual([]);
        expect(offNode(seen)).toEqual([]);
    });

    it("says what the node said when it will not start one (GitHub's device flow switched off)", async () => {
        installNode({
            '/api/recovery/sso-nonce': NONCE,
            [MEMBER_START]: { status: 400, body: { error: 'GitHub sign-in is not enabled for this app yet.' } },
        });

        const { outcome } = await memberSignIn(1_000);
        const { error } = await outcome;

        expect(error).toBeInstanceOf(SsoSignInError);
        expect((error as Error).message).toContain('GitHub sign-in is not enabled for this app yet.');
    });

    it('refuses an ok that names no GitHub user, since the seed is sealed to that id', async () => {
        installNode({
            '/api/recovery/sso-nonce': NONCE,
            [MEMBER_START]: { status: 200, body: START },
            [MEMBER_POLL]: [{ status: 200, body: { status: 'ok', email: 'dev@example.com' } }],
        });

        const { outcome } = await memberSignIn(6_000);
        const { error } = await outcome;

        expect((error as SsoSignInError).reason).toBe('provider');
        expect((error as Error).message).toContain('did not return a user id');
    });

    it('opens only GitHub\'s own page: a start answer pointing anywhere else is refused before the member sees it', async () => {
        installNode({
            '/api/recovery/sso-nonce': NONCE,
            [MEMBER_START]: { status: 200, body: { ...START, verificationUri: 'https://github.com.evil.example/login/device' } },
        });

        const { prompts, outcome } = await memberSignIn(1_000);
        const { error } = await outcome;

        expect(error).toBeInstanceOf(SsoSignInError);
        expect(prompts).toEqual([]);
    });

    // A node is run by someone else. Any github.com page would let one send a member mid-sign-in to
    // another app's "Authorize" button, or to a repo page with instructions to paste their 12 words.
    it.each([
        'https://github.com/login/oauth/authorize?client_id=Iv1.attacker&scope=repo',
        'https://github.com/someone/some-repo#paste-your-12-words-here',
        'https://github.com/login/device/../../someone/some-repo',
    ])('opens only the device page itself, not another github.com page: %s', async (verificationUri) => {
        installNode({
            '/api/recovery/sso-nonce': NONCE,
            [MEMBER_START]: { status: 200, body: { ...START, verificationUri } },
        });

        const { prompts, outcome } = await memberSignIn(1_000);
        const { error } = await outcome;

        expect(error).toBeInstanceOf(SsoSignInError);
        expect(prompts).toEqual([]);
    });
});

// ---------------------------------------------------------------------------------------------------
// Recovery: the recovering device's ephemeral key is the subject, the collection id rides every call.
// ---------------------------------------------------------------------------------------------------

const COLLECT_START = '/api/recovery/collect/github/start';
const COLLECT_POLL = '/api/recovery/collect/github/poll';

async function recoveryNode(opts: { githubFlow?: string; routes?: Record<string, Route> } = {}) {
    const seed = new Uint8Array(32).fill(42);
    const keypair = await seedToKeypair(seed);
    const sealed = await sealSeedToSso(seed, 'github', '987654');
    const nonceBody: Record<string, unknown> = { nonce: 'eph-nonce-1', expiresInSeconds: 600 };
    if (opts.githubFlow) nonceBody.githubFlow = opts.githubFlow;
    const seen = installNode({
        '/api/recovery/collect': { status: 200, body: { collectionId: 'coll-gh-1', generation: 1, threshold: 1 } },
        '/api/recovery/collect/sso-nonce': { status: 200, body: nonceBody },
        [COLLECT_START]: { status: 200, body: START },
        [COLLECT_POLL]: [PENDING, OK],
        '/api/recovery/collect/sso': { status: 200, body: { collected: 1, threshold: 1, enough: true } },
        '/api/recovery/collect/fragments': {
            status: 200,
            body: {
                fragments: [{
                    holderType: 'sso', shareIndex: 1,
                    payload: sealed.encryptedShare, payloadIv: sealed.shareIv, payloadTag: sealed.shareTag,
                    kdfParams: sealed.kdfParams,
                }],
            },
        },
        ...opts.routes,
    });
    return { seen, keypair };
}

const RELEASE = '/api/recovery/collect/sso';

/**
 * The member taps Cancel just as the node's `ok` arrives: the app has the answer and has not acted on it
 * yet. The poll itself is over by then, so only a check after the sign-in can see the cancel.
 */
function cancelOnOk(abort: AbortController, pollPath: string): void {
    const nodeFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: any, init?: any) => {
        const res = await nodeFetch(input, init);
        if (!String(input).endsWith(pollPath)) return res;
        const body = await res.json();
        return {
            ...res,
            json: async () => {
                if (body?.status === 'ok') abort.abort();
                return body;
            },
        };
    }) as any;
}

describe('recovering with GitHub runs through the node', () => {
    it('shows the node\'s code, polls the node, and releases with proof: { sessionId } — no token, no nonce, no GitHub', async () => {
        const { seen, keypair } = await recoveryNode({ githubFlow: 'node' });
        const shown: Array<{ userCode: string; verificationUri: string }> = [];

        const outcome = recoverAccountWithSso({
            callsign: 'member',
            anchorUrl: NODE,
            provider: 'github',
            onDeviceCode: (p) => shown.push(p),
        }).then((value) => ({ value, error: undefined as unknown }), (error) => ({ value: undefined, error }));
        await vi.advanceTimersByTimeAsync(20_000);
        const { value, error } = await outcome;

        expect(error).toBeUndefined();
        expect(value?.identity.publicKey).toBe(keypair.publicKeyHex);
        expect(value?.provider).toBe('github');
        expect(shown).toEqual([{ userCode: 'WXYZ-9876', verificationUri: 'https://github.com/login/device' }]);

        expect(seen.find((s) => s.path === COLLECT_START)?.body).toEqual({ collectionId: 'coll-gh-1' });
        for (const p of polls(seen, COLLECT_POLL)) {
            expect(p.body).toEqual({ collectionId: 'coll-gh-1', sessionId: 'node-session-1' });
        }
        const release = seen.find((s) => s.path === '/api/recovery/collect/sso')?.body;
        expect(release).toEqual({ collectionId: 'coll-gh-1', provider: 'github', proof: { sessionId: 'node-session-1' } });
        expect(release).not.toHaveProperty('idToken');
        expect(release).not.toHaveProperty('nonce');
        // One nonce request (which is where the node says it runs GitHub itself), and no re-mint.
        expect(seen.filter((s) => s.path === '/api/recovery/collect/sso-nonce')).toHaveLength(1);
        expect(toGithub(seen)).toEqual([]);
        expect(offNode(seen)).toEqual([]);
    });

    it('refuses on a node that does not run GitHub sign-in itself, with the update message, before starting anything', async () => {
        const { seen } = await recoveryNode();
        const shown: unknown[] = [];

        const outcome = recoverAccountWithSso({
            callsign: 'member',
            anchorUrl: NODE,
            provider: 'github',
            onDeviceCode: (p) => shown.push(p),
        }).then(() => undefined, (error) => error);
        await vi.advanceTimersByTimeAsync(60_000);
        const error = await outcome;

        expect(error).toBeInstanceOf(SsoSignInError);
        expect((error as SsoSignInError).reason).toBe('unsupported');
        expect((error as Error).message).toBe(GITHUB_UPDATE_MESSAGE);
        expect(shown).toEqual([]);
        expect(seen.map((s) => s.path)).not.toContain(COLLECT_START);
        expect(seen.map((s) => s.path)).not.toContain('/api/recovery/collect/sso');
        expect(toGithub(seen)).toEqual([]);
    });

    it('stops when the member cancels while waiting for GitHub', async () => {
        const { seen } = await recoveryNode({ githubFlow: 'node' });
        const abort = new AbortController();

        const outcome = recoverAccountWithSso({
            callsign: 'member',
            anchorUrl: NODE,
            provider: 'github',
            onDeviceCode: () => {},
            signal: abort.signal,
        }).then(() => undefined, (error) => error);
        await vi.advanceTimersByTimeAsync(1_000);
        abort.abort();
        const error = await outcome;
        await vi.advanceTimersByTimeAsync(10 * 60_000);

        expect((error as SsoSignInError).reason).toBe('cancelled');
        expect(polls(seen, COLLECT_POLL)).toHaveLength(0);
        expect(seen.map((s) => s.path)).not.toContain('/api/recovery/collect/sso');
    });

    // welcome.tsx shows the code, Copy, Open GitHub and Cancel while recovery waits on GitHub. Left up
    // after GitHub said yes, they hid the steps that followed, and Cancel did nothing: the piece was
    // released and this phone's identity replaced all the same.
    it('takes the code and its Cancel down once GitHub says yes, before anything is released, and shows the steps after', async () => {
        let panel: unknown = null;
        let panelWhenReleased: unknown = 'never released';
        const { seen, keypair } = await recoveryNode({
            githubFlow: 'node',
            routes: {
                [RELEASE]: () => {
                    panelWhenReleased = panel;
                    return { status: 200, body: { collected: 1, threshold: 1, enough: true } };
                },
            },
        });
        vi.mocked(SecureStore.setItemAsync).mockClear();
        const steps: Array<{ step: string; message: string; panelUp: boolean }> = [];

        const outcome = recoverAccountWithSso({
            callsign: 'member',
            anchorUrl: NODE,
            provider: 'github',
            // As welcome.tsx drives its panel: up with the code, down at the first step past GitHub.
            onDeviceCode: (p) => { panel = p; },
            onProgress: (p) => {
                if (!waitingOnGithub(p.step)) panel = null;
                steps.push({ step: p.step, message: p.message, panelUp: panel !== null });
            },
        }).then((value) => ({ value, error: undefined as unknown }), (error) => ({ value: undefined, error }));
        await vi.advanceTimersByTimeAsync(20_000);
        const { value, error } = await outcome;

        expect(error).toBeUndefined();
        expect(value?.identity.publicKey).toBe(keypair.publicKeyHex);
        expect(SecureStore.setItemAsync).toHaveBeenCalled();
        // Up while the member is at GitHub, and already down when the node was asked to release.
        expect(steps.find((s) => s.step === 'awaiting-sso')?.panelUp).toBe(true);
        expect(polls(seen, COLLECT_POLL)).toHaveLength(2);
        expect(panelWhenReleased).toBeNull();
        const afterGithub = steps.slice(steps.findIndex((s) => s.step === 'awaiting-sso') + 1);
        expect(afterGithub.map((s) => s.message)).toEqual([
            'Verifying sign-in with node...',
            'Downloading recovery fragments...',
            'Reconstructing account identity...',
            'Account restored successfully!',
        ]);
        expect(afterGithub.filter((s) => s.panelUp)).toEqual([]);
    });

    it("honours a cancel that lands after GitHub's yes but before the release: nothing released, this phone's identity untouched", async () => {
        const { seen } = await recoveryNode({ githubFlow: 'node' });
        const abort = new AbortController();
        cancelOnOk(abort, COLLECT_POLL);
        vi.mocked(SecureStore.setItemAsync).mockClear();
        vi.mocked(AsyncStorage.setItem).mockClear();

        const outcome = recoverAccountWithSso({
            callsign: 'member',
            anchorUrl: NODE,
            provider: 'github',
            onDeviceCode: () => {},
            signal: abort.signal,
        }).then(() => undefined, (error) => error);
        await vi.advanceTimersByTimeAsync(20_000);
        const error = await outcome;

        expect(abort.signal.aborted).toBe(true);
        expect(polls(seen, COLLECT_POLL)).toHaveLength(2);
        expect(error).toBeInstanceOf(SsoSignInError);
        expect((error as SsoSignInError).reason).toBe('cancelled');
        expect(seen.map((s) => s.path)).not.toContain(RELEASE);
        expect(seen.map((s) => s.path)).not.toContain('/api/recovery/collect/fragments');
        expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
        expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    });
});

// The screen cannot be rendered here (see vitest.config.ts). The panel above is driven by the function
// welcome.tsx calls; this checks that it does call it.
describe('app/welcome.tsx', () => {
    it('takes the GitHub code and its Cancel down at the first recovery step past GitHub', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../app/welcome.tsx'), 'utf-8');
        expect(src).toMatch(/if \(!waitingOnGithub\(p\.step\)\) setRecoveryCode\(null\)/);
    });
});

/**
 * Facebook sign-in sends only Facebook's signed ID token (A2b).
 *
 * Since S1 (#1113) the node takes Facebook only as an OIDC id_token it can verify: RS256 against Facebook's JWKS,
 * the issuer, our app id as the audience, and the nonce the node issued. An access token proves nothing a node can
 * check without the app secret, so the node refuses one. The app used to fall back to the access token when no
 * id_token came back, and to ask Graph `/me` for the member's id with it. Now it reads the id_token and nothing else,
 * refuses before anything goes to the node a return without one, with another attempt's state, or with a token that
 * does not carry this attempt's nonce, and never asks Graph.
 *
 * MEASURED 2026-09-25 (Marty, desktop Chrome, the exact request the phone sends): the return's fragment carries
 * access_token, data_access_expiration_time, expires_in, id_token (RS256, iss https://www.facebook.com, aud our app
 * id, nonce echoed verbatim), long_lived_token and state. The fixtures below have that shape.
 *
 * Nothing here contacts a node or Facebook. `node-post` and the request signing are real, so every request the app
 * makes goes through the `fetch` stub, which plays the node and refuses (and records) anything addressed elsewhere.
 * That is what lets these tests say "no request to graph.facebook.com" rather than "the function we mocked was not
 * called".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openShareFromSso, sealSeedToSso } from '@beanpool/core';

(globalThis as any).__DEV__ = false;

const rn = vi.hoisted(() => ({
    linkingListeners: [] as Array<(e: { url: string }) => void>,
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
}));
vi.mock('expo-linking', () => ({
    addEventListener: vi.fn((_name: string, fn: (e: { url: string }) => void) => {
        rn.linkingListeners.push(fn);
        return { remove: vi.fn() };
    }),
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
        // The member's node, which the deposit goes to.
        getItem: vi.fn(async (key: string) => (key === 'beanpool_anchor_url' ? 'https://test.example' : null)),
        setItem: vi.fn(async () => undefined),
        removeItem: vi.fn(async () => undefined),
    },
}));
vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(async () => null),
    setItemAsync: vi.fn(async () => undefined),
    deleteItemAsync: vi.fn(async () => undefined),
}));

import * as WebBrowser from 'expo-web-browser';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { FACEBOOK_APP_ID, SsoSignInError, startSsoSignIn } from '../sso-signin';
import { connectAndDeposit } from '../sso-sheet-connect';
import { recoverAccountWithSso } from '../sso-recovery';
import { seedToKeypair } from '../crypto';

const NODE = 'https://test.example';
const MEMBER_NONCE = 'bWVtYmVyLW5vbmNlLWZvci10aGlzLWZhY2Vib29rLWF0dGVtcHQ';
const RECOVERY_NONCE = 'cmVjb3Zlcnktbm9uY2UtZm9yLXRoaXMtZmFjZWJvb2stYXR0ZW1wdA';
const FB_SUB = '10229876543210987';
const FB_EMAIL = 'member@example.com';
const ACCESS_TOKEN = 'EAALoNLYaccessTOKENtheAppMustNeverKeep1';
const LONG_LIVED_TOKEN = 'EAALoNLYlongLivedTOKENtheAppMustNeverKeep2';
const PLAIN = "Facebook didn't finish the sign-in. Try again, or choose another way.";

const NONCE_PATH = '/api/recovery/sso-nonce';
const DEPOSIT = '/api/recovery/shares/sso';
const RELEASE = '/api/recovery/collect/sso';

const MEMBER = {
    publicKey: 'aa'.repeat(32),
    privateKey: '07'.repeat(32),
    callsign: 'member',
    createdAt: '2026-09-25T00:00:00Z',
    mnemonic: 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' '),
} as any;

/** A Facebook OIDC id_token's shape. Unsigned: nothing here verifies signatures, the node does. */
function fbIdToken(overrides: Record<string, unknown> = {}): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const claims: Record<string, unknown> = {
        iss: 'https://www.facebook.com',
        aud: FACEBOOK_APP_ID,
        sub: FB_SUB,
        email: FB_EMAIL,
        iat: 1790000000,
        exp: 1790003600,
        jti: 'fb-jti-1',
        nonce: MEMBER_NONCE,
        ...overrides,
    };
    for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
    return `${b64({ alg: 'RS256', kid: 'fb-kid-1', typ: 'JWT' })}.${b64(claims)}.c2lnbmF0dXJl`;
}

/** Facebook's return to the verified App Link, everything in the fragment. */
function fbReturn(fields: Record<string, string>): string {
    return `https://beanpool.org/auth/facebook#${new URLSearchParams(fields).toString()}`;
}

/** The return as measured: the id_token, and the access and long-lived tokens beside it. */
function measuredReturn(nonce: string, idToken = fbIdToken({ nonce })): string {
    return fbReturn({
        access_token: ACCESS_TOKEN,
        data_access_expiration_time: '1798000000',
        expires_in: '5184000',
        id_token: idToken,
        long_lived_token: LONG_LIVED_TOKEN,
        state: nonce,
    });
}

/** Facebook's cancel, as the dialog sends it (auth-return.test.ts has the same shape). */
function cancelReturn(nonce: string): string {
    return `https://beanpool.org/auth/facebook?error=access_denied&error_code=200&error_description=Permissions+error&error_reason=user_denied&state=${nonce}#_=_`;
}

// ---------------------------------------------------------------------------------------------------
// The node, and everything the app sends, stores or logs.
// ---------------------------------------------------------------------------------------------------

type Answer = { status: number; body?: unknown };
interface Seen { url: string; path: string; body: any; headers: unknown }

function answer({ status, body = {} }: Answer): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(),
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

/** Play the node. A request to any other host is recorded and fails as a network error would. */
function installNode(routes: Record<string, Answer>): Seen[] {
    const seen: Seen[] = [];
    globalThis.fetch = vi.fn(async (input: any, init?: any) => {
        const url = String(input);
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        const p = url.startsWith(NODE) ? url.slice(NODE.length) : url;
        seen.push({ url, path: p, body, headers: init?.headers });
        if (!url.startsWith(`${NODE}/`)) throw new TypeError(`Network request failed: the app contacted ${url}`);
        const route = routes[p];
        return answer(route ?? { status: 404, body: { error: 'Not Found' } });
    }) as any;
    return seen;
}

function toFacebook(seen: Seen[]): string[] {
    return seen.map((s) => s.url).filter((u) => {
        try {
            const host = new URL(u).hostname;
            return host === 'facebook.com' || host.endsWith('.facebook.com');
        } catch {
            return false;
        }
    });
}

function offNode(seen: Seen[]): string[] {
    return seen.map((s) => s.url).filter((u) => !u.startsWith(`${NODE}/`));
}

function logged(): string[] {
    const spies = [console.log, console.warn, console.error, console.info] as unknown as Array<{ mock?: { calls: unknown[][] } }>;
    return spies.flatMap((spy) => spy.mock?.calls ?? []).map((args) => args.map((a) => (
        a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : JSON.stringify(a)
    )).join(' '));
}

/** Everything the app sent, stored or logged, as one string to search for the tokens it must not keep. */
function everythingKeptOrSent(seen: Seen[], ...extra: unknown[]): string {
    return JSON.stringify([
        seen.map((s) => [s.url, s.body, s.headers]),
        vi.mocked(AsyncStorage.setItem).mock.calls,
        vi.mocked(SecureStore.setItemAsync).mock.calls,
        logged(),
        extra,
    ]);
}

function expectNoAccessOrLongLivedToken(seen: Seen[], ...extra: unknown[]): void {
    const all = everythingKeptOrSent(seen, ...extra);
    expect(all).not.toContain(ACCESS_TOKEN);
    expect(all).not.toContain(LONG_LIVED_TOKEN);
}

/** The Custom Tab closes on Facebook's return (iOS, or an Android tab that survived). */
function facebookReturns(url: string): void {
    vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValueOnce({ type: 'success', url } as any);
}

/**
 * Android: the verified `beanpool.org/auth/facebook` App Link brings the app forward over the Custom Tab, which then
 * reports a cancel it did not mean. The links arrive as Linking events, in order.
 */
function facebookReturnsByAppLink(...urls: string[]): void {
    vi.mocked(WebBrowser.openAuthSessionAsync).mockImplementationOnce(async () => {
        for (const url of urls) rn.linkingListeners.forEach((fn) => fn({ url }));
        return { type: 'cancel' } as any;
    });
}

async function settle<T>(p: Promise<T>, ms = 10_000): Promise<{ value?: T; error?: unknown }> {
    const out = p.then((value) => ({ value, error: undefined as unknown }), (error) => ({ value: undefined, error }));
    await vi.advanceTimersByTimeAsync(ms);
    return out;
}

let originalFetch: typeof fetch;
beforeEach(() => {
    originalFetch = globalThis.fetch;
    rn.linkingListeners.length = 0;
    vi.useFakeTimers();
    vi.mocked(WebBrowser.openAuthSessionAsync).mockReset();
    vi.mocked(AsyncStorage.setItem).mockClear();
    vi.mocked(SecureStore.setItemAsync).mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------------------------------
// What the phone asks Facebook for.
// ---------------------------------------------------------------------------------------------------

describe("Facebook's dialog is asked for an id_token bound to this attempt", () => {
    it("carries our app id, the beanpool.org return, openid and email, and the node's nonce as both nonce and state", async () => {
        installNode({ [NONCE_PATH]: { status: 200, body: { nonce: MEMBER_NONCE, providers: ['facebook'] } } });
        facebookReturns(measuredReturn(MEMBER_NONCE));

        await settle(startSsoSignIn('facebook', NODE, MEMBER));

        const [authUrl, completionUri] = vi.mocked(WebBrowser.openAuthSessionAsync).mock.calls[0];
        const u = new URL(authUrl);
        expect(`${u.origin}${u.pathname}`).toBe('https://www.facebook.com/v20.0/dialog/oauth');
        expect(u.searchParams.get('client_id')).toBe(FACEBOOK_APP_ID);
        expect(u.searchParams.get('redirect_uri')).toBe('https://beanpool.org/auth/facebook');
        expect(u.searchParams.get('scope')).toBe('openid,email');
        expect(u.searchParams.get('nonce')).toBe(MEMBER_NONCE);
        expect(u.searchParams.get('state')).toBe(MEMBER_NONCE);
        // `token,id_token` is the request Marty measured returning a nonce-bearing id_token (2026-09-25). Facebook's
        // manual-flow page documents only `code`, `token` and `code token`, and nothing documents `id_token` alone, so
        // the smaller grant stays unasked until someone measures it. The access token that comes back is never read.
        expect(u.searchParams.get('response_type')).toBe('token,id_token');
        expect(completionUri).toBe('beanpool://auth/facebook');
    });
});

// ---------------------------------------------------------------------------------------------------
// Enrolment: the protection sheet's connect (sso-sheet-connect.ts, called by SsoEnrolSheet).
// ---------------------------------------------------------------------------------------------------

function enrolNode(): Seen[] {
    return installNode({
        [NONCE_PATH]: { status: 200, body: { nonce: MEMBER_NONCE, expiresInSeconds: 600, providers: ['google', 'facebook', 'github'] } },
        [DEPOSIT]: { status: 200, body: { generation: 1, enrolledSso: ['facebook'], threshold: 1 } },
    });
}

function protectWithFacebook() {
    return connectAndDeposit({
        provider: 'facebook',
        url: NODE,
        identity: MEMBER,
        // The phone's lock is sign-in-link-behind-lock.test.ts's: this is about the Facebook token.
        phoneLock: null,
        onGithubPrompt: () => {},
        onSignedIn: () => {},
        signal: new AbortController().signal,
    });
}

/** Refused on the phone: the node was asked for a nonce and for nothing after it. */
function expectNothingSentAfterTheNonce(seen: Seen[]): void {
    expect(seen.map((s) => s.path)).toEqual([NONCE_PATH]);
}

describe('protecting an account with Facebook sends the node only the id_token', () => {
    it("deposits with the id_token and the nonce, sealed to the token's sub, and asks Graph nothing", async () => {
        const seen = enrolNode();
        const idToken = fbIdToken({ nonce: MEMBER_NONCE });
        facebookReturns(measuredReturn(MEMBER_NONCE, idToken));

        const { value, error } = await settle(protectWithFacebook());

        expect(error).toBeUndefined();
        expect(value?.error).toBeUndefined();
        expect(value?.enrolledSso).toEqual(['facebook']);

        const deposit = seen.find((s) => s.path === DEPOSIT)?.body;
        expect(Object.keys(deposit).sort()).toEqual(['idToken', 'nonce', 'provider', 'shares']);
        expect(deposit.provider).toBe('facebook');
        expect(deposit.idToken).toBe(idToken);
        expect(deposit.nonce).toBe(MEMBER_NONCE);
        // Sealed to the sub the id_token names, which is what the node reads from it when it verifies.
        const [share] = deposit.shares;
        const seed = await openShareFromSso(
            { encryptedShare: share.encryptedShare, shareIv: share.shareIv, shareTag: share.shareTag, kdfParams: share.kdfParams },
            'facebook',
            FB_SUB,
        );
        expect(Buffer.from(seed).toString('hex')).toBe(MEMBER.privateKey);

        expect(toFacebook(seen)).toEqual([]);
        expect(offNode(seen)).toEqual([]);
        expectNoAccessOrLongLivedToken(seen, value);
    });

    it('the sign-in hands back the id_token, the nonce and the email, and nothing else from the return', async () => {
        enrolNode();
        const idToken = fbIdToken({ nonce: MEMBER_NONCE });
        facebookReturns(measuredReturn(MEMBER_NONCE, idToken));

        const { value, error } = await settle(startSsoSignIn('facebook', NODE, MEMBER));

        expect(error).toBeUndefined();
        expect(value).toEqual({ provider: 'facebook', idToken, nonce: MEMBER_NONCE, email: FB_EMAIL });
    });

    it('refuses a return with only an access token, with the plain message, and sends the node nothing', async () => {
        const seen = enrolNode();
        facebookReturns(fbReturn({
            access_token: ACCESS_TOKEN,
            expires_in: '5184000',
            long_lived_token: LONG_LIVED_TOKEN,
            state: MEMBER_NONCE,
        }));

        const { value, error } = await settle(protectWithFacebook());

        expect(value).toBeUndefined();
        expect(error).toBeInstanceOf(SsoSignInError);
        expect(error).toMatchObject({ reason: 'no-token', message: PLAIN });
        expectNothingSentAfterTheNonce(seen);
        expect(toFacebook(seen)).toEqual([]);
        expectNoAccessOrLongLivedToken(seen);
    });

    it("refuses a token carrying another attempt's nonce, before the node sees it", async () => {
        const seen = enrolNode();
        facebookReturns(measuredReturn(MEMBER_NONCE, fbIdToken({ nonce: 'another-attempts-nonce' })));

        const { error } = await settle(protectWithFacebook());

        expect(error).toBeInstanceOf(SsoSignInError);
        expect(error).toMatchObject({ reason: 'provider', message: PLAIN });
        expectNothingSentAfterTheNonce(seen);
        expectNoAccessOrLongLivedToken(seen);
    });

    it('refuses a token whose nonce is only a hash of ours: Facebook echoes it verbatim, and the node wants it so', async () => {
        const seen = enrolNode();
        const hashed = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(MEMBER_NONCE))).toString('hex');
        facebookReturns(measuredReturn(MEMBER_NONCE, fbIdToken({ nonce: hashed })));

        const { error } = await settle(protectWithFacebook());

        expect(error).toMatchObject({ reason: 'provider', message: PLAIN });
        expectNothingSentAfterTheNonce(seen);
    });

    it('refuses a token with no nonce at all', async () => {
        const seen = enrolNode();
        facebookReturns(measuredReturn(MEMBER_NONCE, fbIdToken({ nonce: undefined })));

        const { error } = await settle(protectWithFacebook());

        expect(error).toMatchObject({ reason: 'provider', message: PLAIN });
        expectNothingSentAfterTheNonce(seen);
    });

    it('refuses an id_token that is not a JWT, and does not ask Graph who it belongs to', async () => {
        const seen = enrolNode();
        facebookReturns(fbReturn({ id_token: ACCESS_TOKEN, state: MEMBER_NONCE }));

        const { error } = await settle(protectWithFacebook());

        expect(error).toBeInstanceOf(SsoSignInError);
        expect(error).toMatchObject({ message: PLAIN });
        expectNothingSentAfterTheNonce(seen);
        expect(toFacebook(seen)).toEqual([]);
        expectNoAccessOrLongLivedToken(seen);
    });

    it("reads Facebook's cancel as a quiet cancel", async () => {
        const seen = enrolNode();
        facebookReturns(cancelReturn(MEMBER_NONCE));

        const { error } = await settle(protectWithFacebook());

        expect(error).toBeInstanceOf(SsoSignInError);
        expect(error).toMatchObject({ reason: 'cancelled', message: 'Sign-in was cancelled.' });
        expectNothingSentAfterTheNonce(seen);
    });

    it('reads any other error from Facebook as the plain message', async () => {
        const seen = enrolNode();
        facebookReturns(`https://beanpool.org/auth/facebook?error=server_error&error_description=Something+went+wrong&state=${MEMBER_NONCE}#_=_`);

        const { error } = await settle(protectWithFacebook());

        expect(error).toMatchObject({ reason: 'provider', message: PLAIN });
        expectNothingSentAfterTheNonce(seen);
    });

    it("ignores a return carrying another attempt's state: the browser closing is then a cancel", async () => {
        const seen = enrolNode();
        facebookReturns(measuredReturn('an-earlier-attempts-nonce'));

        const { error } = await settle(protectWithFacebook());

        expect(error).toMatchObject({ reason: 'cancelled' });
        expectNothingSentAfterTheNonce(seen);
        expectNoAccessOrLongLivedToken(seen);
    });

    it('ignores a return with no state, like a foreign one', async () => {
        const seen = enrolNode();
        facebookReturns(fbReturn({ access_token: ACCESS_TOKEN, id_token: fbIdToken({ nonce: MEMBER_NONCE }) }));

        const { error } = await settle(protectWithFacebook());

        expect(error).toMatchObject({ reason: 'cancelled' });
        expectNothingSentAfterTheNonce(seen);
    });

    it("Android: takes this attempt's id_token from the App Link, past a stale one, while the Custom Tab reports a cancel", async () => {
        const seen = enrolNode();
        const idToken = fbIdToken({ nonce: MEMBER_NONCE });
        facebookReturnsByAppLink(
            measuredReturn('an-earlier-attempts-nonce'),
            measuredReturn(MEMBER_NONCE, idToken),
        );

        const { value, error } = await settle(protectWithFacebook());

        expect(error).toBeUndefined();
        expect(value?.enrolledSso).toEqual(['facebook']);
        const deposit = seen.find((s) => s.path === DEPOSIT)?.body;
        expect(deposit.idToken).toBe(idToken);
        expect(deposit.nonce).toBe(MEMBER_NONCE);
        expect(offNode(seen)).toEqual([]);
        expectNoAccessOrLongLivedToken(seen, value);
    });
});

// ---------------------------------------------------------------------------------------------------
// Recovery: a recovering device's ephemeral key, releasing the piece sealed to Facebook.
// ---------------------------------------------------------------------------------------------------

async function recoveryNode() {
    const seed = new Uint8Array(32).fill(42);
    const keypair = await seedToKeypair(seed);
    const sealed = await sealSeedToSso(seed, 'facebook', FB_SUB);
    const seen = installNode({
        '/api/recovery/collect': { status: 200, body: { collectionId: 'coll-fb-1', generation: 1, threshold: 1 } },
        '/api/recovery/collect/sso-nonce': { status: 200, body: { nonce: RECOVERY_NONCE, expiresInSeconds: 600 } },
        [RELEASE]: { status: 200, body: { collected: 1, threshold: 1, enough: true } },
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
    });
    return { seen, keypair };
}

function recoverWithFacebook() {
    return recoverAccountWithSso({ callsign: 'member', anchorUrl: NODE, provider: 'facebook', onDeviceCode: () => {} });
}

const BEFORE_THE_RELEASE = ['/api/recovery/collect', '/api/recovery/collect/sso-nonce'];

describe('recovering with Facebook releases against the id_token only', () => {
    it("releases with the id_token and the nonce, opens the piece with the token's sub, and asks Graph nothing", async () => {
        const { seen, keypair } = await recoveryNode();
        const idToken = fbIdToken({ nonce: RECOVERY_NONCE });
        facebookReturns(measuredReturn(RECOVERY_NONCE, idToken));

        const { value, error } = await settle(recoverWithFacebook());

        expect(error).toBeUndefined();
        expect(value?.identity.publicKey).toBe(keypair.publicKeyHex);
        expect(seen.find((s) => s.path === RELEASE)?.body)
            .toEqual({ collectionId: 'coll-fb-1', provider: 'facebook', idToken, nonce: RECOVERY_NONCE });
        expect(toFacebook(seen)).toEqual([]);
        expect(offNode(seen)).toEqual([]);
        expect(SecureStore.setItemAsync).toHaveBeenCalled();
        expectNoAccessOrLongLivedToken(seen, value);
    });

    it('refuses a return with only an access token, with the plain message, and releases nothing', async () => {
        const { seen } = await recoveryNode();
        facebookReturns(fbReturn({ access_token: ACCESS_TOKEN, long_lived_token: LONG_LIVED_TOKEN, state: RECOVERY_NONCE }));

        const { error } = await settle(recoverWithFacebook());

        expect(error).toMatchObject({ reason: 'no-token', message: PLAIN });
        expect(seen.map((s) => s.path)).toEqual(BEFORE_THE_RELEASE);
        expect(toFacebook(seen)).toEqual([]);
        expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
        expectNoAccessOrLongLivedToken(seen);
    });

    it("refuses a token carrying another attempt's nonce, and releases nothing", async () => {
        const { seen } = await recoveryNode();
        facebookReturns(measuredReturn(RECOVERY_NONCE, fbIdToken({ nonce: MEMBER_NONCE })));

        const { error } = await settle(recoverWithFacebook());

        expect(error).toMatchObject({ reason: 'provider', message: PLAIN });
        expect(seen.map((s) => s.path)).toEqual(BEFORE_THE_RELEASE);
        expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    });

    it("reads Facebook's cancel as a quiet cancel, and releases nothing", async () => {
        const { seen } = await recoveryNode();
        facebookReturns(cancelReturn(RECOVERY_NONCE));

        const { error } = await settle(recoverWithFacebook());

        expect(error).toMatchObject({ reason: 'cancelled', message: 'Sign-in was cancelled.' });
        expect(seen.map((s) => s.path)).toEqual(BEFORE_THE_RELEASE);
    });
});

// ---------------------------------------------------------------------------------------------------
// The source, so a later edit cannot quietly bring the fallback back.
// ---------------------------------------------------------------------------------------------------

describe('no sign-in path reads an access token or asks Graph', () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf-8');

    it.each(['../sso-signin.ts', '../sso-recovery.ts', '../sso-sheet-connect.ts', '../keeper-enrolment.ts'])('%s', (rel) => {
        const src = read(rel);
        expect(src).not.toMatch(/graph\.facebook\.com/);
        expect(src).not.toMatch(/\.get\(\s*['"](?:access_token|long_lived_token)['"]\s*\)/);
    });
});

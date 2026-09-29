/**
 * Facebook sign-in sends only Facebook's signed ID token (A2b).
 *
 * Since S1 (#1113) a sign-in check takes Facebook only as an OIDC id_token it can verify: RS256 against Facebook's
 * JWKS, the issuer, our app id as the audience, and the nonce it issued. An access token proves nothing without the app
 * secret, so it is refused. The app used to fall back to the access token when no id_token came back, and to ask Graph
 * `/me` for the member's id with it. Now it reads the id_token and nothing else, refuses before anything goes out a
 * return without one, with another attempt's state, or with a token that does not carry this attempt's nonce, and
 * never asks Graph.
 *
 * Since V4 the sign-in check is BeanPool's key vault's (utils/vault.ts): the nonce is the hash of the vault's ticket,
 * and the token goes to the vault, never to the member's community. The properties are the same.
 *
 * MEASURED 2026-09-25 (Marty, desktop Chrome, the exact request the phone sends): the return's fragment carries
 * access_token, data_access_expiration_time, expires_in, id_token (RS256, iss https://www.facebook.com, aud our app
 * id, nonce echoed verbatim), long_lived_token and state. The fixtures below have that shape.
 *
 * Nothing here contacts a node, a vault or Facebook. The request signing is real, so every request the app makes goes
 * through the `fetch` stub, which plays the vault (fake-vault.ts) and refuses (and records) anything addressed
 * elsewhere. That is what lets these tests say "no request to graph.facebook.com" rather than "the function we mocked
 * was not called".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openShareFromSso, sealSeedToSso, vaultTicketNonce } from '@beanpool/core';

(globalThis as any).__DEV__ = false;

const rn = vi.hoisted(() => ({
    linkingListeners: [] as Array<(e: { url: string }) => void>,
}));
const secure = vi.hoisted(() => new Map<string, string>());

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
        // The member's community: nothing of the sign-in may go there.
        getItem: vi.fn(async (key: string) => (key === 'beanpool_anchor_url' ? 'https://test.example' : null)),
        setItem: vi.fn(async () => undefined),
        removeItem: vi.fn(async () => undefined),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => secure.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { secure.delete(key); }),
}));

import * as WebBrowser from 'expo-web-browser';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { ed25519 } from '@noble/curves/ed25519.js';
import { FACEBOOK_APP_ID, SsoSignInError, signInWithProvider } from '../sso-signin';
import { connectAndDeposit } from '../sso-sheet-connect';
import { checkSsoRestore, finishSsoRestore, startSsoRestore } from '../sso-recovery';
import { seedToKeypair } from '../crypto';
import { HOLD_MS, installNetwork, noVault, useVault, VAULT, type Network, type SentRequest } from './fake-vault';

const MEMBER_NONCE = 'bWVtYmVyLW5vbmNlLWZvci10aGlzLWZhY2Vib29rLWF0dGVtcHQ';
const FB_SUB = '10229876543210987';
const FB_EMAIL = 'member@example.com';
const ACCESS_TOKEN = 'EAALoNLYaccessTOKENtheAppMustNeverKeep1';
const LONG_LIVED_TOKEN = 'EAALoNLYlongLivedTOKENtheAppMustNeverKeep2';
const PLAIN = "Facebook didn't finish the sign-in. Try again, or choose another way.";

const TICKET = '/v1/ticket';
const DEPOSIT = '/v1/copies';
const RESTORE = '/v1/restore';

// A real key pair: the vault checks the signature on every request.
const MEMBER = {
    publicKey: Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(7))).toString('hex'),
    privateKey: '07'.repeat(32),
    callsign: 'member',
    createdAt: '2026-09-25T00:00:00Z',
    mnemonic: 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' '),
} as any;

/** A Facebook OIDC id_token's shape. Unsigned: nothing here verifies signatures, the vault does. */
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
// The vault, and everything the app sends, stores or logs.
// ---------------------------------------------------------------------------------------------------

let net: Network;

function toFacebook(seen: SentRequest[]): string[] {
    return seen.map((s) => s.url).filter((u) => {
        try {
            const host = new URL(u).hostname;
            return host === 'facebook.com' || host.endsWith('.facebook.com');
        } catch {
            return false;
        }
    });
}

/** Every request that went anywhere but the vault: none may. */
function offVault(seen: SentRequest[]): string[] {
    return seen.map((s) => s.url).filter((u) => !u.startsWith(`${VAULT}/`));
}

function logged(): string[] {
    const spies = [console.log, console.warn, console.error, console.info] as unknown as Array<{ mock?: { calls: unknown[][] } }>;
    return spies.flatMap((spy) => spy.mock?.calls ?? []).map((args) => args.map((a) => (
        a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : JSON.stringify(a)
    )).join(' '));
}

/** Everything the app sent, stored or logged, as one string to search for the tokens it must not keep. */
function everythingKeptOrSent(seen: SentRequest[], ...extra: unknown[]): string {
    return JSON.stringify([
        seen.map((s) => [s.url, s.body, s.headers]),
        vi.mocked(AsyncStorage.setItem).mock.calls,
        vi.mocked(SecureStore.setItemAsync).mock.calls,
        logged(),
        extra,
    ]);
}

function expectNoAccessOrLongLivedToken(seen: SentRequest[], ...extra: unknown[]): void {
    const all = everythingKeptOrSent(seen, ...extra);
    expect(all).not.toContain(ACCESS_TOKEN);
    expect(all).not.toContain(LONG_LIVED_TOKEN);
}

/**
 * The Custom Tab closes on Facebook's return (iOS, or an Android tab that survived). `build` makes the return from the
 * nonce the dialog was asked with, which is the hash of the vault's ticket.
 */
function facebookReturns(build: (nonce: string) => string | Promise<string>): void {
    vi.mocked(WebBrowser.openAuthSessionAsync).mockImplementationOnce(async (authUrl: string) => {
        const nonce = new URL(authUrl).searchParams.get('nonce') ?? '';
        return { type: 'success', url: await build(nonce) } as any;
    });
}

/**
 * Android: the verified `beanpool.org/auth/facebook` App Link brings the app forward over the Custom Tab, which then
 * reports a cancel it did not mean. The links arrive as Linking events, in order.
 */
function facebookReturnsByAppLink(...builds: Array<(nonce: string) => string>): void {
    vi.mocked(WebBrowser.openAuthSessionAsync).mockImplementationOnce(async (authUrl: string) => {
        const nonce = new URL(authUrl).searchParams.get('nonce') ?? '';
        for (const build of builds) rn.linkingListeners.forEach((fn) => fn({ url: build(nonce) }));
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
    secure.clear();
    rn.linkingListeners.length = 0;
    useVault();
    net = installNetwork();
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
    noVault();
});

// ---------------------------------------------------------------------------------------------------
// What the phone asks Facebook for.
// ---------------------------------------------------------------------------------------------------

describe("Facebook's dialog is asked for an id_token bound to this attempt", () => {
    it("carries our app id, the beanpool.org return, openid and email, and the vault ticket's nonce as both nonce and state", async () => {
        facebookReturns((n) => measuredReturn(n));

        await settle(protectWithFacebook());

        const [authUrl, completionUri] = vi.mocked(WebBrowser.openAuthSessionAsync).mock.calls[0];
        const u = new URL(authUrl);
        const ticket = net.sent.find((s) => s.path === DEPOSIT)?.body.ticket;
        expect(`${u.origin}${u.pathname}`).toBe('https://www.facebook.com/v20.0/dialog/oauth');
        expect(u.searchParams.get('client_id')).toBe(FACEBOOK_APP_ID);
        expect(u.searchParams.get('redirect_uri')).toBe('https://beanpool.org/auth/facebook');
        expect(u.searchParams.get('scope')).toBe('openid,email');
        expect(u.searchParams.get('nonce')).toBe(vaultTicketNonce(ticket));
        expect(u.searchParams.get('state')).toBe(vaultTicketNonce(ticket));
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

function protectWithFacebook() {
    return connectAndDeposit({
        provider: 'facebook',
        identity: MEMBER,
        // The phone's lock is sign-in-link-behind-lock.test.ts's: this is about the Facebook token.
        phoneLock: null,
        onSignedIn: () => {},
        signal: new AbortController().signal,
    });
}

/** Refused on the phone: the vault was asked for a ticket and for nothing after it. */
function expectNothingSentAfterTheTicket(seen: SentRequest[]): void {
    expect(seen.map((s) => s.path)).toEqual([TICKET]);
}

describe('protecting an account with Facebook sends the vault only the id_token', () => {
    it("deposits with the id_token and the ticket, sealed to the token's sub, and asks Graph nothing", async () => {
        let idToken = '';
        facebookReturns((n) => measuredReturn(n, (idToken = fbIdToken({ nonce: n }))));

        const { value, error } = await settle(protectWithFacebook());

        expect(error).toBeUndefined();
        expect(value?.error).toBeUndefined();
        expect(value?.enrolledSso).toEqual(['facebook']);

        const deposit = net.sent.find((s) => s.path === DEPOSIT)?.body;
        expect(Object.keys(deposit).sort()).toEqual(['box', 'idToken', 'provider', 'ticket']);
        expect(deposit.provider).toBe('facebook');
        expect(deposit.idToken).toBe(idToken);
        expect(vaultTicketNonce(deposit.ticket)).toBe(JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString()).nonce);
        // Sealed to the sub the id_token names, which is what the vault reads from it when it verifies.
        const [copy] = net.vault.copiesOf(MEMBER.publicKey);
        const seed = await openShareFromSso(copy.clientCopy, 'facebook', FB_SUB);
        expect(Buffer.from(seed).toString('hex')).toBe(MEMBER.privateKey);

        expect(toFacebook(net.sent)).toEqual([]);
        expect(offVault(net.sent)).toEqual([]);
        expectNoAccessOrLongLivedToken(net.sent, value);
    });

    it('the sign-in hands back the id_token, the nonce and the email, and nothing else from the return', async () => {
        const idToken = fbIdToken({ nonce: MEMBER_NONCE });
        facebookReturns(() => measuredReturn(MEMBER_NONCE, idToken));

        const { value, error } = await settle(signInWithProvider('facebook', MEMBER_NONCE));

        expect(error).toBeUndefined();
        expect(value).toEqual({ provider: 'facebook', idToken, nonce: MEMBER_NONCE, email: FB_EMAIL });
    });

    it('refuses a return with only an access token, with the plain message, and sends the vault nothing', async () => {
        facebookReturns((n) => fbReturn({
            access_token: ACCESS_TOKEN,
            expires_in: '5184000',
            long_lived_token: LONG_LIVED_TOKEN,
            state: n,
        }));

        const { value, error } = await settle(protectWithFacebook());

        expect(value).toBeUndefined();
        expect(error).toBeInstanceOf(SsoSignInError);
        expect(error).toMatchObject({ reason: 'no-token', message: PLAIN });
        expectNothingSentAfterTheTicket(net.sent);
        expect(toFacebook(net.sent)).toEqual([]);
        expectNoAccessOrLongLivedToken(net.sent);
    });

    it("refuses a token carrying another attempt's nonce, before the vault sees it", async () => {
        facebookReturns((n) => measuredReturn(n, fbIdToken({ nonce: 'another-attempts-nonce' })));

        const { error } = await settle(protectWithFacebook());

        expect(error).toBeInstanceOf(SsoSignInError);
        expect(error).toMatchObject({ reason: 'provider', message: PLAIN });
        expectNothingSentAfterTheTicket(net.sent);
        expectNoAccessOrLongLivedToken(net.sent);
    });

    it('refuses a token whose nonce is only a hash of ours: Facebook echoes it verbatim, and the vault wants it so', async () => {
        facebookReturns(async (n) => {
            const hashed = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(n))).toString('hex');
            return measuredReturn(n, fbIdToken({ nonce: hashed }));
        });

        const { error } = await settle(protectWithFacebook());

        expect(error).toMatchObject({ reason: 'provider', message: PLAIN });
        expectNothingSentAfterTheTicket(net.sent);
    });

    it('refuses a token with no nonce at all', async () => {
        facebookReturns((n) => measuredReturn(n, fbIdToken({ nonce: undefined })));

        const { error } = await settle(protectWithFacebook());

        expect(error).toMatchObject({ reason: 'provider', message: PLAIN });
        expectNothingSentAfterTheTicket(net.sent);
    });

    it('refuses an id_token that is not a JWT, and does not ask Graph who it belongs to', async () => {
        facebookReturns((n) => fbReturn({ id_token: ACCESS_TOKEN, state: n }));

        const { error } = await settle(protectWithFacebook());

        expect(error).toBeInstanceOf(SsoSignInError);
        expect(error).toMatchObject({ message: PLAIN });
        expectNothingSentAfterTheTicket(net.sent);
        expect(toFacebook(net.sent)).toEqual([]);
        expectNoAccessOrLongLivedToken(net.sent);
    });

    it("reads Facebook's cancel as a quiet cancel", async () => {
        facebookReturns((n) => cancelReturn(n));

        const { error } = await settle(protectWithFacebook());

        expect(error).toBeInstanceOf(SsoSignInError);
        expect(error).toMatchObject({ reason: 'cancelled', message: 'Sign-in was cancelled.' });
        expectNothingSentAfterTheTicket(net.sent);
    });

    it('reads any other error from Facebook as the plain message', async () => {
        facebookReturns((n) => `https://beanpool.org/auth/facebook?error=server_error&error_description=Something+went+wrong&state=${n}#_=_`);

        const { error } = await settle(protectWithFacebook());

        expect(error).toMatchObject({ reason: 'provider', message: PLAIN });
        expectNothingSentAfterTheTicket(net.sent);
    });

    it("ignores a return carrying another attempt's state: the browser closing is then a cancel", async () => {
        facebookReturns(() => measuredReturn('an-earlier-attempts-nonce'));

        const { error } = await settle(protectWithFacebook());

        expect(error).toMatchObject({ reason: 'cancelled' });
        expectNothingSentAfterTheTicket(net.sent);
        expectNoAccessOrLongLivedToken(net.sent);
    });

    it('ignores a return with no state, like a foreign one', async () => {
        facebookReturns((n) => fbReturn({ access_token: ACCESS_TOKEN, id_token: fbIdToken({ nonce: n }) }));

        const { error } = await settle(protectWithFacebook());

        expect(error).toMatchObject({ reason: 'cancelled' });
        expectNothingSentAfterTheTicket(net.sent);
    });

    it("Android: takes this attempt's id_token from the App Link, past a stale one, while the Custom Tab reports a cancel", async () => {
        let idToken = '';
        facebookReturnsByAppLink(
            () => measuredReturn('an-earlier-attempts-nonce'),
            (n) => measuredReturn(n, (idToken = fbIdToken({ nonce: n }))),
        );

        const { value, error } = await settle(protectWithFacebook());

        expect(error).toBeUndefined();
        expect(value?.enrolledSso).toEqual(['facebook']);
        const deposit = net.sent.find((s) => s.path === DEPOSIT)?.body;
        expect(deposit.idToken).toBe(idToken);
        expect(offVault(net.sent)).toEqual([]);
        expectNoAccessOrLongLivedToken(net.sent, value);
    });
});

// ---------------------------------------------------------------------------------------------------
// Recovery: a recovering device's throwaway key, and the copy the vault keeps for Facebook.
// ---------------------------------------------------------------------------------------------------

async function vaultKeepsACopy() {
    const seed = new Uint8Array(32).fill(42);
    const keypair = await seedToKeypair(seed);
    net.vault.keep('facebook', FB_SUB, keypair.publicKeyHex, await sealSeedToSso(seed, 'facebook', FB_SUB));
    return { keypair };
}

function recoverWithFacebook() {
    return startSsoRestore('facebook');
}

const BEFORE_THE_RESTORE = [TICKET];

describe('recovering with Facebook sends the vault the id_token only', () => {
    it("asks with the id_token and the ticket, opens the copy with the token's sub, and asks Graph nothing", async () => {
        const { keypair } = await vaultKeepsACopy();
        let idToken = '';
        facebookReturns((n) => measuredReturn(n, (idToken = fbIdToken({ nonce: n }))));

        const { value, error } = await settle(recoverWithFacebook());

        expect(error).toBeUndefined();
        const restore = net.sent.find((s) => s.path === RESTORE)!;
        expect(Object.keys(restore.body).sort()).toEqual(['idToken', 'provider', 'ticket']);
        expect(restore.body).toMatchObject({ provider: 'facebook', idToken });
        expect(value).toMatchObject({ provider: 'facebook', sub: FB_SUB, holdId: expect.any(String) });

        // The day's wait (D2), then the copy, opened with the sub the token named, and the account saved.
        vi.setSystemTime(Date.now() + HOLD_MS + 1000);
        const collected = await checkSsoRestore();
        if (collected?.status !== 'released') throw new Error('expected a release');
        const saved = await finishSsoRestore(collected.restored, 'https://test.example', { nameOnNode: async () => 'member' });
        expect(saved.publicKey).toBe(keypair.publicKeyHex);

        expect(toFacebook(net.sent)).toEqual([]);
        expect(offVault(net.sent)).toEqual([]);
        expect(SecureStore.setItemAsync).toHaveBeenCalled();
        expectNoAccessOrLongLivedToken(net.sent, value, saved);
    });

    it('refuses a return with only an access token, with the plain message, and asks nothing', async () => {
        await vaultKeepsACopy();
        facebookReturns((n) => fbReturn({ access_token: ACCESS_TOKEN, long_lived_token: LONG_LIVED_TOKEN, state: n }));

        const { error } = await settle(recoverWithFacebook());

        expect(error).toMatchObject({ reason: 'no-token', message: PLAIN });
        expect(net.sent.map((s) => s.path)).toEqual(BEFORE_THE_RESTORE);
        expect(toFacebook(net.sent)).toEqual([]);
        expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
        expectNoAccessOrLongLivedToken(net.sent);
    });

    it("refuses a token carrying another attempt's nonce, and asks nothing", async () => {
        await vaultKeepsACopy();
        facebookReturns((n) => measuredReturn(n, fbIdToken({ nonce: MEMBER_NONCE })));

        const { error } = await settle(recoverWithFacebook());

        expect(error).toMatchObject({ reason: 'provider', message: PLAIN });
        expect(net.sent.map((s) => s.path)).toEqual(BEFORE_THE_RESTORE);
        expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    });

    it("reads Facebook's cancel as a quiet cancel, and asks nothing", async () => {
        await vaultKeepsACopy();
        facebookReturns((n) => cancelReturn(n));

        const { error } = await settle(recoverWithFacebook());

        expect(error).toMatchObject({ reason: 'cancelled', message: 'Sign-in was cancelled.' });
        expect(net.sent.map((s) => s.path)).toEqual(BEFORE_THE_RESTORE);
    });
});

// ---------------------------------------------------------------------------------------------------
// The source, so a later edit cannot quietly bring the fallback back.
// ---------------------------------------------------------------------------------------------------

describe('no sign-in path reads an access token or asks Graph', () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf-8');

    it.each(['../sso-signin.ts', '../sso-recovery.ts', '../sso-sheet-connect.ts', '../keeper-enrolment.ts', '../vault.ts'])('%s', (rel) => {
        const src = read(rel);
        expect(src).not.toMatch(/graph\.facebook\.com/);
        expect(src).not.toMatch(/\.get\(\s*['"](?:access_token|long_lived_token)['"]\s*\)/);
    });
});

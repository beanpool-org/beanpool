/**
 * Google sign-in carries the node's nonce (A1).
 *
 * The node now refuses a Google id_token that does not carry the nonce it issued (S1), because a
 * nonce-less token is bound to no request: any node it was once shown to could replay it within the
 * hour and release a member's whole sealed seed. The old library's free `signIn()` cannot set a
 * nonce, so both platforms move off it:
 *
 * - iPhone: Google's own web sign-in page, with our Web client and the nonce in the URL; the
 *   id_token comes back in the fragment of `beanpool.org/auth/google`, which bounces to
 *   `beanpool://auth/google`.
 * - Android: Credential Manager through @thoughtbot/react-native-social-auth, which passes the nonce
 *   to `GetGoogleIdOption.setNonce()`.
 *
 * No provider and no node is contacted: the browser, the native module and the node are all mocks.
 * The fake native module behaves as Google does — it mints a token whose `aud` is the server client
 * id and whose `nonce` is whatever it was configured with — so a test that decodes the token proves
 * the node's nonce actually reached the module, not just that some function was called.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

(globalThis as any).__DEV__ = false;

const rn = vi.hoisted(() => ({
    Platform: { OS: 'ios' as string },
    deviceListeners: [] as Array<(url: string) => void>,
    linkingListeners: [] as Array<(e: { url: string }) => void>,
}));

vi.mock('react-native', () => ({
    Platform: rn.Platform,
    DeviceEventEmitter: {
        addListener: vi.fn((_name: string, fn: (url: string) => void) => {
            rn.deviceListeners.push(fn);
            return { remove: vi.fn() };
        }),
        emit: vi.fn((name: string, url: string) => {
            if (name === 'SSO_AUTH_CALLBACK') rn.deviceListeners.forEach((fn) => fn(url));
        }),
    },
}));
vi.mock('expo-linking', () => ({
    addEventListener: vi.fn((_name: string, fn: (e: { url: string }) => void) => {
        rn.linkingListeners.push(fn);
        return { remove: vi.fn() };
    }),
    openURL: vi.fn(async () => undefined),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() },
}));
vi.mock('expo-apple-authentication', () => ({
    isAvailableAsync: vi.fn(async () => true),
    signInAsync: vi.fn(),
    AppleAuthenticationScope: { EMAIL: 0, FULL_NAME: 1 },
}));
vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(len).fill(9)),
}));
vi.mock('expo-web-browser', () => ({
    openAuthSessionAsync: vi.fn(),
    dismissAuthSession: vi.fn(),
    dismissBrowser: vi.fn(async () => undefined),
    maybeCompleteAuthSession: vi.fn(),
}));
vi.mock('../node-post', () => ({ signedPost: vi.fn(), anchorUrl: vi.fn() }));

// The old library stays installed (design §5 C1 removes it), so it is mocked here only to prove
// that nothing calls it any more.
const oldLib = vi.hoisted(() => ({
    signIn: vi.fn(async () => ({ type: 'success', data: { idToken: 'old.library.token' } })),
    configure: vi.fn(),
    hasPlayServices: vi.fn(async () => true),
}));
vi.mock('@react-native-google-signin/google-signin', () => ({
    GoogleSignin: oldLib,
    statusCodes: { SIGN_IN_CANCELLED: 'SIGN_IN_CANCELLED', PLAY_SERVICES_NOT_AVAILABLE: 'PLAY_SERVICES_NOT_AVAILABLE' },
}));

/** A JWT-shaped string. Unsigned: nothing here verifies signatures, the node does. */
function fakeJwt(claims: Record<string, unknown>): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'RS256', kid: 'k1' })}.${b64(claims)}.c2ln`;
}

function decode(token: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'));
}

// The thoughtbot module, as Credential Manager behaves: the token's `aud` is the server client id it
// was configured with and its `nonce` is the configured nonce. `missing` stands in for a build whose
// native side does not have the module (TurboModuleRegistry.getEnforcing throws on first use).
const tb = vi.hoisted(() => {
    const state = {
        configured: null as null | Record<string, unknown>,
        missing: false,
        failWith: null as null | { code: string; message: string },
        dropNonce: false,
        calls: [] as string[],
    };
    const GoogleSignIn = {
        configure: vi.fn((config: Record<string, unknown>) => {
            state.calls.push('configure');
            state.configured = { ...config };
        }),
        signOut: vi.fn(async () => { state.calls.push('signOut'); }),
        signIn: vi.fn(async () => {
            state.calls.push('signIn');
            if (state.failWith) throw Object.assign(new Error(state.failWith.message), { code: state.failWith.code });
            const c = state.configured ?? {};
            const claims: Record<string, unknown> = {
                iss: 'https://accounts.google.com',
                aud: c.webClientId,
                sub: '110169484474386276334',
                email: 'member@example.com',
            };
            if (!state.dropNonce && c.nonce !== undefined) claims.nonce = c.nonce;
            const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
            return {
                idToken: `${b64({ alg: 'RS256' })}.${b64(claims)}.c2ln`,
                accessToken: null,
                serverAuthCode: null,
                user: { id: 'member@example.com', email: 'member@example.com' },
            };
        }),
    };
    return { state, GoogleSignIn };
});
vi.mock('@thoughtbot/react-native-social-auth', () => ({
    get GoogleSignIn() {
        if (tb.state.missing) {
            throw new Error("TurboModuleRegistry.getEnforcing(...): 'GoogleSignIn' could not be found.");
        }
        return tb.GoogleSignIn;
    },
}));

import * as WebBrowser from 'expo-web-browser';
import { DeviceEventEmitter } from 'react-native';
import { signedPost } from '../node-post';
import {
    GOOGLE_WEB_CLIENT_ID,
    SsoSignInError,
    googleAuthUrl,
    readGoogleCallback,
    signInWithGoogle,
    startSsoSignIn,
} from '../sso-signin';
import { redirectSystemPath } from '../../app/+native-intent';

const NODE_NONCE = 'bm9kZS1pc3N1ZWQtbm9uY2UtZm9yLXRoaXMtYXR0ZW1wdA';
const identity = { publicKey: 'aa', privateKey: 'bb', callsign: 'm', createdAt: '2026-09-25T00:00:00Z' } as any;

beforeEach(() => {
    rn.Platform.OS = 'ios';
    rn.deviceListeners.length = 0;
    rn.linkingListeners.length = 0;
    tb.state.configured = null;
    tb.state.missing = false;
    tb.state.failWith = null;
    tb.state.dropNonce = false;
    tb.state.calls.length = 0;
    vi.mocked(WebBrowser.openAuthSessionAsync).mockReset();
    tb.GoogleSignIn.configure.mockClear();
    tb.GoogleSignIn.signIn.mockClear();
    tb.GoogleSignIn.signOut.mockClear();
    oldLib.signIn.mockClear();
    vi.mocked(signedPost).mockReset();
});

afterEach(() => {
    vi.useRealTimers();
    // Whatever a test did, the old library's signIn() must not have been reached.
    expect(oldLib.signIn).not.toHaveBeenCalled();
});

describe('iPhone: the Google web sign-in page', () => {
    it('asks for an id_token for our Web client, with the node nonce as both nonce and state', () => {
        const url = new URL(googleAuthUrl(NODE_NONCE));
        expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
        const q = url.searchParams;
        expect(q.get('client_id')).toBe(GOOGLE_WEB_CLIENT_ID);
        expect(q.get('redirect_uri')).toBe('https://beanpool.org/auth/google');
        expect(q.get('response_type')).toBe('id_token');
        expect(q.get('scope')).toBe('openid email');
        expect(q.get('nonce')).toBe(NODE_NONCE);
        expect(q.get('state')).toBe(NODE_NONCE);
        expect(q.get('prompt')).toBe('select_account');
    });

    it('the Web client is the one the node accepts first (sso.ts audience list)', () => {
        expect(GOOGLE_WEB_CLIENT_ID).toBe('653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com');
    });

    it('takes the id_token from the fragment', () => {
        const token = fakeJwt({ sub: 's', nonce: NODE_NONCE, email: 'a@example.com' });
        const res = readGoogleCallback(`beanpool://auth/google#state=${NODE_NONCE}&id_token=${token}&authuser=0`, NODE_NONCE);
        expect(res.idToken).toBe(token);
        expect(res.email).toBe('a@example.com');
    });

    it('refuses a callback that carries only an access_token', () => {
        const url = `beanpool://auth/google#access_token=ya29.not-an-id-token&token_type=Bearer&state=${NODE_NONCE}`;
        expect(() => readGoogleCallback(url, NODE_NONCE)).toThrow(SsoSignInError);
        try {
            readGoogleCallback(url, NODE_NONCE);
        } catch (e) {
            expect((e as SsoSignInError).reason).toBe('no-token');
        }
    });

    it("refuses a callback whose state is not this attempt's nonce", () => {
        const token = fakeJwt({ sub: 's', nonce: 'another-attempt' });
        expect(() => readGoogleCallback(`beanpool://auth/google#state=another-attempt&id_token=${token}`, NODE_NONCE))
            .toThrow(SsoSignInError);
        expect(() => readGoogleCallback(`beanpool://auth/google#id_token=${token}`, NODE_NONCE))
            .toThrow(SsoSignInError);
    });

    it('reads a declined consent as a cancel and any other Google error as a provider failure', () => {
        const denied = () => readGoogleCallback(`beanpool://auth/google#error=access_denied&state=${NODE_NONCE}`, NODE_NONCE);
        expect(denied).toThrow('Sign-in was cancelled.');
        try { denied(); } catch (e) { expect((e as SsoSignInError).reason).toBe('cancelled'); }

        const other = () => readGoogleCallback(
            `beanpool://auth/google#error=invalid_request&error_description=Bad+redirect&state=${NODE_NONCE}`, NODE_NONCE,
        );
        try { other(); expect.unreachable(); } catch (e) {
            expect((e as SsoSignInError).reason).toBe('provider');
            expect((e as Error).message).toContain('Bad redirect');
        }
    });

    it('opens the page through the auth session and returns the token, the nonce and the email', async () => {
        const token = fakeJwt({ sub: 's', nonce: NODE_NONCE, email: 'a@example.com', aud: GOOGLE_WEB_CLIENT_ID });
        vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValueOnce({
            type: 'success',
            url: `beanpool://auth/google#state=${NODE_NONCE}&id_token=${token}`,
        } as any);

        const res = await signInWithGoogle(NODE_NONCE);

        expect(res).toEqual({ idToken: token, nonce: NODE_NONCE, email: 'a@example.com' });
        const [authUrl, completion] = vi.mocked(WebBrowser.openAuthSessionAsync).mock.calls[0];
        expect(new URL(authUrl).searchParams.get('nonce')).toBe(NODE_NONCE);
        expect(completion).toBe('beanpool://auth/google');
        // Neither native library is touched on the iPhone.
        expect(tb.GoogleSignIn.signIn).not.toHaveBeenCalled();
    });

    it("ignores a callback carrying another attempt's state and waits for its own", async () => {
        const stale = fakeJwt({ sub: 'someone-else', nonce: 'stale' });
        const mine = fakeJwt({ sub: 's', nonce: NODE_NONCE });
        let finishBrowser: (v: any) => void = () => {};
        vi.mocked(WebBrowser.openAuthSessionAsync).mockReturnValueOnce(new Promise((r) => { finishBrowser = r; }));

        const pending = signInWithGoogle(NODE_NONCE);
        await new Promise((r) => setTimeout(r, 0));
        // A stale callback from an earlier attempt arrives first, through the App Link broadcast.
        DeviceEventEmitter.emit('SSO_AUTH_CALLBACK', `beanpool://auth/google#state=stale&id_token=${stale}`);
        finishBrowser({ type: 'success', url: `beanpool://auth/google#state=${NODE_NONCE}&id_token=${mine}` });

        const res = await pending;
        expect(res.idToken).toBe(mine);
    });

    it('treats a browser that only ever saw a foreign state as a cancel, never as a success', async () => {
        const stale = fakeJwt({ sub: 'someone-else', nonce: 'stale' });
        vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValueOnce({
            type: 'success',
            url: `beanpool://auth/google#state=stale&id_token=${stale}`,
        } as any);
        await expect(signInWithGoogle(NODE_NONCE)).rejects.toThrow('Sign-in was cancelled.');
    });

    it("refuses a token that does not carry this attempt's nonce, before the node sees it", async () => {
        const noNonce = fakeJwt({ sub: 's', aud: GOOGLE_WEB_CLIENT_ID });
        vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValueOnce({
            type: 'success',
            url: `beanpool://auth/google#state=${NODE_NONCE}&id_token=${noNonce}`,
        } as any);
        await expect(signInWithGoogle(NODE_NONCE)).rejects.toMatchObject({ reason: 'provider' });
    });

    it('the App Link / custom-scheme return is broadcast to the waiting sign-in', () => {
        const received: string[] = [];
        rn.deviceListeners.push((url) => received.push(url));
        redirectSystemPath({ path: `beanpool://auth/google#state=${NODE_NONCE}&id_token=x.y.z`, initial: false });
        expect(received).toEqual([`beanpool://auth/google#state=${NODE_NONCE}&id_token=x.y.z`]);
    });

    it('the return link lands on a screen, not Unmatched Route', () => {
        // `redirectSystemPath` broadcasts the callback and then lets Expo Router navigate to the
        // same path, so every provider it recognises needs a screen at app/auth/<provider>.tsx.
        const intent = fs.readFileSync(path.resolve(__dirname, '../../app/+native-intent.ts'), 'utf-8');
        const providers = [...intent.matchAll(/path\.includes\('auth\/(\w+)'\)/g)].map((m) => m[1]);
        expect(providers).toContain('google');
        for (const provider of providers) {
            expect(fs.existsSync(path.resolve(__dirname, `../../app/auth/${provider}.tsx`)), provider).toBe(true);
        }
    });
});

describe('Android: Credential Manager with the nonce', () => {
    beforeEach(() => { rn.Platform.OS = 'android'; });

    it('configures the module with our Web client and the node nonce, and the token carries both', async () => {
        const res = await signInWithGoogle(NODE_NONCE);

        expect(tb.GoogleSignIn.configure).toHaveBeenCalledWith(
            expect.objectContaining({ webClientId: GOOGLE_WEB_CLIENT_ID, nonce: NODE_NONCE }),
        );
        const claims = decode(res.idToken);
        expect(claims.nonce).toBe(NODE_NONCE);
        expect(claims.aud).toBe(GOOGLE_WEB_CLIENT_ID);
        expect(res.nonce).toBe(NODE_NONCE);
        expect(res.email).toBe('member@example.com');
        expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
    });

    it('the nonce is the one the node issued, end to end through startSsoSignIn', async () => {
        vi.mocked(signedPost).mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({ nonce: NODE_NONCE, providers: ['google', 'apple'] }),
        } as any);

        const res = await startSsoSignIn('google', 'https://test.example', identity);

        expect(res.provider).toBe('google');
        expect(res.nonce).toBe(NODE_NONCE);
        expect(decode(res.idToken).nonce).toBe(NODE_NONCE);
        expect(tb.state.configured).toMatchObject({ webClientId: GOOGLE_WEB_CLIENT_ID, nonce: NODE_NONCE });
    });

    it('clears the remembered choice first, so the member sees which account is used', async () => {
        await signInWithGoogle(NODE_NONCE);
        expect(tb.state.calls).toEqual(['configure', 'signOut', 'signIn']);
    });

    it('still signs in when clearing the remembered choice fails', async () => {
        tb.GoogleSignIn.signOut.mockRejectedValueOnce(Object.assign(new Error('clear failed'), { code: 'SIGN_OUT_FAILED' }));
        const res = await signInWithGoogle(NODE_NONCE);
        expect(decode(res.idToken).nonce).toBe(NODE_NONCE);
    });

    it("refuses a token that came back without the node's nonce", async () => {
        tb.state.dropNonce = true;
        await expect(signInWithGoogle(NODE_NONCE)).rejects.toMatchObject({ reason: 'provider' });
    });

    const failures: Array<[string, string, string, RegExp]> = [
        ['SIGN_IN_CANCELLED', 'User cancelled the sign-in flow', 'cancelled', /cancelled/],
        ['NO_CREDENTIALS', 'No credentials available on this device', 'unsupported', /Google found no account to use on this phone/],
        ['PLAY_SERVICES_NOT_AVAILABLE', 'Play Services missing', 'unsupported', /Google Play services/],
        // Credential Manager's own words when no provider (Play services) is on the phone.
        ['SIGN_IN_FAILED', 'getCredentialAsync no provider dependencies found - please ensure the desired provider dependencies are added', 'unsupported', /Google Play services/],
        ['NETWORK_ERROR', 'Unable to reach Google', 'provider', /Google could not sign you in/],
        ['SIGN_IN_FAILED', '[28444] Developer console is not set up correctly.', 'provider', /28444/],
        ['ERR_NO_ACTIVITY', 'No current activity available', 'provider', /Google could not sign you in/],
    ];
    it.each(failures)('%s (%s) maps to %s with a plain message', async (code, message, reason, text) => {
        tb.state.failWith = { code, message };
        const err = await signInWithGoogle(NODE_NONCE).then(() => null, (e) => e);
        expect(err).toBeInstanceOf(SsoSignInError);
        expect(err.reason).toBe(reason);
        expect(err.message).toMatch(text);
    });

    it('a build without the native module says so instead of crashing', async () => {
        tb.state.missing = true;
        const err = await signInWithGoogle(NODE_NONCE).then(() => null, (e) => e);
        expect(err).toBeInstanceOf(SsoSignInError);
        expect(err.reason).toBe('unsupported');
        expect(err.message).toMatch(/update BeanPool/i);
    });
});

describe('the old library is out of every sign-in path', () => {
    // Behaviour is covered above (the afterEach asserts its signIn() was never reached). This pins the
    // source too, so a later edit cannot quietly re-import it: design §5 C1 removes the dependency, and
    // until then nothing may use it for a BeanPool sign-in.
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf-8');

    it.each(['../sso-signin.ts', '../sso-recovery.ts', '../../app/google-probe.tsx'])('%s does not load it', (rel) => {
        expect(read(rel)).not.toMatch(/@react-native-google-signin\/google-signin/);
    });

    it('recovery signs in to Google through signInWithGoogle, the nonce-bearing path', () => {
        expect(read('../sso-recovery.ts')).toMatch(/signInResult = await signInWithGoogle\(nonce\)/);
    });
});

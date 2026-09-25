/**
 * What can be tested without a device, and what deliberately cannot.
 *
 * The Apple sheet needs an iPhone and an Apple ID, so nothing here proves a token was ever
 * issued — that is what the build is for. What these cover is everything AROUND the sheet, which
 * is where the failures are quiet: a nonce that arrives empty, a credential that arrives with a
 * null token, a cancel treated as an error, a provider the node will not accept.
 *
 * Every one of those produces a request the node rejects, at which point the visible symptom is
 * "your sign-in did not check out" and the actual cause is three steps upstream.
 *
 * Google's sheet has the same shape: same nonce, same credential structure, same cancel-vs-error
 * distinction. The tests below cover its error mapping the same way Apple's are covered.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// react-native and expo-apple-authentication have no life outside a device, so they are stubbed
// at the module boundary. Platform defaults to ios; the one test that cares overrides it.
(globalThis as any).__DEV__ = false;
vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    DeviceEventEmitter: {
        addListener: vi.fn(() => ({ remove: vi.fn() })),
        emit: vi.fn(),
    },
    // The GitHub wait listens for the app coming to the front (sso-github-node.test.ts drives it).
    AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));
vi.mock('expo-linking', () => ({
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    getInitialURL: vi.fn(async () => null),
    useURL: vi.fn(() => null),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async () => 'https://test.beanpool.org'),
        setItem: vi.fn(async () => undefined),
        removeItem: vi.fn(async () => undefined),
    },
}));
vi.mock('expo-apple-authentication', () => ({
    isAvailableAsync: vi.fn(async () => true),
    signInAsync: vi.fn(),
    AppleAuthenticationScope: { EMAIL: 0, FULL_NAME: 1 },
}));
vi.mock('@react-native-google-signin/google-signin', () => ({
    GoogleSignin: { configure: vi.fn(), signIn: vi.fn() },
    isErrorWithCode: (e: any) => e && typeof e === 'object' && 'code' in e,
    isNoSavedCredentialFoundResponse: (r: any) => r?.type === 'noSavedCredentialFound',
    statusCodes: {
        SIGN_IN_CANCELLED: 'SIGN_IN_CANCELLED',
        PLAY_SERVICES_NOT_AVAILABLE: 'PLAY_SERVICES_NOT_AVAILABLE',
        IN_PROGRESS: 'IN_PROGRESS',
    },
}));
vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(len).fill(9)),
}));
vi.mock('expo-web-browser', () => ({
    openAuthSessionAsync: vi.fn(),
    dismissAuthSession: vi.fn(),
}));
vi.mock('../node-post', () => ({ signedPost: vi.fn(), anchorUrl: vi.fn() }));

import {
    SsoSignInError,
    describeAppleError,
    describeGoogleError,
    formatAppleErrorMessage,
    formatGoogleErrorMessage,
    readAppleCredential,
    readNonceResponse,
    signInWithFacebook,
    signInWithGithubViaNode,
    GITHUB_MEMBER_ROUTES,
} from '../sso-signin';
import * as WebBrowser from 'expo-web-browser';

describe('the nonce the node sends back', () => {
    it('accepts a well-formed answer and keeps the providers it named', () => {
        expect(readNonceResponse({ nonce: 'abc123', providers: ['google', 'apple'] }))
            .toEqual({ nonce: 'abc123', providers: ['google', 'apple'] });
    });

    it('refuses a missing, empty, or non-string nonce rather than passing it on', () => {
        for (const body of [{}, { nonce: '' }, { nonce: 42 }, { nonce: null }, null, undefined]) {
            expect(() => readNonceResponse(body), JSON.stringify(body)).toThrow(SsoSignInError);
            expect(() => readNonceResponse(body)).toThrow(/did not send a sign-in nonce/);
        }
    });

    it('drops provider names it does not recognise instead of offering them', () => {
        expect(readNonceResponse({ nonce: 'n', providers: ['apple', 'twitter', 7, null] }).providers)
            .toEqual(['apple']);
    });

    it('treats absent providers as "the node did not say", not as "none"', () => {
        expect(readNonceResponse({ nonce: 'n' }).providers).toEqual([]);
    });

    it('keeps githubFlow only when the node says it runs GitHub sign-in itself', () => {
        expect(readNonceResponse({ nonce: 'n', githubFlow: 'node' }).githubFlow).toBe('node');
        for (const githubFlow of [undefined, 'phone', true, 1, null]) {
            expect(readNonceResponse({ nonce: 'n', githubFlow }), String(githubFlow)).not.toHaveProperty('githubFlow');
        }
    });
});

describe('what the Apple sheet threw', () => {
    it('reads a cancel as a cancel', () => {
        expect(describeAppleError({ code: 'ERR_REQUEST_CANCELED' })).toBe('cancelled');
        expect(describeAppleError({ code: 'ERR_CANCELED' })).toBe('cancelled');
    });

    it('reads anything else as a provider failure', () => {
        expect(describeAppleError({ code: 'ERR_INVALID_RESPONSE' })).toBe('provider');
        expect(describeAppleError(new Error('network down'))).toBe('provider');
        expect(describeAppleError(null)).toBe('provider');
        expect(describeAppleError(undefined)).toBe('provider');
    });

    it('diagnoses iOS simulator missing Apple ID with actionable advice', () => {
        const errorMsg = 'The authorization attempt failed for an unknown reason.';
        expect(formatAppleErrorMessage(new Error(errorMsg))).toContain('Apple Sign-In requires an active Apple ID in device or simulator settings');
        expect(formatAppleErrorMessage({ message: 'Error 1000' })).toContain('Apple Sign-In requires an active Apple ID');
    });
});

describe('what the Google sheet threw', () => {
    it('reads a cancel as a cancel', () => {
        expect(describeGoogleError({ code: 'SIGN_IN_CANCELLED' })).toBe('cancelled');
    });

    it('reads Play Services unavailable as unsupported', () => {
        expect(describeGoogleError({ code: 'PLAY_SERVICES_NOT_AVAILABLE' })).toBe('unsupported');
    });

    it('reads anything else as a provider failure', () => {
        expect(describeGoogleError({ code: 'IN_PROGRESS' })).toBe('provider');
        expect(describeGoogleError(new Error('network down'))).toBe('provider');
        expect(describeGoogleError(null)).toBe('provider');
        expect(describeGoogleError(undefined)).toBe('provider');
    });

    it('diagnoses missing Play Services or developer error with actionable advice', () => {
        expect(formatGoogleErrorMessage(new Error('DEVELOPER_ERROR: code 10'))).toContain('Google Sign-In requires Google Play Services and an active Google account');
        expect(formatGoogleErrorMessage({ message: 'PLAY_SERVICES_NOT_AVAILABLE' })).toContain('Google Sign-In requires Google Play Services');
    });
});

describe('the credential Apple hands back', () => {
    it('takes the token and the email when both are there', () => {
        expect(readAppleCredential({ identityToken: 'jwt.goes.here', email: 'someone@example.com' }))
            .toEqual({ idToken: 'jwt.goes.here', email: 'someone@example.com' });
    });

    it('accepts a credential with no email, because that is the normal case', () => {
        expect(readAppleCredential({ identityToken: 'jwt', email: null }))
            .toEqual({ idToken: 'jwt', email: undefined });
        expect(readAppleCredential({ identityToken: 'jwt' })).toEqual({ idToken: 'jwt', email: undefined });
    });

    it('refuses a null token instead of sending the string "null" to the node', () => {
        expect(() => readAppleCredential({ identityToken: null })).toThrow(/returned no token/);
        expect(() => readAppleCredential({})).toThrow(/returned no token/);
        expect(() => readAppleCredential({ identityToken: '' })).toThrow(/returned no token/);
    });
});

describe('SsoSignInError', () => {
    it('carries a reason the caller can branch on without matching prose', () => {
        const e = new SsoSignInError('cancelled', 'Sign-in was cancelled.');
        expect(e.reason).toBe('cancelled');
        expect(e).toBeInstanceOf(Error);
        expect(e.name).toBe('SsoSignInError');
    });
});

describe('Facebook WebBrowser OAuth flow', () => {
    it('handles Facebook OAuth token redirect', async () => {
        // A JWT carrying this attempt's nonce: the app refuses an id_token without it (A2b), as the node does.
        // sso-facebook-idtoken.test.ts covers the refusals.
        const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
        const fbJwt = `${b64({ alg: 'RS256' })}.${b64({ sub: '1234', nonce: 'test-nonce-fb' })}.c2ln`;
        vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValueOnce({
            type: 'success',
            url: `beanpool://auth/facebook#id_token=${fbJwt}&access_token=fb_token_123&state=test-nonce-fb`,
        });
        const res = await signInWithFacebook('test-nonce-fb');
        expect(res.idToken).toBe(fbJwt);
        expect(res.nonce).toBe('test-nonce-fb');
    });

    // The browser's 'cancel' is not trusted on its own any more: on Android it routinely arrives
    // while the real callback is still in flight, so the sign-in keeps listening through a grace
    // window before giving up. These tests advance past that window rather than shorten it.
    it('handles Facebook cancel, after the spurious-cancel grace window', async () => {
        vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValueOnce({ type: 'cancel' as any });
        vi.useFakeTimers();
        try {
            const assertion = expect(signInWithFacebook('test-nonce-fb'))
                .rejects.toThrow('Sign-in was cancelled.');
            await vi.advanceTimersByTimeAsync(11_000);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });
});

// GitHub is the device flow, and since S2 (#1115) the NODE runs it: the app asks the node to start,
// shows the code, and polls the node. No redirect, no code exchange, no client secret, and no request
// from the app to GitHub at all. These were the phone-run flow's tests, each kept for the same
// property on the node-run one; sso-github-node.test.ts runs the same flow through the real request
// signing, with `fetch` as the node.
describe('GitHub sign-in, run by the node', () => {
    const START = {
        sessionId: 'node-session-1', userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        expiresInSeconds: 900, intervalSeconds: 5,
    };
    const nodeGithub = (polls: object[], start: { status: number; body: object } = { status: 200, body: START }) => {
        const queue = [...polls];
        return vi.fn(async (path: string, _body: Record<string, unknown>) => {
            if (path === GITHUB_MEMBER_ROUTES.start) {
                return { ok: start.status === 200, status: start.status, json: async () => start.body } as any;
            }
            if (path === GITHUB_MEMBER_ROUTES.poll) {
                return { ok: true, status: 200, json: async () => queue.shift() ?? { status: 'expired' } } as any;
            }
            return { ok: false, status: 404, json: async () => ({}) } as any;
        });
    };
    const viaNode = (post: ReturnType<typeof nodeGithub>, onPrompt: (p: any) => void = () => {}, signal?: AbortSignal) =>
        signInWithGithubViaNode({ post, routes: GITHUB_MEMBER_ROUTES, githubFlow: 'node', onPrompt, signal });
    const pollsOf = (post: ReturnType<typeof nodeGithub>) =>
        post.mock.calls.filter((c: any[]) => c[0] === GITHUB_MEMBER_ROUTES.poll).length;

    let originalFetch: typeof fetch;
    beforeEach(() => {
        vi.useFakeTimers();
        originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn(async () => { throw new Error('the app made a request of its own'); }) as any;
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.useRealTimers();
    });

    it('polls past pending and returns who the node says signed in', async () => {
        const post = nodeGithub([
            { status: 'pending', intervalSeconds: 5 },
            { status: 'ok', sub: '987654', email: 'dev@github.com' },
        ]);
        const prompts: any[] = [];
        const p = viaNode(post, (pr) => prompts.push(pr));
        await vi.advanceTimersByTimeAsync(10_000);
        const res = await p;

        expect(res).toEqual({ sessionId: 'node-session-1', sub: '987654', email: 'dev@github.com' });
        // The member cannot finish without seeing the code, so surfacing it is part of the contract.
        expect(prompts).toHaveLength(1);
        expect(prompts[0].userCode).toBe('ABCD-1234');
        expect(prompts[0].verificationUri).toBe('https://github.com/login/device');
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('treats denied as a cancel, not an error', async () => {
        const post = nodeGithub([{ status: 'denied' }]);
        const assertion = expect(viaNode(post)).rejects.toThrow('Sign-in was cancelled.');
        await vi.advanceTimersByTimeAsync(5_000);
        await assertion;
    });

    it('surfaces the code before the first poll — no silent hang', async () => {
        // Recovery calls this without a sheet. Before onDeviceCode existed, the code went nowhere:
        // no prompt, no browser, and a fifteen-minute silent wait on the one path these fragments
        // exist for.
        const post = nodeGithub([{ status: 'ok', sub: '987654' }]);
        const seen: any[] = [];
        const p = viaNode(post, (pr) => seen.push({ ...pr, pollsSoFar: pollsOf(post) }));
        await vi.advanceTimersByTimeAsync(5_000);
        const res = await p;
        expect(res.sessionId).toBe('node-session-1');
        expect(seen).toEqual([{ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', pollsSoFar: 0 }]);
    });

    it('stops polling when the caller aborts', async () => {
        // Always pending: without an abort this would poll until the code expired, which is
        // exactly what closing the sheet used to leave running unseen.
        const post = nodeGithub(Array.from({ length: 500 }, () => ({ status: 'pending', intervalSeconds: 5 })));
        const abort = new AbortController();
        const assertion = expect(viaNode(post, () => abort.abort(), abort.signal)).rejects.toThrow('Sign-in was cancelled.');
        await vi.advanceTimersByTimeAsync(60_000);
        await assertion;
        expect(pollsOf(post)).toBe(0);
    });

    it("names GitHub's device flow being switched off rather than reporting an outage", async () => {
        const post = nodeGithub([], { status: 400, body: { error: 'GitHub sign-in is not enabled for this app yet.' } });
        await expect(viaNode(post)).rejects.toThrow('not enabled for this app');
    });

    it('refuses when the node names no GitHub user id', async () => {
        // sealSeedToSso keys on `provider:sub`; a missing sub seals to a key recovery can never
        // derive, which deposits fine and can never be recovered through.
        const post = nodeGithub([{ status: 'ok', email: 'dev@github.com' }]);
        const assertion = expect(viaNode(post)).rejects.toThrow('did not return a user id');
        await vi.advanceTimersByTimeAsync(5_000);
        await assertion;
    });

    it('refuses a node that does not run the flow, before asking it anything', async () => {
        const post = nodeGithub([{ status: 'ok', sub: '987654' }]);
        await expect(signInWithGithubViaNode({
            post, routes: GITHUB_MEMBER_ROUTES, githubFlow: undefined, onPrompt: () => {},
        })).rejects.toMatchObject({ reason: 'unsupported' });
        expect(post).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });
});

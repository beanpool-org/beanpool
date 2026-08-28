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

import { describe, it, expect, vi } from 'vitest';

// react-native and expo-apple-authentication have no life outside a device, so they are stubbed
// at the module boundary. Platform defaults to ios; the one test that cares overrides it.
(globalThis as any).__DEV__ = false;
vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    DeviceEventEmitter: {
        addListener: vi.fn(() => ({ remove: vi.fn() })),
        emit: vi.fn(),
    },
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
    signInWithGithub,
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

describe('Facebook and GitHub WebBrowser OAuth flows', () => {
    it('handles Facebook OAuth token redirect', async () => {
        vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValueOnce({
            type: 'success',
            url: 'beanpool://auth/facebook#id_token=fb.fake.jwt&access_token=fb_token_123&state=test-nonce-fb',
        });
        const res = await signInWithFacebook('test-nonce-fb');
        expect(res.idToken).toBe('fb.fake.jwt');
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

    // GitHub is the device flow now: no redirect, no code exchange, no client secret. See the
    // rationale on `signInWithGithub` — GitHub OAuth Apps are not OIDC, so the web flow needs a
    // secret on every node, which a federated network cannot have.
    const githubDeviceFetch = (poll: object[], user: object = { id: 987654, email: 'dev@github.com' }) => {
        const queue = [...poll];
        return vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes('login/device/code')) {
                return { ok: true, json: async () => ({
                    device_code: 'dev_code_1', user_code: 'ABCD-1234',
                    verification_uri: 'https://github.com/login/device',
                    expires_in: 900, interval: 0,
                }) } as any;
            }
            if (u.includes('login/oauth/access_token')) {
                return { ok: true, json: async () => queue.shift() ?? { error: 'expired_token' } } as any;
            }
            if (u.includes('api.github.com/user')) {
                return { ok: true, json: async () => user } as any;
            }
            return { ok: false, status: 404 } as any;
        });
    };

    it('polls past authorization_pending and returns the profile', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = githubDeviceFetch([
            { error: 'authorization_pending' },
            { access_token: 'gho_device_token' },
        ]) as any;
        try {
            const prompts: any[] = [];
            const res = await signInWithGithub('test-nonce-gh', (p) => prompts.push(p));
            expect(res.idToken).toBe('gho_device_token');
            expect(res.sub).toBe('987654');
            expect(res.email).toBe('dev@github.com');
            // The member cannot finish without seeing the code, so surfacing it is part of the contract.
            expect(prompts).toHaveLength(1);
            expect(prompts[0].userCode).toBe('ABCD-1234');
            expect(prompts[0].verificationUri).toBe('https://github.com/login/device');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('treats access_denied as a cancel, not an error', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = githubDeviceFetch([{ error: 'access_denied' }]) as any;
        try {
            await expect(signInWithGithub('test-nonce-gh')).rejects.toThrow('Sign-in was cancelled.');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('names device_flow_disabled rather than reporting an outage', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn(async () => ({
            ok: true, json: async () => ({ error: 'device_flow_disabled' }),
        })) as any;
        try {
            await expect(signInWithGithub('test-nonce-gh')).rejects.toThrow('not enabled for this app');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('refuses to enrol when GitHub returns no user id', async () => {
        const originalFetch = globalThis.fetch;
        // sealShareToSso keys on `provider:sub`; an undefined sub seals to `github:undefined`,
        // which deposits fine and can never be recovered through.
        globalThis.fetch = githubDeviceFetch([{ access_token: 'gho_device_token' }], { email: 'dev@github.com' }) as any;
        try {
            await expect(signInWithGithub('test-nonce-gh')).rejects.toThrow('did not return a user id');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

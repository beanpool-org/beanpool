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
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
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
    digestStringAsync: vi.fn(async (_alg: string, input: string) => 'sha256_' + input),
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}));
vi.mock('../node-post', () => ({ signedPost: vi.fn(), anchorUrl: vi.fn() }));

import {
    SsoSignInError,
    describeAppleError,
    describeGoogleError,
    readAppleCredential,
    readNonceResponse,
} from '../sso-signin';

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
        expect(readNonceResponse({ nonce: 'n', providers: ['apple', 'facebook', 7, null] }).providers)
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

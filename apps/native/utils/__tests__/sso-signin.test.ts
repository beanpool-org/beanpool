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
vi.mock('../node-post', () => ({ signedPost: vi.fn(), anchorUrl: vi.fn() }));

import {
    SsoSignInError,
    describeAppleError,
    readAppleCredential,
    readNonceResponse,
} from '../sso-signin';

describe('the nonce the node sends back', () => {
    it('accepts a well-formed answer and keeps the providers it named', () => {
        expect(readNonceResponse({ nonce: 'abc123', providers: ['google', 'apple'] }))
            .toEqual({ nonce: 'abc123', providers: ['google', 'apple'] });
    });

    it('refuses a missing, empty, or non-string nonce rather than passing it on', () => {
        // Each of these would otherwise reach the provider, come back inside a signed token, and
        // fail server-side as a nonce mismatch — which is indistinguishable from replay in the
        // logs. The node sent nothing; say that.
        for (const body of [{}, { nonce: '' }, { nonce: 42 }, { nonce: null }, null, undefined]) {
            expect(() => readNonceResponse(body), JSON.stringify(body)).toThrow(SsoSignInError);
            expect(() => readNonceResponse(body)).toThrow(/did not send a sign-in nonce/);
        }
    });

    it('drops provider names it does not recognise instead of offering them', () => {
        // A node advertising something this build cannot do would otherwise produce a button that
        // fails at the sheet. Unknown means unusable, not "try it and see".
        expect(readNonceResponse({ nonce: 'n', providers: ['apple', 'facebook', 7, null] }).providers)
            .toEqual(['apple']);
    });

    it('treats absent providers as "the node did not say", not as "none"', () => {
        // startSsoSignIn only enforces the list when it is non-empty. An older node that does not
        // send the field must not have every provider refused on its behalf.
        expect(readNonceResponse({ nonce: 'n' }).providers).toEqual([]);
    });
});

describe('what the Apple sheet threw', () => {
    it('reads a cancel as a cancel', () => {
        // The most common outcome by far, and not a failure: somebody opened the sheet to see
        // what it said. A caller that reported this as an error would turn a shrug into a
        // support ticket.
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

describe('the credential Apple hands back', () => {
    it('takes the token and the email when both are there', () => {
        expect(readAppleCredential({ identityToken: 'jwt.goes.here', email: 'someone@example.com' }))
            .toEqual({ idToken: 'jwt.goes.here', email: 'someone@example.com' });
    });

    it('accepts a credential with no email, because that is the normal case', () => {
        // Apple returns the email on the FIRST authorization only. Every sign-in after that has
        // none, so treating its absence as a failure would break the flow for everybody except
        // first-timers — and the server's own comment says the keeper list must render without it.
        expect(readAppleCredential({ identityToken: 'jwt', email: null }))
            .toEqual({ idToken: 'jwt', email: undefined });
        expect(readAppleCredential({ identityToken: 'jwt' })).toEqual({ idToken: 'jwt', email: undefined });
    });

    it('refuses a null token instead of sending the string "null" to the node', () => {
        // identityToken is genuinely nullable — a simulator with no Apple ID, an authorization
        // revoked mid-flow. Unchecked it becomes "null" in the request body and the node reports a
        // malformed JWT, sending whoever is debugging after the token rather than after the sheet.
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

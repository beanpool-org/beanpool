import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    normalizeNodeUrl,
    resolveNodeApiUrl,
    buildAdminHeaders,
    isTotpRequired,
    getTfaSessionToken,
    setTfaSessionToken,
    clearAllTfaSessionTokens,
} from './node-client';

describe('normalizeNodeUrl', () => {
    it('returns default URL when rawUrl is empty or whitespace', () => {
        expect(normalizeNodeUrl('')).toBe('https://localhost:8443');
        expect(normalizeNodeUrl('   ')).toBe('https://localhost:8443');
    });

    it('prepends https:// if scheme is missing', () => {
        expect(normalizeNodeUrl('example.com')).toBe('https://example.com');
        expect(normalizeNodeUrl('192.168.1.50:8443')).toBe('https://192.168.1.50:8443');
    });

    it('preserves existing http or https scheme', () => {
        expect(normalizeNodeUrl('http://localhost:8080')).toBe('http://localhost:8080');
        expect(normalizeNodeUrl('https://node.beanpool.org')).toBe('https://node.beanpool.org');
    });

    it('trims whitespace and removes trailing slashes', () => {
        expect(normalizeNodeUrl('  https://node.beanpool.org/// ')).toBe('https://node.beanpool.org');
    });
});

describe('buildAdminHeaders', () => {
    it('returns Content-Type application/json by default', () => {
        expect(buildAdminHeaders()).toEqual({ 'Content-Type': 'application/json' });
    });

    it('includes X-Admin-Password when password is provided', () => {
        expect(buildAdminHeaders('secret123')).toEqual({
            'Content-Type': 'application/json',
            'X-Admin-Password': 'secret123',
        });
    });

    it('includes X-Admin-2FA-Session when token is provided', () => {
        expect(buildAdminHeaders(undefined, 'tfa-token-abc')).toEqual({
            'Content-Type': 'application/json',
            'X-Admin-2FA-Session': 'tfa-token-abc',
        });
    });

    it('includes both password and 2FA session token when provided', () => {
        expect(buildAdminHeaders('secret123', 'tfa-token-abc')).toEqual({
            'Content-Type': 'application/json',
            'X-Admin-Password': 'secret123',
            'X-Admin-2FA-Session': 'tfa-token-abc',
        });
    });
});

describe('isTotpRequired', () => {
    it('returns true when response body totpRequired is true', () => {
        expect(isTotpRequired({ totpRequired: true })).toBe(true);
    });

    it('returns false when response body totpRequired is false or missing', () => {
        expect(isTotpRequired({ totpRequired: false })).toBe(false);
        expect(isTotpRequired({})).toBe(false);
        expect(isTotpRequired(null)).toBe(false);
        expect(isTotpRequired(undefined)).toBe(false);
    });
});

describe('TFA Session Token Helpers', () => {
    beforeEach(() => {
        sessionStorage.clear();
    });

    it('sets and gets TFA session token', () => {
        expect(getTfaSessionToken('profile1')).toBeUndefined();

        setTfaSessionToken('profile1', 'token-123');
        expect(getTfaSessionToken('profile1')).toBe('token-123');
    });

    it('removes token when setting token to undefined', () => {
        setTfaSessionToken('profile1', 'token-123');
        expect(getTfaSessionToken('profile1')).toBe('token-123');

        setTfaSessionToken('profile1', undefined);
        expect(getTfaSessionToken('profile1')).toBeUndefined();
    });

    it('clears all TFA session tokens without affecting other sessionStorage keys', () => {
        setTfaSessionToken('profile1', 'token-1');
        setTfaSessionToken('profile2', 'token-2');
        sessionStorage.setItem('unrelated_key', 'value');

        clearAllTfaSessionTokens();

        expect(getTfaSessionToken('profile1')).toBeUndefined();
        expect(getTfaSessionToken('profile2')).toBeUndefined();
        expect(sessionStorage.getItem('unrelated_key')).toBe('value');
    });
});

describe('resolveNodeApiUrl', () => {
    it('resolves direct endpoint when target origin matches current location origin', () => {
        vi.stubGlobal('location', { origin: 'https://node.beanpool.org' });

        const url = resolveNodeApiUrl('https://node.beanpool.org', '/api/local/admin/diagnostics');
        expect(url).toBe('https://node.beanpool.org/api/local/admin/diagnostics');

        vi.unstubAllGlobals();
    });

    it('routes through proxy when target node is on a different origin', () => {
        vi.stubGlobal('location', { origin: 'https://manager.beanpool.org' });

        const url = resolveNodeApiUrl('https://node.beanpool.org:8443', 'api/local/admin/diagnostics');
        expect(url).toBe('/proxy/https/node.beanpool.org:8443/api/local/admin/diagnostics');

        vi.unstubAllGlobals();
    });

    it('appends search parameters correctly', () => {
        vi.stubGlobal('location', { origin: 'https://node.beanpool.org' });

        const url = resolveNodeApiUrl('https://node.beanpool.org', '/api/local/admin/onboarding-funnel', { days: '30' });
        expect(url).toBe('https://node.beanpool.org/api/local/admin/onboarding-funnel?days=30');

        vi.unstubAllGlobals();
    });

    it('appends search parameters to proxied endpoint correctly', () => {
        vi.stubGlobal('location', { origin: 'https://manager.beanpool.org' });

        const url = resolveNodeApiUrl('https://node.beanpool.org', '/api/local/admin/onboarding-funnel', { days: '30' });
        expect(url).toBe('/proxy/https/node.beanpool.org/api/local/admin/onboarding-funnel?days=30');

        vi.unstubAllGlobals();
    });
});

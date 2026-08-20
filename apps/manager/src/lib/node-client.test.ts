import { describe, it, expect, beforeEach } from 'vitest';
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
    it('returns default fallback localhost URL for empty or whitespace inputs', () => {
        expect(normalizeNodeUrl('')).toBe('https://localhost:8443');
        expect(normalizeNodeUrl('   ')).toBe('https://localhost:8443');
    });

    it('prepends https:// when no protocol is provided', () => {
        expect(normalizeNodeUrl('node.example.com')).toBe('https://node.example.com');
        expect(normalizeNodeUrl('localhost:3000')).toBe('https://localhost:3000');
    });

    it('preserves http and https protocols', () => {
        expect(normalizeNodeUrl('http://192.168.1.50:8443')).toBe('http://192.168.1.50:8443');
        expect(normalizeNodeUrl('https://node.beanpool.net')).toBe('https://node.beanpool.net');
    });

    it('strips trailing slashes from the URL', () => {
        expect(normalizeNodeUrl('https://node.example.com/')).toBe('https://node.example.com');
        expect(normalizeNodeUrl('http://localhost:8443///')).toBe('http://localhost:8443');
    });
});

describe('resolveNodeApiUrl', () => {
    it('resolves direct node API URL when nodeUrl matches window origin', () => {
        const origin = window.location.origin; // e.g. http://localhost:3000
        expect(resolveNodeApiUrl(origin, 'api/local/admin/diagnostics')).toBe(
            `${origin}/api/local/admin/diagnostics`
        );
        expect(resolveNodeApiUrl(origin, '/api/local/admin/diagnostics')).toBe(
            `${origin}/api/local/admin/diagnostics`
        );
    });

    it('routes through proxy when nodeUrl differs from window origin', () => {
        expect(resolveNodeApiUrl('https://remote-node:8443', '/api/local/admin/diagnostics')).toBe(
            '/proxy/https/remote-node:8443/api/local/admin/diagnostics'
        );
    });

    it('attaches search parameters correctly', () => {
        const url = resolveNodeApiUrl(window.location.origin, '/api/local/admin/onboarding-funnel', {
            days: '30',
        });
        expect(url).toBe(`${window.location.origin}/api/local/admin/onboarding-funnel?days=30`);
    });
});

describe('buildAdminHeaders', () => {
    it('returns JSON content type header by default', () => {
        expect(buildAdminHeaders()).toEqual({
            'Content-Type': 'application/json',
        });
    });

    it('includes X-Admin-Password when password is provided', () => {
        expect(buildAdminHeaders('secret123')).toEqual({
            'Content-Type': 'application/json',
            'X-Admin-Password': 'secret123',
        });
    });

    it('includes X-Admin-2FA-Session when token is provided', () => {
        expect(buildAdminHeaders('secret123', 'tfa-token-abc')).toEqual({
            'Content-Type': 'application/json',
            'X-Admin-Password': 'secret123',
            'X-Admin-2FA-Session': 'tfa-token-abc',
        });
    });
});

describe('isTotpRequired', () => {
    it('returns true when totpRequired is explicitly true', () => {
        expect(isTotpRequired({ totpRequired: true })).toBe(true);
    });

    it('returns false when totpRequired is false or missing', () => {
        expect(isTotpRequired({ totpRequired: false })).toBe(false);
        expect(isTotpRequired({})).toBe(false);
        expect(isTotpRequired(null)).toBe(false);
        expect(isTotpRequired(undefined)).toBe(false);
    });
});

describe('2FA Session Token Helpers', () => {
    beforeEach(() => {
        sessionStorage.clear();
    });

    it('stores and retrieves 2FA session token for a profile', () => {
        expect(getTfaSessionToken('profile-1')).toBeUndefined();
        setTfaSessionToken('profile-1', 'token-xyz');
        expect(getTfaSessionToken('profile-1')).toBe('token-xyz');
    });

    it('removes token when setting undefined token', () => {
        setTfaSessionToken('profile-1', 'token-xyz');
        expect(getTfaSessionToken('profile-1')).toBe('token-xyz');
        setTfaSessionToken('profile-1', undefined);
        expect(getTfaSessionToken('profile-1')).toBeUndefined();
    });

    it('clears all 2FA session tokens without affecting other sessionStorage items', () => {
        sessionStorage.setItem('other_key', 'value');
        setTfaSessionToken('p1', 'token-1');
        setTfaSessionToken('p2', 'token-2');

        clearAllTfaSessionTokens();

        expect(getTfaSessionToken('p1')).toBeUndefined();
        expect(getTfaSessionToken('p2')).toBeUndefined();
        expect(sessionStorage.getItem('other_key')).toBe('value');
    });
});

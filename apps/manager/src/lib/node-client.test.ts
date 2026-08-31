import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    fetchHarvesterStatus,
    triggerHarvesterSync,
    fetchNodeHistory,
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

describe('harvester helpers send the manager credential', () => {
    // These three call /api/manager/* on the same origin, and every one of those routes is
    // behind checkAdminAuth. They previously sent no credential at all, so each answered 401
    // and the Harvested Fleet Backups tab sat permanently empty.
    let fetchMock: ReturnType<typeof vi.fn>;

    const lastCall = () => fetchMock.mock.calls[0];
    const headersOf = (init: any) => (init?.headers ?? {}) as Record<string, string>;

    beforeEach(() => {
        fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ nodes: [], harvestState: {}, history: [] }),
            text: async () => '',
        });
        vi.stubGlobal('fetch', fetchMock);
    });

    it('fetchHarvesterStatus sends X-Admin-Password', async () => {
        await fetchHarvesterStatus('manager-secret');
        const [url, init] = lastCall();
        expect(url).toBe('/api/manager/backups/status');
        expect(headersOf(init)['X-Admin-Password']).toBe('manager-secret');
    });

    it('fetchNodeHistory sends X-Admin-Password', async () => {
        await fetchNodeHistory('mullum', 'manager-secret');
        const [url, init] = lastCall();
        expect(url).toContain('/api/manager/backups/history');
        expect(headersOf(init)['X-Admin-Password']).toBe('manager-secret');
    });

    it('omits the header entirely when no password is held', async () => {
        await fetchHarvesterStatus(undefined);
        expect(headersOf(lastCall()[1])).not.toHaveProperty('X-Admin-Password');
    });

    it('never puts the credential in the URL', async () => {
        await fetchNodeHistory('mullum', 'manager-secret');
        expect(String(lastCall()[0])).not.toContain('manager-secret');
    });

    it('triggerHarvesterSync authenticates with the MANAGER password, not the target node\'s', async () => {
        // Two different secrets. The header authenticates us to the local manager API; the body
        // carries the target node's own credential for the server to forward. The server resolves
        // the target as `body.adminPassword || body.password || found.adminPassword`, so leaking
        // the manager password into `password` would override the configured per-node credential.
        await triggerHarvesterSync('mullum', 'https://mullum.example', 'node-secret', 'manager-secret');
        const [, init] = lastCall();
        expect(headersOf(init)['X-Admin-Password']).toBe('manager-secret');

        const body = JSON.parse((init as any).body);
        expect(body.adminPassword).toBe('node-secret');
        expect(body.password).toBe('node-secret');
        expect(JSON.stringify(body)).not.toContain('manager-secret');
    });

    it('falls back to the node password when no manager password is held', async () => {
        await triggerHarvesterSync('mullum', 'https://mullum.example', 'node-secret');
        expect(headersOf(lastCall()[1])['X-Admin-Password']).toBe('node-secret');
    });
});

describe('registrar claim helpers send admin password header', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    const lastCall = () => fetchMock.mock.calls[0];
    const headersOf = (init: any) => (init?.headers ?? {}) as Record<string, string>;

    beforeEach(() => {
        fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ status: 'approved', name: 'mycommunity' }),
        });
        vi.stubGlobal('fetch', fetchMock);
    });

    it('approveRegistrarClaim sends X-Admin-Password and body password when nodeUrl, name, and adminPassword are provided', async () => {
        const { approveRegistrarClaim } = await import('./node-client');
        await approveRegistrarClaim('https://node.example.com', 'mycommunity', 'secret123');
        const [url, init] = lastCall();
        expect(url).toContain('/api/local/admin/registrar/mycommunity/approve');
        expect(headersOf(init)['X-Admin-Password']).toBe('secret123');
        expect(JSON.parse((init as any).body)).toEqual({ password: 'secret123' });
    });

    it('revokeRegistrarClaim sends X-Admin-Password and body password when nodeUrl, name, and adminPassword are provided', async () => {
        const { revokeRegistrarClaim } = await import('./node-client');
        await revokeRegistrarClaim('https://node.example.com', 'mycommunity', 'secret123');
        const [url, init] = lastCall();
        expect(url).toContain('/api/local/admin/registrar/mycommunity/revoke');
        expect(headersOf(init)['X-Admin-Password']).toBe('secret123');
        expect(JSON.parse((init as any).body)).toEqual({ password: 'secret123' });
    });
});

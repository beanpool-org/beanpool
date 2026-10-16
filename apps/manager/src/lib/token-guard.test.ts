import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    tokenCannotReach,
    guardTokenFetch,
    installTokenFetchGuard,
    OWNER_PHONE_MESSAGE,
    TOKEN_REFUSED_CODE,
    OWNER_PHONE_EVENT,
    TOKEN_REPLACE_ADVICE,
} from './token-guard';

const VALID_TOKEN = 'bp_1234567890ab_1111111122222222333333334444444455555555666666667777777788888888';

describe('token-guard standalone functions', () => {
    describe('tokenCannotReach', () => {
        it('identifies owner-only and refused paths correctly', () => {
            expect(tokenCannotReach('/api/local/admin/auth')).toBe(true);
            expect(tokenCannotReach('/api/local/admin/auth/session')).toBe(true);
            expect(tokenCannotReach('/api/local/admin/automation-tokens')).toBe(true);
            expect(tokenCannotReach('/api/local/admin/2fa/verify')).toBe(true);
            expect(tokenCannotReach('/api/local/admin/ws-ticket')).toBe(true);
            expect(tokenCannotReach('/api/local/admin/csrf-token')).toBe(true);
            expect(tokenCannotReach('/api/local/admin/stranded-escrows/abc123/write-off')).toBe(true);
            expect(tokenCannotReach('/api/local/admin/public-address/claim')).toBe(true);
            expect(tokenCannotReach('/api/local/admin/takeover/recovery-code')).toBe(true);
            expect(tokenCannotReach('/api/local/admin/standby-health')).toBe(true);
            expect(tokenCannotReach('/api/local/admin/offbox-backups/restore')).toBe(true);
            expect(tokenCannotReach('/api/local/change-password')).toBe(true);
        });

        it('handles proxied URLs', () => {
            expect(tokenCannotReach('/proxy/https/node.example.com/api/local/admin/auth')).toBe(true);
            expect(tokenCannotReach('/proxy/http/localhost:8552/api/local/change-password/')).toBe(true);
        });

        it('allows reachable routes for automation tokens', () => {
            expect(tokenCannotReach('/api/local/admin/telemetry')).toBe(false);
            expect(tokenCannotReach('/api/local/admin/offbox-backups/status')).toBe(false);
            expect(tokenCannotReach('/api/local/admin/offbox-backups/list')).toBe(false);
            expect(tokenCannotReach('/api/local/admin/offbox-backups/run')).toBe(false);
            expect(tokenCannotReach('/api/local/admin/offbox-backups/download')).toBe(false);
            expect(tokenCannotReach('/proxy/https/node.example.com/api/local/admin/health')).toBe(false);
        });
    });

    describe('guardTokenFetch', () => {
        let mockFetchImpl: ReturnType<typeof vi.fn>;

        beforeEach(() => {
            mockFetchImpl = vi.fn();
        });

        it('passes through requests that do not carry an automation token', async () => {
            const expectedResponse = new Response('ok', { status: 200 });
            mockFetchImpl.mockResolvedValueOnce(expectedResponse);

            const fetchGuarded = guardTokenFetch(mockFetchImpl as unknown as typeof fetch);
            const res = await fetchGuarded('/api/local/admin/telemetry', {
                headers: { authorization: 'Bearer standard_admin_password' },
            });

            expect(mockFetchImpl).toHaveBeenCalledWith('/api/local/admin/telemetry', {
                headers: { authorization: 'Bearer standard_admin_password' },
            });
            expect(res).toBe(expectedResponse);
        });

        it('blocks tokens directed at manager API endpoints', async () => {
            const fetchGuarded = guardTokenFetch(mockFetchImpl as unknown as typeof fetch);
            const res = await fetchGuarded('/api/manager/profiles', {
                headers: { authorization: `Bearer ${VALID_TOKEN}` },
            });

            expect(mockFetchImpl).not.toHaveBeenCalled();
            expect(res.status).toBe(400);
            const body = await res.json();
            expect(body.error).toBe('A token goes only to its own node');
        });

        it('blocks owner-only routes and dispatches OWNER_PHONE_EVENT', async () => {
            const eventHandler = vi.fn();
            window.addEventListener(OWNER_PHONE_EVENT, eventHandler);

            const fetchGuarded = guardTokenFetch(mockFetchImpl as unknown as typeof fetch);
            const res = await fetchGuarded('/api/local/admin/auth/session', {
                headers: { authorization: `Bearer ${VALID_TOKEN}` },
            });

            expect(mockFetchImpl).not.toHaveBeenCalled();
            expect(eventHandler).toHaveBeenCalled();
            expect(res.status).toBe(403);
            expect(res.statusText).toBe(OWNER_PHONE_MESSAGE);

            const body = await res.json();
            expect(body).toEqual({
                error: OWNER_PHONE_MESSAGE,
                code: TOKEN_REFUSED_CODE,
                ownerPhoneNeeded: true,
            });

            window.removeEventListener(OWNER_PHONE_EVENT, eventHandler);
        });

        it('handles 401 token refused response from node', async () => {
            const nodeResponse = new Response(JSON.stringify({ error: 'Token expired' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
            });
            mockFetchImpl.mockResolvedValueOnce(nodeResponse);

            const fetchGuarded = guardTokenFetch(mockFetchImpl as unknown as typeof fetch);
            const res = await fetchGuarded('/api/local/admin/telemetry', {
                headers: { authorization: `Bearer ${VALID_TOKEN}` },
            });

            expect(res.status).toBe(401);
            expect(res.statusText).toBe('Token expired');
            const body = await res.json();
            expect(body.error).toBe(`Token expired. ${TOKEN_REPLACE_ADVICE}`);
            expect(body.tokenRefused).toBe(true);
        });

        it('handles non-JSON 401 token refused response gracefully', async () => {
            const nodeResponse = new Response('Unauthorized text', {
                status: 401,
            });
            mockFetchImpl.mockResolvedValueOnce(nodeResponse);

            const fetchGuarded = guardTokenFetch(mockFetchImpl as unknown as typeof fetch);
            const res = await fetchGuarded('/api/local/admin/telemetry', {
                headers: { authorization: `Bearer ${VALID_TOKEN}` },
            });

            expect(res.status).toBe(401);
            expect(res.statusText).toBe('The node refused this automation token');
            const body = await res.json();
            expect(body.error).toBe(`The node refused this automation token. ${TOKEN_REPLACE_ADVICE}`);
            expect(body.tokenRefused).toBe(true);
        });

        it('handles 403 token_not_allowed response from node', async () => {
            const eventHandler = vi.fn();
            window.addEventListener(OWNER_PHONE_EVENT, eventHandler);

            const nodeResponse = new Response(
                JSON.stringify({ code: TOKEN_REFUSED_CODE, error: 'Write scope required' }),
                { status: 403, headers: { 'Content-Type': 'application/json' } }
            );
            mockFetchImpl.mockResolvedValueOnce(nodeResponse);

            const fetchGuarded = guardTokenFetch(mockFetchImpl as unknown as typeof fetch);
            const res = await fetchGuarded('/api/local/admin/custom-endpoint', {
                headers: { authorization: `Bearer ${VALID_TOKEN}` },
            });

            expect(eventHandler).toHaveBeenCalled();
            expect(res.status).toBe(403);
            const body = await res.json();
            expect(body).toEqual({
                serverError: 'Write scope required',
                error: OWNER_PHONE_MESSAGE,
                code: TOKEN_REFUSED_CODE,
                ownerPhoneNeeded: true,
            });

            window.removeEventListener(OWNER_PHONE_EVENT, eventHandler);
        });

        it('passes through 403 responses without token_not_allowed code', async () => {
            const eventHandler = vi.fn();
            window.addEventListener(OWNER_PHONE_EVENT, eventHandler);

            const nodeResponse = new Response(
                JSON.stringify({ code: 'ip_blocked', error: 'IP address forbidden' }),
                { status: 403, headers: { 'Content-Type': 'application/json' } }
            );
            mockFetchImpl.mockResolvedValueOnce(nodeResponse);

            const fetchGuarded = guardTokenFetch(mockFetchImpl as unknown as typeof fetch);
            const res = await fetchGuarded('/api/local/admin/custom-endpoint', {
                headers: { authorization: `Bearer ${VALID_TOKEN}` },
            });

            expect(eventHandler).not.toHaveBeenCalled();
            expect(res).toBe(nodeResponse);

            window.removeEventListener(OWNER_PHONE_EVENT, eventHandler);
        });

        it('extracts bearer token from a Request object input', async () => {
            const eventHandler = vi.fn();
            window.addEventListener(OWNER_PHONE_EVENT, eventHandler);

            const req = new Request('http://localhost/api/local/admin/auth/session', {
                headers: { authorization: `Bearer ${VALID_TOKEN}` },
            });

            const fetchGuarded = guardTokenFetch(mockFetchImpl as unknown as typeof fetch);
            const res = await fetchGuarded(req);

            expect(mockFetchImpl).not.toHaveBeenCalled();
            expect(eventHandler).toHaveBeenCalled();
            expect(res.status).toBe(403);

            window.removeEventListener(OWNER_PHONE_EVENT, eventHandler);
        });
    });

    describe('installTokenFetchGuard', () => {
        const originalFetch = window.fetch;

        afterEach(() => {
            window.fetch = originalFetch;
        });

        it('wraps window.fetch once', () => {
            const startFetch = window.fetch;
            installTokenFetchGuard();
            const wrappedFetch = window.fetch;
            expect(wrappedFetch).not.toBe(startFetch);

            installTokenFetchGuard();
            expect(window.fetch).toBe(wrappedFetch);
        });
    });
});

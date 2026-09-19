import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    formatCountdown,
    formatShortCode,
    startPhonePairing,
    waitForPhone,
    PHONE_SIGNIN_MESSAGES,
} from './phone-signin';

describe('phone-signin utilities', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    describe('formatCountdown', () => {
        it('formats milliseconds into M:SS correctly', () => {
            expect(formatCountdown(65000)).toBe('1:05');
            expect(formatCountdown(120000)).toBe('2:00');
            expect(formatCountdown(5000)).toBe('0:05');
            expect(formatCountdown(0)).toBe('0:00');
            expect(formatCountdown(-5000)).toBe('0:00');
        });
    });

    describe('formatShortCode', () => {
        it('formats 6-character short code into two 3-character groups', () => {
            expect(formatShortCode('K7F3QX')).toBe('K7F 3QX');
        });

        it('returns raw string for non-6-character codes', () => {
            expect(formatShortCode('ABC')).toBe('ABC');
            expect(formatShortCode('1234567')).toBe('1234567');
        });
    });

    describe('startPhonePairing', () => {
        it('returns ok with pairing details on success', async () => {
            const fakeFetch = vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({
                    pairingId: 'p-123',
                    shortCode: 'K7F3QX',
                    ttlMs: 60000,
                }),
            } as Response);
            globalThis.fetch = fakeFetch;

            const now = () => 1000000;
            const res = await startPhonePairing(now);

            expect(res).toEqual({
                kind: 'ok',
                pairing: {
                    pairingId: 'p-123',
                    shortCode: 'K7F3QX',
                    ttlMs: 60000,
                    expiresAt: 1060000,
                },
            });
            expect(fakeFetch).toHaveBeenCalledWith('/api/local/admin/auth/pairing', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });
        });

        it('uses default ttlMs when not provided in response', async () => {
            const fakeFetch = vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({
                    pairingId: 'p-123',
                    shortCode: 'K7F3QX',
                }),
            } as Response);
            globalThis.fetch = fakeFetch;

            const now = () => 1000;
            const res = await startPhonePairing(now);

            expect(res).toEqual({
                kind: 'ok',
                pairing: {
                    pairingId: 'p-123',
                    shortCode: 'K7F3QX',
                    ttlMs: 120000,
                    expiresAt: 121000,
                },
            });
        });

        it('returns error when endpoint returns 404', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 404,
                json: async () => ({}),
            } as Response);

            const res = await startPhonePairing();

            expect(res).toEqual({
                kind: 'error',
                message: "This node doesn't offer phone sign-in yet. Use the admin password.",
            });
        });

        it('returns custom error message or status error fallback', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 400,
                json: async () => ({ error: 'Custom error' }),
            } as Response);

            const res1 = await startPhonePairing();
            expect(res1).toEqual({ kind: 'error', message: 'Custom error' });

            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 500,
                json: async () => ({}),
            } as Response);

            const res2 = await startPhonePairing();
            expect(res2).toEqual({ kind: 'error', message: 'The node did not answer (500).' });
        });

        it('handles network failure gracefully', async () => {
            globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network offline'));

            const res = await startPhonePairing();

            expect(res).toEqual({
                kind: 'error',
                message: 'Could not reach the node.',
            });
        });
    });

    describe('waitForPhone', () => {
        it('returns waiting status with optional notice', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                status: 200,
                json: async () => ({ status: 'waiting', notice: 'not-admin' }),
            } as Response);

            const res1 = await waitForPhone('p-123');
            expect(res1).toEqual({ kind: 'waiting', notice: 'not-admin' });

            globalThis.fetch = vi.fn().mockResolvedValue({
                status: 200,
                json: async () => ({ status: 'waiting' }),
            } as Response);

            const res2 = await waitForPhone('p-123');
            expect(res2).toEqual({ kind: 'waiting', notice: null });
        });

        it('returns signed-in status when valid session and token are returned', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                status: 200,
                json: async () => ({
                    status: 'signed-in',
                    role: 'admin',
                    memberPubkey: 'pubkey-abc',
                    csrfToken: 'csrf-xyz',
                }),
            } as Response);

            const res = await waitForPhone('p-123');

            expect(res).toEqual({
                kind: 'signed-in',
                session: {
                    memberPubkey: 'pubkey-abc',
                    role: 'admin',
                },
                csrfToken: 'csrf-xyz',
            });
        });

        it('returns ended with failed message when role or pubkey is missing/invalid', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                status: 200,
                json: async () => ({
                    status: 'signed-in',
                    role: 'invalid-role',
                    memberPubkey: 'pubkey-abc',
                    csrfToken: 'csrf-xyz',
                }),
            } as Response);

            const res = await waitForPhone('p-123');

            expect(res).toEqual({
                kind: 'ended',
                message: PHONE_SIGNIN_MESSAGES.failed,
            });
        });

        it('returns retry on network failure or 500/429 status', async () => {
            globalThis.fetch = vi.fn().mockRejectedValue(new Error('Fetch failed'));
            expect(await waitForPhone('p-123')).toEqual({ kind: 'retry' });

            globalThis.fetch = vi.fn().mockResolvedValue({ status: 500, json: async () => ({}) } as Response);
            expect(await waitForPhone('p-123')).toEqual({ kind: 'retry' });

            globalThis.fetch = vi.fn().mockResolvedValue({ status: 429, json: async () => ({}) } as Response);
            expect(await waitForPhone('p-123')).toEqual({ kind: 'retry' });
        });

        it('handles specific ended and expired status codes correctly', async () => {
            const cases: Array<[string, unknown]> = [
                ['expired', { kind: 'expired' }],
                ['unknown', { kind: 'expired' }],
                ['declined', { kind: 'ended', message: PHONE_SIGNIN_MESSAGES.declined }],
                ['refused', { kind: 'ended', message: PHONE_SIGNIN_MESSAGES.refused }],
                ['used', { kind: 'ended', message: PHONE_SIGNIN_MESSAGES.used }],
                ['wrong-browser', { kind: 'ended', message: PHONE_SIGNIN_MESSAGES.wrongBrowser }],
                ['something-else', { kind: 'ended', message: PHONE_SIGNIN_MESSAGES.failed }],
            ];

            for (const [status, expected] of cases) {
                globalThis.fetch = vi.fn().mockResolvedValue({
                    status: 200,
                    json: async () => ({ status }),
                } as Response);

                const res = await waitForPhone('p-123');
                expect(res).toEqual(expected);
            }
        });
    });
});

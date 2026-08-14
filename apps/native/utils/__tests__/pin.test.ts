import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getPinStatus, setRecoveryPin, verifyRecoveryPin } from '../pin';
import type { BeanPoolIdentity } from '../identity';

vi.mock('../node-post', () => ({
    signedPost: vi.fn(),
}));

import { signedPost } from '../node-post';

const mockIdentity: BeanPoolIdentity = {
    callsign: 'Alice',
    publicKey: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
    privateKey: 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100',
    createdAt: '2026-08-14T00:00:00.000Z',
};

describe('pin.ts client utilities', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        globalThis.fetch = vi.fn();
    });

    describe('getPinStatus', () => {
        it('returns pinSet true when node reports PIN is set', async () => {
            (signedPost as any).mockResolvedValueOnce({
                ok: true,
                json: async () => ({ pinSet: true }),
            });

            const res = await getPinStatus('https://test.beanpool.org', mockIdentity);
            expect(res.pinSet).toBe(true);
            expect(signedPost).toHaveBeenCalledWith(
                'https://test.beanpool.org',
                '/api/recovery/pin/status',
                {},
                mockIdentity,
            );
        });

        it('returns pinSet false when node reports no PIN is set', async () => {
            (signedPost as any).mockResolvedValueOnce({
                ok: true,
                json: async () => ({ pinSet: false }),
            });

            const res = await getPinStatus('https://test.beanpool.org', mockIdentity);
            expect(res.pinSet).toBe(false);
        });

        it('handles network error gracefully', async () => {
            (signedPost as any).mockRejectedValueOnce(new Error('Network offline'));

            const res = await getPinStatus('https://test.beanpool.org', mockIdentity);
            expect(res.pinSet).toBe(false);
            expect(res.error).toBe('Network offline');
        });
    });

    describe('setRecoveryPin', () => {
        it('rejects invalid non-6-digit PIN before sending request', async () => {
            const res1 = await setRecoveryPin('https://test.beanpool.org', mockIdentity, '12345');
            expect(res1.ok).toBe(false);
            expect(res1.error).toContain('6 digits');
            expect(signedPost).not.toHaveBeenCalled();

            const res2 = await setRecoveryPin('https://test.beanpool.org', mockIdentity, '12345a');
            expect(res2.ok).toBe(false);
            expect(res2.error).toContain('6 digits');
        });

        it('successfully sets a valid 6-digit PIN', async () => {
            (signedPost as any).mockResolvedValueOnce({
                ok: true,
                json: async () => ({ ok: true, pinSet: true }),
            });

            const res = await setRecoveryPin('https://test.beanpool.org', mockIdentity, '123456');
            expect(res.ok).toBe(true);
            expect(res.pinSet).toBe(true);
            expect(signedPost).toHaveBeenCalledWith(
                'https://test.beanpool.org',
                '/api/recovery/pin/set',
                { pin: '123456' },
                mockIdentity,
            );
        });

        it('clears PIN when null or empty string is passed', async () => {
            (signedPost as any).mockResolvedValueOnce({
                ok: true,
                json: async () => ({ ok: true, pinSet: false }),
            });

            const res = await setRecoveryPin('https://test.beanpool.org', mockIdentity, null);
            expect(res.ok).toBe(true);
            expect(res.pinSet).toBe(false);
            expect(signedPost).toHaveBeenCalledWith(
                'https://test.beanpool.org',
                '/api/recovery/pin/set',
                { pin: null },
                mockIdentity,
            );
        });
    });

    describe('verifyRecoveryPin', () => {
        it('rejects invalid PIN format locally', async () => {
            const res = await verifyRecoveryPin('https://test.beanpool.org', 'Alice', '123');
            expect(res.verified).toBe(false);
            expect(res.error).toContain('6 digits');
            expect(globalThis.fetch).not.toHaveBeenCalled();
        });

        it('returns keepers when PIN is verified by the node', async () => {
            (globalThis.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    verified: true,
                    keepers: [{ type: 'friend', count: 5 }],
                }),
            });

            const res = await verifyRecoveryPin('https://test.beanpool.org', 'Alice', '123456');
            expect(res.verified).toBe(true);
            expect(res.keepers).toEqual([{ type: 'friend', count: 5 }]);
            expect(globalThis.fetch).toHaveBeenCalledWith(
                'https://test.beanpool.org/api/recovery/pin/verify',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ callsign: 'Alice', pin: '123456' }),
                },
            );
        });

        it('returns verified false when PIN does not match', async () => {
            (globalThis.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    verified: false,
                    keepers: null,
                }),
            });

            const res = await verifyRecoveryPin('https://test.beanpool.org', 'Alice', '999999');
            expect(res.verified).toBe(false);
            expect(res.keepers).toBeNull();
        });
    });
});

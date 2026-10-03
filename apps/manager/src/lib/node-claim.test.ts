import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    CLAIM_PATH,
    CLAIM_POLL_MS,
    CLAIM_TIMEOUT_MS,
    CLAIM_COMMAND,
    fetchClaimState,
    buildClaimQr,
} from './node-claim';

describe('node-claim lib', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    describe('exported constants', () => {
        it('has expected constant values', () => {
            expect(CLAIM_PATH).toBe('/api/local/claim');
            expect(CLAIM_POLL_MS).toBe(5_000);
            expect(CLAIM_TIMEOUT_MS).toBe(8_000);
            expect(CLAIM_COMMAND).toBe('docker compose exec beanpool-node beanpool claim');
        });
    });

    describe('buildClaimQr', () => {
        it('appends id query parameter when codeId is valid 8 lower-case hex digits', () => {
            const qr = buildClaimQr('http://localhost:3000', '1a2b3c4d');
            expect(qr).toBe('beanpool://claim?node=http%3A%2F%2Flocalhost%3A3000&id=1a2b3c4d');
        });

        it('omits id query parameter when codeId is null', () => {
            const qr = buildClaimQr('http://localhost:3000', null);
            expect(qr).toBe('beanpool://claim?node=http%3A%2F%2Flocalhost%3A3000');
        });

        it('omits id query parameter when codeId is invalid (e.g. upper-case, too short, or too long)', () => {
            expect(buildClaimQr('http://localhost:3000', '1A2B3C4D')).toBe('beanpool://claim?node=http%3A%2F%2Flocalhost%3A3000');
            expect(buildClaimQr('http://localhost:3000', '12345')).toBe('beanpool://claim?node=http%3A%2F%2Flocalhost%3A3000');
            expect(buildClaimQr('http://localhost:3000', '123456789')).toBe('beanpool://claim?node=http%3A%2F%2Flocalhost%3A3000');
            expect(buildClaimQr('http://localhost:3000', 'zzzzzzzz')).toBe('beanpool://claim?node=http%3A%2F%2Flocalhost%3A3000');
        });
    });

    describe('fetchClaimState', () => {
        it('returns claimed state when response body has unclaimed === false', async () => {
            vi.stubGlobal(
                'fetch',
                vi.fn().mockResolvedValue({
                    ok: true,
                    json: async () => ({ unclaimed: false }),
                } as Response)
            );

            const result = await fetchClaimState('/api/local/claim');
            expect(result).toEqual({ kind: 'claimed' });
        });

        it('returns unclaimed state with codeId, communityName, and password when valid', async () => {
            vi.stubGlobal(
                'fetch',
                vi.fn().mockResolvedValue({
                    ok: true,
                    json: async () => ({
                        unclaimed: true,
                        codeId: 'deadbeef',
                        communityName: '  Bean Town  ',
                        password: false,
                    }),
                } as Response)
            );

            const result = await fetchClaimState('/api/local/claim');
            expect(result).toEqual({
                kind: 'unclaimed',
                codeId: 'deadbeef',
                communityName: 'Bean Town',
                password: false,
            });
        });

        it('defaults password to true if password !== false', async () => {
            vi.stubGlobal(
                'fetch',
                vi.fn().mockResolvedValue({
                    ok: true,
                    json: async () => ({
                        unclaimed: true,
                        codeId: '00000000',
                        communityName: 'Test',
                    }),
                } as Response)
            );

            const result = await fetchClaimState('/api/local/claim');
            expect(result).toEqual({
                kind: 'unclaimed',
                codeId: '00000000',
                communityName: 'Test',
                password: true,
            });
        });

        it('sanitizes invalid codeId or communityName to null', async () => {
            vi.stubGlobal(
                'fetch',
                vi.fn().mockResolvedValue({
                    ok: true,
                    json: async () => ({
                        unclaimed: true,
                        codeId: 'INVALID_CODE',
                        communityName: '   ',
                    }),
                } as Response)
            );

            const result = await fetchClaimState('/api/local/claim');
            expect(result).toEqual({
                kind: 'unclaimed',
                codeId: null,
                communityName: null,
                password: true,
            });
        });

        it('returns unknown state for HTTP error responses or non-object bodies', async () => {
            const fetchMock = vi.fn();
            vi.stubGlobal('fetch', fetchMock);

            // Non-ok HTTP status
            fetchMock.mockResolvedValueOnce({ ok: false } as Response);
            expect(await fetchClaimState('/api/local/claim')).toEqual({ kind: 'unknown' });

            // Non-object body (null)
            fetchMock.mockResolvedValueOnce({ ok: true, json: async () => null } as Response);
            expect(await fetchClaimState('/api/local/claim')).toEqual({ kind: 'unknown' });

            // Missing unclaimed property
            fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ foo: 'bar' }) } as Response);
            expect(await fetchClaimState('/api/local/claim')).toEqual({ kind: 'unknown' });
        });

        it('returns unknown state when fetch throws network error', async () => {
            vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Network Error')));
            const result = await fetchClaimState('/api/local/claim');
            expect(result).toEqual({ kind: 'unknown' });
        });

        it('aborts and returns unknown state on request timeout', async () => {
            vi.useFakeTimers();
            vi.stubGlobal(
                'fetch',
                vi.fn().mockImplementation((_url, init?: RequestInit) => {
                    return new Promise((_resolve, reject) => {
                        init?.signal?.addEventListener('abort', () => {
                            reject(new DOMException('Aborted', 'AbortError'));
                        });
                    });
                })
            );

            const promise = fetchClaimState('/api/local/claim');
            vi.advanceTimersByTime(CLAIM_TIMEOUT_MS);
            const result = await promise;
            expect(result).toEqual({ kind: 'unknown' });
        });

        it('respects external AbortSignal', async () => {
            const controller = new AbortController();
            vi.stubGlobal(
                'fetch',
                vi.fn().mockImplementation((_url, init?: RequestInit) => {
                    return new Promise((_resolve, reject) => {
                        init?.signal?.addEventListener('abort', () => {
                            reject(new DOMException('Aborted', 'AbortError'));
                        });
                    });
                })
            );

            const promise = fetchClaimState('/api/local/claim', controller.signal);
            controller.abort();
            const result = await promise;
            expect(result).toEqual({ kind: 'unknown' });
        });
    });
});

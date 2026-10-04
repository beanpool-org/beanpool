import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    CLAIM_PATH,
    CLAIM_POLL_MS,
    CLAIM_TIMEOUT_MS,
    CLAIM_COMMAND,
    fetchClaimState,
    buildClaimQr,
    sanitizeNodeAddress,
    fetchCommunityInfo,
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

        it.each([
            ['a claimed new install with no admin password', { unclaimed: false, password: false }, { kind: 'claimed', password: false, retired: false }],
            ['a claimed server whose password an owner retired', { unclaimed: false, password: false, passwordRetired: true }, { kind: 'claimed', password: false, retired: true }],
            ['a claimed server with an admin password', { unclaimed: false, password: true }, { kind: 'claimed' }],
        ])('reads %s', async (_name, body, expected) => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body } as Response));
            expect(await fetchClaimState('/api/local/claim')).toEqual(expected);
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
                primaryAddress: null,
                address: null,
                addresses: [],
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
                primaryAddress: null,
                address: null,
                addresses: [],
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
                primaryAddress: null,
                address: null,
                addresses: [],
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

        it('ignores any address fields returned by /api/local/claim', async () => {
            vi.stubGlobal(
                'fetch',
                vi.fn().mockResolvedValue({
                    ok: true,
                    json: async () => ({
                        unclaimed: true,
                        codeId: 'deadbeef',
                        communityName: 'Test Town',
                        address: 'https://test.beanpool.org',
                        primaryAddress: 'https://test.beanpool.org',
                        addresses: ['test.beanpool.org'],
                    }),
                } as Response)
            );

            const result = await fetchClaimState('/api/local/claim');
            expect(result).toEqual({
                kind: 'unclaimed',
                codeId: 'deadbeef',
                communityName: 'Test Town',
                password: true,
                primaryAddress: null,
                address: null,
                addresses: [],
            });
        });
    });

    describe('fetchCommunityInfo', () => {
        it('fetches /api/community/info and returns primaryAddress and addresses', async () => {
            vi.stubGlobal(
                'fetch',
                vi.fn().mockResolvedValue({
                    ok: true,
                    json: async () => ({
                        primaryAddress: 'Town.BeanPool.org',
                        addresses: ['Town.BeanPool.org', 'town.example.org'],
                    }),
                } as Response)
            );

            const result = await fetchCommunityInfo('/api/community/info');
            expect(result).toEqual({
                primaryAddress: 'town.beanpool.org',
                addresses: ['town.beanpool.org', 'town.example.org'],
            });
        });

        it('returns null primaryAddress and empty addresses on error or non-200 response', async () => {
            const fetchMock = vi.fn();
            vi.stubGlobal('fetch', fetchMock);

            fetchMock.mockResolvedValueOnce({ ok: false, status: 500 } as Response);
            expect(await fetchCommunityInfo('/api/community/info')).toEqual({
                primaryAddress: null,
                addresses: [],
            });

            fetchMock.mockRejectedValueOnce(new TypeError('Network error'));
            expect(await fetchCommunityInfo('/api/community/info')).toEqual({
                primaryAddress: null,
                addresses: [],
            });
        });
    });

    describe('sanitizeNodeAddress', () => {
        it('returns null for empty, non-string, or invalid inputs', () => {
            expect(sanitizeNodeAddress(null)).toBeNull();
            expect(sanitizeNodeAddress(undefined)).toBeNull();
            expect(sanitizeNodeAddress('')).toBeNull();
            expect(sanitizeNodeAddress('   ')).toBeNull();
            expect(sanitizeNodeAddress(123)).toBeNull();
            expect(sanitizeNodeAddress({})).toBeNull();
        });

        it('normalizes a bare hostname into an https origin', () => {
            expect(sanitizeNodeAddress('community.beanpool.org')).toBe('https://community.beanpool.org');
            expect(sanitizeNodeAddress('town.example.org:8443')).toBe('https://town.example.org:8443');
        });

        it('preserves a valid https origin', () => {
            expect(sanitizeNodeAddress('https://community.beanpool.org')).toBe('https://community.beanpool.org');
            expect(sanitizeNodeAddress('https://community.beanpool.org/')).toBe('https://community.beanpool.org');
            expect(sanitizeNodeAddress('https://town.example.org:8443')).toBe('https://town.example.org:8443');
        });

        it('rejects hostile schemes and inputs (only https origins allowed)', () => {
            expect(sanitizeNodeAddress('http://community.beanpool.org')).toBeNull();
            expect(sanitizeNodeAddress('javascript:alert(1)')).toBeNull();
            expect(sanitizeNodeAddress('data:text/html,<script>alert(1)</script>')).toBeNull();
            expect(sanitizeNodeAddress('//evil.example.com')).toBeNull();
            expect(sanitizeNodeAddress('ftp://files.example.com')).toBeNull();
            expect(sanitizeNodeAddress('https://user:pass@evil.com')).toBeNull();
            expect(sanitizeNodeAddress('https://evil.com/path')).toBeNull();
            expect(sanitizeNodeAddress('https://evil.com?query=1')).toBeNull();
            expect(sanitizeNodeAddress('https://evil.com#hash')).toBeNull();
            expect(sanitizeNodeAddress('<script>alert(1)</script>')).toBeNull();
        });
    });
});


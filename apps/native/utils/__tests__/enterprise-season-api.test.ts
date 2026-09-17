import { describe, it, expect, vi, beforeEach } from 'vitest';

// db.ts pulls in device modules at import time; stub them at the boundary (same set as apply-delta.test.ts).
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? 'https://test.beanpool.org' : null)),
        setItem: vi.fn(async () => {}),
        removeItem: vi.fn(async () => {}),
        getAllKeys: vi.fn(async () => []),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid' }));
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: '/tmp/cache/' }));
vi.mock('../identity', () => ({
    loadIdentity: vi.fn(async () => ({ publicKey: 'me-pub', privateKey: 'me-priv', callsign: 'Me' })),
}));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn(), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, path: string) => ({ 'X-Signed': `${method} ${path}` })),
}));

import {
    pauseEnterprise, resumeEnterprise, initiateWindUp, cancelWindUp, finaliseWindUp, getEnterpriseLedger,
} from '../db';
import { buildSignedHeaders } from '../crypto';

const fetchMock = vi.fn();

function reply(status: number, body: any) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
    fetchMock.mockReset();
    (buildSignedHeaders as any).mockClear();
    (globalThis as any).fetch = fetchMock;
});

describe('enterprise season calls (native API client)', () => {
    const cases: Array<[string, (t: string) => Promise<any>, string]> = [
        ['pause', pauseEnterprise, '/api/enterprise/ent%2F1/pause'],
        ['resume', resumeEnterprise, '/api/enterprise/ent%2F1/resume'],
        ['start wind-up', initiateWindUp, '/api/enterprise/ent%2F1/wind-up/initiate'],
        ['cancel wind-up', cancelWindUp, '/api/enterprise/ent%2F1/wind-up/cancel'],
        ['finalise wind-up', finaliseWindUp, '/api/enterprise/ent%2F1/wind-up/finalise'],
    ];

    for (const [label, call, path] of cases) {
        it(`${label} is a signed POST to the same route the web app uses`, async () => {
            fetchMock.mockResolvedValueOnce(reply(200, { success: true }));
            await expect(call('ent/1')).resolves.toEqual({ success: true });

            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toBe(`https://test.beanpool.org${path}`);
            expect(init.method).toBe('POST');
            expect(init.body).toBe('{}');
            // Signed over the exact path and body it sends — no actor rides the body.
            expect(buildSignedHeaders).toHaveBeenCalledWith('POST', path, '{}', 'me-priv', 'me-pub');
            expect(init.headers).toEqual({ 'X-Signed': `POST ${path}` });
        });
    }

    it("surfaces the server's own refusal, e.g. a non-lead starting wind-up", async () => {
        fetchMock.mockResolvedValueOnce(reply(403, { error: 'Only the lead keeper may initiate wind-up' }));
        await expect(initiateWindUp('ent1')).rejects.toThrow('Only the lead keeper may initiate wind-up');
    });
});

describe('getEnterpriseLedger', () => {
    it('is a signed GET with the period in the query string, signed over the bare path', async () => {
        const body = { summary: { totalIncome: 5 }, entries: [] };
        fetchMock.mockResolvedValueOnce(reply(200, body));
        await expect(getEnterpriseLedger('ent1', { since: '2026-08-18T00:00:00.000Z' })).resolves.toEqual(body);

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://test.beanpool.org/api/enterprise/ent1/ledger?since=2026-08-18T00%3A00%3A00.000Z');
        expect(init.method).toBe('GET');
        expect(buildSignedHeaders).toHaveBeenCalledWith('GET', '/api/enterprise/ent1/ledger', '', 'me-priv', 'me-pub');
    });

    it('has no query string for all time', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { entries: [] }));
        await getEnterpriseLedger('ent1');
        expect(fetchMock.mock.calls[0][0]).toBe('https://test.beanpool.org/api/enterprise/ent1/ledger');
    });

    it('throws instead of pretending the ledger is empty when the node refuses', async () => {
        fetchMock.mockResolvedValueOnce(reply(404, { error: 'Not a treasury' }));
        await expect(getEnterpriseLedger('nope')).rejects.toThrow('Not a treasury');
    });
});

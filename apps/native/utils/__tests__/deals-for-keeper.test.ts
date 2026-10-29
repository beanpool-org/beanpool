import { describe, it, expect, vi, beforeEach } from 'vitest';

// utils/db.ts getDealsFor (deals S4): a keeper reading one of their enterprise's listings is shown its open deals, read
// for it from the node (GET /api/marketplace/transactions). The node's page is the 50 newest, across all its listings,
// so the enterprise's held deals and its requests are each read by themselves: a held deal behind 50 newer finished ones
// (a shop's brisk sales) still has its row and its Release. The node is stubbed as it answers; utils/db is the real one,
// with the stand-ins marketplace-transactions-304.test.ts uses for its storage and identity.

const ANCHOR = 'https://test.beanpool.org';
const ENT = 'farm-co'.padEnd(64, '0');
const store = new Map<string, string>();
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(async () => ({})) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.set(k, String(v)); }),
        removeItem: vi.fn(async (k: string) => { store.delete(k); }),
        getAllKeys: vi.fn(async () => [...store.keys()]),
        multiRemove: vi.fn(async (ks: string[]) => { for (const k of ks) store.delete(k); }),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid', getRandomBytes: () => new Uint8Array(16) }));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/',
    getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    makeDirectoryAsync: vi.fn().mockResolvedValue(undefined),
    writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: 'me'.padEnd(64, '0'), privateKey: '11'.repeat(32), callsign: 'Me' })) }));
vi.mock('../nodes', () => ({
    getDatabaseFilenameForNode: vi.fn((url: string | null) => (url ? `beanpool_${new URL(url).hostname}.db` : 'beanpool_none.db')),
    addSavedNode: vi.fn(async () => {}),
}));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));

import { getDealsFor } from '../db';

const deal = (id: string, status: string, createdAt: string, postId = 'p-1') => ({
    id, postId, status, buyerPublicKey: ENT, sellerPublicKey: 'mo-key', credits: 20, createdAt,
});

/** The enterprise's deals on the node, and every read the phone made of them. */
const node = { deals: [] as Array<ReturnType<typeof deal>>, failing: null as string | null };
const asked: URL[] = [];
const answer = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: () => null } });

beforeEach(() => {
    store.clear();
    store.set('beanpool_anchor_url', ANCHOR);
    node.deals = [];
    node.failing = null;
    asked.length = 0;
    // As routes/marketplace.ts answers: of one status when asked, the 50 newest.
    globalThis.fetch = vi.fn(async (input: string) => {
        const url = new URL(input);
        asked.push(url);
        if (url.pathname !== '/api/marketplace/transactions') return answer(404, {});
        const status = url.searchParams.get('status');
        if (status && status === node.failing) return answer(500, { error: 'busy' });
        const limit = Number(url.searchParams.get('limit') || 50);
        return answer(200, node.deals.filter(d => !status || d.status === status)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.min(limit, 50)));
    }) as unknown as typeof fetch;
});

describe('getDealsFor: an enterprise’s open deals for its keeper', () => {
    it('asks for its held deals and its requests, each by itself', async () => {
        node.deals = [deal('tx-held', 'pending', '2026-10-24T10:00:00.000Z'), deal('tx-asked', 'requested', '2026-10-25T10:00:00.000Z'),
            deal('tx-done', 'completed', '2026-10-26T10:00:00.000Z')];
        const got = await getDealsFor(ENT);
        expect(asked.map(u => [u.searchParams.get('publicKey'), u.searchParams.get('status')]).sort()).toEqual([[ENT, 'pending'], [ENT, 'requested']]);
        expect(got.map(d => d.id).sort()).toEqual(['tx-asked', 'tx-held']);
    });

    it('a held deal behind 50 newer finished ones is still there', async () => {
        node.deals = [
            ...Array.from({ length: 50 }, (_, i) => deal(`tx-sold-${i}`, 'completed', new Date(Date.parse('2026-10-27T00:00:00.000Z') + i * 60_000).toISOString(), 'eggs')),
            deal('tx-old', 'pending', '2026-10-01T10:00:00.000Z'),
        ];
        expect((await getDealsFor(ENT)).map(d => d.id)).toEqual(['tx-old']);
    });

    it('a status whose read fails gives nothing of it, and the other still comes', async () => {
        node.deals = [deal('tx-held', 'pending', '2026-10-24T10:00:00.000Z'), deal('tx-asked', 'requested', '2026-10-25T10:00:00.000Z')];
        node.failing = 'requested';
        expect((await getDealsFor(ENT)).map(d => d.id)).toEqual(['tx-held']);
    });
});

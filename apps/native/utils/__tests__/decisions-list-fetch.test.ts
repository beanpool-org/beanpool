import { describe, it, expect, vi, beforeEach } from 'vitest';

// db.ts pulls in device modules at import time; stub them at the boundary (same set as enterprise-season-api.test.ts).
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

import { getDecisions } from '../db';

const fetchMock = vi.fn();

function reply(status: number, body: any) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const card = (myVote?: any) => ({ id: 'd1', title: 'Suspend spammer', status: 'open', ...(myVote !== undefined ? { myVote } : {}) });

beforeEach(() => {
    fetchMock.mockReset();
    (globalThis as any).fetch = fetchMock;
});

describe('getDecisions (native)', () => {
    it('signs the list so the node can return your own vote', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { decisions: [card({ support: true, voteCount: 1 })], myPoolVoting: { voiceCredits: 16, hasCompletedTrade: true } }));
        const res = await getDecisions();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://test.beanpool.org/api/commons/decisions');
        expect(init.headers['X-Signed']).toBe('GET /api/commons/decisions');
        expect(res.decisions[0].myVote).toEqual({ support: true, voteCount: 1 });
        expect(res.myPoolVoting).toEqual({ voiceCredits: 16, hasCompletedTrade: true });
    });

    it('passes on whether the node says the signer may propose', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { decisions: [], myPoolVoting: null, canPropose: true }));
        expect((await getDecisions()).canPropose).toBe(true);
    });

    it('when the signature is refused (a phone clock that is off), loads the list unsigned', async () => {
        fetchMock
            .mockResolvedValueOnce(reply(401, { error: 'Request timestamp is too far from server time' }))
            .mockResolvedValueOnce(reply(200, { decisions: [card()], myPoolVoting: null, canPropose: false }));
        const res = await getDecisions('open');

        expect(fetchMock).toHaveBeenCalledTimes(2);
        const [url, init] = fetchMock.mock.calls[1];
        expect(url).toBe('https://test.beanpool.org/api/commons/decisions?status=open');
        expect(init.headers['X-Signed']).toBeUndefined();
        expect(res.decisions.map(d => d.id)).toEqual(['d1']);
        expect(res.decisions[0].myVote).toBeUndefined();
        // Unsigned, the node cannot say whether you may propose: null, so the app falls back instead of blocking.
        expect(res.canPropose).toBeNull();
    });

    it('does not retry on other failures', async () => {
        fetchMock.mockResolvedValueOnce(reply(500, { error: 'boom' }));
        const res = await getDecisions();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(res).toEqual({ decisions: [], myPoolVoting: null, canPropose: null });
    });
});

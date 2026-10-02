/**
 * The post and event report forms show a failed report's message to the member (app/post/[id].tsx, components/
 * EventDetail.tsx): it is the node's sentence when it sent one beside its code, never the code. A report on a post that
 * is no longer at the community answers 404 `{ error: 'not_found', message: 'That post is not here any more.' }`.
 * Nothing here contacts a node: fetch is a stub.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// db.ts pulls in device modules at import time; stub them at the boundary (same set as decisions-list-fetch.test.ts).
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
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));

import { reportAbuse, signedRequest } from '../db';

const fetchMock = vi.fn();
const reply = (status: number, body: any) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

beforeEach(() => {
    fetchMock.mockReset();
    (globalThis as any).fetch = fetchMock;
});

describe('reportAbuse (native)', () => {
    it("a report on a post that is no longer there fails with the node's sentence, the code kept beside it", async () => {
        fetchMock.mockResolvedValueOnce(reply(404, { error: 'not_found', message: 'That post is not here any more.' }));
        const err: any = await reportAbuse('me-pub', 'them-pub', 'Spam', 'post-gone').catch(e => e);
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe('That post is not here any more.');
        expect(err.code).toBe('not_found');
        expect(err.status).toBe(404);
    });

    it('an answer with no sentence keeps what the node said', async () => {
        fetchMock.mockResolvedValueOnce(reply(400, { error: 'Failed — must be a registered member, cannot report yourself' }));
        const err: any = await reportAbuse('me-pub', 'me-pub', 'Spam').catch(e => e);
        expect(err.message).toBe('Failed — must be a registered member, cannot report yourself');
        expect(err.status).toBe(400);
    });

    it('a report the node takes answers as before', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true, report: { id: 'r1' } }));
        expect(await reportAbuse('me-pub', 'them-pub', 'Spam', 'post-1')).toEqual({ success: true, report: { id: 'r1' } });
    });

    it("other signed requests keep the node's code as their message, for the callers that match on it", async () => {
        fetchMock.mockResolvedValueOnce(reply(404, { error: 'not_found', message: 'That post is not here any more.' }));
        const err: any = await signedRequest('/api/anything', {}).catch(e => e);
        expect(err.message).toBe('not_found');
        expect(err.nodeMessage).toBe('That post is not here any more.');
    });
});

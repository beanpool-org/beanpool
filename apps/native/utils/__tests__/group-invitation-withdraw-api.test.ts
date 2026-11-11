import { describe, it, expect, vi, beforeEach } from 'vitest';

// db.ts pulls in device modules at import time; stub them at the boundary (same set as decisions-list-fetch.test.ts).
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? 'https://test.beanpool.example' : null)),
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

import { withdrawGroupInvitationApi } from '../db';

/**
 * The phone's "Withdraw" on a group's invitations list (review of #3061): its own request,
 * DELETE /api/groups/:id/invitations/:pubkey, signed, never the member removal DELETE …/members/:pubkey. The list on
 * screen may be minutes old; if the person accepted since, a removal would remove a member who has just joined, where
 * the withdrawal is refused by the node (409, "already joined") and the phone says so.
 */

const fetchMock = vi.fn();

function reply(status: number, body: any) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
    fetchMock.mockReset();
    (globalThis as any).fetch = fetchMock;
});

describe('withdrawGroupInvitationApi (native)', () => {
    it("DELETEs the group's invitation to that person, signed, and not their membership", async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true }));
        expect(await withdrawGroupInvitationApi('g1', 'pk-ann')).toBe(true);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://test.beanpool.example/api/groups/g1/invitations/pk-ann');
        expect(url).not.toContain('/members/');
        expect(init.method).toBe('DELETE');
        // Signed over the exact URL it sends (its host and path: request binding).
        expect(init.headers['X-Signed']).toBe('DELETE https://test.beanpool.example/api/groups/g1/invitations/pk-ann');
        // Nobody invited is in the chat: no key, no epoch, no body.
        expect(init.body).toBeUndefined();
    });

    it("throws the node's own words when the person has already joined, and sends nothing else", async () => {
        const words = 'They have already joined the group, so there is no invitation to withdraw. They are in the roster now.';
        fetchMock.mockResolvedValueOnce(reply(409, { error: words, code: 'already_joined' }));
        await expect(withdrawGroupInvitationApi('g1', 'pk-ann')).rejects.toThrow(words);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('escapes the ids rather than letting them shape the path', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true }));
        await withdrawGroupInvitationApi('a/b c', 'pk/../x');
        expect(fetchMock.mock.calls[0][0]).toBe('https://test.beanpool.example/api/groups/a%2Fb%20c/invitations/pk%2F..%2Fx');
    });
});

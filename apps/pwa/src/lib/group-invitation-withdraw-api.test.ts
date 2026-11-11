import { describe, it, expect, vi, beforeEach } from 'vitest';

// No identity: the call is being checked for the path it sends, not for the signature the shared `request` wrapper adds
// on top (lib/api, "Sign every request that has an identity available").
vi.mock('./identity', () => ({ loadIdentity: vi.fn(async () => null) }));

import { withdrawGroupInvitation, removeGroupMember } from './api';

/**
 * The group page's "Withdraw" (review of #3061): its own request, DELETE /api/groups/:id/invitations/:pubkey, never the
 * member removal DELETE …/members/:pubkey. The list on screen may be minutes old; if the person accepted since, a removal
 * would remove a member who has just joined, where the withdrawal is refused by the node (409, "already joined").
 */

const fetchMock = vi.fn();

function reply(status: number, body: any) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

describe('withdrawGroupInvitation', () => {
    it("DELETEs the group's invitation to that person, not their membership", async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true }));
        expect(await withdrawGroupInvitation('g1', 'pk-ann')).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/groups/g1/invitations/pk-ann');
        expect(init.method).toBe('DELETE');
        expect(url).not.toContain('/members/');
    });

    it("passes the node's refusal through in its own words when the person has already joined", async () => {
        const words = 'They have already joined the group, so there is no invitation to withdraw. They are in the roster now.';
        fetchMock.mockResolvedValueOnce(reply(409, { error: words, code: 'already_joined' }));
        await expect(withdrawGroupInvitation('g1', 'pk-ann')).rejects.toThrow(words);
        // Nothing else is tried after the refusal: no removal goes out in its place.
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('escapes the ids rather than letting them shape the path', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true }));
        await withdrawGroupInvitation('a/b c', 'pk/../x');
        expect(fetchMock.mock.calls[0][0]).toBe('/api/groups/a%2Fb%20c/invitations/pk%2F..%2Fx');
    });

    it('the member removal is a different request (unchanged)', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true }));
        await removeGroupMember('g1', 'pk-ann');
        expect(fetchMock.mock.calls[0][0]).toBe('/api/groups/g1/members/pk-ann');
        expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
    });
});

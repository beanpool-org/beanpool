import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// No identity: the call is being checked for what it rings, not for the signature the shared `request` wrapper adds.
vi.mock('./identity', () => ({ loadIdentity: vi.fn(async () => null) }));

import { updateMemberProfile } from './api';
import { PROFILE_SAVED_EVENT } from './profile-saved';

/**
 * A save of the member's own profile is heard by the page (the sidebar's picture reads it again, App useOwnAvatar), and
 * only a save the node took: a refused one leaves the old picture where it is.
 */

const fetchMock = vi.fn();
const heard = vi.fn();

function reply(status: number, body: any) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
    fetchMock.mockReset();
    heard.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    window.addEventListener(PROFILE_SAVED_EVENT, heard);
});
afterEach(() => window.removeEventListener(PROFILE_SAVED_EVENT, heard));

describe('updateMemberProfile', () => {
    it('rings PROFILE_SAVED_EVENT once the node has taken the save', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true, profile: { publicKey: 'k', avatar: 'bundled://sun', bio: '', contact: null } }));
        await updateMemberProfile('k', { avatar: 'bundled://sun' });
        expect(fetchMock.mock.calls[0][0]).toBe('/api/profile/update');
        expect(heard).toHaveBeenCalledTimes(1);
    });

    it('a save the node refuses rings nothing', async () => {
        fetchMock.mockResolvedValueOnce(reply(400, { error: 'Invalid avatar' }));
        await expect(updateMemberProfile('k', { avatar: 'nope' })).rejects.toThrow();
        expect(heard).not.toHaveBeenCalled();
    });
});

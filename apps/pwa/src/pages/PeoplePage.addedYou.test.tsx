/**
 * People → Friends: "added you · Add back" (GET /api/friends/added-you, the member's own), and an add the community
 * refuses (100 a day, or someone you blocked) said in its words instead of dropped. The node's routes are mocked at
 * lib/api; the server side is apps/server/src/test-friends-added-you.ts.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { PeoplePage } from './PeoplePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';

vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../lib/blocklist', () => ({ getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}) }));
vi.mock('./InvitePage', () => ({ InvitePage: () => <div>Invite codes</div> }));

const identity: BeanPoolIdentity = { publicKey: 'me-pubkey', privateKey: 'mock-private-key-hex', callsign: 'Me', createdAt: '2026-09-17T00:00:00.000Z' };
const ana = { publicKey: 'ana-pubkey', callsign: 'Ana', avatarUrl: null, addedAt: '2026-10-14T00:00:00.000Z' };

beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getFriends').mockResolvedValue([]);
    vi.spyOn(api, 'getMembers').mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe('People → Friends: who added you', () => {
    it('names each one with Add back, and how many more', async () => {
        vi.spyOn(api as any, 'getAddedYou').mockResolvedValue({ addedYou: [ana], more: 2 });
        render(<PeoplePage identity={identity} />);
        const list = await screen.findByTestId('added-you');
        expect(list).toHaveTextContent('Ana added you');
        expect(list).toHaveTextContent('and 2 more');
        expect(screen.getByRole('button', { name: 'Add Ana back' })).toBeInTheDocument();
    });

    it('Add back adds them and the line goes', async () => {
        vi.spyOn(api as any, 'getAddedYou').mockResolvedValue({ addedYou: [ana], more: 0 });
        const add = vi.spyOn(api, 'addFriendApi').mockResolvedValue({ success: true, friend: { publicKey: ana.publicKey, callsign: 'Ana', addedAt: '', isGuardian: false } as any });
        render(<PeoplePage identity={identity} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Add Ana back' }));
        await waitFor(() => expect(add).toHaveBeenCalledWith('me-pubkey', 'ana-pubkey'));
        await waitFor(() => expect(screen.queryByTestId('added-you')).toBeNull());
    });

    it("an add the community refuses is said in its words, and the line stays", async () => {
        vi.spyOn(api as any, 'getAddedYou').mockResolvedValue({ addedYou: [ana], more: 0 });
        vi.spyOn(api, 'addFriendApi').mockRejectedValue(new Error('You can add 100 people in any 24 hours. You can add someone again in about 5 hours.'));
        render(<PeoplePage identity={identity} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Add Ana back' }));
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('You can add 100 people in any 24 hours. You can add someone again in about 5 hours.');
        expect(screen.getByTestId('added-you')).toHaveTextContent('Ana added you');
    });

    it('nothing shows when nobody has, or the community can\'t say', async () => {
        vi.spyOn(api as any, 'getAddedYou').mockRejectedValue(Object.assign(new Error('You may only read your own friends'), { status: 403 }));
        render(<PeoplePage identity={identity} />);
        expect(await screen.findByText('No friends yet')).toBeInTheDocument();
        expect(screen.queryByTestId('added-you')).toBeNull();
    });
});

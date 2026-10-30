import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { PeoplePage } from './PeoplePage';
import type { BeanPoolIdentity } from '../lib/identity';
import type { CommunityInfo } from '../lib/api';

vi.mock('../lib/avatar', () => ({
    resolveAvatarUrl: vi.fn((url) => url),
}));

vi.mock('../lib/blocklist', () => ({
    getBlockedUsers: vi.fn(() => []),
    onBlocklistUpdated: vi.fn(() => () => {}),
}));

vi.mock('./InvitePage', () => ({
    InvitePage: () => <div>Invite codes</div>,
}));

let mockCommunityInfo: CommunityInfo | null = null;
vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => mockCommunityInfo),
}));

let mockAdminRole: string | null = null;
let mockKnocksResponse: { ok: boolean; status?: number; message?: string; knocks?: any[]; total?: number } = {
    ok: false,
    status: 500,
    message: 'Server error',
};

vi.mock('../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/api')>();
    return {
        ...actual,
        getFriends: vi.fn(async () => []),
        getAddedYou: vi.fn(async () => []),
        getMembers: vi.fn(async () => []),
        request: vi.fn(async (method: string, path: string) => {
            if (path === '/api/node-admin/me') {
                return { role: mockAdminRole, communityName: 'Test' };
            }
            return {};
        }),
        getJoinRequests: vi.fn(async () => mockKnocksResponse),
    };
});

const IDENTITY: BeanPoolIdentity = {
    publicKey: 'a'.repeat(64),
    privateKey: 'b'.repeat(96),
    callsign: 'Ana',
    createdAt: '2026-10-01T00:00:00.000Z',
};

const info = (features: Record<string, unknown>, profile: 'local' | 'global' = 'local') =>
    ({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile, features }) as unknown as CommunityInfo;

describe('PeoplePage: requests to join gating (front doors S2)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        mockKnocksResponse = { ok: false, status: 500, message: 'Server error' };
    });

    it('where only admins invite and member is not an admin, a 500 read never shows an error line', async () => {
        mockCommunityInfo = info({ door: 'admins', knocks: true, invites: true });
        mockAdminRole = null; // not an admin

        render(<PeoplePage identity={IDENTITY} initialView="invites" />);

        // Wait for communityInfo and node-admin/me to settle
        await waitFor(() => {
            expect(screen.queryByTestId('wants-to-join-error')).toBeNull();
            expect(screen.queryByTestId('wants-to-join')).toBeNull();
            expect(screen.queryByRole('alert')).toBeNull();
        });
    });

    it('in a community that takes no requests, a 500 read never shows an error line', async () => {
        mockCommunityInfo = info({ door: 'members', knocks: false, invites: true });
        mockAdminRole = null;

        render(<PeoplePage identity={IDENTITY} initialView="invites" />);

        await waitFor(() => {
            expect(screen.queryByTestId('wants-to-join-error')).toBeNull();
            expect(screen.queryByTestId('wants-to-join')).toBeNull();
            expect(screen.queryByRole('alert')).toBeNull();
        });
    });

    it('on the global node, a 500 read never shows an error line', async () => {
        mockCommunityInfo = info({ door: 'open', knocks: false, invites: false }, 'global');
        mockAdminRole = null;

        render(<PeoplePage identity={IDENTITY} initialView="invites" />);

        await waitFor(() => {
            expect(screen.queryByTestId('wants-to-join-error')).toBeNull();
            expect(screen.queryByTestId('wants-to-join')).toBeNull();
            expect(screen.queryByRole('alert')).toBeNull();
        });
    });

    it('where only admins invite and member is an admin, an error IS shown when the read fails', async () => {
        mockCommunityInfo = info({ door: 'admins', knocks: true, invites: true });
        mockAdminRole = 'admin';

        render(<PeoplePage identity={IDENTITY} initialView="invites" />);

        expect(await screen.findByTestId('wants-to-join-error')).toHaveTextContent('Server error');
        expect(screen.getByTestId('wants-to-join')).toBeInTheDocument();
    });
});

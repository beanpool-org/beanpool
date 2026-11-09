import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

/**
 * A notice that someone asked to join must never land on nothing (9 Nov: an owner of Byron tapped it and found Invites with no
 * list). App opens People → Invites with `fromNotice` from the line "N people asked to join"; WantsToJoin's own words are
 * tested in components/WantsToJoin.test.tsx, and what is checked here is what People hands it, and when it stops.
 */
describe('PeoplePage: Invites opened from the line "N people asked to join"', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        mockKnocksResponse = { ok: true, knocks: [], total: 0 };
        mockCommunityInfo = info({ door: 'admins', knocks: true, invites: true });
        mockAdminRole = 'owner';
    });

    it('an owner, nobody waiting: the section says so and that another owner or admin may have answered', async () => {
        render(<PeoplePage identity={IDENTITY} initialView="invites" fromNotice />);
        expect(await screen.findByTestId('wants-to-join-nobody')).toHaveTextContent('Nobody is waiting to join right now.');
        expect(screen.getByTestId('wants-to-join-answered-already')).toHaveTextContent('Another owner or admin may have answered already.');
    });

    it('Invites opened any other way (the tab bar, "Invite friends"): the page stays quiet', async () => {
        render(<PeoplePage identity={IDENTITY} initialView="invites" />);
        await waitFor(() => expect(screen.getByText('Invite codes')).toBeInTheDocument());
        await new Promise(r => setTimeout(r, 30));
        expect(screen.queryByTestId('wants-to-join-nobody')).toBeNull();
        expect(screen.queryByTestId('wants-to-join-empty')).toBeNull();
    });

    it('a member who may not see requests (not an admin where only admins invite): no section, notice or not', async () => {
        mockAdminRole = null;
        render(<PeoplePage identity={IDENTITY} initialView="invites" fromNotice />);
        await waitFor(() => expect(screen.getByText('Invite codes')).toBeInTheDocument());
        await new Promise(r => setTimeout(r, 30));
        expect(screen.queryByTestId('wants-to-join-nobody')).toBeNull();
        expect(screen.queryByTestId('wants-to-join-empty')).toBeNull();
    });

    it('picking another tab ends it: back on Invites, an ordinary visit, and App is told the view changed', async () => {
        const onViewChange = vi.fn();
        render(<PeoplePage identity={IDENTITY} initialView="invites" fromNotice onViewChange={onViewChange} />);
        expect(await screen.findByTestId('wants-to-join-nobody')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('tab', { name: /Friends/ }));
        expect(onViewChange).toHaveBeenLastCalledWith('friends');
        fireEvent.click(screen.getByRole('tab', { name: /Invites/ }));
        expect(onViewChange).toHaveBeenLastCalledWith('invites');
        await waitFor(() => expect(screen.getByText('Invite codes')).toBeInTheDocument());
        await new Promise(r => setTimeout(r, 30));
        expect(screen.queryByTestId('wants-to-join-nobody')).toBeNull();
    });

    it('opened by the line again (App raises it and the nav nonce): it is a notice\'s visit again', async () => {
        const { rerender } = render(<PeoplePage identity={IDENTITY} initialView="invites" navNonce={1} />);
        await waitFor(() => expect(screen.getByText('Invite codes')).toBeInTheDocument());
        expect(screen.queryByTestId('wants-to-join-nobody')).toBeNull();
        rerender(<PeoplePage identity={IDENTITY} initialView="invites" navNonce={2} fromNotice />);
        expect(await screen.findByTestId('wants-to-join-nobody')).toBeInTheDocument();
    });
});

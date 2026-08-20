import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { PeoplePage } from './PeoplePage';
import * as api from '../lib/api';
import type { BeanPoolIdentity } from '../lib/identity';

vi.mock('../lib/api', () => ({
    getFriends: vi.fn(),
    getMembers: vi.fn(),
    addFriendApi: vi.fn(),
    removeFriendApi: vi.fn(),
    setGuardianApi: vi.fn(),
}));

const mockIdentity: BeanPoolIdentity = {
    publicKey: 'pubkey-user-1',
    privateKey: 'privkey-user-1',
    callsign: 'UserOne',
    createdAt: new Date().toISOString(),
};

describe('PeoplePage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('loadMembers error handling & functionality', () => {
        it('handles getMembers rejection silently (offline state) and turns off loading state', async () => {
            vi.mocked(api.getFriends).mockResolvedValue([]);
            vi.mocked(api.getMembers).mockRejectedValue(new Error('Network error / offline'));

            render(<PeoplePage identity={mockIdentity} initialView="community" />);

            // Initially shows loading state
            expect(screen.getByText('Loading community...')).toBeInTheDocument();

            // Wait for getMembers to fail and setLoading(false) to execute
            await waitFor(() => {
                expect(screen.queryByText('Loading community...')).not.toBeInTheDocument();
            });

            // Verify getMembers was called
            expect(api.getMembers).toHaveBeenCalledTimes(1);

            // Community view should render without crashing (showing search input)
            expect(screen.getByPlaceholderText('🔍 Search members...')).toBeInTheDocument();
        });

        it('populates members list and filters by search query when getMembers resolves', async () => {
            vi.mocked(api.getFriends).mockResolvedValue([]);
            vi.mocked(api.getMembers).mockResolvedValue([
                {
                    publicKey: 'pubkey-member-2',
                    callsign: 'Alice',
                    joinedAt: new Date().toISOString(),
                    invitedBy: 'pubkey-user-1',
                    inviteCode: 'INV123',
                },
                {
                    publicKey: 'pubkey-member-3',
                    callsign: 'Bob',
                    joinedAt: new Date().toISOString(),
                    invitedBy: 'pubkey-user-1',
                    inviteCode: 'INV124',
                },
            ]);

            render(<PeoplePage identity={mockIdentity} initialView="community" />);

            await waitFor(() => {
                expect(screen.queryByText('Loading community...')).not.toBeInTheDocument();
            });

            expect(screen.getByText('Alice')).toBeInTheDocument();
            expect(screen.getByText('Bob')).toBeInTheDocument();

            // Filter search input for "Alice"
            const searchInput = screen.getByPlaceholderText('🔍 Search members...');
            fireEvent.change(searchInput, { target: { value: 'Alice' } });

            expect(screen.getByText('Alice')).toBeInTheDocument();
            expect(screen.queryByText('Bob')).not.toBeInTheDocument();
        });
    });

    describe('loadFriends error handling & functionality', () => {
        it('handles getFriends rejection silently (offline state)', async () => {
            vi.mocked(api.getFriends).mockRejectedValue(new Error('Offline error'));

            render(<PeoplePage identity={mockIdentity} initialView="friends" />);

            await waitFor(() => {
                expect(api.getFriends).toHaveBeenCalledWith(mockIdentity.publicKey);
            });

            // UI should gracefully show empty state without crashing
            expect(screen.getByText('No friends yet')).toBeInTheDocument();
        });

        it('displays loaded friends list', async () => {
            vi.mocked(api.getFriends).mockResolvedValue([
                {
                    publicKey: 'pubkey-friend-1',
                    callsign: 'Charlie',
                    addedAt: new Date().toISOString(),
                    isGuardian: false,
                },
            ]);

            render(<PeoplePage identity={mockIdentity} initialView="friends" />);

            await waitFor(() => {
                expect(screen.getByText('Charlie')).toBeInTheDocument();
            });
        });
    });
});

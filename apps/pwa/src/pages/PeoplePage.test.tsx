import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PeoplePage } from './PeoplePage';
import * as api from '../lib/api';
import type { BeanPoolIdentity } from '../lib/identity';

vi.mock('../lib/api', () => ({
    getFriends: vi.fn(),
    getMembers: vi.fn(),
    addFriendApi: vi.fn(),
    removeFriendApi: vi.fn(),
    setGuardianApi: vi.fn(),
    resolveAvatarUrl: vi.fn(),
    getMyInvites: vi.fn().mockResolvedValue({ invites: [] }),
    generateInvite: vi.fn(),
}));

describe('PeoplePage', () => {
    const mockIdentity: BeanPoolIdentity = {
        publicKey: 'pub_test_123',
        privateKey: 'priv_test_123',
        callsign: 'TestUser',
        createdAt: new Date().toISOString(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('loadFriends & Friends View', () => {
        it('loads and displays friends when getFriends resolves successfully', async () => {
            const friendsData: api.FriendEntry[] = [
                {
                    publicKey: 'pub_friend_1',
                    callsign: 'Alice',
                    addedAt: new Date().toISOString(),
                    isGuardian: false,
                },
                {
                    publicKey: 'pub_friend_2',
                    callsign: 'Bob',
                    addedAt: new Date().toISOString(),
                    isGuardian: true,
                },
            ];

            vi.mocked(api.getFriends).mockResolvedValueOnce(friendsData);

            render(<PeoplePage identity={mockIdentity} initialView="friends" />);

            expect(api.getFriends).toHaveBeenCalledWith(mockIdentity.publicKey);

            await waitFor(() => {
                expect(screen.getByText('Alice')).toBeInTheDocument();
                expect(screen.getByText('Bob')).toBeInTheDocument();
                expect(screen.getByText('Guardian')).toBeInTheDocument();
            });
        });

        it('handles getFriends rejection silently (offline state) without crashing', async () => {
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            vi.mocked(api.getFriends).mockRejectedValueOnce(new Error('Network error (offline)'));

            render(<PeoplePage identity={mockIdentity} initialView="friends" />);

            expect(api.getFriends).toHaveBeenCalledWith(mockIdentity.publicKey);

            await waitFor(() => {
                expect(screen.getByText('No friends yet')).toBeInTheDocument();
            });

            consoleErrorSpy.mockRestore();
        });
    });

    describe('loadMembers & Community View', () => {
        it('loads community members when navigating to community view', async () => {
            vi.mocked(api.getFriends).mockResolvedValueOnce([]);
            vi.mocked(api.getMembers).mockResolvedValueOnce([
                {
                    publicKey: 'pub_member_1',
                    callsign: 'Charlie',
                    joinedAt: new Date().toISOString(),
                    invitedBy: 'pub_test_123',
                    inviteCode: 'CODE123',
                },
            ]);

            render(<PeoplePage identity={mockIdentity} initialView="friends" />);

            const communityTab = screen.getByText('🏘️ Community');
            fireEvent.click(communityTab);

            await waitFor(() => {
                expect(api.getMembers).toHaveBeenCalled();
                expect(screen.getByText('Charlie')).toBeInTheDocument();
            });
        });

        it('handles getMembers rejection silently (offline state)', async () => {
            vi.mocked(api.getFriends).mockResolvedValueOnce([]);
            vi.mocked(api.getMembers).mockRejectedValueOnce(new Error('Community fetch error (offline)'));

            render(<PeoplePage identity={mockIdentity} initialView="friends" />);

            const communityTab = screen.getByText('🏘️ Community');
            fireEvent.click(communityTab);

            await waitFor(() => {
                expect(api.getMembers).toHaveBeenCalled();
                expect(screen.queryByText('Loading community...')).not.toBeInTheDocument();
            });
        });
    });

    describe('Friend actions error handling', () => {
        it('handles handleAddFriend rejection gracefully', async () => {
            vi.mocked(api.getFriends).mockResolvedValue([]);
            vi.mocked(api.getMembers).mockResolvedValue([
                {
                    publicKey: 'pub_member_1',
                    callsign: 'Dave',
                    joinedAt: new Date().toISOString(),
                    invitedBy: 'pub_test_123',
                    inviteCode: 'CODE456',
                },
            ]);
            vi.mocked(api.addFriendApi).mockRejectedValueOnce(new Error('Failed to add friend'));

            render(<PeoplePage identity={mockIdentity} initialView="community" />);

            await waitFor(() => {
                expect(screen.getByText('Dave')).toBeInTheDocument();
            });

            const addButton = screen.getByRole('button', { name: '+ Add' });
            fireEvent.click(addButton);

            await waitFor(() => {
                expect(api.addFriendApi).toHaveBeenCalledWith(mockIdentity.publicKey, 'pub_member_1');
            });
        });

        it('handles handleRemoveFriend rejection gracefully', async () => {
            vi.mocked(api.getFriends).mockResolvedValue([
                {
                    publicKey: 'pub_friend_1',
                    callsign: 'Eve',
                    addedAt: new Date().toISOString(),
                    isGuardian: false,
                },
            ]);
            vi.mocked(api.removeFriendApi).mockRejectedValueOnce(new Error('Failed to remove friend'));

            render(<PeoplePage identity={mockIdentity} initialView="friends" />);

            await waitFor(() => {
                expect(screen.getByText('Eve')).toBeInTheDocument();
            });

            const removeButton = screen.getByText('Remove');
            fireEvent.click(removeButton);

            await waitFor(() => {
                expect(api.removeFriendApi).toHaveBeenCalledWith(mockIdentity.publicKey, 'pub_friend_1');
                expect(screen.getByText('Eve')).toBeInTheDocument();
            });
        });

        it('handles handleToggleGuardian rejection gracefully', async () => {
            vi.mocked(api.getFriends).mockResolvedValue([
                {
                    publicKey: 'pub_friend_1',
                    callsign: 'Frank',
                    addedAt: new Date().toISOString(),
                    isGuardian: false,
                },
            ]);
            vi.mocked(api.setGuardianApi).mockRejectedValueOnce(new Error('Failed to toggle guardian'));

            render(<PeoplePage identity={mockIdentity} initialView="guardians" />);

            await waitFor(() => {
                expect(screen.getByText('Frank')).toBeInTheDocument();
            });

            const makeGuardianButton = screen.getByText('Make Guardian');
            fireEvent.click(makeGuardianButton);

            await waitFor(() => {
                expect(api.setGuardianApi).toHaveBeenCalledWith(mockIdentity.publicKey, 'pub_friend_1', true);
            });
        });
    });
});

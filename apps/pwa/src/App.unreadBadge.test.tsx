/**
 * Test: web-unread-badge — the Chat number clears when the chat is read.
 *
 * Marty, 1 Nov, on the web app: a group showed 5 and the sidebar's Chat showed 5.
 * He opened the group; the group's 5 went, the sidebar's stayed until he refreshed the page.
 * Both must clear at once.
 *
 * 1. Open a chat with 5 unread, the sidebar's count goes to 0 with no page refresh and no timer advanced.
 * 2. No extra reads on a chat with nothing unread.
 * 3. DMs, group chats, enterprise and event chats alike.
 */

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { App } from './App';
import * as api from './lib/api';

if (typeof window !== 'undefined') {
    window.matchMedia = window.matchMedia || vi.fn().mockImplementation(() => ({
        matches: false, media: '', onchange: null,
        addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
}

if (typeof window !== 'undefined' && window.HTMLElement) {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
}

vi.mock('./components/InstallPrompt', () => ({ InstallPrompt: () => null }));
vi.mock('./components/SyncStatus', () => ({ SyncStatus: () => <div data-testid="sync-status">Synced</div> }));
vi.mock('./components/ProfileSetup', () => ({ ProfileSetup: () => <div>Profile setup</div> }));
vi.mock('./components/ReportModal', () => ({ ReportModal: () => null }));

vi.mock('./lib/identity', () => ({
    loadIdentity: vi.fn(async () => ({ publicKey: 'my-user-pubkey', privateKey: 'my-user-privkey', callsign: 'Alice' })),
    updateCallsign: vi.fn(),
}));

vi.mock('./lib/sync', () => ({
    connectToAnchor: vi.fn(),
    onSyncActivity: vi.fn(() => () => {}),
    onSystemAnnouncement: vi.fn(() => () => {}),
    onSocketOpen: vi.fn(() => () => {}),
    socketIsAlive: vi.fn(() => false),
}));

vi.mock('./lib/archetypes', () => ({
    consumeChatPrefill: vi.fn(() => null),
}));

vi.mock('./lib/avatar', () => ({
    resolveAvatarUrl: vi.fn((url) => url),
}));

vi.mock('./lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false),
    blockUser: vi.fn(),
    unblockUser: vi.fn(),
    getBlockedUsers: vi.fn(() => []),
    onBlocklistUpdated: vi.fn(() => () => {}),
    retryPendingReports: vi.fn(async () => {}),
    startBlocklist: vi.fn(),
}));

vi.mock('./pages/HomePage', () => ({
    HomePage: ({ onNavigate }: { onNavigate: (tab: string, ctx?: string) => void }) => (
        <div data-testid="home-page">
            <button onClick={() => onNavigate('messages', 'group-1')}>Open Group Chat from Home</button>
        </div>
    ),
}));

vi.mock('./pages/ProjectsPage', () => ({ ProjectsPage: () => <div data-testid="projects-page" /> }));
vi.mock('./pages/MarketplacePage', () => ({ MarketplacePage: () => <div data-testid="marketplace-page" /> }));
vi.mock('./pages/PeoplePage', () => ({ PeoplePage: () => <div data-testid="people-page" /> }));
vi.mock('./pages/PulsePage', () => ({ PulsePage: () => <div data-testid="pulse-page" /> }));
vi.mock('./pages/LedgerPage', () => ({ LedgerPage: () => <div data-testid="ledger-page" /> }));
vi.mock('./pages/SettingsPage', () => ({ SettingsPage: () => <div data-testid="settings-page" /> }));

let mockConversationsList: api.Conversation[] = [];
let mockTotalUnread = 0;

vi.mock('./lib/api', () => ({
    getNodeApiUrl: vi.fn(() => ''),
    registerMember: vi.fn(async () => ({ ok: true })),
    checkMembership: vi.fn(async () => ({ isMember: true })),
    getConversations: vi.fn(async () => ({
        conversations: mockConversationsList,
        totalUnread: mockTotalUnread,
    })),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    getCommunityHealth: vi.fn(async () => ({ online: true, version: '1.2.30' })),
    getMyActiveRecoveryCollections: vi.fn(async () => ({ count: 0, collections: [] })),
    getUnseenNotices: vi.fn(async () => []),
    markNoticesSeen: vi.fn(async () => ({ success: true, marked: 0 })),
    getMemberProfile: vi.fn(async () => ({ publicKey: 'my-user-pubkey', avatar: null, bio: '', contact: null })),
    markConversationReadApi: vi.fn(async (_pubkey: string, convId: string) => {
        mockConversationsList = mockConversationsList.map(c => c.id === convId ? { ...c, unreadCount: 0 } : c);
        mockTotalUnread = mockConversationsList.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
        return { success: true };
    }),
    getGroupChat: vi.fn(async (groupId: string) => ({
        conversation: mockConversationsList.find(c => c.id === groupId),
        messages: [
            { id: 'm-1', authorPubkey: 'other-pubkey', ciphertext: 'Hello group', timestamp: '2026-09-01T00:00:00Z', type: 'text' },
        ],
        canPost: true,
    })),
    getConversationMessages: vi.fn(async (convId: string) => ({
        conversation: mockConversationsList.find(c => c.id === convId) || {
            id: convId,
            type: 'dm',
            participants: ['my-user-pubkey', 'peer-pubkey'],
            createdAt: '2026-09-14T00:00:00Z',
            updatedAt: '2026-09-14T00:00:00Z',
        },
        messages: [
            { id: 'm-1', authorPubkey: 'peer-pubkey', ciphertext: 'Hello DM', timestamp: '2026-09-01T00:00:00Z', type: 'text' },
        ],
    })),
    getMembers: vi.fn(async () => []),
    getGroupMembers: vi.fn(async () => []),
    createConversationApi: vi.fn(),
    createGroup: vi.fn(),
    groupKeysNet: { get: vi.fn(async () => new Response('{}', { status: 404 })), post: vi.fn(async () => new Response('{}', { status: 404 })) },
    getEventChat: vi.fn(async (_postId: string) => ({
        title: 'Community Garden Bee',
        messages: [{ id: 'em-1', authorPubkey: 'other-pk', ciphertext: 'See you there', timestamp: '2026-09-01T00:00:00Z', type: 'text' }],
    })),
    postEventChatMessage: vi.fn(),
    removeEventChatMessage: vi.fn(),
    sendMessageApi: vi.fn(),
    editMessageApi: vi.fn(),
    toggleMessageReactionApi: vi.fn(),
    getMessageAttachmentApi: vi.fn(),
    completeMarketplaceTransaction: vi.fn(),
    cancelMarketplaceTransaction: vi.fn(),
}));

const sidebar = () => document.querySelector('aside') as HTMLElement;

describe('web-unread-badge: the Chat badge clears when a chat is read', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        mockConversationsList = [];
        mockTotalUnread = 0;
    });

    it('open a group chat with 5 unread: the sidebar count goes to 0 with no page refresh and no timer advanced', async () => {
        // Marty's bug: a group showed 5 and the sidebar's Chat showed 5.
        // He opened the group; the group's 5 went, the sidebar's stayed until he refreshed the page.
        // Both must clear at once.
        mockConversationsList = [
            {
                id: 'group-1',
                type: 'group_thread',
                name: 'Garden Crew',
                participants: ['my-user-pubkey', 'other-pubkey'],
                createdBy: 'other-pubkey',
                createdAt: '2026-09-01T00:00:00Z',
                unreadCount: 5,
            },
        ];
        mockTotalUnread = 5;

        render(<App />);
        await screen.findByTestId('home-page');

        // Initially on Home: the sidebar shows Chat with badge 5
        const chatTab = within(sidebar()).getByRole('button', { name: /Chat/ });
        expect(within(chatTab).getByText('5')).toBeInTheDocument();

        // Navigate to Chat
        fireEvent.click(chatTab);

        // Group item should be visible in conversation list with badge 5
        const groupRow = await screen.findByText('Garden Crew');
        expect(screen.getAllByText('5').length).toBeGreaterThanOrEqual(1);

        // Open the group chat
        fireEvent.click(groupRow);

        // Both the row's badge and the sidebar's badge clear to 0 / disappear!
        await waitFor(() => {
            expect(within(chatTab).queryByText('5')).toBeNull();
        });

        // The API mark-read was called with the group's id
        expect(api.markConversationReadApi).toHaveBeenCalledWith('my-user-pubkey', 'group-1');
    });

    it('open a DM chat with 3 unread: the sidebar count goes to 0 with no page refresh and no timer advanced', async () => {
        mockConversationsList = [
            {
                id: 'dm-1',
                type: 'dm',
                name: 'Bob',
                peerCallsign: 'Bob',
                participants: ['my-user-pubkey', 'bob-pubkey'],
                createdBy: 'bob-pubkey',
                createdAt: '2026-09-01T00:00:00Z',
                unreadCount: 3,
            },
        ];
        mockTotalUnread = 3;

        render(<App />);
        await screen.findByTestId('home-page');

        const chatTab = within(sidebar()).getByRole('button', { name: /Chat/ });
        expect(within(chatTab).getByText('3')).toBeInTheDocument();

        fireEvent.click(chatTab);

        const dmRow = await screen.findByText('Bob');
        fireEvent.click(dmRow);

        await waitFor(() => {
            expect(within(chatTab).queryByText('3')).toBeNull();
        });

        expect(api.markConversationReadApi).toHaveBeenCalledWith('my-user-pubkey', 'dm-1');
    });

    it('no extra reads on a chat with nothing unread', async () => {
        // Chat has 0 unread lines
        mockConversationsList = [
            {
                id: 'group-clean',
                type: 'group_thread',
                name: 'Quiet Group',
                participants: ['my-user-pubkey', 'other-pubkey'],
                createdBy: 'other-pubkey',
                createdAt: '2026-09-01T00:00:00Z',
                unreadCount: 0,
            },
        ];
        mockTotalUnread = 0;

        render(<App />);
        await screen.findByTestId('home-page');

        const chatTab = within(sidebar()).getByRole('button', { name: /Chat/ });
        // No unread badge
        expect(within(chatTab).queryByText('0')).toBeNull();

        fireEvent.click(chatTab);

        const groupRow = await screen.findByText('Quiet Group');
        const initialGetConversationsCalls = vi.mocked(api.getConversations).mock.calls.length;

        // Open the quiet group
        fireEvent.click(groupRow);
        await waitFor(() => expect(api.getGroupChat).toHaveBeenCalledWith('group-clean'));

        // markConversationReadApi must NOT have been called
        expect(api.markConversationReadApi).not.toHaveBeenCalled();

        // getConversations must NOT have received extra calls from unneeded refresh
        expect(vi.mocked(api.getConversations).mock.calls.length).toBe(initialGetConversationsCalls);
    });

    it('open an event chat with 4 unread: the sidebar count clears to 0', async () => {
        mockConversationsList = [
            {
                id: 'event-1',
                type: 'event_thread',
                name: 'Community Garden Bee',
                participants: ['my-user-pubkey', 'other-pk'],
                createdBy: 'other-pk',
                createdAt: '2026-09-01T00:00:00Z',
                unreadCount: 4,
            },
        ];
        mockTotalUnread = 4;

        render(<App />);
        await screen.findByTestId('home-page');

        const chatTab = within(sidebar()).getByRole('button', { name: /Chat/ });
        expect(within(chatTab).getByText('4')).toBeInTheDocument();

        fireEvent.click(chatTab);

        const eventRow = await screen.findByText('Community Garden Bee');
        fireEvent.click(eventRow);

        await waitFor(() => {
            expect(within(chatTab).queryByText('4')).toBeNull();
        });

        expect(api.markConversationReadApi).toHaveBeenCalledWith('my-user-pubkey', 'event-1');
    });

    it('refreshes count past the 2-second poll cooldown when mark lands', async () => {
        mockConversationsList = [
            {
                id: 'group-cooldown',
                type: 'group_thread',
                name: 'Cooldown Group',
                participants: ['my-user-pubkey', 'other-pubkey'],
                createdBy: 'other-pubkey',
                createdAt: '2026-09-01T00:00:00Z',
                unreadCount: 2,
            },
        ];
        mockTotalUnread = 2;

        render(<App />);
        await screen.findByTestId('home-page');

        const chatTab = within(sidebar()).getByRole('button', { name: /Chat/ });
        expect(within(chatTab).getByText('2')).toBeInTheDocument();

        // Navigating to chat and opening it happens immediately (within 2 seconds of the initial poll)
        fireEvent.click(chatTab);
        const groupRow = await screen.findByText('Cooldown Group');
        fireEvent.click(groupRow);

        // Sidebar count must refresh immediately without being blocked by 2-second cooldown
        await waitFor(() => {
            expect(within(chatTab).queryByText('2')).toBeNull();
        });
        expect(api.markConversationReadApi).toHaveBeenCalledWith('my-user-pubkey', 'group-cooldown');
    });
});

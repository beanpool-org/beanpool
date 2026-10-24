/**
 * Tests for web DM chat header: tapping the header opens who you're talking to.
 * - In a DM with a person, the avatar + name is one button with an accessible name
 *   ("{name}, see {name}'s profile") opening their public profile.
 * - In a DM with an enterprise, it opens the enterprise's page.
 * - Keyboard (Enter/Space) works.
 * - A group chat header keeps its current behaviour (no change).
 * - A conversation whose other side is unknown/deleted draws no button.
 */
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MessagesPage } from './MessagesPage';
import { PublicProfilePage } from './PublicProfilePage';
import type { BeanPoolIdentity } from '../lib/identity';
import type { Conversation, ApiMessage } from '../lib/api';

if (typeof window !== 'undefined' && window.HTMLElement) {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
}

vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn(() => () => {}),
}));

vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false),
    blockUser: vi.fn(),
    unblockUser: vi.fn(),
    getBlockedUsers: vi.fn(() => []),
    onBlocklistUpdated: vi.fn(() => () => {}),
    getBlocklistFullNote: vi.fn(() => null),
}));

vi.mock('../lib/archetypes', () => ({
    consumeChatPrefill: vi.fn(() => null),
}));

vi.mock('../lib/avatar', () => ({
    resolveAvatarUrl: vi.fn((url) => url),
}));

vi.mock('../components/ReportModal', () => ({
    ReportModal: () => null,
}));

vi.mock('../components/ArchetypeQuizModal', () => ({
    ArchetypeQuizModal: () => null,
}));

vi.mock('../components/ImageLightbox', () => ({
    ImageLightbox: () => null,
}));

vi.mock('../lib/e2e-crypto', () => ({
    dmThreadInShownOrder: (msgs: unknown[]) => msgs,
    dmQuoteFrom: vi.fn(() => null),
    dmQuoteLabel: vi.fn(() => null),
    dmLineShownText: vi.fn((v: { text: string | null } | undefined) => v?.text ?? ''),
    dmLineIsUnattributed: vi.fn(() => false),
    dmReplyToOf: vi.fn(() => null),
    decodePlaintext: vi.fn((c: string) => c),
    encodePlaintext: vi.fn((text: string) => ({ ciphertext: text, nonce: '00000' })),
    sealDmLine: vi.fn((text: string) => ({ ciphertext: text, nonce: '00000' })),
    openDmLine: vi.fn((p: { ciphertext: string }) => ({ text: p.ciphertext, format: 3, after: null, conversationId: '', moved: false })),
    checkDmThread: vi.fn(() => new Map()),
    dmAfterReference: vi.fn(() => null),
    dmLineMarkText: vi.fn(() => null),
    newDmMessageId: vi.fn(() => 'msg-1'),
    isEncryptedNonce: vi.fn(() => false),
    DM_LINE_NOT_VERIFIED_TEXT: "🔒 This message couldn't be verified, so it isn't shown.",
}));

const ME: BeanPoolIdentity = {
    publicKey: 'member-ana',
    privateKey: 'k',
    callsign: 'Ana',
    createdAt: '2026-01-01T00:00:00.000Z',
};

const KOFI = 'member-kofi';
const ENT = 'enterprise-damo';
const GROUP_ID = 'group-crew-123';
const UNKNOWN_DM_ID = 'dm-unknown-peer';

const mockConversations: Record<string, Conversation> = {
    'dm-kofi': {
        id: 'dm-kofi',
        type: 'dm',
        name: null,
        participants: [ME.publicKey, KOFI],
        createdBy: ME.publicKey,
        createdAt: '2026-10-01T00:00:00Z',
        peerCallsign: 'Kofi',
        peerAvatar: null,
    },
    'dm-enterprise': {
        id: 'dm-enterprise',
        type: 'dm',
        name: null,
        participants: [ME.publicKey, ENT],
        createdBy: ME.publicKey,
        createdAt: '2026-10-01T00:00:00Z',
        peerCallsign: "Damo's Enterprise",
        peerAvatar: null,
    },
    [GROUP_ID]: {
        id: GROUP_ID,
        type: 'group_thread',
        name: 'Garden crew',
        participants: [ME.publicKey, KOFI],
        createdBy: ME.publicKey,
        createdAt: '2026-10-01T00:00:00Z',
    },
    [UNKNOWN_DM_ID]: {
        id: UNKNOWN_DM_ID,
        type: 'dm',
        name: null,
        participants: [ME.publicKey], // other side unknown or deleted
        createdBy: ME.publicKey,
        createdAt: '2026-10-01T00:00:00Z',
    },
};

vi.mock('../lib/api', () => ({
    getConversations: vi.fn(async () => ({
        conversations: Object.values(mockConversations),
        totalUnread: 0,
    })),
    getConversationMessages: vi.fn(async (convId: string) => ({
        conversation: mockConversations[convId] || {
            id: convId,
            type: 'dm',
            participants: [ME.publicKey],
            createdAt: '2026-10-01T00:00:00Z',
        },
        messages: [] as ApiMessage[],
    })),
    getMembers: vi.fn(async () => [
        { publicKey: KOFI, callsign: 'Kofi' },
        { publicKey: ENT, callsign: "Damo's Enterprise" },
    ]),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(),
    getEventChat: vi.fn(),
    sendMessageApi: vi.fn(),
    editMessageApi: vi.fn(),
    toggleMessageReactionApi: vi.fn(),
    getMessageAttachmentApi: vi.fn(),
    completeMarketplaceTransaction: vi.fn(),
    cancelMarketplaceTransaction: vi.fn(),
    getGroupChat: vi.fn(async (groupId: string) => ({
        conversation: mockConversations[groupId],
        messages: [],
        canPost: true,
    })),
    getGroupMembers: vi.fn(async () => [
        { groupId: GROUP_ID, memberPubkey: ME.publicKey, callsign: 'Ana', role: 'member', status: 'active', joinedAt: '' },
        { groupId: GROUP_ID, memberPubkey: KOFI, callsign: 'Kofi', role: 'member', status: 'active', joinedAt: '' },
    ]),
    getMemberProfile: vi.fn(async (key: string) => {
        if (key === ENT) {
            return {
                publicKey: ENT,
                callsign: "Damo's Enterprise",
                avatar: null,
                bio: '',
                contact: null,
                joinedAt: '2026-09-01T00:00:00.000Z',
                status: 'active',
                isTreasury: true,
            };
        }
        if (key === KOFI) {
            return {
                publicKey: KOFI,
                callsign: 'Kofi',
                avatar: null,
                bio: 'I fix bikes',
                contact: null,
                joinedAt: '2026-03-01T00:00:00.000Z',
                status: 'active',
                isTreasury: false,
            };
        }
        throw new Error('Not found');
    }),
    getMemberRatings: vi.fn(async () => ({ average: 0, count: 0, ratings: [] })),
    getMarketplacePosts: vi.fn(async () => []),
    getBalance: vi.fn(async () => ({ balance: 10, keeperOf: [] })),
    getRatingsGiven: vi.fn(async () => ({ ratings: [] })),
    getFriends: vi.fn(async () => []),
    getPublicChannels: vi.fn(async () => ({ channels: [] })),
    vouchMemberApi: vi.fn(async () => ({ success: true })),
    groupKeysNet: { get: vi.fn(), post: vi.fn() },
}));

describe('web DM chat header', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        cleanup();
    });

    it("in a DM with a person, the header's avatar + name is ONE button with an accessible name opening their public profile", async () => {
        const onOpenProfile = vi.fn();
        render(
            <MessagesPage
                identity={ME}
                openConversationId="dm-kofi"
                onOpenProfile={onOpenProfile}
            />
        );

        await screen.findByRole('button', { name: 'Back to messages' });

        const headerBtn = screen.getByRole('button', { name: "Kofi, see Kofi's profile" });
        expect(headerBtn).toBeInTheDocument();
        expect(headerBtn).toHaveAttribute('data-testid', 'dm-header-profile');
        expect(within(headerBtn).getByText('Kofi')).toBeInTheDocument();

        fireEvent.click(headerBtn);
        expect(onOpenProfile).toHaveBeenCalledWith(KOFI);

        // When passed to PublicProfilePage (App.tsx overlay pattern), it renders the public profile
        const onOpenTreasury = vi.fn();
        cleanup();
        render(
            <PublicProfilePage
                identity={ME}
                pubkey={KOFI}
                onBack={vi.fn()}
                onMessage={vi.fn()}
                onNavigatePost={vi.fn()}
                onOpenTreasury={onOpenTreasury}
            />
        );

        expect(await screen.findByText(/I fix bikes/)).toBeInTheDocument();
        expect(onOpenTreasury).not.toHaveBeenCalled();
    });

    it("in a DM with an enterprise, tapping the header opens the enterprise's page", async () => {
        const onOpenProfile = vi.fn();
        render(
            <MessagesPage
                identity={ME}
                openConversationId="dm-enterprise"
                onOpenProfile={onOpenProfile}
            />
        );

        await screen.findByRole('button', { name: 'Back to messages' });

        const headerBtn = screen.getByRole('button', { name: "Damo's Enterprise, see Damo's Enterprise's profile" });
        expect(headerBtn).toBeInTheDocument();
        expect(within(headerBtn).getByText("Damo's Enterprise")).toBeInTheDocument();

        fireEvent.click(headerBtn);
        expect(onOpenProfile).toHaveBeenCalledWith(ENT);

        // PublicProfilePage forwards an enterprise key to onOpenTreasury (App.tsx opens TreasuryDetailPage)
        const onOpenTreasury = vi.fn();
        cleanup();
        render(
            <PublicProfilePage
                identity={ME}
                pubkey={ENT}
                onBack={vi.fn()}
                onMessage={vi.fn()}
                onNavigatePost={vi.fn()}
                onOpenTreasury={onOpenTreasury}
            />
        );

        await waitFor(() => expect(onOpenTreasury).toHaveBeenCalledWith(ENT));
    });

    it('keyboard (Enter/Space) works to trigger the header button', async () => {
        const onOpenProfile = vi.fn();
        render(
            <MessagesPage
                identity={ME}
                openConversationId="dm-kofi"
                onOpenProfile={onOpenProfile}
            />
        );

        await screen.findByRole('button', { name: 'Back to messages' });
        const headerBtn = screen.getByRole('button', { name: "Kofi, see Kofi's profile" });

        fireEvent.keyDown(headerBtn, { key: 'Enter' });
        expect(onOpenProfile).toHaveBeenCalledWith(KOFI);

        onOpenProfile.mockClear();
        fireEvent.keyDown(headerBtn, { key: ' ' });
        expect(onOpenProfile).toHaveBeenCalledWith(KOFI);
    });

    it('a group chat header keeps its current behaviour (no change)', async () => {
        const onNavigate = vi.fn();
        const onOpenProfile = vi.fn();
        render(
            <MessagesPage
                identity={ME}
                openConversationId={GROUP_ID}
                onNavigate={onNavigate}
                onOpenProfile={onOpenProfile}
            />
        );

        await screen.findByRole('button', { name: 'Back to messages' });

        const header = screen.getByRole('button', { name: 'Garden crew, group info' });
        expect(header).toHaveAttribute('data-testid', 'chat-owner-header');
        fireEvent.click(header);
        expect(onNavigate).toHaveBeenCalledWith('group', GROUP_ID);
        expect(onOpenProfile).not.toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: /see .*'s profile/ })).toBeNull();
    });

    it('a conversation whose other side is unknown/deleted draws no button', async () => {
        const onOpenProfile = vi.fn();
        render(
            <MessagesPage
                identity={ME}
                openConversationId={UNKNOWN_DM_ID}
                onOpenProfile={onOpenProfile}
            />
        );

        await screen.findByRole('button', { name: 'Back to messages' });

        expect(screen.queryByRole('button', { name: /profile/i })).toBeNull();
        expect(screen.queryByTestId('dm-header-profile')).toBeNull();
        expect(screen.queryByTestId('chat-owner-header')).toBeNull();
    });
});

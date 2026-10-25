/**
 * Wide-screen layout tests for web app pages (tier B, damo-findings items 2 & 5, fix round 1 & 2).
 * Pins wide-screen container classes, responsive grids, and reading caps:
 * - PulsePage: wide container (max-w-7xl), container-driven auto-fill grid, 1 col on mobile.
 * - MessagesPage (Chat view & List view): wide container on md+/lg+/xl+, reading cap (≤ 75%) on wide screens, 85% on phone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { PulsePage } from './PulsePage';
import { MessagesPage } from './MessagesPage';
import { ProjectsPage } from './ProjectsPage';
import { ToolsPage } from './ToolsPage';
import { ChannelsPage } from './ChannelsPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { getPulseFeed, getConversationMessages, getConversations, getTreasuries, type PulseFeedItem, type Treasury } from '../lib/api';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';

// Polyfill scrollIntoView for jsdom
if (typeof window !== 'undefined' && window.HTMLElement) {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
}

vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn(() => () => {}),
}));

vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({
        memberCount: 3,
        postCount: 0,
        transactionCount: 0,
        commonsBalance: 0,
        profile: 'local',
        features: {},
    })),
}));

vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false),
    blockUser: vi.fn(),
    unblockUser: vi.fn(),
    getBlockedUsers: vi.fn(() => []),
    onBlocklistUpdated: vi.fn(() => () => {}),
}));

vi.mock('../lib/archetypes', () => ({ consumeChatPrefill: vi.fn(() => null) }));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url: string) => url) }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));

vi.mock('../lib/e2e-crypto', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/e2e-crypto')>()),
    dmLineShownText: vi.fn((v: { text: string | null } | undefined) => v?.text ?? ''),
    dmLineIsUnattributed: vi.fn(() => false),
    openDmLine: vi.fn((p: { ciphertext: string }) => ({ text: p.ciphertext, format: 3, after: null, conversationId: '', moved: false })),
}));

vi.mock('../lib/api', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/api')>()),
    getPulseFeed: vi.fn(),
    getMemberChannels: vi.fn().mockResolvedValue({ channels: [] }),
    getPulseNudges: vi.fn().mockResolvedValue({ nudges: [] }),
    getConversations: vi.fn().mockResolvedValue({ conversations: [] }),
    getConversationMessages: vi.fn().mockResolvedValue({ messages: [] }),
    getTreasuries: vi.fn().mockResolvedValue({ treasuries: [] }),
    getDecisions: vi.fn().mockResolvedValue({ decisions: [], myPoolVoting: null }),
    getCommonsBalance: vi.fn().mockResolvedValue({ balance: 0 }),
    getAllMembers: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue({
        balance: 0,
        floor: 0,
        commonsBalance: 0,
        earnedCredit: 0,
        callsign: 'Marty',
        keeperOf: [],
        tier: 'contributor',
    }),
    getCommunityMembers: vi.fn().mockResolvedValue([]),
    getMembers: vi.fn().mockResolvedValue([]),
    getMyMarketplaceTransactions: vi.fn().mockResolvedValue([]),
    getGroups: vi.fn().mockResolvedValue({ groups: [] }),
    markConversationReadApi: vi.fn().mockResolvedValue({ success: true }),
    getGroupChat: vi.fn().mockResolvedValue({ chat: null }),
}));

const testIdentity: BeanPoolIdentity = {
    publicKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    privateKey: 'mock-private-key',
    callsign: 'Marty',
    createdAt: '2026-01-01T00:00:00.000Z',
};

const pulseItem: PulseFeedItem = {
    id: 'p1',
    ownerPubkey: 'owner-1',
    url: 'https://youtube.com/watch?v=1',
    platform: 'youtube',
    category: 'education',
    title: 'Natural Building Workshop',
    thumbnailUrl: null,
    callsign: 'Mud & Timber',
    avatarUrl: null,
    source: 'user',
    isVerified: true,
    publishedAt: '2026-10-23T12:00:00.000Z',
};

const mockEnterprise: Treasury = {
    publicKey: 'pk-enterprise-1',
    name: 'Castlemaine Sourdough Guild',
    callsign: 'sourdough',
    purpose: 'Community bakery and sourdough education',
    balance: 500,
    creditLine: 0,
    liveOffers: 2,
    goalAmount: 1000,
    currentAmount: 500,
    deadlineAt: null,
    lifecycle: 'continuous',
    status: 'active',
    avatar: null,
};

beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetGroupChatLockStoreForTest();
    vi.mocked(getPulseFeed).mockReset();
    vi.mocked(getConversations).mockReset();
    vi.mocked(getConversationMessages).mockReset();
    vi.mocked(getTreasuries).mockReset();
});

afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
});

describe('Wide screen layout: The Pulse', () => {
    it('Pulse page container is widened to max-w-7xl on wide screens instead of pinned to max-w-2xl', async () => {
        vi.mocked(getPulseFeed).mockResolvedValue({ items: [pulseItem], nextCursor: null });
        const { container } = render(<PulsePage identity={testIdentity} onOpenProfile={vi.fn()} />);

        await screen.findByText('Natural Building Workshop');
        const outer = container.firstElementChild as HTMLElement;
        expect(outer).toBeInTheDocument();
        // The container should not be restricted to max-w-2xl (which was 672px)
        expect(outer.className).toContain('max-w-7xl');
        expect(outer.className).not.toContain('max-w-2xl');
    });

    it('Pulse feed items render in a responsive grid using container-driven auto-fill rule', async () => {
        vi.mocked(getPulseFeed).mockResolvedValue({
            items: [
                pulseItem,
                { ...pulseItem, id: 'p2', title: 'Second video item' },
                { ...pulseItem, id: 'p3', title: 'Third video item' },
            ],
            nextCursor: null,
        });

        render(<PulsePage identity={testIdentity} onOpenProfile={vi.fn()} />);
        await screen.findByText('Natural Building Workshop');

        const article = screen.getByText('Natural Building Workshop').closest('article')!;
        const feedContainer = article.parentElement as HTMLElement;

        // Feed container must be a responsive grid using the container-driven auto-fill rule
        expect(feedContainer.className).toContain('grid');
        expect(feedContainer.className).toContain('grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))]');

        // Pulse feed card should not have justify-between on root article (detaches author header from thumbnail in grid stretch)
        expect(article.className).not.toContain('justify-between');
    });
});

describe('Wide screen layout: Chat (Group and DM)', () => {
    it('Chat conversation list container expands on wide screens beyond max-w-4xl (to max-w-6xl and max-w-7xl)', async () => {
        const { container } = render(<MessagesPage identity={testIdentity} />);
        const listContainer = container.querySelector('.max-w-4xl') as HTMLElement;
        expect(listContainer).not.toBeNull();
        expect(listContainer.className).toContain('max-w-4xl');
        expect(listContainer.className).toContain('lg:max-w-6xl');
        expect(listContainer.className).toContain('xl:max-w-7xl');
    });

    it('Chat conversation view container and message bubbles use responsive reading cap on wide screens', async () => {
        const mockConv = {
            id: 'c1',
            type: 'dm' as const,
            name: null,
            participants: [testIdentity.publicKey, 'peer-pk'],
            createdBy: testIdentity.publicKey,
            peerCallsign: 'Bob',
            unreadCount: 0,
            createdAt: '2026-01-01T00:00:00Z',
        };
        vi.mocked(getConversations).mockResolvedValue({
            conversations: [mockConv],
            totalUnread: 0,
        });
        vi.mocked(getConversationMessages).mockResolvedValue({
            conversation: mockConv,
            messages: [
                {
                    id: 'm1',
                    conversationId: 'c1',
                    authorPubkey: 'peer-pk',
                    ciphertext: 'Hello wide screen chat',
                    nonce: '00000',
                    timestamp: '2026-01-01T00:01:00Z',
                },
            ],
        });

        const { container } = render(
            <MessagesPage identity={testIdentity} openConversationId="c1" />
        );

        // Wait for message element to appear in rendered DOM and verify reading width cap
        const bubble = await waitFor(() => {
            const el = container.querySelector('#msg-m1') as HTMLElement;
            expect(el).not.toBeNull();
            return el;
        });

        // Verify the open conversation's own container (not the list's) has wide-screen classes
        const convContainer = bubble.closest('.max-w-4xl') as HTMLElement;
        expect(convContainer).not.toBeNull();
        expect(convContainer.className).toContain('max-w-4xl');
        expect(convContainer.className).toContain('lg:max-w-6xl');
        expect(convContainer.className).toContain('xl:max-w-7xl');

        expect(bubble.className).toContain('max-w-[85%]');
        expect(bubble.className).toContain('md:max-w-[70%]');
    });
});

describe('Wide screen layout: Commons, Tools, and Channels container pins', () => {
    it('Commons enterprise grid uses container-driven auto-fill minmax rule instead of lg:grid-cols-3', async () => {
        vi.mocked(getTreasuries).mockResolvedValue({ treasuries: [mockEnterprise] });
        render(<ProjectsPage identity={testIdentity} onOpenTreasury={vi.fn()} />);

        const enterpriseTitle = await screen.findByText('Castlemaine Sourdough Guild');
        const grid = enterpriseTitle.closest('.grid') as HTMLElement;
        expect(grid).not.toBeNull();
        expect(grid.className).toContain('grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))]');
        expect(grid.className).not.toContain('lg:grid-cols-3');
        expect(grid.className).not.toContain('xl:grid-cols-3');
        expect(grid.className).toContain('max-w-lg');
        expect(grid.className).toContain('xl:max-w-7xl');
    });

    it('Commons Yours grid uses container-driven auto-fill minmax rule instead of lg:grid-cols-3', async () => {
        const kept = {
            ...mockEnterprise,
            keepers: [{ publicKey: testIdentity.publicKey, callsign: testIdentity.callsign, role: 'lead' }],
        };
        vi.mocked(getTreasuries).mockResolvedValue({ treasuries: [kept] });
        render(<ProjectsPage identity={testIdentity} onOpenTreasury={vi.fn()} />);

        const yoursBlock = await screen.findByTestId('commons-yours');
        const grid = yoursBlock.querySelector('.grid') as HTMLElement;
        expect(grid).not.toBeNull();
        expect(grid.className).toContain('grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))]');
        expect(grid.className).not.toContain('lg:grid-cols-3');
        expect(grid.className).not.toContain('xl:grid-cols-3');
    });

    it('Tools page containers preserve max-w-xl reading width (not widened to 6xl)', async () => {
        // 1. ToolsList container
        const { unmount } = render(
            <ToolsPage
                identity={testIdentity}
                open={{ id: null, screen: 'main', key: null }}
                onOpen={vi.fn()}
                onClose={vi.fn()}
                onComposer={vi.fn()}
                onGuide={vi.fn()}
                onAddHomeCard={vi.fn()}
            />
        );

        const intro = screen.getByText('Things you can do on your own, that make your community stronger.');
        const listContainer = intro.parentElement as HTMLElement;
        expect(listContainer.className).toContain('max-w-xl');
        expect(listContainer.className).not.toContain('xl:max-w-6xl');
        expect(listContainer.className).not.toContain('md:max-w-3xl');
        expect(listContainer.className).not.toContain('lg:max-w-5xl');
        unmount();

        // 2. ToolView container (open tool)
        const { container: viewContainer } = render(
            <ToolsPage
                identity={testIdentity}
                open={{ id: 'things', screen: 'main', key: null }}
                onOpen={vi.fn()}
                onClose={vi.fn()}
                onComposer={vi.fn()}
                onGuide={vi.fn()}
                onAddHomeCard={vi.fn()}
            />
        );

        const toolContainer = viewContainer.querySelector('.max-w-xl') as HTMLElement;
        expect(toolContainer).not.toBeNull();
        expect(toolContainer.className).toContain('max-w-xl');
        expect(toolContainer.className).not.toContain('xl:max-w-6xl');
        expect(toolContainer.className).not.toContain('md:max-w-3xl');
        expect(toolContainer.className).not.toContain('lg:max-w-5xl');
    });

    it('Channels page container preserves max-w-2xl form width (not widened to 6xl)', async () => {
        const { container } = render(
            <ChannelsPage
                identity={testIdentity}
                onBack={vi.fn()}
                onViewFeed={vi.fn()}
                onSharePost={vi.fn()}
            />
        );

        const formContainer = container.firstElementChild as HTMLElement;
        expect(formContainer).not.toBeNull();
        expect(formContainer.className).toContain('max-w-2xl');
        expect(formContainer.className).not.toContain('xl:max-w-6xl');
        expect(formContainer.className).not.toContain('md:max-w-4xl');
        expect(formContainer.className).not.toContain('lg:max-w-5xl');
    });
});



/**
 * Wide-screen layout tests for web app pages (tier B, damo-findings items 2 & 5).
 * Pins wide-screen container classes, responsive grids, and reading caps:
 * - PulsePage: wide container (max-w-7xl), responsive 2-3 column card grid on md+/lg+, 1 col on mobile.
 * - MessagesPage (Chat view & List view): wide container on md+/lg+/xl+, reading cap (≤ 75%) on wide screens, 85% on phone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { PulsePage } from './PulsePage';
import type { BeanPoolIdentity } from '../lib/identity';
import { getPulseFeed, type PulseFeedItem } from '../lib/api';

vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn(() => () => {}),
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

vi.mock('../lib/api', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/api')>()),
    getPulseFeed: vi.fn(),
    getMemberChannels: vi.fn().mockResolvedValue({ channels: [] }),
    getPulseNudges: vi.fn().mockResolvedValue({ nudges: [] }),
    getConversations: vi.fn().mockResolvedValue({ conversations: [] }),
    getConversationMessages: vi.fn().mockResolvedValue({ messages: [] }),
    getCommunityMembers: vi.fn().mockResolvedValue([]),
    getMembers: vi.fn().mockResolvedValue([]),
    getMyMarketplaceTransactions: vi.fn().mockResolvedValue([]),
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

beforeEach(() => {
    vi.mocked(getPulseFeed).mockReset();
});

afterEach(() => {
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

    it('Pulse feed items render in a responsive grid (2-3 columns on wide screens, 1 column on mobile)', async () => {
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

        // Feed container must be a responsive grid: 1 column by default, 2 columns on md, 3 columns on lg/xl
        expect(feedContainer.className).toContain('grid');
        expect(feedContainer.className).toContain('grid-cols-1');
        expect(feedContainer.className).toMatch(/md:grid-cols-2|sm:grid-cols-2/);
        expect(feedContainer.className).toMatch(/lg:grid-cols-3|xl:grid-cols-3/);
    });
});

describe('Wide screen layout: Chat (Group and DM)', () => {
    it('Chat conversation container expands on wide screens beyond max-w-4xl (to max-w-6xl or max-w-7xl)', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const messagesPageSrc = fs.readFileSync(path.resolve(__dirname, 'MessagesPage.tsx'), 'utf8');

        // Chat view container should have wide classes on large screens (e.g. max-w-7xl or max-w-6xl)
        expect(messagesPageSrc).toMatch(/h-full max-w-4xl.*(?:lg:max-w-6xl|xl:max-w-7xl|max-w-7xl)/);
        // Conversation list container should also have wide classes
        expect(messagesPageSrc).toMatch(/max-w-4xl.*(?:lg:max-w-6xl|xl:max-w-7xl|max-w-7xl).*mx-auto w-full/);
    });

    it('Chat messages use a comfortable reading width cap on wide screens (≤ 75%) while keeping 85% below 768px', async () => {
        // Source pin / class check for message bubble reading cap
        // The message bubble container should have responsive width cap: max-w-[85%] on phone, md:max-w-[70%] or md:max-w-[75%] on md+
        const fs = await import('node:fs');
        const path = await import('node:path');
        const messagesPageSrc = fs.readFileSync(path.resolve(__dirname, 'MessagesPage.tsx'), 'utf8');

        // Verify that message bubbles are not hardcoded to maxWidth: '85%' on all screens
        expect(messagesPageSrc).toMatch(/md:max-w-\[7[05]%\]|md:max-w-\[6[5-9]%\]/);
    });
});

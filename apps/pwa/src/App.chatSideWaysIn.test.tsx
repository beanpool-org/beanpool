/**
 * Every way into the Chat tab from elsewhere lands on Chats, never on the Forum side a member left it on (slice T0, PR #3146
 * deciding review at 843e3243): the bell's message-request notice, the needs-you "unread messages" and "your groups" rows,
 * and a chat's own notice. Those with no conversation call onNavigate('messages') alone, which only set the tab: with the
 * tab already showing, nothing changed, the member stayed on the empty Forum, and Open had already taken the notice off.
 *
 * The whole App, with the real ChatTabPage, ForumPage and bell (the side bar's: jsdom lays nothing out, and the side bar
 * draws the bell on its own row at any width); MessagesPage and the other tabs stood in, the node's reads mocked at lib/api.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { BellNotice } from '@beanpool/core';
import { App } from './App';
import { recordHomeAnswer, resetHomeStoreForTests } from './lib/home-store';
import type { NeedsItem } from './lib/home-cards';

if (typeof window !== 'undefined') {
    window.matchMedia = window.matchMedia || ((media: string) => ({
        matches: false, media, onchange: null,
        addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    }) as MediaQueryList);
}

vi.mock('./components/InstallPrompt', () => ({ InstallPrompt: () => null }));
vi.mock('./components/SyncStatus', () => ({ SyncStatus: () => <div data-testid="sync-status">Synced</div> }));
vi.mock('./components/ProfileSetup', () => ({ ProfileSetup: () => <div>Profile setup</div> }));
vi.mock('./lib/identity', () => ({
    loadIdentity: vi.fn(async () => ({ publicKey: 'my-user-pubkey', privateKey: 'my-user-privkey', callsign: 'Alice' })),
    updateCallsign: vi.fn(),
}));
vi.mock('./lib/sync', () => ({
    connectToAnchor: vi.fn(),
    onSyncActivity: vi.fn(() => () => {}),
    onSystemAnnouncement: vi.fn(() => () => {}),
    onSocketOpen: vi.fn(() => () => {}),
}));

/** A local community with its forum on, as a 1.4.x server says it (core chatSides). One object, as a read once per load. */
const INFO = vi.hoisted(() => ({ features: { beans: true, decisions: true, invites: true, forum: true } }));
vi.mock('./lib/features', async (orig) => ({
    ...(await orig<typeof import('./lib/features')>()),
    useCommunityInfo: () => INFO,
}));

const node = vi.hoisted(() => ({ needs: [] as unknown[], bell: [] as unknown[] }));
const answer = (items: unknown[]) => ({
    generatedAt: new Date().toISOString(),
    profile: 'local',
    features: { beans: true, decisions: true, invites: true, forum: true },
    me: { joinedAt: '2026-01-01T00:00:00.000Z', isKeeper: false, probation: null, interests: [], area: null, firstOffer: true, standing: 'member' },
    layout: { v: 2, cards: [{ id: 'c1', type: 'community' }], dismissed: {}, updatedAt: null },
    cards: { community: { name: 'Riverside', members: 42 }, needs: { items } },
});
vi.mock('./lib/api', () => ({
    getNodeApiUrl: vi.fn(() => ''),
    registerMember: vi.fn(async () => ({ ok: true })),
    checkMembership: vi.fn(async () => ({ isMember: true })),
    getMyUnread: vi.fn(async () => ({ unread: 0, requests: 0, asOf: '2026-11-01T00:00:00.000Z' })),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    getCommunityHealth: vi.fn(async () => ({ online: true, version: '1.4.0' })),
    getMyActiveRecoveryCollections: vi.fn(async () => ({ count: 0, collections: [] })),
    getUnseenNotices: vi.fn(async () => []),
    markNoticesSeen: vi.fn(async () => ({ success: true, marked: 0 })),
    getBellNotices: vi.fn(async () => node.bell),
    markBellNoticesSeen: vi.fn(async () => 1),
    getMemberProfile: vi.fn(async () => ({ publicKey: 'my-user-pubkey', avatar: null, bio: '', contact: null })),
    getHome: vi.fn(async () => ({ notModified: false, etag: null, answer: answer(node.needs) })),
}));

vi.mock('./pages/HomePage', () => ({ HomePage: () => <div data-testid="home-page" /> }));
vi.mock('./pages/MapPage', () => ({ MapPage: () => <div data-testid="map-page" /> }));
vi.mock('./pages/ProjectsPage', () => ({ ProjectsPage: () => <div data-testid="projects-page" /> }));
vi.mock('./pages/MarketplacePage', () => ({ MarketplacePage: () => <div data-testid="marketplace-page" /> }));
vi.mock('./pages/PeoplePage', () => ({ PeoplePage: () => <div data-testid="people-page" /> }));
// The list stood in: it draws the switch it is handed (the frame) at its top, as the real one does.
vi.mock('./pages/MessagesPage', () => ({
    MessagesPage: ({ frame, openConversationId }: { frame?: React.ReactNode; openConversationId?: string | null }) => (
        <div data-testid="messages-page" data-open={openConversationId ?? ''}>{frame}</div>
    ),
}));

class QuietResizeObserver { observe() {} unobserve() {} disconnect() {} }

const ME = 'my-user-pubkey';
const UNREAD: NeedsItem = { kind: 'message', count: 2, accent: false, label: '2 unread messages', target: { to: 'unread-messages' } };
const GROUPS: NeedsItem = { kind: 'group', count: 3, accent: false, label: '3 new lines in your groups', target: { to: 'your-groups' } };
const CHAT: NeedsItem = { kind: 'message', count: 1, accent: false, label: 'Unread message from Ana', target: { to: 'chat', conversationId: 'dm-ana' } };
const REQUEST: BellNotice = {
    id: 'n-request', kind: 'chat.message', title: '💬 New message request', body: 'Kofi would like to message you',
    data: { screen: 'requests' }, sentAt: Math.floor(Date.now() / 1000) - 120, seenAt: null,
};

const sidebar = () => document.querySelector('aside') as HTMLElement;
const tabs = () => screen.queryAllByRole('tab');
const side = () => tabs().find((tb) => tb.getAttribute('aria-selected') === 'true')?.textContent ?? null;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

async function needs(items: NeedsItem[]) {
    node.needs = items;
    await act(async () => { recordHomeAnswer(answer(items) as never, ME); });
}
async function onChatTabAtForum() {
    render(<App />);
    await screen.findByTestId('home-page');
    await act(async () => { fireEvent.click(within(sidebar()).getByRole('button', { name: /^💬\s*Chat$/ })); });
    await settle();
    expect(side()).toBe('Chats');
    await toForum();
}
async function toForum() {
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Forum' })); });
    expect(side()).toBe('Forum');
    expect(screen.getByTestId('forum-page')).toBeInTheDocument();
}
function bellSheet() {
    fireEvent.click(within(sidebar()).getByTestId('sidebar-bell'));
    return screen.getByRole('dialog');
}
function landedOnChats(way: string) {
    expect(side(), way).toBe('Chats');
    expect(screen.queryByTestId('forum-page'), way).toBeNull();
    expect(screen.getByTestId('chat-side-chats-page').style.display, way).toBe('contents');
}

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetHomeStoreForTests();
    node.needs = [];
    node.bell = [];
    vi.stubGlobal('ResizeObserver', QuietResizeObserver);
    window.innerWidth = 1280;
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('every way into the Chat tab from elsewhere lands on Chats, from the Forum side', () => {
    it('the bell\'s message-request notice: Open shows Chats (the notice is off the bell, so it must)', async () => {
        node.bell = [REQUEST];
        await onChatTabAtForum();
        await settle();
        fireEvent.click(within(bellSheet()).getByTestId('bell-notice'));
        fireEvent.click(within(screen.getByTestId('bell-read')).getByTestId('bell-read-open'));
        await settle();
        landedOnChats('request notice');
    });

    it('the needs-you rows that name no conversation: unread messages, your groups', async () => {
        await onChatTabAtForum();
        for (const item of [UNREAD, GROUPS, UNREAD]) {
            await needs([UNREAD, GROUPS]);
            fireEvent.click(within(bellSheet()).getByRole('button', { name: item.label }));
            await settle();
            landedOnChats(item.label);
            await toForum();
        }
    });

    it('a row that names a conversation: Chats, with that conversation handed to the list', async () => {
        await onChatTabAtForum();
        await needs([CHAT]);
        fireEvent.click(within(bellSheet()).getByRole('button', { name: CHAT.label }));
        await settle();
        landedOnChats(CHAT.label);
        expect(screen.getByTestId('messages-page')).toHaveAttribute('data-open', 'dm-ana');
    });

    it('the tab\'s own button is not a way in from elsewhere: the side the member picked stays', async () => {
        await onChatTabAtForum();
        await act(async () => { fireEvent.click(within(sidebar()).getByRole('button', { name: /^💬\s*Chat$/ })); });
        await settle();
        expect(side()).toBe('Forum');
    });
});

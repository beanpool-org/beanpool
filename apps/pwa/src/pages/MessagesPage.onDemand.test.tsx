/**
 * Messages on a community where people are asked for, not read whole (features.membersOnDemand, design
 * DESIGN-global-members-by-area §2.3–§2.4, slice M3): the New DM picker is the people already talked to plus a search
 * the node answers; the names no row carries come by key; and a community without the switch reads as before.
 */
import { render, screen, act, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';
import { forgetGroupKeys } from '../lib/group-chat-keys';
import { getMembers, getMemberCards, getGroupChat, createConversationApi, type Conversation, type ApiMessage } from '../lib/api';

if (typeof window !== 'undefined' && window.HTMLElement) window.HTMLElement.prototype.scrollIntoView = vi.fn();

const ME = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const CLEO = 'c'.repeat(64);
const DOV = 'd'.repeat(64);
const ALMA = 'e'.repeat(64);
const BLOCKED = 'f'.repeat(64);

vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false), blockUser: vi.fn(), unblockUser: vi.fn(),
    getBlockedUsers: vi.fn(() => ['f'.repeat(64)]), onBlocklistUpdated: vi.fn(() => () => {}),
}));
vi.mock('../lib/archetypes', () => ({ consumeChatPrefill: vi.fn(() => null) }));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));
vi.mock('../lib/e2e-crypto', async (importOriginal) => {
    const real = await importOriginal<typeof import('../lib/e2e-crypto')>();
    return {
        ...real,
        decodePlaintext: vi.fn((c: string) => c),
        openDmLine: vi.fn((p: { ciphertext: string }) => ({ text: p.ciphertext, format: 3, after: null, conversationId: '', moved: false })),
        checkDmThread: vi.fn(() => new Map()),
        isEncryptedNonce: vi.fn(() => false),
    };
});

const info = vi.hoisted(() => ({ value: {} as Record<string, unknown> | Error }));
vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => { if (info.value instanceof Error) throw info.value; return info.value; }),
}));

const state = vi.hoisted(() => ({ conversations: [] as unknown[], messages: {} as Record<string, unknown[]> }));
vi.mock('../lib/api', () => ({
    getNodeApiUrl: vi.fn(() => ''),
    getConversations: vi.fn(async () => ({ conversations: state.conversations, totalUnread: 0 })),
    getConversationMessages: vi.fn(async (id: string) => ({
        conversation: (state.conversations as Conversation[]).find(c => c.id === id), messages: state.messages[id] || [],
    })),
    // A group's chat comes by its own route (#1816, #1841): its lines, unlocked here, and its roster.
    getGroupChat: vi.fn(async (id: string) => ({
        conversation: (state.conversations as Conversation[]).find(c => c.id === id), messages: state.messages[id] || [], canPost: true,
    })),
    getGroupMembers: vi.fn(async (id: string) => ((state.conversations as Conversation[]).find(c => c.id === id)?.participants ?? [])
        .map(pk => ({ groupId: id, memberPubkey: pk, callsign: null, role: 'member', status: 'active', joinedAt: '' }))),
    groupKeysNet: { get: vi.fn(), post: vi.fn() },
    getMembers: vi.fn(async () => [
        { publicKey: 'b'.repeat(64), callsign: 'Bob' }, { publicKey: 'c'.repeat(64), callsign: 'Cleo' },
    ]),
    getMemberCards: vi.fn(async (path: string) => {
        if (path.includes('q=')) return [
            { publicKey: 'e'.repeat(64), callsign: 'Alma', joinedAt: '2026-01-01' },
            { publicKey: 'f'.repeat(64), callsign: 'Alblocked', joinedAt: '2026-01-01' },
        ];
        const keys = new URLSearchParams(path.split('?')[1]).get('keys')?.split(',') ?? [];
        const names: Record<string, string> = { ['c'.repeat(64)]: 'Cleo', ['d'.repeat(64)]: 'Dov' };
        return keys.filter(k => names[k]).map(k => ({ publicKey: k, callsign: names[k], joinedAt: '2026-01-01' }));
    }),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(async (_t: string, participants: string[]) => ({
        conversation: { id: 'conv-new', type: 'dm', name: null, participants, createdBy: participants[0], createdAt: '2026-10-13T00:00:00Z' },
    })),
    getEventChat: vi.fn(), postEventChatMessage: vi.fn(), removeEventChatMessage: vi.fn(),
    sendMessageApi: vi.fn(), editMessageApi: vi.fn(), toggleMessageReactionApi: vi.fn(), getMessageAttachmentApi: vi.fn(),
    completeMarketplaceTransaction: vi.fn(), cancelMarketplaceTransaction: vi.fn(),
}));

const identity: BeanPoolIdentity = { publicKey: ME, privateKey: 'my-privkey', callsign: 'Me', createdAt: '2026-09-14T00:00:00Z' };
const dm = (id: string, peer: string, peerCallsign?: string): Conversation => ({
    id, type: 'dm', name: null, participants: [ME, peer], createdBy: ME, createdAt: '2026-09-14T00:00:00Z', unreadCount: 0,
    ...(peerCallsign ? { peerCallsign } : {}),
});
const GLOBAL = { profile: 'global', features: { membersOnDemand: true } };
const keysAsked = () => vi.mocked(getMemberCards).mock.calls.map(c => c[0]).filter(p => p.includes('keys='))
    .flatMap(p => new URLSearchParams(p.split('?')[1]).get('keys')!.split(','));

describe('Messages with members on demand', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // A store that opens, as in a browser: a group never seen locked here reads as unlocked (group-chat test's setup).
        vi.stubGlobal('indexedDB', memoryIndexedDB());
        resetGroupChatLockStoreForTest();
        forgetGroupKeys();
        info.value = GLOBAL;
        localStorage.clear();
        state.conversations = [dm('conv-bob', BOB, 'Bob'), dm('conv-blocked', BLOCKED, 'Blocked')];
        state.messages = {};
    });
    afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

    it('New DM: the people already talked to, then a search the node answers; never the whole directory', async () => {
        render(<MessagesPage identity={identity} />);
        await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /New DM/ })); });
        const recents = await screen.findByTestId('new-message-recents');
        expect(recents).toHaveTextContent('Bob');
        expect(recents).not.toHaveTextContent('Blocked');
        expect(getMembers).not.toHaveBeenCalled();
        expect(getMemberCards).not.toHaveBeenCalled();

        const box = screen.getByLabelText('Find someone by name');
        fireEvent.change(box, { target: { value: 'a' } });
        expect(screen.getByTestId('new-message-search-status')).toHaveTextContent('Type at least 2 letters');
        fireEvent.change(box, { target: { value: 'al' } });
        const found = await screen.findByTestId('new-message-found');
        expect(vi.mocked(getMemberCards).mock.calls.map(c => c[0])).toEqual(['/api/members?q=al&limit=20']);
        expect(found).toHaveTextContent('Alma');
        expect(found).not.toHaveTextContent('Alblocked');

        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Alma/ })); });
        expect(createConversationApi).toHaveBeenCalledWith('dm', [ME, ALMA], ME);
        expect(getMembers).not.toHaveBeenCalled();
    });

    it('a one-to-one chat whose row carries no name is named by key, once; the named ones are not asked', async () => {
        state.conversations = [dm('conv-bob', BOB, 'Bob'), dm('conv-dov', DOV), dm('conv-blocked', BLOCKED)];
        render(<MessagesPage identity={identity} />);
        await screen.findByText('Dov');
        expect(keysAsked()).toEqual([DOV]);
        expect(getMembers).not.toHaveBeenCalled();
    });

    it("an open group chat's people are asked for by key, each once, and its lines carry their names", async () => {
        state.conversations = [
            dm('conv-bob', BOB, 'Bob'),
            { id: 'grp', type: 'group_thread', name: 'Gardeners', participants: [ME, CLEO, BOB, BLOCKED], createdBy: CLEO, createdAt: '2026-09-14T00:00:00Z', unreadCount: 0 },
        ];
        state.messages = { grp: [{ id: 'm1', conversationId: 'grp', authorPubkey: CLEO, ciphertext: 'Seeds on Saturday', nonce: '', type: 'text', timestamp: '2026-10-01T00:00:00Z' } as unknown as ApiMessage] };
        render(<MessagesPage identity={identity} openConversationId="grp" />);
        await screen.findByText('Seeds on Saturday');
        await waitFor(() => expect(screen.getByTestId('group-line-author')).toHaveTextContent('Cleo'));
        expect(getGroupChat).toHaveBeenCalledWith('grp');
        const asked = keysAsked();
        // Never the member's own key or a blocked one; each asked once; the directory never read.
        expect(new Set(asked)).toEqual(new Set([CLEO, BOB]));
        expect(asked.length).toBe(new Set(asked).size);
        expect(getMembers).not.toHaveBeenCalled();
    });

    it('an offline start on a community that said yes before still asks, never reads the whole directory (N2)', async () => {
        const first = render(<MessagesPage identity={identity} />);
        await first.findByRole('button', { name: /New DM/ });
        await waitFor(() => expect(localStorage.getItem(`bp_members_on_demand:${window.location.origin}`)).toBe('1'));
        first.unmount();
        info.value = new TypeError('Failed to fetch');
        render(<MessagesPage identity={identity} />);
        await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /New DM/ })); });
        expect(await screen.findByTestId('new-message-recents')).toHaveTextContent('Bob');
        expect(screen.getByLabelText('Find someone by name')).toBeInTheDocument();
        expect(getMembers).not.toHaveBeenCalled();
    });

    it('a community without the switch reads the directory as before, and asks none of the small forms', async () => {
        info.value = { profile: 'local', features: {} };
        render(<MessagesPage identity={identity} />);
        await waitFor(() => expect(getMembers).toHaveBeenCalled());
        await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /New DM/ })); });
        await screen.findByText('Choose someone to message:');
        expect(screen.getByText('Cleo')).toBeInTheDocument();
        expect(screen.queryByTestId('new-message-on-demand')).toBeNull();
        expect(getMemberCards).not.toHaveBeenCalled();
    });
});

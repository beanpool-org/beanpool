/**
 * The group chat's header opens the group (15 Oct, Marty: "martys group · 2 members" was plain text): the phone's
 * GroupChatView openOwner. Same harness as MessagesPage.group-chat.test.tsx.
 *
 * (Harness from:) A locked group chat in the web's Messages page (group chats slice 4): real group crypto, a node in memory behind the
 * page's own transport (group-chat-fake-node.test-support.ts). A line goes sealed and nothing readable leaves the page;
 * a member's line is named by the key that opened it; an unsealed row in a locked chat is nobody's, never mine; once the
 * page has seen the group locked, a node that says otherwise still gets nothing readable; search finds opened words.
 * The real node is driven by e2e/group-chat-check.mjs.
 */
import { render, screen, act, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { sendMessageApi, editMessageApi } from '../lib/api';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';
import { forgetGroupKeys, groupKeyring, memoryGroupLockStore } from '../lib/group-chat-keys';
import { sealLine } from '../lib/group-chat-crypto';
import { fakeGroupNode, person, type FakeGroupNode } from '../lib/group-chat-fake-node.test-support';

if (typeof window !== 'undefined' && window.HTMLElement) window.HTMLElement.prototype.scrollIntoView = vi.fn();

vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false), blockUser: vi.fn(), unblockUser: vi.fn(), getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}),
}));
vi.mock('../lib/archetypes', () => ({ consumeChatPrefill: vi.fn(() => null) }));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));

const G = '5c1d2c3b-4a59-4e68-9d7c-8b9a0f1e2d3c';
const ana = person(true);
const ben = person();
let node: FakeGroupNode;
/** What the node's chat answer says about its lock: `locked` (encryption) or not (a node that now says unlocked). */
let chatLocked = true;
/** The type the node gives the conversation (a dishonest node retypes a group). */
let nodeType = 'group_thread';
/** Rows the node serves beside the sealed lines it stored. */
let extraRows: any[] = [];

const served = () => [
    ...node.lines.map((l, i) => ({
        id: l.id, conversationId: G, authorPubkey: l.author, ciphertext: l.ciphertext, nonce: l.nonce, type: 'text',
        metadata: JSON.stringify(l.metadata), timestamp: new Date(Date.UTC(2026, 9, 12, 9, i)).toISOString(), editedAt: null,
    })),
    ...extraRows,
];

vi.mock('../lib/api', () => ({
    getConversations: vi.fn(async () => ({ conversations: [conv()], totalUnread: 0 })),
    getConversationMessages: vi.fn(async () => ({ conversation: conv(), messages: [] })),
    getMembers: vi.fn(async () => [{ publicKey: ben.publicKey, callsign: 'Ben' }]),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(), getEventChat: vi.fn(), sendMessageApi: vi.fn(), editMessageApi: vi.fn(),
    toggleMessageReactionApi: vi.fn(), getMessageAttachmentApi: vi.fn(), completeMarketplaceTransaction: vi.fn(), cancelMarketplaceTransaction: vi.fn(),
    getGroupChat: vi.fn(async () => ({
        conversation: conv(), messages: served(), canPost: true,
        ...(chatLocked ? { encryption: { current: node.current(), stale: false, fromEpoch: 1 } } : {}),
    })),
    getGroupMembers: vi.fn(async () => node.shown.map((pk) => ({ groupId: G, memberPubkey: pk, callsign: pk === ana.publicKey ? 'Ana' : 'Ben', role: 'member', status: 'active', joinedAt: '' }))),
    groupKeysNet: {
        get: (p: string) => node.as(ana.publicKey).get(p),
        post: (p: string, b: unknown) => node.as(ana.publicKey).post(p, b),
    },
}));

function conv() {
    return { id: G, type: nodeType, name: 'Garden crew', participants: [ana.publicKey, ben.publicKey], createdBy: ana.publicKey, createdAt: '2026-10-01T00:00:00Z', unreadCount: 0 };
}

const me: BeanPoolIdentity = { publicKey: ana.publicKey, privateKey: ana.privateKey, callsign: 'Ana', createdAt: '2026-10-01T00:00:00Z' };

beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetGroupChatLockStoreForTest();
    forgetGroupKeys();
    node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
    chatLocked = true;
    nodeType = 'group_thread';
    extraRows = [];
    // Ben opened the chat first: epoch 1 for both of them, and one line of his.
    const { epoch, key } = await groupKeyring(node.as(ben.publicKey), ben, G, memoryGroupLockStore()).prepareToSeal();
    const id = crypto.randomUUID();
    const sealed = sealLine('Working bee Saturday 9am', { myEdPrivHex: ben.privateKey, groupKey: key, groupId: G, epoch, messageId: id });
    node.lines.push({ id, author: ben.publicKey, ciphertext: sealed.ciphertext, nonce: sealed.nonce, metadata: { epoch, sender: ben.publicKey } });
    forgetGroupKeys();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const onNavigate = vi.fn();
async function openChat() {
    render(<MessagesPage identity={me} openConversationId={G} onNavigate={onNavigate} />);
    await screen.findByText('Working bee Saturday 9am', {}, { timeout: 5000 });
    return screen.getByPlaceholderText('Message...');
}

async function send(composer: HTMLElement, text: string) {
    fireEvent.change(composer, { target: { value: text } });
    await act(async () => { fireEvent.keyDown(composer, { key: 'Enter' }); });
}

describe("a group chat's header opens the group", () => {
    it('the avatar and name are one button, named for the group, that lands on the group (its id is the chat id)', async () => {
        await openChat();
        const header = screen.getByRole('button', { name: 'Group info: Garden crew' });
        expect(header).toHaveAttribute('data-testid', 'chat-owner-header');
        expect(header.textContent).toContain('Garden crew');
        expect(header.textContent).toContain('2 members');
        expect(header.className).toContain('focus-visible:ring-2');
        expect(header.style.cursor).toBe('pointer');
        fireEvent.click(header);
        expect(onNavigate).toHaveBeenCalledWith('group', G);
    });

    it('the back button and the search toggle keep their size beside it', async () => {
        await openChat();
        const back = screen.getByRole('button', { name: 'Back to messages' });
        expect(back.style.flexShrink).toBe('0');
        expect(back.style.minWidth).toBe('44px');
        const search = screen.getByTestId('group-chat-search-toggle');
        expect(search.style.flexShrink).toBe('0');
    });
});

/**
 * "Report message" in a locked group chat on the web (group chat photos S6): real group crypto, a node in memory behind the
 * page's own transport (group-chat-fake-node.test-support.ts), the real report card (components/ReportModal.tsx, the DM
 * report card's reasons and words). Someone else's opened line offers Report, my own doesn't; the card says what the
 * moderators get; Submit sends that line's own key (core groupMessageKey under the epoch that opened it here), which opens
 * that line and no other, and the card thanks them in the DM report card's words; a refusal is shown and the card keeps the
 * member's choice.
 */
import { render, screen, act, waitFor, fireEvent, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';
import { forgetGroupKeys, groupKeyring, memoryGroupLockStore } from '../lib/group-chat-keys';
import { groupMessageKey, openGroupLineWithMessageKey, sealLine } from '../lib/group-chat-crypto';
import { fakeGroupNode, person, type FakeGroupNode } from '../lib/group-chat-fake-node.test-support';
import { REPORT_WORDS } from '../lib/reportReasons';

if (typeof window !== 'undefined' && window.HTMLElement) window.HTMLElement.prototype.scrollIntoView = vi.fn();

vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false), blockUser: vi.fn(), unblockUser: vi.fn(), getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}),
}));
vi.mock('../lib/archetypes', () => ({ consumeChatPrefill: vi.fn(() => null) }));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));

const G = '5c1d2c3b-4a59-4e68-9d7c-8b9a0f1e2d3c';
const ana = person(true);
const ben = person();
let node: FakeGroupNode;
let bens: { epoch: number; key: Uint8Array; id: string };
let anas: string;

const served = () => node.lines.map((l, i) => ({
    id: l.id, conversationId: G, authorPubkey: l.author, ciphertext: l.ciphertext, nonce: l.nonce, type: l.type ?? 'text',
    metadata: JSON.stringify(l.metadata), timestamp: new Date(Date.UTC(2026, 9, 25, 9, i)).toISOString(), editedAt: null,
}));

vi.mock('../lib/api', () => ({
    getConversations: vi.fn(async () => ({ conversations: [conv()], totalUnread: 0 })),
    getConversationMessages: vi.fn(async () => ({ conversation: conv(), messages: [] })),
    getMembers: vi.fn(async () => [{ publicKey: ben.publicKey, callsign: 'Ben' }]),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(), getEventChat: vi.fn(), postEventChatMessage: vi.fn(), removeEventChatMessage: vi.fn(), sendMessageApi: vi.fn(), editMessageApi: vi.fn(),
    toggleMessageReactionApi: vi.fn(), getMessageAttachmentApi: vi.fn(), completeMarketplaceTransaction: vi.fn(), cancelMarketplaceTransaction: vi.fn(),
    reportAbuse: vi.fn(),
    getGroupChat: vi.fn(async () => ({ conversation: conv(), messages: served(), canPost: true, encryption: { current: node.current(), stale: false, fromEpoch: 1 } })),
    getGroupMembers: vi.fn(async () => node.shown.map((pk) => ({ groupId: G, memberPubkey: pk, callsign: pk === ana.publicKey ? 'Ana' : 'Ben', role: 'member', status: 'active', joinedAt: '' }))),
    groupKeysNet: {
        get: (p: string) => node.as(ana.publicKey).get(p),
        post: (p: string, b: unknown) => node.as(ana.publicKey).post(p, b),
    },
}));
import { reportAbuse } from '../lib/api';

function conv() {
    return { id: G, type: 'group_thread', name: 'Garden crew', participants: [ana.publicKey, ben.publicKey], createdBy: ana.publicKey, createdAt: '2026-10-01T00:00:00Z', unreadCount: 0 };
}
const me: BeanPoolIdentity = { publicKey: ana.publicKey, privateKey: ana.privateKey, callsign: 'Ana', createdAt: '2026-10-01T00:00:00Z' };

beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetGroupChatLockStoreForTest();
    forgetGroupKeys();
    node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
    // Ben opened the chat first: epoch 1 for both, one line of his and one of Ana's.
    const { epoch, key } = await groupKeyring(node.as(ben.publicKey), ben, G, memoryGroupLockStore()).prepareToSeal();
    const id = crypto.randomUUID();
    const sealed = sealLine('You are all useless', { myEdPrivHex: ben.privateKey, groupKey: key, groupId: G, epoch, messageId: id });
    node.lines.push({ id, author: ben.publicKey, ciphertext: sealed.ciphertext, nonce: sealed.nonce, metadata: { epoch, sender: ben.publicKey } });
    anas = crypto.randomUUID();
    const mine = sealLine('Please be kind', { myEdPrivHex: ana.privateKey, groupKey: key, groupId: G, epoch, messageId: anas });
    node.lines.push({ id: anas, author: ana.publicKey, ciphertext: mine.ciphertext, nonce: mine.nonce, metadata: { epoch, sender: ana.publicKey } });
    bens = { epoch, key, id };
    forgetGroupKeys();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

async function openChat() {
    render(<MessagesPage identity={me} openConversationId={G} />);
    await screen.findByText('You are all useless', {}, { timeout: 5000 });
    await screen.findByText('Please be kind');
}
const reportButtons = () => screen.queryAllByRole('button', { name: 'Report message' });

describe('Report message in a locked group chat on the web (S6)', () => {
    it("someone else's line offers Report, my own doesn't; the card says what is shared", async () => {
        await openChat();
        expect(reportButtons()).toHaveLength(1);
        await act(async () => { fireEvent.click(reportButtons()[0]); });
        const card = screen.getByRole('dialog');
        expect(within(card).getByText('Report this message')).toBeInTheDocument();
        expect(within(card).getByTestId('report-note').textContent)
            .toBe("This community's moderators will see this one message and who sent it. Nothing else in this chat is shared with them.");
        expect(within(card).getByText('Select reason')).toBeInTheDocument();
    });

    it("Submit sends that line's own key, which opens it and no other line, and the card thanks them", async () => {
        await openChat();
        await act(async () => { fireEvent.click(reportButtons()[0]); });
        const card = screen.getByRole('dialog');
        fireEvent.click(within(card).getByRole('button', { name: 'Spam or scam' }));
        fireEvent.change(within(card).getByRole('textbox'), { target: { value: 'again and again' } });
        await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Submit Report' })); });
        await waitFor(() => expect(node.reports).toHaveLength(1));
        const [r] = node.reports;
        expect(r).toEqual({ reporter: ana.publicKey, messageId: bens.id, reason: 'Spam or scam: again and again', disclosure: { epoch: bens.epoch, mk: Buffer.from(groupMessageKey(bens.key, bens.id)).toString('base64') } });
        expect(reportAbuse).not.toHaveBeenCalled();
        const mk = new Uint8Array(Buffer.from((r.disclosure as any).mk, 'base64'));
        const bind = (l: (typeof node.lines)[number]) => ({ groupId: G, epoch: bens.epoch, senderPubHex: l.author, messageId: l.id, part: 'body' as const, replyToId: null });
        expect(openGroupLineWithMessageKey(node.lines[0], bind(node.lines[0]), mk).text).toBe('You are all useless');
        expect(() => openGroupLineWithMessageKey(node.lines[1], bind(node.lines[1]), mk)).toThrow();
        expect(await within(card).findByTestId('report-sent')).toHaveTextContent(REPORT_WORDS.sent);
    });

    it("a refusal is shown in the card, which keeps the member's choice", async () => {
        await openChat();
        node.lie = (method, path) => (method === 'POST' && path.endsWith('/chat/report')
            ? new Response(JSON.stringify({ error: 'Message not found', code: 'not_found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
            : undefined);
        await act(async () => { fireEvent.click(reportButtons()[0]); });
        const card = screen.getByRole('dialog');
        fireEvent.click(within(card).getByRole('button', { name: 'Offensive content' }));
        await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Submit Report' })); });
        expect(await within(card).findByText('Message not found')).toBeInTheDocument();
        expect(within(card).getByRole('button', { name: '✓ Offensive content' })).toHaveAttribute('aria-pressed', 'true');
        expect(within(card).queryByTestId('report-sent')).toBeNull();
    });
});

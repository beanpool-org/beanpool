/**
 * A long message folds with "…more" in a web group chat (components/FoldedChatText.tsx, drawn by MessagesPage), a locked
 * group's opened line as much as any other: a 40-line line folds, opens in place and folds again; a 3-line one never shows the
 * control; my own long line folds too. The one-to-one half is MessagesPage.long-message-more.test.tsx.
 * Real group crypto, a node in memory behind the page's own transport (group-chat-fake-node.test-support.ts).
 */
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';
import { forgetGroupKeys, groupKeyring, memoryGroupLockStore } from '../lib/group-chat-keys';
import { sealLine } from '../lib/group-chat-crypto';
import { fakeGroupNode, person, type FakeGroupNode } from '../lib/group-chat-fake-node.test-support';
import { installFoldLayout, removeFoldLayout } from '../chat-fold-layout.test-support';

if (typeof window !== 'undefined' && window.HTMLElement) window.HTMLElement.prototype.scrollIntoView = vi.fn();

vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false), blockUser: vi.fn(), unblockUser: vi.fn(), getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}),
}));
vi.mock('../lib/archetypes', () => ({ consumeChatPrefill: vi.fn(() => null) }));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));

const G = '5c1d2c3b-4a59-4e68-9d7c-8b9a0f1e2d3d';
const ana = person(true);
const ben = person();
let node: FakeGroupNode;

const served = () => node.lines.map((l, i) => ({
    id: l.id, conversationId: G, authorPubkey: l.author, ciphertext: l.ciphertext, nonce: l.nonce, type: l.type ?? 'text',
    metadata: JSON.stringify(l.metadata), timestamp: new Date(Date.UTC(2026, 9, 12, 9, i)).toISOString(), editedAt: null,
}));

vi.mock('../lib/api', () => ({
    getConversations: vi.fn(async () => ({ conversations: [conv()], totalUnread: 0 })),
    getConversationMessages: vi.fn(async () => ({ conversation: conv(), messages: [] })),
    getMembers: vi.fn(async () => [{ publicKey: ben.publicKey, callsign: 'Ben' }]),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(), getEventChat: vi.fn(), postEventChatMessage: vi.fn(), removeEventChatMessage: vi.fn(), sendMessageApi: vi.fn(), editMessageApi: vi.fn(),
    toggleMessageReactionApi: vi.fn(), getMessageAttachmentApi: vi.fn(), completeMarketplaceTransaction: vi.fn(), cancelMarketplaceTransaction: vi.fn(),
    getGroupChat: vi.fn(async () => ({
        conversation: conv(), messages: served(), canPost: true,
        encryption: { current: node.current(), stale: false, fromEpoch: 1 },
    })),
    getGroupMembers: vi.fn(async () => node.shown.map((pk) => ({ groupId: G, memberPubkey: pk, callsign: pk === ana.publicKey ? 'Ana' : 'Ben', role: 'member', status: 'active', joinedAt: '' }))),
    groupKeysNet: {
        get: (p: string) => node.as(ana.publicKey).get(p),
        post: (p: string, b: unknown) => node.as(ana.publicKey).post(p, b),
    },
}));

function conv() {
    return { id: G, type: 'group_thread', name: 'Garden crew', participants: [ana.publicKey, ben.publicKey], createdBy: ana.publicKey, createdAt: '2026-10-01T00:00:00Z', unreadCount: 0 };
}

const me: BeanPoolIdentity = { publicKey: ana.publicKey, privateKey: ana.privateKey, callsign: 'Ana', createdAt: '2026-10-01T00:00:00Z' };

const fortyLines = Array.from({ length: 40 }, (_, i) => `Job ${i + 1} for the working bee`).join('\n');
const threeLines = 'Gloves\nSpades\nBarrow';

/** Ben's lines, sealed under the group's key as the page opens them. */
async function benSays(...texts: string[]) {
    const { epoch, key } = await groupKeyring(node.as(ben.publicKey), ben, G, memoryGroupLockStore()).prepareToSeal();
    for (const text of texts) {
        const id = crypto.randomUUID();
        const sealed = sealLine(text, { myEdPrivHex: ben.privateKey, groupKey: key, groupId: G, epoch, messageId: id });
        node.lines.push({ id, author: ben.publicKey, ciphertext: sealed.ciphertext, nonce: sealed.nonce, metadata: { epoch, sender: ben.publicKey } });
    }
    forgetGroupKeys();
}

async function openChat() {
    render(<MessagesPage identity={me} openConversationId={G} />);
    await screen.findByText('Gloves\nSpades\nBarrow', { normalizer: (s) => s }, { timeout: 5000 });
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    installFoldLayout();
    resetGroupChatLockStoreForTest();
    forgetGroupKeys();
    node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
});

afterEach(() => {
    cleanup();
    removeFoldLayout();
    vi.unstubAllGlobals();
});

describe('a web group chat folds a long message with …more', () => {
    it("Ben's 40-line line folds under …more, opens in place, and folds again; a 3-line one never shows the control", async () => {
        await benSays(fortyLines, threeLines);
        await openChat();

        const long = screen.getByTestId('chat-text').closest('[id^="msg-"]') as HTMLElement;
        expect(within(long).getByTestId('group-line-author').textContent).toBe('Ben');
        expect(within(long).getByTestId('chat-text').dataset.fold).toBe('folded');
        const more = within(long).getByRole('button', { name: '…more' });
        expect(more.textContent).toBe('…more');
        // Only the long one has a control; the 3-line line beside it is just its words.
        expect(screen.getAllByTestId('chat-fold-toggle')).toHaveLength(1);

        fireEvent.click(more);
        expect(within(long).getByTestId('chat-text').dataset.fold).toBe('open');
        expect(within(long).getByRole('button', { name: 'less' }).textContent).toBe('less');
        expect(within(long).getByTestId('chat-text').textContent).toBe(fortyLines);

        fireEvent.click(within(long).getByRole('button', { name: 'less' }));
        expect(within(long).getByTestId('chat-text').dataset.fold).toBe('folded');
        expect(within(long).getByRole('button', { name: '…more' })).toBeTruthy();
    });

    it('folds my own long line in the group too', async () => {
        await benSays(threeLines);
        const { epoch, key } = await groupKeyring(node.as(ana.publicKey), ana, G, memoryGroupLockStore()).prepareToSeal();
        const id = crypto.randomUUID();
        const sealed = sealLine(fortyLines, { myEdPrivHex: ana.privateKey, groupKey: key, groupId: G, epoch, messageId: id });
        node.lines.push({ id, author: ana.publicKey, ciphertext: sealed.ciphertext, nonce: sealed.nonce, metadata: { epoch, sender: ana.publicKey } });
        forgetGroupKeys();
        await openChat();
        expect(screen.getAllByTestId('chat-fold-toggle')).toHaveLength(1);
        expect(screen.getByTestId('chat-text').textContent).toBe(fortyLines);
        expect(screen.getByRole('button', { name: '…more' })).toBeTruthy();
    });
});

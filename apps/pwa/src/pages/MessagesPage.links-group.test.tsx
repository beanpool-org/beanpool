/**
 * A web group chat: a link in a line is a link (Marty, 9 Nov), a locked group's opened line as much as any other. The
 * one-to-one half is MessagesPage.links.test.tsx. Real group crypto, a node in memory behind the page's own transport
 * (group-chat-fake-node.test-support.ts).
 */
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
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

const opening = 'Gloves\nSpades\nBarrow';

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
    await screen.findByTestId('group-line-author', undefined, { timeout: 5000 });
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetGroupChatLockStoreForTest();
    forgetGroupKeys();
    node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('a web group chat: a link in a line', () => {
    it("Ben's line with a link draws it as a link to the address, in a new tab", async () => {
        await benSays('Working bee at https://byron.beanpool.org on Sunday');
        await openChat();

        const link = screen.getByTestId('chat-link') as HTMLAnchorElement;
        expect(link.closest('[id^="msg-"]')!.querySelector('[data-testid="group-line-author"]')!.textContent).toBe('Ben');
        expect(link.getAttribute('href')).toBe('https://byron.beanpool.org');
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
        expect(link.style.color).toBe('var(--link)');
        expect(link.style.textDecoration).toBe('underline');
        expect(link.closest('[data-testid="chat-bubble"]')!.textContent).toContain('Working bee at https://byron.beanpool.org on Sunday');
    });

    it('a click on it opens no reaction row, and is left to the browser', async () => {
        await benSays('https://byron.beanpool.org');
        await openChat();
        const link = screen.getByTestId('chat-link');
        let notPrevented = true;
        await act(async () => { notPrevented = fireEvent.click(link); });
        expect(notPrevented).toBe(true);
        expect(screen.queryByRole('button', { name: /^React with/ })).toBeNull();
    });

    it('my own line shows its link in the bubble\'s own white', async () => {
        await benSays(opening);
        const { epoch, key } = await groupKeyring(node.as(ana.publicKey), ana, G, memoryGroupLockStore()).prepareToSeal();
        const id = crypto.randomUUID();
        const sealed = sealLine('Our page: www.beanpool.org', { myEdPrivHex: ana.privateKey, groupKey: key, groupId: G, epoch, messageId: id });
        node.lines.push({ id, author: ana.publicKey, ciphertext: sealed.ciphertext, nonce: sealed.nonce, metadata: { epoch, sender: ana.publicKey } });
        forgetGroupKeys();
        await openChat();
        const link = screen.getByTestId('chat-link') as HTMLAnchorElement;
        expect(link.getAttribute('href')).toBe('https://www.beanpool.org');
        expect(link.style.color).toBe('inherit');
        expect(link.closest('[data-testid="chat-bubble"]')!.className).toContain('bp-bubble-mine');
    });

    it('a line with no link is just its words', async () => {
        await benSays(opening);
        await openChat();
        expect(screen.queryAllByTestId('chat-link')).toEqual([]);
        expect(document.querySelector('a[href]')).toBeNull();
    });
});

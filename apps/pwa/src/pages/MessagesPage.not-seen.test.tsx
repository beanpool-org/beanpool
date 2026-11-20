/**
 * "Not seen yet" on the web (DESIGN-notify-and-backup-asks-fable §4.5; amendment 2 §12.3, slice N4): core's line under my
 * newest line the other person hasn't seen or answered, from the same tick the bubble draws (their read cursor) and the
 * times. The rule itself is core's table (not-seen.test.ts); this holds where the page draws it, and that it reads nothing
 * of the other person's but the cursor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import type { ApiMessage, Conversation } from '../lib/api';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';
import { backToEnglish, showIn, xx } from '../words-xx.test-support';

if (typeof window !== 'undefined' && window.HTMLElement) window.HTMLElement.prototype.scrollIntoView = vi.fn();

vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false), blockUser: vi.fn(), unblockUser: vi.fn(),
    getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}),
}));
vi.mock('../lib/archetypes', () => ({ consumeChatPrefill: vi.fn(() => null) }));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));
vi.mock('../lib/e2e-crypto', async (importOriginal) => {
    const real = await importOriginal<typeof import('../lib/e2e-crypto')>();
    return {
        ...real,
        decodePlaintext: vi.fn((c: string) => c),
        openDmLine: vi.fn((p: { ciphertext: string }) => ({ text: p.ciphertext, format: 4, after: null, conversationId: '', moved: false })),
        checkDmThread: vi.fn(() => new Map()),
        isEncryptedNonce: vi.fn(() => false),
    };
});
vi.mock('../lib/visitor-lobby-gate', () => ({ communityInfoOnce: vi.fn(async () => ({})) }));

const state = vi.hoisted(() => ({ conversations: [] as unknown[], messages: {} as Record<string, unknown[]> }));
vi.mock('../lib/api', () => ({
    getNodeApiUrl: vi.fn(() => ''),
    getConversations: vi.fn(async () => ({ conversations: state.conversations, totalUnread: 0 })),
    getConversationMessages: vi.fn(async (id: string) => ({
        conversation: (state.conversations as Conversation[]).find(c => c.id === id), messages: state.messages[id] || [],
    })),
    getGroupChat: vi.fn(async (id: string) => ({
        conversation: (state.conversations as Conversation[]).find(c => c.id === id), messages: state.messages[id] || [], canPost: true,
    })),
    getGroupMembers: vi.fn(async () => []),
    groupKeysNet: { get: vi.fn(async () => new Response('{}', { status: 404 })), post: vi.fn(async () => new Response('{}', { status: 404 })) },
    getMembers: vi.fn(async () => [{ publicKey: 'peer-pubkey', callsign: 'Bob', avatarUrl: null, role: 'member' }]),
    getMemberCards: vi.fn(async () => []),
    getFriends: vi.fn(async () => []),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(),
    getEventChat: vi.fn(), postEventChatMessage: vi.fn(), removeEventChatMessage: vi.fn(),
    sendMessageApi: vi.fn(), editMessageApi: vi.fn(), toggleMessageReactionApi: vi.fn(), getMessageAttachmentApi: vi.fn(),
    completeMarketplaceTransaction: vi.fn(), cancelMarketplaceTransaction: vi.fn(),
    createGroup: vi.fn(),
}));

const me: BeanPoolIdentity = { publicKey: 'my-pubkey', privateKey: 'my-privkey', callsign: 'Alice', createdAt: '2026-09-14T00:00:00Z' };
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const dm = (peerLastReadAt: string | null): Conversation => ({
    id: 'conv-1', type: 'dm', name: null, participants: ['my-pubkey', 'peer-pubkey'], createdBy: 'my-pubkey',
    peerCallsign: 'Bob', peerAvatar: null, unreadCount: 0, createdAt: ago(30 * D), peerLastReadAt,
} as Conversation);
const line = (id: string, author: string, text: string, age: number, over: Partial<ApiMessage> = {}): ApiMessage => ({
    id, conversationId: 'conv-1', authorPubkey: author, ciphertext: text, nonce: '00000', type: 'text', timestamp: ago(age), metadata: null, ...over,
} as ApiMessage);

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetGroupChatLockStoreForTest();
    localStorage.clear();
});
afterEach(() => { cleanup(); backToEnglish(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function open(conv: Conversation, lines: ApiMessage[], waitFor: string) {
    state.conversations = [conv];
    state.messages = { 'conv-1': lines };
    render(<MessagesPage identity={me} openConversationId="conv-1" />);
    await screen.findAllByText(waitFor);
    await act(async () => {});
}

/** The element drawn straight before the line, so the words are known to sit under that message. */
const lineAbove = (el: Element) => el.previousElementSibling as HTMLElement | null;

describe('Not seen yet, on the web', () => {
    it('4 days unseen: the days and the other way, named, once, under my line', async () => {
        await open(dm(ago(6 * D)), [
            line('m1', 'peer-pubkey', 'Is the sourdough still going?', 7 * D),
            line('m2', 'my-pubkey', 'Yes! Want some?', 4 * D),
        ], 'Yes! Want some?');
        const shown = screen.getAllByTestId('not-seen-line');
        expect(shown).toHaveLength(1);
        expect(shown[0].textContent).toBe('Not seen in 4 days. You could try Bob another way.');
        expect(lineAbove(shown[0])?.id).toBe('msg-m2');
    });

    it('25 hours unseen, a node notice after it: "Not seen yet." still under my line', async () => {
        await open(dm(null), [
            line('m1', 'my-pubkey', 'Is the ladder still free?', 25 * H),
            line('m2', 'SYSTEM', '', 2 * H, { type: 'system', systemType: 'ESCROW_CANCELLED' as ApiMessage['systemType'], metadata: JSON.stringify({}) }),
        ], 'Is the ladder still free?');
        const shown = screen.getByTestId('not-seen-line');
        expect(shown.textContent).toBe('Not seen yet.');
        expect(lineAbove(shown)?.id).toBe('msg-m1');
    });

    it('two of mine unseen: under the newest, counted from the oldest', async () => {
        await open(dm(ago(9 * D)), [
            line('m1', 'my-pubkey', 'Hello?', 5 * D),
            line('m2', 'my-pubkey', 'Are you there?', 2 * H),
        ], 'Are you there?');
        const shown = screen.getByTestId('not-seen-line');
        expect(shown.textContent).toBe('Not seen in 5 days. You could try Bob another way.');
        expect(lineAbove(shown)?.id).toBe('msg-m2');
    });

    it('my newest line deleted: the words go under the one before it, which still waits', async () => {
        await open(dm(null), [
            line('m1', 'my-pubkey', 'Yes! Want some?', 4 * D),
            line('m2', 'my-pubkey', '', H, { type: 'removed' }),
        ], 'Yes! Want some?');
        const shown = screen.getByTestId('not-seen-line');
        expect(shown.textContent).toBe('Not seen in 4 days. You could try Bob another way.');
        expect(lineAbove(shown)?.id).toBe('msg-m1');
    });

    it('seen (✓✓): nothing', async () => {
        await open(dm(ago(D)), [line('m1', 'my-pubkey', 'Yes! Want some?', 4 * D)], 'Yes! Want some?');
        expect(screen.queryByTestId('not-seen-line')).toBeNull();
    });

    it('they wrote after it: nothing, whatever the cursor says', async () => {
        await open(dm(null), [
            line('m1', 'my-pubkey', 'Yes! Want some?', 4 * D),
            line('m2', 'peer-pubkey', 'Please!', 3 * D),
        ], 'Please!');
        expect(screen.queryByTestId('not-seen-line')).toBeNull();
    });

    it('sent an hour ago: nothing yet', async () => {
        await open(dm(null), [line('m1', 'my-pubkey', 'Yes! Want some?', H)], 'Yes! Want some?');
        expect(screen.queryByTestId('not-seen-line')).toBeNull();
    });

    it('in the pseudo-locale the words came through t()', async () => {
        await showIn('xx');
        await open(dm(null), [line('m1', 'my-pubkey', 'Yes! Want some?', 26 * H)], 'Yes! Want some?');
        expect(screen.getByTestId('not-seen-line').textContent).toBe(xx('Not seen yet.'));
    });
});

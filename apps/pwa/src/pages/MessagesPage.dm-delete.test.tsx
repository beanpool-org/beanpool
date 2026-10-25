/**
 * Web one-to-one chats: Delete your own message, as on the phone (parity with native DM delete).
 *
 * 1. Author sees Delete on own line in a DM.
 * 2. Clicking Delete opens the confirm dialog with the phone's words:
 *    - Title: "Delete for everyone?"
 *    - Body: 'It will read "This message was deleted" for both of you.'
 *    - Cancel / Delete buttons
 * 3. Cancel dismisses the dialog without deleting.
 * 4. Confirming Delete calls deleteMessageApi(messageId), and the line reloads as deleted
 *    ("This message was deleted") for both participants.
 * 5. Other participant's line has no Delete button.
 * 6. Enterprise and event chats offer no Delete button (node refuses there).
 */
import { render, screen, act, waitFor, cleanup, within, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { toEd25519Pkcs8 } from '@beanpool/core';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import type { Conversation, ApiMessage } from '../lib/api';
import { lockForDm } from '../lib/dm-lock';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';
import { forgetGroupKeys } from '../lib/group-chat-keys';
import * as api from '../lib/api';

if (typeof window !== 'undefined' && window.HTMLElement) {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
}
vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false),
    blockUser: vi.fn(),
    unblockUser: vi.fn(),
    getBlockedUsers: vi.fn(() => []),
    onBlocklistUpdated: vi.fn(() => () => {}),
}));
vi.mock('../lib/archetypes', () => ({ consumeChatPrefill: vi.fn(() => null) }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));

const thread = vi.hoisted(() => ({ conversation: null as any, messages: [] as any[] }));
vi.mock('../lib/api', () => ({
    getConversations: vi.fn(async () => ({ conversations: [thread.conversation], totalUnread: 0 })),
    getConversationMessages: vi.fn(async () => ({ conversation: thread.conversation, messages: thread.messages })),
    getGroupChat: vi.fn(async () => ({ conversation: thread.conversation, messages: thread.messages, canPost: true })),
    getGroupMembers: vi.fn(async () => []),
    groupKeysNet: {
        get: async () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
        post: async () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
    },
    getMembers: vi.fn(async () => []),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(),
    getEventChat: vi.fn(async () => ({
        event: { id: 'evt-1', title: 'Community Garden Meetup' },
        messages: thread.messages,
        isGoing: true,
        isHost: true,
        canPost: true,
        note: null,
    })),
    postEventChatMessage: vi.fn(),
    removeEventChatMessage: vi.fn(),
    sendMessageApi: vi.fn(),
    editMessageApi: vi.fn(),
    deleteMessageApi: vi.fn(async (messageId: string) => {
        const msg = thread.messages.find(m => m.id === messageId);
        if (msg) {
            msg.type = 'removed';
            msg.metadata = JSON.stringify({ ...(msg.metadata ? JSON.parse(msg.metadata) : {}), removed: true, removedBy: msg.authorPubkey });
        }
        return { success: true };
    }),
    toggleMessageReactionApi: vi.fn(),
    getMessageAttachmentApi: vi.fn(),
    completeMarketplaceTransaction: vi.fn(),
    cancelMarketplaceTransaction: vi.fn(),
}));

function person(name: string) {
    const seed = ed25519.utils.randomSecretKey();
    return { name, seed, publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(toEd25519Pkcs8(seed)) };
}

const ana = person('Ana');
const ben = person('Ben');
const CONV = 'c0ffee00-1111-4222-8333-444455556666';
const chat = { id: CONV, type: 'dm', participants: [ana.publicKey, ben.publicKey] };

let minute = 0;
const uuid = () => crypto.randomUUID();

function sent(from: typeof ana, text: string, after: string | null = null, replyToId?: string): ApiMessage {
    const id = uuid();
    const sealed = lockForDm(text, chat, from, { messageId: id, after, replyToId });
    return {
        id, conversationId: CONV, authorPubkey: from.publicKey, ...sealed, timestamp: new Date(Date.UTC(2026, 9, 1, 9, minute++)).toISOString(),
        ...(replyToId ? { metadata: JSON.stringify({ replyToId }) } : {}),
    } as ApiMessage;
}

const anaIdentity: BeanPoolIdentity = { publicKey: ana.publicKey, privateKey: ana.privateKey, callsign: 'Ana', createdAt: '2026-09-01T00:00:00Z' };
const benIdentity: BeanPoolIdentity = { publicKey: ben.publicKey, privateKey: ben.privateKey, callsign: 'Ben', createdAt: '2026-09-01T00:00:00Z' };

async function openChat(identity: BeanPoolIdentity = anaIdentity, convId: string = CONV): Promise<void> {
    render(<MessagesPage identity={identity} openConversationId={convId} />);
    await screen.findByPlaceholderText('Message...');
    await act(async () => {});
}

beforeEach(() => {
    minute = 0;
    vi.clearAllMocks();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetGroupChatLockStoreForTest();
    forgetGroupKeys();
    thread.conversation = {
        id: CONV, type: 'dm', name: null, participants: [ana.publicKey, ben.publicKey], createdBy: ana.publicKey,
        peerCallsign: 'Ben', unreadCount: 0, createdAt: '2026-09-01T00:00:00Z',
    } as Conversation;
    thread.messages = [];
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('Web one-to-one chats: Delete own line', () => {
    it("author sees Delete on own line with phone's words, confirm calls deleteMessageApi, and reads deleted for both", async () => {
        const anaMsg = sent(ana, 'See you at the library at 3pm');
        thread.messages = [anaMsg];

        await openChat(anaIdentity);
        const anaLine = (await screen.findByText('See you at the library at 3pm')).closest('[id^="msg-"]') as HTMLElement;

        // Author sees Delete button
        const delBtn = within(anaLine).getByRole('button', { name: 'Delete message' });
        expect(delBtn).toBeInTheDocument();

        // Clicking Delete opens confirm dialog with phone's DM wording
        await act(async () => {
            fireEvent.click(delBtn);
        });

        const dialog = screen.getByRole('dialog');
        expect(within(dialog).getByText('Delete for everyone?')).toBeInTheDocument();
        expect(within(dialog).getByText('It will read "This message was deleted" for both of you.')).toBeInTheDocument();

        // Cancel closes dialog without deleting
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(api.deleteMessageApi).not.toHaveBeenCalled();
        expect(screen.getByText('See you at the library at 3pm')).toBeInTheDocument();

        // Click Delete again and confirm
        await act(async () => {
            fireEvent.click(delBtn);
        });
        const dialog2 = screen.getByRole('dialog');
        await act(async () => {
            fireEvent.click(within(dialog2).getByRole('button', { name: 'Delete' }));
        });

        expect(api.deleteMessageApi).toHaveBeenCalledWith(anaMsg.id);

        // Ana sees tombstone: "This message was deleted"
        await screen.findByText('This message was deleted');
        expect(screen.queryByText('See you at the library at 3pm')).toBeNull();

        // Ben also sees the line as deleted ("for both of you")
        cleanup();
        await openChat(benIdentity);
        await screen.findByText('This message was deleted');
        expect(screen.queryByText('See you at the library at 3pm')).toBeNull();
    });

    it("others' lines in a DM offer no Delete button", async () => {
        const benMsg = sent(ben, 'I will bring the books');
        thread.messages = [benMsg];

        await openChat(anaIdentity);
        const benLine = (await screen.findByText('I will bring the books')).closest('[id^="msg-"]') as HTMLElement;

        expect(within(benLine).queryByRole('button', { name: 'Delete message' })).toBeNull();
    });

    it('enterprise chats offer no Delete button', async () => {
        const ENT_ID = 'ent-0001-4222-8333-444455556666';
        thread.conversation = {
            id: ENT_ID,
            type: 'enterprise_thread' as any,
            name: 'Local Bakery',
            participants: [ana.publicKey],
            createdBy: ana.publicKey,
            unreadCount: 0,
            createdAt: '2026-09-01T00:00:00Z',
        } as unknown as Conversation;
        thread.messages = [
            {
                id: uuid(),
                conversationId: ENT_ID,
                authorPubkey: ana.publicKey,
                ciphertext: 'Bread is fresh out of the oven',
                nonce: '00000',
                type: 'text',
                timestamp: new Date().toISOString(),
            } as ApiMessage,
        ];

        await openChat(anaIdentity, ENT_ID);
        const line = (await screen.findByText('Bread is fresh out of the oven')).closest('[id^="msg-"]') as HTMLElement;

        expect(within(line).queryByRole('button', { name: 'Delete message' })).toBeNull();
    });

    it('event chats offer no Delete button', async () => {
        const EVT_ID = 'evt-0001-4222-8333-444455556666';
        thread.conversation = {
            id: EVT_ID,
            type: 'event_thread',
            name: 'Harvest Party',
            participants: [ana.publicKey],
            createdBy: ana.publicKey,
            unreadCount: 0,
            createdAt: '2026-09-01T00:00:00Z',
        } as Conversation;
        thread.messages = [
            {
                id: uuid(),
                conversationId: EVT_ID,
                authorPubkey: ana.publicKey,
                ciphertext: Buffer.from('Bringing apples').toString('base64'),
                nonce: 'plaintext-v1',
                type: 'text',
                timestamp: new Date().toISOString(),
            } as ApiMessage,
        ];

        render(<MessagesPage identity={anaIdentity} openConversationId={EVT_ID} />);
        await screen.findByText('Bringing apples');

        expect(screen.queryByRole('button', { name: 'Delete message' })).toBeNull();
    });
});

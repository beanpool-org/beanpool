/**
 * Web chats: the words can be selected and copied (Marty, 9 Nov: "I can't select and copy text from previous messages").
 *
 * What blocked it: the page's global ::selection is the accent colour, and a member's own bubble is the accent colour, so a
 * selection there was accent on accent: nothing showed (index.css .bp-bubble-mine). Nothing set user-select: none on the words.
 *
 * 1. The words sit in a bubble that is selectable, and nothing above it turns selection off; a member's own bubble carries the
 *    class that draws its selection; the time and the chips are the only unselectable parts.
 * 2. Copy puts the words on the clipboard as shown, and says "Copied".
 * 3. A deleted line, and a line that did not open, offer no Copy.
 */
import { render, screen, act, cleanup, within, fireEvent } from '@testing-library/react';
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
import { isUserBlocked } from '../lib/blocklist';

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
    getEventChat: vi.fn(),
    postEventChatMessage: vi.fn(),
    removeEventChatMessage: vi.fn(),
    sendMessageApi: vi.fn(),
    editMessageApi: vi.fn(),
    deleteMessageApi: vi.fn(),
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

function sent(from: typeof ana, text: string, after: string | null = null): ApiMessage {
    const id = uuid();
    const sealed = lockForDm(text, chat, from, { messageId: id, after });
    return {
        id, conversationId: CONV, authorPubkey: from.publicKey, ...sealed, timestamp: new Date(Date.UTC(2026, 9, 1, 9, minute++)).toISOString(),
    } as ApiMessage;
}

const anaIdentity: BeanPoolIdentity = { publicKey: ana.publicKey, privateKey: ana.privateKey, callsign: 'Ana', createdAt: '2026-09-01T00:00:00Z' };

async function openChat(identity: BeanPoolIdentity = anaIdentity): Promise<void> {
    render(<MessagesPage identity={identity} openConversationId={CONV} />);
    await screen.findByPlaceholderText('Message...');
    await act(async () => {});
}

const writeText = vi.fn(async (_text: string) => {});

beforeEach(() => {
    minute = 0;
    vi.clearAllMocks();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
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
    vi.mocked(isUserBlocked).mockReturnValue(false);
    vi.unstubAllGlobals();
});

describe('Web chats: select and copy a message', () => {
    it('draws the words in a selectable bubble, with only the time unselectable', async () => {
        thread.messages = [sent(ana, 'Meet at the library at 3pm'), sent(ben, 'Bringing the ladder')];
        await openChat();
        const mine = await screen.findByText('Meet at the library at 3pm');
        const theirs = screen.getByText('Bringing the ladder');

        for (const words of [mine, theirs]) {
            const bubble = words.closest('[data-testid="chat-bubble"]') as HTMLElement;
            expect(bubble.style.userSelect).toBe('text');
            // Nothing between the words and the bubble, nor above the bubble, turns selection off.
            for (let el: HTMLElement | null = words; el; el = el.parentElement) {
                expect(el.style.userSelect).not.toBe('none');
                expect(el.className).not.toContain('select-none');
            }
        }
        // The member's own bubble is the accent colour: its selection is drawn by its own class (index.css).
        expect(mine.closest('[data-testid="chat-bubble"]')!.className).toContain('bp-bubble-mine');
        expect(theirs.closest('[data-testid="chat-bubble"]')!.className).not.toContain('bp-bubble-mine');
    });

    it("Copy puts someone else's words on the clipboard as shown, and says Copied", async () => {
        thread.messages = [sent(ben, 'Bringing the ladder\nand a thermos')];
        await openChat();
        const line = (await screen.findByText(/Bringing the ladder/)).closest('[id^="msg-"]') as HTMLElement;
        await act(async () => { fireEvent.click(within(line).getByRole('button', { name: 'Copy message' })); });
        expect(writeText).toHaveBeenCalledTimes(1);
        expect(writeText).toHaveBeenCalledWith('Bringing the ladder\nand a thermos');
        expect(within(line).getByRole('status').textContent).toBe('Copied');
        // The button's name holds the word it shows (WCAG 2.5.3): "Copy message" for "Copy", "Copied" for "Copied".
        expect(within(line).getByRole('button', { name: 'Copied' }).textContent).toBe('Copied');
    });

    it("copies the member's own words too", async () => {
        thread.messages = [sent(ana, 'Meet at the library at 3pm')];
        await openChat();
        const line = (await screen.findByText('Meet at the library at 3pm')).closest('[id^="msg-"]') as HTMLElement;
        await act(async () => { fireEvent.click(within(line).getByRole('button', { name: 'Copy message' })); });
        expect(writeText).toHaveBeenCalledWith('Meet at the library at 3pm');
    });

    it('offers no Copy on a deleted line', async () => {
        const gone = sent(ben, 'Said and then taken back');
        thread.messages = [{ ...gone, type: 'removed', metadata: JSON.stringify({ removed: true, removedBy: ben.publicKey }) } as ApiMessage];
        await openChat();
        const line = (await screen.findByText('This message was deleted')).closest('[id^="msg-"]') as HTMLElement;
        expect(within(line).queryByRole('button', { name: 'Copy message' })).toBeNull();
    });

    it('offers no Copy on a line that did not open', async () => {
        const lost = sent(ben, 'Sealed and then altered in transit');
        thread.messages = [{ ...lost, ciphertext: lost.ciphertext.slice(0, -4) + 'AAAA' } as ApiMessage];
        await openChat();
        await act(async () => {});
        expect(screen.queryByText('Sealed and then altered in transit')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull();
        expect(writeText).not.toHaveBeenCalled();
    });
});

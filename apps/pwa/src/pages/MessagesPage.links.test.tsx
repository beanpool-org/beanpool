/**
 * Web chats: a link in a message is a link (Marty, 9 Nov: on the phone a URL in a message is underlined and opens; in the web
 * app it was plain words). One-to-one chat here; the group chat is MessagesPage.links-group.test.tsx and the event chat is
 * components/EventChat.links.test.tsx. The rule is core's chat-links.ts, shared with the phone.
 *
 * 1. "https://byron.beanpool.org" in a bubble is an <a> with the right href, a new tab and noopener noreferrer, in someone
 *    else's bubble and the member's own; a bare www. gets https; the full stop that ends a sentence is not in the address.
 * 2. Clicking it opens nothing of the page's: no reaction row, no copy; the click is left to the browser (not prevented).
 * 3. Only http(s) and www. are links; words with no link are drawn as they were.
 * 4. A chat that is still a request has no links (as the phone's), and a line that did not open has none.
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

/** The bubble's links, as a person sees them. */
const linksIn = (el: HTMLElement) => within(el).queryAllByTestId('chat-link') as HTMLAnchorElement[];

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

describe('Web chats: a link in a message', () => {
    it('is a link to the address, in a new tab, that tells the page it opens nothing', async () => {
        thread.messages = [sent(ben, 'https://byron.beanpool.org')];
        await openChat();
        const bubble = (await screen.findByTestId('chat-link')).closest('[data-testid="chat-bubble"]') as HTMLElement;
        const [link, ...more] = linksIn(bubble);
        expect(more).toEqual([]);
        expect(link.tagName).toBe('A');
        expect(link.getAttribute('href')).toBe('https://byron.beanpool.org');
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
        expect(link.textContent).toBe('https://byron.beanpool.org');
        // Underlined (never colour alone), in the central link colour, and a long one may wrap anywhere.
        expect(link.style.textDecoration).toBe('underline');
        expect(link.style.color).toBe('var(--link)');
        expect(link.style.overflowWrap).toBe('anywhere');
    });

    it('keeps the words around it, and takes a bare www. to https and a sentence-ending full stop out of the address', async () => {
        thread.messages = [sent(ben, 'Join us at www.beanpool.org on Sunday, or read https://byron.beanpool.org/guide.')];
        await openChat();
        const bubble = (await screen.findAllByTestId('chat-link'))[0].closest('[data-testid="chat-bubble"]') as HTMLElement;
        const [first, second] = linksIn(bubble);
        expect(first.getAttribute('href')).toBe('https://www.beanpool.org');
        expect(first.textContent).toBe('www.beanpool.org');
        // The phone draws the full stop inside the link run too, and opens the address without it.
        expect(second.getAttribute('href')).toBe('https://byron.beanpool.org/guide');
        expect(second.textContent).toBe('https://byron.beanpool.org/guide.');
        // Every word is still there, in order.
        expect(bubble.textContent).toContain('Join us at www.beanpool.org on Sunday, or read https://byron.beanpool.org/guide.');
    });

    it("in the member's own bubble the link is the bubble's own white, bolder, and underlined", async () => {
        thread.messages = [sent(ana, 'Our page: https://byron.beanpool.org')];
        await openChat();
        const link = (await screen.findAllByTestId('chat-link'))[0] as HTMLAnchorElement;
        expect(link.closest('[data-testid="chat-bubble"]')!.className).toContain('bp-bubble-mine');
        expect(link.getAttribute('href')).toBe('https://byron.beanpool.org');
        expect(link.style.color).toBe('inherit');
        expect(link.style.fontWeight).toBe('600');
        expect(link.style.textDecoration).toBe('underline');
    });

    it('a click on it opens nothing of the chat\'s: no reaction row, no copy, and the click is left to the browser', async () => {
        thread.messages = [sent(ben, 'See https://byron.beanpool.org please')];
        await openChat();
        const link = (await screen.findAllByTestId('chat-link'))[0] as HTMLAnchorElement;
        const line = link.closest('[id^="msg-"]') as HTMLElement;

        let notPrevented = true;
        await act(async () => { notPrevented = fireEvent.click(link); });
        expect(notPrevented).toBe(true);
        expect(screen.queryByRole('button', { name: /^React with/ })).toBeNull();
        expect(writeText).not.toHaveBeenCalled();
        expect(within(line).queryByText('Copied')).toBeNull();

        // The check can fail: the bubble's own React button does open the row.
        await act(async () => { fireEvent.click(within(line).getByRole('button', { name: 'React to message' })); });
        expect(screen.queryAllByRole('button', { name: /^React with/ }).length).toBeGreaterThan(0);
    });

    it('a press and hold on it (pointer down, a pause, up) starts no copy', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            thread.messages = [sent(ben, 'See https://byron.beanpool.org please')];
            await openChat();
            const link = (await screen.findAllByTestId('chat-link'))[0] as HTMLAnchorElement;
            fireEvent.pointerDown(link);
            fireEvent.mouseDown(link);
            await act(async () => { vi.advanceTimersByTime(1500); });
            fireEvent.pointerUp(link);
            fireEvent.mouseUp(link);
            expect(writeText).not.toHaveBeenCalled();
            expect(screen.queryByRole('button', { name: /^React with/ })).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('Copy still copies the whole message, link and all', async () => {
        thread.messages = [sent(ben, 'See https://byron.beanpool.org please')];
        await openChat();
        const line = (await screen.findAllByTestId('chat-link'))[0].closest('[id^="msg-"]') as HTMLElement;
        await act(async () => { fireEvent.click(within(line).getByRole('button', { name: 'Copy message' })); });
        expect(writeText).toHaveBeenCalledWith('See https://byron.beanpool.org please');
    });

    it('only http(s) and www. are links: a bare domain, an address and other schemes are words', async () => {
        thread.messages = [
            sent(ben, 'byron.beanpool.org and ben@beanpool.org'),
            sent(ben, 'ftp://files.example.org/x and javascript:alert(1) and mailto:ben@beanpool.org'),
        ];
        await openChat();
        await screen.findByText(/byron\.beanpool\.org and ben@beanpool\.org/);
        expect(screen.queryAllByTestId('chat-link')).toEqual([]);
        expect(document.querySelector('a[href]')).toBeNull();
    });

    it('words with no link are drawn exactly as they were: no extra element in the bubble', async () => {
        thread.messages = [sent(ben, 'Bringing the ladder')];
        await openChat();
        const words = await screen.findByText('Bringing the ladder');
        expect(words.childElementCount).toBe(0);
        expect(words.tagName).toBe('DIV');
    });

    it('a chat that is still a request has no links, as on the phone', async () => {
        thread.conversation = {
            ...thread.conversation, request: { state: 'pending', from: ben.publicKey, at: '2026-10-01T00:00:00Z' }, addedYou: false,
        };
        thread.messages = [sent(ben, 'Hello, see https://byron.beanpool.org')];
        render(<MessagesPage identity={anaIdentity} openConversationId={CONV} />);
        await screen.findByText(/Hello, see https:\/\/byron\.beanpool\.org/);
        await act(async () => {});
        expect(screen.queryAllByTestId('chat-link')).toEqual([]);
        expect(document.querySelector('a[href^="https://byron"]')).toBeNull();
    });

    it('a line that did not open has no link, and shows none of its words', async () => {
        const lost = sent(ben, 'Sealed, then altered: https://evil.example/pay');
        thread.messages = [{ ...lost, ciphertext: lost.ciphertext.slice(0, -4) + 'AAAA' } as ApiMessage];
        await openChat();
        await act(async () => {});
        expect(screen.queryByText(/evil\.example/)).toBeNull();
        expect(screen.queryAllByTestId('chat-link')).toEqual([]);
        expect(document.querySelector('a[href*="evil"]')).toBeNull();
    });
});

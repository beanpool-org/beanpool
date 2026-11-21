/**
 * A DM on the web, notifications (scratch/fable-design/DESIGN-notify-and-backup-asks-fable-amend2.md §6, §12.3 slice N5b; the
 * phone's N2a): "Hear when Bob answers." [Tell me] under my line once the node took it, and "Hear when Bob writes again."
 * under his newest line read here, by core's rule for this browser; never in a request, nor with him blocked.
 *
 * Tables, each row red without its line: (moment: sent / theirs read) x (browser) x (the rule's state) -> the line under the
 * right line, or none, the browser's prompt never at the offer. Then a request, someone blocked, another chat opened in its
 * place, Tell me; 320 px at 130%, light and dark. The page over the stand-ins MessagesPage.optimistic-send.test.tsx uses.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { sendMessageApi, type ApiMessage, type Conversation } from '../lib/api';
import { isUserBlocked } from '../lib/blocklist';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';
import { resetPendingChatLinesForTest } from '../lib/pending-chat-lines';
import { readNotifyAsk } from '../lib/web-push';
import {
    BROWSERS, CAN_OFFER, RECORDS, clearBrowser, expectLineFits, keepRecord, oldPhone, resetScreen, standBrowser, type BrowserKind, type RecordKind,
} from '../components/notify-lines.test-support';

if (typeof window !== 'undefined' && window.HTMLElement) window.HTMLElement.prototype.scrollIntoView = vi.fn();

vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}), socketIsAlive: vi.fn(() => true) }));
vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false), blockUser: vi.fn(), unblockUser: vi.fn(), getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}),
}));
vi.mock('../lib/archetypes', () => ({ consumeChatPrefill: vi.fn(() => null) }));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));
vi.mock('../lib/visitor-lobby-gate', () => ({ communityInfoOnce: vi.fn(async () => ({})) }));
vi.mock('../lib/e2e-crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/e2e-crypto')>();
    return {
        ...actual,
        dmThreadInShownOrder: (msgs: any[]) => msgs,
        dmLineShownText: (v: any) => v?.text ?? '',
        dmLineIsUnattributed: () => false,
        dmReplyToOf: () => null,
        decodePlaintext: (c: string) => c,
        encodePlaintext: (text: string) => ({ ciphertext: text, nonce: '00000' }),
        sealDmLine: (text: string) => ({ ciphertext: text, nonce: '00000' }),
        openDmLine: (p: { ciphertext: string }) => ({ text: p.ciphertext, format: 4, after: null, conversationId: '', moved: false }),
        checkDmThread: () => new Map(),
        dmLineMarkText: () => null,
        newDmMessageId: () => 'msg-mine-1',
    };
});

const stand = vi.hoisted(() => ({ conversations: [] as unknown[], messages: {} as Record<string, unknown[]> }));
vi.mock('../lib/api', () => ({
    getNodeApiUrl: vi.fn(() => ''),
    getConversations: vi.fn(async () => ({ conversations: stand.conversations, totalUnread: 0 })),
    getConversationMessages: vi.fn(async (id: string) => ({ conversation: (stand.conversations as Conversation[]).find(c => c.id === id), messages: stand.messages[id] || [] })),
    getGroupChat: vi.fn(async () => ({ conversation: null, messages: [], canPost: true })),
    getGroupMembers: vi.fn(async () => []),
    groupKeysNet: { get: vi.fn(async () => new Response('{}', { status: 404 })), post: vi.fn(async () => new Response('{}', { status: 404 })) },
    getMembers: vi.fn(async () => [{ publicKey: 'b'.repeat(64), callsign: 'Bob', role: 'member' }]),
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

const ME = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const me: BeanPoolIdentity = { publicKey: ME, privateKey: '00'.repeat(48), callsign: 'Alice', createdAt: '2026-09-14T00:00:00Z' };
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const dm = (id: string, over: Partial<Conversation> = {}): Conversation => ({
    id, type: 'dm', name: null, participants: [ME, BOB], createdBy: ME, peerCallsign: 'Bob', peerAvatar: null, unreadCount: 0, createdAt: ago(9e8), ...over,
} as Conversation);
const line = (id: string, conv: string, author: string, text: string): ApiMessage => ({
    id, conversationId: conv, authorPubkey: author, ciphertext: text, nonce: '00000', type: 'text', timestamp: ago(60_000), metadata: null,
} as unknown as ApiMessage);

const ANSWER = 'Hear when Bob answers.';
const AGAIN = 'Hear when Bob writes again.';

async function open(convs: Conversation[], messages: Record<string, ApiMessage[]>, id: string, shown?: string) {
    stand.conversations = convs;
    stand.messages = messages;
    const view = render(<MessagesPage identity={me} openConversationId={id} />);
    if (shown) await screen.findAllByText(shown); else await screen.findByPlaceholderText('Message...');
    await act(async () => {});
    return view;
}

/** Sends a line; the node takes it and the next read has it. */
async function send(text: string) {
    vi.mocked(sendMessageApi).mockImplementation(async () => {
        stand.messages['conv-1'] = [...(stand.messages['conv-1'] ?? []), line('msg-mine-1', 'conv-1', ME, text)];
        return { success: true, message: line('msg-mine-1', 'conv-1', ME, text) } as any;
    });
    const composer = screen.getByPlaceholderText('Message...');
    fireEvent.change(composer, { target: { value: text } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(sendMessageApi).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('chat-line-sending')).toBeNull());
    await act(async () => {});
}

beforeEach(() => {
    window.alert = vi.fn();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetGroupChatLockStoreForTest();
    resetPendingChatLinesForTest();
    vi.clearAllMocks();
    vi.mocked(isUserBlocked).mockReturnValue(false);
    localStorage.clear();
});
afterEach(() => {
    cleanup();
    clearBrowser();
    resetScreen();
    vi.unstubAllGlobals();
});

describe("the moment x browser x the rule's state -> the line under the right line, or none", () => {
    for (const moment of ['sent', 'theirs read'] as const) {
        for (const b of BROWSERS) {
            for (const [rec, { offers, pins }] of Object.entries(RECORDS) as [RecordKind, { offers: boolean; pins: string }][]) {
                if (b !== 'default' && rec !== 'fresh') continue;
                const shows = CAN_OFFER[b as BrowserKind] && offers;
                const kind = moment === 'sent' ? 'answer' : 'again';
                const words = moment === 'sent' ? ANSWER : AGAIN;
                it(`${moment}, ${b}, ${rec} -> ${shows ? `"${words}" [Tell me]` : 'no line'} (pins: ${pins})`, async () => {
                    const ask = standBrowser(b, ME);
                    keepRecord(ME, rec, kind);
                    if (moment === 'sent') {
                        await open([dm('conv-1')], { 'conv-1': [] }, 'conv-1');
                        await send('Is the ladder still free?');
                    } else {
                        await open([dm('conv-1')], { 'conv-1': [line('m-bob', 'conv-1', BOB, 'Want some sourdough?')] }, 'conv-1');
                    }
                    if (shows) {
                        const held = await screen.findByTestId('chat-notify-line');
                        expect(held).toHaveTextContent(words);
                        // Straight under the line it is about.
                        const above = held.previousElementSibling as HTMLElement | null;
                        expect(above?.id ?? above?.querySelector('[id^="msg-"]')?.id).toBe(moment === 'sent' ? 'msg-msg-mine-1' : 'msg-m-bob');
                        expect(readNotifyAsk(ME).lines).toEqual([kind]);
                    } else {
                        await act(async () => {});
                        expect(screen.queryByTestId('chat-notify-line')).toBeNull();
                    }
                    expect(ask).not.toHaveBeenCalled();
                });
            }
        }
    }
});

describe('never in a request, nor with someone blocked; one per visit', () => {
    it("his request to me, unanswered: no line under his line (he hasn't been accepted)", async () => {
        standBrowser('default', ME);
        await open([dm('conv-1', { request: { state: 'pending', from: BOB, at: ago(120_000) } } as any)], { 'conv-1': [line('m-bob', 'conv-1', BOB, 'Hi, is the drill free?')] }, 'conv-1', 'Hi, is the drill free?');
        expect(screen.queryByTestId('chat-notify-line')).toBeNull();
        expect(readNotifyAsk(ME).lines).toBeUndefined();
    });

    it('Bob blocked: no line', async () => {
        standBrowser('default', ME);
        vi.mocked(isUserBlocked).mockImplementation((k: string) => k === BOB);
        await open([dm('conv-1')], { 'conv-1': [line('m-bob', 'conv-1', BOB, 'Want some sourdough?')] }, 'conv-1', 'Want some sourdough?');
        expect(screen.queryByTestId('chat-notify-line')).toBeNull();
        expect(readNotifyAsk(ME).lines).toBeUndefined();
    });

    it("a line the rule refused in one chat leaves nothing behind: the next chat's first send still offers its own line", async () => {
        standBrowser('default', ME);
        // 'again' is spent here: his line in conv-1 offers nothing; then conv-2, where my first line may still bring 'answer'.
        keepRecord(ME, 'kind spent', 'again');
        const view = await open([dm('conv-1'), dm('conv-2')], { 'conv-1': [line('m-bob', 'conv-1', BOB, 'Want some sourdough?')], 'conv-2': [] }, 'conv-1', 'Want some sourdough?');
        await act(async () => {});
        expect(screen.queryByTestId('chat-notify-line')).toBeNull();
        view.rerender(<MessagesPage identity={me} openConversationId="conv-2" />);
        await waitFor(() => expect(screen.queryByText('Want some sourdough?')).toBeNull());
        await screen.findByPlaceholderText('Message...');
        await act(async () => {});
        vi.mocked(sendMessageApi).mockImplementation(async () => {
            stand.messages['conv-2'] = [line('msg-mine-1', 'conv-2', ME, 'Hello again')];
            return { success: true, message: stand.messages['conv-2'][0] } as any;
        });
        const composer = screen.getByPlaceholderText('Message...');
        fireEvent.change(composer, { target: { value: 'Hello again' } });
        fireEvent.keyDown(composer, { key: 'Enter' });
        expect(await screen.findByTestId('chat-notify-line')).toHaveTextContent(ANSWER);
    });

    it("opened on his line, then I write: the one line stays his (one per visit), never a second", async () => {
        standBrowser('default', ME);
        await open([dm('conv-1')], { 'conv-1': [line('m-bob', 'conv-1', BOB, 'Want some sourdough?')] }, 'conv-1');
        await screen.findByTestId('chat-notify-line');
        await send('Yes please!');
        expect(screen.getAllByTestId('chat-notify-line')).toHaveLength(1);
        expect(screen.getByTestId('chat-notify-line')).toHaveTextContent(AGAIN);
    });
});

describe('the line drawn, and its Tell me', () => {
    for (const dark of [false, true]) {
        it(`320 px at 130%${dark ? ', dark' : ''}: wraps, keeps its target, colours from the tokens`, async () => {
            oldPhone(dark);
            standBrowser('default', ME);
            await open([dm('conv-1')], { 'conv-1': [line('m-bob', 'conv-1', BOB, 'Want some sourdough?')] }, 'conv-1');
            const held = await screen.findByTestId('chat-notify-line');
            expectLineFits(within(held).getByTestId('notify-line'));
        });
    }

    it("Tell me: the browser's prompt once, at the tap; a no kept apart and the line gone without a word", async () => {
        const ask = standBrowser('default', ME, 'denied');
        await open([dm('conv-1')], { 'conv-1': [line('m-bob', 'conv-1', BOB, 'Want some sourdough?')] }, 'conv-1');
        fireEvent.click(await screen.findByTestId('notify-line-tell-me'));
        await waitFor(() => expect(screen.queryByTestId('chat-notify-line')).toBeNull());
        expect(ask).toHaveBeenCalledTimes(1);
        expect(readNotifyAsk(ME).phoneNoAt).toEqual(expect.any(Number));
    });
    it("Tell me: the browser allows but the node doesn't take it ('failed'): said in words, and Tell me stays to try again", async () => {
        const ask = standBrowser('default', ME, 'granted');
        await open([dm('conv-1')], { 'conv-1': [line('m-bob', 'conv-1', BOB, 'Want some sourdough?')] }, 'conv-1');
        fireEvent.click(await screen.findByTestId('notify-line-tell-me'));
        const held = await screen.findByTestId('chat-notify-line');
        await within(held).findByTestId('notify-line-failed');
        expect(within(held).getByTestId('notify-line-tell-me')).not.toHaveProperty('disabled', true);
        expect(within(held).queryByTestId('notify-line-done')).toBeNull();
        expect(ask).toHaveBeenCalledTimes(1);
    });
});

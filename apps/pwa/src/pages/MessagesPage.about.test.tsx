/**
 * "About this listing" in a chat, on the web (@beanpool/core chat-about.ts; Marty, 9 Nov): Message on a listing leaves a chip
 * above the composer, in a new thread and in one already there; the next line carries the listing sealed beside its words,
 * and the card shows in the bubble, for the sender and for the reader, with real crypto against a node that stores what it
 * is sent. A listing the reader can't see is said so and opens nothing; a line from before is unchanged. A deleted line
 * and a line whose words did not open show no card; a refused send keeps its listing; each card is opened once per load.
 */
import { render, screen, act, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { aboutOfPost, chatAboutDrafts, chatAboutOfLine, metadataWithAbout, sealChatAbout } from '@beanpool/core';
import { MessagesPage } from './MessagesPage';
import { forgetAboutListings } from '../components/ChatAbout';
import type { BeanPoolIdentity } from '../lib/identity';
import { sendMessageApi, type ApiMessage } from '../lib/api';
import { dmKeyContext, lockForDm } from '../lib/dm-lock';
import { resetPendingChatLinesForTest } from '../lib/pending-chat-lines';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';
import { forgetGroupKeys } from '../lib/group-chat-keys';
import { person } from '../lib/group-chat-fake-node.test-support';

window.HTMLElement.prototype.scrollIntoView = (() => {}) as never;

// Pass-through: the real opener runs; the spy only counts how often a card is opened.
vi.mock('@beanpool/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@beanpool/core')>();
    return { ...actual, chatAboutOfLine: vi.fn(actual.chatAboutOfLine) };
});
vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}), socketIsAlive: vi.fn(() => true) }));
vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false), blockUser: vi.fn(), unblockUser: vi.fn(), getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}),
}));
vi.mock('../lib/archetypes', () => ({ consumeChatPrefill: vi.fn(() => null) }));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));

const ana = person(true);
const ben = person(true);
const DM = 'c0ffee00-1111-4222-8333-444455556666';
const dmConv = { id: DM, type: 'dm', name: null, participants: [ana.publicKey, ben.publicKey], createdBy: ana.publicKey, peerCallsign: 'Ben', unreadCount: 0, createdAt: '2026-09-01T00:00:00Z' };

const node = vi.hoisted(() => ({ rows: [] as any[], listings: [] as any[] }));

vi.mock('../lib/api', () => ({
    getConversations: vi.fn(async () => ({ conversations: [dmConv], totalUnread: 0 })),
    getConversationMessages: vi.fn(async () => ({ conversation: dmConv, messages: node.rows })),
    getMarketplacePosts: vi.fn(async (f?: { id?: string }) => node.listings.filter((p) => p.id === f?.id)),
    getGroupChat: vi.fn(), getGroupMembers: vi.fn(async () => []), groupKeysNet: { get: vi.fn(), post: vi.fn() },
    getMembers: vi.fn(async () => [{ publicKey: ben.publicKey, callsign: 'Ben' }]),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(), getEventChat: vi.fn(), postEventChatMessage: vi.fn(), removeEventChatMessage: vi.fn(), sendMessageApi: vi.fn(), editMessageApi: vi.fn(),
    toggleMessageReactionApi: vi.fn(), getMessageAttachmentApi: vi.fn(), completeMarketplaceTransaction: vi.fn(), cancelMarketplaceTransaction: vi.fn(),
}));

const me: BeanPoolIdentity = { publicKey: ana.publicKey, privateKey: ana.privateKey, callsign: 'Ana', createdAt: '2026-09-01T00:00:00Z' };

const EGGS = { id: 'post-eggs-1', type: 'offer', title: 'Fresh eggs', price_c: 600, priceType: 'fixed', status: 'active' };
let minute = 0;
const stamp = () => new Date(Date.UTC(2026, 9, 1, 9, minute++)).toISOString();

/** A line from Ben as his app writes it: the words sealed, and the listing sealed beside them when he pressed Message on one. */
function fromBen(text: string, post?: object): ApiMessage {
    const id = crypto.randomUUID();
    const words = lockForDm(text, dmConv as never, ben, { messageId: id });
    let metadata: string | undefined;
    if (post) {
        const ctx = dmKeyContext(dmConv as never, ben)!;
        metadata = metadataWithAbout(metadata, sealChatAbout(aboutOfPost(post)!, ctx, { senderPubHex: ben.publicKey, messageId: id }));
    }
    return { id, conversationId: DM, authorPubkey: ben.publicKey, ciphertext: words.ciphertext, nonce: words.nonce, type: 'text', metadata, timestamp: stamp() } as ApiMessage;
}

async function openDm() {
    const page = render(<MessagesPage identity={me} openConversationId={DM} onNavigate={navigate} />);
    const composer = await screen.findByPlaceholderText('Message...');
    await act(async () => {});
    return { ...page, composer: composer as HTMLTextAreaElement };
}
const navigate = vi.fn();
const pressSend = async (composer: HTMLElement) => { await act(async () => { fireEvent.keyDown(composer, { key: 'Enter' }); }); };
const limit = () => Object.assign(new Error('You can send 5 messages a day for now.'), { status: 429, code: 'probation_limit' });
const typed = async (composer: HTMLElement, text: string) => {
    fireEvent.change(composer, { target: { value: text } });
    await act(async () => { fireEvent.keyDown(composer, { key: 'Enter' }); });
};

beforeEach(() => {
    vi.clearAllMocks();
    window.alert = vi.fn();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetGroupChatLockStoreForTest();
    forgetGroupKeys();
    resetPendingChatLinesForTest();
    chatAboutDrafts.clear();
    forgetAboutListings();
    node.rows = [];
    node.listings = [{ ...EGGS }];
    minute = 0;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the chip above the composer', () => {
    it('shows in a new thread, as "About: title · price"', async () => {
        chatAboutDrafts.set(DM, aboutOfPost(EGGS));
        await openDm();
        expect(screen.getByTestId('chat-about-chip').textContent).toContain('About: Fresh eggs · 6 Beans');
    });

    it('shows in a thread that already has messages in it', async () => {
        node.rows = [fromBen('Hello Ana'), fromBen('Are you at the market on Saturday?')];
        chatAboutDrafts.set(DM, aboutOfPost(EGGS));
        await openDm();
        await screen.findByText('Are you at the market on Saturday?');
        expect(screen.getByTestId('chat-about-chip').textContent).toContain('About: Fresh eggs · 6 Beans');
    });

    it('stays while the member types, and is not there when they came by another way', async () => {
        const { composer } = await openDm();
        expect(screen.queryByTestId('chat-about-chip')).toBeNull();
        act(() => { chatAboutDrafts.set(DM, aboutOfPost(EGGS)); });
        fireEvent.change(composer, { target: { value: 'Is this still ava' } });
        expect(screen.getByTestId('chat-about-chip')).toBeTruthy();
    });

    it('goes with the ✕, and the next line then carries no listing', async () => {
        chatAboutDrafts.set(DM, aboutOfPost(EGGS));
        const { composer } = await openDm();
        fireEvent.click(screen.getByTestId('chat-about-chip-drop'));
        expect(screen.queryByTestId('chat-about-chip')).toBeNull();
        expect(chatAboutDrafts.get(DM)).toBeNull();
        await typed(composer, 'Hi there');
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(1));
        const metadata = vi.mocked(sendMessageApi).mock.calls[0][6];
        expect(metadata === undefined || !('about' in JSON.parse(metadata as string))).toBe(true);
    });

    it('has a ✕ a thumb can hit, named in words', async () => {
        chatAboutDrafts.set(DM, aboutOfPost(EGGS));
        await openDm();
        const drop = screen.getByTestId('chat-about-chip-drop');
        expect(drop.getAttribute('aria-label')).toBe('Leave this listing out of your message');
        expect(drop.style.minWidth).toBe('44px');
        expect(drop.style.minHeight).toBe('44px');
    });
});

describe('the line that carries it', () => {
    it('seals the listing beside the words: the node is sent no readable id, title or kind, and the other person opens it', async () => {
        chatAboutDrafts.set(DM, aboutOfPost(EGGS));
        const { composer } = await openDm();
        vi.mocked(sendMessageApi).mockReturnValueOnce(new Promise(() => {}) as never);
        await typed(composer, 'Is this still available?');
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(1));
        const call = vi.mocked(sendMessageApi).mock.calls[0] as unknown as string[];
        const [conversationId, , , , , , metadata, id] = call;
        const stored = JSON.stringify({ call });
        for (const readable of ['post-eggs-1', 'Fresh eggs', '"offer"', 'eggs']) expect(stored).not.toContain(readable);
        expect(Object.keys(JSON.parse(metadata))).toContain('about');
        const asBen = chatAboutOfLine({ myEdPrivHex: ben.privateKey, peerEdPubHex: ana.publicKey }, { conversationId, senderPubHex: ana.publicKey, messageId: id, metadata });
        expect(asBen).toEqual({ postId: 'post-eggs-1', title: 'Fresh eggs', kind: 'offer' });
        // The chip is spent once the line is on its way, and the line shows its card at once.
        expect(screen.queryByTestId('chat-about-chip')).toBeNull();
        expect(chatAboutDrafts.get(DM)).toBeNull();
        // On my own accent bubble the card is a plain darker shade of it: plain rgba, never a mixed colour an old WebView drops.
        const mine = await screen.findByTestId('chat-about-card');
        expect(mine.getAttribute('style')).toContain('rgba(0, 0, 0, 0.18)');
        expect(mine.getAttribute('style')).not.toContain('color-mix');
    });

    it('only the next line carries it', async () => {
        chatAboutDrafts.set(DM, aboutOfPost(EGGS));
        const { composer } = await openDm();
        await typed(composer, 'First');
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(1));
        await typed(composer, 'Second');
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(2));
        const second = vi.mocked(sendMessageApi).mock.calls[1][6];
        expect(second === undefined || !('about' in JSON.parse(second as string))).toBe(true);
    });
});

describe('the card in a bubble', () => {
    it('shows the listing\'s own title, kind and price to the reader, and a tap opens the listing', async () => {
        node.listings = [{ ...EGGS, title: 'Fresh eggs, a dozen', price_c: 800 }];
        node.rows = [fromBen('Is this still available?', EGGS)];
        await openDm();
        const card = await screen.findByTestId('chat-about-card');
        await waitFor(() => expect(card.textContent).toContain('Fresh eggs, a dozen'));
        expect(card.textContent).toContain('Offer');
        expect(card.textContent).toContain('8 Beans');
        // Named by what it shows (WCAG 2.5.3: no label of its own to differ from the visible words); the sentence is its hint.
        expect(card.getAttribute('aria-label')).toBeNull();
        expect(card.getAttribute('title')).toBe('Open this listing: Fresh eggs, a dozen');
        // In Ben's plain bubble it takes the page's own ground and border tokens, which both themes define.
        expect(card.getAttribute('style')).toContain('var(--bg-hover)');
        expect(card.getAttribute('style')).toContain('var(--border-primary)');
        fireEvent.click(card);
        expect(navigate).toHaveBeenCalledWith('marketplace', 'post-eggs-1');
    });

    it('says the listing is no longer up when this reader can\'t see it, and opens nothing', async () => {
        node.listings = [];
        node.rows = [fromBen('Is this still available?', EGGS)];
        await openDm();
        expect((await screen.findByTestId('chat-about-gone')).textContent).toBe('This listing is no longer up.');
        expect(screen.queryByTestId('chat-about-card')).toBeNull();
        expect(screen.queryByText('Fresh eggs')).toBeNull();
        fireEvent.click(screen.getByTestId('chat-about-gone'));
        expect(navigate).not.toHaveBeenCalled();
    });

    it('a line with no listing, as every line from before, shows its words alone', async () => {
        node.rows = [fromBen('Hello Ana')];
        await openDm();
        expect(await screen.findByText('Hello Ana')).toBeTruthy();
        expect(screen.queryByTestId('chat-about-card')).toBeNull();
        expect(screen.queryByTestId('chat-about-gone')).toBeNull();
    });

    it('a reference moved onto another line shows no card', async () => {
        const good = fromBen('Is this still available?', EGGS);
        const other = fromBen('Something else');
        node.rows = [{ ...other, metadata: good.metadata }];
        await openDm();
        expect(await screen.findByText('Something else')).toBeTruthy();
        expect(screen.queryByTestId('chat-about-card')).toBeNull();
        expect(screen.queryByTestId('chat-about-gone')).toBeNull();
    });
});

describe('a deleted line', () => {
    it('shows no card, though an older row on the node still holds the sealed reference', async () => {
        const row = fromBen('Is this still available?', EGGS);
        // A "Delete for everyone" from before the node dropped the reference with the line: the marker words, the tombstone keys, and `about` still there.
        node.rows = [{
            ...row, type: 'removed', ciphertext: btoa('This message was deleted'), nonce: 'plaintext-v1',
            metadata: JSON.stringify({ ...JSON.parse(row.metadata!), removed: true, removedBy: ben.publicKey, removedAt: stamp() }),
        }];
        await openDm();
        expect(await screen.findByText('This message was deleted')).toBeTruthy();
        expect(screen.queryByTestId('chat-about-card')).toBeNull();
        expect(screen.queryByTestId('chat-about-gone')).toBeNull();
        expect(screen.queryByText('Fresh eggs')).toBeNull();
    });
});

describe('a send the node refuses', () => {
    it('puts the listing back with the words, so a Send from the composer still goes with it', async () => {
        chatAboutDrafts.set(DM, aboutOfPost(EGGS));
        const { composer } = await openDm();
        vi.mocked(sendMessageApi).mockRejectedValueOnce(limit());
        await typed(composer, 'Is this still available?');
        await screen.findByText('You can send 5 messages a day for now.');
        expect(composer.value).toBe('Is this still available?');
        expect(screen.getByTestId('chat-about-chip').textContent).toContain('About: Fresh eggs · 6 Beans');

        vi.mocked(sendMessageApi).mockResolvedValueOnce({ success: true } as never);
        await pressSend(composer);
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(2));
        const [, again] = vi.mocked(sendMessageApi).mock.calls as unknown as string[][];
        const [conversationId, , , , , , metadata, id] = again;
        expect(chatAboutOfLine({ myEdPrivHex: ben.privateKey, peerEdPubHex: ana.publicKey }, { conversationId, senderPubHex: ana.publicKey, messageId: id, metadata }))
            .toEqual({ postId: 'post-eggs-1', title: 'Fresh eggs', kind: 'offer' });
        // The refused copy is replaced by this one, and the chip is spent once more.
        expect(screen.queryByTestId('chat-about-chip')).toBeNull();
        expect(chatAboutDrafts.get(DM)).toBeNull();
        expect(screen.getAllByTestId('chat-about-card')).toHaveLength(1);
    });

    it('its Retry sends the same line under the same id with the listing, and the chip does not stay for the next line', async () => {
        chatAboutDrafts.set(DM, aboutOfPost(EGGS));
        const { composer } = await openDm();
        vi.mocked(sendMessageApi).mockRejectedValueOnce(limit());
        await typed(composer, 'Is this still available?');
        await screen.findByText('You can send 5 messages a day for now.');
        expect(screen.getByTestId('chat-about-chip')).toBeTruthy();

        vi.mocked(sendMessageApi).mockResolvedValueOnce({ success: true } as never);
        await act(async () => { fireEvent.click(screen.getByTestId('chat-line-retry')); });
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(2));
        const [first, again] = vi.mocked(sendMessageApi).mock.calls as unknown as string[][];
        expect(again[7]).toBe(first[7]);
        expect(Object.keys(JSON.parse(again[6]))).toContain('about');
        expect(screen.queryByTestId('chat-about-chip')).toBeNull();
        expect(chatAboutDrafts.get(DM)).toBeNull();
        expect(composer.value).toBe('');

        await typed(composer, 'And the price?');
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(3));
        const third = vi.mocked(sendMessageApi).mock.calls[2][6];
        expect(third === undefined || !('about' in JSON.parse(third as string))).toBe(true);
    });

    it('words typed since stay as they are, no listing lands under them, and the line\'s Retry still carries its own', async () => {
        chatAboutDrafts.set(DM, aboutOfPost(EGGS));
        const { composer } = await openDm();
        let refuse!: (e: Error) => void;
        vi.mocked(sendMessageApi).mockReturnValueOnce(new Promise((_, reject) => { refuse = reject; }) as never);
        await typed(composer, 'Is this still available?');
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(1));
        fireEvent.change(composer, { target: { value: 'Never mind the colour' } });
        await act(async () => { refuse(limit()); });
        await screen.findByTestId('chat-line-failed');
        expect(composer.value).toBe('Never mind the colour');
        expect(screen.queryByTestId('chat-about-chip')).toBeNull();

        vi.mocked(sendMessageApi).mockResolvedValueOnce({ success: true } as never);
        await act(async () => { fireEvent.click(screen.getByTestId('chat-line-retry')); });
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(2));
        const [first, again] = vi.mocked(sendMessageApi).mock.calls as unknown as string[][];
        expect(again[7]).toBe(first[7]);
        expect(Object.keys(JSON.parse(again[6]))).toContain('about');
        expect(composer.value).toBe('Never mind the colour');
    });
});

describe('opening the cards', () => {
    it('opens each card once per load, not on every key the member types', async () => {
        node.rows = [fromBen('Is this still available?', EGGS), fromBen('And the second dozen?', EGGS), fromBen('Hello Ana')];
        const { composer } = await openDm();
        expect(await screen.findAllByTestId('chat-about-card')).toHaveLength(2);
        await act(async () => {});
        const opened = vi.mocked(chatAboutOfLine).mock.calls.length;
        expect(opened).toBeGreaterThan(0);
        for (const value of ['I', 'I w', 'I wo', 'I wou', 'I woul', 'I would']) fireEvent.change(composer, { target: { value } });
        await act(async () => {});
        expect(vi.mocked(chatAboutOfLine).mock.calls.length).toBe(opened);
        expect(screen.getAllByTestId('chat-about-card')).toHaveLength(2);
    });
});

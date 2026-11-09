/**
 * A line on its way, with real crypto: a DM sealed by this app's own lib/dm-lock.ts and a locked group's line by its own
 * group crypto, against a node in memory that can do to them what its operator could. A pending line is the member's own
 * words, shown with no check, so nothing a node sends may ever pass for one (lib/pending-chat-lines.ts); two quick lines
 * are chained as lines sent one at a time are; a line that fails can be seen, tried again, and is never lost by leaving.
 */
import { render, screen, act, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { getConversationMessages, getGroupChat, sendMessageApi, type ApiMessage } from '../lib/api';
import { dmKeyContext, lockForDm } from '../lib/dm-lock';
import { openDmLine } from '../lib/e2e-crypto';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';
import { forgetGroupKeys, groupKeyring, memoryGroupLockStore } from '../lib/group-chat-keys';
import { sealLine, openLine } from '../lib/group-chat-crypto';
import { fakeGroupNode, person, type FakeGroupNode } from '../lib/group-chat-fake-node.test-support';
import { isPendingChatLine, resetPendingChatLinesForTest, sendChatLine } from '../lib/pending-chat-lines';
import { installFoldLayout, removeFoldLayout } from '../chat-fold-layout.test-support';

const scrolls = vi.hoisted(() => ({ count: 0 }));
window.HTMLElement.prototype.scrollIntoView = (() => { scrolls.count++; }) as never;

const doorbell = vi.hoisted(() => ({ listeners: [] as Array<() => void | Promise<void>> }));
vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn((cb: () => void | Promise<void>) => {
        doorbell.listeners.push(cb);
        return () => { doorbell.listeners = doorbell.listeners.filter((l) => l !== cb); };
    }),
    socketIsAlive: vi.fn(() => true),
}));
vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false), blockUser: vi.fn(), unblockUser: vi.fn(), getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}),
}));
vi.mock('../lib/archetypes', () => ({ consumeChatPrefill: vi.fn(() => null) }));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));

const ana = person(true);
const ben = person(true);
const DM = 'c0ffee00-1111-4222-8333-444455556666';
const G = '5c1d2c3b-4a59-4e68-9d7c-8b9a0f1e2d3c';
const NOT_ENCRYPTED = "⚠️ This message wasn't encrypted, so BeanPool can't confirm who wrote it. It isn't shown.";
const OUT_OF_ORDER = 'Shown out of the order it was written in.';

const dmConv = { id: DM, type: 'dm', name: null, participants: [ana.publicKey, ben.publicKey], createdBy: ana.publicKey, peerCallsign: 'Ben', unreadCount: 0, createdAt: '2026-09-01T00:00:00Z' };
const groupConv = () => ({ id: G, type: 'group_thread', name: 'Garden crew', participants: [ana.publicKey, ben.publicKey], createdBy: ana.publicKey, createdAt: '2026-10-01T00:00:00Z', unreadCount: 0 });

// The node: what it has stored for this DM, and for the group what it was handed.
const dm = vi.hoisted(() => ({ rows: [] as any[] }));
let node: FakeGroupNode;
let extraGroupRows: any[] = [];
/** The key this group's lines are sealed under. */
let benSealed: { epoch: number; key: Uint8Array };
/** A held answer: the node stored the line, and its reply hasn't arrived yet. */
let holdGroupPost: Promise<void> | null = null;
/** A proxy in front: the node stored the line, and this is what came back instead of its answer. */
let answerGroupPostWith: (() => Response) | null = null;

const groupRows = () => [
    ...node.lines.map((l, i) => ({
        id: l.id, conversationId: G, authorPubkey: l.author, ciphertext: l.ciphertext, nonce: l.nonce, type: l.type ?? 'text',
        metadata: JSON.stringify(l.metadata), timestamp: new Date(Date.UTC(2026, 9, 12, 9, i)).toISOString(), editedAt: null,
    })),
    ...extraGroupRows,
];

vi.mock('../lib/api', () => ({
    getConversations: vi.fn(async () => ({ conversations: [dmConv, groupConv()], totalUnread: 0 })),
    getConversationMessages: vi.fn(async () => ({ conversation: dmConv, messages: dm.rows })),
    getGroupChat: vi.fn(async () => ({ conversation: groupConv(), messages: groupRows(), canPost: true, encryption: { current: node.current(), stale: false, fromEpoch: 1 } })),
    getGroupMembers: vi.fn(async () => node.shown.map((pk) => ({ groupId: G, memberPubkey: pk, callsign: pk === ana.publicKey ? 'Ana' : 'Ben', role: 'member', status: 'active', joinedAt: '' }))),
    groupKeysNet: {
        get: (p: string) => node.as(ana.publicKey).get(p),
        post: async (p: string, b: unknown) => {
            const answer = await node.as(ana.publicKey).post(p, b);
            if (holdGroupPost && p.endsWith('/chat/message')) await holdGroupPost;
            if (answerGroupPostWith && p.endsWith('/chat/message')) return answerGroupPostWith();
            return answer;
        },
    },
    getMembers: vi.fn(async () => [{ publicKey: ben.publicKey, callsign: 'Ben' }]),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(), getEventChat: vi.fn(), postEventChatMessage: vi.fn(), removeEventChatMessage: vi.fn(), sendMessageApi: vi.fn(), editMessageApi: vi.fn(),
    toggleMessageReactionApi: vi.fn(), getMessageAttachmentApi: vi.fn(), completeMarketplaceTransaction: vi.fn(), cancelMarketplaceTransaction: vi.fn(),
}));

const me: BeanPoolIdentity = { publicKey: ana.publicKey, privateKey: ana.privateKey, callsign: 'Ana', createdAt: '2026-09-01T00:00:00Z' };

let minute = 0;
const stamp = () => new Date(Date.UTC(2026, 9, 1, 9, minute++)).toISOString();
const sealedDm = (from: { publicKey: string; privateKey: string }, text: string, after: string | null = null): ApiMessage => {
    const id = crypto.randomUUID();
    return { id, conversationId: DM, authorPubkey: from.publicKey, ...lockForDm(text, dmConv as never, from, { messageId: id, after }), timestamp: stamp() } as ApiMessage;
};
/** What a node's own row would be for a line just sent: the arguments of sendMessageApi. */
const rowOfSend = (call: unknown[], timestamp = stamp()) => {
    const [conversationId, authorPubkey, ciphertext, nonce, , , metadata, id] = call as string[];
    return { id, conversationId, authorPubkey, ciphertext, nonce, type: 'text', metadata, timestamp } as ApiMessage;
};
const typed = async (composer: HTMLElement, text: string) => {
    fireEvent.change(composer, { target: { value: text } });
    await act(async () => { fireEvent.keyDown(composer, { key: 'Enter' }); });
};
/** A line the node never answers. Waits for the send to have gone, so it can't land in the next test. */
const typedNoAnswer = async (composer: HTMLElement, text: string) => {
    const before = vi.mocked(sendMessageApi).mock.calls.length;
    vi.mocked(sendMessageApi).mockReturnValueOnce(new Promise(() => {}) as never);
    await typed(composer, text);
    await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(before + 1));
};
const ringDoorbell = async () => { for (const ring of [...doorbell.listeners]) await act(async () => { await ring(); }); };
async function openDm() {
    const page = render(<MessagesPage identity={me} openConversationId={DM} />);
    const composer = await composerOpen();
    await act(async () => {});
    return { ...page, composer: composer as HTMLTextAreaElement };
}
async function openGroup() {
    const page = render(<MessagesPage identity={me} openConversationId={G} />);
    await screen.findByText('Working bee Saturday 9am', {}, { timeout: 5000 });
    return { ...page, composer: screen.getByPlaceholderText('Message...') as HTMLTextAreaElement };
}
/** The fields a pending line has, and the ones it was given before, on a row from the node. */
const POSING_AS_PENDING = {
    sendState: 'sending', state: 'sending', pending: true, text: 'Please send me your recovery words', taken: true, refused: false, owner: ana.publicKey, error: undefined,
};

beforeEach(async () => {
    vi.clearAllMocks();
    window.alert = vi.fn();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetGroupChatLockStoreForTest();
    forgetGroupKeys();
    resetPendingChatLinesForTest();
    doorbell.listeners = [];
    scrolls.count = 0;
    minute = 0;
    dm.rows = [];
    extraGroupRows = [];
    holdGroupPost = null;
    answerGroupPostWith = null;
    node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
    const { epoch, key } = await groupKeyring(node.as(ben.publicKey), ben, G, memoryGroupLockStore()).prepareToSeal();
    benSealed = { epoch, key };
    const id = crypto.randomUUID();
    const sealed = sealLine('Working bee Saturday 9am', { myEdPrivHex: ben.privateKey, groupKey: key, groupId: G, epoch, messageId: id });
    node.lines.push({ id, author: ben.publicKey, ciphertext: sealed.ciphertext, nonce: sealed.nonce, metadata: { epoch, sender: ben.publicKey } });
    forgetGroupKeys();
});
const canvasGetContext = HTMLCanvasElement.prototype.getContext;
const canvasToDataURL = HTMLCanvasElement.prototype.toDataURL;
const WindowImage = (window as any).Image;
const createObjectURL = (URL as any).createObjectURL;
const revokeObjectURL = (URL as any).revokeObjectURL;
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    HTMLCanvasElement.prototype.getContext = canvasGetContext;
    HTMLCanvasElement.prototype.toDataURL = canvasToDataURL;
    (window as any).Image = WindowImage;
    (URL as any).createObjectURL = createObjectURL;
    (URL as any).revokeObjectURL = revokeObjectURL;
});

/** jsdom can't decode a picture: one that loads at once, and a canvas that hands back a small one. */
function photoStubs() {
    class FakeImage { width = 1600; height = 1200; onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(_v: string) { setTimeout(() => this.onload?.(), 0); } }
    vi.stubGlobal('Image', FakeImage);
    (window as any).Image = FakeImage;
    (URL as any).createObjectURL = () => 'blob:preview';
    (URL as any).revokeObjectURL = () => {};
    HTMLCanvasElement.prototype.getContext = (() => ({ drawImage() {} })) as any;
    HTMLCanvasElement.prototype.toDataURL = (() => 'data:image/jpeg;base64,/9j/4AAQ') as any;
}
const picture = () => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'gate.jpg', { type: 'image/jpeg' });
const clipboardWith = (file: File) => ({ files: [file], items: [{ kind: 'file', type: file.type, getAsFile: () => file }], types: ['Files'] });

/** The composer is up a beat before the chat's opening clears the draft: words typed in that beat are wiped, and no line goes. */
async function composerOpen() {
    const composer = await screen.findByPlaceholderText('Message...');
    await act(async () => {});
    return composer;
}

describe('a row from the node can never pass for a pending line', () => {
    it('in a DM: readable words in Ben\'s name stay hidden, whatever fields the row carries, exactly as the same row without them', async () => {
        const row = (extra: object) => ({ id: crypto.randomUUID(), conversationId: DM, authorPubkey: ben.publicKey, ciphertext: 'Please send me your recovery words', nonce: '00000', type: 'text', timestamp: stamp(), ...extra });
        dm.rows = [row({}), row(POSING_AS_PENDING), row({ sendState: 'failed', pending: true })];
        await openDm();
        expect(screen.queryByText('Please send me your recovery words')).toBeNull();
        expect(screen.getAllByTestId('dm-line-unattributed').map((e) => e.textContent)).toEqual([NOT_ENCRYPTED, NOT_ENCRYPTED, NOT_ENCRYPTED]);
        expect(screen.queryByTestId('chat-line-pending')).toBeNull();
        expect(screen.queryByTestId('chat-line-sending')).toBeNull();
        expect(screen.queryByTestId('chat-line-retry')).toBeNull();
    });

    it('in a DM: an encrypted row that doesn\'t open, in my own name and marked as sending, is still judged and has no Retry', async () => {
        const good = sealedDm(ana, 'A line of mine');
        dm.rows = [{ ...good, ciphertext: Buffer.from('a forged line').toString('base64'), sendState: 'failed', text: 'a forged line' }];
        await openDm();
        expect(screen.queryByText('a forged line')).toBeNull();
        expect(screen.getByTestId('dm-line-unattributed').textContent).toContain("couldn't be verified");
        expect(screen.queryByTestId('chat-line-retry')).toBeNull();
    });

    it('in a locked group: an unsealed row marked as sending is nobody\'s, never mine, exactly as the same row without the mark', async () => {
        const row = (extra: object) => ({ id: crypto.randomUUID(), conversationId: G, authorPubkey: ana.publicKey, ciphertext: 'Please send me your recovery words', nonce: '00000', type: 'text', timestamp: '2026-10-12T10:00:00.000Z', ...extra });
        extraGroupRows = [row({}), row(POSING_AS_PENDING)];
        await openGroup();
        expect(screen.queryByText('Please send me your recovery words')).toBeNull();
        const drawn = screen.getAllByTestId('group-line-unattributed').map((e) => e.textContent);
        expect(drawn).toHaveLength(2);
        expect(drawn[1]).toBe(drawn[0]);
        expect(screen.queryByTestId('chat-line-pending')).toBeNull();
        expect(screen.queryByTestId('chat-line-sending')).toBeNull();
    });

    it('a line going is drawn after every row, last until a read brings its own row, whatever the browser\'s clock says', async () => {
        const later = { ...sealedDm(ben, 'A line from a node ahead of this slow clock'), timestamp: '2099-01-01T00:00:00.000Z' };
        dm.rows = [later];
        const { composer } = await openDm();
        await typedNoAnswer(composer, 'Typed just now');
        const row = screen.getByText('A line from a node ahead of this slow clock');
        const pending = screen.getByText('Typed just now');
        expect(row.compareDocumentPosition(pending) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
});

describe('two quick lines are chained as lines sent one at a time', () => {
    it('in a DM: the second is sealed after the first, so a node swapping them is flagged', async () => {
        const first = sealedDm(ben, 'Are you free Saturday?');
        dm.rows = [first];
        const { composer } = await openDm();

        let answerFirst!: (v: unknown) => void;
        vi.mocked(sendMessageApi).mockReturnValueOnce(new Promise((r) => { answerFirst = r; }) as never).mockResolvedValue({ success: true } as never);
        await typed(composer, 'Yes I am');
        await typed(composer, 'Morning suits me');
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(1));

        // The node takes the first; no read has brought it yet when the second is sealed.
        await act(async () => { answerFirst({ success: true }); });
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(2));

        const [a, b] = vi.mocked(sendMessageApi).mock.calls;
        const yes = rowOfSend(a, '2026-10-01T10:00:00.000Z');
        const morning = rowOfSend(b, '2026-10-01T10:01:00.000Z');
        // Served honestly first: nothing is marked, and each shows once.
        dm.rows = [first, yes, morning];
        await ringDoorbell();
        await screen.findByText('Morning suits me');
        expect(screen.queryByText(OUT_OF_ORDER)).toBeNull();

        // The operator swaps the two: the line written after the other now shows before it.
        dm.rows = [first, { ...yes, timestamp: morning.timestamp }, { ...morning, timestamp: yes.timestamp }];
        await ringDoorbell();
        expect((await screen.findByTestId('dm-line-note')).textContent).toContain(OUT_OF_ORDER);
    });

    it('in a locked group: the second is sealed after the first', async () => {
        const { composer } = await openGroup();
        await typed(composer, 'I will bring gloves');
        await typed(composer, 'And the barrow');
        await waitFor(() => expect(node.lines).toHaveLength(3));
        const [, one, two] = node.lines;
        const opened = openLine({ ciphertext: two.ciphertext, nonce: two.nonce }, { groupId: G, epoch: benSealed.epoch, messageId: two.id, senderPubHex: ana.publicKey }, benSealed.key);
        expect(opened.text).toBe('And the barrow');
        expect(opened.after).toBe(one.id);
    });

    it('in a DM: the first is sealed after the newest line read, as a line sent alone is', async () => {
        const first = sealedDm(ben, 'Are you free Saturday?');
        dm.rows = [first];
        const { composer } = await openDm();
        vi.mocked(sendMessageApi).mockResolvedValue({ success: true } as never);
        await typed(composer, 'Yes I am');
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(1));
        const row = rowOfSend(vi.mocked(sendMessageApi).mock.calls[0]);
        // Shown before the line it was written after: only a line that named it can be caught.
        dm.rows = [{ ...row, timestamp: '2026-09-30T00:00:00.000Z' }, first];
        await ringDoorbell();
        expect((await screen.findByTestId('dm-line-note')).textContent).toContain(OUT_OF_ORDER);
    });

    it('a DM\'s photo behind a line waits for it too, and is written after it', async () => {
        photoStubs();
        const { composer } = await openDm();
        let answerLine!: (v: unknown) => void;
        vi.mocked(sendMessageApi).mockReturnValueOnce(new Promise((r) => { answerLine = r; }) as never).mockResolvedValue({ success: true } as never);
        await typed(composer, 'A line first');
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(1));

        fireEvent.paste(composer, { clipboardData: clipboardWith(picture()) });
        const preview = await screen.findByTestId('chat-image-preview');
        await act(async () => { fireEvent.click(within(preview).getByRole('button', { name: 'Send' })); });
        await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
        expect(sendMessageApi).toHaveBeenCalledTimes(1);

        await act(async () => { answerLine({ success: true }); });
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(2));
        const [line, photo] = vi.mocked(sendMessageApi).mock.calls;
        expect(photo[4]).toBe('image');
        const ctx = dmKeyContext(dmConv as never, me)!;
        const opened = openDmLine({ ciphertext: photo[2], nonce: photo[3] }, ctx, { conversationId: ctx.conversationId, senderPubHex: ana.publicKey, messageId: photo[7]!, part: 'body', metadata: photo[6] });
        expect(opened.after).toBe(line[7]);
    });

    it('a photo behind a line waits for it, written after it, the composer resting meanwhile', async () => {
        photoStubs();
        const { composer } = await openGroup();
        let release!: () => void;
        holdGroupPost = new Promise((r) => { release = r; });
        await typed(composer, 'A line first');
        await waitFor(() => expect(node.lines).toHaveLength(2));
        holdGroupPost = null;

        fireEvent.paste(composer, { clipboardData: clipboardWith(picture()) });
        const preview = await screen.findByTestId('chat-image-preview');
        await act(async () => { fireEvent.click(within(preview).getByRole('button', { name: 'Send' })); });
        await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
        expect(node.lines).toHaveLength(2);
        expect(composer).toBeDisabled();

        await act(async () => { release(); });
        await waitFor(() => expect(node.lines).toHaveLength(3));
        const [, line, photo] = node.lines;
        const opened = openLine({ ciphertext: photo.ciphertext, nonce: photo.nonce }, { groupId: G, epoch: benSealed.epoch, messageId: photo.id, senderPubHex: ana.publicKey }, benSealed.key);
        expect(opened.after).toBe(line.id);
    });
});

describe('the echo of a line never draws it twice', () => {
    it('in a locked group, when the row arrives before the send has returned', async () => {
        const { composer } = await openGroup();
        let release!: () => void;
        holdGroupPost = new Promise((r) => { release = r; });
        await typed(composer, 'Seen once only');
        await waitFor(() => expect(node.lines).toHaveLength(2));

        // Stored, its reply still on the way: the socket's doorbell brings the row.
        await ringDoorbell();
        await waitFor(() => expect(screen.queryByTestId('chat-line-sending')).toBeNull());
        expect(screen.getAllByText('Seen once only')).toHaveLength(1);

        await act(async () => { release(); });
        await ringDoorbell();
        expect(screen.getAllByText('Seen once only')).toHaveLength(1);
        expect(screen.queryByTestId('chat-line-failed')).toBeNull();
    });

    it('in a locked group, after the send has returned', async () => {
        const { composer } = await openGroup();
        await typed(composer, 'Seen once again');
        await waitFor(() => expect(screen.queryByTestId('chat-line-pending')).toBeNull());
        await ringDoorbell();
        expect(screen.getAllByText('Seen once again')).toHaveLength(1);
    });

    it('in a DM, when the row arrives before the send has returned, and a lost answer then says nothing', async () => {
        const { composer } = await openDm();
        let fail!: (e: Error) => void;
        vi.mocked(sendMessageApi).mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }) as never);
        await typed(composer, 'Seen once in a DM');
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(1));
        dm.rows = [rowOfSend(vi.mocked(sendMessageApi).mock.calls[0])];
        await ringDoorbell();
        await act(async () => { fail(new TypeError('Failed to fetch')); });
        expect(screen.getAllByText('Seen once in a DM')).toHaveLength(1);
        expect(screen.queryByTestId('chat-line-failed')).toBeNull();
        expect(composer.value).toBe('');
    });
});

describe('the echo of a line, and an answer that can\'t be checked', () => {
    it('in a DM: its row came, the send then failed and the node can\'t be read: nothing is said, the row stands', async () => {
        const { composer } = await openDm();
        let fail!: (e: Error) => void;
        vi.mocked(sendMessageApi).mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }) as never);
        await typed(composer, 'Echoed then cut off');
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(1));
        const row = rowOfSend(vi.mocked(sendMessageApi).mock.calls[0]);
        dm.rows = [row];
        await ringDoorbell();
        expect(isPendingChatLine(row.id)).toBe(false);
        vi.mocked(getConversationMessages).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await act(async () => { fail(new TypeError('Failed to fetch')); });
        await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
        expect(window.alert).not.toHaveBeenCalled();
        expect(screen.getAllByText('Echoed then cut off')).toHaveLength(1);
    });
});

describe('a line on its way', () => {
    it('in an empty chat is the chat: "No messages yet" goes as it shows', async () => {
        const { composer } = await openDm();
        expect(screen.getByText('No messages yet. Say hello! 👋')).toBeTruthy();
        await typedNoAnswer(composer, 'Hello there');
        expect(screen.queryByText('No messages yet. Say hello! 👋')).toBeNull();
    });

    // Opus review of #2990, finding 2: this bubble is the accent colour with white words, as a sent one is, but had no
    // bp-bubble-mine, so a link in it kept the page's accent focus ring (accent on accent) and the darker selection.
    it('with a link in it: the link is drawn, and the bubble is the member\'s own (index.css draws that link\'s ring white there)', async () => {
        const { composer } = await openDm();
        await typedNoAnswer(composer, 'The roster is at https://byron.beanpool.org/roster');
        const bubble = (await screen.findByTestId('chat-line-pending')).querySelector('.bp-bubble-mine');
        expect(bubble, 'a bubble with the own-bubble class').not.toBeNull();
        const link = within(bubble as HTMLElement).getByTestId('chat-link');
        expect(link).toHaveAttribute('href', 'https://byron.beanpool.org/roster');
        expect(link.style.color).toBe('inherit');
    });

    it('as a reply quotes what it answers, and goes sealed to it, as a reply always did', async () => {
        const asked = sealedDm(ben, 'Are you free Saturday?');
        dm.rows = [asked];
        const { composer } = await openDm();
        fireEvent.click(screen.getByRole('button', { name: 'Reply to message' }));
        vi.mocked(sendMessageApi).mockResolvedValueOnce({ success: true } as never);
        await typed(composer, 'Saturday suits');
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(1));
        const pendingQuote = await screen.findByTestId('dm-quote');
        expect(pendingQuote.textContent).toContain('Are you free Saturday?');

        const call = vi.mocked(sendMessageApi).mock.calls[0];
        expect(JSON.parse(String(call[6])).replyToId).toBe(asked.id);
        dm.rows = [asked, rowOfSend(call)];
        await ringDoorbell();
        await waitFor(() => expect(screen.queryByTestId('chat-line-pending')).toBeNull());
        expect(screen.getByText('Saturday suits')).toBeTruthy();
        expect(screen.getByTestId('dm-quote').textContent).toContain('Are you free Saturday?');
        expect(screen.queryByTestId('dm-line-unattributed')).toBeNull();
    });

    it('is left out while searching the chat: a search finds what the chat holds', async () => {
        const { composer } = await openGroup();
        let release!: () => void;
        holdGroupPost = new Promise((r) => { release = r; });
        await typed(composer, 'Working late');
        await waitFor(() => expect(node.lines).toHaveLength(2));
        expect(screen.getByText('Working late')).toBeTruthy();
        fireEvent.click(screen.getByTestId('group-chat-search-toggle'));
        fireEvent.change(screen.getByTestId('group-chat-search'), { target: { value: 'Working' } });
        await screen.findByText('Working bee Saturday 9am');
        expect(screen.queryByText('Working late')).toBeNull();
        await act(async () => { release(); });
    });
});

describe('a line that couldn\'t go', () => {
    it('is plain in the thread and the composer stays free: Retry sends it under its own id, once', async () => {
        const { composer } = await openDm();
        vi.mocked(sendMessageApi).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await typed(composer, 'No answer to this one');

        const failed = await screen.findByTestId('chat-line-failed');
        expect(failed.textContent).toBe('! not delivered');
        expect(screen.getByText('No answer to this one')).toBeTruthy();
        // No second way to send it, under a new id: the node may have this line.
        expect(composer.value).toBe('');
        // Said out loud as any failure of this kind always was.
        expect(window.alert).toHaveBeenCalledWith('Failed to fetch');

        vi.mocked(sendMessageApi).mockResolvedValueOnce({ success: true } as never);
        await act(async () => { fireEvent.click(screen.getByTestId('chat-line-retry')); });
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(2));
        const [first, again] = vi.mocked(sendMessageApi).mock.calls;
        expect(again[7]).toBe(first[7]);
        dm.rows = [rowOfSend(again)];
        await ringDoorbell();
        await waitFor(() => expect(screen.queryByTestId('chat-line-pending')).toBeNull());
        expect(screen.getAllByText('No answer to this one')).toHaveLength(1);
        expect(isPendingChatLine(String(again[7]))).toBe(false);
    });

    it('whose answer was lost is delivered: the read that follows finds its row', async () => {
        const { composer } = await openDm();
        vi.mocked(sendMessageApi).mockImplementationOnce(async (...args: unknown[]) => {
            dm.rows = [rowOfSend(args)];   // stored; only the reply goes missing
            throw new TypeError('Failed to fetch');
        });
        await typed(composer, 'Stored, reply lost');
        await waitFor(() => expect(screen.queryByTestId('chat-line-pending')).toBeNull());
        expect(screen.getAllByText('Stored, reply lost')).toHaveLength(1);
        expect(screen.getByLabelText('Sent')).toBeTruthy();
        expect(screen.queryByTestId('chat-line-failed')).toBeNull();
        expect(window.alert).not.toHaveBeenCalled();
        expect(composer.value).toBe('');
    });

    it('a proxy\'s 502 leaves the node\'s store unknown: the words stay on the line, not in the composer', async () => {
        const { composer } = await openDm();
        vi.mocked(sendMessageApi).mockRejectedValueOnce(Object.assign(new Error('Bad Gateway'), { status: 502 }));
        await typed(composer, 'Behind a proxy');
        await screen.findByTestId('chat-line-failed');
        expect(composer.value).toBe('');
        expect(sendMessageApi).toHaveBeenCalledTimes(1);
    });

    it('a refusal is as it always was: the node\'s sentence in place, the words back in the composer', async () => {
        const { composer } = await openDm();
        vi.mocked(sendMessageApi).mockRejectedValueOnce(Object.assign(new Error('You can send 5 messages a day for now.'), { status: 429, code: 'probation_limit' }));
        await typed(composer, 'Over my limit');
        await screen.findByText('You can send 5 messages a day for now.');
        expect(composer.value).toBe('Over my limit');
        expect(screen.getByTestId('chat-line-failed')).toBeTruthy();
    });

    it('a DM that can\'t be locked sends nothing and says why, the words back in the composer', async () => {
        const noPeer = { ...dmConv, participants: [ana.publicKey] };
        vi.mocked(getConversationMessages).mockResolvedValue({ conversation: noPeer, messages: [] } as never);
        const { composer } = await openDm();
        await typed(composer, 'Nothing readable leaves');
        await screen.findByTestId('chat-line-failed');
        expect(sendMessageApi).not.toHaveBeenCalled();
        expect(composer.value).toBe('Nothing readable leaves');
        vi.mocked(getConversationMessages).mockImplementation((async () => ({ conversation: dmConv, messages: dm.rows })) as never);
    });

    it('in a group, a proxy\'s 502 leaves the node\'s store unknown too: the words stay on the line', async () => {
        const { composer } = await openGroup();
        node.lie = (_m, path) => (path.endsWith('/chat/message') ? new Response('{}', { status: 502 }) : undefined);
        await typed(composer, 'Behind a proxy too');
        await screen.findByTestId('chat-line-failed');
        expect(composer.value).toBe('');
    });

    it('in a group, a line stored behind a proxy\'s 502 is simply delivered: nothing was ever said about it', async () => {
        const { composer } = await openGroup();
        answerGroupPostWith = () => new Response('{}', { status: 502 });
        await typed(composer, 'Stored behind a proxy');
        await waitFor(() => expect(node.lines).toHaveLength(2));
        await waitFor(() => expect(screen.queryByTestId('chat-line-pending')).toBeNull());
        expect(screen.getAllByText('Stored behind a proxy')).toHaveLength(1);
        expect(screen.queryByTestId('chat-refusal')).toBeNull();
        expect(screen.queryByText('The node answered 502.')).toBeNull();
        expect(window.alert).not.toHaveBeenCalled();
        expect(composer.value).toBe('');
    });

    it('in a group, a 502 for a line the node doesn\'t have is reported once, and the line says it wasn\'t delivered', async () => {
        const { composer } = await openGroup();
        node.lie = (_m, path) => (path.endsWith('/chat/message') ? new Response('{}', { status: 502 }) : undefined);
        await typed(composer, 'Lost behind a proxy');
        await screen.findByTestId('chat-line-failed');
        expect(node.lines).toHaveLength(1);
        expect(screen.queryByTestId('chat-refusal')).toBeNull();
        expect(window.alert).toHaveBeenCalledTimes(1);
        expect(window.alert).toHaveBeenCalledWith('The node answered 502.');
    });

    it('a refusal in a group is as it always was: its sentence, the words back in the composer', async () => {
        const { composer } = await openGroup();
        vi.mocked(getGroupChat).mockResolvedValueOnce({ conversation: groupConv(), messages: groupRows(), canPost: false, encryption: { current: node.current(), stale: false, fromEpoch: 1 } } as never);
        await typed(composer, 'Refused in a group');
        await screen.findByTestId('chat-line-failed');
        expect(screen.getByTestId('chat-refusal').textContent).toContain('Observers can read this chat but not post in it');
        expect(composer.value).toBe('Refused in a group');
    });

    it('a refusal that comes after the member moved on is not said in the chat they moved to', async () => {
        const { composer } = await openGroup();
        let answer!: (v: unknown) => void;
        vi.mocked(getGroupChat).mockReturnValueOnce(new Promise((r) => { answer = r; }) as never);
        await typed(composer, 'Goes on without me');
        fireEvent.click(screen.getByRole('button', { name: 'Back to messages' }));
        fireEvent.click(await screen.findByText('Ben'));
        await composerOpen();
        await act(async () => {});
        await act(async () => { answer({ conversation: groupConv(), messages: groupRows(), canPost: false, encryption: { current: node.current(), stale: false, fromEpoch: 1 } }); });
        await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
        expect(screen.queryByTestId('chat-refusal')).toBeNull();
    });

    it('comes into view when it fails', async () => {
        const { composer } = await openDm();
        let fail!: (e: Error) => void;
        vi.mocked(sendMessageApi).mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }) as never);
        await typed(composer, 'Failing in view');
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(1));
        scrolls.count = 0;
        await act(async () => { fail(new TypeError('Failed to fetch')); });
        await screen.findByTestId('chat-line-failed');
        expect(scrolls.count).toBeGreaterThan(0);
    });

    it('can be discarded, its words gone from the thread and from the list row', async () => {
        const { composer } = await openDm();
        vi.mocked(sendMessageApi).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await typed(composer, 'Never mind');
        await screen.findByTestId('chat-line-failed');
        fireEvent.click(screen.getByTestId('chat-line-discard'));
        expect(screen.queryByText('Never mind')).toBeNull();
        expect(sendMessageApi).toHaveBeenCalledTimes(1);
    });

    it('is drawn in the danger chip\'s own pair, never its ink on the accent, with a Retry that is a real target', async () => {
        const { composer } = await openDm();
        vi.mocked(sendMessageApi).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await typed(composer, 'Plain at a glance');
        const failed = await screen.findByTestId('chat-line-failed');
        const bubble = failed.parentElement!.parentElement as HTMLElement;
        expect(bubble.style.background).toBe('var(--bp-chip-danger-tint)');
        expect(bubble.style.color).toBe('var(--bp-chip-danger-ink)');
        expect(failed.style.color).toBe('');
        const retry = screen.getByTestId('chat-line-retry');
        expect(retry.style.minHeight).toBe('44px');
        expect(retry.style.minWidth).toBe('44px');
        expect(retry.style.background).toBe('var(--bp-commit-fill)');
        expect(retry.style.color).toBe('var(--bp-commit-on)');
        expect(screen.getByTestId('chat-line-discard').style.minHeight).toBe('44px');
    });

    it('is the danger chip, not the member\'s own bubble: no own-bubble class, and a link in it takes the chip\'s ink', async () => {
        const { composer } = await openDm();
        vi.mocked(sendMessageApi).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await typed(composer, 'The roster is at https://byron.beanpool.org/roster');
        const failed = await screen.findByTestId('chat-line-failed');
        const line = failed.closest('[data-testid="chat-line-pending"]') as HTMLElement;
        expect(line.querySelector('.bp-bubble-mine')).toBeNull();
        expect(within(line).getByTestId('chat-link').style.color).toBe('var(--bp-chip-danger-ink)');
    });

    it('folds a long one under a …more in the failed line\'s own ink, never the accent on its tint', async () => {
        installFoldLayout();
        try {
            const { composer } = await openDm();
            vi.mocked(sendMessageApi).mockRejectedValueOnce(new TypeError('Failed to fetch'));
            await typed(composer, Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long note`).join('\n'));
            await screen.findByTestId('chat-line-failed');
            expect(screen.getByTestId('chat-fold-toggle').style.color).toBe('var(--bp-chip-danger-ink)');
        } finally {
            removeFoldLayout();
        }
    });

    it('while it goes says so in words a member can see, off the fill', async () => {
        const { composer } = await openDm();
        await typedNoAnswer(composer, 'On its way');
        const mark = screen.getByTestId('chat-line-sending');
        expect(mark.textContent).toContain('Sending…');
        expect(mark.style.color).toBe('var(--text-secondary)');
        expect(within(mark.parentElement!).queryByLabelText('Sent')).toBeNull();
    });
});

describe('a refused reply keeps what it answers', () => {
    const limit = () => Object.assign(new Error('You can send 5 messages a day for now.'), { status: 429, code: 'probation_limit' });
    const groupWithNoPosting = () => ({ conversation: groupConv(), messages: groupRows(), canPost: false, encryption: { current: node.current(), stale: false, fromEpoch: 1 } });
    const pressSend = async (composer: HTMLElement) => { await act(async () => { fireEvent.keyDown(composer, { key: 'Enter' }); }); };
    const replyTo = (words: string) => fireEvent.click(within(screen.getByText(words).closest('[id^="msg-"]') as HTMLElement).getByRole('button', { name: 'Reply to message' }));
    const metadataOf = (call: unknown[]) => (call[6] ? JSON.parse(String(call[6])) : {});

    it('in a DM: Send from the composer goes as the reply it was, sealed to what it answers, and the failed line goes', async () => {
        const asked = sealedDm(ben, 'Can you bring the ladder?');
        dm.rows = [asked];
        const { composer } = await openDm();
        replyTo('Can you bring the ladder?');
        vi.mocked(sendMessageApi).mockRejectedValueOnce(limit());
        await typed(composer, 'Yes');
        await screen.findByText('You can send 5 messages a day for now.');
        expect(composer.value).toBe('Yes');
        expect(screen.getByText('Replying to Ben')).toBeTruthy();

        vi.mocked(sendMessageApi).mockResolvedValueOnce({ success: true } as never);
        await pressSend(composer);
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(2));
        const [refused, again] = vi.mocked(sendMessageApi).mock.calls;
        expect(metadataOf(refused).replyToId).toBe(asked.id);
        expect(metadataOf(again).replyToId).toBe(asked.id);
        expect(metadataOf(again).lineSig).toBeTruthy();
        expect(screen.queryByText('Replying to Ben')).toBeNull();

        // The node's row for it opens, with the seal over that reply, and quotes the question.
        dm.rows = [asked, rowOfSend(again)];
        await ringDoorbell();
        await waitFor(() => expect(screen.queryByTestId('chat-line-pending')).toBeNull());
        expect(screen.getByTestId('dm-quote').textContent).toContain('Can you bring the ladder?');
        expect(screen.queryByTestId('dm-line-unattributed')).toBeNull();
    });

    it.each([
        ['the chat takes no new lines', () => { vi.mocked(getGroupChat).mockResolvedValueOnce(groupWithNoPosting() as never); }],
        ['the node refuses the sealed line', () => {
            node.lie = (_m, path) => {
                if (!path.endsWith('/chat/message')) return undefined;
                node.lie = null;
                return new Response('{}', { status: 403 });
            };
        }],
    ])('in a locked group: %s, and Send from the composer goes as the reply it was, sealed to it', async (_why, refuse) => {
        const { composer } = await openGroup();
        const asked = node.lines[0].id;
        replyTo('Working bee Saturday 9am');
        refuse();
        await typed(composer, 'I can do Saturday');
        await screen.findByTestId('chat-line-failed');
        await waitFor(() => expect(composer.value).toBe('I can do Saturday'));
        expect(screen.getByText('Replying to Ben')).toBeTruthy();

        await pressSend(composer);
        await waitFor(() => expect(node.lines).toHaveLength(2));
        const line = node.lines[1];
        expect(line.metadata.replyToId).toBe(asked);
        const opened = openLine({ ciphertext: line.ciphertext, nonce: line.nonce }, { groupId: G, epoch: benSealed.epoch, messageId: line.id, senderPubHex: ana.publicKey, replyToId: asked }, benSealed.key);
        expect(opened.text).toBe('I can do Saturday');
        expect(screen.queryByText('Replying to Ben')).toBeNull();
    });

    it('what it answers isn\'t loaded any more: the line keeps its words and its reply, and its Retry sends them whole', async () => {
        const asked = sealedDm(ben, 'Can you bring the ladder?');
        dm.rows = [asked];
        const { composer, unmount } = await openDm();
        replyTo('Can you bring the ladder?');
        vi.mocked(sendMessageApi).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await typed(composer, 'Yes');
        await screen.findByTestId('chat-line-failed');
        unmount();

        // Back later, and only the newest lines are read: the question isn't one of them.
        dm.rows = [];
        const back = await openDm();
        vi.mocked(sendMessageApi).mockRejectedValueOnce(limit());
        await act(async () => { fireEvent.click(screen.getByTestId('chat-line-retry')); });
        await screen.findByText('You can send 5 messages a day for now.');
        expect(back.composer.value).toBe('');
        expect(screen.getByTestId('chat-line-failed')).toBeTruthy();
        expect(screen.getByTestId('dm-quote').textContent).toContain('Message not found');

        // The same words typed by hand are a new line: they don't take the reply away from the one that holds it.
        vi.mocked(sendMessageApi).mockResolvedValueOnce({ success: true } as never);
        await typed(back.composer, 'Yes');
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(3));
        expect(metadataOf(vi.mocked(sendMessageApi).mock.calls[2]).replyToId).toBeUndefined();
        expect(screen.getByTestId('chat-line-failed')).toBeTruthy();

        vi.mocked(sendMessageApi).mockResolvedValueOnce({ success: true } as never);
        await act(async () => { fireEvent.click(screen.getByTestId('chat-line-retry')); });
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(4));
        expect(metadataOf(vi.mocked(sendMessageApi).mock.calls[3]).replyToId).toBe(asked.id);
    });

    it('words written since stay as they are: they don\'t become a reply, and the line keeps its own', async () => {
        const asked = sealedDm(ben, 'Can you bring the ladder?');
        dm.rows = [asked];
        const { composer } = await openDm();
        replyTo('Can you bring the ladder?');
        let refuse!: (e: Error) => void;
        vi.mocked(sendMessageApi).mockReturnValueOnce(new Promise((_, reject) => { refuse = reject; }) as never);
        await typed(composer, 'Yes');
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(1));
        fireEvent.change(composer, { target: { value: 'Something else entirely' } });
        await act(async () => { refuse(limit()); });
        await screen.findByTestId('chat-line-failed');
        expect(composer.value).toBe('Something else entirely');
        expect(screen.queryByText('Replying to Ben')).toBeNull();
        expect(screen.getByTestId('dm-quote').textContent).toContain('Can you bring the ladder?');
    });

    it('a reply started since stays as it is: the refused words don\'t land under it', async () => {
        const asked = sealedDm(ben, 'Can you bring the ladder?');
        const other = sealedDm(ben, 'And the barrow?', asked.id);
        dm.rows = [asked, other];
        const { composer } = await openDm();
        replyTo('Can you bring the ladder?');
        let refuse!: (e: Error) => void;
        vi.mocked(sendMessageApi).mockReturnValueOnce(new Promise((_, reject) => { refuse = reject; }) as never);
        await typed(composer, 'Yes');
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(1));
        replyTo('And the barrow?');
        await act(async () => { refuse(limit()); });
        await screen.findByTestId('chat-line-failed');
        expect(composer.value).toBe('');
        expect(screen.getByText('Replying to Ben').parentElement!.textContent).toContain('And the barrow?');
    });

    it('the line\'s own Retry takes the words and the reply back out of the composer, so the next line isn\'t a reply', async () => {
        const asked = sealedDm(ben, 'Can you bring the ladder?');
        dm.rows = [asked];
        const { composer } = await openDm();
        replyTo('Can you bring the ladder?');
        vi.mocked(sendMessageApi).mockRejectedValueOnce(limit());
        await typed(composer, 'Yes');
        await waitFor(() => expect(composer.value).toBe('Yes'));
        // Full ink on a failed line: at 0.85 the quote is 4.0:1 on the danger tint in light.
        const quotes = screen.getAllByTestId('dm-quote');
        expect(quotes[quotes.length - 1].style.opacity).toBe('1');
        vi.mocked(sendMessageApi).mockResolvedValueOnce({ success: true } as never);
        await act(async () => { fireEvent.click(screen.getByTestId('chat-line-retry')); });
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(2));
        expect(metadataOf(vi.mocked(sendMessageApi).mock.calls[1]).replyToId).toBe(asked.id);
        expect(composer.value).toBe('');
        expect(screen.queryByText('Replying to Ben')).toBeNull();
    });
});

describe('leaving the page', () => {
    it('a line that fails after the member left is still there when they come back, and they were told', async () => {
        const { composer, unmount } = await openDm();
        let fail!: (e: Error) => void;
        vi.mocked(sendMessageApi).mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }) as never);
        await typed(composer, 'Went to Market meanwhile');
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(1));
        unmount();

        await act(async () => { fail(new TypeError('Failed to fetch')); });
        await waitFor(() => expect(window.alert).toHaveBeenCalledTimes(1));
        expect(window.alert).toHaveBeenCalledWith('Message not delivered');

        await openDm();
        expect(await screen.findByTestId('chat-line-failed')).toBeTruthy();
        expect(screen.getByText('Went to Market meanwhile')).toBeTruthy();

        vi.mocked(sendMessageApi).mockResolvedValueOnce({ success: true } as never);
        await act(async () => { fireEvent.click(screen.getByTestId('chat-line-retry')); });
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(2));
        const [first, again] = vi.mocked(sendMessageApi).mock.calls;
        expect(again[7]).toBe(first[7]);
    });

    it('the list says which chat holds a line that didn\'t go', async () => {
        const failing = { id: crypto.randomUUID(), conversationId: DM, owner: ana.publicKey, text: 'From the other tab', replyToId: null };
        await act(async () => { sendChatLine(failing, async () => { throw new TypeError('Failed to fetch'); }); });
        render(<MessagesPage identity={me} />);
        expect(await screen.findByTestId('chat-row-not-delivered')).toBeTruthy();
    });

    it('a line the node takes after the member left is simply in the chat when they come back: one line, no mark', async () => {
        const { composer, unmount } = await openDm();
        let answer!: (v: unknown) => void;
        vi.mocked(sendMessageApi).mockReturnValueOnce(new Promise((r) => { answer = r; }) as never);
        await typed(composer, 'Taken while away');
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(1));
        unmount();
        await act(async () => { answer({ success: true }); });
        dm.rows = [rowOfSend(vi.mocked(sendMessageApi).mock.calls[0])];

        await openDm();
        await screen.findByText('Taken while away');
        expect(screen.getAllByText('Taken while away')).toHaveLength(1);
        expect(screen.queryByTestId('chat-line-pending')).toBeNull();
        expect(window.alert).not.toHaveBeenCalled();
    });

    it('nobody else\'s line shows here: a pending line belongs to the member who wrote it', async () => {
        const theirs = { id: crypto.randomUUID(), conversationId: DM, owner: ben.publicKey, text: 'Another account in this tab', replyToId: null };
        await act(async () => { sendChatLine(theirs, () => new Promise(() => {})); });
        await openDm();
        expect(screen.queryByText('Another account in this tab')).toBeNull();
    });
});

describe('a member reading further up', () => {
    it('is not pulled down by refreshes that bring no new line, with or without a pending line', async () => {
        dm.rows = [sealedDm(ben, 'Reading this')];
        const { composer } = await openDm();
        await ringDoorbell();
        scrolls.count = 0;
        await ringDoorbell();
        await ringDoorbell();
        await ringDoorbell();
        expect(scrolls.count).toBe(0);

        await typedNoAnswer(composer, 'Still going');
        expect(scrolls.count).toBeGreaterThan(0);
        scrolls.count = 0;
        await ringDoorbell();
        await ringDoorbell();
        expect(scrolls.count).toBe(0);
    });

    it('is brought down by a new line', async () => {
        dm.rows = [sealedDm(ben, 'Reading this')];
        await openDm();
        scrolls.count = 0;
        dm.rows = [...dm.rows, sealedDm(ben, 'Something new')];
        await ringDoorbell();
        await screen.findByText('Something new');
        expect(scrolls.count).toBeGreaterThan(0);
    });
});

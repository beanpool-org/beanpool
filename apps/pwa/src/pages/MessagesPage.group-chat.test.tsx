/**
 * A locked group chat in the web's Messages page (group chats slice 4): real group crypto, a node in memory behind the
 * page's own transport (group-chat-fake-node.test-support.ts). A line goes sealed and nothing readable leaves the page;
 * a member's line is named by the key that opened it; an unsealed row in a locked chat is nobody's, never mine; once the
 * page has seen the group locked, a node that says otherwise still gets nothing readable; search finds opened words.
 * Photos (DESIGN-group-chat-photos-fable.md §5 S4): a locked group's photo goes sealed with its caption as one line and
 * opens only after its words; an old node's group chat, an event's chat and an enterprise's take none, and say why.
 * The real node is driven by e2e/group-chat-check.mjs.
 */
import { render, screen, act, waitFor, fireEvent, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { sendMessageApi, editMessageApi, getEventChat, postEventChatMessage } from '../lib/api';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';
import { forgetGroupKeys, groupKeyring, memoryGroupLockStore } from '../lib/group-chat-keys';
import { sealLine, openLine } from '../lib/group-chat-crypto';
import { fakeGroupNode, person, type FakeGroupNode } from '../lib/group-chat-fake-node.test-support';
import { backToEnglish, showIn, xx } from '../words-xx.test-support';

if (typeof window !== 'undefined' && window.HTMLElement) window.HTMLElement.prototype.scrollIntoView = vi.fn();

vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false), blockUser: vi.fn(), unblockUser: vi.fn(), getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}),
}));
vi.mock('../lib/archetypes', () => ({ consumeChatPrefill: vi.fn(() => null) }));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));

const G = '5c1d2c3b-4a59-4e68-9d7c-8b9a0f1e2d3c';
const ana = person(true);
const ben = person();
let node: FakeGroupNode;
/** What the node's chat answer says about its lock: `locked` (encryption) or not (a node that now says unlocked). */
let chatLocked = true;
/** The type the node gives the conversation (a dishonest node retypes a group). */
let nodeType = 'group_thread';
/** Rows the node serves beside the sealed lines it stored. */
let extraRows: any[] = [];
/** Ben's callsign, as the directory and the group's roster give it. */
let benName = 'Ben';
/** The key Ben sealed his first line under, and that line's id. */
let benSealed: { epoch: number; key: Uint8Array; id: string };

const served = () => [
    ...node.lines.map((l, i) => ({
        id: l.id, conversationId: G, authorPubkey: l.author, ciphertext: l.ciphertext, nonce: l.nonce, type: l.type ?? 'text',
        metadata: JSON.stringify(l.metadata), timestamp: new Date(Date.UTC(2026, 9, 12, 9, i)).toISOString(), editedAt: null,
    })),
    ...extraRows,
];

vi.mock('../lib/api', () => ({
    getConversations: vi.fn(async () => ({ conversations: [conv()], totalUnread: 0 })),
    getConversationMessages: vi.fn(async () => ({ conversation: conv(), messages: [] })),
    getMembers: vi.fn(async () => [{ publicKey: ben.publicKey, callsign: benName }]),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(), getEventChat: vi.fn(), postEventChatMessage: vi.fn(), removeEventChatMessage: vi.fn(), sendMessageApi: vi.fn(), editMessageApi: vi.fn(),
    toggleMessageReactionApi: vi.fn(), getMessageAttachmentApi: vi.fn(), completeMarketplaceTransaction: vi.fn(), cancelMarketplaceTransaction: vi.fn(),
    getGroupChat: vi.fn(async () => ({
        conversation: conv(), messages: served(), canPost: true,
        ...(chatLocked ? { encryption: { current: node.current(), stale: false, fromEpoch: 1 } } : {}),
    })),
    getGroupMembers: vi.fn(async () => node.shown.map((pk) => ({ groupId: G, memberPubkey: pk, callsign: pk === ana.publicKey ? 'Ana' : benName, role: 'member', status: 'active', joinedAt: '' }))),
    groupKeysNet: {
        get: (p: string) => node.as(ana.publicKey).get(p),
        post: (p: string, b: unknown) => node.as(ana.publicKey).post(p, b),
    },
}));

function conv() {
    return { id: G, type: nodeType, name: 'Garden crew', participants: [ana.publicKey, ben.publicKey], createdBy: ana.publicKey, createdAt: '2026-10-01T00:00:00Z', unreadCount: 0 };
}

const me: BeanPoolIdentity = { publicKey: ana.publicKey, privateKey: ana.privateKey, callsign: 'Ana', createdAt: '2026-10-01T00:00:00Z' };

beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetGroupChatLockStoreForTest();
    forgetGroupKeys();
    node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
    chatLocked = true;
    nodeType = 'group_thread';
    extraRows = [];
    benName = 'Ben';
    // Ben opened the chat first: epoch 1 for both of them, and one line of his.
    const { epoch, key } = await groupKeyring(node.as(ben.publicKey), ben, G, memoryGroupLockStore()).prepareToSeal();
    const id = crypto.randomUUID();
    const sealed = sealLine('Working bee Saturday 9am', { myEdPrivHex: ben.privateKey, groupKey: key, groupId: G, epoch, messageId: id });
    node.lines.push({ id, author: ben.publicKey, ciphertext: sealed.ciphertext, nonce: sealed.nonce, metadata: { epoch, sender: ben.publicKey } });
    benSealed = { epoch, key, id };
    forgetGroupKeys();
});
const canvasGetContext = HTMLCanvasElement.prototype.getContext;
const canvasToDataURL = HTMLCanvasElement.prototype.toDataURL;
const WindowImage = (window as any).Image;
const createObjectURL = (URL as any).createObjectURL;
const revokeObjectURL = (URL as any).revokeObjectURL;
afterEach(() => {
    cleanup();
    backToEnglish();
    vi.unstubAllGlobals();
    HTMLCanvasElement.prototype.getContext = canvasGetContext;
    HTMLCanvasElement.prototype.toDataURL = canvasToDataURL;
    (window as any).Image = WindowImage;
    (URL as any).createObjectURL = createObjectURL;
    (URL as any).revokeObjectURL = revokeObjectURL;
});

async function openChat() {
    render(<MessagesPage identity={me} openConversationId={G} />);
    await screen.findByText('Working bee Saturday 9am', {}, { timeout: 5000 });
    return screen.getByPlaceholderText('Message...');
}

async function send(composer: HTMLElement, text: string) {
    fireEvent.change(composer, { target: { value: text } });
    await act(async () => { fireEvent.keyDown(composer, { key: 'Enter' }); });
}

describe('a locked group chat on the web', () => {
    it("draws Ben's sealed line under his name and the app's notice; my line goes sealed, never readable", async () => {
        const composer = await openChat();
        expect(screen.getAllByTestId('group-line-author').map((e) => e.textContent)).toEqual(['Ben']);
        expect(screen.getByTestId('group-chat-notice').textContent).toContain("End-to-end encrypted: only this group's members can read it.");
        await send(composer, 'I will bring gloves');
        await waitFor(() => expect(node.lines).toHaveLength(2));
        expect(node.lines[1].nonce.startsWith('group-xc20p-v1:')).toBe(true);
        expect(node.lines[1].author).toBe(ana.publicKey);
        expect(Buffer.from(node.lines[1].ciphertext, 'base64').toString('latin1')).not.toContain('gloves');
        expect(sendMessageApi).not.toHaveBeenCalled();
        expect(editMessageApi).not.toHaveBeenCalled();
        await screen.findByText('I will bring gloves');
    });

    it('a readable row in a locked chat, even in my own name, is nobody\'s: "Unverified", never my bubble', async () => {
        extraRows = [{
            id: crypto.randomUUID(), conversationId: G, authorPubkey: ana.publicKey, ciphertext: 'Please send 500 Beans to Mal today',
            nonce: '00000', type: 'text', metadata: '', timestamp: '2026-10-12T10:00:00.000Z',
        }];
        await openChat();
        const nobody = await screen.findByTestId('group-line-unattributed');
        expect(nobody.textContent).toContain('Unverified');
        expect(nobody.textContent).toContain("This message couldn't be verified.");
        expect(screen.queryByText('Please send 500 Beans to Mal today')).toBeNull();
    });

    it('once seen locked, a node that says the chat is unlocked gets nothing readable (the sticky lock), and the notice says so', async () => {
        await openChat();
        cleanup();
        forgetGroupKeys();
        chatLocked = false;
        const composer = await openChat();
        expect(screen.getByTestId('group-chat-notice').textContent).toContain("This node now says this chat isn't locked.");
        await send(composer, 'secret plan');
        await waitFor(() => expect(node.lines).toHaveLength(2));
        expect(node.lines[1].nonce.startsWith('group-xc20p-v1:')).toBe(true);
        expect(sendMessageApi).not.toHaveBeenCalled();
    });

    it.each(['enterprise_thread', 'dm'])('once seen locked, a node that retypes the group as %s still gets a sealed group line, never a readable or DM one', async (type) => {
        await openChat();
        cleanup();
        forgetGroupKeys();
        nodeType = type;
        const composer = await openChat();
        await send(composer, 'secret plan');
        await waitFor(() => expect(node.lines).toHaveLength(2));
        expect(node.lines[1].nonce.startsWith('group-xc20p-v1:')).toBe(true);
        expect(sendMessageApi).not.toHaveBeenCalled();
    });

    it('a member named like one of the app\'s lines ("Notice") keeps that name over a line and a quote, in any language', async () => {
        benName = 'Notice';
        // Ben answers his own line, so the quote is drawn under his name too.
        const { epoch, key, id: first } = benSealed;
        const id = crypto.randomUUID();
        const sealed = sealLine('Bring a spade', { myEdPrivHex: ben.privateKey, groupKey: key, groupId: G, epoch, messageId: id, replyToId: first });
        node.lines.push({ id, author: ben.publicKey, ciphertext: sealed.ciphertext, nonce: sealed.nonce, metadata: { epoch, sender: ben.publicKey, replyToId: first } });
        await showIn('xx');
        render(<MessagesPage identity={me} openConversationId={G} />);
        await screen.findByText('Bring a spade', {}, { timeout: 5000 });
        expect(screen.getAllByTestId('group-line-author').map((e) => e.textContent)).toEqual(['Notice', 'Notice']);
        expect(screen.getByTestId('dm-quote').firstElementChild?.textContent).toBe('Notice');
    });

    it('searches the loaded thread by its opened words', async () => {
        await openChat();
        fireEvent.click(screen.getByTestId('group-chat-search-toggle'));
        fireEvent.change(screen.getByTestId('group-chat-search'), { target: { value: 'BEE' } });
        expect(screen.getByText('Working bee Saturday 9am')).toBeTruthy();
        fireEvent.change(screen.getByTestId('group-chat-search'), { target: { value: 'gloves' } });
        expect(screen.queryByText('Working bee Saturday 9am')).toBeNull();
        expect(screen.getByTestId('group-chat-search-none')).toBeTruthy();
    });
});

/** The JPEG the stubbed canvas hands back, as a data URI. */
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
const OTHER = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAgAA';
const NOT_HERE = "Photos can't be sent in this chat: the community's server can read it.";
const OLD_NODE = "This community's node is older and can read this group's chat. It will be locked once the node is updated.";

/**
 * jsdom can't decode a picture: an Image that loads at once at 1600 × 1200 and a canvas that hands back PHOTO, noting
 * the size it was drawn at and the quality asked for (put back after each test).
 */
function photoStubs() {
    const drawn: { width: number; height: number; type: string; quality: unknown }[] = [];
    class FakeImage { width = 1600; height = 1200; onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(_v: string) { setTimeout(() => this.onload?.(), 0); } }
    vi.stubGlobal('Image', FakeImage);
    (window as any).Image = FakeImage;
    (URL as any).createObjectURL = () => 'blob:preview';
    (URL as any).revokeObjectURL = () => {};
    HTMLCanvasElement.prototype.getContext = (() => ({ drawImage() {} })) as any;
    HTMLCanvasElement.prototype.toDataURL = function (this: HTMLCanvasElement, type?: string, quality?: unknown) {
        drawn.push({ width: this.width, height: this.height, type: String(type), quality });
        return PHOTO;
    } as any;
    return drawn;
}

const picture = () => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'gate.jpg', { type: 'image/jpeg' });
/** A clipboard carrying a picture, as Chrome and Firefox present one. */
const clipboardWith = (file: File) => ({ files: [file], items: [{ kind: 'file', type: file.type, getAsFile: () => file }], types: ['Files'] });

/** A photo line Ben sealed: its caption as part body, its photo as part attachment, under one message key. */
function benPhotoLine(caption: string, photo: string, opts: { epoch?: number; key?: Uint8Array } = {}) {
    const epoch = opts.epoch ?? benSealed.epoch;
    const key = opts.key ?? benSealed.key;
    const id = crypto.randomUUID();
    const bind = { myEdPrivHex: ben.privateKey, groupKey: key, groupId: G, epoch, messageId: id };
    const body = sealLine(caption, bind);
    const att = sealLine(photo, { ...bind, part: 'attachment' });
    node.lines.push({
        id, author: ben.publicKey, ciphertext: body.ciphertext, nonce: body.nonce, type: 'image', metadata: { epoch, sender: ben.publicKey },
        attachment: { data: att.ciphertext, nonce: att.nonce, mime: 'image/jpeg' },
    });
    return id;
}

const drawnPhotos = () => [...document.querySelectorAll('img')].map((i) => i.getAttribute('src')).filter((src) => !!src?.startsWith('data:image/'));
const photoFetches = () => node.calls.filter((c) => /^\/api\/messages\/[^/]+\/attachment$/.test(c.path));

describe('photos in a locked group chat on the web (DESIGN-group-chat-photos-fable.md §5 S4)', () => {
    it('a paste opens the preview; Send seals the 800 px photo and its caption as one line, each part bound to it; nothing readable, nothing DM-sealed', async () => {
        const drawn = photoStubs();
        const composer = await openChat();
        await act(async () => {});
        fireEvent.change(composer, { target: { value: 'The gate is fixed' } });
        fireEvent.paste(composer, { clipboardData: clipboardWith(picture()) });
        const preview = await screen.findByTestId('chat-image-preview');
        expect(screen.queryByTestId('chat-image-notice')).toBeNull();
        await act(async () => { fireEvent.click(within(preview).getByRole('button', { name: 'Send' })); });
        await waitFor(() => expect(node.lines).toHaveLength(2));

        const line = node.lines[1];
        expect(line).toMatchObject({ author: ana.publicKey, type: 'image', metadata: { epoch: benSealed.epoch } });
        expect(line.nonce.startsWith('group-xc20p-v1:')).toBe(true);
        expect(line.attachment?.nonce.startsWith('group-xc20p-v1:')).toBe(true);
        expect(drawn).toEqual([{ width: 800, height: 600, type: 'image/jpeg', quality: 0.7 }]);
        const bind = { groupId: G, epoch: benSealed.epoch, senderPubHex: ana.publicKey, messageId: line.id, replyToId: null };
        const photo = { ciphertext: line.attachment?.data ?? '', nonce: line.attachment?.nonce ?? '' };
        expect(openLine({ ciphertext: line.ciphertext, nonce: line.nonce }, { ...bind, part: 'body' }, benSealed.key).text).toBe('The gate is fixed');
        expect(openLine(photo, { ...bind, part: 'attachment' }, benSealed.key).text).toBe(PHOTO);
        expect(() => openLine(photo, { ...bind, part: 'body' }, benSealed.key)).toThrow();
        expect(sendMessageApi).not.toHaveBeenCalled();

        // The page reads the chat again: my photo in my bubble, its caption under it, and no Edit on a photo line.
        await waitFor(() => expect(drawnPhotos()).toEqual([PHOTO]));
        expect(screen.queryByTestId('chat-image-preview')).toBeNull();
        const bubble = document.getElementById(`msg-${line.id}`)!;
        expect(within(bubble).getByText('The gate is fixed')).toBeTruthy();
        expect(within(bubble).queryByRole('button', { name: 'Edit message' })).toBeNull();
    });

    it("a member's photo shows in their bubble with its caption; a reply to it quotes it as 🔒 Photo, in the chat and in the reply banner", async () => {
        const photoId = benPhotoLine('Gate before', PHOTO);
        const reply = crypto.randomUUID();
        const sealed = sealLine('Looks great', { myEdPrivHex: ben.privateKey, groupKey: benSealed.key, groupId: G, epoch: benSealed.epoch, messageId: reply, replyToId: photoId });
        node.lines.push({ id: reply, author: ben.publicKey, ciphertext: sealed.ciphertext, nonce: sealed.nonce, metadata: { epoch: benSealed.epoch, sender: ben.publicKey, replyToId: photoId } });
        await openChat();
        await waitFor(() => expect(drawnPhotos()).toEqual([PHOTO]));
        const bubble = document.getElementById(`msg-${photoId}`)!;
        expect(within(bubble).getByText('Gate before')).toBeTruthy();
        expect(within(bubble).getByTestId('group-line-author').textContent).toBe('Ben');
        expect(screen.getByTestId('dm-quote').textContent).toBe('Ben🔒 Photo');
        fireEvent.click(within(bubble).getByRole('button', { name: 'Reply to message' }));
        expect(screen.getByText('Replying to Ben').parentElement?.textContent).toContain('🔒 Photo');
    });

    it('a photo the node swapped for another line\'s reads "Image unavailable", never the other picture', async () => {
        const first = benPhotoLine('Before', PHOTO);
        benPhotoLine('After', OTHER);
        node.lines.find((l) => l.id === first)!.attachment = node.lines[2].attachment;
        await openChat();
        await waitFor(() => expect(within(document.getElementById(`msg-${first}`)!).getByText('🔒 Image unavailable')).toBeTruthy());
        expect(drawnPhotos()).toEqual([OTHER]);
    });

    it("a photo line whose key isn't in this browser draws no picture and asks the node for none", async () => {
        // Ben makes epoch 2 while Ana is off the roster for a moment: it has no wrap for her.
        node.roster = [ben.publicKey];
        node.stale = true;
        const { epoch, key } = await groupKeyring(node.as(ben.publicKey), ben, G, memoryGroupLockStore()).prepareToSeal();
        node.roster = [ana.publicKey, ben.publicKey].sort();
        forgetGroupKeys();
        expect(epoch).toBe(2);
        const id = benPhotoLine('Secret gate', PHOTO, { epoch, key });
        await openChat();
        const waiting = await screen.findByText('Waiting for the key to this message.');
        expect(waiting.closest('[data-testid="group-line-unattributed"]')?.id).toBe(`msg-${id}`);
        await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
        expect(drawnPhotos()).toEqual([]);
        expect(screen.queryByText('Secret gate')).toBeNull();
        expect(photoFetches()).toEqual([]);
    });

    it.each(['enterprise_thread', 'dm'])('once seen locked, a node that retypes the group as %s: a photo by 📎 goes as the group\'s sealed line, never by the DM route', async (type) => {
        await openChat();
        cleanup();
        forgetGroupKeys();
        nodeType = type;
        await openChat();
        photoStubs();
        const input = document.querySelector('input[type="file"]') as HTMLInputElement;
        expect(input).toBeTruthy();
        await act(async () => { fireEvent.change(input, { target: { files: [picture()] } }); });
        await waitFor(() => expect(node.lines).toHaveLength(2));
        expect(node.lines[1]).toMatchObject({ author: ana.publicKey, type: 'image', metadata: { epoch: benSealed.epoch } });
        expect(node.lines[1].attachment?.nonce.startsWith('group-xc20p-v1:')).toBe(true);
        expect(sendMessageApi).not.toHaveBeenCalled();
    });

    it("an old node's group chat, never locked here: a paste says the node is older, there is no 📎, and nothing goes", async () => {
        chatLocked = false;
        render(<MessagesPage identity={me} openConversationId={G} />);
        const composer = await screen.findByPlaceholderText('Message...');
        await waitFor(() => expect(screen.getByTestId('group-chat-notice').textContent).toContain(OLD_NODE));
        photoStubs();
        fireEvent.paste(composer, { clipboardData: clipboardWith(picture()) });
        expect((await screen.findByTestId('chat-image-notice')).textContent).toContain(OLD_NODE);
        expect(screen.queryByTestId('chat-image-preview')).toBeNull();
        expect(document.querySelector('input[type="file"]')).toBeNull();
        expect(node.lines).toHaveLength(1);
        expect(sendMessageApi).not.toHaveBeenCalled();
    });

    it("an event's chat takes no photo, and says plainly why: the community's server can read it", async () => {
        nodeType = 'event_thread';
        vi.mocked(getEventChat).mockResolvedValue({
            conversation: { id: G, type: 'event_thread', name: 'Working bee', participants: [], createdBy: '', createdAt: '2026-10-01T00:00:00Z' },
            messages: [], readOnly: false, readOnlyReason: null, canPost: true, isHost: false, title: 'Working bee', eventEndAt: null,
            eventState: 'upcoming', privateNote: null, notice: 'Everyone going can read this chat, and so can the community.',
        } as any);
        render(<MessagesPage identity={me} openConversationId={G} />);
        const composer = await screen.findByLabelText('Message everyone going', {}, { timeout: 5000 });
        fireEvent.paste(composer, { clipboardData: clipboardWith(picture()) });
        expect((await screen.findByTestId('event-chat-image-notice')).textContent).toContain(NOT_HERE);
        expect(postEventChatMessage).not.toHaveBeenCalled();
    });

    it("an enterprise's chat takes no photo either, says the same, in the member's language", async () => {
        nodeType = 'enterprise_thread';
        render(<MessagesPage identity={me} openConversationId={G} />);
        let composer = await screen.findByPlaceholderText('Message...');
        await act(async () => {});
        fireEvent.paste(composer, { clipboardData: clipboardWith(picture()) });
        expect((await screen.findByTestId('chat-image-notice')).textContent).toContain(NOT_HERE);
        expect(screen.queryByTestId('chat-image-preview')).toBeNull();
        expect(document.querySelector('input[type="file"]')).toBeNull();
        expect(sendMessageApi).not.toHaveBeenCalled();

        cleanup();
        await showIn('xx');
        render(<MessagesPage identity={me} openConversationId={G} />);
        composer = await screen.findByPlaceholderText(xx('Message...'));
        await act(async () => {});
        fireEvent.paste(composer, { clipboardData: clipboardWith(picture()) });
        expect((await screen.findByTestId('chat-image-notice')).textContent).toContain(xx(NOT_HERE));
    });
});

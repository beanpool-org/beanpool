/**
 * Old chat's photos and listing cards, on the web (conversion code, log row OLDCHAT, remove after 12 Dec 2026: this whole
 * file; Marty, 13 Nov 2026: "if they are there why not view them?"). A DM line from before 1.4.0 is shown read-only (#3075);
 * its photo now opens and shows as a new line's does, and its listing card shows, each opened as part of the line's words
 * (core openDmOldPhoto, chatAboutOfOldLine). Real crypto, no crypto mocks: the lines and photos are the frozen ones the
 * 1.2.36 apps and the format-3 card sealer wrote (core dm-line-vectors.ts DM_OLD_LINES), served by a stand-in node.
 */
import { render, screen, act, waitFor, cleanup, within, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { toEd25519Pkcs8 } from '@beanpool/core';
import { DM_OLD_LINES, DM_OLD_LINE_TIMES, DM_VECTOR_CONVERSATION as CONV, DM_VECTOR_PEOPLE as P } from '@beanpool/core/dm-line-vectors';
import { MessagesPage } from './MessagesPage';
import { forgetAboutListings } from '../components/ChatAbout';
import type { BeanPoolIdentity } from '../lib/identity';
import { getMessageAttachmentApi, type ApiMessage } from '../lib/api';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';
import { forgetGroupKeys } from '../lib/group-chat-keys';

window.HTMLElement.prototype.scrollIntoView = (() => {}) as never;

vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}), socketIsAlive: vi.fn(() => true) }));
vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false), blockUser: vi.fn(), unblockUser: vi.fn(), getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}),
}));
vi.mock('../lib/archetypes', () => ({ consumeChatPrefill: vi.fn(() => null) }));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));

const node = vi.hoisted(() => ({
    conversation: null as any,
    rows: [] as any[],
    /** Each line's photo as the node stores it ({ data, nonce }), by message id; none = the file is gone. */
    photos: new Map<string, { data: string; nonce: string; mime: string }>(),
    listings: [] as any[],
}));
vi.mock('../lib/api', () => ({
    getConversations: vi.fn(async () => ({ conversations: [node.conversation], totalUnread: 0 })),
    getConversationMessages: vi.fn(async () => ({ conversation: node.conversation, messages: node.rows })),
    getMarketplacePosts: vi.fn(async (f?: { id?: string }) => node.listings.filter((p) => p.id === f?.id)),
    getGroupChat: vi.fn(), getGroupMembers: vi.fn(async () => []), groupKeysNet: { get: vi.fn(), post: vi.fn() },
    getMembers: vi.fn(async () => []),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(), getEventChat: vi.fn(), postEventChatMessage: vi.fn(), removeEventChatMessage: vi.fn(), sendMessageApi: vi.fn(), editMessageApi: vi.fn(),
    toggleMessageReactionApi: vi.fn(),
    // As the node answers GET /api/messages/:id/attachment (routes/marketplace.ts): the stored photo, or 404 when there is none.
    getMessageAttachmentApi: vi.fn(async (id: string) => {
        const p = node.photos.get(id);
        if (!p) throw Object.assign(new Error('Attachment not found'), { status: 404 });
        return p;
    }),
    completeMarketplaceTransaction: vi.fn(), cancelMarketplaceTransaction: vi.fn(),
}));

const L = DM_OLD_LINES;
const BEFORE = DM_OLD_LINE_TIMES.before;
const AFTER = DM_OLD_LINE_TIMES.after;
const OLD_LINES_LABEL = 'Older messages from before 12 November 2026. They were sent before BeanPool signed every message.';
const LOCKED = '🔒 Image unavailable';

/** Ana and Ben as the web keeps a key (PKCS8); Cat, a stranger to their chat. */
const as = (who: { publicKey: string; pkcs8Hex: string }, callsign: string): BeanPoolIdentity =>
    ({ publicKey: who.publicKey, privateKey: who.pkcs8Hex, callsign, createdAt: '2026-09-01T00:00:00Z' });
const catSeed = sha256(utf8ToBytes('beanpool old-chat test: Cat'));
const cat = { publicKey: bytesToHex(ed25519.getPublicKey(catSeed)), pkcs8Hex: bytesToHex(toEd25519Pkcs8(catSeed)) };

type Fixture = (typeof L)[keyof typeof L];
/** A line as the node stores it: a frozen fixture's words, in its author's name, at the node's time. */
const rowOf = (f: Fixture, o: { type?: string; timestamp?: string; metadata?: string | null } = {}): ApiMessage => ({
    id: f.messageId, conversationId: CONV, authorPubkey: P[f.from].publicKey, ciphertext: f.payload.ciphertext, nonce: f.payload.nonce,
    type: (o.type ?? 'text') as ApiMessage['type'], timestamp: o.timestamp ?? BEFORE, ...(o.metadata ?? f.metadata ? { metadata: (o.metadata ?? f.metadata)! } : {}),
});
const photoOf = (f: Fixture) => ({ data: f.payload.ciphertext, nonce: f.payload.nonce, mime: 'image/jpeg' });

function chatWith(participants: string[]) {
    node.conversation = {
        id: CONV, type: 'dm', name: null, participants, createdBy: participants[0], peerCallsign: 'Them', unreadCount: 0, createdAt: '2026-09-01T00:00:00Z',
    };
}

async function openAs(identity: BeanPoolIdentity): Promise<void> {
    render(<MessagesPage identity={identity} openConversationId={CONV} onNavigate={vi.fn()} />);
    await screen.findByPlaceholderText('Message...');
    await act(async () => {});
}
const bubbleOf = (text: string) => screen.getByText(text).closest('[id^="msg-"]') as HTMLElement;
const shownPhotos = () => Array.from(document.querySelectorAll('img')).filter((i) => i.getAttribute('alt') === 'Photo message');

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetGroupChatLockStoreForTest();
    forgetGroupKeys();
    forgetAboutListings();
    chatWith([P.ana.publicKey, P.ben.publicKey]);
    node.rows = [];
    node.photos = new Map();
    node.listings = [];
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('old chat: an old line\'s photo opens and shows as a new line\'s does', () => {
    it('a frozen 1.2.36 photo (format 3) opens in Ana\'s bubble for Ben, under the label, its caption under it; a tap shows it whole', async () => {
        node.rows = [rowOf(L.anaFormat3, { type: 'image' })];
        node.photos.set(L.anaFormat3.messageId, photoOf(L.anaPhotoFormat3));
        await openAs(as(P.ben, 'Ben'));
        await waitFor(() => expect(shownPhotos()).toHaveLength(1));
        expect(shownPhotos()[0].getAttribute('src')).toBe(L.anaPhotoFormat3.text);
        expect(screen.queryByText(LOCKED)).toBeNull();
        // In her bubble (the other person's: left), with the caption, under the one label.
        const bubble = bubbleOf(L.anaFormat3.text);
        expect(within(bubble).getByRole('img', { name: 'Photo message' })).toBeTruthy();
        expect(bubble.style.alignSelf).toBe('flex-start');
        expect(screen.getAllByTestId('dm-old-lines-label').map((l) => l.textContent)).toEqual([OLD_LINES_LABEL]);
        // Still read-only: no Reply (so no quote), React, Edit or Delete.
        for (const name of ['Reply to message', 'React to message', 'Edit message', 'Delete message']) {
            expect(within(bubble).queryByRole('button', { name })).toBeNull();
        }
        // Tap to see it whole, as a new line's photo.
        fireEvent.click(within(bubble).getByRole('button', { name: 'View photo full screen' }));
        const viewer = await screen.findByTestId('chat-photo-viewer');
        expect(within(viewer).getByRole('img', { name: 'Full-size photo' }).getAttribute('src')).toBe(L.anaPhotoFormat3.text);
    });

    it('the sender sees their own old photo too, and a format-2 photo (an app before 2 October 2026) opens for Ana', async () => {
        node.rows = [rowOf(L.benFormat2, { type: 'image', timestamp: '2026-09-20T10:00:00.000Z' }), rowOf(L.anaFormat3, { type: 'image' })];
        node.photos.set(L.benFormat2.messageId, photoOf(L.benPhotoFormat2));
        node.photos.set(L.anaFormat3.messageId, photoOf(L.anaPhotoFormat3));
        await openAs(as(P.ana, 'Ana'));
        await waitFor(() => expect(shownPhotos()).toHaveLength(2));
        expect(shownPhotos().map((i) => i.getAttribute('src')).sort()).toEqual([L.anaPhotoFormat3.text, L.benPhotoFormat2.text].sort());
        expect(bubbleOf(L.anaFormat3.text).style.alignSelf).toBe('flex-end');
        expect(screen.getAllByTestId('dm-old-lines-label')).toHaveLength(1);
    });
});

describe('old chat: a photo that can\'t be shown keeps today\'s locked bubble, never a broken image', () => {
    it('its file is gone on the node (404): locked, the caption still reads', async () => {
        node.rows = [rowOf(L.anaFormat3, { type: 'image' })];
        await openAs(as(P.ben, 'Ben'));
        await waitFor(() => expect(within(bubbleOf(L.anaFormat3.text)).getByText(LOCKED)).toBeTruthy());
        expect(shownPhotos()).toHaveLength(0);
        expect(vi.mocked(getMessageAttachmentApi)).toHaveBeenCalledWith(L.anaFormat3.messageId);
    });

    it('what the node serves isn\'t this line\'s photo: another format\'s, or words that are no picture', async () => {
        // Under format-3 words, a format-2 photo (Ben's) is refused; under Ben's format-2 words, his format-2 words are no picture.
        node.rows = [rowOf(L.benFormat2, { type: 'image', timestamp: '2026-09-20T10:00:00.000Z' }), rowOf(L.anaFormat3, { type: 'image' })];
        node.photos.set(L.anaFormat3.messageId, photoOf(L.benPhotoFormat2));
        node.photos.set(L.benFormat2.messageId, photoOf(L.benNotPhotoFormat2));
        await openAs(as(P.ana, 'Ana'));
        await waitFor(() => expect(screen.getAllByText(LOCKED)).toHaveLength(2));
        expect(shownPhotos()).toHaveLength(0);
        expect(document.body.textContent).not.toContain(L.benNotPhotoFormat2.text);
        // Both lines' words still show, old and read-only.
        expect(screen.getByText(L.benFormat2.text)).toBeTruthy();
        expect(screen.getByText(L.anaFormat3.text)).toBeTruthy();
    });

    it('a stranger\'s key opens nothing: Cat, shown Ana\'s old photo line in a chat with her, sees neither words nor photo', async () => {
        chatWith([cat.publicKey, P.ana.publicKey]);
        node.rows = [rowOf(L.anaFormat3, { type: 'image' })];
        node.photos.set(L.anaFormat3.messageId, photoOf(L.anaPhotoFormat3));
        await openAs(as(cat, 'Cat'));
        await waitFor(() => expect(screen.getAllByTestId('dm-line-unattributed')).toHaveLength(1));
        expect(shownPhotos()).toHaveLength(0);
        expect(document.body.textContent).not.toContain(L.anaFormat3.text);
        expect(document.body.innerHTML).not.toContain(L.anaPhotoFormat3.text);
        expect(screen.queryByTestId('dm-old-lines-label')).toBeNull();
    });

    it('an old-format photo line dated from the cutover on stays hidden, and its photo with it', async () => {
        node.rows = [rowOf(L.anaFormat3, { type: 'image', timestamp: AFTER })];
        node.photos.set(L.anaFormat3.messageId, photoOf(L.anaPhotoFormat3));
        await openAs(as(P.ben, 'Ben'));
        await waitFor(() => expect(screen.getAllByTestId('dm-line-unattributed')).toHaveLength(1));
        expect(shownPhotos()).toHaveLength(0);
        expect(document.body.innerHTML).not.toContain(L.anaPhotoFormat3.text);
    });
});

describe('old chat: an old line\'s listing card shows', () => {
    const withCard = (f: Fixture) => JSON.stringify({ ...(f.metadata ? JSON.parse(f.metadata) : {}), about: L.anaAboutFormat3.payload });

    it('a format-3 card (sealed 9 to 10 November) shows at the top of Ana\'s old bubble, with the listing\'s own title', async () => {
        node.listings = [{ id: 'old-eggs-1', type: 'offer', title: 'Fresh eggs, a dozen', price_c: 600, priceType: 'fixed', status: 'active' }];
        node.rows = [rowOf(L.anaFormat3, { metadata: withCard(L.anaFormat3) })];
        await openAs(as(P.ben, 'Ben'));
        const card = await within(bubbleOf(L.anaFormat3.text)).findByTestId('chat-about-card');
        await waitFor(() => expect(card.textContent).toContain('Fresh eggs, a dozen'));
        expect(card.textContent).toContain('6 Beans');
    });

    it('a listing that is gone shows the existing "no longer up" line', async () => {
        node.rows = [rowOf(L.anaFormat3, { metadata: withCard(L.anaFormat3) })];
        await openAs(as(P.ana, 'Ana'));
        const gone = await within(bubbleOf(L.anaFormat3.text)).findByTestId('chat-about-gone');
        expect(gone.textContent).toBe('This listing is no longer up.');
    });

    it('no card where the words decide against it: under another message, on a format-2 line, after the cutover', async () => {
        node.listings = [{ id: 'old-eggs-1', type: 'offer', title: 'Fresh eggs', price_c: 600, priceType: 'fixed', status: 'active' }];
        node.rows = [
            rowOf(L.benFormat2, { timestamp: '2026-09-20T10:00:00.000Z', metadata: withCard(L.benFormat2) }),
            rowOf(L.benFormat3Reply, { timestamp: '2026-11-05T09:01:00.000Z', metadata: withCard(L.benFormat3Reply) }),
        ];
        await openAs(as(P.ana, 'Ana'));
        await waitFor(() => expect(screen.getByText(L.benFormat3Reply.text)).toBeTruthy());
        expect(screen.getByText(L.benFormat2.text)).toBeTruthy();
        expect(screen.queryByTestId('chat-about-card')).toBeNull();
        expect(screen.queryByTestId('chat-about-gone')).toBeNull();
        cleanup();
        node.rows = [rowOf(L.anaFormat3, { timestamp: AFTER, metadata: withCard(L.anaFormat3) })];
        await openAs(as(P.ben, 'Ben'));
        await waitFor(() => expect(screen.getAllByTestId('dm-line-unattributed')).toHaveLength(1));
        expect(screen.queryByTestId('chat-about-card')).toBeNull();
    });
});

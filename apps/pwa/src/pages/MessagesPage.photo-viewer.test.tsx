import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import type { Conversation, ApiMessage } from '../lib/api';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';
import { forgetGroupKeys, groupKeyring, memoryGroupLockStore } from '../lib/group-chat-keys';
import { sealLine } from '../lib/group-chat-crypto';
import { fakeGroupNode, person, type FakeGroupNode } from '../lib/group-chat-fake-node.test-support';
import { lockForDm } from '../lib/dm-lock';

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
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));

const DM_CONV = 'c0ffee00-1111-4222-8333-444455556666';
const G = '5c1d2c3b-4a59-4e68-9d7c-8b9a0f1e2d3c';

const ana = person(true);
const ben = person();
const identity: BeanPoolIdentity = {
    publicKey: ana.publicKey,
    privateKey: ana.privateKey,
    callsign: 'Ana',
    createdAt: '2026-09-01T00:00:00Z',
};

const dmChat = { id: DM_CONV, type: 'dm', participants: [ana.publicKey, ben.publicKey] };
const dmConversation: Conversation = {
    id: DM_CONV,
    type: 'dm',
    name: null,
    participants: [ana.publicKey, ben.publicKey],
    createdBy: ana.publicKey,
    peerCallsign: 'Ben',
    unreadCount: 0,
    createdAt: '2026-09-01T00:00:00Z',
} as Conversation;

const groupConversation: Conversation = {
    id: G,
    type: 'group_thread',
    name: 'Working Bee',
    participants: [ana.publicKey, ben.publicKey],
    createdBy: ben.publicKey,
    unreadCount: 0,
    createdAt: '2026-09-01T00:00:00Z',
} as Conversation;

let node: FakeGroupNode;
let benSealed: { epoch: number; key: Uint8Array; id: string };
let dmMessages: ApiMessage[] = [];
const dmAttachments = new Map<string, { data: string; nonce: string; mime: string }>();

const DM_PHOTO_URI = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAPdmPhoto';
const GROUP_PHOTO_URI = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAPgroupPhoto';

vi.mock('../lib/api', () => ({
    getConversations: vi.fn(async () => ({
        conversations: [dmConversation, groupConversation],
        totalUnread: 0,
    })),
    getConversationMessages: vi.fn(async (id: string) => {
        if (id === DM_CONV) return { conversation: dmConversation, messages: dmMessages };
        return { conversation: null, messages: [] };
    }),
    getGroupChat: vi.fn(async (id: string) => {
        if (id === G) {
            return {
                conversation: groupConversation,
                messages: node.lines.map((l, i) => ({
                    id: l.id,
                    conversationId: G,
                    authorPubkey: l.author,
                    ciphertext: l.ciphertext,
                    nonce: l.nonce,
                    type: l.type ?? 'text',
                    metadata: JSON.stringify(l.metadata),
                    timestamp: new Date(Date.UTC(2026, 9, 12, 9, i)).toISOString(),
                    editedAt: null,
                })),
                canPost: true,
                encryption: { current: node.current(), stale: false, fromEpoch: 1 },
            };
        }
        return { conversation: null, messages: [], canPost: false };
    }),
    getGroupMembers: vi.fn(async () => node.shown.map((pk) => ({
        groupId: G,
        memberPubkey: pk,
        callsign: pk === ana.publicKey ? 'Ana' : 'Ben',
        role: 'member',
        status: 'active',
        joinedAt: '',
    }))),
    getMembers: vi.fn(async () => [
        { publicKey: ana.publicKey, callsign: 'Ana' },
        { publicKey: ben.publicKey, callsign: 'Ben' },
    ]),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(),
    getEventChat: vi.fn(),
    postEventChatMessage: vi.fn(),
    removeEventChatMessage: vi.fn(),
    sendMessageApi: vi.fn(),
    editMessageApi: vi.fn(),
    toggleMessageReactionApi: vi.fn(),
    getMessageAttachmentApi: vi.fn(async (messageId: string) => {
        const att = dmAttachments.get(messageId);
        if (!att) throw new Error('Attachment not found');
        return att;
    }),
    completeMarketplaceTransaction: vi.fn(),
    cancelMarketplaceTransaction: vi.fn(),
    groupKeysNet: {
        get: (p: string) => node.as(ana.publicKey).get(p),
        post: (p: string, b: unknown) => node.as(ana.publicKey).post(p, b),
    },
}));

function dmPhoto(from: typeof ana, photoUri: string, caption = ''): ApiMessage {
    const id = crypto.randomUUID();
    const body = lockForDm(caption, dmChat, from, { messageId: id });
    const att = lockForDm(photoUri, dmChat, from, { messageId: id, part: 'attachment' });
    dmAttachments.set(id, { data: att.ciphertext, nonce: att.nonce, mime: 'image/jpeg' });
    return {
        id,
        conversationId: DM_CONV,
        authorPubkey: from.publicKey,
        ciphertext: body.ciphertext,
        nonce: body.nonce,
        type: 'image',
        timestamp: new Date().toISOString(),
    } as ApiMessage;
}

function benPhotoLine(caption: string, photo: string) {
    const epoch = benSealed.epoch;
    const key = benSealed.key;
    const id = crypto.randomUUID();
    const bind = { myEdPrivHex: ben.privateKey, groupKey: key, groupId: G, epoch, messageId: id };
    const body = sealLine(caption, bind);
    const att = sealLine(photo, { ...bind, part: 'attachment' });
    node.lines.push({
        id,
        author: ben.publicKey,
        ciphertext: body.ciphertext,
        nonce: body.nonce,
        type: 'image',
        metadata: { epoch, sender: ben.publicKey },
        attachment: { data: att.ciphertext, nonce: att.nonce, mime: 'image/jpeg' },
    });
    return id;
}

describe('chat photo viewer parity (gap 4)', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        vi.stubGlobal('indexedDB', memoryIndexedDB());
        resetGroupChatLockStoreForTest();
        forgetGroupKeys();
        dmMessages = [];
        dmAttachments.clear();

        node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
        const { epoch, key } = await groupKeyring(node.as(ben.publicKey), ben, G, memoryGroupLockStore()).prepareToSeal();
        const id = crypto.randomUUID();
        const sealed = sealLine('Initial group line', { myEdPrivHex: ben.privateKey, groupKey: key, groupId: G, epoch, messageId: id });
        node.lines.push({ id, author: ben.publicKey, ciphertext: sealed.ciphertext, nonce: sealed.nonce, metadata: { epoch, sender: ben.publicKey } });
        benSealed = { epoch, key, id };
        forgetGroupKeys();
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it('DM photo: renders as button with phone accessible name, opens viewer with same src, Escape/backdrop close and focus returns', async () => {
        const msg = dmPhoto(ben, DM_PHOTO_URI, 'A photo from Ben');
        dmMessages = [msg];

        render(<MessagesPage identity={identity} openConversationId={DM_CONV} />);

        // The photo is a button with the phone's accessible name
        const photoButton = await screen.findByRole('button', { name: 'View photo full screen' });
        expect(photoButton).toBeInTheDocument();
        const inlineImg = within(photoButton).getByRole('img');
        expect(inlineImg).toHaveAttribute('src', DM_PHOTO_URI);

        // Click photo button to open full screen viewer
        fireEvent.click(photoButton);

        const dialog = await screen.findByRole('dialog');
        expect(dialog).toBeInTheDocument();

        // The viewer displays the photo with the same src
        const fullImg = within(dialog).getByRole('img', { name: 'Full-size photo' });
        expect(fullImg).toHaveAttribute('src', DM_PHOTO_URI);

        // Escape closes the viewer and returns focus to the photo button
        fireEvent.keyDown(window, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(document.activeElement).toBe(photoButton);

        // Reopen viewer and close via backdrop click
        fireEvent.click(photoButton);
        await screen.findByRole('dialog');

        const backdrop = screen.getByRole('button', { name: 'Dismiss full-size photo' });
        expect(backdrop).toHaveAttribute('tabindex', '-1');
        fireEvent.click(backdrop);
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(document.activeElement).toBe(photoButton);

        // Reopen viewer and close via clicking the full-size photo
        fireEvent.click(photoButton);
        await screen.findByRole('dialog');
        const photoInViewer = screen.getByRole('img', { name: 'Full-size photo' });
        fireEvent.click(photoInViewer);
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(document.activeElement).toBe(photoButton);
    });

    it('Group photo: renders as button with phone accessible name, opens viewer with same src, Escape closes and focus returns', async () => {
        benPhotoLine('Group garden bed', GROUP_PHOTO_URI);

        render(<MessagesPage identity={identity} openConversationId={G} />);

        // The photo is a button with the phone's accessible name
        const photoButton = await screen.findByRole('button', { name: 'View photo full screen' });
        expect(photoButton).toBeInTheDocument();
        const inlineImg = within(photoButton).getByRole('img');
        expect(inlineImg).toHaveAttribute('src', GROUP_PHOTO_URI);

        // Click photo button to open full screen viewer
        fireEvent.click(photoButton);

        const dialog = await screen.findByRole('dialog');
        expect(dialog).toBeInTheDocument();

        const fullImg = within(dialog).getByRole('img', { name: 'Full-size photo' });
        expect(fullImg).toHaveAttribute('src', GROUP_PHOTO_URI);

        // Escape closes the viewer and returns focus
        fireEvent.keyDown(window, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(document.activeElement).toBe(photoButton);
    });

    it('an unavailable photo has no button (group and DM)', async () => {
        // DM unavailable photo: attachment data corrupt / not decryptable
        const dmId = crypto.randomUUID();
        const body = lockForDm('Corrupt DM photo', dmChat, ben, { messageId: dmId });
        dmAttachments.set(dmId, { data: 'not-valid-encrypted-data', nonce: 'bad-nonce', mime: 'image/jpeg' });
        dmMessages = [{
            id: dmId,
            conversationId: DM_CONV,
            authorPubkey: ben.publicKey,
            ciphertext: body.ciphertext,
            nonce: body.nonce,
            type: 'image',
            timestamp: new Date().toISOString(),
        } as ApiMessage];

        render(<MessagesPage identity={identity} openConversationId={DM_CONV} />);

        expect(await screen.findByText('🔒 Image unavailable')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'View photo full screen' })).toBeNull();

        cleanup();

        // Group unavailable photo: swapped/corrupted attachment
        const grpId = crypto.randomUUID();
        const bind = { myEdPrivHex: ben.privateKey, groupKey: benSealed.key, groupId: G, epoch: benSealed.epoch, messageId: grpId };
        const grpBody = sealLine('Corrupt group photo', bind);
        node.lines.push({
            id: grpId,
            author: ben.publicKey,
            ciphertext: grpBody.ciphertext,
            nonce: grpBody.nonce,
            type: 'image',
            metadata: { epoch: benSealed.epoch, sender: ben.publicKey },
            attachment: { data: 'bad-data', nonce: 'bad-nonce', mime: 'image/jpeg' },
        });

        render(<MessagesPage identity={identity} openConversationId={G} />);

        expect(await screen.findByText('🔒 Image unavailable')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'View photo full screen' })).toBeNull();
    });
});

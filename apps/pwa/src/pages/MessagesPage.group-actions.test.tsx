/**
 * Web group chats: Delete, Remove and Mute, as on the phone (parity-group-lines).
 *
 * Tests:
 * 1. Author sees Delete on own line incl. a photo line and not on others'.
 * 2. Convenor sees Remove on others' lines and Delete on own lines; a plain member sees neither on others'.
 * 3. Confirming Delete calls deleteMessageApi (/api/messages/delete { messageId }) and the line then reads "This message was deleted".
 * 4. Confirming Remove calls removeGroupChatMessage (/api/groups/:id/chat/remove { messageId }) and the line then reads "Removed by a convenor".
 * 5. Mute menu's four choices call /api/messages/mute and the header shows muted ("· muted").
 * 6. A photo line's report sheet has the photo wording.
 */
import { render, screen, act, waitFor, fireEvent, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';
import { forgetGroupKeys, groupKeyring, memoryGroupLockStore } from '../lib/group-chat-keys';
import { sealLine } from '../lib/group-chat-crypto';
import { fakeGroupNode, person, type FakeGroupNode } from '../lib/group-chat-fake-node.test-support';
import * as api from '../lib/api';

if (typeof window !== 'undefined' && window.HTMLElement) window.HTMLElement.prototype.scrollIntoView = vi.fn();

vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false), blockUser: vi.fn(), unblockUser: vi.fn(), getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}),
}));
vi.mock('../lib/archetypes', () => ({ consumeChatPrefill: vi.fn(() => null) }));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: (url: string) => url }));

const G = '5c1d2c3b-4a59-4e68-9d7c-8b9a0f1e2d3c';
const ana = person(true);
const ben = person();
let node: FakeGroupNode;
let benSealed: { epoch: number; key: Uint8Array; id: string };
let isAnaConvenor = true;
let currentMute: any = null;

const served = () => node.lines.map((l, i) => ({
    id: l.id,
    conversationId: G,
    authorPubkey: l.author,
    ciphertext: l.ciphertext,
    nonce: l.nonce,
    type: l.type ?? 'text',
    metadata: JSON.stringify(l.metadata),
    timestamp: new Date(Date.UTC(2026, 9, 25, 9, i)).toISOString(),
    editedAt: null,
}));

vi.mock('../lib/api', () => ({
    getConversations: vi.fn(async () => ({ conversations: [conv()], totalUnread: 0 })),
    getConversationMessages: vi.fn(async () => ({ conversation: conv(), messages: [] })),
    getMembers: vi.fn(async () => [{ publicKey: ben.publicKey, callsign: 'Ben' }]),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(),
    getEventChat: vi.fn(),
    postEventChatMessage: vi.fn(),
    removeEventChatMessage: vi.fn(),
    sendMessageApi: vi.fn(),
    editMessageApi: vi.fn(),
    deleteMessageApi: vi.fn(async (messageId: string) => {
        const line = node.lines.find(l => l.id === messageId);
        if (line) {
            line.type = 'removed';
            line.metadata = { ...(line.metadata || {}), removed: true, removedBy: line.author };
        }
        return { success: true };
    }),
    removeGroupChatMessage: vi.fn(async (_groupId: string, messageId: string) => {
        const line = node.lines.find(l => l.id === messageId);
        if (line) {
            line.type = 'removed';
            line.metadata = { ...(line.metadata || {}), removed: true, removedBy: ana.publicKey };
        }
        return { success: true };
    }),
    muteChatApi: vi.fn(async (conversationId: string, duration: string) => {
        currentMute = duration === 'off' ? null : { conversationId, mutedUntil: null, always: duration === 'always' };
        return {
            success: true,
            mute: currentMute,
        };
    }),
    toggleMessageReactionApi: vi.fn(),
    getMessageAttachmentApi: vi.fn(),
    completeMarketplaceTransaction: vi.fn(),
    cancelMarketplaceTransaction: vi.fn(),
    getGroupChat: vi.fn(async () => ({
        conversation: conv(),
        messages: served(),
        canPost: true,
        isConvenor: isAnaConvenor,
        mute: currentMute,
        encryption: { current: node.current(), stale: false, fromEpoch: 1 },
    })),
    getGroupMembers: vi.fn(async () => node.shown.map((pk) => ({
        groupId: G,
        memberPubkey: pk,
        callsign: pk === ana.publicKey ? 'Ana' : 'Ben',
        role: pk === ana.publicKey && isAnaConvenor ? 'convenor' : 'member',
        status: 'active',
        joinedAt: '',
    }))),
    groupKeysNet: {
        get: (p: string) => node.as(ana.publicKey).get(p),
        post: (p: string, b: unknown) => node.as(ana.publicKey).post(p, b),
    },
}));

function conv() {
    return {
        id: G,
        type: 'group_thread',
        name: 'Garden crew',
        participants: [ana.publicKey, ben.publicKey],
        createdBy: isAnaConvenor ? ana.publicKey : ben.publicKey,
        createdAt: '2026-10-01T00:00:00Z',
        unreadCount: 0,
    };
}

const me: BeanPoolIdentity = {
    publicKey: ana.publicKey,
    privateKey: ana.privateKey,
    callsign: 'Ana',
    createdAt: '2026-10-01T00:00:00Z',
};

function addPhotoLine(author: typeof ana | typeof ben, caption: string, photo: string) {
    const epoch = benSealed.epoch;
    const key = benSealed.key;
    const id = crypto.randomUUID();
    const bind = { myEdPrivHex: author.privateKey, groupKey: key, groupId: G, epoch, messageId: id };
    const body = sealLine(caption, bind);
    const att = sealLine(photo, { ...bind, part: 'attachment' });
    node.lines.push({
        id,
        author: author.publicKey,
        ciphertext: body.ciphertext,
        nonce: body.nonce,
        type: 'image',
        metadata: { epoch, sender: author.publicKey },
        attachment: { data: att.ciphertext, nonce: att.nonce, mime: 'image/jpeg' },
    });
    return id;
}

beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetGroupChatLockStoreForTest();
    forgetGroupKeys();
    node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
    isAnaConvenor = true;
    currentMute = null;

    const { epoch, key } = await groupKeyring(node.as(ben.publicKey), ben, G, memoryGroupLockStore()).prepareToSeal();
    const benMsgId = crypto.randomUUID();
    const sealedBen = sealLine('Ben speaks', { myEdPrivHex: ben.privateKey, groupKey: key, groupId: G, epoch, messageId: benMsgId });
    node.lines.push({ id: benMsgId, author: ben.publicKey, ciphertext: sealedBen.ciphertext, nonce: sealedBen.nonce, metadata: { epoch, sender: ben.publicKey } });
    benSealed = { epoch, key, id: benMsgId };

    const anaMsgId = crypto.randomUUID();
    const sealedAna = sealLine('Ana speaks', { myEdPrivHex: ana.privateKey, groupKey: key, groupId: G, epoch, messageId: anaMsgId });
    node.lines.push({ id: anaMsgId, author: ana.publicKey, ciphertext: sealedAna.ciphertext, nonce: sealedAna.nonce, metadata: { epoch, sender: ana.publicKey } });

    forgetGroupKeys();
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

async function openChat() {
    render(<MessagesPage identity={me} openConversationId={G} />);
    await screen.findByText('Ben speaks', {}, { timeout: 5000 });
    await screen.findByText('Ana speaks');
}

describe('Web group chats: Delete, Remove, Mute, photo report wording', () => {
    it("author sees Delete on own line incl. a photo line and not on others'", async () => {
        const anaPhotoId = addPhotoLine(ana, 'Ana photo caption', 'data:image/jpeg;base64,aaa');
        const benPhotoId = addPhotoLine(ben, 'Ben photo caption', 'data:image/jpeg;base64,bbb');

        await openChat();
        await screen.findByText('Ana photo caption');
        await screen.findByText('Ben photo caption');

        // Ana's own text message bubble
        const anaTextBubble = screen.getByText('Ana speaks').closest('[id^="msg-"]') as HTMLElement;
        expect(within(anaTextBubble).getByRole('button', { name: 'Delete message' })).toBeInTheDocument();

        // Ana's own photo line
        const anaPhotoBubble = document.getElementById(`msg-${anaPhotoId}`) as HTMLElement;
        expect(within(anaPhotoBubble).getByRole('button', { name: 'Delete message' })).toBeInTheDocument();

        // Ben's text message bubble
        const benTextBubble = screen.getByText('Ben speaks').closest('[id^="msg-"]') as HTMLElement;
        expect(within(benTextBubble).queryByRole('button', { name: 'Delete message' })).toBeNull();

        // Ben's photo line
        const benPhotoBubble = document.getElementById(`msg-${benPhotoId}`) as HTMLElement;
        expect(within(benPhotoBubble).queryByRole('button', { name: 'Delete message' })).toBeNull();
    });

    it("convenor sees Remove on others' lines and plain member sees neither on others'", async () => {
        isAnaConvenor = true;
        await openChat();

        // Convenor Ana sees Remove on Ben's line
        const benBubble = screen.getByText('Ben speaks').closest('[id^="msg-"]') as HTMLElement;
        expect(within(benBubble).getByRole('button', { name: 'Remove message' })).toBeInTheDocument();

        // Convenor Ana does NOT see Remove on her own line (she sees Delete)
        const anaBubble = screen.getByText('Ana speaks').closest('[id^="msg-"]') as HTMLElement;
        expect(within(anaBubble).queryByRole('button', { name: 'Remove message' })).toBeNull();
        expect(within(anaBubble).getByRole('button', { name: 'Delete message' })).toBeInTheDocument();

        cleanup();

        // Now test as plain member
        isAnaConvenor = false;
        await openChat();

        const benBubblePlain = screen.getByText('Ben speaks').closest('[id^="msg-"]') as HTMLElement;
        expect(within(benBubblePlain).queryByRole('button', { name: 'Remove message' })).toBeNull();
        expect(within(benBubblePlain).queryByRole('button', { name: 'Delete message' })).toBeNull();
    });

    it('confirming Delete calls deleteMessageApi with messageId and updates the line to tombstone', async () => {
        await openChat();

        const anaBubble = screen.getByText('Ana speaks').closest('[id^="msg-"]') as HTMLElement;
        const delBtn = within(anaBubble).getByRole('button', { name: 'Delete message' });
        await act(async () => { fireEvent.click(delBtn); });

        // Confirm dialog appears
        const dialog = screen.getByRole('dialog');
        expect(within(dialog).getByText('Delete for everyone?')).toBeInTheDocument();
        expect(within(dialog).getByText('It will read "This message was deleted" to everyone in the chat.')).toBeInTheDocument();

        // Cancel closes dialog without calling API
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(api.deleteMessageApi).not.toHaveBeenCalled();

        // Click Delete again and confirm
        await act(async () => { fireEvent.click(delBtn); });
        const dialog2 = screen.getByRole('dialog');
        await act(async () => {
            fireEvent.click(within(dialog2).getByRole('button', { name: 'Delete' }));
        });

        const anaMsg = node.lines.find(l => l.author === ana.publicKey)!;
        expect(api.deleteMessageApi).toHaveBeenCalledWith(anaMsg.id);
        await screen.findByText('This message was deleted');
    });

    it('confirming Remove calls removeGroupChatMessage with messageId and updates the line to tombstone', async () => {
        isAnaConvenor = true;
        await openChat();

        const benBubble = screen.getByText('Ben speaks').closest('[id^="msg-"]') as HTMLElement;
        const remBtn = within(benBubble).getByRole('button', { name: 'Remove message' });
        await act(async () => { fireEvent.click(remBtn); });

        // Confirm dialog appears
        const dialog = screen.getByRole('dialog');
        expect(within(dialog).getByText('Remove this message?')).toBeInTheDocument();
        expect(within(dialog).getByText('It will read "Removed by a convenor" to everyone in the chat.')).toBeInTheDocument();

        // Keep it closes dialog without calling API
        fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }));
        expect(api.removeGroupChatMessage).not.toHaveBeenCalled();

        // Click Remove again and confirm
        await act(async () => { fireEvent.click(remBtn); });
        const dialog2 = screen.getByRole('dialog');
        await act(async () => {
            fireEvent.click(within(dialog2).getByRole('button', { name: 'Remove' }));
        });

        const benMsg = node.lines.find(l => l.author === ben.publicKey)!;
        expect(api.removeGroupChatMessage).toHaveBeenCalledWith(G, benMsg.id);
        await screen.findByText('Removed by a convenor');
    });

    it("Mute menu's four choices call /api/messages/mute and the header shows muted", async () => {
        await openChat();

        // Header shows 2 members initially
        expect(screen.getByText('2 members')).toBeInTheDocument();

        // Open chat menu
        const menuBtn = screen.getByRole('button', { name: 'Chat menu' });
        await act(async () => { fireEvent.click(menuBtn); });

        // Click Mute notifications
        const muteMenuRow = screen.getByRole('button', { name: 'Mute notifications' });
        await act(async () => { fireEvent.click(muteMenuRow); });

        // Duration choice 1: For 8 hours
        const eightHoursBtn = screen.getByRole('button', { name: 'For 8 hours' });
        await act(async () => { fireEvent.click(eightHoursBtn); });
        expect(api.muteChatApi).toHaveBeenCalledWith(G, '8h');

        // Header shows muted
        await waitFor(() => expect(screen.getByText('2 members · muted')).toBeInTheDocument());

        // Choice 4: Unmute (off) when already muted
        await act(async () => { fireEvent.click(menuBtn); });
        const unmuteBtn = screen.getByRole('button', { name: 'Unmute' });
        await act(async () => { fireEvent.click(unmuteBtn); });
        expect(api.muteChatApi).toHaveBeenCalledWith(G, 'off');
        await waitFor(() => expect(screen.getByText('2 members')).toBeInTheDocument());

        // Choice 2: For a week
        await act(async () => { fireEvent.click(menuBtn); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mute notifications' })); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'For a week' })); });
        expect(api.muteChatApi).toHaveBeenCalledWith(G, '1w');

        // Unmute again
        await act(async () => { fireEvent.click(menuBtn); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Unmute' })); });

        // Choice 3: Always
        await act(async () => { fireEvent.click(menuBtn); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mute notifications' })); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Always' })); });
        expect(api.muteChatApi).toHaveBeenCalledWith(G, 'always');
    });

    it("a photo line's report sheet has the photo wording", async () => {
        const benPhotoId = addPhotoLine(ben, 'A picture to report', 'data:image/jpeg;base64,1234');
        await openChat();
        await screen.findByText('A picture to report');

        const benPhotoBubble = document.getElementById(`msg-${benPhotoId}`) as HTMLElement;
        const reportBtn = within(benPhotoBubble).getByRole('button', { name: 'Report message' });
        await act(async () => { fireEvent.click(reportBtn); });

        const card = screen.getByRole('dialog');
        expect(within(card).getByText('Report this message')).toBeInTheDocument();
        expect(within(card).getByTestId('report-note').textContent).toBe(
            "This community's moderators will see this one message, its photo and who sent it. Nothing else in this chat is shared with them."
        );
    });
});

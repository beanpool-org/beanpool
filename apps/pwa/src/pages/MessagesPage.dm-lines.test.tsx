import { render, screen, act, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { toEd25519Pkcs8 } from '@beanpool/core';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import type { Conversation, ApiMessage } from '../lib/api';
import { lockForDm } from '../lib/dm-lock';

// What the node operator can do to a direct message, as the web app's chat shows it (crypto review M F2, 2026-10-02).
// Real encryption, no crypto mocks: every line here is sealed by this app's own lib/dm-lock.ts, as MessagesPage sends
// one, and the node (a stand-in for lib/api) hands the thread back after doing to it what its operator could.

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
    getMembers: vi.fn(async () => []),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(),
    getEventChat: vi.fn(),
    postEventChatMessage: vi.fn(),
    removeEventChatMessage: vi.fn(),
    sendMessageApi: vi.fn(),
    editMessageApi: vi.fn(),
    toggleMessageReactionApi: vi.fn(),
    getMessageAttachmentApi: vi.fn(),
    completeMarketplaceTransaction: vi.fn(),
    cancelMarketplaceTransaction: vi.fn(),
}));

function person(name: string) {
    const seed = ed25519.utils.randomSecretKey();
    // The browser keeps its key as PKCS8 (lib/mnemonic.ts).
    return { name, seed, publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(toEd25519Pkcs8(seed)) };
}
const ana = person('Ana');   // the member at this browser
const ben = person('Ben');
const CONV = 'c0ffee00-1111-4222-8333-444455556666';
const chat = { id: CONV, type: 'dm', participants: [ana.publicKey, ben.publicKey] };
const NOT_VERIFIED = "🔒 This message couldn't be verified, so it isn't shown.";
const OUT_OF_ORDER = 'Shown out of the order it was written in.';
const OLD_APP = "Sent from an older version of the app: who sent it can't be confirmed.";

let minute = 0;
const uuid = () => crypto.randomUUID();
/** A line as this app sends it (lib/dm-lock.ts lockForDm, MessagesPage's handleSend), stored by the node. */
function sent(from: typeof ana, text: string, after: string | null = null): ApiMessage {
    const id = uuid();
    const sealed = lockForDm(text, chat, from, { messageId: id, after });
    return { id, conversationId: CONV, authorPubkey: from.publicKey, ...sealed, timestamp: new Date(Date.UTC(2026, 9, 1, 9, minute++)).toISOString() } as ApiMessage;
}
/** A line an app from before this change wrote: the conversation id was all it was bound to (built from the primitives). */
function oldLine(from: typeof ana, to: typeof ana, text: string): ApiMessage {
    const shared = x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(from.seed), ed25519.utils.toMontgomery(hexToBytes(to.publicKey)));
    const key = hkdf(sha256, shared, utf8ToBytes(CONV), utf8ToBytes('beanpool-dm-v2'), 32);
    const nonce = randomBytes(24);
    const ct = xchacha20poly1305(key, nonce, utf8ToBytes(CONV)).encrypt(utf8ToBytes(text));
    return {
        id: uuid(), conversationId: CONV, authorPubkey: from.publicKey, ciphertext: Buffer.from(ct).toString('base64'),
        nonce: 'x25519-xc20p-v2:' + Buffer.from(nonce).toString('base64'), timestamp: new Date(Date.UTC(2026, 9, 1, 9, minute++)).toISOString(),
    } as ApiMessage;
}

const identity: BeanPoolIdentity = { publicKey: ana.publicKey, privateKey: ana.privateKey, callsign: 'Ana', createdAt: '2026-09-01T00:00:00Z' };

async function openChat(): Promise<void> {
    render(<MessagesPage identity={identity} openConversationId={CONV} />);
    await screen.findByPlaceholderText('Message...');
    await act(async () => {});
}

beforeEach(() => {
    minute = 0;
    thread.conversation = {
        id: CONV, type: 'dm', name: null, participants: [ana.publicKey, ben.publicKey], createdBy: ana.publicKey,
        peerCallsign: 'Ben', unreadCount: 0, createdAt: '2026-09-01T00:00:00Z',
    } as Conversation;
});
afterEach(() => cleanup());

describe('the web app\'s chat, after the node has been at the thread', () => {
    it('a line shown as someone else\'s, or stored again under a new id, never shows its words', async () => {
        const mine = sent(ana, 'I will pay you 50 Beans');
        const bens = sent(ben, 'Thanks, see you Saturday');
        thread.messages = [
            mine,
            { ...bens, authorPubkey: ana.publicKey },        // Ben's line shown as Ana's own
            { ...mine, id: uuid(), timestamp: new Date(Date.UTC(2026, 9, 1, 10)).toISOString() },   // Ana's line again, as new
        ];
        await openChat();
        await waitFor(() => expect(screen.getAllByText(NOT_VERIFIED)).toHaveLength(2));
        expect(screen.queryByText('Thanks, see you Saturday')).toBeNull();
        expect(screen.getAllByText('I will pay you 50 Beans')).toHaveLength(1);
    });

    it('Ben\'s answer shown before Ana\'s question is marked', async () => {
        const question = sent(ana, 'Shall I cancel the order?');
        const answer = sent(ben, 'No', question.id);
        thread.messages = [answer, question];
        await openChat();
        await waitFor(() => expect(screen.getByText('No')).toBeTruthy());
        const notes = screen.getAllByTestId('dm-line-note');
        expect(notes).toHaveLength(1);
        expect(notes[0].textContent).toContain(OUT_OF_ORDER);
        expect(notes[0].parentElement!.textContent).toContain('No');
        expect(notes[0].parentElement!.textContent).not.toContain('Shall I cancel');
    });

    it('in order, nothing is marked; old lines show as before, and one replayed after Ben moved on is marked', async () => {
        const history = oldLine(ben, ana, 'see you at 6');
        const ok = oldLine(ana, ben, 'ok');
        const here = sent(ben, "I'm here", ok.id);
        const replay = { ...history, id: uuid(), timestamp: new Date(Date.UTC(2026, 9, 1, 11)).toISOString() };
        thread.messages = [history, ok, here, replay];
        await openChat();
        await waitFor(() => expect(screen.getByText("I'm here")).toBeTruthy());
        expect(screen.getAllByText('see you at 6')).toHaveLength(2);
        const notes = screen.getAllByTestId('dm-line-note');
        expect(notes.map((n) => n.textContent)).toEqual([`⚠️ ${OLD_APP}`]);
        // the note sits under the replayed copy, the last line, not under the history it copies
        expect(notes[0].compareDocumentPosition(screen.getByText("I'm here")) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    });
});

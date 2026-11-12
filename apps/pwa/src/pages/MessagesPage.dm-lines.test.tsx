import { render, screen, act, waitFor, cleanup, within, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { dmLineAad, dmLineSigDigest, toEd25519Pkcs8 } from '@beanpool/core';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import type { Conversation, ApiMessage } from '../lib/api';
import { lockForDm } from '../lib/dm-lock';
import { sendMessageApi } from '../lib/api';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';
import { forgetGroupKeys } from '../lib/group-chat-keys';

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
    // A group's own chat route (group chats slice 4), as a node from before locked chats answers it: the same rows.
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
const NOT_ENCRYPTED = "⚠️ This message wasn't encrypted, so BeanPool can't confirm who wrote it. It isn't shown.";
const FROM_ADMINS = "From your community's admins. Not a private message: the community's server can read it.";
const OLD_LINES_LABEL = 'Older messages from before 12 November 2026. They were sent before BeanPool signed every message.';
/** The 1.4.0 deploy (core DM_OLD_LINE_CUTOFF): an old-format line dated here or later is hidden. */
const CUTOVER = '2026-11-11T19:16:00.000Z';

let minute = 0;
const uuid = () => crypto.randomUUID();
/** A line as this app sends it (lib/dm-lock.ts lockForDm, MessagesPage's handleSend), stored by the node. */
function sent(from: typeof ana, text: string, after: string | null = null, replyToId?: string): ApiMessage {
    const id = uuid();
    const sealed = lockForDm(text, chat, from, { messageId: id, after, replyToId });
    return {
        id, conversationId: CONV, authorPubkey: from.publicKey, ...sealed, timestamp: new Date(Date.UTC(2026, 9, 1, 9, minute++)).toISOString(),
        ...(replyToId ? { metadata: JSON.stringify({ replyToId }) } : {}),
    } as ApiMessage;
}
/** A row the operator writes into the node's database in someone's name. */
function written(from: typeof ana, ciphertext: string, nonce: string, extra: Partial<ApiMessage> = {}): ApiMessage {
    return { id: uuid(), conversationId: CONV, authorPubkey: from.publicKey, ciphertext, nonce, type: 'text',
        timestamp: new Date(Date.UTC(2026, 9, 1, 9, minute++)).toISOString(), ...extra } as ApiMessage;
}
const b64 = (t: string) => Buffer.from(t, 'utf8').toString('base64');
/** The pair's key, from the primitives: both of them hold it. */
function pairKey(me: typeof ana, other: typeof ana): Uint8Array {
    const shared = x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(me.seed), ed25519.utils.toMontgomery(hexToBytes(other.publicKey)));
    return hkdf(sha256, shared, utf8ToBytes(CONV), utf8ToBytes('beanpool-dm-v2'), 32);
}
const row = (from: typeof ana, ciphertext: Uint8Array, nonce: Uint8Array, id: string = uuid()): ApiMessage => ({
    id, conversationId: CONV, authorPubkey: from.publicKey, ciphertext: Buffer.from(ciphertext).toString('base64'),
    nonce: 'x25519-xc20p-v2:' + Buffer.from(nonce).toString('base64'), timestamp: new Date(Date.UTC(2026, 9, 1, 9, minute++)).toISOString(),
} as ApiMessage);
/** A line an app before 1.4.0 wrote, built from the primitives: format 2 (the conversation id alone) or format 3 (unsigned). */
function oldLine(from: typeof ana, to: typeof ana, text: string, format: 2 | 3 = 2): ApiMessage {
    const id = uuid();
    const nonce = randomBytes(24);
    const aad = format === 3 ? utf8ToBytes(JSON.stringify(['beanpool-dm-line/3', CONV, from.publicKey, id, 'body'])) : utf8ToBytes(CONV);
    const plain = format === 3 ? new Uint8Array([3, 0, ...utf8ToBytes(text)]) : utf8ToBytes(text);
    return row(from, xchacha20poly1305(pairKey(from, to), nonce, aad).encrypt(plain), nonce, id);
}
/**
 * A line `sealer` sealed in `named`'s name (the seal opens: both hold the key) and signed with `signer`'s key, as dm-crypto.ts
 * would lay it out; sealDmLine refuses to make it. With `signer` = `named`, it is `named`'s genuine line.
 */
function sealedInNameOf(sealer: typeof ana, named: typeof ana, text: string, signer: typeof ana = sealer, id: string = uuid()): ApiMessage {
    const nonce = randomBytes(24);
    const at = '2026-10-01T09:30:00.000Z';
    const sealed = xchacha20poly1305(pairKey(sealer, named), nonce, dmLineAad(CONV, { senderPubHex: named.publicKey, messageId: id })).encrypt(new Uint8Array([4, 0, ...utf8ToBytes(text)]));
    const digest = dmLineSigDigest('x25519-xc20p-v2:' + Buffer.from(nonce).toString('base64'), sealed,
        { conversationId: CONV, senderPubHex: named.publicKey, recipientPubHex: sealer.publicKey, messageId: id, part: 'body', at });
    return row(named, new Uint8Array([4, ...ed25519.sign(digest, signer.seed), ...utf8ToBytes(at), ...sealed]), nonce, id);
}

const identity: BeanPoolIdentity = { publicKey: ana.publicKey, privateKey: ana.privateKey, callsign: 'Ana', createdAt: '2026-09-01T00:00:00Z' };

async function openChat(): Promise<void> {
    render(<MessagesPage identity={identity} openConversationId={CONV} />);
    await screen.findByPlaceholderText('Message...');
    await act(async () => {});
}

beforeEach(() => {
    minute = 0;
    // A browser's own storage: the record of locked group chats reads, and holds nothing (lib/group-hold.ts). Without
    // it the page fails closed, as it must when that record can't be read.
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetGroupChatLockStoreForTest();
    forgetGroupKeys();
    thread.conversation = {
        id: CONV, type: 'dm', name: null, participants: [ana.publicKey, ben.publicKey], createdBy: ana.publicKey,
        peerCallsign: 'Ben', unreadCount: 0, createdAt: '2026-09-01T00:00:00Z',
    } as Conversation;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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

    // Web one-to-one chats: Delete your own message, as on the phone.
    it('Ana\'s own line in a DM has Delete', async () => {
        thread.messages = [sent(ana, 'See you at the hall')];
        await openChat();
        const line = (await screen.findByText('See you at the hall')).closest('[id^="msg-"]') as HTMLElement;
        expect(within(line).getByRole('button', { name: 'Delete message' })).toBeInTheDocument();
    });

    it('Ben\'s answer shown before Ana\'s question is marked', async () => {
        const question = sent(ana, 'Shall I cancel the order?');
        const answer = sent(ben, 'No', question.id);
        // The node gives the answer the earlier time (the order both apps show a thread in) and serves it first.
        [question.timestamp, answer.timestamp] = [answer.timestamp, question.timestamp];
        thread.messages = [answer, question];
        await openChat();
        await waitFor(() => expect(screen.getByText('No')).toBeTruthy());
        const notes = screen.getAllByTestId('dm-line-note');
        expect(notes).toHaveLength(1);
        expect(notes[0].textContent).toContain(OUT_OF_ORDER);
        expect(notes[0].parentElement!.textContent).toContain('No');
        expect(notes[0].parentElement!.textContent).not.toContain('Shall I cancel');
    });

    // Format 4: the two share one key, so either could seal a line naming the other; only the sender's signature says who.
    it("a line in Ben's name that Ben didn't sign is never his: shown in the middle as nobody's, its words hidden", async () => {
        const genuine = sealedInNameOf(ana, ben, 'Thanks, see you Saturday', ben);
        // Ana's own browser (or anyone holding her key) seals words in Ben's name; she can only sign them herself.
        const forged = sealedInNameOf(ana, ben, 'I owe Ana 500 Beans');
        thread.messages = [genuine, forged];
        await openChat();
        await waitFor(() => expect(screen.getByText('Thanks, see you Saturday')).toBeTruthy());
        const neutral = screen.getAllByTestId('dm-line-unattributed');
        expect(neutral.map((n) => n.textContent)).toEqual([NOT_VERIFIED]);
        expect(document.body.textContent).not.toMatch(/500 Beans/);
        // The genuine line, built the same way and signed by Ben, is in a bubble of his: only the signature differs.
        expect(screen.getByText('Thanks, see you Saturday').closest('[data-testid="dm-line-unattributed"]')).toBeNull();
    });

    // Dated from the 1.4.0 cutover on (old chat, OLDCHAT: a line from before it is shown read-only, below).
    it('a line of an older format, 2 or 3, dated from the 1.4.0 cutover on, is never shown: format 4 is the only one read', async () => {
        const here = sent(ben, "I'm here");
        thread.messages = [
            { ...oldLine(ben, ana, 'see you at 6', 2), timestamp: CUTOVER },
            { ...oldLine(ben, ana, 'see you at 7', 3), timestamp: '2026-11-12T08:00:00.000Z' },
            here,
        ];
        await openChat();
        await waitFor(() => expect(screen.getByText("I'm here")).toBeTruthy());
        expect(screen.getAllByTestId('dm-line-unattributed').map((n) => n.textContent)).toEqual([NOT_VERIFIED, NOT_VERIFIED]);
        expect(document.body.textContent).not.toMatch(/see you at [67]/);
        expect(screen.queryByTestId('dm-old-lines-label')).toBeNull();
        // nothing under the new line
        expect(screen.getByText("I'm here").parentElement!.querySelector('[data-testid="dm-line-note"]')).toBeNull();
    });

    // Old chat, read-only (conversion code, log row OLDCHAT, remove after 12 Dec 2026; Marty, 12 Nov 2026).
    describe('old chat: a line from before 1.4.0', () => {
        const dated = (m: ApiMessage, timestamp: string): ApiMessage => ({ ...m, timestamp });
        /** A format-3 line as a 1.3.x app sealed it, written after `after` (the id of the newest line its sender had). */
        function format3After(from: typeof ana, to: typeof ana, text: string, after: string): ApiMessage {
            const id = uuid();
            const nonce = randomBytes(24);
            const a = utf8ToBytes(after);
            const sealed = xchacha20poly1305(pairKey(from, to), nonce, utf8ToBytes(JSON.stringify(['beanpool-dm-line/3', CONV, from.publicKey, id, 'body'])))
                .encrypt(new Uint8Array([3, a.length, ...a, ...utf8ToBytes(text)]));
            return row(from, sealed, nonce, id);
        }
        const bubbleOf = (text: string) => screen.getByText(text).closest('[id^="msg-"]') as HTMLElement;

        it('format 2 and 3 open as they did, in their authors\' bubbles, under one label above the run', async () => {
            const here = dated(sent(ben, "I'm here"), '2026-11-12T08:00:00.000Z');
            thread.messages = [
                dated(oldLine(ben, ana, 'see you at 6', 2), '2026-11-01T09:00:00.000Z'),
                dated(oldLine(ana, ben, 'ok, 6 it is', 3), '2026-11-01T09:05:00.000Z'),
                here,
            ];
            await openChat();
            await waitFor(() => expect(screen.getByText('see you at 6')).toBeTruthy());
            expect(screen.getByText('ok, 6 it is')).toBeTruthy();
            expect(screen.queryAllByTestId('dm-line-unattributed')).toHaveLength(0);
            const labels = screen.getAllByTestId('dm-old-lines-label');
            expect(labels).toHaveLength(1);
            expect(labels[0].textContent).toBe(OLD_LINES_LABEL);
            // Above the run: before its first line, and the new line after the run has none above it.
            expect(labels[0].compareDocumentPosition(screen.getByText('see you at 6')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
            expect(screen.getByText("I'm here").compareDocumentPosition(labels[0]) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
            // Ana's own old line sits in her bubble (right), Ben's in his.
            expect(bubbleOf('ok, 6 it is').style.alignSelf).toBe('flex-end');
            expect(bubbleOf('see you at 6').style.alignSelf).toBe('flex-start');
        });

        it('read-only: no Reply (so no quote), React, Edit or Delete on an old line; Copy stays, and Report on the other person\'s', async () => {
            const mineNew = dated(sent(ana, 'A new line of mine'), '2026-11-12T08:00:00.000Z');
            thread.messages = [
                dated(oldLine(ben, ana, 'see you at 6', 2), '2026-11-01T09:00:00.000Z'),
                // Ana's own, two minutes old by the node's clock if the clock is wrong: still no Edit (an old line is never edited).
                dated(oldLine(ana, ben, 'ok, 6 it is', 3), '2026-11-11T19:15:00.000Z'),
                mineNew,
            ];
            await openChat();
            await waitFor(() => expect(screen.getByText('see you at 6')).toBeTruthy());
            for (const text of ['see you at 6', 'ok, 6 it is']) {
                const b = bubbleOf(text);
                for (const name of ['Reply to message', 'React to message', 'Edit message', 'Delete message']) {
                    expect(within(b).queryByRole('button', { name })).toBeNull();
                }
                expect(within(b).getByRole('button', { name: /copy/i })).toBeTruthy();
            }
            expect(within(bubbleOf('see you at 6')).getByRole('button', { name: 'Report message' })).toBeTruthy();
            // A line from after the cutover keeps every action.
            const fresh = bubbleOf('A new line of mine');
            expect(within(fresh).getByRole('button', { name: 'Reply to message' })).toBeTruthy();
            expect(within(fresh).getByRole('button', { name: 'Delete message' })).toBeTruthy();
            // Nothing in the composer to answer: no "Replying to" on the page.
            expect(document.body.textContent).not.toMatch(/Replying to/);
        });

        it('an old-format line dated from the cutover on stays hidden, with no label', async () => {
            thread.messages = [dated(oldLine(ben, ana, 'see you at 6', 3), CUTOVER), dated(oldLine(ben, ana, 'see you at 7', 2), '2026-11-13T09:00:00.000Z')];
            await openChat();
            await waitFor(() => expect(screen.getAllByTestId('dm-line-unattributed').map((n) => n.textContent)).toEqual([NOT_VERIFIED, NOT_VERIFIED]));
            expect(document.body.textContent).not.toMatch(/see you at [67]/);
            expect(screen.queryByTestId('dm-old-lines-label')).toBeNull();
        });

        it('forged time: a format-4 line its named sender didn\'t sign, dated before the cutover, is never old', async () => {
            const forged = dated(sealedInNameOf(ana, ben, 'I owe Ana 500 Beans'), '2026-10-20T09:00:00.000Z');
            thread.messages = [forged, dated(oldLine(ben, ana, 'see you at 6', 2), '2026-11-01T09:00:00.000Z')];
            await openChat();
            await waitFor(() => expect(screen.getByText('see you at 6')).toBeTruthy());
            expect(screen.getAllByTestId('dm-line-unattributed').map((n) => n.textContent)).toEqual([NOT_VERIFIED]);
            expect(document.body.textContent).not.toMatch(/500 Beans/);
        });

        it('forged time: an old-format line sealed after a line from after the cutover, dated before it, is hidden', async () => {
            const newer = dated(sent(ana, 'After the cutover'), '2026-11-12T08:00:00.000Z');
            const forged = dated(format3After(ben, ana, 'Ana agreed to pay 500 Beans', newer.id), '2026-11-02T09:00:00.000Z');
            thread.messages = [forged, newer];
            await openChat();
            await waitFor(() => expect(screen.getByText('After the cutover')).toBeTruthy());
            expect(screen.getAllByTestId('dm-line-unattributed').map((n) => n.textContent)).toEqual([NOT_VERIFIED]);
            expect(document.body.textContent).not.toMatch(/500 Beans/);
            expect(screen.queryByTestId('dm-old-lines-label')).toBeNull();
        });

        it('a reply from before 1.4.0 quotes the old line it answers, both read-only', async () => {
            const asked = dated(oldLine(ana, ben, 'Can I borrow the ladder?', 3), '2026-11-01T09:00:00.000Z');
            // A 1.3.x reply: format 3, bound to what it answers.
            const id = uuid();
            const nonce = randomBytes(24);
            const a = utf8ToBytes(asked.id);
            const sealed = xchacha20poly1305(pairKey(ben, ana), nonce, utf8ToBytes(JSON.stringify(['beanpool-dm-line/3', CONV, ben.publicKey, id, 'body', asked.id])))
                .encrypt(new Uint8Array([3, a.length, ...a, ...utf8ToBytes('Yes, take it')]));
            const reply = { ...row(ben, sealed, nonce, id), metadata: JSON.stringify({ replyToId: asked.id }), timestamp: '2026-11-01T09:01:00.000Z' };
            thread.messages = [asked, reply];
            await openChat();
            const bubble = (await screen.findByText('Yes, take it')).closest('[id^="msg-"]') as HTMLElement;
            const quote = within(bubble).getByTestId('dm-quote');
            expect(quote.textContent).toContain('You');
            expect(quote.textContent).toContain('Can I borrow the ladder?');
            expect(screen.getAllByTestId('dm-old-lines-label')).toHaveLength(1);
            expect(within(bubble).queryByRole('button', { name: 'Reply to message' })).toBeNull();
        });

        // A deleted line, or a row shown as nobody's, is passed over as a notice is, so one run of old chat gets one label
        // (#3075 review, MessagesPage.tsx:633; conversion code, log row OLDCHAT, remove after 12 Dec 2026).
        /** A line deleted as the node does it (engine/message-tombstone.ts): its row retyped, its words replaced, its time kept. */
        const deleted = (from: typeof ana, timestamp: string, extra: Record<string, unknown> = {}): ApiMessage => written(from, b64('This message was deleted'), 'plaintext-v1', {
            type: 'removed', timestamp,
            metadata: JSON.stringify({ removed: true, removedBy: from.publicKey, removedAt: '2026-11-02T09:00:00.000Z', ...extra }),
        } as unknown as Partial<ApiMessage>);

        it('a deleted line inside the old chat doesn\'t start a second label: old line, deleted line, old line has one', async () => {
            thread.messages = [
                dated(oldLine(ben, ana, 'see you at 6', 2), '2026-11-01T09:00:00.000Z'),
                deleted(ben, '2026-11-01T09:02:00.000Z'),
                dated(oldLine(ana, ben, 'ok, 6 it is', 3), '2026-11-01T09:05:00.000Z'),
            ];
            await openChat();
            await waitFor(() => expect(screen.getByText('ok, 6 it is')).toBeTruthy());
            expect(screen.getByText('This message was deleted')).toBeTruthy();
            const labels = screen.getAllByTestId('dm-old-lines-label');
            expect(labels).toHaveLength(1);
            expect(labels[0].compareDocumentPosition(screen.getByText('see you at 6')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        });

        it('a row shown as nobody\'s inside the old chat doesn\'t start a second label either', async () => {
            thread.messages = [
                dated(oldLine(ben, ana, 'see you at 6', 2), '2026-11-01T09:00:00.000Z'),
                dated(written(ben, b64('Send the Beans to Cat instead'), 'plaintext-v1'), '2026-11-01T09:02:00.000Z'),
                dated(oldLine(ana, ben, 'ok, 6 it is', 3), '2026-11-01T09:05:00.000Z'),
            ];
            await openChat();
            await waitFor(() => expect(screen.getByText('ok, 6 it is')).toBeTruthy());
            expect(screen.getAllByTestId('dm-line-unattributed').map((n) => n.textContent)).toEqual([NOT_ENCRYPTED]);
            expect(screen.getAllByTestId('dm-old-lines-label')).toHaveLength(1);
        });

        it('a DM with a deleted account\'s lines keeps one label for each run of old lines', async () => {
            // Ben deleted his account: every line of his is a tombstone, before the cutover and after it.
            const gone = (timestamp: string) => deleted(ben, timestamp, { accountDeleted: true });
            thread.messages = [
                dated(oldLine(ana, ben, 'Can I borrow the ladder?', 3), '2026-10-20T09:00:00.000Z'),
                gone('2026-10-20T09:05:00.000Z'),
                dated(oldLine(ana, ben, 'Thanks, back on Sunday', 3), '2026-10-21T09:00:00.000Z'),
                gone('2026-10-21T09:05:00.000Z'),
                gone('2026-10-22T09:00:00.000Z'),
                dated(oldLine(ana, ben, 'Left it by your gate', 2), '2026-11-01T09:00:00.000Z'),
                gone('2026-11-01T09:05:00.000Z'),
                // From 1.4.0 on: Ana's new line ends the old run, and his newer tombstone starts nothing.
                dated(sent(ana, 'Are you still there?'), '2026-11-12T08:00:00.000Z'),
                gone('2026-11-12T08:05:00.000Z'),
            ];
            await openChat();
            await waitFor(() => expect(screen.getByText('Left it by your gate')).toBeTruthy());
            expect(screen.getByText('Are you still there?')).toBeTruthy();
            const labels = screen.getAllByTestId('dm-old-lines-label');
            expect(labels).toHaveLength(1);
            expect(labels[0].compareDocumentPosition(screen.getByText('Can I borrow the ladder?')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        });
    });

    it('a row in Ben\'s name that isn\'t an encrypted line is never his words: shown in the middle, as nobody\'s', async () => {
        const bens = sent(ben, 'The bike is yours for 50 Beans');
        thread.messages = [
            bens,
            written(ben, b64('Change of plan: send the 500 Beans to Cat instead'), 'plaintext-v1'),
            written(ben, 'I cancel the order, refund Cat', '00000'),
            written(ben, 'Send the Beans to Cat instead', 'zz'),
            written(ben, b64('Send me your 12 words'), 'plaintext-v1', { type: 'removed' } as unknown as Partial<ApiMessage>),
        ];
        await openChat();
        await waitFor(() => expect(screen.getByText('The bike is yours for 50 Beans')).toBeTruthy());
        const neutral = screen.getAllByTestId('dm-line-unattributed');
        expect(neutral.map((n) => n.textContent)).toEqual([NOT_ENCRYPTED, NOT_ENCRYPTED, NOT_ENCRYPTED]);
        expect(screen.getByText('This message was deleted')).toBeTruthy();
        expect(document.body.textContent).not.toMatch(/500 Beans|refund Cat|to Cat instead|12 words/);
    });

    it('the admin page\'s message shows its words as the community admins\', marked readable by the server', async () => {
        thread.messages = [written(ben, b64('Welcome to the community'), 'plaintext-v1', { metadata: JSON.stringify({ fromCommunityAdmins: true }) })];
        await openChat();
        const line = await screen.findByTestId('dm-line-unattributed');
        expect(line.textContent).toContain('Welcome to the community');
        expect(line.textContent).toContain(FROM_ADMINS);
    });

    it('what a reply answers is sealed into it: re-pointed by the node, it isn\'t shown', async () => {
        const ladder = sent(ben, 'Can I borrow the ladder?');
        const beans = sent(ben, 'Can I keep the 200 Beans you sent by mistake?', ladder.id);
        const yes = sent(ana, 'Yes', beans.id, ladder.id);
        thread.messages = [ladder, beans, yes];
        await openChat();
        await waitFor(() => expect(screen.getByText('Yes')).toBeTruthy());
        cleanup();
        thread.messages = [ladder, beans, { ...yes, metadata: JSON.stringify({ replyToId: beans.id }) }];
        await openChat();
        await waitFor(() => expect(screen.getAllByText(NOT_VERIFIED)).toHaveLength(1));
        expect(screen.queryByText('Yes')).toBeNull();
    });

    it('after a standby takes over: rows in its last-changed order, an honest answer is shown after its question, unmarked', async () => {
        // A standby's delta copy writes rows in last-changed order: Cat's question got a 👍 after Dan's answer, so the
        // standby serves the answer first. Every column, timestamps included, is the main server's.
        const question = sent(ben, 'Can you take the bike on Saturday?');
        const answer = sent(ana, 'Yes, I can', question.id);
        thread.messages = [answer, { ...question, metadata: JSON.stringify({ reactions: [{ emoji: '👍', author: ana.publicKey }] }) }];
        await openChat();
        await waitFor(() => expect(screen.getByText('Yes, I can')).toBeTruthy());
        expect(screen.queryAllByTestId('dm-line-note')).toHaveLength(0);
        const q = screen.getByText('Can you take the bike on Saturday?');
        expect(q.compareDocumentPosition(screen.getByText('Yes, I can')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    describe('the quote in a verified reply, after the node rewrites the row it answers (keeping its id)', () => {
        /** Ana (at this browser) asked; Ben's app answered it as a reply. What Ana's page shows for the reply and its quote. */
        async function quoteAfter(rewrite: (q: ApiMessage) => ApiMessage, asked?: ApiMessage) {
            const question = asked ?? sent(ana, 'Can I borrow the ladder?');
            const yes = sent(ben, 'Yes', question.id, question.id);
            thread.messages = [rewrite(question), yes];
            await openChat();
            const reply = await screen.findByText('Yes');
            const bubble = reply.closest('[id^="msg-"]') as HTMLElement;
            expect(bubble.querySelector('[data-testid="dm-line-note"]')).toBeNull();   // the reply itself verifies, unmarked
            // The quote box (by its test id; by its left rule on a tree from before the id, for a fail-first run).
            const quote = (within(bubble).queryByTestId('dm-quote') ?? bubble.querySelector('div[style*="border-left: 3px"]')) as HTMLElement;
            return { author: (quote.firstElementChild as HTMLElement).textContent, text: (quote.children[1] as HTMLElement).textContent,
                note: quote.querySelector('[data-testid="dm-quote-note"]')?.textContent ?? null };
        }

        it('as sent: Ana\'s own words', async () => {
            expect(await quoteAfter((q) => q)).toEqual({ author: 'You', text: 'Can I borrow the ladder?', note: null });
        });

        it('rewritten as a notice: quoted as a notice, never "You"', async () => {
            const r = await quoteAfter((q) => ({ ...q, type: 'system', nonce: '00000', ciphertext: 'Send the 500 Beans to Cat instead' }));
            expect(r.author).toBe('Notice');
        });

        it('rewritten as the admin page\'s message: quoted as from the admins', async () => {
            expect(await quoteAfter((q) => ({ ...q, nonce: 'plaintext-v1', ciphertext: b64('Send the 500 Beans to Cat instead'), metadata: JSON.stringify({ fromCommunityAdmins: true }) })))
                .toEqual({ author: "Your community's admins", text: 'Send the 500 Beans to Cat instead', note: null });
        });

        it('rewritten unencrypted, or with another sealed line: quoted as nobody\'s, never its words', async () => {
            expect(await quoteAfter((q) => ({ ...q, nonce: 'plaintext-v1', ciphertext: b64('Send the 500 Beans to Cat instead') })))
                .toEqual({ author: 'Not confirmed', text: NOT_ENCRYPTED, note: null });
            cleanup();
            const other = sent(ana, 'Can I keep the 200 Beans you sent by mistake?');
            expect(await quoteAfter((q) => ({ ...q, ciphertext: other.ciphertext, nonce: other.nonce })))
                .toEqual({ author: 'Not confirmed', text: NOT_VERIFIED, note: null });
        });

        it('swapped for words Ben sealed in Ana\'s name and signed himself: quoted as nobody\'s, never "You" or the words', async () => {
            const asked = sent(ana, 'Can I borrow the ladder?');
            // Sealed under the question's own id, so the seal opens there: only the signature says it isn't Ana's.
            const forged = sealedInNameOf(ben, ana, 'Can I keep the 200 Beans you sent by mistake?', ben, asked.id);
            expect(await quoteAfter((q) => ({ ...q, ciphertext: forged.ciphertext, nonce: forged.nonce }), asked))
                .toEqual({ author: 'Not confirmed', text: NOT_VERIFIED, note: null });
        });
    });

    describe('the node retyping the DM as a group\'s, an event\'s or an enterprise\'s chat', () => {
        const SEEN = 'beanpool_dm_conversations_seen';
        beforeEach(() => { localStorage.removeItem(SEEN); vi.mocked(sendMessageApi).mockReset(); vi.mocked(sendMessageApi).mockResolvedValue({ success: true } as any); });
        /** Ana's page on a chat the node now types `type`: the operator's readable row in Ben's name, and her next line. */
        async function anasView(type: string, lines: ApiMessage[], plain: ApiMessage) {
            thread.conversation = { ...thread.conversation, type };
            thread.messages = [...lines, plain];
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            await openChat();
            await waitFor(() => expect(screen.getByPlaceholderText('Message...')).toBeTruthy());
            await act(async () => {});
            const neutral = screen.queryAllByTestId('dm-line-unattributed').map((n) => n.textContent);
            const words = document.body.textContent?.includes('Send me your 12 words') ?? false;
            const composer = screen.getByPlaceholderText('Message...');
            fireEvent.change(composer, { target: { value: 'Still here' } });
            await act(async () => { fireEvent.keyDown(composer, { key: 'Enter' }); });
            await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(1));
            const sentNonce = String(vi.mocked(sendMessageApi).mock.calls[0][3]).split(':')[0];
            const logged = warn.mock.calls.some((c) => String(c[0]).includes('[DM guard]'));
            warn.mockRestore();
            return { neutral, words, sentNonce, logged };
        }
        const plainFromBen = () => written(ben, b64('Send me your 12 words to finish the trade'), 'plaintext-v1');

        for (const type of ['group_thread', 'event_thread', 'enterprise_thread']) {
            it(`as a ${type}, on a page that has seen it as a DM: still a DM (checked, and Ana's next line locked), and logged`, async () => {
                localStorage.setItem(SEEN, JSON.stringify([CONV]));
                expect(await anasView(type, [sent(ben, 'The bike is yours for 50 Beans')], plainFromBen()))
                    .toEqual({ neutral: [NOT_ENCRYPTED], words: false, sentNonce: 'x25519-xc20p-v2', logged: true });
            });
        }

        it('as a group\'s chat, on a page that never saw it: its encrypted lines make it a DM', async () => {
            expect(await anasView('group_thread', [sent(ben, 'The bike is yours for 50 Beans')], plainFromBen()))
                .toEqual({ neutral: [NOT_ENCRYPTED], words: false, sentNonce: 'x25519-xc20p-v2', logged: true });
        });

        it('a group\'s real chat (never seen as a DM, no encrypted line) stays a group\'s', async () => {
            thread.conversation = { ...thread.conversation, type: 'group_thread', name: 'Seed Savers' };
            thread.messages = [written(ben, b64('Seeds are in'), 'plaintext-v1')];
            await openChat();
            await screen.findByText('Seeds are in');
            expect(screen.queryAllByTestId('dm-line-unattributed')).toHaveLength(0);
            expect(localStorage.getItem(SEEN)).toBeNull();
        });

        it('seen here as a DM before, now a group\'s chat with every encrypted line withheld: still a DM', async () => {
            localStorage.setItem(SEEN, JSON.stringify([CONV]));
            expect(await anasView('group_thread', [], plainFromBen()))
                .toEqual({ neutral: [NOT_ENCRYPTED], words: false, sentNonce: 'x25519-xc20p-v2', logged: true });
        });
    });
});

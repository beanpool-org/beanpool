import { render, screen, act, waitFor, cleanup, within, fireEvent } from '@testing-library/react';
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
import { sendMessageApi } from '../lib/api';

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
const OLD_APP = "Sent from an older version of the app: BeanPool can't confirm who wrote it.";
const NOT_ENCRYPTED = "⚠️ This message wasn't encrypted, so BeanPool can't confirm who wrote it. It isn't shown.";
const FROM_ADMINS = "From your community's admins. Not a private message: the community's server can read it.";

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

    it('in order, nothing new is marked; every old-format line is, wherever it sits and whoever it names', async () => {
        const history = oldLine(ben, ana, 'see you at 6');
        const ok = oldLine(ana, ben, 'ok');
        const here = sent(ben, "I'm here", ok.id);
        const replay = { ...history, id: uuid(), timestamp: new Date(Date.UTC(2026, 9, 1, 11)).toISOString() };
        // Ana's old line shown as Ben's newest: format 2 can't prove its sender.
        const asBens = { ...oldLine(ana, ben, 'I will pay you 50 Beans'), authorPubkey: ben.publicKey, timestamp: new Date(Date.UTC(2026, 9, 1, 12)).toISOString() };
        thread.messages = [history, ok, here, replay, asBens];
        await openChat();
        await waitFor(() => expect(screen.getByText("I'm here")).toBeTruthy());
        expect(screen.getAllByText('see you at 6')).toHaveLength(2);
        const notes = screen.getAllByTestId('dm-line-note');
        expect(notes.map((n) => n.textContent)).toEqual([OLD_APP, OLD_APP, OLD_APP, OLD_APP].map((t) => `⚠️ ${t}`));
        // nothing under the new line
        expect(screen.getByText("I'm here").parentElement!.querySelector('[data-testid="dm-line-note"]')).toBeNull();
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

        it('an old-format question swapped for another old line: quoted with the older-version mark', async () => {
            const asked = oldLine(ana, ben, 'Can I borrow the ladder?');
            const other = oldLine(ana, ben, 'Can I keep the 200 Beans you sent by mistake?');
            expect(await quoteAfter((q) => ({ ...q, ciphertext: other.ciphertext, nonce: other.nonce }), asked))
                .toEqual({ author: 'You', text: 'Can I keep the 200 Beans you sent by mistake?', note: `⚠️ ${OLD_APP}` });
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

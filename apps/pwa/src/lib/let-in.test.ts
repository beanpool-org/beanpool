/**
 * Let in once on the web (S5 part 3: scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3 "Let in once"): core's rule
 * (packages/beanpool-core/src/let-in.ts, its own table) over the facts the web reads of its one community.
 *
 *   1  one table, the core table's facts as the web reads them (its chat list and a chat's lines, friends, deals,
 *      payments, the contacts this browser keeps) x what else holds {nothing, blocked on this community's list, unblocked
 *      in this page, a block list that can't be read, their key a re-keyed person's former one, the chat list unread}
 *      -> lib/let-in.ts letInOnWeb: let in or not
 *   2  what is read, and when: once a round; a chat's lines and the contacts only when nothing cheaper lets them in
 *   3  through the real round (lib/outside-mail.ts syncOutsideMail, core gateOutsideItem): a first line across from
 *      someone let in opens a chat with the door closed and is receipted now; a stranger is dropped; a block beats it
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { DM_FROM_ADMINS_KEY, DM_NONCE_PREFIX, ed25519Signer, relayConversationId, relayPayloadHash, sealOutsideLine, signRelayEnvelope, type RelayItem } from '@beanpool/core';
import { MemoryIDBKeyRange, memoryIndexedDB } from './memory-indexeddb';

const server = vi.hoisted(() => ({ held: [] as any[], receipts: [] as Array<{ to: string; ids: string[] }> }));

vi.mock('./api', async (importOriginal) => {
    const core = await import('@beanpool/core');
    const { hexToBytes } = await import('@noble/hashes/utils.js');
    const real = await importOriginal<typeof import('./api')>();
    return {
        ...real,
        signAddressCardFor: (c: any, id: any) => core.signAddressCard(c, core.ed25519Signer(hexToBytes(id.privateKey))),
        signRelayEnvelopeFor: (f: any, id: any) => core.signRelayEnvelope(f, core.ed25519Signer(hexToBytes(id.privateKey))),
        signedMailFetch: vi.fn(async (method: string, _community: string, path: string, body: any) => {
            if (method === 'GET') return new Response(JSON.stringify({ items: server.held, more: false, outbox: [], outboxMore: false }), { status: 200 });
            if (path === '/api/mail/confirm') {
                server.held = server.held.filter((h) => !body.ids.includes(h.envelope.itemId));
                return new Response(JSON.stringify({ confirmed: body.ids.length }), { status: 200 });
            }
            if (path === '/api/mail/send') {
                for (const i of body.items) if (i.envelope.kind === 'receipt') server.receipts.push({ to: i.envelope.recipient, ids: JSON.parse(i.payload).items });
                return new Response(JSON.stringify({ items: body.items.map((i: RelayItem) => ({ itemId: i.envelope.itemId, state: 'sent' })) }), { status: 200 });
            }
            return new Response('{}', { status: 404 });
        }),
    };
});
vi.mock('./visitor-lobby-gate', () => ({ communityInfoOnce: vi.fn(async () => ({ features: { outsideMessages: true } })) }));
vi.mock('./identity', () => ({ loadIdentity: vi.fn(async () => null) }));
vi.mock('./blocklist', () => ({ getBlocklistStatus: () => ({ loaded: true, error: null }), isUserBlocked: () => false, loadBlocklist: async () => [], unblockedInThisPage: () => false }));

import { clearOutsideChats, outsideChatStore } from './outside-chat-store';
import { setDoor, syncOutsideMail, type OutsideMailContext } from './outside-mail';
import { setNodeApiUrl } from './api';
import { resetAccountEpochForTest } from './account-epoch';
import { letInOnWeb, type WebLetInReads } from './let-in';

const seedKey = () => { const seed = ed25519.utils.randomSecretKey(); return { seed: bytesToHex(seed), key: bytesToHex(ed25519.getPublicKey(seed)) }; };
const BEN = seedKey(), SOL = seedKey(), NEW = seedKey(), CY = seedKey();
const ME = BEN.key, THEM = SOL.key, OTHER = CY.key;
const SEALED = `${DM_NONCE_PREFIX}abc`;
const B = 'https://b.example';

/** What this community answers the member, as the web reads it; each read counted. */
interface Facts {
    conversations?: any[];
    requests?: any[];
    lines?: Record<string, any[]>;
    friends?: any[];
    deals?: any[];
    payments?: any[];
    contacts?: string[];
}
let reads: Record<string, number>;
function readsOf(f: Facts, broken: { list?: boolean } = {}): WebLetInReads {
    const count = (k: string) => { reads[k] = (reads[k] ?? 0) + 1; };
    return {
        conversations: async () => {
            count('conversations');
            if (broken.list) throw new Error('unreachable');
            return { conversations: f.conversations ?? [], totalUnread: 0, ...(f.requests ? { requests: { count: f.requests.length, conversations: f.requests } } : {}) } as any;
        },
        lines: async (id) => { count('lines'); return { messages: f.lines?.[id] ?? [] }; },
        friends: async () => { count('friends'); return (f.friends ?? []) as any; },
        deals: async () => { count('deals'); return f.deals ?? []; },
        payments: async () => { count('payments'); return f.payments ?? []; },
        contacts: async () => { count('contacts'); return { contacts: (f.contacts ?? []).map((key) => ({ links: [{ key }] })) }; },
    };
}

const dm = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'dm', participants: [ME, THEM], name: null, createdBy: ME, createdAt: '', ...extra });
const line = (author: string, extra: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), authorPubkey: author, nonce: SEALED, type: 'text', ...extra });

interface Source { name: string; facts: Facts; letsIn: boolean }
/** The core table's facts, as the web reads them. */
const SOURCES: Source[] = [
    { name: 'a direct chat the member wrote a line in', facts: { conversations: [dm('c1')], lines: { c1: [line(THEM), line(ME)] } }, letsIn: true },
    { name: 'a direct chat whose request the member accepted', facts: { conversations: [dm('c1', { request: { state: 'accepted', from: THEM, at: '', acceptedByYou: true } })] }, letsIn: true },
    { name: 'a friend the member added', facts: { friends: [{ publicKey: THEM, callsign: 'Sol', addedAt: '', isGuardian: false }] }, letsIn: true },
    { name: 'a deal the member bought in', facts: { deals: [{ buyerPublicKey: ME, sellerPublicKey: THEM, status: 'completed', postAuthorPublicKey: THEM }] }, letsIn: true },
    { name: 'a deal the member sold in on the buyer\'s own Need', facts: { deals: [{ buyerPublicKey: THEM, sellerPublicKey: ME, status: 'pending', postAuthorPublicKey: THEM }] }, letsIn: true },
    { name: 'someone the member paid', facts: { payments: [{ from: ME, to: THEM }] }, letsIn: true },
    { name: 'a private contact the member linked', facts: { contacts: [THEM] }, letsIn: true },
    { name: 'nothing at all', facts: {}, letsIn: false },
    { name: 'a direct chat only they wrote in', facts: { conversations: [dm('c1')], lines: { c1: [line(THEM)] } }, letsIn: false },
    { name: 'a request accepted, not by the member\'s act', facts: { conversations: [dm('c1', { request: { state: 'accepted', from: ME, at: '' } })] }, letsIn: false },
    { name: 'a request waiting for the member', facts: { requests: [dm('c1', { request: { state: 'pending', from: THEM, at: '' } })] }, letsIn: false },
    { name: 'a node notice in the member\'s name', facts: { conversations: [dm('c1')], lines: { c1: [line(ME, { type: 'system' })] } }, letsIn: false },
    { name: 'the admin page\'s message in the member\'s name', facts: { conversations: [dm('c1')], lines: { c1: [line(ME, { nonce: 'plaintext-v1', metadata: JSON.stringify({ [DM_FROM_ADMINS_KEY]: true }) })] } }, letsIn: false },
    { name: 'a group chat the member wrote in', facts: { conversations: [dm('g1', { type: 'group_thread' })], lines: { g1: [line(ME)] } }, letsIn: false },
    { name: 'a chat the member wrote in with two others', facts: { conversations: [dm('c1', { participants: [ME, THEM, OTHER] })], lines: { c1: [line(ME)] } }, letsIn: false },
    { name: 'a deal the member only asked for', facts: { deals: [{ buyerPublicKey: ME, sellerPublicKey: THEM, status: 'requested', postAuthorPublicKey: THEM }] }, letsIn: false },
    { name: 'a deal on the member\'s own Offer', facts: { deals: [{ buyerPublicKey: THEM, sellerPublicKey: ME, status: 'completed', postAuthorPublicKey: ME }] }, letsIn: false },
    { name: 'a payment they sent the member', facts: { payments: [{ from: THEM, to: ME }] }, letsIn: false },
    { name: 'a contact linked to someone else', facts: { contacts: [OTHER] }, letsIn: false },
];

interface Column { name: string; passes: boolean; blocked?: (k: string) => Promise<boolean>; facts?: (f: Facts) => Facts; broken?: { list?: boolean } }
const COLUMNS: Column[] = [
    { name: 'nothing else', passes: true },
    { name: 'blocked on this community\'s list', passes: false, blocked: async (k) => k === THEM },
    { name: 'the block list can\'t be read', passes: false, blocked: async () => { throw new Error('not read'); } },
    {
        name: 'their key is a re-keyed person\'s former one', passes: false,
        facts: (f) => ({ ...f, conversations: [...(f.conversations ?? []), { ...dm('c9', { participants: [ME, NEW.key] }), formerKeys: { [NEW.key]: [{ pubkey: THEM, at: '', sig: '' }] } }] }),
    },
    { name: 'the chat list can\'t be read', passes: false, broken: { list: true } },
];

beforeEach(() => { reads = {}; });

describe('let in once on the web: the core table\'s facts as the web reads them x what else holds', () => {
    for (const source of SOURCES) {
        for (const column of COLUMNS) {
            const want = source.letsIn && column.passes;
            it(`${source.name} | ${column.name} -> ${want ? 'let in' : 'not'}`, async () => {
                const facts = column.facts ? column.facts(source.facts) : source.facts;
                const letIn = letInOnWeb({ publicKey: ME, privateKey: BEN.seed }, column.blocked ?? (async () => false), readsOf(facts, column.broken));
                expect(await letIn(THEM)).toBe(want);
            });
        }
    }
});

describe('what is read, and when', () => {
    it('once a round, however many ask; the lines and the contacts only when nothing cheaper lets them in', async () => {
        const letIn = letInOnWeb({ publicKey: ME, privateKey: BEN.seed }, async () => false, readsOf({ friends: [{ publicKey: THEM }], conversations: [dm('c1')] }));
        expect(await letIn(THEM)).toBe(true);
        expect(await letIn(THEM)).toBe(true);
        expect(reads).toEqual({ conversations: 1, friends: 1, deals: 1, payments: 1 });
        // Someone no fact names: their chat's lines (none with them), then the contacts, each once.
        expect(await letIn(OTHER)).toBe(false);
        expect(await letIn(OTHER)).toBe(false);
        expect(reads).toEqual({ conversations: 1, friends: 1, deals: 1, payments: 1, contacts: 1 });
    });

    it('a chat\'s lines are read once a round, only for a chat with the person asked about', async () => {
        const letIn = letInOnWeb({ publicKey: ME, privateKey: BEN.seed }, async () => false, readsOf({ conversations: [dm('c1'), dm('c2', { participants: [ME, OTHER] })], lines: { c1: [line(ME)] } }));
        expect(await letIn(THEM)).toBe(true);
        expect(await letIn(THEM)).toBe(true);
        expect(reads.lines).toBe(1);
        expect(reads.contacts).toBeUndefined();
    });

    it('a blocked sender is not read about at all; nor the member themselves', async () => {
        const letIn = letInOnWeb({ publicKey: ME, privateKey: BEN.seed }, async (k) => k === THEM, readsOf({ friends: [{ publicKey: THEM }] }));
        expect(await letIn(THEM)).toBe(false);
        expect(await letIn(ME)).toBe(false);
        expect(reads).toEqual({});
    });
});

describe('through the real round: the web\'s across gate takes let in', () => {
    let ctx: OutsideMailContext;
    let blocked: Set<string>;

    beforeEach(async () => {
        server.held = []; server.receipts = [];
        vi.stubGlobal('indexedDB', memoryIndexedDB());
        vi.stubGlobal('IDBKeyRange', MemoryIDBKeyRange);
        await clearOutsideChats();
        localStorage.clear();
        setNodeApiUrl(B);
        resetAccountEpochForTest();
        blocked = new Set();
    });

    function contextLettingIn(facts: Facts): OutsideMailContext {
        const isBlocked = async (k: string) => blocked.has(k);
        return {
            nodeUrl: B, identity: { publicKey: ME, privateKey: BEN.seed, callsign: 'Ben' }, store: outsideChatStore(B), isBlocked,
            letIn: letInOnWeb({ publicKey: ME, privateKey: BEN.seed }, isBlocked, readsOf(facts)),
        };
    }

    async function heldLine(from: { seed: string; key: string }, memberHere = false) {
        const itemId = crypto.randomUUID();
        const payload = sealOutsideLine({ text: 'Hello from the hills', name: 'Sol', myEdPrivHex: from.seed, myKey: from.key, peerKey: ME, messageId: itemId });
        const envelope = await signRelayEnvelope({
            kind: 'dm-line', itemId, senderKey: from.key, senderHome: 'a.example', recipient: ME, recipientHome: 'b.example', at: Date.now(), payloadHash: relayPayloadHash(payload),
        }, ed25519Signer(hexToBytes(from.seed)));
        server.held.push({ kind: 'dm-line', envelope, payload, bytes: payload.length, receivedAt: Date.now(), ...(memberHere ? { memberHere: true } : {}) });
        return itemId;
    }

    const ROWS: Array<{ name: string; facts: Facts; door: boolean; block?: boolean; memberHere?: boolean; state: 'open' | 'request' | null; receipted: boolean }> = [
        { name: 'let in (a friend), door closed', facts: { friends: [{ publicKey: THEM }] }, door: false, state: 'open', receipted: true },
        { name: 'let in (a chat they wrote in here), door open', facts: { conversations: [dm('c1')], lines: { c1: [line(ME)] } }, door: true, state: 'open', receipted: true },
        { name: 'let in, and the member-here mark too: let in decides, receipted now', facts: { payments: [{ from: ME, to: THEM }] }, door: false, memberHere: true, state: 'open', receipted: true },
        { name: 'let in but blocked here', facts: { friends: [{ publicKey: THEM }] }, door: true, block: true, state: null, receipted: false },
        { name: 'a stranger, door closed', facts: {}, door: false, state: null, receipted: false },
        { name: 'a stranger, door open: a request', facts: {}, door: true, state: 'request', receipted: true },
        { name: 'only they paid the member, door closed', facts: { payments: [{ from: THEM, to: ME }] }, door: false, state: null, receipted: false },
    ];
    for (const row of ROWS) {
        it(`${row.name} -> ${row.state ?? 'dropped'}${row.receipted ? ', receipted' : ''}`, async () => {
            const ctx = contextLettingIn(row.facts);
            await ctx.store.setMeta(ME, 'home', `b.example ${Date.now()} ${B}`);
            await setDoor(ctx, row.door);
            if (row.block) blocked.add(THEM);
            const id = await heldLine(SOL, row.memberHere);
            await syncOutsideMail(ctx);
            const chat = await ctx.store.chat(ME, relayConversationId(ME, THEM));
            expect(chat?.state ?? null).toBe(row.state);
            expect(server.receipts.filter((r) => r.to === THEM).flatMap((r) => r.ids).includes(id)).toBe(row.receipted);
        });
    }

    it('a line in a chat already here never asks let in', async () => {
        ctx = contextLettingIn({ friends: [{ publicKey: THEM }] });
        await ctx.store.setMeta(ME, 'home', `b.example ${Date.now()} ${B}`);
        await setDoor(ctx, true);
        await heldLine(SOL);
        await syncOutsideMail(ctx);
        expect(reads.conversations).toBe(1);
        // A new round (its own reader): the chat is here now, so nothing is read for let in.
        reads = {};
        const next = contextLettingIn({ friends: [{ publicKey: THEM }] });
        await heldLine(SOL);
        await syncOutsideMail(next);
        expect(reads).toEqual({});
        expect((await next.store.chat(ME, relayConversationId(ME, THEM)))?.state).toBe('open');
    });
});

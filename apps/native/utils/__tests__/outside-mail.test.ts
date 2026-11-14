/**
 * The phone's half of messages across communities (utils/outside-mail.ts, utils/outside-chat-store.ts; slice X3), against a
 * mailbox played here as the server's routes answer (apps/server/src/routes/relay.ts) and the store on real SQL (node:sqlite,
 * with the tables exactly as utils/db.ts makes them).
 *
 *   1  confirm after write: an item is written to the phone before its confirm is sent, and receipted to its sender's home
 *   2  a write that fails is never confirmed: the item waits at the server and is written at the next round
 *   3  the request gate, one table over every case (outside-chat-store.ts gateIncoming)
 *   4  the gate through a round: door closed, a stranger's first line, their second, a blob, Accept, Decline, Block
 *   5  a line that doesn't open as its envelope's is dropped (confirmed, never written, never receipted)
 *   6  send: written as `sending` first; the server's state after; unreached, sent again at the next round, the same item
 *   7  ticks: Delivered on my line; a phone restored from 12 words gets the chat back empty and `restored`
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from 'node:crypto';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
    checkRelayItem, ed25519Signer, relayConversationId, relayPayloadHash, sealOutsideLine, signRelayEnvelope, type RelayItem,
} from '@beanpool/core';

/** As the mailbox reads a receipt (apps/server/src/engine/relay-mail.ts readReceiptPayload): {"v":1,"items":[ids]}. */
const readReceiptPayloadForTests = (payload: string): string[] | null => {
    const o = JSON.parse(payload);
    return o?.v === 1 && Array.isArray(o.items) ? o.items : null;
};

const server = vi.hoisted(() => ({
    held: [] as any[],
    outbox: [] as any[],
    calls: [] as string[],
    sent: [] as any[],
    confirmed: [] as string[][],
    sendFails: false,
    sendState: 'sent' as string,
}));

vi.mock('../node-post', () => ({
    signedGet: vi.fn(async (_url: string, path: string) => {
        server.calls.push(`GET ${path.split('?')[0]}`);
        return new Response(JSON.stringify({ items: server.held.slice(0, 50), more: false, outbox: server.outbox, outboxMore: false }), { status: 200 });
    }),
    signedPost: vi.fn(async (_url: string, path: string, body: any) => {
        server.calls.push(`POST ${path}`);
        if (path === '/api/mail/confirm') {
            server.confirmed.push(body.ids);
            const before = server.held.length;
            server.held = server.held.filter((h) => !body.ids.includes(h.envelope.itemId));
            return new Response(JSON.stringify({ confirmed: before - server.held.length }), { status: 200 });
        }
        if (path === '/api/mail/send') {
            if (server.sendFails) throw new TypeError('Network request failed');
            server.sent.push(...body.items);
            return new Response(JSON.stringify({ items: body.items.map((i: RelayItem) => ({ itemId: i.envelope.itemId, state: server.sendState })) }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
    }),
}));

// The member's statements as core signs them, without the phone's native modules (the e2e test signs through the real ones).
vi.mock('../member-statements', async () => {
    const core = await import('@beanpool/core');
    const toKey = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
    return {
        signRelayEnvelopeStatement: (f: any, k: string) => core.signRelayEnvelope(f, core.ed25519Signer(toKey(k))),
        signAddressCardStatement: (c: any, k: string) => core.signAddressCard(c, core.ed25519Signer(toKey(k))),
    };
});

import { outsideChatStore, gateIncoming, OUTSIDE_CHAT_TABLES_SQL, type OutsideChatState } from '../outside-chat-store';
import { syncOutsideMail, sendOutsideLine, setDoor, type OutsideMailContext } from '../outside-mail';

const seedKey = () => { const seed = randomBytes(32); return { seed: bytesToHex(seed), key: bytesToHex(ed25519.getPublicKey(seed)) }; };
const BEN = seedKey(), ANA = seedKey(), SOL = seedKey(), CY = seedKey();
const HOME = 'b.example', ANA_HOME = 'a.example';
const uuid = () => { const b = randomBytes(16); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80; const h = b.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };

/** The SQL the phone runs, on node:sqlite, as the store's async interface. */
function sqlStore() {
    const sql = new DatabaseSync(':memory:');
    sql.exec(OUTSIDE_CHAT_TABLES_SQL);
    const db = {
        getAllAsync: async (q: string, p: any[] = []) => sql.prepare(q).all(...p) as any[],
        getFirstAsync: async (q: string, p: any[] = []) => (sql.prepare(q).get(...p) as any) ?? null,
        runAsync: async (q: string, p: any[] = []) => sql.prepare(q).run(...p),
    };
    return { sql, db, store: outsideChatStore(async () => db as any) };
}

let ctx: OutsideMailContext;
let sql: DatabaseSync;
let blocked: Set<string>;

beforeEach(async () => {
    server.held = []; server.outbox = []; server.calls = []; server.sent = []; server.confirmed = []; server.sendFails = false; server.sendState = 'sent';
    const s = sqlStore();
    sql = s.sql;
    blocked = new Set();
    ctx = { nodeUrl: 'https://127.0.0.1:1', identity: { publicKey: BEN.key, privateKey: BEN.seed, callsign: 'Ben' }, store: s.store, isBlocked: async (k) => blocked.has(k) };
    await s.store.setMeta('home', HOME);
});

/** A line `from` writes Ben, as their phone seals it and their server brings it: held for Ben. */
async function heldLine(from: { seed: string; key: string }, text: string, opts: { kind?: string; sealer?: { seed: string; key: string } } = {}) {
    const itemId = uuid();
    const sealer = opts.sealer ?? from;
    const payload = sealOutsideLine({ text, name: 'Ana Ríos', myEdPrivHex: sealer.seed, myKey: sealer.key, peerKey: BEN.key, messageId: itemId });
    const envelope = await signRelayEnvelope({
        kind: (opts.kind ?? 'dm-line') as any, itemId, senderKey: from.key, senderHome: ANA_HOME, recipient: BEN.key, recipientHome: HOME,
        at: Date.now(), payloadHash: relayPayloadHash(payload),
    }, ed25519Signer(Buffer.from(from.seed, 'hex')));
    const item = { kind: envelope.kind, envelope, payload: opts.kind === 'dm-blob' ? null : payload, bytes: payload.length, receivedAt: Date.now() };
    server.held.push(item);
    return item;
}

const lineRows = () => sql.prepare('SELECT id, author, text, state FROM outside_lines ORDER BY at').all() as any[];
const chatOf = (key: string) => sql.prepare('SELECT state, restored, peer_home, peer_name FROM outside_chats WHERE peer_key = ?').get(key) as any;

describe('1  confirm after write', () => {
    it('writes the line on the phone before it confirms it, then receipts it to its sender\'s home', async () => {
        await ctx.store.openChat(BEN.key, relayConversationId(BEN.key, ANA.key), { key: ANA.key, home: ANA_HOME, name: 'Ana' });
        const item = await heldLine(ANA, 'Hello from Riverside');
        const writes: string[] = [];
        const realWrite = ctx.store.writeTheirs;
        ctx.store.writeTheirs = async (...a) => { writes.push(`write ${a[1].id} after ${server.calls.length} calls`); await realWrite(...a); };
        const out = await syncOutsideMail(ctx);
        expect(out).toMatchObject({ written: 1, confirmed: 1 });
        expect(lineRows()).toEqual([{ id: item.envelope.itemId, author: ANA.key, text: 'Hello from Riverside', state: null }]);
        // The write came after the fetch and before the confirm.
        expect(writes).toEqual([`write ${item.envelope.itemId} after 1 calls`]);
        expect(server.calls.slice(0, 2)).toEqual(['GET /api/mail', 'POST /api/mail/confirm']);
        expect(server.confirmed).toEqual([[item.envelope.itemId]]);
        // The receipt: Ben's envelope to Ana at her home, its payload the id, signed by Ben, as the mailbox checks it.
        const receipt = server.sent.find((i) => i.envelope.kind === 'receipt');
        expect(receipt.envelope).toMatchObject({ senderKey: BEN.key, senderHome: HOME, recipient: ANA.key, recipientHome: ANA_HOME });
        expect(readReceiptPayloadForTests(receipt.payload)).toEqual([item.envelope.itemId]);
        expect(checkRelayItem(receipt, { signedBy: HOME, isHere: (h) => h === ANA_HOME }).ok).toBe(true);
    });
});

describe('2  a write that fails is never confirmed', () => {
    it('leaves the item at the server, and writes and confirms it at the next round', async () => {
        await ctx.store.openChat(BEN.key, relayConversationId(BEN.key, ANA.key), { key: ANA.key, home: ANA_HOME, name: 'Ana' });
        const item = await heldLine(ANA, 'Kept until written');
        const realWrite = ctx.store.writeTheirs;
        ctx.store.writeTheirs = async () => { throw new Error('database or disk is full'); };
        const first = await syncOutsideMail(ctx);
        expect(first.confirmed).toBe(0);
        expect(server.confirmed).toEqual([]);
        expect(server.sent.filter((i) => i.envelope.kind === 'receipt')).toEqual([]);
        expect(server.held.map((h) => h.envelope.itemId)).toEqual([item.envelope.itemId]);
        ctx.store.writeTheirs = realWrite;
        const second = await syncOutsideMail(ctx);
        expect(second).toMatchObject({ written: 1, confirmed: 1 });
        expect(lineRows().map((r) => r.text)).toEqual(['Kept until written']);
        expect(server.held).toEqual([]);
    });

    it('a line written but never confirmed (the phone stopped between) is confirmed and receipted again, written once', async () => {
        await ctx.store.openChat(BEN.key, relayConversationId(BEN.key, ANA.key), { key: ANA.key, home: ANA_HOME, name: 'Ana' });
        const item = await heldLine(ANA, 'Once');
        const chatId = relayConversationId(BEN.key, ANA.key);
        await ctx.store.writeTheirs(BEN.key, { id: item.envelope.itemId, chatId, author: ANA.key, text: 'Once', replyTo: null, at: item.envelope.at, sealed: '{}' }, { home: ANA_HOME, name: null }, 'line');
        await syncOutsideMail(ctx);
        expect(lineRows()).toHaveLength(1);
        expect(server.confirmed).toEqual([[item.envelope.itemId]]);
        expect(server.sent.filter((i) => i.envelope.kind === 'receipt')).toHaveLength(1);
    });
});

describe('3  the request gate, every case', () => {
    const kinds = ['dm-line', 'dm-blob', 'dm-delete', 'group-line'];
    const chats: Array<{ state: OutsideChatState; theirLines: number } | null> = [
        null, { state: 'request', theirLines: 0 }, { state: 'request', theirLines: 1 }, { state: 'open', theirLines: 0 }, { state: 'open', theirLines: 5 },
        { state: 'declined', theirLines: 1 },
    ];
    /** The rule in words: blocked never; an open chat takes lines; a stranger, one line, words only, through an open door. */
    const expected = (kind: string, chat: typeof chats[number], doorOpen: boolean, isBlocked: boolean) => {
        if (isBlocked) return 'drop';
        if (chat?.state === 'open') return kind === 'dm-line' ? 'line' : 'drop';
        if (kind !== 'dm-line' || chat?.state === 'declined') return 'drop';
        if (chat?.state === 'request') return chat.theirLines === 0 ? 'request' : 'drop';
        return doorOpen ? 'request' : 'drop';
    };
    for (const kind of kinds) for (const chat of chats) for (const doorOpen of [false, true]) for (const isBlocked of [false, true]) {
        const want = expected(kind, chat, doorOpen, isBlocked);
        it(`${kind}, chat ${chat ? `${chat.state}/${chat.theirLines}` : 'none'}, door ${doorOpen ? 'open' : 'closed'}${isBlocked ? ', blocked' : ''}: ${want}`, () => {
            expect(gateIncoming({ kind, chat, doorOpen, blocked: isBlocked })).toBe(want);
        });
    }
    it('no voice, no photo, no delete, ever, from someone not accepted (design §3.5)', () => {
        for (const kind of ['dm-blob', 'dm-delete', 'call-signal']) for (const doorOpen of [true, false]) {
            expect(gateIncoming({ kind, chat: null, doorOpen, blocked: false })).toBe('drop');
            expect(gateIncoming({ kind, chat: { state: 'request', theirLines: 0 }, doorOpen, blocked: false })).toBe('drop');
        }
    });
});

describe('4  the gate through a round', () => {
    it('door closed: a stranger\'s line is dropped and confirmed, nothing kept, no receipt', async () => {
        const item = await heldLine(SOL, 'Hi, stranger here');
        const out = await syncOutsideMail(ctx);
        expect(out).toMatchObject({ requests: 0, written: 0, dropped: 1, confirmed: 1 });
        expect(lineRows()).toEqual([]);
        expect(chatOf(SOL.key)).toBeUndefined();
        expect(server.confirmed).toEqual([[item.envelope.itemId]]);
        expect(server.sent).toEqual([]);
    });

    it('door open: the first line waits as a request; the second and a blob are dropped; Accept lets the next one in', async () => {
        await setDoor(ctx.store, true);
        await heldLine(SOL, 'May I ask about the bikes?');
        await syncOutsideMail(ctx);
        expect(chatOf(SOL.key)).toMatchObject({ state: 'request', restored: 0, peer_home: ANA_HOME, peer_name: 'Ana Ríos' });
        expect(server.sent.filter((i) => i.envelope.kind === 'receipt')).toHaveLength(1);
        await heldLine(SOL, 'Hello??');
        await heldLine(SOL, 'a photo', { kind: 'dm-blob' });
        const second = await syncOutsideMail(ctx);
        expect(second).toMatchObject({ requests: 0, written: 0, dropped: 2, confirmed: 2 });
        expect(lineRows().map((r) => r.text)).toEqual(['May I ask about the bikes?']);
        const chatId = relayConversationId(BEN.key, SOL.key);
        expect((await ctx.store.chats(BEN.key, 'request')).map((c) => c.id)).toEqual([chatId]);
        await ctx.store.decide(BEN.key, chatId, 'open');
        await heldLine(SOL, 'Thanks for accepting');
        expect(await syncOutsideMail(ctx)).toMatchObject({ written: 1 });
        expect(lineRows().map((r) => r.text)).toEqual(['May I ask about the bikes?', 'Thanks for accepting']);
    });

    it('declined, then blocked: nothing more from them is kept', async () => {
        await setDoor(ctx.store, true);
        await heldLine(SOL, 'First');
        await syncOutsideMail(ctx);
        await ctx.store.decide(BEN.key, relayConversationId(BEN.key, SOL.key), 'declined');
        await heldLine(SOL, 'After decline');
        expect(await syncOutsideMail(ctx)).toMatchObject({ dropped: 1, written: 0, requests: 0 });
        await ctx.store.openChat(BEN.key, relayConversationId(BEN.key, CY.key), { key: CY.key, home: ANA_HOME, name: 'Cy' });
        blocked.add(CY.key);
        await heldLine(CY, 'Blocked one');
        expect(await syncOutsideMail(ctx)).toMatchObject({ dropped: 1, written: 0 });
        expect(lineRows().map((r) => r.text)).toEqual(['First']);
    });
});

describe('5  a line that is not its envelope\'s', () => {
    it('Cy\'s seal in Ana\'s envelope, a changed payload, an envelope to someone else: dropped and confirmed, never shown', async () => {
        await ctx.store.openChat(BEN.key, relayConversationId(BEN.key, ANA.key), { key: ANA.key, home: ANA_HOME, name: 'Ana' });
        await heldLine(ANA, 'Not Ana', { sealer: CY });
        const changed = await heldLine(ANA, 'Changed');
        changed.payload = String(changed.payload).replace(/"c":"./, '"c":"A');
        const other = await heldLine(ANA, 'For Cy');
        other.envelope = { ...other.envelope, recipient: CY.key };
        const out = await syncOutsideMail(ctx);
        expect(out).toMatchObject({ written: 0, dropped: 3, confirmed: 3 });
        expect(server.held).toEqual([]);
        expect(lineRows()).toEqual([]);
        expect(server.sent).toEqual([]);
    });
});

describe('6  send', () => {
    it('shows the line as sending first, then the server\'s state; unreached, it goes again at the next round, the same item', async () => {
        const chatId = relayConversationId(BEN.key, ANA.key);
        await ctx.store.openChat(BEN.key, chatId, { key: ANA.key, home: ANA_HOME, name: 'Ana' });
        server.sendFails = true;
        await expect(sendOutsideLine(ctx, chatId, 'Are the bikes still there?')).rejects.toThrow();
        expect(lineRows().map((r) => [r.text, r.state])).toEqual([['Are the bikes still there?', 'sending']]);
        server.sendFails = false;
        server.sendState = 'queued';
        await syncOutsideMail(ctx);
        expect(server.sent).toHaveLength(1);
        const sent = server.sent[0];
        expect(sent.envelope).toMatchObject({ kind: 'dm-line', senderKey: BEN.key, senderHome: HOME, recipient: ANA.key, recipientHome: ANA_HOME });
        expect(checkRelayItem(sent, { signedBy: HOME, isHere: (h) => h === ANA_HOME }).ok).toBe(true);
        expect(lineRows()[0].state).toBe('queued');
        expect(sql.prepare('SELECT item FROM outside_lines').get()).toEqual({ item: null });
        // Taken: not sent again.
        await syncOutsideMail(ctx);
        expect(server.sent).toHaveLength(1);
    });

    it('a request waiting for me can\'t be answered until Accept', async () => {
        await setDoor(ctx.store, true);
        await heldLine(SOL, 'Hello');
        await syncOutsideMail(ctx);
        await expect(sendOutsideLine(ctx, relayConversationId(BEN.key, SOL.key), 'Reply')).rejects.toThrow('Accept the request first.');
    });
});

describe('7  ticks', () => {
    it('Delivered on my line; the cursor moves past the ticks read', async () => {
        const chatId = relayConversationId(BEN.key, ANA.key);
        await ctx.store.openChat(BEN.key, chatId, { key: ANA.key, home: ANA_HOME, name: 'Ana' });
        await sendOutsideLine(ctx, chatId, 'Hello Ana');
        const id = lineRows()[0].id;
        server.outbox = [{ itemId: id, kind: 'dm-line', recipient: ANA.key, recipientHome: ANA_HOME, state: 'delivered', at: 1763020900000 }];
        await syncOutsideMail(ctx);
        expect(lineRows()[0].state).toBe('delivered');
        expect(await ctx.store.getMeta('outbox-cursor')).toBe(`1763020900000:${id}`);
    });

    it('restored from 12 words: a chat written to from the old phone comes back empty, open and restored', async () => {
        server.outbox = [{ itemId: uuid(), kind: 'dm-line', recipient: ANA.key, recipientHome: ANA_HOME, state: 'delivered', at: 1763020900000 }];
        await syncOutsideMail(ctx);
        expect(chatOf(ANA.key)).toMatchObject({ state: 'open', restored: 1, peer_home: ANA_HOME });
        expect(lineRows()).toEqual([]);
        // Her next line goes straight into it, never behind the requests row: Ben wrote to her.
        await heldLine(ANA, 'Did you get my last one?');
        expect(await syncOutsideMail(ctx)).toMatchObject({ written: 1, requests: 0 });
    });
});

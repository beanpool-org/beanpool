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
 *   9  a resend my server refuses: the refused line fails with its words, the others still go; a 403 fails them all
 *  10  every request of a round carries the round's deadline, and an aborted round stops at its next request
 *  11  a receipt outlives the round: one table over every point a round can stop x how it stops; afterwards every line is
 *      written once, confirmed, and receipted to its sender's home, and nothing is left owed
 *  12  owed receipts: one per line, a refused one tried again behind the rest, none kept past 30 days, 200 ids a round at most
 *  13  typed words are never lost on a failed send: in the box, or kept as the line with its state
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
    /** The batches /api/mail/send was posted, by their items' ids. */
    batches: [] as string[][],
    /** An item the server refuses, as relay-outbox.ts sendRelayItems does: the whole request answered with the first problem. */
    refuse: null as null | ((item: RelayItem) => { status: number; error: string; code: string } | null),
    /** Every request's signal, by its path. */
    signals: [] as Array<{ path: string; signal: AbortSignal | undefined }>,
    /** A GET that never answers until its signal aborts (React Native's fetch never gives up by itself). */
    stallGet: false,
    /** A send that never answers until its signal aborts. */
    stallSend: false,
    /**
     * Where a round stops (test 11): the nth confirm or the nth receipt, before my server takes it or after (its answer lost),
     * and how: the round's deadline, the network dropped, the app killed (the request never settles, nothing after it runs),
     * or my server answering no (403, 400) or busy (503).
     */
    stop: null as null | { at: 'confirm' | 'receipt'; nth: number; taken: boolean; how: string },
    seen: { confirm: 0, receipt: 0 },
    stopped: false,
    /** The round's deadline, which a `deadline` stop fires. */
    deadline: null as null | AbortController,
    /** Every receipt posted, taken or not: to whom, at which home, naming which ids. */
    receiptTries: [] as Array<{ to: string; ids: string[] }>,
}));

/** A stop the round meets (test 11): throws, never settles, or my server's answer. */
function stopHere(how: string): Promise<Response> | Response {
    server.stopped = true;
    if (how === 'deadline') { server.deadline?.abort(); throw new DOMException('Aborted', 'AbortError'); }
    if (how === 'network') throw new TypeError('Network request failed');
    if (how === 'killed') return new Promise<Response>(() => {});
    const status = Number(how.split('-')[1]);
    return new Response(JSON.stringify({ error: `No (${status}).`, code: 'no' }), { status });
}

vi.mock('../node-post', () => ({
    signedGet: vi.fn(async (_url: string, path: string, _identity: unknown, signal?: AbortSignal) => {
        server.calls.push(`GET ${path.split('?')[0]}`);
        server.signals.push({ path: path.split('?')[0], signal });
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (server.stallGet) {
            await new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
        }
        return new Response(JSON.stringify({ items: server.held.slice(0, 50), more: false, outbox: server.outbox, outboxMore: false }), { status: 200 });
    }),
    signedPost: vi.fn(async (_url: string, path: string, body: any, _identity: unknown, signal?: AbortSignal) => {
        server.calls.push(`POST ${path}`);
        server.signals.push({ path, signal });
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const isReceipt = path === '/api/mail/send' && body.items?.[0]?.envelope?.kind === 'receipt';
        if (isReceipt) {
            const r = body.items[0];
            server.receiptTries.push({ to: `${r.envelope.recipient}@${r.envelope.recipientHome}`, ids: readReceiptPayloadForTests(r.payload) ?? [] });
        }
        const at = path === '/api/mail/confirm' ? 'confirm' : isReceipt ? 'receipt' : null;
        const stop = at && server.stop?.at === at && ++server.seen[at] === server.stop.nth ? server.stop : null;
        if (stop && !stop.taken) return stopHere(stop.how);
        let answer: Response;
        if (path === '/api/mail/confirm') {
            server.confirmed.push(body.ids);
            const before = server.held.length;
            server.held = server.held.filter((h) => !body.ids.includes(h.envelope.itemId));
            answer = new Response(JSON.stringify({ confirmed: before - server.held.length }), { status: 200 });
        } else if (path === '/api/mail/send') {
            if (server.sendFails) throw new TypeError('Network request failed');
            if (server.stallSend) {
                await new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
            }
            server.batches.push(body.items.map((i: RelayItem) => i.envelope.itemId));
            for (const i of body.items) {
                const problem = server.refuse?.(i);
                if (problem) return new Response(JSON.stringify({ error: problem.error, code: problem.code }), { status: problem.status });
            }
            server.sent.push(...body.items);
            answer = new Response(JSON.stringify({ items: body.items.map((i: RelayItem) => ({ itemId: i.envelope.itemId, state: server.sendState })) }), { status: 200 });
        } else {
            return new Response('{}', { status: 404 });
        }
        // Taken, then the answer lost.
        if (stop) return stopHere(stop.how);
        return answer;
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
import { failUnsent, myHome, syncOutsideMail, sendFromBox, sendOutsideLine, setDoor, type OutsideMailContext } from '../outside-mail';

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
    server.batches = []; server.refuse = null; server.signals = []; server.stallGet = false; server.stallSend = false;
    server.stop = null; server.seen = { confirm: 0, receipt: 0 }; server.stopped = false; server.deadline = null; server.receiptTries = [];
    const s = sqlStore();
    sql = s.sql;
    blocked = new Set();
    ctx = { nodeUrl: 'https://127.0.0.1:1', identity: { publicKey: BEN.key, privateKey: BEN.seed, callsign: 'Ben' }, store: s.store, isBlocked: async (k) => blocked.has(k) };
    await s.store.setMeta('home', `${HOME} ${Date.now()}`);
});

/** A line `from` writes Ben, as their phone seals it and their server brings it: held for Ben. */
async function heldLine(from: { seed: string; key: string }, text: string, opts: { kind?: string; sealer?: { seed: string; key: string }; home?: string } = {}) {
    const itemId = uuid();
    const sealer = opts.sealer ?? from;
    const payload = sealOutsideLine({ text, name: 'Ana Ríos', myEdPrivHex: sealer.seed, myKey: sealer.key, peerKey: BEN.key, messageId: itemId });
    const envelope = await signRelayEnvelope({
        kind: (opts.kind ?? 'dm-line') as any, itemId, senderKey: from.key, senderHome: opts.home ?? ANA_HOME, recipient: BEN.key, recipientHome: HOME,
        at: Date.now(), payloadHash: relayPayloadHash(payload),
    }, ed25519Signer(Buffer.from(from.seed, 'hex')));
    const item = { kind: envelope.kind, envelope, payload: opts.kind === 'dm-blob' ? null : payload, bytes: payload.length, receivedAt: Date.now() };
    server.held.push(item);
    return item;
}

const lineRows = () => sql.prepare('SELECT id, author, text, state FROM outside_lines ORDER BY at').all() as any[];
const noteOf = (text: string) => ({ ...(sql.prepare('SELECT state, note, item IS NOT NULL AS kept FROM outside_lines WHERE text = ?').get(text) as any) });
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

describe('8  my home', () => {
    it('is read again from the community after an hour: one that moved to a new address names its new home', async () => {
        const realFetch = globalThis.fetch;
        const asked: string[] = [];
        globalThis.fetch = (async (url: string) => {
            asked.push(String(url));
            return new Response(JSON.stringify({ primaryAddress: 'coop.example.org' }), { status: 200 });
        }) as any;
        try {
            expect(await myHome(ctx)).toBe(HOME);
            expect(asked).toEqual([]);
            expect(await myHome(ctx, Date.now() + 61 * 60_000)).toBe('coop.example.org');
            expect(asked).toEqual(['https://127.0.0.1:1/api/community/info']);
            // Unreachable: the home read before.
            globalThis.fetch = (async () => { throw new TypeError('Network request failed'); }) as any;
            expect(await myHome(ctx, Date.now() + 3 * 60 * 60_000)).toBe('coop.example.org');
        } finally {
            globalThis.fetch = realFetch;
        }
    });
});

describe('9  a resend my server refuses', () => {
    const OUTSIDE_OFF = "This community doesn't take messages from other communities.";
    /** Ben's lines written while his server couldn't be reached: each `sending`, its signed item kept. */
    async function unsentLines(texts: string[]) {
        const chatId = relayConversationId(BEN.key, ANA.key);
        await ctx.store.openChat(BEN.key, chatId, { key: ANA.key, home: ANA_HOME, name: 'Ana' });
        server.sendFails = true;
        // Apart in time, so the oldest is first in every batch (unsent() reads ORDER BY at).
        for (const text of texts) {
            await expect(sendOutsideLine(ctx, chatId, text)).rejects.toThrow();
            await new Promise((r) => setTimeout(r, 2));
        }
        server.sendFails = false;
        expect(lineRows().map((r) => r.state)).toEqual(texts.map(() => 'sending'));
        return chatId;
    }
    const idOf = (text: string) => lineRows().find((r) => r.text === text)!.id;

    it('one refused line (signed under the old home) fails with its words; the lines behind it still go', async () => {
        await unsentLines(['Old home', 'Second', 'Third']);
        const bad = idOf('Old home');
        const words = "An item sent from here names this community's server as its sender's home.";
        server.refuse = (i) => (i.envelope.itemId === bad ? { status: 400, error: words, code: 'bad_item' } : null);
        await syncOutsideMail(ctx);
        expect(noteOf('Old home')).toEqual({ state: 'failed', note: words, kept: 0 });
        expect(noteOf('Second')).toMatchObject({ state: 'sent', note: null });
        expect(noteOf('Third')).toMatchObject({ state: 'sent', note: null });
        expect(server.sent.map((i) => i.envelope.itemId)).toEqual([idOf('Second'), idOf('Third')]);
        // The next round sends nothing again: none is left `sending`.
        const batches = server.batches.length;
        await syncOutsideMail(ctx);
        expect(server.batches.length).toBe(batches);
        expect((await ctx.store.lines(relayConversationId(BEN.key, ANA.key))).find((l) => l.id === bad)?.note).toBe(words);
    });

    it('a 403 (the owner switched outside messages off) fails every waiting line with the server\'s words, in one request', async () => {
        await unsentLines(['One', 'Two']);
        server.refuse = () => ({ status: 403, error: OUTSIDE_OFF, code: 'outside_messages_off' });
        await syncOutsideMail(ctx);
        expect([noteOf('One'), noteOf('Two')]).toEqual([{ state: 'failed', note: OUTSIDE_OFF, kept: 0 }, { state: 'failed', note: OUTSIDE_OFF, kept: 0 }]);
        expect(server.batches).toHaveLength(1);
    });

    it('a 429, a 5xx or no answer is not a refusal: the lines stay `sending` and go at a later round', async () => {
        await unsentLines(['Wait']);
        for (const status of [429, 503]) {
            server.refuse = () => ({ status, error: 'later', code: 'rate_limited' });
            await syncOutsideMail(ctx);
            expect(noteOf('Wait'), String(status)).toEqual({ state: 'sending', note: null, kept: 1 });
        }
        server.refuse = null;
        await syncOutsideMail(ctx);
        expect(noteOf('Wait')).toMatchObject({ state: 'sent' });
    });

    it('sendOutsideLine keeps the refusal\'s words on the line too', async () => {
        const chatId = relayConversationId(BEN.key, ANA.key);
        await ctx.store.openChat(BEN.key, chatId, { key: ANA.key, home: ANA_HOME, name: 'Ana' });
        server.refuse = () => ({ status: 403, error: OUTSIDE_OFF, code: 'outside_messages_off' });
        await expect(sendOutsideLine(ctx, chatId, 'Refused at once')).rejects.toThrow(OUTSIDE_OFF);
        expect(noteOf('Refused at once')).toEqual({ state: 'failed', note: OUTSIDE_OFF, kept: 0 });
    });

    it('failUnsent (the phone reads the switch off, so no round asks): every waiting line fails with the words given', async () => {
        await unsentLines(['Held one', 'Held two']);
        await failUnsent(ctx, OUTSIDE_OFF);
        expect([noteOf('Held one'), noteOf('Held two')]).toEqual([{ state: 'failed', note: OUTSIDE_OFF, kept: 0 }, { state: 'failed', note: OUTSIDE_OFF, kept: 0 }]);
        expect(server.batches).toEqual([]);
    });
});

describe('10  a round\'s deadline', () => {
    it('every request of the round carries the round\'s signal', async () => {
        const chatId = relayConversationId(BEN.key, ANA.key);
        await ctx.store.openChat(BEN.key, chatId, { key: ANA.key, home: ANA_HOME, name: 'Ana' });
        server.sendFails = true;
        await expect(sendOutsideLine(ctx, chatId, 'Unsent')).rejects.toThrow();
        server.sendFails = false;
        await heldLine(ANA, 'Hello');
        server.signals = [];
        const controller = new AbortController();
        await syncOutsideMail({ ...ctx, signal: controller.signal });
        // Resend, fetch, confirm, receipt: each one bounded by the round.
        expect(server.signals.map((s) => s.path)).toEqual(['/api/mail/send', '/api/mail', '/api/mail/confirm', '/api/mail/send']);
        expect(server.signals.every((s) => s.signal === controller.signal)).toBe(true);
    });

    it('my home\'s read from the community carries it too', async () => {
        const realFetch = globalThis.fetch;
        const seen: Array<AbortSignal | undefined> = [];
        globalThis.fetch = (async (_url: string, init?: RequestInit) => {
            seen.push(init?.signal ?? undefined);
            return new Response(JSON.stringify({ primaryAddress: HOME }), { status: 200 });
        }) as any;
        try {
            const controller = new AbortController();
            await myHome({ ...ctx, signal: controller.signal }, Date.now() + 2 * 60 * 60_000);
            expect(seen).toEqual([controller.signal]);
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    it('a stalled fetch ends when the deadline aborts the round: it throws, nothing is confirmed, and the next round runs', async () => {
        await ctx.store.openChat(BEN.key, relayConversationId(BEN.key, ANA.key), { key: ANA.key, home: ANA_HOME, name: 'Ana' });
        await heldLine(ANA, 'Waits for a good link');
        server.stallGet = true;
        const controller = new AbortController();
        const round = syncOutsideMail({ ...ctx, signal: controller.signal });
        setTimeout(() => controller.abort(), 20);
        await expect(round).rejects.toThrow(/abort/i);
        expect(server.confirmed).toEqual([]);
        server.stallGet = false;
        expect(await syncOutsideMail(ctx)).toMatchObject({ written: 1, confirmed: 1 });
    });
});

const DAY = 24 * 60 * 60_000;
const CY_HOME = 'c.example';
/** Each id a receipt my server TOOK named, and whom it went to: `<key>@<home>`. */
function receiptedTo(): Record<string, string[]> {
    const to: Record<string, string[]> = {};
    for (const i of server.sent.filter((s) => s.envelope.kind === 'receipt')) {
        for (const id of readReceiptPayloadForTests(i.payload) ?? []) to[id] = [...new Set([...(to[id] ?? []), `${i.envelope.recipient}@${i.envelope.recipientHome}`])];
    }
    return to;
}
/** The receipts this phone still owes. */
const owed = () => (sql.prepare('SELECT COUNT(*) AS n FROM outside_receipts').get() as any).n as number;
/** Lets a round that never settles (the app killed) reach its stop. */
const until = async (ok: () => boolean) => { for (let i = 0; i < 2000 && !ok(); i++) await new Promise((r) => setImmediate(r)); };
async function openWithAnaAndCy() {
    await ctx.store.openChat(BEN.key, relayConversationId(BEN.key, ANA.key), { key: ANA.key, home: ANA_HOME, name: 'Ana' });
    await ctx.store.openChat(BEN.key, relayConversationId(BEN.key, CY.key), { key: CY.key, home: CY_HOME, name: 'Cy' });
}

describe('11  a receipt outlives the round (PR #3168 review: "the receipts not yet sent are lost")', () => {
    // A page holds a line from Ana (a.example) and one from Cy (c.example): two receipts, one to each home.
    const POINTS = [
        { at: 'confirm', nth: 1, taken: false, what: 'the confirm, before my server deleted the page' },
        { at: 'confirm', nth: 1, taken: true, what: 'the confirm, after my server deleted the page (its answer lost)' },
        { at: 'receipt', nth: 1, taken: false, what: 'the first receipt, before my server took it' },
        { at: 'receipt', nth: 1, taken: true, what: 'the first receipt, after my server took it (its answer lost)' },
        { at: 'receipt', nth: 2, taken: false, what: 'the second receipt, the first one taken' },
        { at: 'receipt', nth: 2, taken: true, what: 'the second receipt, after my server took it (its answer lost)' },
    ] as const;
    /** How a round stops. Before my server takes a request it can also answer no, or be busy; after, only its answer is lost. */
    const BEFORE = ['deadline', 'network', 'killed', 'refused-403', 'refused-400', 'busy-503'];
    const AFTER = ['deadline', 'network', 'killed'];
    for (const point of POINTS) for (const how of point.taken ? AFTER : BEFORE) {
        it(`stopped at ${point.what}, by ${how}: both lines written once, confirmed, and receipted to their senders' homes`, async () => {
            await openWithAnaAndCy();
            const ana = await heldLine(ANA, 'From Ana');
            const cy = await heldLine(CY, 'From Cy', { home: CY_HOME });
            const controller = new AbortController();
            server.deadline = controller;
            server.stop = { ...point, how };
            const first = syncOutsideMail({ ...ctx, signal: controller.signal }).catch(() => null);
            // Killed: the round never goes on past its stop. Otherwise it ends, or throws.
            if (how === 'killed') await until(() => server.stopped); else await first;
            expect(server.stopped, 'the round reached its stop').toBe(true);
            server.stop = null;
            // The app back: the next rounds, each with its own deadline.
            for (let i = 0; i < 2; i++) await syncOutsideMail({ ...ctx, signal: new AbortController().signal });
            expect(lineRows().map((r) => r.text).sort()).toEqual(['From Ana', 'From Cy']);
            expect(server.held).toEqual([]);
            expect(receiptedTo()).toEqual({
                [ana.envelope.itemId]: [`${ANA.key}@${ANA_HOME}`],
                [cy.envelope.itemId]: [`${CY.key}@${CY_HOME}`],
            });
            expect(owed()).toBe(0);
        });
    }
});

describe('12  owed receipts: one per line, a refused one tried again behind the rest, none kept for ever', () => {
    it('a line fetched again (its confirm never answered) is owed once, and receipted once it can be', async () => {
        await ctx.store.openChat(BEN.key, relayConversationId(BEN.key, ANA.key), { key: ANA.key, home: ANA_HOME, name: 'Ana' });
        const a = await heldLine(ANA, 'Twice');
        for (const nth of [1, 2]) {
            server.stop = { at: 'confirm', nth, taken: false, how: 'network' };
            await syncOutsideMail(ctx).catch(() => null);
        }
        expect(server.confirmed).toEqual([]);
        expect(lineRows()).toHaveLength(1);
        expect(owed()).toBe(1);
        server.stop = null;
        await syncOutsideMail(ctx);
        expect(owed()).toBe(0);
        expect(receiptedTo()).toEqual({ [a.envelope.itemId]: [`${ANA.key}@${ANA_HOME}`] });
    });

    it('a receipt my server keeps refusing holds none of the others: they go first, and it is tried again at the next round', async () => {
        await openWithAnaAndCy();
        await heldLine(ANA, 'From Ana');
        await heldLine(CY, 'From Cy', { home: CY_HOME });
        server.refuse = (i) => (i.envelope.kind === 'receipt' && i.envelope.recipient === ANA.key ? { status: 400, error: 'No.', code: 'bad_item' } : null);
        await syncOutsideMail(ctx);
        expect(server.receiptTries.map((r) => r.to).sort()).toEqual([`${ANA.key}@${ANA_HOME}`, `${CY.key}@${CY_HOME}`].sort());
        expect(owed()).toBe(1);
        // A new line from Cy: its receipt goes before Ana's is tried again.
        server.receiptTries = [];
        await heldLine(CY, 'Again from Cy', { home: CY_HOME });
        await syncOutsideMail(ctx);
        expect(server.receiptTries.map((r) => r.to)).toEqual([`${CY.key}@${CY_HOME}`, `${ANA.key}@${ANA_HOME}`]);
        expect(owed()).toBe(1);
        server.refuse = null;
        await syncOutsideMail(ctx);
        expect(owed()).toBe(0);
        expect(Object.values(receiptedTo()).flat().filter((to) => to.startsWith(ANA.key))).toHaveLength(1);
    });

    it('a receipt owed for more than 30 days goes unsent: its sender\'s server settled that line long ago', async () => {
        const now = Date.now();
        await ctx.store.oweReceipt(BEN.key, { id: uuid(), key: ANA.key, home: ANA_HOME }, now - 31 * DAY);
        const fresh = uuid();
        await ctx.store.oweReceipt(BEN.key, { id: fresh, key: ANA.key, home: ANA_HOME }, now - 29 * DAY);
        await syncOutsideMail(ctx, now);
        expect(server.receiptTries).toEqual([{ to: `${ANA.key}@${ANA_HOME}`, ids: [fresh] }]);
        expect(owed()).toBe(0);
    });

    it('one round posts 200 owed ids at most, 50 to a receipt; the rest go at the next round', async () => {
        const ids = Array.from({ length: 250 }, () => uuid());
        for (const id of ids) await ctx.store.oweReceipt(BEN.key, { id, key: ANA.key, home: ANA_HOME }, Date.now());
        await syncOutsideMail(ctx);
        expect(server.receiptTries.map((r) => r.ids.length)).toEqual([50, 50, 50, 50]);
        expect(owed()).toBe(50);
        await syncOutsideMail(ctx);
        expect(server.receiptTries.map((r) => r.ids.length)).toEqual([50, 50, 50, 50, 50]);
        expect(owed()).toBe(0);
        expect(new Set(server.receiptTries.flatMap((r) => r.ids))).toEqual(new Set(ids));
    });
});

describe('13  typed words are never lost on a failed send (PR #3168 review note)', () => {
    const WORDS = 'Are the bikes still there?';
    const realFetch = globalThis.fetch;
    /** My community's home not yet read on this phone (a restore from 12 words), and its read answering as `fetchHome` does. */
    const homeUnknown = (fetchHome: (init?: RequestInit) => Promise<Response>) => {
        sql.exec("DELETE FROM outside_meta WHERE k = 'home'");
        globalThis.fetch = ((_url: string, init?: RequestInit) => fetchHome(init)) as any;
    };
    type Case = { what: string; setup: () => void; budgetMs?: number } & ({ kept: false } | { kept: true; state: string });
    const CASES: Case[] = [
        { what: 'my community knows none of its names here, and can\'t be read now', kept: false,
            setup: () => homeUnknown(async () => { throw new TypeError('Network request failed'); }) },
        { what: 'the send\'s deadline cuts the read of my community', kept: false, budgetMs: 40,
            setup: () => homeUnknown((init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))) },
        { what: 'the request is not accepted yet', kept: false, setup: () => { sql.exec("UPDATE outside_chats SET state = 'request'"); } },
        { what: 'my server can\'t be reached', kept: true, state: 'sending', setup: () => { server.sendFails = true; } },
        { what: 'my server answers no', kept: true, state: 'failed',
            setup: () => { server.refuse = () => ({ status: 403, error: 'Off here.', code: 'outside_messages_off' }); } },
        { what: 'my server never answers before the deadline', kept: true, state: 'sending', budgetMs: 40, setup: () => { server.stallSend = true; } },
        { what: 'it goes', kept: true, state: 'sent', setup: () => {} },
    ];
    for (const c of CASES) {
        it(`${c.what}: ${c.kept ? `the box empties, the line kept as ${c.state}` : 'the words stay in the box, no line'}`, async () => {
            const chatId = relayConversationId(BEN.key, ANA.key);
            await ctx.store.openChat(BEN.key, chatId, { key: ANA.key, home: ANA_HOME, name: 'Ana' });
            c.setup();
            let box = WORDS;
            try {
                const r = await sendFromBox(ctx, chatId, WORDS, c.budgetMs ?? 5_000, () => { box = ''; });
                const line = lineRows().find((l) => l.text === WORDS);
                expect(r.kept).toBe(c.kept);
                if (c.kept) {
                    expect(box).toBe('');
                    expect(line?.state).toBe(c.state);
                    expect(!!r.error).toBe(c.state !== 'sent');
                } else {
                    expect(box).toBe(WORDS);
                    expect(line).toBeUndefined();
                    expect(r.error).toBeTruthy();
                }
            } finally {
                globalThis.fetch = realFetch;
            }
        });
    }

    it('the chat\'s box and the card\'s first line send only through sendFromBox; neither gives up its words before the line is kept', () => {
        const src = (f: string) => readFileSync(join(__dirname, '../../app', f), 'utf8');
        const chat = src('outside-chat/[id].tsx');
        const card = src('address-card.tsx');
        for (const s of [chat, card]) expect(s).not.toMatch(/\bsendOutsideLine\(/);
        // The chat's box empties in sendFromBox's onKept, and nowhere else; the kept line is shown at once.
        expect(chat).toMatch(/sendFromBox\([^;]*\(\)\s*=>\s*\{?\s*setText\(/);
        expect(chat.match(/\bsetText\(\s*(''|"")\s*\)/g) ?? [], 'no other way to empty the box').toEqual([]);
        // The card never empties its box: it moves on to the chat only when the line was kept, and otherwise stays with the words.
        expect(card).toMatch(/sendFromBox\(/);
        expect(card).not.toMatch(/\bsetFirst\(\s*(''|""|\()/);
        expect(card).toMatch(/if \(kept\) router\.replace\(/);
    });
});

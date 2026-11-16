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
 *  14  a first send with no home read here says the true reason: can't reach (offline, the deadline), had a problem (an
 *      answer that is not the info), or knows none of its names (only when my server answered so)
 *  15  each device for itself (X2b, scratch/fable-design/decisions/DECISION-outside-door.md): section 3's gate table (kind x
 *      chat x door x block, 96 rows) through a round with a second device listed: after every row, drops included, the second device is
 *      still served the item; the round names this phone's id on every fetch and confirm, the same id each round
 *  16  the two round fixes: my ticks are applied before held items are gated (a new device's first page), and a tick for a
 *      line I wrote elsewhere opens that chat here from a request or a decline
 *  17  a source rule: no fetch of /api/mail and no confirm without the device, in either app's round
 *  18  a blocked person's chat stays closed (PR #3188 review): one table over every way a chat can change here (a tick for a
 *      line written on another device, its receipt, its expiry, a second page of a new device's history, a tick for a line
 *      written here, their line, their card) x the chat's state here, with them blocked: never made, reopened, listed or
 *      counted as new; and the same ways without the block do change it, so the table can fail
 *  19  Sign Out's forget (X2b): this phone's id read at once, the forget asked with it, settled within its 4 s whatever the
 *      community does (a fetch that never gives up included), never a throw; a phone that never ran a round asks nothing
 *  X5  report a line from another community: the line as it came, its words and the reason; a refusal reads as a sentence
 *  X6  changes to lines: one table over kind (edit, reaction add, change, remove, delete) x sender (the writer, the other
 *      person, a third key, a forged seal, a blocked sender) x state (fetched, already deleted, a request here) through a round:
 *      applied, or not, and always confirmed; how the line reads after; and sending one: kept at once, sent, sent again when
 *      unreached, taken back when refused for good, never for a line that isn't mine to edit
 *
 * The mailbox is played as the server keeps it since X2b: each device listed by its fetch, an item gone once every listed
 * device has confirmed it (apps/server/src/engine/relay-mail.ts settleMailFor).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from 'node:crypto';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
    checkRelayItem, ed25519Signer, openOutsideChange, outsideLineShown, relayConversationId, relayEnvelopeVerifies, relayPayloadHash, sealOutsideChange,
    sealOutsideLine, signRelayEnvelope, type OutsideChangeKind, type RelayItem,
} from '@beanpool/core';

/** As the mailbox reads a receipt (apps/server/src/engine/relay-mail.ts readReceiptPayload): {"v":1,"items":[ids]}. */
const readReceiptPayloadForTests = (payload: string): string[] | null => {
    const o = JSON.parse(payload);
    return o?.v === 1 && Array.isArray(o.items) ? o.items : null;
};

const server = vi.hoisted(() => ({
    /** What each report of an outside line handed my server (X5). */
    reports: [] as any[],
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
    refuse: null as null | ((item: RelayItem) => { status: number; error: string; code: string } | { status: number; body: unknown } | null),
    /** What my server answers a report instead of taking it (X5): its status and body as sent. */
    reportAnswer: null as null | { status: number; body: unknown },
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
    /** Ticks a page at a time (test 15): each fetch takes the next, `more` saying another follows; empty: `outbox` in one. */
    outboxPages: [] as Array<{ ticks: any[]; more: boolean }>,
    seen: { confirm: 0, receipt: 0 },
    stopped: false,
    /** The round's deadline, which a `deadline` stop fires. */
    deadline: null as null | AbortController,
    /** Every receipt posted, taken or not: to whom, at which home, naming which ids. */
    receiptTries: [] as Array<{ to: string; ids: string[] }>,
    /** The devices listed (each by its fetch), and which device has confirmed which item (X2b). */
    devices: new Set<string>(),
    got: new Map<string, Set<string>>(),
    /** The device each fetch and confirm named, in order. */
    named: [] as Array<{ at: 'fetch' | 'confirm'; device: string | null }>,
    /** Each forget asked (test 19): with what id, and its signal; and how my server answers it. */
    forgets: [] as Array<{ device: string; signal: AbortSignal | undefined }>,
    forgetAnswer: 'ok' as 'ok' | 'refused' | 'never' | 'deaf',
}));

/** What waits for `device` at the server: every held item it has not confirmed. */
function servedTo(device: string): any[] {
    return server.held.filter((h) => !server.got.get(h.envelope.itemId)?.has(device));
}

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
        // As routes/relay.ts answers since X2b: no device, 400; else the device is listed and served what it has not confirmed.
        const device = new URLSearchParams(path.split('?')[1] ?? '').get('device');
        server.named.push({ at: 'fetch', device });
        if (!device || !/^[0-9a-f]{32}$/.test(device)) return new Response(JSON.stringify({ error: 'No device.', code: 'bad_device' }), { status: 400 });
        server.devices.add(device);
        const outbox = server.outboxPages.length ? server.outboxPages.shift()! : { ticks: server.outbox, more: false };
        return new Response(JSON.stringify({ items: servedTo(device).slice(0, 50), more: false, outbox: outbox.ticks, outboxMore: outbox.more }), { status: 200 });
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
            const device = typeof body.device === 'string' ? body.device : null;
            server.named.push({ at: 'confirm', device });
            if (!device) return new Response(JSON.stringify({ error: 'No device.', code: 'bad_device' }), { status: 400 });
            server.confirmed.push(body.ids);
            let marked = 0;
            for (const h of server.held) {
                if (!body.ids.includes(h.envelope.itemId)) continue;
                const got = server.got.get(h.envelope.itemId) ?? new Set<string>();
                if (!got.has(device)) { got.add(device); marked++; }
                server.got.set(h.envelope.itemId, got);
            }
            // Gone once a device has it and every listed device has (engine/relay-mail.ts settleMailFor).
            server.held = server.held.filter((h) => {
                const got = server.got.get(h.envelope.itemId);
                return !got?.size || ![...server.devices].every((d) => got.has(d));
            });
            answer = new Response(JSON.stringify({ confirmed: marked }), { status: 200 });
        } else if (path === '/api/mail/send') {
            if (server.sendFails) throw new TypeError('Network request failed');
            if (server.stallSend) {
                await new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
            }
            server.batches.push(body.items.map((i: RelayItem) => i.envelope.itemId));
            for (const i of body.items) {
                const problem = server.refuse?.(i);
                if (problem) return new Response(JSON.stringify('body' in problem ? problem.body : { error: problem.error, code: problem.code }), { status: problem.status });
            }
            server.sent.push(...body.items);
            answer = new Response(JSON.stringify({ items: body.items.map((i: RelayItem) => ({ itemId: i.envelope.itemId, state: server.sendState })) }), { status: 200 });
        } else if (path === '/api/mail/report') {
            if (server.reportAnswer) return new Response(JSON.stringify(server.reportAnswer.body), { status: server.reportAnswer.status });
            server.reports.push(body);
            answer = new Response(JSON.stringify({ success: true, report: { id: 'r-1' } }), { status: 200 });
        } else if (path === '/api/mail/device/forget') {
            server.forgets.push({ device: body.device, signal });
            if (server.forgetAnswer === 'refused') return new Response(JSON.stringify({ error: 'Busy.', code: 'busy' }), { status: 503 });
            if (server.forgetAnswer === 'never') {
                await new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
            }
            // A fetch that never gives up, even when aborted.
            if (server.forgetAnswer === 'deaf') await new Promise(() => {});
            answer = new Response(JSON.stringify({ success: true }), { status: 200 });
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
import {
    DEVICE_META, FORGET_DEVICE_MS, chatsShown, failUnsent, forgetThisPhoneForMail, mailDevice, myAddressCard, myHome, openChatFromCard,
    reportOutsideLine, syncOutsideMail, sendFromBox, sendOutsideChange, sendOutsideLine, setDoor, OutsideMailError, type OutsideMailContext, type SyncOutcome,
} from '../outside-mail';

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
    server.reports = []; server.reportAnswer = null; server.held = []; server.outbox = []; server.calls = []; server.sent = []; server.confirmed = []; server.sendFails = false; server.sendState = 'sent';
    server.batches = []; server.refuse = null; server.signals = []; server.stallGet = false; server.stallSend = false;
    server.stop = null; server.seen = { confirm: 0, receipt: 0 }; server.stopped = false; server.deadline = null; server.receiptTries = [];
    server.devices = new Set(); server.got = new Map(); server.named = []; server.outboxPages = []; server.forgets = []; server.forgetAnswer = 'ok';
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
    const kinds = ['dm-line', 'dm-blob', 'dm-delete', 'dm-edit', 'dm-reaction', 'group-line'];
    const chats: Array<{ state: OutsideChatState; theirLines: number } | null> = [
        null, { state: 'request', theirLines: 0 }, { state: 'request', theirLines: 1 }, { state: 'open', theirLines: 0 }, { state: 'open', theirLines: 5 },
        { state: 'declined', theirLines: 1 },
    ];
    /** The rule in words: blocked never; an open chat takes lines and changes to lines (X6); a stranger, one line, words only, through an open door. */
    const expected = (kind: string, chat: typeof chats[number], doorOpen: boolean, isBlocked: boolean) => {
        if (isBlocked) return 'drop';
        if (chat?.state === 'open') return kind === 'dm-line' ? 'line' : ['dm-delete', 'dm-edit', 'dm-reaction'].includes(kind) ? 'change' : 'drop';
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
    it('no voice, no photo, no delete, edit or reaction, ever, from someone not accepted (design §3.5)', () => {
        for (const kind of ['dm-blob', 'dm-delete', 'dm-edit', 'dm-reaction', 'call-signal']) for (const doorOpen of [true, false]) {
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

describe('14  a first send on a phone that never read its home says the true reason (PR #3168 round-3 note)', () => {
    const WORDS = 'Are the bikes still there?';
    const KNOWS_NONE = "This community's server knows none of its own names yet, so it can't send to another community.";
    const CANT_REACH = "This phone can't reach your community's server just now: no signal, or the server is down. Try again in a while.";
    const HAD_A_PROBLEM = "Your community's server had a problem just now. Try again in a while.";
    const realFetch = globalThis.fetch;
    const aborted = (init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    // How my server's info answers (GET /api/community/info), on a phone with no home kept (a restore from 12 words).
    const CASES: Array<{ what: string; info: (init?: RequestInit) => Promise<Response>; code: string; words: string; budgetMs?: number }> = [
        { what: 'offline: no signal', info: async () => { throw new TypeError('Network request failed'); }, code: 'unreached', words: CANT_REACH },
        { what: 'the send\'s deadline cuts the read', info: aborted, code: 'unreached', words: CANT_REACH, budgetMs: 40 },
        { what: 'my server answered, and knows none of its names', code: 'no_home', words: KNOWS_NONE,
            info: async () => new Response(JSON.stringify({ name: 'Riverside', primaryAddress: null }), { status: 200 }) },
        { what: 'a proxy answered for my server (502, its own page)', code: 'home_unanswered', words: HAD_A_PROBLEM,
            info: async () => new Response('<html>Bad gateway</html>', { status: 502 }) },
        { what: 'my server answered 200, but not its info', code: 'home_unanswered', words: HAD_A_PROBLEM,
            info: async () => new Response('<html>A captive page</html>', { status: 200 }) },
    ];
    for (const c of CASES) {
        it(`${c.what}: "${c.words.slice(0, 40)}…", the words stay in the box`, async () => {
            const chatId = relayConversationId(BEN.key, ANA.key);
            await ctx.store.openChat(BEN.key, chatId, { key: ANA.key, home: ANA_HOME, name: 'Ana' });
            sql.exec("DELETE FROM outside_meta WHERE k = 'home'");
            globalThis.fetch = ((_url: string, init?: RequestInit) => c.info(init)) as any;
            try {
                let box = WORDS;
                const r = await sendFromBox(ctx, chatId, WORDS, c.budgetMs ?? 5_000, () => { box = ''; });
                expect(r.kept).toBe(false);
                expect(box).toBe(WORDS);
                expect(lineRows()).toEqual([]);
                expect((r.error as any)?.code).toBe(c.code);
                expect((r.error as Error).message).toBe(c.words);
                // Nothing reached my server's mailbox: no line was made to send.
                expect(server.batches).toEqual([]);
                // Showing my card says the same.
                if (c.code === 'no_home') expect(await myAddressCard(ctx)).toBeNull();
                else await expect(myAddressCard({ ...ctx, signal: c.budgetMs ? AbortSignal.timeout(c.budgetMs) : undefined })).rejects.toMatchObject({ code: c.code, message: c.words });
            } finally {
                globalThis.fetch = realFetch;
            }
        });
    }

    it('a home read before is used while my server can\'t be reached or answers badly: the send goes', async () => {
        const chatId = relayConversationId(BEN.key, ANA.key);
        await ctx.store.openChat(BEN.key, chatId, { key: ANA.key, home: ANA_HOME, name: 'Ana' });
        await ctx.store.setMeta('home', `${HOME} ${Date.now() - 2 * 60 * 60_000}`);   // stale: read again first
        for (const info of [CASES[0].info, CASES[3].info, CASES[4].info]) {
            globalThis.fetch = ((_url: string, init?: RequestInit) => info(init)) as any;
            try {
                const r = await sendFromBox(ctx, chatId, WORDS, 5_000, () => {});
                expect(r).toEqual({ kept: true, error: null });
            } finally {
                globalThis.fetch = realFetch;
            }
        }
        expect(server.sent.map((i: RelayItem) => i.envelope.senderHome)).toEqual([HOME, HOME, HOME]);
    });
});

describe('15  each device for itself: the gate table through a round, a second device listed', () => {
    /** Ben's browser, which fetched once (so it is listed) and has not run a round since. */
    const BROWSER = 'f'.repeat(32);
    // Section 3's kinds: the three the mailbox holds for a member (apps/server/src/engine/relay-mail.ts HELD_KINDS), and a
    // group line, which it never holds but which the gate drops here all the same.
    const kinds = ['dm-line', 'dm-blob', 'dm-delete', 'group-line'];
    const chats: Array<{ state: OutsideChatState; theirLines: number } | null> = [
        null, { state: 'request', theirLines: 0 }, { state: 'request', theirLines: 1 }, { state: 'open', theirLines: 0 }, { state: 'open', theirLines: 5 },
        { state: 'declined', theirLines: 1 },
    ];
    const expected = (kind: string, chat: typeof chats[number], doorOpen: boolean, isBlocked: boolean) => {
        if (isBlocked) return 'drop';
        if (chat?.state === 'open') return kind === 'dm-line' ? 'line' : 'drop';
        if (kind !== 'dm-line' || chat?.state === 'declined') return 'drop';
        if (chat?.state === 'request') return chat.theirLines === 0 ? 'request' : 'drop';
        return doorOpen ? 'request' : 'drop';
    };
    for (const kind of kinds) for (const chat of chats) for (const doorOpen of [false, true]) for (const isBlocked of [false, true]) {
        const want = expected(kind, chat, doorOpen, isBlocked);
        it(`${kind}, chat ${chat ? `${chat.state}/${chat.theirLines}` : 'none'}, door ${doorOpen ? 'open' : 'closed'}${isBlocked ? ', blocked' : ''}: ${want} on this phone, and the browser is still served it`, async () => {
            server.devices.add(BROWSER);
            const chatId = relayConversationId(BEN.key, SOL.key);
            if (chat) {
                await ctx.store.openChat(BEN.key, chatId, { key: SOL.key, home: ANA_HOME, name: 'Sol' });
                for (let i = 0; i < chat.theirLines; i++) {
                    await ctx.store.writeTheirs(BEN.key, { id: uuid(), chatId, author: SOL.key, text: `Earlier ${i}`, replyTo: null, at: Date.now() - 10_000 + i, sealed: '{}' }, { home: ANA_HOME, name: null }, 'line');
                }
                sql.prepare('UPDATE outside_chats SET state = ? WHERE id = ?').run(chat.state, chatId);
            }
            await setDoor(ctx.store, doorOpen);
            if (isBlocked) blocked.add(SOL.key);
            const item = await heldLine(SOL, 'The row\'s line', { kind });
            const id = item.envelope.itemId;
            const out = await syncOutsideMail(ctx);
            const phone = await ctx.store.getMeta(DEVICE_META);
            // This phone did its part: the item judged as the gate says, then confirmed, under this phone's own id.
            const rowText = sql.prepare('SELECT 1 AS x FROM outside_lines WHERE id = ?').get(id);
            if (want === 'line') expect([out.written, !!rowText, chatOf(SOL.key)?.state]).toEqual([1, true, chat?.state]);
            if (want === 'request') expect([out.requests, !!rowText, chatOf(SOL.key)?.state]).toEqual([1, true, 'request']);
            if (want === 'drop') expect([out.dropped, !!rowText]).toEqual([1, false]);
            expect(phone).toMatch(/^[0-9a-f]{32}$/);
            expect(phone).not.toBe(BROWSER);
            expect(server.got.get(id)).toEqual(new Set([phone]));
            // The browser is still served it, drops included: its own door, chats and blocks decide there.
            expect(servedTo(BROWSER).map((h) => h.envelope.itemId)).toContain(id);
            expect(servedTo(phone!).map((h) => h.envelope.itemId)).not.toContain(id);
        });
    }

    it('every fetch and confirm of a round names this phone\'s id, the same one round after round; with this phone alone, its confirm is the last', async () => {
        await ctx.store.openChat(BEN.key, relayConversationId(BEN.key, ANA.key), { key: ANA.key, home: ANA_HOME, name: 'Ana' });
        await heldLine(ANA, 'One');
        await syncOutsideMail(ctx);
        await heldLine(ANA, 'Two');
        await syncOutsideMail(ctx);
        const id = await mailDevice(ctx.store);
        expect(server.named.length).toBeGreaterThanOrEqual(4);
        expect(server.named.every((n) => n.device === id)).toBe(true);
        expect(server.named.filter((n) => n.at === 'confirm')).toHaveLength(2);
        expect(server.held).toEqual([]);
    });
});

describe('16  the two round fixes', () => {
    const tickTo = (key: string, at = 1763020900000) => ({ itemId: uuid(), kind: 'dm-line', recipient: key, recipientHome: ANA_HOME, state: 'delivered', at });

    it('my ticks before any held item is judged: a new device\'s first page writes the line of a chat I wrote to, door closed', async () => {
        // A new device (this store holds no chat): Ben wrote to Ana elsewhere, and her answer waits. His door here is closed.
        server.outbox = [tickTo(ANA.key)];
        await heldLine(ANA, 'Answering you');
        const out = await syncOutsideMail(ctx);
        expect(out).toMatchObject({ written: 1, requests: 0, dropped: 0 });
        expect(chatOf(ANA.key)).toMatchObject({ state: 'open' });
        expect(lineRows().map((r) => r.text)).toEqual(['Answering you']);
    });

    it('every page of ticks first: a tick on the second page still opens the chat before the held line is judged', async () => {
        server.outboxPages = [{ ticks: [tickTo(CY.key, 1763020900000)], more: true }, { ticks: [tickTo(ANA.key, 1763020900001)], more: false }];
        await heldLine(ANA, 'Second page');
        const out = await syncOutsideMail(ctx);
        expect(out).toMatchObject({ written: 1, dropped: 0 });
        expect(lineRows().map((r) => r.text)).toEqual(['Second page']);
        expect(server.confirmed).toHaveLength(1);
    });

    it('a tick for a line I wrote elsewhere opens the chat here from a request: their next line is written', async () => {
        await setDoor(ctx.store, true);
        await heldLine(SOL, 'May I ask about the bikes?');
        await syncOutsideMail(ctx);
        expect(chatOf(SOL.key)).toMatchObject({ state: 'request' });
        // Ben accepted and answered on his browser: this phone sees his line's tick, and Sol's next line, in one round.
        server.outbox = [tickTo(SOL.key)];
        await heldLine(SOL, 'Thanks for answering');
        const out = await syncOutsideMail(ctx);
        expect(chatOf(SOL.key)).toMatchObject({ state: 'open', restored: 0 });
        expect(out).toMatchObject({ written: 1, dropped: 0 });
        expect(lineRows().map((r) => r.text)).toEqual(['May I ask about the bikes?', 'Thanks for answering']);
    });

    it('and from a decline', async () => {
        await setDoor(ctx.store, true);
        await heldLine(SOL, 'Hello');
        await syncOutsideMail(ctx);
        await ctx.store.decide(BEN.key, relayConversationId(BEN.key, SOL.key), 'declined');
        server.outbox = [tickTo(SOL.key)];
        await heldLine(SOL, 'After your answer');
        expect(await syncOutsideMail(ctx)).toMatchObject({ written: 1, dropped: 0 });
        expect(chatOf(SOL.key)).toMatchObject({ state: 'open' });
    });

    it('an open chat stays as it is: not marked restored, its lines kept', async () => {
        const chatId = relayConversationId(BEN.key, ANA.key);
        await ctx.store.openChat(BEN.key, chatId, { key: ANA.key, home: ANA_HOME, name: 'Ana' });
        await heldLine(ANA, 'Kept');
        await syncOutsideMail(ctx);
        const before = chatOf(ANA.key);
        server.outbox = [tickTo(ANA.key)];
        expect(await syncOutsideMail(ctx)).toMatchObject({ ticks: 0 });
        expect(chatOf(ANA.key)).toEqual({ ...before, state: 'open', restored: 0 });
        expect(lineRows().map((r) => r.text)).toEqual(['Kept']);
    });
});

describe('17  a source rule: no fetch or confirm without the device', () => {
    // Each app's round (the web's lib/outside-mail.ts, X4, is held to it once it is on main). Since X2b the server refuses
    // both without one (400 bad_device), and a confirm with another device's id would take an item from that device.
    const ROUNDS = ['apps/native/utils/outside-mail.ts', 'apps/pwa/src/lib/outside-mail.ts'];
    const repo = join(__dirname, '../../../..');
    for (const file of ROUNDS) {
        it(file, () => {
            let src: string;
            try { src = readFileSync(join(repo, file), 'utf8'); } catch { return; }   // not on this branch (the web's, before X4)
            src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   // the code, not what its comments say
            const fetches = src.match(/['`]\/api\/mail(?:\?[^'`]*)?['`]/g) ?? [];
            expect(fetches.length, 'the round fetches /api/mail').toBeGreaterThan(0);
            for (const f of fetches) expect(f, 'every fetch of /api/mail names the device').toMatch(/[?&]device=\$\{/);
            const confirms = [...src.matchAll(/'\/api\/mail\/confirm',\s*(\{[^}]*\})/g)].map((m) => m[1]);
            expect(confirms.length, 'the round confirms').toBeGreaterThan(0);
            for (const c of confirms) expect(c, 'every confirm names the device').toMatch(/\bdevice\b/);
            expect(src.match(/\/api\/mail\/confirm/g)?.length, 'no confirm the rule does not see').toBe(confirms.length);
        });
    }
});

describe('18  a blocked person\'s chat stays closed: every way a chat can change here x blocked (PR #3188 review)', () => {
    // Sol, blocked on this account (a block is the account's: utils/blocklist.ts). Ben's door here is open, so the block alone
    // stands between Sol and Ben's Chats tab. Each start: no chat here (a new device, or a phone restored from 12 words), a
    // request, an open chat (blocked from another screen, so not declined here), a declined one (Block in the chat declines it).
    const starts = ['none', 'request', 'open', 'declined'] as const;
    type Start = typeof starts[number];
    const chatId = () => relayConversationId(BEN.key, SOL.key);
    const sol = { key: SOL.key, home: ANA_HOME, name: 'Sol' };
    const tick = (state: string, at = 1763020900000) => ({ itemId: uuid(), kind: 'dm-line', recipient: SOL.key, recipientHome: ANA_HOME, state, at });
    const round = async () => ({ round: await syncOutsideMail(ctx) });

    async function start(s: Start) {
        server.outbox = [];
        await setDoor(ctx.store, true);
        if (s === 'request') { await heldLine(SOL, 'Hello'); await syncOutsideMail(ctx); }
        if (s === 'open' || s === 'declined') await ctx.store.openChat(BEN.key, chatId(), sol);
        if (s === 'declined') await ctx.store.decide(BEN.key, chatId(), 'declined');
        expect(chatOf(SOL.key)?.state).toBe(s === 'none' ? undefined : s);
    }

    /** Every way a chat can change here. `here`: a tick for a line this phone has (its state moves; the chat doesn't). */
    const ways: Array<{ way: string; only?: Start[]; here?: true; act: () => Promise<{ round?: SyncOutcome; opened?: string | null }> }> = [
        { way: 'a tick for a line I wrote on another device', act: async () => { server.outbox = [tick('sent')]; return round(); } },
        { way: 'its receipt: Delivered', act: async () => { server.outbox = [tick('delivered')]; return round(); } },
        { way: 'it expired', act: async () => { server.outbox = [tick('expired')]; return round(); } },
        {
            way: 'a tick on the second page of a new device\'s history',
            act: async () => {
                server.outboxPages = [{ ticks: [{ ...tick('delivered'), kind: 'receipt' }], more: true }, { ticks: [tick('sent', 1763020900001)], more: false }];
                return round();
            },
        },
        {
            way: 'a tick for a line I wrote here before the block', only: ['open', 'declined'], here: true,
            act: async () => {
                const id = uuid();
                await ctx.store.addMine({ id, chatId: chatId(), author: BEN.key, text: 'Before the block', replyTo: null, at: Date.now(), item: '{}' });
                await ctx.store.setMineState(id, 'sent');
                server.outbox = [{ ...tick('delivered'), itemId: id }];
                return round();
            },
        },
        { way: 'a line from them', act: async () => { await heldLine(SOL, 'Still there?'); return round(); } },
        { way: 'I write to them from their card', act: async () => ({ opened: await openChatFromCard(ctx, sol) }) },
        { way: 'nothing new: the block alone', act: async () => ({}) },
    ];

    for (const s of starts) for (const w of ways) {
        if (w.only && !w.only.includes(s)) continue;
        it(`${s === 'none' ? 'no chat here' : `a chat ${s} here`}, ${w.way}: not made, not reopened, not listed, nothing new`, async () => {
            await start(s);
            blocked.add(SOL.key);
            const before = chatOf(SOL.key);
            const theirs = () => lineRows().filter((r) => r.author === SOL.key).length;
            const theirsBefore = theirs();

            const { round: out, opened } = await w.act();

            // The chat is as it was: none made, none reopened, none marked restored.
            expect(chatOf(SOL.key)).toEqual(before);
            // Listed nowhere: neither among the open chats nor behind the requests row (app/(tabs)/chats.tsx reads chatsShown).
            expect((await chatsShown(ctx)).map((c) => c.peerKey)).not.toContain(SOL.key);
            // Nothing of theirs kept, and nothing counted as new: the round's counts are what tells the screens (OUTSIDE_CHATS_UPDATED).
            expect(theirs()).toBe(theirsBefore);
            if (out) expect(out).toMatchObject({ written: 0, requests: 0, ticks: w.here ? 1 : 0 });
            if (w.way.includes('card')) expect(opened).toBeNull();
        });
    }

    it('the same ways without the block do change the chat: so each row above can fail', async () => {
        // A tick for a line written elsewhere: made open and restored when none, opened from a request or a decline.
        for (const s of ['none', 'request', 'declined'] as const) {
            sql.exec('DELETE FROM outside_chats; DELETE FROM outside_lines;');
            await start(s);
            server.outbox = [tick('sent')];
            expect((await syncOutsideMail(ctx)).ticks).toBe(1);
            expect(chatOf(SOL.key)).toMatchObject({ state: 'open', restored: s === 'none' ? 1 : 0 });
            expect((await chatsShown(ctx)).map((c) => c.peerKey)).toContain(SOL.key);
        }
        // Their line, with no chat here: a request, behind the requests row.
        sql.exec('DELETE FROM outside_chats; DELETE FROM outside_lines;');
        await start('none');
        await heldLine(SOL, 'May I ask?');
        expect(await syncOutsideMail(ctx)).toMatchObject({ requests: 1 });
        expect((await chatsShown(ctx)).find((c) => c.peerKey === SOL.key)?.state).toBe('request');
        // Their card, after a decline: opened again.
        await ctx.store.decide(BEN.key, chatId(), 'declined');
        expect(await openChatFromCard(ctx, sol)).toBe(chatId());
        expect(chatOf(SOL.key)?.state).toBe('open');
    });

    it('unblocked, a chat blocked from another screen shows again as it was', async () => {
        await start('open');
        blocked.add(SOL.key);
        expect((await chatsShown(ctx)).map((c) => c.peerKey)).toEqual([]);
        blocked.delete(SOL.key);
        expect((await chatsShown(ctx)).map((c) => [c.peerKey, c.state])).toEqual([[SOL.key, 'open']]);
    });
});

describe('19  Sign Out\'s forget (X2b)', () => {
    const settle = async () => { for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r)); };
    afterEach(() => { vi.useRealTimers(); });

    it('asks my server to forget this phone\'s id, read before anything else goes', async () => {
        const id = await mailDevice(ctx.store);
        const { done } = await forgetThisPhoneForMail(ctx);
        // The id was read and the request started before `done` is awaited: the tables may go meanwhile.
        sql.exec('DELETE FROM outside_meta;');
        await done;
        expect(server.forgets.map((f) => f.device)).toEqual([id]);
    });

    it('a phone that never ran a round has no id, and asks nothing', async () => {
        await (await forgetThisPhoneForMail(ctx)).done;
        expect(server.forgets).toEqual([]);
        expect(server.calls).toEqual([]);
    });

    for (const how of ['never', 'deaf'] as const) {
        it(`my server ${how === 'never' ? 'never answers' : 'never answers and its fetch ignores the abort'}: settled at its 4 s, the request aborted, no throw`, async () => {
            await mailDevice(ctx.store);
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            server.forgetAnswer = how;
            const { done } = await forgetThisPhoneForMail(ctx);
            let settled = false;
            void done.then(() => { settled = true; });
            await vi.advanceTimersByTimeAsync(FORGET_DEVICE_MS - 1);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            await settle();
            expect(settled).toBe(true);
            expect(server.forgets[0].signal?.aborted).toBe(true);
        });
    }

    it('a refusal settles too, without a throw; so does a store that can\'t be read', async () => {
        await mailDevice(ctx.store);
        server.forgetAnswer = 'refused';
        await expect((await forgetThisPhoneForMail(ctx)).done).resolves.toBeUndefined();
        expect(server.forgets).toHaveLength(1);
        const broken = { ...ctx, store: { ...ctx.store, getMeta: async () => { throw new Error('the file is gone'); } } };
        await expect((await forgetThisPhoneForMail(broken)).done).resolves.toBeUndefined();
        expect(server.forgets).toHaveLength(1);
    });
});

describe('X5  report a line from another community', () => {
    it('hands my server the line exactly as it came, its words and the reason, and nothing else', async () => {
        await ctx.store.openChat(BEN.key, relayConversationId(BEN.key, ANA.key), { key: ANA.key, home: ANA_HOME, name: 'Ana' });
        const item = await heldLine(ANA, 'Buy my miracle seeds');
        await syncOutsideMail(ctx);
        await reportOutsideLine(ctx, item.envelope.itemId, 'Spam or scam');
        expect(server.reports).toHaveLength(1);
        const sent = server.reports[0];
        expect(Object.keys(sent).sort()).toEqual(['item', 'reason', 'words']);
        expect(sent.item).toEqual({ envelope: item.envelope, payload: item.payload });
        expect(sent).toMatchObject({ reason: 'Spam or scam', words: 'Buy my miracle seeds' });
    });

    it('a line of mine, or one not on this phone, is never sent as a report', async () => {
        await ctx.store.openChat(BEN.key, relayConversationId(BEN.key, ANA.key), { key: ANA.key, home: ANA_HOME, name: 'Ana' });
        await sendOutsideLine(ctx, relayConversationId(BEN.key, ANA.key), 'Mine');
        const mine = lineRows().find((r) => r.text === 'Mine');
        await expect(reportOutsideLine(ctx, mine.id, 'Other')).rejects.toBeInstanceOf(OutsideMailError);
        await expect(reportOutsideLine(ctx, uuid(), 'Other')).rejects.toBeInstanceOf(OutsideMailError);
        expect(server.reports).toHaveLength(0);
    });

    // Every shape a refusal comes in, on the report and send paths (every outside-mail path reads my server's answer through
    // one reader, answerOf; the fetch and confirm paths too): the words a screen shows are the server's sentence or `HTTP <n>`
    // (which each screen turns into its own sentence), never a code.
    const RATE = 'You have sent a lot of reports recently. Please try again in an hour.';
    const MEMBERS = 'Only members of this community can do this.';
    const shapes: Array<[string, number, unknown, string, string | undefined]> = [
        ['a report\'s 429: a code in error, its words in message', 429, { error: 'rate_limited', message: RATE }, RATE, 'rate_limited'],
        ['words in error beside a code', 403, { error: MEMBERS, code: 'not_a_member' }, MEMBERS, 'not_a_member'],
        ['words in message beside a code in code', 429, { error: 'rate_limited', code: 'rate_limited', message: RATE }, RATE, 'rate_limited'],
        ['a code alone', 429, { error: 'rate_limited' }, 'HTTP 429', 'rate_limited'],
        ['no body', 503, null, 'HTTP 503', undefined],
    ];
    for (const [what, status, body, says, code] of shapes) {
        it(`a refusal, ${what}: reads "${says}" on the report path and the send path`, async () => {
            const chatId = relayConversationId(BEN.key, ANA.key);
            await ctx.store.openChat(BEN.key, chatId, { key: ANA.key, home: ANA_HOME, name: 'Ana' });
            const item = await heldLine(ANA, 'Buy my miracle seeds');
            await syncOutsideMail(ctx);
            server.reportAnswer = { status, body };
            const reported = await reportOutsideLine(ctx, item.envelope.itemId, 'Spam or scam').catch((e) => e);
            server.refuse = () => ({ status, body });
            const sent = await sendOutsideLine(ctx, chatId, 'Hello').catch((e) => e);
            for (const e of [reported, sent]) {
                expect(e).toBeInstanceOf(OutsideMailError);
                expect(e.message).toBe(says);
                expect(e.code).toBe(code);
                expect(e.message).not.toMatch(/^[a-z0-9_]+$/);
            }
            expect(server.reports).toHaveLength(0);
        });
    }
});

describe('X6  changes to lines across communities', () => {
    type Kind = 'edit' | 'reaction add' | 'reaction change' | 'reaction remove' | 'delete';
    type Sender = 'writer' | 'other person' | 'third key' | 'forged' | 'blocked';
    type State = 'fetched' | 'already deleted' | 'request';
    const coreKind = (k: Kind): OutsideChangeKind => (k === 'edit' ? 'dm-edit' : k === 'delete' ? 'dm-delete' : 'dm-reaction');
    const extraOf = (k: Kind) => (k === 'edit' ? { text: 'Edited words' } : k === 'delete' ? {} : { emoji: k === 'reaction change' ? '❤️' : k === 'reaction add' ? '👍' : '' });

    /** A change `from` makes to line `lineId`, as their phone seals it (by `sealer`, theirs unless forged) and their server brings it. */
    async function heldChange(from: { seed: string; key: string }, kind: OutsideChangeKind, lineId: string, extra: { text?: string; emoji?: string }, sealer = from) {
        const itemId = uuid();
        const payload = sealOutsideChange({ kind, lineId, ...extra, myEdPrivHex: sealer.seed, myKey: sealer.key, peerKey: BEN.key, itemId });
        const envelope = await signRelayEnvelope({
            kind, itemId, senderKey: from.key, senderHome: ANA_HOME, recipient: BEN.key, recipientHome: HOME, at: Date.now(), payloadHash: relayPayloadHash(payload),
        }, ed25519Signer(Buffer.from(from.seed, 'hex')));
        server.held.push({ kind, envelope, payload, bytes: payload.length, receivedAt: Date.now() });
        return itemId;
    }
    const want = (kind: Kind, sender: Sender, state: State) => {
        if (sender === 'forged' || sender === 'blocked' || state === 'request') return 'dropped';
        if (sender === 'third key') return 'refused';
        if (state === 'already deleted') return 'dropped';
        if (sender === 'other person' && (kind === 'edit' || kind === 'delete')) return 'refused';
        return 'applied';
    };
    const KINDS: Kind[] = ['edit', 'reaction add', 'reaction change', 'reaction remove', 'delete'];
    const SENDERS: Sender[] = ['writer', 'other person', 'third key', 'forged', 'blocked'];
    const STATES: State[] = ['fetched', 'already deleted', 'request'];
    for (const kind of KINDS) for (const sender of SENDERS) for (const state of STATES) {
        const w = want(kind, sender, state);
        it(`${kind}, from ${sender}, ${state}: ${w}, and confirmed`, async () => {
            const anaChat = relayConversationId(BEN.key, ANA.key), cyChat = relayConversationId(BEN.key, CY.key);
            await ctx.store.openChat(BEN.key, anaChat, { key: ANA.key, home: ANA_HOME, name: 'Ana' });
            await ctx.store.openChat(BEN.key, cyChat, { key: CY.key, home: ANA_HOME, name: 'Cy' });
            // The line: Ana's to Ben, or (the other person) Ben's own to Ana.
            let lineId: string;
            if (sender === 'other person') {
                lineId = uuid();
                await ctx.store.addMine({ id: lineId, chatId: anaChat, author: BEN.key, text: 'Original words', replyTo: null, at: Date.now() - 5_000, item: '{}' });
                await ctx.store.setMineState(lineId, 'delivered');
            } else {
                lineId = (await heldLine(ANA, 'Original words')).envelope.itemId;
            }
            await syncOutsideMail(ctx);
            if (state === 'already deleted') {
                if (sender === 'other person') await ctx.store.putChange(anaChat, { kind: 'dm-delete', itemId: uuid(), lineId, author: BEN.key, at: Date.now() });
                else { await heldChange(ANA, 'dm-delete', lineId, {}); await syncOutsideMail(ctx); }
            }
            const maker = sender === 'third key' ? CY : ANA;
            if (kind === 'reaction change' || kind === 'reaction remove') { await heldChange(maker, 'dm-reaction', lineId, { emoji: '👍' }); await syncOutsideMail(ctx); }
            if (state === 'request') sql.prepare("UPDATE outside_chats SET state = 'request' WHERE id = ?").run(maker === CY ? cyChat : anaChat);
            if (sender === 'blocked') blocked.add(ANA.key);
            const id = await heldChange(maker, coreKind(kind), lineId, extraOf(kind), sender === 'forged' ? CY : maker);
            const out = await syncOutsideMail(ctx);
            expect(out.changes).toBe(w === 'applied' ? 1 : 0);
            expect(server.confirmed.flat()).toContain(id);
            expect(server.held.map((h) => h.envelope.itemId)).not.toContain(id);
            const line = lineRows().find((r) => r.id === lineId)!;
            const shown = outsideLineShown(line, await ctx.store.changes(anaChat), BEN.key);
            // The earlier 👍 came while the chat was open here (the request state is set after it): it stands but on a line
            // in another chat (the third key's) or a deleted one.
            const prior = (kind === 'reaction change' || kind === 'reaction remove') && sender !== 'third key' && state !== 'already deleted';
            const expectShown = state === 'already deleted' ? { text: '', edited: false, deleted: true, reactions: [] }
                : w !== 'applied' ? { text: 'Original words', edited: false, deleted: false, reactions: prior ? [{ emoji: '👍', count: 1, mine: false }] : [] }
                    : kind === 'edit' ? { text: 'Edited words', edited: true, deleted: false, reactions: [] }
                        : kind === 'delete' ? { text: '', edited: false, deleted: true, reactions: [] }
                            : { text: 'Original words', edited: false, deleted: false, reactions: kind === 'reaction remove' ? [] : [{ emoji: kind === 'reaction add' ? '👍' : '❤️', count: 1, mine: false }] };
            expect(shown).toEqual(expectShown);
        });
    }

    it('a change that comes before its line is kept, and applies once the line is here', async () => {
        const anaChat = relayConversationId(BEN.key, ANA.key);
        await ctx.store.openChat(BEN.key, anaChat, { key: ANA.key, home: ANA_HOME, name: 'Ana' });
        const lineId = uuid();
        await heldChange(ANA, 'dm-edit', lineId, { text: 'Edited first' });
        expect(await syncOutsideMail(ctx)).toMatchObject({ changes: 1 });
        const payload = sealOutsideLine({ text: 'Original', name: 'Ana', myEdPrivHex: ANA.seed, myKey: ANA.key, peerKey: BEN.key, messageId: lineId });
        const envelope = await signRelayEnvelope({ kind: 'dm-line', itemId: lineId, senderKey: ANA.key, senderHome: ANA_HOME, recipient: BEN.key, recipientHome: HOME, at: Date.now(), payloadHash: relayPayloadHash(payload) }, ed25519Signer(Buffer.from(ANA.seed, 'hex')));
        server.held.push({ kind: 'dm-line', envelope, payload, bytes: payload.length, receivedAt: Date.now() });
        await syncOutsideMail(ctx);
        expect(outsideLineShown(lineRows().find((r) => r.id === lineId)!, await ctx.store.changes(anaChat), BEN.key)).toMatchObject({ text: 'Edited first', edited: true });
    });

    describe('sending one', () => {
        const anaChat = () => relayConversationId(BEN.key, ANA.key);
        async function withLines() {
            await ctx.store.openChat(BEN.key, anaChat(), { key: ANA.key, home: ANA_HOME, name: 'Ana' });
            const mine = uuid();
            await ctx.store.addMine({ id: mine, chatId: anaChat(), author: BEN.key, text: 'Mine', replyTo: null, at: Date.now() - 5_000, item: '{}' });
            await ctx.store.setMineState(mine, 'delivered');
            const theirs = (await heldLine(ANA, 'Theirs')).envelope.itemId;
            await syncOutsideMail(ctx);
            server.sent = [];
            return { mine, theirs };
        }

        it('an edit, a reaction and a delete: kept here at once, sent sealed to Ana, opening there as Ben\'s own', async () => {
            const { mine, theirs } = await withLines();
            await sendOutsideChange(ctx, anaChat(), { kind: 'dm-edit', lineId: mine, text: 'Mine, fixed' });
            await sendOutsideChange(ctx, anaChat(), { kind: 'dm-reaction', lineId: theirs, emoji: '😂' });
            const sent = server.sent.filter((i) => i.envelope.kind !== 'receipt');
            expect(sent.map((i) => i.envelope.kind)).toEqual(['dm-edit', 'dm-reaction']);
            for (const i of sent) {
                expect(relayEnvelopeVerifies(i.envelope)).toBe(true);
                expect(i.envelope).toMatchObject({ senderKey: BEN.key, senderHome: HOME, recipient: ANA.key, recipientHome: ANA_HOME });
            }
            expect(openOutsideChange(sent[0].payload, sent[0].envelope, { key: ANA.key, edPrivHex: ANA.seed })).toMatchObject({ kind: 'dm-edit', lineId: mine, author: BEN.key, text: 'Mine, fixed' });
            const changes = await ctx.store.changes(anaChat());
            expect(outsideLineShown({ id: mine, author: BEN.key, text: 'Mine' }, changes, BEN.key)).toMatchObject({ text: 'Mine, fixed', edited: true });
            expect(outsideLineShown({ id: theirs, author: ANA.key, text: 'Theirs' }, changes, BEN.key).reactions).toEqual([{ emoji: '😂', count: 1, mine: true }]);
            expect(await ctx.store.unsent(BEN.key)).toEqual([]);
            await sendOutsideChange(ctx, anaChat(), { kind: 'dm-delete', lineId: mine });
            expect(outsideLineShown({ id: mine, author: BEN.key, text: 'Mine' }, await ctx.store.changes(anaChat()), BEN.key).deleted).toBe(true);
        });

        it('never a line that isn\'t mine to edit or delete, nor one already deleted; nothing is sent', async () => {
            const { mine, theirs } = await withLines();
            await expect(sendOutsideChange(ctx, anaChat(), { kind: 'dm-edit', lineId: theirs, text: 'x' })).rejects.toMatchObject({ code: 'not_yours' });
            await expect(sendOutsideChange(ctx, anaChat(), { kind: 'dm-delete', lineId: theirs })).rejects.toMatchObject({ code: 'not_yours' });
            await sendOutsideChange(ctx, anaChat(), { kind: 'dm-delete', lineId: mine });
            await expect(sendOutsideChange(ctx, anaChat(), { kind: 'dm-reaction', lineId: mine, emoji: '👍' })).rejects.toMatchObject({ code: 'not_yours' });
            expect(server.sent.map((i) => i.envelope.kind)).toEqual(['dm-delete']);
        });

        it('unreached: kept with its item and sent again at the next round; refused for good: taken back here', async () => {
            const { mine, theirs } = await withLines();
            server.sendFails = true;
            await expect(sendOutsideChange(ctx, anaChat(), { kind: 'dm-edit', lineId: mine, text: 'Later' })).rejects.toThrow();
            expect((await ctx.store.unsent(BEN.key)).length).toBe(1);
            server.sendFails = false;
            await syncOutsideMail(ctx);
            expect(server.sent.filter((i) => i.envelope.kind === 'dm-edit')).toHaveLength(1);
            expect(await ctx.store.unsent(BEN.key)).toEqual([]);
            server.refuse = () => ({ status: 403, error: "This community doesn't take messages from other communities.", code: 'outside_messages_off' });
            await expect(sendOutsideChange(ctx, anaChat(), { kind: 'dm-reaction', lineId: theirs, emoji: '👍' })).rejects.toBeInstanceOf(OutsideMailError);
            expect(outsideLineShown({ id: theirs, author: ANA.key, text: 'Theirs' }, await ctx.store.changes(anaChat()), BEN.key).reactions).toEqual([]);
        });
    });
});

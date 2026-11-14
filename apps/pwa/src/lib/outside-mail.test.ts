/**
 * The browser's half of messages across communities (lib/outside-mail.ts, lib/outside-chat-store.ts; slice X4), against a
 * mailbox played here as the server's routes answer (apps/server/src/routes/relay.ts) and the store on the in-memory
 * IndexedDB (lib/memory-indexeddb.ts), which can fail a write as a full disk does. The phone's utils/__tests__/
 * outside-mail.test.ts is the same round; these keep its three review rounds' findings (#3168) from coming back here.
 *
 *   1  confirm after write: an item is written in this browser before its confirm is sent, and receipted to its sender's home
 *   2  a write that fails (a full disk) is never confirmed: the item waits at the server and is written at the next round
 *   3  the request gate, one table over every case (core gateOutsideItem, the phone's too), and through a round
 *   4  a resend my server refuses: the refused line fails with its words, the others still go; a 403 fails them all
 *   5  every request of a round carries the round's deadline; a stalled round is let go at its deadline, the next one runs
 *   6  a receipt outlives the round: every point a round can stop x how it stops; afterwards every line is written once,
 *      confirmed, receipted to its sender's home, and nothing is left owed
 *   7  typed words are never lost on a failed send; ticks: Delivered, and a chat this browser lacks comes back restored
 *   8  a stalled wait never holds the round's lock: every wait a round makes x how it stalls; the round lets go of it and
 *      of the lock at its deadline, waits on nothing after it, and the next round runs (#3183's deciding finding)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
    checkRelayItem, ed25519Signer, gateOutsideItem, relayConversationId, relayPayloadHash, sealOutsideLine, signRelayEnvelope,
    type OutsideChatState, type RelayItem,
} from '@beanpool/core';
import { memoryIndexedDB, type MemoryIndexedDB } from './memory-indexeddb';

const server = vi.hoisted(() => ({
    held: [] as any[],
    outbox: [] as any[],
    calls: [] as string[],
    sent: [] as any[],
    confirmed: [] as string[][],
    batches: [] as string[][],
    sendState: 'sent' as string,
    sendFails: false,
    refuse: null as null | ((item: any) => { status: number; error: string; code: string } | null),
    signals: [] as Array<{ path: string; signal: AbortSignal | undefined }>,
    stallGet: false,
    stop: null as null | { at: 'confirm' | 'receipt'; nth: number; taken: boolean; how: string },
    seen: { confirm: 0, receipt: 0 },
    stopped: false,
    deadline: null as null | AbortController,
    receiptTries: [] as Array<{ to: string; ids: string[] }>,
    /** Section 8: every wait a round makes goes through here, by name, so one of them can be made to stall. */
    point: null as null | ((name: string, run: () => any) => any),
}));
const blocks = vi.hoisted(() => ({ loaded: true }));

function stopHere(how: string): Promise<Response> | Response {
    server.stopped = true;
    if (how === 'deadline') { server.deadline?.abort(); throw new DOMException('Aborted', 'AbortError'); }
    if (how === 'network') throw new TypeError('Failed to fetch');
    if (how === 'closed') return new Promise<Response>(() => {});   // the tab closed: the request never settles
    const status = Number(how.split('-')[1]);
    return new Response(JSON.stringify({ error: `No (${status}).`, code: 'no' }), { status });
}

vi.mock('./api', async () => {
    const core = await import('@beanpool/core');
    const { hexToBytes } = await import('@noble/hashes/utils.js');
    return {
        nodeAddress: () => 'https://b.example',
        signAddressCardFor: (c: any, id: any) => core.signAddressCard(c, core.ed25519Signer(hexToBytes(id.privateKey))),
        signRelayEnvelopeFor: (f: any, id: any) => {
            const sign = () => core.signRelayEnvelope(f, core.ed25519Signer(hexToBytes(id.privateKey)));
            return server.point ? server.point('sign', sign) : sign();
        },
        signedMailFetch: vi.fn((method: string, community: string, path: string, body: any, id: unknown, signal?: AbortSignal) => {
            const ask = () => mailAnswer(method, community, path, body, id, signal);
            return server.point ? server.point(`${method} ${path.split('?')[0]}`, ask) : ask();
        }),
    };
    async function mailAnswer(method: string, _community: string, path: string, body: any, _id: unknown, signal?: AbortSignal): Promise<Response> {
            const bare = path.split('?')[0];
            server.calls.push(`${method} ${bare}`);
            server.signals.push({ path: bare, signal });
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            if (method === 'GET') {
                if (server.stallGet) await new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
                return new Response(JSON.stringify({ items: server.held.slice(0, 50), more: false, outbox: server.outbox, outboxMore: false }), { status: 200 });
            }
            const isReceipt = path === '/api/mail/send' && body.items?.[0]?.envelope?.kind === 'receipt';
            if (isReceipt) server.receiptTries.push({ to: `${body.items[0].envelope.recipient}@${body.items[0].envelope.recipientHome}`, ids: JSON.parse(body.items[0].payload).items });
            const at = path === '/api/mail/confirm' ? 'confirm' : isReceipt ? 'receipt' : null;
            const stop = at && server.stop?.at === at && ++server.seen[at] === server.stop.nth ? server.stop : null;
            if (stop && !stop.taken) return stopHere(stop.how);
            let answer: Response;
            if (path === '/api/mail/confirm') {
                server.confirmed.push(body.ids);
                const before = server.held.length;
                server.held = server.held.filter((h) => !body.ids.includes(h.envelope.itemId));
                answer = new Response(JSON.stringify({ confirmed: before - server.held.length }), { status: 200 });
            } else {
                if (server.sendFails) throw new TypeError('Failed to fetch');
                server.batches.push(body.items.map((i: RelayItem) => i.envelope.itemId));
                for (const i of body.items) {
                    const problem = server.refuse?.(i);
                    if (problem) return new Response(JSON.stringify({ error: problem.error, code: problem.code }), { status: problem.status });
                }
                server.sent.push(...body.items);
                answer = new Response(JSON.stringify({ items: body.items.map((i: RelayItem) => ({ itemId: i.envelope.itemId, state: server.sendState })) }), { status: 200 });
            }
            if (stop) return stopHere(stop.how);
            return answer;
    }
});
vi.mock('./visitor-lobby-gate', () => ({ communityInfoOnce: vi.fn(async () => ({ features: { outsideMessages: true } })) }));
vi.mock('./identity', () => ({ loadIdentity: vi.fn(async () => null) }));
vi.mock('./blocklist', () => ({
    getBlocklistStatus: () => ({ loaded: blocks.loaded, error: null }),
    isUserBlocked: () => false,
    loadBlocklist: () => {
        const read = async () => { blocks.loaded = true; return []; };
        return server.point ? server.point('loadBlocklist', read) : read();
    },
}));
// The round's own store (outsideContext) goes through `point` while section 8 runs; every other test's store is the store.
vi.mock('./outside-chat-store', async (importOriginal) => {
    const real = await importOriginal<typeof import('./outside-chat-store')>();
    return {
        ...real,
        outsideChatStore: () => {
            const store = real.outsideChatStore();
            if (!server.point) return store;
            return Object.fromEntries(Object.entries(store).map(([k, v]) => [k, typeof v === 'function'
                ? (...a: unknown[]) => server.point!(`store.${k}`, () => (v as (...a: unknown[]) => unknown).apply(store, a)) : v])) as typeof store;
        },
    };
});

import { clearOutsideChats, outsideChatStore } from './outside-chat-store';
import { myAddressCard, sendFromBox, setDoor, syncOutsideMail, type OutsideMailContext } from './outside-mail';

const DAY = 24 * 60 * 60_000;
const seedKey = () => { const seed = ed25519.utils.randomSecretKey(); return { seed: bytesToHex(seed), key: bytesToHex(ed25519.getPublicKey(seed)) }; };
const BEN = seedKey(), ANA = seedKey(), SOL = seedKey(), CY = seedKey();
const HOME = 'b.example', ANA_HOME = 'a.example', CY_HOME = 'c.example';
const uuid = () => crypto.randomUUID();

let ctx: OutsideMailContext;
let idb: MemoryIndexedDB;
let blocked: Set<string>;

beforeEach(async () => {
    Object.assign(server, {
        held: [], outbox: [], calls: [], sent: [], confirmed: [], batches: [], sendState: 'sent', sendFails: false, refuse: null, signals: [],
        stallGet: false, stop: null, seen: { confirm: 0, receipt: 0 }, stopped: false, deadline: null, receiptTries: [], point: null,
    });
    blocks.loaded = true;
    idb = memoryIndexedDB();
    vi.stubGlobal('indexedDB', idb);
    await clearOutsideChats();
    blocked = new Set();
    ctx = { nodeUrl: 'https://b.example', identity: { publicKey: BEN.key, privateKey: BEN.seed, callsign: 'Ben' }, store: outsideChatStore(), isBlocked: async (k) => blocked.has(k) };
    await ctx.store.setMeta(BEN.key, 'home', `${HOME} ${Date.now()}`);
});

/** A line `from` writes Ben, as their device seals it and their server brings it: held for Ben. */
async function heldLine(from: { seed: string; key: string }, text: string, opts: { kind?: string; sealer?: { seed: string; key: string }; home?: string } = {}) {
    const itemId = uuid();
    const sealer = opts.sealer ?? from;
    const payload = sealOutsideLine({ text, name: 'Ana Ríos', myEdPrivHex: sealer.seed, myKey: sealer.key, peerKey: BEN.key, messageId: itemId });
    const envelope = await signRelayEnvelope({
        kind: (opts.kind ?? 'dm-line') as any, itemId, senderKey: from.key, senderHome: opts.home ?? ANA_HOME, recipient: BEN.key, recipientHome: HOME,
        at: Date.now(), payloadHash: relayPayloadHash(payload),
    }, ed25519Signer(hexToBytes(from.seed)));
    const item = { kind: envelope.kind, envelope, payload: opts.kind === 'dm-blob' ? null : payload, bytes: payload.length, receivedAt: Date.now() };
    server.held.push(item);
    return item;
}

const chatWith = (key: string) => relayConversationId(BEN.key, key);
const linesWith = async (key: string) => (await ctx.store.lines(BEN.key, chatWith(key))).map((l) => ({ author: l.author, text: l.text, state: l.state }));
const textsWith = async (key: string) => (await ctx.store.lines(BEN.key, chatWith(key))).map((l) => l.text);
const openWith = (key: string, home = ANA_HOME) => ctx.store.openChat(BEN.key, chatWith(key), { key, home, name: null });
const owed = async () => (await ctx.store.owedReceipts(BEN.key, 1000)).length;
const receiptedTo = () => {
    const to: Record<string, string[]> = {};
    for (const i of server.sent.filter((s) => s.envelope.kind === 'receipt')) {
        for (const id of JSON.parse(i.payload).items) (to[id] ??= []).push(`${i.envelope.recipient}@${i.envelope.recipientHome}`);
    }
    return to;
};
const until = async (cond: () => boolean) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); };

describe('1  confirm after write', () => {
    it('writes the line in this browser before it confirms it, then receipts it to its sender\'s home', async () => {
        await openWith(ANA.key);
        const item = await heldLine(ANA, 'Hello from Riverside');
        const writes: string[] = [];
        const realWrite = ctx.store.writeTheirs;
        ctx.store.writeTheirs = async (...a) => { writes.push(`write ${a[1].id} after ${server.calls.length} calls`); await realWrite(...a); };
        expect(await syncOutsideMail(ctx)).toMatchObject({ written: 1, confirmed: 1 });
        expect(await linesWith(ANA.key)).toEqual([{ author: ANA.key, text: 'Hello from Riverside', state: null }]);
        expect(writes).toEqual([`write ${item.envelope.itemId} after 1 calls`]);
        expect(server.calls.slice(0, 2)).toEqual(['GET /api/mail', 'POST /api/mail/confirm']);
        const receipt = server.sent.find((i) => i.envelope.kind === 'receipt');
        expect(receipt.envelope).toMatchObject({ senderKey: BEN.key, senderHome: HOME, recipient: ANA.key, recipientHome: ANA_HOME });
        expect(JSON.parse(receipt.payload).items).toEqual([item.envelope.itemId]);
        expect(checkRelayItem(receipt, { signedBy: HOME, isHere: (h) => h === ANA_HOME }).ok).toBe(true);
    });
});

describe('2  a write that fails is never confirmed', () => {
    it('a full disk: the item waits at the server, nothing is receipted, and the next round writes and confirms it', async () => {
        await openWith(ANA.key);
        const item = await heldLine(ANA, 'Kept until written');
        const realWrite = ctx.store.writeTheirs;
        ctx.store.writeTheirs = async (...a) => { idb.failNextCommit(); return realWrite(...a); };
        expect((await syncOutsideMail(ctx)).confirmed).toBe(0);
        expect(server.confirmed).toEqual([]);
        expect(server.sent.filter((i) => i.envelope.kind === 'receipt')).toEqual([]);
        expect(await owed()).toBe(0);
        expect(server.held.map((h) => h.envelope.itemId)).toEqual([item.envelope.itemId]);
        expect(await textsWith(ANA.key)).toEqual([]);
        ctx.store.writeTheirs = realWrite;
        expect(await syncOutsideMail(ctx)).toMatchObject({ written: 1, confirmed: 1 });
        expect(await textsWith(ANA.key)).toEqual(['Kept until written']);
        expect(server.held).toEqual([]);
    });

    it('a block list that can\'t be read: the item is neither dropped nor shown, it waits at the server', async () => {
        await setDoor(ctx, true);
        await heldLine(SOL, 'Who am I?');
        ctx.isBlocked = async () => { throw new Error('The block list could not be read.'); };
        expect(await syncOutsideMail(ctx)).toMatchObject({ confirmed: 0, requests: 0, dropped: 0 });
        expect(server.held).toHaveLength(1);
    });

    it('a line written but never confirmed is confirmed and receipted again, and written once', async () => {
        await openWith(ANA.key);
        const item = await heldLine(ANA, 'Once');
        await ctx.store.writeTheirs(BEN.key, { id: item.envelope.itemId, chatId: chatWith(ANA.key), author: ANA.key, text: 'Once', replyTo: null, at: item.envelope.at }, { home: ANA_HOME, name: null }, 'line');
        await syncOutsideMail(ctx);
        expect(await textsWith(ANA.key)).toEqual(['Once']);
        expect(server.confirmed).toEqual([[item.envelope.itemId]]);
        expect(Object.keys(receiptedTo())).toEqual([item.envelope.itemId]);
    });
});

describe('3  the request gate', () => {
    const kinds = ['dm-line', 'dm-blob', 'dm-delete', 'group-line', 'call-signal'];
    const chats: Array<{ state: OutsideChatState; theirLines: number } | null> = [
        null, { state: 'request', theirLines: 0 }, { state: 'request', theirLines: 1 }, { state: 'open', theirLines: 0 }, { state: 'open', theirLines: 5 },
        { state: 'declined', theirLines: 1 },
    ];
    /** The rule in words (design §3.5): blocked never; an open chat takes lines; a stranger, one line of words, through an open door. */
    const expected = (kind: string, chat: typeof chats[number], doorOpen: boolean, isBlocked: boolean) => {
        if (isBlocked) return 'drop';
        if (chat?.state === 'open') return kind === 'dm-line' ? 'line' : 'drop';
        if (kind !== 'dm-line' || chat?.state === 'declined') return 'drop';
        if (chat?.state === 'request') return chat.theirLines === 0 ? 'request' : 'drop';
        return doorOpen ? 'request' : 'drop';
    };
    it('every kind x chat x door x block', () => {
        const wrong: string[] = [];
        for (const kind of kinds) for (const chat of chats) for (const doorOpen of [false, true]) for (const isBlocked of [false, true]) {
            const got = gateOutsideItem({ kind, chat, doorOpen, blocked: isBlocked });
            if (got !== expected(kind, chat, doorOpen, isBlocked)) wrong.push(`${kind} ${JSON.stringify(chat)} door=${doorOpen} blocked=${isBlocked}: ${got}`);
        }
        expect(wrong).toEqual([]);
    });

    it('through a round: door closed drops a stranger (confirmed, no receipt); open, one line waits; the second and a blob drop; Accept lets the next in', async () => {
        const first = await heldLine(SOL, 'Hi, stranger here');
        expect(await syncOutsideMail(ctx)).toMatchObject({ requests: 0, written: 0, dropped: 1, confirmed: 1 });
        expect(await ctx.store.chat(BEN.key, chatWith(SOL.key))).toBeNull();
        expect(server.confirmed).toEqual([[first.envelope.itemId]]);
        expect(server.sent).toEqual([]);

        await setDoor(ctx, true);
        await heldLine(SOL, 'May I ask about the bikes?');
        await syncOutsideMail(ctx);
        expect(await ctx.store.chat(BEN.key, chatWith(SOL.key))).toMatchObject({ state: 'request', restored: false, peerHome: ANA_HOME, peerName: 'Ana Ríos' });
        await heldLine(SOL, 'Hello??');
        await heldLine(SOL, 'a photo', { kind: 'dm-blob' });
        expect(await syncOutsideMail(ctx)).toMatchObject({ requests: 0, written: 0, dropped: 2, confirmed: 2 });
        expect(await textsWith(SOL.key)).toEqual(['May I ask about the bikes?']);
        await ctx.store.decide(BEN.key, chatWith(SOL.key), 'open');
        await heldLine(SOL, 'Thanks for accepting');
        expect(await syncOutsideMail(ctx)).toMatchObject({ written: 1 });
        expect(await textsWith(SOL.key)).toEqual(['May I ask about the bikes?', 'Thanks for accepting']);

        blocked.add(SOL.key);
        await heldLine(SOL, 'After the block');
        expect(await syncOutsideMail(ctx)).toMatchObject({ dropped: 1, written: 0 });
        expect(await textsWith(SOL.key)).toEqual(['May I ask about the bikes?', 'Thanks for accepting']);
    });

    it('a line that is not its envelope\'s (another\'s seal, a changed payload, to someone else): dropped and confirmed, never shown', async () => {
        await openWith(ANA.key);
        await heldLine(ANA, 'Not Ana', { sealer: CY });
        const changed = await heldLine(ANA, 'Changed');
        changed.payload = String(changed.payload).replace(/"c":"./, '"c":"A');
        const other = await heldLine(ANA, 'For Cy');
        other.envelope = { ...other.envelope, recipient: CY.key };
        expect(await syncOutsideMail(ctx)).toMatchObject({ written: 0, dropped: 3, confirmed: 3 });
        expect(await textsWith(ANA.key)).toEqual([]);
        expect(server.sent).toEqual([]);
    });
});

describe('4  a refused resend fails per line', () => {
    async function threeUnsent() {
        await openWith(ANA.key);
        server.sendFails = true;
        for (const w of ['one', 'two', 'three']) await sendFromBox(ctx, chatWith(ANA.key), w, 5_000, () => {});
        server.sendFails = false;
        const lines = await ctx.store.lines(BEN.key, chatWith(ANA.key));
        expect(lines.map((l) => l.state)).toEqual(['sending', 'sending', 'sending']);
        return lines;
    }

    it('one line my server refuses fails with its words; the other two still go', async () => {
        const [, two] = await threeUnsent();
        server.refuse = (i) => (i.envelope.itemId === two.id ? { status: 400, error: 'That line names another home.', code: 'bad_item' } : null);
        await syncOutsideMail(ctx);
        const after = await ctx.store.lines(BEN.key, chatWith(ANA.key));
        expect(after.map((l) => [l.text, l.state, l.note])).toEqual([['one', 'sent', null], ['two', 'failed', 'That line names another home.'], ['three', 'sent', null]]);
    });

    it('a 403 fails every waiting line with its words; a 503 leaves them all to go at the next round', async () => {
        await threeUnsent();
        server.refuse = () => ({ status: 503, error: 'Busy.', code: 'busy' });
        await syncOutsideMail(ctx);
        expect((await ctx.store.lines(BEN.key, chatWith(ANA.key))).map((l) => l.state)).toEqual(['sending', 'sending', 'sending']);
        server.refuse = () => ({ status: 403, error: "This community doesn't take messages from other communities.", code: 'outside_messages_off' });
        await syncOutsideMail(ctx);
        expect((await ctx.store.lines(BEN.key, chatWith(ANA.key))).map((l) => [l.state, l.note])).toEqual(
            Array(3).fill(['failed', "This community doesn't take messages from other communities."]));
    });
});

describe('5  a deadline on every round', () => {
    it('every request a round makes carries its signal, and an aborted round asks nothing more', async () => {
        await openWith(ANA.key);
        await heldLine(ANA, 'Signed with the deadline');
        const controller = new AbortController();
        await syncOutsideMail({ ...ctx, signal: controller.signal });
        expect(server.signals.length).toBeGreaterThanOrEqual(3);
        expect(server.signals.every((s) => s.signal === controller.signal)).toBe(true);
        controller.abort();
        const before = server.calls.length;
        await expect(syncOutsideMail({ ...ctx, signal: controller.signal })).rejects.toThrow();
        expect(server.calls.length - before).toBeLessThanOrEqual(1);
    });

    it('syncOutsideMailNow lets a stalled round go at its deadline, and the next round runs afresh', async () => {
        const identity = await import('./identity');
        vi.mocked(identity.loadIdentity).mockResolvedValue({ publicKey: BEN.key, privateKey: BEN.seed, callsign: 'Ben', createdAt: '' });
        const { syncOutsideMailNow } = await import('./outside-mail');
        server.stallGet = true;
        expect(await syncOutsideMailNow(60)).toBeNull();
        server.stallGet = false;
        await ctx.store.openChat(BEN.key, chatWith(ANA.key), { key: ANA.key, home: ANA_HOME, name: null });
        await heldLine(ANA, 'After the stall');
        expect(await syncOutsideMailNow(5_000)).toMatchObject({ written: 1 });
        vi.mocked(identity.loadIdentity).mockResolvedValue(null);
    });
});

describe('6  a receipt outlives the round (the phone\'s round 3 finding: "the receipts not yet sent are lost")', () => {
    const POINTS = [
        { at: 'confirm', nth: 1, taken: false, what: 'the confirm, before my server deleted the page' },
        { at: 'confirm', nth: 1, taken: true, what: 'the confirm, after my server deleted the page (its answer lost)' },
        { at: 'receipt', nth: 1, taken: false, what: 'the first receipt, before my server took it' },
        { at: 'receipt', nth: 1, taken: true, what: 'the first receipt, after my server took it (its answer lost)' },
        { at: 'receipt', nth: 2, taken: false, what: 'the second receipt, the first one taken' },
        { at: 'receipt', nth: 2, taken: true, what: 'the second receipt, after my server took it (its answer lost)' },
    ] as const;
    const BEFORE = ['deadline', 'network', 'closed', 'refused-403', 'refused-400', 'busy-503'];
    const AFTER = ['deadline', 'network', 'closed'];
    for (const point of POINTS) for (const how of point.taken ? AFTER : BEFORE) {
        it(`stopped at ${point.what}, by ${how}: both lines written once, confirmed, and receipted to their senders' homes`, async () => {
            await openWith(ANA.key);
            await openWith(CY.key, CY_HOME);
            const ana = await heldLine(ANA, 'From Ana');
            const cy = await heldLine(CY, 'From Cy', { home: CY_HOME });
            const controller = new AbortController();
            server.deadline = controller;
            server.stop = { ...point, how };
            const first = syncOutsideMail({ ...ctx, signal: controller.signal }).catch(() => null);
            if (how === 'closed') await until(() => server.stopped); else await first;
            expect(server.stopped, 'the round reached its stop').toBe(true);
            server.stop = null;
            for (let i = 0; i < 2; i++) await syncOutsideMail({ ...ctx, signal: new AbortController().signal });
            expect([...await textsWith(ANA.key), ...await textsWith(CY.key)]).toEqual(['From Ana', 'From Cy']);
            expect(server.held).toEqual([]);
            const to = receiptedTo();
            expect([...new Set(to[ana.envelope.itemId])]).toEqual([`${ANA.key}@${ANA_HOME}`]);
            expect([...new Set(to[cy.envelope.itemId])]).toEqual([`${CY.key}@${CY_HOME}`]);
            expect(await owed()).toBe(0);
        });
    }

    it('a receipt owed for more than 30 days goes unsent; 200 owed ids a round at most, 50 to a receipt', async () => {
        const now = Date.now();
        await ctx.store.oweReceipt(BEN.key, { id: uuid(), key: ANA.key, home: ANA_HOME }, now - 31 * DAY);
        const fresh = uuid();
        await ctx.store.oweReceipt(BEN.key, { id: fresh, key: ANA.key, home: ANA_HOME }, now - 29 * DAY);
        await syncOutsideMail(ctx, now);
        expect(server.receiptTries).toEqual([{ to: `${ANA.key}@${ANA_HOME}`, ids: [fresh] }]);
        expect(await owed()).toBe(0);
        server.receiptTries = [];
        for (let i = 0; i < 250; i++) await ctx.store.oweReceipt(BEN.key, { id: uuid(), key: ANA.key, home: ANA_HOME }, now);
        await syncOutsideMail(ctx, now);
        expect(server.receiptTries.map((r) => r.ids.length)).toEqual([50, 50, 50, 50]);
        expect(await owed()).toBe(50);
    });
});

describe('7  typed words, ticks, the card', () => {
    it('a send with no home known keeps nothing and says so: the words stay with the caller; a kept line empties the box once', async () => {
        await openWith(ANA.key);
        await ctx.store.setMeta(BEN.key, 'home', '');
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
        let emptied = 0;
        const lost = await sendFromBox(ctx, chatWith(ANA.key), 'Keep me', 5_000, () => { emptied++; });
        expect(lost.kept).toBe(false);
        expect(emptied).toBe(0);
        expect(await textsWith(ANA.key)).toEqual([]);
        vi.unstubAllGlobals();
        vi.stubGlobal('indexedDB', idb);
        await ctx.store.setMeta(BEN.key, 'home', `${HOME} ${Date.now()}`);
        server.sendFails = true;
        const kept = await sendFromBox(ctx, chatWith(ANA.key), 'Keep me', 5_000, () => { emptied++; });
        expect(kept.kept).toBe(true);
        expect(emptied).toBe(1);
        expect(await linesWith(ANA.key)).toEqual([{ author: BEN.key, text: 'Keep me', state: 'sending' }]);
    });

    it('a tick sets Delivered; a tick for a chat this browser lacks brings it back empty and restored', async () => {
        await openWith(ANA.key);
        await sendFromBox(ctx, chatWith(ANA.key), 'Did it arrive?', 5_000, () => {});
        const [mine] = await ctx.store.lines(BEN.key, chatWith(ANA.key));
        server.outbox = [
            { itemId: mine.id, kind: 'dm-line', recipient: ANA.key, recipientHome: ANA_HOME, state: 'delivered', at: Date.now() },
            { itemId: uuid(), kind: 'dm-line', recipient: SOL.key, recipientHome: 'd.example', state: 'sent', at: Date.now() + 1 },
        ];
        await syncOutsideMail(ctx);
        expect((await ctx.store.lines(BEN.key, chatWith(ANA.key)))[0].state).toBe('delivered');
        expect(await ctx.store.chat(BEN.key, chatWith(SOL.key))).toMatchObject({ state: 'open', restored: true, peerHome: 'd.example' });
        expect(await textsWith(SOL.key)).toEqual([]);
    });

    it('my card names my key, my home and my name, and its signature checks', async () => {
        const { addressCardFromText, addressCardLink } = await import('@beanpool/core');
        const card = await myAddressCard(ctx);
        expect(card).toMatchObject({ key: BEN.key, home: HOME, name: 'Ben' });
        expect(addressCardFromText(addressCardLink(card!))).toEqual(card);
    });
});

describe('8  a stalled wait never holds the round\'s lock (#3183: "a stalled block-list read keeps the round\'s lock past its deadline")', () => {
    /**
     * Every wait a round makes, in order, as `name#n` (its n-th in the round). Switch on: a round that resends a waiting line
     * of mine, reads its community's home again (two hours old), reads the block list (not yet read on this page), writes,
     * confirms and receipts a line from Ana, and applies the tick for my line. Switch off: the round that fails my waiting
     * line. The first test proves these ARE every wait such a round makes, so a wait added later has to join this table.
     */
    const ON = [
        'loadIdentity#1', 'communityInfo#1', 'store.unsent#1', 'POST /api/mail/send#1', 'store.setMineState#1', 'store.getMeta#1',
        'store.getMeta#2', 'GET /api/mail#1', 'store.hasLine#1', 'store.chat#1', 'store.theirLines#1', 'loadBlocklist#1',
        'store.writeTheirs#1', 'store.oweReceipt#1', 'POST /api/mail/confirm#1', 'store.forgetReceiptsOwedBefore#1',
        'store.owedReceipts#1', 'store.getMeta#3', 'fetch /api/community/info#1', 'store.setMeta#1', 'sign#1', 'POST /api/mail/send#2',
        'store.receiptsSent#1', 'store.hasLine#2', 'store.setMineState#2', 'store.setMeta#2',
    ];
    const OFF = ['loadIdentity#1', 'communityInfo#1', 'store.unsent#1', 'store.setMineState#1', 'store.unsent#2'];
    /** Never asked and never answered; asked and never answered; answered, but after the deadline. */
    const HOW = ['lost', 'unanswered', 'late'] as const;
    /** Round 1's deadline: its timer is caught and fired by hand the moment the round reaches its stall. */
    const BUDGET = 7_777;
    const OFF_WORDS = "This community doesn't take messages from other communities.";
    const realSetTimeout = globalThis.setTimeout;
    const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => realSetTimeout(r, 0)); };

    /** One round's waits, recorded; `stall` makes one of them stall, as its `how` says. */
    function pointer(stall: { at: string; how: typeof HOW[number] } | null) {
        const seen: string[] = [];
        const counts = new Map<string, number>();
        let reachedIt!: () => void;
        let release!: () => void;
        const reached = new Promise<void>((r) => { reachedIt = r; });
        const released = new Promise<void>((r) => { release = r; });
        const point = (name: string, run: () => any) => {
            const n = (counts.get(name) ?? 0) + 1;
            counts.set(name, n);
            seen.push(`${name}#${n}`);
            if (stall?.at !== `${name}#${n}`) return run();
            reachedIt();
            if (stall.how === 'lost') return new Promise(() => {});
            const answer = Promise.resolve().then(run);
            answer.catch(() => {});
            return stall.how === 'unanswered' ? new Promise(() => {}) : released.then(() => answer);
        };
        return { seen, point, reached, release };
    }

    /** navigator.locks as a browser's: one holder; `ifAvailable` gets null while it is held; held until the callback settles. */
    function lockStandIn() {
        const state = { held: false };
        const locks = {
            async request(name: string, _opts: { ifAvailable?: boolean }, callback: (lock: object | null) => unknown) {
                if (state.held) return callback(null);
                state.held = true;
                try { return await callback({ name }); } finally { state.held = false; }
            },
        };
        return { state, locks };
    }

    async function scenario(on: boolean) {
        await openWith(ANA.key);
        server.sendFails = true;
        await sendFromBox(ctx, chatWith(ANA.key), 'Mine, waiting', 5_000, () => {});
        server.sendFails = false;
        const [mine] = await ctx.store.lines(BEN.key, chatWith(ANA.key));
        if (!on) return { mine, held: null };
        const held = await heldLine(ANA, 'From Ana');
        server.outbox = [{ itemId: mine.id, kind: 'dm-line', recipient: ANA.key, recipientHome: ANA_HOME, state: 'delivered', at: Date.now() }];
        await ctx.store.setMeta(BEN.key, 'home', `${HOME} ${Date.now() - 2 * 60 * 60_000}`);
        blocks.loaded = false;
        return { mine, held };
    }

    /** Runs `body` with the account, the community's info and address, and the lock as a browser has them; then puts them back. */
    async function inABrowser<T>(on: boolean, body: (lock: { held: boolean }) => Promise<T>): Promise<T> {
        const identity = await import('./identity');
        const gate = await import('./visitor-lobby-gate');
        vi.mocked(identity.loadIdentity).mockImplementation(() => server.point!('loadIdentity', async () => ({ publicKey: BEN.key, privateKey: BEN.seed, callsign: 'Ben', createdAt: '' })));
        vi.mocked(gate.communityInfoOnce).mockImplementation(() => server.point!('communityInfo', async () => ({ features: { outsideMessages: on } })));
        vi.stubGlobal('fetch', vi.fn((url: string) => server.point!('fetch /api/community/info', async () => {
            expect(String(url)).toBe('https://b.example/api/community/info');
            return new Response(JSON.stringify({ primaryAddress: HOME }), { status: 200 });
        })));
        const { state, locks } = lockStandIn();
        Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
        try {
            return await body(state);
        } finally {
            delete (navigator as { locks?: unknown }).locks;
            vi.mocked(identity.loadIdentity).mockImplementation(async () => null);
            vi.mocked(gate.communityInfoOnce).mockImplementation(async () => ({ features: { outsideMessages: true } }) as any);
            vi.unstubAllGlobals();
            vi.stubGlobal('indexedDB', idb);
            server.point = null;
        }
    }

    for (const on of [true, false]) {
        it(`the table names every wait a round makes, in order (switch ${on ? 'on' : 'off'})`, async () => {
            const { syncOutsideMailNow } = await import('./outside-mail');
            await scenario(on);
            const recorded = await inABrowser(on, async () => {
                const p = pointer(null);
                server.point = p.point;
                const out = await syncOutsideMailNow(5_000);
                if (on) expect(out).toMatchObject({ written: 1, confirmed: 1, ticks: 1 });
                return p.seen;
            });
            expect(recorded).toEqual(on ? ON : OFF);
        });
    }

    for (const on of [true, false]) for (const at of on ? ON : OFF) for (const how of HOW) {
        it(`switch ${on ? 'on' : 'off'}, ${at} ${how}: let go with the lock at the deadline, nothing after it, the next round runs`, async () => {
            const { syncOutsideMailNow } = await import('./outside-mail');
            const { mine, held } = await scenario(on);
            await inABrowser(on, async (lock) => {
                let fireDeadline: (() => void) | null = null;
                const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
                    if (ms !== BUDGET) return realSetTimeout(fn, ms, ...rest);
                    fireDeadline = fn;
                    return 0 as unknown as ReturnType<typeof setTimeout>;
                }) as typeof setTimeout);
                const p1 = pointer({ at, how });
                server.point = p1.point;
                let round1!: Promise<unknown>;
                try {
                    round1 = syncOutsideMailNow(BUDGET);
                } finally {
                    timers.mockRestore();
                }
                const first = await Promise.race([p1.reached.then(() => 'reached'), round1.then(() => 'finished')]);
                expect(first, `round 1 reached ${at}`).toBe('reached');
                expect(lock.held, 'round 1 holds the lock').toBe(true);
                const seenAtDeadline = p1.seen.length;
                expect(fireDeadline, 'round 1 set its deadline').not.toBeNull();
                fireDeadline!();
                expect(await round1, 'round 1 answers at its deadline').toBeNull();
                expect(lock.held, 'the lock is handed back at the deadline').toBe(false);
                p1.release();
                await settle();
                expect(p1.seen.slice(seenAtDeadline), 'round 1 waits on nothing more after its deadline').toEqual([]);

                const p2 = pointer(null);
                server.point = p2.point;
                const out = await syncOutsideMailNow(5_000);
                expect(p2.seen.slice(0, 2), 'the next round took the lock and ran').toEqual(['loadIdentity#1', 'communityInfo#1']);
                expect(lock.held).toBe(false);
                const lines = await ctx.store.lines(BEN.key, chatWith(ANA.key));
                if (!on) {
                    expect(out).toBeNull();
                    expect(lines.map((l) => [l.text, l.state, l.note])).toEqual([['Mine, waiting', 'failed', OFF_WORDS]]);
                    return;
                }
                expect(out, 'the next round answers').not.toBeNull();
                expect(lines.map((l) => [l.id === mine.id ? 'mine' : l.author === ANA.key ? 'Ana' : '?', l.text, l.state]))
                    .toEqual([['mine', 'Mine, waiting', 'delivered'], ['Ana', 'From Ana', null]]);
                expect(server.held).toEqual([]);
                expect([...new Set(receiptedTo()[held!.envelope.itemId])]).toEqual([`${ANA.key}@${ANA_HOME}`]);
                expect(await owed()).toBe(0);
            });
        });
    }
});

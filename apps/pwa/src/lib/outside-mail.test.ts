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
 *   9  each device for itself (X2b, scratch/fable-design/decisions/DECISION-outside-door.md; the phone's 14 to 19): every
 *      fetch and confirm names this browser's own id; another device listed is still served what this one wrote or dropped;
 *      my ticks are in before any held item is judged; a tick for a line I wrote elsewhere opens its chat here, never one
 *      with someone blocked; Sign Out asks the community to forget this browser, 4 s at most, never a reason it stops
 *  10  a round never acts for an account or a community it no longer belongs to (#3183 round 4): Sign Out, a move to
 *      another community, the delete here x every wait a round makes x answered after / asked after -> nothing asked, no
 *      wait started, nothing written for the old account or community; and what is kept (the home among it) is the
 *      community's own, as the phone keeps it in each community's file
 *
 * The mailbox played here is X2b's: GET /api/mail and POST /api/mail/confirm refuse a request without the device (400
 * bad_device), an item is served to each device until it has confirmed it, and goes once every device listed has.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
    checkRelayItem, ed25519Signer, gateOutsideItem, relayConversationId, relayPayloadHash, sealOutsideLine, signRelayEnvelope,
    type OutsideChatState, type RelayItem,
} from '@beanpool/core';
import { MemoryIDBKeyRange, memoryIndexedDB, type MemoryIndexedDB } from './memory-indexeddb';

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
    /** X2b: the device each fetch, confirm and forget named, in order (`call` GET, confirm or forget). */
    named: [] as Array<{ call: string; device: unknown }>,
    /** The devices listed for Ben (each that fetched, until forgotten), and which device has confirmed which item. */
    listed: new Set<string>(),
    got: new Map<string, Set<string>>(),
    forgot: [] as string[],
    /** Ticks served a page at a time (`more`: outboxMore), when set; else `outbox` on every fetch. */
    outboxPages: null as null | Array<{ ticks: any[]; more: boolean }>,
    /** How the forget is answered, when set (a stall, a throw). */
    forgetAnswer: null as null | ((signal: AbortSignal | undefined) => Promise<Response>),
    /** Every request a server took, in order: asked with a signal not yet aborted (an aborted fetch never leaves a browser). */
    served: [] as string[],
}));
const MAIL_DEVICE = /^[0-9a-f]{32}$/;
const badDevice = () => new Response(JSON.stringify({ error: "device is this device's mail id: 32 lowercase hex characters, made by the app.", code: 'bad_device' }), { status: 400 });
/** As the server's settleMailFor: an item goes once a device has confirmed it and every device listed has. */
function settleHeld() {
    server.held = server.held.filter((h) => {
        const got = server.got.get(h.envelope.itemId);
        return !(got && got.size > 0 && [...server.listed].every((d) => got.has(d)));
    });
}
const blocks = vi.hoisted(() => ({ loaded: true }));

function stopHere(how: string): Promise<Response> | Response {
    server.stopped = true;
    if (how === 'deadline') { server.deadline?.abort(); throw new DOMException('Aborted', 'AbortError'); }
    if (how === 'network') throw new TypeError('Failed to fetch');
    if (how === 'closed') return new Promise<Response>(() => {});   // the tab closed: the request never settles
    const status = Number(how.split('-')[1]);
    return new Response(JSON.stringify({ error: `No (${status}).`, code: 'no' }), { status });
}

vi.mock('./api', async (importOriginal) => {
    const core = await import('@beanpool/core');
    const { hexToBytes } = await import('@noble/hashes/utils.js');
    // The real module (the node address the web app talks to, kept in localStorage as a browser keeps it); its mail calls played here.
    const real = await importOriginal<typeof import('./api')>();
    return {
        ...real,
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
            server.served.push(`${method} ${bare}`);
            if (method === 'GET') {
                const device = new URLSearchParams(path.split('?')[1] ?? '').get('device');
                server.named.push({ call: 'GET', device });
                if (!device || !MAIL_DEVICE.test(device)) return badDevice();
                server.listed.add(device);
                if (server.stallGet) await new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
                const page = server.outboxPages ? (server.outboxPages.shift() ?? { ticks: [], more: false }) : { ticks: server.outbox, more: false };
                const items = server.held.filter((h) => !server.got.get(h.envelope.itemId)?.has(device)).slice(0, 50);
                return new Response(JSON.stringify({ items, more: false, outbox: page.ticks, outboxMore: page.more }), { status: 200 });
            }
            if (path === '/api/mail/device/forget') {
                server.named.push({ call: 'forget', device: body?.device });
                if (server.forgetAnswer) return server.forgetAnswer(signal);
                if (typeof body?.device !== 'string' || !MAIL_DEVICE.test(body.device)) return badDevice();
                server.forgot.push(body.device);
                server.listed.delete(body.device);
                settleHeld();
                return new Response(JSON.stringify({ forgotten: true }), { status: 200 });
            }
            const isReceipt = path === '/api/mail/send' && body.items?.[0]?.envelope?.kind === 'receipt';
            if (isReceipt) server.receiptTries.push({ to: `${body.items[0].envelope.recipient}@${body.items[0].envelope.recipientHome}`, ids: JSON.parse(body.items[0].payload).items });
            const at = path === '/api/mail/confirm' ? 'confirm' : isReceipt ? 'receipt' : null;
            const stop = at && server.stop?.at === at && ++server.seen[at] === server.stop.nth ? server.stop : null;
            if (stop && !stop.taken) return stopHere(stop.how);
            let answer: Response;
            if (path === '/api/mail/confirm') {
                server.named.push({ call: 'confirm', device: body?.device });
                if (typeof body?.device !== 'string' || !MAIL_DEVICE.test(body.device)) return badDevice();
                server.confirmed.push(body.ids);
                let mine = 0;
                for (const h of server.held) {
                    if (!body.ids.includes(h.envelope.itemId)) continue;
                    const got = server.got.get(h.envelope.itemId) ?? new Set<string>();
                    if (!got.has(body.device)) { got.add(body.device); mine++; }
                    server.got.set(h.envelope.itemId, got);
                }
                settleHeld();
                answer = new Response(JSON.stringify({ confirmed: mine }), { status: 200 });
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
        outsideChatStore: (...args: Parameters<typeof real.outsideChatStore>) => {
            const store = real.outsideChatStore(...args);
            if (!server.point) return store;
            return Object.fromEntries(Object.entries(store).map(([k, v]) => [k, typeof v === 'function'
                ? (...a: unknown[]) => server.point!(`store.${k}`, () => (v as (...a: unknown[]) => unknown).apply(store, a)) : v])) as typeof store;
        },
    };
});

import { clearOutsideChats, outsideChatStore } from './outside-chat-store';
import {
    FORGET_DEVICE_MS, doorOpen, forgetThisBrowserForMail, mailDevice, myAddressCard, myHome, sendFromBox, setDoor, syncOutsideMail,
    type OutsideMailContext,
} from './outside-mail';
import { setNodeApiUrl } from './api';
import { resetAccountEpochForTest } from './account-epoch';

const DAY = 24 * 60 * 60_000;
const seedKey = () => { const seed = ed25519.utils.randomSecretKey(); return { seed: bytesToHex(seed), key: bytesToHex(ed25519.getPublicKey(seed)) }; };
const BEN = seedKey(), ANA = seedKey(), SOL = seedKey(), CY = seedKey();
const HOME = 'b.example', ANA_HOME = 'a.example', CY_HOME = 'c.example';
/** The community this web app talks to here (Settings' node address), and the one a move takes it to. */
const B = 'https://b.example', C = 'https://c.example';
/** Ben's home as this browser keeps it for B: `<home> <when> <community>`. */
const keptHome = (at = Date.now()) => `${HOME} ${at} ${B}`;
const uuid = () => crypto.randomUUID();

let ctx: OutsideMailContext;
let idb: MemoryIndexedDB;
let blocked: Set<string>;

beforeEach(async () => {
    Object.assign(server, {
        held: [], outbox: [], calls: [], sent: [], confirmed: [], batches: [], sendState: 'sent', sendFails: false, refuse: null, signals: [],
        stallGet: false, stop: null, seen: { confirm: 0, receipt: 0 }, stopped: false, deadline: null, receiptTries: [], point: null,
        named: [], listed: new Set(), got: new Map(), forgot: [], outboxPages: null, forgetAnswer: null, served: [],
    });
    blocks.loaded = true;
    idb = memoryIndexedDB();
    vi.stubGlobal('indexedDB', idb);
    vi.stubGlobal('IDBKeyRange', MemoryIDBKeyRange);
    await clearOutsideChats();
    // This page, as one loaded now, signed in, the web app pointed at B.
    localStorage.clear();
    setNodeApiUrl(B);
    resetAccountEpochForTest();
    blocked = new Set();
    ctx = { nodeUrl: B, identity: { publicKey: BEN.key, privateKey: BEN.seed, callsign: 'Ben' }, store: outsideChatStore(B), isBlocked: async (k) => blocked.has(k) };
    await ctx.store.setMeta(BEN.key, 'home', keptHome());
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
        await ctx.store.setMeta(BEN.key, 'home', keptHome());
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

// ─── A round as a browser runs it (sections 8 and 10) ─────────────────────────────────────────────────────────

/**
 * Every wait a round makes, in order, as `name#n` (its n-th in the round). Switch on: a round that resends a waiting line
 * of mine, reads its community's home again (two hours old), reads the block list (not yet read on this page), writes,
 * confirms and receipts a line from Ana, and applies the tick for my line. Switch off: the round that fails my waiting
 * line. The first test proves these ARE every wait such a round makes, so a wait added later has to join this table.
 */
// X2b: this browser's mail id (store.metaOrMake), then the ticks (hasLine, setMineState, the cursor's setMeta) before the
// held item is judged.
const ON = [
    'loadIdentity#1', 'communityInfo#1', 'store.unsent#1', 'POST /api/mail/send#1', 'store.setMineState#1', 'store.getMeta#1',
    'store.metaOrMake#1', 'store.getMeta#2', 'GET /api/mail#1', 'store.hasLine#1', 'store.setMineState#2', 'store.setMeta#1',
    'store.hasLine#2', 'store.chat#1', 'store.theirLines#1', 'loadBlocklist#1',
    'store.writeTheirs#1', 'store.oweReceipt#1', 'POST /api/mail/confirm#1', 'store.forgetReceiptsOwedBefore#1',
    'store.owedReceipts#1', 'store.getMeta#3', 'fetch /api/community/info#1', 'store.setMeta#2', 'sign#1', 'POST /api/mail/send#2',
    'store.receiptsSent#1',
];
const OFF = ['loadIdentity#1', 'communityInfo#1', 'store.unsent#1', 'store.setMineState#1', 'store.unsent#2'];
/** Never asked and never answered; asked and never answered; answered, but after the deadline. */
const HOW = ['lost', 'unanswered', 'late'] as const;
/** Section 10's: asked before and answered after its event (`late`), or asked only after it (`gap`: the call was under way). */
type Stall = typeof HOW[number] | 'gap';
/** Round 1's deadline: its timer is caught and fired by hand the moment the round reaches its stall. */
const BUDGET = 7_777;
const OFF_WORDS = "This community doesn't take messages from other communities.";
const realSetTimeout = globalThis.setTimeout;
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => realSetTimeout(r, 0)); };

/** One round's waits, recorded; `stall` makes one of them stall, as its `how` says. */
function pointer(stall: { at: string; how: Stall } | null) {
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
        if (stall.how === 'gap') return released.then(run);
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
    await ctx.store.setMeta(BEN.key, 'home', keptHome(Date.now() - 2 * 60 * 60_000));
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

describe('8  a stalled wait never holds the round\'s lock (#3183: "a stalled block-list read keeps the round\'s lock past its deadline")', () => {
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

describe('9  each device for itself (X2b: "each device confirms for itself", DECISION-outside-door.md)', () => {
    /** Another browser or phone of Ben's, listed at his server (it has fetched once). */
    const OTHER = 'f'.repeat(32);
    const named = (call: string) => server.named.filter((n) => n.call === call).map((n) => n.device);
    const chatOf = (key: string) => ctx.store.chat(BEN.key, chatWith(key));
    /** A tick for a line I wrote `key` on another device (or before this browser was signed in). */
    const tickTo = (key: string, state = 'sent', at = Date.now()) => ({ itemId: uuid(), kind: 'dm-line', recipient: key, recipientHome: ANA_HOME, state, at });

    it('every fetch and confirm names this browser\'s id: one for the account, kept round to round, its own for another account here, a new one after Sign Out', async () => {
        await openWith(ANA.key);
        await heldLine(ANA, 'One');
        await syncOutsideMail(ctx);
        await heldLine(ANA, 'Two');
        await syncOutsideMail(ctx);
        const id = await mailDevice(ctx);
        expect(id).toMatch(MAIL_DEVICE);
        expect(named('GET')).toEqual([id, id]);
        expect(named('confirm')).toEqual([id, id]);
        expect(server.listed).toEqual(new Set([id]));
        expect(server.held).toEqual([]);
        // Another account in this browser: its own id, in its own documents; Ben's is unchanged.
        const cyId = await mailDevice({ ...ctx, identity: { publicKey: CY.key, privateKey: CY.seed, callsign: 'Cy' } });
        expect(cyId).toMatch(MAIL_DEVICE);
        expect(cyId).not.toBe(id);
        expect(await mailDevice(ctx)).toBe(id);
        // Sign Out takes the store and the id with it: the next round here names a new one.
        await clearOutsideChats();
        server.named = [];
        await syncOutsideMail(ctx);
        expect(named('GET')).toHaveLength(1);
        expect(named('GET')[0]).toMatch(MAIL_DEVICE);
        expect(named('GET')[0]).not.toBe(id);
        // A kept value that is no device id is never sent: a new one replaces it.
        await ctx.store.setMeta(BEN.key, 'device', 'not-a-device');
        expect(await mailDevice(ctx)).toMatch(MAIL_DEVICE);
    });

    it('another device listed is still served what this browser wrote and what it dropped; once it has them too, they go', async () => {
        server.listed.add(OTHER);
        await openWith(ANA.key);
        const line = await heldLine(ANA, 'To both of Ben\'s devices');
        const stranger = await heldLine(SOL, 'A stranger at this browser\'s closed door');
        expect(await syncOutsideMail(ctx)).toMatchObject({ written: 1, dropped: 1, confirmed: 2 });
        expect(await textsWith(ANA.key)).toEqual(['To both of Ben\'s devices']);
        expect(await chatOf(SOL.key)).toBeNull();
        expect(server.held.map((h) => h.envelope.itemId)).toEqual([line.envelope.itemId, stranger.envelope.itemId]);
        // Not served here again.
        expect(await syncOutsideMail(ctx)).toMatchObject({ written: 0, dropped: 0, confirmed: 0 });
        // The other device confirms them: now every device listed has them, and they go.
        const api = await import('./api');
        await api.signedMailFetch('POST', 'https://b.example', '/api/mail/confirm', { ids: [line.envelope.itemId, stranger.envelope.itemId], device: OTHER }, ctx.identity as any);
        expect(server.held).toEqual([]);
    });

    describe('my ticks are in before any held item is judged (a new browser\'s first page; the phone\'s 15)', () => {
        it('a line from someone I wrote to on another device is written here, though this browser\'s door is closed', async () => {
            await heldLine(SOL, 'Answering what you wrote on your phone');
            server.outbox = [tickTo(SOL.key, 'delivered', Date.now() - 1_000)];
            expect(await syncOutsideMail(ctx)).toMatchObject({ written: 1, requests: 0, dropped: 0, ticks: 1 });
            expect(await chatOf(SOL.key)).toMatchObject({ state: 'open', restored: true, peerHome: ANA_HOME });
            expect(await textsWith(SOL.key)).toEqual(['Answering what you wrote on your phone']);
            expect(server.held).toEqual([]);
        });

        it('every page of ticks first: the held items wait, neither judged nor confirmed, while more ticks wait', async () => {
            await heldLine(SOL, 'Answering what you wrote on your phone');
            server.outboxPages = [
                { ticks: [{ ...tickTo(ANA.key, 'delivered', 1763020900000), kind: 'receipt' }], more: true },
                { ticks: [tickTo(SOL.key, 'sent', 1763020900001)], more: false },
            ];
            expect(await syncOutsideMail(ctx)).toMatchObject({ written: 1, dropped: 0, confirmed: 1, ticks: 1 });
            expect(named('GET')).toHaveLength(2);
            expect(server.confirmed).toHaveLength(1);
            expect(await textsWith(SOL.key)).toEqual(['Answering what you wrote on your phone']);
            expect(await ctx.store.getMeta(BEN.key, 'outbox-cursor')).toMatch(/^1763020900001:/);
        });
    });

    describe('a tick for a line I wrote elsewhere opens its chat here (the phone\'s noteRestored)', () => {
        it('from a request: open, its line kept, counted', async () => {
            await setDoor(ctx, true);
            await heldLine(SOL, 'Hello Ben');
            await syncOutsideMail(ctx);
            expect((await chatOf(SOL.key))?.state).toBe('request');
            server.outbox = [tickTo(SOL.key)];
            expect(await syncOutsideMail(ctx)).toMatchObject({ ticks: 1 });
            expect(await chatOf(SOL.key)).toMatchObject({ state: 'open', restored: false });
            expect(await textsWith(SOL.key)).toEqual(['Hello Ben']);
        });

        it('from a decline: open', async () => {
            await ctx.store.openChat(BEN.key, chatWith(SOL.key), { key: SOL.key, home: ANA_HOME, name: 'Sol' });
            await ctx.store.decide(BEN.key, chatWith(SOL.key), 'declined');
            server.outbox = [tickTo(SOL.key)];
            expect(await syncOutsideMail(ctx)).toMatchObject({ ticks: 1 });
            expect((await chatOf(SOL.key))?.state).toBe('open');
        });

        it('an open chat stays as it is, and is not counted', async () => {
            await openWith(SOL.key);
            await heldLine(SOL, 'Kept');
            await syncOutsideMail(ctx);
            const before = await chatOf(SOL.key);
            server.outbox = [tickTo(SOL.key)];
            expect(await syncOutsideMail(ctx)).toMatchObject({ ticks: 0 });
            expect(await chatOf(SOL.key)).toEqual(before);
            expect(await textsWith(SOL.key)).toEqual(['Kept']);
        });
    });

    describe('a blocked person\'s chat never opens from a tick (the phone\'s 18; #3188 review)', () => {
        // Sol, blocked on this account (a block is the account's). Ben's door here is open, so the block alone stands between
        // Sol and Ben's chats. Each start: no chat here (a new browser), a request, an open chat (blocked from another screen),
        // a declined one.
        const starts = ['none', 'request', 'open', 'declined'] as const;
        const ways: Array<{ way: string; set: () => void }> = [
            { way: 'a tick for a line I wrote on another device', set: () => { server.outbox = [tickTo(SOL.key, 'sent')]; } },
            { way: 'its receipt: Delivered', set: () => { server.outbox = [tickTo(SOL.key, 'delivered')]; } },
            { way: 'it expired', set: () => { server.outbox = [tickTo(SOL.key, 'expired')]; } },
            {
                way: 'a tick on the second page of a new browser\'s history',
                set: () => { server.outboxPages = [{ ticks: [{ ...tickTo(ANA.key, 'delivered', 1763020900000), kind: 'receipt' }], more: true }, { ticks: [tickTo(SOL.key, 'sent', 1763020900001)], more: false }]; },
            },
        ];
        async function start(s: typeof starts[number]) {
            await setDoor(ctx, true);
            if (s === 'request') { await heldLine(SOL, 'Hello'); await syncOutsideMail(ctx); }
            if (s === 'open' || s === 'declined') await ctx.store.openChat(BEN.key, chatWith(SOL.key), { key: SOL.key, home: ANA_HOME, name: 'Sol' });
            if (s === 'declined') await ctx.store.decide(BEN.key, chatWith(SOL.key), 'declined');
            expect((await chatOf(SOL.key))?.state).toBe(s === 'none' ? undefined : s);
        }
        for (const s of starts) for (const w of ways) {
            it(`${s} x ${w.way}: nothing changes here`, async () => {
                await start(s);
                blocked.add(SOL.key);
                const before = await chatOf(SOL.key);
                w.set();
                expect(await syncOutsideMail(ctx)).toMatchObject({ ticks: 0 });
                expect(await chatOf(SOL.key)).toEqual(before);
            });
        }
        for (const s of ['none', 'request', 'declined'] as const) {
            it(`control: ${s}, not blocked: the same tick opens the chat`, async () => {
                await start(s);
                ways[0].set();
                expect(await syncOutsideMail(ctx)).toMatchObject({ ticks: 1 });
                expect((await chatOf(SOL.key))?.state).toBe('open');
            });
        }
    });

    describe('Sign Out: the community forgets this browser (forgetThisBrowserForMail; the phone\'s 19)', () => {
        it('reads the id before the store goes, asks once with it, signed, with its own deadline; the community lists it no more', async () => {
            await syncOutsideMail(ctx);
            const id = await mailDevice(ctx);
            const api = await import('./api');
            vi.mocked(api.signedMailFetch).mockClear();
            const { done } = await forgetThisBrowserForMail(ctx);
            await clearOutsideChats();   // Sign Out takes the store next: the id was read before
            await done;
            expect(named('forget')).toEqual([id]);
            expect(server.listed.has(id)).toBe(false);
            const call = vi.mocked(api.signedMailFetch).mock.calls.at(-1)!;
            expect(call.slice(0, 5)).toEqual(['POST', 'https://b.example', '/api/mail/device/forget', { device: id }, ctx.identity]);
            expect(call[5]).toBeInstanceOf(AbortSignal);
        });

        it('a browser that never ran a round asks nothing', async () => {
            const { done } = await forgetThisBrowserForMail(ctx);
            await done;
            expect(named('forget')).toEqual([]);
            expect(await ctx.store.getMeta(BEN.key, 'device')).toBeNull();
        });

        it('a refusal or no network: done all the same, never a throw', async () => {
            await syncOutsideMail(ctx);
            for (const answer of [() => Promise.reject(new TypeError('Failed to fetch')), async () => new Response('{"error":"No."}', { status: 403 })]) {
                server.forgetAnswer = answer;
                const { done } = await forgetThisBrowserForMail(ctx);
                await expect(done).resolves.toBeUndefined();
            }
            expect(named('forget')).toHaveLength(2);
        });

        it('a community that never answers nor hears the abort, or a store that never reads: settled at 4 s, never a reason Sign Out stops', async () => {
            await syncOutsideMail(ctx);
            let aborted = false;
            server.forgetAnswer = (signal) => { signal?.addEventListener('abort', () => { aborted = true; }); return new Promise<Response>(() => {}); };
            const stalledStore = { ...ctx.store, getMeta: () => new Promise<string | null>(() => {}) };
            vi.useFakeTimers();
            try {
                for (const which of ['community', 'store'] as const) {
                    let settled = false;
                    const started = forgetThisBrowserForMail(which === 'store' ? { ...ctx, store: stalledStore } : ctx)
                        .then(({ done }) => done).then(() => { settled = true; });
                    await vi.advanceTimersByTimeAsync(FORGET_DEVICE_MS - 1);
                    expect(settled, `${which}: not before 4 s`).toBe(false);
                    await vi.advanceTimersByTimeAsync(1);
                    expect(settled, `${which}: at 4 s`).toBe(true);
                    await started;
                }
            } finally {
                vi.useRealTimers();
            }
            expect(aborted, 'the request was aborted at 4 s').toBe(true);
            expect(named('forget')).toHaveLength(1);
        });
    });
});

describe('10  a round never acts for an account or a community it no longer belongs to (#3183 round 4)', () => {
    // The deciding pass's findings: "a round still running when Sign Out clears this browser keeps working for the account
    // that left" (it dropped and confirmed a line never shown, wrote private lines into a fresh database, made a new mail id)
    // and "the kept home is per account, not per community" (pointed at another community, the browser signed as the old one).
    const DB = 'beanpool-outside-chats';
    const docs = () => idb.dump(DB, 'docs');
    const ofB = (all: Record<string, unknown>) => Object.keys(all).filter((k) => k.startsWith(`${B} `));

    /** What leaves where this page stands, each as the app does it. */
    const EVENTS: Record<string, () => Promise<void>> = {
        // Settings' Sign Out (Device Only) and the delete at the last community: the routine both run.
        'sign out': async () => { const { clearAccountStorage } = await import('./device-prefs'); await clearAccountStorage(); },
        // Settings' node address, set in another tab of this web address: this tab hears it as a storage change.
        'switch community': async () => {
            setNodeApiUrl(C);
            window.dispatchEvent(new StorageEvent('storage', { key: 'bp_node_url', newValue: C }));
        },
        // The delete at the community the web app was pointed at, the key kept for the page's own (lib/delete-here.ts).
        'delete here': async () => { const { leaveThisCommunity } = await import('./delete-here'); await leaveThisCommunity(); },
    };
    /** The wait was asked before the event and answered after it, or it was under way and asks only after it. */
    const WHEN = { 'answered after': 'late', 'asked after': 'gap' } as const;

    it('the round this table stops at every wait of is the one section 8 names: every wait, in order', async () => {
        const { syncOutsideMailNow } = await import('./outside-mail');
        await scenario(true);
        const seen = await inABrowser(true, async () => {
            const p = pointer(null);
            server.point = p.point;
            expect(await syncOutsideMailNow(30_000)).toMatchObject({ written: 1, confirmed: 1, ticks: 1 });
            return p.seen;
        });
        expect(seen).toEqual(ON);
    });

    for (const [event, run] of Object.entries(EVENTS)) for (const at of ON) for (const [when, how] of Object.entries(WHEN)) {
        it(`${event}, the round at ${at}, ${when}: nothing asked, no wait started, nothing written for the old account or community`, async () => {
            const { syncOutsideMailNow } = await import('./outside-mail');
            await scenario(true);
            await inABrowser(true, async () => {
                const p = pointer({ at, how });
                server.point = p.point;
                const round = syncOutsideMailNow(30_000);
                expect(await Promise.race([p.reached.then(() => 'reached'), round.then(() => 'finished')]), `the round reached ${at}`).toBe('reached');
                const entered = p.seen.length;
                const served = server.served.length;
                await run();
                await settle();
                // What the documents hold once the event is done (and a write asked before it has landed).
                const atEvent = docs();
                p.release();
                await round;
                await settle();
                expect(p.seen.slice(entered), 'no wait started after it: no store call, no request, no block read, no signature').toEqual([]);
                expect(server.served.slice(served), 'no server asked anything after it: no confirm, no send, no fetch naming a new id').toEqual([]);
                if (event === 'switch community') {
                    expect(docs(), 'nothing written after it, in the old community\'s documents or the new one\'s').toEqual(atEvent);
                } else {
                    expect(docs(), 'nothing of the old account or community written back').toEqual({});
                }
                if (event === 'sign out') expect(idb.has(DB), 'no fresh database made after Sign Out deleted it').toBe(false);
            });
        });
    }

    it('a page that missed the news of a Sign Out in another tab still stops at its next store call or request', async () => {
        const { syncOutsideMailNow } = await import('./outside-mail');
        const { ACCOUNT_EPOCH_KEY } = await import('./account-epoch');
        await scenario(true);
        await inABrowser(true, async () => {
            const p = pointer({ at: 'GET /api/mail#1', how: 'late' });
            server.point = p.point;
            const round = syncOutsideMailNow(30_000);
            await p.reached;
            await settle();   // the GET is out (served), its answer held
            const served = server.served.length;
            // Another tab signed out: its value is in storage, and its database gone; no channel or storage event reached this page.
            localStorage.setItem(ACCOUNT_EPOCH_KEY, `99.${'s'.repeat(8)}.${'c'.repeat(8)}`);
            await clearOutsideChats();
            p.release();
            expect(await round).toBeNull();
            await settle();
            expect(server.served.slice(served)).toEqual([]);
            expect(idb.has(DB)).toBe(false);
        });
    });

    it('the kept home is the community\'s own: pointed at another, this browser asks it and signs as it; pointed back, the first one\'s documents are there', async () => {
        const identity = await import('./identity');
        const { outsideContext } = await import('./outside-mail');
        vi.mocked(identity.loadIdentity).mockResolvedValue({ publicKey: BEN.key, privateKey: BEN.seed, callsign: 'Ben', createdAt: '' });
        const asked: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            asked.push(String(url));
            return new Response(JSON.stringify({ primaryAddress: new URL(String(url)).hostname }), { status: 200 });
        }));
        try {
            const atB = (await outsideContext())!;
            expect(atB.nodeUrl).toBe(B);
            expect((await myAddressCard(atB))?.home).toBe(HOME);
            const bDevice = await mailDevice(atB);
            await setDoor(atB, true);
            expect(asked, 'b\'s home is kept, and fresh').toEqual([]);
            // Settings' node address moves the web app to c while b's kept home is still fresh: c is asked, and the card names c.
            setNodeApiUrl(C);
            const atC = (await outsideContext())!;
            expect(atC.nodeUrl).toBe(C);
            expect((await myAddressCard(atC))?.home).toBe('c.example');
            expect(asked).toEqual([`${C}/api/community/info`]);
            // Nothing of b's carried over: c has its own door, and this browser its own mail id there.
            expect(await doorOpen(atC)).toBe(false);
            expect(await mailDevice(atC)).not.toBe(bDevice);
            // The context made at b answers for b no more: its store opens nothing, its requests go nowhere.
            await expect(atB.store.getMeta(BEN.key, 'device')).rejects.toThrow();
            // Pointed back at b, however typed: b's documents are there again, as the phone keeps each community's file.
            setNodeApiUrl('https://B.example:443/');
            const back = (await outsideContext())!;
            expect(await mailDevice(back)).toBe(bDevice);
            expect(await doorOpen(back)).toBe(true);
            expect((await myAddressCard(back))?.home).toBe(HOME);
            expect(asked).toHaveLength(1);
            // A home kept for another address is never this one's: a store holding b's, read for c, asks c.
            expect(await myHome({ ...atC, store: outsideChatStore(B), holds: undefined })).toBe('c.example');
            expect(asked).toEqual([`${C}/api/community/info`, `${C}/api/community/info`]);
        } finally {
            vi.mocked(identity.loadIdentity).mockImplementation(async () => null);
            vi.unstubAllGlobals();
            vi.stubGlobal('indexedDB', idb);
            vi.stubGlobal('IDBKeyRange', MemoryIDBKeyRange);
        }
    });

    it('the delete here clears that community\'s documents, every one, and leaves every other community\'s', async () => {
        await openWith(ANA.key);
        await heldLine(ANA, 'At b');
        await syncOutsideMail(ctx);
        await mailDevice(ctx);
        const own = window.location.origin;
        const ownDevice = 'a'.repeat(32), nearDevice = 'b'.repeat(32);
        await outsideChatStore(own).setMeta(BEN.key, 'device', ownDevice);
        // An address that starts as b's does: another community all the same.
        await outsideChatStore('https://b.example.org').setMeta(BEN.key, 'device', nearDevice);
        expect(ofB(docs()).length, 'b holds chats, lines, receipts and meta').toBeGreaterThanOrEqual(3);
        const { leaveThisCommunity } = await import('./delete-here');
        await leaveThisCommunity();
        expect(ofB(docs())).toEqual([]);
        expect(await outsideChatStore(own).getMeta(BEN.key, 'device')).toBe(ownDevice);
        expect(await outsideChatStore('https://b.example.org').getMeta(BEN.key, 'device')).toBe(nearDevice);
    });
});

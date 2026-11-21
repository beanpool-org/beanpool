/**
 * Delivered, held for a line the member-here mark let in, in the web app (Marty, 22 Nov 2026, from the PR #3347 max review
 * finding 1: "HOLD DELIVERED"; scratch/fable-design/DESIGN-no-switch-messaging-fable.md, DECIDED 22 Nov; core
 * outsideReceiptWhen and outsideHeldReceipts; the phone's utils/__tests__/held-receipts.test.ts, the same table).
 * lib/outside-mail.ts and lib/outside-chat-store.ts against a mailbox played here as the server's routes answer
 * (apps/server/src/routes/relay.ts), the store on the in-memory IndexedDB (lib/memory-indexeddb.ts).
 *
 *   1  one table: let in by the mark (straight in / as a request) x the member's step (none, open, accept, answer, block,
 *      ignore, decline) x blocked before the line came -> how many receipts its sender gets: before the step, at the round
 *      after it, and after more rounds and the same step again (never twice); and never for a line later blocked, an
 *      unblock and an open after included
 *   2  unchanged: a stranger through an open door and a chat already open are receipted at the first round, with no step
 *   3  a held chat holds its later lines too, and lets them all go at once; a block list that can't be read holds them
 *   4  a block made anywhere (no Block step here): the round forgets the held receipts, so an unblock and an open send none
 *   5  the review's probe (PR #3347 finding 1), re-run: receipts 0/0/0 before any step
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { ed25519Signer, relayConversationId, relayPayloadHash, sealOutsideLine, signRelayEnvelope, type RelayItem } from '@beanpool/core';
import { MemoryIDBKeyRange, memoryIndexedDB } from './memory-indexeddb';

const server = vi.hoisted(() => ({
    held: [] as any[],
    /** Every receipt my server took: to whom, naming which ids. */
    receipts: [] as Array<{ to: string; ids: string[] }>,
    /** My server's own `dmRequests` in its mailbox answer (slice S5). */
    dmRequests: undefined as undefined | boolean,
}));

vi.mock('./api', async (importOriginal) => {
    const core = await import('@beanpool/core');
    const { hexToBytes } = await import('@noble/hashes/utils.js');
    const real = await importOriginal<typeof import('./api')>();
    return {
        ...real,
        signAddressCardFor: (c: any, id: any) => core.signAddressCard(c, core.ed25519Signer(hexToBytes(id.privateKey))),
        signRelayEnvelopeFor: (f: any, id: any) => core.signRelayEnvelope(f, core.ed25519Signer(hexToBytes(id.privateKey))),
        signedMailFetch: vi.fn(async (method: string, _community: string, path: string, body: any) => {
            if (method === 'GET') {
                const device = new URLSearchParams(path.split('?')[1] ?? '').get('device');
                if (!device) return new Response(JSON.stringify({ error: 'No device.' }), { status: 400 });
                return new Response(JSON.stringify({
                    items: server.held, more: false, outbox: [], outboxMore: false,
                    ...(server.dmRequests === undefined ? {} : { dmRequests: server.dmRequests }),
                }), { status: 200 });
            }
            if (path === '/api/mail/confirm') {
                server.held = server.held.filter((h) => !body.ids.includes(h.envelope.itemId));
                return new Response(JSON.stringify({ confirmed: body.ids.length }), { status: 200 });
            }
            if (path === '/api/mail/send') {
                for (const i of body.items) {
                    if (i.envelope.kind === 'receipt') server.receipts.push({ to: i.envelope.recipient, ids: JSON.parse(i.payload).items });
                }
                return new Response(JSON.stringify({ items: body.items.map((i: RelayItem) => ({ itemId: i.envelope.itemId, state: 'sent' })) }), { status: 200 });
            }
            return new Response('{}', { status: 404 });
        }),
    };
});
vi.mock('./visitor-lobby-gate', () => ({ communityInfoOnce: vi.fn(async () => ({ features: { outsideMessages: true } })) }));
vi.mock('./identity', () => ({ loadIdentity: vi.fn(async () => null) }));
vi.mock('./blocklist', () => ({ getBlocklistStatus: () => ({ loaded: true, error: null }), isUserBlocked: () => false, loadBlocklist: async () => [] }));

import { clearOutsideChats, outsideChatStore } from './outside-chat-store';
import { heldReceiptsOn, openChatFromCard, sendOutsideLine, setDoor, syncOutsideMail, type OutsideMailContext } from './outside-mail';
import { setNodeApiUrl } from './api';
import { resetAccountEpochForTest } from './account-epoch';

const seedKey = () => { const seed = ed25519.utils.randomSecretKey(); return { seed: bytesToHex(seed), key: bytesToHex(ed25519.getPublicKey(seed)) }; };
const BEN = seedKey(), SOL = seedKey(), ANA = seedKey(), CY = seedKey();
const HOME = 'b.example', THEIR_HOME = 'a.example';
const B = 'https://b.example';

let ctx: OutsideMailContext;
/** Blocked on this account's list (lib/blocklist.ts); `unknown`: the list can't be read (isBlocked throws). */
let blocked: Set<string>;
let unknown: Set<string>;

beforeEach(async () => {
    server.held = []; server.receipts = []; server.dmRequests = undefined;
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    vi.stubGlobal('IDBKeyRange', MemoryIDBKeyRange);
    await clearOutsideChats();
    localStorage.clear();
    setNodeApiUrl(B);
    resetAccountEpochForTest();
    blocked = new Set();
    unknown = new Set();
    ctx = {
        nodeUrl: B, identity: { publicKey: BEN.key, privateKey: BEN.seed, callsign: 'Ben' }, store: outsideChatStore(B),
        isBlocked: async (k) => { if (unknown.has(k)) throw new Error('The block list could not be read.'); return blocked.has(k); },
    };
    await ctx.store.setMeta(BEN.key, 'home', `${HOME} ${Date.now()} ${B}`);
});

/** A line `from` writes Ben, held for him; `memberHere`: my own server's mark beside it. */
async function heldLine(from: { seed: string; key: string }, text: string, memberHere: boolean) {
    const itemId = crypto.randomUUID();
    const payload = sealOutsideLine({ text, name: 'Sol', myEdPrivHex: from.seed, myKey: from.key, peerKey: BEN.key, messageId: itemId });
    const envelope = await signRelayEnvelope({
        kind: 'dm-line', itemId, senderKey: from.key, senderHome: THEIR_HOME, recipient: BEN.key, recipientHome: HOME, at: Date.now(), payloadHash: relayPayloadHash(payload),
    }, ed25519Signer(hexToBytes(from.seed)));
    const item: any = { kind: 'dm-line', envelope, payload, bytes: payload.length, receivedAt: Date.now() };
    if (memberHere) item.memberHere = true;
    server.held.push(item);
    return itemId;
}

const receiptedTo = (key: string) => server.receipts.filter((r) => r.to === key).flatMap((r) => r.ids);
const chatWith = (key: string) => relayConversationId(BEN.key, key);
const chatState = async (key: string) => (await ctx.store.chat(BEN.key, chatWith(key)))?.state ?? null;

type Way = 'straight in' | 'request';
type Step = 'none' | 'open' | 'accept' | 'answer' | 'block' | 'ignore' | 'decline';

/** The member's step, as the chat view takes it (components/OutsideChats.tsx: load, decide, block, send). */
async function take(step: Step, key: string): Promise<void> {
    const id = chatWith(key);
    if (step === 'none' || step === 'ignore') return;
    if (step === 'open') { await heldReceiptsOn(ctx, id, 'open'); return; }
    if (step === 'accept' || step === 'decline') {
        await ctx.store.decide(BEN.key, id, step === 'accept' ? 'open' : 'declined');
        await heldReceiptsOn(ctx, id, step);
        return;
    }
    if (step === 'answer') { await sendOutsideLine(ctx, id, 'Hello back').catch(() => null); return; }
    blocked.add(key);
    await heldReceiptsOn(ctx, id, 'block');
    await ctx.store.decide(BEN.key, id, 'declined');
}

/** The phone's table, the same answers (utils/__tests__/held-receipts.test.ts want). */
function want(way: Way, step: Step, blockedBefore: boolean): 0 | 1 {
    if (blockedBefore) return 0;
    if (step === 'accept') return 1;
    if (step === 'answer' || step === 'open') return way === 'straight in' ? 1 : 0;
    return 0;
}

const WAYS: Way[] = ['straight in', 'request'];
const STEPS: Step[] = ['none', 'open', 'accept', 'answer', 'block', 'ignore', 'decline'];
const rows = WAYS.flatMap((way) => STEPS.flatMap((step) => [false, true].map((blockedBefore) => ({ way, step, blockedBefore }))));

describe('1  let in by the mark x the member\'s step x blocked before: the receipt, and when', () => {
    it.each(rows)('$way, step $step, blocked before it came: $blockedBefore', async ({ way, step, blockedBefore }) => {
        server.dmRequests = way === 'request';
        if (blockedBefore) blocked.add(SOL.key);
        const line = await heldLine(SOL, 'Hello from the garden group', true);
        await syncOutsideMail(ctx);
        expect(await chatState(SOL.key)).toBe(blockedBefore ? null : way === 'request' ? 'request' : 'open');
        expect(receiptedTo(SOL.key)).toEqual([]);
        await syncOutsideMail(ctx);
        expect(receiptedTo(SOL.key)).toEqual([]);

        await take(step, SOL.key);
        await syncOutsideMail(ctx);
        const n = want(way, step, blockedBefore);
        expect(receiptedTo(SOL.key)).toEqual(n ? [line] : []);

        await take(step === 'block' ? 'none' : step, SOL.key);
        await syncOutsideMail(ctx);
        await syncOutsideMail(ctx);
        expect(receiptedTo(SOL.key)).toEqual(n ? [line] : []);

        if (step === 'block') {
            blocked.delete(SOL.key);
            await openChatFromCard(ctx, { key: SOL.key, home: THEIR_HOME, name: 'Sol' });
            await heldReceiptsOn(ctx, chatWith(SOL.key), 'open');
            await sendOutsideLine(ctx, chatWith(SOL.key), 'Sorry, unblocked you').catch(() => null);
            await syncOutsideMail(ctx);
            expect(receiptedTo(SOL.key)).toEqual([]);
        }
    });
});

describe('2  unchanged: receipted at the first round, with no step', () => {
    it('a stranger through an open door (a request), and a chat already open', async () => {
        await setDoor(ctx, true);
        const stranger = await heldLine(ANA, 'Hello, a stranger', false);
        await ctx.store.openChat(BEN.key, chatWith(SOL.key), { key: SOL.key, home: THEIR_HOME, name: 'Sol' });
        const open = await heldLine(SOL, 'Hello in a chat you opened', true);
        await syncOutsideMail(ctx);
        expect({ stranger: receiptedTo(ANA.key), open: receiptedTo(SOL.key) }).toEqual({ stranger: [stranger], open: [open] });
        expect(await chatState(ANA.key)).toBe('request');
    });
});

describe('3  a held chat holds its later lines too, and lets them all go at once', () => {
    it('straight in: two lines held; opened, both go in one receipt; a third line after goes at once', async () => {
        server.dmRequests = false;
        const first = await heldLine(SOL, 'One', true);
        await syncOutsideMail(ctx);
        const second = await heldLine(SOL, 'Two', false);
        await syncOutsideMail(ctx);
        expect(receiptedTo(SOL.key)).toEqual([]);
        await heldReceiptsOn(ctx, chatWith(SOL.key), 'open');
        await syncOutsideMail(ctx);
        expect(receiptedTo(SOL.key).sort()).toEqual([first, second].sort());
        expect(server.receipts.filter((r) => r.to === SOL.key)).toHaveLength(1);
        const third = await heldLine(SOL, 'Three', false);
        await syncOutsideMail(ctx);
        expect(receiptedTo(SOL.key).sort()).toEqual([first, second, third].sort());
    });

    it('a block list that can\'t be read holds them at the step', async () => {
        server.dmRequests = false;
        await heldLine(SOL, 'One', true);
        await syncOutsideMail(ctx);
        unknown.add(SOL.key);
        expect(await heldReceiptsOn(ctx, chatWith(SOL.key), 'open')).toBe('hold');
        expect(receiptedTo(SOL.key)).toEqual([]);
        unknown.delete(SOL.key);
        expect(await heldReceiptsOn(ctx, chatWith(SOL.key), 'open')).toBe('send');
        await syncOutsideMail(ctx);
        expect(receiptedTo(SOL.key)).toHaveLength(1);
    });
});

describe('4  a block made anywhere: the round forgets the held receipts', () => {
    it('blocked in another tab or on the phone (no Block step here), unblocked later, opened: no receipt', async () => {
        server.dmRequests = false;
        await heldLine(SOL, 'One', true);
        await syncOutsideMail(ctx);
        blocked.add(SOL.key);
        await syncOutsideMail(ctx);
        blocked.delete(SOL.key);
        await heldReceiptsOn(ctx, chatWith(SOL.key), 'open');
        await syncOutsideMail(ctx);
        expect(receiptedTo(SOL.key)).toEqual([]);
    });
});

describe('5  the review probe (PR #3347 finding 1), re-run', () => {
    it('door closed, one round: a member here, a member here blocked, a stranger: 0/0/0', async () => {
        server.dmRequests = false;
        blocked.add(CY.key);
        await heldLine(SOL, 'Hi, a fellow member, not blocked', true);
        await heldLine(CY, 'Hi, a fellow member the member blocked', true);
        await heldLine(ANA, 'Hi, a stranger', false);
        const out = await syncOutsideMail(ctx);
        expect({ memberHereNotBlocked: receiptedTo(SOL.key).length, memberHereBlocked: receiptedTo(CY.key).length, strangerClosedDoor: receiptedTo(ANA.key).length })
            .toEqual({ memberHereNotBlocked: 0, memberHereBlocked: 0, strangerClosedDoor: 0 });
        expect(out).toMatchObject({ written: 1, dropped: 2 });
    });
});

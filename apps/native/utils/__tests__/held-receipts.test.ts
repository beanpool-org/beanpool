/**
 * Delivered, held for a line the member-here mark let in, on the phone (Marty, 22 Nov 2026, from the PR #3347 max review
 * finding 1: "HOLD DELIVERED"; scratch/fable-design/DESIGN-no-switch-messaging-fable.md, DECIDED 22 Nov; core
 * outsideReceiptWhen and outsideHeldReceipts). utils/outside-mail.ts and utils/outside-chat-store.ts against a mailbox played
 * here as the server's routes answer (apps/server/src/routes/relay.ts), the store on real SQL (node:sqlite, the tables exactly
 * as utils/db.ts makes them).
 *
 *   1  one table: let in by the mark (straight in / as a request) x the member's step (none, open, accept, answer, block,
 *      ignore, decline) x blocked before the line came -> how many receipts its sender gets: before the step, at the round
 *      after it, and after more rounds and the same step again (never twice); and never for a line later blocked, an
 *      unblock and an open after included
 *   2  unchanged: a stranger through an open door, a line let in once, and a chat already open are receipted at the first
 *      round, with no step
 *   3  a held chat holds its later lines too, and lets them all go at once; after that its lines are receipted at once
 *   4  a block made anywhere (no Block step here): the round forgets the held receipts, so an unblock and an open send none
 *   5  the review's probe (PR #3347 finding 1), re-run: receipts 0/0/0 before any step (it was 1/0/0)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from 'node:crypto';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ed25519Signer, relayConversationId, relayPayloadHash, sealOutsideLine, signRelayEnvelope, type RelayItem } from '@beanpool/core';

const server = vi.hoisted(() => ({
    held: [] as any[],
    /** Every receipt my server took: to whom, naming which ids. */
    receipts: [] as Array<{ to: string; ids: string[] }>,
    /** My server's own `dmRequests` in its mailbox answer (slice S5). */
    dmRequests: undefined as undefined | boolean,
}));

vi.mock('../node-post', () => ({
    signedGet: vi.fn(async (_url: string, path: string) => {
        const device = new URLSearchParams(path.split('?')[1] ?? '').get('device');
        if (!device) return new Response(JSON.stringify({ error: 'No device.' }), { status: 400 });
        return new Response(JSON.stringify({
            items: server.held, more: false, outbox: [], outboxMore: false,
            ...(server.dmRequests === undefined ? {} : { dmRequests: server.dmRequests }),
        }), { status: 200 });
    }),
    signedPost: vi.fn(async (_url: string, path: string, body: any) => {
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
}));

vi.mock('../member-statements', async () => {
    const core = await import('@beanpool/core');
    const toKey = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
    return {
        signRelayEnvelopeStatement: (f: any, k: string) => core.signRelayEnvelope(f, core.ed25519Signer(toKey(k))),
        signAddressCardStatement: (c: any, k: string) => core.signAddressCard(c, core.ed25519Signer(toKey(k))),
    };
});

import { outsideChatStore, OUTSIDE_CHAT_TABLES_SQL } from '../outside-chat-store';
import { heldReceiptsOn, openChatFromCard, sendOutsideLine, setDoor, syncOutsideMail, type OutsideMailContext } from '../outside-mail';

const seedKey = () => { const seed = randomBytes(32); return { seed: bytesToHex(seed), key: bytesToHex(ed25519.getPublicKey(seed)) }; };
const BEN = seedKey(), SOL = seedKey(), ANA = seedKey(), CY = seedKey();
const HOME = 'b.example', THEIR_HOME = 'a.example';
const uuid = () => { const b = randomBytes(16); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80; const h = b.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };

let ctx: OutsideMailContext;
let sql: DatabaseSync;
/** Blocked on this phone's own list (blocklist.ts isUserBlocked). */
let blocked: Set<string>;
/** Blocked once and unblocked since, as the phone remembers (blocklist.ts `once`): no block bars them only when in neither. */
let once: Set<string>;

beforeEach(async () => {
    server.held = []; server.receipts = []; server.dmRequests = undefined;
    sql = new DatabaseSync(':memory:');
    sql.exec(OUTSIDE_CHAT_TABLES_SQL);
    const db = {
        getAllAsync: async (q: string, p: any[] = []) => sql.prepare(q).all(...p) as any[],
        getFirstAsync: async (q: string, p: any[] = []) => (sql.prepare(q).get(...p) as any) ?? null,
        runAsync: async (q: string, p: any[] = []) => sql.prepare(q).run(...p),
    };
    blocked = new Set();
    once = new Set();
    ctx = {
        nodeUrl: 'https://127.0.0.1:1', identity: { publicKey: BEN.key, privateKey: BEN.seed, callsign: 'Ben' }, store: outsideChatStore(async () => db as any),
        isBlocked: async (k) => blocked.has(k),
        // utils/let-in.ts unbarredFor: blocked anywhere, or blocked once and since unblocked, bars them.
        unbarred: async (k) => !blocked.has(k) && !once.has(k),
    };
    await ctx.store.setMeta('home', `${HOME} ${Date.now()}`);
});

/** A line `from` writes Ben, held for him; `memberHere`: my own server's mark beside it. */
async function heldLine(from: { seed: string; key: string }, text: string, memberHere: boolean) {
    const itemId = uuid();
    const payload = sealOutsideLine({ text, name: 'Sol', myEdPrivHex: from.seed, myKey: from.key, peerKey: BEN.key, messageId: itemId });
    const envelope = await signRelayEnvelope({
        kind: 'dm-line', itemId, senderKey: from.key, senderHome: THEIR_HOME, recipient: BEN.key, recipientHome: HOME, at: Date.now(), payloadHash: relayPayloadHash(payload),
    }, ed25519Signer(Buffer.from(from.seed, 'hex')));
    const item: any = { kind: 'dm-line', envelope, payload, bytes: payload.length, receivedAt: Date.now() };
    if (memberHere) item.memberHere = true;
    server.held.push(item);
    return itemId;
}

/** The ids receipted to `key` so far, every receipt counted (a receipt sent twice counts twice). */
const receiptedTo = (key: string) => server.receipts.filter((r) => r.to === key).flatMap((r) => r.ids);
const chatWith = (key: string) => relayConversationId(BEN.key, key);
const chatState = (key: string) => (sql.prepare('SELECT state FROM outside_chats WHERE peer_key = ?').get(key) as any)?.state ?? null;

type Way = 'straight in' | 'request';
type Step = 'none' | 'open' | 'accept' | 'answer' | 'block' | 'ignore' | 'decline';

/** The member's step, as each screen takes it (app/outside-chat/[id].tsx: load, decide, block, send). */
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
    // Block (blockFromAcross, then the Block step, then declined), as the screen does.
    blocked.add(key);
    await heldReceiptsOn(ctx, id, 'block');
    await ctx.store.decide(BEN.key, id, 'declined');
}

/**
 * What the sender should see, by the decision: Delivered only once the member accepts, answers or opens the chat (an open
 * one: a request opened says "They will not know you saw this unless you accept"); never for a line later blocked; nothing
 * at all for a line blocked before it came (dropped). An answer to a request not yet accepted is refused (Accept first).
 */
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
        expect(chatState(SOL.key)).toBe(blockedBefore ? null : way === 'request' ? 'request' : 'open');
        // Before any step: Sent, as for a blocked sender.
        expect(receiptedTo(SOL.key)).toEqual([]);
        await syncOutsideMail(ctx);
        expect(receiptedTo(SOL.key)).toEqual([]);

        await take(step, SOL.key);
        // Sent at the round after the step, or never.
        await syncOutsideMail(ctx);
        const n = want(way, step, blockedBefore);
        expect(receiptedTo(SOL.key)).toEqual(n ? [line] : []);

        // Never twice: more rounds, and the same step again.
        await take(step === 'block' ? 'none' : step, SOL.key);
        await syncOutsideMail(ctx);
        await syncOutsideMail(ctx);
        expect(receiptedTo(SOL.key)).toEqual(n ? [line] : []);

        // A line later blocked is never receipted: an unblock and an open after it send nothing.
        if (step === 'block') {
            blocked.delete(SOL.key);
            once.add(SOL.key);
            await openChatFromCard(ctx, { key: SOL.key, home: THEIR_HOME, name: 'Sol' });
            await heldReceiptsOn(ctx, chatWith(SOL.key), 'open');
            await sendOutsideLine(ctx, chatWith(SOL.key), 'Sorry, unblocked you').catch(() => null);
            await syncOutsideMail(ctx);
            expect(receiptedTo(SOL.key)).toEqual([]);
        }
    });
});

describe('2  unchanged: receipted at the first round, with no step', () => {
    it('a stranger through an open door (a request), a line let in once, and a chat already open', async () => {
        await setDoor(ctx.store, true);
        const stranger = await heldLine(ANA, 'Hello, a stranger', false);
        ctx.letIn = async (k) => k === CY.key;
        const letIn = await heldLine(CY, 'Hello, someone you let in', true);
        await ctx.store.openChat(BEN.key, chatWith(SOL.key), { key: SOL.key, home: THEIR_HOME, name: 'Sol' });
        const open = await heldLine(SOL, 'Hello in a chat you opened', true);
        await syncOutsideMail(ctx);
        expect({ stranger: receiptedTo(ANA.key), letIn: receiptedTo(CY.key), open: receiptedTo(SOL.key) })
            .toEqual({ stranger: [stranger], letIn: [letIn], open: [open] });
        expect(chatState(ANA.key)).toBe('request');
    });
});

describe('3  a held chat holds its later lines too, and lets them all go at once', () => {
    it('straight in: two lines held; opened, both go in one receipt; a third line after goes at once', async () => {
        server.dmRequests = false;
        const first = await heldLine(SOL, 'One', true);
        await syncOutsideMail(ctx);
        // The second line comes into the open chat the mark made: no mark asked, still held.
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

    it('a hold that can\'t be sure no block bars them (blocked once, unblocked since) stays held at the step', async () => {
        server.dmRequests = false;
        await heldLine(SOL, 'One', true);
        await syncOutsideMail(ctx);
        once.add(SOL.key);
        expect(await heldReceiptsOn(ctx, chatWith(SOL.key), 'open')).toBe('hold');
        await sendOutsideLine(ctx, chatWith(SOL.key), 'Hi');
        await syncOutsideMail(ctx);
        expect(receiptedTo(SOL.key)).toEqual([]);
    });
});

describe('4  a block made anywhere: the round forgets the held receipts', () => {
    it('blocked on another device (no Block step here), unblocked later, opened: no receipt', async () => {
        server.dmRequests = false;
        await heldLine(SOL, 'One', true);
        await syncOutsideMail(ctx);
        blocked.add(SOL.key);
        await syncOutsideMail(ctx);
        // Unblocked, and the phone remembers nothing of it (a block made elsewhere): the open finds nothing to send.
        blocked.delete(SOL.key);
        await heldReceiptsOn(ctx, chatWith(SOL.key), 'open');
        await syncOutsideMail(ctx);
        expect(receiptedTo(SOL.key)).toEqual([]);
    });
});

describe('5  the review probe (PR #3347 finding 1), re-run', () => {
    it('door closed, one round: a member here not barred, a member here barred, a stranger: 0/0/0 (was 1/0/0)', async () => {
        server.dmRequests = false;
        ctx.unbarred = async (k) => k !== CY.key;
        await heldLine(SOL, 'Hi, a fellow member, not blocked', true);
        await heldLine(CY, 'Hi, a fellow member the member blocked', true);
        await heldLine(ANA, 'Hi, a stranger', false);
        const out = await syncOutsideMail(ctx);
        expect({ memberHereNotBlocked: receiptedTo(SOL.key).length, memberHereBlocked: receiptedTo(CY.key).length, strangerClosedDoor: receiptedTo(ANA.key).length })
            .toEqual({ memberHereNotBlocked: 0, memberHereBlocked: 0, strangerClosedDoor: 0 });
        expect(out).toMatchObject({ written: 1, dropped: 2 });
    });
});

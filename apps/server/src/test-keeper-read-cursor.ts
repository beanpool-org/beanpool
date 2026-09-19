/**
 * A keeper's read cursor on their enterprise's thread is not a way to post in it (PR #924 review, B1).
 *
 * "Your groups" and mark-read keep a read cursor for each keeper on the enterprise thread. That cursor once
 * lived on a conversation_participants row, and the generic messaging routes treat a participant row as the
 * right to write, so a keeper who had opened "Your groups" could send through POST /api/messages/send and skip
 * every enterprise-thread rule: read-only after wind-up, frozen authors, the 2000-character cap, plaintext and
 * text only. An ex-keeper kept the row for good.
 *
 *  1. Opening "Your groups" and marking the thread read makes no participant row; the cursor still counts.
 *  2. A keeper cannot send (text or image) or react through the generic routes; the thread's own route works.
 *  3. The same for an ex-keeper, whose mark-read is refused.
 *  4. The same after wind-up, and for a frozen keeper.
 *  5. Even a stray participant row (from a build that made one) gives no right to send or react.
 *  6. A DM and a group chat still send through /api/messages/send.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { db } from './db/db.js';
import {
    initStateEngine, createTreasury, adminAssignTreasuryOperator, adminRevokeTreasuryOperator, createGroup, joinGroup,
    createConversation, listYourChats,
} from './state-engine.js';
import { postEnterpriseThreadMessage } from './engine/enterprise-thread.js';
import { createGroupRoutes } from './routes/groups.js';
import { createMessagingRoutes } from './routes/messaging.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const tick = () => new Promise(r => setTimeout(r, 5));

function makeMember(callsign: string): string {
    const pub = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, avatar_url, status, updated_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pub, callsign, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pub);
    return pub;
}

async function dispatch(router: any, method: string, path: string, ctx: any) {
    const matched = router.match(path, method);
    const layer = matched.pathAndMethod.find((l: any) => l.methods.includes(method));
    if (!layer) throw new Error(`No route found for ${method} ${path}`);
    const m = path.match(layer.regexp);
    const params: Record<string, string> = {};
    (layer.paramNames || []).forEach((p: any, i: number) => { params[p.name] = decodeURIComponent(m?.[i + 1] ?? ''); });
    ctx.params = { ...params, ...(ctx.params || {}) };
    await layer.stack[layer.stack.length - 1](ctx);
    return ctx;
}
/** Koa answers 200 when a handler sets a body and no status; the bare test context does not, so do it here. */
const statusOf = (ctx: any): number => ctx.status ?? (ctx.body !== undefined ? 200 : 404);
const ctxFor = (actor: string | undefined, body?: any): any => ({
    requestBody: body ?? {}, state: actor ? { actor } : {}, query: {}, get: () => '', set: () => { }, headers: {}, ip: '10.0.0.1',
});

const cb = { broadcast: () => { }, dispatchPushNotification: () => { }, registerVisitor: () => { } };

const isParticipant = (convId: string, pk: string) =>
    !!db.prepare('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND public_key = ?').get(convId, pk);
const messageCount = (convId: string) =>
    (db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?').get(convId) as any).c as number;
const attachmentCount = (convId: string) =>
    (db.prepare('SELECT COUNT(*) AS c FROM message_attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)').get(convId) as any).c as number;
const reactionsOn = (messageId: string) => {
    const r = db.prepare('SELECT metadata FROM messages WHERE id = ?').get(messageId) as any;
    try { return (JSON.parse(r?.metadata || '{}').reactions || []) as any[]; } catch { return []; }
};

async function main(): Promise<void> {
    initStateEngine();
    const deps = {
        checkAdminAuth: async () => true,
        rateLimit: () => true,
        clampLimit: (n: any) => Number(n) || 50,
        clampOffset: (n: any) => Number(n) || 0,
        activeConnections: new Map(),
        calculateAnalytics: () => ({}),
        enforceReadAuth: false,
    } as any;
    const groupsRouter = createGroupRoutes(deps);
    const messagingRouter = createMessagingRoutes(deps);
    const yourGroups = (actor: string) => dispatch(groupsRouter, 'GET', '/api/your-groups', ctxFor(actor));
    const mpost = (path: string, actor: string, body: any) => dispatch(messagingRouter, 'POST', path, ctxFor(actor, body));

    const bob = makeMember('Bob');     // keeper
    const erin = makeMember('Erin');   // posts in the thread
    const bakery = createTreasury('Village Bakery', AVATAR, 0).publicKey;
    adminAssignTreasuryOperator(bakery, bob, 'admin');
    const erinLine = postEnterpriseThreadMessage(cb as any, bakery, erin, 'Bread is up');

    const send = (actor: string, extra: Record<string, any> = {}) => mpost('/api/messages/send', actor, {
        conversationId: bakery, authorPubkey: actor, ciphertext: b64('hello'), nonce: 'plaintext-v1', ...extra,
    });
    const react = (actor: string, messageId: string) => mpost('/api/messages/react', actor, { messageId, authorPubkey: actor, emoji: '👍' });

    /** Every generic write into the enterprise thread is refused and leaves nothing behind. */
    async function assertNoGenericWrites(actor: string, who: string): Promise<void> {
        const before = messageCount(bakery);
        const big = await send(actor, { ciphertext: 'x'.repeat(200_000), nonce: 'deadbeef' });
        assert(statusOf(big) >= 400 && statusOf(big) < 500, `${who}: a 200,000-character encrypted send is refused (got ${statusOf(big)})`);
        const plain = await send(actor);
        assert(statusOf(plain) >= 400 && statusOf(plain) < 500, `${who}: a short plaintext send through /api/messages/send is refused (got ${statusOf(plain)})`);
        const image = await send(actor, { type: 'image', attachment: { data: 'x'.repeat(200_000), nonce: 'n' } });
        assert(statusOf(image) >= 400 && statusOf(image) < 500, `${who}: an image send is refused (got ${statusOf(image)})`);
        assert(messageCount(bakery) === before && attachmentCount(bakery) === 0, `${who}: no message or attachment was written`);
        const r = await react(actor, erinLine.id);
        assert(statusOf(r) >= 400 && statusOf(r) < 500, `${who}: a reaction through /api/messages/react is refused (got ${statusOf(r)})`);
        assert(reactionsOn(erinLine.id).length === 0, `${who}: no reaction was written`);
    }

    // ── 1. The read cursor makes no participant row ────────────────────────────────────────
    console.log('\n--- 1. Reading the thread makes no participant row ---');
    const listed = await yourGroups(bob);
    assert((listed.body.items as any[]).some(i => i.id === bakery && i.kind === 'enterprise'), 'the keeper sees the enterprise in "Your groups"');
    assert(!isParticipant(bakery, bob), 'opening "Your groups" makes no participant row');
    const markRead = await mpost('/api/messages/mark-read', bob, { conversationId: bakery });
    assert(statusOf(markRead) !== 403 && markRead.body?.success === true, 'the keeper can mark the enterprise thread read');
    assert(!isParticipant(bakery, bob), 'and marking it read makes no participant row either');
    assert((listYourChats(bob).items.find(i => i.id === bakery)?.unreadCount ?? -1) === 0, 'the thread reads as read');
    await tick();
    postEnterpriseThreadMessage(cb as any, bakery, erin, 'Rye on Friday');
    await tick();
    assert((listYourChats(bob).items.find(i => i.id === bakery)?.unreadCount ?? 0) === 1, 'a new line counts as unread against the cursor');
    await mpost('/api/messages/mark-read', bob, { conversationId: bakery });
    assert((listYourChats(bob).items.find(i => i.id === bakery)?.unreadCount ?? -1) === 0, 'and marking read again clears it');

    // ── 2. A keeper posts through the thread's own route only ──────────────────────────────
    console.log('\n--- 2. A keeper cannot write through the generic routes ---');
    await assertNoGenericWrites(bob, 'keeper');
    const own = postEnterpriseThreadMessage(cb as any, bakery, bob, 'Through the thread route');
    assert(!!own.id && messageCount(bakery) === 3, "the thread's own route still takes the keeper's line");

    // ── 3. An ex-keeper ────────────────────────────────────────────────────────────────────
    console.log('\n--- 3. An ex-keeper ---');
    adminRevokeTreasuryOperator(bakery, bob);
    await assertNoGenericWrites(bob, 'ex-keeper');
    const exMark = await mpost('/api/messages/mark-read', bob, { conversationId: bakery });
    assert(statusOf(exMark) === 403, `an ex-keeper's mark-read is refused (got ${statusOf(exMark)})`);
    assert(!(listYourChats(bob).items as any[]).some(i => i.id === bakery), 'and the enterprise leaves their "Your groups"');

    // ── 4. Wind-up and a frozen keeper ─────────────────────────────────────────────────────
    console.log('\n--- 4. After wind-up, and a frozen keeper ---');
    adminAssignTreasuryOperator(bakery, bob, 'admin');
    await yourGroups(bob);
    await mpost('/api/messages/mark-read', bob, { conversationId: bakery });
    db.prepare('UPDATE members SET credit_frozen = 1 WHERE public_key = ?').run(bob);
    await assertNoGenericWrites(bob, 'frozen keeper');
    db.prepare('UPDATE members SET credit_frozen = 0 WHERE public_key = ?').run(bob);
    db.prepare("UPDATE members SET status = 'completed' WHERE public_key = ?").run(bakery);
    await assertNoGenericWrites(bob, 'keeper after wind-up');
    db.prepare("UPDATE members SET status = 'active' WHERE public_key = ?").run(bakery);

    // ── 5. A stray participant row is no authority ─────────────────────────────────────────
    console.log('\n--- 5. A participant row left by an earlier build ---');
    db.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key, last_read_at) VALUES (?, ?, ?)')
        .run(bakery, erin, new Date().toISOString());
    await assertNoGenericWrites(erin, 'a stray participant');

    // ── 6. DMs and group chats still send through /api/messages/send ───────────────────────
    console.log('\n--- 6. DMs and group chats are unaffected ---');
    const dm = createConversation('dm', [bob, erin], bob)!;
    const dmSend = await mpost('/api/messages/send', bob, { conversationId: dm.id, authorPubkey: bob, ciphertext: 'c', nonce: 'n' });
    assert(statusOf(dmSend) !== 400 && dmSend.body?.success === true, 'a DM still sends');
    const garden = createGroup({ name: 'Garden Crew', joinPolicy: 'open', createdBy: bob });
    joinGroup(garden.id, erin);
    const gSend = await mpost('/api/messages/send', erin, { conversationId: garden.id, authorPubkey: erin, ciphertext: b64('hi all'), nonce: 'plaintext-v1' });
    assert(gSend.body?.success === true, 'a group chat line still sends the way store apps up to 1.2.37 send it');

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exit(1);
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

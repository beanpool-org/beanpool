/**
 * The chat list carries each chat's newest line's time, for both apps to order it by (core chat-list-order.ts; Marty,
 * 16 Nov 2026: "when someone [posts] a chat in a group it pushes the group to the top for everyone. but not the person
 * who entered the chat"). Before this the list gave only when each chat was made, and the web ordered by that.
 *
 * Over REAL HTTPS through the real signature middleware:
 *   1. every chat in a member's list carries `lastMessageAt`, the time of its newest line, and null while it has none;
 *      `createdAt` stays when the chat was made
 *   2. a line moves its chat to the top of everyone's list by that rule, the sender's own list included: a group line, then
 *      a direct line, each first for the sender and for the other member
 *   3. a line the node withholds from someone who blocked its sender (engine/withheld-lines.ts) counts in the sender's own
 *      list, as it does in the order the node gives them, and not in the blocker's
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-chat-list-time.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, createGroup, joinGroup, createConversation } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { lockedDm } from './dm-test-payload.js';
import { lockedGroupLine } from './group-test-payload.js';
import { chatMovedAt, newestChatsFirst } from '@beanpool/core';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let run = 0;
let passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Identity { pub: string; priv: crypto.KeyObject }
function keypair(): Identity {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey };
}
function seedMember(pk: string, callsign: string) {
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(pk, callsign);
}

let BASE = '';
async function call(method: string, path: string, body: unknown, signer: Identity): Promise<{ status: number; body: any }> {
    const bodyString = body === undefined ? undefined : JSON.stringify(body);
    const ts = String(Date.now());
    const nonce = crypto.randomUUID();
    const canonical: Record<string, string> = { method, path: path.split('?')[0], timestamp: ts, nonce };
    if (bodyString !== undefined) canonical.body = bodyString;
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            ...(bodyString !== undefined ? { 'Content-Type': 'application/json' } : {}),
            'X-Public-Key': signer.pub,
            'X-Signature': signRequest(signer.priv, canonical as any),
            [SIGNED_FOR_HEADER]: signedForHost(),
            'X-Timestamp': ts,
            'X-Nonce': nonce,
        },
        ...(bodyString !== undefined ? { body: bodyString } : {}),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: json };
}

/** A member's chat list, as both apps read it. */
async function listOf(who: Identity): Promise<any[]> {
    const r = await call('GET', `/api/messages/conversations/${who.pub}`, undefined, who);
    if (r.status !== 200) console.error(`  (list answered ${r.status}: ${JSON.stringify(r.body)})`);
    return r.body?.conversations ?? [];
}
/** The list in the order both apps draw it (core chat-list-order.ts): ids, newest line first. */
const drawn = (list: any[]) => newestChatsFirst(list, (c) => chatMovedAt(c.lastMessageAt, c.createdAt)).map((c) => c.id);
/** The newest stored line's time in a chat, as the node itself holds it; null with none. */
const newestStored = (id: string) => (db.prepare('SELECT timestamp FROM messages WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1').get(id) as { timestamp: string } | undefined)?.timestamp ?? null;

async function main() {
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const ana = keypair();
    const ben = keypair();
    const cy = keypair();
    seedMember(ana.pub, 'Ana');
    seedMember(ben.pub, 'Ben');
    seedMember(cy.pub, 'Cy');

    // The chats: Ana and Ben's group, their direct chat, and Ana and Cy's direct chat with nothing in it yet.
    const group = createGroup({ name: 'Riverside garden', createdBy: ana.pub, category: 'social' });
    joinGroup(group.id, ben.pub);
    await sleep(5);
    const dm = createConversation('dm', [ana.pub, ben.pub], ana.pub)!;
    await sleep(5);
    const quiet = createConversation('dm', [ana.pub, cy.pub], ana.pub)!;
    await sleep(5);
    const benFirst = await call('POST', '/api/messages/send', { conversationId: dm.id, authorPubkey: ben.pub, ...lockedDm() }, ben);
    assert(benFirst.status === 200 || benFirst.status === 201, `Ben's direct line is stored (${benFirst.status})`);

    // ── 1. every chat carries its newest line's time ──
    console.log('── 1. the newest line\'s time, null with none ──');
    {
        const list = await listOf(ana);
        const ids = new Set(list.map((c) => c.id));
        assert(ids.has(group.id) && ids.has(dm.id) && ids.has(quiet.id), `Ana's list holds the group, the direct chat and the quiet chat (${list.length})`);
        for (const c of list) {
            assert(c.lastMessageAt === newestStored(c.id), `${c.type} ${c.id.slice(0, 8)}: lastMessageAt is its newest stored line's time (${c.lastMessageAt} vs ${newestStored(c.id)})`);
            assert(typeof c.createdAt === 'string' && c.createdAt.length > 0, `${c.type} ${c.id.slice(0, 8)}: createdAt stays when it was made (${c.createdAt})`);
        }
        const q = list.find((c) => c.id === quiet.id);
        assert(q && 'lastMessageAt' in q && q.lastMessageAt === null, `a chat with no line says so: lastMessageAt null (${JSON.stringify(q?.lastMessageAt)})`);
        assert(list.find((c) => c.id === dm.id)?.lastMessageAt !== list.find((c) => c.id === dm.id)?.createdAt,
            'the direct chat\'s time is its line\'s, not when it was made');
    }

    // ── 2. a line puts its chat first for everyone, the sender included ──
    console.log('── 2. a line moves its chat to the top, for the sender too ──');
    await sleep(5);
    const anaGroupLine = await call('POST', `/api/groups/${group.id}/chat/message`, lockedGroupLine(db, group.id), ana);
    assert(anaGroupLine.status === 201, `Ana posts in the group (${anaGroupLine.status})`);
    const groupLineAt: string | undefined = anaGroupLine.body?.message?.timestamp;
    for (const [name, who] of [['Ana (the sender)', ana], ['Ben', ben]] as const) {
        const list = await listOf(who);
        const g = list.find((c) => c.id === group.id);
        assert(!!groupLineAt && g?.lastMessageAt === groupLineAt, `${name}'s list gives the group Ana's line's time (${g?.lastMessageAt} vs ${groupLineAt})`);
        assert(drawn(list)[0] === group.id, `and the group is first in ${name}'s list (${drawn(list).map((id) => id.slice(0, 8)).join(', ')})`);
    }
    await sleep(5);
    const anaDmLine = await call('POST', '/api/messages/send', { conversationId: dm.id, authorPubkey: ana.pub, ...lockedDm() }, ana);
    assert(anaDmLine.status === 200 || anaDmLine.status === 201, `Ana answers Ben directly (${anaDmLine.status})`);
    for (const [name, who] of [['Ana (the sender)', ana], ['Ben', ben]] as const) {
        const list = await listOf(who);
        assert(drawn(list)[0] === dm.id, `the direct chat is now first in ${name}'s list, over the group (${drawn(list).map((id) => id.slice(0, 8)).join(', ')})`);
    }
    {
        // The quiet chat, made before either line, sits by when it was made: last.
        const list = await listOf(ana);
        assert(drawn(list).at(-1) === quiet.id, `the quiet chat, made before both lines, is last (${drawn(list).map((id) => id.slice(0, 8)).join(', ')})`);
    }

    // ── 3. a line withheld from a blocker counts in the sender's own list only ──
    console.log('── 3. a withheld line counts for its sender ──');
    const blk = await call('POST', '/api/blocks', { targetPubkey: ana.pub }, ben);
    assert(blk.status === 200 || blk.status === 201, `Ben blocks Ana (${blk.status})`);
    const benBefore = (await listOf(ben)).find((c) => c.id === dm.id)?.lastMessageAt;
    await sleep(5);
    // A line in the group from Ben, so the group is newer than the direct chat in everyone's list, then Ana's withheld one.
    await call('POST', `/api/groups/${group.id}/chat/message`, lockedGroupLine(db, group.id), ben);
    await sleep(5);
    const withheld = await call('POST', '/api/messages/send', { conversationId: dm.id, authorPubkey: ana.pub, ...lockedDm() }, ana);
    const heldRow = db.prepare('SELECT timestamp FROM withheld_lines WHERE id = ?').get(withheld.body?.message?.id) as { timestamp: string } | undefined;
    assert(!!heldRow, `Ana's line to Ben is withheld, answered as a stored one (${withheld.status})`);
    {
        const anaList = await listOf(ana);
        assert(anaList.find((c) => c.id === dm.id)?.lastMessageAt === heldRow?.timestamp,
            `Ana's own list gives the direct chat her withheld line's time (${anaList.find((c) => c.id === dm.id)?.lastMessageAt} vs ${heldRow?.timestamp})`);
        assert(drawn(anaList)[0] === dm.id, `and it is first in her list, as the node orders it (${drawn(anaList).map((id) => id.slice(0, 8)).join(', ')})`);
        assert(anaList[0]?.id === dm.id, 'the node\'s own order agrees');
        const benList = await listOf(ben);
        const benDm = benList.find((c) => c.id === dm.id);
        assert(!benDm || benDm.lastMessageAt === benBefore, `Ben's list shows nothing of it (${benDm?.lastMessageAt} vs ${benBefore})`);
        assert(drawn(benList)[0] === group.id, `Ben's first chat is the group, his own newest line (${drawn(benList).map((id) => id.slice(0, 8)).join(', ')})`);
    }

    console.log(`\n${passed}/${run} tests passed.`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((err) => {
    console.error('Test failed with unhandled error:', err);
    process.exit(1);
});

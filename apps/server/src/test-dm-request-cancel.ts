/**
 * Message requests: Cancel request (decideRequest decision: 'cancel').
 *
 * Checks:
 *   1. the opener cancels → the request is gone from the recipient's requests and the opener's line is gone
 *   2. a second cancel → refused (409 request_not_pending)
 *   3. the recipient can't cancel (403 not_request_opener)
 *   4. another member can't cancel (404 request_not_found)
 *   5. cancel then a new first line → a request again, and no push for it, nor for the first (count the pushes)
 *   6. an ignored request stays ignored through a cancel and a new line: no Requests entry, no push
 *   7. the cancel withdraws only the opener's lines: the recipient's own line (kept for them) stays
 *   8. a withdrawn line leaves a `messages` tombstone, and its photo row, stored object and overlays go with it
 *  10. after a cancel, the person it was for cannot accept it (Marty, 28 Oct 2026): Accept and Ignore 404, and their line,
 *      their asking for the chat or their adding the opener accepts nothing; their line or asking is a request of their own
 *      to the opener. An open with nothing written in it yet (never withdrawn) is accepted by their asking, as before.
 *      While the opener blocks them (PR #2540 review 4396980737), their line or asking leaves the opener's row, list and
 *      chat as the opener left them, and reaches the opener by no push or socket; to them it is a request of their own all
 *      the same: read as theirs, a second line and a reaction refused, Accept the opener's 403, their cancel withdrawing
 *      their line. Once the block is lifted, the line kept during it is no request's line, and their next line is
 *      (turning the request round, under the opener's Requests)
 *  11. a blocked member who reached out sees their request accepted when the blocker writes; nothing tells them they are
 *      blocked (Marty, 28 Oct 2026, "B"): what they read, hear and are answered after the opener's line equals what an
 *      unblocked member is, with an Ignore before the cancel too (PR #2540 review 4397305910: their chat never leaves their
 *      chats), when they block the opener back, with requests off at her line, when they cancel their own request first,
 *      and when they block her back and cancel it (PR #2540 review 4400797748: their chat stays in their chats, their own,
 *      cancelled); the opener reads hers as waiting
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-dm-request-cancel.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.NODE_PROFILE = 'global';
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_READ_AUTH;
process.env.ADMIN_PASSWORD = 'DmCancelPass123!';

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { putPushTokenRow } from './services/push-token-seal.js';
import { lockedDm } from './dm-test-payload.js';
import { setMemberPhoto } from '@beanpool/engine';
import { startP2P } from './p2p.js';
import { getImageStore, readObject } from './storage/image-store.js';
import { setSwitchOverride } from './config/node-profile.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

let BASE = '';

// ── Expo stubbed ─────────────────────────────────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
const pushes: { to: string; title: string; body: string; data: unknown; badge?: number }[] = [];
(globalThis as unknown as { fetch: typeof fetch }).fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes('exp.host') && init?.body) {
        pushes.push(...JSON.parse(init.body as string));
        return { ok: true, status: 200, json: async () => ({}) } as Response;
    }
    return realFetch(url, init);
};

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}
const tokenOf = (id: Id) => `ExponentPushToken[${id.name}]`;
const pushesTo = (id: Id) => pushes.filter(p => p.to === tokenOf(id));

const owner: Id = newId('Owner');
function member(name: string): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_visitor)
                VALUES (?, ?, ?, ?, 'TEST', 'active', 0)`)
        .run(id.pk, name, iso(Date.now() - 30 * DAY), owner.pk);
    setMemberPhoto(db, id.pk, `https://example.org/${name}.jpg`);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    putPushTokenRow(id.pk, tokenOf(id), 'android');
    return id;
}

interface Res { status: number; body: any }
async function call(method: 'GET' | 'POST', id: Id | null, route: string, body?: unknown): Promise<Res> {
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = method === 'GET' ? {} : { 'Content-Type': 'application/json' };
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${route.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await realFetch(`${BASE}${route}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* empty or not JSON */ }
    return { status: res.status, body: parsed };
}

// ── signed member sockets ────────────────────────────────────────────────────────────────────────
type Sock = { ws: WebSocket; events: any[] };
function socket(id: Id): Promise<Sock> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.priv).toString('base64');
    const url = `${BASE.replace('https', 'wss')}/ws?pubkey=${id.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const s: Sock = { ws, events: [] };
        ws.on('message', (d) => { try { s.events.push(JSON.parse(d.toString())); } catch { /* */ } });
        ws.on('open', () => resolve(s));
        ws.on('error', reject);
    });
}

// ── bootstrap ────────────────────────────────────────────────────────────────────────────────────
const dir = process.env.BEANPOOL_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'bp-test-dm-cancel-'));
process.env.BEANPOOL_DATA_DIR = dir;
initStateEngine();
await initTls();
initAdminPassword();
const p2p = await startP2P(0, 0);
seedGenesisMember(owner.pk, 'owner');

const port = await startHttpsServer(0);
BASE = `https://localhost:${port}`;

const alice = member('Alice');
const bob = member('Bob');
const charlie = member('Charlie');

const bobSock = await socket(bob);
const aliceSock = await socket(alice);

// ── 1. Alice opens a conversation with Bob and sends a request line ──────────────────────────────
const openRes = await call('POST', alice, '/api/messages/conversation', {
    type: 'dm',
    participants: [alice.pk, bob.pk],
    createdBy: alice.pk,
});
assert(openRes.status === 200, `Alice opens chat with Bob: ${openRes.status}`);
const convId = openRes.body.conversation.id;

const send1 = await call('POST', alice, '/api/messages/send', { conversationId: convId, authorPubkey: alice.pk, ...lockedDm() });
assert(send1.status === 200, `Alice sends first message: ${send1.status}`);

// Bob sees it in requests
const bobList1 = await call('GET', bob, `/api/messages/conversations/${bob.pk}`);
const bobReqs1 = bobList1.body.requests?.conversations || [];
assert(bobReqs1.length === 1 && bobReqs1[0].id === convId, `Bob has 1 request from Alice: ${bobReqs1.length}`);
assert(pushesTo(bob).length === 0, `A request alerts nobody until it is accepted, so Bob received no push: ${pushesTo(bob).length}`);

// Check messages in conversation: 1 message exists
const msgsBefore = await call('GET', alice, `/api/messages/${convId}`);
assert(msgsBefore.body.messages?.length === 1, `Conversation has 1 message: ${msgsBefore.body.messages?.length}`);

// ── 2. The recipient (Bob) tries to cancel → refused 403 ──────────────────────────────────────────
const bobCancel = await call('POST', bob, '/api/messages/request', { conversationId: convId, decision: 'cancel' });
assert(bobCancel.status === 403 && bobCancel.body.code === 'not_request_opener',
    `Recipient cannot cancel (403 not_request_opener): ${bobCancel.status} ${bobCancel.body.code}`);

// ── 3. Another member (Charlie) tries to cancel → refused 404 ─────────────────────────────────────
const charlieCancel = await call('POST', charlie, '/api/messages/request', { conversationId: convId, decision: 'cancel' });
assert(charlieCancel.status === 404 && charlieCancel.body.code === 'request_not_found',
    `Another member cannot cancel (404 request_not_found): ${charlieCancel.status} ${charlieCancel.body.code}`);

// ── 4. The opener (Alice) cancels the request ────────────────────────────────────────────────────
const aliceCancel = await call('POST', alice, '/api/messages/request', { conversationId: convId, decision: 'cancel' });
assert(aliceCancel.status === 200 && aliceCancel.body.success === true,
    `Alice cancels her own pending request: ${aliceCancel.status}`);
assert(aliceCancel.body.request?.nextLineIsRequest === true,
    `Alice's view shows nextLineIsRequest = true after cancel: ${aliceCancel.body.request?.nextLineIsRequest}`);

// Recipient no longer sees it in Requests
const bobList2 = await call('GET', bob, `/api/messages/conversations/${bob.pk}`);
const bobReqs2 = bobList2.body.requests?.conversations || [];
assert(bobReqs2.length === 0, `Bob has 0 requests after cancel: ${bobReqs2.length}`);

// Opener's line is gone for both
const msgsAfterAlice = await call('GET', alice, `/api/messages/${convId}`);
assert(msgsAfterAlice.body.messages?.length === 0, `Messages gone for Alice: ${msgsAfterAlice.body.messages?.length}`);
const msgsAfterBob = await call('GET', bob, `/api/messages/${convId}`);
assert(msgsAfterBob.body.messages?.length === 0, `Messages gone for Bob: ${msgsAfterBob.body.messages?.length}`);

// ── 5. A second cancel → refused 409 request_not_pending ──────────────────────────────────────────
const secondCancel = await call('POST', alice, '/api/messages/request', { conversationId: convId, decision: 'cancel' });
assert(secondCancel.status === 409 && secondCancel.body.code === 'request_not_pending',
    `Second cancel refused (409 request_not_pending): ${secondCancel.status} ${secondCancel.body.code}`);

// ── 6. Alice sends a new first line ──────────────────────────────────────────────────────────────
// Count pushes before sending
const bobPushesBefore = pushesTo(bob).length;
const send2 = await call('POST', alice, '/api/messages/send', { conversationId: convId, authorPubkey: alice.pk, ...lockedDm() });
assert(send2.status === 200, `Alice sends new first message: ${send2.status}`);

// It is a request again: Bob sees it under requests
const bobList3 = await call('GET', bob, `/api/messages/conversations/${bob.pk}`);
const bobReqs3 = bobList3.body.requests?.conversations || [];
assert(bobReqs3.length === 1 && bobReqs3[0].id === convId, `Bob has 1 request again: ${bobReqs3.length}`);

// No push for this one either
const bobPushesAfter = pushesTo(bob).length;
assert(bobPushesAfter === bobPushesBefore, `No push for the new request (was ${bobPushesBefore}, now ${bobPushesAfter})`);

// Sockets received update
assert(bobSock.events.some(e => e.type === 'dm_request_updated' && e.conversationId === convId),
    'Bob received dm_request_updated via socket');
assert(aliceSock.events.some(e => e.type === 'dm_request_updated' && e.conversationId === convId),
    'Alice received dm_request_updated via socket');

// ── 7. Cancel never undoes Ignore (PR #2540 review 4393642102) ───────────────────────────────────
// Gina ignores Frank's request. He cancels it and writes again inside its 30 days: his answers are a waiting request's, and
// it stays ignored for her: in neither of her lists, no push, nothing on her socket.
const frank = member('Frank');
const gina = member('Gina');
const ginaSock = await socket(gina);
const fgConv = (await call('POST', frank, '/api/messages/conversation', { type: 'dm', participants: [frank.pk, gina.pk], createdBy: frank.pk })).body.conversation.id;
const fg1 = await call('POST', frank, '/api/messages/send', { conversationId: fgConv, authorPubkey: frank.pk, ...lockedDm() });
const ginaIgnores = await call('POST', gina, '/api/messages/request', { conversationId: fgConv, decision: 'ignore' });
const fg2Refused = await call('POST', frank, '/api/messages/send', { conversationId: fgConv, authorPubkey: frank.pk, ...lockedDm() });
assert(fg1.status === 200 && ginaIgnores.status === 200 && ginaIgnores.body.request?.state === 'ignored'
    && fg2Refused.status === 403 && fg2Refused.body.code === 'dm_request_pending',
    `Gina ignores Frank's request, and his second line is refused as a waiting one's (${fg1.status}, ${ginaIgnores.body.request?.state}, ${fg2Refused.status} ${fg2Refused.body.code})`);
const ginaPushesBefore = pushesTo(gina).length;
const frankCancels = await call('POST', frank, '/api/messages/request', { conversationId: fgConv, decision: 'cancel' });
assert(frankCancels.status === 200 && frankCancels.body.request?.state === 'pending' && frankCancels.body.request?.nextLineIsRequest === true,
    `Frank cancels it: answered as a waiting request's cancel (${frankCancels.status}, ${JSON.stringify(frankCancels.body.request)})`);
const ginaSockBefore = ginaSock.events.length;
const fg3 = await call('POST', frank, '/api/messages/send', { conversationId: fgConv, authorPubkey: frank.pk, ...lockedDm() });
const fgRow = db.prepare('SELECT state FROM dm_requests WHERE conversation_id = ?').get(fgConv) as { state: string };
const ginaList = await call('GET', gina, `/api/messages/conversations/${gina.pk}`);
const ginaReqs = ginaList.body.requests?.conversations || [];
const ginaChats = ginaList.body.conversations || [];
assert(fg3.status === 200 && fgRow.state === 'ignored' && ginaReqs.length === 0 && (ginaList.body.requests?.count ?? 0) === 0
    && !ginaChats.some((c: any) => c.id === fgConv),
    `his line after the cancel leaves it ignored: not in Gina's Requests nor her chats (${fg3.status}, ${fgRow.state}, ${ginaReqs.length}, ${ginaChats.some((c: any) => c.id === fgConv)})`);
await new Promise(r => setTimeout(r, 150));
assert(pushesTo(gina).length === ginaPushesBefore, `no push to Gina for it (was ${ginaPushesBefore}, now ${pushesTo(gina).length})`);
assert(!ginaSock.events.slice(ginaSockBefore).some(e => e.conversationId === fgConv),
    `nothing on Gina's socket for it (${JSON.stringify(ginaSock.events.slice(ginaSockBefore).map(e => e.type))})`);
const frankReads = await call('GET', frank, `/api/messages/${fgConv}`);
const fg4Refused = await call('POST', frank, '/api/messages/send', { conversationId: fgConv, authorPubkey: frank.pk, ...lockedDm() });
assert(frankReads.body.conversation?.request?.state === 'pending' && frankReads.body.conversation?.request?.nextLineIsRequest === false
    && fg4Refused.status === 403 && fg4Refused.body.code === 'dm_request_pending',
    `Frank reads a waiting request, and his next line is refused as one's (${JSON.stringify(frankReads.body.conversation?.request)}, ${fg4Refused.status})`);

// ── 8. Cancel withdraws only the opener's lines (PR #2540 review 4393642111) ─────────────────────
// Dan writes to Eve, then blocks her. Eve accepts and writes (kept for her alone: Dan blocks her). Dan, who reads the
// request as waiting, cancels it: his line goes, hers stays.
const dan = member('Dan');
const eve = member('Eve');
const deConv = (await call('POST', dan, '/api/messages/conversation', { type: 'dm', participants: [dan.pk, eve.pk], createdBy: dan.pk })).body.conversation.id;
const de1 = await call('POST', dan, '/api/messages/send', { conversationId: deConv, authorPubkey: dan.pk, ...lockedDm() });
const danBlocks = await call('POST', dan, '/api/blocks', { targetPubkey: eve.pk });
const eveAccepts = await call('POST', eve, '/api/messages/request', { conversationId: deConv, decision: 'accept' });
const eve1 = await call('POST', eve, '/api/messages/send', { conversationId: deConv, authorPubkey: eve.pk, ...lockedDm() });
const eveReadBefore = await call('GET', eve, `/api/messages/${deConv}`);
assert(de1.status === 200 && danBlocks.status === 200 && eveAccepts.status === 200 && eve1.status === 200 && eveReadBefore.body.messages?.length === 2,
    `Dan writes, blocks Eve; she accepts and writes, and reads both lines (${de1.status}, ${danBlocks.status}, ${eveAccepts.status}, ${eve1.status}, ${eveReadBefore.body.messages?.length})`);
const danCancels = await call('POST', dan, '/api/messages/request', { conversationId: deConv, decision: 'cancel' });
const eveReadAfter = await call('GET', eve, `/api/messages/${deConv}`);
const eveIds = (eveReadAfter.body.messages || []).map((m: any) => m.id);
const eveKept = db.prepare('SELECT COUNT(*) AS n FROM withheld_lines WHERE id = ?').get(eve1.body.message?.id) as { n: number };
const danLeft = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE id = ?').get(de1.body.message?.id) as { n: number };
assert(danCancels.status === 200 && eveIds.length === 1 && eveIds[0] === eve1.body.message?.id && eveKept.n === 1 && danLeft.n === 0,
    `Dan's cancel takes his line and leaves Eve's: she reads hers alone, still kept (${danCancels.status}, ${JSON.stringify(eveIds)}, kept ${eveKept.n}, his ${danLeft.n})`);

// ── 9. A withdrawn line leaves a tombstone, and its photo goes with it (PR #2540 review 4393642119) ──
// Hal's first line to Ivy is a photo: after his cancel, the line's tombstone is written for a standby, and its photo row and
// stored object are gone. Jo's photo to Kim, who blocked her, is kept for Jo alone: it goes the same way.
const hal = member('Hal');
const ivy = member('Ivy');
const hiConv = (await call('POST', hal, '/api/messages/conversation', { type: 'dm', participants: [hal.pk, ivy.pk], createdBy: hal.pk })).body.conversation.id;
const halPhoto = lockedDm(64);
const hi1 = await call('POST', hal, '/api/messages/send', {
    conversationId: hiConv, authorPubkey: hal.pk, ...lockedDm(), type: 'image',
    attachment: { data: halPhoto.ciphertext, nonce: halPhoto.nonce, mime: 'image/jpeg' },
});
const hiId: string = hi1.body.message?.id;
const hiKey = (db.prepare('SELECT storage_key FROM message_attachments WHERE message_id = ?').get(hiId) as { storage_key: string | null } | undefined)?.storage_key ?? null;
const hiStored = hiKey ? (await readObject(getImageStore(), hiKey)) !== null : false;
assert(hi1.status === 200 && !!hiKey && hiStored, `Hal's photo line is stored, its object in the image store (${hi1.status}, ${hiKey}, ${hiStored})`);
const halCancels = await call('POST', hal, '/api/messages/request', { conversationId: hiConv, decision: 'cancel' });
const hiRows = db.prepare('SELECT (SELECT COUNT(*) FROM messages WHERE id = @id) AS line, (SELECT COUNT(*) FROM message_attachments WHERE message_id = @id) AS photo, '
    + "(SELECT COUNT(*) FROM tombstones WHERE table_name = 'messages' AND row_key = @id) AS tomb").get({ id: hiId }) as { line: number; photo: number; tomb: number };
const hiObjectGone = hiKey ? (await readObject(getImageStore(), hiKey)) === null : false;
assert(halCancels.status === 200 && hiRows.line === 0 && hiRows.photo === 0 && hiRows.tomb === 1 && hiObjectGone,
    `Hal's cancel: line ${hiRows.line}, photo row ${hiRows.photo}, tombstone ${hiRows.tomb}, object gone ${hiObjectGone} (${halCancels.status})`);
const jo = member('Jo');
const kim = member('Kim');
const kimBlocks = await call('POST', kim, '/api/blocks', { targetPubkey: jo.pk });
const jkConv = (await call('POST', jo, '/api/messages/conversation', { type: 'dm', participants: [jo.pk, kim.pk], createdBy: jo.pk })).body.conversation?.id;
const joPhoto = lockedDm(64);
const jk1 = await call('POST', jo, '/api/messages/send', {
    conversationId: jkConv, authorPubkey: jo.pk, ...lockedDm(), type: 'image',
    attachment: { data: joPhoto.ciphertext, nonce: joPhoto.nonce, mime: 'image/jpeg' },
});
const jkId: string = jk1.body.message?.id;
const jkKey = (db.prepare('SELECT storage_key FROM withheld_lines WHERE id = ?').get(jkId) as { storage_key: string | null } | undefined)?.storage_key ?? null;
const jkStored = jkKey ? (await readObject(getImageStore(), jkKey)) !== null : false;
const joCancels = await call('POST', jo, '/api/messages/request', { conversationId: jkConv, decision: 'cancel' });
const jkLeft = db.prepare('SELECT COUNT(*) AS n FROM withheld_lines WHERE id = ?').get(jkId) as { n: number };
const jkObjectGone = jkKey ? (await readObject(getImageStore(), jkKey)) === null : false;
assert(kimBlocks.status === 200 && jk1.status === 200 && !!jkKey && jkStored && joCancels.status === 200 && jkLeft.n === 0 && jkObjectGone,
    `Jo's photo kept for her alone goes with her cancel, its object too (${jk1.status}, ${jkKey}, ${jkStored}, ${joCancels.status}, kept ${jkLeft.n}, gone ${jkObjectGone})`);
// Lou's line to Mae, who blocks him after it: his edit of it is kept for him alone (withheld_overlays), and goes with his cancel.
const lou = member('Lou');
const mae = member('Mae');
const lmConv = (await call('POST', lou, '/api/messages/conversation', { type: 'dm', participants: [lou.pk, mae.pk], createdBy: lou.pk })).body.conversation.id;
const lm1 = await call('POST', lou, '/api/messages/send', { conversationId: lmConv, authorPubkey: lou.pk, ...lockedDm() });
const maeBlocks = await call('POST', mae, '/api/blocks', { targetPubkey: lou.pk });
const louEdits = await call('POST', lou, '/api/messages/edit', { messageId: lm1.body.message?.id, ...lockedDm() });
const overlaysBefore = (db.prepare('SELECT COUNT(*) AS n FROM withheld_overlays WHERE message_id = ?').get(lm1.body.message?.id) as { n: number }).n;
const louCancels = await call('POST', lou, '/api/messages/request', { conversationId: lmConv, decision: 'cancel' });
const overlaysAfter = (db.prepare('SELECT COUNT(*) AS n FROM withheld_overlays WHERE message_id = ?').get(lm1.body.message?.id) as { n: number }).n;
assert(lm1.status === 200 && maeBlocks.status === 200 && louEdits.status === 200 && overlaysBefore === 1 && louCancels.status === 200 && overlaysAfter === 0,
    `Lou's edit kept for him alone goes with his cancel (${lm1.status}, ${louEdits.status}, overlays ${overlaysBefore} → ${overlaysAfter}, ${louCancels.status})`);

// ── 10. After Cancel request, the person it was for cannot accept it, by Accept or by writing (Marty, 28 Oct 2026) ──
// The node's state is the authority: Nat's request stays his, withdrawn, and nothing of Ola's accepts it: not her Accept or
// Ignore (404), her line, her asking for the chat (Message on his profile) or her adding him. Her line, or her asking, is a
// request of her own, which waits for him under his Requests. An open with nothing written in it yet was never withdrawn:
// asking for the chat accepts it, as before.
const reqRow = (c: string) => db.prepare('SELECT from_pubkey, to_pubkey, state FROM dm_requests WHERE conversation_id = ?').get(c) as
    { from_pubkey: string; to_pubkey: string; state: string } | undefined;
const listOf = async (id: Id) => (await call('GET', id, `/api/messages/conversations/${id.pk}`)).body;
const inChats = (l: any, c: string) => (l?.conversations || []).some((x: any) => x.id === c);
const inRequests = (l: any, c: string) => (l?.requests?.conversations || []).some((x: any) => x.id === c);
const noticesTo = (id: Id) => (db.prepare('SELECT body FROM push_notices WHERE recipient = ? ORDER BY sent_at, rowid').all(id.pk) as { body: string }[]).map(r => r.body);
const openWith = async (a: Id, b: Id) => call('POST', a, '/api/messages/conversation', { type: 'dm', participants: [a.pk, b.pk], createdBy: a.pk });
const sendIn = async (c: string, id: Id) => call('POST', id, '/api/messages/send', { conversationId: c, authorPubkey: id.pk, ...lockedDm() });
const nat = member('Nat');
const ola = member('Ola');
const natSock = await socket(nat);
const noConv: string = (await openWith(nat, ola)).body.conversation.id;
const no1 = await sendIn(noConv, nat);
const natCancels = await call('POST', nat, '/api/messages/request', { conversationId: noConv, decision: 'cancel' });
const olaAccepts = await call('POST', ola, '/api/messages/request', { conversationId: noConv, decision: 'accept' });
const olaIgnores = await call('POST', ola, '/api/messages/request', { conversationId: noConv, decision: 'ignore' });
const olaRead = await call('GET', ola, `/api/messages/${noConv}`);
assert(no1.status === 200 && natCancels.status === 200 && olaAccepts.status === 404 && olaAccepts.body.code === 'request_not_found'
    && olaIgnores.status === 404 && olaIgnores.body.code === 'request_not_found'
    && reqRow(noConv)?.state === 'pending' && reqRow(noConv)?.from_pubkey === nat.pk,
    `after Nat's cancel, Ola's Accept and Ignore find no request (404), and the node keeps his, waiting (${olaAccepts.status} ${olaAccepts.body.code}, ${olaIgnores.status}, ${JSON.stringify(reqRow(noConv))})`);
assert(olaRead.body.conversation?.request?.state === 'pending' && olaRead.body.conversation?.request?.from === nat.pk && olaRead.body.messages?.length === 0,
    `Ola reads his request as the node holds it, with no line in it (${JSON.stringify(olaRead.body.conversation?.request)}, ${olaRead.body.messages?.length} lines)`);
const natHeard = natSock.events.length;
const natNotices = noticesTo(nat).length;
const ol1 = await sendIn(noConv, ola);
await new Promise(r => setTimeout(r, 200));
const natList = await listOf(nat);
assert(ol1.status === 200 && reqRow(noConv)?.state === 'pending' && reqRow(noConv)?.from_pubkey === ola.pk && reqRow(noConv)?.to_pubkey === nat.pk,
    `Ola's line accepts nothing: it is a request of her own, waiting for Nat (${ol1.status}, ${JSON.stringify(reqRow(noConv))})`);
assert(!inChats(natList, noConv) && inRequests(natList, noConv) && natList?.totalUnread === 0,
    `it is under Nat's Requests, not in his chats or his unread count (chats ${inChats(natList, noConv)}, requests ${inRequests(natList, noConv)}, unread ${natList?.totalUnread})`);
assert(noticesTo(nat).length === natNotices
    && !natSock.events.slice(natHeard).some(e => e.type === 'dm_request_updated' && e.request?.state === 'accepted'),
    `Nat gets no alert for a request, and hears no acceptance (${noticesTo(nat).length - natNotices} pushes)`);
const ol2 = await sendIn(noConv, ola);
const olaReads = await call('GET', ola, `/api/messages/${noConv}`);
assert(ol2.status === 403 && ol2.body.code === 'dm_request_pending' && olaReads.body.conversation?.request?.from === ola.pk
    && olaReads.body.conversation?.request?.nextLineIsRequest === false,
    `her second line is refused as any waiting opener's, and she reads her own request (${ol2.status} ${ol2.body.code}, ${JSON.stringify(olaReads.body.conversation?.request)})`);
const no2 = await sendIn(noConv, nat);
assert(no2.status === 200 && reqRow(noConv)?.state === 'accepted', `Nat's reply accepts Ola's request, as a reply to any request does (${no2.status}, ${reqRow(noConv)?.state})`);
// Quin asks for the chat with Pia (Message on her profile) after her cancel: a request of his own, his next line its line.
const pia = member('Pia');
const quin = member('Quin');
const pqConv: string = (await openWith(pia, quin)).body.conversation.id;
await sendIn(pqConv, pia);
const piaCancels = await call('POST', pia, '/api/messages/request', { conversationId: pqConv, decision: 'cancel' });
const quinAsks = await openWith(quin, pia);
const piaList = await listOf(pia);
assert(piaCancels.status === 200 && quinAsks.status === 200 && quinAsks.body.conversation?.id === pqConv
    && quinAsks.body.conversation?.request?.state === 'pending' && quinAsks.body.conversation?.request?.from === quin.pk
    && quinAsks.body.conversation?.request?.nextLineIsRequest === true && reqRow(pqConv)?.state === 'pending',
    `Quin asking for the chat accepts nothing: it is a request of his own, his next line its line (${quinAsks.status}, ${JSON.stringify(quinAsks.body.conversation?.request)})`);
assert(!inChats(piaList, pqConv) && !inRequests(piaList, pqConv),
    `until he writes, it asks Pia nothing (chats ${inChats(piaList, pqConv)}, requests ${inRequests(piaList, pqConv)})`);
const qp1 = await sendIn(pqConv, quin);
const piaList2 = await listOf(pia);
assert(qp1.status === 200 && reqRow(pqConv)?.from_pubkey === quin.pk && reqRow(pqConv)?.state === 'pending' && inRequests(piaList2, pqConv) && !inChats(piaList2, pqConv),
    `his line is the request, under Pia's Requests (${qp1.status}, ${JSON.stringify(reqRow(pqConv))})`);
// Uma adding Tia after her cancel accepts nothing either; it lets Tia's next line through, as the rule does for anyone Uma added.
const tia = member('Tia');
const uma = member('Uma');
const tuConv: string = (await openWith(tia, uma)).body.conversation.id;
await sendIn(tuConv, tia);
const tiaCancels = await call('POST', tia, '/api/messages/request', { conversationId: tuConv, decision: 'cancel' });
const umaAdds = await call('POST', uma, '/api/friends/add', { friendPubkey: tia.pk });
const tuAfterAdd = reqRow(tuConv)?.state;
const tu2 = await sendIn(tuConv, tia);
assert(tiaCancels.status === 200 && umaAdds.status === 200 && tuAfterAdd === 'pending' && tu2.status === 200 && reqRow(tuConv)?.state === 'accepted',
    `Uma adding Tia leaves Tia's withdrawn request (${tuAfterAdd}); Tia's next line goes straight through (${tu2.status}, ${reqRow(tuConv)?.state})`);
// An open with nothing written in it yet, never withdrawn: Sid asking for the chat accepts Ray's, as before.
const ray = member('Ray');
const sid = member('Sid');
const rsConv: string = (await openWith(ray, sid)).body.conversation.id;
const sidAsks = await openWith(sid, ray);
assert(sidAsks.status === 200 && sidAsks.body.conversation?.id === rsConv && sidAsks.body.conversation?.request?.state === 'accepted' && reqRow(rsConv)?.from_pubkey === ray.pk,
    `Ray's open with nothing in it is accepted by Sid asking for the chat, as before (${sidAsks.status}, ${JSON.stringify(sidAsks.body.conversation?.request)})`);

// A block the opener made (PR #2540 review 4396980737): what a blocked member does never reaches the person who blocked
// them. Vic cancels her request to Wes and blocks him; Wes writes. The row stays as she left it: her list and her chat read
// as before, and nothing is pushed or rung to her. To Wes it is a request of his own, as it is to anyone she hasn't blocked
// (Ola above): he reads it as his, his second line and a reaction are refused, Accept is an opener's refusal, and his
// cancel withdraws his line.
const requestRow = (c: string) => JSON.stringify(db.prepare('SELECT from_pubkey, to_pubkey, state, requested_at, decided_at, accepted_by, state_before FROM dm_requests WHERE conversation_id = ?').get(c));
const requestIn = (l: any, c: string) => JSON.stringify((l?.conversations || []).find((x: any) => x.id === c)?.request ?? null);
const readOf = async (id: Id, c: string) => (await call('GET', id, `/api/messages/${c}`)).body.conversation?.request;
const vic = member('Vic');
const wes = member('Wes');
const vicSock = await socket(vic);
const vwConv: string = (await openWith(vic, wes)).body.conversation.id;
await sendIn(vwConv, vic);
const vicCancels = await call('POST', vic, '/api/messages/request', { conversationId: vwConv, decision: 'cancel' });
const vicBlocks = await call('POST', vic, '/api/blocks', { targetPubkey: wes.pk });
const vwRowLeft = requestRow(vwConv);
const vicListLeft = await listOf(vic);
const vicReadLeft = await readOf(vic, vwConv);
const vicHeard = vicSock.events.length;
const vicNotices = noticesTo(vic).length;
const wv1 = await sendIn(vwConv, wes);
await new Promise(r => setTimeout(r, 200));
const vicList = await listOf(vic);
const vicRead = await readOf(vic, vwConv);
assert(vicCancels.status === 200 && vicBlocks.status === 200 && wv1.status === 200 && requestRow(vwConv) === vwRowLeft,
    `Wes's line while Vic blocks him leaves her request's row as she left it (${wv1.status}, ${requestRow(vwConv)})`);
assert(inChats(vicList, vwConv) && !inRequests(vicList, vwConv) && requestIn(vicList, vwConv) === requestIn(vicListLeft, vwConv)
    && JSON.stringify(vicRead) === JSON.stringify(vicReadLeft) && vicRead?.from === vic.pk && vicRead?.nextLineIsRequest === true,
    `Vic's list and chat read as she left them: her own request, her next line its line (${requestIn(vicList, vwConv)}, ${JSON.stringify(vicRead)})`);
assert(noticesTo(vic).length === vicNotices && !vicSock.events.slice(vicHeard).some(e => e.conversationId === vwConv),
    `nothing is pushed or rung to Vic (${noticesTo(vic).length - vicNotices} pushes, ${JSON.stringify(vicSock.events.slice(vicHeard).map(e => e.type))})`);
const wesRead = await readOf(wes, vwConv);
const wesList = await listOf(wes);
assert(wesRead?.from === wes.pk && wesRead?.state === 'pending' && wesRead?.nextLineIsRequest === false
    && inChats(wesList, vwConv) && JSON.parse(requestIn(wesList, vwConv))?.from === wes.pk,
    `to Wes it is a request of his own, as to anyone Vic hasn't blocked: his, waiting, in his chats (${JSON.stringify(wesRead)}, ${requestIn(wesList, vwConv)})`);
const wv2 = await sendIn(vwConv, wes);
const wesReacts = await call('POST', wes, '/api/messages/react', { messageId: wv1.body.message?.id, authorPubkey: wes.pk, emoji: '👍' });
const wesAccepts = await call('POST', wes, '/api/messages/request', { conversationId: vwConv, decision: 'accept' });
assert(wv2.status === 403 && wv2.body.code === 'dm_request_pending' && wesReacts.status === 403 && wesReacts.body.code === 'dm_request_pending'
    && wesAccepts.status === 403 && wesAccepts.body.code === 'not_request_recipient',
    `his second line and his reaction are refused as any waiting opener's, and Accept is an opener's refusal (${wv2.status} ${wv2.body.code}, ${wesReacts.status} ${wesReacts.body.code}, ${wesAccepts.status} ${wesAccepts.body.code})`);
const wesCancels = await call('POST', wes, '/api/messages/request', { conversationId: vwConv, decision: 'cancel' });
const wesKept = (db.prepare('SELECT COUNT(*) AS n FROM withheld_lines WHERE id = ?').get(wv1.body.message?.id) as { n: number }).n;
const wv3 = await sendIn(vwConv, wes);
const wesAgain = await sendIn(vwConv, wes);
assert(wesCancels.status === 200 && wesCancels.body.request?.from === wes.pk && wesCancels.body.request?.nextLineIsRequest === true && wesKept === 0
    && wv3.status === 200 && wesAgain.status === 403 && requestRow(vwConv) === vwRowLeft && JSON.stringify(await readOf(vic, vwConv)) === JSON.stringify(vicReadLeft),
    `Wes cancels his own: his kept line goes, his next line is its line again, and Vic's row and chat stay as she left them (${wesCancels.status}, ${JSON.stringify(wesCancels.body.request)}, kept ${wesKept}, ${wv3.status}, ${wesAgain.status})`);
// Once Vic lifts the block, the line kept during it never reaches her, so it is no request's line: his next line is, as a
// blocked opener's is after a lift, and it turns the request round, under her Requests.
const vicLifts = await call('POST', vic, '/api/blocks/remove', { targetPubkey: wes.pk });
const wesReadLifted = await readOf(wes, vwConv);
const wv4 = await sendIn(vwConv, wes);
const vicListLifted = await listOf(vic);
assert(vicLifts.status === 200 && wesReadLifted?.from === wes.pk && wesReadLifted?.nextLineIsRequest === true && wv4.status === 200
    && reqRow(vwConv)?.from_pubkey === wes.pk && reqRow(vwConv)?.to_pubkey === vic.pk && reqRow(vwConv)?.state === 'pending' && inRequests(vicListLifted, vwConv),
    `once Vic lifts the block, Wes's next line is the request's, under her Requests (${JSON.stringify(wesReadLifted)}, ${wv4.status}, ${JSON.stringify(reqRow(vwConv))}, requests ${inRequests(vicListLifted, vwConv)})`);
// The same by asking for the chat (Message on her profile): Yas, whom Xan blocked after her cancel, gets the answer anyone
// gets, a request of his own with his next line its line, and Xan's row and chat stay as she left them.
const xan = member('Xan');
const yas = member('Yas');
const xyConv: string = (await openWith(xan, yas)).body.conversation.id;
await sendIn(xyConv, xan);
const xanCancels = await call('POST', xan, '/api/messages/request', { conversationId: xyConv, decision: 'cancel' });
const xanBlocks = await call('POST', xan, '/api/blocks', { targetPubkey: yas.pk });
const xyRowLeft = requestRow(xyConv);
const xanReadLeft = JSON.stringify(await readOf(xan, xyConv));
const yasAsks = await openWith(yas, xan);
const yasReads = await readOf(yas, xyConv);
assert(xanCancels.status === 200 && xanBlocks.status === 200 && yasAsks.status === 200 && yasAsks.body.conversation?.id === xyConv
    && yasAsks.body.conversation?.request?.from === yas.pk && yasAsks.body.conversation?.request?.state === 'pending'
    && yasAsks.body.conversation?.request?.nextLineIsRequest === true && yasReads?.from === yas.pk && yasReads?.nextLineIsRequest === true,
    `Yas asking for the chat while Xan blocks him: a request of his own, his next line its line, as Quin's (${yasAsks.status}, ${JSON.stringify(yasAsks.body.conversation?.request)}, ${JSON.stringify(yasReads)})`);
const xanList = await listOf(xan);
assert(requestRow(xyConv) === xyRowLeft && JSON.stringify(await readOf(xan, xyConv)) === xanReadLeft && inChats(xanList, xyConv) && !inRequests(xanList, xyConv),
    `and Xan's row, list and chat stay as she left them (${requestRow(xyConv)}, chats ${inChats(xanList, xyConv)})`);
const yx1 = await sendIn(xyConv, yas);
const yx2 = await sendIn(xyConv, yas);
assert(yx1.status === 200 && yx2.status === 403 && yx2.body.code === 'dm_request_pending' && requestRow(xyConv) === xyRowLeft
    && JSON.stringify(await readOf(xan, xyConv)) === xanReadLeft,
    `his line is its line, his second refused, and Xan's row and chat still as she left them (${yx1.status}, ${yx2.status} ${yx2.body.code})`);

// ── 11. A blocked member who reached out sees their request accepted when the blocker writes; nothing tells them they are
// blocked (Marty, 28 Oct 2026, PR #2540: "B: shows as accepted") ──────────────────────────────────────────────────────
// Each case runs twice: the opener asks, the other ignores it or not, the opener cancels and, in one of the two, blocks the
// other; the other writes (reaching out); then the opener writes. Everything the other reads, hears and is answered from
// then on is the same in both: their own request accepted by her line, in their chats, her line in it, pushed and counted
// as an ordinary line. With an Ignore first, their chat is in their chats at every step: her line never brings the Ignore
// back (PR #2540 review 4397305910, the probe of the :504 finding). The opener who blocks reads hers as waiting, until she
// lifts the block. Also: the other blocking her back after reaching out, her line written while requests are off, the
// other cancelling their own request before she writes, and the other doing both.
const seenAs = (r: any, me: Id, them: Id, at0?: string) => !r ? 'none'
    : [r.state, r.from === me.pk ? 'mine' : r.from === them.pk ? 'theirs' : '?', at0 === undefined ? '' : r.at === at0 ? 'same-at' : 'moved', String(r.nextLineIsRequest ?? '')].join(':');
const placeOf = (l: any, c: string) => inChats(l, c) ? 'chats' : inRequests(l, c) ? 'requests' : 'neither';
const listedIn = (l: any, c: string) => (l?.conversations || []).find((x: any) => x.id === c)?.request;
async function reachOutThenOpenerWrites(opName: string, reName: string, o: { ignoreFirst?: boolean; block: boolean; blockBack?: boolean; off?: boolean; cancelOwn?: boolean; opCancels?: boolean }) {
    const op = member(opName);
    const re = member(reName);
    const reSock = await socket(re);
    const opSock = await socket(op);
    const c: string = (await openWith(op, re)).body.conversation.id;
    await sendIn(c, op);
    if (o.ignoreFirst) await call('POST', re, '/api/messages/request', { conversationId: c, decision: 'ignore' });
    await call('POST', op, '/api/messages/request', { conversationId: c, decision: 'cancel' });
    if (o.block) await call('POST', op, '/api/blocks', { targetPubkey: re.pk });
    const reLine = await sendIn(c, re);
    if (o.blockBack) await call('POST', re, '/api/blocks', { targetPubkey: op.pk });
    const reCancelsOwn = o.cancelOwn ? (await call('POST', re, '/api/messages/request', { conversationId: c, decision: 'cancel' })).status : undefined;
    const before = await readOf(re, c);
    const placeBefore = placeOf(await listOf(re), c);
    const reHeard = reSock.events.length;
    const opHeard = opSock.events.length;
    const reNotices = noticesTo(re).length;
    if (o.off) setSwitchOverride('dmRequests', false);
    const opLine = await sendIn(c, op);
    if (o.off) setSwitchOverride('dmRequests', true);
    // She cancels what her line made before he reads anything (Cancel request in her chat).
    const opCancels = o.opCancels ? (await call('POST', op, '/api/messages/request', { conversationId: c, decision: 'cancel' })).status : undefined;
    const row = db.prepare('SELECT from_pubkey, state, reached_out_at FROM dm_requests WHERE conversation_id = ?').get(c) as
        { from_pubkey: string; state: string; reached_out_at: string | null } | undefined;
    const rowAfter = row ? [row.from_pubkey === op.pk ? 'hers' : 'his', row.state, row.reached_out_at === null ? 'none' : 'set'].join(':') : 'none';
    await new Promise(r => setTimeout(r, 200));
    const reAfter = (await call('GET', re, `/api/messages/${c}`)).body;
    const reList = await listOf(re);
    const seen: Record<string, unknown> = {
        reLine: reLine.status,
        reCancelsOwn,
        before: seenAs(before, re, op),
        placeBefore,
        after: seenAs(reAfter.conversation?.request, re, op, before?.at),
        place: placeOf(reList, c),
        listed: seenAs(listedIn(reList, c), re, op, before?.at),
        unread: reList?.totalUnread,
        seesHerLine: (reAfter.messages || []).some((m: any) => m.id === opLine.body.message?.id),
        pushed: noticesTo(re).slice(reNotices).map(b => b.replace(opName, '{opener}')),
        heard: reSock.events.slice(reHeard).filter(e => e.conversationId === c)
            .map(e => e.type === 'dm_request_updated' ? `${e.type}:${seenAs(e.request, re, op, before?.at)}` : `${e.type}:${e.message?.authorPubkey === op.pk ? 'hers' : 'his'}`),
    };
    // The opener's side (asserted per case, not compared: she reads what she did).
    const opener = {
        line: opLine.status,
        read: seenAs(await readOf(op, c), op, re),
        place: placeOf(await listOf(op), c),
        heardAccepted: opSock.events.slice(opHeard).some(e => e.conversationId === c && e.type === 'dm_request_updated' && e.request?.state === 'accepted'),
        second: '',
        reacts: '',
        cancels: opCancels,
    };
    const opSecond = await sendIn(c, op);
    const opReacts = await call('POST', op, '/api/messages/react', { messageId: opLine.body.message?.id, authorPubkey: op.pk, emoji: '👍' });
    opener.second = `${opSecond.status} ${opSecond.body?.code ?? ''}`;
    opener.reacts = `${opReacts.status} ${opReacts.body?.code ?? ''}`;
    // The other's answers from here on, the cancel last: it withdraws what it can.
    const reSecond = await sendIn(c, re);
    const reReacts = await call('POST', re, '/api/messages/react', { messageId: reLine.body.message?.id, authorPubkey: re.pk, emoji: '👍' });
    const reAccepts = await call('POST', re, '/api/messages/request', { conversationId: c, decision: 'accept' });
    const reIgnores = await call('POST', re, '/api/messages/request', { conversationId: c, decision: 'ignore' });
    const reCancels = await call('POST', re, '/api/messages/request', { conversationId: c, decision: 'cancel' });
    seen.answers = [reSecond, reReacts, reAccepts, reIgnores, reCancels].map(r => `${r.status} ${r.body?.code ?? ''}`).join(', ');
    seen.cancelReads = seenAs(reCancels.body?.request, re, op, before?.at);
    seen.placeAtEnd = placeOf(await listOf(re), c);
    if (o.blockBack) {
        await call('POST', re, '/api/blocks/remove', { targetPubkey: op.pk });
        seen.afterOwnLift = seenAs(await readOf(re, c), re, op, before?.at);
    }
    reSock.ws.close();
    opSock.ws.close();
    return { op, re, c, seen, opener, rowAfter };
}
const plainControl = await reachOutThenOpenerWrites('Abe', 'Bix', { block: false });
const plainBlocked = await reachOutThenOpenerWrites('Cora', 'Dex', { block: true });
assert(plainBlocked.seen.after === 'accepted:mine:same-at:' && plainBlocked.seen.place === 'chats' && plainBlocked.seen.listed === 'accepted:mine:same-at:'
    && plainBlocked.seen.seesHerLine === true && plainBlocked.seen.unread === 1 && JSON.stringify(plainBlocked.seen.pushed) === '["{opener} sent you a message"]',
    `a blocked member who reached out sees their request accepted when the blocker writes: Dex reads his own accepted, in his chats, her line in it, pushed and counted as an ordinary one (${JSON.stringify(plainBlocked.seen)})`);
assert(JSON.stringify(plainBlocked.seen) === JSON.stringify(plainControl.seen),
    `nothing tells them they are blocked: all Dex reads, hears and is answered is what Bix, not blocked, is (blocked ${JSON.stringify(plainBlocked.seen)}; control ${JSON.stringify(plainControl.seen)})`);
assert(plainBlocked.opener.line === 200 && plainBlocked.opener.read === 'pending:mine::false' && plainBlocked.opener.place === 'chats' && !plainBlocked.opener.heardAccepted
    && plainBlocked.opener.second === '403 dm_request_pending' && plainBlocked.opener.reacts === '403 dm_request_pending',
    `Cora, who blocks him, reads hers as waiting: her second line and her reaction refused, nothing accepted rung to her (${JSON.stringify(plainBlocked.opener)})`);
const coraLifts = await call('POST', plainBlocked.op, '/api/blocks/remove', { targetPubkey: plainBlocked.re.pk });
const coraReadsLifted = seenAs(await readOf(plainBlocked.op, plainBlocked.c), plainBlocked.op, plainBlocked.re);
const coraWrites = await sendIn(plainBlocked.c, plainBlocked.op);
const dexReadsLifted = seenAs(await readOf(plainBlocked.re, plainBlocked.c), plainBlocked.re, plainBlocked.op);
assert(coraLifts.status === 200 && coraReadsLifted === 'accepted:mine::' && coraWrites.status === 200 && dexReadsLifted === 'accepted:mine::',
    `once Cora lifts the block it shows to her as accepted, and she writes on; Dex reads it as before (${coraReadsLifted}, ${coraWrites.status}, ${dexReadsLifted})`);
// The :504 finding: an Ignore before the cancel. Before the fix her line brought his Ignore back and the chat left both his lists.
const ignoredControl = await reachOutThenOpenerWrites('Elle', 'Finn', { ignoreFirst: true, block: false });
const ignoredBlocked = await reachOutThenOpenerWrites('Gwen', 'Hugo', { ignoreFirst: true, block: true });
assert(ignoredBlocked.seen.placeBefore === 'chats' && ignoredBlocked.seen.place === 'chats' && ignoredBlocked.seen.placeAtEnd === 'chats'
    && ignoredBlocked.seen.after === 'accepted:mine:same-at:',
    `Hugo ignored Gwen's request, she cancelled and blocked him, he wrote: when she writes his chat stays in his chats, his request accepted, never his old Ignore (${JSON.stringify(ignoredBlocked.seen)})`);
assert(JSON.stringify(ignoredBlocked.seen) === JSON.stringify(ignoredControl.seen),
    `and all Hugo reads, hears and is answered is what Finn, not blocked, is (blocked ${JSON.stringify(ignoredBlocked.seen)}; control ${JSON.stringify(ignoredControl.seen)})`);
assert(ignoredBlocked.opener.line === 200 && ignoredBlocked.opener.read === 'pending:mine::false' && ignoredBlocked.opener.second === '403 dm_request_pending' && !ignoredBlocked.opener.heardAccepted,
    `Gwen's answers are a waiting request's: 200, then 403 (${JSON.stringify(ignoredBlocked.opener)})`);
// He blocks her back after reaching out: her line is kept for her alone and reaches him no more than her acceptance of a
// request of his would while he blocks her: he reads his own as waiting, and accepted once he lifts his block.
const backControl = await reachOutThenOpenerWrites('Iris', 'Jude', { block: false, blockBack: true });
const backBlocked = await reachOutThenOpenerWrites('Kai', 'Lars', { block: true, blockBack: true });
assert(backBlocked.seen.after === 'pending:mine:same-at:false' && backBlocked.seen.place === 'chats' && backBlocked.seen.afterOwnLift === 'accepted:mine:same-at:'
    && JSON.stringify(backBlocked.seen) === JSON.stringify(backControl.seen),
    `Lars, who blocks Kai back, reads and is answered as Jude, whom Iris never blocked (blocked ${JSON.stringify(backBlocked.seen)}; control ${JSON.stringify(backControl.seen)})`);
// Her line written while requests are off answers him all the same, and reads so once they are on again.
const offControl = await reachOutThenOpenerWrites('Mira', 'Ned', { block: false, off: true });
const offBlocked = await reachOutThenOpenerWrites('Opal', 'Pax', { block: true, off: true });
assert(offBlocked.seen.after === 'accepted:mine:same-at:' && offBlocked.seen.place === 'chats' && JSON.stringify(offBlocked.seen) === JSON.stringify(offControl.seen)
    && offBlocked.opener.read === 'pending:mine::false',
    `with requests off when Opal writes, Pax reads as Ned does, and Opal hers as waiting (blocked ${JSON.stringify(offBlocked.seen)}; control ${JSON.stringify(offControl.seen)}; ${offBlocked.opener.read})`);
// He cancels his own request before she writes (PR #2540 review 4399348393): her line is then a request of hers, as it is
// to one she never blocked, and answers nothing he withdrew. Before the fix it was accepted, in his chats, counted, and
// rung to him as accepted.
const cancelControl = await reachOutThenOpenerWrites('Rosa', 'Seth', { block: false, cancelOwn: true });
const cancelBlocked = await reachOutThenOpenerWrites('Tess', 'Ugo', { block: true, cancelOwn: true });
assert(cancelBlocked.seen.reCancelsOwn === 200 && cancelBlocked.seen.before === 'pending:mine::true' && cancelBlocked.seen.after === 'pending:theirs:moved:'
    && cancelBlocked.seen.place === 'requests' && cancelBlocked.seen.unread === 0 && cancelBlocked.rowAfter === 'hers:pending:none',
    `Ugo cancelled his own request, then Tess, who blocks him, writes: a request of hers again, under his Requests, not an answer to the one he withdrew (${JSON.stringify(cancelBlocked.seen)}, row ${cancelBlocked.rowAfter})`);
assert(JSON.stringify(cancelBlocked.seen) === JSON.stringify(cancelControl.seen) && cancelBlocked.rowAfter === cancelControl.rowAfter,
    `and all Ugo reads, hears and is answered is what Seth, not blocked, is (blocked ${JSON.stringify(cancelBlocked.seen)}, row ${cancelBlocked.rowAfter}; control ${JSON.stringify(cancelControl.seen)}, row ${cancelControl.rowAfter})`);
assert(cancelBlocked.opener.line === 200 && cancelBlocked.opener.read === 'pending:mine::false' && !cancelBlocked.opener.heardAccepted,
    `Tess reads hers as waiting, as any opener's after their line (${JSON.stringify(cancelBlocked.opener)})`);
// He blocks her back AND cancels his own request before she writes (PR #2540 review 4400797748): her line is kept for her
// alone, so it changes nothing he reads, as it changes nothing for one she never blocked: his own request, cancelled, in
// his chats. Before the fix her line took his chat out of both his lists and his request read as hers, which told him she
// wrote and that she blocks him.
const backCancelControl = await reachOutThenOpenerWrites('Vida', 'Wade', { block: false, blockBack: true, cancelOwn: true });
const backCancelBlocked = await reachOutThenOpenerWrites('Yara', 'Zeke', { block: true, blockBack: true, cancelOwn: true });
assert(backCancelBlocked.seen.reCancelsOwn === 200 && backCancelBlocked.seen.after === 'pending:mine:same-at:true' && backCancelBlocked.seen.place === 'chats'
    && backCancelBlocked.seen.listed === 'pending:mine:same-at:true' && backCancelBlocked.seen.seesHerLine === false && backCancelBlocked.seen.placeAtEnd === 'chats',
    `Zeke blocked Yara back and cancelled his own request, then she writes: he reads his own, cancelled, in his chats, and never her line (${JSON.stringify(backCancelBlocked.seen)})`);
assert(JSON.stringify(backCancelBlocked.seen) === JSON.stringify(backCancelControl.seen),
    `and all Zeke reads, hears and is answered is what Wade, whom Vida never blocked, is (blocked ${JSON.stringify(backCancelBlocked.seen)}; control ${JSON.stringify(backCancelControl.seen)})`);
assert(backCancelBlocked.opener.line === 200 && backCancelBlocked.opener.read === 'pending:mine::false' && backCancelBlocked.opener.second === '403 dm_request_pending'
    && !backCancelBlocked.opener.heardAccepted,
    `Yara's answers are a waiting request's: 200, then 403 (${JSON.stringify(backCancelBlocked.opener)})`);
// And she cancels what her line made before he reads it: neither the line nor its cancel ever reached him, so his own,
// cancelled, stays as he left it. Without the fix her cancel cleared his, and his chat left both his lists.
const opCancelsControl = await reachOutThenOpenerWrites('Fay', 'Gus', { block: false, blockBack: true, cancelOwn: true, opCancels: true });
const opCancelsBlocked = await reachOutThenOpenerWrites('Hana', 'Ike', { block: true, blockBack: true, cancelOwn: true, opCancels: true });
assert(opCancelsBlocked.opener.cancels === 200 && opCancelsBlocked.seen.after === 'pending:mine:same-at:true' && opCancelsBlocked.seen.place === 'chats'
    && JSON.stringify(opCancelsBlocked.seen.heard) === '[]' && JSON.stringify(opCancelsBlocked.seen) === JSON.stringify(opCancelsControl.seen),
    `Hana cancels the line she wrote after Ike blocked her back and cancelled his: he reads, hears and is answered as Gus is (blocked ${JSON.stringify(opCancelsBlocked.seen)}; control ${JSON.stringify(opCancelsControl.seen)})`);

vicSock.ws.close();
natSock.ws.close();
ginaSock.ws.close();
bobSock.ws.close();
aliceSock.ws.close();
await p2p.stop();

console.log(`\n${passed}/${run} passed`);
process.exit(passed === run ? 0 : 1);

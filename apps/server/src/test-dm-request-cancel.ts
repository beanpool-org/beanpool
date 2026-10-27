/**
 * Message requests: Cancel request (decideRequest decision: 'cancel').
 *
 * Checks:
 *   1. the opener cancels → the request is gone from the recipient's requests and the opener's line is gone
 *   2. a second cancel → refused (409 request_not_pending)
 *   3. the recipient can't cancel (403 not_request_opener)
 *   4. another member can't cancel (404 request_not_found)
 *   5. cancel then a new first line within the hour → a request again, and NO second push inside the hour (count the pushes)
 *   6. an ignored request stays ignored through a cancel and a new line: no Requests entry, no push, no fold push
 *   7. the cancel withdraws only the opener's lines: the recipient's own line (kept for them) stays
 *   8. a withdrawn line leaves a `messages` tombstone, and its photo row, stored object and overlays go with it
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
import { tickRequestPushFolds, REQUEST_PUSH_EVERY_MS } from './engine/dm-requests.js';
import { getImageStore, readObject } from './storage/image-store.js';

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
assert(pushesTo(bob).length === 1, `Bob received exactly 1 push: ${pushesTo(bob).length}`);

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

// ── 6. Alice sends a new first line within the hour ──────────────────────────────────────────────
// Count pushes before sending
const bobPushesBefore = pushesTo(bob).length;
const send2 = await call('POST', alice, '/api/messages/send', { conversationId: convId, authorPubkey: alice.pk, ...lockedDm() });
assert(send2.status === 200, `Alice sends new first message: ${send2.status}`);

// It is a request again: Bob sees it under requests
const bobList3 = await call('GET', bob, `/api/messages/conversations/${bob.pk}`);
const bobReqs3 = bobList3.body.requests?.conversations || [];
assert(bobReqs3.length === 1 && bobReqs3[0].id === convId, `Bob has 1 request again: ${bobReqs3.length}`);

// NO second push inside the hour
const bobPushesAfter = pushesTo(bob).length;
assert(bobPushesAfter === bobPushesBefore, `No second push inside the hour (was ${bobPushesBefore}, now ${bobPushesAfter})`);

// Sockets received update
assert(bobSock.events.some(e => e.type === 'dm_request_updated' && e.conversationId === convId),
    'Bob received dm_request_updated via socket');
assert(aliceSock.events.some(e => e.type === 'dm_request_updated' && e.conversationId === convId),
    'Alice received dm_request_updated via socket');

// ── 7. Cancel never undoes Ignore (PR #2540 review 4393642102) ───────────────────────────────────
// Gina ignores Frank's request. He cancels it and writes again inside its 30 days: his answers are a waiting request's, and
// it stays ignored for her: in neither of her lists, no push now, none folded into the hour's end, nothing on her socket.
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
// The hour's end: Bob's line after Alice's cancel (6) was folded and still waits, so he is pushed; Gina is not.
const folded: string[][] = [];
tickRequestPushFolds((targets) => { folded.push(targets); }, Date.now() + REQUEST_PUSH_EVERY_MS + 1000);
assert(folded.some(t => t.includes(bob.pk)) && !folded.some(t => t.includes(gina.pk)),
    `an hour on, the fold pushes Bob (Alice's request waits) and not Gina (${folded.map(t => t.map(pk => pk === bob.pk ? 'Bob' : pk === gina.pk ? 'Gina' : pk.slice(0, 6)).join('+')).join(', ')})`);

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

ginaSock.ws.close();
bobSock.ws.close();
aliceSock.ws.close();
await p2p.stop();

console.log(`\n${passed}/${run} passed`);
process.exit(passed === run ? 0 : 1);

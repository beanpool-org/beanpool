/**
 * Message requests: Cancel request (decideRequest decision: 'cancel').
 *
 * Checks:
 *   1. the opener cancels → the request is gone from the recipient's requests and the opener's line is gone
 *   2. a second cancel → refused (409 request_not_pending)
 *   3. the recipient can't cancel (403 not_request_opener)
 *   4. another member can't cancel (404 request_not_found)
 *   5. cancel then a new first line within the hour → a request again, and NO second push inside the hour (count the pushes)
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
const pushes: { to: string; title: string; body: string; data: any; badge?: number }[] = [];
(globalThis as any).fetch = async (url: any, init: any) => {
    if (String(url).includes('exp.host')) {
        pushes.push(...JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({}) } as any;
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

let owner: Id;
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
const p2p = await startP2P();
owner = newId('Owner');
seedGenesisMember(owner.pk, 'owner');

const server = await startHttpsServer();
const addr = server.address() as any;
BASE = `https://localhost:${addr.port}`;

const alice = member('Alice');
const bob = member('Bob');
const charlie = member('Charlie');

const bobSock = await socket(bob);
const aliceSock = await socket(alice);

// ── 1. Alice opens a conversation with Bob and sends a request line ──────────────────────────────
const openRes = await call('POST', alice, '/api/messages/conversation', { recipientPubkey: bob.pk });
assert(openRes.status === 200, `Alice opens chat with Bob: ${openRes.status}`);
const convId = openRes.body.conversation.id;

const send1 = await call('POST', alice, '/api/messages/send', lockedDm(convId, alice.pk, bob.pk, 'Hello Bob!'));
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
const send2 = await call('POST', alice, '/api/messages/send', lockedDm(convId, alice.pk, bob.pk, 'Hello again Bob!'));
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

bobSock.ws.close();
aliceSock.ws.close();
server.close();
await p2p.stop();

console.log(`\n${passed}/${run} passed`);
process.exit(passed === run ? 0 : 1);

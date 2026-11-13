/**
 * The mailbox between communities, through the real middleware (messages across communities X2: scratch/fable-design/
 * DESIGN-cross-chat-voice-fable.md §3.2, §3.3, §3.5, §7, §11 row X2; DESIGN-forums-messaging-joint-fable.md §3.1:
 * "X2 handles four item kinds (line, blob, delete, receipt) and answers every other kind 202 and drops it").
 *
 * Two communities in one process, as test-federation-hardening has its peer beside the node: the node under test is
 * b.example (BEANPOOL_ADDRESSES, its own node key), the real server with its real routes, door and database. The other
 * community is a.example, played by this suite: its server key and key document (handed to the node's door by the test
 * fetch hook, double-locked by BEANPOOL_SSRF_TEST_HOOK=1, as https://a.example/api/node/key would answer), its members'
 * keys, and its own /api/relay/mail, which the node's forwards reach through the transport hook: there the suite checks
 * each forward with core's own verifier against b.example's key document from b.example's real route, and each item with
 * core's checkRelayItem, before it answers. No other server is contacted.
 *
 *   1  send, held: Ana (a.example) writes Ben (b.example); a.example's signed request is answered 202; the line waits
 *   2  fetch: Ben reads it, as it came; nobody else does
 *   3  a blob: held as a file of its own, fetched on its own; the row keeps no bytes
 *   4  a delete for everyone is held the same way
 *   5  confirm: the rows and the file are deleted; the same items again are replays, answered alike, nothing stored
 *   6  a receipt: Ben's device signs one, the node forwards it to a.example in a request it signed
 *   7  Ben writes Ana: the outbox row is queued, then sent; the sealed copy goes at the 2xx; Ana's receipt makes it delivered,
 *      and a receipt from anyone else moves nothing
 *   8  202 and drop: a key that is no member here, a member who blocked the sender, a group item, a call signal; each
 *      answered exactly as a held item is, and nothing is stored
 *   9  the owner's switch: off, every item from outside is answered 202 and dropped, and a member's send is refused; on again
 *  10  caps: a blob over 1,200,000 characters is refused (413) and nothing stored or spent; two blobs, 17 items: 400; a
 *      member past 200 items or 20 MB waiting: dropped; a sending server past 300 an hour, a sender key past 200 a day: 429;
 *      the mailbox past 500 MB or the disk past its floor: 503; a member's send of a blob over the cap: 413
 *  11  envelopes: wrong home, a changed payload, stale: refused, nothing stored
 *  12  a member's send refused: not their envelope, not this home, a recipient here, not a member, a bad signature
 *  13  a forward that fails is queued and tried again; 24 hours untaken is failed; 30 days unconfirmed is expired
 *  14  hygiene: held mail goes after 30 days, and when its recipient is no member here; seen ids after 8 days
 *  15  never copied: a standby's whole copy and a snapshot file hold no mail, no outbox, no ids; the blob is not in the images
 *  16  the door: unsigned, or a member's signature, at /api/relay/mail is refused
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) BEANPOOL_SSRF_TEST_HOOK=1 pnpm exec tsx src/test-relay-mail.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.BEANPOOL_SSRF_TEST_HOOK = '1';
process.env.BEANPOOL_ADDRESSES = 'b.example';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
    NODE_KEY_VALIDITY_MS, NODE_REQUEST_HEADER, buildNodeRequestHeaders, checkRelayItem, nodeRequestSignatureVerifies,
    parseNodeRequestHeader, readNodeKeyDocument, relayPayloadHash, signNodeKeyDocument, signRelayEnvelope, type RelayItem,
    type RelayItemKind,
} from '@beanpool/core';
import { signedHeaders } from './signed-request-test-helper.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

let BASE = '';
const DAY = 24 * 60 * 60_000;

interface Keys { seed: Uint8Array; key: string }
const keys = (): Keys => { const seed = crypto.randomBytes(32); return { seed, key: Buffer.from(ed25519.getPublicKey(seed)).toString('hex') }; };
const signerOf = (seed: Uint8Array) => (b: Uint8Array) => ed25519.sign(b, seed);

interface Answer { status: number; body: any; headers: Headers }
async function send(method: string, path: string, headers: Record<string, string>, body?: string): Promise<Answer> {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body });
    let parsed: any = null;
    try { parsed = await res.json(); } catch { /* no body */ }
    return { status: res.status, body: parsed, headers: res.headers };
}

async function main(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR;
    if (!dataDir) throw new Error('BEANPOOL_DATA_DIR must be set to a fresh directory');
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const nodeKey = await generateKeyPair('Ed25519');
    fs.writeFileSync(path.join(dataDir, 'libp2p_key'), privateKeyToProtobuf(nodeKey));

    const { initTls } = await import('./services/tls.js');
    const { initStateEngine, seedGenesisMember, exportSyncState } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { __useNodeKeyFetchForTests } = await import('./engine/node-signature.js');
    const { applyShapeChanges } = await import('./config/community-shape-write.js');
    const mail = await import('./engine/relay-mail.js');
    const outbox = await import('./engine/relay-outbox.js');
    const { TABLES: REPLICATION_TABLES } = await import('./engine/replication-manifest.js');
    const { setSimulatedFreeDiskBytesForTests } = await import('./engine/photo-upload-budget.js');
    const { writeDbSnapshot } = await import('./services/snapshot-scheduler.js');
    const { imagesDir } = await import('./storage/image-store.js');

    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    // ── The members here, and the other community ─────────────────────────────────────────
    const olive = keys(), ben = keys(), bea = keys();
    seedGenesisMember(olive.key, 'Olive');
    const addLocal = (k: Keys, name: string) => {
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'TEST', 'active')`).run(k.key, name, olive.key);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(k.key);
    };
    addLocal(ben, 'Ben');
    addLocal(bea, 'Bea');
    const A = keys();                    // a.example's server key
    const C = keys();                    // c.example's
    const ana = keys(), abe = keys(), cara = keys();
    const now = Date.now();
    const docs = new Map<string, unknown>([
        ['https://a.example/api/node/key', await signNodeKeyDocument({ key: A.key, validUntil: now + NODE_KEY_VALIDITY_MS, previousKeys: [] }, signerOf(A.seed))],
        ['https://c.example/api/node/key', await signNodeKeyDocument({ key: C.key, validUntil: now + NODE_KEY_VALIDITY_MS, previousKeys: [] }, signerOf(C.seed))],
    ]);
    __useNodeKeyFetchForTests(async (url) => {
        if (!docs.has(url)) throw new Error('no such server');
        return docs.get(url);
    });
    const bDoc = readNodeKeyDocument(await (await fetch(`${BASE}/api/node/key`)).json());
    if (!bDoc) throw new Error('b.example has no key document');

    // a.example's own /api/relay/mail: what the node's forwards reach. It checks each as a real server's door would.
    interface Forward { url: string; origin: string | null; signed: boolean; items: RelayItem[]; refused: string[] }
    const forwards: Forward[] = [];
    let aAnswers = 202;
    let aUnreachable = false;
    let answerAfterMs = 0;
    outbox.__useRelayTransportForTests(async (url, init) => {
        if (aUnreachable) throw new Error('connect ECONNREFUSED');
        if (answerAfterMs) await new Promise((r) => setTimeout(r, answerAfterMs));
        const header = parseNodeRequestHeader(init.headers[NODE_REQUEST_HEADER] ?? '');
        const signed = !!header && header.key === bDoc.key && header.destination === 'a.example'
            && nodeRequestSignatureVerifies(header, { method: 'POST', path: new URL(url).pathname, body: init.body });
        const items: RelayItem[] = [];
        const refused: string[] = [];
        for (const raw of (JSON.parse(init.body).items ?? []) as unknown[]) {
            const v = checkRelayItem(raw, { signedBy: header?.origin ?? '', isHere: (h) => h === 'a.example' });
            if (v.ok) items.push(v.item); else refused.push(v.reason);
        }
        forwards.push({ url, origin: header?.origin ?? null, signed, items, refused });
        return { status: aAnswers };
    });

    // ── Helpers ───────────────────────────────────────────────────────────────────────────
    let n = 0;
    const newId = () => `itm-${String(++n).padStart(4, '0')}-${crypto.randomBytes(6).toString('hex')}`;
    async function item(from: Keys, fromHome: string, to: string, toHome: string, opts: { kind?: RelayItemKind; payload?: string; at?: number; itemId?: string } = {}): Promise<RelayItem> {
        const payload = opts.payload ?? crypto.randomBytes(300).toString('base64');
        const envelope = await signRelayEnvelope({
            kind: opts.kind ?? 'dm-line', itemId: opts.itemId ?? newId(), senderKey: from.key, senderHome: fromHome, recipient: to,
            recipientHome: toHome, at: opts.at ?? Date.now(), payloadHash: relayPayloadHash(payload),
        }, signerOf(from.seed));
        return { envelope, payload };
    }
    /** a.example (or `as`) brings items to b.example, in a request it signed. */
    async function bring(items: unknown[], as: { name: string; k: Keys } = { name: 'a.example', k: A }): Promise<Answer> {
        const body = JSON.stringify({ items });
        const headers = await buildNodeRequestHeaders({ method: 'POST', url: 'https://b.example/api/relay/mail', body, origin: as.name, keyHex: as.k.key, sign: signerOf(as.k.seed) });
        return send('POST', '/api/relay/mail', headers, body);
    }
    /** A member's signed request to b.example. `path` may carry a query; the signature covers the path alone. */
    async function asMember(who: Keys, method: 'GET' | 'POST', pathAndQuery: string, body?: unknown): Promise<Answer> {
        const text = body === undefined ? '' : JSON.stringify(body);
        const p = pathAndQuery.split('?')[0];
        return send(method, pathAndQuery, signedHeaders({ method, path: p, body: text, publicKeyHex: who.key, key: who.seed, host: 'b.example' }), method === 'GET' ? undefined : text);
    }
    const heldCount = (where = '1 = 1', ...args: unknown[]) => (db.prepare(`SELECT COUNT(*) AS n FROM relay_mail WHERE ${where}`).get(...args) as { n: number }).n;
    const seenCount = () => (db.prepare('SELECT COUNT(*) AS n FROM relay_mail_seen').get() as { n: number }).n;
    const outRow = (sender: string, id: string) => db.prepare('SELECT * FROM relay_outbox WHERE sender_key = ? AND item_id = ?').get(sender, id) as any;
    const inFile = (sender: string, id: string) => mail.relayBlobFile('in', sender, id);

    // ── 1. Send, held ─────────────────────────────────────────────────────────────────────
    console.log('\n1. Ana at a.example writes Ben at b.example');
    const line1 = await item(ana, 'a.example', ben.key, 'b.example');
    const r1 = await bring([line1]);
    assert(r1.status === 202 && r1.body?.items?.[0]?.received === true && r1.body.items[0].itemId === line1.envelope.itemId,
        `1a. a.example's signed request is answered 202, the item received (got ${r1.status} ${JSON.stringify(r1.body)})`);
    const held1 = db.prepare('SELECT * FROM relay_mail WHERE sender_key = ? AND item_id = ?').get(ana.key, line1.envelope.itemId) as any;
    assert(!!held1 && held1.recipient === ben.key && held1.payload === line1.payload && held1.sender_home === 'a.example' && held1.kind === 'dm-line',
        '1b. it waits for Ben, sealed as it came, with its sender\'s home');
    assert(r1.headers.get('cache-control') === 'no-store', '1c. the answer is never kept by a cache');

    // ── 2. Fetch ──────────────────────────────────────────────────────────────────────────
    console.log('\n2. Ben fetches what waits');
    const f1 = await asMember(ben, 'GET', '/api/mail');
    assert(f1.status === 200 && f1.body?.items?.length === 1 && f1.body.items[0].envelope.itemId === line1.envelope.itemId
        && f1.body.items[0].payload === line1.payload && f1.body.items[0].envelope.sig === line1.envelope.sig && f1.body.more === false,
        `2a. GET /api/mail gives Ben the line and its signed envelope as they came (got ${f1.status} ${JSON.stringify(f1.body)?.slice(0, 160)})`);
    const fBea = await asMember(bea, 'GET', '/api/mail');
    assert(fBea.status === 200 && fBea.body?.items?.length === 0, '2b. Bea, another member here, gets nothing of Ben\'s');
    const stranger = keys();
    const fStranger = await asMember(stranger, 'GET', '/api/mail');
    assert(fStranger.status === 403 || fStranger.status === 401, `2c. a key that is no member here is refused (got ${fStranger.status})`);

    // ── 3. A blob ─────────────────────────────────────────────────────────────────────────
    console.log('\n3. A sealed photo or voice part');
    const blobPayload = crypto.randomBytes(600_000).toString('base64');   // 800,000 characters
    const blob1 = await item(ana, 'a.example', ben.key, 'b.example', { kind: 'dm-blob', payload: blobPayload });
    const r3 = await bring([blob1]);
    const heldBlob = db.prepare('SELECT payload, bytes FROM relay_mail WHERE item_id = ?').get(blob1.envelope.itemId) as any;
    assert(r3.status === 202 && !!heldBlob && heldBlob.payload === null && heldBlob.bytes === blobPayload.length,
        `3a. a blob of ${blobPayload.length} characters is held; its row keeps no bytes (got ${r3.status})`);
    assert(fs.existsSync(inFile(ana.key, blob1.envelope.itemId)) && fs.readFileSync(inFile(ana.key, blob1.envelope.itemId), 'utf8') === blobPayload,
        '3b. its bytes are a file of their own under relay-mail/in');
    const f3 = await asMember(ben, 'GET', '/api/mail');
    const listed = (f3.body?.items ?? []).find((i: any) => i.envelope.itemId === blob1.envelope.itemId);
    assert(!!listed && listed.payload === null && listed.bytes === blobPayload.length, '3c. the fetch lists it with its size, its bytes fetched on their own');
    const b3 = await asMember(ben, 'GET', `/api/mail/blob/${blob1.envelope.itemId}`);
    assert(b3.status === 200 && b3.body?.payload === blobPayload, `3d. GET /api/mail/blob/:itemId gives Ben its bytes (got ${b3.status})`);
    const b3Bea = await asMember(bea, 'GET', `/api/mail/blob/${blob1.envelope.itemId}`);
    assert(b3Bea.status === 404, `3e. Bea asking for Ben's blob: 404 (got ${b3Bea.status})`);

    // ── 4. A delete ───────────────────────────────────────────────────────────────────────
    console.log('\n4. A delete for everyone');
    const del1 = await item(ana, 'a.example', ben.key, 'b.example', { kind: 'dm-delete' });
    const r4 = await bring([del1]);
    assert(r4.status === 202 && heldCount('item_id = ? AND kind = ?', del1.envelope.itemId, 'dm-delete') === 1, '4a. held for Ben like a line: his device applies it');

    // ── 5. Confirm ────────────────────────────────────────────────────────────────────────
    console.log('\n5. Ben\'s device confirms');
    const c5 = await asMember(ben, 'POST', '/api/mail/confirm', { ids: [line1.envelope.itemId, blob1.envelope.itemId, del1.envelope.itemId] });
    assert(c5.status === 200 && c5.body?.confirmed === 3, `5a. three confirmed (got ${c5.status} ${JSON.stringify(c5.body)})`);
    assert(heldCount('recipient = ?', ben.key) === 0, '5b. their rows are deleted');
    assert(!fs.existsSync(inFile(ana.key, blob1.envelope.itemId)), '5c. the blob\'s file is deleted');
    const f5 = await asMember(ben, 'GET', '/api/mail');
    assert(f5.body?.items?.length === 0, '5d. nothing waits any more');
    const replay = await bring([line1, blob1]);
    assert(replay.status === 202 && replay.body?.items?.every((i: any) => i.received === true) && heldCount() === 0,
        `5e. the same two items again: answered alike, and nothing stored (a replay dies on its sender and id) (got ${replay.status})`);
    const bConfirmsBea = await asMember(bea, 'POST', '/api/mail/confirm', { ids: [line1.envelope.itemId] });
    assert(bConfirmsBea.status === 200 && bConfirmsBea.body?.confirmed === 0, '5f. Bea confirming Ben\'s id deletes nothing of his');

    // ── 6. Ben's receipt ──────────────────────────────────────────────────────────────────
    console.log('\n6. Ben\'s device sends a receipt to Ana');
    const receipt = await item(ben, 'b.example', ana.key, 'a.example', { kind: 'receipt', payload: JSON.stringify({ v: 1, items: [line1.envelope.itemId, blob1.envelope.itemId] }) });
    const s6 = await asMember(ben, 'POST', '/api/mail/send', { items: [receipt] });
    const fw6 = forwards.at(-1);
    assert(s6.status === 200 && s6.body?.items?.[0]?.state === 'sent', `6a. the receipt is sent (got ${s6.status} ${JSON.stringify(s6.body)})`);
    assert(!!fw6 && fw6.url === 'https://a.example/api/relay/mail' && fw6.signed && fw6.origin === 'b.example'
        && fw6.items.length === 1 && fw6.items[0].envelope.kind === 'receipt' && fw6.items[0].envelope.itemId === receipt.envelope.itemId,
        `6b. a.example got it in a request b.example signed with its published key, and its envelope checks out there (${JSON.stringify({ url: fw6?.url, signed: fw6?.signed, origin: fw6?.origin, refused: fw6?.refused })})`);

    // ── 7. Ben writes Ana: the outbox ─────────────────────────────────────────────────────
    console.log('\n7. Ben writes Ana');
    const out1 = await item(ben, 'b.example', ana.key, 'a.example');
    const s7 = await asMember(ben, 'POST', '/api/mail/send', { items: [out1] });
    const row7 = outRow(ben.key, out1.envelope.itemId);
    assert(s7.status === 200 && s7.body?.items?.[0]?.state === 'sent' && row7?.state === 'sent' && row7.item === null,
        `7a. forwarded at once: sent, and the outbox keeps no sealed copy (got ${s7.status} ${row7?.state}, item ${row7?.item === null ? 'gone' : 'kept'})`);
    const fw7 = forwards.at(-1);
    assert(!!fw7 && fw7.signed && fw7.items[0]?.payload === out1.payload && fw7.refused.length === 0, '7b. a.example got the line, signed, as Ben sealed it');
    const again7 = await asMember(ben, 'POST', '/api/mail/send', { items: [out1] });
    assert(again7.status === 200 && again7.body?.items?.[0]?.state === 'sent' && forwards.at(-1) === fw7, '7c. sent again by the device: its row answers, nothing forwarded twice');
    const forged = await item(abe, 'a.example', ben.key, 'b.example', { kind: 'receipt', payload: JSON.stringify({ v: 1, items: [out1.envelope.itemId] }) });
    await bring([forged]);
    assert(outRow(ben.key, out1.envelope.itemId).state === 'sent', '7d. a receipt from Abe, who was never sent it, moves nothing');
    const fromC = await item(ana, 'c.example', ben.key, 'b.example', { kind: 'receipt', payload: JSON.stringify({ v: 1, items: [out1.envelope.itemId] }) });
    await bring([fromC], { name: 'c.example', k: C });
    assert(outRow(ben.key, out1.envelope.itemId).state === 'sent', '7e. Ana\'s key with c.example as her home (not where it was sent) moves nothing');
    const anaReceipt = await item(ana, 'a.example', ben.key, 'b.example', { kind: 'receipt', payload: JSON.stringify({ v: 1, items: [out1.envelope.itemId] }) });
    const r7 = await bring([anaReceipt]);
    assert(r7.status === 202 && outRow(ben.key, out1.envelope.itemId).state === 'delivered' && heldCount('item_id = ?', anaReceipt.envelope.itemId) === 0,
        `7f. Ana's signed receipt, from her home: delivered, and the receipt itself is not held (got ${outRow(ben.key, out1.envelope.itemId).state})`);
    const f7 = await asMember(ben, 'GET', '/api/mail');
    const tick = (f7.body?.outbox ?? []).find((o: any) => o.itemId === out1.envelope.itemId);
    assert(tick?.state === 'delivered' && tick.recipient === ana.key && tick.recipientHome === 'a.example' && !(f7.body.outbox as any[]).some((o) => o.kind === 'receipt'),
        `7g. Ben's fetch carries the tick: delivered; his receipts are not listed (got ${JSON.stringify(tick)})`);

    // ── 8. 202 and drop ───────────────────────────────────────────────────────────────────
    console.log('\n8. 202 and drop, answered exactly as a held item');
    const shape = (a: Answer) => JSON.stringify({ s: a.status, b: (a.body?.items ?? []).map((i: any) => Object.keys(i).sort().join(',') + (i.received ? ':r' : '')) });
    const heldAnswer = await bring([await item(ana, 'a.example', bea.key, 'b.example')]);
    const before8 = heldCount();
    const toNobody = await bring([await item(ana, 'a.example', keys().key, 'b.example')]);
    assert(shape(toNobody) === shape(heldAnswer) && heldCount() === before8,
        `8a. to a key that is no member here: the same answer as one held (${shape(toNobody)} vs ${shape(heldAnswer)}), and nothing stored`);
    db.prepare("INSERT INTO member_blocks (owner_pubkey, blocked_pubkey) VALUES (?, ?)").run(bea.key, abe.key);
    const blocked = await bring([await item(abe, 'a.example', bea.key, 'b.example')]);
    assert(shape(blocked) === shape(heldAnswer) && heldCount() === before8, '8b. from Abe, whom Bea blocked: the same answer, nothing stored');
    const others = await bring([
        await item(ana, 'a.example', ben.key, 'b.example', { kind: 'call-signal' }),
        await item(ana, 'a.example', 'group:hall', 'b.example', { kind: 'group-line' }),
        await item(ana, 'a.example', ben.key, 'b.example', { kind: 'complaint' }),
    ]);
    assert(others.status === 202 && others.body?.items?.length === 3 && others.body.items.every((i: any) => i.received === true) && heldCount() === before8,
        `8c. a call signal, a group line and a complaint (not this slice's kinds): 202, received, nothing stored (got ${others.status})`);

    // ── 9. The owner's switch ─────────────────────────────────────────────────────────────
    console.log('\n9. The owner\'s switch, Messages from other communities');
    const info9 = await (await fetch(`${BASE}/api/community/info`)).json();
    assert(info9?.features?.outsideMessages === true, `9a. on by default: features say outsideMessages (got ${JSON.stringify(info9?.features?.outsideMessages)})`);
    const offWrite = applyShapeChanges({ actor: olive.key, actorRole: 'owner' }, { changes: { outsideMessages: false } });
    assert(offWrite.changed.includes('outsideMessages') && offWrite.told === 'nobody' && offWrite.shape.settings.outsideMessages.value === false,
        `9a2. Olive, an owner, turns it off under How this community works; members are not told (no app shows an outside chat yet) (changed ${offWrite.changed.join(', ')}; told ${offWrite.told})`);
    const off = await bring([await item(ana, 'a.example', ben.key, 'b.example')]);
    assert(shape(off) === shape(heldAnswer) && heldCount() === before8, '9b. off: an item for Ben is answered the same, and dropped');
    const offSend = await asMember(ben, 'POST', '/api/mail/send', { items: [await item(ben, 'b.example', ana.key, 'a.example')] });
    assert(offSend.status === 403 && offSend.body?.code === 'outside_messages_off', `9c. off: Ben's send is refused (got ${offSend.status} ${offSend.body?.code})`);
    const info9off = await (await fetch(`${BASE}/api/community/info`)).json();
    assert(!('outsideMessages' in (info9off?.features ?? {})), '9d. off: features no longer say it');
    applyShapeChanges({ actor: olive.key, actorRole: 'owner' }, { changes: { outsideMessages: true } });
    const onAgain = await bring([await item(ana, 'a.example', ben.key, 'b.example')]);
    assert(onAgain.status === 202 && heldCount('recipient = ?', ben.key) === 1, '9e. on again: held');
    const shapeRead = await import('./config/community-shape.js');
    assert(shapeRead.SHAPE_SWITCH_PLACES.outsideMessages === 'outsideMessages', '9f. it is an owners\' setting under How this community works');

    // ── 10. Caps ──────────────────────────────────────────────────────────────────────────
    console.log('\n10. Caps');
    const seenBefore = seenCount();
    const bigBlob = await item(ana, 'a.example', ben.key, 'b.example', { kind: 'dm-blob', payload: 'A'.repeat(mail.RELAY_BLOB_MAX_CHARS + 1) });
    const r10 = await bring([bigBlob]);
    assert(r10.status === 413 && r10.body?.code === 'too_large' && heldCount('item_id = ?', bigBlob.envelope.itemId) === 0 && seenCount() === seenBefore
        && !fs.existsSync(inFile(ana.key, bigBlob.envelope.itemId)),
        `10a. a blob of ${mail.RELAY_BLOB_MAX_CHARS + 1} characters is refused, 413, and nothing is stored or spent (got ${r10.status} ${r10.body?.code})`);
    const okBlob = await item(ana, 'a.example', ben.key, 'b.example', { kind: 'dm-blob', payload: 'B'.repeat(mail.RELAY_BLOB_MAX_CHARS) });
    const r10b = await bring([okBlob]);
    assert(r10b.status === 202 && heldCount('item_id = ?', okBlob.envelope.itemId) === 1, `10b. one of exactly ${mail.RELAY_BLOB_MAX_CHARS} is held (got ${r10b.status})`);
    const bigLine = await item(ana, 'a.example', ben.key, 'b.example', { payload: 'C'.repeat(mail.RELAY_LINE_MAX_CHARS + 1) });
    assert((await bring([bigLine])).status === 413, `10c. a line over ${mail.RELAY_LINE_MAX_CHARS} characters: 413`);
    const twoBlobs = await bring([await item(ana, 'a.example', ben.key, 'b.example', { kind: 'dm-blob' }), await item(ana, 'a.example', ben.key, 'b.example', { kind: 'dm-blob' })]);
    assert(twoBlobs.status === 400, `10d. two blobs in one request: 400 (got ${twoBlobs.status})`);
    const seventeen = await bring(Array.from({ length: 17 }, () => line1));
    assert(seventeen.status === 400, `10e. 17 items in one request: 400 (got ${seventeen.status})`);

    // Bea's mailbox at 200 items: the 201st is dropped, the held ones kept.
    const fill = db.prepare(`INSERT INTO relay_mail (sender_key, item_id, kind, recipient, sender_home, envelope, payload, bytes, received_at)
                             VALUES (?, ?, 'dm-line', ?, 'a.example', '{}', 'x', 1, ?)`);
    const filler = keys().key;
    const heldBea = heldCount('recipient = ?', bea.key);
    for (let i = heldBea; i < mail.MAIL_PER_MEMBER_ITEMS; i++) fill.run(filler, `fill-${String(i).padStart(6, '0')}`, bea.key, Date.now());
    const overItems = await bring([await item(ana, 'a.example', bea.key, 'b.example')]);
    assert(shape(overItems) === shape(heldAnswer) && heldCount('recipient = ?', bea.key) === mail.MAIL_PER_MEMBER_ITEMS,
        `10f. Bea has ${mail.MAIL_PER_MEMBER_ITEMS} waiting: the next is answered the same and dropped; hers are kept`);
    db.prepare('DELETE FROM relay_mail WHERE sender_key = ?').run(filler);
    fill.run(filler, 'fill-bytes-0001', bea.key, Date.now());
    db.prepare('UPDATE relay_mail SET bytes = ? WHERE sender_key = ?').run(mail.MAIL_PER_MEMBER_BYTES - 10, filler);
    const overBytes = await bring([await item(ana, 'a.example', bea.key, 'b.example')]);
    assert(shape(overBytes) === shape(heldAnswer) && heldCount('recipient = ? AND sender_key = ?', bea.key, ana.key) === 1,
        '10g. Bea with 20 MB waiting: a line more is answered the same and dropped');
    db.prepare('DELETE FROM relay_mail WHERE sender_key = ?').run(filler);

    // A sending server past 300 in the hour, a sender key past 200 in the day: 429, whoever they are for.
    const spend = db.prepare('INSERT INTO relay_mail_seen (sender_key, item_id, sender_home, seen_at) VALUES (?, ?, ?, ?)');
    const someone = keys().key;
    for (let i = 0; i < mail.MAIL_PER_ORIGIN_HOUR; i++) spend.run(someone, `spent-${String(i).padStart(6, '0')}`, 'c.example', Date.now());
    const busyC = await bring([await item(cara, 'c.example', keys().key, 'b.example')], { name: 'c.example', k: C });
    assert(busyC.status === 429 && busyC.body?.code === 'rate_limited' && !!busyC.headers.get('retry-after'),
        `10h. c.example past ${mail.MAIL_PER_ORIGIN_HOUR} items in the hour: 429 with Retry-After, for an item to nobody here too (got ${busyC.status})`);
    assert((await bring([await item(ana, 'a.example', ben.key, 'b.example')])).status === 202, '10i. a.example meanwhile: taken');
    db.prepare('DELETE FROM relay_mail_seen WHERE sender_key = ?').run(someone);
    const loud = keys();
    for (let i = 0; i < mail.MAIL_PER_SENDER_DAY; i++) spend.run(loud.key, `loud-${String(i).padStart(6, '0')}`, 'a.example', Date.now() - 2 * 60 * 60_000);
    const loudAgain = await bring([await item(loud, 'a.example', ben.key, 'b.example')]);
    assert(loudAgain.status === 429, `10j. a sender key past ${mail.MAIL_PER_SENDER_DAY} items in the day: 429 (got ${loudAgain.status})`);
    db.prepare('DELETE FROM relay_mail_seen WHERE sender_key = ?').run(loud.key);

    // The whole mailbox past 500 MB, and the disk past its floor: 503.
    fill.run(filler, 'fill-server-0001', bea.key, Date.now());
    db.prepare('UPDATE relay_mail SET bytes = ? WHERE sender_key = ?').run(mail.MAIL_SERVER_BYTES, filler);
    const full = await bring([await item(ana, 'a.example', ben.key, 'b.example')]);
    assert(full.status === 503 && full.body?.code === 'mailbox_full', `10k. ${mail.MAIL_SERVER_BYTES} bytes waiting here: 503 mailbox_full (got ${full.status})`);
    db.prepare('DELETE FROM relay_mail WHERE sender_key = ?').run(filler);
    setSimulatedFreeDiskBytesForTests(1024);
    const diskFull = await bring([await item(ana, 'a.example', ben.key, 'b.example')]);
    assert(diskFull.status === 503 && diskFull.body?.code === 'mailbox_full', `10l. the disk past its free floor: 503 (got ${diskFull.status})`);
    setSimulatedFreeDiskBytesForTests(null);
    const sendBig = await asMember(ben, 'POST', '/api/mail/send', { items: [await item(ben, 'b.example', ana.key, 'a.example', { kind: 'dm-blob', payload: 'D'.repeat(mail.RELAY_BLOB_MAX_CHARS + 1) })] });
    assert(sendBig.status === 413 && (db.prepare("SELECT COUNT(*) AS n FROM relay_outbox WHERE kind = 'dm-blob'").get() as { n: number }).n === 0,
        `10m. Ben's send of a blob over the cap: 413, no outbox row (got ${sendBig.status})`);

    // ── 11. Envelopes ─────────────────────────────────────────────────────────────────────
    console.log('\n11. Envelopes that fail their checks');
    const before11 = heldCount();
    const caraVia = await item(cara, 'c.example', ben.key, 'b.example');
    const changed = await item(ana, 'a.example', ben.key, 'b.example');
    const stale = await item(ana, 'a.example', ben.key, 'b.example', { at: Date.now() - 8 * DAY });
    const r11 = await bring([caraVia, { envelope: changed.envelope, payload: `${changed.payload}A` }, stale]);
    const reasons = (r11.body?.items ?? []).map((i: any) => i.refused ?? 'received');
    assert(r11.status === 202 && reasons.join(',') === 'wrong-home,payload-changed,stale' && heldCount() === before11,
        `11a. Cara's line carried by a.example, a changed payload, an item 8 days old: refused (${reasons.join(', ')}), nothing stored`);

    // ── 12. A member's send refused ───────────────────────────────────────────────────────
    console.log('\n12. A member\'s send, refused');
    const outBefore = (db.prepare('SELECT COUNT(*) AS n FROM relay_outbox').get() as { n: number }).n;
    const notHis = await asMember(ben, 'POST', '/api/mail/send', { items: [await item(bea, 'b.example', ana.key, 'a.example')] });
    const otherHome = await asMember(ben, 'POST', '/api/mail/send', { items: [await item(ben, 'c.example', ana.key, 'a.example')] });
    const here = await asMember(ben, 'POST', '/api/mail/send', { items: [await item(ben, 'b.example', bea.key, 'b.example')] });
    const badSig = await item(ben, 'b.example', ana.key, 'a.example');
    const badSigSent = await asMember(ben, 'POST', '/api/mail/send', { items: [{ envelope: { ...badSig.envelope, sig: (await item(bea, 'b.example', ana.key, 'a.example')).envelope.sig }, payload: badSig.payload }] });
    const notMember = await asMember(stranger, 'POST', '/api/mail/send', { items: [await item(stranger, 'b.example', ana.key, 'a.example')] });
    assert(notHis.status === 400 && otherHome.status === 400 && here.status === 400 && badSigSent.status === 400,
        `12a. Bea's envelope, a home other than b.example, a recipient here, a signature not Ben's: each 400 (got ${notHis.status}, ${otherHome.status}, ${here.status}, ${badSigSent.status})`);
    assert(notMember.status === 403 || notMember.status === 401, `12b. a key that is no member here: refused (got ${notMember.status})`);
    assert((db.prepare('SELECT COUNT(*) AS n FROM relay_outbox').get() as { n: number }).n === outBefore, '12c. no outbox row for any of them');

    const quotes = await item(ben, 'b.example', ana.key, 'a.example', { payload: '"'.repeat(mail.RELAY_LINE_MAX_CHARS) });
    aAnswers = 503;
    const q12 = await asMember(ben, 'POST', '/api/mail/send', { items: [quotes] });
    aAnswers = 202;
    assert(q12.status === 200 && q12.body?.items?.[0]?.state === 'queued' && JSON.parse(outRow(ben.key, quotes.envelope.itemId).item).payload === quotes.payload,
        `12d. a line of ${mail.RELAY_LINE_MAX_CHARS} quotes (twice that, escaped) waits queued with its sealed copy whole (got ${q12.status} ${JSON.stringify(q12.body)?.slice(0, 120)})`);

    // ── 13. Forward failures ──────────────────────────────────────────────────────────────
    console.log('\n13. A forward that fails');
    aAnswers = 503;
    const out2 = await item(ben, 'b.example', ana.key, 'a.example');
    const s13 = await asMember(ben, 'POST', '/api/mail/send', { items: [out2] });
    const row13 = outRow(ben.key, out2.envelope.itemId);
    assert(s13.body?.items?.[0]?.state === 'queued' && row13.attempts === 1 && row13.item !== null && row13.next_try_at > Date.now(),
        `13a. a.example answers 503: queued, the sealed copy kept for the next try (got ${row13?.state}, ${row13?.attempts} tries)`);
    aUnreachable = true;
    await outbox.retryRelayOutbox(row13.next_try_at + 1);
    assert(outRow(ben.key, out2.envelope.itemId).state === 'queued' && outRow(ben.key, out2.envelope.itemId).attempts === 2, '13b. a.example unreachable: still queued, tried twice');
    aUnreachable = false;
    aAnswers = 202;
    await outbox.retryRelayOutbox(outRow(ben.key, out2.envelope.itemId).next_try_at + 1);
    assert(outRow(ben.key, out2.envelope.itemId).state === 'sent' && outRow(ben.key, out2.envelope.itemId).item === null, '13c. a.example back: sent, the copy gone');
    aAnswers = 503;
    const blobOut = await item(ben, 'b.example', ana.key, 'a.example', { kind: 'dm-blob', payload: crypto.randomBytes(30_000).toString('base64') });
    await asMember(ben, 'POST', '/api/mail/send', { items: [blobOut] });
    assert(outRow(ben.key, blobOut.envelope.itemId).state === 'queued' && fs.existsSync(mail.relayBlobFile('out', ben.key, blobOut.envelope.itemId)),
        '13d. a queued blob waits as a file of its own');
    outbox.sweepRelayOutbox(Date.now() + outbox.OUTBOX_QUEUE_MS + 1);
    assert(outRow(ben.key, blobOut.envelope.itemId).state === 'failed' && !fs.existsSync(mail.relayBlobFile('out', ben.key, blobOut.envelope.itemId)),
        '13e. 24 hours and never taken: failed, and its file gone');
    aAnswers = 202;
    outbox.sweepRelayOutbox(Date.now() + outbox.OUTBOX_KEPT_MS + 1);
    assert(outRow(ben.key, out2.envelope.itemId).state === 'expired', '13f. sent and never confirmed in 30 days: expired');
    answerAfterMs = 400;
    const t13 = Date.now();
    const twoHomes = await asMember(ben, 'POST', '/api/mail/send', { items: [await item(ben, 'b.example', ana.key, 'a.example'), await item(ben, 'b.example', cara.key, 'c.example')] });
    const took = Date.now() - t13;
    answerAfterMs = 0;
    assert(twoHomes.status === 200 && twoHomes.body?.items?.every((i: any) => i.state === 'sent') && took < 750,
        `13h. a send to two homes, each answering after 400 ms, waits for the slower, not their sum (${took} ms)`);
    outbox.sweepRelayOutbox(Date.now() + 2 * outbox.OUTBOX_KEPT_MS + 2);
    assert(!outRow(ben.key, out2.envelope.itemId) && !outRow(ben.key, out1.envelope.itemId), '13g. 30 days after their last change, settled rows go');

    // ── 14. Hygiene ───────────────────────────────────────────────────────────────────────
    console.log('\n14. Hygiene');
    assert(heldCount('recipient = ?', ben.key) > 0, '14a. Ben has mail waiting');
    mail.sweepRelayMail(Date.now() + mail.MAIL_HELD_DAYS * DAY + 1);
    assert(heldCount() === 0, '14b. 30 days unconfirmed: gone');
    assert(!fs.existsSync(inFile(ana.key, okBlob.envelope.itemId)), '14c. with its file');
    const gone = keys();
    addLocal(gone, 'Gone');
    await bring([await item(ana, 'a.example', gone.key, 'b.example')]);
    assert(heldCount('recipient = ?', gone.key) === 1, '14d. mail waits for Gone');
    db.prepare("UPDATE members SET status = 'pruned' WHERE public_key = ?").run(gone.key);
    mail.sweepRelayMail();
    assert(heldCount('recipient = ?', gone.key) === 0, '14e. Gone is no member here any more: their mail goes at the next sweep');
    const seenNow = seenCount();
    mail.sweepRelayMail(Date.now() + mail.MAIL_SEEN_MS + 1);
    assert(seenNow > 0 && seenCount() === 0, `14f. ids seen are kept 8 days, then go (${seenNow} → ${seenCount()})`);

    // ── 15. Never copied ──────────────────────────────────────────────────────────────────
    console.log('\n15. Never copied: a standby\'s copy, a snapshot file');
    const keep1 = await item(ana, 'a.example', ben.key, 'b.example');
    const keepBlob = await item(ana, 'a.example', ben.key, 'b.example', { kind: 'dm-blob', payload: crypto.randomBytes(3_000).toString('base64') });
    await bring([keep1]);
    await bring([keepBlob]);
    aAnswers = 503;
    const keepOut = await item(ben, 'b.example', ana.key, 'a.example');
    await asMember(ben, 'POST', '/api/mail/send', { items: [keepOut] });
    aAnswers = 202;
    assert(heldCount() === 2 && outRow(ben.key, keepOut.envelope.itemId)?.state === 'queued', '15a. two items held, one queued');
    for (const t of ['relay_mail', 'relay_mail_seen', 'relay_outbox']) {
        assert((REPLICATION_TABLES as Record<string, { kind: string }>)[t]?.kind === 'local', `15b. ${t} is local in the replication manifest`);
    }
    const { startP2P } = await import('./p2p.js');
    const p2p = await startP2P(0, 0);
    const copy = JSON.stringify(await exportSyncState(p2p.peerId.toString()));
    assert(copy.length > 1000 && !/relay_mail|relay_outbox/.test(copy) && !copy.includes(keep1.envelope.itemId) && !copy.includes(keep1.payload)
        && !copy.includes(keepBlob.envelope.itemId) && !copy.includes(keepOut.envelope.itemId),
        `15c. a standby's whole copy (${copy.length} characters) names no mailbox table, no item id, no payload`);
    const snap = path.join(dataDir, 'mail-check-snapshot.db');
    writeDbSnapshot(snap);
    const s15 = new Database(snap, { readonly: true });
    const inSnap = ['relay_mail', 'relay_mail_seen', 'relay_outbox'].map((t) => (s15.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
    s15.close();
    const raw = fs.readFileSync(snap);
    assert(inSnap.every((c) => c === 0) && !raw.includes(Buffer.from(keep1.payload)) && !raw.includes(Buffer.from(keep1.envelope.itemId)),
        `15d. a snapshot file (what every backup is made from) holds no mail, no outbox, no ids, not even in its free space (rows: ${inSnap.join(', ')})`);
    assert(heldCount() === 2, '15e. the live mailbox is untouched by the copy');
    const imageFiles = fs.existsSync(imagesDir()) ? fs.readdirSync(imagesDir(), { recursive: true }).map(String) : [];
    assert(!imageFiles.some((f) => f.includes(keepBlob.envelope.itemId)), '15f. the blob is not in the image store, so no backup\'s objects carry it');
    await p2p.stop();

    // ── 16. The door ──────────────────────────────────────────────────────────────────────
    console.log('\n16. The door');
    const unsigned = await send('POST', '/api/relay/mail', {}, JSON.stringify({ items: [keep1] }));
    assert(unsigned.status === 401 && unsigned.body?.code === 'node_signature_missing', `16a. unsigned: refused (got ${unsigned.status})`);
    const memberSigned = await asMember(ben, 'POST', '/api/relay/mail', { items: [keep1] });
    assert(memberSigned.status === 401 && memberSigned.body?.code === 'node_signature_missing', `16b. a member's signature is no server's: refused (got ${memberSigned.status})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Mail from another community waits sealed for its member, goes when their device has it, and is copied nowhere.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });

/**
 * Requests from another community's server, through the real middleware (messages across communities X1:
 * scratch/fable-design/DESIGN-cross-chat-voice-fable.md §3.2, §11 row X1; engine/node-signature.ts, routes/node-key.ts).
 *
 * The node under test is b.example (BEANPOOL_ADDRESSES), with a node key of its own. The other servers are this suite:
 * a.example, c.example and the rest sign with core's builder, and their key documents are handed to the node's door by
 * the test fetch hook (double-locked: BEANPOOL_SSRF_TEST_HOOK=1), as `https://<origin>/api/node/key` would answer them.
 * b.example's own document is fetched from its real route. No other server is contacted.
 *
 *   1  GET /api/node/key: the node key from data/libp2p_key, self-signed, valid 7 days, no previous key, the same for all
 *   2  a good request from a.example passes, with its origin and key; a previous key still within its time passes too
 *   3  the same request again is refused as a replay; a forged request burns no nonce
 *   4  a request signed for another destination is refused (421), and for loopback on a named node
 *   5  an expired key is refused: a document past its time, and a previous key past its own
 *   6  an unknown key is refused: one the document doesn't name, an origin with no document, a private origin (the real
 *      fetch refuses it, no hook)
 *   7  a changed body is refused, and a request signed for another path
 *   8  a time beyond the skew window is refused, either way; inside it, taken
 *   9  an envelope naming a home other than the server that signed the request is dropped; the same item from its own
 *      home is taken; for another server, a changed payload, a rewritten home: dropped. Nothing is stored
 *  10  no node signature: refused, a member's signature too, and every spelling of the path
 *  11  the node's own signer: a request it signs is taken by its own door, its document fetched from its own route
 *  12  at most 8 key fetches at once: the ninth origin is answered busy (503), and nothing waits on it
 *  13  two requests from one origin while its document is on its way: the second waits for it, one fetch
 *  14  a node that knows none of its names takes no server request: signed for localhost, 127.0.0.1, 192.168.1.10, 10.0.0.5
 *      or mybox.local, each is refused (421), and no item for one is for here; named again, its own name is taken
 *  15  512 + 1 origins' documents: the one in use is kept, the least recently used goes
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) BEANPOOL_SSRF_TEST_HOOK=1 pnpm exec tsx src/test-node-signature.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.BEANPOOL_SSRF_TEST_HOOK = '1';
process.env.BEANPOOL_ADDRESSES = 'b.example';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
    NODE_KEY_VALIDITY_MS, NODE_REQUEST_HEADER, buildNodeRequestHeaders, readNodeKeyDocument, relayPayloadHash, signNodeKeyDocument,
    signRelayEnvelope, type NodeKeyDocument, type RelayItemKind,
} from '@beanpool/core';
import { signedHeaders } from './signed-request-test-helper.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

let BASE = '';

interface Server { name: string; seed: Uint8Array; key: string }
function server(name: string): Server {
    const seed = crypto.randomBytes(32);
    return { name, seed, key: Buffer.from(ed25519.getPublicKey(seed)).toString('hex') };
}
const signerOf = (seed: Uint8Array) => (b: Uint8Array) => ed25519.sign(b, seed);

interface Answer { status: number; body: any; headers: Headers }

/** POST `path` on the node as a server: signed by `as` (key `signWith`, default its own) for `opts.destination`. */
async function serverPost(path: string, body: unknown, as: Server, opts: {
    destination?: string; timestamp?: number; nonce?: string; signWith?: Uint8Array; keyHex?: string; signPath?: string; sendBody?: string;
} = {}): Promise<Answer & { sent: Record<string, string>; text: string }> {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const headers = await buildNodeRequestHeaders({
        method: 'POST', url: `https://${opts.destination ?? 'b.example'}${opts.signPath ?? path}`, body: text, origin: as.name,
        keyHex: opts.keyHex ?? as.key, sign: signerOf(opts.signWith ?? as.seed), timestamp: opts.timestamp, nonce: opts.nonce,
    });
    const answer = await send(path, headers, opts.sendBody ?? text);
    return { ...answer, sent: headers, text };
}

async function send(path: string, headers: Record<string, string>, body: string): Promise<Answer> {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
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
    const B_KEY = Buffer.from(nodeKey.publicKey.raw).toString('hex');

    const { initTls } = await import('./services/tls.js');
    const { initStateEngine } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { __useNodeKeyFetchForTests, NODE_KEY_FETCHES_AT_ONCE } = await import('./engine/node-signature.js');
    const { isOwnNodeHome, ownNodeRequestHeaders } = await import('./engine/node-key.js');

    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    // ── The other servers and their key documents ─────────────────────────────────────────
    const A = server('a.example');
    const A_BEFORE = server('a.example');
    const C = server('c.example');
    const EXPIRED = server('expired.example');
    const ROTATED = server('rotated.example');
    const ROTATED_BEFORE = server('rotated.example');
    const now = Date.now();
    const docs = new Map<string, () => Promise<unknown>>();
    const docOf = async (s: Server, validUntil: number, previousKeys: NodeKeyDocument['previousKeys'] = []) =>
        signNodeKeyDocument({ key: s.key, validUntil, previousKeys }, signerOf(s.seed));
    const docA = await docOf(A, now + NODE_KEY_VALIDITY_MS, [{ key: A_BEFORE.key, validUntil: now + 60 * 60_000 }]);
    docs.set('a.example', async () => docA);
    docs.set('c.example', async () => docOf(C, now + NODE_KEY_VALIDITY_MS));
    docs.set('expired.example', async () => docOf(EXPIRED, now - 1_000));
    docs.set('rotated.example', async () => docOf(ROTATED, now + NODE_KEY_VALIDITY_MS, [{ key: ROTATED_BEFORE.key, validUntil: now - 1_000 }]));
    docs.set('b.example', async () => (await fetch(`${BASE}/api/node/key`)).json());
    const asked: string[] = [];
    __useNodeKeyFetchForTests(async (origin) => {
        asked.push(origin);
        const doc = docs.get(origin);
        if (!doc) throw new Error('no such server');
        return doc();
    });

    const counts = () => db.prepare('SELECT (SELECT COUNT(*) FROM members) AS members, (SELECT COUNT(*) FROM messages) AS messages').get() as { members: number; messages: number };
    const before = counts();

    // ── 1. The node's key document ────────────────────────────────────────────────────────
    console.log('\n1. GET /api/node/key');
    const keyRes = await fetch(`${BASE}/api/node/key`);
    const keyDoc = await keyRes.json();
    const readBack = readNodeKeyDocument(keyDoc);
    assert(keyRes.status === 200 && !!readBack, `1a. unsigned GET /api/node/key is 200 and a document that checks out (got ${keyRes.status})`);
    assert(readBack?.key === B_KEY, '1b. its key is the node key from data/libp2p_key');
    const validFor = (readBack?.validUntil ?? 0) - Date.now();
    assert(validFor > NODE_KEY_VALIDITY_MS - 120_000 && validFor <= NODE_KEY_VALIDITY_MS,
        `1c. valid 7 days from when it was made (${Math.round(validFor / 3_600_000)} h ahead)`);
    assert(Array.isArray(readBack?.previousKeys) && readBack!.previousKeys.length === 0, '1d. no previous key: nothing changes a node key today');
    const cacheControl = keyRes.headers.get('cache-control') ?? '';
    assert(/no-cache/.test(cacheControl) && !/public|s-maxage/.test(cacheControl),
        `1e. no shared cache keeps it, so a changed key is never answered stale (${cacheControl})`);
    const again = await (await fetch(`${BASE}/api/node/key`)).json();
    assert(JSON.stringify(again) === JSON.stringify(keyDoc), '1f. asked again within the hour: the same document, signed once');

    // ── 2. A good request ─────────────────────────────────────────────────────────────────
    console.log('\n2. A good request');
    const good = await serverPost('/api/node/check', { items: [] }, A);
    assert(good.status === 200 && good.body?.origin === 'a.example' && good.body?.key === A.key && Array.isArray(good.body?.items),
        `2a. a.example's signed request is taken, with its origin and key (got ${good.status} ${JSON.stringify(good.body)})`);
    assert(asked.filter(o => o === 'a.example').length === 1, '2b. a.example\'s key document was fetched once');
    const second = await serverPost('/api/node/check', { items: [] }, A);
    assert(second.status === 200 && asked.filter(o => o === 'a.example').length === 1, '2c. the next request uses the document kept: no second fetch');
    const previous = await serverPost('/api/node/check', { items: [] }, A, { signWith: A_BEFORE.seed, keyHex: A_BEFORE.key });
    assert(previous.status === 200 && previous.body?.key === A_BEFORE.key,
        `2d. signed by a.example's previous key, still within its time: taken (got ${previous.status})`);

    // ── 3. Replay ─────────────────────────────────────────────────────────────────────────
    console.log('\n3. Replay');
    const replay = await send('/api/node/check', good.sent, good.text);
    assert(replay.status === 403 && replay.body?.code === 'replay', `3a. the same request again is refused as a replay (got ${replay.status} ${replay.body?.code})`);
    const nonce = crypto.randomBytes(16).toString('hex');
    const forged = await serverPost('/api/node/check', { items: [] }, A, { nonce, signWith: C.seed });
    assert(forged.status === 403 && forged.body?.code === 'bad_signature', `3b. a forgery (a.example's key named, signed by another) is refused (got ${forged.status} ${forged.body?.code})`);
    const afterForgery = await serverPost('/api/node/check', { items: [] }, A, { nonce });
    assert(afterForgery.status === 200, `3c. the forgery burned nothing: a.example's own request with the same nonce is taken (got ${afterForgery.status})`);

    // ── 4. Wrong destination ──────────────────────────────────────────────────────────────
    console.log('\n4. Wrong destination');
    const elsewhere = await serverPost('/api/node/check', { items: [] }, A, { destination: 'c.example' });
    assert(elsewhere.status === 421 && elsewhere.body?.code === 'wrong_destination',
        `4a. a request a.example signed for c.example is refused here (got ${elsewhere.status} ${elsewhere.body?.code})`);
    const loopback = await serverPost('/api/node/check', { items: [] }, A, { destination: 'localhost' });
    assert(loopback.status === 421, `4b. one signed for localhost, on a node with a name, is refused too (got ${loopback.status})`);
    const elsewhereNonce = elsewhere.sent[NODE_REQUEST_HEADER].match(/nonce=([0-9a-f]+)/)![1];
    const sameNonceHere = await serverPost('/api/node/check', { items: [] }, A, { nonce: elsewhereNonce });
    assert(sameNonceHere.status === 200, `4c. the refused request spent no nonce: the same nonce, signed for this server, is taken (got ${sameNonceHere.status})`);

    // ── 5. Expired keys ───────────────────────────────────────────────────────────────────
    console.log('\n5. Expired keys');
    const expired = await serverPost('/api/node/check', { items: [] }, EXPIRED);
    assert(expired.status === 401 && expired.body?.code === 'node_key_expired',
        `5a. a server whose document is past its time is refused (got ${expired.status} ${expired.body?.code})`);
    const retired = await serverPost('/api/node/check', { items: [] }, ROTATED, { signWith: ROTATED_BEFORE.seed, keyHex: ROTATED_BEFORE.key });
    assert(retired.status === 401 && retired.body?.code === 'node_key_expired',
        `5b. a previous key past its own time is refused (got ${retired.status} ${retired.body?.code})`);
    const rotatedNow = await serverPost('/api/node/check', { items: [] }, ROTATED);
    assert(rotatedNow.status === 200, `5c. the same server's current key is taken (got ${rotatedNow.status})`);

    // ── 6. Unknown keys ───────────────────────────────────────────────────────────────────
    console.log('\n6. Unknown keys');
    const stranger = server('a.example');
    const unknownKey = await serverPost('/api/node/check', { items: [] }, stranger);
    assert(unknownKey.status === 401 && unknownKey.body?.code === 'node_key_unknown',
        `6a. a key a.example's document doesn't name is refused (got ${unknownKey.status} ${unknownKey.body?.code})`);
    const askedA = asked.filter(o => o === 'a.example').length;
    await serverPost('/api/node/check', { items: [] }, stranger);
    assert(asked.filter(o => o === 'a.example').length === askedA, '6b. asked about again within the minute: a.example is not fetched again');
    const nowhere = await serverPost('/api/node/check', { items: [] }, server('nowhere.example'));
    assert(nowhere.status === 401 && nowhere.body?.code === 'node_key_unknown', `6c. an origin with no key document is refused (got ${nowhere.status})`);
    __useNodeKeyFetchForTests(null);
    const privateOrigin = await serverPost('/api/node/check', { items: [] }, server('127.0.0.1'));
    const refusedLine = db.prepare(`SELECT message FROM system_logs WHERE message LIKE '%from 127.0.0.1 (%' ORDER BY id DESC LIMIT 1`).get() as { message: string } | undefined;
    assert(privateOrigin.status === 401 && privateOrigin.body?.code === 'node_key_unknown' && /127\.0\.0\.1 is blocked/.test(refusedLine?.message ?? ''),
        `6d. with the real fetch, an origin at a private address is refused: the SSRF guard blocks its document's fetch (got ${privateOrigin.status}; log: ${refusedLine?.message ?? 'none'})`);
    __useNodeKeyFetchForTests(async (origin) => {
        asked.push(origin);
        const doc = docs.get(origin);
        if (!doc) throw new Error('no such server');
        return doc();
    });

    // ── 7. Changed body, other path ───────────────────────────────────────────────────────
    console.log('\n7. Changed body');
    const changed = await serverPost('/api/node/check', { items: [] }, A, { sendBody: JSON.stringify({ items: [], extra: 1 }) });
    assert(changed.status === 403 && changed.body?.code === 'bad_signature', `7a. a body changed after signing is refused (got ${changed.status} ${changed.body?.code})`);
    const spaced = await serverPost('/api/node/check', '{"items":[]}', A, { sendBody: '{"items": []}' });
    assert(spaced.status === 403, `7b. one changed byte, the same JSON: refused (got ${spaced.status})`);
    const otherPath = await serverPost('/api/node/check', { items: [] }, A, { signPath: '/api/node/key' });
    assert(otherPath.status === 403 && otherPath.body?.code === 'bad_signature', `7c. a request signed for another path is refused (got ${otherPath.status})`);

    // ── 8. Clock skew ─────────────────────────────────────────────────────────────────────
    console.log('\n8. Clock skew');
    const late = await serverPost('/api/node/check', { items: [] }, A, { timestamp: Date.now() - 5 * 60_000 - 15_000 });
    assert(late.status === 401 && late.body?.code === 'stale', `8a. signed more than 5 minutes ago: refused (got ${late.status} ${late.body?.code})`);
    const early = await serverPost('/api/node/check', { items: [] }, A, { timestamp: Date.now() + 5 * 60_000 + 15_000 });
    assert(early.status === 401 && early.body?.code === 'stale', `8b. dated more than 5 minutes ahead: refused (got ${early.status})`);
    const inside = await serverPost('/api/node/check', { items: [] }, A, { timestamp: Date.now() - 4 * 60_000 });
    assert(inside.status === 200, `8c. 4 minutes behind, inside the window: taken (got ${inside.status})`);

    // ── 9. The home rule ──────────────────────────────────────────────────────────────────
    console.log('\n9. Envelopes and the home rule');
    const member = () => { const seed = crypto.randomBytes(32); return { seed, key: Buffer.from(ed25519.getPublicKey(seed)).toString('hex') }; };
    const ana = member(), cara = member(), ben = member();
    let n = 0;
    const item = async (who: { seed: Uint8Array; key: string }, senderHome: string, opts: { recipientHome?: string; kind?: RelayItemKind } = {}) => {
        const payload = crypto.randomBytes(48).toString('base64');
        const envelope = await signRelayEnvelope({
            kind: opts.kind ?? 'dm-line', itemId: `item-${String(++n).padStart(4, '0')}-${crypto.randomBytes(4).toString('hex')}`,
            senderKey: who.key, senderHome, recipient: ben.key, recipientHome: opts.recipientHome ?? 'b.example', at: Date.now(),
            payloadHash: relayPayloadHash(payload),
        }, signerOf(who.seed));
        return { envelope, payload };
    };
    const anaLine = await item(ana, 'a.example');
    const caraLine = await item(cara, 'c.example');
    const forOther = await item(ana, 'a.example', { recipientHome: 'z.example' });
    const anaBlob = await item(ana, 'a.example', { kind: 'dm-blob' });
    const rewritten = { envelope: { ...caraLine.envelope, senderHome: 'a.example' }, payload: caraLine.payload };
    const changedPayload = { envelope: anaBlob.envelope, payload: `${anaBlob.payload}A` };
    const checked = await serverPost('/api/node/check', { items: [anaLine, caraLine, forOther, rewritten, changedPayload] }, A);
    const verdicts = (checked.body?.items ?? []) as Array<{ itemId: string | null; ok: boolean; reason?: string }>;
    assert(checked.status === 200 && verdicts.length === 5, `9a. a.example's request with five items is answered item by item (got ${checked.status})`);
    assert(verdicts[0]?.ok === true && verdicts[0]?.itemId === anaLine.envelope.itemId, '9b. Ana\'s line, from her own home a.example: taken');
    assert(verdicts[1]?.ok === false && verdicts[1]?.reason === 'wrong-home',
        `9c. Cara's line names c.example as her home but a.example signed the request: dropped, wrong-home (got ${JSON.stringify(verdicts[1])})`);
    assert(verdicts[2]?.ok === false && verdicts[2]?.reason === 'not-for-here', '9d. a line for z.example: dropped, not for here');
    assert(verdicts[3]?.ok === false && verdicts[3]?.reason === 'bad-signature',
        '9e. Cara\'s line with its home rewritten to a.example: Cara\'s signature breaks, dropped');
    assert(verdicts[4]?.ok === false && verdicts[4]?.reason === 'payload-changed', '9f. a payload changed after Ana signed it: dropped');
    const fromHome = await serverPost('/api/node/check', { items: [caraLine] }, C);
    assert(fromHome.status === 200 && fromHome.body?.items?.[0]?.ok === true, '9g. the same line of Cara\'s, from her own home c.example: taken');
    const tooMany = await serverPost('/api/node/check', { items: Array.from({ length: 17 }, () => anaLine) }, A);
    assert(tooMany.status === 400 && tooMany.body?.code === 'bad_items', `9h. more than 16 items: refused (got ${tooMany.status})`);
    const after = counts();
    assert(after.members === before.members && after.messages === before.messages,
        '9i. nothing is stored: no member row, no message (Ben is no member here, and nothing asked)');

    // ── 10. No node signature ─────────────────────────────────────────────────────────────
    console.log('\n10. No node signature');
    const unsigned = await send('/api/node/check', {}, JSON.stringify({ items: [] }));
    assert(unsigned.status === 401 && unsigned.body?.code === 'node_signature_missing', `10a. unsigned: refused (got ${unsigned.status} ${unsigned.body?.code})`);
    const memberKey = crypto.generateKeyPairSync('ed25519');
    const memberHex = memberKey.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const memberBody = JSON.stringify({ items: [] });
    const byMember = await send('/api/node/check', signedHeaders({ method: 'POST', path: '/api/node/check', body: memberBody, publicKeyHex: memberHex, key: memberKey.privateKey, host: 'b.example' }), memberBody);
    assert(byMember.status === 401 && byMember.body?.code === 'node_signature_missing',
        `10b. a member's signature is no server's: refused (got ${byMember.status} ${byMember.body?.code})`);
    const malformed = await send('/api/node/check', { [NODE_REQUEST_HEADER]: 'v=1, origin=a.example' }, memberBody);
    assert(malformed.status === 400 && malformed.body?.code === 'bad_node_signature', `10c. a header that is not one: 400 (got ${malformed.status})`);
    const slash = await send('/api/node/check/', {}, memberBody);
    assert(slash.status === 401 && slash.body?.code === 'node_signature_missing', `10d. /api/node/check/ is the same door (got ${slash.status})`);

    // ── 11. The node's own signer ─────────────────────────────────────────────────────────
    console.log('\n11. The node\'s own signer');
    const ownBody = JSON.stringify({ items: [] });
    const ownHeaders = await ownNodeRequestHeaders({ method: 'POST', url: 'https://b.example/api/node/check', body: ownBody });
    assert(ownHeaders[NODE_REQUEST_HEADER].includes('origin=b.example') && ownHeaders[NODE_REQUEST_HEADER].includes(`key=${B_KEY}`),
        '11a. it signs as its primary address, with its node key');
    const own = await send('/api/node/check', ownHeaders, ownBody);
    assert(own.status === 200 && own.body?.origin === 'b.example' && own.body?.key === B_KEY,
        `11b. its own door takes it, the key checked against the document its own route publishes (got ${own.status} ${JSON.stringify(own.body)})`);

    // ── 12. Key fetches are bounded ───────────────────────────────────────────────────────
    console.log('\n12. At most 8 key fetches at once');
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    let waiting = 0;
    for (let i = 0; i <= NODE_KEY_FETCHES_AT_ONCE; i++) docs.set(`slow${i}.example`, async () => { waiting++; await gate; return null; });
    const slow = Array.from({ length: NODE_KEY_FETCHES_AT_ONCE }, (_, i) => serverPost('/api/node/check', { items: [] }, server(`slow${i}.example`)));
    for (let t = 0; t < 200 && waiting < NODE_KEY_FETCHES_AT_ONCE; t++) await new Promise(r => setTimeout(r, 25));
    assert(waiting === NODE_KEY_FETCHES_AT_ONCE, `12a. ${NODE_KEY_FETCHES_AT_ONCE} origins' documents are being fetched (${waiting})`);
    const ninth = await serverPost('/api/node/check', { items: [] }, server(`slow${NODE_KEY_FETCHES_AT_ONCE}.example`));
    assert(ninth.status === 503 && ninth.body?.code === 'busy' && !!ninth.headers.get('retry-after'),
        `12b. the ninth origin is answered busy at once, with Retry-After (got ${ninth.status} ${ninth.body?.code})`);
    const meanwhile = await serverPost('/api/node/check', { items: [] }, A);
    assert(meanwhile.status === 200, `12c. a server whose document is kept is still taken meanwhile (got ${meanwhile.status})`);
    release();
    const settled = await Promise.all(slow);
    assert(settled.every(r => r.status === 401 && r.body?.code === 'node_key_unknown'), '12d. the eight that answered nothing are refused, unknown key');

    // ── 13. Two requests from one origin while its document is on its way ─────────────────
    console.log('\n13. A second request waits for the fetch already on its way');
    const LATE = server('late.example');
    let lateRelease: () => void = () => {};
    const lateGate = new Promise<void>(r => { lateRelease = r; });
    let lateAsked = 0;
    docs.set('late.example', async () => { lateAsked++; await lateGate; return docOf(LATE, Date.now() + NODE_KEY_VALIDITY_MS); });
    const firstLate = serverPost('/api/node/check', { items: [] }, LATE);
    for (let t = 0; t < 200 && lateAsked === 0; t++) await new Promise(r => setTimeout(r, 25));
    const secondLate = serverPost('/api/node/check', { items: [] }, LATE);
    await new Promise(r => setTimeout(r, 100));
    lateRelease();
    const [one, two] = await Promise.all([firstLate, secondLate]);
    assert(one.status === 200 && two.status === 200 && lateAsked === 1,
        `13a. both are taken, on one fetch: the second waited for the first's answer (got ${one.status}, ${two.status}; fetched ${lateAsked})`);

    // ── 14. A node that knows none of its names takes no server request ───────────────────
    console.log('\n14. A node that knows none of its names takes no server request');
    const { forgetOwnAddresses, knowsItsNames } = await import('./engine/own-addresses.js');
    process.env.BEANPOOL_ADDRESSES = '';
    forgetOwnAddresses();
    assert(!knowsItsNames(), '14a. with no address set, the node knows none of its names');
    const LOCAL_HOSTS = ['localhost', '127.0.0.1', '192.168.1.10', '10.0.0.5', 'mybox.local'];
    for (const [i, destination] of LOCAL_HOSTS.entries()) {
        const r = await serverPost('/api/node/check', { items: [] }, A, { destination });
        assert(r.status === 421 && r.body?.code === 'wrong_destination' && /knows none of its own names/.test(r.body?.error ?? ''),
            `14${'bcdef'[i]}. signed for ${destination}, on a node that knows none of its names: refused 421, saying so (got ${r.status} ${r.body?.code}: ${r.body?.error})`);
    }
    const forHere = LOCAL_HOSTS.filter(isOwnNodeHome);
    assert(forHere.length === 0, `14g. nor is an item for any of them for here (routes/node-key.ts isHere) (for here: ${forHere.join(', ') || 'none'})`);
    process.env.BEANPOOL_ADDRESSES = 'b.example';
    forgetOwnAddresses();
    const namedAgain = await serverPost('/api/node/check', { items: [] }, A);
    assert(knowsItsNames() && namedAgain.status === 200 && namedAgain.body?.origin === 'a.example' && isOwnNodeHome('b.example'),
        `14h. named again (b.example): a request signed for its own name is taken, and an item for it is for here (got ${namedAgain.status})`);

    // ── 15. Kept documents: the least recently used goes first ────────────────────────────
    console.log('\n15. 512 + 1 origins: the one in use is kept');
    const { originKeyStanding, nodeKeysKept, NODE_KEYS_KEPT } = await import('./engine/node-signature.js');
    const PEER = server('peer.example');
    const FILLER = server('filler.example');
    const peerDoc = await docOf(PEER, Date.now() + NODE_KEY_VALIDITY_MS);
    const fillerDoc = await docOf(FILLER, Date.now() + NODE_KEY_VALIDITY_MS);
    const fetchesOf = new Map<string, number>();
    __useNodeKeyFetchForTests(async (origin) => {
        fetchesOf.set(origin, (fetchesOf.get(origin) ?? 0) + 1);
        return origin === 'peer.example' ? peerDoc : fillerDoc;
    });
    const t0 = Date.now();
    const peerFirst = await originKeyStanding('peer.example', PEER.key, t0);
    for (let i = 1; i < NODE_KEYS_KEPT; i++) await originKeyStanding(`filler${i}.example`, FILLER.key, t0);
    const keptFull = nodeKeysKept();
    const peerInUse = await originKeyStanding('peer.example', PEER.key, t0);
    assert(peerFirst === 'current' && keptFull === NODE_KEYS_KEPT && peerInUse === 'current' && fetchesOf.get('peer.example') === 1,
        `15a. peer.example fetched, then ${NODE_KEYS_KEPT - 1} other origins (${keptFull} kept), then peer.example used again from its kept document (fetched ${fetchesOf.get('peer.example')} time)`);
    await originKeyStanding(`filler${NODE_KEYS_KEPT}.example`, FILLER.key, t0);
    const peerAfter = await originKeyStanding('peer.example', PEER.key, t0);
    assert(peerAfter === 'current' && fetchesOf.get('peer.example') === 1 && nodeKeysKept() === NODE_KEYS_KEPT,
        `15b. one more origin past ${NODE_KEYS_KEPT}: peer.example, used since, is still kept, not fetched again (got ${peerAfter}; fetched ${fetchesOf.get('peer.example')} time(s); ${nodeKeysKept()} kept)`);
    const firstFiller = await originKeyStanding('filler1.example', FILLER.key, t0);
    assert(firstFiller === 'unknown' && fetchesOf.get('filler1.example') === 1,
        `15c. the least recently used, filler1.example, went instead: asked about again within the minute, it is unknown and not fetched (got ${firstFiller}; fetched ${fetchesOf.get('filler1.example')} time(s))`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Another community\'s server is taken only with its own key, for this server, once, on time, with the body it signed.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });

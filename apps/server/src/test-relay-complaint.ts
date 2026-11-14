/**
 * Reports of lines from other communities, and complaints between communities' servers, through the real middleware
 * (messages across communities X5: scratch/fable-design/DESIGN-cross-chat-voice-fable.md §3.5, §11 row X5: "signature
 * checked, reporter never named outward, counts in logs"; DESIGN-forums-messaging-joint-fable.md §2.4, §3.2).
 *
 * Two communities in one process, as test-relay-mail has them: the node under test is b.example, the real server with its
 * real routes, door and database; a.example (and c.example) are played by this suite: their server keys and key documents
 * (handed to the node's door by the test fetch hook, double-locked by BEANPOOL_SSRF_TEST_HOOK=1), their members' keys, and
 * their own /api/relay/complaint, which the node's complaints reach through the relay transport hook. No other server is
 * contacted. Lines are real format-4 lines (core sealOutsideLine) in real relay envelopes.
 *
 *   1  Ben (here) reports a line Ana (a.example) sent him: one report naming Ana, her home and the line; Ana blocked for
 *      Ben; a complaint to a.example in a request b.example signed, carrying the report's kind only, never Ben
 *   2  the moderators: the list shows the line from another community, the complaint taken; they open it, signature checked
 *   3  a report that is not one: a changed envelope, a changed payload, a line to someone else, a line signed inside by
 *      another sender, a line from here, no reason, a key that is no member: refused, nothing filed, nothing sent
 *   4  a.example cannot be reached: the complaint waits and is tried again; a 400 is final
 *   5  a complaint from a.example about Ben's line to Ana: filed, from another community, its reporter a server
 *   6  dropped and answered alike: again, from a community the line never went to, an id never sent, a key that is no member,
 *      the owner's switch off; a field naming a reporter is never kept
 *   7  refusals: not a complaint (400), unsigned or a member's signature (401), past 100 a day from one server (429)
 *   8  closing the class: every outward path (complaint body and headers, the answer, the moderators' list, the stored
 *      complaint, every log line, the owners' notice) x every spelling of the reporter: absent; the logs carry counts
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) BEANPOOL_SSRF_TEST_HOOK=1 pnpm exec tsx src/test-relay-complaint.ts
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
    NODE_KEY_VALIDITY_MS, NODE_REQUEST_HEADER, buildNodeRequestHeaders, nodeRequestSignatureVerifies, parseNodeRequestHeader,
    readNodeKeyDocument, relayConversationId, relayPayloadHash, sealOutsideLine, signNodeKeyDocument, signRelayEnvelope,
    type RelayItem,
} from '@beanpool/core';
import { signedHeaders } from './signed-request-test-helper.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

// Every line the server writes, for the class table (8): stdout and stderr both, as they go.
const logs: string[] = [];
for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    (stream as any).write = (chunk: any, ...rest: any[]) => {
        const text = String(chunk);
        if (!text.startsWith('✓ ') && !text.startsWith('✗ ')) logs.push(text);
        return write(chunk, ...rest);
    };
}

let BASE = '';
interface Answer { status: number; body: any; text: string }
async function send(method: string, p: string, headers: Record<string, string>, body?: string): Promise<Answer> {
    const res = await fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* no body */ }
    return { status: res.status, body: parsed, text };
}

interface Keys { seed: Uint8Array; key: string }
const keys = (): Keys => { const seed = crypto.randomBytes(32); return { seed, key: Buffer.from(ed25519.getPublicKey(seed)).toString('hex') }; };
const signerOf = (seed: Uint8Array) => (b: Uint8Array) => ed25519.sign(b, seed);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

async function main(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR;
    if (!dataDir) throw new Error('BEANPOOL_DATA_DIR must be set to a fresh directory');
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    fs.writeFileSync(path.join(dataDir, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));

    const { initTls } = await import('./services/tls.js');
    const { initStateEngine, seedGenesisMember, getReports } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { __useNodeKeyFetchForTests } = await import('./engine/node-signature.js');
    const { applyShapeChanges } = await import('./config/community-shape-write.js');
    const { hasBlocked } = await import('./engine/member-blocks.js');
    const outbox = await import('./engine/relay-outbox.js');
    const complaints = await import('./engine/relay-complaint.js');

    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    // ── Who is where ──────────────────────────────────────────────────────────────────────
    const olive = keys(), ben = keys(), bea = keys();
    const BEN_NAME = 'Benedikt Quillfeather';
    seedGenesisMember(olive.key, 'Olive');
    const addLocal = (k: Keys, name: string) => {
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'TEST', 'active')`).run(k.key, name, olive.key);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(k.key);
    };
    addLocal(ben, BEN_NAME);
    addLocal(bea, 'Bea');
    const A = keys(), C = keys();
    const ana = keys(), cara = keys();
    const ANA_NAME = 'Anastasia Brightwater';
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

    // a.example's (and c.example's) side of the node's requests: complaints, and the mail Ben sends Ana (5).
    interface Forward { url: string; path: string; signed: boolean; headers: Record<string, string>; body: string }
    const forwards: Forward[] = [];
    let otherAnswers = 202;
    let otherUnreachable = false;
    outbox.__useRelayTransportForTests(async (url, init) => {
        if (otherUnreachable) throw new Error('connect ECONNREFUSED');
        const u = new URL(url);
        const header = parseNodeRequestHeader(init.headers[NODE_REQUEST_HEADER] ?? '');
        const signed = !!header && header.key === bDoc.key && header.origin === 'b.example' && header.destination === u.host
            && nodeRequestSignatureVerifies(header, { method: 'POST', path: u.pathname, body: init.body });
        forwards.push({ url, path: u.pathname, signed, headers: init.headers, body: init.body });
        if (u.pathname === '/api/relay/mail') {
            const items = (JSON.parse(init.body).items ?? []) as RelayItem[];
            return { status: 202, body: { items: items.map((i) => ({ itemId: i.envelope.itemId, received: true })) } };
        }
        return otherAnswers >= 200 && otherAnswers < 300 ? { status: otherAnswers, body: { received: true } } : { status: otherAnswers };
    });
    const complaintsSent = () => forwards.filter((f) => f.path === '/api/relay/complaint');

    // ── Helpers ───────────────────────────────────────────────────────────────────────────
    /** A real line: `from` at `fromHome` writes `to` at `toHome`, sealed (and signed inside) by `sealer`, enveloped by `from`. */
    async function line(from: Keys, fromHome: string, to: Keys, toHome: string, text: string, opts: { sealer?: Keys; name?: string } = {}): Promise<RelayItem> {
        const itemId = crypto.randomUUID();
        const sealer = opts.sealer ?? from;
        const payload = sealOutsideLine({ text, name: opts.name ?? 'Someone', myEdPrivHex: hex(sealer.seed), myKey: sealer.key, peerKey: to.key, messageId: itemId });
        const envelope = await signRelayEnvelope({
            kind: 'dm-line', itemId, senderKey: from.key, senderHome: fromHome, recipient: to.key, recipientHome: toHome, at: Date.now(),
            payloadHash: relayPayloadHash(payload),
        }, signerOf(from.seed));
        return { envelope, payload };
    }
    async function asMember(who: Keys, p: string, body: unknown): Promise<Answer> {
        const text = JSON.stringify(body);
        return send('POST', p, signedHeaders({ method: 'POST', path: p, body: text, publicKeyHex: who.key, key: who.seed, host: 'b.example' }), text);
    }
    /** `as` (a.example by default) brings a complaint to b.example, in a request it signed. */
    async function complain(complaint: unknown, as: { name: string; k: Keys } = { name: 'a.example', k: A }): Promise<Answer> {
        const body = JSON.stringify({ complaint });
        const headers = await buildNodeRequestHeaders({ method: 'POST', url: 'https://b.example/api/relay/complaint', body, origin: as.name, keyHex: as.k.key, sign: signerOf(as.k.seed) });
        return send('POST', '/api/relay/complaint', headers, body);
    }
    const reportsCount = () => (db.prepare('SELECT COUNT(*) AS n FROM abuse_reports').get() as { n: number }).n;
    const listed = (id: string) => getReports('all').reports.find((r) => r.id === id) as any;

    // ── 1. Ben reports a line from Ana ────────────────────────────────────────────────────
    console.log('\n1. Ben (b.example) reports a line Ana (a.example) sent him');
    const spam = await line(ana, 'a.example', ben, 'b.example', 'Buy my miracle seeds now, today only', { name: ANA_NAME });
    const r1 = await asMember(ben, '/api/mail/report', { item: spam, reason: 'Spam or scam: she keeps selling to me', words: 'Buy my miracle seeds now, today only' });
    const reportId = r1.body?.report?.id as string;
    assert(r1.status === 200 && r1.body?.success === true && typeof reportId === 'string', `1a. the report is taken (got ${r1.status} ${r1.text.slice(0, 160)})`);
    const row1 = db.prepare('SELECT * FROM abuse_reports WHERE id = ?').get(reportId) as any;
    assert(row1?.reporter_pubkey === ben.key && row1.target_pubkey === ana.key && row1.target_home === 'a.example' && row1.target_message_id === spam.envelope.itemId,
        '1b. one report: by Ben, about Ana, her home a.example (target_home), the line by its id');
    assert(hasBlocked(ben.key, ana.key), '1c. Ana is blocked for Ben at this server\'s door');
    const sent1 = complaintsSent();
    assert(sent1.length === 1 && sent1[0].url === 'https://a.example/api/relay/complaint' && sent1[0].signed,
        `1d. one complaint went to a.example, in a request b.example's key signed for a.example (got ${sent1.length})`);
    const c1 = JSON.parse(sent1[0]?.body ?? '{}').complaint ?? {};
    assert(JSON.stringify(Object.keys(c1).sort()) === JSON.stringify(['at', 'id', 'itemId', 'member', 'reason', 'v', 'words'])
        && c1.member === ana.key && c1.itemId === spam.envelope.itemId && c1.at === spam.envelope.at && c1.words === 'Buy my miracle seeds now, today only',
        `1e. the complaint is the member there, the line's id and time, and the reporter's word: nothing else (got ${Object.keys(c1).sort().join(', ')})`);
    assert(c1.reason === 'spam or scam' && !sent1[0].body.includes('she keeps selling'),
        '1f. it carries the report\'s kind, never the reporter\'s own words beside the choice');
    const again1 = await asMember(ben, '/api/mail/report', { item: spam, reason: 'Spam or scam', words: 'Buy my miracle seeds now, today only' });
    assert(again1.status === 200 && again1.body?.duplicate === true && again1.body.report?.id === reportId && complaintsSent().length === 1 && reportsCount() === 1,
        '1g. the same line again is the report on file: no second report, no second complaint');

    // ── 2. The moderators ─────────────────────────────────────────────────────────────────
    console.log('\n2. The moderators\' list here');
    const l2 = listed(reportId);
    assert(l2?.targetHome === 'a.example' && l2.complaintTold === 'sent' && l2.directMessage && l2.groupMessage === null && l2.fromAnotherCommunity === null,
        `2a. listed as a line from a.example, its complaint taken, opened as a direct message's (got ${JSON.stringify({ h: l2?.targetHome, t: l2?.complaintTold, d: l2?.directMessage, g: l2?.groupMessage })})`);
    const open2 = complaints.openReportedOutsideLine(reportId);
    assert(open2?.signature === 'verified' && open2.signer === ana.key && open2.from === 'a.example' && open2.words.text === 'Buy my miracle seeds now, today only'
        && open2.told === 'sent', `2b. opened, the sender's signatures checked again from what is stored: verified, Ana's, from a.example (got ${open2?.signature})`);
    db.prepare("UPDATE abuse_reports SET disclosure = json_set(disclosure, '$.payload', ?) WHERE id = ?").run(JSON.stringify({ v: 1, c: 'AAAA', n: 'AAAA' }), reportId);
    assert(complaints.openReportedOutsideLine(reportId)?.signature === 'unverified', '2c. a stored line changed since reads as unverified: no stored flag stands in for the check');
    db.prepare("UPDATE abuse_reports SET disclosure = json_set(disclosure, '$.payload', ?) WHERE id = ?").run(spam.payload, reportId);

    // ── 3. A report that is not one ───────────────────────────────────────────────────────
    console.log('\n3. Reports that are not one are refused, and nothing is filed or sent');
    const before3 = { reports: reportsCount(), sent: complaintsSent().length };
    const base = await line(ana, 'a.example', ben, 'b.example', 'Another line');
    const cases: Array<[string, unknown, number, string]> = [
        ['a changed envelope', { item: { ...base, envelope: { ...base.envelope, at: base.envelope.at + 1 } }, reason: 'Other', words: 'x' }, 400, 'line_not_verified'],
        ['a changed payload', { item: { ...base, payload: base.payload.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A')) }, reason: 'Other', words: 'x' }, 400, 'line_not_verified'],
        ['a line to Bea', { item: await line(ana, 'a.example', bea, 'b.example', 'To Bea'), reason: 'Other', words: 'x' }, 400, 'line_not_verified'],
        ['a line signed inside by Cara', { item: await line(ana, 'a.example', ben, 'b.example', 'Forged', { sealer: cara }), reason: 'Other', words: 'x' }, 400, 'line_not_verified'],
        ['a line from here', { item: await line(bea, 'b.example', ben, 'b.example', 'Local'), reason: 'Other', words: 'x' }, 400, 'line_not_verified'],
        ['no reason', { item: base, reason: '  ', words: 'x' }, 400, 'report_form'],
        ['no item', { reason: 'Other', words: 'x' }, 400, 'report_form'],
    ];
    for (const [what, body, status, code] of cases) {
        const r = await asMember(ben, '/api/mail/report', body);
        assert(r.status === status && r.body?.code === code, `3. ${what}: ${status} ${code} (got ${r.status} ${r.body?.code})`);
    }
    const stranger = keys();
    const r3s = await asMember(stranger, '/api/mail/report', { item: base, reason: 'Other', words: 'x' });
    assert(r3s.status === 403, `3. a key that is no member here: 403 (got ${r3s.status})`);
    assert(reportsCount() === before3.reports && complaintsSent().length === before3.sent, '3z. nothing filed, nothing sent, for any of them');

    // ── 4. a.example cannot be reached ────────────────────────────────────────────────────
    console.log('\n4. The complaint waits when a.example cannot be reached');
    otherUnreachable = true;
    const r4 = await asMember(ben, '/api/mail/report', { item: base, reason: 'Offensive content', words: 'Another line' });
    otherUnreachable = false;
    const id4 = r4.body?.report?.id as string;
    assert(r4.status === 200 && listed(id4)?.complaintTold === 'queued', `4a. the report is filed; its complaint waits (got ${r4.status} ${listed(id4)?.complaintTold})`);
    const sentBefore4 = complaintsSent().length;
    await complaints.retryComplaints(Date.now());
    assert(complaintsSent().length === sentBefore4, '4b. not tried again before its wait is over');
    await complaints.retryComplaints(Date.now() + outbox.RETRY_BACKOFF_MS[0] + 1);
    assert(complaintsSent().length === sentBefore4 + 1 && listed(id4)?.complaintTold === 'sent', `4c. tried again after a minute, and taken (got ${listed(id4)?.complaintTold})`);
    otherAnswers = 400;
    const r4b = await asMember(ben, '/api/mail/report', { item: await line(ana, 'a.example', ben, 'b.example', 'Third'), reason: 'Other', words: 'Third' });
    otherAnswers = 202;
    assert(listed(r4b.body?.report?.id)?.complaintTold === 'failed', '4d. a complaint a.example refuses as not one (400) is not tried again');

    // ── 5. A complaint from a.example about Ben ───────────────────────────────────────────
    console.log('\n5. a.example complains about a line Ben sent Ana');
    const benToAna = await line(ben, 'b.example', ana, 'a.example', 'Rude words for Ana', { name: BEN_NAME });
    const sendR = await asMember(ben, '/api/mail/send', { items: [benToAna] });
    assert(sendR.status === 200 && sendR.body?.items?.[0]?.state === 'sent', `5a. Ben's line went to a.example (got ${sendR.status} ${sendR.text.slice(0, 120)})`);
    const complaint5 = { v: 1, id: crypto.randomUUID(), member: ben.key, itemId: benToAna.envelope.itemId, at: benToAna.envelope.at, reason: 'offensive content', words: 'Rude words for Ana' };
    const before5 = reportsCount();
    const r5 = await complain(complaint5);
    assert(r5.status === 202 && r5.text === '{"received":true}', `5b. answered 202 { received: true } (got ${r5.status} ${r5.text})`);
    const row5 = db.prepare("SELECT * FROM abuse_reports WHERE target_pubkey = ? AND json_extract(disclosure, '$.kind') = 'relay-complaint'").get(ben.key) as any;
    assert(reportsCount() === before5 + 1 && row5?.reporter_pubkey === A.key && row5.target_message_id === benToAna.envelope.itemId && row5.target_home === null
        && JSON.parse(row5.disclosure).from === 'a.example', '5c. filed: about Ben, the line by its id, from a.example, its reporter a.example\'s server key (a server, never a person)');
    const l5 = listed(row5?.id);
    assert(l5?.fromAnotherCommunity?.from === 'a.example' && l5.fromAnotherCommunity.words === 'Rude words for Ana' && l5.reporterCallsign === 'a.example'
        && l5.targetPubkey === ben.key && l5.groupMessage === null && l5.directMessage === null,
        `5d. Settings' list: from another community (a.example), its word for the line, about Ben (got ${JSON.stringify(l5?.fromAnotherCommunity)} / ${l5?.reporterCallsign})`);
    assert(r5.text === '{"received":true}', '5e. the answer says received, nothing of what was filed');

    // ── 6. Dropped, answered alike ────────────────────────────────────────────────────────
    console.log('\n6. Complaints dropped and answered alike');
    const answersAlike: string[] = [];
    const drop = async (what: string, body: unknown, as?: { name: string; k: Keys }) => {
        const n0 = reportsCount();
        const r = await complain(body, as);
        answersAlike.push(`${r.status} ${r.text}`);
        assert(r.status === 202 && r.text === '{"received":true}' && reportsCount() === n0, `6. ${what}: 202 received, nothing filed (got ${r.status} ${r.text})`);
    };
    await drop('the same complaint again', complaint5);
    await drop('the same line, another complaint id', { ...complaint5, id: crypto.randomUUID() });
    await drop('from c.example, where the line never went', { ...complaint5, id: crypto.randomUUID() }, { name: 'c.example', k: C });
    await drop('an id Ben never sent', { ...complaint5, id: crypto.randomUUID(), itemId: crypto.randomUUID() });
    await drop('a key that is no member here', { ...complaint5, id: crypto.randomUUID(), member: stranger.key });
    applyShapeChanges({ actor: olive.key, actorRole: 'owner' }, { changes: { outsideMessages: false } });
    const benToAna2 = await line(ben, 'b.example', ana, 'a.example', 'Second line');
    db.prepare(`INSERT INTO relay_outbox (sender_key, item_id, kind, recipient, recipient_home, state, item, attempts, next_try_at, created_at, updated_at)
                VALUES (?, ?, 'dm-line', ?, 'a.example', 'sent', NULL, 1, NULL, ?, ?)`).run(ben.key, benToAna2.envelope.itemId, ana.key, Date.now(), Date.now());
    await drop('the owner\'s switch off', { ...complaint5, id: crypto.randomUUID(), itemId: benToAna2.envelope.itemId });
    applyShapeChanges({ actor: olive.key, actorRole: 'owner' }, { changes: { outsideMessages: true } });
    assert(new Set(answersAlike).size === 1 && answersAlike[0] === `202 ${r5.text}`, '6z. every drop answered exactly as the one filed');
    const withReporter = await complain({ ...complaint5, id: crypto.randomUUID(), itemId: benToAna2.envelope.itemId, reporter: ana.key, reporterName: ANA_NAME });
    const row6 = db.prepare('SELECT * FROM abuse_reports WHERE target_message_id = ?').get(benToAna2.envelope.itemId) as any;
    assert(withReporter.status === 202 && !!row6 && !JSON.stringify(row6).includes(ana.key) && !JSON.stringify(row6).includes(ANA_NAME),
        '6y. a complaint that carries a field naming its reporter is filed without it: the row keeps only the complaint\'s own fields');

    // ── 7. Refusals ───────────────────────────────────────────────────────────────────────
    console.log('\n7. Refusals');
    for (const [what, body] of [
        ['no complaint', {}], ['an unknown kind', { ...complaint5, reason: 'she was rude' }], ['a member that is no key', { ...complaint5, member: 'ben' }],
        ['words past 8,000 characters', { ...complaint5, words: 'x'.repeat(8_001) }], ['version 2', { ...complaint5, v: 2 }],
    ] as Array<[string, unknown]>) {
        const r = what === 'no complaint'
            ? await (async () => {
                const raw = JSON.stringify({});
                const h = await buildNodeRequestHeaders({ method: 'POST', url: 'https://b.example/api/relay/complaint', body: raw, origin: 'a.example', keyHex: A.key, sign: signerOf(A.seed) });
                return send('POST', '/api/relay/complaint', h, raw);
            })()
            : await complain(body);
        assert(r.status === 400 && r.body?.code === 'bad_complaint', `7a. ${what}: 400 bad_complaint (got ${r.status} ${r.body?.code})`);
    }
    const unsigned = await send('POST', '/api/relay/complaint', {}, JSON.stringify({ complaint: complaint5 }));
    assert(unsigned.status === 401 && unsigned.body?.code === 'node_signature_missing', `7b. unsigned: refused (got ${unsigned.status} ${unsigned.body?.code})`);
    const memberSigned = await asMember(ben, '/api/relay/complaint', { complaint: complaint5 });
    assert(memberSigned.status === 401 && memberSigned.body?.code === 'node_signature_missing', `7c. a member's signature is no server's: refused (got ${memberSigned.status})`);
    const fill = db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_message_id, disclosure, reason, created_at) VALUES (?, ?, ?, ?, ?, 'other', ?)`);
    const already = (db.prepare("SELECT COUNT(*) AS n FROM abuse_reports WHERE json_extract(disclosure, '$.from') = 'a.example'").get() as { n: number }).n;
    for (let i = already; i < complaints.COMPLAINTS_PER_ORIGIN_DAY; i++) {
        fill.run(crypto.randomUUID(), A.key, bea.key, crypto.randomUUID(), JSON.stringify({ kind: 'relay-complaint', v: 1, from: 'a.example', complaintId: crypto.randomUUID(), at: 1, words: '' }), new Date().toISOString());
    }
    const over = await complain({ ...complaint5, id: crypto.randomUUID() });
    assert(over.status === 429 && over.body?.code === 'rate_limited', `7d. past ${complaints.COMPLAINTS_PER_ORIGIN_DAY} a day from one server: 429 (got ${over.status})`);
    const fromC = await complain({ ...complaint5, id: crypto.randomUUID() }, { name: 'c.example', k: C });
    assert(fromC.status === 202, '7e. another server\'s complaints still count on their own');

    // ── 8. Closing the class: the reporter is never named outward ─────────────────────────
    console.log('\n8. Every outward path x every spelling of the reporter');
    const spellings = (k: Keys, name: string, peer: Keys) => ({
        'key (hex)': k.key,
        'key (base64)': Buffer.from(k.key, 'hex').toString('base64'),
        'key (base64url)': Buffer.from(k.key, 'hex').toString('base64url'),
        'name': name,
        'the conversation (made from the key)': relayConversationId(k.key, peer.key),
    });
    const alerts = fs.readdirSync(dataDir).filter((f) => /alert/i.test(f)).map((f) => fs.readFileSync(path.join(dataDir, f), 'utf8')).join('\n');
    const benPaths: Array<[string, string]> = [
        ['the complaints\' bodies', complaintsSent().map((f) => f.body).join('\n')],
        ['the complaints\' headers', complaintsSent().map((f) => JSON.stringify(f.headers)).join('\n')],
        ['every log line', logs.join('')],
        ['the owners\' notice', alerts],
    ];
    const anaPaths: Array<[string, string]> = [
        ['this server\'s answers to complaints', answersAlike.join('\n') + r5.text],
        ['the moderators\' list', JSON.stringify(getReports('all').reports.filter((r: any) => r.fromAnotherCommunity))],
        ['the stored complaints', JSON.stringify(db.prepare("SELECT * FROM abuse_reports WHERE json_extract(disclosure, '$.kind') = 'relay-complaint'").all())],
        ['every log line', logs.join('')],
        ['the owners\' notice', alerts],
    ];
    assert(complaintsSent().length >= 3 && benPaths[0][1].length > 100 && logs.length > 10 && /new report came in/i.test(alerts),
        `8a. there is something to look in (${complaintsSent().length} complaints, ${logs.length} log writes, the owners' notice of a new report: ${/new report came in/i.test(alerts)})`);
    for (const [who, paths, ids] of [
        ['Ben, who reported at b.example', benPaths, spellings(ben, BEN_NAME, ana)],
        ['Ana, whose community complained to b.example', anaPaths, spellings(ana, ANA_NAME, ben)],
    ] as Array<[string, Array<[string, string]>, Record<string, string>]>) {
        for (const [where, text] of paths) {
            const found = Object.entries(ids).filter(([, v]) => text.includes(v)).map(([k]) => k);
            assert(found.length === 0, `8b. ${who}: ${where} holds no ${Object.keys(ids).join(', ')} (found: ${found.join(', ') || 'none'})`);
        }
    }
    const all = logs.join('');
    assert(/Complaints to other communities: 1 taken by a\.example\./.test(all) && /Complaints from other communities: 1 filed from a\.example\./.test(all),
        '8c. the logs carry counts and community names: "1 taken by a.example", "1 filed from a.example"');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ A line from another community can be reported, its sender\'s home is told, and the reporter is named to nobody.');
}

main().then(() => process.exit(0)).catch((e) => { console.error('❌ Test failed:', e); process.exit(1); });

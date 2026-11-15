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
 *   5  a complaint from a.example about Ben's line to Ana: filed, from another community, its reporter a server; the owners'
 *      assistant reads it as an outside_message from another community (never a group chat message), and can't remove it
 *   6  on file already (again, another complaint id): 202, nothing filed again; dropped and answered alike, 422 not_taken,
 *      never as one taken: from a community the line never went to, an id never sent, a key that is no member, a member
 *      gone since, the owner's switch off; a field naming a reporter is never kept; a retry after a lost 202 (round 3 of
 *      #3185): one on file is taken whatever changed since (the switch off, the member re-keyed or pruned, the line gone
 *      from the outbox), while a new complaint under each of those is dropped
 *   7  refusals: not a complaint (400), unsigned or a member's signature (401), past 100 a day from one server (429; one on
 *      file already is still taken)
 *   9  closing the class (round 2 of #3185): a line addressed to the home now, a former name or an alias x a complaint signed
 *      as the home now: matched and filed; to another community's name: dropped alike; to a name whose key document can't
 *      be had: 503, tried again. The reporting side signs as its home now for a line to any of its names; and every answer
 *      the home gave, handed back to it: told `sent` only for one taken (202), never for a drop
 *   8  closing the class: every outward path (complaint body and headers, the answer, the moderators' list, the stored
 *      complaint, every log line, the owners' notice) x every spelling of the reporter: absent; the logs carry counts
 *  10  a standby (round 4 of #3185): the main server tells the home after the standby copied the report (told queued ->
 *      sent): a delta and a whole copy each bring the new disclosure, and the copy check (each table's hash) reads exact
 *  11  closing the class (the last review of #3185): the first send taken, its 202 lost, or refused x nothing, a re-key, a
 *      second re-key, or another member's re-key between (the real issueRekeyCode + completeRekey) x the same complaint
 *      again: on file is 202 in the same bytes and told `sent`, never filed twice; not on file stays 422, told `failed`; the
 *      line named as the other member's is 422; a standby answers the same. Asked backwards (the deciding review of
 *      #3196): one re-key and two re-keys deep, each key's line x each key the member had: on file only under the key that
 *      signed it; under any older or newer key of theirs 422 in the bytes a stranger's key gets, on a standby too
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) BEANPOOL_SSRF_TEST_HOOK=1 pnpm exec tsx src/test-relay-complaint.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.BEANPOOL_SSRF_TEST_HOOK = '1';
process.env.BEANPOOL_ADDRESSES = 'b.example,b-alias.example';
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
import type { AgentGrant } from './agent/tools.js';

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
    const nodeIdentity = await generateKeyPair('Ed25519');
    fs.writeFileSync(path.join(dataDir, 'libp2p_key'), privateKeyToProtobuf(nodeIdentity));

    const { initTls } = await import('./services/tls.js');
    const { initStateEngine, seedGenesisMember, getReports } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { __useNodeKeyFetchForTests } = await import('./engine/node-signature.js');
    const { applyShapeChanges } = await import('./config/community-shape-write.js');
    const { updateNodeConfig } = await import('./state-engine.js');
    const { forgetOwnAddresses } = await import('./engine/own-addresses.js');
    const { hasBlocked, addBlocks, MEMBER_BLOCKS_MAX } = await import('./engine/member-blocks.js');
    const outbox = await import('./engine/relay-outbox.js');
    const complaints = await import('./engine/relay-complaint.js');
    const { AGENT_TOOLS } = await import('./agent/tools.js');

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
    assert(l2?.targetHome === 'a.example' && l2.directMessage && l2.groupMessage === null && l2.fromAnotherCommunity === null,
        `2a. listed as a line from a.example, opened as a direct message's (got ${JSON.stringify({ h: l2?.targetHome, d: l2?.directMessage, g: l2?.groupMessage })})`);
    const open2 = complaints.openReportedOutsideLine(reportId);
    assert(open2?.signature === 'verified' && open2.signer === ana.key && open2.from === 'a.example' && open2.words.text === 'Buy my miracle seeds now, today only'
        && open2.told === 'sent', `2b. opened, the sender's signatures checked again from what is stored: verified, Ana's, from a.example (got ${open2?.signature})`);
    db.prepare("UPDATE abuse_reports SET disclosure = json_set(disclosure, '$.payload', ?) WHERE id = ?").run(JSON.stringify({ v: 1, c: 'AAAA', n: 'AAAA' }), reportId);
    assert(complaints.openReportedOutsideLine(reportId)?.signature === 'unverified', '2c. a stored line changed since reads as unverified: no stored flag stands in for the check');
    db.prepare("UPDATE abuse_reports SET disclosure = json_set(disclosure, '$.payload', ?) WHERE id = ?").run(spam.payload, reportId);
    assert(complaints.openReportedOutsideLine(reportId)?.blocked === true, '2d. Ana is blocked for Ben, and the moderators read that she is');
    const fay = keys();
    addLocal(fay, 'Fay');
    addBlocks(fay.key, Array.from({ length: MEMBER_BLOCKS_MAX }, () => crypto.randomBytes(32).toString('hex')));
    const toFay = await line(ana, 'a.example', fay, 'b.example', 'To Fay');
    const rFay = await asMember(fay, '/api/mail/report', { item: toFay, reason: 'Other', words: 'To Fay' });
    assert(rFay.status === 200 && !hasBlocked(fay.key, ana.key) && complaints.openReportedOutsideLine(rFay.body?.report?.id)?.blocked === false,
        `2e. a member whose block list is full: the report is filed, the block is not, and the moderators never read that it is (got ${rFay.status})`);

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
    const toldOf = (id: string) => complaints.openReportedOutsideLine(id)?.told;
    assert(r4.status === 200 && toldOf(id4) === 'queued', `4a. the report is filed; its complaint waits (got ${r4.status} ${toldOf(id4)})`);
    const sentBefore4 = complaintsSent().length;
    await complaints.retryComplaints(Date.now());
    assert(complaintsSent().length === sentBefore4, '4b. not tried again before its wait is over');
    await complaints.retryComplaints(Date.now() + outbox.RETRY_BACKOFF_MS[0] + 1);
    assert(complaintsSent().length === sentBefore4 + 1 && toldOf(id4) === 'sent', `4c. tried again after a minute, and taken (got ${toldOf(id4)})`);
    otherAnswers = 400;
    const r4b = await asMember(ben, '/api/mail/report', { item: await line(ana, 'a.example', ben, 'b.example', 'Third'), reason: 'Other', words: 'Third' });
    otherAnswers = 202;
    assert(toldOf(r4b.body?.report?.id) === 'failed', '4d. a complaint a.example refuses as not one (400) is not tried again');

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
    assert(reportsCount() === before5 + 1 && row5?.reporter_pubkey === 'community:a.example' && row5.target_message_id === benToAna.envelope.itemId && row5.target_home === null
        && JSON.parse(row5.disclosure).from === 'a.example', '5c. filed: about Ben, the line by its id, its reporter the community a.example (community:a.example, never a person)');
    const l5 = listed(row5?.id);
    assert(l5?.fromAnotherCommunity?.from === 'a.example' && l5.reporterCallsign === 'a.example' && l5.targetPubkey === ben.key && l5.groupMessage === null
        && l5.directMessage === null, `5d. Settings' list: from another community (a.example), about Ben (got ${JSON.stringify(l5?.fromAnotherCommunity)} / ${l5?.reporterCallsign})`);
    const open5 = complaints.openReportedComplaint(row5?.id);
    assert(open5?.kind === 'complaint' && open5.from === 'a.example' && open5.words.text === 'Rude words for Ana' && open5.authorPubkey === ben.key
        && open5.id === benToAna.envelope.itemId, `5f. the moderators open it: from a.example, its reporter's word, about Ben's line (got ${JSON.stringify(open5)?.slice(0, 120)})`);
    assert(r5.text === '{"received":true}', '5e. the answer says received, nothing of what was filed');
    // The owners' assistant (agent/tools.ts) reads it as what it is: a complaint from another community about a line a member
    // here sent there. Never a group chat message, never which community or its words; and there is no post to remove.
    const grant: AgentGrant = { id: 'test-grant', name: 'Test', member: olive.key, role: 'owner', via: 'token', createdAt: Date.now(), expiresAt: null, canPost: false };
    const tool = (name: string) => AGENT_TOOLS.find((t) => t.name === name)!;
    const got5 = await tool('report_get').run(grant, { report_id: row5?.id ?? '' }, 'B0UNDARY') as any;
    const list5 = await tool('reports_list').run(grant, { include_text: true }, 'B0UNDARY') as any;
    const listed5 = (list5.result?.reports ?? []).find((r: any) => r.id === row5?.id);
    assert(got5.ok && got5.result?.report?.targetKind === 'outside_message' && got5.result.report.fromAnotherCommunity === true
        && listed5?.targetKind === 'outside_message' && listed5.fromAnotherCommunity === true,
        `5g. the assistant's report_get and reports_list call it an outside_message report, from another community (got ${got5.result?.report?.targetKind}/${got5.result?.report?.fromAnotherCommunity} and ${listed5?.targetKind}/${listed5?.fromAnotherCommunity})`);
    const ofLine = await tool('report_get').run(grant, { report_id: reportId }, 'B0UNDARY') as any;
    assert(ofLine.result?.report?.targetKind === 'direct_message' && ofLine.result.report.fromAnotherCommunity === false,
        `5h. Ben's own report of Ana's line is still a direct_message report, not one from another community (got ${ofLine.result?.report?.targetKind}/${ofLine.result?.report?.fromAnotherCommunity})`);
    const fenced5 = String(got5.result?.report?.authorCallsign?.text ?? '');
    const seen5 = JSON.stringify([got5, listed5]);
    const named5 = fenced5.includes(BEN_NAME), community5 = seen5.includes('a.example'), words5 = seen5.includes('Rude words for Ana');
    assert(named5 && !community5 && !words5,
        `5i. it names the member here who sent the line (fenced), as a message's report does, and never the community or the line's words (named ${named5}, community ${community5}, words ${words5})`);
    const remove5 = await tool('suggest_action').run(grant, { kind: 'remove_reported', report_id: row5?.id ?? '', reason: 'Take it down' }, 'B0UNDARY') as any;
    assert(!remove5.ok && /another community/.test(remove5.error ?? '') && !/group chat/.test(remove5.error ?? ''),
        `5j. nor may it suggest removing it, in words that say what it is: a complaint from another community (got ${JSON.stringify(remove5)})`);

    // ── 6. On file, or dropped and answered alike ─────────────────────────────────────────
    console.log('\n6. A complaint on file already is taken; every drop is answered alike, and never as one taken');
    const answersAlike: string[] = [];
    /** The home's real answers, by what they were (section 9 hands each to the reporting side). */
    const realAnswers: Array<{ what: string; status: number; text: string }> = [{ what: 'filed', status: r5.status, text: r5.text }];
    const onFile = async (what: string, body: unknown) => {
        const n0 = reportsCount();
        const r = await complain(body);
        realAnswers.push({ what, status: r.status, text: r.text });
        assert(r.status === 202 && r.text === '{"received":true}' && reportsCount() === n0, `6. ${what}: on file already, 202 received, nothing filed again (got ${r.status} ${r.text})`);
    };
    await onFile('the same complaint again', complaint5);
    await onFile('the same line, another complaint id', { ...complaint5, id: crypto.randomUUID() });
    const drop = async (what: string, body: unknown, as?: { name: string; k: Keys }) => {
        const n0 = reportsCount();
        const r = await complain(body, as);
        answersAlike.push(`${r.status} ${r.text}`);
        realAnswers.push({ what, status: r.status, text: r.text });
        assert(r.status === 422 && r.body?.code === 'not_taken' && reportsCount() === n0, `6. ${what}: 422 not_taken, nothing filed (got ${r.status} ${r.text})`);
    };
    await drop('from c.example, where the line never went', { ...complaint5, id: crypto.randomUUID() }, { name: 'c.example', k: C });
    await drop('an id Ben never sent', { ...complaint5, id: crypto.randomUUID(), itemId: crypto.randomUUID() });
    await drop('a key that is no member here', { ...complaint5, id: crypto.randomUUID(), member: stranger.key });
    // A member who sent the line and is gone since: nothing here can act on them.
    const bo = keys();
    addLocal(bo, 'Bo');
    const boToAna = await line(bo, 'b.example', ana, 'a.example', 'Bye');
    const boSent = await asMember(bo, '/api/mail/send', { items: [boToAna] });
    db.prepare('DELETE FROM members WHERE public_key = ?').run(bo.key);
    await drop('a member who sent the line and is gone since', { ...complaint5, id: crypto.randomUUID(), member: bo.key, itemId: boToAna.envelope.itemId });
    assert(boSent.body?.items?.[0]?.state === 'sent', `6. (Bo's line did go to a.example before: ${boSent.status} ${boSent.body?.items?.[0]?.state})`);
    applyShapeChanges({ actor: olive.key, actorRole: 'owner' }, { changes: { outsideMessages: false } });
    const benToAna2 = await line(ben, 'b.example', ana, 'a.example', 'Second line');
    db.prepare(`INSERT INTO relay_outbox (sender_key, item_id, kind, recipient, recipient_home, state, item, attempts, next_try_at, created_at, updated_at)
                VALUES (?, ?, 'dm-line', ?, 'a.example', 'sent', NULL, 1, NULL, ?, ?)`).run(ben.key, benToAna2.envelope.itemId, ana.key, Date.now(), Date.now());
    await drop('the owner\'s switch off', { ...complaint5, id: crypto.randomUUID(), itemId: benToAna2.envelope.itemId });
    applyShapeChanges({ actor: olive.key, actorRole: 'owner' }, { changes: { outsideMessages: true } });
    assert(new Set(answersAlike).size === 1 && !answersAlike[0].startsWith('202') && !answersAlike[0].includes('received'),
        `6z. every drop answered exactly alike, whatever the reason, and never as one taken (got ${[...new Set(answersAlike)].join(' | ')})`);
    const withReporter = await complain({ ...complaint5, id: crypto.randomUUID(), itemId: benToAna2.envelope.itemId, reporter: ana.key, reporterName: ANA_NAME });
    const row6 = db.prepare('SELECT * FROM abuse_reports WHERE target_message_id = ?').get(benToAna2.envelope.itemId) as any;
    assert(withReporter.status === 202 && !!row6 && !JSON.stringify(row6).includes(ana.key) && !JSON.stringify(row6).includes(ANA_NAME),
        '6y. a complaint that carries a field naming its reporter is filed without it: the row keeps only the complaint\'s own fields');
    // A retry after a lost 202 (round 3 of #3185): b.example filed a.example's complaint about Cy's line, but its answer was
    // lost, so a.example tries again. Whatever changed here meanwhile, the complaint is on file: 202, never 422 (which
    // a.example would record as `failed`; section 9c hands each of these answers back to the reporting side: told `sent`).
    const cy = keys();
    addLocal(cy, 'Cy');
    const cyToAna = await line(cy, 'b.example', ana, 'a.example', 'Cheap watches');
    const cyToAna2 = await line(cy, 'b.example', ana, 'a.example', 'Cheaper watches');
    const cySent = await asMember(cy, '/api/mail/send', { items: [cyToAna, cyToAna2] });
    const complaintCy = { v: 1, id: crypto.randomUUID(), member: cy.key, itemId: cyToAna.envelope.itemId, at: cyToAna.envelope.at, reason: 'spam or scam', words: 'Cheap watches' };
    const nCy = reportsCount();
    const firstCy = await complain(complaintCy);
    assert(cySent.body?.items?.length === 2 && cySent.body.items.every((i: any) => i.state === 'sent') && firstCy.status === 202 && reportsCount() === nCy + 1,
        `6x. a.example's complaint about Cy's line is filed (got ${cySent.status} ${firstCy.status} ${reportsCount() - nCy})`);
    const aboutCy2 = () => ({ ...complaintCy, id: crypto.randomUUID(), itemId: cyToAna2.envelope.itemId, at: cyToAna2.envelope.at });
    applyShapeChanges({ actor: olive.key, actorRole: 'owner' }, { changes: { outsideMessages: false } });
    await onFile('the same complaint again, the owner\'s switch off since', complaintCy);
    applyShapeChanges({ actor: olive.key, actorRole: 'owner' }, { changes: { outsideMessages: true } });
    // Cy re-keys: the old key is invalidated, its row 'suspended' until the new phone binds a new one (engine members.ts).
    db.prepare("INSERT INTO invalidated_keys (public_key, reason) VALUES (?, 'rekey')").run(cy.key);
    db.prepare("UPDATE members SET status = 'suspended' WHERE public_key = ?").run(cy.key);
    await drop('a new complaint about a line of a key re-keyed since', aboutCy2());
    await onFile('the same complaint again, Cy re-keyed since', complaintCy);
    db.prepare('DELETE FROM invalidated_keys WHERE public_key = ?').run(cy.key);
    // The owners prune Cy over the complaint.
    db.prepare("UPDATE members SET status = 'pruned' WHERE public_key = ?").run(cy.key);
    await drop('a new complaint about a line of a member pruned since', aboutCy2());
    await onFile('the same complaint again, Cy pruned since', complaintCy);
    await onFile('the same line, another complaint id, Cy pruned since', { ...complaintCy, id: crypto.randomUUID() });
    // Cy's outbox row is gone (past its 30 days).
    db.prepare('DELETE FROM relay_outbox WHERE sender_key = ? AND item_id = ?').run(cy.key, cyToAna.envelope.itemId);
    await onFile('the same complaint again, its line gone from the outbox since', complaintCy);
    // On file is this member's line by that id from that community, nothing wider: another key naming the same id is dropped.
    await drop('another key naming a line on file', { ...complaintCy, id: crypto.randomUUID(), member: bea.key });

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
        if (what === 'an unknown kind') realAnswers.push({ what: 'not a complaint', status: r.status, text: r.text });
    }
    const unsigned = await send('POST', '/api/relay/complaint', {}, JSON.stringify({ complaint: complaint5 }));
    assert(unsigned.status === 401 && unsigned.body?.code === 'node_signature_missing', `7b. unsigned: refused (got ${unsigned.status} ${unsigned.body?.code})`);
    const memberSigned = await asMember(ben, '/api/relay/complaint', { complaint: complaint5 });
    assert(memberSigned.status === 401 && memberSigned.body?.code === 'node_signature_missing', `7c. a member's signature is no server's: refused (got ${memberSigned.status})`);
    const fill = db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_message_id, disclosure, reason, created_at) VALUES (?, ?, ?, ?, ?, 'other', ?)`);
    const already = (db.prepare("SELECT COUNT(*) AS n FROM abuse_reports WHERE reporter_pubkey = 'community:a.example'").get() as { n: number }).n;
    for (let i = already; i < complaints.COMPLAINTS_PER_ORIGIN_DAY; i++) {
        fill.run(crypto.randomUUID(), 'community:a.example', bea.key, crypto.randomUUID(), JSON.stringify({ kind: 'relay-complaint', v: 1, from: 'a.example', complaintId: crypto.randomUUID(), at: 1, words: '' }), new Date().toISOString());
    }
    const benToAna3 = await line(ben, 'b.example', ana, 'a.example', 'A third line to Ana');
    await asMember(ben, '/api/mail/send', { items: [benToAna3] });
    const nOver = reportsCount();
    const over = await complain({ ...complaint5, id: crypto.randomUUID(), itemId: benToAna3.envelope.itemId, at: benToAna3.envelope.at });
    realAnswers.push({ what: 'past the day\'s cap', status: over.status, text: over.text });
    assert(over.status === 429 && over.body?.code === 'rate_limited' && reportsCount() === nOver,
        `7d. past ${complaints.COMPLAINTS_PER_ORIGIN_DAY} a day from one server: 429, nothing filed (got ${over.status})`);
    await onFile('the same complaint again, past the day\'s cap', complaint5);
    const benToCara = await line(ben, 'b.example', cara, 'c.example', 'A line to Cara');
    await asMember(ben, '/api/mail/send', { items: [benToCara] });
    const fromC = await complain({ v: 1, id: crypto.randomUUID(), member: ben.key, itemId: benToCara.envelope.itemId, at: benToCara.envelope.at, reason: 'other', words: 'A line to Cara' },
        { name: 'c.example', k: C });
    assert(fromC.status === 202 && !!db.prepare("SELECT 1 FROM abuse_reports WHERE reporter_pubkey = 'community:c.example' AND target_message_id = ?").get(benToCara.envelope.itemId),
        `7e. another server's complaints still count on their own: c.example's about Ben's line to Cara is filed (got ${fromC.status} ${fromC.text})`);

    // ── 9. Closing the class: every name a line went to; every answer the home gives ──────
    console.log('\n9. A line to any of a server\'s names is matched; a complaint the home did not take is never told as taken');
    // a.example's day is full from 7d: those made-up rows go, so its complaints are read again.
    db.prepare("DELETE FROM abuse_reports WHERE reporter_pubkey = 'community:a.example' AND target_pubkey = ?").run(bea.key);
    // a.example's names: its home now, the name it had before a rename, and an alias, each serving its one key document.
    const aDoc = docs.get('https://a.example/api/node/key');
    for (const n of ['a-old.example', 'a-alias.example']) docs.set(`https://${n}/api/node/key`, aDoc);
    // 9a. At the home (here): Ben's line to Ana, addressed to each name; a.example complains, signed as its home now.
    const nameRows: Array<[string, string, number, boolean]> = [
        ['a.example\'s home now', 'a.example', 202, true],
        ['the name a.example had before its rename (a-old.example)', 'a-old.example', 202, true],
        ['an alias of a.example (a-alias.example)', 'a-alias.example', 202, true],
        ['another community\'s name (c.example, whose key document names another key)', 'c.example', 422, false],
        ['a name whose key document can\'t be had now (a-gone.example)', 'a-gone.example', 503, false],
    ];
    for (const [what, home, status, filed] of nameRows) {
        const l = await line(ben, 'b.example', ana, home, `To Ana at ${home}`);
        const s = await asMember(ben, '/api/mail/send', { items: [l] });
        const r = await complain({ v: 1, id: crypto.randomUUID(), member: ben.key, itemId: l.envelope.itemId, at: l.envelope.at, reason: 'spam or scam', words: `To Ana at ${home}` });
        const row = db.prepare('SELECT reporter_pubkey FROM abuse_reports WHERE target_message_id = ?').get(l.envelope.itemId) as { reporter_pubkey: string } | undefined;
        if (status === 422) answersAlike.push(`${r.status} ${r.text}`);
        if (!filed) realAnswers.push({ what: `a line to ${what}`, status: r.status, text: r.text });
        assert(s.body?.items?.[0]?.state === 'sent' && r.status === status && !!row === filed && (!filed || row?.reporter_pubkey === 'community:a.example'),
            `9a. a line to ${what}, the complaint signed as a.example: ${status}, ${filed ? 'filed, from a.example' : 'nothing filed'} (got ${r.status} ${r.text.slice(0, 100)})`);
    }
    assert(new Set(answersAlike).size === 1, '9a. a line that went to another server\'s name is dropped as every other drop is: the same answer');
    // 9b. At the reporting side (here): Ben reports a line Ana addressed to each of this server's names. One complaint goes
    // to a.example, signed as this server's home now (b.example), about that line: 9a shows a.example matches it by name.
    updateNodeConfig({ ownerAddresses: ['b-old.example'] } as any);   // as keepReplacedAddress keeps a name a rename replaced
    forgetOwnAddresses();
    for (const [what, home] of [['b.example, its home now', 'b.example'], ['b-old.example, the name it had before', 'b-old.example'], ['b-alias.example, an alias', 'b-alias.example']]) {
        const sentBefore = complaintsSent().length;
        const l = await line(ana, 'a.example', ben, home, `Spam to Ben at ${home}`);
        const r = await asMember(ben, '/api/mail/report', { item: l, reason: 'Spam or scam', words: `Spam to Ben at ${home}` });
        const went = complaintsSent().slice(sentBefore);
        const c = JSON.parse(went[0]?.body ?? '{}').complaint ?? {};
        assert(r.status === 200 && went.length === 1 && went[0].signed && went[0].url === 'https://a.example/api/relay/complaint' && c.itemId === l.envelope.itemId,
            `9b. Ben reports a line Ana addressed to ${what}: one complaint to a.example, signed as b.example, about that line (got ${r.status} ${went.length} ${r.text.slice(0, 80)})`);
    }
    // 9c. Every answer the home gave above, handed to the reporting side as its answer: told `sent` only for one taken.
    const replay = [...realAnswers, { what: 'a 200 from something that is no BeanPool home', status: 200, text: '{"received":true}' }, { what: 'cannot be reached', status: 0, text: '' }];
    const drops = realAnswers.filter((a) => a.status === 422).length;
    assert(drops >= 6 && replay.some((a) => a.status === 503) && replay.some((a) => a.status === 429) && replay.some((a) => a.status === 400),
        `9c. there is every kind of answer to hand over (${drops} drops, a 503, a 429, a 400)`);
    const toldWant = (status: number) => (status === 202 ? 'sent' : status === 400 || status === 413 || status === 422 ? 'failed' : 'queued');
    for (const [i, a] of replay.entries()) {
        const reporter = keys();
        addLocal(reporter, `Reporter ${i}`);
        otherAnswers = a.status;
        otherUnreachable = a.status === 0;
        const l = await line(ana, 'a.example', reporter, 'b.example', `Answered ${a.status}: ${a.what}`);
        const r = await asMember(reporter, '/api/mail/report', { item: l, reason: 'Other', words: 'x' });
        otherUnreachable = false;
        const told = toldOf(r.body?.report?.id);
        const taken = a.what === 'filed' || a.what.startsWith('the same');
        assert(r.status === 200 && told === toldWant(a.status) && (told === 'sent') === taken,
            `9c. the home answers ${a.status} (${a.what}): told ${toldWant(a.status)}${taken ? '' : ', never sent'} (got ${told})`);
    }
    otherAnswers = 202;

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
        ['the moderators\' list, and each complaint opened', JSON.stringify(getReports('all').reports.filter((r: any) => r.fromAnotherCommunity)
            .map((r: any) => ({ listed: r, opened: complaints.openReportedComplaint(r.id) })))],
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

    // ── 10. A complaint's state on a standby ──────────────────────────────────────────────
    // Last, after 8's look at every log line: the copies are imported into this same database, as test-group-chat-report's
    // section 8 does it (the main server's change made here, then the standby's earlier copy of the row put back).
    console.log('\n10. A complaint\'s told state reaches a standby that already holds the report, and the copy check reads exact');
    const { exportSyncState, importRemoteState } = await import('./state-engine.js');
    const { setNodeRole } = await import('./config/node-role.js');
    const { setPrivateKeyForTests } = await import('./p2p.js');
    const { tableContentHashes, compareTableHashes, TABLE_HASHES_VERSION } = await import('./engine/replica-hashes.js');
    const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
    const { pinMainServerForTests } = await import('./standby-pin-test-helper.js');
    setPrivateKeyForTests(nodeIdentity);
    const nodeId = peerIdFromPrivateKey(nodeIdentity).toString();
    pinMainServerForTests(nodeId);
    // Dot reports a line from Ana while a.example can't be reached: told `queued`, and the standby's next delta copies the row.
    const dot = keys();
    addLocal(dot, 'Dot');
    otherUnreachable = true;
    const r10 = await asMember(dot, '/api/mail/report', { item: await line(ana, 'a.example', dot, 'b.example', 'Seeds again'), reason: 'Spam or scam', words: 'Seeds again' });
    otherUnreachable = false;
    const id10 = r10.body?.report?.id as string;
    const rowOf10 = () => db.prepare('SELECT disclosure, updated_at FROM abuse_reports WHERE id = ?').get(id10) as { disclosure: string; updated_at: string };
    const standbys10 = rowOf10();
    assert(r10.status === 200 && toldOf(id10) === 'queued', `10a. the report is filed, its complaint waiting (got ${r10.status} ${toldOf(id10)})`);
    // Then the main server tells a.example: told `sent` (setTold rewrites the disclosure and moves updated_at).
    await new Promise((r) => setTimeout(r, 5));
    const since10 = new Date(Date.now() - 1000).toISOString();
    await complaints.retryComplaints(Date.now() + outbox.RETRY_BACKOFF_MS[0] + 1);
    const mains10 = rowOf10();
    assert(toldOf(id10) === 'sent' && mains10.disclosure !== standbys10.disclosure && mains10.updated_at > standbys10.updated_at,
        `10b. on the main server it is told sent: the disclosure and updated_at changed (got ${toldOf(id10)})`);
    const mainHashes = tableContentHashes();
    const delta10: any = await exportSyncState(nodeId, since10);
    const whole10: any = await exportSyncState(nodeId);
    const carried10 = (delta10.abuseReports ?? []).find((r: any) => r.id === id10);
    assert(carried10?.disclosure === mains10.disclosure && mainHashes.v === TABLE_HASHES_VERSION && !!mainHashes.tables.abuse_reports?.d,
        `10c. the delta carries the new disclosure, and the main server's hashes are this release's (v ${mainHashes.v}, abuse_reports d ${mainHashes.tables.abuse_reports?.d?.slice(0, 12)})`);
    const putStandbysBack = () => db.prepare('UPDATE abuse_reports SET disclosure = ?, updated_at = ? WHERE id = ?').run(standbys10.disclosure, standbys10.updated_at, id10);
    for (const [what, payload, full] of [['a delta', delta10, false], ['a whole copy', whole10, true]] as Array<[string, any, boolean]>) {
        putStandbysBack();
        const before = compareTableHashes(mainHashes, tableContentHashes());
        assert(before.differing.some((d) => d.table === 'abuse_reports'),
            `10d. (${what}: with the standby's earlier copy of the row, the check finds abuse_reports differing: it can fail)`);
        setNodeRole('backup');
        try {
            await importRemoteState(payload, { full });
        } finally {
            setNodeRole('primary');
        }
        const after = compareTableHashes(mainHashes, tableContentHashes());
        assert(rowOf10().disclosure === mains10.disclosure && toldOf(id10) === 'sent' && after.compared.includes('abuse_reports') && after.exact,
            `10e. ${what}: the standby takes the new disclosure, and the copy check reads exact, abuse_reports compared (differing: ${after.differing.map((d) => d.table).join(', ') || 'none'}; drift: ${after.drift.join(', ') || 'none'})`);
    }
    // 10f. Closing the class: every column the copy check hashes (the manifest's abuse_reports columns), changed on the main
    // server after the standby copied the row, reaches it with the next delta, and the check reads exact. A column added
    // later that the import doesn't take goes red here.
    const { TABLES } = await import('./engine/replication-manifest.js');
    const entry = TABLES.abuse_reports;
    const hashed = entry.kind === 'replicated' || entry.kind === 'replicated-except' ? entry.columns : [];
    const changed: Record<string, string> = { reporter_pubkey: bea.key, target_pubkey: bea.key, status: 'reviewed', created_at: '2026-01-02T03:04:05.678Z' };
    const notTaken: string[] = [], unseen: string[] = [];
    for (const column of hashed.filter((c) => c !== 'id' && c !== 'updated_at')) {
        const standbys = db.prepare('SELECT * FROM abuse_reports WHERE id = ?').get(id10) as Record<string, unknown>;
        const stamp = new Date(Date.parse(String(standbys.updated_at)) + 1000).toISOString();
        db.prepare(`UPDATE abuse_reports SET ${column} = ?, updated_at = ? WHERE id = ?`).run(changed[column] ?? `changed ${column}`, stamp, id10);
        const mains = tableContentHashes({ only: ['abuse_reports'] });
        const delta: any = await exportSyncState(nodeId, String(standbys.updated_at));
        db.prepare(`UPDATE abuse_reports SET ${column} = ?, updated_at = ? WHERE id = ?`).run(standbys[column] ?? null, standbys.updated_at, id10);
        // The standby's earlier copy differs before the import, or the row's check below could pass without the import.
        if (compareTableHashes(mains, tableContentHashes({ only: ['abuse_reports'] }), ['abuse_reports']).exact) unseen.push(column);
        setNodeRole('backup');
        try {
            await importRemoteState(delta);
        } finally {
            setNodeRole('primary');
        }
        if (!compareTableHashes(mains, tableContentHashes({ only: ['abuse_reports'] }), ['abuse_reports']).exact) notTaken.push(column);
    }
    assert(hashed.length >= 15 && unseen.length === 0 && notTaken.length === 0,
        `10f. each of the ${hashed.length} hashed columns, changed on the main server later, differs on the standby until the next delta, which brings it: exact (not seen differing: ${unseen.join(', ') || 'none'}; not taken: ${notTaken.join(', ') || 'none'})`);

    // ── 11. Closing the class: a retry across a re-key ────────────────────────────────────
    // The last review of #3185: a.example's complaint is filed here, its 202 lost, the member redeems a re-key code (the
    // real issueRekeyCode + completeRekey, which move this server's row to the new key), and a.example's retry names the
    // key the line was signed with, the one it keeps. Each cell: how the first send went x what happened here between x
    // the same complaint again. On file is answered 202, the same bytes whatever happened between (a repeat tells a.example
    // nothing new, not whether the person re-keyed), and is told `sent` at a.example; one not on file stays 422 `not_taken`,
    // told `failed`. Never a second row; never on file for another member's key; and a standby, reading the same rows,
    // answers the same.
    console.log('\n11. A complaint on file is matched across the member\'s re-keys, never as another member\'s, and a standby answers the same');
    const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
    /** The real re-key, by the owner: `from` is replaced by a new key, returned (with its seed, to sign as it). */
    const rekeyTo = (from: string): Keys => {
        const to = keys();
        completeRekey(from, to.key, issueRekeyCode(from, olive.key).code, olive.key);
        return to;
    };
    const rekey = (from: string): string => rekeyTo(from).key;
    const firsts = ['taken', 'lost 202', 'refused'] as const;
    const betweens = ['nothing', 'a re-key', 'a second re-key', 'another member\'s re-key'] as const;
    const onFileAnswers = new Set<string>(), notTakenAnswers = new Set<string>();
    const sendersKeys: string[] = [], sendersWords: string[] = [];
    let cell = 0;
    for (const first of firsts) {
        for (const between of betweens) {
            cell++;
            const what = `11. ${first}, then ${between}, then the same complaint again`;
            const sender = keys(), other = keys();
            addLocal(sender, `Sender ${cell}`);
            addLocal(other, `Other ${cell}`);
            // Refused: the line went to Cara at c.example, so a.example's complaint about it is not one this server takes.
            const to = first === 'refused' ? { k: cara, home: 'c.example' } : { k: ana, home: 'a.example' };
            const l = await line(sender, 'b.example', to.k, to.home, `Line ${cell}`);
            const sentL = await asMember(sender, '/api/mail/send', { items: [l] });
            const complaint = { v: 1, id: crypto.randomUUID(), member: sender.key, itemId: l.envelope.itemId, at: l.envelope.at, reason: 'spam or scam', words: `Words of cell ${cell}` };
            sendersWords.push(complaint.words);
            const rowsFiled = () => db.prepare("SELECT target_pubkey FROM abuse_reports WHERE reporter_pubkey = 'community:a.example' AND target_message_id = ?")
                .all(l.envelope.itemId) as { target_pubkey: string }[];
            const firstR = await complain(complaint);
            // What a.example made of its first send: taken (it read the 202), lost (no answer: still queued), or refused.
            const toldFirst = first === 'lost 202' ? complaints.toldAfter(0, 60_000) : complaints.toldAfter(firstR.status, 60_000);
            const wantFirst = first === 'refused' ? { status: 422, told: 'failed', rows: 0 } : { status: 202, told: first === 'taken' ? 'sent' : 'queued', rows: 1 };
            assert(sentL.body?.items?.[0]?.state === 'sent' && firstR.status === wantFirst.status && toldFirst === wantFirst.told && rowsFiled().length === wantFirst.rows,
                `${what}: (the first send: ${wantFirst.status}, ${wantFirst.rows} filed, told ${wantFirst.told} at a.example; got ${firstR.status}, ${rowsFiled().length}, ${toldFirst})`);

            let senderNow = sender.key, otherNow = other.key;
            if (between === 'a re-key') senderNow = rekey(sender.key);
            if (between === 'a second re-key') senderNow = rekey(rekey(sender.key));
            if (between === 'another member\'s re-key') otherNow = rekey(other.key);
            sendersKeys.push(sender.key, senderNow);
            const moved = rowsFiled().every((r) => r.target_pubkey === senderNow);
            const retry = await complain(complaint);
            const told = complaints.toldAfter(retry.status, 60_000);
            const want = first === 'refused'
                ? { status: 422, text: JSON.stringify(complaints.COMPLAINT_NOT_TAKEN), told: 'failed', rows: 0 }
                : { status: 202, text: '{"received":true}', told: 'sent', rows: 1 };
            (want.status === 202 ? onFileAnswers : notTakenAnswers).add(`${retry.status} ${retry.text}`);
            const rowAt = want.rows === 0 ? '' : `, the row under the key ${senderNow === sender.key ? 'the line was signed with' : 'the last re-key gave'}: ${moved}`;
            assert(moved && retry.status === want.status && retry.text === want.text && told === want.told && rowsFiled().length === want.rows,
                `${what}: ${want.status} ${want.text}, told ${want.told} at a.example, ${want.rows} filed (got ${retry.status} ${retry.text}, told ${told}, ${rowsFiled().length} filed${rowAt})`);

            // Never on file for another member: the other member's key, as it was and as it is, naming the same line.
            const asOther: string[] = [];
            for (const member of new Set([other.key, otherNow])) {
                const r = await complain({ ...complaint, id: crypto.randomUUID(), member });
                asOther.push(`${r.status} ${r.text}`);
            }
            assert(asOther.every((a) => a === `422 ${JSON.stringify(complaints.COMPLAINT_NOT_TAKEN)}`) && rowsFiled().length === want.rows,
                `${what}: the same line named as the other member's (their key as it was${otherNow !== other.key ? ' and as their re-key made it' : ''}): 422 not_taken, nothing filed (got ${asOther.join(' | ')})`);

            // A standby holds the same rows (abuse_reports and invalidated_keys are in its copy) and answers the same.
            setNodeRole('backup');
            let standby: Answer;
            try {
                standby = await complain(complaint);
            } finally {
                setNodeRole('primary');
            }
            assert(standby.status === retry.status && standby.text === retry.text && rowsFiled().length === want.rows,
                `${what}: a standby answers the same (got ${standby.status} ${standby.text})`);
        }
    }

    // ── 11, asked backwards: never which old key became which new one ────────────────────
    // The deciding review of #3196: a community holding lines under two of a member's keys must not learn from the on-file
    // check that they are one person's. Each key the member holds in turn sends Ana at a.example a line, which a.example
    // reports naming that key (the honest complaint: filed, 202), and then the owner re-keys the member. Then every line is
    // asked again naming every key the member had: on file (202) only under the key that signed it; under any other of
    // their keys, older or newer, 422 in exactly the bytes a key that was never anyone's here gets, as another member's key
    // does, nothing filed; and a standby answers each the same. One re-key, then two re-keys deep. In life a line a new key
    // signed is reported a round trip after its re-key at the soonest; here the steps run inside a millisecond, so each
    // re-key is followed by a short wait, and each filing by one before the next re-key.
    const tick = () => new Promise((r) => setTimeout(r, 5));
    // Each table asks some forty times in a few seconds from one address: the gateway's per-minute buckets are emptied
    // before each burst (as other suites do), so every answer is the complaint route's own, never the gateway's 429.
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const dropped = `422 ${JSON.stringify(complaints.COMPLAINT_NOT_TAKEN)}`;
    const generationNames = ['their first key', 'the key one re-key gave', 'the key a second re-key gave'];
    for (const rekeys of [1, 2]) {
        const deep = rekeys === 1 ? 'one re-key' : 'two re-keys deep';
        resetGatewayRateLimit();
        const signed: { k: Keys; itemId: string; at: number }[] = [];
        const other = keys();
        addLocal(other, `Other of ${deep}`);
        let k = keys();
        addLocal(k, `Re-keyed ${rekeys}`);
        for (let g = 0; g <= rekeys; g++) {
            if (g > 0) {
                k = rekeyTo(k.key);
                await tick();
            }
            const l = await line(k, 'b.example', ana, 'a.example', `Line ${rekeys}.${g}`);
            const sentL = await asMember(k, '/api/mail/send', { items: [l] });
            const words = `Words ${rekeys}.${g}`;
            sendersWords.push(words);
            sendersKeys.push(k.key);
            const filed = await complain({ v: 1, id: crypto.randomUUID(), member: k.key, itemId: l.envelope.itemId, at: l.envelope.at, reason: 'spam or scam', words });
            const rows = db.prepare("SELECT target_pubkey FROM abuse_reports WHERE reporter_pubkey = 'community:a.example' AND target_message_id = ?").all(l.envelope.itemId) as { target_pubkey: string }[];
            assert(sentL.body?.items?.[0]?.state === 'sent' && filed.status === 202 && filed.text === '{"received":true}' && rows.length === 1 && rows[0].target_pubkey === k.key,
                `11b. ${deep}: the line ${generationNames[g]} signed, reported by a.example naming that key: 202, filed under it (got ${sentL.body?.items?.[0]?.state}, ${filed.status} ${filed.text}, ${rows.length} filed)`);
            signed.push({ k, itemId: l.envelope.itemId, at: l.envelope.at });
            await tick();
        }
        const rowsOf = (itemId: string) => (db.prepare("SELECT COUNT(*) AS n FROM abuse_reports WHERE reporter_pubkey = 'community:a.example' AND target_message_id = ?").get(itemId) as { n: number }).n;
        /** The primary's answer and a standby's, the same complaint a.example could send naming `member` for the line. */
        const ask = async (member: string, s: { itemId: string; at: number }): Promise<[string, string]> => {
            const complaint = { v: 1, id: crypto.randomUUID(), member, itemId: s.itemId, at: s.at, reason: 'spam or scam', words: 'Asked again' };
            const p = await complain(complaint);
            setNodeRole('backup');
            try {
                const b = await complain(complaint);
                return [`${p.status} ${p.text}`, `${b.status} ${b.text}`];
            } finally {
                setNodeRole('primary');
            }
        };
        for (const [i, s] of signed.entries()) {
            resetGatewayRateLimit();
            // The line named under a key that was never anyone's here, and under another member's: the answer every drop gets.
            const stranger = await ask(keys().key, s), asOther = await ask(other.key, s);
            assert([...stranger, ...asOther].every((a) => a === dropped) && stranger[0] === answersAlike[0] && rowsOf(s.itemId) === 1,
                `11b. ${deep}: the line ${generationNames[i]} signed, named under a stranger's key or another member's: 422 as every drop, on a standby too, nothing filed (got ${[...stranger, ...asOther].join(' | ')})`);
            for (const [j, named] of signed.entries()) {
                const got = await ask(named.k.key, s);
                const want = i === j ? '202 {"received":true}' : dropped;
                (i === j ? onFileAnswers : notTakenAnswers).add(got[0]);
                const how = i === j ? 'the key that signed it: on file, 202' : `${j < i ? 'an older' : 'a newer'} key of theirs (${generationNames[j]}): 422, the same bytes as a stranger's key`;
                assert(got[0] === want && got[1] === want && rowsOf(s.itemId) === 1,
                    `11b. ${deep}: the line ${generationNames[i]} signed, named under ${how}, on a standby too, nothing filed (got ${got.join(' | standby ')})`);
            }
        }
        // A complaint filed in the very millisecond of the re-key is the replaced key's line (the new key's line is reported a
        // round trip later at the soonest): on file under the key that signed it, never under the key the re-key gave.
        if (rekeys === 1) {
            resetGatewayRateLimit();
            const [first, second] = signed;
            const filedAt = (db.prepare("SELECT created_at FROM abuse_reports WHERE reporter_pubkey = 'community:a.example' AND target_message_id = ?").get(first.itemId) as { created_at: string }).created_at;
            const rekeyedAt = (db.prepare('SELECT invalidated_at FROM invalidated_keys WHERE public_key = ? AND rekeyed_to = ?').get(first.k.key, second.k.key) as { invalidated_at: string }).invalidated_at;
            const setFiled = db.prepare("UPDATE abuse_reports SET created_at = ? WHERE reporter_pubkey = 'community:a.example' AND target_message_id = ?");
            setFiled.run(rekeyedAt, first.itemId);
            let underSigner: [string, string], underNew: [string, string];
            try {
                underSigner = await ask(first.k.key, first);
                underNew = await ask(second.k.key, first);
            } finally {
                setFiled.run(filedAt, first.itemId);
            }
            assert(filedAt < rekeyedAt && underSigner.every((a) => a === '202 {"received":true}') && underNew.every((a) => a === dropped) && rowsOf(first.itemId) === 1,
                `11b. one re-key: the first key's line filed in the very millisecond of the re-key: on file under the key that signed it, 422 under the key the re-key gave, on a standby too (got ${underSigner.join(' | ')} / ${underNew.join(' | ')})`);
        }
    }

    const { TABLES: manifest } = await import('./engine/replication-manifest.js');
    const copied = (table: string) => { const e = manifest[table]; return e && (e.kind === 'replicated' || e.kind === 'replicated-except') ? e.columns : []; };
    assert(['reporter_pubkey', 'target_pubkey', 'target_message_id', 'created_at'].every((c) => copied('abuse_reports').includes(c))
        && ['public_key', 'rekeyed_to', 'invalidated_at'].every((c) => copied('invalidated_keys').includes(c)),
        '11z. what the on-file check reads is in a standby\'s copy: abuse_reports\' reporter, member, line and filing time, invalidated_keys\' re-key link and its time');
    const answers11 = [...onFileAnswers, ...notTakenAnswers].join('\n');
    const leaked = [...sendersKeys, ...sendersWords].filter((v) => answers11.includes(v));
    assert(onFileAnswers.size === 1 && notTakenAnswers.size === 1 && notTakenAnswers.has(answersAlike[0]) && leaked.length === 0,
        `11y. every on-file answer is the same bytes, re-keyed or not, and every refusal is the one every drop gets; no answer carries a key or the words (got ${[...onFileAnswers, ...notTakenAnswers].join(' | ')}; carried ${leaked.length})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ A line from another community can be reported, its sender\'s home is told, and the reporter is named to nobody.');
}

main().then(() => process.exit(0)).catch((e) => { console.error('❌ Test failed:', e); process.exit(1); });

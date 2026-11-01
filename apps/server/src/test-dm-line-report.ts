/**
 * Reporting one line of a direct message (R0: scratch/fable-design/DESIGN-reaching-across-fable.md §3, §6 item 5). Over REAL
 * HTTPS through the real signature middleware, with real Ed25519 identities, every line sealed and signed on the member's
 * side with @beanpool/core as the apps do it:
 *
 *   1. a report: POST /api/messages/report { messageId, reason, disclosure } files one row naming the line and its author,
 *      the reporter from the signature, and holds what was handed over and no key. The moderators' view verifies the sender's
 *      signature, reads the words as the reporter's and nothing more. The Reports list names it as a direct message, without
 *      its words, and the assistant never reads them
 *   2. what a signature proves: a signature by someone else, over other bytes, under another message id or to another person
 *      never verifies; bytes nobody signed are never filed as the line (the node's own copy is), and a line from an older
 *      app reads as unsigned
 *   3. who may report: an outsider, a line of a group, a node's own line and a line nobody has answer word for word alike;
 *      their own line is refused; signed out is 401
 *   4. one report per reporter per line; a repeat that changes the reason to Child safety changes the one on file
 *   5. the sender can't take it back: reported, then deleted; deleted, then reported from the copy the reporter holds; a
 *      request cancelled. An unsigned line that is gone has nothing to stand on
 *   6. an edit: a new signature replaces the old, an edit from an older app drops it, a reply's or not, and a report of the old
 *      copy still verifies
 *   7. the form: the disclosure's shape, its words' limit
 *   8. a standby copy carries the row exactly, and a server that took over verifies it the same
 *   9. a request whose line its sender deleted: it still waits, the node takes no report of the tombstone an app is left with,
 *      and the block Report sends in its place clears the request
 *  10. a line that lists too many conversation ids: a report and a moderator's read cost a fixed few verifies, counted, however
 *      long its sender's list; its own id and a fold's one id still verify, and an id past the cap doesn't
 *
 * Run through the runner: SERVER_SUITES_ONLY=test-dm-line-report node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import {
    initStateEngine, seedGenesisMember, createGroup, exportSyncState, importRemoteState, setNodeRole, getReports,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { resetChatRateLimit } from './chat-rate-limit.js';
import { ownerSessionHeaders, ownerTokenHeaders } from './admin-auth-test-harness.js';
import { startP2P } from './p2p.js';
import { pinMainServerForTests } from './standby-pin-test-helper.js';
import { setMemberPhoto } from '@beanpool/engine';
import { DM_REPORT_SEALED_MAX, DM_REPORT_WORDS_MAX, dmLineDisclosureFor, dmPublicKeyOf, newDmMessageId, sealDmLine, signDmLine } from '@beanpool/core';
import { lockedDm } from './dm-test-payload.js';
import { AGENT_TOOLS, type AgentGrant } from './agent/tools.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

// Nothing leaves this machine: no push service, no update check.
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init: any) => {
    const u = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return realFetch(url, init);
    return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '' } as any;
};

let BASE = '';
interface Id { pk: string; seedHex: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const seed = crypto.randomBytes(32);
    const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
    const seedHex = seed.toString('hex');
    return { pk: dmPublicKeyOf(seedHex), seedHex, priv: crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }), name };
}
let owner: Id;
function member(name: string): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'TEST', 'active')`).run(id.pk, name, owner.pk);
    setMemberPhoto(db, id.pk, `https://example.org/${name}.jpg`);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    return id;
}

interface Res { status: number; body: any; text: string }
async function call(method: 'GET' | 'POST', signer: Id | null, p: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    resetGatewayRateLimit();
    resetChatRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = { ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...extra };
    if (signer) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = signer.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${p.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), signer.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await realFetch(`${BASE}${p}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* empty or not JSON */ }
    return { status: res.status, body: parsed, text };
}
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 220)}`;

const open = async (a: Id, b: Id): Promise<string> => {
    const r = await call('POST', a, '/api/messages/conversation', { type: 'dm', participants: [a.pk, b.pk], createdBy: a.pk });
    if (!r.body?.conversation?.id) throw new Error(`setup: no conversation (${show(r)})`);
    return r.body.conversation.id;
};

interface Line { id: string; conversationId: string; ciphertext: string; nonce: string; metadata: string | undefined; text: string }
/** A line as an app sends one: sealed, and its sealed bytes signed by its sender to `to`. */
function sealed(from: Id, to: Id, conversationId: string, text: string, o: { id?: string; signer?: Id; signedTo?: Id; signedId?: string; signed?: boolean } = {}): Line {
    const id = o.id ?? newDmMessageId();
    const seal = sealDmLine(text, { myEdPrivHex: from.seedHex, peerEdPubHex: to.pk, conversationId }, { senderPubHex: from.pk, messageId: id });
    if (o.signed === false) return { id, conversationId, ...seal, metadata: undefined, text };
    const by = o.signer ?? from;
    const lineSig = signDmLine(seal, by.seedHex, {
        conversationId, senderPubHex: by.pk, recipientPubHex: (o.signedTo ?? to).pk, messageId: o.signedId ?? id, at: new Date().toISOString(),
    });
    return { id, conversationId, ...seal, metadata: JSON.stringify({ lineSig }), text };
}
async function send(from: Id, line: Line): Promise<Res> {
    const r = await call('POST', from, '/api/messages/send', { id: line.id, conversationId: line.conversationId, authorPubkey: from.pk, ciphertext: line.ciphertext, nonce: line.nonce, metadata: line.metadata });
    if (r.status !== 200) throw new Error(`setup: ${from.name}'s line was not sent (${show(r)})`);
    return r;
}
const disclosureOf = (l: Line, words = l.text) => dmLineDisclosureFor({ ciphertext: l.ciphertext, nonce: l.nonce, conversationId: l.conversationId, metadata: l.metadata }, words);
const report = (who: Id | null, l: Line, extra: Record<string, unknown> = {}) =>
    call('POST', who, '/api/messages/report', { messageId: l.id, reason: 'Harassment', disclosure: disclosureOf(l), ...extra });
/**
 * What `run` returned, and how many signature checks it made on `sig`. ed25519 is frozen, so its verify can't be wrapped, but
 * dmLineSigVerifies decodes the signature once for each try, in this process. The counts asserted are exact, so a change to
 * that decoding fails here rather than counting nothing.
 */
async function verifiesDuring<T>(sig: string, run: () => Promise<T>): Promise<{ result: T; verifies: number }> {
    const realFrom = Buffer.from;
    let verifies = 0;
    (Buffer as any).from = function (...args: any[]) {
        if (args[0] === sig && args[1] === 'base64') verifies++;
        return (realFrom as any).apply(Buffer, args);
    };
    try {
        return { result: await run(), verifies };
    } finally {
        Buffer.from = realFrom;
    }
}
const reportRows = (reporter: string, messageId: string) =>
    (db.prepare('SELECT COUNT(*) AS c FROM abuse_reports WHERE reporter_pubkey = ? AND target_message_id = ?').get(reporter, messageId) as { c: number }).c;
const allReports = () => (db.prepare('SELECT COUNT(*) AS c FROM abuse_reports').get() as { c: number }).c;

async function main(): Promise<void> {
    console.log('R0: report one direct-message line\n');
    await initTls();
    initStateEngine();
    const p2p = await startP2P(0, 0);
    const nodeId = p2p.peerId.toString();
    pinMainServerForTests(`/ip4/127.0.0.1/tcp/4099/p2p/${nodeId}`);
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    const ann = member('Ann');     // reports
    const bo = member('Bo');       // writes to her
    const cy = member('Cy');       // an outsider to their chat
    let admin = ownerTokenHeaders('admin');
    const viewOf = (reportId: string) => call('GET', null, `/api/local/admin/reports/${reportId}/message`, undefined, admin);
    const conv = await open(bo, ann);

    console.log('── 1. a report, and what it holds ──');
    const nastyWords = `You will regret this ${crypto.randomUUID()}`;
    const nasty = sealed(bo, ann, conv, nastyWords);
    const other = sealed(bo, ann, conv, `another line ${crypto.randomUUID()}`);
    await send(bo, nasty);
    await send(bo, other);
    const annRead = await call('GET', ann, `/api/messages/${conv}`);
    const annCopy = (annRead.body?.messages ?? []).find((m: any) => m.id === nasty.id);
    assert(JSON.parse(annCopy?.metadata ?? '{}').lineSig?.sig === JSON.parse(nasty.metadata!).lineSig.sig,
        'the signature reaches the person the line is for, with the line, as an app reads it');
    const rep = await report(ann, nasty);
    assert(rep.status === 200 && rep.body?.report?.targetPubkey === bo.pk && rep.body?.report?.reporterPubkey === ann.pk && rep.body?.report?.targetMessageId === nasty.id,
        `the report names the line, its author and, from the signature, its reporter (${show(rep)})`);
    const repId: string = rep.body?.report?.id;
    const row = db.prepare('SELECT disclosure, target_post_id FROM abuse_reports WHERE id = ?').get(repId) as { disclosure: string; target_post_id: string | null };
    const kept = JSON.parse(row.disclosure);
    assert(kept.kind === 'dm-line' && kept.v === 1 && kept.ciphertext === nasty.ciphertext && kept.nonce === nasty.nonce && kept.words === nastyWords && row.target_post_id === null,
        'it keeps what was handed over: the sealed line, the signature and the reporter\'s words');
    assert(!('mk' in kept) && !('key' in kept) && !row.disclosure.includes(other.ciphertext) && !row.disclosure.includes(other.text),
        'and no key, and nothing of any other line');
    let v = await viewOf(repId);
    assert(v.status === 200 && v.body?.message?.kind === 'dm' && v.body?.message?.signature === 'verified' && v.body?.message?.signer === bo.pk,
        `the moderators' view verifies the sender's signature (${show(v)})`);
    assert(v.body?.message?.words?.state === 'reported' && v.body?.message?.words?.text === nastyWords && v.body?.message?.line === 'same',
        'and reads the words as the reporter\'s, never as verified');
    assert(!v.text.includes(nasty.ciphertext) && !v.text.includes(other.text), 'its answer holds neither the sealed bytes nor another line');
    const listed = getReports().reports.find((r: any) => r.id === repId) as any;
    assert(!!listed?.directMessage && listed.groupMessage === null && !JSON.stringify(listed).includes(nastyWords),
        `the Reports list names a direct message, without its words (${JSON.stringify(listed?.directMessage)})`);
    const grant: AgentGrant = { id: 'test-grant', name: 'Test', member: owner.pk, role: 'owner', via: 'token', createdAt: Date.now(), expiresAt: null, canPost: false };
    const got = AGENT_TOOLS.find((t) => t.name === 'report_get')!.run(grant, { report_id: repId }, 'B0UNDARY') as any;
    assert(got.result?.report?.targetKind === 'direct_message' && !JSON.stringify(got).includes(nastyWords),
        `the assistant calls it a direct_message report, and never reads the words (${got.result?.report?.targetKind})`);

    console.log('── 2. what a signature proves ──');
    const forged: [string, Line][] = [
        ['by the reporter', sealed(bo, ann, conv, 'forged 1', { signer: ann })],
        ['by a third member', sealed(bo, ann, conv, 'forged 2', { signer: cy })],
        ['to someone else', sealed(bo, ann, conv, 'forged 3', { signedTo: cy })],
        ['under another message id', sealed(bo, ann, conv, 'forged 4', { signedId: newDmMessageId() })],
    ];
    for (const [how, line] of forged) {
        await send(bo, line);
        const r = await report(ann, line);
        const view = await viewOf(r.body?.report?.id);
        assert(r.status === 200 && view.body?.message?.signature === 'unverified' && view.body?.message?.signer === null,
            `a signature ${how} never verifies: the view says so (${view.body?.message?.signature})`);
    }
    const honest = sealed(bo, ann, conv, 'an honest line');
    await send(bo, honest);
    const swapped = await report(ann, { ...honest, ...lockedDm() });
    const swappedKept = JSON.parse((db.prepare('SELECT disclosure FROM abuse_reports WHERE id = ?').get(swapped.body?.report?.id) as any).disclosure);
    assert(swapped.status === 200 && swappedKept.ciphertext === honest.ciphertext && swappedKept.nonce === honest.nonce,
        'bytes nobody signed are never filed as the line: the node keeps its own copy');
    const oldApp = sealed(bo, ann, conv, 'from an older app', { signed: false });
    await send(bo, oldApp);
    const oldRep = await report(ann, oldApp);
    v = await viewOf(oldRep.body?.report?.id);
    assert(oldRep.status === 200 && v.body?.message?.signature === 'unsigned' && v.body?.message?.words?.text === 'from an older app',
        `a line from an older app is still reported, as unsigned (${v.body?.message?.signature})`);

    console.log('── 3. who may report ──');
    const allBefore = allReports();
    const missing = await call('POST', cy, '/api/messages/report', { messageId: crypto.randomUUID(), reason: 'Harassment', disclosure: disclosureOf(nasty) });
    const outsider = await report(cy, nasty);
    assert(outsider.status === 404 && outsider.text === missing.text, `an outsider is answered as for an id nobody has (${show(outsider)})`);
    const own = await report(bo, nasty);
    assert(own.status === 400 && own.body?.code === 'own_message', `their own line is refused (${show(own)})`);
    const out = await report(null, nasty);
    assert(out.status === 401, `signed out is 401 (${show(out)})`);
    const grp = createGroup({ name: 'Club', category: 'general', createdBy: ann.pk } as any) as any;
    const grpLine = newDmMessageId();
    db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, timestamp) VALUES (?, ?, ?, ?, ?, 'text', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
        .run(grpLine, grp?.id ?? 'no-group', bo.pk, 'c2VudGluZWw=', 'group-sealed');
    const grpRep = await report(ann, { ...nasty, id: grpLine, conversationId: grp?.id ?? 'no-group' });
    assert(grpRep.status === 404, `a group's line is no direct line (${show(grpRep)})`);
    const adminLine = newDmMessageId();
    db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp) VALUES (?, ?, ?, ?, 'plaintext-v1', 'text', '{"fromCommunityAdmins":true}', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
        .run(adminLine, conv, bo.pk, 'c2VudGluZWw=');
    const readable = await report(ann, { ...nasty, id: adminLine });
    assert(readable.status === 404, `a readable line the admins sent is no sealed line (${show(readable)})`);
    const unsignedNobody = await report(ann, { ...sealed(bo, ann, conv, 'never sent', { signed: false }) });
    assert(unsignedNobody.status === 404, `an unsigned line the node doesn't hold has nothing to stand on (${show(unsignedNobody)})`);
    assert(allReports() === allBefore, 'none of those filed anything');

    console.log('── 4. one report per reporter per line ──');
    const again = await report(ann, nasty, { reason: 'Spam or scam' });
    assert(again.status === 200 && again.body?.duplicate === true && again.body?.report?.id === repId && reportRows(ann.pk, nasty.id) === 1,
        `a repeat answers the one on file (${show(again)})`);
    const child = await report(ann, nasty, { reason: 'Child safety' });
    assert(child.body?.duplicate === true && child.body?.report?.reason === 'Child safety' && reportRows(ann.pk, nasty.id) === 1,
        `a repeat with Child safety changes the one on file (${show(child)})`);

    console.log('── 5. the sender can\'t take it back ──');
    const del = await call('POST', bo, '/api/messages/delete', { messageId: nasty.id });
    v = await viewOf(repId);
    assert(del.status === 200 && v.body?.message?.signature === 'verified' && v.body?.message?.line === 'gone' && v.body?.message?.words?.text === nastyWords,
        `reported, then deleted: the report keeps the line, verified, and says it is gone (${show(v)})`);
    const quick = sealed(bo, ann, conv, 'sent and deleted');
    await send(bo, quick);
    await call('POST', bo, '/api/messages/delete', { messageId: quick.id });
    const late = await report(ann, quick);
    v = await viewOf(late.body?.report?.id);
    assert(late.status === 200 && v.body?.message?.signature === 'verified' && v.body?.message?.line === 'gone',
        `deleted, then reported from the copy the reporter holds: it stands on its signature (${show(late)})`);
    const quickOld = sealed(bo, ann, conv, 'old app, deleted', { signed: false });
    await send(bo, quickOld);
    await call('POST', bo, '/api/messages/delete', { messageId: quickOld.id });
    const lateOld = await report(ann, quickOld);
    assert(lateOld.status === 404, `an unsigned line that is gone has nothing to stand on (${show(lateOld)})`);

    console.log('── 6. an edit ──');
    const edited = sealed(bo, ann, conv, 'first words');
    await send(bo, edited);
    const newWords = sealed(bo, ann, conv, 'second words', { id: edited.id });
    const ed = await call('POST', bo, '/api/messages/edit', { messageId: edited.id, ciphertext: newWords.ciphertext, nonce: newWords.nonce, metadata: JSON.parse(newWords.metadata!) });
    const edRow = db.prepare('SELECT metadata FROM messages WHERE id = ?').get(edited.id) as { metadata: string };
    assert(ed.status === 200 && JSON.parse(edRow.metadata).lineSig.sig === JSON.parse(newWords.metadata!).lineSig.sig, `an edit carries its new signature (${show(ed)})`);
    const ofOld = await report(ann, edited);
    v = await viewOf(ofOld.body?.report?.id);
    assert(v.body?.message?.signature === 'verified' && v.body?.message?.line === 'changed' && v.body?.message?.words?.text === 'first words',
        `the copy the reporter was sent still verifies, and reads as changed since (${show(v)})`);
    const replied = sealed(bo, ann, conv, 'a reply');
    await send(bo, { ...replied, metadata: JSON.stringify({ ...JSON.parse(replied.metadata!), replyToId: other.id }) });
    const oldEdit = sealed(bo, ann, conv, 'edited by an older app', { id: replied.id, signed: false });
    await call('POST', bo, '/api/messages/edit', { messageId: replied.id, ciphertext: oldEdit.ciphertext, nonce: oldEdit.nonce });
    const dropped = JSON.parse((db.prepare('SELECT metadata FROM messages WHERE id = ?').get(replied.id) as { metadata: string }).metadata);
    assert(dropped.lineSig === undefined && dropped.replyToId === other.id,
        'an edit from an older app drops the old signature, which covers bytes the line no longer has, and keeps the rest of its metadata');
    const unsignedEdit = await report(ann, oldEdit);
    v = await viewOf(unsignedEdit.body?.report?.id);
    assert(v.body?.message?.signature === 'unsigned', `so it reports as unsigned, not as a failed signature (${v.body?.message?.signature})`);
    // The signature is all this one's metadata holds, so nothing else keeps the row's metadata in being (the deciding review of
    // #2705). Fay's own chat, as Ann is at her hourly limit on reports by now.
    const fay = member('Fay');
    const fayConv = await open(bo, fay);
    const plain = sealed(bo, fay, fayConv, 'not a reply');
    await send(bo, plain);
    const plainEdit = sealed(bo, fay, fayConv, 'edited by an older app, and not a reply', { id: plain.id, signed: false });
    const pe = await call('POST', bo, '/api/messages/edit', { messageId: plain.id, ciphertext: plainEdit.ciphertext, nonce: plainEdit.nonce });
    const plainRow = db.prepare('SELECT metadata FROM messages WHERE id = ?').get(plain.id) as { metadata: string | null };
    assert(pe.status === 200 && plainRow.metadata === null, `an edit from an older app of a line that is not a reply leaves no signature either (${plainRow.metadata})`);
    const plainReport = await report(fay, plainEdit);
    v = await viewOf(plainReport.body?.report?.id);
    assert(v.body?.message?.signature === 'unsigned', `and it too reports as unsigned, not as a failed signature (${show(v)})`);

    console.log('── 7. the form ──');
    const allForm = allReports();
    const line7 = sealed(bo, ann, conv, 'form');
    await send(bo, line7);
    const forms: [string, Record<string, unknown>][] = [
        ['no disclosure', { disclosure: undefined }],
        ['a group line\'s disclosure', { disclosure: { epoch: 1, mk: Buffer.alloc(32, 7).toString('base64') } }],
        ['a later version', { disclosure: { ...disclosureOf(line7), v: 2 } }],
        ['no reason', { reason: '   ' }],
        ['a bad message id', { messageId: 'not-a-uuid' }],
        ['readable bytes', { disclosure: { ...disclosureOf(line7), nonce: 'plaintext-v1' } }],
        ['words past the limit', { disclosure: { ...disclosureOf(line7), words: 'x'.repeat(DM_REPORT_WORDS_MAX + 1) } }],
        ['sealed bytes past a line\'s limit', { disclosure: { ...disclosureOf(line7), ciphertext: 'x'.repeat(DM_REPORT_SEALED_MAX + 1) } }],
    ];
    for (const [what, extra] of forms) {
        const r = await report(ann, line7, extra);
        assert(r.status === 400, `${what} is refused (${show(r)})`);
    }
    assert(allReports() === allForm, 'and files nothing');

    console.log('── 8. a standby copy ──');
    const cols = 'id, reporter_pubkey, target_pubkey, target_message_id, disclosure, reason';
    const onMain = db.prepare(`SELECT ${cols} FROM abuse_reports WHERE id = ?`).get(repId) as any;
    const payload: any = await exportSyncState(nodeId);
    db.prepare('DELETE FROM abuse_reports WHERE id = ?').run(repId);
    setNodeRole('backup');
    await importRemoteState(payload);
    setNodeRole('primary');
    const onStandby = db.prepare(`SELECT ${cols} FROM abuse_reports WHERE id = ?`).get(repId);
    assert(JSON.stringify(onStandby) === JSON.stringify(onMain), 'a standby copies the report, column for column');
    admin = ownerTokenHeaders('admin');
    v = await viewOf(repId);
    assert(v.body?.message?.signature === 'verified', `and on a server that took over its signature verifies the same (${v.body?.message?.signature})`);

    console.log('── 9. a request whose line its sender deleted ──');
    const on = await call('POST', null, '/api/local/admin/community-shape', { changes: { dmRequests: true } }, ownerSessionHeaders(owner.pk));
    assert(on.status === 200, `an owner turns requests on (${show(on)})`);
    const dee = member('Dee');
    const deeConv = await open(dee, ann);
    const deeLine = sealed(dee, ann, deeConv, 'a nasty request');
    await send(dee, deeLine);
    const waiting = async (): Promise<number | undefined> => (await call('GET', ann, `/api/messages/conversations/${ann.pk}`)).body?.requests?.count;
    const before = await waiting();
    await call('POST', dee, '/api/messages/delete', { messageId: deeLine.id });
    const afterDelete = await waiting();
    assert(before === 1 && afterDelete === 1, `a delete leaves the request waiting (${before}, then ${afterDelete})`);
    const heldNow = (await call('GET', ann, `/api/messages/${deeConv}?limit=20`)).body?.messages?.find((m: any) => m.id === deeLine.id);
    assert(heldNow?.type === 'removed', `and all an app reads now is a tombstone (${heldNow?.type})`);
    const ofTombstone = await call('POST', ann, '/api/messages/report', {
        messageId: heldNow.id, reason: 'Harassment',
        disclosure: dmLineDisclosureFor({ ciphertext: heldNow.ciphertext, nonce: heldNow.nonce, conversationId: deeConv, metadata: heldNow.metadata }, ''),
    });
    assert(ofTombstone.status === 400 && ofTombstone.body?.code === 'disclosure_form' && reportRows(ann.pk, deeLine.id) === 0,
        `the node takes no report of it, so the apps never hand it over (${show(ofTombstone)})`);
    const blocked = await call('POST', ann, '/api/blocks', { targetPubkey: dee.pk });
    const afterBlock = await waiting();
    assert(blocked.status === 200 && afterBlock === 0, `the block Report sends in its place clears the request (${afterDelete} to ${afterBlock})`);

    // The deciding review of #2705: 11,000 ids held a node for 20.6 s, past the duplicate and hourly limits. Gus's own chat, as
    // the limits on reports by now are Ann's and Fay's.
    console.log('── 10. a line that lists too many conversation ids ──');
    const off = await call('POST', null, '/api/local/admin/community-shape', { changes: { dmRequests: false } }, ownerSessionHeaders(owner.pk));
    assert(off.status === 200, `requests off again, as a request holds its sender's second line (${show(off)})`);
    const gus = member('Gus');
    const gusConv = await open(bo, gus);
    const manyIds = Array.from({ length: 300 }, (_, i) => `listed-${i}`);
    const withIds = (l: Line, ids: Record<string, unknown>): Line => ({ ...l, metadata: JSON.stringify({ ...JSON.parse(l.metadata!), ...ids }) });
    // A real signature made for another message id, so nothing verifies and the whole list would be walked, as the review's was.
    const walker = withIds(sealed(bo, gus, gusConv, 'a list to walk', { signedId: newDmMessageId() }), { originalConversationIds: manyIds });
    await send(bo, walker);
    const stored = (db.prepare('SELECT metadata FROM messages WHERE id = ?').get(walker.id) as { metadata: string }).metadata;
    assert(JSON.parse(stored).originalConversationIds?.length === manyIds.length, 'the sender\'s list is stored as sent, the case the cap is for');
    const sig = JSON.parse(walker.metadata!).lineSig.sig as string;
    // The handed copy's check, then the stored copy's, at two ids each; a moderator's read checks once.
    const filed = await verifiesDuring(sig, () => report(gus, walker));
    assert(filed.result.status === 200 && filed.verifies === 4, `a report of it costs 4 verifies, not one for each id listed (${filed.verifies}, ${show(filed.result)})`);
    const again10 = await verifiesDuring(sig, () => report(gus, walker));
    assert(again10.result.body?.duplicate === true && again10.verifies === 4, `and the same again as a repeat (${again10.verifies})`);
    const walked = await verifiesDuring(sig, () => viewOf(filed.result.body?.report?.id));
    assert(walked.result.body?.message?.signature === 'unverified' && walked.verifies === 2, `a moderator opening it costs 2, through the same cap (${walked.verifies}, ${walked.result.body?.message?.signature})`);

    const ownId = withIds(sealed(bo, gus, gusConv, 'signed here, with a list beside it'), { originalConversationIds: manyIds });
    await send(bo, ownId);
    const ownIdSig = JSON.parse(ownId.metadata!).lineSig.sig as string;
    const ownFiled = await verifiesDuring(ownIdSig, () => report(gus, ownId));
    const ownView = await verifiesDuring(ownIdSig, () => viewOf(ownFiled.result.body?.report?.id));
    assert(ownFiled.verifies === 1 && ownView.result.body?.message?.signature === 'verified' && ownView.verifies === 1,
        `a line signed under its own id verifies at the first try, whatever is listed beside it (${ownFiled.verifies}, ${ownView.verifies}, ${ownView.result.body?.message?.signature})`);

    const oldThread = crypto.randomUUID();
    const signedInOld = (text: string) => ({ ...sealed(bo, gus, oldThread, text), conversationId: gusConv });
    const folded = withIds(signedInOld('signed in the thread it was folded from'), { originalConversationId: oldThread });
    await send(bo, folded);
    const foldedRep = await report(gus, folded);
    v = await viewOf(foldedRep.body?.report?.id);
    assert(v.body?.message?.signature === 'verified', `the one id a fold names is within the cap (${show(v)})`);

    const pastCap = withIds(signedInOld('signed under an id past the cap'), { originalConversationIds: ['listed-first', oldThread] });
    await send(bo, pastCap);
    const pastRep = await report(gus, pastCap);
    v = await viewOf(pastRep.body?.report?.id);
    assert(pastRep.status === 200 && v.body?.message?.signature === 'unverified', `a signature only an id past the cap would verify reads as not verified (${show(v)})`);

    console.log(`\n${passed}/${run} passed`);
    try { await p2p.stop(); } catch { /* stopping only */ }
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error('❌ Test crashed:', e); console.log(`\n${passed}/${run} passed`); process.exit(1); });

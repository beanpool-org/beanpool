/**
 * Reporting one message of a locked group chat, with its key (group chat photos S6: scratch/fable-design/
 * DESIGN-group-chat-photos-fable.md §5 S6; the encryption design §13). Over REAL HTTPS through the real signature
 * middleware, with real Ed25519 identities, every line sealed on the member's side with @beanpool/core's group line lock
 * and every disclosed key made by core's groupMessageKey, as the apps make them:
 *
 *   1. a photo line's report: POST /api/groups/:id/chat/report { messageId, reason, disclosure: { epoch, mk } } files one
 *      row naming the line and its author, the reporter from the signature; the disclosed key opens exactly that
 *      message's two parts (its words and its photo) and no other line of the chat, in any part; the moderators' view
 *      (GET /api/local/admin/reports/:id/message) opens the words and the photo, verified against their signer, and holds
 *      nothing else of the chat; the Reports list names the message without opening it
 *   2. a forged key (random, or another line's), a line the node re-attributed or altered, and a swapped photo read
 *      "could not be verified" in the view, never an error
 *   3. a line the reporter may not read (from before their epoch; a group they are not in, an invite-only one too; after
 *      their removal; another group's line by this group's path; a system line) is 404, word for word the answer of a
 *      missing id, nothing stored; signed out is 401, as every group route
 *   4. one report per reporter per message, whatever its status; a second reporter files their own; a repeat that changes
 *      the reason to Child safety changes the one on file; a report of the member is not taken for a report of their line.
 *      Child safety on a report a moderator closed (dismissed or handled) files a new one with the key sent with it, told
 *      to the owners once, the closed one as they left it; a further repeat finds the new one and adds nothing; any other
 *      reason on a closed one is still the one on file. The assistant calls a message's report a group_message report
 *   5. the form: their own line, a messageId, a reason, the disclosure's shape and its epoch; the hourly report limit
 *   6. who reaches the view: owners' tokens and a moderator's session, no member's signature; a report of a post or a
 *      member has no message to open
 *   7. the author deletes the line after the report: the view says it is gone
 *   8. a standby copy carries the row with its message and its key exactly; on a server that took over, the words open
 *      and the photo reads unavailable (chat photos are not copied, G4)
 *
 * Run through the runner: SERVER_SUITES_ONLY=test-group-chat-report node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { wrapCreatePost } from './post-test-helper.js';
import {
    initStateEngine, seedGenesisMember, createGroup, joinGroup, removeGroupMember, inviteGroupMember, createPost as rawCreatePost,
    exportSyncState, importRemoteState, setNodeRole, REPORTS_PER_REPORTER_PER_HOUR,
} from './state-engine.js';
const createPost = wrapCreatePost(rawCreatePost);
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { resetChatRateLimit } from './chat-rate-limit.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { ownerTokenHeaders } from './admin-auth-test-harness.js';
import { mintHandshakeToken, consumeHandshakeToken } from './admin-key-auth.js';
import { grantNodeRole } from './engine/node-roles.js';
import { emptyCopiedTables } from './engine/copied-tables.js';
import { changeGroupLineReportReason } from './engine/group-chat-report.js';
import { startP2P } from './p2p.js';
import { pinMainServerForTests } from './standby-pin-test-helper.js';
import { setMemberPhoto } from '@beanpool/engine';
import { dmPublicKeyOf, groupMessageKey, openGroupLineWithMessageKey, sealGroupLine, type GroupLinePart } from '@beanpool/core';
import { getImageStore } from './storage/image-store.js';
import { freshGroupEpoch } from './group-test-payload.js';
import { getAlertsStatus } from './services/alerts.js';
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

interface Res { status: number; body: any; text: string; headers: Record<string, string> }
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
    return { status: res.status, body: parsed, text, headers: Object.fromEntries(res.headers.entries()) };
}
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 200)}`;

// ── the members' side: one random key per epoch, which the node never sees ────────────────────────────────────────
const epochKeys = new Map<string, Uint8Array>();
const keyFor = (groupId: string, epoch: number): Uint8Array => {
    const k = `${groupId}:${epoch}`;
    if (!epochKeys.has(k)) epochKeys.set(k, new Uint8Array(crypto.randomBytes(32)));
    return epochKeys.get(k)!;
};

interface Line { id: string; groupId: string; epoch: number; sender: Id; text: string; uri: string | null; replyToId: string | null }
/** A line as an app seals one: its words as part 'body', and for a photo the JPEG data URI as part 'attachment'. */
async function send(sender: Id, groupId: string, text: string, o: { photo?: boolean; replyToId?: string } = {}): Promise<Line> {
    const epoch = freshGroupEpoch(db, groupId);
    const id = crypto.randomUUID();
    const base = { myEdPrivHex: sender.seedHex, groupKey: keyFor(groupId, epoch), groupId, epoch, messageId: id, after: null, replyToId: o.replyToId ?? null };
    const body = sealGroupLine(text, { ...base, part: 'body' });
    const uri = o.photo ? `data:image/jpeg;base64,${crypto.randomBytes(1200).toString('base64')}` : null;
    const meta: Record<string, unknown> = { epoch };
    if (o.replyToId) meta.replyToId = o.replyToId;
    const req: Record<string, unknown> = { ciphertext: body.ciphertext, nonce: body.nonce, metadata: JSON.stringify(meta), clientId: id };
    if (uri) {
        const att = sealGroupLine(uri, { ...base, part: 'attachment' });
        Object.assign(req, { type: 'image', attachment: { data: att.ciphertext, nonce: att.nonce, mime: 'image/jpeg' } });
    }
    const r = await call('POST', sender, `/api/groups/${groupId}/chat/message`, req);
    if (r.status !== 201) throw new Error(`setup: ${sender.name}'s line was not sent (${show(r)})`);
    return { id, groupId, epoch, sender, text, uri, replyToId: o.replyToId ?? null };
}

/** The key a reporter's app hands over for one line: core's per-message key under the line's epoch (§7.1). */
const mkOf = (l: Line): Uint8Array => groupMessageKey(keyFor(l.groupId, l.epoch), l.id);
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const disclosureOf = (l: Line) => ({ epoch: l.epoch, mk: b64(mkOf(l)) });
const reportPath = (groupId: string) => `/api/groups/${groupId}/chat/report`;
const report = (who: Id | null, l: Line, extra: Record<string, unknown> = {}) =>
    call('POST', who, reportPath(l.groupId), { messageId: l.id, reason: 'Offensive content', disclosure: disclosureOf(l), ...extra });

const reportRows = (reporter: string, messageId: string) =>
    (db.prepare('SELECT COUNT(*) AS c FROM abuse_reports WHERE reporter_pubkey = ? AND target_message_id = ?').get(reporter, messageId) as { c: number }).c;
const allReports = () => (db.prepare('SELECT COUNT(*) AS c FROM abuse_reports').get() as { c: number }).c;

/** The report route answers `who` for `l` word for word as it answers them for an id nobody has (no oracle). */
async function sameAsMissing(who: Id, groupId: string, l: Line): Promise<{ ok: boolean; got: string }> {
    const a = await call('POST', who, reportPath(groupId), { messageId: l.id, reason: 'Spam or scam', disclosure: disclosureOf(l) });
    const b = await call('POST', who, reportPath(groupId), { messageId: crypto.randomUUID(), reason: 'Spam or scam', disclosure: disclosureOf(l) });
    return { ok: a.status === 404 && a.status === b.status && a.text === b.text, got: `${show(a)} vs ${show(b)}` };
}

/** Opens with this key, as this part, as its own author: true only if it opened and its signature verified. */
function opensWith(row: { id: string; ciphertext: string; nonce: string; metadata: string | null; author_pubkey: string }, groupId: string, part: GroupLinePart, mk: Uint8Array): boolean {
    let meta: any = {};
    try { meta = JSON.parse(row.metadata || '{}'); } catch { /* none */ }
    const att = part === 'attachment' ? db.prepare('SELECT nonce FROM message_attachments WHERE message_id = ?').get(row.id) as { nonce: string } | undefined : undefined;
    let payload = { ciphertext: row.ciphertext, nonce: row.nonce };
    if (part === 'attachment') {
        if (!att) return false;
        let data: Buffer | null = null;
        try { data = getImageStore().get(`attachments/${row.id}.bin`); } catch { data = null; }
        if (!data) return false;
        payload = { ciphertext: data.toString('base64'), nonce: att.nonce };
    }
    try {
        openGroupLineWithMessageKey(payload, {
            groupId, epoch: meta.epoch, senderPubHex: meta.sender ?? row.author_pubkey, messageId: row.id, part,
            replyToId: typeof meta.replyToId === 'string' ? meta.replyToId : null,
        }, mk);
        return true;
    } catch {
        return false;
    }
}

async function main(): Promise<void> {
    console.log('Group chat photos S6: report one message, with its key\n');
    await initTls();
    initStateEngine();
    const p2p = await startP2P(0, 0);
    const nodeId = p2p.peerId.toString();
    pinMainServerForTests(`/ip4/127.0.0.1/tcp/4099/p2p/${nodeId}`);
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    const alice = member('Alice');   // convenor, reports
    const bob = member('Bob');       // writes most lines
    const carol = member('Carol');   // member, reports too
    const dave = member('Dave');     // removed later
    const nora = member('Nora');     // joins after the first lines
    const erin = member('Erin');     // outsider
    const mo = member('Mo');         // the node's moderator
    grantNodeRole(mo.pk, 'moderator', owner.pk);
    let admin = ownerTokenHeaders('admin');
    const modSession = (): Record<string, string> => {
        const { handshakeToken } = mintHandshakeToken(mo.pk, 'moderator');
        const s = consumeHandshakeToken(handshakeToken);
        if (!s.ok || !s.sessionId) throw new Error(`setup: no moderator session (${s.error})`);
        return { 'X-Admin-Session': s.sessionId };
    };
    const viewOf = (reportId: string, headers: Record<string, string> = admin) => call('GET', null, `/api/local/admin/reports/${reportId}/message`, undefined, headers);

    const garden = createGroup({ name: 'Garden Crew', joinPolicy: 'open', createdBy: alice.pk });
    for (const m of [bob, carol, dave]) joinGroup(garden.id, m.pk);
    const g = garden.id;

    // ── 1. A photo line's report ─────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 1. A photo line, reported with its key ---');
    const photo = await send(bob, g, 'Look what I found', { photo: true });
    const t1 = await send(bob, g, 'Sentinel words of the first other line');
    const t2 = await send(carol, g, 'Sentinel words of the second other line', { replyToId: photo.id });
    const before = allReports();
    const filed = await report(alice, photo, { reason: 'Offensive content: not ok here' });
    assert(filed.status === 200 && filed.body?.success === true && typeof filed.body?.report?.id === 'string',
        `a member reports a photo line with its key: 200 (got ${show(filed)})`);
    const repId: string = filed.body?.report?.id ?? '';
    const row = db.prepare('SELECT * FROM abuse_reports WHERE id = ?').get(repId) as any;
    assert(allReports() === before + 1 && !!row, 'one row is filed');
    assert(row?.reporter_pubkey === alice.pk && row?.target_pubkey === bob.pk && row?.target_message_id === photo.id
        && row?.target_post_id === null && row?.target_pulse_item_id === null && row?.reason === 'Offensive content: not ok here' && row?.status === 'pending',
        `it names the reporter (the signer), the line's author and the line, and no post (got ${JSON.stringify(row)?.slice(0, 240)})`);
    let disclosure: any = null;
    try { disclosure = JSON.parse(row?.disclosure); } catch { /* stays null */ }
    assert(disclosure?.epoch === photo.epoch && disclosure?.mk === b64(mkOf(photo)) && Object.keys(disclosure ?? {}).length === 2,
        `and keeps the disclosure as it was handed over, its epoch and its key (got ${row?.disclosure})`);
    const otherReporter = allReports();
    const asCarol = await call('POST', alice, reportPath(g), { messageId: t1.id, reason: 'Spam or scam', disclosure: disclosureOf(t1), reporterPubkey: carol.pk });
    assert(asCarol.status === 403 && allReports() === otherReporter, `a body naming another reporter is refused by the signature check, nothing filed (got ${show(asCarol)})`);
    const named = await call('POST', alice, reportPath(g), { messageId: t1.id, reason: 'Spam or scam', disclosure: disclosureOf(t1), targetPubkey: dave.pk });
    const namedRow = db.prepare('SELECT reporter_pubkey, target_pubkey FROM abuse_reports WHERE id = ?').get(named.body?.report?.id ?? '') as any;
    assert(named.status === 200 && namedRow?.reporter_pubkey === alice.pk && namedRow?.target_pubkey === bob.pk,
        `a body naming another target changes nothing: the signer reports the line's author (got ${show(named)})`);

    const lines = db.prepare('SELECT id, ciphertext, nonce, metadata, author_pubkey FROM messages WHERE conversation_id = ? AND nonce LIKE ?').all(g, 'group-xc20p-v1:%') as any[];
    const photoRow = lines.find((l) => l.id === photo.id);
    assert(!!photoRow && opensWith(photoRow, g, 'body', mkOf(photo)) && opensWith(photoRow, g, 'attachment', mkOf(photo)),
        'the disclosed key opens that message\'s words and its photo, each signed by its author');
    const others = lines.filter((l) => l.id !== photo.id);
    const openedOther = others.flatMap((l) => (['body', 'attachment', 'edit'] as const).filter((part) => opensWith(l, g, part, mkOf(photo))).map((part) => `${l.id}:${part}`));
    assert(others.length >= 2 && openedOther.length === 0, `and no other line of the chat, in any part (${others.length} lines tried; opened ${openedOther.join(', ') || 'none'})`);

    const view = await viewOf(repId);
    const m = view.body?.message;
    assert(view.status === 200 && m?.id === photo.id && m?.groupId === g && m?.groupName === 'Garden Crew',
        `the moderators' view opens the reported message (got ${show(view)})`);
    assert(m?.words?.state === 'verified' && m?.words?.text === photo.text && m?.signer === bob.pk && m?.authorPubkey === bob.pk && m?.authorCallsign === 'Bob',
        `its words, verified against the key that signed them, Bob's (got ${JSON.stringify(m?.words)} signer ${m?.signer?.slice(0, 8)})`);
    assert(m?.photo?.state === 'verified' && m?.photo?.dataUri === photo.uri, `and its photo, verified the same (got ${m?.photo?.state})`);
    assert(!view.text.includes(t1.text) && !view.text.includes(t2.text), 'the view holds nothing else of the chat');
    assert(view.headers['cache-control'] === 'private, no-store', 'and no cache on the way keeps it');
    const list = await call('GET', null, '/api/local/admin/reports?status=open', undefined, admin);
    const listed = (list.body?.reports ?? []).find((r: any) => r.id === repId);
    assert(list.status === 200 && listed?.targetMessageId === photo.id && listed?.groupMessage?.groupName === 'Garden Crew' && listed?.groupMessage?.photo === true,
        `the Reports list names the message, its group and that it is a photo (got ${JSON.stringify(listed)?.slice(0, 240)})`);
    assert(!list.text.includes(photo.text) && !list.text.includes(b64(mkOf(photo))), 'without opening it, and without its key');

    // ── 2. Forged keys and forged lines ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- 2. "Could not be verified" ---');
    const unverified = async (repIdHere: string, what: string) => {
        const v = await viewOf(repIdHere);
        assert(v.status === 200 && v.body?.message?.words?.state === 'unverified' && v.body?.message?.words?.text === undefined,
            `${what}: the view answers, and reads "could not be verified" with no words (got ${show(v)})`);
        return v;
    };
    const randomKey = await call('POST', carol, reportPath(g), { messageId: t1.id, reason: 'Spam or scam', disclosure: { epoch: t1.epoch, mk: b64(crypto.randomBytes(32)) } });
    assert(randomKey.status === 200, `a report with a key that opens nothing is still taken: the node opens nothing when it takes one (got ${show(randomKey)})`);
    let v = await unverified(randomKey.body?.report?.id ?? '', 'a random key');
    assert(!v.text.includes(t1.text), 'and nothing of the line');
    const otherKey = await call('POST', dave, reportPath(g), { messageId: t2.id, reason: 'Spam or scam', disclosure: { epoch: t2.epoch, mk: b64(mkOf(t1)) } });
    await unverified(otherKey.body?.report?.id ?? '', "another line's key");
    const reattributed = await send(dave, g, 'Sentinel words Dave wrote');
    const reattribRep = await report(alice, reattributed);
    db.prepare("UPDATE messages SET author_pubkey = ?, metadata = json_set(metadata, '$.sender', ?) WHERE id = ?").run(bob.pk, bob.pk, reattributed.id);
    v = await unverified(reattribRep.body?.report?.id ?? '', 'a line the node re-attributed to Bob');
    assert(!v.text.includes(reattributed.text), 'and nothing of its words');
    const altered = await send(bob, g, 'Sentinel words the node alters');
    const alteredRep = await report(alice, altered);
    const ct = Buffer.from((db.prepare('SELECT ciphertext FROM messages WHERE id = ?').get(altered.id) as any).ciphertext, 'base64');
    ct[ct.length - 20] ^= 0x01;
    db.prepare('UPDATE messages SET ciphertext = ? WHERE id = ?').run(ct.toString('base64'), altered.id);
    await unverified(alteredRep.body?.report?.id ?? '', 'a line the node altered by one bit');
    const swapped = await send(bob, g, 'A second photo', { photo: true });
    const swappedRep = await report(alice, swapped);
    const firstAtt = db.prepare('SELECT nonce FROM message_attachments WHERE message_id = ?').get(photo.id) as any;
    const firstBytes = getImageStore().get(`attachments/${photo.id}.bin`);
    getImageStore().put(`attachments/${swapped.id}.bin`, firstBytes!, { mime: 'application/octet-stream', sha256: crypto.createHash('sha256').update(firstBytes!).digest('hex') });
    db.prepare('UPDATE message_attachments SET nonce = ? WHERE message_id = ?').run(firstAtt.nonce, swapped.id);
    v = await viewOf(swappedRep.body?.report?.id ?? '');
    assert(v.status === 200 && v.body?.message?.words?.state === 'verified' && v.body?.message?.photo?.state === 'unverified' && v.body?.message?.photo?.dataUri === undefined,
        `a photo the node swapped for another line's: the words verified, the photo "could not be verified" (got ${show(v)})`);

    // ── 3. Only a line the reporter may read ─────────────────────────────────────────────────────────────────────
    console.log('\n--- 3. Lines the reporter may not read ---');
    const stored = allReports();
    joinGroup(g, nora.pk);
    const noraFrom = (db.prepare('SELECT from_epoch FROM group_members WHERE group_id = ? AND member_pubkey = ?').get(g, nora.pk) as any)?.from_epoch;
    assert(typeof noraFrom === 'number' && noraFrom > photo.epoch, `(Nora's from_epoch ${noraFrom} is after the photo's epoch ${photo.epoch})`);
    let s = await sameAsMissing(nora, g, photo);
    assert(s.ok, `a line from before the reporter's epoch, with its right key: the answer of a missing id (${s.got})`);
    s = await sameAsMissing(erin, g, photo);
    assert(s.ok, `a member of the node who is not in the group: the same (${s.got})`);
    const quiet = createGroup({ name: 'Quiet Room', joinPolicy: 'invite_only', createdBy: alice.pk });
    inviteGroupMember(quiet.id, alice.pk, erin.pk);
    const quietLine = await send(alice, quiet.id, 'Sentinel words of the quiet room');
    s = await sameAsMissing(erin, quiet.id, quietLine);
    assert(s.ok, `an invite-only group, an invitee who has not accepted: the same (${s.got})`);
    s = await sameAsMissing(bob, quiet.id, quietLine);
    assert(s.ok, `an invite-only group, a member of the node outside it: the same (${s.got})`);
    s = await sameAsMissing(alice, g, quietLine);
    assert(s.ok, `another group's line, by this group's path, from a member of both: the same (${s.got})`);
    const joinLine = db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND type = 'system' LIMIT 1").get(g) as { id: string } | undefined;
    s = joinLine ? await sameAsMissing(alice, g, { ...t1, id: joinLine.id }) : { ok: false, got: 'no system line' };
    assert(s.ok, `a system line: the same (${s.got})`);
    removeGroupMember(g, alice.pk, dave.pk);
    s = await sameAsMissing(dave, g, t1);
    assert(s.ok, `a removed member, a line from their time: the same (${s.got})`);
    const signedOut = await report(null, t1);
    assert(signedOut.status === 401, `signed out: 401, as every group route (got ${show(signedOut)})`);
    assert(allReports() === stored, 'and none of them stored anything');

    // ── 4. One report per reporter per message ───────────────────────────────────────────────────────────────────
    console.log('\n--- 4. One report per reporter per message ---');
    const again = await report(alice, photo, { reason: 'Spam or scam' });
    assert(again.status === 200 && again.body?.duplicate === true && again.body?.report?.id === repId && reportRows(alice.pk, photo.id) === 1,
        `the same reporter again: the report on file, no second row (got ${show(again)})`);
    assert((db.prepare('SELECT reason FROM abuse_reports WHERE id = ?').get(repId) as any)?.reason === 'Offensive content: not ok here', 'its reason as filed');
    const dismissed = await call('POST', null, `/api/local/admin/reports/${repId}/dismiss`, {}, admin);
    assert(dismissed.status === 200, `(a moderator dismisses it: ${show(dismissed)})`);
    const afterDismiss = await report(alice, photo);
    assert(afterDismiss.status === 200 && afterDismiss.body?.duplicate === true && afterDismiss.body?.report?.id === repId && reportRows(alice.pk, photo.id) === 1,
        `once dismissed, still the one on file: one report per reporter per message (got ${show(afterDismiss)})`);
    const byCarol = await report(carol, photo);
    assert(byCarol.status === 200 && !byCarol.body?.duplicate && byCarol.body?.report?.id !== repId && reportRows(carol.pk, photo.id) === 1,
        `a second reporter files their own (got ${show(byCarol)})`);
    const toChild = await report(carol, photo, { reason: 'Child safety' });
    assert(toChild.status === 200 && toChild.body?.duplicate === true && reportRows(carol.pk, photo.id) === 1
        && (db.prepare('SELECT reason FROM abuse_reports WHERE id = ?').get(byCarol.body?.report?.id ?? '') as any)?.reason === 'Child safety',
        `a repeat that changes the reason to Child safety changes the pending one (got ${show(toChild)})`);
    const ofBob = await call('POST', alice, '/api/reports', { targetPubkey: bob.pk, reason: 'Spam or scam' });
    assert(ofBob.status === 200 && !ofBob.body?.duplicate && ofBob.body?.report?.id !== repId,
        `a report of Bob himself is its own, not taken for the report of his line (got ${show(ofBob)})`);

    // Child safety on a report a moderator closed (the deciding review of #2470): a new report, as /api/reports files one
    // once nothing is pending, told as a new one is. The closed one is never reopened or changed: an actioned one counts
    // towards a suspension (member-wizards.ts reportMaySuspend).
    const childTold = () => getAlertsStatus().history.filter((e) => e.key === 'reports.child').reduce((n, e) => n + (e.count ?? 1), 0);
    const rowOf = (id: string) => db.prepare('SELECT status, reason, disclosure, updated_at FROM abuse_reports WHERE id = ?').get(id) as any;
    const pendingChild = (reporter: string, messageId: string) => (db.prepare(`SELECT id FROM abuse_reports
        WHERE reporter_pubkey = ? AND target_message_id = ? AND status = 'pending' AND reason = 'Child safety'`).all(reporter, messageId) as { id: string }[]).map((r) => r.id);
    const dismissedRow = rowOf(repId);
    let toldBefore = childTold();
    const childOnDismissed = await report(alice, photo, { reason: 'Child safety' });
    const newOnDismissed = pendingChild(alice.pk, photo.id);
    assert(childOnDismissed.status === 200 && !childOnDismissed.body?.duplicate && newOnDismissed.length === 1
        && childOnDismissed.body?.report?.id === newOnDismissed[0] && reportRows(alice.pk, photo.id) === 2,
        `Child safety on a dismissed report files a new one, pending (got ${show(childOnDismissed)})`);
    assert(childTold() === toldBefore + 1, `and the owners are told of it as a child-safety report, once (${childTold() - toldBefore} told)`);
    assert(dismissedRow?.status === 'reviewed' && dismissedRow?.reason === 'Offensive content: not ok here' && JSON.stringify(rowOf(repId)) === JSON.stringify(dismissedRow),
        `the dismissed one stays as the moderator left it (got ${JSON.stringify(rowOf(repId))?.slice(0, 200)})`);
    const childAgain = await report(alice, photo, { reason: 'Child safety' });
    const otherAgain = await report(alice, photo, { reason: 'Spam or scam' });
    assert(childAgain.body?.duplicate === true && childAgain.body?.report?.id === newOnDismissed[0] && otherAgain.body?.duplicate === true
        && otherAgain.body?.report?.id === newOnDismissed[0] && reportRows(alice.pk, photo.id) === 2 && childTold() === toldBefore + 1
        && rowOf(newOnDismissed[0] ?? '')?.reason === 'Child safety',
        `a further repeat finds the new one, whatever its reason, and adds nothing (got ${show(childAgain)} / ${show(otherAgain)})`);

    const handledLine = await send(bob, g, 'Sentinel words Nora reports twice');
    const firstOfNora = await call('POST', nora, reportPath(g), { messageId: handledLine.id, reason: 'Spam or scam', disclosure: { epoch: handledLine.epoch, mk: b64(crypto.randomBytes(32)) } });
    const noraRepId: string = firstOfNora.body?.report?.id ?? '';
    const handled = await call('POST', null, `/api/local/admin/reports/${noraRepId}/action`, {}, admin);
    const handledRow = rowOf(noraRepId);
    assert(firstOfNora.status === 200 && handled.status === 200 && handledRow?.status === 'actioned',
        `(Nora reports Bob's line with a key that opens nothing, and a moderator marks it handled: ${show(handled)})`);
    toldBefore = childTold();
    const otherOnHandled = await report(nora, handledLine, { reason: 'Offensive content' });
    assert(otherOnHandled.status === 200 && otherOnHandled.body?.duplicate === true && otherOnHandled.body?.report?.id === noraRepId
        && reportRows(nora.pk, handledLine.id) === 1 && childTold() === toldBefore,
        `another reason on a handled report: still the one on file, nothing new (got ${show(otherOnHandled)})`);
    const childOnHandled = await report(nora, handledLine, { reason: 'Child safety' });
    const newOnHandled = pendingChild(nora.pk, handledLine.id);
    assert(childOnHandled.status === 200 && !childOnHandled.body?.duplicate && newOnHandled.length === 1
        && childOnHandled.body?.report?.id === newOnHandled[0] && reportRows(nora.pk, handledLine.id) === 2,
        `Child safety on a handled report files a new one, pending (got ${show(childOnHandled)})`);
    assert(childTold() === toldBefore + 1, `and the owners are told of it once (${childTold() - toldBefore} told)`);
    assert(handledRow?.reason === 'Spam or scam' && JSON.stringify(rowOf(noraRepId)) === JSON.stringify(handledRow),
        `the handled one stays as the moderator left it, actioned (got ${JSON.stringify(rowOf(noraRepId))?.slice(0, 200)})`);
    let newDisclosure: any = null;
    try { newDisclosure = JSON.parse(rowOf(newOnHandled[0] ?? '')?.disclosure); } catch { /* stays null */ }
    const newView = await viewOf(newOnHandled[0] ?? '');
    assert(newDisclosure?.mk === b64(mkOf(handledLine)) && newView.body?.message?.words?.state === 'verified' && newView.body?.message?.words?.text === handledLine.text,
        `the new one keeps the key sent with it, which opens the line (got ${newView.body?.message?.words?.state})`);
    const handledAgain = await report(nora, handledLine, { reason: 'Child safety' });
    assert(handledAgain.body?.duplicate === true && handledAgain.body?.report?.id === newOnHandled[0] && reportRows(nora.pk, handledLine.id) === 2 && childTold() === toldBefore + 1,
        `a further repeat finds the new one and adds nothing (got ${show(handledAgain)})`);

    // The assistant (agent/tools.ts) calls a message's report what it is, and still never sees its key or its words.
    const grant: AgentGrant = { id: 'test-grant', name: 'Test', member: owner.pk, role: 'owner', via: 'token', createdAt: Date.now(), expiresAt: null, canPost: false };
    const tool = (name: string) => AGENT_TOOLS.find((t) => t.name === name)!;
    const got = tool('report_get').run(grant, { report_id: repId }, 'B0UNDARY') as any;
    const listedOpen = tool('reports_list').run(grant, { include_text: true }, 'B0UNDARY') as any;
    const asListed = (listedOpen.result?.reports ?? []).find((r: any) => r.id === newOnDismissed[0]);
    assert(got.ok && got.result?.report?.targetKind === 'group_message' && asListed?.targetKind === 'group_message',
        `the assistant's report_get and reports_list call it a group_message report (got ${got.result?.report?.targetKind} / ${asListed?.targetKind})`);
    const ofMember = tool('report_get').run(grant, { report_id: ofBob.body?.report?.id ?? '' }, 'B0UNDARY') as any;
    assert(ofMember.result?.report?.targetKind === 'member', `a report of the member is still a member report (got ${ofMember.result?.report?.targetKind})`);
    const seen = JSON.stringify([got, listedOpen]);
    assert(!seen.includes(b64(mkOf(photo))) && !seen.includes(b64(mkOf(handledLine))) && !seen.includes(photo.text) && !seen.includes(handledLine.text),
        'and it is given neither the key nor the words');
    // A tool's answer may be a promise (agent/owner-posts.ts creates resize photos first); suggest_action's is not, but is awaited as any.
    const removeIt = await tool('suggest_action').run(grant, { kind: 'remove_reported', report_id: newOnDismissed[0] ?? '', reason: 'Take it down' }, 'B0UNDARY');
    assert(!removeIt.ok, `nor may it suggest removing one, as there is no post to remove (got ${JSON.stringify(removeIt)})`);

    // ── 5. The form ──────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 5. Refusals of form ---');
    const formBefore = allReports();
    const own = await report(bob, t1);
    assert(own.status === 400 && own.body?.code === 'own_message', `a member's own line: 400 own_message (got ${show(own)})`);
    for (const [what, body] of [
        ['no messageId', { reason: 'Spam or scam', disclosure: disclosureOf(t1) }],
        ['a messageId that is no message id', { messageId: 'msg-1', reason: 'Spam or scam', disclosure: disclosureOf(t1) }],
        ['no reason', { messageId: t1.id, disclosure: disclosureOf(t1) }],
        ['an empty reason', { messageId: t1.id, reason: '   ', disclosure: disclosureOf(t1) }],
        ['no disclosure', { messageId: t1.id, reason: 'Spam or scam' }],
        ['a key of 31 bytes', { messageId: t1.id, reason: 'Spam or scam', disclosure: { epoch: t1.epoch, mk: b64(crypto.randomBytes(31)) } }],
        ['a key that is not base64', { messageId: t1.id, reason: 'Spam or scam', disclosure: { epoch: t1.epoch, mk: '!'.repeat(44) } }],
        ['an epoch that is no number', { messageId: t1.id, reason: 'Spam or scam', disclosure: { epoch: '1', mk: b64(mkOf(t1)) } }],
    ] as const) {
        const r = await call('POST', carol, reportPath(g), body);
        assert(r.status === 400, `${what}: 400 (got ${show(r)})`);
    }
    const wrongEpoch = await call('POST', carol, reportPath(g), { messageId: t1.id, reason: 'Spam or scam', disclosure: { epoch: t1.epoch + 1, mk: b64(mkOf(t1)) } });
    assert(wrongEpoch.status === 400 && wrongEpoch.body?.code === 'disclosure_epoch', `a disclosure under another epoch than the line's: 400 disclosure_epoch (got ${show(wrongEpoch)})`);
    assert(allReports() === formBefore, 'and none stored anything');
    const busy = member('Busy');
    joinGroup(g, busy.pk);
    const busyLine = await send(bob, g, 'Sentinel words for the limit');
    const insert = db.prepare('INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, reason, created_at) VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < REPORTS_PER_REPORTER_PER_HOUR; i++) insert.run(crypto.randomUUID(), busy.pk, bob.pk, 'Spam or scam', new Date().toISOString());
    const limited = await report(busy, busyLine);
    assert(limited.status === 429 && reportRows(busy.pk, busyLine.id) === 0, `past the hour's reports: 429, nothing stored (got ${show(limited)})`);

    // ── 6. Who reaches the view ──────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 6. The moderators\' view ---');
    const asMod = await viewOf(byCarol.body?.report?.id ?? '', modSession());
    assert(asMod.status === 200 && asMod.body?.message?.words?.state === 'verified', `a moderator's session opens it (got ${show(asMod)})`);
    const asMember = await call('GET', alice, `/api/local/admin/reports/${repId}/message`);
    resetAdminAuthTarpit();
    assert(asMember.status === 401 || asMember.status === 403, `a member's signature alone does not (got ${asMember.status})`);
    assert(!asMember.text.includes(photo.text), 'and is given nothing of it');
    const post = createPost('offer', 'other', 'Sentinel post', 'A post', 0, 'fixed', bob.pk);
    const ofPost = await call('POST', alice, '/api/reports', { targetPubkey: bob.pk, targetPostId: post?.id, reason: 'Spam or scam' });
    const postView = await viewOf(ofPost.body?.report?.id ?? '');
    assert(ofPost.status === 200 && postView.status === 404, `a report of a post has no message to open: 404 (got ${show(postView)})`);
    const memberView = await viewOf(ofBob.body?.report?.id ?? '');
    assert(memberView.status === 404, `nor a report of a member (got ${show(memberView)})`);
    const noneView = await viewOf(crypto.randomUUID());
    assert(noneView.status === 404, `nor an id no report has (got ${show(noneView)})`);

    // ── 7. Deleted after the report ──────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 7. The author deletes the line ---');
    const deleted = await send(bob, g, 'Sentinel words Bob will delete');
    const deletedRep = await report(alice, deleted);
    const del = await call('POST', bob, '/api/messages/delete', { messageId: deleted.id });
    assert(del.status === 200, `(Bob deletes it for everyone: ${show(del)})`);
    v = await viewOf(deletedRep.body?.report?.id ?? '');
    assert(v.status === 200 && v.body?.message?.words?.state === 'gone' && v.body?.message?.words?.by === 'author' && !v.text.includes(deleted.text),
        `the view says its author deleted it, and has nothing of it (got ${show(v)})`);
    const removed = await send(bob, g, 'Sentinel words a convenor removes');
    const removedRep = await report(carol, removed);
    const rem = await call('POST', alice, `/api/groups/${g}/chat/remove`, { messageId: removed.id });
    v = await viewOf(removedRep.body?.report?.id ?? '');
    assert(rem.status === 200 && v.body?.message?.words?.state === 'gone' && v.body?.message?.words?.by === 'convenor',
        `a convenor's removal reads as theirs (got ${show(v)})`);

    // ── 8. A standby copy, and a take-over ───────────────────────────────────────────────────────────────────────
    console.log('\n--- 8. A standby copy carries the report and its key ---');
    const cols = 'id, reporter_pubkey, target_pubkey, target_post_id, target_pulse_item_id, target_message_id, disclosure, reason, status, created_at, updated_at';
    const onMain = db.prepare(`SELECT ${cols} FROM abuse_reports WHERE target_message_id IS NOT NULL ORDER BY id`).all() as any[];
    const payload: any = await exportSyncState(nodeId);
    const carried = (payload.abuseReports ?? []).find((r: any) => r.id === repId);
    assert(carried?.targetMessageId === photo.id && carried?.disclosure === row?.disclosure,
        `the copy carries the report with its message and its key (got ${JSON.stringify(carried)?.slice(0, 200)})`);
    const since = new Date(Date.now() - 1000).toISOString();
    const late = await send(bob, g, 'Sentinel words reported late');
    const lateRep = await report(carol, late);
    const delta: any = await exportSyncState(nodeId, since);
    const lateCarried = (delta.abuseReports ?? []).find((r: any) => r.id === lateRep.body?.report?.id);
    assert(!!lateCarried && lateCarried.targetMessageId === late.id && typeof lateCarried.disclosure === 'string', 'and a delta carries a new one the same');
    emptyCopiedTables(db);
    // A standby never holds a chat photo (G4: message_attachments is local), so a server that took over has none.
    for (const a of db.prepare('SELECT message_id FROM message_attachments').all() as { message_id: string }[]) {
        try { getImageStore().delete(`attachments/${a.message_id}.bin`); } catch { /* gone already */ }
    }
    db.prepare('DELETE FROM message_attachments').run();
    setNodeRole('backup');
    await importRemoteState(payload);
    setNodeRole('primary');
    const onStandby = db.prepare(`SELECT ${cols} FROM abuse_reports WHERE target_message_id IS NOT NULL AND id != ? ORDER BY id`).all(lateRep.body?.report?.id ?? '') as any[];
    assert(onMain.length >= 8 && JSON.stringify(onStandby) === JSON.stringify(onMain),
        `on the standby every message report is the main server's, column for column (${onStandby.length} of ${onMain.length})`);
    admin = ownerTokenHeaders('admin');
    v = await viewOf(repId);
    assert(v.status === 200 && v.body?.message?.words?.state === 'verified' && v.body?.message?.words?.text === photo.text,
        `on a server that took over, the words open, verified (got ${show(v)})`);
    assert(v.body?.message?.photo?.state === 'unavailable' && v.body?.message?.photo?.dataUri === undefined,
        `and the photo reads unavailable: chat photos are not copied to a standby (got ${JSON.stringify(v.body?.message?.photo)})`);
    // A report changed to Child safety on the main server reaches a standby that holds it already (the review of #2470):
    // the delta carries the new reason with its updated_at, and the copy takes both, so a server that took over lists it
    // first. The change is made here as the main server makes it, then this copy is put back to the standby's.
    const toChange = onStandby.find((r: any) => r.status === 'pending' && r.reason !== 'Child safety');
    const sinceChange = new Date(Date.now() - 1000).toISOString();
    const changedOnMain = toChange ? changeGroupLineReportReason(toChange.id, 'Child safety') : null;
    const changeDelta: any = await exportSyncState(nodeId, sinceChange);
    const changeCarried = (changeDelta.abuseReports ?? []).find((r: any) => r.id === toChange?.id);
    assert(!!changedOnMain && changeCarried?.reason === 'Child safety' && changeCarried?.updatedAt > toChange.updated_at,
        `(the main server changes a pending one to Child safety, and its delta carries it: ${JSON.stringify(changeCarried)?.slice(0, 160)})`);
    if (toChange) db.prepare('UPDATE abuse_reports SET reason = ?, updated_at = ? WHERE id = ?').run(toChange.reason, toChange.updated_at, toChange.id);
    setNodeRole('backup');
    await importRemoteState(changeDelta);
    setNodeRole('primary');
    const changedOnStandby = toChange ? db.prepare('SELECT reason, updated_at FROM abuse_reports WHERE id = ?').get(toChange.id) as any : null;
    assert(changedOnStandby?.reason === 'Child safety' && changedOnStandby?.updated_at === changeCarried?.updatedAt,
        `a standby that holds the report takes the new reason with its updated_at (got ${JSON.stringify(changedOnStandby)})`);

    console.log(`\n${passed}/${run} passed`);
    try { await p2p.stop(); } catch { /* stopping only */ }
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error('❌ Test crashed:', e); console.log(`\n${passed}/${run} passed`); process.exit(1); });

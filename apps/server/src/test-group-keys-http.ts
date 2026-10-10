/**
 * Group chats, step 2: the node keeps only locked lines, and the keys members made (scratch/global-node/DESIGN-group-chat-
 * encryption-fable.md §2–§3, §14, Appendix A–B; DESIGN-group-chat-wrap-provenance-fable.md §5.3, §8). Over REAL HTTPS
 * through the real signature middleware, with real Ed25519 identities and @beanpool/core's group locks on the members'
 * side, so every key opened below is opened the way an app opens it:
 *
 *   1. a group with no epoch refuses a line (epoch_needed); POST …/keys/epoch refuses a record with a wrong membersDigest,
 *      a wrong wrapsDigest, a bad signature, a recipient set that is not the active set, an epoch that is not current+1,
 *      or a maker who is not the signer, writing nothing; a correct one is 201, the row holds the three digests and one
 *      wrap per recipient with sig null
 *   2. a join takes the joiner's epoch in the same transaction; a refused epoch rolls the join back; a real sealed line
 *      opens for another member from GET …/keys (record without its wraps + their own wrap), and its words are nowhere
 *      on the node
 *   3. a join without an epoch (an old app) applies and makes the epoch stale: a line is refused until a member rotates;
 *      a line under an older epoch is refused; the newcomer is served nothing from before their membership (keys, lines,
 *      an epoch's wraps, a top-up)
 *   4. a convenor's removal is the rotation; one that still wraps the removed member is refused and rolled back
 *   5. top-ups: …/keys/missing lists a member who lacks a wrap; a member's top-up is 201 and is served with its sig; a
 *      second is 409; GET …/keys never returns another member's wrap; ?after and ?epochs bound the answer;
 *      GET …/keys/:epoch/wraps hashes to the stored wraps_digest
 *   6. the node operator: a wrap of its own making (wrapper named as the maker), a top-up signed by a key in no roster, a
 *      top-up by a member holding another key, a forged epoch record, and a rolled-back epoch: each refused, measured on
 *      the member's side; the node refuses a line under the old epoch and a replayed older record
 *   7. a non-member, a removed member, someone who left and a member of another group: every key route refused; an
 *      invite-only group answers an outsider 404; another group's record is refused here
 *   8. day zero: a readable group line from before becomes a tombstone with one system line per group; idempotent
 *   9. a re-key drops the old key's wraps (engine/key-move.ts), and the member shows as missing under the new key
 *
 * Run through the runner: SERVER_SUITES_ONLY=test-group-keys-http node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import fs from 'node:fs';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, createGroup } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { resetChatRateLimit } from './chat-rate-limit.js';
import { setMemberPhoto } from '@beanpool/engine';
import { issueRekeyCode, completeRekey } from './engine/member-wizards.js';
import {
    dmPublicKeyOf, groupEpochCanonical, groupKeyCommit, groupMembersDigest, groupWrapsDigest, makeGroupEpochRecord, makeGroupTopUp,
    openGroupLine, openMyGroupKey, sealGroupLine, verifyGroupEpochRecord, wrapGroupKey, GROUP_NONCE_PREFIX,
    type GroupEpochReason, type GroupEpochRecord, type GroupServedWrap,
} from '@beanpool/core';
import { ed25519 } from '@noble/curves/ed25519.js';
// Loaded at run time, so on a server without them (origin/main, the fail-first run) the suite reports a count, not a crash.
const groupThread: any = await import('./engine/group-thread.js');
const groupKeys: any = await import('./engine/group-keys.js').catch(() => null);

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function refuses(fn: () => unknown, match: RegExp, msg: string): void {
    run++;
    try {
        fn();
        console.error(`✗ ${msg} (it opened)`);
    } catch (e: any) {
        if (match.test(e?.message ?? '')) { passed++; console.log(`✓ ${msg}`); }
        else console.error(`✗ ${msg} (refused, but for "${e?.message}")`);
    }
}

const AVATAR = 'https://example.com/a.jpg';
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
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    return id;
}

interface Res { status: number; body: any }
async function call(method: 'GET' | 'POST' | 'DELETE', signer: Id, path: string, body?: unknown): Promise<Res> {
    resetGatewayRateLimit();
    resetChatRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const headers: Record<string, string> = {
        'X-Public-Key': signer.pk,
        'X-Signature': crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), signer.priv).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* empty or not JSON */ }
    return { status: res.status, body: parsed };
}

/** -1 where the table isn't there (origin/main, the fail-first run). */
const count = (sql: string, ...a: unknown[]) => { try { return (db.prepare(sql).get(...a) as { n: number }).n; } catch { return -1; } };
const epochRows = (g: string) => count('SELECT COUNT(*) AS n FROM group_key_epochs WHERE group_id = ?', g);
const wrapRows = (g: string) => count('SELECT COUNT(*) AS n FROM group_key_wraps WHERE group_id = ?', g);
const isActive = (g: string, pk: string) => !!db.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND member_pubkey = ? AND status = 'active'").get(g, pk);
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const sha256Utf8 = (s: string): Uint8Array => crypto.createHash('sha256').update(s, 'utf8').digest();

/** An epoch made on `maker`'s side, as an app makes one. */
function epochBy(maker: Id, groupId: string, epoch: number, reason: GroupEpochReason, recipients: Id[], subject: Id | null = null) {
    return makeGroupEpochRecord({
        myEdPrivHex: maker.seedHex, groupId, epoch, reason, subject: subject?.pk ?? null, createdAt: new Date().toISOString(),
        recipients: recipients.map((r) => r.pk),
    });
}
/** Re-sign a changed record as `signer`: what a modified app could send. */
function resign(r: Omit<GroupEpochRecord, 'sig'>, signer: Id): GroupEpochRecord {
    return { ...r, sig: b64(ed25519.sign(sha256Utf8(groupEpochCanonical(r)), Buffer.from(signer.seedHex, 'hex'))) };
}

/** A member's side: fetch …/keys, verify the record and open my wrap for `epoch` against the roster the node serves. */
async function myKey(who: Id, groupId: string, epoch: number, served?: Res): Promise<Uint8Array> {
    const keys = served ?? await call('GET', who, `/api/groups/${groupId}/keys`);
    const rec = (keys.body.epochs as any[]).find((e) => e.epoch === epoch);
    const wrap = (keys.body.myWraps as any[]).find((w) => w.epoch === epoch) as GroupServedWrap | undefined;
    if (!rec || !wrap) throw new Error(`no record or wrap for epoch ${epoch}`);
    const record: GroupEpochRecord = { groupId, ...rec };
    return openMyGroupKey(record, wrap, who.seedHex, { groupId, activeMembers: keys.body.roster });
}

async function main(): Promise<void> {
    console.log('\n=== Group chats: the server keeps only locked lines ===\n');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    const ana = member('Ana');
    const ben = member('Ben');
    const cat = member('Cat');
    const dov = member('Dov');
    const eve = member('Eve');
    const fay = member('Fay');

    const group = createGroup({ name: 'Seed Library', joinPolicy: 'open', createdBy: ana.pk });
    const G = group.id;
    const keysPath = `/api/groups/${G}/keys`;
    const sendLine = (who: Id, payload: { ciphertext: string; nonce: string }, meta: Record<string, unknown>, clientId: string = crypto.randomUUID()) =>
        call('POST', who, `/api/groups/${G}/chat/message`, { ...payload, metadata: meta, clientId });

    // ── 1. the first epoch ─────────────────────────────────────────────────────────────────────────
    console.log('── 1. the first epoch, and what POST …/keys/epoch refuses ──');
    const k0 = await call('GET', ana, keysPath);
    assert(k0.status === 200 && k0.body.current === null && k0.body.fromEpoch === null && JSON.stringify(k0.body.roster) === JSON.stringify([ana.pk]),
        `a group with no epoch: current null, Ana's roster of one (got ${k0.status} ${JSON.stringify(k0.body)})`);
    const noKeyYet = await sendLine(ana, { ciphertext: b64(crypto.randomBytes(120)), nonce: GROUP_NONCE_PREFIX + b64(crypto.randomBytes(24)) }, { epoch: 1 });
    assert(noKeyYet.status === 409 && noKeyYet.body.code === 'epoch_needed', `a line before any epoch is refused: epoch_needed (got ${noKeyYet.status} ${noKeyYet.body?.code})`);

    const start = epochBy(ana, G, 1, 'start', [ana]);
    const bad: [string, unknown, number, RegExp | string][] = [];
    const { wraps: startWraps, ...startHead } = start.record;
    bad.push(['a wrong membersDigest (re-signed)', resign({ ...startHead, membersDigest: groupMembersDigest([ana.pk, eve.pk]), wraps: startWraps }, ana), 400, /recipients are not the ones its digest names/]);
    bad.push(['a wrong wrapsDigest (re-signed)', resign({ ...startHead, wrapsDigest: b64(sha256Utf8('x')), wraps: startWraps }, ana), 400, /wraps are not the ones its digest names/]);
    bad.push(['a bad signature', { ...start.record, sig: b64(new Uint8Array(64).fill(1)) }, 400, /signature/]);
    const toEve = epochBy(ana, G, 1, 'start', [ana, eve]);
    bad.push(['a recipient set that is not the active set (Eve wrapped in)', toEve.record, 409, 'epoch_conflict']);
    bad.push(['an epoch that is not current + 1', epochBy(ana, G, 2, 'rotate', [ana]).record, 409, 'epoch_conflict']);
    bad.push(['no wraps (the served shape)', startHead, 400, 'epoch_refused']);
    for (const [what, rec, status, why] of bad) {
        const r = await call('POST', ana, `${keysPath}/epoch`, { epoch: rec });
        const ok = r.status === status && (typeof why === 'string' ? r.body?.code === why : why.test(r.body?.error ?? ''));
        assert(ok && epochRows(G) === 0 && wrapRows(G) === 0, `refused, nothing written: ${what} (got ${r.status} ${r.body?.code} ${r.body?.error})`);
    }
    // Ben (not yet a member) carries Ana's record: refused before anything reads it.
    const notMine = await call('POST', ben, `${keysPath}/epoch`, { epoch: start.record });
    assert(notMine.status === 403 && epochRows(G) === 0, `a non-member posting a record is refused 403 (got ${notMine.status})`);
    const made = await call('POST', ana, `${keysPath}/epoch`, { epoch: start.record });
    const row1 = db.prepare('SELECT * FROM group_key_epochs WHERE group_id = ? AND epoch = 1').get(G) as any;
    assert(made.status === 201 && row1?.key_commit === start.record.keyCommit && row1.members_digest === start.record.membersDigest
        && row1.wraps_digest === start.record.wrapsDigest && row1.sig === start.record.sig && row1.created_by === ana.pk,
        `a correct record is 201 and its row holds the three digests and the signature (got ${made.status} ${JSON.stringify(made.body)})`);
    const w1 = db.prepare('SELECT * FROM group_key_wraps WHERE group_id = ? AND epoch = 1').all(G) as any[];
    assert(w1.length === 1 && w1[0].recipient_pubkey === ana.pk && w1[0].sig === null && w1[0].wrapper_pubkey === ana.pk, 'one wrap per recipient, sig null, the maker as wrapper');
    const dup = await call('POST', ana, `${keysPath}/epoch`, { epoch: start.record });
    assert(dup.status === 409 && epochRows(G) === 1, `the same record again is 409 (got ${dup.status})`);

    // ── 2. a join with its epoch, and a real line ──────────────────────────────────────────────────
    console.log('\n── 2. a join takes the joiner\'s epoch; a real line opens for another member ──');
    const benShort = epochBy(ben, G, 2, 'join', [ben], ben);
    const benRefused = await call('POST', ben, `/api/groups/${G}/join`, { epoch: benShort.record });
    assert(benRefused.status === 409 && benRefused.body.code === 'epoch_conflict' && !isActive(G, ben.pk) && epochRows(G) === 1,
        `a join whose epoch leaves Ana out is refused, and the join is rolled back with it (got ${benRefused.status} ${benRefused.body?.code})`);
    const benJoin = epochBy(ben, G, 2, 'join', [ana, ben], ben);
    const joined = await call('POST', ben, `/api/groups/${G}/join`, { epoch: benJoin.record });
    assert(joined.status === 200 && isActive(G, ben.pk) && epochRows(G) === 2, `Ben joins with his own epoch 2, in one request (got ${joined.status} ${JSON.stringify(joined.body)})`);

    const words = 'Swap day is Saturday at the hall 🌱';
    const msgId = crypto.randomUUID();
    const sealed = sealGroupLine(words, { myEdPrivHex: ana.seedHex, groupKey: benJoin.groupKey, groupId: G, epoch: 2, messageId: msgId });
    const noId = await call('POST', ana, `/api/groups/${G}/chat/message`, { ...sealed, metadata: { epoch: 2 } });
    assert(noId.status === 400 && /sealed under/.test(noId.body?.error ?? ''), `a sealed line sent without the id it was sealed under is refused: it could never open (got ${noId.status})`);
    const sent = await call('POST', ana, `/api/groups/${G}/chat/message`, { ...sealed, metadata: { epoch: 2 }, clientId: msgId });
    assert(sent.status === 201 && sent.body.message.id === msgId, `Ana sends a real sealed line under epoch 2 (got ${sent.status} ${JSON.stringify(sent.body?.error ?? '')})`);
    const benKey = await myKey(ben, G, 2);
    const line = (await call('GET', ben, `/api/groups/${G}/chat`)).body.messages.find((m: any) => m.id === msgId);
    const opened = openGroupLine({ ciphertext: line.ciphertext, nonce: line.nonce }, { groupId: G, epoch: 2, senderPubHex: ana.pk, messageId: msgId }, benKey);
    assert(opened.text === words, 'Ben opens it from GET …/keys (record without its wraps, his own wrap) and reads Ana\'s words, signature verified');
    const everything = JSON.stringify(db.prepare('SELECT * FROM messages WHERE conversation_id = ?').all(G))
        + JSON.stringify(db.prepare('SELECT * FROM group_key_epochs').all()) + JSON.stringify(db.prepare('SELECT * FROM group_key_wraps').all());
    assert(!everything.includes('Swap day') && !everything.includes(Buffer.from(words).toString('base64').slice(0, 16))
        && !everything.includes(Buffer.from(benJoin.groupKey).toString('hex')) && !everything.includes(b64(benJoin.groupKey)),
        'neither the words nor the epoch key are anywhere in the node\'s messages or key tables');

    // ── 3. a join without an epoch, stale, and fromEpoch ───────────────────────────────────────────
    console.log('\n── 3. an old app\'s join: stale; the newcomer sees nothing from before ──');
    const catJoin = await call('POST', cat, `/api/groups/${G}/join`, {});
    assert(catJoin.status === 200 && isActive(G, cat.pk), 'Cat joins with no epoch (an old app): the join applies');
    const k3 = await call('GET', ana, keysPath);
    assert(k3.body.current === 2 && k3.body.stale === true, 'and the current epoch is now stale');
    const staleLine = sealGroupLine('hello Cat', { myEdPrivHex: ana.seedHex, groupKey: benJoin.groupKey, groupId: G, epoch: 2, messageId: crypto.randomUUID() });
    const staleSent = await sendLine(ana, staleLine, { epoch: 2 });
    assert(staleSent.status === 409 && staleSent.body.code === 'epoch_stale' && JSON.stringify(staleSent.body.roster) === JSON.stringify([ana.pk, ben.pk, cat.pk].sort()),
        `a line under the stale epoch is refused 409 epoch_stale, with the roster to rotate to (got ${staleSent.status} ${staleSent.body?.code})`);
    const old1 = await sendLine(ana, sealGroupLine('old key', { myEdPrivHex: ana.seedHex, groupKey: start.groupKey, groupId: G, epoch: 1, messageId: crypto.randomUUID() }), { epoch: 1 });
    assert(old1.status === 409 && old1.body.code === 'epoch_not_current', `a line under an older epoch is refused (got ${old1.status} ${old1.body?.code})`);
    const anasByBen = await call('POST', ben, `${keysPath}/epoch`, { epoch: epochBy(ana, G, 3, 'rotate', [ana, ben, cat]).record });
    assert(anasByBen.status === 403 && anasByBen.body.code === 'epoch_refused' && count('SELECT COUNT(*) AS n FROM group_key_epochs WHERE group_id = ? AND epoch = 3', G) === 0,
        `a record Ana made and signed, sent by Ben, is refused 403 and not stored: an epoch is made by its sender (got ${anasByBen.status} ${anasByBen.body?.code})`);
    const rot3 = epochBy(ben, G, 3, 'rotate', [ana, ben, cat]);
    const rotated = await call('POST', ben, `${keysPath}/epoch`, { epoch: rot3.record });
    assert(rotated.status === 201, `any member rotates (Ben, epoch 3, reason rotate) (got ${rotated.status} ${JSON.stringify(rotated.body)})`);
    const id3 = crypto.randomUUID();
    const sent3 = await sendLine(ana, sealGroupLine('welcome Cat', { myEdPrivHex: ana.seedHex, groupKey: rot3.groupKey, groupId: G, epoch: 3, messageId: id3 }), { epoch: 3 }, id3);
    assert(sent3.status === 201, 'and the line goes under epoch 3');
    const catKeys = await call('GET', cat, keysPath);
    assert(catKeys.body.fromEpoch === 3 && catKeys.body.epochs.every((e: any) => e.epoch >= 3) && catKeys.body.myWraps.every((w: any) => w.epoch >= 3),
        `Cat's fromEpoch is 3: no record or wrap from before he joined (got ${JSON.stringify(catKeys.body.epochs.map((e: any) => e.epoch))})`);
    assert(Buffer.from(await myKey(cat, G, 3, catKeys)).equals(Buffer.from(rot3.groupKey)), 'Cat opens epoch 3');
    const catAsks = await call('GET', cat, `${keysPath}?epochs=1,2,3`);
    assert(catAsks.status === 200 && JSON.stringify(catAsks.body.epochs.map((e: any) => e.epoch)) === '[3]' && catAsks.body.myWraps.every((w: any) => w.epoch >= 3),
        `asking for epochs 1, 2 and 3 by number, Cat is served only 3 (got ${JSON.stringify(catAsks.body.epochs?.map((e: any) => e.epoch))})`);
    const catChat = (await call('GET', cat, `/api/groups/${G}/chat`)).body;
    assert(!catChat.messages.some((m: any) => m.id === msgId) && catChat.messages.some((m: any) => m.id === id3),
        "Cat's chat leaves out Ana's epoch-2 line and shows the epoch-3 one" + ` (got ${JSON.stringify(catChat.messages.map((m: any) => [m.id === msgId ? 'e2' : m.id === id3 ? 'e3' : m.type, m.metadata]))})`);
    const catGeneric = await call('GET', cat, `/api/messages/${G}`);
    assert(catGeneric.status === 200 && !catGeneric.body.messages.some((m: any) => m.id === msgId), 'so does the ordinary read route old apps use');
    assert(catChat.encryption?.current === 3 && catChat.encryption.stale === false && catChat.encryption.fromEpoch === 3, 'the chat answer carries its lock: current, stale, fromEpoch');
    assert((await call('GET', cat, `${keysPath}/2/wraps`)).status === 404, "Cat can't fetch epoch 2's wraps");
    const backTopUp = makeGroupTopUp(benJoin.groupKey, { myEdPrivHex: ana.seedHex, groupId: G, epoch: 2, recipientPubHex: cat.pk });
    const below = await call('POST', ana, `${keysPath}/wrap`, backTopUp);
    assert(below.status === 403 && below.body.code === 'wrap_below_membership' && !db.prepare('SELECT 1 FROM group_key_wraps WHERE group_id = ? AND epoch = 2 AND recipient_pubkey = ?').get(G, cat.pk),
        `nobody may hand Cat a key from before his membership (got ${below.status} ${below.body?.code})`);

    // ── 4. removal ─────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. a removal is the rotation ──');
    // makeGroupEpochRecord itself refuses a removal that keeps the removed member: a modified app's record, re-signed.
    const keepsCat = resign({ ...epochBy(ana, G, 4, 'rotate', [ana, ben, cat]).record, reason: 'remove', subject: cat.pk }, ana);
    const r1 = await call('DELETE', ana, `/api/groups/${G}/members/${cat.pk}`, { epoch: keepsCat });
    assert(r1.status === 400 && isActive(G, cat.pk) && epochRows(G) === 3, `a removal whose epoch still wraps Cat is refused and Cat stays (got ${r1.status} ${r1.body?.error})`);
    const rem4 = epochBy(ana, G, 4, 'remove', [ana, ben], cat);
    const r2 = await call('DELETE', ana, `/api/groups/${G}/members/${cat.pk}`, { epoch: rem4.record });
    assert(r2.status === 200 && !isActive(G, cat.pk) && epochRows(G) === 4, `the convenor removes Cat with epoch 4, wrapped to Ana and Ben only (got ${r2.status} ${JSON.stringify(r2.body)})`);
    assert(!db.prepare('SELECT 1 FROM group_key_wraps WHERE group_id = ? AND epoch = 4 AND recipient_pubkey = ?').get(G, cat.pk), 'no wrap of epoch 4 for Cat');

    // ── 5. top-ups and what …/keys serves ──────────────────────────────────────────────────────────
    console.log('\n── 5. top-ups; GET …/keys serves only my own wraps ──');
    db.prepare('DELETE FROM group_key_wraps WHERE group_id = ? AND epoch = 4 AND recipient_pubkey = ?').run(G, ben.pk); // a wrap lost to a bug
    const missing = await call('GET', ana, `${keysPath}/missing`);
    const benMissing = missing.body.missing.find((m: any) => m.pubkey === ben.pk);
    assert(missing.status === 200 && missing.body.epoch === 4 && JSON.stringify(benMissing?.epochs) === '[4]' && benMissing.fromEpoch === 2,
        `…/keys/missing lists Ben, lacking epoch 4, from his epoch 2 (got ${JSON.stringify(missing.body)})`);
    const benTopUp = makeGroupTopUp(rem4.groupKey, { myEdPrivHex: ana.seedHex, groupId: G, epoch: 4, recipientPubHex: ben.pk });
    const tu = await call('POST', ana, `${keysPath}/wrap`, benTopUp);
    assert(tu.status === 201, `Ana tops Ben up (got ${tu.status} ${JSON.stringify(tu.body)})`);
    const benK4 = await call('GET', ben, keysPath);
    const served4 = benK4.body.myWraps.find((w: any) => w.epoch === 4);
    assert(served4?.sig === benTopUp.sig && served4.wrapper === ana.pk, 'the served wrap carries the top-up\'s signature and its wrapper');
    assert(Buffer.from(await myKey(ben, G, 4, benK4)).equals(Buffer.from(rem4.groupKey)), 'and Ben opens epoch 4 from it');
    assert((await call('POST', ana, `${keysPath}/wrap`, benTopUp)).status === 409, 'a second top-up of the same is 409');
    const forged = { ...benTopUp, epoch: 3 };
    assert((await call('POST', ana, `${keysPath}/wrap`, forged)).status === 400, 'a top-up whose signature does not cover what it says is 400');
    const anaK = await call('GET', ana, keysPath);
    const anaRows = db.prepare('SELECT epoch, eph_pub FROM group_key_wraps WHERE group_id = ? AND recipient_pubkey = ? ORDER BY epoch').all(G, ana.pk) as any[];
    assert(anaK.body.myWraps.length === anaRows.length && anaK.body.myWraps.every((w: any, i: number) => w.ephPub === anaRows[i].eph_pub)
        && !JSON.stringify(anaK.body).includes(benTopUp.ephPub), 'GET …/keys returns exactly the caller\'s own wraps, never another member\'s');
    const after2 = await call('GET', ana, `${keysPath}?after=2`);
    assert(JSON.stringify(after2.body.epochs.map((e: any) => e.epoch)) === '[3,4]' && after2.body.myWraps.every((w: any) => w.epoch > 2), '?after=2 serves epochs 3 and 4 only');
    const only = await call('GET', ana, `${keysPath}?epochs=4,1`);
    assert(JSON.stringify(only.body.epochs.map((e: any) => e.epoch)) === '[1,4]', '?epochs=4,1 serves those two');
    assert(!('wraps' in only.body.epochs[0]) && JSON.stringify(only.body.epochs[0]).length < 800, 'a served record carries no wraps: a few hundred bytes');
    const tooMany = await call('GET', ana, `${keysPath}?epochs=${Array.from({ length: 101 }, (_, i) => i + 1).join(',')}`);
    assert(tooMany.status === 400, '?epochs is capped at 100');
    const all4 = await call('GET', ana, `${keysPath}/4/wraps`);
    const stored4 = (db.prepare('SELECT wraps_digest FROM group_key_epochs WHERE group_id = ? AND epoch = 4').get(G) as any).wraps_digest;
    // Ben's wrap is now a top-up: the epoch's own wraps are the ones its record hashed, Ana's and Ben's original.
    assert(all4.status === 200 && all4.body.wrapsDigest === stored4 && groupWrapsDigest(rem4.record.wraps!) === stored4,
        'GET …/keys/:epoch/wraps answers with the stored wraps_digest, which the record\'s own wraps hash to');
    const anaOnly3 = await call('GET', ana, `${keysPath}/3/wraps`);
    assert(groupWrapsDigest(anaOnly3.body.wraps) === anaOnly3.body.wrapsDigest, "and an untouched epoch's served wraps hash to it exactly");

    // ── 6. the node operator ────────────────────────────────────────────────────────────────────────
    console.log('\n── 6. the node operator: forged wraps, top-ups, records and a rollback, each refused by the member ──');
    const roster = [ana.pk, ben.pk];
    const realBenWrap = db.prepare('SELECT * FROM group_key_wraps WHERE group_id = ? AND epoch = 4 AND recipient_pubkey = ?').get(G, ben.pk) as any;
    const rogueKey = crypto.randomBytes(32);
    const rogue = wrapGroupKey(new Uint8Array(rogueKey), { groupId: G, epoch: 4, recipientPubHex: ben.pk, wrapperPubHex: ana.pk });
    db.prepare('UPDATE group_key_wraps SET wrapper_pubkey = ?, eph_pub = ?, nonce = ?, wrapped = ?, sig = NULL WHERE group_id = ? AND epoch = 4 AND recipient_pubkey = ?')
        .run(ana.pk, rogue.ephPub, rogue.nonce, rogue.wrapped, G, ben.pk);
    const swapped = await call('GET', ben, keysPath);
    let benOpenedRogue = false;
    try { await myKey(ben, G, 4, swapped); benOpenedRogue = true; } catch (e: any) { assert(/commits to/.test(e.message), `a wrap of the node's own making, "from Ana", is refused by the commitment ("${e.message}")`); }
    assert(!benOpenedRogue, 'Ben never holds the node\'s key');
    const outsider = newId('Mallory');
    const rogueTopUp = makeGroupTopUp(new Uint8Array(rogueKey), { myEdPrivHex: outsider.seedHex, groupId: G, epoch: 4, recipientPubHex: ben.pk });
    db.prepare('UPDATE group_key_wraps SET wrapper_pubkey = ?, eph_pub = ?, nonce = ?, wrapped = ?, sig = ? WHERE group_id = ? AND epoch = 4 AND recipient_pubkey = ?')
        .run(outsider.pk, rogueTopUp.ephPub, rogueTopUp.nonce, rogueTopUp.wrapped, rogueTopUp.sig, G, ben.pk);
    refuses(() => openMyGroupKey({ groupId: G, ...(swapped.body.epochs.find((e: any) => e.epoch === 4)) },
        { epoch: 4, wrapper: outsider.pk, ephPub: rogueTopUp.ephPub, nonce: rogueTopUp.nonce, wrapped: rogueTopUp.wrapped, sig: rogueTopUp.sig }, ben.seedHex,
        { groupId: G, activeMembers: roster }), /wrapper is not an active member/, 'a top-up row signed by a key in no roster is refused by the roster check');
    const k4served = (await call('GET', ben, keysPath)).body;
    refuses(() => myKeySync(ben, G, 4, k4served, roster), /wrapper is not an active member/, '… and so it is when served through GET …/keys');
    const wrongByAna = makeGroupTopUp(new Uint8Array(rogueKey), { myEdPrivHex: ana.seedHex, groupId: G, epoch: 4, recipientPubHex: ben.pk });
    db.prepare('UPDATE group_key_wraps SET wrapper_pubkey = ?, eph_pub = ?, nonce = ?, wrapped = ?, sig = ? WHERE group_id = ? AND epoch = 4 AND recipient_pubkey = ?')
        .run(ana.pk, wrongByAna.ephPub, wrongByAna.nonce, wrongByAna.wrapped, wrongByAna.sig, G, ben.pk);
    const k4c = (await call('GET', ben, keysPath)).body;
    refuses(() => myKeySync(ben, G, 4, k4c, roster), /commits to/, "a member's genuine top-up holding another key is refused by the commitment");
    db.prepare('UPDATE group_key_wraps SET wrapper_pubkey = ?, eph_pub = ?, nonce = ?, wrapped = ?, sig = ? WHERE group_id = ? AND epoch = 4 AND recipient_pubkey = ?')
        .run(realBenWrap.wrapper_pubkey, realBenWrap.eph_pub, realBenWrap.nonce, realBenWrap.wrapped, realBenWrap.sig, G, ben.pk);
    assert(Buffer.from(await myKey(ben, G, 4)).equals(Buffer.from(rem4.groupKey)), 'with the real row back, Ben opens epoch 4 again');

    // A forged epoch record: the operator writes epoch 5 "by Ana", committing to its own key, with any signature it can make.
    const operatorKey = crypto.randomBytes(32);
    const forgedRec = { epoch: 5, created_by: ana.pk, reason: 'rotate', created_at: new Date().toISOString(), key_commit: groupKeyCommit(new Uint8Array(operatorKey)),
        members_digest: groupMembersDigest(roster), wraps_digest: b64(sha256Utf8('w')), sig: b64(ed25519.sign(sha256Utf8('x'), Buffer.from(outsider.seedHex, 'hex'))) };
    const opWrap = wrapGroupKey(new Uint8Array(operatorKey), { groupId: G, epoch: 5, recipientPubHex: ben.pk, wrapperPubHex: ana.pk });
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO group_key_epochs (group_id, epoch, created_by, reason, subject_pubkey, created_at, key_commit, members_digest, wraps_digest, sig, stored_at, stale_since, updated_at)
                VALUES (?, 5, ?, 'rotate', NULL, ?, ?, ?, ?, ?, ?, NULL, ?)`).run(G, forgedRec.created_by, forgedRec.created_at, forgedRec.key_commit, forgedRec.members_digest, forgedRec.wraps_digest, forgedRec.sig, now, now);
    db.prepare(`INSERT INTO group_key_wraps (group_id, epoch, recipient_pubkey, wrapper_pubkey, eph_pub, nonce, wrapped, sig, created_at, updated_at) VALUES (?, 5, ?, ?, ?, ?, ?, NULL, ?, ?)`)
        .run(G, ben.pk, ana.pk, opWrap.ephPub, opWrap.nonce, opWrap.wrapped, now, now);
    const k5 = (await call('GET', ben, keysPath)).body;
    assert(k5.current === 5, 'the node now serves its forged epoch 5 as current');
    refuses(() => myKeySync(ben, G, 5, k5, roster), /signature/, 'a forged epoch record is refused: its signature is not Ana\'s');
    db.prepare('DELETE FROM group_key_wraps WHERE group_id = ? AND epoch = 5').run(G);
    db.prepare('DELETE FROM group_key_epochs WHERE group_id = ? AND epoch = 5').run(G);

    // A rolled-back epoch: the operator drops epoch 4 (the removal) and serves 3 as current, so Cat could read again.
    const ep4 = db.prepare('SELECT * FROM group_key_epochs WHERE group_id = ? AND epoch = 4').get(G) as any;
    const wr4 = db.prepare('SELECT * FROM group_key_wraps WHERE group_id = ? AND epoch = 4').all(G) as any[];
    db.prepare('DELETE FROM group_key_wraps WHERE group_id = ? AND epoch = 4').run(G);
    db.prepare('DELETE FROM group_key_epochs WHERE group_id = ? AND epoch = 4').run(G);
    const rolled = (await call('GET', ana, keysPath)).body;
    const rec3 = { groupId: G, ...rolled.epochs.find((e: any) => e.epoch === 3) } as GroupEpochRecord;
    assert(rolled.current === 3, 'the node now serves epoch 3 as current');
    refuses(() => verifyGroupEpochRecord(rec3, { groupId: G, epoch: 4 }), /another epoch/,
        'Ana, who made epoch 4 and remembers it, refuses 3 as current (the check slices 3–4 run before sealing)');
    assert(rolled.stale === true, "and the node's own check calls epoch 3 stale: it still wraps Cat, who is no longer in the roster");
    const replay = await call('POST', ben, `${keysPath}/epoch`, { epoch: rot3.record });
    assert(replay.status === 409, `a replayed older record is refused (got ${replay.status})`);
    db.prepare(`INSERT INTO group_key_epochs (group_id, epoch, created_by, reason, subject_pubkey, created_at, key_commit, members_digest, wraps_digest, sig,
                stored_at, stale_since, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(ep4.group_id, ep4.epoch, ep4.created_by, ep4.reason, ep4.subject_pubkey, ep4.created_at, ep4.key_commit, ep4.members_digest, ep4.wraps_digest, ep4.sig, ep4.stored_at, ep4.stale_since, ep4.updated_at);
    for (const w of wr4) db.prepare('INSERT INTO group_key_wraps (group_id, epoch, recipient_pubkey, wrapper_pubkey, eph_pub, nonce, wrapped, sig, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(w.group_id, w.epoch, w.recipient_pubkey, w.wrapper_pubkey, w.eph_pub, w.nonce, w.wrapped, w.sig, w.created_at, w.updated_at);
    assert((await call('GET', ana, keysPath)).body.current === 4, 'epoch 4 restored');

    // ── 7. who may touch the keys ───────────────────────────────────────────────────────────────────
    console.log('\n── 7. a non-member, a removed member, a leaver, a member of another group ──');
    const other = createGroup({ name: 'Tool Shed', joinPolicy: 'open', createdBy: dov.pk });
    const otherStart = epochBy(dov, other.id, 1, 'start', [dov]);
    assert((await call('POST', dov, `/api/groups/${other.id}/keys/epoch`, { epoch: otherStart.record })).status === 201, 'Dov starts his own group\'s epoch');
    const benLeaves = await call('DELETE', ben, `/api/groups/${G}/members/${ben.pk}`, {});
    assert(benLeaves.status === 200 && (await call('GET', ana, keysPath)).body.stale === true, 'Ben leaves (no epoch): the current epoch goes stale');
    const routes: [string, 'GET' | 'POST', string, unknown?][] = [
        ['GET …/keys', 'GET', keysPath],
        ['GET …/keys/missing', 'GET', `${keysPath}/missing`],
        ['GET …/keys/4/wraps', 'GET', `${keysPath}/4/wraps`],
        ['POST …/keys/epoch', 'POST', `${keysPath}/epoch`, { epoch: epochBy(ana, G, 5, 'rotate', [ana]).record }],
        ['POST …/keys/wrap', 'POST', `${keysPath}/wrap`, makeGroupTopUp(rem4.groupKey, { myEdPrivHex: ana.seedHex, groupId: G, epoch: 4, recipientPubHex: ana.pk })],
        ['POST …/chat/message', 'POST', `/api/groups/${G}/chat/message`, { ...sealGroupLine('x', { myEdPrivHex: ana.seedHex, groupKey: rem4.groupKey, groupId: G, epoch: 4, messageId: crypto.randomUUID() }), metadata: { epoch: 4 }, clientId: crypto.randomUUID() }],
    ];
    for (const [who, label] of [[eve, 'a non-member'], [cat, 'a removed member'], [ben, 'someone who left'], [dov, 'a member of another group']] as [Id, string][]) {
        const before = `${epochRows(G)}/${wrapRows(G)}`;
        const statuses: number[] = [];
        for (const [, method, path, body] of routes) statuses.push((await call(method, who, path, body)).status);
        assert(statuses.every((s) => s === 403) && `${epochRows(G)}/${wrapRows(G)}` === before, `${label} is refused every key route and the chat, 403, nothing written (got ${statuses.join(',')})`);
    }
    const otherIntoG = await call('POST', ana, `${keysPath}/epoch`, { epoch: { ...epochBy(ana, other.id, 5, 'rotate', [ana]).record } });
    assert(otherIntoG.status === 400 && otherIntoG.body.code === 'epoch_refused', `a record made for another group is refused here (got ${otherIntoG.status} ${otherIntoG.body?.code})`);
    const hidden = createGroup({ name: 'Quiet Room', joinPolicy: 'invite_only', createdBy: fay.pk });
    for (const [, method, path, body] of routes) {
        const r = await call(method, eve, path.replace(G, hidden.id), body);
        assert(r.status === 404, `an invite-only group answers an outsider 404 on ${method} ${path.replace(`/api/groups/${G}`, '…')} (got ${r.status})`);
    }

    // ── 8. day zero ─────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 8. day zero: readable lines go ──');
    const legacy = crypto.randomUUID();
    db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp)
                VALUES (?, ?, ?, ?, 'plaintext-v1', 'text', ?, ?)`).run(legacy, other.id, dov.pk, Buffer.from('the shed key is under the pot').toString('base64'),
        JSON.stringify({ mentions: [ana.pk], reactions: [{ emoji: '👍', author: ana.pk }] }), new Date().toISOString());
    const cb = { broadcast: () => { }, dispatchPushNotification: () => { }, registerVisitor: () => { } } as any;
    const wipe = (c: unknown): number => (typeof groupThread.wipeReadableGroupLines === 'function' ? groupThread.wipeReadableGroupLines(c) : -1);
    const wiped = wipe(cb);
    const legacyRow = db.prepare('SELECT * FROM messages WHERE id = ?').get(legacy) as any;
    assert(wiped >= 1 && legacyRow.type === 'removed' && !Buffer.from(legacyRow.ciphertext, 'base64').toString().includes('shed key')
        && !JSON.parse(legacyRow.metadata).mentions && !JSON.parse(legacyRow.metadata).reactions, 'a readable group line becomes a tombstone: words, mentions and reactions gone');
    const lockedLine = db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND system_type = 'GROUP_CHAT_LOCKED' ORDER BY rowid DESC LIMIT 1").get(other.id) as any;
    assert(!!lockedLine && lockedLine.ciphertext === groupThread.GROUP_CHAT_LOCKED_TEXT, 'and the group gets one line saying its chat is now end-to-end encrypted');
    assert(!db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND system_type = 'GROUP_CHAT_LOCKED'").get(G), 'a group with nothing readable gets no such line');
    // The rows are clean; so must the files be. secure_delete zeroes the old words in the pages the wipe writes, but
    // state.db-wal still holds the pages as they were (and state.db once a checkpoint folds them back) until the WAL is
    // emptied, as an account deletion does (review of #1762, finding 2).
    const legacyBytes = [Buffer.from('the shed key is under the pot').toString('base64'), 'the shed key is under the pot'];
    const holds = (file: string): boolean => {
        let buf: Buffer;
        try { buf = fs.readFileSync(file); } catch { return false; }
        return legacyBytes.some((n) => buf.indexOf(Buffer.from(n, 'utf8')) >= 0);
    };
    assert(!holds(db.name), 'state.db holds no byte of a wiped line\'s words');
    assert(!holds(`${db.name}-wal`), 'and neither does state.db-wal: the WAL is emptied after the wipe');
    assert(wipe(cb) === 0, 'a second run finds nothing: idempotent');
    assert(count("SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.type = 'group_thread' AND m.type = 'text' AND m.nonce NOT LIKE 'group-xc20p-v1:%'") === 0,
        'no readable group line is left on the node');

    // ── 9. re-key ───────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 9. a re-key drops the old key\'s wraps ──');
    const anaWraps = count('SELECT COUNT(*) AS n FROM group_key_wraps WHERE recipient_pubkey = ?', ana.pk);
    groupKeys?.dropGroupWrapsOf(ana.pk);
    assert(anaWraps > 0 && count('SELECT COUNT(*) AS n FROM group_key_wraps WHERE recipient_pubkey = ?', ana.pk) === 0, `the old key's ${anaWraps} wraps are gone`);
    const missingAna = (await call('GET', ana, `${keysPath}/missing`)).body.missing.find((m: any) => m.pubkey === ana.pk);
    assert(missingAna?.fromEpoch === 1 && missingAna.epochs.includes(4), 'and the member shows in …/keys/missing from their first epoch');

    // ── 10. a rejoin after a clock step back ────────────────────────────────────────────────────────
    console.log('\n── 10. a rejoin whose joined_at lands after the moment its own epoch is stored ──');
    // Ben's leave was stamped 5 s ahead (the clock stepped back since, or a promoted standby is behind the main server that
    // stamped it), so his rejoin's joined_at is moved past it. His own join epoch must still be his (review finding 6).
    const clock = createGroup({ name: 'Clock Step', joinPolicy: 'open', createdBy: ana.pk });
    const clockKeys = `/api/groups/${clock.id}/keys`;
    assert((await call('POST', ana, `${clockKeys}/epoch`, { epoch: epochBy(ana, clock.id, 1, 'start', [ana]).record })).status === 201, 'a fresh group starts at epoch 1');
    assert((await call('POST', ben, `/api/groups/${clock.id}/join`, { epoch: epochBy(ben, clock.id, 2, 'join', [ana, ben], ben).record })).status === 200, 'Ben joins with epoch 2');
    assert((await call('DELETE', ben, `/api/groups/${clock.id}/members/${ben.pk}`, {})).status === 200, 'Ben leaves');
    db.prepare("UPDATE tombstones SET deleted_at = ? WHERE table_name = 'group_members' AND row_key = ?").run(new Date(Date.now() + 5000).toISOString(), `${clock.id}|${ben.pk}`);
    const rejoin3 = epochBy(ben, clock.id, 3, 'join', [ana, ben], ben);
    assert((await call('POST', ben, `/api/groups/${clock.id}/join`, { epoch: rejoin3.record })).status === 200, 'Ben rejoins with his own epoch 3');
    const benBack = await call('GET', ben, clockKeys);
    assert(benBack.body.fromEpoch === 3 && benBack.body.myWraps.some((w: any) => w.epoch === 3),
        `and is served it: fromEpoch 3 and his wrap (got fromEpoch ${benBack.body.fromEpoch}, wraps ${JSON.stringify(benBack.body.myWraps.map((w: any) => w.epoch))})`);
    assert(Buffer.from(await myKey(ben, clock.id, 3, benBack)).equals(Buffer.from(rejoin3.groupKey)), 'and opens it');

    const pointless = await call('POST', ben, `/api/groups/${clock.id}/join`, { epoch: epochBy(ben, clock.id, 4, 'join', [ana, ben], ben).record });
    assert(pointless.status === 400 && pointless.body.code === 'epoch_not_applicable' && count('SELECT MAX(epoch) AS n FROM group_key_epochs WHERE group_id = ?', clock.id) === 3,
        `joining again while active, with an epoch: 400 epoch_not_applicable, and no epoch 4 is stored (got ${pointless.status} ${pointless.body?.code})`);
    // An edit re-seals under the current epoch and moves the row's epoch with it (§7.4), or nobody could open it.
    const clockLine = crypto.randomUUID();
    const sentE3 = await call('POST', ana, `/api/groups/${clock.id}/chat/message`, {
        ...sealGroupLine('the gate code is 4417', { myEdPrivHex: ana.seedHex, groupKey: rejoin3.groupKey, groupId: clock.id, epoch: 3, messageId: clockLine }), metadata: { epoch: 3 }, clientId: clockLine });
    assert(sentE3.status === 201, 'Ana writes a line under epoch 3');
    const rot4 = epochBy(ben, clock.id, 4, 'rotate', [ana, ben]);
    assert((await call('POST', ben, `${clockKeys}/epoch`, { epoch: rot4.record })).status === 201, 'Ben rotates to epoch 4');
    const edited = sealGroupLine('the gate code is 5528', { myEdPrivHex: ana.seedHex, groupKey: rot4.groupKey, groupId: clock.id, epoch: 4, messageId: clockLine, part: 'edit' });
    const editRes = await call('POST', ana, '/api/messages/edit', { messageId: clockLine, ...edited, metadata: { epoch: 4 } });
    const editedRow = db.prepare('SELECT ciphertext, nonce, metadata FROM messages WHERE id = ?').get(clockLine) as any;
    const editedEpoch = JSON.parse(editedRow.metadata).epoch;
    assert(editRes.status === 200 && editedEpoch === 4, `Ana edits it under epoch 4, and the row's epoch moves to 4 (got ${editRes.status}, epoch ${editedEpoch})`);
    let editedText = '';
    try {
        editedText = openGroupLine({ ciphertext: editedRow.ciphertext, nonce: editedRow.nonce },
            { groupId: clock.id, epoch: editedEpoch, senderPubHex: ana.pk, messageId: clockLine, part: 'edit' }, editedEpoch === 4 ? rot4.groupKey : rejoin3.groupKey).text;
    } catch { /* the epoch the row names does not open it */ }
    assert(editedText === 'the gate code is 5528', `so Ben opens the edit under the epoch the row names (got "${editedText}")`);

    // ── 11. a real re-key ───────────────────────────────────────────────────────────────────────────
    console.log('\n── 11. a real re-key (issueRekeyCode + completeRekey) drops the old key\'s wraps ──');
    const benWrapsBefore = count('SELECT COUNT(*) AS n FROM group_key_wraps WHERE recipient_pubkey = ?', ben.pk);
    const newBen = newId('Ben2');
    completeRekey(ben.pk, newBen.pk, issueRekeyCode(ben.pk, owner.pk).code, owner.pk);
    assert(benWrapsBefore > 0 && count('SELECT COUNT(*) AS n FROM group_key_wraps WHERE recipient_pubkey = ?', ben.pk) === 0,
        `the old key's ${benWrapsBefore} wraps are gone after completeRekey (${count('SELECT COUNT(*) AS n FROM group_key_wraps WHERE recipient_pubkey = ?', ben.pk)} left)`);
    assert(isActive(clock.id, newBen.pk) && !isActive(clock.id, ben.pk), 'and the group row moved to the new key');
    const missingBen = (await call('GET', ana, `${clockKeys}/missing`)).body.missing?.find((m: any) => m.pubkey === newBen.pk);
    assert(missingBen?.fromEpoch === 3 && missingBen.epochs.includes(4), `the new key shows in …/keys/missing from Ben's unchanged joined_at (got ${JSON.stringify(missingBen)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

/** myKey with an answer already fetched. */
function myKeySync(who: Id, groupId: string, epoch: number, served: any, activeMembers: string[]): Uint8Array {
    const rec = (served.epochs as any[]).find((e) => e.epoch === epoch);
    const wrap = (served.myWraps as any[]).find((w) => w.epoch === epoch) as GroupServedWrap;
    return openMyGroupKey({ groupId, ...rec }, wrap, who.seedHex, { groupId, activeMembers });
}

main().catch((e) => {
    console.error(e);
    console.log(`\n${passed}/${run + 1} passed (stopped: ${e?.message ?? e})`);
    process.exit(1);
});

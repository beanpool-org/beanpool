/**
 * Group chats: a re-keyed member's earlier history (scratch/global-node/DESIGN-group-history-after-rekey-fable.md §3, §8
 * S1; Marty's picks of 13 Oct 2026). Over REAL HTTPS through the real signature middleware, real Ed25519 identities and
 * @beanpool/core's records, wraps and statements on the members' side:
 *
 *   K.  a re-key keeps the old key's wraps; the old key is never listed in …/keys/missing, never in a keys roster, and a
 *       top-up to it is refused (it is in no live slot); the new key shows as missing from the unchanged fromEpoch; an
 *       epoch's wraps (…/keys/:epoch/wraps) are again exactly its signed recipients
 *   F.  GET …/keys/former, signed by the successor: the old key's wraps for the epochs the successor lacks, with their
 *       records; each opens with the OLD seed against the record's keyCommit, and with nothing else (the new seed, a
 *       fellow member's). Nothing below the successor's fromEpoch, nothing for a member never re-keyed, an unattested
 *       re-key, a puppet with no claim, or a non-member (404)
 *   N.  the node writes rekeyed_to(A) = P and P signs the statement: A's wraps are served to P, and P's phone opens 0 of
 *       them. A junk row the node writes in A's slot fails the commitment on the member's side
 *   W.  a self top-up: 201, served back in …/keys myWraps, opens with the successor's own seed; then that epoch leaves
 *       …/keys/former; below the fromEpoch still 403 wrap_below_membership; a second one 409
 *   V.  VACUUM INTO (a sealed backup's copy) carries the kept rows
 *
 * Run through the runner: SERVER_SUITES_ONLY=test-group-history-after-rekey node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, createGroup, joinGroup } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { resetChatRateLimit } from './chat-rate-limit.js';
import { setMemberPhoto } from '@beanpool/engine';
import { issueRekeyCode, completeRekey } from './engine/member-wizards.js';
import {
    dmPublicKeyOf, groupEpochCoversExactly, makeGroupEpochRecord, makeGroupTopUp, makeKeySuccession, openGroupKeyWrap, openMyGroupKey,
    type GroupEpochReason, type GroupEpochRecord, type GroupServedWrap,
} from '@beanpool/core';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

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
    setMemberPhoto(db, id.pk, 'https://example.com/a.jpg');
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    return id;
}
function rekey(old: Id, name: string): Id {
    const next = newId(name);
    completeRekey(old.pk, next.pk, issueRekeyCode(old.pk, owner.pk).code, owner.pk);
    return next;
}

interface Res { status: number; body: any }
async function call(method: 'GET' | 'POST', signer: Id, p: string, body?: unknown): Promise<Res> {
    resetGatewayRateLimit();
    resetChatRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const headers: Record<string, string> = {
        'X-Public-Key': signer.pk,
        'X-Signature': crypto.sign(null, Buffer.from(`${method}\n${p.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), signer.priv).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${p}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* empty or not JSON */ }
    return { status: res.status, body: parsed };
}

const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
function epochBy(maker: Id, groupId: string, epoch: number, reason: GroupEpochReason, recipients: Id[], subject: Id | null = null) {
    return makeGroupEpochRecord({
        myEdPrivHex: maker.seedHex, groupId, epoch, reason, subject: subject?.pk ?? null, createdAt: new Date().toISOString(),
        recipients: recipients.map((r) => r.pk),
    });
}
const statementOf = (newKey: Id, old: Id) => {
    const s = makeKeySuccession({ newEdPrivHex: newKey.seedHex, oldPubHex: old.pk, at: new Date().toISOString() });
    return { oldPubkey: s.pubkey, at: s.at, sig: s.sig };
};
/** Open a served former wrap with `seedHex` against its record's commitment: the key, or null when it does not open. */
function openFormer(groupId: string, answer: any, w: any, seedHex: string): Uint8Array | null {
    const rec = (answer.epochs as any[]).find((e) => e.epoch === w.epoch);
    if (!rec) return null;
    try {
        if (w.sig === null) {
            const record: GroupEpochRecord = { groupId, ...rec };
            return openMyGroupKey(record, { epoch: w.epoch, wrapper: w.wrapper, ephPub: w.ephPub, nonce: w.nonce, wrapped: w.wrapped, sig: null } as GroupServedWrap, seedHex, { groupId });
        }
        return openGroupKeyWrap({ recipient: w.recipient, ephPub: w.ephPub, nonce: w.nonce, wrapped: w.wrapped },
            { groupId, epoch: w.epoch, wrapperPubHex: w.wrapper, keyCommit: rec.keyCommit }, seedHex);
    } catch {
        return null;
    }
}

async function main(): Promise<void> {
    console.log('\n=== Group chats: a re-keyed member\'s earlier history ===\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    const catA = member('Cat');
    const ben = member('Ben');
    const dov = member('Dov');
    const pip = member('Pip'); // the node's puppet: a member of the group, holding what any member holds
    const G = createGroup({ name: 'Gardeners', joinPolicy: 'open', createdBy: catA.pk }).id;
    for (const m of [ben, dov, pip]) joinGroup(G, m.pk);
    const keys = `/api/groups/${G}/keys`;
    const all = [catA, ben, dov, pip];
    const made: Record<number, Uint8Array> = {};
    const e1 = epochBy(catA, G, 1, 'start', all);
    assert((await call('POST', catA, `${keys}/epoch`, { epoch: e1.record })).status === 201, 'Cat starts the chat: epoch 1');
    made[1] = e1.groupKey;
    for (const [n, who] of [[2, ben], [3, dov]] as const) {
        const e = epochBy(who, G, n, 'rotate', all);
        assert((await call('POST', who, `${keys}/epoch`, { epoch: e.record })).status === 201, `${who.name} rotates: epoch ${n}`);
        made[n] = e.groupKey;
    }
    // A second group Cat joined at its epoch 2: she holds nothing from before it.
    const H = createGroup({ name: 'Repair Café', joinPolicy: 'open', createdBy: ben.pk }).id;
    const hKeys = `/api/groups/${H}/keys`;
    assert((await call('POST', ben, `${hKeys}/epoch`, { epoch: epochBy(ben, H, 1, 'start', [ben]).record })).status === 201, 'Ben starts Repair Café');
    const h2 = epochBy(catA, H, 2, 'join', [ben, catA], catA);
    assert((await call('POST', catA, `/api/groups/${H}/join`, { epoch: h2.record })).status === 200, 'Cat joins it with epoch 2');

    const catWrapsBefore = count('SELECT COUNT(*) AS n FROM group_key_wraps WHERE recipient_pubkey = ?', catA.pk);

    // ── K. the re-key keeps the old key's wraps ────────────────────────────────────────────────────────
    console.log('\n── K. a re-key keeps the old key\'s wraps, and lists, rosters and top-ups never see them ──');
    const catB = rekey(catA, 'Cat₂');
    const kept = count('SELECT COUNT(*) AS n FROM group_key_wraps WHERE recipient_pubkey = ?', catA.pk);
    assert(catWrapsBefore === 4 && kept === catWrapsBefore, `the old key's ${catWrapsBefore} wraps are all kept (${kept} after the re-key)`);
    const e4 = epochBy(ben, G, 4, 'rotate', [catB, ben, dov, pip]);
    assert((await call('POST', ben, `${keys}/epoch`, { epoch: e4.record })).status === 201, 'Ben rotates to epoch 4 over Cat\'s new key');
    made[4] = e4.groupKey;
    const missing = await call('GET', ben, `${keys}/missing`);
    const listed = (missing.body.missing as any[]).map((m) => m.pubkey);
    const catBMissing = (missing.body.missing as any[]).find((m) => m.pubkey === catB.pk);
    assert(missing.status === 200 && !listed.includes(catA.pk) && JSON.stringify(catBMissing?.epochs) === '[1,2,3]' && catBMissing.fromEpoch === 1,
        `…/keys/missing never lists the old key, and lists the new key lacking 1–3 from its unchanged fromEpoch 1 (got ${JSON.stringify(missing.body)})`);
    const benKeys = await call('GET', ben, keys);
    assert(!benKeys.body.roster.includes(catA.pk) && benKeys.body.roster.includes(catB.pk), 'the keys roster names the new key, never the old one');
    const toOld = makeGroupTopUp(made[3], { myEdPrivHex: ben.seedHex, groupId: G, epoch: 3, recipientPubHex: catA.pk });
    const toOldRes = await call('POST', ben, `${keys}/wrap`, toOld);
    assert(toOldRes.status === 403 && count('SELECT COUNT(*) AS n FROM group_key_wraps WHERE recipient_pubkey = ? AND sig IS NOT NULL', catA.pk) === 0,
        `a top-up to the old key is refused 403, nothing stored (got ${toOldRes.status} ${toOldRes.body?.error})`);
    const w2 = await call('GET', ben, `${keys}/2/wraps`);
    const own2 = (w2.body.wraps as any[]).filter((w) => w.sig === null && w.wrapper === ben.pk).map((w) => w.recipient);
    assert(groupEpochCoversExactly({ membersDigest: w2.body.membersDigest }, own2) && own2.includes(catA.pk),
        'an epoch\'s own wraps are exactly its signed recipients again, the old key among them');

    // ── F. GET …/keys/former ──────────────────────────────────────────────────────────────────────────
    console.log('\n── F. GET …/keys/former ──');
    const unattested = await call('GET', catB, `${keys}/former`);
    assert(unattested.status === 200 && unattested.body.wraps.length === 0 && unattested.body.formerKeys.length === 0,
        `before Cat's new key signs the statement: nothing (got ${JSON.stringify(unattested.body).slice(0, 200)})`);
    assert((await call('POST', catB, '/api/community/me/key-succession', statementOf(catB, catA))).status === 201, 'Cat₂ signs that Cat\'s old key was hers');
    const former = await call('GET', catB, `${keys}/former`);
    const fEpochs = (former.body.wraps as any[]).map((w) => w.epoch);
    assert(former.status === 200 && JSON.stringify(former.body.formerKeys) === JSON.stringify([catA.pk]) && JSON.stringify(fEpochs) === '[1,2,3]'
        && former.body.wraps.every((w: any) => w.recipient === catA.pk) && JSON.stringify(former.body.epochs.map((e: any) => e.epoch)) === '[1,2,3]',
        `Cat₂ is served the old key's wraps for 1–3, with their records, nothing for 4 she holds (got ${JSON.stringify(fEpochs)})`);
    let opened = 0, matched = 0;
    for (const w of former.body.wraps) {
        const k = openFormer(G, former.body, w, catA.seedHex);
        if (k) { opened++; if (Buffer.from(k).equals(Buffer.from(made[w.epoch]))) matched++; }
    }
    assert(opened === 3 && matched === 3, `each opens with the OLD seed to the key its record commits to (${matched}/3)`);
    const withOthers = former.body.wraps.filter((w: any) => [catB, ben, pip].some((who) => openFormer(G, former.body, w, who.seedHex))).length;
    assert(withOthers === 0, `and with no other seed: the new key's, Ben's or Pip's open ${withOthers}`);
    const benFormer = await call('GET', ben, `${keys}/former`);
    assert(benFormer.status === 200 && benFormer.body.wraps.length === 0, 'a member never re-keyed is served nothing');
    const pipFormer = await call('GET', pip, `${keys}/former`);
    assert(pipFormer.status === 200 && pipFormer.body.wraps.length === 0, 'the puppet, with no claim, is served nothing');
    const pipClaim = await call('POST', pip, '/api/community/me/key-succession', statementOf(pip, catA));
    assert(pipClaim.status === 404 && (await call('GET', pip, `${keys}/former`)).body.wraps.length === 0,
        `the puppet's own statement over Cat's old key is refused 404 on an honest node, and it is still served nothing (got ${pipClaim.status})`);
    const outsider = member('Ola');
    const outsiderRes = await call('GET', outsider, `${keys}/former`);
    assert(outsiderRes.status === 403 || outsiderRes.status === 404, `a non-member is refused (got ${outsiderRes.status})`);
    // Below the fromEpoch: the node writes a wrap for the old key at Repair Café's epoch 1, from before Cat joined.
    const h1 = db.prepare('SELECT * FROM group_key_wraps WHERE group_id = ? AND epoch = 1').get(H) as any;
    db.prepare(`INSERT INTO group_key_wraps (group_id, epoch, recipient_pubkey, wrapper_pubkey, eph_pub, nonce, wrapped, sig, created_at, updated_at)
                VALUES (?, 1, ?, ?, ?, ?, ?, NULL, ?, ?)`).run(H, catA.pk, ben.pk, h1.eph_pub, h1.nonce, h1.wrapped, h1.created_at, h1.updated_at);
    const hFormer = await call('GET', catB, `${hKeys}/former`);
    assert(JSON.stringify(hFormer.body.wraps.map((w: any) => w.epoch)) === '[2]',
        `Repair Café: only epoch 2, never the row below Cat's fromEpoch 2 (got ${JSON.stringify(hFormer.body.wraps.map((w: any) => w.epoch))})`);

    // ── W. a self top-up ───────────────────────────────────────────────────────────────────────────────
    console.log('\n── W. a self top-up ──');
    const k2 = openFormer(G, former.body, former.body.wraps.find((w: any) => w.epoch === 2), catA.seedHex)!;
    const self2 = makeGroupTopUp(k2, { myEdPrivHex: catB.seedHex, groupId: G, epoch: 2, recipientPubHex: catB.pk });
    const selfRes = await call('POST', catB, `${keys}/wrap`, self2);
    assert(selfRes.status === 201, `Cat₂ wraps epoch 2 to herself: 201 (got ${selfRes.status} ${JSON.stringify(selfRes.body)})`);
    const catBKeys = await call('GET', catB, keys);
    const served2 = (catBKeys.body.myWraps as any[]).find((w) => w.epoch === 2);
    assert(served2?.wrapper === catB.pk && served2.sig === self2.sig, 'it is served back in …/keys myWraps, her own signature on it');
    const rec2 = { groupId: G, ...(catBKeys.body.epochs as any[]).find((e) => e.epoch === 2) } as GroupEpochRecord;
    let selfOpened = false;
    try { selfOpened = Buffer.from(openMyGroupKey(rec2, served2, catB.seedHex, { groupId: G })).equals(Buffer.from(made[2])); } catch { /* not opened */ }
    assert(selfOpened, 'and opens with her new seed to epoch 2\'s key');
    assert(JSON.stringify((await call('GET', catB, `${keys}/former`)).body.wraps.map((w: any) => w.epoch)) === '[1,3]', 'epoch 2 leaves …/keys/former');
    assert((await call('POST', catB, `${keys}/wrap`, self2)).status === 409, 'a second self top-up of the same slot: 409');
    const below = makeGroupTopUp(crypto.randomBytes(32), { myEdPrivHex: catB.seedHex, groupId: H, epoch: 1, recipientPubHex: catB.pk });
    const belowRes = await call('POST', catB, `${hKeys}/wrap`, below);
    assert(belowRes.status === 403 && belowRes.body.code === 'wrap_below_membership', `a self top-up below her fromEpoch: 403 wrap_below_membership (got ${belowRes.status} ${belowRes.body?.code})`);
    const missingAfter = (await call('GET', ben, `${keys}/missing`)).body.missing.find((m: any) => m.pubkey === catB.pk);
    assert(JSON.stringify(missingAfter?.epochs) === '[1,3]', `…/keys/missing now lists Cat₂ lacking 1 and 3 (got ${JSON.stringify(missingAfter)})`);

    // ── N. the dishonest node ──────────────────────────────────────────────────────────────────────────
    // Pia: a member the node adds with a fromEpoch of 1 and no wrap of any old epoch, then names as Cat's successor.
    console.log('\n── N. the node adds Pia from epoch 1 and writes rekeyed_to(Cat\'s old key) = Pia ──');
    const pia = member('Pia');
    joinGroup(G, pia.pk);
    db.prepare('UPDATE group_members SET from_epoch = 1 WHERE group_id = ? AND member_pubkey = ?').run(G, pia.pk);
    db.prepare('UPDATE invalidated_keys SET rekeyed_to = ?, succession_sig = NULL WHERE public_key = ?').run(pia.pk, catA.pk);
    assert((await call('POST', pia, '/api/community/me/key-succession', statementOf(pia, catA))).status === 201, 'Pia signs a statement over Cat\'s old key and the node takes it');
    const piaServed = await call('GET', pia, `${keys}/former`);
    const piaOpens = (piaServed.body.wraps as any[]).filter((w) => openFormer(G, piaServed.body, w, pia.seedHex)).length;
    assert(piaServed.body.wraps.length === 3 && piaOpens === 0, `Pia is served the old key's ${piaServed.body.wraps.length} wraps and opens ${piaOpens}`);
    // A junk row in the old key's slot: the node's own wrap, a key it made, to Cat's old key.
    const junkKey = crypto.randomBytes(32);
    const junk = makeGroupTopUp(junkKey, { myEdPrivHex: pia.seedHex, groupId: G, epoch: 1, recipientPubHex: catA.pk });
    db.prepare('UPDATE group_key_wraps SET wrapper_pubkey = ?, eph_pub = ?, nonce = ?, wrapped = ?, sig = ? WHERE group_id = ? AND epoch = 1 AND recipient_pubkey = ?')
        .run(pia.pk, junk.ephPub, junk.nonce, junk.wrapped, junk.sig, G, catA.pk);
    db.prepare('UPDATE invalidated_keys SET rekeyed_to = ?, succession_sig = NULL WHERE public_key = ?').run(catB.pk, catA.pk);
    assert((await call('POST', catB, '/api/community/me/key-succession', statementOf(catB, catA))).status === 201, 'the node puts the link back to Cat₂');
    const withJunk = await call('GET', catB, `${keys}/former`);
    const junkRow = (withJunk.body.wraps as any[]).find((w) => w.epoch === 1);
    assert(!!junkRow && openFormer(G, withJunk.body, junkRow, catA.seedHex) === null,
        'the junk row for epoch 1 fails the commitment with Cat\'s old seed: the member\'s side takes nothing from it');

    // ── V. a sealed backup's copy ──────────────────────────────────────────────────────────────────────
    console.log('\n── V. VACUUM INTO carries the kept rows ──');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-history-'));
    const copy = path.join(dir, 'copy.db');
    db.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
    const c = new Database(copy, { readonly: true });
    const inCopy = (c.prepare('SELECT COUNT(*) AS n FROM group_key_wraps WHERE recipient_pubkey = ?').get(catA.pk) as { n: number }).n;
    c.close();
    fs.rmSync(dir, { recursive: true, force: true });
    assert(inCopy === count('SELECT COUNT(*) AS n FROM group_key_wraps WHERE recipient_pubkey = ?', catA.pk) && inCopy >= 4, `the copy holds the old key's ${inCopy} rows`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    console.log(`\n${passed}/${run + 1} passed (stopped: ${e?.message ?? e})`);
    process.exit(1);
});

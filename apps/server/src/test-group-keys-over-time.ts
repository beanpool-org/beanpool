/**
 * Group chats, step 2b: keys that hold up over time (scratch/global-node/DESIGN-group-chat-epochs-over-time-fable.md, DECIDED;
 * reviews of #1762, findings 3–6, and its confirmation round, finding 1). Over REAL HTTPS through the real signature
 * middleware, with real Ed25519 identities and @beanpool/core's group locks on the members' side:
 *
 *   F6/B. a newcomer who joins after a rejoin was stamped ahead of the clock gets his own epoch as fromEpoch: nothing
 *         earlier served (keys, lines, an epoch's wraps, `missing`), and a top-up from before is 403
 *   F6/P. the same after an epoch stored by a clock that was ahead (no rejoin at all)
 *   F6.   a join with no epoch under the same step: from_epoch = current + 1, served from the next rotation at once; the
 *         creator's row holds 1; a row no code wrote (from_epoch NULL) falls back to the stored_at rule
 *   F3.   a junk wrap in a maker's record: refused by the commitment, the recipient rejects it, `missing` lists the slot,
 *         another member's top-up fills it and opens; the refused wrapper hears wrap_rejected, anyone else wrap_exists. A
 *         junk top-up on a re-keyed member's empty slot: rejected, filled, the junk wrapper may not retry and `missing`
 *         asked by them leaves the slot out. Another's wrap, a wrong ephPub, an outsider, a self top-up: each refused.
 *         …/wraps flags the refused row, and the record's own wraps still hash to its wrapsDigest
 *
 * Run through the runner: SERVER_SUITES_ONLY=test-group-keys-over-time node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, createGroup } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { resetChatRateLimit } from './chat-rate-limit.js';
import { setMemberPhoto } from '@beanpool/engine';
import { issueRekeyCode, completeRekey } from './engine/member-wizards.js';
import {
    dmPublicKeyOf, groupEpochCanonical, groupWrapsDigest, makeGroupEpochRecord, makeGroupTopUp, openMyGroupKey, sealGroupLine, wrapGroupKey,
    type GroupEpochReason, type GroupEpochRecord, type GroupServedWrap,
} from '@beanpool/core';
import { ed25519 } from '@noble/curves/ed25519.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const AVATAR = 'https://example.com/a.jpg';
/** How far ahead of the clock the stamps below are, as after a clock step back or on a promoted standby behind its main. */
const STEP_MS = 5000;
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

/** An epoch made on `maker`'s side, as an app makes one. */
function epochBy(maker: Id, groupId: string, epoch: number, reason: GroupEpochReason, recipients: Id[], subject: Id | null = null) {
    return makeGroupEpochRecord({
        myEdPrivHex: maker.seedHex, groupId, epoch, reason, subject: subject?.pk ?? null, createdAt: new Date().toISOString(),
        recipients: recipients.map((r) => r.pk),
    });
}
const keysOf = async (who: Id, g: string) => (await call('GET', who, `/api/groups/${g}/keys`)).body;
/** A member's side, reading: the record's signature and commitment, no roster (design §2). */
function openFrom(keys: any, who: Id, g: string, epoch: number): Uint8Array {
    const rec = (keys.epochs as any[]).find((e) => e.epoch === epoch);
    const wrap = (keys.myWraps as any[]).find((w) => w.epoch === epoch) as GroupServedWrap | undefined;
    if (!rec || !wrap) throw new Error(`no record or wrap for epoch ${epoch}`);
    return openMyGroupKey({ groupId: g, ...rec } as GroupEpochRecord, wrap, who.seedHex, { groupId: g });
}
async function send(who: Id, g: string, key: Uint8Array, epoch: number, text: string): Promise<{ id: string; status: number; body: any }> {
    const id = crypto.randomUUID();
    const r = await call('POST', who, `/api/groups/${g}/chat/message`, {
        ...sealGroupLine(text, { myEdPrivHex: who.seedHex, groupKey: key, groupId: g, epoch, messageId: id }), metadata: { epoch }, clientId: id });
    return { id, status: r.status, body: r.body };
}
const chatIds = async (who: Id, g: string): Promise<string[]> => ((await call('GET', who, `/api/groups/${g}/chat`)).body.messages ?? []).map((m: any) => m.id);
const fromEpochCol = (g: string, pk: string): unknown => {
    try { return (db.prepare('SELECT from_epoch FROM group_members WHERE group_id = ? AND member_pubkey = ?').get(g, pk) as any)?.from_epoch; } catch { return 'no column'; }
};
const ahead = () => new Date(Date.now() + STEP_MS).toISOString();
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
/** Re-sign a changed record as `signer`: what a modified or buggy app could send. */
function resign(r: Omit<GroupEpochRecord, 'sig'>, signer: Id): GroupEpochRecord {
    return { ...r, sig: b64(ed25519.sign(crypto.createHash('sha256').update(groupEpochCanonical(r), 'utf8').digest(), Buffer.from(signer.seedHex, 'hex'))) };
}
/** Refused by `match`, as the member's own open refuses. */
function refuses(fn: () => unknown, match: RegExp, msg: string): void {
    run++;
    try {
        fn();
        console.error(`✗ ${msg} (it opened)`);
    } catch (e: any) {
        if (match.test(e?.message ?? '')) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg} (refused, but for "${e?.message}")`);
    }
}
const missingFor = async (asker: Id, g: string, pk: string): Promise<number[] | null> =>
    ((await call('GET', asker, `/api/groups/${g}/keys/missing`)).body.missing as any[]).find((m) => m.pubkey === pk)?.epochs ?? null;

async function main(): Promise<void> {
    console.log('\n=== Group chats, step 2b: keys that hold up over time ===\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    const ana = member('Ana');
    const ben = member('Ben');
    const cat = member('Cat');
    const dov = member('Dov');

    // ── F6/B. a newcomer after a rejoin stamped ahead ────────────────────────────────────────────────
    console.log('── F6/B. a newcomer after a rejoin stamped ahead of the clock ──');
    {
        const g = createGroup({ name: 'Clock B', joinPolicy: 'open', createdBy: ana.pk }).id;
        const kp = `/api/groups/${g}/keys`;
        assert(fromEpochCol(g, ana.pk) === 1, `the creator's row holds from_epoch 1 (got ${fromEpochCol(g, ana.pk)})`);
        assert((await call('POST', ana, `${kp}/epoch`, { epoch: epochBy(ana, g, 1, 'start', [ana]).record })).status === 201, 'Ana starts epoch 1');
        assert((await call('POST', ben, `/api/groups/${g}/join`, { epoch: epochBy(ben, g, 2, 'join', [ana, ben], ben).record })).status === 200, 'Ben joins with epoch 2');
        assert(fromEpochCol(g, ben.pk) === 2, `Ben's row holds from_epoch 2, set by number in the join (got ${fromEpochCol(g, ben.pk)})`);
        assert((await call('DELETE', ben, `/api/groups/${g}/members/${ben.pk}`, {})).status === 200, 'Ben leaves');
        db.prepare("UPDATE tombstones SET deleted_at = ? WHERE table_name = 'group_members' AND row_key = ?").run(ahead(), `${g}|${ben.pk}`);
        const e3 = epochBy(ben, g, 3, 'join', [ana, ben], ben);
        assert((await call('POST', ben, `/api/groups/${g}/join`, { epoch: e3.record })).status === 200, 'Ben rejoins with his own epoch 3, his leave stamped 5 s ahead');
        const benK = await keysOf(ben, g);
        assert(benK.fromEpoch === 3 && fromEpochCol(g, ben.pk) === 3, `Ben's fromEpoch is 3, a new row set afresh (got ${benK.fromEpoch}, column ${fromEpochCol(g, ben.pk)})`);
        const anaKey3 = openFrom(await keysOf(ana, g), ana, g, 3);
        const anaLine = await send(ana, g, anaKey3, 3, 'BEFORE-DOV the spare key is in the meter box');
        const benLine = await send(ben, g, e3.groupKey, 3, 'BEFORE-DOV Ben is back');
        assert(anaLine.status === 201 && benLine.status === 201, 'Ana and Ben each write a line under epoch 3');
        const benChat = await chatIds(ben, g);
        assert(benChat.includes(anaLine.id) && benChat.includes(benLine.id), "Ben's chat serves Ana's epoch-3 line and his own at once");

        // Dov joins INSIDE the window: the clock has not reached Ben's joined_at, so epoch 3's stored_at is after Dov's.
        const e4 = epochBy(dov, g, 4, 'join', [ana, ben, dov], dov);
        assert((await call('POST', dov, `/api/groups/${g}/join`, { epoch: e4.record })).status === 200, 'Dov, a newcomer, joins inside the window with his own epoch 4');
        const dovK = await keysOf(dov, g);
        assert(dovK.fromEpoch === 4 && dovK.epochs.every((e: any) => e.epoch >= 4) && dovK.myWraps.every((w: any) => w.epoch >= 4),
            `Dov's fromEpoch is his own epoch, 4: no earlier record or wrap (got ${dovK.fromEpoch}, epochs ${JSON.stringify(dovK.epochs.map((e: any) => e.epoch))})`);
        const dovAsks = await call('GET', dov, `${kp}?epochs=1,2,3,4`);
        assert(JSON.stringify(dovAsks.body.epochs.map((e: any) => e.epoch)) === '[4]', `asking by number, Dov is served only 4 (got ${JSON.stringify(dovAsks.body.epochs?.map((e: any) => e.epoch))})`);
        const dovChat = await chatIds(dov, g);
        assert(!dovChat.includes(anaLine.id) && !dovChat.includes(benLine.id), "Dov's chat leaves out both epoch-3 lines written before he joined");
        const dovGeneric = await call('GET', dov, `/api/messages/${g}`);
        assert(dovGeneric.status === 200 && !dovGeneric.body.messages.some((m: any) => m.id === anaLine.id), 'so does the ordinary read route old apps use');
        const missing = (await call('GET', ana, `${kp}/missing`)).body.missing as any[];
        assert(!missing.some((m) => m.pubkey === dov.pk), `…/keys/missing asks nobody to hand Dov an epoch from before he joined (got ${JSON.stringify(missing.find((m) => m.pubkey === dov.pk) ?? null)})`);
        assert((await call('GET', dov, `${kp}/3/wraps`)).status === 404, 'GET …/keys/3/wraps as Dov is 404');
        const tu = await call('POST', ana, `${kp}/wrap`, makeGroupTopUp(anaKey3, { myEdPrivHex: ana.seedHex, groupId: g, epoch: 3, recipientPubHex: dov.pk }));
        assert(tu.status === 403 && tu.body?.code === 'wrap_below_membership' && !db.prepare('SELECT 1 FROM group_key_wraps WHERE group_id = ? AND epoch = 3 AND recipient_pubkey = ?').get(g, dov.pk),
            `Ana's top-up of epoch 3 to Dov is refused 403 wrap_below_membership, nothing written (got ${tu.status} ${tu.body?.code ?? ''})`);
        const dovKey4 = openFrom(dovK, dov, g, 4);
        assert(Buffer.from(dovKey4).equals(Buffer.from(e4.groupKey)), 'Dov opens his own epoch 4');
    }

    // ── F6/P. a newcomer after an epoch stamped ahead ───────────────────────────────────────────────
    console.log('\n── F6/P. a newcomer after an epoch stored by a clock that was ahead ──');
    {
        const g = createGroup({ name: 'Clock P', joinPolicy: 'open', createdBy: ana.pk }).id;
        const kp = `/api/groups/${g}/keys`;
        const e1 = epochBy(ana, g, 1, 'start', [ana]);
        assert((await call('POST', ana, `${kp}/epoch`, { epoch: e1.record })).status === 201, 'Ana starts epoch 1');
        db.prepare('UPDATE group_key_epochs SET stored_at = ? WHERE group_id = ? AND epoch = 1').run(ahead(), g);
        const line = await send(ana, g, e1.groupKey, 1, 'BEFORE-DOV the hall key code is 2291');
        assert(line.status === 201, 'Ana writes a line under epoch 1, which was stored 5 s ahead');
        const e2 = epochBy(dov, g, 2, 'join', [ana, dov], dov);
        assert((await call('POST', dov, `/api/groups/${g}/join`, { epoch: e2.record })).status === 200, 'Dov joins with his own epoch 2');
        const dovK = await keysOf(dov, g);
        assert(dovK.fromEpoch === 2 && dovK.epochs.every((e: any) => e.epoch >= 2) && dovK.myWraps.every((w: any) => w.epoch >= 2),
            `Dov's fromEpoch is 2: nothing earlier (got ${dovK.fromEpoch}, epochs ${JSON.stringify(dovK.epochs.map((e: any) => e.epoch))})`);
        assert(!(await chatIds(dov, g)).includes(line.id), "Dov's chat leaves out Ana's epoch-1 line");
        assert((await call('GET', dov, `${kp}/1/wraps`)).status === 404, 'GET …/keys/1/wraps as Dov is 404');
        const missing = (await call('GET', ana, `${kp}/missing`)).body.missing as any[];
        assert(!missing.some((m) => m.pubkey === dov.pk), '…/keys/missing does not list Dov for epoch 1');
        const tu = await call('POST', ana, `${kp}/wrap`, makeGroupTopUp(e1.groupKey, { myEdPrivHex: ana.seedHex, groupId: g, epoch: 1, recipientPubHex: dov.pk }));
        assert(tu.status === 403 && tu.body?.code === 'wrap_below_membership', `Ana's top-up of epoch 1 to Dov is refused 403 (got ${tu.status} ${tu.body?.code ?? ''})`);
    }

    // ── F6. a join with no epoch under the same step, and a row no code wrote ────────────────────────
    console.log('\n── F6. a no-epoch join under a clock step; a hand-written row ──');
    {
        const g = createGroup({ name: 'Clock N', joinPolicy: 'open', createdBy: ana.pk }).id;
        const kp = `/api/groups/${g}/keys`;
        assert((await call('POST', ana, `${kp}/epoch`, { epoch: epochBy(ana, g, 1, 'start', [ana]).record })).status === 201, 'Ana starts epoch 1');
        assert((await call('POST', cat, `/api/groups/${g}/join`, { epoch: epochBy(cat, g, 2, 'join', [ana, cat], cat).record })).status === 200, 'Cat joins with epoch 2');
        assert((await call('DELETE', cat, `/api/groups/${g}/members/${cat.pk}`, {})).status === 200, 'Cat leaves');
        db.prepare("UPDATE tombstones SET deleted_at = ? WHERE table_name = 'group_members' AND row_key = ?").run(ahead(), `${g}|${cat.pk}`);
        // An old app's re-join, no epoch: the membership begins 5 s ahead of the clock.
        assert((await call('POST', cat, `/api/groups/${g}/join`, {})).status === 200, "Cat rejoins with no epoch (an old app), her leave stamped 5 s ahead");
        assert(fromEpochCol(g, cat.pk) === 3, `her row holds from_epoch 3: current + 1 (got ${fromEpochCol(g, cat.pk)})`);
        const catK = await keysOf(cat, g);
        assert(catK.fromEpoch === 3 && catK.epochs.length === 0 && catK.current === 2 && catK.stale === true,
            `she is served nothing yet: fromEpoch 3, beyond current 2, which is stale (got ${catK.fromEpoch}, ${catK.epochs.length} epochs, current ${catK.current})`);
        // Ana rotates at once: the next rotation is stored at `now`, still before Cat's joined_at, and is hers by number.
        const r3 = epochBy(ana, g, 3, 'rotate', [ana, cat]);
        assert((await call('POST', ana, `${kp}/epoch`, { epoch: r3.record })).status === 201, 'Ana rotates to epoch 3 at once, inside the window');
        const catK3 = await keysOf(cat, g);
        assert(catK3.fromEpoch === 3 && catK3.myWraps.some((w: any) => w.epoch === 3), `Cat is served epoch 3 at once, not when the clock catches up (got ${catK3.fromEpoch}, wraps ${JSON.stringify(catK3.myWraps.map((w: any) => w.epoch))})`);
        assert(Buffer.from(openFrom(catK3, cat, g, 3)).equals(Buffer.from(r3.groupKey)), 'and opens it');
        const l3 = await send(ana, g, r3.groupKey, 3, 'welcome back Cat');
        assert(l3.status === 201 && (await chatIds(cat, g)).includes(l3.id), "Ana's line under 3 is served to Cat at once");

        // A row no code wrote: from_epoch NULL falls back to the first epoch stored at or after joined_at.
        db.prepare('UPDATE group_members SET from_epoch = NULL WHERE group_id = ? AND member_pubkey = ?').run(g, ana.pk);
        const anaK = await keysOf(ana, g);
        assert(anaK.fromEpoch === 1, `a row with from_epoch NULL falls back to the stored_at rule: Ana's epoch 1 (got ${anaK.fromEpoch})`);
        db.prepare("UPDATE group_members SET from_epoch = NULL, joined_at = ? WHERE group_id = ? AND member_pubkey = ?").run(ahead(), g, ana.pk);
        assert((await keysOf(ana, g)).fromEpoch === null, 'and with joined_at after every stored epoch, the fallback serves nothing (fails closed)');
        db.prepare('UPDATE group_members SET from_epoch = 1 WHERE group_id = ? AND member_pubkey = ?').run(g, ana.pk);
    }

    // ── F3. a wrong or orphaned wrap ─────────────────────────────────────────────────────────────────
    console.log('\n── F3. a wrap that does not open: the recipient refuses it, another member fills the slot ──');
    {
        const eve = member('Eve');
        const outsider = member('Mallory');
        const g = createGroup({ name: 'Junk Wraps', joinPolicy: 'open', createdBy: ana.pk }).id;
        const kp = `/api/groups/${g}/keys`;
        assert((await call('POST', ana, `${kp}/epoch`, { epoch: epochBy(ana, g, 1, 'start', [ana]).record })).status === 201, 'Ana starts epoch 1');
        for (const who of [ben, cat, dov, eve]) assert((await call('POST', who, `/api/groups/${g}/join`, {})).status === 200, `${who.name} joins (no epoch): from epoch 2`);
        // Ana's app is buggy: its record commits to the real key, but Ben's wrap holds another. Re-signed, it passes the node.
        const real = epochBy(ana, g, 2, 'rotate', [ana, ben, cat, dov, eve]);
        const junkKey = new Uint8Array(crypto.randomBytes(32));
        const junkWrap = wrapGroupKey(junkKey, { groupId: g, epoch: 2, recipientPubHex: ben.pk, wrapperPubHex: ana.pk });
        const wraps = real.record.wraps!.map((w) => (w.recipient === ben.pk ? junkWrap : w));
        const { sig: _s, ...head } = real.record;
        const buggy = resign({ ...head, wraps, wrapsDigest: groupWrapsDigest(wraps) }, ana);
        assert((await call('POST', ana, `${kp}/epoch`, { epoch: buggy })).status === 201, "Ana's record with a junk wrap for Ben is stored: the node cannot tell");
        const benK = await keysOf(ben, g);
        refuses(() => openFrom(benK, ben, g, 2), /commits to/, "Ben's open of epoch 2 is refused by the commitment");
        const benServed = (benK.myWraps as any[]).find((w) => w.epoch === 2);
        assert(!(await missingFor(cat, g, ben.pk)), 'before he says so, …/keys/missing does not list Ben');

        const catReject = await call('POST', cat, `${kp}/2/reject`, { wrapper: ana.pk, ephPub: benServed.ephPub });
        assert(catReject.status === 404, `Cat refusing Ben's wrap is 404: only a wrap's recipient may (got ${catReject.status})`);
        const wrongEph = await call('POST', ben, `${kp}/2/reject`, { wrapper: ana.pk, ephPub: b64(crypto.randomBytes(32)) });
        assert(wrongEph.status === 404, `naming the wrong ephPub is 404 (got ${wrongEph.status})`);
        const byOutsider = await call('POST', outsider, `${kp}/2/reject`, { wrapper: ana.pk, ephPub: benServed.ephPub });
        assert(byOutsider.status === 403, `an outsider is 403 (got ${byOutsider.status})`);
        assert((await call('POST', ben, `${kp}/2/reject`, { wrapper: ana.pk })).status === 400, 'naming no ephPub is 400');
        const rejected = await call('POST', ben, `${kp}/2/reject`, { wrapper: ana.pk, ephPub: benServed.ephPub });
        assert(rejected.status === 200 && rejected.body.epoch === 2 && rejected.body.missing === true, `Ben refuses Ana's wrap: 200 { epoch: 2, missing: true } (got ${rejected.status} ${JSON.stringify(rejected.body)})`);
        const row = db.prepare('SELECT rejected_at FROM group_key_wraps WHERE group_id = ? AND epoch = 2 AND recipient_pubkey = ? AND wrapper_pubkey = ?').get(g, ben.pk, ana.pk) as any;
        assert(!!row?.rejected_at, 'the row stays, flagged, naming its wrapper');
        assert((await call('POST', ben, `${kp}/2/reject`, { wrapper: ana.pk, ephPub: benServed.ephPub })).status === 404, 'refusing it again is 404: it is no longer live');
        assert(!(await keysOf(ben, g)).myWraps.some((w: any) => w.epoch === 2), 'GET …/keys no longer serves Ben the refused wrap');
        assert(JSON.stringify(await missingFor(cat, g, ben.pk)) === '[2]', '…/keys/missing lists Ben for epoch 2 again');

        const catKey2 = openFrom(await keysOf(cat, g), cat, g, 2);
        const anaAgain = await call('POST', ana, `${kp}/wrap`, makeGroupTopUp(real.groupKey, { myEdPrivHex: ana.seedHex, groupId: g, epoch: 2, recipientPubHex: ben.pk }));
        assert(anaAgain.status === 409 && anaAgain.body.code === 'wrap_rejected', `Ana, refused once on this slot, may not try it again: 409 wrap_rejected (got ${anaAgain.status} ${anaAgain.body?.code})`);
        assert(!(await missingFor(ana, g, ben.pk)), '…/keys/missing asked by Ana leaves the slot out, so her app never wastes a wrap on it');
        const catTop = await call('POST', cat, `${kp}/wrap`, makeGroupTopUp(catKey2, { myEdPrivHex: cat.seedHex, groupId: g, epoch: 2, recipientPubHex: ben.pk }));
        assert(catTop.status === 201, `Cat tops Ben up (got ${catTop.status} ${JSON.stringify(catTop.body)})`);
        assert(Buffer.from(openFrom(await keysOf(ben, g), ben, g, 2)).equals(Buffer.from(real.groupKey)), 'and Ben opens epoch 2 from it');
        const anaAfter = await call('POST', ana, `${kp}/wrap`, makeGroupTopUp(real.groupKey, { myEdPrivHex: ana.seedHex, groupId: g, epoch: 2, recipientPubHex: ben.pk }));
        assert(anaAfter.status === 409 && anaAfter.body.code === 'wrap_rejected', `Ana's top-up for the slot is still 409 wrap_rejected (got ${anaAfter.status} ${anaAfter.body?.code})`);
        const dovKey2 = openFrom(await keysOf(dov, g), dov, g, 2);
        const dovTop = await call('POST', dov, `${kp}/wrap`, makeGroupTopUp(dovKey2, { myEdPrivHex: dov.seedHex, groupId: g, epoch: 2, recipientPubHex: ben.pk }));
        assert(dovTop.status === 409 && dovTop.body.code === 'wrap_exists', `Dov's is 409 wrap_exists: the slot is filled (got ${dovTop.status} ${dovTop.body?.code})`);
        const self = await call('POST', ben, `${kp}/wrap`, makeGroupTopUp(real.groupKey, { myEdPrivHex: ben.seedHex, groupId: g, epoch: 2, recipientPubHex: ben.pk }));
        assert(self.status === 400, `a self top-up is 400 (got ${self.status} ${self.body?.code})`);

        const all2 = (await call('GET', cat, `${kp}/2/wraps`)).body;
        const flagged = (all2.wraps as any[]).filter((w) => w.recipient === ben.pk);
        assert(flagged.length === 2 && flagged.some((w) => w.wrapper === ana.pk && w.rejectedAt && w.sig === null) && flagged.some((w) => w.wrapper === cat.pk && !w.rejectedAt && w.sig),
            `…/keys/2/wraps shows Ben's refused wrap flagged beside Cat's live top-up (got ${JSON.stringify(flagged.map((w) => [w.wrapper === ana.pk ? 'ana' : 'cat', !!w.rejectedAt]))})`);
        const recordOwn = (all2.wraps as any[]).filter((w) => w.sig === null);
        assert(groupWrapsDigest(recordOwn) === all2.wrapsDigest && all2.wrapsDigest === buggy.wrapsDigest,
            "the record's own wraps (sig null), the refused one among them, still hash to its wrapsDigest: the maker's signed set is checkable");

        // A re-keyed Ben: every slot empty. Eve gets in first with junk.
        const newBen = newId('Ben2');
        completeRekey(ben.pk, newBen.pk, issueRekeyCode(ben.pk, owner.pk).code, owner.pk);
        assert(JSON.stringify(await missingFor(cat, g, newBen.pk)) === '[2]', "after Ben's re-key, his new key lacks epoch 2");
        const eveJunk = makeGroupTopUp(junkKey, { myEdPrivHex: eve.seedHex, groupId: g, epoch: 2, recipientPubHex: newBen.pk });
        assert((await call('POST', eve, `${kp}/wrap`, eveJunk)).status === 201, "Eve's junk top-up lands first: signed by her, the node cannot tell");
        const nbK = await keysOf(newBen, g);
        refuses(() => openFrom(nbK, newBen, g, 2), /commits to/, "Ben's new key refuses it by the commitment");
        assert((await call('POST', newBen, `${kp}/2/reject`, { wrapper: eve.pk, ephPub: eveJunk.ephPub })).status === 200, 'Ben rejects it');
        assert(!(await missingFor(eve, g, newBen.pk)), '…/keys/missing asked by Eve leaves the slot out');
        assert(JSON.stringify(await missingFor(cat, g, newBen.pk)) === '[2]', 'asked by Cat it lists it');
        assert((await call('POST', cat, `${kp}/wrap`, makeGroupTopUp(catKey2, { myEdPrivHex: cat.seedHex, groupId: g, epoch: 2, recipientPubHex: newBen.pk }))).status === 201, 'Cat fills it');
        assert(Buffer.from(openFrom(await keysOf(newBen, g), newBen, g, 2)).equals(Buffer.from(real.groupKey)), 'and Ben opens epoch 2 on his new key');
        const eveRetry = await call('POST', eve, `${kp}/wrap`, makeGroupTopUp(junkKey, { myEdPrivHex: eve.seedHex, groupId: g, epoch: 2, recipientPubHex: newBen.pk }));
        assert(eveRetry.status === 409 && eveRetry.body.code === 'wrap_rejected', `Eve cannot retry: 409 wrap_rejected (got ${eveRetry.status} ${eveRetry.body?.code})`);
        const live = (db.prepare('SELECT COUNT(*) AS n FROM group_key_wraps WHERE group_id = ? AND epoch = 2 AND recipient_pubkey = ? AND rejected_at IS NULL').get(g, newBen.pk) as any).n;
        assert(live === 1, `one live wrap per slot (got ${live})`);
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    console.log(`\n${passed}/${run + 1} passed (stopped: ${e?.message ?? e})`);
    process.exit(1);
});

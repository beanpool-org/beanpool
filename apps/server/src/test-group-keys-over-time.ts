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
import {
    dmPublicKeyOf, makeGroupEpochRecord, makeGroupTopUp, openMyGroupKey, sealGroupLine,
    type GroupEpochReason, type GroupEpochRecord, type GroupServedWrap,
} from '@beanpool/core';

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

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    console.log(`\n${passed}/${run + 1} passed (stopped: ${e?.message ?? e})`);
    process.exit(1);
});

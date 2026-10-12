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
 *   F4.   Ana makes epochs 1 and 3, Cat (later re-keyed) 2 and 4, Cat tops Dov up; Ana leaves and Cat is re-keyed: every
 *         member still opens every epoch with { groupId } and no roster; created_by, subject_pubkey and wrapper_pubkey stay
 *         on the old key and the records still verify; the pre-seal check against today's roster refuses the current
 *         record (the app rotates); the node still refuses a non-member's record and top-up
 *   Re-key lines. Ana's line under epoch 2, then completeRekey: metadata.sender is her old key, author_pubkey her new
 *         one; Ben opens it with metadata.sender (not with author_pubkey; not with a wrong sender); Ana opens it on her new
 *         key after a top-up
 *   F5.   an edit stays under its line's own epoch (Marty's pick 1): Ana's line under 2, Dov joins (3), Ana edits under 2:
 *         200, metadata.epoch still 2, Dov served nothing of it; an edit naming 3 is 409 epoch_not_lines; an edit under 2
 *         while 2 is current and stale is 200; the edit opens under 2 for a member, and its sender is the editor
 *   Re-key edit. Amy, re-keyed, edits her old line: metadata.sender becomes her new key, and only by it does the edit open
 *   K11.  a pruned account's group row stays active, and `missing` lists it for nobody (review of #1772, finding 3)
 *   E.    a newcomer hears nothing of a line from before her (review of #1772, finding 2): her socket hears no edit, reaction
 *         or removal of it; her reaction to it by id, and her removal of it once a convenor, are answered as an id nobody
 *         has, with nothing written; a member who holds its epoch hears each, and her own reaction to a line under 2 is heard.
 *         A chat-mirror row with no active group row behind it (a kill between a leave's commit and the mirror delete)
 *         hears no sealed line: groupLineHearers fails closed (review of #1782, finding 2)
 *   K16.  setMembershipFromEpoch on a row whose updated_at is ahead of the clock moves updated_at strictly past it, so a
 *         replica takes the new from_epoch (review of #1782, finding 1)
 *
 * Run through the runner: SERVER_SUITES_ONLY=test-group-keys-over-time node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import WebSocket from 'ws';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, createGroup, adminPruneUser } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { resetChatRateLimit } from './chat-rate-limit.js';
import { setMemberPhoto } from '@beanpool/engine';
import { issueRekeyCode, completeRekey } from './engine/member-wizards.js';
import { setMembershipFromEpoch } from './engine/group-keys.js';
import { groupLineHearers } from './engine/group-thread.js';
import {
    dmPublicKeyOf, groupEpochCanonical, groupWrapsDigest, makeGroupEpochRecord, makeGroupTopUp, openGroupLine, openMyGroupKey, sealGroupLine,
    verifyGroupEpochRecord, wrapGroupKey,
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
async function send(who: Id, g: string, key: Uint8Array, epoch: number, text: string, extra: { replyToId?: string; mentions?: string[] } = {}): Promise<{ id: string; status: number; body: any }> {
    const id = crypto.randomUUID();
    const r = await call('POST', who, `/api/groups/${g}/chat/message`, {
        ...sealGroupLine(text, { myEdPrivHex: who.seedHex, groupKey: key, groupId: g, epoch, messageId: id, replyToId: extra.replyToId ?? null }),
        metadata: { epoch, ...extra }, clientId: id });
    return { id, status: r.status, body: r.body };
}
/** A member's live socket, signed as the apps sign it; every event it hears, in order. */
type Sock = { ws: WebSocket; events: any[] };
function socket(id: Id): Promise<Sock> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.priv).toString('base64');
    const url = `${BASE.replace('https', 'wss')}/ws?pubkey=${id.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const s: Sock = { ws, events: [] };
        ws.on('message', (d) => { try { s.events.push(JSON.parse(d.toString())); } catch { /* not JSON */ } });
        ws.on('open', () => resolve(s));
        ws.on('error', reject);
    });
}
const settle = () => new Promise((r) => setTimeout(r, 300));
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

    // ── F4. old epochs and top-ups by someone no longer in today's roster ────────────────────────────
    console.log('\n── F4. an epoch or a top-up by someone who left or was re-keyed still opens; the roster is checked only before sealing ──');
    {
        const [a, b, c, d] = [member('Ann'), member('Bob'), member('Cy'), member('Di')];
        const g = createGroup({ name: 'Old Epochs', joinPolicy: 'open', createdBy: b.pk }).id;
        const kp = `/api/groups/${g}/keys`;
        assert((await call('POST', a, `/api/groups/${g}/join`, {})).status === 200, 'Ann joins Bob\'s group before any epoch: from epoch 1');
        const e1 = epochBy(a, g, 1, 'start', [a, b]);
        assert((await call('POST', a, `${kp}/epoch`, { epoch: e1.record })).status === 201, 'Ann starts epoch 1');
        const e2 = epochBy(c, g, 2, 'join', [a, b, c], c);
        assert((await call('POST', c, `/api/groups/${g}/join`, { epoch: e2.record })).status === 200, 'Cy joins with her own epoch 2');
        const e3 = epochBy(a, g, 3, 'rotate', [a, b, c]);
        assert((await call('POST', a, `${kp}/epoch`, { epoch: e3.record })).status === 201, 'Ann rotates to epoch 3');
        assert((await call('POST', d, `/api/groups/${g}/join`, {})).status === 200, 'Di joins with no epoch: from epoch 4');
        const e4 = epochBy(c, g, 4, 'rotate', [a, b, c, d]);
        assert((await call('POST', c, `${kp}/epoch`, { epoch: e4.record })).status === 201, 'Cy rotates to epoch 4');
        db.prepare('DELETE FROM group_key_wraps WHERE group_id = ? AND epoch = 4 AND recipient_pubkey = ?').run(g, d.pk); // a wrap lost to a bug
        assert((await call('POST', c, `${kp}/wrap`, makeGroupTopUp(e4.groupKey, { myEdPrivHex: c.seedHex, groupId: g, epoch: 4, recipientPubHex: d.pk }))).status === 201, 'Cy tops Di up for epoch 4');

        const newC = newId('Cy2');
        completeRekey(c.pk, newC.pk, issueRekeyCode(c.pk, owner.pk).code, owner.pk);
        const row = (e: number) => db.prepare('SELECT created_by, subject_pubkey FROM group_key_epochs WHERE group_id = ? AND epoch = ?').get(g, e) as any;
        const diWrap = db.prepare('SELECT wrapper_pubkey FROM group_key_wraps WHERE group_id = ? AND epoch = 4 AND recipient_pubkey = ?').get(g, d.pk) as any;
        assert(row(2).created_by === c.pk && row(2).subject_pubkey === c.pk && row(4).created_by === c.pk && diWrap?.wrapper_pubkey === c.pk,
            "after Cy's re-key, created_by, subject_pubkey and wrapper_pubkey stay on her old key: the signatures were made by it");
        const diK = await keysOf(d, g);
        assert(Buffer.from(openFrom(diK, d, g, 4)).equals(Buffer.from(e4.groupKey)), "Di opens epoch 4 from Cy's top-up, though Cy's old key is in no roster now");
        assert((await call('DELETE', a, `/api/groups/${g}/members/${a.pk}`, {})).status === 200, 'Ann leaves');
        const bK = await keysOf(b, g);
        assert(!bK.roster.includes(a.pk) && !bK.roster.includes(c.pk), "today's roster has neither Ann nor Cy's old key");
        const opened = [1, 2, 3, 4].map((e) => { try { return Buffer.from(openFrom(bK, b, g, e)).toString('hex'); } catch (err: any) { return `refused: ${err?.message}`; } });
        assert(JSON.stringify(opened) === JSON.stringify([e1, e2, e3, e4].map((x) => Buffer.from(x.groupKey).toString('hex'))),
            `Bob opens epochs 1–4 with { groupId } alone: two by Ann, who left, two by Cy's old key (got ${JSON.stringify(opened.map((o) => o.slice(0, 16)))})`);
        for (const e of [1, 2, 3, 4]) {
            let ok = true;
            try { verifyGroupEpochRecord({ groupId: g, ...(bK.epochs as any[]).find((x) => x.epoch === e) }, { groupId: g, epoch: e }); } catch { ok = false; }
            assert(ok, `epoch ${e}'s record still verifies under its maker's key`);
        }
        const cur = { groupId: g, ...(bK.epochs as any[]).find((x) => x.epoch === 4) } as GroupEpochRecord;
        refuses(() => verifyGroupEpochRecord(cur, { groupId: g, epoch: 4, activeMembers: bK.roster }), /maker is not an active member/,
            "before sealing, the current record is checked against today's roster and refused: the app rotates");
        assert(bK.stale === true, 'and the node calls it stale');
        const annRot = await call('POST', a, `${kp}/epoch`, { epoch: epochBy(a, g, 5, 'rotate', [a, b, newC, d]).record });
        const annTop = await call('POST', a, `${kp}/wrap`, makeGroupTopUp(e4.groupKey, { myEdPrivHex: a.seedHex, groupId: g, epoch: 4, recipientPubHex: newC.pk }));
        assert(annRot.status === 403 && annTop.status === 403 && (db.prepare('SELECT MAX(epoch) AS n FROM group_key_epochs WHERE group_id = ?').get(g) as any).n === 4
            && !db.prepare('SELECT 1 FROM group_key_wraps WHERE group_id = ? AND recipient_pubkey = ?').get(g, newC.pk),
            `the node still refuses a non-member's record and top-up: 403, nothing written (got ${annRot.status}, ${annTop.status})`);
    }

    // ── Re-key lines ─────────────────────────────────────────────────────────────────────────────────
    console.log('\n── a re-keyed author\'s old line still opens: metadata.sender ──');
    {
        const [a, b] = [member('Amy'), member('Bo')];
        const g = createGroup({ name: 'Rekey Lines', joinPolicy: 'open', createdBy: a.pk }).id;
        const kp = `/api/groups/${g}/keys`;
        assert((await call('POST', b, `/api/groups/${g}/join`, {})).status === 200, 'Bo joins');
        assert((await call('POST', a, `${kp}/epoch`, { epoch: epochBy(a, g, 1, 'start', [a, b]).record })).status === 201, 'Amy starts epoch 1');
        const e2 = epochBy(b, g, 2, 'rotate', [a, b]);
        assert((await call('POST', b, `${kp}/epoch`, { epoch: e2.record })).status === 201, 'Bo rotates to epoch 2');
        const words = 'the seed swap moved to the library';
        const line = await send(a, g, e2.groupKey, 2, words);
        assert(line.status === 201 && JSON.parse(line.body.message.metadata).sender === a.pk, `Amy's line under 2 is stored with metadata.sender, her key (got ${line.body?.message?.metadata})`);
        const newA = newId('Amy2');
        completeRekey(a.pk, newA.pk, issueRekeyCode(a.pk, owner.pk).code, owner.pk);
        const stored = db.prepare('SELECT author_pubkey, metadata, ciphertext, nonce FROM messages WHERE id = ?').get(line.id) as any;
        const meta = JSON.parse(stored.metadata);
        assert(stored.author_pubkey === newA.pk && meta.sender === a.pk && meta.epoch === 2,
            `after completeRekey: author_pubkey is her new key, metadata.sender still her old one (got ${stored.author_pubkey === newA.pk ? 'new' : 'old'}, ${meta.sender === a.pk ? 'old' : meta.sender})`);
        const served = ((await call('GET', b, `/api/groups/${g}/chat`)).body.messages as any[]).find((m) => m.id === line.id);
        const servedMeta = JSON.parse(served.metadata);
        const bKey2 = openFrom(await keysOf(b, g), b, g, 2);
        const openAs = (sender: string, key: Uint8Array) => {
            try { return openGroupLine({ ciphertext: served.ciphertext, nonce: served.nonce }, { groupId: g, epoch: 2, senderPubHex: sender, messageId: line.id }, key).text; } catch { return null; }
        };
        assert(openAs(servedMeta.sender ?? served.authorPubkey, bKey2) === words, 'Bo opens it with metadata.sender ?? author_pubkey, as the apps will');
        assert(openAs(served.authorPubkey, bKey2) === null, 'with author_pubkey alone (the new key) it does not open: that is why sender is stored');
        assert(openAs(b.pk, bKey2) === null, 'and a wrong sender fails to open: the node cannot lie here');
        assert(JSON.stringify(await missingFor(b, g, newA.pk)) === '[1,2]', "Amy's new key lacks epochs 1 and 2");
        assert((await call('POST', b, `${kp}/wrap`, makeGroupTopUp(bKey2, { myEdPrivHex: b.seedHex, groupId: g, epoch: 2, recipientPubHex: newA.pk }))).status === 201, 'Bo tops Amy up for epoch 2');
        const aKey2 = openFrom(await keysOf(newA, g), newA, g, 2);
        assert(openAs(servedMeta.sender, aKey2) === words, 'and Amy, on her new key, opens her own old line');
        // Her edit after the re-key is sealed by her new key: the node must store the editor as sender, or nobody opens it.
        const edited = 'the seed swap moved to the hall';
        const ed = await call('POST', newA, '/api/messages/edit', { messageId: line.id,
            ...sealGroupLine(edited, { myEdPrivHex: newA.seedHex, groupKey: aKey2, groupId: g, epoch: 2, messageId: line.id, part: 'edit' }), metadata: { epoch: 2 } });
        const after = db.prepare('SELECT ciphertext, nonce, metadata FROM messages WHERE id = ?').get(line.id) as any;
        const afterMeta = JSON.parse(after.metadata);
        assert(ed.status === 200 && afterMeta.sender === newA.pk && afterMeta.epoch === 2,
            `Amy, re-keyed, edits her old line under 2: metadata.sender is now the editor, her new key (got ${ed.status}, ${afterMeta.sender === newA.pk ? 'new' : afterMeta.sender === a.pk ? 'old' : afterMeta.sender})`);
        const openEdit = (sender: string) => {
            try { return openGroupLine({ ciphertext: after.ciphertext, nonce: after.nonce }, { groupId: g, epoch: 2, senderPubHex: sender, messageId: line.id, part: 'edit' }, bKey2).text; } catch { return null; }
        };
        assert(openEdit(afterMeta.sender ?? stored.author_pubkey) === edited, "Bo opens her edit with metadata.sender ?? author_pubkey: the only way a re-keyed author's edit opens");
        assert(openEdit(a.pk) === null, "by her old key, the line's first sender, it does not open");
    }

    // ── F5. an edit across a join ────────────────────────────────────────────────────────────────────
    console.log('\n── F5. an edit is sealed under its line\'s own epoch: a newcomer never holds that key ──');
    {
        const [a, b, c, d] = [member('Ada'), member('Bea'), member('Cal'), member('Del')];
        const g = createGroup({ name: 'Edits', joinPolicy: 'open', createdBy: a.pk }).id;
        const kp = `/api/groups/${g}/keys`;
        assert((await call('POST', b, `/api/groups/${g}/join`, {})).status === 200, 'Bea joins');
        assert((await call('POST', a, `${kp}/epoch`, { epoch: epochBy(a, g, 1, 'start', [a, b]).record })).status === 201, 'Ada starts epoch 1');
        const e2 = epochBy(b, g, 2, 'rotate', [a, b]);
        assert((await call('POST', b, `${kp}/epoch`, { epoch: e2.record })).status === 201, 'Bea rotates to epoch 2');
        const line = await send(a, g, e2.groupKey, 2, 'the hall is booked for 6');
        assert(line.status === 201, 'Ada writes a line under epoch 2');
        const editAs = (who: Id, key: Uint8Array, epoch: number, text: string) => call('POST', who, '/api/messages/edit', {
            messageId: line.id, ...sealGroupLine(text, { myEdPrivHex: who.seedHex, groupKey: key, groupId: g, epoch, messageId: line.id, part: 'edit' }), metadata: { epoch } });
        const epochOf = () => JSON.parse((db.prepare('SELECT metadata FROM messages WHERE id = ?').get(line.id) as any).metadata).epoch;

        // Cal joins with no epoch: 2 is still current, and stale.
        assert((await call('POST', c, `/api/groups/${g}/join`, {})).status === 200 && (await keysOf(a, g)).stale === true, 'Cal joins with no epoch: epoch 2 is current and stale');
        const whileStale = await editAs(a, e2.groupKey, 2, 'the hall is booked for 6:30');
        assert(whileStale.status === 200 && epochOf() === 2, `an edit under 2 while 2 is current and stale: 200, epoch 2 (got ${whileStale.status} ${whileStale.body?.code ?? ''})`);
        const e3 = epochBy(d, g, 3, 'join', [a, b, c, d], d);
        assert((await call('POST', d, `/api/groups/${g}/join`, { epoch: e3.record })).status === 200, 'Del joins with his own epoch 3');
        const under3 = await editAs(a, e3.groupKey, 3, 'EDITED after Del joined: the hall is booked for 7');
        assert(under3.status === 409 && under3.body?.code === 'epoch_not_lines' && under3.body?.epoch === 2 && epochOf() === 2,
            `an edit naming epoch 3 is 409 epoch_not_lines, { epoch: 2 }, nothing written (got ${under3.status} ${under3.body?.code} ${under3.body?.epoch})`);
        const under2 = await editAs(a, e2.groupKey, 2, 'EDITED after Del joined: the hall is booked for 7');
        assert(under2.status === 200 && epochOf() === 2, `Ada edits under 2, the line's own epoch: 200, metadata.epoch still 2 (got ${under2.status} ${under2.body?.code ?? ''}, epoch ${epochOf()})`);
        assert(!(await chatIds(d, g)).includes(line.id), 'Del is served nothing of it: the line and its edit are under an epoch he never holds');
        const delK = await keysOf(d, g);
        assert(delK.fromEpoch === 3 && !delK.myWraps.some((w: any) => w.epoch === 2), 'and he holds no key for epoch 2');
        const row = db.prepare('SELECT ciphertext, nonce, metadata FROM messages WHERE id = ?').get(line.id) as any;
        const meta = JSON.parse(row.metadata);
        let text = '';
        try {
            text = openGroupLine({ ciphertext: row.ciphertext, nonce: row.nonce }, { groupId: g, epoch: meta.epoch, senderPubHex: meta.sender, messageId: line.id, part: 'edit' },
                openFrom(await keysOf(b, g), b, g, 2)).text;
        } catch { /* refused */ }
        assert(text === 'EDITED after Del joined: the hall is booked for 7' && meta.sender === a.pk, `Bea opens the edit under the epoch the row names, from its sender (got "${text}")`);
    }

    // ── K11. `missing` asks for no one outside the roster ──────────────────────────────────────────────
    console.log('\n── K11. a pruned account keeps an active group row, and `missing` never lists it ──');
    {
        const [a, b, p] = [member('Abe'), member('Bree'), member('Pru')];
        const g = createGroup({ name: 'Pruned', joinPolicy: 'open', createdBy: a.pk }).id;
        const kp = `/api/groups/${g}/keys`;
        assert((await call('POST', b, `/api/groups/${g}/join`, {})).status === 200, 'Bree joins');
        assert((await call('POST', a, `${kp}/epoch`, { epoch: epochBy(a, g, 1, 'start', [a, b]).record })).status === 201, 'Abe starts epoch 1 for Abe and Bree');
        assert((await call('POST', p, `/api/groups/${g}/join`, {})).status === 200 && fromEpochCol(g, p.pk) === 2, 'Pru joins with no epoch: from_epoch 2');
        adminPruneUser(p.pk, owner.pk);
        const pRow = db.prepare('SELECT status FROM group_members WHERE group_id = ? AND member_pubkey = ?').get(g, p.pk) as any;
        assert(pRow?.status === 'active' && !(await keysOf(a, g)).roster.includes(p.pk), "Pru is pruned: her group row stays active, and she is in no roster");
        assert((await call('POST', a, `${kp}/epoch`, { epoch: epochBy(a, g, 2, 'rotate', [a, b]).record })).status === 201, "Abe rotates to 2 for today's roster, Abe and Bree");
        const listed = ((await call('GET', a, `${kp}/missing`)).body.missing as any[]).map((m) => m.pubkey);
        assert(!listed.includes(p.pk), `\`missing\` leaves out her active row with no wrap for 2: nobody is asked to wrap for someone outside the roster (got ${JSON.stringify(listed)})`);
    }

    // ── E. a newcomer hears nothing of the lines from before her ─────────────────────────────────────
    console.log('\n── E. a newcomer hears nothing of a line from before her: live updates, reactions, removals ──');
    {
        const [a, c, f] = [member('Ari'), member('Coby'), member('Fen')];
        const g = createGroup({ name: 'Newcomer', joinPolicy: 'open', createdBy: a.pk }).id;
        const kp = `/api/groups/${g}/keys`;
        assert((await call('POST', c, `/api/groups/${g}/join`, {})).status === 200, 'Coby joins');
        const e1 = epochBy(a, g, 1, 'start', [a, c]);
        assert((await call('POST', a, `${kp}/epoch`, { epoch: e1.record })).status === 201, 'Ari starts epoch 1 for Ari and Coby');
        const pre = await send(a, g, e1.groupKey, 1, 'BEFORE-FEN the safe code is 9921', { mentions: [c.pk] });
        assert(pre.status === 201, 'Ari writes a line under 1, mentioning Coby');
        const e2 = epochBy(f, g, 2, 'join', [a, c, f], f);
        assert((await call('POST', f, `/api/groups/${g}/join`, { epoch: e2.record })).status === 200 && (await keysOf(f, g)).fromEpoch === 2, 'Fen joins with her own epoch 2: fromEpoch 2');
        const [fenSock, cySock] = [await socket(f), await socket(c)];
        const heard = (s: Sock) => s.events.filter((e) => e?.message?.id === pre.id || e?.messageId === pre.id);
        const quiet = async () => { await settle(); fenSock.events.length = 0; cySock.events.length = 0; };
        await quiet();

        // Live updates: an edit.
        const edit = await call('POST', a, '/api/messages/edit', { messageId: pre.id,
            ...sealGroupLine('BEFORE-FEN the safe code is 1234', { myEdPrivHex: a.seedHex, groupKey: e1.groupKey, groupId: g, epoch: 1, messageId: pre.id, part: 'edit' }), metadata: { epoch: 1 } });
        await settle();
        assert(edit.status === 200 && heard(fenSock).length === 0, `Ari edits her epoch-1 line: Fen's socket hears nothing of it (got ${edit.status}, heard ${heard(fenSock).length}×)`);
        assert(heard(cySock).some((e) => e.action === 'edited' && JSON.parse(e.message.metadata).epoch === 1), 'Coby, who holds epoch 1, hears the edit');

        // Reactions: Coby's reply under 2 names the old line, so Fen learns its id.
        const rep = await send(c, g, openFrom(await keysOf(c, g), c, g, 2), 2, 'replying to the old one', { replyToId: pre.id });
        const servedReply = ((await call('GET', f, `/api/groups/${g}/chat`)).body.messages as any[]).find((m) => m.id === rep.id);
        assert(rep.status === 201 && JSON.parse(servedReply.metadata).replyToId === pre.id, "Fen is served Coby's reply under 2, which names the old line's id");
        await quiet();
        const unknown = await call('POST', f, '/api/messages/react', { messageId: crypto.randomUUID(), authorPubkey: f.pk, emoji: '👀' });
        const fenReact = await call('POST', f, '/api/messages/react', { messageId: pre.id, authorPubkey: f.pk, emoji: '👀' });
        await settle();
        const stored = JSON.parse((db.prepare('SELECT metadata FROM messages WHERE id = ?').get(pre.id) as any).metadata);
        assert(fenReact.status === unknown.status && JSON.stringify(fenReact.body) === JSON.stringify(unknown.body) && fenReact.status === 404,
            `Fen reacting to the pre-join line by its id is answered as an id nobody has (got ${fenReact.status} ${JSON.stringify(fenReact.body)}, unknown id ${unknown.status} ${JSON.stringify(unknown.body)})`);
        assert(!(stored.reactions ?? []).some((r: any) => r?.author === f.pk) && heard(cySock).length === 0 && heard(fenSock).length === 0,
            'nothing is stored and nobody hears a reaction from her');
        const cyReact = await call('POST', c, '/api/messages/react', { messageId: pre.id, authorPubkey: c.pk, emoji: '👍' });
        await settle();
        assert(cyReact.status === 200 && heard(cySock).some((e) => e.type === 'message_reaction'), `Coby reacts to it: 200, and Coby hears it (got ${cyReact.status})`);
        assert(heard(fenSock).length === 0, "Fen's socket hears nothing of Coby's reaction to it");
        const fenOwn = await call('POST', f, '/api/messages/react', { messageId: rep.id, authorPubkey: f.pk, emoji: '👀' });
        await settle();
        assert(fenOwn.status === 200 && fenSock.events.some((e) => e?.messageId === rep.id) && cySock.events.some((e) => e?.messageId === rep.id),
            `Fen reacts to Coby's line under 2: 200, and both hear it (got ${fenOwn.status})`);

        // A convenor who joined later removes nothing she was never served, and learns nothing from trying.
        db.prepare("UPDATE group_members SET role = 'convenor' WHERE group_id = ? AND member_pubkey = ?").run(g, f.pk);
        await quiet();
        const unknownRm = await call('POST', f, `/api/groups/${g}/chat/remove`, { messageId: crypto.randomUUID() });
        const fenRm = await call('POST', f, `/api/groups/${g}/chat/remove`, { messageId: pre.id });
        assert(fenRm.status === unknownRm.status && JSON.stringify(fenRm.body) === JSON.stringify(unknownRm.body)
            && (db.prepare('SELECT type FROM messages WHERE id = ?').get(pre.id) as any).type !== 'removed',
            `Fen, made a convenor, removing the pre-join line is answered as an id nobody has, and it stays (got ${fenRm.status} ${JSON.stringify(fenRm.body)}, unknown id ${unknownRm.status})`);

        // Live updates: the author's own delete reaches the members who hold its epoch, and not her.
        const del = await call('POST', a, '/api/messages/delete', { messageId: pre.id });
        await settle();
        assert(del.status === 200 && heard(fenSock).length === 0, `Ari deletes the line: Fen's socket hears nothing of it (got ${del.status}, heard ${heard(fenSock).length}×)`);
        assert(heard(cySock).some((e) => e.action === 'removed'), 'Coby hears the removal');
        fenSock.ws.close();
        cySock.ws.close();

        // A mirror row with no group row: Hal is a node member in the chat's participants (a kill between a leave's
        // commit and afterGroupMembershipChange's mirror delete), with no active group_members row. He hears no sealed
        // line, live or by groupLineHearers, while a member who holds its epoch does (review of #1782, finding 2).
        const hal = member('Hal');
        db.prepare("INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))").run(g, hal.pk);
        const [halSock, cy2] = [await socket(hal), await socket(c)];
        await settle();
        halSock.events.length = 0;
        cy2.events.length = 0;
        const anyKey = openFrom(await keysOf(c, g), c, g, 2);
        const later = await send(c, g, anyKey, 2, 'AFTER-HAL-LEFT only members hear this');
        await settle();
        const heardIt = (s: Sock) => s.events.some((e) => e?.message?.id === later.id);
        assert(later.status === 201 && !heardIt(halSock) && heardIt(cy2), `a sealed line reaches Coby and not Hal's mirror row (status ${later.status}, Hal heard ${heardIt(halSock)}, Coby ${heardIt(cy2)})`);
        assert(groupLineHearers(g, { epoch: 2 }, [hal.pk, c.pk]).join() === c.pk, 'groupLineHearers leaves out a participant with no active group row (fails closed)');
        halSock.ws.close();
        cy2.ws.close();
    }

    // ── K16. from_epoch written past an updated_at that is ahead of the clock ──────────────────────
    console.log('\n── K16. setMembershipFromEpoch moves updated_at strictly past a stamp ahead of the clock ──');
    {
        const k = member('Kip');
        const g = createGroup({ name: 'K16', joinPolicy: 'open', createdBy: k.pk }).id;
        const aheadIso = new Date(Date.now() + 60_000).toISOString();
        db.prepare('UPDATE group_members SET updated_at = ? WHERE group_id = ? AND member_pubkey = ?').run(aheadIso, g, k.pk);
        db.transaction(() => setMembershipFromEpoch(g, k.pk, 7))();
        const row = db.prepare('SELECT from_epoch, updated_at FROM group_members WHERE group_id = ? AND member_pubkey = ?').get(g, k.pk) as { from_epoch: number; updated_at: string };
        assert(row.from_epoch === 7 && row.updated_at > aheadIso,
            `from_epoch 7, and updated_at moved past the stamp 60 s ahead (${row.updated_at} > ${aheadIso}), so a replica takes it`);
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    console.log(`\n${passed}/${run + 1} passed (stopped: ${e?.message ?? e})`);
    process.exit(1);
});

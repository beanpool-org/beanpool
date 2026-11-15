/**
 * A bill with an invite, slice B3 (scratch/fable-design/DESIGN-getting-paid-fable.md §4.5, §8 B3, §9 B3; Marty took every
 * recommendation on 11 Nov 2026, and on 15 Nov said build the rest).
 *
 * Over real HTTP with real signatures, against the real middleware. Every section ends in assertConserved: a bill moves no
 * Bean until its payer pays it.
 *
 *  1. An invite made with a bill: the answer and the maker's own list carry it; the row waits with no payer, as long as the
 *     invite does; nobody's list shows it but its sender's ("waiting for them to join"). An invite with no bill is as before.
 *  2. Refusals, nothing written (no invite, no bill): a bad amount, "what for" or id; bills off; the bill counted as one of the
 *     day's 3 to someone new (429 with resetsAt). A retry (the same bill id) answers the same invite; the same id for another
 *     bill is 409.
 *  3. The redeem gives the bill its payer in the redeem's own transaction: the key that joined and no other, its 30 days from
 *     the join; a bind that fails undoes the join. Never shown while they join (no notice, nothing in the redeem's answer);
 *     after, one row, amber and counted: the inviter is someone they know.
 *  4. A newcomer with a vouch on the same invite and an Offer still can't pay their inviter's first bill on credit; with Beans
 *     held they can.
 *  5. An offline ticket carries none: a joiner by the inviter's ticket gets no bill, and the invite's bill keeps waiting.
 *  6. A standby answers the same: it refuses the invite, the redeem and the revoke, writes nothing, and reads the newcomer's
 *     bill exactly as the main server does.
 *  7. Account closed, as B1: the inviter's closed account withdraws the invite's bill and its invite admits nobody; a payer's
 *     closed account ends the bill waiting on them.
 *  8. Closing the class: one table over (invite with bill: redeemed / revoked before / expired before / redeemed twice /
 *     redeemed by a key a re-key replaced / redeemed, then re-keyed / inviter re-keyed, then redeemed) × (who sees it: the
 *     joiner, a second joiner, a member with nothing to do with it, the sender) → the bill's row and each one's read.
 *
 * Run: SERVER_SUITES_ONLY=test-bills-invite TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { wrapCreatePost } from './post-test-helper.js';
import { initStateEngine, transfer, createPost as rawCreatePost, getCommonsBalanceExact, runLedgerAudit, purgeMemberSelf } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { db } from './db/db.js';
import { setNodeRole } from './config/node-role.js';
import { setSwitchOverride } from './config/node-profile.js';
import { expireBills } from './engine/bills.js';
import { setMemberPhoto } from '@beanpool/engine';
import { BILL_RULES, INVITE_LIFE_MS, feeOf } from '@beanpool/core';
import { signRequest, SIGNED_FOR_HEADER, signedForHost, offlineTicket } from './signed-request-test-helper.js';
const createPost = wrapCreatePost(rawCreatePost);

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); }
}

const DAY = 86_400_000;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
let BASE = '';
type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any };
const show = (r: Res | undefined) => (r ? `${r.status} ${JSON.stringify(r.body)?.slice(0, 240)}` : '-');
const hc = (beans: number) => Math.round(beans * 100);
let names = 0;
/** A fresh name each time: a callsign is one person's here. */
const nameFor = (base: string) => `${base}${++names}`;

function newKey(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}
/** A member with a face and a name, holding `beans`, with a live Offer of their own (a jar of jam). */
function member(base: string, beans = 0): Id & { jam: any } {
    const id = newKey(nameFor(base));
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'TEST', 'active')`).run(id.pk, id.name);
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    if (beans > 0) transfer('genesis', id.pk, hc(beans), `seed ${id.name}`, 'direct', true);
    const jam = createPost('offer', 'general', `${id.name}'s jam`, 'A jar of plum jam', 500, 'fixed', id.pk, undefined, undefined, undefined, true) as any;
    return { ...id, jam };
}

async function call(id: Id | null, method: 'GET' | 'POST' | 'DELETE', path: string, body?: Record<string, unknown>): Promise<Res> {
    resetGatewayRateLimit();
    pruneAuthAttempts(Date.now() + 120_000);
    const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = signRequest(id.priv, { method, path: path.split('?')[0], timestamp: ts, nonce, body: bodyString });
        headers[SIGNED_FOR_HEADER] = signedForHost();
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : bodyString });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

/** An invite as the panel makes one: with `bill` when the fold was filled. */
const invite = (maker: Id, extra: Record<string, unknown> = {}) => call(maker, 'POST', '/api/invite/generate', { publicKey: maker.pk, ...extra });
const withBill = (beans: number, whatFor: string, id: string = crypto.randomUUID()) => ({ bill: { id, whatFor, amount_c: hc(beans) } });
const redeem = (who: Id, code: string) => call(who, 'POST', '/api/invite/redeem', { code, publicKey: who.pk, callsign: who.name });
const revoke = (who: Id, code: string) => call(who, 'DELETE', `/api/invite/${encodeURIComponent(code)}`);
const pay = (who: Id, billId: string) => call(who, 'POST', `/api/bills/${billId}/pay`, {});

const billRow = (id: string) => db.prepare('SELECT * FROM bills WHERE id = ?').get(id) as any;
const billOn = (code: string) => db.prepare('SELECT * FROM bills WHERE invite_code = ?').get(code) as any;
const inviteRow = (code: string) => db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code) as any;
const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
const bills = () => count('SELECT COUNT(*) AS n FROM bills');
const invites = () => count('SELECT COUNT(*) AS n FROM invite_codes');
const isMember = (pk: string) => count(`SELECT COUNT(*) AS n FROM members WHERE public_key = ? AND status = 'active'`, pk) === 1;
const bal = (pk: string) => (db.prepare('SELECT balance_c FROM accounts WHERE public_key = ?').get(pk) as { balance_c: number } | undefined)?.balance_c ?? 0;
const keptNotices = (pk: string) => count('SELECT COUNT(*) AS n FROM moderation_notices WHERE recipient = ?', pk);

/** The bills a key reads (GET /api/bills), or null where it may not read them at all. */
async function read(who: Id): Promise<{ toPay: any[]; sent: any[] } | null> {
    const r = await call(who, 'GET', '/api/bills');
    return r.status === 200 ? { toPay: r.body?.toPay ?? [], sent: r.body?.sent ?? [] } : null;
}
const sees = async (who: Id, billId: string) => !!(await read(who))?.toPay.some((b) => b.id === billId);

function nodeTotal(): number {
    const accounts = (db.prepare(`SELECT COALESCE(SUM(balance_c), 0) t FROM accounts WHERE public_key != 'COMMONS_POOL'`).get() as any).t;
    return accounts + getCommonsBalanceExact();
}
function assertConserved(step: string): void {
    const audit = runLedgerAudit();
    assert(audit.ok && audit.drift === 0 && nodeTotal() === 0, `${step}: the Beans are conserved (audit ${audit.ok ? 'ok' : 'FAILED'}, drift ${audit.drift}, total ${nodeTotal()})`);
}

async function rekey(who: Id): Promise<Id> {
    const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
    const next = newKey(who.name);
    completeRekey(who.pk, next.pk, issueRekeyCode(who.pk, 'owner:password').code, 'owner:password');
    return next;
}

async function main(): Promise<void> {
    console.log('\nA bill with an invite (B3)\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    // ── 1. An invite made with a bill ─────────────────────────────────────────────────────────────────────────────────
    console.log('── 1. Made with a bill ──');
    const rob = member('Rob');
    const outsider = member('Ola', 50);
    const made = await invite(rob, withBill(60, 'Power, October'));
    const code = made.body?.invite?.code as string;
    const row1 = code ? billOn(code) : undefined;
    assert(made.status === 200 && made.body.invite.bill?.whatFor === 'Power, October' && made.body.invite.bill.amount_c === hc(60) && typeof made.body.invite.bill.id === 'string',
        `Rob makes an invite with a bill of 60 Beans: the answer carries it (${show(made)})`);
    assert(row1 && row1.payer_pubkey === null && row1.state === 'sent' && row1.biller_pubkey === rob.pk && row1.sent_by === rob.pk && row1.delivered_at === null
        && row1.expires_at === new Date(Date.parse(inviteRow(code).created_at) + INVITE_LIFE_MS).toISOString(),
        `the bill waits with the invite: no payer, nothing delivered, as long as the invite works (${JSON.stringify(row1)?.slice(0, 260)})`);
    const mine = await call(rob, 'GET', `/api/invite/mine/${rob.pk}`);
    const mineRow = (mine.body?.invites ?? []).find((i: any) => i.code === code);
    assert(mineRow?.bill?.whatFor === 'Power, October' && mineRow.bill.amount_c === hc(60), `Rob's own list says the invite carries it (${JSON.stringify(mineRow?.bill)})`);
    const robSent = (await read(rob))?.sent.find((b) => b.id === row1?.id);
    assert(robSent?.awaitingJoin === true && robSent.state === 'sent' && robSent.payerPublicKey === '', `Rob's bills: it waits for someone to join (${JSON.stringify(robSent)?.slice(0, 200)})`);
    assert(!(await sees(outsider, row1?.id)), 'nobody else reads it: it has no payer');
    const plain = await invite(rob);
    assert(plain.status === 200 && plain.body.invite.bill === undefined && !billOn(plain.body.invite.code)
        && !(((await call(rob, 'GET', `/api/invite/mine/${rob.pk}`)).body?.invites ?? []).find((i: any) => i.code === plain.body.invite.code)?.bill),
        'an invite with no bill is as before: no bill row, none in the answer or the list');
    assertConserved('made with a bill');

    // ── 2. Refusals and retries ───────────────────────────────────────────────────────────────────────────────────────
    console.log('── 2. Refusals and retries ──');
    const sal = member('Sal');
    const before2 = { bills: bills(), invites: invites() };
    const unchanged = () => bills() === before2.bills && invites() === before2.invites;
    const zero = await invite(sal, { bill: { whatFor: 'Fence paint', amount_c: 0 } });
    const over = await invite(sal, { bill: { whatFor: 'Fence paint', amount_c: BILL_RULES.maxAmount_c + 1 } });
    const short = await invite(sal, { bill: { whatFor: 'ab', amount_c: hc(5) } });
    const badId = await invite(sal, { bill: { id: 'x', whatFor: 'Fence paint', amount_c: hc(5) } });
    assert(zero.status === 400 && zero.body?.code === 'bill_amount' && over.body?.code === 'bill_amount' && short.body?.code === 'bill_what_for' && badId.body?.code === 'bill_id' && unchanged(),
        `a bad amount, "what for" or id is refused in the bill's words, and no invite is made (${show(zero)} · ${show(short)} · ${show(badId)})`);
    setSwitchOverride('bills', false);
    const off = await invite(sal, withBill(5, 'Fence paint'));
    setSwitchOverride('bills', true);
    assert(off.status === 404 && off.body?.code === 'feature_off' && unchanged(), `bills off: 404 feature_off, and no invite is made (${show(off)})`);
    // The day's 3 to people never dealt with: a bill on an invite is one of them, beside bills sent to strangers.
    const stranger = member('Tia');
    const direct = await call(sal, 'POST', '/api/bills', { id: crypto.randomUUID(), to: stranger.pk, amount_c: hc(4), whatFor: 'Eggs' });
    const i1 = await invite(sal, withBill(5, 'Seedlings'));
    const i2 = await invite(sal, withBill(5, 'Compost'));
    const before2b = { bills: bills(), invites: invites() };
    const i3 = await invite(sal, withBill(5, 'Mulch'));
    assert(direct.status === 200 && i1.status === 200 && i2.status === 200 && i3.status === 429 && i3.body?.code === 'bills_new_people_day' && typeof i3.body?.resetsAt === 'string'
        && bills() === before2b.bills && invites() === before2b.invites,
        `a bill sent and two invites with bills make the day's 3 to new people: the fourth is 429 with resetsAt and no invite (${show(i3)})`);
    const una = member('Una');
    const retryId = crypto.randomUUID();
    const first = await invite(una, withBill(12, 'Bread, two weeks', retryId));
    const before2c = { bills: bills(), invites: invites() };
    const again = await invite(una, withBill(12, 'Bread, two weeks', retryId));
    assert(first.status === 200 && again.status === 200 && again.body?.invite?.code === first.body?.invite?.code && again.body.invite.bill?.id === retryId
        && bills() === before2c.bills && invites() === before2c.invites,
        `the same bill again is a retry: the same invite, nothing written (${show(again)})`);
    const reused = await invite(una, withBill(13, 'Bread, two weeks', retryId));
    assert(reused.status === 409 && reused.body?.code === 'bill_id_reused' && bills() === before2c.bills && invites() === before2c.invites,
        `the same id for another bill is 409, nothing written (${show(reused)})`);
    assertConserved('refusals');

    // ── 3. The redeem gives it its payer, in its own transaction ──────────────────────────────────────────────────────
    console.log('── 3. The redeem binds it ──');
    const kim = newKey(nameFor('Kim'));
    // A bind that can't be written undoes the whole join: the same transaction.
    db.exec(`CREATE TEMP TRIGGER b3_refuse_bind BEFORE UPDATE OF payer_pubkey ON bills BEGIN SELECT RAISE(ABORT, 'b3 test: bind refused'); END;`);
    let failed: Res;
    try { failed = await redeem(kim, code); } finally { db.exec('DROP TRIGGER IF EXISTS b3_refuse_bind'); }
    assert(failed.status >= 400 && !isMember(kim.pk) && inviteRow(code).used_by === null && billOn(code).payer_pubkey === null,
        `a bind that fails undoes the join: no member, the code unused, the bill unbound (${show(failed)})`);
    const joined = await redeem(kim, code);
    const row3 = billOn(code);
    assert(joined.status === 200 && isMember(kim.pk) && inviteRow(code).used_by === kim.pk && row3.payer_pubkey === kim.pk,
        `Kim joins with Rob's invite: the bill is hers, the key that joined (${show(joined)})`);
    assert(row3.delivered_at && Math.abs(Date.parse(row3.delivered_at) - Date.parse(inviteRow(code).used_at)) < 5_000
        && row3.expires_at === new Date(Date.parse(row3.delivered_at) + BILL_RULES.waitDays * DAY).toISOString(),
        `it reaches her at the join and waits 30 days from then (${row3.delivered_at} → ${row3.expires_at})`);
    assert(joined.body?.bill === undefined && !JSON.stringify(joined.body).includes(row3.id) && keptNotices(kim.pk) === 0,
        'never shown while she joins: nothing in the redeem\'s answer, no notice kept');
    const kimRead = (await read(kim))?.toPay ?? [];
    const kimBill = kimRead.find((b) => b.id === row3.id);
    assert(kimRead.length === 1 && kimBill?.known === true && kimBill.creditOpen === false && kimBill.billerName === rob.name && kimBill.amount_c === hc(60),
        `after the welcome it is one bill to pay, from someone she knows, on Beans held (${JSON.stringify(kimBill)?.slice(0, 240)})`);
    const needs = ((await call(kim, 'GET', '/api/home?cards=needs&lands=bills')).body?.cards?.needs?.items ?? []) as any[];
    const line = needs.filter((i) => i.kind === 'bill');
    assert(line.length === 1 && line[0].accent === true && line[0].count === 1 && line[0].label === `Bill from ${rob.name}: Power, October · 60 Beans` && line[0].target?.id === row3.id,
        `her one row: amber and counted (${JSON.stringify(line)?.slice(0, 240)})`);
    const robSent3 = (await read(rob))?.sent.find((b) => b.id === row3.id);
    assert(robSent3?.payerPublicKey === kim.pk && robSent3.awaitingJoin === undefined && robSent3.state === 'sent', 'Rob\'s bills: now Kim\'s, not paid');
    assertConserved('the redeem binds it');

    // ── 4. A vouch and an Offer give room, not Beans: the inviter's first bill takes Beans held ──────────────────────
    console.log('── 4. Vouch, Offer, first bill ──');
    const vic = member('Vic');
    db.prepare(`INSERT INTO vouchers (member_pubkey, source, made_by) VALUES (?, 'role', 'b3-test')`).run(vic.pk);
    db.prepare(`INSERT INTO voucher_allocations (id, member_pubkey, kind, amount_c, actor) VALUES (?, ?, 'grant', ?, 'b3-test')`).run(crypto.randomUUID(), vic.pk, hc(1000));
    const vInv = await invite(vic, { vouchAmount: hc(100), ...withBill(30, 'Firewood') });
    const wes = newKey(nameFor('Wes'));
    const wesJoin = await redeem(wes, vInv.body?.invite?.code);
    // A photo first: the marketplace asks every member for one before their first listing.
    setMemberPhoto(db, wes.pk, AVATAR);
    createPost('offer', 'general', `${wes.name}'s soup`, 'A pot of soup', 800, 'fixed', wes.pk, undefined, undefined, undefined, true);
    const room = (await call(wes, 'GET', `/api/ledger/balance/${wes.pk}`)).body;
    const wBill = billOn(vInv.body?.invite?.code);
    const tried = await pay(wes, wBill?.id);
    assert(vInv.status === 200 && wesJoin.status === 200 && wesJoin.body?.vouch?.landed > 0 && room?.usableFloor_c < 0 && room.balance_c === 0,
        `Wes joins with Vic's invite carrying a 100 vouch and a bill, and posts an Offer: he has room, no Beans (${show(vInv)} · ${JSON.stringify(room)?.slice(0, 160)})`);
    assert(tried.status === 409 && tried.body?.code === 'bill_nothing' && billRow(wBill.id).state === 'sent' && bal(wes.pk) === 0,
        `he still can't pay his inviter's first bill on credit: refused in his money line, nothing moved (${show(tried)})`);
    transfer('genesis', wes.pk, hc(40), 'seed', 'direct', true);
    const vicBefore = bal(vic.pk);
    const paid = await pay(wes, wBill.id);
    assert(paid.status === 200 && bal(wes.pk) === hc(10) && bal(vic.pk) - vicBefore === hc(30) - feeOf(hc(30)) && billRow(wBill.id).state === 'paid',
        `with 40 Beans held he pays it: −30, Vic +29.55 after the 1.5% (${show(paid)})`);
    assertConserved('vouch and first bill');

    // ── 5. An offline ticket carries none ─────────────────────────────────────────────────────────────────────────────
    console.log('── 5. Offline ticket ──');
    const pia = member('Pia');
    const pInv = await invite(pia, withBill(8, 'Jam jars'));
    const viaTicket = newKey(nameFor('Tom'));
    const tk = await call(viaTicket, 'POST', '/api/invite/redeem-offline', { ticketB64: offlineTicket(pia.priv, pia.pk), publicKey: viaTicket.pk, callsign: viaTicket.name });
    assert(tk.status === 200 && isMember(viaTicket.pk) && ((await read(viaTicket))?.toPay.length ?? -1) === 0 && billOn(pInv.body?.invite?.code)?.payer_pubkey === null,
        `Tom joins by Pia's paper ticket: no bill is his, and the bill on her invite still waits (${show(tk)})`);
    assertConserved('offline ticket');

    // ── 6. A standby answers the same ────────────────────────────────────────────────────────────────────────────────
    console.log('── 6. Standby ──');
    const mainRead = await call(kim, 'GET', '/api/bills');
    const quinn = member('Quinn');
    const qInv = await invite(quinn, withBill(9, 'Plums'));
    const before6 = { bills: bills(), invites: invites() };
    const sbJoiner = newKey(nameFor('Sid'));
    setNodeRole('backup');
    let sbMake: Res, sbRedeem: Res, sbRevoke: Res, sbRead: Res;
    try {
        sbMake = await invite(quinn, withBill(9, 'Pears'));
        sbRedeem = await redeem(sbJoiner, qInv.body?.invite?.code);
        sbRevoke = await revoke(quinn, qInv.body?.invite?.code);
        sbRead = await call(kim, 'GET', '/api/bills');
    } finally {
        setNodeRole('primary');
    }
    assert(sbMake.status >= 400 && sbRedeem.status >= 400 && sbRevoke.status >= 400 && bills() === before6.bills && invites() === before6.invites
        && billOn(qInv.body?.invite?.code)?.payer_pubkey === null && billOn(qInv.body?.invite?.code)?.state === 'sent' && !isMember(sbJoiner.pk),
        `a standby refuses the invite with a bill, the redeem and the revoke, and writes nothing (${sbMake.status}, ${sbRedeem.status}, ${sbRevoke.status})`);
    assert(sbRead.status === 200 && JSON.stringify(sbRead.body) === JSON.stringify(mainRead.body), 'and reads the newcomer\'s bill exactly as the main server does');
    assertConserved('standby');

    // ── 7. Account closed, as B1 ──────────────────────────────────────────────────────────────────────────────────────
    console.log('── 7. Account closed ──');
    const gus = member('Gus');
    const gInv = await invite(gus, withBill(6, 'Seed potatoes'));
    const gCode = gInv.body?.invite?.code as string;
    const closed = purgeMemberSelf(gus.pk);
    const late = newKey(nameFor('Lea'));
    const lateJoin = await redeem(late, gCode);
    assert(closed.ok && billOn(gCode)?.state === 'withdrawn' && billOn(gCode)?.payer_pubkey === null && lateJoin.status === 400 && !isMember(late.pk),
        `Gus closes his account: the invite's bill is withdrawn, and his invite admits nobody (${show(lateJoin)})`);
    const hal = member('Hal');
    const hInv = await invite(hal, withBill(6, 'Kindling'));
    const ivy = newKey(nameFor('Ivy'));
    await redeem(ivy, hInv.body?.invite?.code);
    const ivyClosed = purgeMemberSelf(ivy.pk);
    assert(ivyClosed.ok && billOn(hInv.body?.invite?.code)?.state === 'expired', 'Ivy joins with Hal\'s invite and closes her account: the bill waiting on her ends');
    assertConserved('account closed');

    // ── 8. Closing the class: the table ──────────────────────────────────────────────────────────────────────────────
    console.log('── 8. The table ──');
    type Expect = { state: string; payer: 'joiner' | 'joinerNew' | null; joiner: boolean; second: boolean; other: boolean; senderState: string; awaiting: boolean };
    type World = { inviter: Id; joiner: Id; joinerNow: Id; second: Id; other: Id; code: string; billId: string; sender: Id };
    const scenarios: Array<{ name: string; act: (w: World) => Promise<void>; expect: Expect }> = [
        { name: 'redeemed', act: async (w) => { await redeem(w.joiner, w.code); },
            expect: { state: 'sent', payer: 'joiner', joiner: true, second: false, other: false, senderState: 'sent', awaiting: false } },
        { name: 'revoked before', act: async (w) => { await revoke(w.inviter, w.code); await redeem(w.joiner, w.code); },
            expect: { state: 'withdrawn', payer: null, joiner: false, second: false, other: false, senderState: 'withdrawn', awaiting: false } },
        { name: 'expired before', act: async (w) => {
                // Its 30 days are over: made 31 days ago, as the invite's own date says; then the hourly expiry and a late join.
                db.prepare('UPDATE invite_codes SET created_at = ? WHERE code = ?').run(new Date(Date.now() - 31 * DAY).toISOString(), w.code);
                expireBills(Date.now() + 31 * DAY - 1);
                await redeem(w.joiner, w.code);
            },
            expect: { state: 'expired', payer: null, joiner: false, second: false, other: false, senderState: 'expired', awaiting: false } },
        { name: 'redeemed twice', act: async (w) => { await redeem(w.joiner, w.code); await redeem(w.second, w.code); await redeem(w.joiner, w.code); },
            expect: { state: 'sent', payer: 'joiner', joiner: true, second: false, other: false, senderState: 'sent', awaiting: false } },
        { name: 'redeemed by a key a re-key replaced', act: async (w) => {
                // The joiner is the old key of a member who has since moved to a new one: it joins nothing, the bill keeps waiting.
                const moved = member('Old');
                await rekey(moved);
                w.joiner = moved;
                w.joinerNow = moved;
                await redeem(moved, w.code);
            },
            expect: { state: 'sent', payer: null, joiner: false, second: false, other: false, senderState: 'sent', awaiting: true } },
        { name: 'redeemed, then the joiner re-keyed', act: async (w) => { await redeem(w.joiner, w.code); w.joinerNow = await rekey(w.joiner); },
            expect: { state: 'sent', payer: 'joinerNew', joiner: true, second: false, other: false, senderState: 'sent', awaiting: false } },
        { name: 'the inviter re-keyed, then redeemed', act: async (w) => { w.sender = await rekey(w.inviter); await redeem(w.joiner, w.code); },
            expect: { state: 'sent', payer: 'joiner', joiner: true, second: false, other: false, senderState: 'sent', awaiting: false } },
    ];
    for (const sc of scenarios) {
        const inviter = member('Ina');
        const made8 = await invite(inviter, withBill(15, 'Garden hire'));
        const w: World = {
            inviter, joiner: newKey(nameFor('Jo')), joinerNow: null as any, second: newKey(nameFor('Sec')), other: member('Oth', 30),
            code: made8.body?.invite?.code, billId: made8.body?.invite?.bill?.id, sender: inviter,
        };
        w.joinerNow = w.joiner;
        const before = nodeTotal();
        await sc.act(w);
        const r = billRow(w.billId);
        const e = sc.expect;
        const payerKey = e.payer === 'joiner' ? w.joiner.pk : e.payer === 'joinerNew' ? w.joinerNow.pk : null;
        const got = {
            state: r?.state, payer: r?.payer_pubkey ?? null,
            joiner: await sees(w.joinerNow, w.billId), second: await sees(w.second, w.billId), other: await sees(w.other, w.billId),
            sender: (await read(w.sender))?.sent.find((b) => b.id === w.billId),
        };
        // A replaced key reads nothing at all (the middleware refuses it), so its old self never sees the bill either.
        const oldKeyRead = w.joinerNow !== w.joiner ? await read(w.joiner) : null;
        assert(made8.status === 200 && got.state === e.state && got.payer === payerKey,
            `${sc.name}: the bill is ${e.state}, payer ${e.payer ?? 'nobody'} (got ${got.state}, ${got.payer === null ? 'nobody' : got.payer === w.joiner.pk ? 'joiner' : got.payer === w.joinerNow.pk ? 'joinerNew' : 'SOMEONE ELSE'})`);
        assert(got.joiner === e.joiner && got.second === e.second && got.other === e.other && oldKeyRead === null,
            `${sc.name}: the joiner ${e.joiner ? 'sees' : 'does not see'} it, a second joiner and an unrelated member never do (got ${got.joiner}/${got.second}/${got.other})`);
        assert(got.sender?.state === e.senderState && (got.sender?.awaitingJoin === true) === e.awaiting && (e.payer ? got.sender?.payerPublicKey === payerKey : got.sender?.payerPublicKey === ''),
            `${sc.name}: the sender reads ${e.senderState}${e.awaiting ? ', waiting for someone to join' : ''} (got ${JSON.stringify(got.sender)?.slice(0, 160)})`);
        assert(nodeTotal() === before && count('SELECT COUNT(*) AS n FROM transactions WHERE auth_payload = ?', `bill:${w.billId}`) === 0,
            `${sc.name}: nothing is ever taken by itself: no Bean moved, no ledger row`);
    }
    assertConserved('the table');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

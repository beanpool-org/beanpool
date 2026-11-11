/**
 * Bills, slice B1 (scratch/fable-design/DESIGN-getting-paid-fable.md §4, §5, §9; Marty took every recommendation, 11 Nov 2026):
 * a request to pay, never a payment.
 *
 * Over real HTTP with real signatures, against the real middleware (the money limits, the standby gate, the feature switches).
 * Every section ends in assertConserved.
 *
 *  0. Beans off: every bill route answers 403 profile_no_beans, and nothing is written.
 *  1. Pay moves the amount once, with the fee: payer − 60, sender + 59.10, the Commons + 0.90; one ledger row naming the payer
 *     and `bill:<id>`; no deal row; the sender told; one payment counted against the payer's money limits.
 *  2. Retries: the same requestId answers the first payment and moves nothing; a second payment of a paid bill is refused; the
 *     same send again is the same bill; the same id for another bill is 409.
 *  3. Two pays at once: one wins.
 *  4. A first bill (never dealt) can't take the payer below zero, whatever their line; after one finished deal it can.
 *  5. No room: refused in the payer's own money line, nothing written.
 *  6. Decline, withdraw and expiry move nothing; the sender's read can't tell declined from waiting; a declined bill is
 *     withdrawn as a waiting one is.
 *  7. A bill to someone who blocked its sender is taken, never listed, never told, and can't be paid.
 *  8. Limits: the 11th bill of a day and the 4th to new people are 429 with resetsAt; the 4th not paid to one person (a
 *     declined one counted) and the 21st out are 429.
 *  9. Three reporters hold the sender: no new bill, none of theirs listed or paid; the owners told once; a report handled lifts it.
 * 10. An enterprise sends a bill by its keeper and is paid; a bill to an enterprise is refused: an enterprise pays none.
 * 11. Bills off: 404 feature_off.
 * 12. A standby refuses every write.
 * 13. A re-key moves both sides.
 * 14. A closed account's bills end.
 * 15. The Home answer: one line per bill waiting, known amber, a stranger's calm; none to an app that doesn't open a bill.
 * 16. What a bill may be about: the sender's own listing, or the standing deal between the two; never a Local knowledge page.
 *
 * The deciding review of 6bc2ece9 (#3066), one section a finding:
 * 17. A hold follows the person, both ways: a member held by reports sends no bill for an enterprise they keep, and the bill
 *     they sent for it before is neither listed nor paid; an enterprise held by reports holds its keepers' own bills too.
 * 18. Whether a report on a bill is child safety is the reporter's choice alone, never the bill's words: kept, marked, listed
 *     and alerted on the reporter's reason; the queue still reads what the bill was for and how much.
 * 19. A withdrawn bill still counts: towards the 3 not paid to one person in 30 days, and the day's counts.
 *
 * Run: SERVER_SUITES_ONLY=test-bills TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { wrapCreatePost } from './post-test-helper.js';
import {
    initStateEngine, transfer, createPost as rawCreatePost, getCommonsBalanceExact, runLedgerAudit, adminSetTier, acceptPost,
    completePostTransaction, dismissReport, purgeMemberSelf, getReports,
} from './state-engine.js';
import { getAlertsStatus } from './services/alerts.js';
import { startHttpsServer } from './https-server.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { db } from './db/db.js';
import { setNodeRole } from './config/node-role.js';
import { getProfileSwitches, setSwitchOverride } from './config/node-profile.js';
import { expireBills } from './engine/bills.js';
import { setMemberPhoto } from '@beanpool/engine';
import { BILL_RULES, feeOf } from '@beanpool/core';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';
const createPost = wrapCreatePost(rawCreatePost);

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); }
}

const DAY = 86_400_000;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
let BASE = '';
type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any; headers?: Headers };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 260)}`;
/** Beans in the story, whole hundredths at the node. */
const hc = (beans: number) => Math.round(beans * 100);

function newKey(): { pk: string; priv: crypto.KeyObject } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey };
}
/** A member with a face and a name, and no Offer: what a member is before any Bean moves. */
function bareMember(name: string, opts: { treasury?: boolean } = {}): Id {
    const id = { ...newKey(), name };
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_treasury)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'TEST', 'active', ?)`).run(id.pk, name, opts.treasury ? 1 : 0);
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    return id;
}
/** A member holding `beans`, with one live Offer of their own (a jar of jam, 5 Beans), so a credit line they have is open. */
function makeMember(name: string, beans: number, opts: { treasury?: boolean } = {}): Id & { jam: any } {
    const id = bareMember(name, opts);
    if (beans > 0) transfer('genesis', id.pk, hc(beans), `seed ${name}`, 'direct', true);
    // Repeatable, so more than one member can buy it (finishDeal).
    const jam = createPost('offer', 'general', `${name}'s jam`, 'A jar of plum jam', 500, 'fixed', id.pk, undefined, undefined, undefined, true) as any;
    return { ...id, jam };
}

async function call(id: Id | null, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<Res> {
    resetGatewayRateLimit();
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
    return { status: res.status, body: json, headers: res.headers };
}
const post = (id: Id, path: string, body: Record<string, unknown> = {}) => call(id, 'POST', path, body);

/** Send a bill as an app does: its own new id, the signer the sender. */
async function bill(from: Id, to: Id | string, beans: number, whatFor: string, extra: Record<string, unknown> = {}): Promise<Res & { id: string }> {
    const id = (extra.id as string) ?? crypto.randomUUID();
    const r = await post(from, '/api/bills', { id, to: typeof to === 'string' ? to : to.pk, amount_c: hc(beans), whatFor, ...extra });
    return { ...r, id };
}
const pay = (who: Id, billId: string, requestId?: string) => post(who, `/api/bills/${billId}/pay`, requestId ? { requestId } : {});
const billRow = (id: string) => db.prepare('SELECT * FROM bills WHERE id = ?').get(id) as any;
const bal = (pk: string) => (db.prepare('SELECT balance_c FROM accounts WHERE public_key = ?').get(pk) as { balance_c: number } | undefined)?.balance_c ?? 0;
const ledgerRows = (payload: string) => db.prepare('SELECT * FROM transactions WHERE auth_payload = ?').all(payload) as any[];
const dealRows = () => (db.prepare('SELECT COUNT(*) AS n FROM marketplace_transactions').get() as { n: number }).n;
const notices = (pk: string, kind: string) => (db.prepare('SELECT body, data FROM moderation_notices WHERE recipient = ? ORDER BY created_at, rowid').all(pk) as { body: string; data: string }[])
    .filter((r) => { try { return JSON.parse(r.data).kind === kind; } catch { return false; } });
const toPay = async (who: Id) => ((await call(who, 'GET', '/api/bills')).body?.toPay ?? []) as any[];
const sentList = async (who: Id) => ((await call(who, 'GET', '/api/bills')).body?.sent ?? []) as any[];

function nodeTotal(): number {
    const accounts = (db.prepare(`SELECT COALESCE(SUM(balance_c), 0) t FROM accounts WHERE public_key != 'COMMONS_POOL'`).get() as any).t;
    return accounts + getCommonsBalanceExact();
}
function assertConserved(step: string): void {
    const audit = runLedgerAudit();
    assert(audit.ok && audit.drift === 0 && nodeTotal() === 0, `${step}: the Beans are conserved (audit ${audit.ok ? 'ok' : 'FAILED'}, drift ${audit.drift}, total ${nodeTotal()})`);
}

/** `member` keeps `enterprise`: a keeper's row, and can_operate, as createTreasury leaves its lead keeper. */
function keepEnterprise(enterprise: Id, member: Id): void {
    db.prepare('INSERT INTO treasury_operators (treasury_pubkey, member_pubkey) VALUES (?, ?)').run(enterprise.pk, member.pk);
    db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(member.pk);
}

/** A report as the owners' queue reads it (getReports: what both queue routes answer). */
const queued = (id: string | undefined) => getReports('all').reports.find((r) => r.id === id);
/** A report's reason as the node keeps it. */
const storedReason = (id: string | undefined) => (db.prepare('SELECT reason FROM abuse_reports WHERE id = ?').get(id ?? '') as { reason: string } | undefined)?.reason;
/** Child-safety alerts told so far (each at once, urgent and pushed). */
const childTold = () => getAlertsStatus().history.filter((e) => e.key === 'reports.child').reduce((n, e) => n + (e.count ?? 1), 0);

/** A finished deal between the two on `seller`'s jam: what opens a payer's credit line to a seller's bills. */
function finishDeal(buyer: Id, seller: Id & { jam: any }): void {
    const tx = acceptPost(seller.jam.id, buyer.pk);
    const done = completePostTransaction(tx.id, buyer.pk);
    assert(done?.status === 'completed', `${buyer.name} bought ${seller.name}'s jam and the deal is finished`);
}

async function main(): Promise<void> {
    console.log('\nBills: a request to pay, never a payment\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    // ── 0. Beans off: before any Bean has moved here, so the switch holds ──────────────────────────────────────────────
    console.log('── 0. Beans off ──');
    const early = bareMember('Early');
    const earlier = bareMember('Earlier');
    setSwitchOverride('beans', false);
    const off = getProfileSwitches();
    assert(!off.beans && !off.bills, `with Beans off, bills are off too (beans ${off.beans}, bills ${off.bills})`);
    const offSend = await bill(early, earlier, 5, 'Fence paint');
    const offList = await call(early, 'GET', '/api/bills');
    const offPay = await pay(early, 'no-such-bill-0000');
    assert(offSend.status === 403 && offSend.body?.code === 'profile_no_beans' && offList.status === 403 && offPay.status === 403,
        `every bill route answers 403 profile_no_beans (${show(offSend)} · ${offList.status} · ${offPay.status})`);
    assert((db.prepare('SELECT COUNT(*) AS n FROM bills').get() as { n: number }).n === 0, 'nothing was written');
    setSwitchOverride('beans', true);
    assert(getProfileSwitches().bills === true, 'Beans back on: bills are on (a local community)');
    assertConserved('Beans off');

    const rob = makeMember('Rob', 0);
    const kim = makeMember('Kim', 100);
    const ana = makeMember('Ana', 300);

    // ── 1. Pay moves the amount once, with the fee ─────────────────────────────────────────────────────────────────────
    console.log('── 1. Send and pay ──');
    const b1 = await bill(rob, kim, 60, 'Power, October');
    assert(b1.status === 200 && b1.body?.bill?.state === 'sent' && b1.body.bill.amount_c === hc(60) && billRow(b1.id)?.payer_pubkey === kim.pk,
        `Rob sends Kim a bill of 60 Beans (${show(b1)})`);
    assert(billRow(b1.id).expires_at === new Date(Date.parse(billRow(b1.id).delivered_at) + BILL_RULES.waitDays * DAY).toISOString(), 'it waits 30 days from reaching Kim');
    const listed = await toPay(kim);
    assert(listed.length === 1 && listed[0].id === b1.id && listed[0].role === 'to-pay' && listed[0].creditOpen === false && listed[0].billerName === 'Rob',
        `Kim's To pay lists it, from Rob, her credit line not open to it (${JSON.stringify(listed[0] ?? null)?.slice(0, 200)})`);
    const before = { kim: bal(kim.pk), rob: bal(rob.pk), commons: getCommonsBalanceExact(), deals: dealRows() };
    const acts = () => (db.prepare(`SELECT COUNT(*) AS n FROM money_acts WHERE account = ? AND kind = 'payment' AND recipient = ?`).get(kim.pk, rob.pk) as { n: number }).n;
    const actsBefore = acts();
    const p1 = await pay(kim, b1.id, 'req-kim-power-oct');
    const fee = feeOf(hc(60));
    assert(p1.status === 200 && p1.body?.bill?.state === 'paid' && typeof p1.body.transactionId === 'string', `Kim pays it (${show(p1)})`);
    assert(before.kim - bal(kim.pk) === hc(60) && bal(rob.pk) - before.rob === hc(60) - fee && getCommonsBalanceExact() - before.commons === fee && fee === 90,
        `Kim − 60, Rob + 59.10, the Commons + 0.90 (${before.kim - bal(kim.pk)}, ${bal(rob.pk) - before.rob}, ${getCommonsBalanceExact() - before.commons})`);
    const rows1 = ledgerRows(`bill:${b1.id}`);
    assert(rows1.length === 1 && rows1[0].from_pubkey === kim.pk && rows1[0].to_pubkey === rob.pk && rows1[0].amount_c === hc(60) && rows1[0].fee_c === fee
        && rows1[0].auth_signer === kim.pk && rows1[0].memo === 'Bill · Power, October' && billRow(b1.id).ledger_tx_id === rows1[0].id,
        `one ledger row: Kim to Rob, 60, its fee, signed by Kim, "Bill · Power, October", named on the bill (${rows1.length})`);
    assert(dealRows() === before.deals, 'no deal row: a bill is no deal, and builds no credit');
    assert(notices(rob.pk, 'bill_paid').some((n) => n.body === "Kim paid your bill: Power, October · 60 Beans (59.10 after the community's 1.5%)."),
        'Rob is told, with what he received');
    assert(acts() === actsBefore + 1, `one payment to Rob counted against Kim's money limits (${actsBefore} → ${acts()})`);
    assert((await toPay(kim)).length === 0, 'a paid bill leaves Kim\'s To pay');
    assertConserved('one bill paid');

    // ── 2. Retries ──────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 2. Retries ──');
    const again = await pay(kim, b1.id, 'req-kim-power-oct');
    assert(again.status === 200 && again.body?.transactionId === p1.body.transactionId && ledgerRows(`bill:${b1.id}`).length === 1 && acts() === actsBefore + 1,
        `the same requestId answers the first payment and moves nothing, counting nothing (${show(again)})`);
    const second = await pay(kim, b1.id, 'req-kim-power-oct-2');
    assert(second.status === 409 && second.body?.code === 'bill_not_waiting' && ledgerRows(`bill:${b1.id}`).length === 1,
        `paying a paid bill again is refused (${show(second)})`);
    const resend = await bill(rob, kim, 60, 'Power, October', { id: b1.id });
    assert(resend.status === 200 && resend.body?.bill?.id === b1.id && (db.prepare('SELECT COUNT(*) AS n FROM bills WHERE biller_pubkey = ?').get(rob.pk) as any).n === 1,
        `the same send again answers the same bill and writes nothing (${show(resend)})`);
    const reused = await bill(rob, kim, 61, 'Power, October', { id: b1.id });
    assert(reused.status === 409 && reused.body?.code === 'bill_id_reused', `the same id for another bill: 409 (${show(reused)})`);
    assertConserved('retries');

    // ── 3. Two pays at once ─────────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 3. Two pays at once ──');
    const b3 = await bill(rob, kim, 10, 'Water, October');
    const kim3 = bal(kim.pk);
    const both = await Promise.all([pay(kim, b3.id), pay(kim, b3.id)]);
    const wins = both.filter((r) => r.status === 200).length;
    assert(wins === 1 && both.some((r) => r.status === 409) && kim3 - bal(kim.pk) === hc(10) && ledgerRows(`bill:${b3.id}`).length === 1,
        `one wins, one is refused, 10 Beans move once (${both.map((r) => r.status).join(', ')})`);
    assertConserved('two pays at once');

    // ── 4. A first bill is paid with Beans held ─────────────────────────────────────────────────────────────────────────
    console.log('── 4. First bills: Beans held only ──');
    const lee = makeMember('Lee', 10);
    adminSetTier(lee.pk, 'Resident');
    const leeRoom = (await call(lee, 'GET', `/api/ledger/balance/${lee.pk}`)).body;
    assert(leeRoom?.usableFloor_c < 0, `Lee has a credit line open (usable floor ${leeRoom?.usableFloor_c})`);
    const b4 = await bill(rob, lee, 60, 'Garden tools hire');
    const lee4 = bal(lee.pk);
    const r4 = await pay(lee, b4.id);
    assert(r4.status === 409 && r4.body?.code === 'bill_first_bill' && /only be paid with Beans you hold\. You hold 10\./.test(r4.body?.error ?? '')
        && bal(lee.pk) === lee4 && billRow(b4.id).state === 'sent' && ledgerRows(`bill:${b4.id}`).length === 0,
        `a first bill from Rob can't take Lee below zero: refused in his money line, nothing written (${show(r4)})`);
    finishDeal(lee, rob);
    const lee4b = bal(lee.pk);
    const r4b = await pay(lee, b4.id);
    assert(r4b.status === 200 && lee4b - bal(lee.pk) === hc(60) && bal(lee.pk) < 0, `after one finished deal, Lee pays it on his line (${show(r4b)}; balance ${bal(lee.pk)})`);
    assertConserved('first bills');

    // ── 5. No room ─────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 5. Nothing to pay with ──');
    // Each section from here bills from a sender of its own: Rob has sent his day's three bills to people he never dealt with.
    const ivy = makeMember('Ivy', 0);
    const noa = makeMember('Noa', 0);
    const b5 = await bill(ivy, noa, 25, 'Bike repair');
    const r5 = await pay(noa, b5.id);
    assert(r5.status === 409 && r5.body?.code === 'bill_nothing' && /You need 25 Beans to pay this\./.test(r5.body?.error ?? '') && billRow(b5.id).state === 'sent'
        && ledgerRows(`bill:${b5.id}`).length === 0 && bal(noa.pk) === 0, `Noa holds nothing and has no line: refused, nothing written (${show(r5)})`);
    assertConserved('no room');

    // ── 6. Decline, withdraw, expiry ────────────────────────────────────────────────────────────────────────────────────
    console.log('── 6. Decline, withdraw, expiry ──');
    const rio = makeMember('Rio', 0);
    const deb = makeMember('Deb', 50);
    const waitingB = await bill(rio, deb, 5, 'Eggs, week one');
    const declinedB = await bill(rio, deb, 5, 'Eggs, week two');
    const deb6 = bal(deb.pk);
    const rioNotices = () => (db.prepare('SELECT COUNT(*) AS n FROM moderation_notices WHERE recipient = ?').get(rio.pk) as { n: number }).n;
    const rioToldBefore = rioNotices();
    const dec = await post(deb, `/api/bills/${declinedB.id}/decline`);
    assert(dec.status === 200 && billRow(declinedB.id).state === 'declined' && bal(deb.pk) === deb6, `Deb declines one; nothing moves (${show(dec)})`);
    assert(rioNotices() === rioToldBefore, 'Rio is told nothing');
    const robSent = await sentList(rio);
    const seen = (id: string) => robSent.find((b) => b.id === id);
    const strip = (b: any) => JSON.stringify({ ...b, id: '', whatFor: '', sentAt: '', expiresAt: '' });
    assert(seen(declinedB.id)?.state === 'sent' && strip(seen(declinedB.id)) === strip(seen(waitingB.id)),
        `Rio's read of the declined bill is the read of the waiting one ("not paid") (${JSON.stringify(seen(declinedB.id))?.slice(0, 160)})`);
    assert((await toPay(deb)).map((b) => b.id).join() === waitingB.id, 'the declined one leaves Deb\'s To pay');
    const wd = await post(rio, `/api/bills/${declinedB.id}/withdraw`);
    assert(wd.status === 200 && billRow(declinedB.id).state === 'withdrawn', `Rio withdraws the declined one as she would a waiting one (${show(wd)})`);
    const notRobs = await post(ana, `/api/bills/${waitingB.id}/withdraw`);
    assert(notRobs.status === 404 && billRow(waitingB.id).state === 'sent', `nobody else withdraws Rio's bill (${show(notRobs)})`);
    const expiring = await bill(rio, deb, 5, 'Eggs, week three');
    await post(deb, `/api/bills/${expiring.id}/decline`);
    const flipped = expireBills(Date.now() + BILL_RULES.waitDays * DAY + 60_000);
    assert(flipped >= 2 && billRow(waitingB.id).state === 'expired' && billRow(expiring.id).state === 'expired' && bal(deb.pk) === deb6,
        `30 days on, the waiting and the declined bills expire; nothing moves (${flipped})`);
    const robSent2 = await sentList(rio);
    assert(robSent2.find((b) => b.id === waitingB.id)?.state === 'expired' && robSent2.find((b) => b.id === expiring.id)?.state === 'expired',
        'Rio reads both as expired, not paid');
    const lateP = await pay(deb, waitingB.id);
    assert(lateP.status === 409 && lateP.body?.code === 'bill_not_waiting', `an expired bill can't be paid (${show(lateP)})`);
    assertConserved('decline, withdraw, expiry');

    // ── 7. A bill to someone who blocked its sender ────────────────────────────────────────────────────────────────────
    console.log('── 7. Blocked ──');
    const tom = makeMember('Tom', 0);
    const bea = makeMember('Bea', 50);
    finishDeal(bea, tom);
    db.prepare(`INSERT INTO member_blocks (owner_pubkey, blocked_pubkey, created_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(bea.pk, tom.pk);
    const beaHeld = bal(bea.pk);
    const bb = await bill(tom, bea, 5, 'Hedge trimming');
    assert(bb.status === 200 && billRow(bb.id).state === 'sent', `Tom's bill to Bea, who blocked him, is taken as any (${show(bb)})`);
    assert((await toPay(bea)).length === 0 && notices(bea.pk, 'bill').length === 0, 'never listed for Bea, and she is told nothing, though she knows him');
    const bp = await pay(bea, bb.id);
    assert(bp.status === 404 && bal(bea.pk) === beaHeld, `she can't pay what she can't see (${show(bp)})`);
    assert((await sentList(tom)).find((b) => b.id === bb.id)?.state === 'sent', 'Tom reads it as not paid, as any');
    assertConserved('blocked');

    // ── 8. Limits ─────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 8. Limits ──');
    const sal = makeMember('Sal', 0);
    const dealt = [makeMember('P1', 20), makeMember('P2', 20), makeMember('P3', 20), makeMember('P4', 20)];
    for (const d of dealt) finishDeal(d, sal);
    let sentToday = 0;
    for (const d of dealt.slice(0, 3)) for (let i = 0; i < 3; i++) { const r = await bill(sal, d, 1, `Lesson ${i + 1}`); if (r.status === 200) sentToday++; }
    const tenth = await bill(sal, dealt[3], 1, 'Lesson 1');
    if (tenth.status === 200) sentToday++;
    const eleventh = await bill(sal, dealt[3], 1, 'Lesson 2');
    assert(sentToday === 10 && eleventh.status === 429 && eleventh.body?.code === 'bills_sent_day' && typeof eleventh.body?.resetsAt === 'string'
        && /You've sent 10 bills today\. More from /.test(eleventh.body?.error ?? '') && Number(eleventh.headers?.get('retry-after')) > 0,
        `10 bills in a day go; the 11th is 429 with resetsAt (${sentToday}; ${show(eleventh)})`);
    const ned = makeMember('Ned', 0);
    const strangers = [makeMember('S1', 0), makeMember('S2', 0), makeMember('S3', 0), makeMember('S4', 0)];
    const toNew: Array<Res & { id: string }> = [];
    for (const s of strangers) toNew.push(await bill(ned, s, 1, 'Raffle ticket'));
    assert(toNew.slice(0, 3).every((r) => r.status === 200) && toNew[3].status === 429 && toNew[3].body?.code === 'bills_new_people_day' && !!toNew[3].body?.resetsAt,
        `3 bills to people Ned never dealt with go; the 4th is 429 (${toNew.map((r) => r.status).join(', ')}; ${show(toNew[3])})`);
    const ola = makeMember('Ola', 0);
    const oPayer = makeMember('Opal', 20);
    finishDeal(oPayer, ola);
    const toOne = [await bill(ola, oPayer, 1, 'Pot 1'), await bill(ola, oPayer, 1, 'Pot 2'), await bill(ola, oPayer, 1, 'Pot 3')];
    await post(oPayer, `/api/bills/${toOne[0].id}/decline`);
    const fourthToOne = await bill(ola, oPayer, 1, 'Pot 4');
    assert(toOne.every((r) => r.status === 200) && fourthToOne.status === 429 && fourthToOne.body?.code === 'bills_to_one',
        `3 bills not paid to Opal (one declined, still counted) and the 4th is 429: the limit never gives a decline away (${show(fourthToOne)})`);
    // 20 out at once: bills sent over earlier days, not paid and not expired (written as the node keeps them).
    const pia = makeMember('Pia', 0);
    const many = makeMember('Many', 0);
    const old = new Date(Date.now() - 2 * DAY).toISOString();
    const later = new Date(Date.now() + 20 * DAY).toISOString();
    for (let i = 0; i < BILL_RULES.unpaidOut; i++) {
        db.prepare(`INSERT INTO bills (id, biller_pubkey, sent_by, payer_pubkey, amount_c, what_for, state, created_at, delivered_at, expires_at)
                    VALUES (?, ?, ?, ?, 100, 'Old one', 'sent', ?, ?, ?)`).run(crypto.randomUUID(), pia.pk, pia.pk, `${many.pk.slice(0, 63)}${i % 10}`, old, old, later);
    }
    const out21 = await bill(pia, many, 1, 'One more');
    assert(out21.status === 429 && out21.body?.code === 'bills_out' && /20 bills out that aren't paid/.test(out21.body?.error ?? ''),
        `20 bills out, not paid: the 21st is 429 (${show(out21)})`);
    assertConserved('limits');

    // ── 9. Three reporters hold the sender ─────────────────────────────────────────────────────────────────────────────
    console.log('── 9. Reports ──');
    const owner = makeMember('Olive', 0);
    db.prepare(`INSERT INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'owner', 'genesis')`).run(owner.pk);
    const zed = makeMember('Zed', 0);
    const victims = [makeMember('V1', 50), makeMember('V2', 50), makeMember('V3', 50)];
    const dora = makeMember('Dora', 50);
    finishDeal(dora, zed);
    const zedBills: Array<Res & { id: string }> = [];
    for (const v of victims) zedBills.push(await bill(zed, v, 40, 'Community fee'));
    const toDora = await bill(zed, dora, 5, 'Plums');
    assert(zedBills.every((r) => r.status === 200) && toDora.status === 200, 'Zed sends three strangers a "Community fee", and Dora a bill for plums');
    const report = (v: Id, billId: string) => post(v, '/api/reports', { reporterPubkey: v.pk, reason: 'Scam or fraud', targetBillId: billId });
    const rep1 = await report(victims[0], zedBills[0].id);
    const kept1 = db.prepare('SELECT * FROM abuse_reports WHERE id = ?').get(rep1.body?.report?.id) as any;
    // The report keeps its reporter's reason alone; the queue reads the bill beside it (§18: the sender's words never decide
    // what kind of report it is).
    const queued1 = queued(kept1?.id);
    assert(rep1.status === 200 && kept1?.target_pubkey === zed.pk && kept1?.reason === 'Scam or fraud' && queued1?.targetPubkey === zed.pk
        && queued1?.reason === 'Scam or fraud · Bill: "Community fee", 40 Beans'
        && billRow(zedBills[0].id).state === 'declined' && billRow(zedBills[0].id).report_id === kept1?.id,
        `a report on a bill reaches the queue about Zed, with what for and how much, and declines the bill (${show(rep1)}; queue: ${queued1?.reason})`);
    const notTheirs = await post(victims[1], '/api/reports', { reporterPubkey: victims[1].pk, reason: 'Spam', targetBillId: zedBills[0].id });
    assert(notTheirs.status === 404, `only its payer reports a bill (${show(notTheirs)})`);
    await report(victims[1], zedBills[1].id);
    assert(notices(owner.pk, 'bills_on_hold').length === 0 && (await bill(zed, dora, 1, 'Plums again')).status === 200, 'two reporters hold nothing');
    await report(victims[2], zedBills[2].id);
    const held = notices(owner.pk, 'bills_on_hold');
    assert(held.length === 1 && held[0].body === "Zed's bills are on hold: 3 members reported them within 7 days. Look at the reports to clear the hold.",
        `the third reporter holds Zed's bills, and the owner is told once: who, how many, where (${held.map((n) => n.body).join(' | ')})`);
    const zedNew = await bill(zed, dora, 1, 'Plums, more');
    assert(zedNew.status === 403 && zedNew.body?.code === 'bills_on_hold', `Zed sends no new bill (${show(zedNew)})`);
    assert((await toPay(dora)).length === 0, 'none of Zed\'s bills is listed for Dora while held');
    const heldPay = await pay(dora, toDora.id);
    assert(heldPay.status === 409 && heldPay.body?.code === 'bill_on_hold' && billRow(toDora.id).state === 'sent', `nor paid (${show(heldPay)})`);
    dismissReport(kept1.id);
    assert((await toPay(dora)).some((b) => b.id === toDora.id) && (await pay(dora, toDora.id)).status === 200,
        'an owner handles a report: the hold lifts, and Dora pays her bill');
    assert(notices(owner.pk, 'bills_on_hold').length === 1, 'the owner was told once');
    assertConserved('reports');

    // ── 10. An enterprise ───────────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 10. Enterprises ──');
    const shop = makeMember('Seed Shop', 0, { treasury: true });
    const keeper = makeMember('Kit', 0);
    db.prepare('INSERT INTO treasury_operators (treasury_pubkey, member_pubkey) VALUES (?, ?)').run(shop.pk, keeper.pk);
    db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(keeper.pk);
    const eb = await bill(keeper, ana, 30, 'Seed order', { enterprise: shop.pk });
    assert(eb.status === 200 && billRow(eb.id).biller_pubkey === shop.pk && billRow(eb.id).sent_by === keeper.pk, `Kit sends Ana a bill for the Seed Shop (${show(eb)})`);
    const shopBefore = bal(shop.pk);
    const ep = await pay(ana, eb.id);
    assert(ep.status === 200 && bal(shop.pk) - shopBefore === hc(30) - feeOf(hc(30)) && notices(keeper.pk, 'bill_paid').length === 1,
        `Ana pays it: the shop receives it less the fee, and Kit is told (${show(ep)})`);
    const notKeeper = await bill(ana, kim, 5, 'Seed order', { enterprise: shop.pk });
    assert(notKeeper.status === 403, `only a keeper sends for an enterprise (${show(notKeeper)})`);
    const toShop = await bill(ana, shop.pk, 5, 'Returned seeds');
    assert(toShop.status === 400 && toShop.body?.code === 'bill_enterprise_payer', `a bill to an enterprise is refused: an enterprise pays none yet (${show(toShop)})`);
    assertConserved('enterprises');

    // ── 11. Bills off ───────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 11. Bills off ──');
    setSwitchOverride('bills', false);
    const offB = await bill(rob, kim, 5, 'Gate latch');
    const offL = await call(kim, 'GET', '/api/bills');
    setSwitchOverride('bills', true);
    assert(offB.status === 404 && offB.body?.code === 'feature_off' && offL.status === 404, `with the bills switch off: 404 feature_off (${show(offB)})`);
    assertConserved('bills off');

    // ── 12. A standby ───────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 12. Standby ──');
    const sam = makeMember('Sam', 0);
    const sb = await bill(sam, kim, 5, 'Gate hinge');
    setNodeRole('backup');
    let sbSend: Res, sbPay: Res, sbDecline: Res;
    try {
        sbSend = await bill(sam, kim, 5, 'Gate post');
        sbPay = await pay(kim, sb.id);
        sbDecline = await post(kim, `/api/bills/${sb.id}/decline`);
    } finally {
        setNodeRole('primary');
    }
    assert(sbSend.status === 409 && sbPay.status === 409 && sbDecline.status === 409 && sbPay.body?.code === 'standby' && billRow(sb.id).state === 'sent',
        `a standby refuses send, pay and decline (${sbSend.status}, ${sbPay.status}, ${sbDecline.status})`);
    assertConserved('standby');

    // ── 13. A re-key ────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 13. Re-key ──');
    const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
    const rae = makeMember('Rae', 0);
    const quinn = makeMember('Quinn', 40);
    finishDeal(quinn, rae);
    const rk = await bill(rae, quinn, 12, 'Bread, two weeks');
    const raeNew = newKey();
    completeRekey(rae.pk, raeNew.pk, issueRekeyCode(rae.pk, 'owner:password').code, 'owner:password');
    const quinnNew = newKey();
    completeRekey(quinn.pk, quinnNew.pk, issueRekeyCode(quinn.pk, 'owner:password').code, 'owner:password');
    const row13 = billRow(rk.id);
    assert(row13.biller_pubkey === raeNew.pk && row13.sent_by === raeNew.pk && row13.payer_pubkey === quinnNew.pk, 'the bill moves to both new keys');
    const quinnId = { ...quinnNew, name: 'Quinn' };
    const raeBefore = bal(raeNew.pk);
    const rp = await pay(quinnId, rk.id);
    assert(rp.status === 200 && bal(raeNew.pk) - raeBefore === hc(12) - feeOf(hc(12)), `paid from Quinn's new key to Rae's (${show(rp)})`);
    assertConserved('re-key');

    // ── 14. A closed account ────────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 14. A closed account ──');
    const gus = makeMember('Gus', 0);
    const hal = makeMember('Hal', 20);
    finishDeal(hal, gus);
    const gusOut = await bill(gus, hal, 3, 'Seedlings');
    const toGus = await bill(hal, gus, 3, 'Compost');
    const closed = purgeMemberSelf(gus.pk);
    assert(closed.ok && billRow(gusOut.id).state === 'withdrawn' && billRow(toGus.id).state === 'expired',
        `Gus deletes his account: the bill he sent is withdrawn, the one waiting on him expires (${JSON.stringify(closed)})`);
    assertConserved('closed account');

    // ── 15. The Home answer ─────────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 15. Home answer ──');
    const una = makeMember('Una', 20);
    const known = makeMember('Vic', 0);
    finishDeal(una, known);
    const fromKnown = await bill(known, una, 7, 'Kindling');
    const stranger = makeMember('Wes', 0);
    const fromStranger = await bill(stranger, una, 300, 'Bike repair');
    const items = ((await call(una, 'GET', '/api/home?cards=needs&lands=bills')).body?.cards?.needs?.items ?? []) as any[];
    const billLines = items.filter((i) => i.kind === 'bill');
    const k = billLines.find((i) => i.target?.id === fromKnown.id);
    const s = billLines.find((i) => i.target?.id === fromStranger.id);
    assert(billLines.length === 2 && k?.accent === true && k.label === 'Bill from Vic: Kindling · 7 Beans' && s?.accent === false
        && s.label === "Bill from Wes, who you haven't dealt with: Bike repair · 300 Beans",
        `one line per bill: a known sender's amber, a stranger's calm (${JSON.stringify(billLines)?.slice(0, 300)})`);
    assert(notices(una.pk, 'bill').length === 1, 'the known sender\'s bill made a notice; the stranger\'s none');
    const oldApp = ((await call(una, 'GET', '/api/home?cards=needs')).body?.cards?.needs?.items ?? []) as any[];
    assert(!oldApp.some((i) => i.kind === 'bill'), 'an app that doesn\'t say it opens a bill is given no bill line');
    assertConserved('Home answer');

    // ── 16. What a bill is about ────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 16. About ──');
    const uma = makeMember('Uma', 0);
    const mine = await bill(uma, kim, 2, 'Jam jar back', { postId: uma.jam.id });
    const notMine = await bill(uma, kim, 2, 'Jam jar back', { postId: kim.jam.id });
    const noStanding = await bill(uma, kim, 2, 'Rent', { standingId: 'not-a-standing-deal' });
    assert(mine.status === 200 && mine.body?.bill?.postId === uma.jam.id && mine.body.bill.postTitle === "Uma's jam" && notMine.status === 400 && notMine.body?.code === 'bill_about'
        && noStanding.status === 400 && noStanding.body?.code === 'bill_about',
        `about the sender's own listing only, or the standing deal between them (${mine.status}, ${notMine.status}, ${noStanding.status})`);
    // A Local knowledge page is never money's (DESIGN-local-knowledge-fable §2.3), even its own writer's (sync review of aed41aa2).
    const page = await post(owner, '/api/knowledge/posts', { title: 'How recycling works at the tip', body: 'Glass in the green bins, paper in the blue.', topic: 'local-services' });
    const aboutPage = await bill(owner, kim, 25, 'The recycling guide', { postId: page.body?.post?.id });
    assert(page.status === 201 && page.body?.post?.type === 'knowledge' && aboutPage.status === 400 && aboutPage.body?.code === 'bill_about' && !billRow(aboutPage.id),
        `a bill is never about a Local knowledge page, even its writer's own: 400 bill_about, nothing written (${page.status}, ${show(aboutPage)})`);
    const badId = await post(rob, '/api/bills', { id: 'x', to: kim.pk, amount_c: hc(2), whatFor: 'Short id' });
    assert(badId.status === 400 && badId.body?.code === 'bill_id' && /8 to 128 letters/.test(badId.body?.error ?? ''), `a bill's id is the app's own, in its shape (${show(badId)})`);
    const badWhat = await bill(rob, kim, 2, 'ab');
    const badAmount = await bill(rob, kim, 2001, 'Too much');
    const self = await bill(rob, rob, 2, 'Myself');
    assert(badWhat.body?.code === 'bill_what_for' && badAmount.body?.code === 'bill_amount' && self.body?.code === 'bill_yourself',
        'what for is 3 to 80 characters; at most 2,000 Beans; nobody bills themselves');
    assertConserved('about');

    // ── 17. A hold follows the person, both ways (the deciding review of 6bc2ece9, finding 1) ─────────────────────────────
    console.log('── 17. A hold follows the person ──');
    // A member held by reports on the bills they sent as themselves sends none for an enterprise they keep.
    const zak = makeMember('Zak', 0);
    const zakCo = makeMember('Zak Co', 0, { treasury: true });
    const kai = makeMember('Kai', 0);
    keepEnterprise(zakCo, zak);
    keepEnterprise(zakCo, kai);
    const dot = makeMember('Dot', 50);
    const coBill = await bill(zak, dot, 10, 'Plum crate', { enterprise: zakCo.pk });
    assert(coBill.status === 200 && billRow(coBill.id).biller_pubkey === zakCo.pk && billRow(coBill.id).sent_by === zak.pk,
        `Zak sends Dot a bill for Zak Co, which he keeps (${show(coBill)})`);
    for (const m of [makeMember('M1', 0), makeMember('M2', 0), makeMember('M3', 0)]) await report(m, (await bill(zak, m, 40, 'Community fee')).id);
    const zakSelf = await bill(zak, dot, 1, 'Plums');
    const zakAsCo = await bill(zak, makeMember('Fay', 0), 1, 'Community fee', { enterprise: zakCo.pk });
    assert(zakSelf.status === 403 && zakSelf.body?.code === 'bills_on_hold', `three members reported Zak's bills: he sends none as himself (${show(zakSelf)})`);
    assert(zakAsCo.status === 403 && zakAsCo.body?.code === 'bills_on_hold' && !billRow(zakAsCo.id),
        `nor for Zak Co: the hold follows Zak into the enterprise he keeps, and nothing is written (${show(zakAsCo)})`);
    const dot17 = bal(dot.pk);
    const coPay = await pay(dot, coBill.id);
    assert(!(await toPay(dot)).some((b) => b.id === coBill.id) && coPay.status === 409 && coPay.body?.code === 'bill_on_hold' && bal(dot.pk) === dot17
        && billRow(coBill.id).state === 'sent',
        `the bill Zak sent for Zak Co before the hold is neither listed for Dot nor paid (${show(coPay)})`);
    const kaiCo = await bill(kai, makeMember('Gil', 0), 1, 'Plum crate', { enterprise: zakCo.pk });
    assert(kaiCo.status === 200, `Kai keeps Zak Co too, and nobody reported its bills: he still sends for it (${show(kaiCo)})`);
    // An enterprise held by reports on its bills: its keepers send none as themselves either (design §4.4 says "one sender's
    // bills" and is silent on whether an enterprise's hold reaches its keepers, so the hold goes both ways).
    const fen = makeMember('Fen', 0);
    const flo = makeMember('Flo', 0);
    const figCo = makeMember('Fig Co', 0, { treasury: true });
    keepEnterprise(figCo, fen);
    keepEnterprise(figCo, flo);
    const ownerTold17 = notices(owner.pk, 'bills_on_hold').length;
    const figReports: string[] = [];
    for (const m of [makeMember('N1', 0), makeMember('N2', 0), makeMember('N3', 0)]) {
        figReports.push((await report(m, (await bill(fen, m, 40, 'Membership dues', { enterprise: figCo.pk })).id)).body?.report?.id);
    }
    const figTold = notices(owner.pk, 'bills_on_hold').slice(ownerTold17);
    assert(figTold.length === 1 && figTold[0].body.startsWith("Fig Co's bills are on hold: 3 members"), `the owner is told once, of Fig Co (${figTold.map((n) => n.body).join(' | ')})`);
    const fenSelf = await bill(fen, makeMember('Hap', 0), 1, 'Hedge trim');
    assert(fenSelf.status === 403 && fenSelf.body?.code === 'bills_on_hold', `Fen, who sent Fig Co's reported bills, sends none as himself (${show(fenSelf)})`);
    const floSelf = await bill(flo, makeMember('Ida', 0), 1, 'Hedge trim');
    const floAsFig = await bill(flo, makeMember('Jem', 0), 1, 'Membership dues', { enterprise: figCo.pk });
    assert(floSelf.status === 403 && floSelf.body?.code === 'bills_on_hold' && floAsFig.status === 403 && floAsFig.body?.code === 'bills_on_hold',
        `Flo keeps Fig Co and sent none of them: she sends none as herself while it is held, nor for it (${show(floSelf)} · ${show(floAsFig)})`);
    dismissReport(figReports[0]);
    const floAfter = await bill(flo, makeMember('Kip', 0), 1, 'Hedge trim');
    const fenAfter = await bill(fen, makeMember('Lou', 0), 1, 'Hedge trim');
    assert(floAfter.status === 200 && fenAfter.status === 200, `an owner handles one report: the hold lifts for Fig Co's keepers (${show(floAfter)} · ${show(fenAfter)})`);
    assertConserved('a hold follows the person');

    // ── 18. A report's kind is the reporter's choice (the deciding review of 6bc2ece9, finding 2) ──────────────────────────
    console.log("── 18. A report's kind is the reporter's ──");
    const sly = makeMember('Sly', 0);
    const pat = makeMember('Pat', 50);
    const peg = makeMember('Peg', 50);
    finishDeal(pat, sly);
    finishDeal(peg, sly);
    const swimA = await bill(sly, pat, 20, 'Swim lessons');
    const swimB = await bill(sly, pat, 20, 'Swim squad, underage group');
    const swimC = await bill(sly, peg, 20, 'Swim lessons, underage squad');
    const swimD = await bill(sly, peg, 5, 'Swim kit');
    assert([swimA, swimB, swimC, swimD].every((r) => r.status === 200), 'Sly sends Pat and Peg two bills each, two of them for an "underage" squad');
    const fileAs = (v: Id, billId: string, reason: string) => post(v, '/api/reports', { reporterPubkey: v.pk, reason, targetBillId: billId });
    let child18 = childTold();
    const repC = await fileAs(peg, swimC.id, 'Spam or scam');
    const idC = repC.body?.report?.id;
    assert(repC.status === 200 && storedReason(idC) === 'Spam or scam',
        `Peg reports the bill "Swim lessons, underage squad" as Spam or scam: the report keeps her reason alone (${show(repC)}; kept ${JSON.stringify(storedReason(idC))})`);
    assert(queued(idC)?.childSafety === false && childTold() === child18,
        `it is no child-safety report: the queue doesn't mark it, and no urgent alert goes (marked ${queued(idC)?.childSafety}; ${childTold() - child18} told)`);
    assert(queued(idC)?.reason === 'Spam or scam · Bill: "Swim lessons, underage squad", 20 Beans', `the queue still reads what the bill was for and how much (${queued(idC)?.reason})`);
    const repA = await fileAs(pat, swimA.id, 'Spam or scam');
    const idA = repA.body?.report?.id;
    child18 = childTold();
    const repB = await fileAs(pat, swimB.id, 'Spam or scam');
    assert(repB.status === 200 && repB.body?.duplicate === true && repB.body?.report?.id === idA && storedReason(idA) === 'Spam or scam' && childTold() === child18
        && billRow(swimB.id).state === 'declined' && billRow(swimB.id).report_id === idA,
        `Pat's second report, on the "underage" bill, joins his report on file: still Spam or scam, no alert, the bill declined (${show(repB)}; kept ${JSON.stringify(storedReason(idA))})`);
    assert(queued(idA)?.childSafety === false && queued(idA)?.reason === 'Spam or scam · Bill: "Swim lessons", 20 Beans · Bill: "Swim squad, underage group", 20 Beans',
        `the queue reads both of Pat's bills on that report, not marked (${queued(idA)?.reason})`);
    child18 = childTold();
    const repD = await fileAs(peg, swimD.id, 'Child safety');
    assert(repD.status === 200 && repD.body?.report?.id === idC && storedReason(idC) === 'Child safety' && queued(idC)?.childSafety === true && childTold() === child18 + 1,
        `Peg picks Child safety on her other bill from Sly: her report becomes child safety, marked, and told at once (kept ${JSON.stringify(storedReason(idC))}; ${childTold() - child18} told)`);
    // However long the reporter's words, a reader that keeps a report's first 500 characters (the assistant's suggestions,
    // agent/suggestions-route.ts) still reads the bill whole: the reporter's words give way, as they did when it was kept.
    const ulf = makeMember('Ulf', 0);
    const ray = makeMember('Ray', 50);
    const longBill = await bill(ulf, ray, 15, 'Garden water');
    const longRep = await fileAs(ray, longBill.id, `Other: ${'a very long story '.repeat(40)}`);
    const longRead = queued(longRep.body?.report?.id)?.reason ?? '';
    assert(longRep.status === 200 && storedReason(longRep.body?.report?.id)?.length === 500 && longRead.length === 500
        && longRead.startsWith('Other: a very long story') && longRead.endsWith(' · Bill: "Garden water", 15 Beans'),
        `a 500-character reason: the queue reads 500 characters, the bill whole at the end (${longRead.length}; …${longRead.slice(-40)})`);
    assertConserved("a report's kind");

    // ── 19. A withdrawn bill still counts (the deciding review of 6bc2ece9, finding 3) ─────────────────────────────────────
    console.log('── 19. Withdrawn bills count ──');
    const ora = makeMember('Ora', 0);
    const opi = makeMember('Opi', 20);
    finishDeal(opi, ora);
    const round = [await bill(ora, opi, 1, 'Pot 1'), await bill(ora, opi, 1, 'Pot 2'), await bill(ora, opi, 1, 'Pot 3')];
    const takenBack: Res[] = [];
    for (const r of round) takenBack.push(await post(ora, `/api/bills/${r.id}/withdraw`));
    const opiTold = notices(opi.pk, 'bill').length;
    const fourthToOpi = await bill(ora, opi, 1, 'Pot 4');
    assert(round.every((r) => r.status === 200) && takenBack.every((r) => r.status === 200) && fourthToOpi.status === 429 && fourthToOpi.body?.code === 'bills_to_one'
        && !billRow(fourthToOpi.id) && notices(opi.pk, 'bill').length === opiTold,
        `Ora sends Opi 3 bills and withdraws them: a 4th to Opi in 30 days is still 429, and Opi hears of no 4th (${show(fourthToOpi)})`);
    const nia = makeMember('Nia', 0);
    const newcomers = [makeMember('T1', 0), makeMember('T2', 0), makeMember('T3', 0), makeMember('T4', 0)];
    for (const t of newcomers.slice(0, 3)) await post(nia, `/api/bills/${(await bill(nia, t, 1, 'Raffle ticket')).id}/withdraw`);
    const fourthNew = await bill(nia, newcomers[3], 1, 'Raffle ticket');
    assert(fourthNew.status === 429 && fourthNew.body?.code === 'bills_new_people_day',
        `3 bills to people Nia never dealt with, withdrawn, still count among the day's 3: the 4th is 429 (${show(fourthNew)})`);
    assertConserved('withdrawn bills count');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

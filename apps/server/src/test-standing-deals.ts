/**
 * Standing deals, paid at the start of each period (scratch/fable-design/DESIGN-standing-deals-upfront-fable.md §1, §2, §5 and
 * its amendment §1-§5, slice U1; Marty's decisions, 10 Nov 2026). Nothing is ever held in trust.
 *
 * Over real HTTP with real signatures: the accept and the approval with `standing` (the payer's signed authorisation), Stop
 * and Extend, Release and Cancel refused on a standing row, the transactions read and its ETag, the Home answer. The node's
 * minute tick is run as the main server runs it (state-engine.ts runStandingDeals), each time with a pinned `now`; the
 * after-commit hook on the credit doors runs for real from transfer() (its clock pinned by setStandingHookForTests); the
 * node's own transfer and push are watched, and failed where a crash is simulated. Every section ends in assertConserved.
 *
 *  1. Agree pays once: payer − 50, payee + 49.25, Commons + 0.75, no escrow account; the row is a finished deal; one ledger
 *     row names the signer and `standing:<id>:1`. A monthly listing taken without `standing` is today's deal.
 *  2. Running: Release and Cancel move nothing on a standing row; Hold back is gone; nobody is nudged; the price can change;
 *     the payer is kept from holiday, the payee may go.
 *  3. A period's start pays it once; a second tick moves nothing; a clock that goes back pays nothing.
 *  4. A crash inside the payment leaves both balances as they were and the retry pays once; the UNIQUE index holds.
 *  5. Short: warned ahead (the payer only), told at the due time (both), the retry sends no push; Beans that arrive pay the
 *     whole period at once with no tick (the hook), dates unchanged; hook + tick in one minute pay once; a credit that leaves
 *     them short pays nothing and sends no push; a chain A→B→C pays each once.
 *  6. The grace is over: nothing is paid even with Beans arriving that minute; it ends, both told.
 *  7. Stop now in the grace, by either side: it ends at once, no row, nothing moves, the Home answer has no line after.
 *  8. The cadence: a monthly grace run out sends the payer 5 pushes (ahead, due, halfway, day before, ended) and the payee 4
 *     (no ahead: the payee never hears the payer's balance); a weekly one 4 and 3 (no halfway).
 *  9. Stop outside the grace: the period paid runs to its end, then it ends and nothing more is paid.
 * 10. K periods, and Extend.
 * 11. Forged or mismatched authorisations: 400 standing_auth, nothing paid. A keeper of the paying enterprise as payee: 403.
 * 12. Late: under one period late pays as normal; a period already over is never paid (the server was away): it ends.
 * 13. A standby ticks nothing; with Beans off nothing moves.
 * 14. A Need: the author pays the helper at the start, and each week after.
 * 15. The author removes the listing: a paid one stops after its period, a short one ends at once.
 * 16. The transactions read carries the standing fields, and its ETag changes when the phase does.
 * 17. A re-key of the payee, then of the payer: it carries on under each new key.
 * 18. An enterprise payee: each period counts toward its earned surplus.
 * 19. A moderator removes the listing: each standing deal on it ends at once, both told, nothing to refund.
 * 20. The keeper who signed an enterprise's standing deal is removed: no further period is paid.
 * 21. The Home answer: one live line per short deal per side, the payer's counted, the payee's calm; gone once paid.
 * 22. No unused helper is exported.
 *
 * Run: SERVER_SUITES_ONLY=test-standing-deals TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { wrapCreatePost } from './post-test-helper.js';
import * as se from './state-engine.js';
import { initStateEngine, transfer, createPost as rawCreatePost, getCommonsBalanceExact, runLedgerAudit, setHolidayMode, runMarketplaceHygiene, adminSetCreditFrozen } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { db } from './db/db.js';
import { setNodeRole } from './config/node-role.js';
import { setSwitchOverride } from './config/node-profile.js';
import { setMemberPhoto } from '@beanpool/engine';
import { TRANSACTION_FEE_RATE, periodEnd, periodStart, standingAuthorisationText, standingGraceEndsAt, type StandingPeriodUnit } from '@beanpool/core';
const createPost = wrapCreatePost(rawCreatePost);

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); }
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
let BASE = '';
let HOST = '';
type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any; etag?: string | null };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 240)}`;
const r2 = (n: number) => Math.round(n * 100) / 100;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

function makeMember(name: string, beans: number, opts: { treasury?: boolean } = {}): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const id = { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_treasury)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'TEST', 'active', ?)`).run(id.pk, name, opts.treasury ? 1 : 0);
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    if (beans > 0) transfer('genesis', id.pk, beans, `seed ${name}`, 'direct', true);
    // Every buyer has listed an Offer of their own (the contribution rule).
    createPost('offer', 'general', `${name}'s jam`, 'A jar of plum jam', 5, 'fixed', id.pk);
    return id;
}

async function call(id: Id, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<Res> {
    resetGatewayRateLimit();
    const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const headers: Record<string, string> = {
        'X-Public-Key': id.pk,
        'X-Signature': crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`), id.priv).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : bodyString });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json, etag: res.headers.get('etag') };
}

const post = (id: Id, path: string, body: Record<string, unknown>) => call(id, 'POST', path, body);

interface AuthOpts { postId: string; payee: string; beans: number; unit: StandingPeriodUnit; max: number | null; startsAt?: string; id?: string; host?: string; nonce?: string }
/**
 * A standing authorisation as an app makes one (@beanpool/core signStandingAuthorisation), signed by `signer` as every member
 * statement is: 0xFF, then the text's UTF-8 bytes. `bare` signs the text alone, as an older app's "Manage" button signs any
 * text a node sends it: never an authorisation.
 */
function authorise(signer: Id, o: AuthOpts & { bare?: boolean }): { id: string; startsAt: string; payload: string; standing: Record<string, unknown> } {
    const id = o.id ?? crypto.randomUUID();
    const startsAt = o.startsAt ?? new Date(Date.now()).toISOString();
    const payload = standingAuthorisationText({
        host: o.host ?? HOST, standingId: id, listingId: o.postId, payee: o.payee, beansPerPeriod: o.beans, unit: o.unit, maxPeriods: o.max, startsAt,
        nonce: o.nonce ?? crypto.randomBytes(12).toString('hex'),
    });
    const bytes = o.bare ? Buffer.from(payload, 'utf-8') : Buffer.concat([Buffer.from([0xff]), Buffer.from(payload, 'utf-8')]);
    const signature = crypto.sign(null, bytes, signer.priv).toString('base64');
    return { id, startsAt, payload, standing: { authorisation: { payload, signature }, ...(o.max === null ? { untilStopped: true } : { periods: o.max }), startsAt } };
}

const standingRow = (id: string) => db.prepare('SELECT * FROM standing_deals WHERE id = ?').get(id) as any;
const periodRows = (id: string) => db.prepare('SELECT * FROM marketplace_transactions WHERE standing_id = ? ORDER BY period_no').all(id) as any[];
const bal = (pk: string) => (db.prepare('SELECT balance_c FROM accounts WHERE public_key = ?').get(pk) as { balance: number } | undefined)?.balance ?? 0;
const escrowsOf = (id: string) => (db.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE public_key IN (SELECT 'escrow_' || id FROM marketplace_transactions WHERE standing_id = ?)`).get(id) as { n: number }).n;
const keptKinds = (pk: string, standingId: string) => (db.prepare(`SELECT data FROM moderation_notices WHERE recipient = ? ORDER BY created_at, rowid`).all(pk) as { data: string }[])
    .map(r => { try { return JSON.parse(r.data); } catch { return {}; } }).filter(d => d.standing === standingId).map(d => d.kind as string);
const chatLines = (text: string) => (db.prepare(`SELECT ciphertext FROM messages WHERE system_type = 'STANDING_DEAL' AND ciphertext LIKE ?`).all(`%${text}%`) as { ciphertext: string }[]).map(r => r.ciphertext);
function nodeTotal(): number {
    const accounts = (db.prepare(`SELECT COALESCE(SUM(balance_c), 0) t FROM accounts WHERE public_key != 'COMMONS_POOL'`).get() as any).t;
    return r2(accounts + getCommonsBalanceExact());
}
function assertConserved(step: string): void {
    const audit = runLedgerAudit();
    assert(audit.ok && Math.abs(audit.drift) < 0.0001 && Math.abs(nodeTotal()) < 0.0001, `${step}: the Beans are conserved (audit ${audit.ok ? 'ok' : 'FAILED'}, drift ${audit.drift}, total ${nodeTotal()})`);
}

/** Every push the standing deals send, from the tick and the hook: to whom, what it says, its kind. */
const pushes: Array<{ to: string; body: string; kind: string }> = [];
const watch = (h: any) => ({
    ...h,
    dispatchPushNotification: (to: string[], actor: string, title: string, body: string, data: any, cat: any, kind: any, ...rest: any[]) => {
        for (const t of to) pushes.push({ to: t, body, kind });
        return h.dispatchPushNotification(to, actor, title, body, data, cat, kind, ...rest);
    },
});
const pushesTo = (pk: string, about: string) => pushes.filter(p => p.to === pk && p.body.includes(about));
/** The hook's clock, pinned per section (the periods run in the suite's future). */
let hookNow = Date.now();
const tick = (now: number, wrap?: (h: any) => any) => (se as any).runStandingDeals(now, (h: any) => watch(wrap ? wrap(h) : h)) as { paid: number; short: number; ended: number };
const payeeShare = (beans: number) => beans * (1 - TRANSACTION_FEE_RATE);
/** A payee's share, to the half cent (the fee on 35 Beans is 0.525). */
const nearPaid = (got: number, beans: number) => Math.abs(got - payeeShare(beans)) < 0.006;
/** Beans from the genesis account to a member: a credit through transfer(), as any payment to them is, so the hook runs. */
const credit = (who: Id, beans: number) => assert(!!transfer('genesis', who.pk, beans, `Beans for ${who.name}`, 'direct', true), `${who.name} receives ${beans} Beans`);

async function main(): Promise<void> {
    console.log('\nStanding deals: each period paid at its start, nothing held\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    // The host as apps sign it (lower case, no port: engine/own-addresses.ts audienceStanding).
    HOST = new URL(BASE).hostname;
    assert(typeof (se as any).runStandingDeals === 'function' && typeof (se as any).setStandingHookForTests === 'function',
        "the main server's minute tick and the credit hook have their seams (state-engine.ts runStandingDeals, setStandingHookForTests)");
    (se as any).setStandingHookForTests(watch, () => hookNow);

    const marty = makeMember('Marty', 400);
    const rob = makeMember('Rob', 0);
    const ana = makeMember('Ana', 300);
    const storage = createPost('offer', 'services', 'Vehicle Storage', 'A covered space for one car', 50, 'monthly', rob.pk) as any;

    // Short, the way a member is: their admins froze their credit line (the manager's Freeze), and their own Beans are fewer
    // than a period.
    const drain = (who: Id, keep: number) => {
        const out = r2(bal(who.pk) - keep);
        if (out > 0) assert(!!transfer(who.pk, ana.pk, out, 'sent away for the test', 'direct', true), `${who.name} sends ${out} away`);
        adminSetCreditFrozen(who.pk, true);
        return out;
    };

    // ── 1. Agree pays once ─────────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 1. Agree pays the first period at once ──');
    const martyBefore = bal(marty.pk);
    const robBefore1 = bal(rob.pk);
    const commonsBefore1 = getCommonsBalanceExact();
    const a1 = authorise(marty, { postId: storage.id, payee: rob.pk, beans: 50, unit: 'month', max: null });
    const accepted = await post(marty, '/api/marketplace/posts/accept', { postId: storage.id, buyerPublicKey: marty.pk, standing: a1.standing });
    assert(accepted.status === 200 && accepted.body?.transaction?.standingId === a1.id && accepted.body?.transaction?.periodNo === 1 && accepted.body?.transaction?.status === 'completed',
        `the accept with a signed authorisation answers the period-1 deal, finished (${show(accepted)})`);
    const sd1 = standingRow(a1.id);
    const p1 = periodRows(a1.id);
    assert(!!sd1 && sd1.phase === 'paid' && sd1.periods_done === 1 && sd1.current_tx_id === p1[0]?.id && sd1.next_due_at === periodEnd(a1.startsAt, 'month', 1)
        && sd1.auth_payload === a1.payload && sd1.auth_signer === marty.pk && !('held_back_reason' in sd1),
        `the standing row: paid, one period done, the next due at the month's end (${JSON.stringify(sd1)?.slice(0, 200)})`);
    assert(p1.length === 1 && p1[0].status === 'completed' && p1[0].completed_at === p1[0].created_at && near(p1[0].credits, 50) && p1[0].hours === null,
        `period 1 is one finished deal row (${p1.map(r => `${r.status}:${r.credits}`).join(' ')})`);
    assert(near(martyBefore - bal(marty.pk), 50) && nearPaid(bal(rob.pk) - robBefore1, 50) && Math.abs(getCommonsBalanceExact() - commonsBefore1 - 50 * TRANSACTION_FEE_RATE) < 0.006,
        `Marty − 50, Rob + ${r2(bal(rob.pk) - robBefore1)} (50 less 1.5%), the Commons the fee`);
    assert(escrowsOf(a1.id) === 0, 'nothing is held in trust: no escrow account for the period');
    const payRows = db.prepare(`SELECT from_pubkey, to_pubkey, amount_c, fee_c, auth_signer, auth_payload FROM transactions WHERE auth_payload LIKE ?`).all(`standing:${a1.id}:%`) as any[];
    assert(payRows.length === 1 && payRows[0].from_pubkey === marty.pk && payRows[0].to_pubkey === rob.pk && near(payRows[0].amount, 50) && payRows[0].tax_fee > 0
        && payRows[0].auth_signer === marty.pk && payRows[0].auth_payload === `standing:${a1.id}:1`,
        `ONE ledger row, payer to payee, the fee taken, naming the signer and standing:<id>:1 (${JSON.stringify(payRows)})`);
    const listingNow = db.prepare('SELECT status, pending_transaction_id FROM posts WHERE id = ?').get(storage.id) as any;
    assert(listingNow.status === 'pending' && listingNow.pending_transaction_id === p1[0].id, 'a one-off listing is taken while its standing deal runs');
    assertConserved('after the accept');

    // A monthly listing taken without `standing` is today's deal.
    const bikeRack = createPost('offer', 'services', 'Bike Rack Space', 'Indoors', 10, 'monthly', rob.pk, undefined, undefined, undefined, true) as any;
    const plain = await post(ana, '/api/marketplace/posts/accept', { postId: bikeRack.id, buyerPublicKey: ana.pk, hours: 3 });
    assert(plain.status === 200 && near(plain.body?.transaction?.credits, 30) && !plain.body?.transaction?.standingId && plain.body?.transaction?.status === 'pending',
        `without standing a per-month listing keeps today's behaviour: 3 months, 30 Beans held, no standing deal (${show(plain)})`);
    await post(ana, '/api/marketplace/transactions/cancel', { transactionId: plain.body?.transaction?.id, cancellerPublicKey: ana.pk });
    const again = await post(marty, '/api/marketplace/posts/accept', { postId: storage.id, buyerPublicKey: marty.pk, standing: authorise(marty, { postId: storage.id, payee: rob.pk, beans: 50, unit: 'month', max: null }).standing });
    assert(again.status === 400 || again.status === 409, `a second take-up of a one-off listing under a standing deal is refused (${show(again)})`);
    assertConserved('after the plain deal');

    // ── 2. Running: no Release, no Cancel, no Hold back ─────────────────────────────────────────────────────────────────
    console.log('── 2. A standing deal running ──');
    const robBefore2 = bal(rob.pk);
    const martyBefore2 = bal(marty.pk);
    const rel = await post(marty, '/api/marketplace/transactions/complete', { transactionId: p1[0].id, confirmerPublicKey: marty.pk });
    const can = await post(marty, '/api/marketplace/transactions/cancel', { transactionId: p1[0].id, cancellerPublicKey: marty.pk });
    assert((rel.status === 400 || rel.body?.alreadyCompleted === true) && rel.body?.code !== 'standing_runs_itself' && can.status >= 400
        && near(bal(rob.pk), robBefore2) && near(bal(marty.pk), martyBefore2),
        `Release and Cancel on a standing row move nothing: nothing is held (${show(rel)}; ${show(can)})`);
    const holdBack = await post(marty, `/api/marketplace/standing/${a1.id}/hold-back`, {});
    assert(holdBack.status === 404 || holdBack.status === 405, `Hold back is gone: no such door (${show(holdBack)})`);
    db.prepare(`UPDATE marketplace_transactions SET created_at = ? WHERE id = ?`).run(new Date(Date.now() - 20 * DAY).toISOString(), p1[0].id);
    runMarketplaceHygiene();
    assert((db.prepare('SELECT last_reminded_at FROM marketplace_transactions WHERE id = ?').get(p1[0].id) as any).last_reminded_at == null, 'the hygiene nudges nobody: nothing is held');
    db.prepare(`UPDATE marketplace_transactions SET created_at = completed_at WHERE id = ?`).run(p1[0].id);
    const repriced = await post(rob, '/api/marketplace/posts/update', { id: storage.id, postId: storage.id, authorPublicKey: rob.pk, credits: 60 });
    assert(repriced.status === 200 && near((db.prepare('SELECT price_c FROM posts WHERE id = ?').get(storage.id) as any).credits, 60),
        `the author can change the price while it runs (${show(repriced)})`);
    let payerHoliday = '';
    try { setHolidayMode(marty.pk, true); } catch (e: any) { payerHoliday = e?.message ?? ''; }
    assert(payerHoliday === 'Stop your standing deal for Vehicle Storage first.', `the payer is kept from holiday mode, told why ("${payerHoliday}")`);
    let payeeHoliday = 'ok';
    try { setHolidayMode(rob.pk, true); } catch (e: any) { payeeHoliday = e?.message ?? 'refused'; }
    assert(payeeHoliday === 'ok', `the payee may go on holiday while it runs (${payeeHoliday})`);
    assertConserved('while it runs');

    // ── 3. A period's start: paid once ──────────────────────────────────────────────────────────────────────────────────
    console.log('── 3. Each period paid once at its start ──');
    const end1 = Date.parse(periodEnd(a1.startsAt, 'month', 1));
    const before3 = tick(end1 - 1);
    assert(before3.paid === 0 && standingRow(a1.id).periods_done === 1, 'not a millisecond before the start of month 2: nothing moves');
    const robBefore3 = bal(rob.pk);
    const martyBefore3 = bal(marty.pk);
    const pushesBefore3 = pushes.length;
    const t3 = tick(end1 + 60_000);
    const rows3 = periodRows(a1.id);
    const sd3 = standingRow(a1.id);
    assert(t3.paid === 1 && rows3.length === 2 && rows3[1].period_no === 2 && rows3[1].status === 'completed' && near(rows3[1].credits, 50),
        `one tick pays month 2, at the 50 the payer signed for, not the new price (${JSON.stringify(t3)}, ${rows3.map(r => `${r.period_no}:${r.status}:${r.credits}`).join(' ')})`);
    assert(near(martyBefore3 - bal(marty.pk), 50) && nearPaid(bal(rob.pk) - robBefore3, 50), `Marty − 50, Rob + ${r2(bal(rob.pk) - robBefore3)}`);
    assert(sd3.phase === 'paid' && sd3.periods_done === 2 && sd3.current_tx_id === rows3[1].id && sd3.next_due_at === periodEnd(a1.startsAt, 'month', 2),
        `paid, two periods done, the next due at the start of month 3 (${sd3.next_due_at})`);
    const own3 = pushes.slice(pushesBefore3);
    assert(own3.length === 1 && own3[0].to === rob.pk && own3[0].body === '50 Beans for Vehicle Storage came in from Marty · month 2' && own3[0].kind === 'trade.update',
        `on time: the payee's push says what came in; the payer gets none (${JSON.stringify(own3)})`);
    const t3b = tick(end1 + 120_000);
    assert(t3b.paid === 0 && periodRows(a1.id).length === 2 && near(martyBefore3 - bal(marty.pk), 50), `a second tick moves nothing (${JSON.stringify(t3b)})`);
    const back3 = tick(end1 - DAY);
    assert(back3.paid === 0 && periodRows(a1.id).length === 2, 'a clock that goes back pays nothing');
    const listing3 = db.prepare('SELECT status, pending_transaction_id FROM posts WHERE id = ?').get(storage.id) as any;
    assert(listing3.status === 'pending' && listing3.pending_transaction_id === rows3[1].id, 'the listing stays taken, under the latest period');
    assertConserved('after month 2');
    setHolidayMode(rob.pk, false);

    // ── 4. A crash inside the payment ───────────────────────────────────────────────────────────────────────────────────
    console.log('── 4. A crash inside the payment ──');
    const end2 = Date.parse(periodEnd(a1.startsAt, 'month', 2));
    const crashPay = (h: any) => ({ ...h, transfer: (...args: any[]) => { if (args[0] === marty.pk && args[1] === rob.pk) throw new Error('power cut in the payment'); return h.transfer(...args); } });
    const robBefore4 = bal(rob.pk);
    const martyBefore4 = bal(marty.pk);
    const c1 = tick(end2 + 1000, crashPay);
    const sd4 = standingRow(a1.id);
    assert(c1.paid === 0 && sd4.phase === 'paid' && sd4.periods_done === 2 && periodRows(a1.id).length === 2 && near(bal(rob.pk), robBefore4) && near(bal(marty.pk), martyBefore4),
        `a crash in the payment keeps nothing: both balances as they were, no row, still two done (${JSON.stringify(c1)})`);
    assertConserved('after a crash in the payment');
    const c2 = tick(end2 + 2000);
    assert(c2.paid === 1 && periodRows(a1.id).length === 3 && standingRow(a1.id).periods_done === 3 && near(martyBefore4 - bal(marty.pk), 50) && nearPaid(bal(rob.pk) - robBefore4, 50),
        `the retry pays month 3 once (${JSON.stringify(c2)})`);
    let unique = false;
    try {
        db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, status, standing_id, period_no) VALUES (?, ?, ?, ?, 50, 'completed', ?, 3)`)
            .run(crypto.randomUUID(), storage.id, marty.pk, rob.pk, a1.id);
    } catch (e: any) { unique = /UNIQUE/.test(String(e?.message)); }
    assert(unique, 'the UNIQUE (standing_id, period_no) index refuses a second row for a period');
    assertConserved('after the crash and the retry');

    // ── 5. Short: told, retried, and paid the moment Beans arrive ───────────────────────────────────────────────────────
    console.log('── 5. Short, then covered by Beans that arrive ──');
    const end3 = Date.parse(periodEnd(a1.startsAt, 'month', 3));
    drain(marty, 20);
    tick(end3 - 2 * DAY);
    assert(keptKinds(marty.pk, a1.id).includes('standing_short_ahead') && !keptKinds(rob.pk, a1.id).includes('standing_short_ahead'),
        'three days before a month is due, a payer who will be short is told; the payee is not');
    tick(end3 - 2 * DAY + 60_000);
    assert(keptKinds(marty.pk, a1.id).filter(k => k === 'standing_short_ahead').length === 1, 'told once a period');
    const s1 = tick(end3 + 1000);
    const shortRow = standingRow(a1.id);
    assert(s1.short === 1 && shortRow.phase === 'short' && shortRow.short_since === periodStart(a1.startsAt, 'month', 4) && shortRow.periods_done === 3 && periodRows(a1.id).length === 3,
        `month 4 can't be paid at its start: short since the day it was due, no row made (${JSON.stringify(s1)}, ${shortRow.phase} ${shortRow.short_since})`);
    assert(Date.parse(shortRow.next_due_at) === end3 + 1000 + HOUR, `tried again in an hour (${shortRow.next_due_at})`);
    assert(keptKinds(marty.pk, a1.id).includes('standing_short') && keptKinds(rob.pk, a1.id).includes('standing_short'), 'both are told at the due time');
    assert(pushesTo(rob.pk, 'Vehicle Storage').some(p => p.body.startsWith("Marty's 50 Beans for this month of Vehicle Storage couldn't be paid today.")) && pushesTo(rob.pk, 'Vehicle Storage').every(p => !/short|20/.test(p.body)),
        "the payee's push says it couldn't be paid, never the payer's balance or shortfall");
    assert(chatLines("couldn't be paid when due").some(l => l.includes('Vehicle Storage')), 'the deal\'s chat records it');
    const pushesBeforeRetry = pushes.length;
    assert(tick(end3 + 30 * 60_000).paid === 0, 'not tried again before the hour');
    const retry = tick(end3 + 61 * 60_000);
    assert(retry.paid === 0 && standingRow(a1.id).phase === 'short' && pushes.length === pushesBeforeRetry, `the hourly retry, still short, sends no push (${pushes.length - pushesBeforeRetry})`);
    // A credit that leaves them short pays nothing and sends nothing.
    hookNow = end3 + 2 * HOUR;
    const pushesBeforeSmall = pushes.length;
    const kindsBeforeSmall = keptKinds(marty.pk, a1.id).length + keptKinds(rob.pk, a1.id).length;
    credit(marty, 10);
    assert(standingRow(a1.id).phase === 'short' && periodRows(a1.id).length === 3 && pushes.length === pushesBeforeSmall
        && keptKinds(marty.pk, a1.id).length + keptKinds(rob.pk, a1.id).length === kindsBeforeSmall,
        'a credit that leaves them short pays nothing, keeps nothing and sends no push');
    assertConserved('after a credit that left them short');
    // Beans that cover it: paid at once by the hook, the whole period, dates unchanged, both told.
    const robBefore5 = bal(rob.pk);
    const martyBefore5 = bal(marty.pk);
    credit(marty, 40);
    const covered = standingRow(a1.id);
    assert(covered.phase === 'paid' && covered.periods_done === 4 && covered.short_since === null && covered.next_due_at === periodEnd(a1.startsAt, 'month', 4) && periodRows(a1.id).length === 4,
        `the credit pays month 4 at once, with no tick, the whole period, the dates unchanged (${covered.phase}, ${covered.next_due_at})`);
    assert(near(martyBefore5 + 40 - bal(marty.pk), 50) && nearPaid(bal(rob.pk) - robBefore5, 50), `Marty − 50 of the 40 that came in and his 20; Rob + ${r2(bal(rob.pk) - robBefore5)}`);
    assert(keptKinds(marty.pk, a1.id).includes('standing_covered') && keptKinds(rob.pk, a1.id).includes('standing_covered')
        && pushesTo(marty.pk, 'Vehicle Storage').some(p => p.body === "Vehicle Storage: this month's 50 Beans have gone to Rob.")
        && pushesTo(rob.pk, 'Vehicle Storage').some(p => p.body === "Marty's 50 Beans for this month of Vehicle Storage came in."), 'both are told it is covered, a push and a bell row each');
    assert(chatLines('have gone to Rob').length >= 1, "the deal's chat records it");
    const hookAndTick = tick(end3 + 2 * HOUR);
    assert(hookAndTick.paid === 0 && periodRows(a1.id).length === 4 && standingRow(a1.id).periods_done === 4, `the tick in the same minute pays nothing more (${JSON.stringify(hookAndTick)})`);
    assertConserved('after covered by the hook');
    adminSetCreditFrozen(marty.pk, false);

    // A chain: A short paying B, B short paying C. Beans to A pay B, whose own hook then pays C: each once.
    console.log('── 5b. A chain A→B→C ──');
    const ada = makeMember('Ada', 100);
    const bea = makeMember('Bea', 100);
    const cy = makeMember('Cy', 0);
    const ropes = createPost('offer', 'services', 'Rope Shed', 'Ropes', 40, 'monthly', bea.pk, undefined, undefined, undefined, true) as any;
    const kilns = createPost('offer', 'services', 'Kiln Time', 'Kilns', 40, 'monthly', cy.pk, undefined, undefined, undefined, true) as any;
    const aA = authorise(ada, { postId: ropes.id, payee: bea.pk, beans: 40, unit: 'month', max: null });
    const aB = authorise(bea, { postId: kilns.id, payee: cy.pk, beans: 40, unit: 'month', max: null });
    assert((await post(ada, '/api/marketplace/posts/accept', { postId: ropes.id, buyerPublicKey: ada.pk, standing: aA.standing })).status === 200
        && (await post(bea, '/api/marketplace/posts/accept', { postId: kilns.id, buyerPublicKey: bea.pk, standing: aB.standing })).status === 200, 'two standing deals, A→B and B→C');
    drain(ada, 5);
    drain(bea, 5);
    const endChain = Math.max(Date.parse(periodEnd(aA.startsAt, 'month', 1)), Date.parse(periodEnd(aB.startsAt, 'month', 1)));
    tick(endChain + 1000);
    assert(standingRow(aA.id).phase === 'short' && standingRow(aB.id).phase === 'short', 'both are short');
    hookNow = endChain + 2000;
    const cyBefore = bal(cy.pk);
    credit(ada, 40);
    assert(standingRow(aA.id).phase === 'paid' && standingRow(aB.id).phase === 'paid' && periodRows(aA.id).length === 2 && periodRows(aB.id).length === 2
        && nearPaid(bal(cy.pk) - cyBefore, 40), `Beans to A pay B, and B's own hook pays C: each once (${standingRow(aA.id).phase}, ${standingRow(aB.id).phase}, Cy + ${r2(bal(cy.pk) - cyBefore)})`);
    assert(tick(endChain + 3000).paid === 0, 'and the tick after pays nothing more');
    assertConserved('after the chain');

    // ── 6. The grace is over ───────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 6. The grace runs out ──');
    const kai = makeMember('Kai', 30);
    const garden = createPost('offer', 'services', 'Garden Plot', 'A raised bed', 25, 'weekly', rob.pk, undefined, undefined, undefined, true) as any;
    const a6 = authorise(kai, { postId: garden.id, payee: rob.pk, beans: 25, unit: 'week', max: null });
    assert((await post(kai, '/api/marketplace/posts/accept', { postId: garden.id, buyerPublicKey: kai.pk, standing: a6.standing })).status === 200, 'a weekly standing deal starts');
    drain(kai, 2);
    const wEnd1 = Date.parse(periodEnd(a6.startsAt, 'week', 1));
    tick(wEnd1 + 1000);
    assert(standingRow(a6.id).phase === 'short', 'the weekly one is short');
    const grace6 = Date.parse(standingGraceEndsAt(a6.startsAt, 'week', 2));
    assert(grace6 - wEnd1 === 3.5 * DAY, `its grace is half the week: 3½ days (${(grace6 - wEnd1) / DAY})`);
    tick(grace6 - 60_000);
    assert(standingRow(a6.id).phase === 'short', 'still trying a minute before the grace is over');
    const kaiBefore = bal(kai.pk);
    const robBefore6 = bal(rob.pk);
    hookNow = grace6;
    credit(kai, 30);
    const ended6 = standingRow(a6.id);
    assert(ended6.phase === 'ended' && ended6.ended_reason === 'short' && near(bal(kai.pk) - kaiBefore, 30) && near(bal(rob.pk), robBefore6) && periodRows(a6.id).length === 1,
        `Beans arriving the minute the grace ends pay nothing: it ends, Beans ran short (${ended6.phase}/${ended6.ended_reason}, Kai + ${r2(bal(kai.pk) - kaiBefore)})`);
    assert(keptKinds(kai.pk, a6.id).includes('standing_ended') && keptKinds(rob.pk, a6.id).includes('standing_ended') && chatLines('Garden Plot ended').length >= 1,
        'both are told it ended, and the chat records it');
    assert((db.prepare('SELECT status FROM posts WHERE id = ?').get(garden.id) as any).status === 'active', 'its listing is back');
    assertConserved('after the grace ran out');

    // ── 7. Stop now in the grace, either side ───────────────────────────────────────────────────────────────────────────
    console.log('── 7. Stop now in the grace ──');
    const lou = makeMember('Lou', 30);
    const kim = makeMember('Kimi', 30);
    const potting = createPost('offer', 'services', 'Potting Bench', 'A bench', 25, 'weekly', rob.pk, undefined, undefined, undefined, true) as any;
    const a7 = authorise(lou, { postId: potting.id, payee: rob.pk, beans: 25, unit: 'week', max: null });
    const a7b = authorise(kim, { postId: potting.id, payee: rob.pk, beans: 25, unit: 'week', max: null });
    await post(lou, '/api/marketplace/posts/accept', { postId: potting.id, buyerPublicKey: lou.pk, standing: a7.standing });
    await post(kim, '/api/marketplace/posts/accept', { postId: potting.id, buyerPublicKey: kim.pk, standing: a7b.standing });
    drain(lou, 2);
    drain(kim, 2);
    tick(Math.max(Date.parse(periodEnd(a7.startsAt, 'week', 1)), Date.parse(periodEnd(a7b.startsAt, 'week', 1))) + 1000);
    assert(standingRow(a7.id).phase === 'short' && standingRow(a7b.id).phase === 'short', 'both short');
    const homeNeeds = async (who: Id) => ((await call(who, 'GET', '/api/home?cards=needs')).body?.cards?.needs?.items ?? []) as any[];
    assert((await homeNeeds(rob)).some(i => i.label?.includes("Lou's 25 Beans for Potting Bench")), 'the payee has a live line while it is short');
    const stranger = makeMember('Stranger', 10);
    assert((await post(stranger, `/api/marketplace/standing/${a7.id}/stop`, {})).status === 404, "a stranger can't stop it");
    const robBefore7 = bal(rob.pk);
    const louBefore = bal(lou.pk);
    const rowsBefore7 = periodRows(a7.id).length;
    const payeeStop = await post(rob, `/api/marketplace/standing/${a7.id}/stop`, {});
    const sd7 = standingRow(a7.id);
    assert(payeeStop.status === 200 && sd7.phase === 'ended' && sd7.ended_reason === 'stopped' && sd7.stopped_by === rob.pk && periodRows(a7.id).length === rowsBefore7
        && near(bal(rob.pk), robBefore7) && near(bal(lou.pk), louBefore), `the payee's Stop now ends it at once: no row, nothing moves (${show(payeeStop)})`);
    assert(keptKinds(lou.pk, a7.id).includes('standing_stopped') && !keptKinds(rob.pk, a7.id).includes('standing_stopped'), 'the payer is told; the payee, who tapped it, is not');
    assert(!(await homeNeeds(rob)).some(i => i.label?.includes("Lou's 25 Beans")) && !(await homeNeeds(lou)).some(i => i.label?.includes('Potting Bench')),
        'the Home answer has no standing line for it after, either side');
    const kimBefore = bal(kim.pk);
    const payerStop = await post(kim, `/api/marketplace/standing/${a7b.id}/stop`, {});
    assert(payerStop.status === 200 && standingRow(a7b.id).phase === 'ended' && standingRow(a7b.id).ended_reason === 'stopped' && near(bal(kim.pk), kimBefore)
        && keptKinds(rob.pk, a7b.id).includes('standing_stopped') && chatLines('Kimi stopped Potting Bench').length >= 1,
        `the payer's Stop now ends it at once too, the payee told, the chat records it (${show(payerStop)})`);
    assert((db.prepare('SELECT status FROM posts WHERE id = ?').get(potting.id) as any).status !== 'cancelled', 'the listing is untouched by a stop');
    // Your deals' History line (U2, @beanpool/core standingHistoryLine) reads why it ended, who stopped it and when, off the read.
    const louRead = await call(lou, 'GET', `/api/marketplace/transactions?publicKey=${lou.pk}`);
    const ended7 = (louRead.body as any[])?.find(t => t.standingId === a7.id && t.standingPhase);
    assert(ended7?.standingPhase === 'ended' && ended7?.standingEndedReason === 'stopped' && ended7?.standingStoppedBy === rob.pk
        && ended7?.standingEndedAt === sd7.ended_at && !!ended7?.standingShortSince,
        `the read carries how an ended one ended, for its History line (${JSON.stringify(ended7)?.slice(0, 300)})`);
    assert(tick(Date.parse(periodEnd(a7.startsAt, 'week', 3))).paid === 0 && periodRows(a7.id).length === 1 && periodRows(a7b.id).length === 1, 'and nothing is paid for either after');
    assertConserved('after Stop now');

    // ── 8. The cadence: pushes per side across a whole grace ────────────────────────────────────────────────────────────
    console.log('── 8. The cadence ──');
    const cadence = async (unit: StandingPeriodUnit, title: string, payerName: string) => {
        const payer = makeMember(payerName, 60);
        const payee = makeMember(`${payerName}'s host`, 0);
        const listing = createPost('offer', 'services', title, 'For the cadence', 50, unit === 'month' ? 'monthly' : 'weekly', payee.pk, undefined, undefined, undefined, true) as any;
        const a = authorise(payer, { postId: listing.id, payee: payee.pk, beans: 50, unit, max: null });
        assert((await post(payer, '/api/marketplace/posts/accept', { postId: listing.id, buyerPublicKey: payer.pk, standing: a.standing })).status === 200, `${title}: taken up`);
        drain(payer, 2);
        const due = Date.parse(periodEnd(a.startsAt, unit, 1));
        const graceEnd = Date.parse(standingGraceEndsAt(a.startsAt, unit, 2));
        tick(due - (unit === 'month' ? 2 * DAY : 12 * HOUR));
        for (let t = due + 1000; t <= graceEnd + HOUR; t += HOUR) tick(t);
        tick(graceEnd + 2 * HOUR);
        const sd = standingRow(a.id);
        return { sd, payer: pushesTo(payer.pk, title), payee: pushesTo(payee.pk, title) };
    };
    const monthly = await cadence('month', 'Boat Mooring', 'Moe');
    assert(monthly.sd.phase === 'ended' && monthly.sd.ended_reason === 'short', `the monthly one ran out its grace (${monthly.sd.phase}/${monthly.sd.ended_reason})`);
    assert(monthly.payer.length === 5 && monthly.payee.length === 4,
        `a monthly grace: the payer 5 pushes (ahead, due, halfway, day before, ended), the payee 4 (${monthly.payer.length}: ${monthly.payer.map(p => p.body.slice(0, 40)).join(' | ')} / ${monthly.payee.length}: ${monthly.payee.map(p => p.body.slice(0, 40)).join(' | ')})`);
    assert(monthly.payer.some(p => /\d+ days overdue/.test(p.body)) && monthly.payer.some(p => p.body.startsWith('Boat Mooring ends on')) && monthly.payee.every(p => p.kind === 'trade.update'),
        'each moment once: the halfway says the days overdue, the day before says the end; every push is trade.update');
    const weekly = await cadence('week', 'Workshop Bench', 'Wes');
    assert(weekly.sd.phase === 'ended' && weekly.payer.length === 4 && weekly.payee.length === 3 && !weekly.payer.some(p => /overdue/.test(p.body)),
        `a weekly grace: 4 and 3, no halfway (${weekly.payer.length}: ${weekly.payer.map(p => p.body.slice(0, 40)).join(' | ')} / ${weekly.payee.length})`);
    assertConserved('after the cadence');

    // ── 9. Stop outside the grace ───────────────────────────────────────────────────────────────────────────────────────
    console.log('── 9. Stop after the period paid ──');
    const stopped = await post(marty, `/api/marketplace/standing/${a1.id}/stop`, {});
    assert(stopped.status === 200 && stopped.body?.standing?.stopped === true && standingRow(a1.id).phase === 'paid', `the payer stops it: the month paid runs on (${show(stopped)})`);
    assert(keptKinds(rob.pk, a1.id).includes('standing_stopped'), 'the payee is told');
    const end4 = Date.parse(periodEnd(a1.startsAt, 'month', 4));
    const martyBefore9 = bal(marty.pk);
    const t9 = tick(end4 + 1000);
    const afterStop = standingRow(a1.id);
    assert(t9.ended >= 1 && afterStop.phase === 'ended' && afterStop.ended_reason === 'stopped' && near(bal(marty.pk), martyBefore9) && periodRows(a1.id).length === 4,
        `at its end nothing more is paid and it ends (${JSON.stringify(t9)}, ${afterStop.ended_reason})`);
    assert((db.prepare('SELECT status FROM posts WHERE id = ?').get(storage.id) as any).status === 'active', 'the one-off listing is back on the board');
    assertConserved('after the stop');

    // ── 10. K periods, and Extend ──────────────────────────────────────────────────────────────────────────────────────
    console.log('── 10. K periods ──');
    const ivy = makeMember('Ivy', 400);
    const lessons = createPost('offer', 'education', 'Guitar Lessons', 'Weekly lesson', 20, 'weekly', rob.pk, undefined, undefined, undefined, true) as any;
    const a10 = authorise(ivy, { postId: lessons.id, payee: rob.pk, beans: 20, unit: 'week', max: 2 });
    assert((await post(ivy, '/api/marketplace/posts/accept', { postId: lessons.id, buyerPublicKey: ivy.pk, standing: a10.standing })).status === 200 && standingRow(a10.id).max_periods === 2, 'for 2 weeks');
    tick(Date.parse(periodEnd(a10.startsAt, 'week', 1)) + 1000);
    assert(standingRow(a10.id).periods_done === 2 && keptKinds(ivy.pk, a10.id).includes('standing_last_period') && keptKinds(rob.pk, a10.id).includes('standing_last_period'),
        'the second (last) week is paid, and both are told it is the last');
    const forged = authorise(ivy, { postId: lessons.id, payee: rob.pk, beans: 20, unit: 'week', max: 3, id: a10.id, startsAt: a10.startsAt });
    assert((await post(rob, `/api/marketplace/standing/${a10.id}/extend`, { standing: forged.standing })).status === 403, 'only the payer extends');
    const wrongPrice = authorise(ivy, { postId: lessons.id, payee: rob.pk, beans: 21, unit: 'week', max: 3, id: a10.id, startsAt: a10.startsAt });
    const extendedPrice = await post(ivy, `/api/marketplace/standing/${a10.id}/extend`, { standing: wrongPrice.standing });
    assert(extendedPrice.status === 400 && extendedPrice.body?.code === 'standing_auth', `an extension can't change the price (${show(extendedPrice)})`);
    const extended = await post(ivy, `/api/marketplace/standing/${a10.id}/extend`, { standing: forged.standing });
    assert(extended.status === 200 && standingRow(a10.id).max_periods === 3 && standingRow(a10.id).auth_payload === forged.payload, `the payer extends it to 3 weeks (${show(extended)})`);
    tick(Date.parse(periodEnd(a10.startsAt, 'week', 2)) + 1000);
    tick(Date.parse(periodEnd(a10.startsAt, 'week', 3)) + 1000);
    const k = standingRow(a10.id);
    assert(k.phase === 'ended' && k.ended_reason === 'count_reached' && periodRows(a10.id).length === 3 && periodRows(a10.id).every(r => r.status === 'completed'),
        `after the third week it ends: the count reached, three periods paid (${k.phase}/${k.ended_reason}, ${periodRows(a10.id).length})`);
    assertConserved('after K periods');

    // ── 11. Forged or mismatched authorisations; a keeper as payee ──────────────────────────────────────────────────────
    console.log('── 11. Forged authorisations ──');
    const zed = makeMember('Zed', 400);
    const tool = createPost('offer', 'services', 'Tool Shed Access', 'Monthly', 30, 'monthly', rob.pk, undefined, undefined, undefined, true) as any;
    const good = () => authorise(zed, { postId: tool.id, payee: rob.pk, beans: 30, unit: 'month', max: null });
    const tryAccept = (standing: unknown) => post(zed, '/api/marketplace/posts/accept', { postId: tool.id, buyerPublicKey: zed.pk, standing });
    const zedBefore = bal(zed.pk);
    const cases: Array<[string, unknown]> = [
        ['signed by another key', authorise(stranger, { postId: tool.id, payee: rob.pk, beans: 30, unit: 'month', max: null }).standing],
        ['the bare text signed, as an older app signs a node\'s text', authorise(zed, { postId: tool.id, payee: rob.pk, beans: 30, unit: 'month', max: null, bare: true }).standing],
        ['a price that is not the listing\'s', authorise(zed, { postId: tool.id, payee: rob.pk, beans: 20, unit: 'month', max: null }).standing],
        ['another listing', authorise(zed, { postId: storage.id, payee: rob.pk, beans: 30, unit: 'month', max: null }).standing],
        ['another payee', authorise(zed, { postId: tool.id, payee: ana.pk, beans: 30, unit: 'month', max: null }).standing],
        ['another period', authorise(zed, { postId: tool.id, payee: rob.pk, beans: 30, unit: 'week', max: null }).standing],
        ['another community', authorise(zed, { postId: tool.id, payee: rob.pk, beans: 30, unit: 'month', max: null, host: 'elsewhere.example' }).standing],
        ['a start 40 days ahead', authorise(zed, { postId: tool.id, payee: rob.pk, beans: 30, unit: 'month', max: null, startsAt: new Date(Date.now() + 40 * DAY).toISOString() }).standing],
        ['a text tampered after signing', (() => { const g = good(); (g.standing as any).authorisation.payload = g.payload.replace('30.00', '3.00'); return g.standing; })()],
        ['no signature', { authorisation: { payload: good().payload } }],
        ['an id already used', authorise(zed, { postId: tool.id, payee: rob.pk, beans: 30, unit: 'month', max: null, id: a1.id }).standing],
        ['the app says a count the text does not', { ...(good().standing as any), periods: 6 }],
    ];
    for (const [what, standing] of cases) {
        const r = await tryAccept(standing);
        assert(r.status === 400 && r.body?.code === 'standing_auth', `${what}: 400 standing_auth (${show(r)})`);
    }
    assert(near(bal(zed.pk), zedBefore) && !(db.prepare('SELECT 1 FROM marketplace_transactions WHERE post_id = ? AND buyer_pubkey = ?').get(tool.id, zed.pk)),
        'none of them paid anything or wrote a deal');
    const hourly = createPost('offer', 'services', 'Lawn Mowing', 'Per hour', 15, 'hourly', rob.pk, undefined, undefined, undefined, true) as any;
    const hr = await post(zed, '/api/marketplace/posts/accept', { postId: hourly.id, buyerPublicKey: zed.pk, standing: authorise(zed, { postId: hourly.id, payee: rob.pk, beans: 15, unit: 'week', max: null }).standing });
    assert(hr.status === 400 && hr.body?.code === 'standing_auth', `an hourly listing makes no standing deal (${show(hr)})`);
    // An enterprise paying a keeper of its own: refused.
    const ent = makeMember('Eggs Co', 400, { treasury: true });
    const keeper = makeMember('Kim', 50);
    const keeper2 = makeMember('Kit', 50);
    db.prepare('INSERT INTO treasury_operators (treasury_pubkey, member_pubkey) VALUES (?, ?)').run(ent.pk, keeper.pk);
    db.prepare('INSERT INTO treasury_operators (treasury_pubkey, member_pubkey) VALUES (?, ?)').run(ent.pk, keeper2.pk);
    db.prepare('UPDATE members SET can_operate = 1 WHERE public_key IN (?, ?)').run(keeper.pk, keeper2.pk);
    const kimsOffer = createPost('offer', 'services', 'Bookkeeping', 'Monthly books', 40, 'monthly', keeper.pk, undefined, undefined, undefined, true) as any;
    const engineAccept = (postId: string, payee: string, beans: number) => {
        const st = authorise(keeper2, { postId, payee, beans, unit: 'month', max: null });
        try {
            return { tx: se.acceptPost(postId, ent.pk, undefined, { authSigner: keeper2.pk, standing: { ...(st.standing as any), requestHost: HOST } }), err: null as any, id: st.id };
        } catch (e: any) { return { tx: null, err: e, id: st.id }; }
    };
    const keeperPaid = engineAccept(kimsOffer.id, keeper.pk, 40);
    assert(keeperPaid.err?.code === 'standing_keeper' && keeperPaid.err?.status === 403 && keeperPaid.err?.message === "A standing deal can't pay a keeper of the enterprise that pays it. Pay each job as a deal.",
        `a standing deal paying a keeper of the paying enterprise is refused (${keeperPaid.err?.code}: ${keeperPaid.err?.message})`);
    const entOk = engineAccept(tool.id, rob.pk, 30);
    assert(!!entOk.tx && standingRow(entOk.id)?.auth_signer === keeper2.pk && standingRow(entOk.id)?.payer_pubkey === ent.pk && standingRow(entOk.id)?.periods_done === 1,
        `a keeper signs an enterprise's standing deal with another member, its first month paid (${entOk.err?.message ?? 'ok'})`);
    assertConserved('after the refusals');

    // ── 12. Late ───────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 12. Late ──');
    const sam = makeMember('Sam', 400);
    const a12 = authorise(sam, { postId: tool.id, payee: rob.pk, beans: 30, unit: 'month', max: null });
    await post(sam, '/api/marketplace/posts/accept', { postId: tool.id, buyerPublicKey: sam.pk, standing: a12.standing });
    const lateOk = tick(Date.parse(periodEnd(a12.startsAt, 'month', 1)) + 10 * DAY);
    assert(lateOk.paid >= 1 && standingRow(a12.id).periods_done === 2 && standingRow(a12.id).next_due_at === periodEnd(a12.startsAt, 'month', 2),
        `ten days late (under a period) pays as normal, the dates unchanged (${JSON.stringify(lateOk)})`);
    const tom = makeMember('Tom', 400);
    const a12b = authorise(tom, { postId: tool.id, payee: rob.pk, beans: 30, unit: 'month', max: null });
    await post(tom, '/api/marketplace/posts/accept', { postId: tool.id, buyerPublicKey: tom.pk, standing: a12b.standing });
    const tomBefore = bal(tom.pk);
    tick(Date.parse(periodEnd(a12b.startsAt, 'month', 2)) + 1000);
    const late = standingRow(a12b.id);
    assert(late.phase === 'ended' && late.ended_reason === 'server_away' && periodRows(a12b.id).length === 1 && near(bal(tom.pk), tomBefore),
        `a month already over when its turn comes is never paid: it ends (${late.phase}/${late.ended_reason})`);
    assert(keptKinds(tom.pk, a12b.id).includes('standing_ended') && keptKinds(rob.pk, a12b.id).includes('standing_ended'), 'both are told');
    assertConserved('after late');

    // ── 13. A standby ticks nothing; Beans off moves nothing ────────────────────────────────────────────────────────────
    console.log('── 13. Standby and Beans off ──');
    const sdBefore = JSON.stringify(standingRow(a12.id));
    setNodeRole('backup');
    const onBackup = tick(Date.parse(periodEnd(a12.startsAt, 'month', 2)) + 1000);
    setNodeRole('primary');
    assert(onBackup.paid === 0 && JSON.stringify(standingRow(a12.id)) === sdBefore, `a standby ticks nothing (${JSON.stringify(onBackup)})`);
    const standbyStop = await (async () => { setNodeRole('backup'); try { return await post(sam, `/api/marketplace/standing/${a12.id}/stop`, {}); } finally { setNodeRole('primary'); } })();
    assert(standbyStop.status >= 400 && standingRow(a12.id).stopped_at === null, `a standby refuses a Stop (${show(standbyStop)})`);
    setSwitchOverride('beans', false);
    const beansOff = tick(Date.parse(periodEnd(a12.startsAt, 'month', 2)) + 1000);
    setSwitchOverride('beans', true);
    assert(beansOff.paid === 0 && JSON.stringify(standingRow(a12.id)) === sdBefore, `with Beans off nothing moves (${JSON.stringify(beansOff)})`);

    // ── 14. A Need ─────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 14. A Need ──');
    const nan = makeMember('Nan', 400);
    const helper = makeMember('Hal', 0);
    const care = createPost('need', 'services', 'Weekly Garden Help', 'Two hours each week', 35, 'weekly', nan.pk, undefined, undefined, undefined, true) as any;
    const asked = await post(helper, '/api/marketplace/posts/request', { postId: care.id, buyerPublicKey: helper.pk, hours: 1 });
    assert(asked.status === 200, `the helper offers to help (${show(asked)})`);
    const a14 = authorise(nan, { postId: care.id, payee: helper.pk, beans: 35, unit: 'week', max: null });
    const nanBefore = bal(nan.pk);
    const approved = await post(nan, '/api/marketplace/transactions/approve', { transactionId: asked.body?.transaction?.id, authorPublicKey: nan.pk, standing: a14.standing });
    assert(approved.status === 200 && approved.body?.transaction?.standingId === a14.id && approved.body?.transaction?.status === 'completed'
        && near(nanBefore - bal(nan.pk), 35) && nearPaid(bal(helper.pk), 35) && escrowsOf(a14.id) === 0,
        `the author approves with a signed authorisation: the helper is paid the first week at once (${show(approved)}, Hal ${r2(bal(helper.pk))})`);
    const halBefore = bal(helper.pk);
    tick(Date.parse(periodEnd(a14.startsAt, 'week', 1)) + 1000);
    assert(nearPaid(bal(helper.pk) - halBefore, 35) && periodRows(a14.id).length === 2 && standingRow(a14.id).phase === 'paid',
        `at the week's start the helper is paid the next week (${r2(bal(helper.pk) - halBefore)})`);
    assertConserved('after the Need');

    // ── 15. The author removes the listing ─────────────────────────────────────────────────────────────────────────────
    console.log('── 15. The author removes the listing ──');
    const yan = makeMember('Yan', 50);
    const zoe = makeMember('Zoe', 300);
    const desk = createPost('offer', 'services', 'Desk Space', 'A desk by the window', 45, 'weekly', rob.pk, undefined, undefined, undefined, true) as any;
    const a15 = authorise(yan, { postId: desk.id, payee: rob.pk, beans: 45, unit: 'week', max: null });
    await post(yan, '/api/marketplace/posts/accept', { postId: desk.id, buyerPublicKey: yan.pk, standing: a15.standing });
    drain(yan, 2);
    tick(Date.parse(periodEnd(a15.startsAt, 'week', 1)) + 1000);
    assert(standingRow(a15.id).phase === 'short', 'Yan is short');
    const a15b = authorise(zoe, { postId: desk.id, payee: rob.pk, beans: 45, unit: 'week', max: null });
    await post(zoe, '/api/marketplace/posts/accept', { postId: desk.id, buyerPublicKey: zoe.pk, standing: a15b.standing });
    const deskRemoved = await post(rob, '/api/marketplace/posts/remove', { id: desk.id, authorPublicKey: rob.pk });
    assert(deskRemoved.status === 200 && standingRow(a15.id).phase === 'ended' && standingRow(a15b.id).phase === 'paid' && !!standingRow(a15b.id).stopped_at,
        `the author removes it: the short one ends, the paid one stops after its week (${show(deskRemoved)})`);
    assert(keptKinds(yan.pk, a15.id).includes('standing_ended') && keptKinds(zoe.pk, a15b.id).includes('standing_stopped')
        && !keptKinds(rob.pk, a15.id).includes('standing_ended') && !keptKinds(rob.pk, a15b.id).includes('standing_stopped'), 'each payer is told; the author who removed it is not');
    const zoeBefore = bal(zoe.pk);
    tick(Date.parse(periodEnd(a15b.startsAt, 'week', 1)) + 1000);
    assert(standingRow(a15b.id).phase === 'ended' && standingRow(a15b.id).ended_reason === 'stopped' && near(bal(zoe.pk), zoeBefore), 'at its week\'s end nothing more is paid');
    assertConserved('after the removal');

    // ── 16. The transactions read and its ETag ───────────────────────────────────────────────────────────────────────
    console.log('── 16. The transactions read ──');
    const pia = makeMember('Pia', 300);
    const a16 = authorise(pia, { postId: lessons.id, payee: rob.pk, beans: 20, unit: 'week', max: 6 });
    await post(pia, '/api/marketplace/posts/accept', { postId: lessons.id, buyerPublicKey: pia.pk, standing: a16.standing });
    tick(Date.parse(periodEnd(a16.startsAt, 'week', 1)) + 1000);
    const read1 = await call(pia, 'GET', `/api/marketplace/transactions?publicKey=${pia.pk}`);
    const cur = (read1.body as any[])?.find(t => t.standingId === a16.id && t.standingPhase);
    assert(read1.status === 200 && cur?.standingPhase === 'paid' && cur?.status === 'completed' && cur?.standingUnit === 'week' && near(cur?.standingBeans, 20) && cur?.periodNo === 2
        && cur?.standingMaxPeriods === 6 && cur?.standingNextDueAt === periodEnd(a16.startsAt, 'week', 2) && cur?.standingStopped === false,
        `the read carries the standing fields on the current row (${JSON.stringify(cur)?.slice(0, 260)})`);
    assert(cur?.standingEndedReason === undefined && cur?.standingStoppedBy === undefined, 'a running one carries no end');
    const older = (read1.body as any[])?.find(t => t.standingId === a16.id && t.periodNo === 1);
    assert(!!older && older.status === 'completed' && older.standingPhase === undefined, 'an older period carries none');
    drain(pia, 2);
    tick(Date.parse(periodEnd(a16.startsAt, 'week', 2)) + 1000);
    const read2 = await call(pia, 'GET', `/api/marketplace/transactions?publicKey=${pia.pk}`);
    const cur2 = (read2.body as any[]).find(t => t.standingId === a16.id && t.standingPhase);
    assert(!!read1.etag && !!read2.etag && read1.etag !== read2.etag && cur2?.standingPhase === 'short' && cur2?.standingShortSince === periodStart(a16.startsAt, 'week', 3),
        `the ETag changes when the phase does, and the read says since when it is short (${read1.etag} → ${read2.etag}, ${cur2?.standingShortSince})`);

    // ── 17. A re-key of either side ────────────────────────────────────────────────────────────────────────────────────
    console.log('── 17. Re-key ──');
    const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
    const quinn = makeMember('Quinn', 300);
    const rae = makeMember('Rae', 0);
    const baking = createPost('offer', 'food', 'Weekly Bread', 'A loaf a week', 15, 'weekly', rae.pk, undefined, undefined, undefined, true) as any;
    const a17 = authorise(quinn, { postId: baking.id, payee: rae.pk, beans: 15, unit: 'week', max: null });
    await post(quinn, '/api/marketplace/posts/accept', { postId: baking.id, buyerPublicKey: quinn.pk, standing: a17.standing });
    const raeNew = crypto.generateKeyPairSync('ed25519');
    const raeNewPk = (raeNew.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    completeRekey(rae.pk, raeNewPk, issueRekeyCode(rae.pk, 'owner:password').code, 'owner:password');
    assert(standingRow(a17.id).payee_pubkey === raeNewPk, 'the payee re-keys: the standing row moves to the new key');
    const raeNewBefore = bal(raeNewPk);
    tick(Date.parse(periodEnd(a17.startsAt, 'week', 1)) + 1000);
    assert(nearPaid(bal(raeNewPk) - raeNewBefore, 15) && standingRow(a17.id).phase === 'paid' && periodRows(a17.id).length === 2 && periodRows(a17.id)[1].seller_pubkey === raeNewPk,
        'the next week is paid to the new key: the signed text\'s payee is read through the re-key');
    const quinnNew = crypto.generateKeyPairSync('ed25519');
    const quinnNewPk = (quinnNew.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    completeRekey(quinn.pk, quinnNewPk, issueRekeyCode(quinn.pk, 'owner:password').code, 'owner:password');
    const quinnBefore = bal(quinnNewPk);
    tick(Date.parse(periodEnd(a17.startsAt, 'week', 2)) + 1000);
    assert(standingRow(a17.id).payer_pubkey === quinnNewPk && periodRows(a17.id).length === 3 && periodRows(a17.id)[2].buyer_pubkey === quinnNewPk && near(quinnBefore - bal(quinnNewPk), 15),
        'the payer re-keys: the next week is paid from the new key');
    assertConserved('after the re-keys');

    // ── 18. An enterprise payee ────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 18. An enterprise payee ──');
    const uma = makeMember('Uma', 300);
    const eggs = createPost('offer', 'food', 'Egg Box', 'A dozen a month', 20, 'monthly', ent.pk, undefined, undefined, undefined, true) as any;
    const surplusOf = () => Number((db.prepare('SELECT earned_surplus_c FROM members WHERE public_key = ?').get(ent.pk) as any)?.earned_surplus) || 0;
    const surplus0 = surplusOf();
    const a18 = authorise(uma, { postId: eggs.id, payee: ent.pk, beans: 20, unit: 'month', max: null });
    assert((await post(uma, '/api/marketplace/posts/accept', { postId: eggs.id, buyerPublicKey: uma.pk, standing: a18.standing })).status === 200 && near(surplusOf() - surplus0, 20),
        `a member takes up an enterprise's Offer: the first month counts toward its earned surplus (${surplusOf() - surplus0})`);
    const surplus1 = surplusOf();
    tick(Date.parse(periodEnd(a18.startsAt, 'month', 1)) + 1000);
    assert(near(surplusOf() - surplus1, 20) && standingRow(a18.id).periods_done === 2, `the tick's payment counts too, with no signer (${surplusOf() - surplus1})`);
    assertConserved('after the enterprise payee');

    // ── 19. A moderator removes the listing ────────────────────────────────────────────────────────────────────────────
    console.log('── 19. A moderator removes the listing ──');
    const vic = makeMember('Vic', 300);
    const shed = createPost('offer', 'services', 'Bike Shed', 'A locked shed', 40, 'monthly', rob.pk, undefined, undefined, undefined, true) as any;
    const a19 = authorise(vic, { postId: shed.id, payee: rob.pk, beans: 40, unit: 'month', max: null });
    await post(vic, '/api/marketplace/posts/accept', { postId: shed.id, buyerPublicKey: vic.pk, standing: a19.standing });
    const vicBefore = bal(vic.pk);
    const robBefore19 = bal(rob.pk);
    assert(se.adminDeletePost(shed.id) && standingRow(a19.id).phase === 'ended' && standingRow(a19.id).ended_reason === 'listing_gone' && near(bal(vic.pk), vicBefore) && near(bal(rob.pk), robBefore19),
        `a moderator's removal ends it at once; the month paid stays paid, nothing to refund (${standingRow(a19.id).phase}/${standingRow(a19.id).ended_reason})`);
    assert(keptKinds(vic.pk, a19.id).includes('standing_ended') && keptKinds(rob.pk, a19.id).includes('standing_ended'), 'both are told it ended');
    let vicHoliday = 'ok';
    try { setHolidayMode(vic.pk, true); } catch (e: any) { vicHoliday = e?.message ?? 'refused'; }
    assert(vicHoliday === 'ok', `the payer may go on holiday again (${vicHoliday})`);
    setHolidayMode(vic.pk, false);
    assertConserved('after the moderator removal');

    // ── 20. The keeper who signed is a keeper no more ──────────────────────────────────────────────────────────────────
    console.log('── 20. The signer is no longer a keeper ──');
    const windows = createPost('offer', 'services', 'Window Cleaning', 'Once a month', 15, 'monthly', rob.pk, undefined, undefined, undefined, true) as any;
    const e20 = engineAccept(windows.id, rob.pk, 15);
    assert(!!e20.tx, `a keeper signs an enterprise's standing deal on an Offer (${e20.err?.message ?? 'ok'})`);
    const start20 = standingRow(e20.id).starts_at as string;
    tick(Date.parse(periodEnd(start20, 'month', 1)) + 1000);
    assert(standingRow(e20.id).periods_done === 2, 'while the signer keeps the enterprise, the next month is paid');
    db.prepare('DELETE FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?').run(ent.pk, keeper2.pk);
    tick(Date.parse(periodEnd(start20, 'month', 2)) + 1000);
    const sd20 = standingRow(e20.id);
    const third = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE from_pubkey = ? AND auth_payload = ?').get(ent.pk, `standing:${e20.id}:3`) as { n: number };
    assert(sd20.phase === 'ended' && sd20.ended_reason === 'cant_run' && periodRows(e20.id).length === 2 && third.n === 0,
        `the signer removed as a keeper: no further month is paid from the enterprise (${sd20.phase}/${sd20.ended_reason}, ${third.n} third payments)`);
    assert(keptKinds(rob.pk, e20.id).includes('standing_ended'), 'the payee is told it ended');
    assertConserved('after the keeper left');

    // ── 21. The Home answer's live lines ───────────────────────────────────────────────────────────────────────────────
    console.log('── 21. The Home answer ──');
    const max = makeMember('Max', 60);
    const loft = createPost('offer', 'services', 'Loft Storage', 'Dry and dusty', 50, 'monthly', rob.pk, undefined, undefined, undefined, true) as any;
    const a21 = authorise(max, { postId: loft.id, payee: rob.pk, beans: 50, unit: 'month', max: null });
    await post(max, '/api/marketplace/posts/accept', { postId: loft.id, buyerPublicKey: max.pk, standing: a21.standing });
    assert(!(await homeNeeds(max)).some(i => i.label?.includes('Loft Storage')), 'paid: no line');
    drain(max, 2);
    tick(Date.parse(periodEnd(a21.startsAt, 'month', 1)) + 1000);
    const txId21 = standingRow(a21.id).current_tx_id;
    const payerLine = (await homeNeeds(max)).find(i => i.label?.startsWith('Loft Storage: 50 Beans'));
    const payeeLine = (await homeNeeds(rob)).find(i => i.label?.startsWith("Max's 50 Beans for Loft Storage"));
    assert(!!payerLine && payerLine.kind === 'deal' && payerLine.accent === true && payerLine.count === 1 && payerLine.target?.to === 'deal' && payerLine.target?.txId === txId21
        && / · until \d+ \w+$/.test(payerLine.label), `the payer's live line: amber, counted, to the deal (${JSON.stringify(payerLine)})`);
    assert(!!payeeLine && payeeLine.accent === false && payeeLine.label.endsWith('you can stop it now') && !/short|balance|you have/i.test(payeeLine.label),
        `the payee's: calm, says they can stop it, never the payer's balance (${JSON.stringify(payeeLine)})`);
    assert(!(await homeNeeds(max)).some(i => i.label?.startsWith('A deal is waiting for you')), 'the short deal is not counted again in the generic deal line');
    hookNow = Date.parse(periodEnd(a21.startsAt, 'month', 1)) + 2000;
    credit(max, 60);
    assert(standingRow(a21.id).phase === 'paid' && !(await homeNeeds(max)).some(i => i.label?.includes('Loft Storage')) && !(await homeNeeds(rob)).some(i => i.label?.includes('Loft Storage')),
        'paid by Beans that came in: both lines leave at once');
    assertConserved('after the Home lines');

    // ── 22. No helper nothing calls ────────────────────────────────────────────────────────────────────────────────────
    const standingModule = await import('./engine/standing-deals.js') as Record<string, unknown>;
    assert(!('holdBackStandingDeal' in standingModule) && !('standingPeriodSettled' in standingModule) && !('assertNotRunningStandingPeriod' in standingModule)
        && !('STANDING_RUNS_ITSELF_CODE' in standingModule) && !('liveStandingPeriodsOn' in standingModule),
        'Hold back, the period settlement and the release guard are gone, and nothing unused is exported');

    (se as any).setStandingHookForTests(null, null);
    assertConserved('at the end');
    console.log(`\n${passed}/${run} assertions passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error('Unhandled failure:', e);
    process.exit(1);
});

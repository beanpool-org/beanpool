/**
 * Standing deals: paying for something by the week or by the month, one period's Beans in trust at a time
 * (scratch/fable-design/DESIGN-standing-deals-fable.md §7 S1; Marty's decisions, 9 Nov 2026).
 *
 * Over real HTTP with real signatures: the accept and the approval with `standing` (the payer's signed authorisation), Stop,
 * Hold back and Extend, Release and Cancel hold, the transactions read and its ETag. The node's minute tick is run as the
 * main server runs it (state-engine.ts runStandingDeals), each time with a pinned `now`, and with the node's own transfer
 * watched where a crash is simulated.
 *
 *  1. Accept holds one period: the standing row, period 1's deal row, its escrow, the ledger row naming the signer and
 *     `standing:<id>:1`; a monthly listing taken without `standing` is today's deal (Beans for the months typed).
 *  2. A period running by itself: nobody is nudged, the payer's Release is refused (409 standing_runs_itself), the price
 *     can change under it, and its payer is kept from holiday while its payee may go.
 *  3. At the period's end the tick settles it once (the payee paid less 1.5%) and holds the next once; a second tick moves
 *     nothing; at no moment more than one period is held; the audit holds.
 *  4. A crash: in the release (nothing settled, the next tick settles once) and between the two steps (settled, not held:
 *     the next tick holds once). The UNIQUE (standing, period) index refuses a second row for a period.
 *  5. Short: warned ahead (the payer only), both told at the due time, tried again hourly, covered again (held with the
 *     original dates), and a second one that stays short ends after 7 days with nothing owed.
 *  6. Stop: by the payer, the period under way is still paid and then it ends; by the payee while short, at once.
 *  7. Hold back: the period stays held past its end; the payer's Release resumes it (next period held at its own date);
 *     a hold back cancelled refunds and ends it.
 *  8. K periods: for 2 months, the last is told a period ahead and it ends after the second; Extend makes it 3.
 *  9. Forged or mismatched authorisations: 400 standing_auth, nothing held. A keeper of the paying enterprise as payee: 403.
 * 10. Late: under one period late settles normally; more than one is held back for a person (node_held), both told.
 * 11. A standby ticks nothing; with Beans off nothing moves.
 * 12. A Need: the helper asks, the author approves with `standing`, the tick pays the helper.
 * 13. The author removes the listing: allowed while a period is held, which is still paid, then it ends.
 * 14. The transactions read carries the standing fields, and its ETag changes when the phase does.
 * 15. A re-key of the payee, then of the payer: the standing deal carries on under each new key.
 * 16. An enterprise payee: the tick's release counts toward its earned surplus with no signer.
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
import { TRANSACTION_FEE_RATE, periodEnd, standingAuthorisationText, type StandingPeriodUnit } from '@beanpool/core';
const createPost = wrapCreatePost(rawCreatePost);

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); }
}

const DAY = 86_400_000;
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
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
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
/** A standing authorisation as an app makes one, signed by `signer` over the text's UTF-8 bytes. */
function authorise(signer: Id, o: AuthOpts): { id: string; startsAt: string; payload: string; standing: Record<string, unknown> } {
    const id = o.id ?? crypto.randomUUID();
    const startsAt = o.startsAt ?? new Date(Date.now()).toISOString();
    const payload = standingAuthorisationText({
        host: o.host ?? HOST, standingId: id, listingId: o.postId, payee: o.payee, beansPerPeriod: o.beans, unit: o.unit, maxPeriods: o.max, startsAt,
        nonce: o.nonce ?? crypto.randomBytes(12).toString('hex'),
    });
    const signature = crypto.sign(null, Buffer.from(payload, 'utf-8'), signer.priv).toString('base64');
    return { id, startsAt, payload, standing: { authorisation: { payload, signature }, ...(o.max === null ? { untilStopped: true } : { periods: o.max }), startsAt } };
}

const standingRow = (id: string) => db.prepare('SELECT * FROM standing_deals WHERE id = ?').get(id) as any;
const periodRows = (id: string) => db.prepare('SELECT * FROM marketplace_transactions WHERE standing_id = ? ORDER BY period_no').all(id) as any[];
const bal = (pk: string) => (db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(pk) as { balance: number } | undefined)?.balance ?? 0;
const heldFor = (id: string) => periodRows(id).reduce((s, r) => s + bal(`escrow_${r.id}`), 0);
const keptKinds = (pk: string, standingId: string) => (db.prepare(`SELECT data FROM moderation_notices WHERE recipient = ? ORDER BY created_at, rowid`).all(pk) as { data: string }[])
    .map(r => { try { return JSON.parse(r.data); } catch { return {}; } }).filter(d => d.standing === standingId).map(d => d.kind as string);
function nodeTotal(): number {
    const accounts = (db.prepare(`SELECT COALESCE(SUM(balance), 0) t FROM accounts WHERE public_key != 'COMMONS_POOL'`).get() as any).t;
    return r2(accounts + getCommonsBalanceExact());
}
function assertConserved(step: string): void {
    const audit = runLedgerAudit();
    assert(audit.ok && Math.abs(audit.drift) < 0.0001 && Math.abs(nodeTotal()) < 0.0001, `${step}: the Beans are conserved (audit ${audit.ok ? 'ok' : 'FAILED'}, drift ${audit.drift}, total ${nodeTotal()})`);
}
const tick = (now: number, wrap?: (h: any) => any) => (se as any).runStandingDeals(now, wrap) as { settled: number; held: number; short: number; ended: number };
const payeeShare = (beans: number) => beans * (1 - TRANSACTION_FEE_RATE);
/** A payee's share, to the half cent (the fee on 35 Beans is 0.525). */
const nearPaid = (got: number, beans: number) => Math.abs(got - payeeShare(beans)) < 0.006;

async function main(): Promise<void> {
    console.log('\nStanding deals: one period in trust at a time\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    // The host as apps sign it (lower case, no port: engine/own-addresses.ts audienceStanding).
    HOST = new URL(BASE).hostname;
    assert(typeof (se as any).runStandingDeals === 'function', "the main server's minute tick has its wrapper (state-engine.ts runStandingDeals)");

    const marty = makeMember('Marty', 400);
    const rob = makeMember('Rob', 0);
    const storage = createPost('offer', 'services', 'Vehicle Storage', 'A covered space for one car', 50, 'monthly', rob.pk) as any;

    // ── 1. Accept holds one period ───────────────────────────────────────────────────────────────────────────────────
    console.log('── 1. Accept holds one period ──');
    const martyBefore = bal(marty.pk);
    const a1 = authorise(marty, { postId: storage.id, payee: rob.pk, beans: 50, unit: 'month', max: null });
    const accepted = await post(marty, '/api/marketplace/posts/accept', { postId: storage.id, buyerPublicKey: marty.pk, standing: a1.standing });
    assert(accepted.status === 200 && accepted.body?.transaction?.standingId === a1.id && accepted.body?.transaction?.periodNo === 1,
        `the accept with a signed authorisation answers the period-1 deal (${show(accepted)})`);
    const sd1 = standingRow(a1.id);
    const p1 = periodRows(a1.id);
    assert(!!sd1 && sd1.phase === 'held' && sd1.periods_done === 0 && sd1.current_tx_id === p1[0]?.id && sd1.next_due_at === periodEnd(a1.startsAt, 'month', 1)
        && sd1.auth_payload === a1.payload && sd1.auth_signer === marty.pk, `the standing row: held, period 1 current, due at the month's end (${JSON.stringify(sd1)?.slice(0, 200)})`);
    assert(p1.length === 1 && p1[0].status === 'pending' && near(p1[0].credits, 50) && p1[0].hours === null && near(bal(`escrow_${p1[0].id}`), 50)
        && near(bal(marty.pk), martyBefore - 50), `one period's 50 Beans are held, and only that (${p1.length} row, escrow ${bal(`escrow_${p1[0]?.id}`)})`);
    const holdRow = db.prepare(`SELECT auth_signer, auth_payload, auth_signature FROM transactions WHERE to_pubkey = ? ORDER BY timestamp DESC LIMIT 1`).get(`escrow_${p1[0].id}`) as any;
    assert(holdRow?.auth_signer === marty.pk && holdRow?.auth_payload === `standing:${a1.id}:1` && holdRow?.auth_signature == null,
        `the hold's ledger row names the payer and standing:<id>:1 (${JSON.stringify(holdRow)})`);
    const listingNow = db.prepare('SELECT status, pending_transaction_id FROM posts WHERE id = ?').get(storage.id) as any;
    assert(listingNow.status === 'pending' && listingNow.pending_transaction_id === p1[0].id, 'a one-off listing is taken while its standing deal runs');
    assertConserved('after the accept');

    // A monthly listing taken without `standing` is today's deal.
    const ana = makeMember('Ana', 300);
    const bikeRack = createPost('offer', 'services', 'Bike Rack Space', 'Indoors', 10, 'monthly', rob.pk, undefined, undefined, undefined, true) as any;
    const plain = await post(ana, '/api/marketplace/posts/accept', { postId: bikeRack.id, buyerPublicKey: ana.pk, hours: 3 });
    assert(plain.status === 200 && near(plain.body?.transaction?.credits, 30) && !plain.body?.transaction?.standingId,
        `without standing a per-month listing keeps today's behaviour: 3 months, 30 Beans, no standing deal (${show(plain)})`);
    await post(ana, '/api/marketplace/transactions/cancel', { transactionId: plain.body?.transaction?.id, cancellerPublicKey: ana.pk });
    const again = await post(marty, '/api/marketplace/posts/accept', { postId: storage.id, buyerPublicKey: marty.pk, standing: authorise(marty, { postId: storage.id, payee: rob.pk, beans: 50, unit: 'month', max: null }).standing });
    assert(again.status === 400 || again.status === 409, `a second take-up of a one-off listing under a standing deal is refused (${show(again)})`);

    // ── 2. A period running by itself ────────────────────────────────────────────────────────────────────────────────
    console.log('── 2. A period running by itself ──');
    const early = await post(marty, '/api/marketplace/transactions/complete', { transactionId: p1[0].id, confirmerPublicKey: marty.pk });
    assert(early.status === 409 && early.body?.code === 'standing_runs_itself', `the payer's Release of a period running by itself is refused, saying why (${show(early)})`);
    db.prepare(`UPDATE marketplace_transactions SET created_at = ? WHERE id = ?`).run(new Date(Date.now() - 20 * DAY).toISOString(), p1[0].id);
    runMarketplaceHygiene();
    const nudged = db.prepare('SELECT last_reminded_at FROM marketplace_transactions WHERE id = ?').get(p1[0].id) as any;
    assert(nudged.last_reminded_at == null, 'the hygiene nudges nobody to release a period running by itself');
    const repriced = await post(rob, '/api/marketplace/posts/update', { id: storage.id, postId: storage.id, authorPublicKey: rob.pk, credits: 60 });
    assert(repriced.status === 200 && near((db.prepare('SELECT credits FROM posts WHERE id = ?').get(storage.id) as any).credits, 60),
        `the author can change the price while a period is held (${show(repriced)})`);
    let payerHoliday = '';
    try { setHolidayMode(marty.pk, true); } catch (e: any) { payerHoliday = e?.message ?? ''; }
    assert(payerHoliday === 'Stop your standing deal for Vehicle Storage first.', `the payer is kept from holiday mode, told why ("${payerHoliday}")`);
    let payeeHoliday = 'ok';
    try { setHolidayMode(rob.pk, true); } catch (e: any) { payeeHoliday = e?.message ?? 'refused'; }
    assert(payeeHoliday === 'ok', `the payee may go on holiday while it runs (${payeeHoliday})`);

    // ── 3. The period's end: settled once, the next held once ────────────────────────────────────────────────────────
    console.log('── 3. Settle once, hold once ──');
    const end1 = Date.parse(periodEnd(a1.startsAt, 'month', 1));
    const before3 = tick(end1 - 1);
    assert(before3.settled === 0 && standingRow(a1.id).phase === 'held', 'not a millisecond before the end: nothing moves');
    const robBefore = bal(rob.pk);
    const commonsBefore = getCommonsBalanceExact();
    const t3 = tick(end1 + 60_000);
    const sdAfter = standingRow(a1.id);
    const rows3 = periodRows(a1.id);
    assert(t3.settled === 1 && t3.held === 1, `one tick settles period 1 and holds period 2 (${JSON.stringify(t3)})`);
    assert(nearPaid(bal(rob.pk) - robBefore, 50) && Math.abs(getCommonsBalanceExact() - commonsBefore - 50 * TRANSACTION_FEE_RATE) < 0.006,
        `Rob is paid 50 less 1.5% (${r2(bal(rob.pk) - robBefore)}), the Commons the fee`);
    assert(rows3.length === 2 && rows3[0].status === 'completed' && rows3[1].status === 'pending' && rows3[1].period_no === 2 && near(rows3[1].credits, 50),
        `period 2 is held at the 50 the payer signed for, not the new price (${rows3.map(r => `${r.period_no}:${r.status}:${r.credits}`).join(' ')})`);
    assert(sdAfter.phase === 'held' && sdAfter.periods_done === 1 && sdAfter.current_tx_id === rows3[1].id && sdAfter.next_due_at === periodEnd(a1.startsAt, 'month', 2),
        `held again, due at the end of month 2 (${sdAfter.phase}, ${sdAfter.next_due_at})`);
    assert(near(heldFor(a1.id), 50), `exactly one period in trust (${heldFor(a1.id)})`);
    const t3b = tick(end1 + 120_000);
    assert(t3b.settled === 0 && t3b.held === 0 && periodRows(a1.id).length === 2, `a second tick moves nothing (${JSON.stringify(t3b)})`);
    assert((db.prepare('SELECT status FROM posts WHERE id = ?').get(storage.id) as any).status === 'pending', 'the listing stays taken between periods');
    assertConserved('after settling and holding');
    setHolidayMode(rob.pk, false);

    // ── 4. A crash in the release, and between the two steps ─────────────────────────────────────────────────────────
    console.log('── 4. Crashes ──');
    const end2 = Date.parse(periodEnd(a1.startsAt, 'month', 2));
    const crashRelease = (h: any) => ({ ...h, transfer: (...args: any[]) => { if (String(args[0]).startsWith('escrow_') && args[1] === rob.pk) throw new Error('power cut in the release'); return h.transfer(...args); } });
    const c1 = tick(end2 + 1000, crashRelease);
    assert(c1.settled === 0 && standingRow(a1.id).phase === 'held' && standingRow(a1.id).periods_done === 1 && periodRows(a1.id)[1].status === 'pending',
        `a crash in the release keeps nothing: still held, period 2 still pending (${JSON.stringify(c1)})`);
    assertConserved('after a crash in the release');
    const crashHold = (h: any) => ({ ...h, transfer: (...args: any[]) => { if (args[0] === marty.pk && String(args[1]).startsWith('escrow_')) throw new Error('power cut in the hold'); return h.transfer(...args); } });
    const robBefore4 = bal(rob.pk);
    const c2 = tick(end2 + 2000, crashHold);
    const mid = standingRow(a1.id);
    assert(c2.settled === 1 && c2.held === 0 && mid.phase === 'due' && mid.periods_done === 2 && periodRows(a1.id).length === 2 && nearPaid(bal(rob.pk) - robBefore4, 50),
        `a crash between the steps: period 2 settled once, period 3 not held, phase due (${JSON.stringify(c2)}, ${mid.phase})`);
    const c3 = tick(end2 + 3000);
    assert(c3.settled === 0 && c3.held === 1 && periodRows(a1.id).length === 3 && standingRow(a1.id).phase === 'held' && nearPaid(bal(rob.pk) - robBefore4, 50),
        `the next tick holds period 3 once and pays nothing twice (${JSON.stringify(c3)})`);
    let unique = false;
    try {
        db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, standing_id, period_no) VALUES (?, ?, ?, ?, 50, 'pending', ?, 3)`)
            .run(crypto.randomUUID(), storage.id, marty.pk, rob.pk, a1.id);
    } catch (e: any) { unique = /UNIQUE/.test(String(e?.message)); }
    assert(unique, 'the UNIQUE (standing_id, period_no) index refuses a second row for a period');
    assertConserved('after the crashes');

    // ── 5. Short: warned, told, tried again, covered; and ended after 7 days ─────────────────────────────────────────
    console.log('── 5. Short ──');
    const end3 = Date.parse(periodEnd(a1.startsAt, 'month', 3));
    // Short, the way a member is: their admins froze their credit line (the manager's Freeze), and their own Beans are
    // fewer than a period.
    const drain = (who: Id, keep: number) => {
        const out = r2(bal(who.pk) - keep);
        if (out > 0) assert(!!transfer(who.pk, ana.pk, out, 'sent away for the test', 'direct', true), `${who.name} sends ${out} away`);
        adminSetCreditFrozen(who.pk, true);
        return out;
    };
    const drained = drain(marty, 20);
    tick(end3 - 2 * DAY);
    assert(keptKinds(marty.pk, a1.id).includes('standing_short_ahead') && !keptKinds(rob.pk, a1.id).includes('standing_short_ahead'),
        'three days before a month is due, a payer who will be short is told; the payee is not');
    tick(end3 - 2 * DAY + 60_000);
    assert(keptKinds(marty.pk, a1.id).filter(k => k === 'standing_short_ahead').length === 1, 'told once a period');
    const s1 = tick(end3 + 1000);
    const shortRow = standingRow(a1.id);
    assert(s1.settled === 1 && s1.short === 1 && shortRow.phase === 'short' && !!shortRow.short_since && periodRows(a1.id).length === 3,
        `period 3 is settled, period 4 can't be held: short (${JSON.stringify(s1)}, ${shortRow.phase})`);
    assert(keptKinds(marty.pk, a1.id).includes('standing_short') && keptKinds(rob.pk, a1.id).includes('standing_short'), 'both are told at the due time');
    assert(tick(end3 + 30 * 60_000).held === 0, 'not tried again before the hour');
    adminSetCreditFrozen(marty.pk, false);
    transfer(ana.pk, marty.pk, drained, 'back for the test', 'direct', true);
    const s2 = tick(end3 + 61 * 60_000);
    const covered = standingRow(a1.id);
    assert(s2.held === 1 && covered.phase === 'held' && covered.short_since === null && covered.next_due_at === periodEnd(a1.startsAt, 'month', 4),
        `covered in the week: held, with the original dates (${covered.next_due_at})`);
    assert(keptKinds(marty.pk, a1.id).includes('standing_covered') && keptKinds(rob.pk, a1.id).includes('standing_covered'), 'both are told it is covered again');
    assertConserved('after short and covered');

    // A second one that stays short ends after the week, with nothing owed.
    const kai = makeMember('Kai', 30);
    const garden = createPost('offer', 'services', 'Garden Plot', 'A raised bed', 25, 'weekly', rob.pk, undefined, undefined, undefined, true) as any;
    const a5 = authorise(kai, { postId: garden.id, payee: rob.pk, beans: 25, unit: 'week', max: null });
    const acc5 = await post(kai, '/api/marketplace/posts/accept', { postId: garden.id, buyerPublicKey: kai.pk, standing: a5.standing });
    assert(acc5.status === 200, `a weekly standing deal starts (${show(acc5)})`);
    drain(kai, 5);
    const wEnd1 = Date.parse(periodEnd(a5.startsAt, 'week', 1));
    tick(wEnd1 + 1000);
    assert(standingRow(a5.id).phase === 'short', 'the weekly one is short');
    tick(wEnd1 + 3 * DAY + 2 * 60 * 60_000);
    assert(keptKinds(kai.pk, a5.id).includes('standing_still_short'), 'on day 3 of the week the payer is reminded');
    const shortSince = Date.parse(standingRow(a5.id).short_since);
    tick(shortSince + 7 * DAY - 60_000);
    assert(standingRow(a5.id).phase === 'short', 'still trying a minute before the week is over');
    const kaiBefore = bal(kai.pk);
    tick(shortSince + 7 * DAY + 1000);
    const endedShort = standingRow(a5.id);
    assert(endedShort.phase === 'ended' && endedShort.ended_reason === 'short' && near(bal(kai.pk), kaiBefore) && periodRows(a5.id).length === 1,
        `after 7 days it ends: Beans ran short, nothing taken (${endedShort.phase}/${endedShort.ended_reason})`);
    assert(keptKinds(kai.pk, a5.id).includes('standing_ended') && keptKinds(rob.pk, a5.id).includes('standing_ended'), 'both are told it ended');

    // ── 6. Stop ──────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 6. Stop ──');
    const stranger = makeMember('Stranger', 10);
    const notYours = await post(stranger, `/api/marketplace/standing/${a1.id}/stop`, {});
    assert(notYours.status === 404, `a stranger can't stop it (${show(notYours)})`);
    const stopped = await post(marty, `/api/marketplace/standing/${a1.id}/stop`, {});
    assert(stopped.status === 200 && stopped.body?.standing?.stopped === true && standingRow(a1.id).phase === 'held',
        `the payer stops it: the month under way is still held (${show(stopped)})`);
    assert(keptKinds(rob.pk, a1.id).includes('standing_stopped'), 'the payee is told');
    const end4 = Date.parse(periodEnd(a1.startsAt, 'month', 4));
    const robBefore6 = bal(rob.pk);
    const t6 = tick(end4 + 1000);
    const afterStop = standingRow(a1.id);
    assert(t6.settled >= 1 && t6.ended >= 1 && afterStop.phase === 'ended' && afterStop.ended_reason === 'stopped' && nearPaid(bal(rob.pk) - robBefore6, 50) && periodRows(a1.id).length === 4,
        `at its end the period is paid and it ends; nothing more held (${JSON.stringify(t6)}, ${afterStop.ended_reason})`);
    assert((db.prepare('SELECT status FROM posts WHERE id = ?').get(storage.id) as any).status === 'active', 'the one-off listing is back on the board');
    assertConserved('after the stop');

    // The payee stops one that is short: it ends at once.
    const lou = makeMember('Lou', 30);
    const a6 = authorise(lou, { postId: garden.id, payee: rob.pk, beans: 25, unit: 'week', max: null });
    await post(lou, '/api/marketplace/posts/accept', { postId: garden.id, buyerPublicKey: lou.pk, standing: a6.standing });
    drain(lou, 5);
    tick(Date.parse(periodEnd(a6.startsAt, 'week', 1)) + 1000);
    assert(standingRow(a6.id).phase === 'short', 'short');
    const payeeStop = await post(rob, `/api/marketplace/standing/${a6.id}/stop`, {});
    assert(payeeStop.status === 200 && standingRow(a6.id).phase === 'ended' && standingRow(a6.id).ended_reason === 'stopped', `the payee may stop it at once while it's short (${show(payeeStop)})`);

    // ── 7. Hold back ─────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 7. Hold back ──');
    const mo = makeMember('Mo', 400);
    const lessons = createPost('offer', 'education', 'Guitar Lessons', 'Weekly lesson', 20, 'weekly', rob.pk, undefined, undefined, undefined, true) as any;
    const a7 = authorise(mo, { postId: lessons.id, payee: rob.pk, beans: 20, unit: 'week', max: null });
    await post(mo, '/api/marketplace/posts/accept', { postId: lessons.id, buyerPublicKey: mo.pk, standing: a7.standing });
    const payeeHolds = await post(rob, `/api/marketplace/standing/${a7.id}/hold-back`, {});
    assert(payeeHolds.status === 403 && payeeHolds.body?.code === 'standing_payer_only', `only the payer holds back (${show(payeeHolds)})`);
    const held = await post(mo, `/api/marketplace/standing/${a7.id}/hold-back`, {});
    assert(held.status === 200 && standingRow(a7.id).phase === 'held_back' && keptKinds(rob.pk, a7.id).includes('standing_held_back'), `the payer holds this week back; the payee is told (${show(held)})`);
    const wk1 = Date.parse(periodEnd(a7.startsAt, 'week', 1));
    const t7 = tick(wk1 + 1000);
    assert(t7.settled === 0 && periodRows(a7.id)[0].status === 'pending', 'past its end, a period held back is not released by the node');
    const rel = await post(mo, '/api/marketplace/transactions/complete', { transactionId: periodRows(a7.id)[0].id, confirmerPublicKey: mo.pk });
    const resumed = standingRow(a7.id);
    assert(rel.status === 200 && resumed.phase === 'due' && resumed.periods_done === 1 && resumed.next_due_at === periodEnd(a7.startsAt, 'week', 1),
        `the payer's Release settles it and the schedule resumes, dates unchanged (${show(rel)}, ${resumed.phase})`);
    const t7b = tick(wk1 + 2000);
    assert(t7b.held === 1 && standingRow(a7.id).phase === 'held' && periodRows(a7.id).length === 2, 'the next week is held at once (its date has come)');
    await post(mo, `/api/marketplace/standing/${a7.id}/hold-back`, {});
    const moBefore = bal(mo.pk);
    const can = await post(mo, '/api/marketplace/transactions/cancel', { transactionId: periodRows(a7.id)[1].id, cancellerPublicKey: mo.pk });
    assert(can.status === 200 && standingRow(a7.id).phase === 'ended' && standingRow(a7.id).ended_reason === 'cancelled' && near(bal(mo.pk) - moBefore, 20),
        `a period held back and cancelled is refunded and the standing deal ends (${show(can)})`);
    assertConserved('after hold back');

    // ── 8. K periods, and Extend ────────────────────────────────────────────────────────────────────────────────────
    console.log('── 8. K periods ──');
    const ivy = makeMember('Ivy', 400);
    const a8 = authorise(ivy, { postId: lessons.id, payee: rob.pk, beans: 20, unit: 'week', max: 2 });
    const acc8 = await post(ivy, '/api/marketplace/posts/accept', { postId: lessons.id, buyerPublicKey: ivy.pk, standing: a8.standing });
    assert(acc8.status === 200 && standingRow(a8.id).max_periods === 2, `for 2 weeks (${show(acc8)})`);
    tick(Date.parse(periodEnd(a8.startsAt, 'week', 1)) + 1000);
    assert(standingRow(a8.id).phase === 'held' && periodRows(a8.id).length === 2 && keptKinds(ivy.pk, a8.id).includes('standing_last_period') && keptKinds(rob.pk, a8.id).includes('standing_last_period'),
        'the second (last) week is held, and both are told it is the last');
    const forged = authorise(ivy, { postId: lessons.id, payee: rob.pk, beans: 20, unit: 'week', max: 3, id: a8.id, startsAt: a8.startsAt });
    const extendedByOther = await post(rob, `/api/marketplace/standing/${a8.id}/extend`, { standing: forged.standing });
    assert(extendedByOther.status === 403, `only the payer extends (${show(extendedByOther)})`);
    const wrongPrice = authorise(ivy, { postId: lessons.id, payee: rob.pk, beans: 21, unit: 'week', max: 3, id: a8.id, startsAt: a8.startsAt });
    const extendedPrice = await post(ivy, `/api/marketplace/standing/${a8.id}/extend`, { standing: wrongPrice.standing });
    assert(extendedPrice.status === 400 && extendedPrice.body?.code === 'standing_auth', `an extension can't change the price (${show(extendedPrice)})`);
    const extended = await post(ivy, `/api/marketplace/standing/${a8.id}/extend`, { standing: forged.standing });
    assert(extended.status === 200 && standingRow(a8.id).max_periods === 3 && standingRow(a8.id).auth_payload === forged.payload, `the payer extends it to 3 weeks with a new signed text (${show(extended)})`);
    tick(Date.parse(periodEnd(a8.startsAt, 'week', 2)) + 1000);
    tick(Date.parse(periodEnd(a8.startsAt, 'week', 3)) + 1000);
    const k = standingRow(a8.id);
    assert(k.phase === 'ended' && k.ended_reason === 'count_reached' && periodRows(a8.id).length === 3 && periodRows(a8.id).every(r => r.status === 'completed'),
        `after the third week it ends: the count reached, three periods paid (${k.phase}/${k.ended_reason}, ${periodRows(a8.id).length})`);
    assertConserved('after K periods');

    // ── 9. Forged or mismatched authorisations; a keeper as payee ────────────────────────────────────────────────────
    console.log('── 9. Forged authorisations ──');
    const zed = makeMember('Zed', 400);
    const tool = createPost('offer', 'services', 'Tool Shed Access', 'Monthly', 30, 'monthly', rob.pk, undefined, undefined, undefined, true) as any;
    const good = () => authorise(zed, { postId: tool.id, payee: rob.pk, beans: 30, unit: 'month', max: null });
    const tryAccept = (standing: unknown) => post(zed, '/api/marketplace/posts/accept', { postId: tool.id, buyerPublicKey: zed.pk, standing });
    const zedBefore = bal(zed.pk);
    const otherKey = authorise(stranger, { postId: tool.id, payee: rob.pk, beans: 30, unit: 'month', max: null });
    const cases: Array<[string, unknown]> = [
        ['signed by another key', otherKey.standing],
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
        'none of them held anything or wrote a deal');
    const hourly = createPost('offer', 'services', 'Lawn Mowing', 'Per hour', 15, 'hourly', rob.pk, undefined, undefined, undefined, true) as any;
    const hr = await post(zed, '/api/marketplace/posts/accept', { postId: hourly.id, buyerPublicKey: zed.pk, standing: authorise(zed, { postId: hourly.id, payee: rob.pk, beans: 15, unit: 'week', max: null }).standing });
    assert(hr.status === 400 && hr.body?.code === 'standing_auth', `an hourly listing makes no standing deal (${show(hr)})`);

    // An enterprise paying a keeper of its own: refused (§1.5).
    const ent = makeMember('Eggs Co', 400, { treasury: true });
    const keeper = makeMember('Kim', 50);
    const keeper2 = makeMember('Kit', 50);
    db.prepare('INSERT INTO treasury_operators (treasury_pubkey, member_pubkey) VALUES (?, ?)').run(ent.pk, keeper.pk);
    db.prepare('INSERT INTO treasury_operators (treasury_pubkey, member_pubkey) VALUES (?, ?)').run(ent.pk, keeper2.pk);
    db.prepare('UPDATE members SET can_operate = 1 WHERE public_key IN (?, ?)').run(keeper.pk, keeper2.pk);
    const kimsOffer = createPost('offer', 'services', 'Bookkeeping', 'Monthly books', 40, 'monthly', keeper.pk, undefined, undefined, undefined, true) as any;
    // A keeper acts as the enterprise through the enterprise's own doors; the engine's own refusal is what holds (S1).
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
    assert(!!entOk.tx && standingRow(entOk.id)?.auth_signer === keeper2.pk && standingRow(entOk.id)?.payer_pubkey === ent.pk,
        `a keeper signs an enterprise's standing deal with another member (${entOk.err?.message ?? 'ok'})`);

    // ── 10. Late: under one period, and more than one ────────────────────────────────────────────────────────────────
    console.log('── 10. Late ──');
    const sam = makeMember('Sam', 400);
    const a10 = authorise(sam, { postId: tool.id, payee: rob.pk, beans: 30, unit: 'month', max: null });
    await post(sam, '/api/marketplace/posts/accept', { postId: tool.id, buyerPublicKey: sam.pk, standing: a10.standing });
    const lateOk = tick(Date.parse(periodEnd(a10.startsAt, 'month', 1)) + 10 * DAY);
    assert(lateOk.settled >= 1 && standingRow(a10.id).periods_done === 1 && standingRow(a10.id).phase === 'held', `ten days late (under a period) settles normally (${JSON.stringify(lateOk)})`);
    const tom = makeMember('Tom', 400);
    const a10b = authorise(tom, { postId: tool.id, payee: rob.pk, beans: 30, unit: 'month', max: null });
    await post(tom, '/api/marketplace/posts/accept', { postId: tool.id, buyerPublicKey: tom.pk, standing: a10b.standing });
    const robBefore10 = bal(rob.pk);
    tick(Date.parse(periodEnd(a10b.startsAt, 'month', 2)) + 1000);
    const late = standingRow(a10b.id);
    assert(late.phase === 'held_back' && late.held_back_reason === 'node_held' && periodRows(a10b.id).length === 1 && periodRows(a10b.id)[0].status === 'pending',
        `more than a whole period late, the node pays nothing: held back for a person (${late.phase}/${late.held_back_reason})`);
    assert(keptKinds(tom.pk, a10b.id).includes('standing_held_back') && keptKinds(rob.pk, a10b.id).includes('standing_held_back'), 'both are told');
    assert(near(bal(`escrow_${periodRows(a10b.id)[0].id}`), 30) && robBefore10 <= bal(rob.pk), "Tom's 30 Beans stay held");

    // ── 11. A standby ticks nothing; Beans off moves nothing ─────────────────────────────────────────────────────────
    console.log('── 11. Standby and Beans off ──');
    const sdBefore = JSON.stringify(standingRow(a10.id));
    setNodeRole('backup');
    const onBackup = tick(Date.parse(periodEnd(a10.startsAt, 'month', 2)) + 1000);
    setNodeRole('primary');
    assert(onBackup.settled === 0 && onBackup.held === 0 && JSON.stringify(standingRow(a10.id)) === sdBefore, `a standby ticks nothing (${JSON.stringify(onBackup)})`);
    const standbyStop = await (async () => { setNodeRole('backup'); try { return await post(sam, `/api/marketplace/standing/${a10.id}/stop`, {}); } finally { setNodeRole('primary'); } })();
    assert(standbyStop.status >= 400 && standingRow(a10.id).stopped_at === null, `a standby refuses a Stop (${show(standbyStop)})`);
    setSwitchOverride('beans', false);
    const beansOff = tick(Date.parse(periodEnd(a10.startsAt, 'month', 2)) + 1000);
    setSwitchOverride('beans', true);
    assert(beansOff.settled === 0 && JSON.stringify(standingRow(a10.id)) === sdBefore, `with Beans off nothing moves (${JSON.stringify(beansOff)})`);

    // ── 12. A Need ──────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 12. A Need ──');
    const nan = makeMember('Nan', 400);
    const helper = makeMember('Hal', 0);
    const care = createPost('need', 'services', 'Weekly Garden Help', 'Two hours each week', 35, 'weekly', nan.pk, undefined, undefined, undefined, true) as any;
    const asked = await post(helper, '/api/marketplace/posts/request', { postId: care.id, buyerPublicKey: helper.pk, hours: 1 });
    assert(asked.status === 200, `the helper offers to help (${show(asked)})`);
    const a12 = authorise(nan, { postId: care.id, payee: helper.pk, beans: 35, unit: 'week', max: null });
    const approved = await post(nan, '/api/marketplace/transactions/approve', { transactionId: asked.body?.transaction?.id, authorPublicKey: nan.pk, standing: a12.standing });
    assert(approved.status === 200 && approved.body?.transaction?.standingId === a12.id && near(bal(`escrow_${asked.body?.transaction?.id}`), 35),
        `the author approves with a signed authorisation: a standing deal, the first week held (${show(approved)})`);
    const halBefore = bal(helper.pk);
    tick(Date.parse(periodEnd(a12.startsAt, 'week', 1)) + 1000);
    assert(nearPaid(bal(helper.pk) - halBefore, 35) && periodRows(a12.id).length === 2 && standingRow(a12.id).phase === 'held',
        `at the week's end the helper is paid and the next week held (${r2(bal(helper.pk) - halBefore)})`);
    assertConserved('after the Need');

    // ── 13. The author removes the listing ─────────────────────────────────────────────────────────────────────────
    console.log('── 13. The listing removed ──');
    const removed = await post(rob, '/api/marketplace/posts/remove', { id: tool.id, authorPublicKey: rob.pk });
    assert(removed.status === 200, `the author removes a listing with standing deals running (${show(removed)})`);
    assert(standingRow(a10.id).stopped_at !== null && standingRow(a10.id).phase === 'held', 'each stops after its current period');
    const robBefore13 = bal(rob.pk);
    // Sam's standing deal is in its third month by now (the late ticks above reached it too).
    const t13 = tick(Date.parse(periodEnd(a10.startsAt, 'month', standingRow(a10.id).periods_done + 1)) + 1000);
    assert(standingRow(a10.id).phase === 'ended' && standingRow(a10.id).ended_reason === 'stopped' && bal(rob.pk) > robBefore13,
        `the current period is still paid, then it ends (${JSON.stringify(t13)}, ${JSON.stringify(standingRow(a10.id))?.slice(0, 400)}, rows ${JSON.stringify(periodRows(a10.id).map(r => [r.period_no, r.status]))})`);
    assertConserved('after the removal');

    // ── 14. The transactions read and its ETag ───────────────────────────────────────────────────────────────────────
    console.log('── 14. The transactions read ──');
    const pia = makeMember('Pia', 300);
    const a14 = authorise(pia, { postId: lessons.id, payee: rob.pk, beans: 20, unit: 'week', max: 6 });
    await post(pia, '/api/marketplace/posts/accept', { postId: lessons.id, buyerPublicKey: pia.pk, standing: a14.standing });
    tick(Date.parse(periodEnd(a14.startsAt, 'week', 1)) + 1000);
    const read1 = await call(pia, 'GET', `/api/marketplace/transactions?publicKey=${pia.pk}`);
    const cur = (read1.body as any[])?.find(t => t.standingId === a14.id && t.standingPhase);
    assert(read1.status === 200 && cur?.standingPhase === 'held' && cur?.standingUnit === 'week' && near(cur?.standingBeans, 20) && cur?.periodNo === 2
        && cur?.standingMaxPeriods === 6 && cur?.standingNextDueAt === periodEnd(a14.startsAt, 'week', 2) && cur?.standingStopped === false,
        `the read carries the standing fields on the current period (${JSON.stringify(cur)?.slice(0, 260)})`);
    const older = (read1.body as any[])?.find(t => t.standingId === a14.id && t.periodNo === 1);
    assert(!!older && older.status === 'completed' && older.standingPhase === undefined, 'an older period carries none');
    await post(pia, `/api/marketplace/standing/${a14.id}/hold-back`, {});
    const read2 = await call(pia, 'GET', `/api/marketplace/transactions?publicKey=${pia.pk}`);
    assert(!!read1.etag && !!read2.etag && read1.etag !== read2.etag && (read2.body as any[]).some(t => t.standingId === a14.id && t.standingPhase === 'held_back'),
        `the ETag changes when the phase does (${read1.etag} → ${read2.etag})`);

    // ── 15. A re-key of either side: the standing deal carries on under the new key ─────────────────────────────────
    console.log('── 15. Re-key ──');
    const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
    const quinn = makeMember('Quinn', 300);
    const rae = makeMember('Rae', 0);
    const baking = createPost('offer', 'food', 'Weekly Bread', 'A loaf a week', 15, 'weekly', rae.pk, undefined, undefined, undefined, true) as any;
    const a15 = authorise(quinn, { postId: baking.id, payee: rae.pk, beans: 15, unit: 'week', max: null });
    await post(quinn, '/api/marketplace/posts/accept', { postId: baking.id, buyerPublicKey: quinn.pk, standing: a15.standing });
    const raeNew = crypto.generateKeyPairSync('ed25519');
    const raeNewPk = (raeNew.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    completeRekey(rae.pk, raeNewPk, issueRekeyCode(rae.pk, 'owner:password').code, 'owner:password');
    assert(standingRow(a15.id).payee_pubkey === raeNewPk && periodRows(a15.id)[0].seller_pubkey === raeNewPk, 'the payee re-keys: the standing row and its period move to the new key');
    tick(Date.parse(periodEnd(a15.startsAt, 'week', 1)) + 1000);
    assert(nearPaid(bal(raeNewPk), 15) && standingRow(a15.id).phase === 'held' && periodRows(a15.id).length === 2 && periodRows(a15.id)[1].seller_pubkey === raeNewPk,
        `the week is paid to the new key and the next held for it: the signed text's payee is read through the re-key (${bal(raeNewPk)})`);
    const quinnNew = crypto.generateKeyPairSync('ed25519');
    const quinnNewPk = (quinnNew.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    completeRekey(quinn.pk, quinnNewPk, issueRekeyCode(quinn.pk, 'owner:password').code, 'owner:password');
    const quinnBefore = bal(quinnNewPk);
    tick(Date.parse(periodEnd(a15.startsAt, 'week', 2)) + 1000);
    assert(standingRow(a15.id).payer_pubkey === quinnNewPk && periodRows(a15.id).length === 3 && periodRows(a15.id)[2].buyer_pubkey === quinnNewPk && near(quinnBefore - bal(quinnNewPk), 15),
        'the payer re-keys: the next week is held from the new key');
    assertConserved('after the re-keys');

    // ── 16. An enterprise paid by the tick: its earned surplus counts the sale, with no signer ──────────────────────
    console.log('── 16. An enterprise payee ──');
    const uma = makeMember('Uma', 300);
    const eggs = createPost('offer', 'food', 'Egg Box', 'A dozen a month', 20, 'monthly', ent.pk, undefined, undefined, undefined, true) as any;
    const a16 = authorise(uma, { postId: eggs.id, payee: ent.pk, beans: 20, unit: 'month', max: null });
    const acc16 = await post(uma, '/api/marketplace/posts/accept', { postId: eggs.id, buyerPublicKey: uma.pk, standing: a16.standing });
    assert(acc16.status === 200, `a member takes up an enterprise's Offer as a standing deal (${show(acc16)})`);
    const surplusOf = () => Number((db.prepare('SELECT earned_surplus FROM members WHERE public_key = ?').get(ent.pk) as any)?.earned_surplus) || 0;
    const surplusBefore = surplusOf();
    const t16 = tick(Date.parse(periodEnd(a16.startsAt, 'month', 1)) + 1000);
    assert(t16.settled >= 1 && near(surplusOf() - surplusBefore, 20) && standingRow(a16.id).phase === 'held',
        `the tick's release counts toward the enterprise's earned surplus, as a Release does (${surplusOf() - surplusBefore})`);
    assertConserved('after the enterprise payee');

    assertConserved('at the end');
    console.log(`\n${passed}/${run} assertions passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error('Unhandled failure:', e);
    process.exit(1);
});

// Bills: a request to pay, never a payment (scratch/fable-design/DESIGN-getting-paid-fable.md §4, §5, slice B1; Marty took
// every recommendation, 11 Nov 2026). TIER A: paying one moves Beans.
//
// THE MODEL. A member (or a keeper, for an enterprise they keep) sends one member a bill: what it is for, how many Beans,
// perhaps the sender's own listing or the standing deal between the two as what it is about. One row of `bills`
// (schema.sql 5c), keyed by the sender's app's id, so a retry of the send is the same bill. It never pays itself: its payer
// pays it, declines it (quietly: the sender reads "not paid" until it expires) or leaves it; it waits 30 days from reaching
// them and then expires (expireBills, hourly, a state flip). The sender may withdraw it until it is paid.
//
// PAYING. payBill runs every guard first, outside the transaction: the bill waiting on this payer, the payer's own standing
// (escrow.ts assertBuyerMayTrade), the sender's account open, the sender's bills not on hold, the retry id
// (money-requests.ts), and the money line (@beanpool/core billMoneyLine, the same function both apps draw Pay from). Then
// ONE conservingTransaction: the compare-and-swap sent → paid, which must change one row, and the one transfer() with method
// 'escrow', not fee-exempt: the combination that takes the 1.5% to the Commons and lets the payer's credit line pay, which
// transfer bounds by the usable floor itself.
//
// FIRST BILLS ARE PAID WITH BEANS HELD. transfer would let the credit line pay any bill on this path. The rule that a first
// bill (from someone the payer never finished a deal with, and has no standing deal running with: dealtWith) takes Beans
// held only is THIS engine's guard: billMoneyLine refuses it before the transaction, read from the balance in the same
// synchronous step as the payment (nothing is awaited between them), and inside the transaction the payer's balance is read
// again after the transfer and the whole payment is undone if a first bill took it below zero.
//
// NO DEAL, NO CREDIT. A bill writes no deal row and no review, so nothing here feeds the trust curve (trust.ts reads deal
// rows only): the board stays the place where credit is earned in the open.
//
// WHO SEES WHAT. The sender never reads why a bill isn't paid: a declined bill reads `sent` to them until it expires, and
// every limit counts declined bills with waiting ones. A bill to someone who has blocked its sender (or the keeper who sent
// it) is taken and never shown to them, as a request from a blocked member waits (escrow.ts). A stranger's bill (the
// message-request rule, dm-requests.ts requestNeeded) makes no push and no badge: its line is listed, calm.
//
// HELD BY REPORTS. A payer may report a bill (POST /api/reports with targetBillId): it is declined, and the report goes to the
// owners' queue naming the sender, what for and how much. Three different members' open reports on one sender's bills within
// 7 days hold that sender's bills: no new one goes, and none of theirs is listed or paid, until an owner or admin handles the
// reports in the queue (dismissed or actioned, each is no longer open). The owners and admins are told once, when it holds.
//
// WHERE. A main server with Beans on and the `bills` switch on (config/node-profile.ts): Beans off answers 403
// profile_no_beans, bills off 404 feature_off. A standby refuses every write (routes/standby-ledger-gate.ts) and moves nothing.

import {
    BILL_RULES, billLines, billMoneyLine, billNeedsLine, billWhatForOf, formatHundredths, isBillAmount, type BillNeedsLine, type BillState,
    type BillView, type PushNoticeKind,
} from '@beanpool/core';
import { isNodeMember } from '@beanpool/engine';
import { db } from '../db/db.js';
import { assertBeansOn, assertFeatureOn, getProfileSwitches } from '../config/node-profile.js';
import { assertLedgerWritable, assertPlainTablesWritable, standbyWritesNothing } from '../config/node-role.js';
import { assertNotMuted } from './auto-moderation.js';
import { keepNotice, keptNoticeDetails } from './kept-notices.js';
import { hasBlocked } from './member-blocks.js';
import { requestNeeded } from './dm-requests.js';
import { assertBuyerMayTrade, type EscrowCallbacks } from './escrow.js';
import { moneyRequestOf, priorAnswer, recordAnswer } from './money-requests.js';

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
/** The id an app makes for a bill (a UUID): letters, digits, - and _, 8 to 128 of them, as a payment's request id. */
const BILL_ID = /^[A-Za-z0-9_-]{8,128}$/;
const PAY_ROUTE = 'POST /api/bills/:id/pay';

/** What the bills engine needs of the node: escrow's own callbacks. */
export type BillHooks = Pick<EscrowCallbacks, 'broadcast' | 'transfer' | 'getBalance' | 'conservingTransaction' | 'canOperateTreasury' | 'dispatchPushNotification' | 'injectSystemMessage'>;

export interface BillRow {
    id: string;
    biller_pubkey: string;
    sent_by: string;
    payer_pubkey: string | null;
    invite_code: string | null;
    amount_c: number;
    what_for: string;
    post_id: string | null;
    standing_id: string | null;
    state: BillState;
    created_at: string;
    delivered_at: string | null;
    expires_at: string | null;
    answered_at: string | null;
    ledger_tx_id: string | null;
    report_id: string | null;
}

/** A refusal: its status and code with the words a member reads; a limit's carries when it lets up. */
export class BillRefusal extends Error {
    constructor(readonly status: number, readonly code: string, message: string, readonly resetsAt?: string) {
        super(message);
        this.name = 'BillRefusal';
    }
}
const refuse = (status: number, code: string, message: string, resetsAt?: string) => new BillRefusal(status, code, message, resetsAt);

/** Bills go only on a node whose Beans are on (403 profile_no_beans) and whose `bills` switch is on (404 feature_off). */
function assertBillsHere(): void {
    assertBeansOn();
    assertFeatureOn('bills');
}

const readBill = (id: string): BillRow | undefined => db.prepare('SELECT * FROM bills WHERE id = ?').get(id) as BillRow | undefined;

interface MemberRow { status: string | null; is_treasury: number | null; is_visitor: number | null; paused: number | null; callsign: string | null }
const memberRow = (key: string): MemberRow | undefined =>
    db.prepare('SELECT status, is_treasury, is_visitor, paused, callsign FROM members WHERE public_key = ?').get(key) as MemberRow | undefined;
const nameOf = (key: string): string => (memberRow(key)?.callsign || '').trim() || 'A member';
/** A member of this node, active: not a visitor's row, not paused, removed or wound up, for a key no re-key replaced. */
const activeHere = (key: string): boolean => isNodeMember(db, key) && memberRow(key)?.status === 'active';
const isEnterprise = (key: string): boolean => memberRow(key)?.is_treasury === 1;

/**
 * Whether `payer` may pay `biller`'s bill from their credit line (design §4.1): the two have finished a deal on a listing,
 * either way round, or have a standing deal running. Else a bill between them is paid with Beans held only.
 */
export function dealtWith(payer: string, biller: string): boolean {
    return !!db.prepare(`SELECT 1 FROM marketplace_transactions WHERE status = 'completed'
                           AND ((buyer_pubkey = @a AND seller_pubkey = @b) OR (buyer_pubkey = @b AND seller_pubkey = @a)) LIMIT 1`).get({ a: payer, b: biller })
        || !!db.prepare(`SELECT 1 FROM standing_deals WHERE phase != 'ended'
                           AND ((payer_pubkey = @a AND payee_pubkey = @b) OR (payer_pubkey = @b AND payee_pubkey = @a)) LIMIT 1`).get({ a: payer, b: biller });
}

/** The payer knows the sender (the message-request rule: added, written to or traded with): a push, an amber row. */
const knownTo = (payer: string, bill: Pick<BillRow, 'biller_pubkey'>): boolean => !requestNeeded(bill.biller_pubkey, payer);

/** The payer has blocked the sender, or the keeper who sent it: the bill is never shown to them. */
const hiddenFrom = (payer: string, bill: Pick<BillRow, 'biller_pubkey' | 'sent_by'>): boolean =>
    hasBlocked(payer, bill.biller_pubkey) || (bill.sent_by !== bill.biller_pubkey && hasBlocked(payer, bill.sent_by));

// ── Held by reports ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Whether `biller`'s bills are held now: within some 7 days, `reportersToHold` different members (each still active here)
 * filed reports on their bills that are still open in the owners' queue. Handling those reports (dismissed or actioned)
 * lifts it. Returns the reporters in the window that holds it, or 0.
 */
export function billsHeldBy(biller: string): number {
    const rows = db.prepare(`SELECT ar.reporter_pubkey AS reporter, ar.created_at AS at FROM bills b
                               JOIN abuse_reports ar ON ar.id = b.report_id
                               JOIN members m ON m.public_key = ar.reporter_pubkey AND m.status = 'active'
                              WHERE b.biller_pubkey = ? AND b.report_id IS NOT NULL AND (ar.status IS NULL OR ar.status = 'pending')`)
        .all(biller) as { reporter: string; at: string }[];
    const times = rows.map((r) => ({ reporter: r.reporter, ms: Date.parse(r.at) })).filter((r) => Number.isFinite(r.ms)).sort((a, b) => a.ms - b.ms);
    const windowMs = BILL_RULES.reportWindowDays * DAY_MS;
    let most = 0;
    for (let i = 0; i < times.length; i++) {
        const within = new Set(times.filter((r) => r.ms >= times[i].ms && r.ms <= times[i].ms + windowMs).map((r) => r.reporter));
        most = Math.max(most, within.size);
    }
    return most >= BILL_RULES.reportersToHold ? most : 0;
}

// ── Notices ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface BillNotice { to: string; title: string; body: string; id: string | null; data: Record<string, unknown> }

/** Keep a notice for `to` (in the caller's transaction where there is one); tell() sends it after the commit. */
function keep(to: string, body: string, data: Record<string, unknown>): BillNotice {
    const title = billLines.noticeTitle();
    return { to, title, body, data, id: keepNotice(to, title, body, data) };
}

/** After the commit: each notice live to its member's own sockets with its kept copy's id, and a push naming that copy. */
function tell(hooks: Pick<BillHooks, 'broadcast' | 'dispatchPushNotification'>, notices: BillNotice[], kind: PushNoticeKind): void {
    for (const n of notices) {
        try {
            hooks.broadcast({ type: 'system_announcement', title: n.title, body: n.body, severity: 'info', ...n.data, ...(n.id ? { noticeId: n.id } : {}) }, [n.to]);
        } catch (e: any) {
            console.warn('[Bills] A live notice failed:', e?.message || e);
        }
        try {
            const screen = typeof n.data.postId === 'string' ? { screen: 'post', postId: n.data.postId } : { screen: n.data.screen ?? 'bill', billId: n.data.bill };
            hooks.dispatchPushNotification([n.to], 'SYSTEM', n.title, n.body, screen, 'escrow', kind, false, keptNoticeDetails([n]));
        } catch (e: any) {
            console.warn('[Bills] A push failed:', e?.message || e);
        }
    }
}

/** The direct chat the two already share, if any: where a bill's line goes ("where they already share a chat"). */
const shareADirectChat = (a: string, b: string): boolean => !!db.prepare(`SELECT 1 FROM conversations c
        JOIN conversation_participants p1 ON p1.conversation_id = c.id AND p1.public_key = ?
        JOIN conversation_participants p2 ON p2.conversation_id = c.id AND p2.public_key = ?
       WHERE c.type = 'dm' AND c.post_id IS NULL LIMIT 1`).get(a, b);

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const titleOf = (postId: string | null): string | null =>
    postId ? ((db.prepare('SELECT title FROM posts WHERE id = ?').get(postId) as { title: string | null } | undefined)?.title ?? null) : null;

/** The state the sender reads: a declined bill is `sent` (not paid) until it expires. */
const senderState = (s: BillState): BillState => (s === 'declined' ? 'sent' : s);

/** A bill as one of its sides reads it (core BillView). The payer's read carries `known` and `creditOpen`. */
export function billViewFor(b: BillRow, role: 'to-pay' | 'sent'): BillView {
    const payer = b.payer_pubkey ?? '';
    const base: BillView = {
        id: b.id, role, billerPublicKey: b.biller_pubkey, billerName: nameOf(b.biller_pubkey), payerPublicKey: payer, payerName: payer ? nameOf(payer) : '',
        amount_c: b.amount_c, whatFor: b.what_for, postId: b.post_id, postTitle: titleOf(b.post_id), standingId: b.standing_id,
        state: role === 'sent' ? senderState(b.state) : b.state,
        sentAt: b.delivered_at ?? b.created_at, expiresAt: b.expires_at ?? '', paidAt: b.state === 'paid' ? b.answered_at : null,
    };
    return role === 'to-pay' && payer ? { ...base, known: knownTo(payer, b), creditOpen: dealtWith(payer, b.biller_pubkey) } : base;
}

/** The bills waiting on `payer` now, newest first: not expired, not from someone they blocked, not held by reports. */
function waitingFor(payer: string, now: number): BillRow[] {
    const rows = db.prepare(`SELECT * FROM bills WHERE payer_pubkey = ? AND state = 'sent' AND expires_at > ? ORDER BY created_at DESC LIMIT 200`)
        .all(payer, iso(now)) as BillRow[];
    const held = new Map<string, boolean>();
    const isHeld = (biller: string) => held.get(biller) ?? (held.set(biller, billsHeldBy(biller) > 0), held.get(biller)!);
    return rows.filter((b) => !hiddenFrom(payer, b) && !isHeld(b.biller_pubkey));
}

/**
 * GET /api/bills: the bills waiting on the signer (`toPay`), and the bills they sent (`sent`), newest first; with
 * `enterprise`, the bills that enterprise sent, when the signer keeps it.
 */
export function listBills(hooks: Pick<BillHooks, 'canOperateTreasury'>, signer: string, enterprise: unknown, now: number = Date.now()): { toPay: BillView[]; sent: BillView[] } {
    assertBillsHere();
    if (enterprise !== undefined && enterprise !== null && enterprise !== '') {
        const ent = String(enterprise);
        if (!isEnterprise(ent) || !hooks.canOperateTreasury(signer, ent)) throw refuse(403, 'bill_not_keeper', billLines.notYours());
        return { toPay: [], sent: sentBy(ent) };
    }
    return { toPay: waitingFor(signer, now).map((b) => billViewFor(b, 'to-pay')), sent: sentBy(signer) };
}
const sentBy = (biller: string): BillView[] =>
    (db.prepare('SELECT * FROM bills WHERE biller_pubkey = ? ORDER BY created_at DESC LIMIT 200').all(biller) as BillRow[]).map((b) => billViewFor(b, 'sent'));

/** The "Needs you" lines of the bills waiting on `payer` (the Home answer; core billNeedsLine). */
export function billNeedsLinesFor(payer: string, now: number = Date.now()): BillNeedsLine[] {
    if (!getProfileSwitches().bills) return [];
    return waitingFor(payer, now).map((b) => billNeedsLine(billViewFor(b, 'to-pay'))).filter((l): l is BillNeedsLine => l !== null);
}

// ── Sending ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What an app sends to POST /api/bills. */
export interface BillSend {
    id?: unknown;
    to?: unknown;
    amount_c?: unknown;
    whatFor?: unknown;
    postId?: unknown;
    standingId?: unknown;
    /** An enterprise the signer keeps, to send the bill for it. */
    enterprise?: unknown;
}

/** A date and time as a refusal writes when a limit lets up (UTC, as every kept notice). */
const whenWords = (ms: number) => `${new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`;

/** Throws the first limit `biller` is over for one more bill to `payer` (design §4.4), counted from the bills table. */
function assertUnderLimits(biller: string, payer: string, now: number): void {
    const times = BILL_RULES.enterpriseTimes;
    const enterprise = isEnterprise(biller);
    const day = db.prepare('SELECT payer_pubkey AS payer, created_at AS at FROM bills WHERE biller_pubkey = ? AND created_at > ? ORDER BY created_at')
        .all(biller, iso(now - DAY_MS)) as { payer: string | null; at: string }[];
    const sentLimit = BILL_RULES.sentPerDay * (enterprise ? times : 1);
    if (day.length >= sentLimit) {
        const at = Date.parse(day[day.length - sentLimit].at) + DAY_MS;
        throw refuse(429, 'bills_sent_day', billLines.limitSent(sentLimit, whenWords(at)), iso(at));
    }
    if (!dealtWith(payer, biller)) {
        // A bill on an invite (no payer yet) is to someone new.
        const toNew = day.filter((r) => !r.payer || !dealtWith(r.payer, biller));
        const newLimit = BILL_RULES.newPeoplePerDay * (enterprise ? times : 1);
        if (toNew.length >= newLimit) {
            const at = Date.parse(toNew[toNew.length - newLimit].at) + DAY_MS;
            throw refuse(429, 'bills_new_people_day', billLines.limitNewPeople(newLimit, whenWords(at)), iso(at));
        }
    }
    // Declined bills count as not paid, so the limit never tells the sender a bill was declined.
    const toOne = db.prepare(`SELECT created_at AS at FROM bills WHERE biller_pubkey = ? AND payer_pubkey = ? AND state IN ('sent', 'declined')
                               AND created_at > ? ORDER BY created_at`).all(biller, payer, iso(now - BILL_RULES.waitDays * DAY_MS)) as { at: string }[];
    if (toOne.length >= BILL_RULES.unpaidToOnePer30Days) {
        const at = Date.parse(toOne[toOne.length - BILL_RULES.unpaidToOnePer30Days].at) + BILL_RULES.waitDays * DAY_MS;
        throw refuse(429, 'bills_to_one', billLines.limitToOne(BILL_RULES.unpaidToOnePer30Days, nameOf(payer), whenWords(at)), iso(at));
    }
    const out = db.prepare(`SELECT expires_at AS at FROM bills WHERE biller_pubkey = ? AND state IN ('sent', 'declined')
                             AND (expires_at IS NULL OR expires_at > ?) ORDER BY expires_at`).all(biller, iso(now)) as { at: string | null }[];
    const outLimit = BILL_RULES.unpaidOut * (enterprise ? times : 1);
    if (out.length >= outLimit) {
        const first = out.find((r) => r.at)?.at;
        throw refuse(429, 'bills_out', billLines.limitOut(outLimit), first ?? undefined);
    }
}

/**
 * POST /api/bills: `signer` sends a bill, as themselves or for an enterprise they keep. Refused in words, nothing written,
 * for a bad id, amount or "what for"; a payer who isn't an active member here, is an enterprise, or is the sender; an "about"
 * that isn't the sender's own listing or the standing deal between the two; a sender whose bills are held; or a limit
 * (429, with resetsAt). The same id again with the same bill answers that bill and writes nothing; with another, 409.
 */
export function sendBill(hooks: BillHooks, signer: string, body: BillSend, now: number = Date.now()): BillView {
    assertBillsHere();
    assertPlainTablesWritable();
    const id = body.id;
    if (typeof id !== 'string' || !BILL_ID.test(id)) throw refuse(400, 'bill_id', billLines.idReused());
    const ent = body.enterprise === undefined || body.enterprise === null || body.enterprise === '' ? null : String(body.enterprise);
    const biller = ent ?? signer;
    if (!activeHere(signer)) throw refuse(403, 'bill_sender', billLines.notAMember());
    assertNotMuted(signer, now);
    if (ent) {
        const row = memberRow(ent);
        if (row?.is_treasury !== 1 || row.status !== 'active' || row.paused === 1 || !hooks.canOperateTreasury(signer, ent)) {
            throw refuse(403, 'bill_not_keeper', billLines.notYours());
        }
    }
    const amount = body.amount_c;
    if (!isBillAmount(amount)) throw refuse(400, 'bill_amount', billLines.badAmount());
    const whatFor = billWhatForOf(body.whatFor);
    if (!whatFor) throw refuse(400, 'bill_what_for', billLines.badWhatFor());
    const payer = typeof body.to === 'string' ? body.to : '';
    if (!payer || !activeHere(payer)) throw refuse(400, 'bill_payer', billLines.notAMember());
    if (payer === biller || payer === signer) throw refuse(400, 'bill_yourself', billLines.notYourself());
    if (isEnterprise(payer)) throw refuse(400, 'bill_enterprise_payer', billLines.noEnterprisePayer());
    const postId = typeof body.postId === 'string' && body.postId ? body.postId : null;
    if (body.postId !== undefined && body.postId !== null && body.postId !== '' && !postId) throw refuse(400, 'bill_about', billLines.notYourListing());
    if (postId) {
        const author = (db.prepare('SELECT author_pubkey FROM posts WHERE id = ? AND shown_from_host IS NULL').get(postId) as { author_pubkey: string } | undefined)?.author_pubkey;
        if (author !== biller) throw refuse(400, 'bill_about', billLines.notYourListing());
    }
    const standingId = typeof body.standingId === 'string' && body.standingId ? body.standingId : null;
    if (body.standingId !== undefined && body.standingId !== null && body.standingId !== '' && !standingId) throw refuse(400, 'bill_about', billLines.notYourStanding());
    if (standingId && !db.prepare(`SELECT 1 FROM standing_deals WHERE id = @id
                                     AND ((payer_pubkey = @p AND payee_pubkey = @b) OR (payer_pubkey = @b AND payee_pubkey = @p))`).get({ id: standingId, p: payer, b: biller })) {
        throw refuse(400, 'bill_about', billLines.notYourStanding());
    }

    // A retry of the same send: the same bill, answered again; nothing new is written or told.
    const prior = readBill(id);
    if (prior) {
        const same = prior.biller_pubkey === biller && prior.sent_by === signer && prior.payer_pubkey === payer && prior.amount_c === amount
            && prior.what_for === whatFor && prior.post_id === postId && prior.standing_id === standingId;
        if (!same) throw refuse(409, 'bill_id_reused', billLines.idReused());
        return billViewFor(prior, 'sent');
    }
    if (billsHeldBy(biller) > 0) throw refuse(403, 'bills_on_hold', billLines.onHold());
    assertUnderLimits(biller, payer, now);

    const at = iso(now);
    const expires = iso(now + BILL_RULES.waitDays * DAY_MS);
    const hidden = hiddenFrom(payer, { biller_pubkey: biller, sent_by: signer });
    const known = !hidden && knownTo(payer, { biller_pubkey: biller });
    let told: BillNotice[] = [];
    db.transaction(() => {
        db.prepare(`INSERT INTO bills (id, biller_pubkey, sent_by, payer_pubkey, amount_c, what_for, post_id, standing_id, state, created_at, delivered_at, expires_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?)`).run(id, biller, signer, payer, amount, whatFor, postId, standingId, at, at, expires);
        // Only from someone the payer knows: a push and a bell row (and the row in Needs you, from state). A stranger's makes
        // neither; one to a blocker, nothing at all.
        if (known) told = [keep(payer, billLines.arrived(nameOf(biller), whatFor, amount), { kind: 'bill', bill: id, ...(postId ? { postId } : {}) })];
    })();
    if (known && shareADirectChat(biller, payer)) {
        try {
            hooks.injectSystemMessage('', 'BILL', { text: billLines.arrived(nameOf(biller), whatFor, amount), postId: postId ?? undefined }, biller, payer);
        } catch (e: any) {
            console.warn('[Bills] A chat line failed:', e?.message || e);
        }
    }
    tell(hooks, told, 'trade.update');
    return billViewFor(readBill(id)!, 'sent');
}

// ── Paying, declining, withdrawing ──────────────────────────────────────────────────────────────────────────────────

/** POST /api/bills/:id/pay's answer: the bill as the payer now reads it, and the ledger row that paid it. */
export interface PaidBill { bill: BillView; transactionId: string }

/** The bill `payer` may act on: theirs, waiting, not expired, not hidden from them. Throws 404 or 409 otherwise. */
function waitingBillOf(payer: string, billId: string, now: number): BillRow {
    const bill = readBill(billId);
    // Hidden from them (they blocked its sender) reads as no bill at all, as it is never listed for them.
    if (!bill || bill.payer_pubkey !== payer || hiddenFrom(payer, bill)) throw refuse(404, 'bill_gone', billLines.notYours());
    if (bill.state !== 'sent' || !bill.expires_at || Date.parse(bill.expires_at) <= now) throw refuse(409, 'bill_not_waiting', billLines.notWaiting());
    return bill;
}

/**
 * POST /api/bills/:id/pay: the payer pays it, at once and for good. Every guard runs before the one conservingTransaction
 * (the file header's PAYING); the money line is core's billMoneyLine, so a refusal here is the line the payer read beside a
 * Pay that was off. Safe to retry with `requestId` (money-requests.ts): the same payment again answers the first.
 */
export function payBill(hooks: BillHooks, payer: string, billId: string, requestId: unknown, now: number = Date.now()): PaidBill {
    assertBillsHere();
    assertLedgerWritable();
    const request = moneyRequestOf(payer, PAY_ROUTE, requestId, { billId });
    if (request) {
        const first = priorAnswer<PaidBill>(request);
        if (first) return first;
    }
    const bill = waitingBillOf(payer, billId, now);
    // The payer's own standing, as at every door that spends their Beans on a deal: an active member, not on holiday.
    assertBuyerMayTrade(payer);
    // An enterprise pays no bill in v1 (design §4.1): none can be sent one, and none pays one.
    if (isEnterprise(payer)) throw refuse(403, 'bill_enterprise_payer', billLines.noEnterprisePayer());
    if (!activeHere(bill.biller_pubkey) || memberRow(bill.biller_pubkey)?.paused === 1) throw refuse(409, 'bill_biller_gone', billLines.billerGone());
    if (billsHeldBy(bill.biller_pubkey) > 0) throw refuse(409, 'bill_on_hold', billLines.payOnHold());

    const creditOpen = dealtWith(payer, bill.biller_pubkey);
    const read = hooks.getBalance(payer) as ReturnType<BillHooks['getBalance']> & { liveOffers?: number };
    const line = billMoneyLine(bill.amount_c, { balance_c: read.balance_c, usableFloor_c: read.usableFloor_c, floor_c: read.floor_c, liveOffers: read.liveOffers ?? 0 },
        creditOpen, new Date(Date.parse(bill.expires_at!)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }));
    if (!line.canPay) throw refuse(409, `bill_${line.case}`, line.line);

    const paidAt = iso(now);
    let answer: PaidBill | null = null;
    let told: BillNotice[] = [];
    hooks.conservingTransaction(() => {
        const moved = db.prepare(`UPDATE bills SET state = 'paid', answered_at = ? WHERE id = ? AND state = 'sent' AND payer_pubkey = ?`).run(paidAt, bill.id, payer);
        if (moved.changes !== 1) throw refuse(409, 'bill_not_waiting', billLines.notWaiting());
        const tx = hooks.transfer(payer, bill.biller_pubkey, bill.amount_c, billLines.memo(bill.what_for), 'escrow', false, { signer: payer, payload: `bill:${bill.id}` });
        if (!tx) throw refuse(409, 'bill_cant_pay', line.line);
        // The first-bill rule's second read, after the move: a first bill never leaves its payer below zero.
        if (!creditOpen && hooks.getBalance(payer).balance_c < 0) throw refuse(409, 'bill_first_bill', billLines.firstBillHeldOnly(Math.max(0, read.balance_c), ''));
        db.prepare('UPDATE bills SET ledger_tx_id = ? WHERE id = ?').run(tx.id, bill.id);
        answer = { bill: billViewFor(readBill(bill.id)!, 'to-pay'), transactionId: tx.id };
        if (request) recordAnswer(request, answer);
        // The sender hears it was paid: the keeper who sent it for an enterprise (an enterprise keeps no notices).
        told = [keep(bill.sent_by, billLines.paidToSender(nameOf(payer), bill.what_for, bill.amount_c), { kind: 'bill_paid', bill: bill.id, screen: 'bill' })];
    });
    tell(hooks, told, 'trade.update');
    return answer!;
}

/** POST /api/bills/:id/decline: the payer declines, quietly. The sender is told nothing and reads "not paid" until it expires. */
export function declineBill(payer: string, billId: string, now: number = Date.now()): BillView {
    assertBillsHere();
    assertPlainTablesWritable();
    const bill = waitingBillOf(payer, billId, now);
    const moved = db.prepare(`UPDATE bills SET state = 'declined', answered_at = ? WHERE id = ? AND state = 'sent' AND payer_pubkey = ?`).run(iso(now), bill.id, payer);
    if (moved.changes !== 1) throw refuse(409, 'bill_not_waiting', billLines.notWaiting());
    return billViewFor(readBill(bill.id)!, 'to-pay');
}

/**
 * POST /api/bills/:id/withdraw: the sender (or a keeper of the enterprise that sent it) takes back a bill not paid. A
 * declined one too, so withdrawing never tells them it was declined. The payer's row leaves, silently.
 */
export function withdrawBill(hooks: Pick<BillHooks, 'canOperateTreasury'>, signer: string, billId: string, now: number = Date.now()): BillView {
    assertBillsHere();
    assertPlainTablesWritable();
    const bill = readBill(billId);
    const mine = !!bill && (bill.biller_pubkey === signer || bill.sent_by === signer || (isEnterprise(bill.biller_pubkey) && hooks.canOperateTreasury(signer, bill.biller_pubkey)));
    if (!bill || !mine) throw refuse(404, 'bill_gone', billLines.notYours());
    const moved = db.prepare(`UPDATE bills SET state = 'withdrawn', answered_at = ? WHERE id = ? AND state IN ('sent', 'declined')`).run(iso(now), bill.id);
    if (moved.changes !== 1) throw refuse(409, 'bill_not_waiting', billLines.notWaiting());
    return billViewFor(readBill(bill.id)!, 'sent');
}

// ── Reports, expiry, closed accounts ───────────────────────────────────────────────────────────────────────────────

/** The bill a report names, when `reporter` is its payer and it is still theirs to see: the report is about its sender. */
export function reportableBill(reporter: string, billId: unknown): BillRow | null {
    if (typeof billId !== 'string' || !billId) return null;
    const bill = readBill(billId);
    return bill && bill.payer_pubkey === reporter && !hiddenFrom(reporter, bill) ? bill : null;
}

/** The words the owners' queue keeps for a report on a bill: the reporter's reason, then what the bill was for and how much. */
export function billReportReason(reason: string, bill: BillRow): string {
    const tail = ` · Bill: "${bill.what_for}", ${formatHundredths(bill.amount_c, 'en')} Beans`;
    return `${reason.slice(0, Math.max(0, 500 - tail.length))}${tail}`;
}

/**
 * A report filed on a bill (routes/community.ts POST /api/reports with targetBillId), after the report is kept: the bill is
 * declined if it is still waiting, and names the report. When this makes three reporters within 7 days, the sender's bills
 * are held and every owner and admin is told once: who, how many, and where to look.
 */
export function billReported(hooks: Pick<BillHooks, 'broadcast' | 'dispatchPushNotification'>, bill: BillRow, reportId: string, now: number = Date.now()): void {
    if (standbyWritesNothing()) return;
    const before = billsHeldBy(bill.biller_pubkey);
    let told: BillNotice[] = [];
    db.transaction(() => {
        db.prepare('UPDATE bills SET report_id = ? WHERE id = ?').run(reportId, bill.id);
        db.prepare(`UPDATE bills SET state = 'declined', answered_at = ? WHERE id = ? AND state = 'sent'`).run(iso(now), bill.id);
        const after = billsHeldBy(bill.biller_pubkey);
        if (before === 0 && after > 0) {
            const keepers = db.prepare(`SELECT nr.member_pubkey AS key FROM node_roles nr JOIN members m ON m.public_key = nr.member_pubkey
                                         WHERE nr.role IN ('owner', 'admin') AND m.status = 'active'`).all() as { key: string }[];
            const body = billLines.heldForOwners(nameOf(bill.biller_pubkey), after);
            told = keepers.map((k) => keep(k.key, body, { kind: 'bills_on_hold', member: bill.biller_pubkey, screen: 'settings' }));
            console.log(`🧾 Member ${bill.biller_pubkey.slice(0, 12)}…'s bills are held: ${after} members reported them within ${BILL_RULES.reportWindowDays} days.`);
        }
    })();
    tell(hooks, told, 'community.notice');
}

/** On a main server, hourly: every bill past its 30 days, waiting or declined, expires. A state flip; no Beans move. */
export function expireBills(now: number = Date.now()): number {
    if (standbyWritesNothing()) return 0;
    return db.prepare(`UPDATE bills SET state = 'expired', answered_at = ? WHERE state IN ('sent', 'declined') AND expires_at <= ?`).run(iso(now), iso(now)).changes;
}

/**
 * A member removed (adminPruneUser) or who deleted their account (purgeMemberSelf), in the caller's transaction: the bills
 * they sent and have out are withdrawn, and the bills waiting on them expire. Nothing was held, so nothing is settled.
 */
export function endBillsOf(memberKey: string, now: number = Date.now()): number {
    const at = iso(now);
    const sent = db.prepare(`UPDATE bills SET state = 'withdrawn', answered_at = ? WHERE biller_pubkey = ? AND state IN ('sent', 'declined')`).run(at, memberKey).changes;
    const owed = db.prepare(`UPDATE bills SET state = 'expired', answered_at = ? WHERE payer_pubkey = ? AND state IN ('sent', 'declined')`).run(at, memberKey).changes;
    return sent + owed;
}

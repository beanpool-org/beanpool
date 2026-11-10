// Standing deals: paying for something by the week or by the month (scratch/fable-design/DESIGN-standing-deals-upfront-fable.md
// and its amendment; Marty's decisions, 10 Nov 2026). TIER A: Beans move on a timer, with no fresh tap.
//
// THE MODEL. A listing priced per week or per month, taken up with `standing` (acceptPost on an Offer, approvePostRequest on
// a Need, engine/escrow.ts), is a standing deal. Each period is PAID AT ITS START, and nothing is ever held in trust: at the
// take-up the first period's Beans go to the payee at once, less the 1.5% to the Commons; at each period's end this node's
// minute tick pays the next the same way, until the count is reached or one of them stops it. Every period is one
// marketplace_transactions row written `completed` (numbered in period_no) and ONE ledger row, by escrow.ts payStandingPeriod;
// the arrangement is one row of standing_deals (schema.sql), whose phase is paid, short or ended.
//
// CONSENT. The payer signs one standing authorisation with their key at the start (@beanpool/core
// standingAuthorisationText): the host, the standing deal's id, the listing, the payee, the Beans per period, the period, how
// many periods and the start. The node keeps the text, its signature and its signer, and every payment it makes is read back
// against it (boundsRow). Each payment's ledger row names the signer and `standing:<id>:<n>` (auth_payload).
//
// ONE PAYMENT PER PERIOD. payNext is ONE conservingTransaction: a compare-and-swap on the standing row's phase and
// periods_done that must change one row, the period's row under the UNIQUE (standing_id, period_no) index, and the one
// transfer(), which checks the payer's usable floor and the enterprise floor itself. The node is one process and SQLite has
// one writer, so whichever of the tick and the after-commit hook runs second finds the period paid and writes nothing.
//
// SHORT (amendment §2, §3). A period that can't be paid when due (a refusal that means the payer's Beans don't cover it: the
// floor, a frozen credit line) makes the phase 'short': both told at once, a live "Needs you" line each (from state, in the
// apps and the Home answer), tried again hourly, and paid the moment Beans reach the payer (payShortStandingDealsOf, from the
// after-commit hook on the two doors every credit goes through, state-engine.ts transfer and payFromCommons). Either side
// may stop it at once. Its grace is half the period from the day it was due (@beanpool/core standingGraceEndsAt); then it
// ends, with nothing owed through the app. Pushes follow a fixed cadence (due, halfway on a month, the day before the end,
// then covered, stopped or ended), never the hourly retry. Any other refusal means it can't carry on: it ends, both told.
//
// NEVER PAY SILENTLY OR LATE FOR NOTHING. A period already over when its turn comes (the server was away for longer than it)
// is never paid: the standing deal ends and both are told. A clock that goes back finds nothing due.
//
// WHERE. On a main server only, from its minute tick (state-engine.ts armMainServerTimers) and the after-commit hook, never
// on a standby (whose copy of this row is its main server's); where Beans are switched off nothing moves.

import crypto from 'node:crypto';
import {
    STANDING_RETRY_MS, STANDING_START_AHEAD_MS, parseStandingAuthorisation, periodEnd, periodStart, signedRequestBytes, standingAuthorisationText,
    standingGraceEndsAt, standingLines, standingPaymentPayload, standingUnitOf, standingWarnAheadMs, type PushNoticeKind, type StandingAuthorisation,
    type StandingEndReason, type StandingPeriodUnit,
} from '@beanpool/core';
import { getPosts } from '@beanpool/engine';
import { db } from '../db/db.js';
import { getNodeRole } from '../config/node-role.js';
import { assertFeatureOn, getProfileSwitches } from '../config/node-profile.js';
import { keepNotice, keptNoticeDetails } from './kept-notices.js';
import { marketplacePostOutOfSight } from './post-sight.js';
import { audienceRefusal } from './member-signature.js';
import { audienceStanding, isLocalNetworkHost, normalizeAddress } from './own-addresses.js';
import {
    afterRelease, assertBuyerMayTrade, isShortRefusal, offerHoldChecks, payStandingPeriod, requestHoldChecks, type EscrowCallbacks, type HoldParties,
} from './escrow.js';

/** The `standing` a member's app sends with an accept (an Offer) or an approval (a Need). */
export interface StandingStart {
    /** The signed authorisation: its exact text, and the payer's (or their keeper's) signature over its UTF-8 bytes. */
    authorisation: { payload: string; signature: string };
    /** Until one of them stops it (true), or a number of periods: each, when given, must say what the text says. */
    untilStopped?: boolean;
    periods?: number;
    /** The start the app showed: when given, the text's own. */
    startsAt?: string;
    /** The host this request came to (the route's, never the body's): a statement for a home-network host must name it. */
    requestHost?: string;
}

/** A standing start the node has checked: the authorisation it read, who signed it, and the text and signature it keeps. */
export interface CheckedStandingStart {
    auth: StandingAuthorisation;
    payer: string;
    payee: string;
    signer: string;
    payload: string;
    signature: string;
}

/** A notice kept for a member in the transaction that made it, to go out live and as a push after the commit. */
export interface StandingNotice { to: string; title: string; body: string; id: string | null; data: Record<string, unknown> }

/** The refusal of a standing start whose authorisation doesn't match (400 standing_auth). */
export const STANDING_AUTH_CODE = 'standing_auth';
function authRefused(why: string): Error {
    console.warn(`[Standing] A standing start was refused: ${why}.`);
    return Object.assign(new Error(standingLines.authMismatch()), { status: 400, statusCode: 400, code: STANDING_AUTH_CODE });
}

/**
 * An ed25519 signature (base64 or hex) by a member's key (64 hex) over the text as every member statement is signed
 * (@beanpool/core request-signing.ts, signStandingAuthorisation): 0xFF, then the text in UTF-8. Never the bare text: an
 * older app's "Manage" button signs whatever text a node sends it as plain UTF-8, so a bare-text signature could have been
 * made by a hostile node.
 */
function signedBy(text: string, signature: string, pubKeyHex: string): boolean {
    try {
        if (!/^[0-9a-f]{64}$/.test(pubKeyHex) || typeof signature !== 'string' || !signature) return false;
        const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubKeyHex, 'hex')]), format: 'der', type: 'spki' });
        const sig = Buffer.from(signature.trim(), /^[0-9a-fA-F]{128}$/.test(signature.trim()) ? 'hex' : 'base64');
        return sig.length === 64 && crypto.verify(null, Buffer.from(signedRequestBytes(text)), key, sig);
    } catch {
        return false;
    }
}

/** May `signer` sign for `payer`: themselves, or a keeper of the enterprise that pays (the node's canOperateTreasury). */
function signsFor(cb: EscrowCallbacks, signer: string, payer: string): boolean {
    if (signer === payer) return true;
    const isEnterprise = (db.prepare('SELECT is_treasury FROM members WHERE public_key = ?').get(payer) as { is_treasury: number } | undefined)?.is_treasury === 1;
    return isEnterprise && typeof cb.canOperateTreasury === 'function' && cb.canOperateTreasury(signer, payer);
}

/** Whether a host the text names is this community's (as every format-2 statement's is: engine/member-signature.ts). */
function hostIsOurs(host: string, signer: string, requestHost: string | undefined): boolean {
    if (audienceRefusal(host, signer)) return false;
    // A node that knows none of its names takes any host, and every node a home-network one: then it must be the host this
    // request came to, so a text signed for another server is no authorisation here (routes/node-claim.ts does the same).
    if (audienceStanding(host) === 'unconfigured' || isLocalNetworkHost(host)) {
        return !!requestHost && normalizeAddress(host) === normalizeAddress(requestHost);
    }
    return true;
}

/**
 * Check a standing start before anything is written: the listing is priced per week or per month; the text is one
 * @beanpool/core writes; it is signed by the actor, who is the payer or a keeper of the enterprise that pays; it names this
 * community, this listing, this payee and this price per period, to the cent; its start is from now to 30 days ahead; and its
 * id is new. Any mismatch is the one refusal (400 standing_auth), its reason logged.
 */
export function checkStandingStart(
    cb: EscrowCallbacks,
    s: StandingStart,
    deal: { postId: string; priceType: string | null | undefined; price: number; payer: string; payee: string; signer?: string },
    now: number = Date.now(),
): CheckedStandingStart {
    const unit = standingUnitOf(deal.priceType);
    if (!unit) throw authRefused(`the listing is priced ${deal.priceType}, not per week or per month`);
    const payload = s?.authorisation?.payload;
    const signature = s?.authorisation?.signature;
    const auth = parseStandingAuthorisation(payload);
    if (!auth || typeof signature !== 'string') throw authRefused('the authorisation is not a standing authorisation text');
    const signer = deal.signer;
    if (!signer || !signsFor(cb, signer, deal.payer)) throw authRefused('the signer is neither the payer nor a keeper of the enterprise that pays');
    if (!signedBy(payload as string, signature, signer)) throw authRefused('the signature is not the signer\'s over this text');
    if (!hostIsOurs(auth.host, signer, s.requestHost)) throw authRefused(`it was signed for ${auth.host}, not this community`);
    if (auth.listingId !== deal.postId) throw authRefused('it names another listing');
    if (auth.payee !== deal.payee) throw authRefused('it names another payee');
    if (auth.unit !== unit) throw authRefused(`it is per ${auth.unit}, the listing per ${unit}`);
    // Whole hundredths, exactly: the integer the payer signed is the listing's price per period.
    if (deal.price !== auth.beansPerPeriod_c) {
        throw authRefused(`it is ${auth.beansPerPeriod_c} hundredths a period, the listing ${deal.price}`);
    }
    if (s.untilStopped === true && auth.maxPeriods !== null) throw authRefused('the app said until stopped, the text a count');
    if (s.periods !== undefined && s.periods !== auth.maxPeriods) throw authRefused('the app\'s count is not the text\'s');
    if (s.startsAt !== undefined && s.startsAt !== auth.startsAt) throw authRefused('the app\'s start is not the text\'s');
    const startMs = Date.parse(auth.startsAt);
    if (startMs < now - 10 * 60 * 1000 || startMs > now + STANDING_START_AHEAD_MS) throw authRefused('its start is not between now and 30 days ahead');
    if (db.prepare('SELECT 1 FROM standing_deals WHERE id = ?').get(auth.standingId)) throw authRefused('its id is taken');
    return { auth, payer: deal.payer, payee: deal.payee, signer, payload: payload as string, signature };
}

/**
 * The standing row for a start, its first period `txId` paid: INSIDE the payment's conservingTransaction (escrow.ts). Phase
 * paid, one period done, the next due when the first ends.
 */
export function insertStandingDeal(v: CheckedStandingStart, txId: string): void {
    db.prepare(`INSERT INTO standing_deals (id, post_id, payer_pubkey, payee_pubkey, beans_per_period_c, period_unit, starts_at, max_periods, phase,
                    periods_done, current_tx_id, next_due_at, auth_signer, auth_signature, auth_payload)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'paid', 1, ?, ?, ?, ?, ?)`)
        .run(v.auth.standingId, v.auth.listingId, v.payer, v.payee, v.auth.beansPerPeriod_c, v.auth.unit, v.auth.startsAt, v.auth.maxPeriods,
            txId, periodEnd(v.auth.startsAt, v.auth.unit, 1), v.signer, v.signature, v.payload);
}

/** The first period's payment as the take-up makes it: what escrow.ts payStandingPeriod needs from a checked start. */
export function firstPeriodOf(v: CheckedStandingStart, title: string): { periodNo: number; amount: number; memo: string; auth: { signer: string; payload: string } } {
    return {
        periodNo: 1,
        amount: v.auth.beansPerPeriod_c,
        memo: standingLines.memo(v.auth.unit, title, 1),
        auth: { signer: v.signer, payload: standingPaymentPayload(v.auth.standingId, 1) },
    };
}

interface StandingRow {
    id: string;
    post_id: string;
    payer_pubkey: string;
    payee_pubkey: string;
    beans_per_period_c: number;
    period_unit: StandingPeriodUnit;
    starts_at: string;
    max_periods: number | null;
    phase: 'paid' | 'short' | 'ended';
    periods_done: number;
    current_tx_id: string | null;
    next_due_at: string;
    short_since: string | null;
    stopped_by: string | null;
    stopped_at: string | null;
    ended_at: string | null;
    ended_reason: StandingEndReason | null;
    auth_signer: string;
    auth_signature: string;
    auth_payload: string;
}

const readStanding = (id: string): StandingRow | undefined => db.prepare('SELECT * FROM standing_deals WHERE id = ?').get(id) as StandingRow | undefined;

/** A listing's title as a notice quotes it, cut to a line. */
function titleOf(postId: string): string {
    const t = ((db.prepare('SELECT title FROM posts WHERE id = ?').get(postId) as { title: string | null } | undefined)?.title || '').trim();
    return t.length > 80 ? `${t.slice(0, 79)}…` : t;
}
const nameOf = (key: string): string =>
    ((db.prepare('SELECT callsign FROM members WHERE public_key = ?').get(key) as { callsign: string | null } | undefined)?.callsign || '').trim() || 'A member';
/** A date as a notice writes it: day and month, UTC (the notices are kept in English, as every kept notice is). */
const dayOf = (iso: string | number): string => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Keep a notice for each of `to` in the caller's transaction; tellStanding sends them after the commit. */
function keep(to: string[], body: string, sd: { id: string; post_id: string }, kind: string, extra: Record<string, unknown> = {}): StandingNotice[] {
    const title = standingLines.noticeTitle();
    const data = { kind, standing: sd.id, postId: sd.post_id, ...extra };
    return to.map((who) => ({ to: who, title, body, data, id: keepNotice(who, title, body, data) }));
}

/**
 * After the commit: each notice live to its member's own sockets with its kept copy's id (the bell's row), and a push of
 * kind trade.update (amendment §2), which names the kept copy so acknowledging one takes the other off.
 */
export function tellStanding(hooks: Pick<EscrowCallbacks, 'broadcast' | 'dispatchPushNotification'>, notices: StandingNotice[]): void {
    for (const n of notices) {
        try {
            hooks.broadcast({ type: 'system_announcement', title: n.title, body: n.body, severity: 'info', ...n.data, ...(n.id ? { noticeId: n.id } : {}) }, [n.to]);
        } catch (e: any) {
            console.warn('[Standing] A live notice failed:', e?.message || e);
        }
        try {
            hooks.dispatchPushNotification([n.to], 'SYSTEM', n.title, n.body, { screen: 'post', postId: n.data.postId }, 'escrow', 'trade.update' as PushNoticeKind,
                false, keptNoticeDetails([n]));
        } catch (e: any) {
            console.warn('[Standing] A push failed:', e?.message || e);
        }
    }
}

/** The record in the deal's chat (amendment §2): one SYSTEM line both sides read, after the commit. */
const STANDING_CHAT_LINE = 'STANDING_DEAL';
function chatLine(hooks: Pick<EscrowCallbacks, 'injectSystemMessage'>, sd: { post_id: string; payer_pubkey: string; payee_pubkey: string }, text: string): void {
    try {
        hooks.injectSystemMessage(sd.post_id, STANDING_CHAT_LINE, { text }, sd.payer_pubkey, sd.payee_pubkey);
    } catch (e: any) {
        console.warn('[Standing] A chat line failed:', e?.message || e);
    }
}

/**
 * A one-off listing the standing deal took off the board goes back on it once the standing deal has ended (unless its
 * author removed it, or a prune cancelled it): the thing is free to take up again.
 */
function listingBack(sd: { id: string; post_id: string }, at: string): void {
    db.prepare(`UPDATE posts SET status = 'active', accepted_by = NULL, accepted_at = NULL, pending_transaction_id = NULL, updated_at = ?
                WHERE id = ? AND status = 'pending' AND pending_transaction_id IN (SELECT id FROM marketplace_transactions WHERE standing_id = ?)`)
        .run(at, sd.post_id, sd.id);
}

/** End a standing deal (the caller's transaction): nothing more is paid, and its listing comes back. Whether it ended now. */
function endStanding(sd: { id: string; post_id: string }, reason: StandingEndReason, at: string): boolean {
    const moved = db.prepare(`UPDATE standing_deals SET phase = 'ended', ended_at = ?, ended_reason = ? WHERE id = ? AND phase != 'ended'`).run(at, reason, sd.id);
    if (moved.changes === 1) listingBack(sd, at);
    return moved.changes === 1;
}

/** Whether the count the payer signed for is reached with `paid` periods paid. */
const countReached = (sd: StandingRow, paid: number): boolean => sd.max_periods !== null && paid >= sd.max_periods;

/** The period now due (the one after the last paid), when it was due, and when its grace ends. */
function duePeriodOf(sd: StandingRow): { n: number; dueAt: string; graceEndsAt: string; periodEndsAt: string } {
    const n = sd.periods_done + 1;
    return {
        n,
        dueAt: periodStart(sd.starts_at, sd.period_unit, n),
        graceEndsAt: standingGraceEndsAt(sd.starts_at, sd.period_unit, n),
        periodEndsAt: periodEnd(sd.starts_at, sd.period_unit, n),
    };
}

// ── The tick and the hook ──────────────────────────────────────────────────────────────────────────────────────────

/** What the tick and the hook need of the node: escrow's own callbacks, and the enterprise floor cache to clear after a payment. */
export interface StandingHooks extends EscrowCallbacks {
    clearEnterpriseFloorCache?: () => void;
}

const loggedOnce = new Map<string, string>();
let loggedBeansOff = false;
function logOnce(id: string, line: string): void {
    if (loggedOnce.get(id) === line) return;
    loggedOnce.set(id, line);
    console.error(`[Standing] ${line}`);
}

/**
 * The key a member holds now: `key` itself, or the key a re-key moved it to, followed to the end (invalidated_keys.rekeyed_to;
 * engine/key-move.ts moves the standing row, not the text its payer signed). At most a few links; a loop stops.
 */
export function currentKeyOf(key: string): string {
    let k = key;
    for (let i = 0; i < 8; i++) {
        const next = (db.prepare('SELECT rekeyed_to FROM invalidated_keys WHERE public_key = ?').get(k) as { rekeyed_to: string | null } | undefined)?.rekeyed_to;
        if (!next || next === k) break;
        k = next;
    }
    return k;
}
/** Whether two keys are one member's: the same, or `signed` was re-keyed to `now` (the payee a signed text names, re-keyed since). */
const sameMember = (signed: string, now: string): boolean => signed === now || currentKeyOf(signed) === now;

/** The authorisation the row holds, read back, and whether it bounds the row as the row stands. */
function boundsRow(sd: StandingRow): boolean {
    const a = parseStandingAuthorisation(sd.auth_payload);
    return !!a && a.standingId === sd.id && a.listingId === sd.post_id && sameMember(a.payee, sd.payee_pubkey) && a.unit === sd.period_unit
        && a.startsAt === sd.starts_at && a.maxPeriods === sd.max_periods && a.beansPerPeriod_c === sd.beans_per_period_c
        && standingAuthorisationText(a) === sd.auth_payload;
}

/** Whether a standing deal's money may move here at all: a main server with Beans on. */
function movesHere(): boolean {
    return getNodeRole() !== 'backup' && !!getProfileSwitches().beans;
}

/**
 * Run every standing deal that is due at `now`: pay the periods whose start has come, try again for the short ones, end
 * those whose grace is over, send the grace's pushes on their cadence, and tell payers who will be short ahead of time. On a
 * main server, from its minute tick. Never throws.
 */
export function tickStandingDeals(hooks: StandingHooks, now: number = Date.now()): { paid: number; short: number; ended: number } {
    const out = { paid: 0, short: 0, ended: 0 };
    if (getNodeRole() === 'backup') return out;
    let due: StandingRow[];
    try {
        due = db.prepare(`SELECT * FROM standing_deals WHERE phase IN ('paid', 'short') AND next_due_at <= ? ORDER BY next_due_at LIMIT 200`)
            .all(new Date(now).toISOString()) as StandingRow[];
    } catch (e) {
        console.warn('[Standing] Could not look for standing deals that are due:', e);
        return out;
    }
    if (!getProfileSwitches().beans) {
        if (due.length > 0 && !loggedBeansOff) {
            loggedBeansOff = true;
            console.warn(`[Standing] ${due.length} standing deal(s) are due; Beans are switched off here, so nothing moves.`);
        }
        return out;
    }
    for (const sd of due) {
        try {
            const r = sd.phase === 'paid' ? dueStep(hooks, sd, now) : payNext(hooks, sd, now, 'tick');
            if (r === 'paid') out.paid++;
            else if (r === 'short') out.short++;
            else if (r === 'ended') out.ended++;
        } catch (e: any) {
            logOnce(sd.id, `standing deal ${sd.id} could not be run: ${e?.message || e}`);
        }
    }
    try { graceCadence(hooks, now); } catch (e: any) { console.warn('[Standing] The grace notices failed:', e?.message || e); }
    try { warnAhead(hooks, now); } catch (e: any) { console.warn('[Standing] The short-ahead notices failed:', e?.message || e); }
    return out;
}

/**
 * The after-commit hook (amendment §3): Beans reached `payer` (transfer() or payFromCommons() credited them and committed),
 * so each of their short standing deals is tried at once, oldest due first, each its own payNext. A refusal (still short)
 * writes nothing and sends nothing; the hourly retry and the cadence stay the tick's. Never throws. Returns how many were paid.
 */
export function payShortStandingDealsOf(hooks: StandingHooks, payer: string, now: number = Date.now()): number {
    if (!movesHere()) return 0;
    let paid = 0;
    try {
        const short = db.prepare(`SELECT * FROM standing_deals WHERE payer_pubkey = ? AND phase = 'short' ORDER BY short_since, next_due_at LIMIT 50`).all(payer) as StandingRow[];
        for (const sd of short) {
            try {
                if (payNext(hooks, sd, now, 'hook') === 'paid') paid++;
            } catch (e: any) {
                logOnce(sd.id, `standing deal ${sd.id} could not be paid when Beans came in: ${e?.message || e}`);
            }
        }
    } catch (e: any) {
        console.warn('[Standing] Paying short standing deals after a credit failed:', e?.message || e);
    }
    return paid;
}

/** Whether `payer` has a standing deal that is short: the hook's cheap test, before it asks for the node's callbacks. */
export function hasShortStandingDeal(payer: string): boolean {
    try {
        return !!db.prepare(`SELECT 1 FROM standing_deals WHERE payer_pubkey = ? AND phase = 'short' LIMIT 1`).get(payer);
    } catch {
        return false;
    }
}

/** A paid standing deal whose next period's start has come: stop, count, bounds, too late, or pay it. */
function dueStep(hooks: StandingHooks, sd: StandingRow, now: number): 'paid' | 'short' | 'ended' | 'skipped' {
    if (sd.stopped_at) return endFromTick(hooks, sd, 'stopped', standingLines.ended);
    if (countReached(sd, sd.periods_done)) return endFromTick(hooks, sd, 'count_reached', standingLines.ended);
    if (!boundsRow(sd)) {
        logOnce(sd.id, `standing deal ${sd.id}: its row no longer matches the authorisation it holds, so no period is paid`);
        return endFromTick(hooks, sd, 'cant_run', standingLines.cantRun);
    }
    // A period already over is never paid (design §2): the server was away for longer than it.
    if (now >= Date.parse(duePeriodOf(sd).periodEndsAt)) return endFromTick(hooks, sd, 'server_away', standingLines.serverAway);
    return payNext(hooks, sd, now, 'tick');
}

/**
 * Every guard the door that started it runs, again, for its next period: acceptPost's on an Offer, approvePostRequest's on
 * a Need. Throws the refusal; isShortRefusal tells a short payer from one who can't carry on.
 */
function scheduledChecks(hooks: StandingHooks, sd: StandingRow): HoldParties & { oneAtATime: boolean } {
    assertFeatureOn('escrow');
    // Whoever signed still signs for the payer, as checkStandingStart asked at the start: the payer themselves (under a
    // re-key, their key now), or a keeper of the enterprise that pays. A keeper removed since stops spending its Beans.
    if (!signsFor(hooks, currentKeyOf(sd.auth_signer), sd.payer_pubkey)) throw new Error('the one who signed it no longer signs for its payer');
    const raw = db.prepare('SELECT * FROM posts WHERE id = ?').get(sd.post_id) as any;
    if (!raw) throw new Error('its listing is gone');
    // Running deals carry on while their listing is paused; a one-off listing stays taken by its standing deal.
    const heldByThis = raw.status === 'pending' && !!raw.pending_transaction_id
        && !!db.prepare('SELECT 1 FROM marketplace_transactions WHERE id = ? AND standing_id = ?').get(raw.pending_transaction_id, sd.id);
    if (!(raw.status === 'active' || raw.status === 'paused' || heldByThis) || raw.active !== 1 || raw.hidden_by_reports_at) {
        throw new Error('its listing is no longer up');
    }
    const scheduled = { standingId: sd.id };
    if (raw.type === 'offer') {
        // The buyer's own checks as acceptPost makes them (member, re-key, holiday), then the post as getPosts reads it by id.
        const post = getPosts(db, { id: sd.post_id, includeAllScopes: true } as any)[0];
        // As acceptPost: a group or direct listing out of the payer's sight (they left the group) is not theirs to take.
        if (!post || marketplacePostOutOfSight(post, sd.payer_pubkey)) throw new Error('its listing is not in the payer\'s sight');
        assertBuyerMayTrade(sd.payer_pubkey);
        if (post.authorPublicKey !== sd.payee_pubkey) throw new Error('its listing has another author');
        const p = offerHoldChecks(hooks, post, sd.payer_pubkey, () => sd.beans_per_period_c, { authSigner: currentKeyOf(sd.auth_signer), scheduled });
        return { ...p, oneAtATime: !raw.repeatable };
    }
    const deal = { id: sd.current_tx_id ?? '', post_id: sd.post_id, buyer_pubkey: sd.payer_pubkey, seller_pubkey: sd.payee_pubkey, amount_c: sd.beans_per_period_c };
    const p = requestHoldChecks(hooks, deal, raw, sd.payer_pubkey, { authSigner: currentKeyOf(sd.auth_signer), scheduled });
    if (!p) throw new Error('its payer is no longer the listing\'s author');
    return p;
}

/** Why a scheduled payment can't be made at all, from the refusal: the standing deal ends with it. */
function endReasonOf(sd: StandingRow): StandingEndReason {
    const post = db.prepare('SELECT status, active, hidden_by_reports_at FROM posts WHERE id = ?').get(sd.post_id) as any;
    if (!post || post.active !== 1 || post.status === 'cancelled' || post.status === 'completed' || post.hidden_by_reports_at) return 'listing_gone';
    const closed = db.prepare(`SELECT 1 FROM members WHERE public_key IN (?, ?) AND status IN ('pruned', 'disabled', 'completed')`).get(sd.payer_pubkey, sd.payee_pubkey);
    return closed ? 'account_closed' : 'cant_run';
}

/**
 * End it from the tick, with its notice to both, while it is as it was read: not ended, the same periods done and the
 * same phase. Whether it ended.
 */
function endIfUnmoved(hooks: StandingHooks, sd: StandingRow, reason: StandingEndReason, body: (title: string) => string): boolean {
    let told: StandingNotice[] = [];
    let ended = false;
    const at = new Date().toISOString();
    db.transaction(() => {
        const fresh = readStanding(sd.id);
        if (!fresh || fresh.phase !== sd.phase || fresh.periods_done !== sd.periods_done) return;
        if (!endStanding(fresh, reason, at)) return;
        ended = true;
        told = keep([sd.payer_pubkey, sd.payee_pubkey], body(titleOf(sd.post_id)), sd, 'standing_ended', { reason });
    })();
    tellStanding(hooks, told);
    return ended;
}

/** End it from the tick, with its notice to both. */
function endFromTick(hooks: StandingHooks, sd: StandingRow, reason: StandingEndReason, body: (title: string) => string): 'ended' {
    endIfUnmoved(hooks, sd, reason, body);
    return 'ended';
}

/**
 * Pay the period now due: ONE conservingTransaction (the CAS on phase and periods_done, the period's row under its UNIQUE
 * index, the one transfer). `via` says who asks: the tick (a refusal makes it short, or tries again in an hour) or the
 * after-commit hook (a refusal writes nothing and sends nothing). A short one whose grace is over ends instead.
 */
function payNext(hooks: StandingHooks, sd: StandingRow, now: number, via: 'tick' | 'hook'): 'paid' | 'short' | 'ended' | 'skipped' {
    const due = duePeriodOf(sd);
    const n = due.n;
    if (sd.phase === 'short') {
        // The same two guards as the tick's, from either door: the grace not over (else it ends), and the authorisation.
        if (now >= Date.parse(due.graceEndsAt)) return endShort(hooks, sd);
        if (!boundsRow(sd)) {
            if (via === 'hook') return 'skipped';
            logOnce(sd.id, `standing deal ${sd.id}: its row no longer matches the authorisation it holds, so no period is paid`);
            return endFromTick(hooks, sd, 'cant_run', standingLines.cantRun);
        }
        // A clock that went back pays nothing: the period isn't due yet.
        if (now < Date.parse(due.dueAt)) return 'skipped';
    }

    let parties: HoldParties & { oneAtATime: boolean };
    try {
        parties = scheduledChecks(hooks, sd);
    } catch (e: any) {
        if (via === 'hook') return 'skipped';
        if (isShortRefusal(e)) return markShort(hooks, sd, now);
        console.warn(`[Standing] Standing deal ${sd.id} can't carry on: ${e?.message || e}`);
        return endFromTick(hooks, sd, endReasonOf(sd), standingLines.cantRun);
    }

    const title = titleOf(sd.post_id);
    const txId = crypto.randomUUID();
    const paidAt = new Date(now).toISOString();
    const nextDue = due.periodEndsAt;
    const covered = sd.phase === 'short';
    let paid: { releaseResult: any; releaseCredits: number } | null = null;
    let told: StandingNotice[] = [];
    let row: any = null;
    try {
        hooks.conservingTransaction(() => {
            const moved = db.prepare(`UPDATE standing_deals SET phase = 'paid', periods_done = periods_done + 1, short_since = NULL, current_tx_id = ?, next_due_at = ?
                                      WHERE id = ? AND phase = ? AND periods_done = ?`).run(txId, nextDue, sd.id, sd.phase, sd.periods_done);
            if (moved.changes !== 1) throw new Error('the standing deal moved on since it was read');
            paid = payStandingPeriod(hooks, {
                txId, postId: sd.post_id, parties, periodNo: n, standingId: sd.id, amount: sd.beans_per_period_c,
                memo: standingLines.memo(sd.period_unit, title, n),
                auth: { signer: sd.auth_signer, payload: standingPaymentPayload(sd.id, n) },
                row: 'insert', paidAt, takeListing: parties.oneAtATime,
            });
            row = db.prepare('SELECT * FROM marketplace_transactions WHERE id = ?').get(txId);
            if (covered) {
                told = [
                    ...keep([sd.payer_pubkey], standingLines.coveredPayer(sd.period_unit, title, sd.beans_per_period_c, nameOf(sd.payee_pubkey)), sd, 'standing_covered', { period: n }),
                    ...keep([sd.payee_pubkey], standingLines.coveredPayee(sd.period_unit, nameOf(sd.payer_pubkey), sd.beans_per_period_c, title), sd, 'standing_covered', { period: n }),
                ];
            }
            if (sd.max_periods !== null && n === sd.max_periods) {
                told.push(...keep([sd.payer_pubkey, sd.payee_pubkey], standingLines.lastPeriod(sd.period_unit, title, dayOf(nextDue)), sd, 'standing_last_period', { period: n }));
            }
        });
    } catch (e: any) {
        if (via === 'hook') return 'skipped';
        if (isShortRefusal(e)) return markShort(hooks, sd, now);
        logOnce(sd.id, `paying period ${n} of standing deal ${sd.id} failed and was rolled back: ${e?.message || e}`);
        return 'skipped';
    }
    loggedOnce.delete(sd.id);
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(sd.post_id) as any;
    // Each period paid on time: the payee's push, as every payment received; the payer's Ledger row and the chat line only.
    // Covered in the grace: both get the covered notice (a push and a bell row) instead, and the record its line.
    afterRelease(hooks, row, post, paid!, 'SYSTEM', covered ? null
        : { title: standingLines.noticeTitle(), body: standingLines.paidIn(sd.period_unit, sd.beans_per_period_c, title, nameOf(sd.payer_pubkey), n) });
    hooks.clearEnterpriseFloorCache?.();
    if (covered) chatLine(hooks, sd, standingLines.chatCovered(sd.period_unit, nameOf(sd.payer_pubkey), sd.beans_per_period_c, title, nameOf(sd.payee_pubkey)));
    tellStanding(hooks, told);
    return 'paid';
}

/**
 * The period now due couldn't be paid. From paid: short, both told at once (a push and a bell row each, and the chat line),
 * tried again in an hour; a grace already over (the server was away) ends it at once instead. Already short: tried again
 * in an hour, never later than the grace's end, and nobody is told anything (amendment §2: no push from a retry).
 */
function markShort(hooks: StandingHooks, sd: StandingRow, now: number): 'short' | 'ended' {
    const due = duePeriodOf(sd);
    const graceEnd = Date.parse(due.graceEndsAt);
    if (now >= graceEnd) return endShort(hooks, { ...sd, phase: 'short' }, sd.phase);
    const retryAt = new Date(Math.min(now + STANDING_RETRY_MS, graceEnd)).toISOString();
    const title = titleOf(sd.post_id);
    const until = dayOf(due.graceEndsAt);
    let told: StandingNotice[] = [];
    let began = false;
    db.transaction(() => {
        // The period's own start is when it went short: "N days overdue" counts from it, and its grace runs from it.
        const moved = db.prepare(`UPDATE standing_deals SET phase = 'short', short_since = ?, next_due_at = ? WHERE id = ? AND phase = ? AND periods_done = ?`)
            .run(sd.short_since ?? due.dueAt, retryAt, sd.id, sd.phase, sd.periods_done);
        if (moved.changes !== 1 || sd.phase === 'short') return;
        began = true;
        told = [
            ...keep([sd.payer_pubkey], standingLines.duePayer(sd.period_unit, title, sd.beans_per_period_c, nameOf(sd.payee_pubkey), until), sd, 'standing_short', { period: due.n }),
            ...keep([sd.payee_pubkey], standingLines.duePayee(sd.period_unit, nameOf(sd.payer_pubkey), sd.beans_per_period_c, title, until), sd, 'standing_short', { period: due.n }),
        ];
    })();
    if (began) chatLine(hooks, sd, standingLines.chatDue(sd.period_unit, nameOf(sd.payer_pubkey), sd.beans_per_period_c, title, until));
    tellStanding(hooks, told);
    return 'short';
}

/**
 * The grace is over: it ends, nothing is paid, and nothing is owed through the app for the days since the period was due.
 * Both told (a push and a bell row each) and the record its line. `from`: the phase the row is in (short, or paid when the
 * server came back after the grace).
 */
function endShort(hooks: StandingHooks, sd: StandingRow, from: StandingRow['phase'] = 'short'): 'ended' {
    const title = titleOf(sd.post_id);
    const dueSince = dayOf(duePeriodOf(sd).dueAt);
    let told: StandingNotice[] = [];
    let ended = false;
    const at = new Date().toISOString();
    db.transaction(() => {
        const fresh = readStanding(sd.id);
        if (!fresh || fresh.phase !== from || fresh.periods_done !== sd.periods_done) return;
        if (!endStanding(fresh, 'short', at)) return;
        ended = true;
        told = [
            ...keep([sd.payer_pubkey], standingLines.endedShortPayer(sd.period_unit, title, nameOf(sd.payee_pubkey)), sd, 'standing_ended', { reason: 'short' }),
            ...keep([sd.payee_pubkey], standingLines.endedShortPayee(sd.period_unit, nameOf(sd.payer_pubkey), title, dueSince), sd, 'standing_ended', { reason: 'short' }),
        ];
    })();
    if (ended) chatLine(hooks, sd, standingLines.chatEndedShort(sd.period_unit, title, dueSince));
    tellStanding(hooks, told);
    return 'ended';
}

/**
 * Points told this run, so a point fires once whatever the tick count even where neither side can keep a notice (an
 * enterprise keeps none, engine/kept-notices.ts canHold) or a member has cleared theirs.
 */
const toldThisRun = new Set<string>();
const markTold = (standingId: string, kind: string, period: number) => toldThisRun.add(`${standingId}:${kind}:${period}`);

/**
 * Whether a point of this kind was told for this standing deal and period: to either side, kept, or this run. The notices
 * read are the two sides' own (idx_moderation_notices_recipient), never a scan of the whole table on the minute tick; a hit
 * there is remembered for the run.
 */
function toldBefore(sd: StandingRow, kind: string, period: number): boolean {
    if (toldThisRun.has(`${sd.id}:${kind}:${period}`)) return true;
    const kept = !!db.prepare(`SELECT 1 FROM moderation_notices WHERE recipient IN (?, ?) AND CASE WHEN json_valid(data)
                           THEN json_extract(data, '$.kind') = ? AND json_extract(data, '$.standing') = ? AND json_extract(data, '$.period') = ?
                           ELSE 0 END LIMIT 1`).get(sd.payer_pubkey, sd.payee_pubkey, kind, sd.id, period);
    if (kept) markTold(sd.id, kind, period);
    return kept;
}

/**
 * The grace's own pushes, on the minute tick (amendment §2), once per (kind, period): halfway through it (on a month only:
 * a week's halfway and day-before are 18 hours apart) and the day before it ends. Only the latest point that has come is
 * sent, so a server back from a long absence sends one, not two at once.
 */
function graceCadence(hooks: StandingHooks, now: number): void {
    const short = db.prepare(`SELECT * FROM standing_deals WHERE phase = 'short' ORDER BY short_since LIMIT 500`).all() as StandingRow[];
    for (const sd of short) {
        const due = duePeriodOf(sd);
        const dueMs = Date.parse(due.dueAt);
        const graceEnd = Date.parse(due.graceEndsAt);
        if (now >= graceEnd || now < dueMs) continue;
        const title = titleOf(sd.post_id);
        const until = dayOf(graceEnd);
        const dayBefore = graceEnd - 86_400_000;
        const halfway = dueMs + (graceEnd - dueMs) / 2;
        let kind: string | null = null;
        let payerBody = '';
        let payeeBody = '';
        if (now >= dayBefore) {
            kind = 'standing_day_before';
            payerBody = standingLines.dayBeforePayer(title, sd.beans_per_period_c, nameOf(sd.payee_pubkey), until);
            payeeBody = standingLines.dayBeforePayee(sd.period_unit, nameOf(sd.payer_pubkey), title, sd.beans_per_period_c, until);
        } else if (sd.period_unit === 'month' && now >= halfway) {
            const days = Math.floor((now - dueMs) / 86_400_000);
            kind = 'standing_halfway';
            payerBody = standingLines.halfwayPayer(title, sd.beans_per_period_c, days, until);
            payeeBody = standingLines.halfwayPayee(nameOf(sd.payer_pubkey), sd.beans_per_period_c, title, days, until);
        }
        if (!kind || toldBefore(sd, kind, due.n)) continue;
        const k = kind;
        let told: StandingNotice[] = [];
        db.transaction(() => {
            told = [...keep([sd.payer_pubkey], payerBody, sd, k, { period: due.n }), ...keep([sd.payee_pubkey], payeeBody, sd, k, { period: due.n })];
        })();
        markTold(sd.id, k, due.n);
        tellStanding(hooks, told);
    }
}

/**
 * Ahead of the next period (3 days for a month, 1 day for a week), a payer whose Beans won't cover it is told, once a period.
 * A read only: the balance as it stands now, against the usable floor. The payee is never told the payer's balance.
 */
function warnAhead(hooks: StandingHooks, now: number): void {
    const soon = db.prepare(`SELECT * FROM standing_deals WHERE phase = 'paid' AND stopped_at IS NULL AND next_due_at > ? AND next_due_at <= ? ORDER BY next_due_at LIMIT 200`)
        .all(new Date(now).toISOString(), new Date(now + standingWarnAheadMs('month')).toISOString()) as StandingRow[];
    for (const sd of soon) {
        if (Date.parse(sd.next_due_at) - now > standingWarnAheadMs(sd.period_unit)) continue;
        if (countReached(sd, sd.periods_done)) continue;
        const period = sd.periods_done + 1;
        if (toldBefore(sd, 'standing_short_ahead', period)) continue;
        const { balance_c: balance, usableFloor_c: usableFloor } = hooks.getBalance(sd.payer_pubkey);
        const shortBy = usableFloor - (balance - sd.beans_per_period_c);
        if (!(shortBy > 0)) continue;
        const title = titleOf(sd.post_id);
        let told: StandingNotice[] = [];
        db.transaction(() => {
            told = keep([sd.payer_pubkey], standingLines.shortAheadNotice(title, sd.beans_per_period_c, nameOf(sd.payee_pubkey), dayOf(sd.next_due_at), shortBy), sd, 'standing_short_ahead', { period });
        })();
        markTold(sd.id, 'standing_short_ahead', period);
        tellStanding(hooks, told);
    }
}

// ── Stop, Extend (signed requests: routes/marketplace.ts) ───────────────────────────────────────────────────────────

/** A refusal from Stop or Extend: the status and the code go with the words. */
function refusal(status: number, code: string, message: string): Error {
    return Object.assign(new Error(message), { status, statusCode: status, code });
}

const STANDING_GONE_ERROR = 'This standing deal has ended, or is not yours.';

/** Whom `actor` stands for on a standing deal: the payer or the payee themselves, or a keeper of either. null: a stranger. */
function sideOf(hooks: Pick<EscrowCallbacks, 'canOperateTreasury'>, sd: StandingRow, actor: string): 'payer' | 'payee' | null {
    if (actor === sd.payer_pubkey) return 'payer';
    if (actor === sd.payee_pubkey) return 'payee';
    if (typeof hooks.canOperateTreasury === 'function') {
        if (hooks.canOperateTreasury(actor, sd.payer_pubkey)) return 'payer';
        if (hooks.canOperateTreasury(actor, sd.payee_pubkey)) return 'payee';
    }
    return null;
}

/** The standing deal as the routes answer it. */
export function standingDealView(id: string): Record<string, unknown> | null {
    const sd = readStanding(id);
    if (!sd) return null;
    return {
        id: sd.id, postId: sd.post_id, payerPublicKey: sd.payer_pubkey, payeePublicKey: sd.payee_pubkey, beansPerPeriod_c: sd.beans_per_period_c,
        unit: sd.period_unit, startsAt: sd.starts_at, maxPeriods: sd.max_periods, phase: sd.phase, periodsDone: sd.periods_done,
        currentTransactionId: sd.current_tx_id, nextDueAt: sd.next_due_at, shortSince: sd.short_since,
        stopped: !!sd.stopped_at, endedAt: sd.ended_at, endedReason: sd.ended_reason,
    };
}

/**
 * Stop (either side). Paid: the period already paid runs to its end, which the payee keeps, and nothing more is paid; the
 * other side is told when it stops. Short (in the grace, amendment §1): it ends at once, in one transaction, with no row ever
 * made for the unpaid period, so there is nothing to pay, refund or dispute; the other side is told (a push and a bell row)
 * and the record its line; the listing comes back.
 */
export function stopStandingDeal(hooks: EscrowCallbacks, id: string, actor: string): Record<string, unknown> {
    const sd = readStanding(id);
    const side = sd ? sideOf(hooks, sd, actor) : null;
    if (!sd || !side || sd.phase === 'ended') throw refusal(404, 'standing_gone', STANDING_GONE_ERROR);
    const at = new Date().toISOString();
    const title = titleOf(sd.post_id);
    const other = side === 'payer' ? sd.payee_pubkey : sd.payer_pubkey;
    const who = side === 'payer' ? sd.payer_pubkey : sd.payee_pubkey;
    let told: StandingNotice[] = [];
    let line: string | null = null;
    db.transaction(() => {
        const fresh = readStanding(id);
        if (!fresh || fresh.phase === 'ended' || fresh.stopped_at) return;
        if (fresh.phase === 'short') {
            const dueSince = dayOf(duePeriodOf(fresh).dueAt);
            const moved = db.prepare(`UPDATE standing_deals SET stopped_by = ?, stopped_at = ? WHERE id = ? AND phase = 'short' AND periods_done = ?`)
                .run(actor, at, id, fresh.periods_done);
            if (moved.changes !== 1 || !endStanding(fresh, 'stopped', at)) throw new Error('the standing deal moved on since it was read');
            const body = side === 'payer'
                ? standingLines.stoppedInGraceByPayer(sd.period_unit, nameOf(who), title, sd.beans_per_period_c, dueSince)
                : standingLines.stoppedInGraceByPayee(sd.period_unit, nameOf(who), title, sd.beans_per_period_c);
            told = keep([other], body, sd, 'standing_stopped', { period: duePeriodOf(fresh).n });
            line = standingLines.chatStoppedInGrace(sd.period_unit, nameOf(who), title, sd.beans_per_period_c, dueSince);
            return;
        }
        const moved = db.prepare(`UPDATE standing_deals SET stopped_by = ?, stopped_at = ? WHERE id = ? AND phase = 'paid' AND stopped_at IS NULL`).run(actor, at, id);
        if (moved.changes !== 1) return;
        told = keep([other], standingLines.stoppedBy(sd.period_unit, nameOf(who), title, dayOf(fresh.next_due_at)), sd, 'standing_stopped');
    })();
    if (line) chatLine(hooks, sd, line);
    tellStanding(hooks, told);
    return standingDealView(id)!;
}

/**
 * Extend (the payer): a new signed authorisation for the same standing deal, the same listing, payee, price, period and
 * start, with a larger count or none. It replaces the one the node holds.
 */
export function extendStandingDeal(hooks: EscrowCallbacks, id: string, actor: string, s: StandingStart): Record<string, unknown> {
    const sd = readStanding(id);
    const side = sd ? sideOf(hooks, sd, actor) : null;
    if (!sd || !side || sd.phase === 'ended') throw refusal(404, 'standing_gone', STANDING_GONE_ERROR);
    if (side !== 'payer') throw refusal(403, 'standing_payer_only', standingLines.payerOnly());
    const payload = s?.authorisation?.payload;
    const signature = s?.authorisation?.signature;
    const auth = parseStandingAuthorisation(payload);
    if (!auth || typeof signature !== 'string') throw authRefused('the extension is not a standing authorisation text');
    if (!signsFor(hooks, actor, sd.payer_pubkey) || !signedBy(payload as string, signature, actor)) throw authRefused('the extension is not signed by the payer');
    if (!hostIsOurs(auth.host, actor, s.requestHost)) throw authRefused(`the extension was signed for ${auth.host}`);
    const same = auth.standingId === sd.id && auth.listingId === sd.post_id && sameMember(auth.payee, sd.payee_pubkey) && auth.unit === sd.period_unit
        && auth.startsAt === sd.starts_at && auth.beansPerPeriod_c === sd.beans_per_period_c;
    if (!same) throw authRefused('the extension changes more than the count');
    const longer = auth.maxPeriods === null ? sd.max_periods !== null : sd.max_periods !== null && auth.maxPeriods > sd.max_periods;
    if (!longer) throw authRefused('the extension is not longer');
    if (payload === sd.auth_payload) throw authRefused('the extension is the same text');
    db.prepare(`UPDATE standing_deals SET max_periods = ?, auth_signer = ?, auth_signature = ?, auth_payload = ? WHERE id = ? AND phase != 'ended' AND auth_payload = ?`)
        .run(auth.maxPeriods, actor, signature, payload, id, sd.auth_payload);
    return standingDealView(id)!;
}

// ── A member gone, a listing removed ────────────────────────────────────────────────────────────────────────────────

/**
 * A member removed (adminPruneUser) or who deleted their account (purgeMemberSelf): every standing deal they pay or are paid
 * by ends at once (in the caller's transaction where there is one). Nothing of it is held, so nothing is left to settle.
 */
export function endStandingDealsOf(memberKey: string): number {
    const live = db.prepare(`SELECT * FROM standing_deals WHERE (payer_pubkey = ? OR payee_pubkey = ?) AND phase != 'ended'`).all(memberKey, memberKey) as StandingRow[];
    const at = new Date().toISOString();
    for (const sd of live) endStanding(sd, 'account_closed', at);
    return live.length;
}

/**
 * Its author removed the listing (engine/posts.ts removePost), in the caller's transaction: each standing deal on it stops
 * after the period already paid, or ends at once while short (nothing is paid for the unpaid period). Each side but the one
 * who removed it is told. Returns the notices, for tellStanding after the commit.
 */
export function stopStandingDealsOnListing(postId: string, by: string): StandingNotice[] {
    const live = db.prepare(`SELECT * FROM standing_deals WHERE post_id = ? AND phase != 'ended'`).all(postId) as StandingRow[];
    const at = new Date().toISOString();
    const told: StandingNotice[] = [];
    for (const sd of live) {
        const others = [sd.payer_pubkey, sd.payee_pubkey].filter((k) => k !== by);
        const title = titleOf(sd.post_id);
        if (sd.phase === 'short') {
            db.prepare(`UPDATE standing_deals SET stopped_by = COALESCE(stopped_by, ?), stopped_at = COALESCE(stopped_at, ?) WHERE id = ?`).run(by, at, sd.id);
            endStanding(sd, 'listing_gone', at);
            told.push(...keep(others, standingLines.ended(title), sd, 'standing_ended', { reason: 'listing_gone' }));
        } else if (!sd.stopped_at) {
            db.prepare(`UPDATE standing_deals SET stopped_by = ?, stopped_at = ? WHERE id = ? AND stopped_at IS NULL`).run(by, at, sd.id);
            told.push(...keep(others, standingLines.stoppedBy(sd.period_unit, nameOf(by), title, dayOf(sd.next_due_at)), sd, 'standing_stopped'));
        }
    }
    return told;
}

/**
 * A moderator removed the listing (engine/posts.ts adminDeletePost: an admin's removal, a report resolved with removal,
 * Prune Stale Posts, an assistant's takedown made final), in its transaction: every standing deal still running on it ends
 * now, and both sides are told. The periods already paid stay paid. Returns the notices, for tellStanding after the commit.
 */
export function endStandingDealsOnRemovedListing(postId: string, at: string): StandingNotice[] {
    const live = db.prepare(`SELECT * FROM standing_deals WHERE post_id = ? AND phase != 'ended'`).all(postId) as StandingRow[];
    const told: StandingNotice[] = [];
    for (const sd of live) {
        endStanding(sd, 'listing_gone', at);
        told.push(...keep([sd.payer_pubkey, sd.payee_pubkey], standingLines.ended(titleOf(sd.post_id)), sd, 'standing_ended', { reason: 'listing_gone' }));
    }
    return told;
}

/**
 * The payer's live standing deals that keep them from holiday mode: a payer stays blocked ("Stop your standing deal for …
 * first"); a payee may go away while theirs run. Returns the listing title of the first, or null.
 */
export function standingDealBlockingHoliday(memberKey: string): string | null {
    const sd = db.prepare(`SELECT post_id FROM standing_deals WHERE payer_pubkey = ? AND phase != 'ended' LIMIT 1`).get(memberKey) as { post_id: string } | undefined;
    return sd ? titleOf(sd.post_id) || '' : null;
}

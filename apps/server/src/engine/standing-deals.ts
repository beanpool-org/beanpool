// Standing deals: paying for something by the week or by the month (scratch/fable-design/DESIGN-standing-deals-fable.md;
// Marty's decisions, 9 Nov 2026). TIER A: Beans move on a timer, with no fresh tap.
//
// THE MODEL. A listing priced per week or per month, taken up with `standing` (acceptPost on an Offer, approvePostRequest on
// a Need, engine/escrow.ts), is a standing deal: one period's Beans in trust at a time. At the start the first period is held,
// as any deal holds its Beans. At each period's end this node's minute tick releases those Beans to the payee (less the 1.5%
// to the Commons, by the release every deal uses: escrow.ts releaseHeld) and holds the next period's (escrow.ts openHold),
// unless the payer tapped Hold back or either side tapped Stop. Every period is an ordinary deal row (Release, Cancel hold,
// disputes, Ledger rows, chat lines unchanged), numbered in marketplace_transactions.period_no; the arrangement is one row of
// standing_deals (schema.sql).
//
// CONSENT (§6). The payer signs one standing authorisation with their key at the start (@beanpool/core
// standingAuthorisationText): the host, the standing deal's id, the listing, the payee, the Beans per period, the period, how
// many periods and the start. The node keeps the text, its signature and its signer, and every hold it makes is read back
// against it: the amount, the payee, the listing, the period's number against the count, and the period's dates. A hold that
// doesn't match is never made. Each hold's ledger row names the signer and `standing:<id>:<n>` (auth_payload), so SRV-20's
// verifier can later resolve it to the stored signed text.
//
// THE TWO STEPS (§5). Each its own conservingTransaction, each a compare-and-swap on the standing row's phase and
// periods_done, so a period is settled at most once and held at most once whatever runs twice: SETTLE ('held' → 'due',
// periods_done + 1, the release in the same transaction; the release also needs the row's status='pending' to change one row)
// and HOLD ('due'/'short' → 'held', the new row's UNIQUE (standing_id, period_no) refusing a second). A crash between them
// leaves 'due' and the next tick finishes it. Every guard acceptPost (or approvePostRequest) runs is run again before a hold
// (escrow.ts offerHoldChecks, requestHoldChecks); a refusal that means the payer is short of Beans (the floor, a frozen
// credit line) makes the phase 'short': both told, tried again hourly for 7 days, the payee may stop it at once, then it ends
// with nothing owed through the app. Any other refusal means it can't carry on: it ends, and both are told.
//
// NEVER PAY OR SKIP SILENTLY. A period whose end is more than one whole period past (the server was away, or its clock leapt)
// is not settled by the node: it is held back ('node_held') for a person to release or cancel, and both are told. A next
// period that would already be over when held is not held: the standing deal ends. A clock that goes back finds nothing due.
//
// WHERE. On a main server only, from its minute tick (state-engine.ts armMainServerTimers), never on a standby (whose copy of
// this row is its main server's: a promoted standby carries on from it); where Beans are switched off it logs once and moves
// nothing.

import crypto from 'node:crypto';
import {
    STANDING_GRACE_MS, STANDING_REMINDER_AFTER_MS, STANDING_RETRY_MS, STANDING_START_AHEAD_MS, parseStandingAuthorisation, periodEnd,
    standingAuthorisationText, standingHoldPayload, standingLines, standingUnitOf, standingWarnAheadMs, type PushNoticeKind,
    type StandingAuthorisation, type StandingEndReason, type StandingHeldBackReason, type StandingPeriodUnit,
} from '@beanpool/core';
import { getPosts, getMarketplaceTransaction } from '@beanpool/engine';
import { db } from '../db/db.js';
import { getNodeRole } from '../config/node-role.js';
import { assertFeatureOn, getProfileSwitches } from '../config/node-profile.js';
import { keepNotice } from './kept-notices.js';
import { marketplacePostOutOfSight } from './post-sight.js';
import { audienceRefusal } from './member-signature.js';
import { audienceStanding, isLocalNetworkHost, normalizeAddress } from './own-addresses.js';
import {
    afterRelease, assertBuyerMayTrade, isShortRefusal, offerHoldChecks, openHold, releaseHeld, requestHoldChecks, type EscrowCallbacks, type HoldParties,
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

/** The refusal of a standing start whose authorisation doesn't match (400 standing_auth, §2.3). */
export const STANDING_AUTH_CODE = 'standing_auth';
function authRefused(why: string): Error {
    console.warn(`[Standing] A standing start was refused: ${why}.`);
    return Object.assign(new Error(standingLines.authMismatch()), { status: 400, statusCode: 400, code: STANDING_AUTH_CODE });
}

/** An ed25519 signature (base64 or hex) by a member's key (64 hex) over the text's UTF-8 bytes. */
function signedBy(text: string, signature: string, pubKeyHex: string): boolean {
    try {
        if (!/^[0-9a-f]{64}$/.test(pubKeyHex) || typeof signature !== 'string' || !signature) return false;
        const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubKeyHex, 'hex')]), format: 'der', type: 'spki' });
        const sig = Buffer.from(signature.trim(), /^[0-9a-fA-F]{128}$/.test(signature.trim()) ? 'hex' : 'base64');
        return sig.length === 64 && crypto.verify(null, Buffer.from(text, 'utf-8'), key, sig);
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
 * Check a standing start before anything is written (§6): the listing is priced per week or per month; the text is one
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
    if (Math.round(deal.price * 100) !== Math.round(auth.beansPerPeriod * 100) || Math.abs(deal.price - auth.beansPerPeriod) > 1e-9) {
        throw authRefused(`it is ${auth.beansPerPeriod} Beans a period, the listing ${deal.price}`);
    }
    if (s.untilStopped === true && auth.maxPeriods !== null) throw authRefused('the app said until stopped, the text a count');
    if (s.periods !== undefined && s.periods !== auth.maxPeriods) throw authRefused('the app\'s count is not the text\'s');
    if (s.startsAt !== undefined && s.startsAt !== auth.startsAt) throw authRefused('the app\'s start is not the text\'s');
    const startMs = Date.parse(auth.startsAt);
    if (startMs < now - 10 * 60 * 1000 || startMs > now + STANDING_START_AHEAD_MS) throw authRefused('its start is not between now and 30 days ahead');
    if (db.prepare('SELECT 1 FROM standing_deals WHERE id = ?').get(auth.standingId)) throw authRefused('its id is taken');
    return { auth, payer: deal.payer, payee: deal.payee, signer, payload: payload as string, signature };
}

/** The standing row for a start, its first period `txId` held: INSIDE the hold's conservingTransaction (escrow.ts). */
export function insertStandingDeal(v: CheckedStandingStart, txId: string): void {
    db.prepare(`INSERT INTO standing_deals (id, post_id, payer_pubkey, payee_pubkey, beans_per_period, period_unit, starts_at, max_periods, phase,
                    periods_done, current_tx_id, next_due_at, auth_signer, auth_signature, auth_payload)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held', 0, ?, ?, ?, ?, ?)`)
        .run(v.auth.standingId, v.auth.listingId, v.payer, v.payee, v.auth.beansPerPeriod, v.auth.unit, v.auth.startsAt, v.auth.maxPeriods,
            txId, periodEnd(v.auth.startsAt, v.auth.unit, 1), v.signer, v.signature, v.payload);
}

interface StandingRow {
    id: string;
    post_id: string;
    payer_pubkey: string;
    payee_pubkey: string;
    beans_per_period: number;
    period_unit: StandingPeriodUnit;
    starts_at: string;
    max_periods: number | null;
    phase: 'held' | 'due' | 'short' | 'held_back' | 'ended';
    periods_done: number;
    current_tx_id: string | null;
    next_due_at: string;
    short_since: string | null;
    held_back_reason: StandingHeldBackReason | null;
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
const dayOf = (iso: string): string => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Keep a notice for each of `to` in the caller's transaction; tellStanding sends them after the commit. */
function keep(to: string[], body: string, sd: { id: string; post_id: string }, kind: string, extra: Record<string, unknown> = {}): StandingNotice[] {
    const title = standingLines.noticeTitle();
    const data = { kind, standing: sd.id, postId: sd.post_id, ...extra };
    return to.map((who) => ({ to: who, title, body, data, id: keepNotice(who, title, body, data) }));
}

/** After the commit: each notice live to its member's own sockets with its kept copy's id, and a push of kind community.notice. */
export function tellStanding(hooks: Pick<EscrowCallbacks, 'broadcast' | 'dispatchPushNotification'>, notices: StandingNotice[]): void {
    for (const n of notices) {
        try {
            hooks.broadcast({ type: 'system_announcement', title: n.title, body: n.body, severity: 'info', ...n.data, ...(n.id ? { noticeId: n.id } : {}) }, [n.to]);
        } catch (e: any) {
            console.warn('[Standing] A live notice failed:', e?.message || e);
        }
        try {
            hooks.dispatchPushNotification([n.to], 'SYSTEM', n.title, n.body, { screen: 'post', postId: n.data.postId }, 'escrow', 'community.notice' as PushNoticeKind);
        } catch (e: any) {
            console.warn('[Standing] A push failed:', e?.message || e);
        }
    }
}

/**
 * A one-off listing the standing deal took off the board goes back on it once nothing of the standing deal is held (unless
 * its author removed it, or a prune cancelled it): the thing is free to take up again.
 */
function listingBack(sd: { id: string; post_id: string }, at: string): void {
    db.prepare(`UPDATE posts SET status = 'active', accepted_by = NULL, accepted_at = NULL, pending_transaction_id = NULL, updated_at = ?
                WHERE id = ? AND status = 'pending'
                  AND pending_transaction_id IN (SELECT id FROM marketplace_transactions WHERE standing_id = ? AND status != 'pending')`)
        .run(at, sd.post_id, sd.id);
}

/** End a standing deal (the caller's transaction): nothing more is held. Its listing comes back once nothing of it is held. */
function endStanding(sd: StandingRow, reason: StandingEndReason, at: string): void {
    db.prepare(`UPDATE standing_deals SET phase = 'ended', ended_at = ?, ended_reason = ?, held_back_reason = NULL WHERE id = ? AND phase != 'ended'`).run(at, reason, sd.id);
    listingBack(sd, at);
}

/** Whether the next period would be past the count the payer signed for. */
const countReached = (sd: StandingRow, settled: number): boolean => sd.max_periods !== null && settled >= sd.max_periods;

/**
 * A standing deal's period settled by a person or a ruling (escrow.ts completePostTransaction, cancelPostTransaction,
 * resolveEscrowDispute), INSIDE their conservingTransaction. Released: it carries on from the period's end, dates unchanged
 * (held back by the payer, or by the node because its server was away), or ends (stopped, the count reached, or held back
 * because it couldn't carry on). Refunded, or a ruling against the payee: it ends (§1.2, §1.3). Returns the notices.
 */
export function standingPeriodSettled(row: { id: string; standing_id: string | null; period_no: number | null }, outcome: 'released' | 'refunded', at: string): StandingNotice[] {
    if (!row.standing_id) return [];
    const sd = readStanding(row.standing_id);
    if (!sd || sd.current_tx_id !== row.id) return [];
    if (sd.phase === 'ended') {
        listingBack(sd, at);
        return [];
    }
    const title = titleOf(sd.post_id);
    const both = [sd.payer_pubkey, sd.payee_pubkey];
    if (outcome === 'refunded') {
        endStanding(sd, 'cancelled', at);
        return keep(both, standingLines.ended(title), sd, 'standing_ended', { reason: 'cancelled' });
    }
    const n = Number(row.period_no) || sd.periods_done + 1;
    db.prepare('UPDATE standing_deals SET periods_done = ? WHERE id = ?').run(n, sd.id);
    const reason: StandingEndReason | null = sd.stopped_at ? 'stopped'
        : countReached(sd, n) ? 'count_reached'
        : sd.held_back_reason === 'listing_hidden' ? 'listing_gone'
        : sd.held_back_reason === 'cant_run' ? 'cant_run'
        : null;
    if (reason) {
        endStanding(sd, reason, at);
        return keep(both, standingLines.ended(title), sd, 'standing_ended', { reason });
    }
    db.prepare(`UPDATE standing_deals SET phase = 'due', held_back_reason = NULL, short_since = NULL, next_due_at = ? WHERE id = ?`)
        .run(periodEnd(sd.starts_at, sd.period_unit, n), sd.id);
    return [];
}

/** The refusal of a payer's Release on a period running by itself (§1.2: the node releases it at its end). */
export const STANDING_RUNS_ITSELF_CODE = 'standing_runs_itself';
export function assertNotRunningStandingPeriod(row: { id: string; standing_id: string | null }): void {
    if (!row.standing_id) return;
    const sd = readStanding(row.standing_id);
    if (sd && sd.current_tx_id === row.id && sd.phase === 'held') {
        throw Object.assign(new Error(standingLines.releaseByItself(sd.period_unit)), { status: 409, statusCode: 409, code: STANDING_RUNS_ITSELF_CODE });
    }
}

// ── The tick (§5) ─────────────────────────────────────────────────────────────────────────────────────────────────

/** What the tick needs of the node: escrow's own callbacks, and the enterprise floor cache to clear after a release. */
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

/** For a suite: forget what was logged, as a restart does. */
export function resetStandingLogs(): void {
    loggedOnce.clear();
    loggedBeansOff = false;
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

/** The authorisation the row holds, read back, and whether it bounds the row as the row stands (§6). */
function boundsRow(sd: StandingRow): boolean {
    const a = parseStandingAuthorisation(sd.auth_payload);
    return !!a && a.standingId === sd.id && a.listingId === sd.post_id && sameMember(a.payee, sd.payee_pubkey) && a.unit === sd.period_unit
        && a.startsAt === sd.starts_at && a.maxPeriods === sd.max_periods && Math.abs(a.beansPerPeriod - sd.beans_per_period) < 1e-9
        && standingAuthorisationText(a) === sd.auth_payload;
}

/**
 * Run every standing deal that is due at `now`: settle the periods that have ended and hold the next, try again for the short
 * ones, and tell payers who will be short ahead of time. On a main server, from its minute tick. Never throws.
 */
export function tickStandingDeals(hooks: StandingHooks, now: number = Date.now()): { settled: number; held: number; short: number; ended: number } {
    const out = { settled: 0, held: 0, short: 0, ended: 0 };
    if (getNodeRole() === 'backup') return out;
    let due: StandingRow[];
    try {
        due = db.prepare(`SELECT * FROM standing_deals WHERE phase IN ('held', 'due', 'short') AND next_due_at <= ? ORDER BY next_due_at LIMIT 200`)
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
    for (const row of due) {
        try {
            let sd: StandingRow | undefined = row;
            if (sd.phase === 'held') {
                const r = settle(hooks, sd, now);
                if (r === 'settled' || r === 'settled-ended') out.settled++;
                if (r === 'settled-ended') out.ended++;
                sd = readStanding(row.id);
            }
            if (sd && (sd.phase === 'due' || sd.phase === 'short') && Date.parse(sd.next_due_at) <= now) {
                const r = holdNext(hooks, sd, now);
                if (r === 'held') out.held++;
                else if (r === 'short') out.short++;
                else if (r === 'ended') out.ended++;
            }
        } catch (e: any) {
            logOnce(row.id, `standing deal ${row.id} could not be run: ${e?.message || e}`);
        }
    }
    try { warnAhead(hooks, now); } catch (e: any) { console.warn('[Standing] The short-ahead notices failed:', e?.message || e); }
    return out;
}

/** Hold a period back by the node (the caller's transaction is opened here): a person settles it; both are told. */
function holdBackByNode(hooks: StandingHooks, sd: StandingRow, reason: StandingHeldBackReason, body: string): 'held_back' {
    let told: StandingNotice[] = [];
    db.transaction(() => {
        const moved = db.prepare(`UPDATE standing_deals SET phase = 'held_back', held_back_reason = ? WHERE id = ? AND phase = 'held' AND periods_done = ?`)
            .run(reason, sd.id, sd.periods_done);
        if (moved.changes === 1) told = keep([sd.payer_pubkey, sd.payee_pubkey], body, sd, 'standing_held_back', { reason });
    })();
    tellStanding(hooks, told);
    return 'held_back';
}

/** The period under way has ended: release it to the payee (step 1), or hold it back for a person when that isn't safe. */
function settle(hooks: StandingHooks, sd: StandingRow, now: number): 'settled' | 'settled-ended' | 'held_back' {
    const n = sd.periods_done + 1;
    const title = titleOf(sd.post_id);
    const row = sd.current_tx_id ? db.prepare('SELECT * FROM marketplace_transactions WHERE id = ?').get(sd.current_tx_id) as any : null;
    // The row must be this period's, held, for no more than the authorisation allows, between these two.
    if (!row || row.status !== 'pending' || row.standing_id !== sd.id || row.period_no !== n || row.buyer_pubkey !== sd.payer_pubkey
        || row.seller_pubkey !== sd.payee_pubkey || !(row.credits <= sd.beans_per_period + 1e-9) || !boundsRow(sd)) {
        logOnce(sd.id, `standing deal ${sd.id}: period ${n}'s row does not match its authorisation, so the node does not release it`);
        return holdBackByNode(hooks, sd, 'cant_run', standingLines.cantRunHeld(title));
    }
    // More than one whole period late (the server was away, or its clock leapt): a person settles it (§5).
    if (now >= Date.parse(periodEnd(sd.starts_at, sd.period_unit, n + 1))) {
        return holdBackByNode(hooks, sd, 'node_held', standingLines.nodeHeld(title, nameOf(sd.payee_pubkey)));
    }
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(sd.post_id) as any;
    if (post?.hidden_by_reports_at) return holdBackByNode(hooks, sd, 'listing_hidden', standingLines.listingHidden(title));
    try {
        assertFeatureOn('escrow');
    } catch {
        return holdBackByNode(hooks, sd, 'cant_run', standingLines.cantRunHeld(title));
    }

    const completedAt = new Date(now).toISOString();
    let released: { releaseResult: any; releaseCredits: number } | null = null;
    let ended = false;
    let told: StandingNotice[] = [];
    hooks.conservingTransaction(() => {
        const moved = db.prepare(`UPDATE standing_deals SET phase = 'due', periods_done = periods_done + 1, next_due_at = ? WHERE id = ? AND phase = 'held' AND periods_done = ?`)
            .run(periodEnd(sd.starts_at, sd.period_unit, n), sd.id, sd.periods_done);
        if (moved.changes !== 1) throw new Error('the standing deal moved on since it was read');
        released = releaseHeld(hooks, row, post, { completedAt, credits: row.credits, memo: standingLines.memo(sd.period_unit, title, n), listing: 'keep' });
        const reason: StandingEndReason | null = sd.stopped_at ? 'stopped' : countReached(sd, n) ? 'count_reached' : null;
        if (reason) {
            endStanding(sd, reason, completedAt);
            ended = true;
            told = keep([sd.payer_pubkey, sd.payee_pubkey], standingLines.ended(title), sd, 'standing_ended', { reason });
        }
    });
    afterRelease(hooks, row, post, released!, 'SYSTEM');
    hooks.clearEnterpriseFloorCache?.();
    tellStanding(hooks, told);
    loggedOnce.delete(sd.id);
    return ended ? 'settled-ended' : 'settled';
}

/** Why a scheduled hold can't be made at all, from the refusal: the standing deal ends with it. */
function endReasonOf(sd: StandingRow): StandingEndReason {
    const post = db.prepare('SELECT status, active, hidden_by_reports_at FROM posts WHERE id = ?').get(sd.post_id) as any;
    if (!post || post.active !== 1 || post.status === 'cancelled' || post.status === 'completed' || post.hidden_by_reports_at) return 'listing_gone';
    const closed = db.prepare(`SELECT 1 FROM members WHERE public_key IN (?, ?) AND status IN ('pruned', 'disabled', 'completed')`).get(sd.payer_pubkey, sd.payee_pubkey);
    return closed ? 'account_closed' : 'cant_run';
}

/** End it from the tick, with its notice to both. */
function endFromTick(hooks: StandingHooks, sd: StandingRow, reason: StandingEndReason, body: (title: string) => string): 'ended' {
    let told: StandingNotice[] = [];
    const at = new Date().toISOString();
    db.transaction(() => {
        const fresh = readStanding(sd.id);
        if (!fresh || fresh.phase === 'ended' || fresh.periods_done !== sd.periods_done) return;
        endStanding(fresh, reason, at);
        told = keep([sd.payer_pubkey, sd.payee_pubkey], body(titleOf(sd.post_id)), sd, 'standing_ended', { reason });
    })();
    tellStanding(hooks, told);
    return 'ended';
}

/**
 * Every guard the door that started it runs, again (§0), for its next period: acceptPost's on an Offer, approvePostRequest's
 * on a Need. Throws the refusal; isShortRefusal tells a short payer from one who can't carry on.
 */
function scheduledChecks(hooks: StandingHooks, sd: StandingRow): HoldParties & { oneAtATime: boolean } {
    assertFeatureOn('escrow');
    const raw = db.prepare('SELECT * FROM posts WHERE id = ?').get(sd.post_id) as any;
    if (!raw) throw new Error('its listing is gone');
    // Running deals carry on while their listing is paused (§1.5); a one-off listing stays taken by its standing deal.
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
        const p = offerHoldChecksScheduled(hooks, post, sd, scheduled);
        return { ...p, oneAtATime: !raw.repeatable };
    }
    const deal = { id: sd.current_tx_id ?? '', post_id: sd.post_id, buyer_pubkey: sd.payer_pubkey, seller_pubkey: sd.payee_pubkey, credits: sd.beans_per_period };
    const p = requestHoldChecks(hooks, deal, raw, sd.payer_pubkey, { authSigner: currentKeyOf(sd.auth_signer), scheduled });
    if (!p) throw new Error('its payer is no longer the listing\'s author');
    return p;
}

function offerHoldChecksScheduled(hooks: StandingHooks, post: any, sd: StandingRow, scheduled: { standingId: string }): HoldParties {
    assertBuyerMayTrade(sd.payer_pubkey);
    if (post.authorPublicKey !== sd.payee_pubkey) throw new Error('its listing has another author');
    return offerHoldChecks(hooks, post, sd.payer_pubkey, () => sd.beans_per_period, { authSigner: currentKeyOf(sd.auth_signer), scheduled });
}

/** The next period's Beans (step 2), or the short path, or the end. */
function holdNext(hooks: StandingHooks, sd: StandingRow, now: number): 'held' | 'short' | 'ended' | 'skipped' {
    const n = sd.periods_done + 1;
    if (sd.stopped_at) return endFromTick(hooks, sd, 'stopped', standingLines.ended);
    if (countReached(sd, sd.periods_done)) return endFromTick(hooks, sd, 'count_reached', standingLines.ended);
    if (!boundsRow(sd)) {
        logOnce(sd.id, `standing deal ${sd.id}: its row no longer matches the authorisation it holds, so no period is held`);
        return endFromTick(hooks, sd, 'cant_run', standingLines.cantRun);
    }
    const graceOver = sd.phase === 'short' && sd.short_since && now >= Date.parse(sd.short_since) + STANDING_GRACE_MS;
    const pEnd = periodEnd(sd.starts_at, sd.period_unit, n);
    if (graceOver || (sd.phase === 'short' && now >= Date.parse(pEnd))) {
        return endShort(hooks, sd);
    }
    // A period already over is never held (§5): the server was away for longer than it.
    if (now >= Date.parse(pEnd)) return endFromTick(hooks, sd, 'node_held', standingLines.nodeHeldEnded);

    let parties: HoldParties & { oneAtATime: boolean };
    try {
        parties = scheduledChecks(hooks, sd);
    } catch (e: any) {
        if (isShortRefusal(e)) return markShort(hooks, sd, now);
        console.warn(`[Standing] Standing deal ${sd.id} can't carry on: ${e?.message || e}`);
        return endFromTick(hooks, sd, endReasonOf(sd), standingLines.cantRun);
    }

    const title = titleOf(sd.post_id);
    const txId = crypto.randomUUID();
    const createdAt = new Date(now).toISOString();
    let told: StandingNotice[] = [];
    try {
        hooks.conservingTransaction(() => {
            openHold(hooks, {
                txId,
                postId: sd.post_id,
                parties,
                amount: sd.beans_per_period,
                memo: standingLines.memo(sd.period_unit, title, n),
                auth: { signer: sd.auth_signer, payload: standingHoldPayload(sd.id, n) },
                row: 'insert',
                createdAt,
                takeListing: parties.oneAtATime ? { gone: 'its listing is no longer up' } : null,
                standing: { id: sd.id, periodNo: n },
            });
            const moved = db.prepare(`UPDATE standing_deals SET phase = 'held', current_tx_id = ?, next_due_at = ?, short_since = NULL
                                      WHERE id = ? AND phase IN ('due', 'short') AND periods_done = ?`).run(txId, pEnd, sd.id, sd.periods_done);
            if (moved.changes !== 1) throw new Error('the standing deal moved on since it was read');
            if (sd.phase === 'short') {
                told = [
                    ...keep([sd.payer_pubkey], standingLines.coveredPayer(sd.period_unit, title, sd.beans_per_period), sd, 'standing_covered'),
                    ...keep([sd.payee_pubkey], standingLines.coveredPayee(sd.period_unit, title, sd.beans_per_period), sd, 'standing_covered'),
                ];
            }
            if (sd.max_periods !== null && n === sd.max_periods) {
                told.push(...keep([sd.payer_pubkey, sd.payee_pubkey], standingLines.lastPeriod(sd.period_unit, title, dayOf(pEnd)), sd, 'standing_last_period'));
            }
        });
    } catch (e: any) {
        if (isShortRefusal(e)) return markShort(hooks, sd, now);
        logOnce(sd.id, `holding period ${n} of standing deal ${sd.id} failed and was rolled back: ${e?.message || e}`);
        return 'skipped';
    }
    loggedOnce.delete(sd.id);
    const tx = getMarketplaceTransaction(db, txId);
    try {
        hooks.broadcast({ type: 'post_accepted', postId: sd.post_id, transaction: tx }, [sd.payer_pubkey, sd.payee_pubkey], { othersGetDoorbell: true });
        hooks.injectSystemMessage(sd.post_id, hooks.SystemMessageType.ESCROW_FUNDED, {
            amount: sd.beans_per_period, postId: sd.post_id, transactionId: txId, actorPubkey: 'SYSTEM', buyerPubkey: sd.payer_pubkey, sellerPubkey: sd.payee_pubkey,
        }, sd.payer_pubkey, sd.payee_pubkey);
    } catch (e: any) {
        console.warn('[Standing] The held period could not be announced:', e?.message || e);
    }
    tellStanding(hooks, told);
    return 'held';
}

/** When the week of grace ends, from the first refusal. */
const graceEnd = (shortSince: string): string => new Date(Date.parse(shortSince) + STANDING_GRACE_MS).toISOString();

/** The next period couldn't be held: short, tried again in an hour; both told the first time, the payer once more on day 3. */
function markShort(hooks: StandingHooks, sd: StandingRow, now: number): 'short' {
    const nowIso = new Date(now).toISOString();
    const since = sd.short_since ?? nowIso;
    const title = titleOf(sd.post_id);
    const until = dayOf(graceEnd(since));
    let told: StandingNotice[] = [];
    db.transaction(() => {
        // Tried again in an hour, but never later than the week's end: it ends on time, not at the next hourly try.
        const retryAt = Math.min(now + STANDING_RETRY_MS, Date.parse(since) + STANDING_GRACE_MS);
        const moved = db.prepare(`UPDATE standing_deals SET phase = 'short', short_since = ?, next_due_at = ? WHERE id = ? AND phase IN ('due', 'short') AND periods_done = ?`)
            .run(since, new Date(retryAt).toISOString(), sd.id, sd.periods_done);
        if (moved.changes !== 1) return;
        const period = sd.periods_done + 1;
        if (!sd.short_since) {
            told = [
                ...keep([sd.payer_pubkey], standingLines.notHeldPayer(sd.period_unit, title, sd.beans_per_period, until), sd, 'standing_short', { period }),
                ...keep([sd.payee_pubkey], standingLines.notHeldPayee(sd.period_unit, nameOf(sd.payer_pubkey), title, until), sd, 'standing_short', { period }),
            ];
        } else if (now >= Date.parse(since) + STANDING_REMINDER_AFTER_MS && !toldBefore(sd.payer_pubkey, sd.id, 'standing_still_short', period)) {
            told = keep([sd.payer_pubkey], standingLines.stillShort(title, sd.beans_per_period, until), sd, 'standing_still_short', { period });
        }
    })();
    tellStanding(hooks, told);
    return 'short';
}

/** The week of grace is over: it ends, and nothing is owed through the app for the days since the period was due. */
function endShort(hooks: StandingHooks, sd: StandingRow): 'ended' {
    const title = titleOf(sd.post_id);
    const dueSince = dayOf(periodEnd(sd.starts_at, sd.period_unit, Math.max(1, sd.periods_done)));
    let told: StandingNotice[] = [];
    const at = new Date().toISOString();
    db.transaction(() => {
        const fresh = readStanding(sd.id);
        if (!fresh || fresh.phase !== 'short' || fresh.periods_done !== sd.periods_done) return;
        endStanding(fresh, 'short', at);
        told = [
            ...keep([sd.payer_pubkey], standingLines.endedShortPayer(sd.period_unit, title, nameOf(sd.payee_pubkey)), sd, 'standing_ended', { reason: 'short' }),
            ...keep([sd.payee_pubkey], standingLines.endedShortPayee(sd.period_unit, nameOf(sd.payer_pubkey), title, dueSince), sd, 'standing_ended', { reason: 'short' }),
        ];
    })();
    tellStanding(hooks, told);
    return 'ended';
}

/** Whether a member has a kept notice of this kind for this standing deal and period. */
function toldBefore(recipient: string, standingId: string, kind: string, period: number): boolean {
    return !!db.prepare(`SELECT 1 FROM moderation_notices WHERE recipient = ?
                           AND CASE WHEN json_valid(data) THEN json_extract(data, '$.kind') = ? AND json_extract(data, '$.standing') = ?
                               AND json_extract(data, '$.period') = ? ELSE 0 END LIMIT 1`).get(recipient, kind, standingId, period);
}

/**
 * Ahead of the next period (3 days for a month, 1 day for a week), a payer whose Beans won't cover it is told, once a period
 * (§3). A read only: the balance as it stands now, against the usable floor. The payee is never told the payer's balance.
 */
function warnAhead(hooks: StandingHooks, now: number): void {
    const soon = db.prepare(`SELECT * FROM standing_deals WHERE phase = 'held' AND stopped_at IS NULL AND next_due_at > ? AND next_due_at <= ? ORDER BY next_due_at LIMIT 200`)
        .all(new Date(now).toISOString(), new Date(now + standingWarnAheadMs('month')).toISOString()) as StandingRow[];
    for (const sd of soon) {
        if (Date.parse(sd.next_due_at) - now > standingWarnAheadMs(sd.period_unit)) continue;
        if (countReached(sd, sd.periods_done + 1)) continue;
        const period = sd.periods_done + 2;
        if (toldBefore(sd.payer_pubkey, sd.id, 'standing_short_ahead', period)) continue;
        const { balance, usableFloor } = hooks.getBalance(sd.payer_pubkey);
        const shortBy = usableFloor - (balance - sd.beans_per_period);
        if (!(shortBy > 1e-9)) continue;
        const title = titleOf(sd.post_id);
        let told: StandingNotice[] = [];
        db.transaction(() => {
            told = keep([sd.payer_pubkey], standingLines.shortAheadNotice(sd.period_unit, title, sd.beans_per_period, dayOf(sd.next_due_at), shortBy), sd, 'standing_short_ahead', { period });
        })();
        tellStanding(hooks, told);
    }
}

// ── Stop, Hold back, Extend (§1.2, §1.3; signed requests: routes/marketplace.ts) ─────────────────────────────────────

/** A refusal from Stop, Hold back or Extend: the status and the code go with the words. */
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
        id: sd.id, postId: sd.post_id, payerPublicKey: sd.payer_pubkey, payeePublicKey: sd.payee_pubkey, beansPerPeriod: sd.beans_per_period,
        unit: sd.period_unit, startsAt: sd.starts_at, maxPeriods: sd.max_periods, phase: sd.phase, periodsDone: sd.periods_done,
        currentTransactionId: sd.current_tx_id, nextDueAt: sd.next_due_at, shortSince: sd.short_since, heldBackReason: sd.held_back_reason,
        stopped: !!sd.stopped_at, endedAt: sd.ended_at, endedReason: sd.ended_reason,
    };
}

/**
 * Stop (either side, §1.3): the period under way is still paid at its end and nothing more is held. With nothing held (between
 * its steps, or short) it ends at once. The other side is told.
 */
export function stopStandingDeal(hooks: EscrowCallbacks, id: string, actor: string): Record<string, unknown> {
    const sd = readStanding(id);
    const side = sd ? sideOf(hooks, sd, actor) : null;
    if (!sd || !side || sd.phase === 'ended') throw refusal(404, 'standing_gone', STANDING_GONE_ERROR);
    const at = new Date().toISOString();
    let told: StandingNotice[] = [];
    db.transaction(() => {
        const moved = db.prepare(`UPDATE standing_deals SET stopped_by = ?, stopped_at = ? WHERE id = ? AND phase != 'ended' AND stopped_at IS NULL`).run(actor, at, id);
        if (moved.changes !== 1) return;
        const fresh = readStanding(id)!;
        if (fresh.phase === 'due' || fresh.phase === 'short') endStanding(fresh, 'stopped', at);
        const other = side === 'payer' ? sd.payee_pubkey : sd.payer_pubkey;
        const who = side === 'payer' ? sd.payer_pubkey : sd.payee_pubkey;
        told = keep([other], standingLines.stoppedBy(sd.period_unit, nameOf(who), titleOf(sd.post_id)), sd, 'standing_stopped');
    })();
    tellStanding(hooks, told);
    return standingDealView(id)!;
}

/**
 * Hold back (the payer, or a keeper of an enterprise payer, §1.2): the period under way stays held as a plain deal (Release,
 * Cancel hold, dispute), and the schedule waits until it is settled. The payee is told.
 */
export function holdBackStandingDeal(hooks: EscrowCallbacks, id: string, actor: string): Record<string, unknown> {
    const sd = readStanding(id);
    const side = sd ? sideOf(hooks, sd, actor) : null;
    if (!sd || !side || sd.phase === 'ended') throw refusal(404, 'standing_gone', STANDING_GONE_ERROR);
    if (side !== 'payer') throw refusal(403, 'standing_payer_only', standingLines.payerOnly());
    if (sd.phase !== 'held') throw refusal(409, 'standing_not_running', standingLines.notRunning());
    let told: StandingNotice[] = [];
    db.transaction(() => {
        const moved = db.prepare(`UPDATE standing_deals SET phase = 'held_back', held_back_reason = 'payer' WHERE id = ? AND phase = 'held'`).run(id);
        if (moved.changes !== 1) return;
        told = keep([sd.payee_pubkey], standingLines.heldBackBy(sd.period_unit, nameOf(sd.payer_pubkey), titleOf(sd.post_id)), sd, 'standing_held_back', { reason: 'payer' });
    })();
    tellStanding(hooks, told);
    return standingDealView(id)!;
}

/**
 * Extend (the payer, §1.3): a new signed authorisation for the same standing deal, the same listing, payee, price, period and
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
        && auth.startsAt === sd.starts_at && Math.abs(auth.beansPerPeriod - sd.beans_per_period) < 1e-9;
    if (!same) throw authRefused('the extension changes more than the count');
    const longer = auth.maxPeriods === null ? sd.max_periods !== null : sd.max_periods !== null && auth.maxPeriods > sd.max_periods;
    if (!longer) throw authRefused('the extension is not longer');
    if (payload === sd.auth_payload) throw authRefused('the extension is the same text');
    db.prepare(`UPDATE standing_deals SET max_periods = ?, auth_signer = ?, auth_signature = ?, auth_payload = ? WHERE id = ? AND phase != 'ended' AND auth_payload = ?`)
        .run(auth.maxPeriods, actor, signature, payload, id, sd.auth_payload);
    return standingDealView(id)!;
}

// ── A member gone, a listing removed (§1.5) ─────────────────────────────────────────────────────────────────────────

/**
 * A member removed (adminPruneUser) or who deleted their account (purgeMemberSelf): every standing deal they pay or are paid
 * by ends at once (in the caller's transaction where there is one). A period still held follows the removed-member rule for
 * any open deal: it stays for the other side to close.
 */
export function endStandingDealsOf(memberKey: string): number {
    const live = db.prepare(`SELECT * FROM standing_deals WHERE (payer_pubkey = ? OR payee_pubkey = ?) AND phase != 'ended'`).all(memberKey, memberKey) as StandingRow[];
    const at = new Date().toISOString();
    for (const sd of live) endStanding(sd, 'account_closed', at);
    return live.length;
}

/**
 * Its author removed the listing (engine/posts.ts removePost): each standing deal on it stops after its current period
 * (§1.5), at once where nothing is held. Returns how many it stopped.
 */
export function stopStandingDealsOnListing(postId: string, by: string): number {
    const live = db.prepare(`SELECT * FROM standing_deals WHERE post_id = ? AND phase != 'ended'`).all(postId) as StandingRow[];
    const at = new Date().toISOString();
    for (const sd of live) {
        db.prepare(`UPDATE standing_deals SET stopped_by = COALESCE(stopped_by, ?), stopped_at = COALESCE(stopped_at, ?) WHERE id = ?`).run(by, at, sd.id);
        if (sd.phase === 'due' || sd.phase === 'short') endStanding(sd, 'listing_gone', at);
    }
    return live.length;
}

/** How many standing deals on a listing hold a period now (removePost lets these through: they stop, they don't block). */
export function liveStandingPeriodsOn(postId: string): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM marketplace_transactions mt JOIN standing_deals sd ON sd.id = mt.standing_id
                        WHERE mt.post_id = ? AND mt.status = 'pending'`).get(postId) as { n: number }).n;
}

/**
 * The payer's live standing deals that keep them from holiday mode (§2.5): a payer stays blocked ("Stop your standing deal for
 * … first"); a payee may go away while theirs run. Returns the listing title of the first, or null.
 */
export function standingDealBlockingHoliday(memberKey: string): string | null {
    const sd = db.prepare(`SELECT post_id FROM standing_deals WHERE payer_pubkey = ? AND phase != 'ended' LIMIT 1`).get(memberKey) as { post_id: string } | undefined;
    return sd ? titleOf(sd.post_id) || '' : null;
}

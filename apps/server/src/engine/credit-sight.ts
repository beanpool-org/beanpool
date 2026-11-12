/**
 * The giver's sight, on the server (scratch/fable-design/DESIGN-credit-list-fable.md §6 and its amendment 1 §2, §5, §6;
 * slice C1): what an owner, an admin or a voucher reads about each member's credit, and what a member reads about
 * themselves. Marty, 12 Nov: owners, admins AND vouchers see each member's balance (+ or −, the figure) and the line in use;
 * members are told in one sentence (core CREDIT_SIGHT_WORDS.told); every look is recorded (engine/credit-looks.ts).
 *
 * - {@link giverSight}: who reads, decided at each request from the node's own tables, never an app's copy of a role: an
 *   owner or an admin whose role acts, else a live voucher (a stopped budget ends the sight at the next request), else
 *   nobody. A moderator, a member, a visitor: nobody.
 * - Two answers, each BUILT for its sight, never trimmed in an app: a voucher's carries the line, the usable part, the live
 *   Offers, the balance and the line in use, a can't-give mark, the risk level with its open and giver reasons, `more`, and
 *   what they vouched; an owner's or admin's adds what the line is made of, who stands behind them (the confirmation, each
 *   vouch), the freeze and every reason. A member's own (`me`) is the voucher answer about them, from the same builder.
 * - The balance is the STORED `accounts.balance_c`, one read for the page: never getBalance or ledger.getAccount, which book
 *   the circulation fee as they read (amendment §1 F6), so going down the list charges nobody. Above 200 Beans it can read a
 *   little high until the member's fee is next booked; at or below 200, and below zero, it is exact (amendment §6).
 * - The line from getMemberTrustProfile and usableFloor (neither reads a balance), the Offers from liveOfferCount.
 * - A page is at most PAGE_SIZE people, each worked out once ({@link linesComputed} counts them for the cost test): the
 *   order and the filters are SQL over the members table, before any whole line is worked out. "No credit yet" is the
 *   line itself, from its parts as the line reads them ({@link creditedKeys}), never a stand-in such as "confirmed".
 * - Only people are listed: never an account core calls synthetic (SYSTEM, genesis, the Commons, escrow, project, bridge),
 *   an enterprise or a visitor; nobody else gets a row, a button or a look.
 * - A gift of Beans can't wash the word (amendment 2, slice C8): for the people on a page sent a gift in the last core
 *   GIFT_DAYS days (one statement a page, {@link pageContext}), their own ledger rows of those days are walked back from
 *   the stored balance ({@link giftPaidOf}) and core's paidByGifts says what the gift paid; the five rules built from what
 *   they owe read it. The figure travels only inside a reason's `values`: no sender, no date, no row id. The row's
 *   balance and Spending paused stay the stored balance.
 *
 * Plain reads: nothing here is a Bean, no `accounts` write, no transfer.
 */
import {
    creditRisk, riskForVoucher, position, paidByGifts, DISPUTE_DAYS, GIFT_DAYS, creditAllowance, isSyntheticAccount, SYNTHETIC_ACCOUNT_IDS, SYNTHETIC_ACCOUNT_PREFIXES,
    type BalanceMove, type CreditRisk, type CreditRiskFacts, type CreditSight,
} from '@beanpool/core';
import {
    creditCap, earnedCreditOf, getMember, isVisitorKey, LIVE_OFFER_WHERE, liveOfferCount as liveOffersOf, memberUsableKnownGrant, roomHeldOf,
} from '@beanpool/engine';
import { db } from '../db/db.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { isNodeOwner, isNodeAdmin } from './node-roles.js';
import { isVoucher, isOnCreditCommittee, voucherBudgetLine } from './vouchers.js';
import { confirmationOf, effectiveLines } from './community-health.js';
import { getMemberTrustProfile, usableFloor, isAdminPubkey, getWashTradingEnforcement } from '../state-engine.js';

export const PAGE_SIZE = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export class CreditSightError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
}

/** The credit view answers on a node with Beans on (never global, where they are off): else every route is 404. */
export function creditSightOn(): boolean {
    return getProfileSwitches().beans === true;
}

/** Who `viewer` reads as, now: an owner or admin whose role acts, a live voucher, or nobody (null). */
export function giverSight(viewer: string | null | undefined): CreditSight | null {
    if (!viewer) return null;
    if (isNodeOwner(viewer)) return 'owner';
    if (isNodeAdmin(viewer, false)) return 'admin';
    if (isVoucher(viewer)) return 'voucher';
    return null;
}

let computed = 0;
/** How many people's lines this process worked out (the cost test reads it before and after a page). */
export function linesComputed(): number { return computed; }
let orderChecked = 0;
/** How many people's line parts this process read to put a page in order ({@link creditedKeys}; the cost test reads it). */
export function orderChecks(): number { return orderChecked; }
let giftPages = 0, walked = 0, walkedRows = 0;
/** How many pages asked which of their people were sent a gift (one statement each; the cost test reads it). */
export function giftStatements(): number { return giftPages; }
/** How many people's own rows were walked for what a gift paid ({@link giftPaidOf}; the cost test reads it). */
export function giftWalks(): number { return walked; }
/** How many ledger rows those walks handed to core (the cost test: only the last GIFT_DAYS days' rows). */
export function giftRowsWalked(): number { return walkedRows; }

// ── Who is listed ────────────────────────────────────────────────────────────────────────────────────────────────

const sqlText = (v: string) => `'${v.replace(/'/g, "''")}'`;
/**
 * Not a person: core's own list of accounts that are not people (isSyntheticAccount: the seeded SYSTEM row, genesis, the
 * Commons, escrow, project and bridge accounts), as SQL over a key column, so the list, {@link buildPerson} and
 * {@link isGiftRow} agree.
 */
const notSynthetic = (column: string) => [
    `${column} NOT IN (${SYNTHETIC_ACCOUNT_IDS.map(sqlText).join(', ')})`,
    ...SYNTHETIC_ACCOUNT_PREFIXES.map((prefix) => `substr(${column}, 1, ${prefix.length}) <> ${sqlText(prefix)}`),
].join(' AND ');
const NOT_SYNTHETIC = notSynthetic('m.public_key');
/**
 * Listed: a person's own row, never an enterprise (a treasury), a visitor, an account that is not a person or a removed
 * account. A paused member is listed, greyed. Nobody else is ever built, so nobody else gets a row, a button or a look.
 */
const LISTED = `m.is_visitor = 0 AND COALESCE(m.is_treasury, 0) = 0 AND m.status IN ('active', 'suspended', 'disabled') AND ${NOT_SYNTHETIC}`;
/** A live confirmation (the names list's, a second admin's agreement where one was needed). */
const LIVE_CONFIRMATION = `EXISTS (SELECT 1 FROM confirmations c WHERE c.member_pubkey = m.public_key AND c.revoked_at IS NULL
    AND (c.needs_second = 0 OR c.seconded_at IS NOT NULL))`;
/** Frozen as {@link buildPerson} reads it (the whole line, or the known floor): the row says "frozen", never "No credit yet". */
const FROZEN_SQL = `(COALESCE(m.credit_frozen, 0) = 1
    OR EXISTS (SELECT 1 FROM known_floor_exceptions x WHERE x.member_pubkey = m.public_key AND x.frozen = 1))`;
/** A live Offer of their own: the engine's own rule (posts.ts LIVE_OFFER_WHERE), on the row's key. */
const HAS_LIVE_OFFER = `EXISTS (SELECT 1 FROM posts WHERE ${LIVE_OFFER_WHERE.replace('author_pubkey = ?', 'author_pubkey = m.public_key')})`;
/**
 * The order every filter shares: no credit yet with a live Offer, no credit yet, then the rest; by callsign within each.
 * No credit yet is the row's own sentence: not frozen, and a line of 0 (not in `@credited`, {@link creditedKeys}).
 */
const GROUP_SQL = `CASE WHEN NOT ${FROZEN_SQL} AND m.public_key NOT IN (SELECT value FROM json_each(@credited))
    THEN (CASE WHEN ${HAS_LIVE_OFFER} THEN 0 ELSE 1 END) ELSE 2 END`;

/**
 * Everyone listed and not frozen whose line is above 0 now: the order's "has credit". Each part is read by the function the
 * line itself reads (engine getMemberTrustProfile), and the line by core's creditAllowance, so the order and the row's
 * sentence never disagree: the known grant with the confirmation dial as it is (memberUsableKnownGrant: 0 with the dial
 * off, whoever is confirmed), the room they hold (roomHeldOf: received less passed on), what they earned (earnedCreditOf)
 * and what was granted (members.earned_credit_c, the granted lane's own column).
 *
 * Cost (design §6): SQL first keeps only the people one of whose parts can be above 0 at all (a live confirmation, room
 * received, a completed trade, granted credit); someone with none of them has a line of 0 and is never read here. Of
 * the rest, earned (the dearest part) is worked out only when no cheaper part already gives a line.
 */
function creditedKeys(): string[] {
    const cap = creditCap(db);
    const rows = many<{ pk: string; granted: number; confirmed: number; room: number; traded: number }>(`SELECT * FROM (SELECT m.public_key AS pk,
        COALESCE(m.earned_credit_c, 0) AS granted, ${LIVE_CONFIRMATION} AS confirmed,
        EXISTS (SELECT 1 FROM room_gifts g WHERE g.to_pubkey = m.public_key) AS room,
        EXISTS (SELECT 1 FROM marketplace_transactions t WHERE t.status = 'completed' AND (t.buyer_pubkey = m.public_key OR t.seller_pubkey = m.public_key)) AS traded
        FROM members m WHERE ${LISTED} AND NOT ${FROZEN_SQL}) WHERE granted > 0 OR confirmed OR room OR traded`);
    const out: string[] = [];
    for (const r of rows) {
        orderChecked++;
        const granted = Math.max(0, Number(r.granted) || 0);
        const knownGrant = r.confirmed ? memberUsableKnownGrant(db, r.pk) : 0;
        const roomHeld = r.room ? roomHeldOf(db, r.pk) : 0;
        const earned = r.traded && granted + knownGrant + roomHeld === 0 ? earnedCreditOf(db, r.pk).earnedCredit : 0;
        if (creditAllowance({ earned, granted, knownGrant, roomHeld, cap }) > 0) out.push(r.pk);
    }
    return out;
}

export const CREDIT_FILTERS = ['all', 'no_credit', 'has_offers', 'mine'] as const;
export type CreditFilter = typeof CREDIT_FILTERS[number];

interface Cursor { g: number; c: string; k: string }
const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify([c.g, c.c, c.k])).toString('base64url');
function decodeCursor(raw: unknown): Cursor | null {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 400) return null;
    try {
        const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
        if (Array.isArray(v) && v.length === 3 && Number.isInteger(v[0]) && typeof v[1] === 'string' && typeof v[2] === 'string') return { g: v[0], c: v[1], k: v[2] };
    } catch { /* not one */ }
    return null;
}

// ── The facts of one person ──────────────────────────────────────────────────────────────────────────────────────

interface PageContext {
    viewer: string | null;
    debtLinePct: number;
    quietDays: number;
    /** Every member in a flagged wash pair or cluster (the kept analysis, read once a page: never a fresh run per row). */
    ring: Set<string>;
    balances: Map<string, number>;
    cap: number;
    now: number;
    /**
     * The viewer is on the credit committee (an owner, or an admin an owner put on it), decided at this request: a voucher's
     * row then carries their budget in one line (slice C3, amendment §3.5). Never for a plain admin, a voucher or a member.
     */
    committee: boolean;
    /** The start of the gift window (now − core GIFT_DAYS), as the ledger's rows spell a moment. */
    giftSince: string;
    /** The page's people who were sent a gift of Beans since then ({@link GIFT_ROW_SQL}): on most pages nobody. */
    gifted: Set<string>;
}

// ── What a gift of Beans paid (amendment 2 §4, slice C8) ─────────────────────────────────────────────────────────

/** One ledger row as the walk reads it: who paid, who was paid, what left the payer and the fee the Commons took. */
export interface LedgerMoveRow { from_pubkey: string; to_pubkey: string; amount_c: number; fee_c: number }

/**
 * A gift of Beans, the one rule (amendment 2 §2, F17): Beans that reached `pk` fee-free straight from another account that
 * is a member's or an enterprise's own, never one core calls synthetic. So Send Beans and a leaving member's parting gift
 * are gifts; a sale (from the deal's escrow), a refund of their own hold (from escrow), a standing deal's period, a paid bill
 * and a wage (payer to payee with the 1.5% fee), a grant from the Commons or a Decision (from COMMONS_POOL, or with the fee)
 * and a pledge coming back (from the project's escrow) are not. {@link GIFT_ROW_SQL} is the same rule as SQL.
 */
export function isGiftRow(r: LedgerMoveRow, pk: string): boolean {
    return r.to_pubkey === pk && r.from_pubkey !== pk && Math.trunc(Number(r.fee_c) || 0) === 0 && !isSyntheticAccount(r.from_pubkey);
}
/** {@link isGiftRow} as SQL over a `transactions` row aliased `t` (the page's one statement; a test holds the two to one answer). */
export const GIFT_ROW_SQL = `t.fee_c = 0 AND t.from_pubkey <> t.to_pubkey AND ${notSynthetic('t.from_pubkey')}`;

/** What one row did to `pk`'s stored balance: to them, what reached them (amount less fee); from them, what left them. */
export function balanceMoveOf(r: LedgerMoveRow, pk: string): BalanceMove {
    const amount = Math.trunc(Number(r.amount_c) || 0);
    const fee = Math.trunc(Number(r.fee_c) || 0);
    const delta_c = (r.to_pubkey === pk ? amount - fee : 0) - (r.from_pubkey === pk ? amount : 0);
    return { delta_c, gift: isGiftRow(r, pk) };
}

/** `pk`'s own ledger rows since `since`, either side, newest first, as moves (the walk's input; test 29 rebuilds from it). */
export function balanceMovesSince(pk: string, since: string): BalanceMove[] {
    const rows = many<LedgerMoveRow>(`SELECT from_pubkey, to_pubkey, amount_c, fee_c FROM transactions
        WHERE (from_pubkey = @pk OR to_pubkey = @pk) AND timestamp >= @since ORDER BY timestamp DESC, rowid DESC`, { pk, since });
    return rows.map((r) => balanceMoveOf(r, pk));
}

/**
 * What a gift of Beans paid off of what `pk` owed in the last GIFT_DAYS days, not yet earned back by their own trading:
 * 0 unless the page's one statement found a gift to them; else their rows of those days walked back from the stored
 * balance (core paidByGifts). A plain read: never getBalance or the ledger, nothing written.
 */
export function giftPaidOf(pk: string, balance_c: number, ctx: PageContext): number {
    if (!ctx.gifted.has(pk)) return 0;
    walked++;
    const moves = balanceMovesSince(pk, ctx.giftSince);
    walkedRows += moves.length;
    return paidByGifts(balance_c, moves);
}

function pageContext(viewer: string | null, subjects: readonly string[], now = Date.now(), sight: CreditSight | null = null): PageContext {
    const { debtLinePct, quietDays } = effectiveLines(now);
    const wash = getWashTradingEnforcement();
    const ring = new Set<string>(wash.flaggedClusters.keys());
    for (const pair of wash.flaggedPairs) for (const pk of pair.split('|')) ring.add(pk);
    const balances = new Map<string, number>();
    if (subjects.length > 0) {
        // The stored balance, one read for the page (amendment §1 F6: never through the ledger, which books the fee).
        const rows = db.prepare(`SELECT public_key, balance_c FROM accounts WHERE public_key IN (${subjects.map(() => '?').join(', ')})`).all(...subjects) as { public_key: string; balance_c: number }[];
        for (const r of rows) balances.set(r.public_key, Math.trunc(Number(r.balance_c) || 0));
    }
    const committee = !!viewer && (sight === 'owner' || sight === 'admin') && isOnCreditCommittee(viewer);
    // Which of the page's people were sent a gift of Beans in the last GIFT_DAYS days: one statement for the page.
    const giftSince = new Date(now - GIFT_DAYS * DAY_MS).toISOString();
    const gifted = new Set<string>();
    if (subjects.length > 0) {
        giftPages++;
        const rows = db.prepare(`SELECT DISTINCT t.to_pubkey AS pk FROM transactions t
            WHERE t.to_pubkey IN (${subjects.map(() => '?').join(', ')}) AND t.timestamp >= ? AND ${GIFT_ROW_SQL}`).all(...subjects, giftSince) as { pk: string }[];
        for (const r of rows) gifted.add(r.pk);
    }
    return { viewer, debtLinePct, quietDays, ring, balances, cap: creditCap(db), now, committee, giftSince, gifted };
}

const one = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T;
const many = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[];

/** Their own circle (design §4.1): their inviter, the people they invited, who vouched for them, and whom they vouched for. */
function circleOf(pk: string): Set<string> {
    const keys = many<{ k: string | null }>(`SELECT invited_by AS k FROM members WHERE public_key = @pk
        UNION SELECT public_key FROM members WHERE invited_by = @pk
        UNION SELECT from_pubkey FROM room_gifts WHERE kind = 'vouch' AND to_pubkey = @pk
        UNION SELECT to_pubkey FROM room_gifts WHERE kind = 'vouch' AND from_pubkey = @pk`, { pk });
    return new Set(keys.map((r) => r.k).filter((k): k is string => !!k && k !== pk));
}

function stored(ctx: PageContext, pk: string): number {
    if (ctx.balances.has(pk)) return ctx.balances.get(pk)!;
    const row = one<{ balance_c: number } | undefined>('SELECT balance_c FROM accounts WHERE public_key = ?', pk);
    return Math.trunc(Number(row?.balance_c) || 0);
}

function riskFacts(pk: string, joinedAt: string | null, line_c: number, usable_c: number, balance_c: number, frozen: boolean, ctx: PageContext): CreditRiskFacts {
    const trades = one<{ completed: number | null; cancelled: number | null }>(`SELECT SUM(status = 'completed') AS completed, SUM(status = 'cancelled') AS cancelled
        FROM marketplace_transactions WHERE buyer_pubkey = ? OR seller_pubkey = ?`, pk, pk);
    const completed = trades.completed ?? 0;
    const lastSale = one<{ at: string | null }>("SELECT MAX(completed_at) AS at FROM marketplace_transactions WHERE seller_pubkey = ? AND status = 'completed'", pk).at;
    const since = new Date(ctx.now - DISPUTE_DAYS * DAY_MS).toISOString();
    const dispute = !!one<unknown>(`SELECT 1 FROM marketplace_transactions WHERE dispute_resolved_at > ?
        AND ((seller_pubkey = ? AND dispute_resolution = 'refund_to_buyer') OR (buyer_pubkey = ? AND dispute_resolution = 'release_to_seller')) LIMIT 1`, since, pk, pk);
    const circle = circleOf(pk);
    const partners = many<{ other: string }>(`SELECT seller_pubkey AS other FROM marketplace_transactions WHERE buyer_pubkey = ? AND status = 'completed'
        UNION ALL SELECT buyer_pubkey FROM marketplace_transactions WHERE seller_pubkey = ? AND status = 'completed'`, pk, pk);
    const outside = partners.filter((p) => !circle.has(p.other));
    // Their branch: the people they invited or vouched for, how many are below zero now (the stored balance), and what was
    // written off of the room they stood behind.
    const branch = many<{ k: string }>(`SELECT public_key AS k FROM members WHERE invited_by = @pk AND is_visitor = 0
        UNION SELECT to_pubkey FROM room_gifts WHERE kind = 'vouch' AND from_pubkey = @pk`, { pk }).map((r) => r.k);
    const branchBelowZero = branch.filter((k) => stored(ctx, k) < 0).length;
    const writtenOff = one<{ n: number }>('SELECT COALESCE(SUM(written_off_c), 0) AS n FROM room_gifts WHERE root_pubkey = ?', pk).n;
    const joined = joinedAt ? Date.parse(joinedAt) : NaN;
    return {
        completed, cancelled: trades.cancelled ?? 0,
        daysHere: Number.isFinite(joined) ? Math.max(0, Math.floor((ctx.now - joined) / DAY_MS)) : 0,
        balance_c, line_c, usable_c, giftPaid_c: giftPaidOf(pk, balance_c, ctx),
        frozen, ring: ctx.ring.has(pk), disputeAgainst: dispute,
        lastSaleDays: lastSale && Number.isFinite(Date.parse(lastSale)) ? Math.floor((ctx.now - Date.parse(lastSale)) / DAY_MS) : null,
        confirmed: confirmationOf(pk).confirmed,
        insideOnly: completed > 0 && partners.length > 0 && outside.length === 0,
        outsideTrades: outside.length, outsidePartners: new Set(outside.map((p) => p.other)).size,
        branchPeople: branch.length, branchBelowZero, writtenOff_c: writtenOff,
        debtLinePct: ctx.debtLinePct, quietDays: ctx.quietDays,
    };
}

/** A voucher's answer about one person: what every giver reads, and what a member reads about themselves (`me`). */
export interface CreditPersonVoucher {
    memberPubkey: string;
    callsign: string;
    /** `paused`: their account is paused (listed greyed, no button). */
    status: 'active' | 'paused';
    /** The viewer's own row: no button. */
    own: boolean;
    line_c: number;
    usable_c: number;
    /** Null for a key whose count isn't a person's (F4: an admin key reads as having every band). */
    liveOffers: number | null;
    balance_c: number;
    owed_c: number;
    over_c: number;
    /** Spending paused: they owe more than their Offers unlock. */
    paused: boolean;
    /** Whether credit can be given to them now; false for a freeze, a paused account or the viewer's own row. */
    canGive: boolean;
    risk: CreditRisk;
    /** What this viewer's vouches for them come to (0 for none); absent from `me`. */
    youVouched_c?: number;
}

/** An owner's or admin's answer: everything a voucher reads, and what the line is made of, who stands behind it, the freeze. */
export interface CreditPersonFull extends CreditPersonVoucher {
    parts: { known_c: number; room_c: number; earned_c: number; granted_c: number; cap_c: number };
    standsBehind: {
        confirmedBy: { memberPubkey: string; callsign: string; at: string } | null;
        vouchedBy: { memberPubkey: string; callsign: string; amount_c: number }[];
    };
    frozen: { credit: boolean; known: boolean };
    /**
     * A live voucher's budget in one line (slice C3: "Voucher · 150 of 1,000 left ! Running low"), only in the answer to an
     * owner or a committee admin, and only on a voucher's row: absent for a plain admin, whatever the person is.
     */
    voucherBudget?: NonNullable<ReturnType<typeof voucherBudgetLine>>;
}

const callsignOf = (pk: string | null | undefined): string => (pk ? getMember(db, pk)?.callsign ?? '' : '');

/** One person's answer for `sight`, built for it: a voucher's never holds the parts, who stands behind, a freeze or an admins' reason. */
function buildPerson(pk: string, sight: CreditSight, ctx: PageContext, withYouVouched: boolean): CreditPersonVoucher | CreditPersonFull | null {
    const m = one<{ public_key: string; callsign: string; status: string; joined_at: string | null; credit_frozen: number | null } | undefined>(
        `SELECT m.public_key, m.callsign, m.status, m.joined_at, m.credit_frozen FROM members m WHERE m.public_key = ? AND ${LISTED}`, pk);
    if (!m || isVisitorKey(db, pk) || isSyntheticAccount(pk)) return null;
    computed++;
    const trust = getMemberTrustProfile(pk);
    const line_c = Math.max(0, -trust.floor);
    const usable_c = Math.min(line_c, Math.max(0, -usableFloor(pk)));
    const balance_c = stored(ctx, pk);
    const knownFrozen = !!one<unknown>('SELECT 1 FROM known_floor_exceptions WHERE member_pubkey = ? AND frozen = 1', pk);
    const creditFrozen = (m.credit_frozen ?? 0) === 1;
    const frozen = creditFrozen || knownFrozen;
    const pausedAccount = m.status !== 'active';
    const own = ctx.viewer === pk;
    const p = position(balance_c, line_c, usable_c);
    const facts = riskFacts(pk, m.joined_at, line_c, usable_c, balance_c, frozen, ctx);
    const full = sight !== 'voucher';
    const base: CreditPersonVoucher = {
        memberPubkey: pk, callsign: m.callsign, status: pausedAccount ? 'paused' : 'active', own,
        line_c, usable_c,
        liveOffers: isAdminPubkey(pk) ? null : liveOffersOf(db, pk),
        balance_c: p.balance_c, owed_c: p.owed_c, over_c: p.over_c, paused: p.paused,
        canGive: !frozen && !pausedAccount && !own,
        risk: full ? creditRisk(facts) : riskForVoucher(facts),
        ...(withYouVouched && ctx.viewer
            ? { youVouched_c: one<{ n: number }>("SELECT COALESCE(SUM(amount_c), 0) AS n FROM room_gifts WHERE kind = 'vouch' AND from_pubkey = ? AND to_pubkey = ?", ctx.viewer, pk).n }
            : {}),
    };
    if (!full) return base;
    const confirmation = one<{ confirmed_by: string; confirmed_at: string; seconded_at: string | null } | undefined>(`SELECT confirmed_by, confirmed_at, seconded_at FROM confirmations
        WHERE member_pubkey = ? AND revoked_at IS NULL AND (needs_second = 0 OR seconded_at IS NOT NULL) ORDER BY confirmed_at DESC LIMIT 1`, pk);
    const vouchedBy = many<{ k: string; n: number }>(`SELECT from_pubkey AS k, SUM(amount_c) AS n FROM room_gifts WHERE kind = 'vouch' AND to_pubkey = ?
        GROUP BY from_pubkey ORDER BY MIN(at) ASC`, pk);
    const budget = ctx.committee ? voucherBudgetLine(pk, ctx.now) : null;
    return {
        ...base,
        ...(budget ? { voucherBudget: budget } : {}),
        parts: { known_c: trust.knownGrant, room_c: trust.roomHeld, earned_c: trust.earnedCredit, granted_c: trust.grantedCredit, cap_c: ctx.cap },
        standsBehind: {
            confirmedBy: facts.confirmed && confirmation
                ? { memberPubkey: confirmation.confirmed_by, callsign: callsignOf(confirmation.confirmed_by), at: confirmation.seconded_at ?? confirmation.confirmed_at }
                : null,
            vouchedBy: vouchedBy.map((v) => ({ memberPubkey: v.k, callsign: callsignOf(v.k), amount_c: v.n })),
        },
        frozen: { credit: creditFrozen, known: knownFrozen },
    } satisfies CreditPersonFull;
}

// ── The reads ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CreditPage { people: (CreditPersonVoucher | CreditPersonFull)[]; next: string | null }

/**
 * One page of the People list with Show credit on (GET /api/credit/people): the members `filter` and `q` pick, in the shared
 * order, after `after`, each built for `sight`. The caller records the looks before it answers (engine/credit-looks.ts).
 */
export function creditPeople(viewer: string, sight: CreditSight, opts: { filter?: unknown; q?: unknown; after?: unknown }): CreditPage {
    const filter = (opts.filter === undefined || opts.filter === '' ? 'all' : opts.filter) as CreditFilter;
    if (!CREDIT_FILTERS.includes(filter)) throw new CreditSightError(400, 'bad_filter', `filter is one of ${CREDIT_FILTERS.join(', ')}.`);
    const after = opts.after === undefined || opts.after === '' ? null : decodeCursor(opts.after);
    if (opts.after !== undefined && opts.after !== '' && !after) throw new CreditSightError(400, 'bad_cursor', 'after is the `next` of an earlier page.');
    const q = typeof opts.q === 'string' ? opts.q.trim().slice(0, 64) : '';
    const where: string[] = [LISTED];
    const params: Record<string, unknown> = { viewer, limit: PAGE_SIZE + 1, credited: JSON.stringify(creditedKeys()) };
    if (filter === 'no_credit') where.push('grp IN (0, 1)');
    if (filter === 'has_offers') where.push('grp = 0');
    if (filter === 'mine') where.push(`(m.invited_by = @viewer OR EXISTS (SELECT 1 FROM room_gifts v WHERE v.kind = 'vouch' AND v.from_pubkey = @viewer AND v.to_pubkey = m.public_key))`);
    if (q) { where.push("m.callsign LIKE @q ESCAPE '\\'"); params.q = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`; }
    if (after) { where.push('(grp, lower(m.callsign), m.public_key) > (@g, @c, @k)'); Object.assign(params, { g: after.g, c: after.c, k: after.k }); }
    const rows = db.prepare(`SELECT m.public_key AS pk, lower(m.callsign) AS c, grp FROM (SELECT *, ${GROUP_SQL} AS grp FROM members m) m
        WHERE ${where.join(' AND ')} ORDER BY grp, lower(m.callsign), m.public_key LIMIT @limit`).all(params) as { pk: string; c: string; grp: number }[];
    const page = rows.slice(0, PAGE_SIZE);
    const ctx = pageContext(viewer, page.map((r) => r.pk), Date.now(), sight);
    const people = page.map((r) => buildPerson(r.pk, sight, ctx, true)).filter((p): p is CreditPersonVoucher => !!p);
    const last = page.at(-1);
    return { people, next: rows.length > PAGE_SIZE && last ? encodeCursor({ g: last.grp, c: last.c, k: last.pk }) : null };
}

/** The card or sheet for one person (GET /api/credit/people/:member). Null: nobody listed by that key. */
export function creditPerson(viewer: string, sight: CreditSight, member: string): CreditPersonVoucher | CreditPersonFull | null {
    return buildPerson(member, sight, pageContext(viewer, [member], Date.now(), sight), true);
}

/**
 * What givers see about the signer (GET /api/credit/me, slice C6 draws it): exactly a voucher's answer about them, from the
 * same builder, but for "you vouched". No look is recorded: it is their own.
 */
export function creditMe(pk: string): CreditPersonVoucher | null {
    return buildPerson(pk, 'voucher', pageContext(null, [pk]), false) as CreditPersonVoucher | null;
}

/** A member key in the table's spelling, or null. */
export function memberKeyOf(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const k = raw.trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(k) ? k : null;
}


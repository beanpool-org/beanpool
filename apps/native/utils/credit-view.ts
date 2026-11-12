/**
 * The credit view on the phone (scratch/fable-design/DESIGN-credit-list-fable.md with its amendments 1 and 2; slice C4): what
 * People → Community draws when an owner, an admin or a voucher turns on Show credit, and what the profile card, the Give
 * credit sheet, the Vouchers chip and Ask for more draw.
 *
 * Three rules, each held by a test:
 *   1. The NODE decides who may see it. {@link creditGiverFrom} reads the node's fresh answers (GET /api/node-admin/me and
 *      GET /api/vouchers/me), never the phone's copy of a role, and a plain member's phone never asks for a credit answer.
 *      A 403 `not_a_giver` from a credit route turns the view off whatever those answers said.
 *   2. NOTHING IS KEPT. Every answer lives in a screen's state while it is open: no phone database, no storage, no offline
 *      copy (amendment 1 §5.1). This module imports neither.
 *   3. NO FIGURE IS WORKED OUT HERE. The line, the balance, the risk and each reason are core's sentences over the node's
 *      figures (core credit-sight.ts); a top-up level is the node's `topUpTo_c`; a reason is never composed from its values.
 */
import {
    CREDIT_SIGHT_WORDS, RISK_SHAPES, balanceSentence, balanceSpoken, creditLineSentence, formatHundredths, position,
    formatCount, riskLevelSentence, riskReasonSentence, t, tn,
    type CreditPosition, type RiskLevel, type RiskReason,
} from '@beanpool/core';
import type { BeanPoolIdentity } from './identity';

// ── What the node answers (engine/credit-sight.ts, engine/vouchers.ts; whole hundredths of a Bean throughout) ──────────

export type CreditSightKind = 'owner' | 'admin' | 'voucher';

export interface CreditRiskAnswer { level: RiskLevel; reasons: RiskReason[]; more: boolean }

export interface VoucherBudgetLine {
    noLimit: boolean;
    left_c: number | null;
    held_c: number | null;
    level_c: number | null;
    setLevel_c: number | null;
    runningLow: boolean;
    nothingLeft: boolean;
    askedAt: string | null;
}

/** One person as the node builds the answer for the signer's sight: a voucher's answer never holds `parts`, `standsBehind` or `frozen`. */
export interface CreditPerson {
    memberPubkey: string;
    callsign: string;
    status: 'active' | 'paused';
    own: boolean;
    line_c: number;
    usable_c: number;
    liveOffers: number | null;
    balance_c: number;
    owed_c: number;
    over_c: number;
    paused: boolean;
    canGive: boolean;
    risk: CreditRiskAnswer;
    youVouched_c?: number;
    parts?: { known_c: number; room_c: number; earned_c: number; granted_c: number; cap_c: number };
    standsBehind?: {
        confirmedBy: { memberPubkey: string; callsign: string; at: string } | null;
        vouchedBy: { memberPubkey: string; callsign: string; amount_c: number }[];
    };
    frozen?: { credit: boolean; known: boolean };
    voucherBudget?: VoucherBudgetLine;
}

export interface CreditPage { sight: CreditSightKind; told: string; people: CreditPerson[]; next: string | null }

export type TopUpBlocked = 'no_limit' | 'own' | 'paused' | 'frozen' | 'at_most';

/** A row of the Vouchers chip: today's voucher summary and the committee's budget sight (engine/vouchers.ts vouchersChip). */
export interface VoucherChipRow {
    memberPubkey: string;
    callsign: string;
    noLimit?: boolean;
    left: number;
    held: number;
    heldInvites: number;
    vouched: number;
    peopleVouched: number;
    level: number;
    belowZero: number;
    writtenOff: number;
    setLevel_c: number | null;
    runningLow: boolean;
    nothingLeft: boolean;
    askedAt: string | null;
    topUpTo_c: number | null;
    topUpBlocked: TopUpBlocked | null;
}

export type CreditFilter = 'all' | 'no_credit' | 'has_offers' | 'mine' | 'vouchers';
export const CREDIT_FILTERS: readonly CreditFilter[] = ['all', 'no_credit', 'has_offers', 'mine', 'vouchers'];

// ── Who gets the switch ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Whether to OFFER Show credit, from what the node just said (never a copy kept on the phone): an owner or admin by
 * GET /api/node-admin/me, a live voucher by GET /api/vouchers/me. `null` is "not heard" (offline, a 5xx), which offers
 * nothing. This only decides whether to ask: the node decides at every credit request, and a 403 turns the view off.
 */
export function creditGiverFrom(role: { role: string | null } | null, voucher: boolean | null): 'giver' | 'no' | 'unknown' {
    if (role?.role === 'owner' || role?.role === 'admin' || voucher === true) return 'giver';
    return role !== null && voucher !== null ? 'no' : 'unknown';
}

// ── Asking the node ──────────────────────────────────────────────────────────────────────────────────────────────────

export type CreditResult<T> =
    | { ok: true; value: T }
    | { ok: false; status: number; code: string | null; message: string; extra: Record<string, unknown>; offline: boolean };

const OFFLINE: CreditResult<never> = { ok: false, status: 0, code: null, message: '', extra: {}, offline: true };

async function answer<T>(res: Response): Promise<CreditResult<T>> {
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && body) return { ok: true, value: body as T };
    const message = typeof body?.error === 'string' && body.error.trim() ? body.error : typeof body?.message === 'string' ? body.message : '';
    const extra: Record<string, unknown> = { ...(body ?? {}) };
    const code = extra.code;
    delete extra.error; delete extra.message; delete extra.code;
    return { ok: false, status: res.status, code: typeof code === 'string' ? code : null, message, extra, offline: false };
}

async function get<T>(anchor: string, path: string, identity: BeanPoolIdentity): Promise<CreditResult<T>> {
    try {
        const { signedGet } = await import('./node-post');
        return await answer<T>(await signedGet(anchor, path, identity));
    } catch {
        return OFFLINE;
    }
}

async function post<T>(anchor: string, path: string, body: unknown, identity: BeanPoolIdentity): Promise<CreditResult<T>> {
    try {
        const { signedPost } = await import('./node-post');
        return await answer<T>(await signedPost(anchor, path, body, identity));
    } catch {
        return OFFLINE;
    }
}

/** One page of the list (30 people): `GET /api/credit/people`, the node's own order and cursor. Records a look for each person on it. */
export function fetchCreditPage(anchor: string, identity: BeanPoolIdentity, o: { filter: Exclude<CreditFilter, 'vouchers'>; q?: string; after?: string | null }): Promise<CreditResult<CreditPage>> {
    const params = [`filter=${o.filter}`];
    if (o.q && o.q.trim()) params.push(`q=${encodeURIComponent(o.q.trim())}`);
    if (o.after) params.push(`after=${encodeURIComponent(o.after)}`);
    return get<CreditPage>(anchor, `/api/credit/people?${params.join('&')}`, identity);
}

/** The sheet's and the card's read of one person; read again after every give, never updated locally. */
export function fetchCreditPerson(anchor: string, identity: BeanPoolIdentity, memberPubkey: string): Promise<CreditResult<{ sight: CreditSightKind; told: string; person: CreditPerson }>> {
    return get(anchor, `/api/credit/people/${encodeURIComponent(memberPubkey)}`, identity);
}

/** The Vouchers chip: owners and the credit committee only (anyone else: 403 `committee_only`). No look is recorded. */
export function fetchVouchersChip(anchor: string, identity: BeanPoolIdentity): Promise<CreditResult<{ sight: CreditSightKind; vouchers: VoucherChipRow[] }>> {
    return get(anchor, '/api/credit/people?filter=vouchers', identity);
}

/** Raise a confirmed member's known floor: exactly `{ memberPubkey, raiseTo_c }`, raise only (engine/credit-give.ts). */
export function raiseKnownFloor(anchor: string, identity: BeanPoolIdentity, memberPubkey: string, raiseTo_c: number): Promise<CreditResult<{ memberPubkey: string; was_c: number; knownFloor_c: number }>> {
    return post(anchor, '/api/credit/known-floor', { memberPubkey, raiseTo_c }, identity);
}

/** Ask for more: one tap, no words and no amount, so an empty body (the node refuses any key in it). */
export function askForMore(anchor: string, identity: BeanPoolIdentity): Promise<CreditResult<{ askedAt: string; askAgainAt: string }>> {
    return post(anchor, '/api/vouchers/ask', {}, identity);
}

// ── Rows ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The words a row (and the card, and the sheet's top) draws for one person. All core's sentences over the node's figures. */
export interface CreditRowText {
    credit: string;
    balance: string;
    balanceSpoken: string;
    /** "Spending paused": the row's own mark, from the stored balance. */
    pausedMark: string | null;
    risk: string;
    riskShape: string;
    /** The shape and the word together: "✓ Credit risk: low". */
    riskLine: string;
    level: RiskLevel;
}

export function creditPositionOf(p: CreditPerson): CreditPosition {
    return position(p.balance_c, p.line_c, p.usable_c);
}

export function creditRowText(p: CreditPerson, sight: CreditSightKind): CreditRowText {
    const frozen = !!(p.frozen && (p.frozen.credit || p.frozen.known));
    // A voucher is not told the cause of a freeze: the node marks the person `canGive: false`, and the row says so. Not for
    // the viewer's own row (it has no button by design) nor for a paused account (listed greyed).
    const cantGive = sight === 'voucher' && !p.canGive && !p.own && p.status === 'active';
    const pos = creditPositionOf(p);
    return {
        credit: creditLineSentence({ line_c: p.line_c, usable_c: p.usable_c, liveOffers: p.liveOffers, frozen, cantGive }),
        balance: balanceSentence(pos),
        balanceSpoken: balanceSpoken(pos),
        pausedMark: p.paused ? t(CREDIT_SIGHT_WORDS.spendingPaused) : null,
        risk: riskLevelSentence(p.risk.level),
        riskShape: RISK_SHAPES[p.risk.level],
        riskLine: marked(RISK_SHAPES[p.risk.level], riskLevelSentence(p.risk.level)),
        level: p.risk.level,
    };
}

/** Each reason as core draws it, in the node's order; a code this build doesn't know draws nothing. */
export function riskReasonLines(risk: CreditRiskAnswer): string[] {
    const lines = risk.reasons.map((r) => riskReasonSentence(r)).filter((s): s is string => !!s);
    if (risk.more) lines.push(t(CREDIT_SIGHT_WORDS.adminsSayMore));
    return lines;
}

/** Whether a row offers Give credit: the node's `canGive`, never worked out here. */
export const mayGive = (p: CreditPerson): boolean => p.canGive && p.status === 'active' && !p.own;

/** The next person the sheet opens after a give: the one after `current` in the loaded rows that can be given credit. */
export function nextToGive(people: readonly CreditPerson[], current: string): CreditPerson | null {
    const at = people.findIndex((p) => p.memberPubkey === current);
    return people.slice(at + 1).find(mayGive) ?? null;
}

// ── The sheet ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Why the sheet greys the presets before the tap rather than after a refusal (amendment §3.3), or null. The node still refuses either. */
export function presetsGreyedBecause(p: CreditPerson, sight: CreditSightKind): 'below_zero' | 'cannot_receive' | null {
    if (p.balance_c < 0) return 'below_zero';
    const frozen = !!(p.frozen && (p.frozen.credit || p.frozen.known));
    if (frozen || (sight === 'voucher' && !p.canGive && !p.own && p.status === 'active')) return 'cannot_receive';
    return null;
}

export function presetsGreyedWords(why: 'below_zero' | 'cannot_receive', name: string): string {
    return why === 'below_zero'
        ? t('@{name} is below zero: a credit-line gift or a Decision can help.', { name })
        : t('@{name} can’t be given part of a credit line right now.', { name });
}

/** A mark and its words ("! Running low", "✓ Credit risk: low"), kept out of the JSX so no English is joined to a glyph there. */
export function marked(mark: string, text: string): string {
    return `${mark} ${text}`;
}

/**
 * The steps a known-floor raise offers: from 100 Beans above what the member holds now, in 100s, up to the cap
 * (the node refuses anything else). Raise only: nothing here can lower a floor.
 */
export function floorRaiseSteps(known_c: number, cap_c: number, step_c = 10_000): { min: number; max: number } | null {
    const min = (Math.floor(known_c / step_c) + 1) * step_c;
    return min <= cap_c ? { min, max: Math.floor(cap_c / step_c) * step_c } : null;
}

/** The parts a line is made of, for owners and admins: "known floor 1,000 · vouched 200 · earned 100". */
export function madeOfWords(p: CreditPerson): string | null {
    const parts = p.parts;
    if (!parts) return null;
    const seg: string[] = [];
    if (parts.known_c > 0) seg.push(t('known floor {amount}', { amount: formatHundredths(parts.known_c) }));
    if (parts.room_c > 0) seg.push(t('vouched {amount}', { amount: formatHundredths(parts.room_c) }));
    if (parts.earned_c > 0) seg.push(t('earned {amount}', { amount: formatHundredths(parts.earned_c) }));
    if (parts.granted_c > 0) seg.push(t('granted {amount}', { amount: formatHundredths(parts.granted_c) }));
    return seg.length ? t('Made of: {parts}', { parts: seg.join(' · ') }) : null;
}

/** Who stands behind the person (owners and admins): who confirmed, each vouch. */
export function standsBehindWords(p: CreditPerson): string[] {
    const out: string[] = [];
    const sb = p.standsBehind;
    if (!sb) return out;
    if (sb.confirmedBy) out.push(t('Confirmed by @{name}', { name: sb.confirmedBy.callsign }));
    if (sb.vouchedBy.length) {
        out.push(t('Vouched by {list}', { list: sb.vouchedBy.map((v) => `@${v.callsign} ${formatHundredths(v.amount_c)}`).join(', ') }));
    }
    return out;
}

/** Over the cap: the parts add up to more than the community allows. */
export function cappedWords(p: CreditPerson): string | null {
    const parts = p.parts;
    if (!parts) return null;
    return parts.known_c + parts.room_c + parts.earned_c + parts.granted_c > parts.cap_c
        ? t('Capped at {cap}, the most this community allows.', { cap: formatHundredths(parts.cap_c) })
        : null;
}

// ── Vouchers' budgets (amendment §3.5) ───────────────────────────────────────────────────────────────────────────────

const day = (iso: string) => {
    const d = new Date(iso);
    return Number.isFinite(d.getTime()) ? d : null;
};

/** A moment as a short date in the member's language ("12 Nov"), or '' for one that can't be read. */
export function shortDay(iso: string | null | undefined, format: (d: Date) => string): string {
    const d = iso ? day(iso) : null;
    return d ? format(d) : '';
}

/** The words of one Vouchers row. The node's figures and flags; the level of a top-up is `topUpTo_c`, never worked out here. */
export function voucherRowWords(v: VoucherChipRow, askedOn: string): {
    head: string; flag: string | null; vouched: string; held: string | null; health: string; asked: string | null; topUp: string | null; blocked: string | null;
} {
    if (v.noLimit) {
        return { head: t('Owner · no limit'), flag: null, vouched: vouchedWords(v), held: null, health: healthWords(v), asked: null, topUp: null, blocked: null };
    }
    return {
        head: t('Voucher · {left} of {level} left', { left: formatHundredths(v.left), level: formatHundredths(v.setLevel_c ?? v.level) }),
        flag: v.nothingLeft ? t('Nothing left to vouch with') : v.runningLow ? t('Running low') : null,
        vouched: vouchedWords(v),
        held: v.held > 0 ? t('{amount} held on invites', { amount: formatHundredths(v.held) }) : null,
        health: healthWords(v),
        asked: v.askedAt ? t('Asked for more on {day}', { day: askedOn }) : null,
        topUp: v.topUpTo_c !== null && v.topUpBlocked === null ? t('Top up to {level}', { level: formatHundredths(v.topUpTo_c) }) : null,
        blocked: blockedWords(v.topUpBlocked),
    };
}

const vouchedWords = (v: VoucherChipRow) => tn(v.peopleVouched, 'Vouched {amount} to {n} person', 'Vouched {amount} to {n} people', { n: formatCount(v.peopleVouched), amount: formatHundredths(v.vouched) });
const healthWords = (v: VoucherChipRow) => t('{below} of {people} below zero · written off {amount}', { below: formatCount(v.belowZero), people: formatCount(v.peopleVouched), amount: formatHundredths(v.writtenOff) });

function blockedWords(b: TopUpBlocked | null): string | null {
    if (b === 'frozen') return t('Their credit line is frozen, so their budget can’t be raised.');
    if (b === 'paused') return t('Their account is paused, so their budget can’t be raised.');
    if (b === 'at_most') return t('At the most a voucher can hold.');
    return null;
}

/** What a voucher's own Ask for more button says (GET /api/vouchers/me `ask`, from the node). */
export interface AskState { askedAt: string | null; lastAskedAt: string | null; askAgainAt: string | null; blocked: 'paused' | 'frozen' | null }

export function askWords(ask: AskState, format: (iso: string) => string): { kind: 'button' | 'asked' | 'wait' | 'blocked'; text: string } {
    if (ask.blocked === 'frozen') return { kind: 'blocked', text: t('Your credit line is frozen, so your budget can’t be raised until an admin unfreezes it.') };
    if (ask.blocked === 'paused') return { kind: 'blocked', text: t('Your account is paused, so your budget can’t be raised while it lasts.') };
    if (ask.askedAt) return { kind: 'asked', text: t('Asked on {day} · an owner or the credit committee will see it.', { day: format(ask.askedAt) }) };
    if (ask.lastAskedAt && ask.askAgainAt) {
        return { kind: 'wait', text: t('You asked on {asked}. You can ask again on {again}.', { asked: format(ask.lastAskedAt), again: format(ask.askAgainAt) }) };
    }
    return { kind: 'button', text: t('Ask for more') };
}

/** The refusal the sheet answers with "Ask for more" under it: the node's "You have … Beans of budget left" sentence (409 `not_enough`, engine/vouchers.ts). */
export const NOT_ENOUGH_BUDGET_CODE = 'not_enough';

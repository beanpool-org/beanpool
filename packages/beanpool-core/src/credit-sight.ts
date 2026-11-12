/**
 * The giver's sight (scratch/fable-design/DESIGN-credit-list-fable.md, its amendment 1 of 12 Nov: Marty's answers): what an
 * owner, an admin or a voucher reads about a member's credit, worked out here, pure, so the server and both apps cannot
 * disagree.
 *
 * - {@link position}: the balance with its sign beside the credit line (amendment §3.2), from the stored balance, the line
 *   and the part of it their Offers unlock. A balance always comes with its line beside it (§4.3, 6).
 * - {@link creditRisk}: one of four levels, from rules anyone can read (§4.2), each reason marked `open` (any member can read
 *   it on a profile), `giver` (built only from the balance and the line) or `admins` (owners' and admins' alone). The level
 *   is the worst rule's; the server drops the admins' reasons from a voucher's answer and says `more` where one of them
 *   moved the level ({@link riskForVoucher}). Advice for a person: the server enforces nothing from it.
 * - The sentences each surface draws: the row's credit line, the balance, the level and each reason, and the one sentence
 *   that tells every member who can see them (§5.3, {@link CREDIT_SIGHT_WORDS}.told).
 *
 * Every figure is whole hundredths of a Bean (`*_c`), as the ledger holds it; nothing here rounds a hundredth away.
 */
import { formatCount, t, tn, word } from './words.js';
import { formatHundredths } from './hundredths.js';

/** Who reads: an owner or admin whose role acts reads everything here; a live voucher the open and giver parts. */
export type CreditSight = 'owner' | 'admin' | 'voucher';
export type RiskLevel = 'not_known' | 'low' | 'medium' | 'high';
/** Who may read a reason: any member on a profile, every giver (the balance and the line), or owners and admins. */
export type ReasonMark = 'open' | 'giver' | 'admins';

export const RISK_LEVELS: readonly RiskLevel[] = ['not_known', 'low', 'medium', 'high'];
const rank = (l: RiskLevel) => RISK_LEVELS.indexOf(l);

/** "Almost all" of a line: nine tenths or more (§5.1, kept by amendment §4.2). */
export const ALMOST_ALL_TENTHS = 9;
/** A record that reads low on trades alone (§4.2): this many completed trades, with this many different people outside their own circle, here this many days. */
export const LOW_TRADES = 3;
export const LOW_PARTNERS = 2;
export const LOW_DAYS_HERE = 30;
/** Fewer than half completed, once this many trades ended (the profile's own rule, state-engine assessTradeRisk). */
export const COMPLETION_MIN_ENDED = 4;
/** Cancellations that read medium: this many, with under 8 in 10 completed. */
export const CANCELLED_MIN = 2;
/** Their branch reads medium when at least this many of the people they stood behind are below zero, and at least half. */
export const BRANCH_BELOW_MIN = 2;
/** How far back a dispute decided against them counts (§4.1): 12 months. */
export const DISPUTE_DAYS = 365;

export const CREDIT_SIGHT_WORDS = {
    /** §5.3: drawn on the join screen and "How this community works" on every node with Beans, in the PR that answers a look. */
    told: word('People who give credit here (the owners, admins and vouchers) can see your balance and your credit line, and each look is recorded.'),
    /** Under the switch, and atop the profile card (§3.1, §3.4). */
    onlyGivers: word('Only people who can give credit see this. Each look is recorded.'),
    adminsSayMore: word('An owner or admin can say more.'),
    spendingPaused: word('Spending paused'),
    levelNotKnown: word('Credit risk: not known yet'),
    levelLow: word('Credit risk: low'),
    levelMedium: word('Credit risk: medium'),
    levelHigh: word('Credit risk: high'),
};

// ── The position: the balance beside the line ─────────────────────────────────────────────────────────────────────

export interface CreditPosition {
    sign: 'plus' | 'zero' | 'minus';
    balance_c: number;
    /** What they owe now: 0 at or above zero. */
    owed_c: number;
    /** Their whole credit line (the limit), never the part their Offers unlock: "using 420 of 1,300". */
    line_c: number;
    /** What they owe past the whole line (it was lowered or frozen after they spent): 0 otherwise. */
    over_c: number;
    /** Spending paused: they owe more than their Offers unlock (getBalance's `frozen`, balance below the usable floor). */
    paused: boolean;
}

const whole = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : 0);

/** The position from the stored balance, the whole line and the usable part, each in whole hundredths. */
export function position(balance_c: number, line_c: number, usable_c: number): CreditPosition {
    const balance = whole(balance_c);
    const line = Math.max(0, whole(line_c));
    const usable = Math.max(0, whole(usable_c));
    const owed = balance < 0 ? -balance : 0;
    return {
        sign: balance > 0 ? 'plus' : balance < 0 ? 'minus' : 'zero',
        balance_c: balance,
        owed_c: owed,
        line_c: line,
        over_c: Math.max(0, owed - line),
        paused: balance < -usable,
    };
}

/** A figure as the member's own Ledger draws it: to the hundredth where there is one, no sign. */
const B = (c: number) => formatHundredths(Math.abs(c));

/** "Balance +340", "Balance 0", "Balance −420 · using 420 of 1,300" or "Balance −60 · 60 more than their credit line": a real minus sign. */
export function balanceSentence(p: CreditPosition): string {
    if (p.sign === 'plus') return t('Balance +{amount}', { amount: B(p.balance_c) });
    if (p.sign === 'zero') return t('Balance 0');
    if (p.over_c > 0) return t('Balance −{owed} · {over} more than their credit line', { owed: B(p.owed_c), over: B(p.over_c) });
    return t('Balance −{owed} · using {owed} of {line}', { owed: B(p.owed_c), line: B(p.line_c) });
}

/** The same for a screen reader: "minus 420 Beans", never a dash read as nothing. */
export function balanceSpoken(p: CreditPosition): string {
    if (p.sign === 'plus') return t('Balance plus {amount} Beans', { amount: B(p.balance_c) });
    if (p.sign === 'zero') return t('Balance 0 Beans');
    if (p.over_c > 0) return t('Balance minus {owed} Beans, {over} more than their credit line', { owed: B(p.owed_c), over: B(p.over_c) });
    return t('Balance minus {owed} Beans, using {owed} of {line}', { owed: B(p.owed_c), line: B(p.line_c) });
}

// ── The row's credit sentence ────────────────────────────────────────────────────────────────────────────────────

export interface CreditLineFacts {
    line_c: number;
    usable_c: number;
    /** Their live Offers; null where the count isn't theirs to say (an admin key's, F4). */
    liveOffers: number | null;
    /** An admin froze the line (owners' and admins' answer only). */
    frozen?: boolean;
    /** They can't be given credit now (a voucher's answer: a freeze it is not told the cause of). */
    cantGive?: boolean;
}

/** One of: No credit yet (· n live Offers) · Credit line n · can use all / m of it now · asleep · frozen · can't be given. */
export function creditLineSentence(f: CreditLineFacts): string {
    if (f.frozen) return t('Credit line frozen by an admin');
    if (f.cantGive) return t('Can’t be given credit right now');
    const line = Math.max(0, whole(f.line_c));
    const usable = Math.min(line, Math.max(0, whole(f.usable_c)));
    if (line === 0) {
        return typeof f.liveOffers === 'number'
            ? tn(f.liveOffers, 'No credit yet · {n} live Offer', 'No credit yet · {n} live Offers', { n: formatCount(f.liveOffers) })
            : t('No credit yet');
    }
    if (usable >= line) return t('Credit line {line} · can use all of it now', { line: B(line) });
    if (usable === 0) return t('Credit line {line} · asleep until they post an Offer', { line: B(line) });
    return t('Credit line {line} · can use {usable} of it now', { line: B(line), usable: B(usable) });
}

// ── Credit risk ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Every fact the rules read. The server gathers them; a voucher's answer is trimmed there, never in an app. */
export interface CreditRiskFacts {
    // Open: any member reads these on a profile.
    completed: number;
    cancelled: number;
    daysHere: number;
    // Giver: the balance and the line.
    balance_c: number;
    line_c: number;
    usable_c: number;
    // Admins'.
    frozen: boolean;
    ring: boolean;
    disputeAgainst: boolean;
    /** Days since their last completed sale; null when they have never sold. */
    lastSaleDays: number | null;
    confirmed: boolean;
    /** Every completed trade so far inside their own circle (their inviter, the people they invited, who vouched for them, whom they vouched for). */
    insideOnly: boolean;
    /** Completed trades with people outside their own circle, and how many different people. */
    outsideTrades: number;
    outsidePartners: number;
    /** Their branch: the people they invited or vouched for, how many are below zero, and what was written off of credit they stood behind. */
    branchPeople: number;
    branchBelowZero: number;
    writtenOff_c: number;
    // The owner's two balance-rule settings (effectiveLines): "half" and "60 days".
    debtLinePct: number;
    quietDays: number;
}

export type RiskCode =
    | 'frozen' | 'over' | 'paused' | 'ring' | 'almost_all_quiet' | 'dispute' | 'completion' | 'written_off'
    | 'over_half' | 'below_zero_quiet' | 'branch_below' | 'inside_only' | 'cancelled'
    | 'confirmed' | 'established'
    | 'new' | 'few_trades';

/** One reason: its rule, its level, who may read it, and its figures (hundredths for money, counts otherwise). */
export interface RiskReason {
    code: RiskCode;
    level: RiskLevel;
    mark: ReasonMark;
    values: Record<string, number>;
}

export interface CreditRisk {
    level: RiskLevel;
    reasons: RiskReason[];
    /** A voucher's answer only: an admins' reason moved the level ("An owner or admin can say more."). */
    more: boolean;
}

const quiet = (f: CreditRiskFacts) => f.lastSaleDays === null || f.lastSaleDays >= f.quietDays;

/** Every rule that holds, at its own level (§4.2, amendment §4.2). Pure. */
export function riskReasons(f: CreditRiskFacts): RiskReason[] {
    const out: RiskReason[] = [];
    const add = (code: RiskCode, level: RiskLevel, mark: ReasonMark, values: Record<string, number> = {}) => out.push({ code, level, mark, values });
    const p = position(f.balance_c, f.line_c, f.usable_c);
    const ended = f.completed + f.cancelled;
    // High.
    if (f.frozen) add('frozen', 'high', 'admins');
    if (p.over_c > 0) add('over', 'high', 'giver', { owed: p.owed_c, over: p.over_c });
    else if (p.owed_c > 0 && p.paused) add('paused', 'high', 'giver', { owed: p.owed_c, usable: Math.max(0, whole(f.usable_c)) });
    if (f.ring) add('ring', 'high', 'admins');
    if (p.line_c > 0 && p.owed_c * 10 >= p.line_c * ALMOST_ALL_TENTHS && quiet(f)) add('almost_all_quiet', 'high', 'admins', { owed: p.owed_c, line: p.line_c, days: f.quietDays });
    if (f.disputeAgainst) add('dispute', 'high', 'admins');
    const poorCompletion = ended >= COMPLETION_MIN_ENDED && f.completed * 2 < ended;
    if (poorCompletion) add('completion', 'high', 'open');
    if (f.writtenOff_c > 0) add('written_off', 'high', 'admins');
    // Medium.
    if (p.over_c === 0 && p.line_c > 0 && p.owed_c * 100 > p.line_c * f.debtLinePct) add('over_half', 'medium', 'giver', { owed: p.owed_c, line: p.line_c, pct: f.debtLinePct });
    if (p.owed_c > 0 && quiet(f)) add('below_zero_quiet', 'medium', 'admins', { owed: p.owed_c, days: f.quietDays });
    if (f.branchBelowZero >= BRANCH_BELOW_MIN && f.branchBelowZero * 2 >= f.branchPeople) add('branch_below', 'medium', 'admins', { n: f.branchBelowZero, m: f.branchPeople });
    if (f.insideOnly) add('inside_only', 'medium', 'admins');
    // Fewer than half completed says it already, at high: the cancellations are its reason, not a second one.
    if (!poorCompletion && f.cancelled >= CANCELLED_MIN && f.completed * 10 < ended * 8) add('cancelled', 'medium', 'open', { n: f.cancelled });
    // Low: a reason to trust. A balance above zero is never one (amendment §4.2; §4.3, 2).
    if (f.confirmed) add('confirmed', 'low', 'admins');
    if (f.outsideTrades >= LOW_TRADES && f.outsidePartners >= LOW_PARTNERS && f.daysHere >= LOW_DAYS_HERE) add('established', 'low', 'admins', { n: f.outsideTrades, k: f.outsidePartners });
    // Not known yet: it is not a bad mark, it means start small.
    if (f.completed === 0) add('new', 'not_known', 'open');
    else add('few_trades', 'not_known', 'open', { n: f.completed });
    return out;
}

const levelOf = (reasons: readonly RiskReason[]): RiskLevel =>
    reasons.reduce<RiskLevel>((l, r) => (rank(r.level) > rank(l) ? r.level : l), 'not_known');

/** The reasons a surface draws for a level: every high and medium one when the level is either, else that level's own. */
function shown(reasons: readonly RiskReason[], level: RiskLevel): RiskReason[] {
    return rank(level) >= rank('medium')
        ? reasons.filter((r) => rank(r.level) >= rank('medium')).sort((a, b) => rank(b.level) - rank(a.level))
        : reasons.filter((r) => r.level === level);
}

/** The owners' and admins' answer: the worst rule's level and its reasons, every mark. */
export function creditRisk(f: CreditRiskFacts): CreditRisk {
    const all = riskReasons(f);
    const level = levelOf(all);
    return { level, reasons: shown(all, level), more: false };
}

/**
 * A voucher's answer: the same level, the open and giver reasons only, and `more` where an admins' reason moved the
 * level above what the open and giver reasons alone say. Built on the server; an app never trims an owner's answer.
 */
export function riskForVoucher(f: CreditRiskFacts): CreditRisk {
    const all = riskReasons(f);
    const level = levelOf(all);
    const theirs = all.filter((r) => r.mark !== 'admins');
    const visible = levelOf(theirs);
    return { level, reasons: shown(theirs, visible), more: rank(level) > rank(visible) };
}

/** "Credit risk: low", and its shape (never colour alone, §3.2): ○ not known, ✓ low, ! medium, ✕ high. */
export function riskLevelSentence(level: RiskLevel): string {
    switch (level) {
        case 'high': return t(CREDIT_SIGHT_WORDS.levelHigh);
        case 'medium': return t(CREDIT_SIGHT_WORDS.levelMedium);
        case 'low': return t(CREDIT_SIGHT_WORDS.levelLow);
        default: return t(CREDIT_SIGHT_WORDS.levelNotKnown);
    }
}
export const RISK_SHAPES: Readonly<Record<RiskLevel, string>> = { not_known: '○', low: '✓', medium: '!', high: '✕' };

/** A reason's one sentence, with its figures. A code this build doesn't know draws nothing (null). */
export function riskReasonSentence(r: RiskReason): string | null {
    const v = r.values ?? {};
    const days = () => tn(whole(v.days), '{n} day', '{n} days', { n: formatCount(whole(v.days)) });
    switch (r.code) {
        case 'frozen': return t('An admin froze their credit line.');
        case 'over': return t('They owe {owed}, {over} more than their credit line allows.', { owed: B(v.owed), over: B(v.over) });
        case 'paused': return t('Spending paused: they owe {owed}, more than the {usable} their Offers unlock.', { owed: B(v.owed), usable: B(v.usable) });
        case 'ring': return t('Their trades look like a ring: the same Beans going round a small group.');
        case 'almost_all_quiet': return t('They owe {owed} of {line}, almost all of it, and have made no sale for {days}.', { owed: B(v.owed), line: B(v.line), days: days() });
        case 'dispute': return t('An admin decided a dispute against them in the last 12 months.');
        case 'completion': return t('Fewer than half of their trades were completed.');
        case 'written_off': return t('Credit they stood behind was written off.');
        case 'over_half': return whole(v.pct) === 50
            ? t('They owe {owed} of {line}: more than half.', { owed: B(v.owed), line: B(v.line) })
            : t('They owe {owed} of {line}: more than {pct}%.', { owed: B(v.owed), line: B(v.line), pct: formatCount(whole(v.pct)) });
        case 'below_zero_quiet': return t('Below zero ({owed}) with no sale for {days}.', { owed: B(v.owed), days: days() });
        case 'branch_below': return t('{n} of the {m} people they stood behind are below zero.', { n: formatCount(whole(v.n)), m: formatCount(whole(v.m)) });
        case 'inside_only': return t('Only trades inside their own circle so far.');
        case 'cancelled': return tn(whole(v.n), '{n} trade cancelled.', '{n} trades cancelled.', { n: formatCount(whole(v.n)) });
        case 'confirmed': return t('Confirmed as known by an admin.');
        case 'established': return t('{n} completed trades with {k} different people outside their own circle.', { n: formatCount(whole(v.n)), k: formatCount(whole(v.k)) });
        case 'new': return t('New here: no completed trade yet.');
        case 'few_trades': return tn(whole(v.n), '{n} completed trade so far.', '{n} completed trades so far.', { n: formatCount(whole(v.n)) });
        default: return null;
    }
}

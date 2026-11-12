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
 * - {@link paidByGifts} (amendment 2, slice C8): for {@link GIFT_DAYS} days the five rules built from what someone owes read
 *   what they would owe by their own trading, so a friend's gift of Beans can't wash the word just before a giver looks.
 *   The row's balance and Spending paused stay the stored balance; a gift can never make a word worse.
 * - The sentences each surface draws: the row's credit line, the balance, the level and each reason, and the one sentence
 *   that tells every member who can see them (§5.3, {@link CREDIT_SIGHT_WORDS}.told).
 *
 * Every figure is whole hundredths of a Bean (`*_c`), as the ledger holds it; nothing here rounds a hundredth away.
 */
import { formatCount, t, tn, word } from './words.js';
import { formatHundredths, beans } from './hundredths.js';
import { VOUCH_MAX, VOUCH_PRESETS, VOUCHER_BUDGET_MAX, isBudgetLevel } from './vouch-presets.js';

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
/**
 * A gift of Beans stops counting toward the word this many days after it arrived (amendment 2 §2). A constant, never the
 * owner's "60 days" (7 to 3,650: ten years of rows would be walked, amendment 2 F19).
 */
export const GIFT_DAYS = 30;

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
    /**
     * What gifts of Beans paid off of what they owed in the last {@link GIFT_DAYS} days, not yet earned back by their own
     * trading ({@link paidByGifts}; 0 for nearly everyone). The five rules built from what they owe read what they would
     * owe by their own trading: what they owe now plus this (amendment 2 §2). Never the row's balance, which stays the stored one.
     */
    giftPaid_c: number;
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

// ── What a gift of Beans paid (amendment 2 §2, §4) ───────────────────────────────────────────────────────────────

/** One change to a stored balance, from its ledger row: what it added (+) or took (−), and whether it was a gift of Beans. */
export interface BalanceMove { delta_c: number; gift: boolean }

/**
 * What gifts of Beans paid off of what they owed, over the moves given (newest first, the last {@link GIFT_DAYS} days of
 * their own rows), not yet earned back by their own trading. Walked back from the stored balance: the most they owed at
 * any moment in those days, less everything that came in since that moment other than gifts, never less than what they
 * owe now; what gifts paid is that less what they owe now.
 *
 * Two properties hold for any history (core test 25): a gift added anywhere never raises what they owe now plus this, so
 * nobody can mark a person by sending them Beans; and this is never more than the gifts in the moves, so an odd row
 * cannot invent a debt larger than real gifts. A gift on a balance at or above zero counts for nothing.
 */
export function paidByGifts(balance_c: number, newestFirst: readonly BalanceMove[]): number {
    let bal = whole(balance_c); // the balance after the move in hand
    const owedNow = Math.max(0, -bal);
    let counted = owedNow;
    let own = 0; // Beans in since then that were not gifts
    for (const m of newestFirst) {
        const d = whole(m?.delta_c);
        if (d > 0 && !m.gift) own += d;
        bal -= d; // the balance just before this move
        counted = Math.max(counted, Math.max(0, -bal) - own);
    }
    return counted - owedNow;
}

/** Every rule that holds, at its own level (§4.2, amendment §4.2). Pure. */
export function riskReasons(f: CreditRiskFacts): RiskReason[] {
    const out: RiskReason[] = [];
    const add = (code: RiskCode, level: RiskLevel, mark: ReasonMark, values: Record<string, number> = {}) => out.push({ code, level, mark, values });
    // The five rules built from what they owe read what they would owe by their own trading: what they owe now, plus what a
    // gift of Beans paid in the last GIFT_DAYS days (amendment 2 §2). The row's balance and Spending paused read `now`.
    const now = position(f.balance_c, f.line_c, f.usable_c);
    const gift = Math.max(0, whole(f.giftPaid_c));
    const p = gift > 0 ? position(-(now.owed_c + gift), f.line_c, f.usable_c) : now;
    /** A rule's figures, and how much a gift paid when one did (its sentence then takes its second form). */
    const owing = (values: Record<string, number>) => (gift > 0 ? { ...values, gift, giftDays: GIFT_DAYS } : values);
    const ended = f.completed + f.cancelled;
    // High.
    if (f.frozen) add('frozen', 'high', 'admins');
    if (p.over_c > 0) add('over', 'high', 'giver', owing({ owed: p.owed_c, over: p.over_c }));
    else if (p.owed_c > 0 && p.paused) add('paused', 'high', 'giver', owing({ owed: p.owed_c, usable: Math.max(0, whole(f.usable_c)) }));
    if (f.ring) add('ring', 'high', 'admins');
    if (p.line_c > 0 && p.owed_c * 10 >= p.line_c * ALMOST_ALL_TENTHS && quiet(f)) add('almost_all_quiet', 'high', 'admins', owing({ owed: p.owed_c, line: p.line_c, days: f.quietDays }));
    if (f.disputeAgainst) add('dispute', 'high', 'admins');
    const poorCompletion = ended >= COMPLETION_MIN_ENDED && f.completed * 2 < ended;
    if (poorCompletion) add('completion', 'high', 'open');
    if (f.writtenOff_c > 0) add('written_off', 'high', 'admins');
    // Medium.
    if (p.over_c === 0 && p.line_c > 0 && p.owed_c * 100 > p.line_c * f.debtLinePct) add('over_half', 'medium', 'giver', owing({ owed: p.owed_c, line: p.line_c, pct: f.debtLinePct }));
    if (p.owed_c > 0 && quiet(f)) add('below_zero_quiet', 'medium', 'admins', owing({ owed: p.owed_c, days: f.quietDays }));
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

/**
 * A reason's one sentence, with its figures. A code this build doesn't know draws nothing (null). Where a gift of Beans
 * paid what they owe (`values.gift`, amendment 2 §4), the five rules built from it say what they would owe by their own
 * trading, then one shared sentence says how much the gift paid: never "They owe" (the row reads the real balance) and
 * never "Spending paused" (the row's own mark, which may not hold now). No name and no date, ever.
 */
export function riskReasonSentence(r: RiskReason): string | null {
    const v = r.values ?? {};
    const days = () => tn(whole(v.days), '{n} day', '{n} days', { n: formatCount(whole(v.days)) });
    const gift = whole(v.gift) > 0;
    const giftDays = whole(v.giftDays) > 0 ? whole(v.giftDays) : GIFT_DAYS;
    /** The second form's last sentence, one for all five: what the gift paid, and in how many days. No name, no date. */
    const paid = () => tn(giftDays, 'A gift of Beans paid {gift} of it in the last {n} day.', 'A gift of Beans paid {gift} of it in the last {n} days.',
        { gift: B(v.gift), n: formatCount(giftDays) });
    switch (r.code) {
        case 'frozen': return t('An admin froze their credit line.');
        case 'over': return gift
            ? t('By their own trading they would owe {owed}, {over} more than their credit line allows. {paid}', { owed: B(v.owed), over: B(v.over), paid: paid() })
            : t('They owe {owed}, {over} more than their credit line allows.', { owed: B(v.owed), over: B(v.over) });
        case 'paused': return gift
            ? t('By their own trading they would owe {owed}, more than the {usable} their Offers unlock. {paid}', { owed: B(v.owed), usable: B(v.usable), paid: paid() })
            : t('Spending paused: they owe {owed}, more than the {usable} their Offers unlock.', { owed: B(v.owed), usable: B(v.usable) });
        case 'ring': return t('Their trades look like a ring: the same Beans going round a small group.');
        case 'almost_all_quiet': return gift
            ? t('By their own trading they would owe {owed} of {line}, almost all of it, and they have made no sale for {days}. {paid}', { owed: B(v.owed), line: B(v.line), days: days(), paid: paid() })
            : t('They owe {owed} of {line}, almost all of it, and have made no sale for {days}.', { owed: B(v.owed), line: B(v.line), days: days() });
        case 'dispute': return t('An admin decided a dispute against them in the last 12 months.');
        case 'completion': return t('Fewer than half of their trades were completed.');
        case 'written_off': return t('Credit they stood behind was written off.');
        case 'over_half': {
            const half = whole(v.pct) === 50;
            if (gift) {
                return half
                    ? t('By their own trading they would owe {owed} of {line}: more than half. {paid}', { owed: B(v.owed), line: B(v.line), paid: paid() })
                    : t('By their own trading they would owe {owed} of {line}: more than {pct}%. {paid}', { owed: B(v.owed), line: B(v.line), pct: formatCount(whole(v.pct)), paid: paid() });
            }
            return half
                ? t('They owe {owed} of {line}: more than half.', { owed: B(v.owed), line: B(v.line) })
                : t('They owe {owed} of {line}: more than {pct}%.', { owed: B(v.owed), line: B(v.line), pct: formatCount(whole(v.pct)) });
        }
        case 'below_zero_quiet': return gift
            ? t('By their own trading they would be below zero ({owed}), with no sale for {days}. {paid}', { owed: B(v.owed), days: days(), paid: paid() })
            : t('Below zero ({owed}) with no sale for {days}.', { owed: B(v.owed), days: days() });
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

// ── Vouchers' budgets on the view (amendment §3.5, §3.6; slice C3) ─────────────────────────────────────────────────

/**
 * Running low: under VOUCH_MAX left (100 Beans), the most one voucher's vouches for one person come to, so under it they
 * can no longer give anyone a full vouch (amendment §3.5). What is LEFT, never the level: a 2,000 budget with 99 left is low.
 * An owner vouches with no limit and is never flagged (the server never asks this for one).
 */
export function runningLow(left_c: number): boolean {
    return whole(left_c) < VOUCH_MAX;
}

/** Nothing left to vouch with: under the smallest vouch preset (25 Beans) left. */
export function nothingLeft(left_c: number): boolean {
    return whole(left_c) < Math.min(...VOUCH_PRESETS);
}

/** The levels a top-up offers past the last level set: 500 · 1,000 · 1,500 · 2,000 (amendment §3.5). */
export const TOP_UP_LEVELS: readonly number[] = [beans(500), beans(1000), beans(1500), beans(2000)];

/**
 * The one level "Top up to {level}" offers (amendment §3.5), the node's offer in the row, never worked out in an app: the
 * level this voucher was last set to (`lastLevel_c`: the newest grant, top-up or lower for them; the community's setting
 * when there is none) when they have less than that in hand; otherwise the next of {@link TOP_UP_LEVELS} above what they
 * have in hand; null at the ceiling (2,000 in hand: "At the most a voucher can hold."). `inHand_c` is left and held together.
 */
export function topUpTarget(inHand_c: number, lastLevel_c: number): number | null {
    const inHand = Math.max(0, whole(inHand_c));
    if (inHand >= VOUCHER_BUDGET_MAX) return null;
    if (isBudgetLevel(lastLevel_c) && inHand < lastLevel_c) return lastLevel_c;
    return TOP_UP_LEVELS.find((l) => l > inHand) ?? null;
}

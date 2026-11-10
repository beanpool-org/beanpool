/**
 * Standing deals: paying for something by the week or by the month (scratch/fable-design/DESIGN-standing-deals-upfront-fable.md
 * and its amendment; Marty's decisions, 10 Nov 2026). Pure and universal: imported by both apps and the server.
 *
 * THE MODEL. A listing priced per week or per month makes a standing deal when it is taken up (hourly, daily and fixed prices
 * stay one-off deals). Each period is PAID AT ITS START, and nothing is ever held in trust: at Agree (an Offer) or Approve (a
 * Need) the first period's Beans go to the payee at once, less the 1.5% to the Commons; at each period's end the node pays the
 * next the same way, until the count is reached or one of them stops it. Each period is one finished deal row and one
 * ledger row. A period that can't be paid when it is due makes the standing deal short: the node tries again for half that
 * period (the grace), either side may stop it at once, Beans that reach the payer pay the whole period at once, and when the
 * grace is over it ends with nothing owed through the app.
 *
 * THE CALENDAR. Period n runs [start + (n-1) units, start + n units), worked out from the start every time, in UTC, never
 * from the previous period's end, so it never drifts: weeks are exact (7 × 24 h); a month keeps the start's day and time of
 * day, and a day the month doesn't have (the 31st in April, the 29th–31st in February) is clamped to its last day. A start
 * on 31 January ends its periods on 28 (or 29) February, 31 March, 30 April, 31 May, …
 *
 * THE AUTHORISATION. The payer signs one text with their key when it starts: the community's host, the standing deal's id,
 * the listing, the payee, the Beans per period, the period, how many periods (or open) and the start. The node keeps it, and
 * every period it pays must match it: never more, more often, past the count, or to anyone else.
 */

import { randomBytes } from '@noble/hashes/utils.js';
import { audienceOf, signedRequestBytes, toBase64, type Signer } from './request-signing.js';
import { t, tn } from './words.js';
import { formatHundredths, isHundredths, type Hundredths } from './hundredths.js';

/** The two periods a standing deal runs by. */
export type StandingPeriodUnit = 'week' | 'month';

/**
 * Where a standing deal is (the node's `standing_deals.phase`):
 *  - paid: every period due so far is paid; the next is paid at its start;
 *  - short: the period now due couldn't be paid; the node tries again until its grace ends (half the period), then it ends;
 *  - ended: nothing more is paid.
 */
export type StandingPhase = 'paid' | 'short' | 'ended';
export const STANDING_PHASES: readonly StandingPhase[] = Object.freeze(['paid', 'short', 'ended']);

/** Why a standing deal ended (`standing_deals.ended_reason`). */
export type StandingEndReason = 'stopped' | 'count_reached' | 'short' | 'listing_gone' | 'account_closed' | 'server_away' | 'cant_run';

/** How often the node tries again to pay a period that is short (amendment §3). */
export const STANDING_RETRY_MS = 60 * 60 * 1000;
/** How long before a period is due the payer is told they will be short: 3 days for a month, 1 day for a week. */
export function standingWarnAheadMs(unit: StandingPeriodUnit): number {
    return (unit === 'month' ? 3 : 1) * 86_400_000;
}
/** How far ahead a standing deal may start ("up to 30 days ahead"). */
export const STANDING_START_AHEAD_MS = 30 * 86_400_000;

/** The listing's price unit that makes a standing deal (decision 1), or null for one that makes a one-off deal. */
export function standingUnitOf(priceType: string | null | undefined): StandingPeriodUnit | null {
    if (priceType === 'weekly') return 'week';
    if (priceType === 'monthly') return 'month';
    return null;
}

/**
 * Whether taking this listing up makes a standing deal, and by which period: both apps ask this one rule (the take-up, a
 * Need's approval). Priced per week or per month, AND for more than 0 Beans: a free one (listing-price.ts: 0 by the week or
 * the month is free) has nothing to hold each period, and its authorisation could not name 0 Beans (isStandingAuthorisation,
 * the node's checkStandingStart), so it stays the one-off deal of 0 Beans it was before S2 (round 2 of #3000).
 */
export function standingUnitForListing(priceType: string | null | undefined, price: Hundredths | null | undefined): StandingPeriodUnit | null {
    const unit = standingUnitOf(priceType);
    return unit && isHundredths(price) && price > 0 ? unit : null;
}

const WEEK_MS = 7 * 86_400_000;

function daysInMonthUtc(year: number, month0: number): number {
    return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/** The start moved on `k` whole units (k ≥ 0), as a time in ms: exact weeks, or months with the day clamped. */
function addUnits(startMs: number, unit: StandingPeriodUnit, k: number): number {
    if (unit === 'week') return startMs + k * WEEK_MS;
    const d = new Date(startMs);
    const total = d.getUTCMonth() + k;
    const year = d.getUTCFullYear() + Math.floor(total / 12);
    const month0 = ((total % 12) + 12) % 12;
    const day = Math.min(d.getUTCDate(), daysInMonthUtc(year, month0));
    return Date.UTC(year, month0, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

function startMsOf(startsAt: string | number): number {
    const ms = typeof startsAt === 'number' ? startsAt : Date.parse(startsAt);
    if (!Number.isFinite(ms)) throw new RangeError('A standing deal needs a start that is a date');
    return ms;
}

function assertPeriod(n: number): void {
    if (!Number.isInteger(n) || n < 1) throw new RangeError('A period is numbered from 1');
}

/** When period `n` (from 1) starts: the start moved on n − 1 units. ISO, UTC. */
export function periodStart(startsAt: string | number, unit: StandingPeriodUnit, n: number): string {
    assertPeriod(n);
    return new Date(addUnits(startMsOf(startsAt), unit, n - 1)).toISOString();
}

/** When period `n` (from 1) ends, and the next starts: the start moved on n units. ISO, UTC. */
export function periodEnd(startsAt: string | number, unit: StandingPeriodUnit, n: number): string {
    assertPeriod(n);
    return new Date(addUnits(startMsOf(startsAt), unit, n)).toISOString();
}

/**
 * Which period the moment `at` falls in (from 1), or 0 before the start. A moment at a period's end is in the next one, as
 * the periods are [start, end).
 */
export function periodNo(startsAt: string | number, unit: StandingPeriodUnit, at: string | number): number {
    const startMs = startMsOf(startsAt);
    const atMs = typeof at === 'number' ? at : Date.parse(at);
    if (!Number.isFinite(atMs) || atMs < startMs) return 0;
    // A first guess from the average length, then stepped to the exact period (at most a step or two either way).
    const avg = unit === 'week' ? WEEK_MS : 30.436875 * 86_400_000;
    let n = Math.max(1, Math.floor((atMs - startMs) / avg) + 1);
    while (n > 1 && addUnits(startMs, unit, n - 1) > atMs) n--;
    while (addUnits(startMs, unit, n) <= atMs) n++;
    return n;
}

/**
 * The grace of period `n` (amendment §2, Marty 10 Nov): half that period on the calendar, from its start (when it is due).
 * 15 days for a 30-day month, 14 for February, 3½ days for a week.
 */
export function standingGraceMs(startsAt: string | number, unit: StandingPeriodUnit, n: number): number {
    return (Date.parse(periodEnd(startsAt, unit, n)) - Date.parse(periodStart(startsAt, unit, n))) / 2;
}

/** When the grace of period `n` ends: its start plus half of it. ISO, UTC. */
export function standingGraceEndsAt(startsAt: string | number, unit: StandingPeriodUnit, n: number): string {
    return new Date(Date.parse(periodStart(startsAt, unit, n)) + standingGraceMs(startsAt, unit, n)).toISOString();
}

// ── The authorisation (§6) ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The first line of every standing authorisation: its format. v2 carries the amount as whole hundredths of a Bean, an
 * integer (DESIGN-atomic-beans-fable.md §1), so no v1 text (Beans to the cent) parses.
 */
export const STANDING_AUTH_VERSION = 'beanpool-standing-v2';

/** What the payer agrees to, once, when a standing deal starts (and again when they extend it). */
export interface StandingAuthorisation {
    /** The community's host the app signed for (one of its names). */
    host: string;
    /** The standing deal's id, made by the app (a UUID). */
    standingId: string;
    /** The listing taken up. */
    listingId: string;
    /** Who is paid: the listing's author on an Offer, the helper on a Need. 64 lower-case hex. */
    payee: string;
    /** Per period, whole hundredths of a Bean (above 0). */
    beansPerPeriod_c: Hundredths;
    unit: StandingPeriodUnit;
    /** How many periods, or null for until one of them stops it. */
    maxPeriods: number | null;
    /** When the first period starts: ISO, UTC, as Date.prototype.toISOString writes it. */
    startsAt: string;
    /** Fresh for each text, so no two authorisations are the same text. */
    nonce: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A host in the one form apps sign (lower case, no port, no trailing dot), or a bracketed IPv6 address. */
const HOST = /^(?=.{1,253}$)(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/;
const NONCE = /^[A-Za-z0-9_-]{8,128}$/;
/** The amount line: whole hundredths, above 0, at most 11 digits, no leading zero. */
const HUNDREDTHS_LINE = /^[1-9]\d{0,10}$/;
/** The largest number of periods one authorisation may name (about 19 years of months). */
export const STANDING_MAX_PERIODS = 240;


/** Whether a start is written exactly as toISOString writes it (one spelling per instant, so the text is canonical). */
function isCanonicalIso(s: string): boolean {
    const ms = Date.parse(s);
    return Number.isFinite(ms) && new Date(ms).toISOString() === s;
}

/** Whether every field is one the text can carry, as parseStandingAuthorisation reads it back. */
export function isStandingAuthorisation(a: StandingAuthorisation): boolean {
    return !!a
        && typeof a.host === 'string' && HOST.test(a.host)
        && typeof a.standingId === 'string' && SAFE_ID.test(a.standingId)
        && typeof a.listingId === 'string' && SAFE_ID.test(a.listingId)
        && typeof a.payee === 'string' && HEX64.test(a.payee)
        && isHundredths(a.beansPerPeriod_c) && a.beansPerPeriod_c > 0 && HUNDREDTHS_LINE.test(String(a.beansPerPeriod_c))
        && (a.unit === 'week' || a.unit === 'month')
        && (a.maxPeriods === null || (Number.isInteger(a.maxPeriods) && a.maxPeriods >= 1 && a.maxPeriods <= STANDING_MAX_PERIODS))
        && typeof a.startsAt === 'string' && isCanonicalIso(a.startsAt)
        && typeof a.nonce === 'string' && NONCE.test(a.nonce);
}

/**
 * The exact text the payer signs (§6): ten lines joined by "\n", no line break at the end. Both apps build it here and the
 * node rebuilds it here, so the bytes are the same. Throws for a field the text can't carry.
 */
export function standingAuthorisationText(a: StandingAuthorisation): string {
    if (!isStandingAuthorisation(a)) throw new RangeError('A standing authorisation needs every field, each in its form');
    return [
        STANDING_AUTH_VERSION,
        a.host,
        a.standingId,
        a.listingId,
        a.payee,
        String(a.beansPerPeriod_c),
        a.unit,
        a.maxPeriods === null ? 'open' : String(a.maxPeriods),
        a.startsAt,
        a.nonce,
    ].join('\n');
}

/**
 * The authorisation a text says, or null for any text that isn't exactly one standingAuthorisationText writes: a line
 * missing or added, a field out of its form, an amount not to the cent, a start not in its one spelling. So
 * standingAuthorisationText(parse(text)) === text for every text this accepts.
 */
export function parseStandingAuthorisation(text: unknown): StandingAuthorisation | null {
    if (typeof text !== 'string' || text.length > 2048) return null;
    const lines = text.split('\n');
    if (lines.length !== 10 || lines[0] !== STANDING_AUTH_VERSION) return null;
    const [, host, standingId, listingId, payee, beans, unit, max, startsAt, nonce] = lines;
    if (!HUNDREDTHS_LINE.test(beans)) return null;
    if (unit !== 'week' && unit !== 'month') return null;
    let maxPeriods: number | null;
    if (max === 'open') maxPeriods = null;
    else if (/^[1-9]\d{0,3}$/.test(max)) maxPeriods = Number(max);
    else return null;
    const a: StandingAuthorisation = { host, standingId, listingId, payee, beansPerPeriod_c: Number(beans), unit, maxPeriods, startsAt, nonce };
    if (!isStandingAuthorisation(a)) return null;
    return standingAuthorisationText(a) === text ? a : null;
}

/** The ledger row's `auth_payload` of a period the node pays under a standing authorisation: `standing:<id>:<n>`. */
export function standingPaymentPayload(standingId: string, periodNo: number): string {
    return `standing:${standingId}:${periodNo}`;
}

// ── The words, one set for both apps and the node's notices ─────────────────────────────────────────────────────────

/** A figure in the words: whole hundredths (formatHundredths). */
const n2 = (c: Hundredths) => formatHundredths(c);

/**
 * Every sentence a member reads about a standing deal. Amounts are numbers (formatted here); names, titles and dates come
 * formatted. Each sentence is written once per period, so a translation never has to fit "week" or "month" into another
 * sentence. The payee's sentences never carry the payer's balance or how short they are (amendment §2).
 */
export const standingLines = {
    // Taking it up (design §3)
    takeUpTitle: () => t('Take this up?'),
    takeUpSummary: (unit: StandingPeriodUnit, title: string, beans: number, name: string) => (unit === 'month'
        ? t('{title} · {n} Beans a month · from {name}', { title, n: n2(beans), name })
        : t('{title} · {n} Beans a week · from {name}', { title, n: n2(beans), name })),
    howLong: () => t('How long?'),
    untilStopped: () => t('Until one of us stops it'),
    forPeriods: (unit: StandingPeriodUnit, k: number) => (unit === 'month'
        ? tn(k, 'For {n} month', 'For {n} months')
        : tn(k, 'For {n} week', 'For {n} weeks')),
    startLabel: () => t('Start:'),
    startToday: () => t('Today'),
    startOn: (date: string) => t('On {date}', { date }),
    startAhead: () => t('Up to 30 days ahead'),
    paidNow: (unit: StandingPeriodUnit, beans: number, name: string, from: string, to: string) => (unit === 'month'
        ? t('{n} Beans go to {name} now for the first month ({from} – {to}), then {n} at the start of each month, until one of you stops it.', { n: n2(beans), name, from, to })
        : t('{n} Beans go to {name} now for the first week ({from} – {to}), then {n} at the start of each week, until one of you stops it.', { n: n2(beans), name, from, to })),
    howItRuns: (unit: StandingPeriodUnit) => (unit === 'month'
        ? t('You can stop it any time. A month already paid stays paid.')
        : t('You can stop it any time. A week already paid stays paid.')),
    shortAhead: (unit: StandingPeriodUnit) => (unit === 'month'
        ? t("If you're short when a month is due, you'll be told a few days before.")
        : t("If you're short when a week is due, you'll be told the day before.")),
    agree: (beans: number) => t('Agree and pay {n} Beans', { n: n2(beans) }),

    // The deal card while it runs (design §3)
    since: (unit: StandingPeriodUnit, date: string, beans: number) => (unit === 'month'
        ? t('🔁 Standing deal since {date} · {n} Beans a month', { date, n: n2(beans) })
        : t('🔁 Standing deal since {date} · {n} Beans a week', { date, n: n2(beans) })),
    paidPayer: (unit: StandingPeriodUnit, beans: number, name: string, paidOn: string, nextOn: string) => (unit === 'month'
        ? t("This month's {n} went to {name} on {paid} · the next {n} go on {next}", { n: n2(beans), name, paid: paidOn, next: nextOn })
        : t("This week's {n} went to {name} on {paid} · the next {n} go on {next}", { n: n2(beans), name, paid: paidOn, next: nextOn })),
    paidPayee: (unit: StandingPeriodUnit, name: string, beans: number, paidOn: string, nextOn: string) => (unit === 'month'
        ? t("{name}'s standing deal · {n} Beans a month · paid for this month on {paid} · next on {next}", { name, n: n2(beans), paid: paidOn, next: nextOn })
        : t("{name}'s standing deal · {n} Beans a week · paid for this week on {paid} · next on {next}", { name, n: n2(beans), paid: paidOn, next: nextOn })),
    shortPayer: (unit: StandingPeriodUnit, beans: number, date: string) => (unit === 'month'
        ? t("⚠️ This month's {n} Beans couldn't be paid · {n} needed by {date} or it ends", { n: n2(beans), date })
        : t("⚠️ This week's {n} Beans couldn't be paid · {n} needed by {date} or it ends", { n: n2(beans), date })),
    shortPayee: (unit: StandingPeriodUnit, date: string) => (unit === 'month'
        ? t("This month isn't paid yet · we'll keep trying until {date}", { date })
        : t("This week isn't paid yet · we'll keep trying until {date}", { date })),
    stopsOn: (unit: StandingPeriodUnit, date: string) => (unit === 'month'
        ? t('Stops on {date} · this month is paid', { date })
        : t('Stops on {date} · this week is paid', { date })),
    stop: () => t('Stop…'),
    stopNow: () => t('Stop now'),
    periodOf: (unit: StandingPeriodUnit, n: number, k: number) => (unit === 'month'
        ? t('Month {n} of {k}', { n, k })
        : t('Week {n} of {k}', { n, k })),
    chip: () => t('🔁 STANDING'),
    memo: (unit: StandingPeriodUnit, title: string, n: number) => (unit === 'month'
        ? t('Standing deal · {title} · month {n}', { title, n })
        : t('Standing deal · {title} · week {n}', { title, n })),

    // Stop, asked first (design §3; amendment §1 in the grace)
    stopConfirm: (unit: StandingPeriodUnit) => (unit === 'month' ? t('Stop after this month?') : t('Stop after this week?')),
    stopConfirmPayer: (unit: StandingPeriodUnit, name: string) => (unit === 'month'
        ? t("You've paid for this month; {name} keeps it; nothing more is paid.", { name })
        : t("You've paid for this week; {name} keeps it; nothing more is paid.", { name })),
    stopConfirmPayee: (date: string) => t('Nothing more will be paid to you after {date}.', { date }),
    stopNowConfirm: () => t('Stop it now?'),
    stopNowConfirmPayer: (unit: StandingPeriodUnit, beans: number, name: string, date: string) => (unit === 'month'
        ? t("It ends now. This month's {n} Beans aren't paid and won't be; nothing is owed through the app for the days since {date}. Talk to {name} about it.", { n: n2(beans), name, date })
        : t("It ends now. This week's {n} Beans aren't paid and won't be; nothing is owed through the app for the days since {date}. Talk to {name} about it.", { n: n2(beans), name, date })),
    stopNowConfirmPayee: (unit: StandingPeriodUnit, beans: number, date: string) => (unit === 'month'
        ? t("It ends now. This month's {n} Beans won't come; nothing is owed through the app for the days since {date}.", { n: n2(beans), date })
        : t("It ends now. This week's {n} Beans won't come; nothing is owed through the app for the days since {date}.", { n: n2(beans), date })),

    // Refusals
    keeperPayee: () => t("A standing deal can't pay a keeper of the enterprise that pays it. Pay each job as a deal."),
    holidayPayer: (title: string) => t('Stop your standing deal for {title} first.', { title }),
    removeStops: (unit: StandingPeriodUnit, count: number) => (unit === 'month'
        ? tn(count, 'This stops {n} standing deal after its current month.', 'This stops {n} standing deals after their current month.')
        : tn(count, 'This stops {n} standing deal after its current week.', 'This stops {n} standing deals after their current week.')),
    authMismatch: () => t("The standing deal's agreement doesn't match this listing. Close it and try again."),
    payerOnly: () => t('Only the one who pays can do this.'),

    // What happened, as a notice (a push and a bell row; amendment §2)
    noticeTitle: () => t('🔁 Standing deal'),
    shortAheadNotice: (title: string, beans: number, name: string, date: string, short: number) =>
        t("{title}: {n} Beans go to {name} on {date} and you're {short} short. Earn or receive Beans by then, or stop the standing deal.", { title, n: n2(beans), name, date, short: n2(short) }),
    duePayer: (unit: StandingPeriodUnit, title: string, beans: number, name: string, until: string) => (unit === 'month'
        ? t("{title}: this month's {n} Beans couldn't be paid to {name} today. Earn or receive Beans by {date}, or it ends. {name} has been told.", { title, n: n2(beans), name, date: until })
        : t("{title}: this week's {n} Beans couldn't be paid to {name} today. Earn or receive Beans by {date}, or it ends. {name} has been told.", { title, n: n2(beans), name, date: until })),
    duePayee: (unit: StandingPeriodUnit, name: string, beans: number, title: string, until: string) => (unit === 'month'
        ? t("{name}'s {n} Beans for this month of {title} couldn't be paid today. We'll keep trying until {date}. You can stop it now.", { name, n: n2(beans), title, date: until })
        : t("{name}'s {n} Beans for this week of {title} couldn't be paid today. We'll keep trying until {date}. You can stop it now.", { name, n: n2(beans), title, date: until })),
    halfwayPayer: (title: string, beans: number, days: number, until: string) =>
        tn(days, '{title}: {beans} Beans {n} day overdue. Earn or receive Beans by {date}, or it ends.', '{title}: {beans} Beans {n} days overdue. Earn or receive Beans by {date}, or it ends.', { title, beans: n2(beans), date: until }),
    halfwayPayee: (name: string, beans: number, title: string, days: number, until: string) =>
        tn(days, "{name}'s {beans} Beans for {title} are {n} day overdue. We keep trying until {date}; you can stop it now.", "{name}'s {beans} Beans for {title} are {n} days overdue. We keep trying until {date}; you can stop it now.", { name, beans: n2(beans), title, date: until }),
    dayBeforePayer: (title: string, beans: number, name: string, until: string) =>
        t('{title} ends on {date} unless {n} Beans reach {name} by then.', { title, n: n2(beans), name, date: until }),
    dayBeforePayee: (unit: StandingPeriodUnit, name: string, title: string, beans: number, until: string) => (unit === 'month'
        ? t("{name}'s {title} ends on {date} unless this month's {n} Beans arrive by then.", { name, title, n: n2(beans), date: until })
        : t("{name}'s {title} ends on {date} unless this week's {n} Beans arrive by then.", { name, title, n: n2(beans), date: until })),
    coveredPayer: (unit: StandingPeriodUnit, title: string, beans: number, name: string) => (unit === 'month'
        ? t("{title}: this month's {n} Beans have gone to {name}.", { title, n: n2(beans), name })
        : t("{title}: this week's {n} Beans have gone to {name}.", { title, n: n2(beans), name })),
    coveredPayee: (unit: StandingPeriodUnit, name: string, beans: number, title: string) => (unit === 'month'
        ? t("{name}'s {n} Beans for this month of {title} came in.", { name, n: n2(beans), title })
        : t("{name}'s {n} Beans for this week of {title} came in.", { name, n: n2(beans), title })),
    endedShortPayer: (unit: StandingPeriodUnit, title: string, name: string) => (unit === 'month'
        ? t("{title} ended: this month's Beans couldn't be paid. Nothing more will be taken. Talk to {name} about it.", { title, name })
        : t("{title} ended: this week's Beans couldn't be paid. Nothing more will be taken. Talk to {name} about it.", { title, name })),
    endedShortPayee: (unit: StandingPeriodUnit, name: string, title: string, date: string) => (unit === 'month'
        ? t("{name}'s {title} ended: this month's Beans couldn't be paid. Nothing is owed through the app for the days since {date}.", { name, title, date })
        : t("{name}'s {title} ended: this week's Beans couldn't be paid. Nothing is owed through the app for the days since {date}.", { name, title, date })),
    stoppedInGraceByPayer: (unit: StandingPeriodUnit, name: string, title: string, beans: number, date: string) => (unit === 'month'
        ? t("{name} stopped {title}. This month's {n} Beans weren't paid; nothing is owed through the app for the days since {date}.", { name, title, n: n2(beans), date })
        : t("{name} stopped {title}. This week's {n} Beans weren't paid; nothing is owed through the app for the days since {date}.", { name, title, n: n2(beans), date })),
    stoppedInGraceByPayee: (unit: StandingPeriodUnit, name: string, title: string, beans: number) => (unit === 'month'
        ? t("{name} stopped {title}. This month's {n} Beans aren't taken; nothing is owed through the app. Talk to {name} about it.", { name, title, n: n2(beans) })
        : t("{name} stopped {title}. This week's {n} Beans aren't taken; nothing is owed through the app. Talk to {name} about it.", { name, title, n: n2(beans) })),
    paidIn: (unit: StandingPeriodUnit, beans: number, title: string, name: string, n: number) => (unit === 'month'
        ? t('{beans} Beans for {title} came in from {name} · month {n}', { beans: n2(beans), title, name, n })
        : t('{beans} Beans for {title} came in from {name} · week {n}', { beans: n2(beans), title, name, n })),
    stoppedBy: (unit: StandingPeriodUnit, name: string, title: string, date: string) => (unit === 'month'
        ? t('{name} stopped the standing deal for {title}. This month is paid; it ends on {date} and nothing more is paid.', { name, title, date })
        : t('{name} stopped the standing deal for {title}. This week is paid; it ends on {date} and nothing more is paid.', { name, title, date })),
    lastPeriod: (unit: StandingPeriodUnit, title: string, date: string) => (unit === 'month'
        ? t('{title}: the last month of this standing deal is paid. It ends on {date}.', { title, date })
        : t('{title}: the last week of this standing deal is paid. It ends on {date}.', { title, date })),
    ended: (title: string) => t('The standing deal for {title} has ended. Nothing more will be paid.', { title }),
    serverAway: (title: string) => t("This community's server was away for longer than a whole period, so the standing deal for {title} has ended and nothing was paid for it. Talk to each other, and take it up again if you both want to.", { title }),
    cantRun: (title: string) => t("The standing deal for {title} can't carry on, so it has ended. Nothing more will be paid.", { title }),

    // The record in the deal's chat: one SYSTEM line both sides read, so said of both by name (amendment §2)
    chatDue: (unit: StandingPeriodUnit, payer: string, beans: number, title: string, until: string) => (unit === 'month'
        ? t("{name}'s {n} Beans for this month of {title} couldn't be paid when due. We keep trying until {date}, then it ends.", { name: payer, n: n2(beans), title, date: until })
        : t("{name}'s {n} Beans for this week of {title} couldn't be paid when due. We keep trying until {date}, then it ends.", { name: payer, n: n2(beans), title, date: until })),
    chatCovered: (unit: StandingPeriodUnit, payer: string, beans: number, title: string, payee: string) => (unit === 'month'
        ? t("{name}'s {n} Beans for this month of {title} have gone to {payee}.", { name: payer, n: n2(beans), title, payee })
        : t("{name}'s {n} Beans for this week of {title} have gone to {payee}.", { name: payer, n: n2(beans), title, payee })),
    chatEndedShort: (unit: StandingPeriodUnit, title: string, date: string) => (unit === 'month'
        ? t("{title} ended: this month's Beans couldn't be paid. Nothing is owed through the app for the days since {date}.", { title, date })
        : t("{title} ended: this week's Beans couldn't be paid. Nothing is owed through the app for the days since {date}.", { title, date })),
    /** Either side's Stop in the grace, as the record says it: the payee is told the same words when the payer stops. */
    chatStoppedInGrace: (unit: StandingPeriodUnit, name: string, title: string, beans: number, date: string): string =>
        standingLines.stoppedInGraceByPayer(unit, name, title, beans, date),
};

// ── Taking it up, signed (§2.2, §6; slice S2: both apps) ──────────────────────────────────────────────────────────────

/** What an app fills in to take a standing deal up: everything but the host, which comes from where the request goes. */
export type StandingAuthorisationFields = Omit<StandingAuthorisation, 'host'>;

/** The `standing` an accept (an Offer) or an approval (a Need) carries: the signed text and what the screen showed. */
export interface StandingStartBody {
    authorisation: { payload: string; signature: string };
    untilStopped?: true;
    periods?: number;
    startsAt: string;
}

const hexOf = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** A version-4 UUID from 16 random bytes. */
function uuidOf(b: Uint8Array): string {
    const h = hexOf(b);
    const variant = ((parseInt(h[16], 16) & 3) | 8).toString(16);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * The authorisation's fields for a take-up, both apps: a fresh standing deal id (a UUID) and nonce, the start as
 * toISOString writes it, and the amount in whole hundredths. `rand` is for tests.
 */
export function standingFieldsFor(
    input: { listingId: string; payee: string; beansPerPeriod_c: Hundredths; unit: StandingPeriodUnit; maxPeriods: number | null; startsAt: number },
    rand: (n: number) => Uint8Array = randomBytes,
): StandingAuthorisationFields {
    return {
        standingId: uuidOf(rand(16)),
        listingId: input.listingId,
        payee: input.payee,
        beansPerPeriod_c: input.beansPerPeriod_c,
        unit: input.unit,
        maxPeriods: input.maxPeriods,
        startsAt: new Date(input.startsAt).toISOString(),
        nonce: hexOf(rand(16)),
    };
}

/**
 * The payer's signed standing authorisation for the community at `nodeUrl`, as an accept or an approval carries it. The
 * host is the one the app's own requests are signed for (`audienceOf` the URL fetched, or the name the phone signs for on
 * a hall laptop): never one a node sent. Signed as every member statement is (request-signing.ts): 0xFF, then the text in
 * UTF-8, so nothing an older app can be made to sign is one. Throws, having signed nothing, for a field the text can't carry.
 */
export async function signStandingAuthorisation(
    nodeUrl: string, fields: StandingAuthorisationFields, sign: Signer, audience?: string | null,
): Promise<StandingStartBody> {
    const host = audience || audienceOf(nodeUrl);
    if (!host) throw new Error('Cannot sign a standing deal: the node address names no host');
    const payload = standingAuthorisationText({ ...fields, host });
    const signature = toBase64(await sign(signedRequestBytes(payload)));
    return {
        authorisation: { payload, signature },
        ...(fields.maxPeriods === null ? { untilStopped: true as const } : { periods: fields.maxPeriods }),
        startsAt: fields.startsAt,
    };
}

/** The most periods the take-up screen offers ("For [ k ] months"), well inside what a text may name. */
export const STANDING_PICK_MAX = 52;
/** The furthest day ahead the take-up screen's start offers (§2.2 "up to 30 days ahead"). */
export const STANDING_PICK_DAYS = 30;

/**
 * When a take-up starts: now ("Today"), or `daysAhead` whole days from now (1 to 30), so it is always inside the node's
 * window (from now to 30 days ahead).
 */
export function standingStartAt(now: number, daysAhead: number): number {
    const d = Math.max(0, Math.min(STANDING_PICK_DAYS, Math.floor(daysAhead) || 0));
    return now + d * 86_400_000;
}

/** Every line of the take-up screen (design §3), one set for both apps. `day` writes a date as the app does ("9 Nov"). */
export function standingTakeUpLines(
    input: { unit: StandingPeriodUnit; beans: number; title: string; payeeName: string; startsAt: number; periods: number },
    day: (iso: string) => string,
) {
    const { unit, beans } = input;
    const from = new Date(input.startsAt).toISOString();
    return {
        title: standingLines.takeUpTitle(),
        summary: standingLines.takeUpSummary(unit, input.title, beans, input.payeeName),
        howLong: standingLines.howLong(),
        untilStopped: standingLines.untilStopped(),
        forPeriods: standingLines.forPeriods(unit, input.periods),
        startLabel: standingLines.startLabel(),
        startToday: standingLines.startToday(),
        startOn: standingLines.startOn(day(from)),
        startAhead: standingLines.startAhead(),
        paidNow: standingLines.paidNow(unit, beans, input.payeeName, day(from), day(periodEnd(from, unit, 1))),
        howItRuns: standingLines.howItRuns(unit),
        shortAhead: standingLines.shortAhead(unit),
        agree: standingLines.agree(beans),
        fewer: t('One fewer'),
        more: t('One more'),
        earlier: t('A day earlier'),
        later: t('A day later'),
    };
}

/** A deal row as the standing panel reads it: the node's transactions read (@beanpool/engine escrow.ts standingFields). */
export interface StandingDealRow {
    id?: string;
    postId?: string;
    postTitle?: string | null;
    status: string;
    buyerPublicKey: string;
    buyerCallsign?: string | null;
    sellerPublicKey: string;
    sellerCallsign?: string | null;
    createdAt?: string | null;
    completedAt?: string | null;
    standingId?: string | null;
    periodNo?: number | null;
    standingPhase?: StandingPhase | null;
    standingBeans_c?: number | null;
    standingUnit?: StandingPeriodUnit | null;
    standingMaxPeriods?: number | null;
    standingNextDueAt?: string | null;
    standingStartsAt?: string | null;
    standingShortSince?: string | null;
    standingStopped?: boolean;
}

/**
 * The current row of a standing deal that is short, read for its unpaid period: which period is due (the one after the
 * last paid, the row's own), since when (its start, or the node's short_since), and when its grace ends. Null for any row
 * that is not the current row of a short standing deal.
 */
function shortPeriodOf(tx: StandingDealRow): { n: number; dueAt: string; graceEndsAt: string } | null {
    const unit = tx.standingUnit;
    if (!tx.standingId || tx.standingPhase !== 'short' || (unit !== 'week' && unit !== 'month') || !tx.standingStartsAt) return null;
    if (!Number.isFinite(Date.parse(tx.standingStartsAt))) return null;
    const n = Math.max(1, (Number(tx.periodNo) || 0) + 1);
    const dueAt = tx.standingShortSince && Number.isFinite(Date.parse(tx.standingShortSince)) ? tx.standingShortSince : periodStart(tx.standingStartsAt, unit, n);
    return { n, dueAt, graceEndsAt: standingGraceEndsAt(tx.standingStartsAt, unit, n) };
}

/** What a listing's page (and a Your deals card) shows of one standing deal still running, for one of its sides. */
export interface StandingPanel {
    role: 'payer' | 'payee';
    phase: Exclude<StandingPhase, 'ended'>;
    unit: StandingPeriodUnit;
    /** "🔁 Standing deal since 9 Nov · 50 Beans a month" */
    title: string;
    /** Where it is, for this side. */
    status: string;
    /** The payer's step: the period now due isn't paid (shown as a warning, with the day the grace ends). */
    warning: boolean;
    /** The last period is paid (stopped, or the count reached): when it ends. Null otherwise. */
    lastLine: string | null;
    /** "Month 3 of 6", or null for one that runs until stopped. */
    periodOf: string | null;
    /** Stop: either side, until one of them has; in the grace it ends at once ("Stop now"). */
    stop: boolean;
    stopLabel: string;
    /** When the grace ends, for a short one (ISO), else null. */
    graceEndsAt: string | null;
}

/**
 * The standing panel for `actingAs` (the member, or the enterprise they keep), or null for a row that is no standing deal
 * still running, or for a stranger to it. `day` writes a date as the app does. The one rule for both apps (design §3): paid
 * says when this period went and when the next goes; short warns the payer with the day the grace ends and tells the
 * payee it isn't paid yet; stopped says when it stops.
 */
export function standingPanel(tx: StandingDealRow, actingAs: string, day: (iso: string) => string, now: number = Date.now()): StandingPanel | null {
    const phase = tx.standingPhase;
    const unit = tx.standingUnit;
    if (!tx.standingId || (phase !== 'paid' && phase !== 'short') || (unit !== 'week' && unit !== 'month')) return null;
    const payer = tx.buyerPublicKey === actingAs;
    if (!payer && tx.sellerPublicKey !== actingAs) return null;
    const beans = (isHundredths(tx.standingBeans_c) ? tx.standingBeans_c : 0);
    const payeeName = tx.sellerCallsign || t('A member');
    const payerName = tx.buyerCallsign || t('A member');
    const next = tx.standingNextDueAt || new Date(now).toISOString();
    const paidOn = tx.completedAt || tx.createdAt || tx.standingStartsAt || next;
    const short = shortPeriodOf(tx);
    const n = Number(tx.periodNo) || 0;
    const max = tx.standingMaxPeriods ?? null;
    const last = phase === 'paid' && (!!tx.standingStopped || (max !== null && n >= max));
    let status: string;
    if (short) status = payer ? standingLines.shortPayer(unit, beans, day(short.graceEndsAt)) : standingLines.shortPayee(unit, day(short.graceEndsAt));
    else if (last) status = standingLines.stopsOn(unit, day(next));
    else status = payer ? standingLines.paidPayer(unit, beans, payeeName, day(paidOn), day(next)) : standingLines.paidPayee(unit, payerName, beans, day(paidOn), day(next));
    return {
        role: payer ? 'payer' : 'payee',
        phase,
        unit,
        title: standingLines.since(unit, day(tx.standingStartsAt || paidOn), beans),
        status,
        warning: payer && phase === 'short',
        lastLine: last && !tx.standingStopped ? standingLines.lastPeriod(unit, tx.postTitle || '', day(next)) : null,
        periodOf: max !== null && n > 0 ? standingLines.periodOf(unit, Math.min(n, max), max) : null,
        stop: !tx.standingStopped,
        stopLabel: phase === 'short' ? standingLines.stopNow() : standingLines.stop(),
        graceEndsAt: short?.graceEndsAt ?? null,
    };
}

/**
 * The Stop confirm's words, both apps (design §3, amendment §1), for the side that taps it. Paid: it stops after the period
 * already paid, which the payee keeps. Short (in the grace): it ends at once, nothing is paid for the unpaid period, and
 * nothing is owed through the app for the days since it was due. `otherName` is the other side's name; `day` writes a date.
 */
export function standingStopConfirm(tx: StandingDealRow, actingAs: string, day: (iso: string) => string) {
    const unit: StandingPeriodUnit = tx.standingUnit === 'week' ? 'week' : 'month';
    const payer = tx.buyerPublicKey === actingAs;
    const beans = (isHundredths(tx.standingBeans_c) ? tx.standingBeans_c : 0);
    const short = shortPeriodOf(tx);
    const next = tx.standingNextDueAt || new Date().toISOString();
    return {
        title: short ? standingLines.stopNowConfirm() : standingLines.stopConfirm(unit),
        body: short
            ? (payer ? standingLines.stopNowConfirmPayer(unit, beans, tx.sellerCallsign || t('A member'), day(short.dueAt)) : standingLines.stopNowConfirmPayee(unit, beans, day(short.dueAt)))
            : (payer ? standingLines.stopConfirmPayer(unit, tx.sellerCallsign || t('A member')) : standingLines.stopConfirmPayee(day(next))),
        yes: t('Stop it'),
        no: t('Keep it'),
    };
}

/** One live "Needs you" line for a short standing deal (amendment §2): the payer's step (amber, counted) or the payee's (calm). */
export interface StandingNeedsLine {
    role: 'payer' | 'payee';
    /** "Vehicle Storage: 50 Beans 3 days overdue · until 24 Dec" */
    label: string;
    /** The payer's: it is their step, so it is amber and counts. The payee's is listed, not counted. */
    accent: boolean;
    standingId: string;
    txId: string | null;
    postId: string | null;
}

/**
 * The live "Needs you" line of one short standing deal for `me`, written fresh from the row on every draw, so "3 days
 * overdue" becomes "4 days overdue" with the clock and no row is ever kept (amendment §2). Whole days since the period was
 * due; under a day, "due today". Null for any row that is not the current row of a short standing deal `me` is a side of.
 * The payee's line never carries the payer's balance or shortfall.
 */
export function standingNeedsLine(tx: StandingDealRow, me: string, now: number, day: (iso: string) => string): StandingNeedsLine | null {
    const short = shortPeriodOf(tx);
    if (!short || !me) return null;
    const payer = tx.buyerPublicKey === me;
    if (!payer && tx.sellerPublicKey !== me) return null;
    const title = tx.postTitle || t('A standing deal');
    const beans = n2((isHundredths(tx.standingBeans_c) ? tx.standingBeans_c : 0));
    const until = day(short.graceEndsAt);
    const days = Math.max(0, Math.floor((now - Date.parse(short.dueAt)) / 86_400_000));
    let label: string;
    if (payer) {
        label = days < 1
            ? t('{title}: {beans} Beans due today · until {date}', { title, beans, date: until })
            : tn(days, '{title}: {beans} Beans {n} day overdue · until {date}', '{title}: {beans} Beans {n} days overdue · until {date}', { title, beans, date: until });
    } else {
        const name = tx.buyerCallsign || t('A member');
        label = days < 1
            ? t("{name}'s {beans} Beans for {title}: due today · we try until {date} · you can stop it now", { name, beans, title, date: until })
            : tn(days, "{name}'s {beans} Beans for {title}: {n} day overdue · we try until {date} · you can stop it now",
                "{name}'s {beans} Beans for {title}: {n} days overdue · we try until {date} · you can stop it now", { name, beans, title, date: until });
    }
    return { role: payer ? 'payer' : 'payee', label, accent: payer, standingId: tx.standingId!, txId: tx.id ?? null, postId: tx.postId ?? null };
}

/** The live lines for every short standing deal among `txs` that `me` is a side of: one per standing deal, oldest due first. */
export function standingNeedsLines(txs: readonly StandingDealRow[], me: string, now: number, day: (iso: string) => string): StandingNeedsLine[] {
    const seen = new Set<string>();
    const out: Array<StandingNeedsLine & { due: number }> = [];
    for (const tx of txs) {
        const line = standingNeedsLine(tx, me, now, day);
        if (!line || seen.has(line.standingId)) continue;
        seen.add(line.standingId);
        out.push({ ...line, due: Date.parse(shortPeriodOf(tx)!.dueAt) });
    }
    return out.sort((a, b) => a.due - b.due).map(({ due: _due, ...line }) => line);
}

/**
 * Standing deals: paying for something by the week or by the month (scratch/fable-design/DESIGN-standing-deals-fable.md;
 * Marty's decisions, 9 Nov 2026). Pure and universal: imported by both apps and the server.
 *
 * THE MODEL. A listing priced per week or per month makes a standing deal when it is taken up (hourly, daily and fixed prices
 * stay one-off deals). One period's Beans are in trust at a time: at the start the first period is held, as any deal holds its
 * Beans; at each period's end the node releases them to the payee (less the 1.5% to the Commons, as every release) and holds
 * the next period's, unless the payer tapped Hold back or either side tapped Stop. Each period is an ordinary deal row.
 *
 * THE CALENDAR (§5 "Clock"). Period n runs [start + (n-1) units, start + n units), worked out from the start every time, in
 * UTC, never from the previous period's end, so it never drifts: weeks are exact (7 × 24 h); a month keeps the start's day
 * and time of day, and a day the month doesn't have (the 31st in April, the 29th–31st in February) is clamped to its last
 * day. A start on 31 January ends its periods on 28 (or 29) February, 31 March, 30 April, 31 May, …
 *
 * THE AUTHORISATION (§6). The payer signs one text with their key when it starts: the community's host, the standing deal's
 * id, the listing, the payee, the Beans per period, the period, how many periods (or open) and the start. The node keeps it,
 * and every period it holds must match it: never more, more often, past the count, or for anyone else.
 */

import { randomBytes } from '@noble/hashes/utils.js';
import { audienceOf, signedRequestBytes, toBase64, type Signer } from './request-signing.js';
import { formatNumber, t, tn } from './words.js';

/** The two periods a standing deal runs by. */
export type StandingPeriodUnit = 'week' | 'month';

/**
 * Where a standing deal is (the node's `standing_deals.phase`):
 *  - held: this period's Beans are held, released by the node at its end;
 *  - due: the period was settled and the next isn't held yet (the node is between its two steps, or waits for the next
 *    period's start after an early release);
 *  - short: the next period's Beans couldn't be held; the node tries again for 7 days, then it ends;
 *  - held_back: the payer held this period back (or the node did, when it couldn't carry on): a plain held deal, settled
 *    by a person;
 *  - ended: nothing more is held.
 */
export type StandingPhase = 'held' | 'due' | 'short' | 'held_back' | 'ended';
export const STANDING_PHASES: readonly StandingPhase[] = Object.freeze(['held', 'due', 'short', 'held_back', 'ended']);

/** Why a standing deal ended (`standing_deals.ended_reason`). */
export type StandingEndReason = 'stopped' | 'count_reached' | 'short' | 'cancelled' | 'listing_gone' | 'account_closed' | 'node_held' | 'cant_run';

/** Why a period is held back (`standing_deals.held_back_reason`): the payer's tap, or what stopped the node carrying on. */
export type StandingHeldBackReason = 'payer' | 'node_held' | 'listing_hidden' | 'cant_run';

/** How long the node keeps trying to hold a period that couldn't be held, before the standing deal ends (§1.4, decision 2). */
export const STANDING_GRACE_MS = 7 * 86_400_000;
/** How often it tries again in that week (§1.4). */
export const STANDING_RETRY_MS = 60 * 60 * 1000;
/** How long before a period is due the payer is told they are short (§3): 3 days for a month, 1 day for a week. */
export function standingWarnAheadMs(unit: StandingPeriodUnit): number {
    return (unit === 'month' ? 3 : 1) * 86_400_000;
}
/** On which day of the week of grace the payer is reminded once (§3 "Day 3 of grace"). */
export const STANDING_REMINDER_AFTER_MS = 3 * 86_400_000;
/** How far ahead a standing deal may start (§2.2 "up to 30 days ahead"). */
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
export function standingUnitForListing(priceType: string | null | undefined, price: number | string | null | undefined): StandingPeriodUnit | null {
    const unit = standingUnitOf(priceType);
    const beans = typeof price === 'string' ? Number(price) : price;
    return unit && typeof beans === 'number' && Number.isFinite(beans) && beans > 0 ? unit : null;
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

// ── The authorisation (§6) ─────────────────────────────────────────────────────────────────────────────────────────

/** The first line of every standing authorisation: its format. */
export const STANDING_AUTH_VERSION = 'beanpool-standing-v1';

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
    /** Beans per period, to the cent. */
    beansPerPeriod: number;
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
const BEANS_2DP = /^(0|[1-9]\d{0,8})\.\d{2}$/;
/** The largest number of periods one authorisation may name (about 19 years of months). */
export const STANDING_MAX_PERIODS = 240;

/** Beans per period as the text writes them: to the cent, always two places. */
export function standingBeansText(beans: number): string {
    return (Math.round(beans * 100) / 100).toFixed(2);
}

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
        && typeof a.beansPerPeriod === 'number' && Number.isFinite(a.beansPerPeriod) && a.beansPerPeriod > 0
        && BEANS_2DP.test(standingBeansText(a.beansPerPeriod)) && Number(standingBeansText(a.beansPerPeriod)) === a.beansPerPeriod
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
        standingBeansText(a.beansPerPeriod),
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
    if (!BEANS_2DP.test(beans)) return null;
    if (unit !== 'week' && unit !== 'month') return null;
    let maxPeriods: number | null;
    if (max === 'open') maxPeriods = null;
    else if (/^[1-9]\d{0,3}$/.test(max)) maxPeriods = Number(max);
    else return null;
    const a: StandingAuthorisation = { host, standingId, listingId, payee, beansPerPeriod: Number(beans), unit, maxPeriods, startsAt, nonce };
    if (!isStandingAuthorisation(a)) return null;
    return standingAuthorisationText(a) === text ? a : null;
}

/** The ledger rows' `auth_payload` of a period the node holds under a standing authorisation (§6). */
export function standingHoldPayload(standingId: string, periodNo: number): string {
    return `standing:${standingId}:${periodNo}`;
}

// ── The words (§1–§3), one set for both apps and the node's notices ──────────────────────────────────────────────────

const n2 = (n: number) => formatNumber(Math.round(n * 100) / 100);

/**
 * Every sentence a member reads about a standing deal. Amounts are numbers (formatted here); names, titles and dates come
 * formatted. Each sentence is written once per period, so a translation never has to fit "week" or "month" into another
 * sentence.
 */
export const standingLines = {
    // §2.2 Taking it up
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
    heldNow: (unit: StandingPeriodUnit, beans: number, from: string, to: string) => (unit === 'month'
        ? t('{n} Beans are held now for the first month ({from} – {to}).', { n: n2(beans), from, to })
        : t('{n} Beans are held now for the first week ({from} – {to}).', { n: n2(beans), from, to })),
    howItRuns: (unit: StandingPeriodUnit, beans: number, name: string) => (unit === 'month'
        ? t("At the end of each month they go to {name}, and the next month's {n} are held, until one of you stops it. You can stop any time; the month under way is still paid.", { n: n2(beans), name })
        : t("At the end of each week they go to {name}, and the next week's {n} are held, until one of you stops it. You can stop any time; the week under way is still paid.", { n: n2(beans), name })),
    shortAhead: (unit: StandingPeriodUnit) => (unit === 'month'
        ? t("If you're short when a month is due, you'll be told a few days before.")
        : t("If you're short when a week is due, you'll be told the day before.")),
    agree: (beans: number) => t('Agree and hold {n} Beans', { n: n2(beans) }),

    // §2.2 The listing's panel while it runs
    since: (unit: StandingPeriodUnit, date: string, beans: number) => (unit === 'month'
        ? t('🔁 Standing deal since {date} · {n} Beans a month', { date, n: n2(beans) })
        : t('🔁 Standing deal since {date} · {n} Beans a week', { date, n: n2(beans) })),
    heldGoesTo: (unit: StandingPeriodUnit, beans: number, name: string, date: string) => (unit === 'month'
        ? t("This month's {n} Beans are held · they go to {name} {date}", { n: n2(beans), name, date })
        : t("This week's {n} Beans are held · they go to {name} {date}", { n: n2(beans), name, date })),
    holdBack: (unit: StandingPeriodUnit) => (unit === 'month' ? t('Hold back this month') : t('Hold back this week')),
    stop: () => t('Stop…'),
    stopNow: () => t('Stop now'),
    stopConfirm: (unit: StandingPeriodUnit) => (unit === 'month' ? t('Stop after this month?') : t('Stop after this week?')),
    stopConfirmBody: (unit: StandingPeriodUnit) => (unit === 'month'
        ? t('The month under way is still paid. Nothing more is held after it.')
        : t('The week under way is still paid. Nothing more is held after it.')),
    /** Short, or between its periods: nothing is held, and Stop ends it at once (the node's endStanding). */
    stopNowConfirm: () => t('Stop it now?'),
    stopNowConfirmBody: () => t('It ends now. Nothing is held for it, and nothing more will be.'),
    periodOf: (unit: StandingPeriodUnit, n: number, k: number) => (unit === 'month'
        ? t('Month {n} of {k}', { n, k })
        : t('Week {n} of {k}', { n, k })),
    payeePanel: (unit: StandingPeriodUnit, name: string, beans: number, date: string) => (unit === 'month'
        ? t("{name}'s standing deal · {n} Beans a month · this month held for you · paid {date}", { name, n: n2(beans), date })
        : t("{name}'s standing deal · {n} Beans a week · this week held for you · paid {date}", { name, n: n2(beans), date })),
    shortPayer: (unit: StandingPeriodUnit, beans: number, date: string) => (unit === 'month'
        ? t("⚠️ Next month isn't covered · {n} Beans needed by {date} or this ends", { n: n2(beans), date })
        : t("⚠️ Next week isn't covered · {n} Beans needed by {date} or this ends", { n: n2(beans), date })),
    shortPayee: (unit: StandingPeriodUnit, date: string) => (unit === 'month'
        ? t("Next month isn't covered yet · we'll keep trying until {date}", { date })
        : t("Next week isn't covered yet · we'll keep trying until {date}", { date })),
    heldBack: () => t('Held back · the schedule is paused'),
    chip: () => t('🔁 STANDING'),
    memo: (unit: StandingPeriodUnit, title: string, n: number) => (unit === 'month'
        ? t('Standing deal · {title} · month {n}', { title, n })
        : t('Standing deal · {title} · week {n}', { title, n })),

    // §1.5 and §2.5 Refusals
    keeperPayee: () => t("A standing deal can't pay a keeper of the enterprise that pays it. Pay each job as a deal."),
    holidayPayer: (title: string) => t('Stop your standing deal for {title} first.', { title }),
    removeStops: (unit: StandingPeriodUnit, count: number) => (unit === 'month'
        ? tn(count, 'This stops {n} standing deal after its current month.', 'This stops {n} standing deals after their current month.')
        : tn(count, 'This stops {n} standing deal after its current week.', 'This stops {n} standing deals after their current week.')),
    authMismatch: () => t("The standing deal's agreement doesn't match this listing. Close it and try again."),
    releaseByItself: (unit: StandingPeriodUnit) => (unit === 'month'
        ? t("This month's Beans go to them by themselves at the month's end. Hold it back first to settle it yourself.")
        : t("This week's Beans go to them by themselves at the week's end. Hold it back first to settle it yourself.")),
    payerOnly: () => t('Only the one who pays can do this.'),
    notRunning: () => t("This standing deal isn't running by itself just now, so there is nothing to hold back."),
    alreadyStanding: () => t('You already have a standing deal on this. Stop it first.'),

    // §3 Short funds
    shortAheadNotice: (unit: StandingPeriodUnit, title: string, beans: number, date: string, short: number) => (unit === 'month'
        ? t("{title}: {n} Beans are due on {date} and you're {short} short. Earn or receive Beans by then, or stop the standing deal; the month under way is still paid.", { title, n: n2(beans), date, short: n2(short) })
        : t("{title}: {n} Beans are due on {date} and you're {short} short. Earn or receive Beans by then, or stop the standing deal; the week under way is still paid.", { title, n: n2(beans), date, short: n2(short) })),
    notHeldPayer: (unit: StandingPeriodUnit, title: string, beans: number, date: string) => (unit === 'month'
        ? t("{title}: this month's {n} Beans couldn't be held. We'll try again until {date}. Then it ends.", { title, n: n2(beans), date })
        : t("{title}: this week's {n} Beans couldn't be held. We'll try again until {date}. Then it ends.", { title, n: n2(beans), date })),
    notHeldPayee: (unit: StandingPeriodUnit, name: string, title: string, date: string) => (unit === 'month'
        ? t("{name}'s next month of {title} isn't covered yet. We'll keep trying until {date}. You can stop it now.", { name, title, date })
        : t("{name}'s next week of {title} isn't covered yet. We'll keep trying until {date}. You can stop it now.", { name, title, date })),
    stillShort: (title: string, beans: number, date: string) => t('Still short for {title}: {n} Beans by {date} or it ends.', { title, n: n2(beans), date }),
    coveredPayer: (unit: StandingPeriodUnit, title: string, beans: number) => (unit === 'month'
        ? t("{title} is covered again. This month's {n} Beans are held.", { title, n: n2(beans) })
        : t("{title} is covered again. This week's {n} Beans are held.", { title, n: n2(beans) })),
    coveredPayee: (unit: StandingPeriodUnit, title: string, beans: number) => (unit === 'month'
        ? t("{title} is covered again. This month's {n} Beans are held for you.", { title, n: n2(beans) })
        : t("{title} is covered again. This week's {n} Beans are held for you.", { title, n: n2(beans) })),
    endedShortPayer: (unit: StandingPeriodUnit, title: string, name: string) => (unit === 'month'
        ? t("{title} ended: the Beans for this month couldn't be held. Nothing more will be taken. Talk to {name} about it.", { title, name })
        : t("{title} ended: the Beans for this week couldn't be held. Nothing more will be taken. Talk to {name} about it.", { title, name })),
    endedShortPayee: (unit: StandingPeriodUnit, name: string, title: string, date: string) => (unit === 'month'
        ? t("{name}'s {title} ended: this month's Beans couldn't be held. Nothing is owed through the app for the days since {date}.", { name, title, date })
        : t("{name}'s {title} ended: this week's Beans couldn't be held. Nothing is owed through the app for the days since {date}.", { name, title, date })),

    // §1.2–§1.4 and §5 What happened, as a notice
    noticeTitle: () => t('🔁 Standing deal'),
    paid: (unit: StandingPeriodUnit, title: string, n: number, net: number) => (unit === 'month'
        ? t('{title}: month {n} is paid. {net} Beans came to you.', { title, n, net: n2(net) })
        : t('{title}: week {n} is paid. {net} Beans came to you.', { title, n, net: n2(net) })),
    stoppedBy: (unit: StandingPeriodUnit, name: string, title: string) => (unit === 'month'
        ? t('{name} stopped the standing deal for {title}. The month under way is still paid; nothing more will be held.', { name, title })
        : t('{name} stopped the standing deal for {title}. The week under way is still paid; nothing more will be held.', { name, title })),
    heldBackBy: (unit: StandingPeriodUnit, name: string, title: string) => (unit === 'month'
        ? t("{name} held back this month's Beans for {title}. The schedule is paused until it is settled.", { name, title })
        : t("{name} held back this week's Beans for {title}. The schedule is paused until it is settled.", { name, title })),
    lastPeriod: (unit: StandingPeriodUnit, title: string, date: string) => (unit === 'month'
        ? t('{title}: the last month of this standing deal is under way. It ends on {date}.', { title, date })
        : t('{title}: the last week of this standing deal is under way. It ends on {date}.', { title, date })),
    ended: (title: string) => t('The standing deal for {title} has ended. Nothing more will be held.', { title }),
    nodeHeld: (title: string, name: string) => t("This community's server was away, so {title} wasn't settled on time. Check with {name} and release this period's Beans, then it carries on.", { title, name }),
    nodeHeldEnded: (title: string) => t("This community's server was away for too long, so the standing deal for {title} has ended. Nothing more will be held.", { title }),
    listingHidden: (title: string) => t("{title} is hidden while a moderator looks at it, so this period's Beans wait for one of you to release or cancel them. Nothing more will be held.", { title }),
    cantRun: (title: string) => t("The standing deal for {title} can't carry on, so it has ended. Nothing more will be held.", { title }),
    cantRunHeld: (title: string) => t("The standing deal for {title} can't carry on. This period's Beans wait for one of you to release or cancel them; nothing more will be held.", { title }),
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
 * toISOString writes it, and Beans to the cent. `rand` is for tests.
 */
export function standingFieldsFor(
    input: { listingId: string; payee: string; beansPerPeriod: number; unit: StandingPeriodUnit; maxPeriods: number | null; startsAt: number },
    rand: (n: number) => Uint8Array = randomBytes,
): StandingAuthorisationFields {
    return {
        standingId: uuidOf(rand(16)),
        listingId: input.listingId,
        payee: input.payee,
        beansPerPeriod: Math.round(input.beansPerPeriod * 100) / 100,
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

/** Every line of the take-up screen (§2.2), one set for both apps. `day` writes a date as the app does ("9 Nov"). */
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
        heldNow: standingLines.heldNow(unit, beans, day(from), day(periodEnd(from, unit, 1))),
        howItRuns: standingLines.howItRuns(unit, beans, input.payeeName),
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
    postTitle?: string | null;
    status: string;
    buyerPublicKey: string;
    buyerCallsign?: string | null;
    sellerPublicKey: string;
    sellerCallsign?: string | null;
    standingId?: string | null;
    periodNo?: number | null;
    standingPhase?: StandingPhase | null;
    standingBeans?: number | null;
    standingUnit?: StandingPeriodUnit | null;
    standingMaxPeriods?: number | null;
    standingNextDueAt?: string | null;
    standingStartsAt?: string | null;
    standingShortSince?: string | null;
    standingStopped?: boolean;
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
    /** The next period isn't covered: shown as a warning (the payer's short-funds banner, with the week's end). */
    warning: boolean;
    /** The period under way is its last (stopped, or the count reached): when it ends. Null otherwise. */
    lastLine: string | null;
    /** "Month 3 of 6", or null until stopped. */
    periodOf: string | null;
    /** Hold back: the payer, while this period runs by itself. */
    holdBack: boolean;
    /** Stop: either side, until one of them has. */
    stop: boolean;
    holdBackLabel: string;
    stopLabel: string;
    /** When the week of grace ends, for a short one (ISO), else null. */
    graceEndsAt: string | null;
}

/**
 * The standing panel for `actingAs` (the member, or the enterprise they keep), or null for a row that is no standing deal
 * still running, or for a stranger to it. `day` writes a date as the app does. The one rule for both apps (§2.2): a healthy
 * standing deal says when its Beans go; short warns with the day the week of grace ends; held back says the schedule waits.
 */
export function standingPanel(tx: StandingDealRow, actingAs: string, day: (iso: string) => string, now: number = Date.now()): StandingPanel | null {
    const phase = tx.standingPhase;
    const unit = tx.standingUnit;
    if (!tx.standingId || !phase || phase === 'ended' || (unit !== 'week' && unit !== 'month')) return null;
    const payer = tx.buyerPublicKey === actingAs;
    if (!payer && tx.sellerPublicKey !== actingAs) return null;
    const beans = Number(tx.standingBeans ?? 0);
    const payeeName = tx.sellerCallsign || t('A member');
    const payerName = tx.buyerCallsign || t('A member');
    const due = tx.standingNextDueAt || new Date(now).toISOString();
    const shortFrom = tx.standingShortSince ? Date.parse(tx.standingShortSince) : NaN;
    const graceEndsAt = phase === 'short'
        ? new Date((Number.isFinite(shortFrom) ? shortFrom : Date.parse(due)) + STANDING_GRACE_MS).toISOString()
        : null;
    let status: string;
    if (phase === 'held') status = payer ? standingLines.heldGoesTo(unit, beans, payeeName, day(due)) : standingLines.payeePanel(unit, payerName, beans, day(due));
    else if (phase === 'short') status = payer ? standingLines.shortPayer(unit, beans, day(graceEndsAt!)) : standingLines.shortPayee(unit, day(graceEndsAt!));
    else if (phase === 'held_back') status = standingLines.heldBack();
    else status = t('Standing deal · runs by itself');
    const n = Number(tx.periodNo) || 0;
    const max = tx.standingMaxPeriods ?? null;
    const last = phase === 'held' && (!!tx.standingStopped || (max !== null && n >= max));
    return {
        role: payer ? 'payer' : 'payee',
        phase,
        unit,
        title: standingLines.since(unit, day(tx.standingStartsAt || due), beans),
        status,
        warning: phase === 'short',
        lastLine: last ? standingLines.lastPeriod(unit, tx.postTitle || '', day(due)) : null,
        periodOf: max !== null && n > 0 ? standingLines.periodOf(unit, Math.min(n, max), max) : null,
        holdBack: payer && tx.status === 'pending' && phase === 'held',
        stop: !tx.standingStopped,
        holdBackLabel: standingLines.holdBack(unit),
        stopLabel: !payer && phase === 'short' ? standingLines.stopNow() : standingLines.stop(),
        graceEndsAt,
    };
}

/**
 * The Stop confirm's words (§1.3), both apps. Held (or held back), the period under way is still paid; short, or between its
 * periods (due), nothing is held and the node ends it at once (stopStandingDeal), as the payee's "Stop now" says.
 */
export function standingStopConfirm(unit: StandingPeriodUnit, phase?: StandingPhase | null) {
    const now = phase === 'short' || phase === 'due';
    return {
        title: now ? standingLines.stopNowConfirm() : standingLines.stopConfirm(unit),
        body: now ? standingLines.stopNowConfirmBody() : standingLines.stopConfirmBody(unit),
        yes: t('Stop it'),
        no: t('Keep it'),
    };
}

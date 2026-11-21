/**
 * When BeanPool may raise notifications, and what a phone keeps of the answers (scratch/fable-design/
 * DESIGN-notify-and-backup-asks-fable-amend2.md §6, §7 and slice N1 in §12.3; the first design §4 and amend1 §4 for the
 * parts amend2 keeps). One rule for both apps, so the phone and the web app cannot drift.
 *
 * Marty's terms: a soft ask is anything WE draw; a hard ask is the phone's own pop-up, and it only ever follows a tap on
 * a soft ask. Nothing here asks: it says what may be drawn, from the record, the phone's own state and the day.
 *
 * - "Later" and the phone's "no" are kept apart, each with its date. "Later" is never final.
 * - The phone says whether it can still ask (`canAskAgain`); the record never overrides it.
 * - One soft ask a day across the join's screen, the once card, the named lines, the Home card and the fact line. The
 *   join's screen is its day's, with one named line still allowed that day. First steps' line and the bell's line are
 *   standing lines, not asks, and are never counted.
 * - No stored data moves: an old record's "Not now" (`state: 'declined'` with no date of the phone's "no") is read as a
 *   "Later" made at its `updatedAt`.
 *
 * Pure: no I/O and no Node built-ins (the barrel is bundled for the phone).
 */
import { localDay } from './home-tips.js';
import { t } from './words.js';

const DAY_MS = 86_400_000;

/** The once card stays, until answered, this many days after it is first shown; then it folds into First steps' line. */
export const NOTIFY_ONCE_CARD_DAYS = 7;
/** No Home card this many days after a "Later". */
export const NOTIFY_HOME_AFTER_LATER_DAYS = 7;
/** The Home card's × puts it away this many days... */
export const NOTIFY_HOME_AWAY_DAYS = 30;
/** ...and after this many ×, for good. */
export const NOTIFY_HOME_AWAYS = 3;
/** The fact line ("This waited 2 days for you") shows at most once in this many days. */
export const NOTIFY_FACT_DAYS = 30;

/** The soft asks, each counted towards one a day. */
export type NotifyAskSurface = 'join' | 'once' | 'line' | 'home' | 'fact';

/** What a phone (or a browser) keeps of the asks and answers. Every field may be missing: an empty record is a new phone. */
export interface NotifyAskRecord {
    /** 'granted' once allowed through one of our asks. 'declined' is only ever an older app's word for "Not now". */
    state?: 'unanswered' | 'granted' | 'declined';
    /** When `state` was last written: an older app's 'declined' was said then. */
    updatedAt?: number;
    /** The last "Later" (ours, on any ask). */
    laterAt?: number;
    /** The phone's own "no" to its pop-up. */
    phoneNoAt?: number;
    /** The local day (YYYY-MM-DD) of the last soft ask shown, and which one it was. */
    askDay?: string;
    askKind?: NotifyAskSurface;
    /** The join's last screen was shown on this phone (last time). */
    joinAt?: number;
    /** The once card on Home was first shown, and when it was answered with "Later". */
    onceAt?: number;
    onceClosedAt?: number;
    /** The kinds of named line already shown: each kind once. */
    lines?: readonly string[];
    /** The Home card's last ×, and how many there have been. */
    homeAwayAt?: number;
    homeAways?: number;
    /** The fact line was last shown. */
    factAt?: number;
}

/** What the phone itself says (utils/notification-permission.ts `readOsNotificationPermission` on the phone). */
export interface NotifyPhone {
    /** Notifications can be had at all here (false: nothing to turn on, nothing drawn). */
    available: boolean;
    granted: boolean;
    /** Whether the phone's pop-up can still be shown. False after an iPhone's Don't Allow, Android's second no, or a switch off in the phone's settings. */
    canAskAgain: boolean;
}

export interface NotifyAskInput {
    record: NotifyAskRecord;
    phone: NotifyPhone;
    now: number;
    /** A named line's kind, where one is asked about (each kind shows once). */
    line?: string;
    /** Something of the member's is live: a listing, a deal, an unanswered line of theirs, an event they marked. */
    live?: boolean;
    /** What is being opened waited a day or more for them. */
    waited?: boolean;
}

/** What may be drawn. A soft ask that is drawn is marked with {@link markNotifyAsk} `shown`. */
export interface NotifyAsks {
    join: boolean;
    once: boolean;
    line: boolean;
    home: boolean;
    fact: boolean;
    /** First steps' line: null no line, false unticked, true ticked. */
    firstSteps: boolean | null;
    bell: boolean;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const SURFACES: readonly NotifyAskSurface[] = ['join', 'once', 'line', 'home', 'fact'];

/** A stored record read back: only the fields of the right type are kept, so nothing stored can throw or mislead the rule. */
export function notifyAskRecordFrom(raw: unknown): NotifyAskRecord {
    if (!raw || typeof raw !== 'object') return {};
    const o = raw as Record<string, unknown>;
    const r: NotifyAskRecord = {
        state: o.state === 'granted' || o.state === 'declined' ? o.state : 'unanswered',
        updatedAt: num(o.updatedAt) ?? 0,
    };
    for (const k of ['laterAt', 'phoneNoAt', 'joinAt', 'onceAt', 'onceClosedAt', 'homeAwayAt', 'homeAways', 'factAt'] as const) {
        const v = num(o[k]);
        if (v !== undefined) r[k] = v;
    }
    if (typeof o.askDay === 'string' && DAY_KEY.test(o.askDay)) r.askDay = o.askDay;
    if (SURFACES.includes(o.askKind as NotifyAskSurface)) r.askKind = o.askKind as NotifyAskSurface;
    if (Array.isArray(o.lines)) r.lines = o.lines.filter((l): l is string => typeof l === 'string');
    return r;
}

/** When "Later" was last said, or null: the record's own date, else an older app's "Not now" at its `updatedAt`. */
export function notifyLaterAt(r: NotifyAskRecord): number | null {
    if (typeof r.laterAt === 'number') return r.laterAt;
    if (r.state === 'declined' && typeof r.phoneNoAt !== 'number') return r.updatedAt ?? 0;
    return null;
}

/** The phone said no: at its pop-up (recorded), or it won't show the pop-up again. Never while it allows them. */
export function notifyPhoneSaidNo(r: NotifyAskRecord, p: NotifyPhone): boolean {
    if (!p.available || p.granted) return false;
    return typeof r.phoneNoAt === 'number' || !p.canAskAgain;
}

/** What a tap on "Turn on" does: bring the phone's pop-up, open the one line about the phone's settings, or nothing. */
export function notifyTurnOn(p: NotifyPhone): 'ask' | 'settings' | 'none' {
    if (!p.available || p.granted) return 'none';
    return p.canAskAgain ? 'ask' : 'settings';
}

/**
 * First steps' line "Hear when someone answers you", for itself: null where it has no place (nothing to turn on here; the
 * phone allows them without being asked, as Android 8 to 12 does; or the phone said no, and the line goes), false while
 * the phone has to ask (it stays through a "Later", for its 30 days), true once allowed through one of our asks.
 * {@link notifyAsks} also hides it while the once card is up.
 */
export function notifyFirstStepsLine(r: NotifyAskRecord, p: NotifyPhone): boolean | null {
    if (!p.available) return null;
    if (p.granted) return r.state === 'granted' ? true : null;
    return notifyPhoneSaidNo(r, p) ? null : false;
}

/**
 * The rule. A soft ask needs a phone that has to ask and still can, and has not said no (the fact line aside: it shows
 * after the phone's "no" too, and its tap opens the phone's settings where the pop-up can't come). Each ask also needs
 * the day free of other asks:
 *
 * - **join**, the join's last screen: also on a later join after a "Later", never twice in a day; one shown today and not
 *   yet answered shows again (a join killed on it resumes on it).
 * - **once**, the card on Home for a member who never met the join's screen on this phone (after the update, after a
 *   restore; an older app's "Not now" included): first shown on a free day, then each landing until "Later" or for 7 days.
 * - **line**, a named line at the member's own act: each kind once. The day of the join's screen still allows one.
 * - **home**, the card while something of theirs is live: not 7 days after a "Later", × puts it away 30 days and for good
 *   at the third, never with the once card.
 * - **fact**, the line over something that waited a day or more: at most once in 30 days.
 */
export function notifyAsks(i: NotifyAskInput): NotifyAsks {
    const { record: r, phone: p, now } = i;
    const today = localDay(new Date(now));
    const askedToday = r.askDay === today ? (r.askKind ?? 'line') : null;
    const free = askedToday === null;
    const canAsk = p.available && !p.granted && !notifyPhoneSaidNo(r, p);
    const laterAt = notifyLaterAt(r);
    const since = (at: number | null | undefined) => (typeof at === 'number' ? now - at : Infinity);

    const joinUnanswered = askedToday === 'join' && typeof r.joinAt === 'number' && !(laterAt !== null && laterAt >= r.joinAt);
    const join = canAsk && (free || joinUnanswered);

    const onceOpen = typeof r.onceAt === 'number' && typeof r.onceClosedAt !== 'number' && since(r.onceAt) < NOTIFY_ONCE_CARD_DAYS * DAY_MS;
    const once = canAsk && typeof r.joinAt !== 'number'
        && (typeof r.onceAt !== 'number' ? free : onceOpen && (free || askedToday === 'once'));

    const line = canAsk && !!i.line && !(r.lines ?? []).includes(i.line) && (free || askedToday === 'join');

    const home = canAsk && !!i.live && !once
        && since(laterAt) >= NOTIFY_HOME_AFTER_LATER_DAYS * DAY_MS
        && since(r.homeAwayAt) >= NOTIFY_HOME_AWAY_DAYS * DAY_MS
        && (r.homeAways ?? 0) < NOTIFY_HOME_AWAYS
        && (free || askedToday === 'home');

    const fact = notifyTurnOn(p) !== 'none' && !!i.waited && since(r.factAt) >= NOTIFY_FACT_DAYS * DAY_MS && free;

    return { join, once, line, home, fact, firstSteps: once ? null : notifyFirstStepsLine(r, p), bell: notifyTurnOn(p) !== 'none' };
}

/**
 * The named lines at the member's own acts (amend2 §12.3 slice N2a; the first design §4.2, amend1 §4.3), each kind shown
 * once on a phone (the record's `lines`): a first message sent ('answer'), a first message read or a request accepted
 * ('again'), a first listing ('listing'), a first offer or request on someone's listing ('offer'), an ask to join ('join').
 * One line with one button and no "Not now": leaving the screen is the no.
 */
export const NOTIFY_LINE_KINDS = ['answer', 'again', 'listing', 'offer', 'join'] as const;
export type NotifyLineKind = typeof NOTIFY_LINE_KINDS[number];

/**
 * A named line's words: the offer, and what it says once the phone allows notifications. `name` is the person (answer,
 * again, offer) or the community (join) they wait on; without one, or for a first listing, "someone".
 */
export function notifyLineWords(kind: NotifyLineKind, name?: string | null): { line: string; done: string; button: string } {
    const who = kind === 'listing' ? '' : (name ?? '').trim();
    const button = t('Tell me');
    if (!who) return { line: t('Hear when someone answers.'), done: t("You'll hear when someone answers."), button };
    if (kind === 'again') return { line: t('Hear when {name} writes again.', { name: who }), done: t("You'll hear when {name} writes again.", { name: who }), button };
    if (kind === 'offer') return { line: t('Hear when {name} says yes.', { name: who }), done: t("You'll hear when {name} says yes.", { name: who }), button };
    return { line: t('Hear when {name} answers.', { name: who }), done: t("You'll hear when {name} answers.", { name: who }), button };
}

export type NotifyAskEvent =
    /** A soft ask was drawn (a named line with its kind). */
    | { type: 'shown'; surface: NotifyAskSurface; line?: string }
    /** "Later" on an ask (on the once card it also puts the card away), or the phone's pop-up closed with no answer. */
    | { type: 'later'; surface?: NotifyAskSurface }
    /** × on the Home card. */
    | { type: 'away' }
    /** The phone's pop-up answered. */
    | { type: 'granted' }
    | { type: 'phone-no' };

/** The record after an event. Pure: the caller stores what it returns. Fields it doesn't know are kept. */
export function markNotifyAsk<R extends NotifyAskRecord>(r: R, e: NotifyAskEvent, now: number): R {
    return { ...r, ...notifyAskChange(r, e, now) };
}

function notifyAskChange(r: NotifyAskRecord, e: NotifyAskEvent, now: number): NotifyAskRecord {
    switch (e.type) {
        case 'shown': {
            const lines = r.lines ?? [];
            return {
                askDay: localDay(new Date(now)),
                askKind: e.surface,
                ...(e.surface === 'join' ? { joinAt: now } : {}),
                ...(e.surface === 'once' && typeof r.onceAt !== 'number' ? { onceAt: now } : {}),
                ...(e.surface === 'fact' ? { factAt: now } : {}),
                ...(e.surface === 'line' && e.line && !lines.includes(e.line) ? { lines: [...lines, e.line] } : {}),
            };
        }
        case 'later':
            return e.surface === 'once' ? { laterAt: now, onceClosedAt: now } : { laterAt: now };
        case 'away':
            return { homeAwayAt: now, homeAways: (r.homeAways ?? 0) + 1 };
        case 'granted':
            return { state: 'granted', updatedAt: now };
        case 'phone-no':
            return { phoneNoAt: now };
    }
}

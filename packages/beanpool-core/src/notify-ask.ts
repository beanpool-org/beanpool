/**
 * When BeanPool may raise notifications, and what a phone keeps of the answers (scratch/fable-design/
 * DESIGN-notify-and-backup-asks-fable-amend2.md §6, §7 and slice N1 in §12.3; the first design §4 and amend1 §4 for the
 * parts amend2 keeps). One rule for both apps, so the phone and the web app cannot drift.
 *
 * Marty's terms: a soft ask is anything WE draw; a hard ask is the phone's own pop-up, and it only ever follows a tap on
 * a soft ask. Nothing here asks: it says what may be drawn, from the record, the phone's own state and the day.
 *
 * - "Later" and the phone's "no" are kept apart, each with its date. "Later" is never final.
 * - The phone says whether it can still ask (`canAskAgain`); nothing WE said ("Later", an old "Not now") ever overrides
 *   it. On Android 13 and later (`cantAskNeedsRecord`, amend3) "can't ask again" also reads back after a pop-up closed
 *   with no answer, so there it is the phone's no only beside an answer the phone itself gave at one of our taps. Where
 *   the phone also reads Android's own "one no" flag (`saidNoOnce`, amend4), that flag says whether the phone has said
 *   no once, whatever the record holds, and before and after a tap it says which pop-up was answered and how.
 * - One soft ask a day across the join's screen, the once card, the named lines, the Home card and the fact line. The
 *   join's screen is its day's, with one named line still allowed that day. First steps' line and the bell's line are
 *   standing lines, not asks, and are never counted.
 * - No stored data moves: an old record's "Not now" (`state: 'declined'` with no date of the phone's "no") is read as a
 *   "Later" made at its `updatedAt`.
 *
 * Pure: no I/O and no Node built-ins (the barrel is bundled for the phone).
 */
import { localDay } from './home-tips.js';
import { t, tn, word, wordn } from './words.js';

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
    /**
     * The once card on Home was first shown, and when it was closed for good: any answer on it ("Later", a yes, the phone's
     * or the browser's no), or this account's notifications turned off in the app's own Settings (the web's Turn off).
     */
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
    /**
     * This phone's "can't ask again" needs the record (amend3 §3): Android 13 and later only, set by the phone's reader.
     * There Expo reads "denied, can't ask again" after a pop-up closed with no answer, after the app was closed with it
     * up, and on a phone restored from a backup, as well as after a second "Don't allow": only the record tells them
     * apart. Absent (an iPhone, Android 8 to 12, a browser): the flag alone is the phone's answer.
     */
    cantAskNeedsRecord?: boolean;
    /**
     * Android 13 and later: Android's own "should show a reason" flag for notifications, read live by the phone's reader
     * (amend4 §3). On once the phone has said "Don't allow" one time and its last pop-up is still to come; off when it
     * was never asked, said no twice, had a pop-up closed with no answer, or allows them. Absent where it can't be read
     * (no screen in front, a failed call; an iPhone, Android 8 to 12, a browser): amend3's rule stands for that read. It
     * counts only beside `cantAskNeedsRecord`.
     */
    saidNoOnce?: boolean;
}

export interface NotifyAskInput {
    record: NotifyAskRecord;
    phone: NotifyPhone;
    now: number;
    /** A named line's kind, where one is asked about (each kind shows once). */
    line?: string;
    /** Something of the member's is live: a listing, a deal, an unanswered line of theirs, an event they marked. */
    live?: boolean;
    /** What is being opened waited a day or more for them ({@link notifyWaitedDays}). */
    waited?: boolean;
    /**
     * Home's "Your way back in" card is up on this landing (way-back-schedule.ts). Home has one slot for these cards: the
     * Home card waits while that one is up, so a member with nothing kept to get back in is never kept from it by a card
     * that may stay for weeks (slice N3). The once card is decided before either (slice N1h: it goes first).
     */
    wayBack?: boolean;
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

/** An answer the phone itself gave at one of our taps is on this phone's record: a "Don't allow", or a yes (now maybe off). */
function phoneAnswerOnRecord(r: NotifyAskRecord): boolean {
    return typeof r.phoneNoAt === 'number' || r.state === 'granted';
}

/** Android's own "one no" flag where the phone read it beside the Android 13+ mark; else undefined, and amend3 stands (amend4 §3.4). */
function androidSaidNoOnce(p: Pick<NotifyPhone, 'cantAskNeedsRecord' | 'saidNoOnce'>): boolean | undefined {
    return p.cantAskNeedsRecord && typeof p.saidNoOnce === 'boolean' ? p.saidNoOnce : undefined;
}

/**
 * Whether the phone's pop-up can still come (amend3 §3.2, amend4 §3.1). The phone's own flag, except where its "can't ask again" needs
 * the record (`cantAskNeedsRecord`, Android 13+): there it is final only beside an answer the phone gave and this phone
 * recorded, a "Don't allow" (said twice, the second final) or a yes now switched off. With neither on record it is "no
 * answer on file" (a pop-up closed with no answer, the app closed with it up, a phone restored from a backup): it can ask.
 * Where Android's own flag was read (amend4 §3.1) it replaces Expo's "can ask again", which reads the same for "never asked"
 * and "said no once": on, the last pop-up is still to come, whatever the record holds; off, the same record rule.
 */
export function notifyCanAskAgain(r: NotifyAskRecord, p: NotifyPhone): boolean {
    const saidNoOnce = androidSaidNoOnce(p);
    if (saidNoOnce !== undefined) return saidNoOnce || !phoneAnswerOnRecord(r);
    if (p.canAskAgain) return true;
    return !!p.cantAskNeedsRecord && !phoneAnswerOnRecord(r);
}

/**
 * The phone said no: at its pop-up (recorded), or it won't show the pop-up again ({@link notifyCanAskAgain}, which on
 * Android 13+ needs the record). Never while it allows them. Nothing we said (a "Later", an old "Not now") counts. On Android 13+ with its
 * own flag read (amend4 §3.1), the flag on is the phone's no, said once, whatever is on record: an old `declined` that held
 * it, or a write that was lost.
 */
export function notifyPhoneSaidNo(r: NotifyAskRecord, p: NotifyPhone): boolean {
    if (!p.available || p.granted) return false;
    if (androidSaidNoOnce(p)) return true;
    return typeof r.phoneNoAt === 'number' || !notifyCanAskAgain(r, p);
}

/**
 * What a tap on "Turn on" does: bring the phone's pop-up, open the one line about the phone's settings, or nothing. The
 * record goes with the phone's read ({@link notifyCanAskAgain}): on Android 13+ a "can't ask again" with no answer on file
 * still asks.
 */
export function notifyTurnOn(p: NotifyPhone, r: NotifyAskRecord): 'ask' | 'settings' | 'none' {
    if (!p.available || p.granted) return 'none';
    return notifyCanAskAgain(r, p) ? 'ask' : 'settings';
}

/**
 * What the phone's pop-up read back at a tap: Expo's `requestPermissionsAsync` status and its own "can ask again". On
 * Android 13+ that "can ask again" is Android's own flag as it stands after the ask (Expo has marked it asked by then).
 */
export interface NotifyPopUpRead {
    status: string;
    canAskAgain: boolean;
}

/**
 * What a tap's pop-up answered (amend3 §3.1), from what the ask itself read back and what this phone had on record before
 * it. 'granted' and 'phone-no' are the phone's answers, recorded as such; 'later' is no answer (recorded as a "Later");
 * 'none' records nothing new.
 *
 * - Allowed: 'granted', everywhere.
 * - An iPhone, Android 8 to 12 (no `cantAskNeedsRecord`): "denied" is the phone's no, as it always was. Anything else is no
 *   answer.
 * - Android 13+: "denied, can ask again" is a first "Don't allow" ('phone-no'), or, with one already on record, Android's
 *   second pop-up closed with no answer ('none': the first no stands). "denied, can't ask again" is the second "Don't
 *   allow" where an answer of the phone's is on record ('phone-no', now final), else a pop-up closed with no answer
 *   (swiped, backed out of, tapped outside): 'later', never a no.
 * - Android 13+ with its own flag read just before the ask (`saidNoOnce`, amend4 §3.2): the flag before beside the flag
 *   after decides, and the record is not asked. Off then on: a first "Don't allow" ('phone-no'). On then off: the final
 *   "Don't allow" ('phone-no'). On then on: the last pop-up closed with no answer ('none': the phone's one no stands).
 *   Off then off: a pop-up closed with no answer ('later'), or one that never came, which only the phone can tell (amend4
 *   §3.3, utils/notification-permission.ts on the phone).
 */
export function notifyPopUpAnswer(r: NotifyAskRecord, p: Pick<NotifyPhone, 'cantAskNeedsRecord' | 'saidNoOnce'>, read: NotifyPopUpRead): 'granted' | 'phone-no' | 'later' | 'none' {
    if (read.status === 'granted') return 'granted';
    if (read.status !== 'denied') return 'later';
    if (!p.cantAskNeedsRecord) return 'phone-no';
    const before = androidSaidNoOnce(p);
    if (before !== undefined) {
        if (before !== read.canAskAgain) return 'phone-no';
        return before ? 'none' : 'later';
    }
    if (read.canAskAgain) return typeof r.phoneNoAt === 'number' ? 'none' : 'phone-no';
    return phoneAnswerOnRecord(r) ? 'phone-no' : 'later';
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
 *   restore; an older app's "Not now" included): first shown on a free day that no "Later" was said on (a pop-up closed
 *   at First steps' line or the bell's is that day's answer), then each landing until it is answered or for 7 days.
 *   Never again once closed (`onceClosedAt`): any answer on it, a yes included, or a Turn off in the app's own Settings,
 *   which is the member's choice even where the browser still allows the site.
 * - **line**, a named line at the member's own act: each kind once. The day of the join's screen still allows one.
 * - **home**, the card while something of theirs is live ({@link notifyLive}): not 7 days after a "Later", × puts it away
 *   30 days and for good at the third, never with the once card or the way-back card (one card in Home's slot).
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

    const onceOpen = typeof r.onceAt === 'number' && since(r.onceAt) < NOTIFY_ONCE_CARD_DAYS * DAY_MS;
    const laterToday = laterAt !== null && localDay(new Date(laterAt)) === today;
    const once = canAsk && typeof r.joinAt !== 'number' && typeof r.onceClosedAt !== 'number'
        && (typeof r.onceAt !== 'number' ? free && !laterToday : onceOpen && (free || askedToday === 'once'));

    const line = canAsk && !!i.line && !(r.lines ?? []).includes(i.line) && (free || askedToday === 'join');

    const home = canAsk && !!i.live && !once && !i.wayBack
        && since(laterAt) >= NOTIFY_HOME_AFTER_LATER_DAYS * DAY_MS
        && since(r.homeAwayAt) >= NOTIFY_HOME_AWAY_DAYS * DAY_MS
        && (r.homeAways ?? 0) < NOTIFY_HOME_AWAYS
        && (free || askedToday === 'home');

    const fact = notifyTurnOn(p, r) !== 'none' && !!i.waited && since(r.factAt) >= NOTIFY_FACT_DAYS * DAY_MS && free;

    return { join, once, line, home, fact, firstSteps: once ? null : notifyFirstStepsLine(r, p), bell: notifyTurnOn(p, r) !== 'none' };
}

/**
 * What of the member's is live, for the Home card (slice N3; the first design §4.3, amend1 §4.3): the first that holds, in
 * this order, names the card's first line. A listing of theirs that is up ('offers' when every one is an Offer, else
 * 'listings'), an open deal, a chat where their own line is the newest and waits ('waiting'), an event they answered Going
 * or Interested that has not ended.
 */
export type NotifyLive =
    | { kind: 'offers' | 'listings' | 'deals'; n: number }
    | { kind: 'waiting' }
    | { kind: 'event'; title: string; going: boolean };

/** A line of the member's own that is the newest in its chat counts as waiting for this many days after it was sent. */
export const NOTIFY_WAITING_DAYS = 30;

/**
 * What the phone already has, read for {@link notifyLive}. Every field may be missing: nothing is asked of the server.
 *
 * - `listings`: the member's own posts on this phone (type and status; events are not listings).
 * - `deals`: open deals, from Home's answer (Your deals' `open`).
 * - `waitingAt`: when the member's own line was sent, in each chat where it is the newest.
 * - `events`: the events in Home's answer, each with the member's answer (`rsvp`) and its times.
 */
export interface NotifyLiveInput {
    listings?: readonly { type?: unknown; status?: unknown }[] | null;
    deals?: number | null;
    waitingAt?: readonly (number | string | null | undefined)[] | null;
    events?: readonly { title?: unknown; rsvp?: unknown; startsAt?: unknown; endsAt?: unknown }[] | null;
    now: number;
}

const LIVE_STATUS = new Set(['active', 'pending']);
const LISTING_TYPES = new Set(['offer', 'need']);

/** A time as a number of ms: a number as it is, a string parsed, anything else null. */
function msOf(v: unknown): number | null {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string' || !v) return null;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
}

/** What is live ({@link NotifyLive}), or null: nothing an answer could come to, so no Home card. */
export function notifyLive(i: NotifyLiveInput): NotifyLive | null {
    const up = (i.listings ?? []).filter((l) => LIVE_STATUS.has(l?.status as string) && LISTING_TYPES.has(l?.type as string));
    if (up.length) return { kind: up.every((l) => l.type === 'offer') ? 'offers' : 'listings', n: up.length };
    const deals = typeof i.deals === 'number' && Number.isFinite(i.deals) ? Math.floor(i.deals) : 0;
    if (deals > 0) return { kind: 'deals', n: deals };
    const waiting = (i.waitingAt ?? []).some((at) => {
        const ms = msOf(at);
        return ms !== null && ms <= i.now && i.now - ms < NOTIFY_WAITING_DAYS * DAY_MS;
    });
    if (waiting) return { kind: 'waiting' };
    for (const e of i.events ?? []) {
        if (e?.rsvp !== 'going' && e?.rsvp !== 'interested') continue;
        const title = typeof e.title === 'string' ? e.title.trim() : '';
        const ends = msOf(e.endsAt) ?? msOf(e.startsAt);
        if (title && ends !== null && ends > i.now) return { kind: 'event', title, going: e.rsvp === 'going' };
    }
    return null;
}

const HOME_OFFERS = wordn('You have {n} offer up.', 'You have {n} offers up.');
const HOME_LISTINGS = wordn('You have {n} listing up.', 'You have {n} listings up.');
const HOME_DEALS = wordn('You have {n} deal open.', 'You have {n} deals open.');

/** The Home card's words: its band, what is live, what this phone won't do, its button and its ×'s label. */
export interface NotifyHomeWords {
    band: string;
    fact: string;
    wont: string;
    turnOn: string;
    away: string;
}

/**
 * The Home card's words (the first design §4.3, §6.1; amend1 §4.3): "You have 1 offer up. This phone won't tell you when
 * someone answers."; an event they marked: "You're going to {event}. This phone won't remind you." An event's title is
 * the member's neighbour's words, never translated.
 */
export function notifyHomeWords(live: NotifyLive): NotifyHomeWords {
    const base = { band: t('Notifications'), turnOn: t('Turn on'), away: t('Put this card away') };
    if (live.kind === 'event') {
        return {
            ...base,
            fact: live.going ? t("You're going to {event}.", { event: live.title }) : t("You're interested in {event}.", { event: live.title }),
            wont: t("This phone won't remind you."),
        };
    }
    const wont = t("This phone won't tell you when someone answers.");
    if (live.kind === 'waiting') return { ...base, fact: t("You're waiting for an answer."), wont };
    const w = live.kind === 'offers' ? HOME_OFFERS : live.kind === 'listings' ? HOME_LISTINGS : HOME_DEALS;
    return { ...base, fact: tn(live.n, w.one, w.other), wont };
}

/**
 * Whole days something waited for the member before they opened it (the fact line, the first design §4.4, amend1 §4.3):
 * from when it arrived (a message, a notice, an event's change) to when it is opened. Null under a day, or with no time
 * to go by: then no fact line.
 */
export function notifyWaitedDays(arrivedAt: number | string | null | undefined, openedAt: number): number | null {
    const at = msOf(arrivedAt);
    if (at === null || openedAt < at) return null;
    const days = Math.floor((openedAt - at) / DAY_MS);
    return days >= 1 ? days : null;
}

const FACT_WAITED = wordn('This waited {n} day for you.', 'This waited {n} days for you.');

/**
 * The fact line's words: "This waited 2 days for you." and its link, "Tell me next time ›" where a tap brings the phone's
 * pop-up, "Turn on ›" where it opens the one line before the phone's settings ({@link notifyTurnOn} 'settings': the phone
 * said no). Null where a tap has nothing to do (the phone allows them, or has none).
 */
export function notifyFactWords(days: number, p: NotifyPhone, r: NotifyAskRecord): { line: string; link: string } | null {
    const way = notifyTurnOn(p, r);
    if (way === 'none') return null;
    return { line: tn(days, FACT_WAITED.one, FACT_WAITED.other), link: way === 'settings' ? t('Turn on ›') : t('Tell me next time ›') };
}

/**
 * The named lines at the member's own acts (amend2 §12.3 slice N2a; the first design §4.2, amend1 §4.3), each kind shown
 * once on a phone (the record's `lines`): a first message sent ('answer'), a first message read or a request accepted
 * ('again'), a first listing ('listing'), a first offer or request on someone's listing ('offer'), an ask to join ('join');
 * and (slice N2b) Going on an event ('going'), Interested on one ('interested'), a starred interest where the community
 * tells members when a neighbour asks ('star'), a forum topic followed ('follow'). One line with one button and no "Not
 * now": leaving the screen is the no.
 */
export const NOTIFY_LINE_KINDS = ['answer', 'again', 'listing', 'offer', 'join', 'going', 'interested', 'star', 'follow'] as const;
export type NotifyLineKind = typeof NOTIFY_LINE_KINDS[number];

/**
 * A named line's words: the offer, and what it says once the phone allows notifications. `name` is the person (answer,
 * again, offer) or the community (join) they wait on; without one, or for a first listing, "someone". The event, interest
 * and forum lines name nobody; Interested gets the reminder only, as a change to an event is told to Going alone.
 */
export function notifyLineWords(kind: NotifyLineKind, name?: string | null): { line: string; done: string; button: string } {
    const button = t('Tell me');
    switch (kind) {
        case 'going': return { line: t('Get a reminder the day before, and hear if it changes.'), done: t("You'll get a reminder the day before, and hear if it changes."), button };
        case 'interested': return { line: t('Get a reminder the day before.'), done: t("You'll get a reminder the day before."), button };
        case 'star': return { line: t('Hear when a neighbour asks for one of these.'), done: t("You'll hear when a neighbour asks for one of these."), button };
        case 'follow': return { line: t('Hear when someone replies here.'), done: t("You'll hear when someone replies here."), button };
        default: break;
    }
    const who = kind === 'listing' ? '' : (name ?? '').trim();
    if (!who) return { line: t('Hear when someone answers.'), done: t("You'll hear when someone answers."), button };
    if (kind === 'again') return { line: t('Hear when {name} writes again.', { name: who }), done: t("You'll hear when {name} writes again.", { name: who }), button };
    if (kind === 'offer') return { line: t('Hear when {name} says yes.', { name: who }), done: t("You'll hear when {name} says yes.", { name: who }), button };
    return { line: t('Hear when {name} answers.', { name: who }), done: t("You'll hear when {name} answers.", { name: who }), button };
}

/**
 * What the node will still tell a member of an event they answered, read by its own rule (event-notices.ts
 * eventNoticesComing, both apps): `dayBefore`, the reminder the day before is still to come for them;
 * `changes`, a change of time or place or a cancellation will be told to them (Going only, apps/server/src/engine/posts.ts).
 */
export interface NotifyEventComing {
    dayBefore: boolean;
    changes: boolean;
}

/**
 * The named line under an answer to an event (slice N2b), saying only what will come: the reminder the day before only while
 * it is still to come, a change only where one is told (Going). Neither: null, and no line is offered or drawn. The words
 * follow what is true now, not the answer that brought the line: Going then Interested drops the change, and a reminder
 * choice changed to none drops the reminder.
 */
export function notifyEventLineWords(coming: NotifyEventComing): { line: string; done: string; button: string } | null {
    if (coming.dayBefore && coming.changes) return notifyLineWords('going');
    if (coming.dayBefore) return notifyLineWords('interested');
    if (coming.changes) return { line: t('Hear if it changes.'), done: t("You'll hear if it changes."), button: t('Tell me') };
    return null;
}

/**
 * The two true lines (amend1 §4.3, amend2 §6, slice N2b). Neither is a soft ask: each is the true state of something the
 * member asked for, so it shows in every state of the record, after a "Later" and after the phone's "no" alike, and never
 * takes the day. `phone` null: not read yet; neither says anything new then, and nothing is promised.
 *
 * - An event's reminder ({@link notifyRemindersOff}): while this phone can't notify and notifications can be had here,
 *   "⏰ Remind me: a day before" becomes "⏰ Reminders need notifications on." [Turn on]. Its Turn on is
 *   {@link notifyTurnOn}'s: the phone's pop-up where it can still show it, else the one line before the phone's settings.
 * - What are you into?'s note ({@link notifyInterestsPromise}): "we'll tell you when a neighbour asks for it" only where the
 *   community sends that push and this phone allows notifications. Off, the note says the rest and promises nothing.
 */
export function notifyRemindersOff(p: NotifyPhone | null | undefined): boolean {
    // Whether there is anything to turn on is the phone's alone; the record only chooses the pop-up or the settings line.
    return !!p && notifyTurnOn(p, {}) !== 'none';
}

/** Whether What are you into?'s note may say "we'll tell you when a neighbour asks for it" (see {@link notifyRemindersOff}). */
export function notifyInterestsPromise(askedPush: boolean, p: NotifyPhone | null | undefined): boolean {
    return askedPush && !!p && p.available && p.granted;
}

/** The reminder's true line, in place of "⏰ Remind me: …" while this phone can't notify ({@link notifyRemindersOff}). */
export const NOTIFY_TRUE_WORDS = {
    reminders: word('⏰ Reminders need notifications on.'),
} as const;

export type NotifyAskEvent =
    /** A soft ask was drawn (a named line with its kind). */
    | { type: 'shown'; surface: NotifyAskSurface; line?: string }
    /** "Later" on an ask (on the once card it also puts the card away), or the phone's pop-up closed with no answer. */
    | { type: 'later'; surface?: NotifyAskSurface }
    /** × on the Home card. */
    | { type: 'away' }
    /** The phone's (or browser's) pop-up answered, at a tap on `surface`: on the once card either answer also closes it. */
    | { type: 'granted'; surface?: NotifyAskSurface }
    | { type: 'phone-no'; surface?: NotifyAskSurface }
    /**
     * This account's notifications turned off in the app's own Settings (the web's Turn off, slice N5a). The member's
     * choice: the once card never shows again. The browser may still allow the site, so nothing else reads it as a no.
     */
    | { type: 'off' };

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
            return { state: 'granted', updatedAt: now, ...closesOnce(r, e.surface, now) };
        case 'phone-no':
            return { phoneNoAt: now, ...closesOnce(r, e.surface, now) };
        case 'off':
            return closesOnce(r, 'once', now);
    }
}

/** The once card closed for good, at its first close: an answer on it (`surface` 'once'), or a Turn off in Settings. */
function closesOnce(r: NotifyAskRecord, surface: NotifyAskSurface | undefined, now: number): NotifyAskRecord {
    return surface === 'once' && typeof r.onceClosedAt !== 'number' ? { onceClosedAt: now } : {};
}

/**
 * The join's last screen (amend2 §4, slice N1j): the join's one soft ask, after the way back and straight before Home (on a
 * claim, before the owner's card). Its words, whether it shows, and what an answer counts, one place for both apps.
 *
 * Which way a join came in by: an invite, another community's open door, the global community's door, a claim; a restore
 * passes no join and never meets the screen (Home's once card is its one soft ask, slice N1h).
 */
export type NotifyJoinPath = 'invite' | 'door' | 'global' | 'claim' | 'restore';

/**
 * Whether the join's last screen shows: on a join, where {@link notifyAsks} allows the join's ask (the phone has to ask and
 * still can, the day is free or this screen is its unanswered ask; Android 8 to 12 already allows, so never there). Read
 * before the join's steps for their dots, and again as the way back hands over, so a phone that answered in between goes
 * straight on.
 */
export function notifyJoinStep(path: NotifyJoinPath, i: Pick<NotifyAskInput, 'record' | 'phone' | 'now'>): boolean {
    return path !== 'restore' && notifyAsks({ record: i.record, phone: i.phone, now: i.now }).join;
}

/** How the join's screen was left: the phone's answer to "Turn on notifications" (the phone app's TurnOnResult), or "Later". */
export type NotifyJoinOutcome = 'granted' | 'declined' | 'settings' | 'unanswered' | 'later';

/**
 * What the owner's Onboarding panel counts for an answer (N1c's sub-types, onboarding-funnel.ts NOTIFY_CHOICES): the phone
 * allowed ('on'); the phone said no, at its pop-up or already in its settings ('no'); "Later", or the phone's pop-up closed
 * with no answer, which leaves its question unspent ('later').
 */
export function notifyJoinChoice(o: NotifyJoinOutcome): 'on' | 'later' | 'no' {
    if (o === 'granted') return 'on';
    return o === 'declined' || o === 'settings' ? 'no' : 'later';
}

/** Whose join it is, for the screen's third line: a community's member, the global community's, or the owner of a claim. */
export type NotifyJoinKind = 'community' | 'global' | 'owner';

/**
 * Who shows the pop-up a tap on "Turn on notifications" brings, for the line under the button: the phone (the phone app),
 * the browser (the web app, slice N5a), or nobody, where the browser already allows this site and asks nothing more (then
 * no line: nothing is promised that won't come).
 */
export type NotifyPrompter = 'phone' | 'browser' | 'none';

export interface NotifyJoinWords {
    title: string;
    /** The reason no other app can give, in two sentences, the second the stronger. */
    never: string;
    only: string;
    /** What arrives, then the promise "Never ads." after it in the same paragraph. */
    arrives: string;
    ads: string;
    turnOn: string;
    /** Under the main button: the phone's (or browser's) own pop-up follows, so it is no surprise. Empty where none follows. */
    confirm: string;
    later: string;
}

/**
 * The screen's words (amend2 §4.1): "Hear from {community}"; "BeanPool never emails or texts you." "Notifications are the
 * only way it can reach you." (true: nothing of BeanPool sends email or SMS); what arrives, by name where the join knows who
 * invited; "Never ads." (a push is one of a fixed list of sentences, never free text). Never "Nothing else.": votes,
 * reviews, group invites and account-safety notices come too.
 */
export function notifyJoinWords(o: { kind: NotifyJoinKind; community?: string | null; inviter?: string | null; prompter?: NotifyPrompter }): NotifyJoinWords {
    const community = (o.community ?? '').trim();
    const inviter = (o.inviter ?? '').trim();
    const arrives = o.kind === 'owner'
        ? t('When someone asks to join, a member writes, or your server needs you.')
        : o.kind === 'global'
            ? t('When someone writes to you, or a community answers your request to join.')
            : inviter
                ? t("When {name} writes, someone answers you, or an event you're going to changes.", { name: inviter })
                : t("When a neighbour writes, someone answers you, or an event you're going to changes.");
    return {
        title: community ? t('Hear from {community}', { community }) : t('Hear from your community'),
        never: t('BeanPool never emails or texts you.'),
        only: t('Notifications are the only way it can reach you.'),
        arrives,
        ads: t('Never ads.'),
        turnOn: t('Turn on notifications'),
        confirm: o.prompter === 'none' ? '' : o.prompter === 'browser' ? t('Your browser will ask you to confirm.') : t('Your phone will ask you to confirm.'),
        later: t('Later'),
    };
}

/**
 * Home's once card (amend2 §7, slice N1h): the join's own words, for a member already in, with "a neighbour" for the name (no
 * join to name an inviter from), and its band's word. The global community's line on the global community's Home.
 */
export function notifyOnceWords(o: { global: boolean; community?: string | null }): NotifyJoinWords & { band: string } {
    return {
        ...notifyJoinWords({ kind: o.global ? 'global' : 'community', community: o.global ? null : o.community, inviter: null }),
        band: t('Notifications'),
    };
}

/**
 * A browser, read for the rule (slice N5a; amend2 §10: the web's join gets the same last screen where the browser can
 * deliver). Nothing here asks the browser: each is read from what it already says.
 *
 * - `push`: web push can reach this browser at all: a computer's browser, a phone's, BeanPool opened from an iPhone's
 *   Home Screen. Not Safari on an iPhone outside the Home Screen, a private window, a page over http, a browser with no
 *   push (apps/pwa lib/web-push.ts pushPlace).
 * - `permission`: the browser's own `Notification.permission` ('default', 'granted', 'denied'; null with no Notification).
 * - `on`: this account's notifications are on in this browser: the browser allows them and the community holds this
 *   browser as the member's (a Tell me from the waiting page is not that: only a tap on Turn on is).
 */
export interface NotifyBrowser {
    push: boolean;
    permission: string | null;
    on: boolean;
}

/**
 * A browser as the rule's phone: no push, nothing to turn on and nothing drawn; this account's notifications on here, it
 * allows; else it can still ask unless the browser blocks this site ('denied', which only the browser's own settings undo,
 * as an iPhone's Don't Allow). A browser that allows the site while this account's notifications are off here is one that
 * can still ask: Turn on then asks it nothing more (its prompter is 'none') and makes this account's subscription.
 * Browsers say 'default' after a prompt closed with no answer: still able to ask, never a no.
 */
export function notifyBrowserPhone(b: NotifyBrowser): NotifyPhone {
    if (!b.push) return { available: false, granted: false, canAskAgain: false };
    return { available: true, granted: b.on, canAskAgain: b.permission !== 'denied' };
}

/** Who shows a pop-up at the web's Turn on: the browser, unless it already allows this site (it asks nothing then). */
export function notifyBrowserPrompter(b: NotifyBrowser): NotifyPrompter {
    return b.permission === 'granted' ? 'none' : 'browser';
}

/**
 * What a tap on the web's Turn on ended in (apps/pwa lib/web-push.ts turnOnWebPush): this account's notifications on
 * ('ok'), the browser blocked them ('blocked'), its prompt closed with no answer ('dismissed': browsers report 'default'
 * then), no push here ('cannot'), or the browser allowed them and the community did not take the subscription ('failed').
 */
export type NotifyBrowserResult = 'ok' | 'blocked' | 'dismissed' | 'cannot' | 'failed';

/**
 * What that answer records and counts, as the phone's: 'granted' (on; counted 'on'), 'declined' (the browser's no;
 * recorded apart with its date, counted 'no'), 'unanswered' (a "Later", never a no; counted 'later'). Null for 'failed':
 * nothing is on yet, so nothing is recorded or counted, and the screen says so with its buttons still there.
 */
export function notifyBrowserOutcome(r: NotifyBrowserResult): Exclude<NotifyJoinOutcome, 'settings' | 'later'> | null {
    if (r === 'ok') return 'granted';
    if (r === 'blocked') return 'declined';
    return r === 'failed' ? null : 'unanswered';
}

/**
 * The record's event for a way off a soft ask: the browser's or phone's yes, its no, or a "Later", each on `surface`, so
 * any answer on the once card closes it for good (a yes too: switched off later in Settings, the card stays closed).
 */
export function notifyOutcomeEvent(o: NotifyJoinOutcome, surface: NotifyAskSurface): NotifyAskEvent {
    if (o === 'granted') return { type: 'granted', surface };
    if (o === 'declined' || o === 'settings') return { type: 'phone-no', surface };
    return { type: 'later', surface };
}

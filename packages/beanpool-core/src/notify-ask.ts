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
 *   with no answer, so there it is the phone's no only beside an answer the phone itself gave at one of our taps.
 * - One soft ask a day across the join's screen, the once card, the named lines, the Home card and the fact line. The
 *   join's screen is its day's, with one named line still allowed that day. First steps' line and the bell's line are
 *   standing lines, not asks, and are never counted.
 * - No stored data moves: an old record's "Not now" (`state: 'declined'` with no date of the phone's "no") is read as a
 *   "Later" made at its `updatedAt`.
 *
 * Pure: no I/O and no Node built-ins (the barrel is bundled for the phone).
 */
import { localDay } from './home-tips.js';
import { t, word } from './words.js';

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
    /**
     * This phone's "can't ask again" needs the record (amend3 §3): Android 13 and later only, set by the phone's reader.
     * There Expo reads "denied, can't ask again" after a pop-up closed with no answer, after the app was closed with it
     * up, and on a phone restored from a backup, as well as after a second "Don't allow": only the record tells them
     * apart. Absent (an iPhone, Android 8 to 12, a browser): the flag alone is the phone's answer.
     */
    cantAskNeedsRecord?: boolean;
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

/** An answer the phone itself gave at one of our taps is on this phone's record: a "Don't allow", or a yes (now maybe off). */
function phoneAnswerOnRecord(r: NotifyAskRecord): boolean {
    return typeof r.phoneNoAt === 'number' || r.state === 'granted';
}

/**
 * Whether the phone's pop-up can still come (amend3 §3.2). The phone's own flag, except where its "can't ask again" needs
 * the record (`cantAskNeedsRecord`, Android 13+): there it is final only beside an answer the phone gave and this phone
 * recorded, a "Don't allow" (said twice, the second final) or a yes now switched off. With neither on record it is "no
 * answer on file" (a pop-up closed with no answer, the app closed with it up, a phone restored from a backup): it can ask.
 */
export function notifyCanAskAgain(r: NotifyAskRecord, p: NotifyPhone): boolean {
    if (p.canAskAgain) return true;
    return !!p.cantAskNeedsRecord && !phoneAnswerOnRecord(r);
}

/**
 * The phone said no: at its pop-up (recorded), or it won't show the pop-up again ({@link notifyCanAskAgain}, which on
 * Android 13+ needs the record). Never while it allows them. Nothing we said (a "Later", an old "Not now") counts.
 */
export function notifyPhoneSaidNo(r: NotifyAskRecord, p: NotifyPhone): boolean {
    if (!p.available || p.granted) return false;
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

/** What the phone's pop-up read back at a tap: Expo's `requestPermissionsAsync` status and its own "can ask again". */
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
 */
export function notifyPopUpAnswer(r: NotifyAskRecord, p: Pick<NotifyPhone, 'cantAskNeedsRecord'>, read: NotifyPopUpRead): 'granted' | 'phone-no' | 'later' | 'none' {
    if (read.status === 'granted') return 'granted';
    if (read.status !== 'denied') return 'later';
    if (!p.cantAskNeedsRecord) return 'phone-no';
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

    const fact = notifyTurnOn(p, r) !== 'none' && !!i.waited && since(r.factAt) >= NOTIFY_FACT_DAYS * DAY_MS && free;

    return { join, once, line, home, fact, firstSteps: once ? null : notifyFirstStepsLine(r, p), bell: notifyTurnOn(p, r) !== 'none' };
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
 * What the node will still tell a member of an event they answered, read by its own rule (the phone's
 * apps/native/utils/event-extras.ts eventNoticesComing): `dayBefore`, the reminder the day before is still to come for them;
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
    return !!p && notifyTurnOn(p) !== 'none';
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

export interface NotifyJoinWords {
    title: string;
    /** The reason no other app can give, in two sentences, the second the stronger. */
    never: string;
    only: string;
    /** What arrives, then the promise "Never ads." after it in the same paragraph. */
    arrives: string;
    ads: string;
    turnOn: string;
    /** Under the main button: the phone's own pop-up follows, so it is no surprise. */
    confirm: string;
    later: string;
}

/**
 * The screen's words (amend2 §4.1): "Hear from {community}"; "BeanPool never emails or texts you." "Notifications are the
 * only way it can reach you." (true: nothing of BeanPool sends email or SMS); what arrives, by name where the join knows who
 * invited; "Never ads." (a push is one of a fixed list of sentences, never free text). Never "Nothing else.": votes,
 * reviews, group invites and account-safety notices come too.
 */
export function notifyJoinWords(o: { kind: NotifyJoinKind; community?: string | null; inviter?: string | null }): NotifyJoinWords {
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
        confirm: t('Your phone will ask you to confirm.'),
        later: t('Later'),
    };
}

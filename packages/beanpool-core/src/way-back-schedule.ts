/**
 * When Home's "Your way back in" card shows (scratch/fable-design/DESIGN-notify-and-backup-asks-fable.md §5.2, amend2
 * §12.3 slice B1; Marty's pick 10 of 21 Nov 2026, "as stated"). One rule for both apps, so the phone and the web app
 * cannot drift.
 *
 * - **first**: from the first landing after the join's "Later" (onboarding S4), until it is put away.
 * - **beans**: once when the first Beans arrive (a balance above zero is first seen), with the fact:
 *   "You have 40 Beans here now. Keep a way back in, so they don't go with a lost phone."
 * - **month**: once more 30 days after joining.
 * - **every**: after that, once every 90 days from the last time it was put away, only while there is something to lose.
 * - Never while a way back is kept (a sign-in's copy at the key vault, the 12 words said written down, a sign-in the
 *   community counts), and never on one screen with the notifications card (that one first; this one the next landing).
 *
 * "Something to lose" (decided here from the first design §5.2, which names "a balance that isn't zero, or a live
 * listing"): a balance that isn't zero (Beans owed are history and standing too), a live listing or an open deal, or a
 * role in the community (owner, admin, moderator). Not the bare account: then every account would qualify and the
 * condition would say nothing.
 *
 * Each return is waiting while its moment is later than the last put-away, so one × answers every return waiting then, a
 * put-away on another device counts as this one's, and no "used" flag is kept. The record keeps one new field, when the
 * first Beans were seen ({@link wayBackBeansSeen}); an older record's flags for the old returns (first post, a week) are
 * read as nothing and never rewritten.
 *
 * Pure: no I/O and no Node built-ins (the barrel is bundled for the phone).
 */
import { t, word } from './words.js';

const DAY_MS = 86_400_000;

/** The card comes once more this many days after joining. */
export const WAY_BACK_MONTH_DAYS = 30;
/** After that, at most once in this many days, while there is something to lose. */
export const WAY_BACK_EVERY_DAYS = 90;

/** Why the card is up: see the file's header. */
export type WayBackReturn = 'first' | 'beans' | 'month' | 'every';

export interface WayBackScheduleInput {
    /** When the account joined (the phone's record). */
    joinedAt: number;
    now: number;
    /** A way back is kept: never shown. */
    kept: boolean;
    /** The last time the card was put away, here or anywhere; absent: not put away since it started (it shows). */
    putAwayAt?: number | null;
    /** When a balance above zero was first seen on this account; absent: not yet. */
    beansAt?: number | null;
    /** The balance now, whole hundredths of a Bean; absent when not known (Beans off, no Beans card asked, the worldwide community). */
    balance_c?: number | null;
    /** Something else to lose now: a live listing, an open deal, a role. */
    holds?: boolean;
    /** The notifications card holds Home's one slot now: this card waits for the next landing. */
    slotTaken?: boolean;
}

export interface WayBackSchedule {
    /** The card is drawn now. */
    show: boolean;
    /** Why it is drawn; null when it is not. */
    why: WayBackReturn | null;
    /**
     * When it next comes back by the calendar, if nothing else changes; null when no date is known: kept, up now, or with
     * the 30 days past and nothing to lose (the first Beans bring it, and so does anything to lose at the next 90 days).
     */
    next: number | null;
    /** The bell's quiet last line, "No way back in yet. Keep one ›": after the card's first ×, until a way back is kept. */
    bell: boolean;
}

const at = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Whether there is something to lose now (the file's header). */
export function wayBackSomethingToLose(i: Pick<WayBackScheduleInput, 'balance_c' | 'holds'>): boolean {
    const balance = at(i.balance_c);
    return (balance !== null && balance !== 0) || !!i.holds;
}

/**
 * When the first Beans were seen: the date already kept, else `now` when the balance is above zero now, else none. The
 * phone writes it into its record the first time it changes.
 */
export function wayBackBeansSeen(beansAt: number | null | undefined, balance_c: number | null | undefined, now: number): number | null {
    const kept = at(beansAt);
    if (kept !== null) return kept;
    const balance = at(balance_c);
    return balance !== null && balance > 0 ? now : null;
}

/** The rule: see the file's header. */
export function wayBackSchedule(i: WayBackScheduleInput): WayBackSchedule {
    if (i.kept) return { show: false, why: null, next: null, bell: false };
    const away = at(i.putAwayAt);
    const beansAt = at(i.beansAt);
    const balance = at(i.balance_c);
    const month = i.joinedAt + WAY_BACK_MONTH_DAYS * DAY_MS;
    const toLose = wayBackSomethingToLose(i);
    const after = (moment: number) => away === null || moment > away;

    let why: WayBackReturn | null = null;
    if (beansAt !== null && balance !== null && balance > 0 && after(beansAt)) why = 'beans';
    else if (away === null) why = 'first';
    else if (i.now >= month && after(month)) why = 'month';
    else if (toLose && i.now >= away + WAY_BACK_EVERY_DAYS * DAY_MS) why = 'every';

    const bell = away !== null;
    if (why !== null && !i.slotTaken) return { show: true, why, next: null, bell };
    if (why !== null) return { show: false, why: null, next: i.now, bell };
    // Not up: the next date by the calendar. The 30 days first, while that return is still to come; then the 90 days.
    const next = after(month) ? month : toLose ? away! + WAY_BACK_EVERY_DAYS * DAY_MS : null;
    return { show: false, why: null, next, bell };
}

/** The card's words (amend2 §12.3 B1; the first design §6.1). The phone keeps its buttons' words where they were. */
export const WAY_BACK_WORDS = {
    line: word('If this phone is lost, this is how you get back in.'),
    beans: word("You have {amount} here now. Keep a way back in, so they don't go with a lost phone."),
    bell: word('No way back in yet.'),
    bellKeep: word('Keep one'),
} as const;

/** The card's sentence for why it is up: the fact on the first Beans (`amount` already written, "40 Beans"), else the one line. */
export function wayBackLine(why: WayBackReturn | null, amount: string | null): string {
    return why === 'beans' && amount ? t(WAY_BACK_WORDS.beans, { amount }) : t(WAY_BACK_WORDS.line);
}

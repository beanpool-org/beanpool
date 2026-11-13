/**
 * First steps, as it shrinks and leaves (scratch/fable-design/DESIGN-home-default-fable.md §2.4, slice D0): the card's line
 * ids, its two new lines' words, the one quiet line of progress, and how long it stays. The apps build each line from the
 * node's `steps` facts (routes/home-answer.ts) and draw only what is left; the node stops sending the card when no line it
 * knows of is left or the days are up. No Beans for any line (decided 2 Nov).
 *
 * Pure: no I/O and no Node built-ins (the barrel is bundled for the phone).
 */
import { t, word } from './words.js';

/**
 * The card's lines on a local community, in their order: the five there are (Post your first Offer, Add a photo, Pick a few
 * things you like, then after the first Offer, Ask for one thing and Invite someone), then the two new ones last, each
 * only where it applies:
 *
 * - `words` "Keep your 12 words safe": for an account with no second way back (the node's `me.wayBack` is `words`).
 *   Ticked by adding a sign-in, by "I still have my 12 words", or by saving the recovery kit (all kept on the account).
 * - `notify` "Hear when someone answers you": on a phone that has to ask (Android 13 and later, iPhone). Ticked when
 *   allowed. Never on Android 8 to 12, where it is already on, nor on the web until members' web push (W2).
 */
export const FIRST_STEPS_LINE_IDS = ['offer', 'photo', 'interests', 'need', 'invite', 'words', 'notify'] as const;
export type FirstStepsLineId = (typeof FIRST_STEPS_LINE_IDS)[number];

/** The two new lines' words: shown through t(). */
export const FIRST_STEPS_WORDS = {
    words: word('Keep your 12 words safe'),
    notify: word('Hear when someone answers you'),
} as const;

/** How long First steps stays on a local community, in days after joining (§2.4 "It leaves"). */
export const FIRST_STEPS_DAYS = 30;
/** How long global's "Your first week" stays (it keeps its 14 days, §2.4). */
export const FIRST_WEEK_DAYS = 14;

/** Only what is left is drawn (§2.4): a finished row is never shown. */
export const firstStepsLeft = <L extends { done: boolean }>(lines: readonly L[]): L[] => lines.filter((l) => !l.done);

/** The one quiet line of progress, "2 of 5 done", in the member's language; '' for a card with no lines. */
export function firstStepsCount(lines: readonly { done: boolean }[]): string {
    if (lines.length === 0) return '';
    return t('{n} of {m} done', { n: lines.filter((l) => l.done).length, m: lines.length });
}

/**
 * Whether the card's days are up: 30 after joining on a local community, 14 on the worldwide one. A join date not heard or
 * unreadable is never over (the card then stays while a line is left).
 */
export function firstStepsOver(joinedAt: string | null | undefined, now: number = Date.now(), profile: 'local' | 'global' | string = 'local'): boolean {
    const joined = typeof joinedAt === 'string' ? Date.parse(joinedAt) : NaN;
    if (!Number.isFinite(joined)) return false;
    return now - joined >= (profile === 'global' ? FIRST_WEEK_DAYS : FIRST_STEPS_DAYS) * 86_400_000;
}

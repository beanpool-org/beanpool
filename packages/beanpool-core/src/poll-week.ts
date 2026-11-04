/**
 * A member starts one poll a week for the whole community (Marty, 4 Nov 2026). The node holds it (apps/server engine/poll-week.ts);
 * this is what both apps say BEFORE the member types: when the node says the next community poll cannot start yet, the poll form
 * opens as a notice with the day, not as an empty form. A poll for one of the member's groups is not held to the week, so the web
 * app, whose poll form can aim at a group, says that too (the phone's poll form is the community's alone). One module for the
 * phone and the web app, so they read the node's answer, and say it, the same way.
 *
 * The node answers GET /api/marketplace/polls/next-start with `{ nextAt }`: an ISO time, or null when the member may start a
 * community poll now (an owner or an admin always: their limit is the one in Settings). A node from before this rule answers 404, an offline
 * phone answers nothing: both read as "may start one", and the form opens as it always did. The node still checks at the
 * Create, so a stale answer is never the last word, and never a gate (onboarding-no-hard-gates).
 *
 * The day is written in the member's own calendar and language (formatDate: the device's time zone, which is where the member
 * is; a node has no time zone of its own). The node's refusal, if the member gets as far as Create, names no day: it says how
 * long to wait, in hours or days, rounded up.
 */

import { formatDate, t } from './words.js';

/** The node's answer to "when can I start my next poll?" (signed GET). */
export const POLL_NEXT_START_PATH = '/api/marketplace/polls/next-start';

/** The time the node says the member's next poll can start, or null: no answer, an old node, a time that has passed, or a malformed one. */
export function pollNextStartMs(answer: unknown, now: number = Date.now()): number | null {
    const nextAt = (answer as { nextAt?: unknown } | null | undefined)?.nextAt;
    if (typeof nextAt !== 'string') return null;
    const at = Date.parse(nextAt);
    return Number.isFinite(at) && at > now ? at : null;
}

/** The sentence a community poll form shows in place of its fields: the day the next one can start, in the member's calendar. */
export function pollWeekNotice(nextAtMs: number): string {
    return t('You can start one community poll a week. Your next one can start on {date}.', { date: formatDate(new Date(nextAtMs), 'weekday-day-month') });
}

/**
 * The line after the notice, for a member who has a group to aim a poll at: a poll for a group is not held to the week.
 * Only the web app shows it; the phone's poll form has no group choice.
 */
export function pollWeekGroupNote(): string {
    return t('You can still start a poll for one of your groups. Choose Group above.');
}

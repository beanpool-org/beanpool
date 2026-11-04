/**
 * A member starts one poll a week (Marty, 4 Nov 2026). The node holds it (apps/server engine/poll-week.ts); this is what both
 * apps say BEFORE the member types: when the node says the next poll cannot start yet, the poll form opens as a notice with the
 * day, not as an empty form. One module for the phone and the web app, so they read the node's answer, and say it, the same way.
 *
 * The node answers GET /api/marketplace/polls/next-start with `{ nextAt }`: an ISO time, or null when the member may start one
 * now (an owner or an admin always: their limit is the one in Settings). A node from before this rule answers 404, an offline
 * phone answers nothing: both read as "may start one", and the form opens as it always did. The node still checks at the
 * Create, so a stale answer is never the last word, and never a gate (onboarding-no-hard-gates).
 *
 * The day is written in the member's own calendar and language (formatDate: the device's time zone, which is where the member
 * is; a node has no time zone of its own). The node's refusal, if the member gets as far as Create, writes the UTC day.
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

/** The sentence a form shows in place of its fields: the one the node's own refusal says, with the day in the member's calendar. */
export function pollWeekNotice(nextAtMs: number): string {
    return t('You can start one poll a week. Your next one can start on {date}.', { date: formatDate(new Date(nextAtMs), 'weekday-day-month') });
}

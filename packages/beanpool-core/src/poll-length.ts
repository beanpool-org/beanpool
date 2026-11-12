/**
 * How long a poll may run (Damo's ask, Marty's yes, 12 Nov 2026). Anyone who can start a poll chooses 3, 7 or 14 days. An owner
 * or an admin of the community may also choose 30 or 90 days, for a question that is meant to stay open (a survey, a yearly
 * choice). One list for the node (apps/server engine/posts.ts createPost, the only door a poll is made through), an owner's
 * assistant (agent/owner-posts.ts) and both apps' length pickers, so what a picker offers and what the node accepts never drift.
 *
 * The node decides. A picker only offers what the node would take from this person: it reads the role the way each app already
 * reads it for an owner's controls (GET /api/node-admin/me), and a role it has not heard offers the short lengths, which every
 * member may use. Nothing here blocks a form (onboarding-no-hard-gates).
 *
 * A poll keeps no column for how long it was made to run, and its length can never change, so a long poll is read off its own
 * times: when it began and when it ends (pollRunsLong).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The lengths anyone who can start a poll may choose. */
export const POLL_DAYS_MEMBERS = [3, 7, 14] as const;
/** The lengths only an owner or an admin may choose. */
export const POLL_DAYS_LONG = [30, 90] as const;
/** What a form starts on. */
export const POLL_DAYS_DEFAULT = 7;

export type PollDays = (typeof POLL_DAYS_MEMBERS)[number] | (typeof POLL_DAYS_LONG)[number];

/**
 * Whether the role a node names for the signed-in member (GET /api/node-admin/me: owner, admin, moderator or none; undefined or
 * null when it has not been heard) may choose the long lengths: an owner or an admin. A moderator is a member here.
 */
export function mayChooseLongPolls(role: unknown): boolean {
    return role === 'owner' || role === 'admin';
}

/** The lengths a picker offers, shortest first: the long ones only for an owner or an admin. */
export function pollDayChoices(ownerOrAdmin: boolean): readonly PollDays[] {
    return ownerOrAdmin ? [...POLL_DAYS_MEMBERS, ...POLL_DAYS_LONG] : POLL_DAYS_MEMBERS;
}

/** Whether `days` is one of the lengths this person may choose. Only a whole number from the list counts: "30" and 30.5 are not 30. */
export function pollDaysAllowed(days: unknown, ownerOrAdmin: boolean): days is PollDays {
    return typeof days === 'number' && (pollDayChoices(ownerOrAdmin) as readonly number[]).includes(days);
}

/** Whether `days` is one of the long lengths, the ones only an owner or an admin may choose. */
export function isLongPollDays(days: unknown): boolean {
    return typeof days === 'number' && (POLL_DAYS_LONG as readonly number[]).includes(days);
}

/**
 * A closing time is worked out from the clock a moment before the row is stamped, so a 30-day poll runs a few milliseconds off
 * 30 whole days. Anything within this is read as the day count it was made with; no short length is anywhere near it.
 */
const LENGTH_SLACK_MS = 60 * 60 * 1000;

/** Whether a poll was made to run 30 or 90 days, from when it began and when it ends. False when either time is missing or unreadable. */
export function pollRunsLong(createdAt: string | null | undefined, closesAt: string | null | undefined): boolean {
    if (!createdAt || !closesAt) return false;
    const began = Date.parse(createdAt);
    const ends = Date.parse(closesAt);
    if (!Number.isFinite(began) || !Number.isFinite(ends)) return false;
    return ends - began >= POLL_DAYS_LONG[0] * DAY_MS - LENGTH_SLACK_MS;
}

/**
 * The polls in the order Decide shows them. They keep their order by closing time (the soonest first), except that a long poll
 * the viewer has already voted in drops below every poll that is still waiting for their vote, or a 90-day poll answered in
 * week one would sit at the top of the card for months. Among the polls that move down, the order by closing time holds too.
 * A short poll already answered keeps its place: it closes soon enough that it clears itself. Returns a new list.
 */
export function decidePollOrder<T extends { createdAt?: string | null; pollClosesAt?: string | null }>(
    polls: readonly T[],
    voted: (poll: T) => boolean,
): T[] {
    const closes = (p: T) => { const at = p.pollClosesAt ? Date.parse(p.pollClosesAt) : NaN; return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY; };
    const settledLong = (p: T) => pollRunsLong(p.createdAt, p.pollClosesAt) && voted(p);
    return [...polls].sort((a, b) => Number(settledLong(a)) - Number(settledLong(b)) || closes(a) - closes(b));
}

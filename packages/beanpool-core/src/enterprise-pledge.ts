export const PROJECT_CLOSED_CODE = 'project_closed';

/** A project's deadline is a day: both apps store the day the member chose, not an instant. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The deadline badge's number (both apps' EnterpriseCard, the enterprise page, the phone's Yours row): whole days until
 * the deadline, a part day counted as a whole one. 0 is "Ends today" and below 0 "Expired". NaN for a deadline that
 * names no time, as the badges always worked it out.
 */
export function deadlineDaysRemaining(deadline: string, now: number = Date.now()): number {
    return Math.ceil((new Date(deadline).getTime() - now) / DAY_MS);
}

/**
 * Past its deadline once its end date is over: from the moment the deadline badge says "Expired", a full day after the
 * deadline's instant, so the badge and the pledge gate (both pledge routes, pledgeToProject, both apps) never disagree.
 * The web stores the chosen day as UTC midnight at its start and the phone at the time of day its picker opened, and the
 * node takes today's date (apps/server/src/routes/project-deadline.ts): a project that ends today takes pledges today.
 * No deadline (null, undefined, '') never passes, nor one that names no time (NaN is not below 0).
 */
export function isPastDeadline(deadline: string | null | undefined, now: number = Date.now()): boolean {
    if (!deadline) return false;
    return deadlineDaysRemaining(deadline, now) < 0;
}

/**
 * How many days after its end date a project that didn't reach its goal gives its backers their Beans back, unless the end
 * date moves before then (Marty, board, 27 Oct 2026: "Return them a week after the end date").
 */
export const PLEDGE_RETURN_DAYS = 7;

/**
 * When an unfunded project's pledges go back to their backers (ms): its deadline's instant + 7 days. By the day rule above
 * a deadline is a day starting at its instant, over (pledges stop) a day later; this is the start of the end date + 7, the
 * day both apps' project page names, and the moment the deadline badge's number reaches -7. The node returns them at its
 * first tick from then on (apps/server/src/engine/unfunded-pledges.ts). NaN for no deadline, or one that names no time.
 */
export function pledgeReturnAt(deadline: string | null | undefined): number {
    if (!deadline) return NaN;
    return new Date(deadline).getTime() + PLEDGE_RETURN_DAYS * DAY_MS;
}

/** Whether an unfunded project's pledges are due to go back: from pledgeReturnAt on, however late. Never without a deadline. */
export function isPledgeReturnDue(deadline: string | null | undefined, now: number = Date.now()): boolean {
    const at = pledgeReturnAt(deadline);
    return Number.isFinite(at) && now >= at;
}

export interface TakesPledgesInput {
    goalAmount?: number | null;
    currentAmount?: number | null;
    balance?: number | null;
    status?: string | null;
    lifecycle?: string | null;
    deadlineAt?: string | null;
}

/**
 * The pure rule for whether an enterprise or project card/detail takes pledges:
 * A goal not yet reached, an enterprise that is active, and a deadline that has not passed.
 */
export function takesPledges(item: TakesPledgesInput, now: number = Date.now()): boolean {
    const hasGoal = item.goalAmount != null && item.goalAmount > 0;
    if (!hasGoal) return false;
    const currentRaised = item.currentAmount != null ? item.currentAmount : Math.max(0, item.balance ?? 0);
    const goalAmount = item.goalAmount || 1;
    const isFunded = currentRaised >= goalAmount || item.status === 'funded' || item.status === 'completed';
    if (isFunded) return false;
    if (item.status && item.status !== 'active') return false;
    if (isPastDeadline(item.deadlineAt, now)) return false;
    return true;
}

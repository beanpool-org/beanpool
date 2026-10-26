import { formatDate, isPastDeadline, isPledgeReturnDue, keeperWords, pledgeReturnAt, t } from '@beanpool/core';

export {
    isPastDeadline,
    takesPledges,
    PROJECT_CLOSED_CODE,
    type TakesPledgesInput,
} from '@beanpool/core';

/**
 * Whether an enterprise is taking pledges, and the plain sentence shown in place of the pledge box when it isn't
 * (#1374 NB, 2026-10-02). The node takes a pledge only while the enterprise is active and before its deadline.
 *
 * Null: pledges are open (an active enterprise whose deadline has not passed).
 * A project says "project" (group decisions pick 8), each sentence written whole for each kind.
 */
export function pledgeClosedLine(
    status: string | null | undefined,
    lifecycle?: string | null,
    deadlineAt?: string | null,
    now: number = Date.now(),
): string | null {
    const project = keeperWords(lifecycle).kind === 'project';
    if (status === 'funded') return project ? t('This project has reached its goal, so it isn’t taking more pledges.') : t('This enterprise has reached its goal, so it isn’t taking more pledges.');
    if (status === 'winding_up') return project ? t('This project is winding up, so it isn’t taking pledges.') : t('This enterprise is winding up, so it isn’t taking pledges.');
    if (status && status !== 'active') return project ? t('This project has closed, so it isn’t taking pledges.') : t('This enterprise has closed, so it isn’t taking pledges.');
    if (isPastDeadline(deadlineAt, now)) {
        return t("This project's deadline has passed: it takes no more pledges.");
    }
    return null;
}

export interface PledgeReturnInput {
    goalAmount?: number | null;
    /** What the page shows as raised. */
    currentAmount?: number | null;
    status?: string | null;
    deadlineAt?: string | null;
    /** When the node gave the backers their Beans back for this end date (GET /api/treasury/:id), else null. */
    pledgesReturnedAt?: string | null;
}

/**
 * What a project's page says happens to its backers' Beans if its goal isn't reached (Marty, board, 27 Oct 2026): they go
 * back a week after its end date (core's pledgeReturnAt, the node's own rule), unless the end date moves before then; and
 * once the node has given them back, that they went back. The dates are days on the reader's own clock. Null for an
 * enterprise with no goal, a project with no end date or one that reached its goal, and one whose end date is over with
 * nothing pledged.
 */
export function pledgeReturnLine(p: PledgeReturnInput, now: number = Date.now()): string | null {
    const goal = Number(p.goalAmount ?? 0);
    if (!(goal > 0) || !p.deadlineAt) return null;
    const ends = new Date(p.deadlineAt);
    if (Number.isNaN(ends.getTime())) return null;
    const raised = Number(p.currentAmount ?? 0);
    if (raised >= goal || p.status === 'funded' || p.status === 'completed') return null;
    const date = formatDate(ends, 'day-month-year');
    const returned = p.pledgesReturnedAt ? new Date(p.pledgesReturnedAt) : null;
    if (returned && !Number.isNaN(returned.getTime())) {
        return t('The goal wasn’t reached by {date}, so everyone’s Beans went back on {returned}.', { date, returned: formatDate(returned, 'day-month-year') });
    }
    const returnDate = formatDate(new Date(pledgeReturnAt(p.deadlineAt)), 'day-month-year');
    if (!isPastDeadline(p.deadlineAt, now)) {
        return t('If the goal isn’t reached by {date}, everyone’s Beans go back on {returnDate}.', { date, returnDate });
    }
    if (!(raised > 0)) return null;
    if (!isPledgeReturnDue(p.deadlineAt, now)) {
        return t('The goal wasn’t reached by {date}. Everyone’s Beans go back on {returnDate}, unless the end date moves before then.', { date, returnDate });
    }
    return t('The goal wasn’t reached by {date}, so everyone’s Beans are going back.', { date });
}

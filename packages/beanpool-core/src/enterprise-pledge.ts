import { word, t, type WordKey } from './words.js';
import { keeperWords } from './group-words.js';

export const PROJECT_DEADLINE_PASSED_WORDS: WordKey = word("This project's deadline has passed: it takes no more pledges.");
export const PROJECT_CLOSED_CODE = 'project_closed';

/**
 * True when a project deadline names an instant that has already expired.
 * A project with no deadline (null, undefined, '') never expires.
 * Matches getDaysRemaining across the apps: a project ending today is not expired until today ends.
 */
export function isPastDeadline(deadline: string | null | undefined, now: number = Date.now()): boolean {
    if (!deadline) return false;
    const time = new Date(deadline).getTime();
    if (Number.isNaN(time)) return false;
    const diff = time - now;
    return Math.ceil(diff / (1000 * 60 * 60 * 24)) < 0;
}

/**
 * Whether an enterprise is taking pledges, and the plain sentence shown in place of the pledge box when it isn't
 * (#1374 NB, 2026-10-02). The node takes a pledge only while the enterprise is active and before its deadline.
 *
 * Null: pledges are open (an active enterprise whose deadline has not passed).
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
        return t(PROJECT_DEADLINE_PASSED_WORDS);
    }
    return null;
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
    return pledgeClosedLine(item.status, item.lifecycle, item.deadlineAt, now) === null;
}

export const PROJECT_CLOSED_CODE = 'project_closed';

/**
 * True when a project deadline names an instant that has already expired.
 * A project with no deadline (null, undefined, '') never expires.
 */
export function isPastDeadline(deadline: string | null | undefined, now: number = Date.now()): boolean {
    if (!deadline) return false;
    const time = new Date(deadline).getTime();
    if (Number.isNaN(time)) return false;
    return now >= time;
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

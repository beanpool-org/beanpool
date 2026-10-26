import { keeperWords, t, isPastDeadline } from '@beanpool/core';

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

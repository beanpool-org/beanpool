import { keeperWords, t } from '@beanpool/core';

/**
 * Whether an enterprise is taking pledges, and the plain sentence shown in place of the pledge box when it isn't
 * (#1374 NB, 2026-10-02). The node takes a pledge only while the enterprise's status is 'active' (server
 * routes/treasury.ts crowdfundPledgeHandler): a member who filled in the box on a funded enterprise was told "Pledge
 * Failed" with the server's refusal. The web app has the same rule (apps/pwa/src/lib/enterprise-pledge.ts).
 *
 * Null: pledges are open (an active enterprise, or one whose status the screen doesn't know, which the node still decides).
 * A project says "project" (group decisions pick 8), each sentence written whole for each kind.
 */
export function pledgeClosedLine(status: string | null | undefined, lifecycle?: string | null): string | null {
    if (!status || status === 'active') return null;
    const project = keeperWords(lifecycle).kind === 'project';
    if (status === 'funded') return project ? t('This project has reached its goal, so it isn’t taking more pledges.') : t('This enterprise has reached its goal, so it isn’t taking more pledges.');
    if (status === 'winding_up') return project ? t('This project is winding up, so it isn’t taking pledges.') : t('This enterprise is winding up, so it isn’t taking pledges.');
    return project ? t('This project has closed, so it isn’t taking pledges.') : t('This enterprise has closed, so it isn’t taking pledges.');
}

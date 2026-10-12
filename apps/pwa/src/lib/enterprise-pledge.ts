import { keeperWords } from '@beanpool/core';

/**
 * Whether an enterprise is taking pledges, and the plain sentence shown in place of the pledge box when it isn't
 * (#1374 NB, 2026-10-02). The node takes a pledge only while the enterprise's status is 'active' (server
 * routes/treasury.ts crowdfundPledgeHandler): a member who filled in the box on a funded enterprise was told "Pledge
 * Failed" with the server's refusal. The native app has the same rule (apps/native/utils/enterprise-pledge.ts).
 *
 * Null: pledges are open (an active enterprise, or one whose status the page doesn't know, which the node still decides).
 * A project says "project" (group decisions pick 8).
 */
export function pledgeClosedLine(status: string | null | undefined, lifecycle?: string | null): string | null {
    if (!status || status === 'active') return null;
    const { kind } = keeperWords(lifecycle);
    if (status === 'funded') return `This ${kind} has reached its goal, so it isn’t taking more pledges.`;
    if (status === 'winding_up') return `This ${kind} is winding up, so it isn’t taking pledges.`;
    return `This ${kind} has closed, so it isn’t taking pledges.`;
}

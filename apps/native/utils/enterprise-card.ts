import { isHundredths, t, tn } from '@beanpool/core';
import type { TreasurySummary } from './db';
import { pledgeClosedLine } from './enterprise-pledge';

/**
 * What an enterprise card on the Commons list says about the enterprise's state.
 *
 * Mirrors the PWA's ProjectsPage card so a paused or winding-up enterprise reads the same on both
 * clients: a state badge (Paused / Winding up / Closed), and a meta line
 * that names the state instead of a live-offer count nobody can buy from. Everything comes from the
 * /api/treasuries list row — no per-card detail fetch.
 */

export type EnterpriseStateBadge = 'paused' | 'winding_up' | 'closed' | null;
export type EnterpriseKindBadge = 'funded' | 'project' | 'ongoing';

export interface EnterpriseCardStatus {
    stateBadge: EnterpriseStateBadge;
    kindBadge: EnterpriseKindBadge;
    /**
     * False while a state badge shows, unless the project is funded. "WINDING UP" beside "ONGOING" read as a
     * contradiction, and at 320dp + 1.3x text the two badges wrap onto two lines. The avatar (🏛️ / 🌱) still
     * shows the type; FUNDED stays because "Closed · Funded" is news, not a contradiction.
     */
    showKindBadge: boolean;
    hasGoal: boolean;
    isFunded: boolean;
    /** The card says "Pledge Beans": a goal not yet reached, and an enterprise the node still takes pledges for. */
    takesPledges: boolean;
    /** What the card shows as raised, whole hundredths of a Bean. */
    currentRaised: number;
    /** Meta line under the name, e.g. "Paused for season · 2 keepers". */
    meta: string;
}

type CardInput = Pick<TreasurySummary, 'balance_c' | 'liveOffers' | 'goalAmount_c' | 'currentAmount_c' | 'lifecycle' | 'status' | 'paused' | 'keepers' | 'deadlineAt'>;

/** Whole hundredths of a Bean, every figure (the node's `*_c` fields): compared as they are, never scaled. */
export function enterpriseCardStatus(item: CardInput): EnterpriseCardStatus {
    const hasGoal = isHundredths(item.goalAmount_c) && item.goalAmount_c > 0;
    const raised = isHundredths(item.currentAmount_c) ? item.currentAmount_c : null;
    const currentRaised = raised !== null ? raised : Math.max(0, isHundredths(item.balance_c) ? item.balance_c : 0);
    const goalAmount = hasGoal ? item.goalAmount_c as number : 1;
    const isFunded = hasGoal && (currentRaised >= goalAmount || item.status === 'funded' || item.status === 'completed');

    let stateBadge: EnterpriseStateBadge = null;
    if (item.status === 'completed') stateBadge = 'closed';
    else if (item.status === 'winding_up') stateBadge = 'winding_up';
    else if (item.paused) stateBadge = 'paused';

    const kindBadge: EnterpriseKindBadge = isFunded
        ? 'funded'
        : hasGoal || item.lifecycle === 'bounded' ? 'project' : 'ongoing';

    // Two facts side by side, each whole in the member's language.
    const liveOffers = item.liveOffers ?? 0;
    const stateText = item.status === 'completed'
        ? t('Completed · Closed')
        : item.status === 'winding_up'
            ? t('Winding up')
            : item.paused
                ? t('Paused for season')
                : tn(liveOffers, '{n} live offer', '{n} live offers');
    const keeperCount = item.keepers?.length ?? 0;
    const keeperText = keeperCount > 0 ? tn(keeperCount, '{n} keeper', '{n} keepers') : null;

    const showKindBadge = stateBadge === null || kindBadge === 'funded';

    const takesPledges = hasGoal && !isFunded && pledgeClosedLine(item.status, item.lifecycle, item.deadlineAt) === null;

    return { stateBadge, kindBadge, showKindBadge, hasGoal, isFunded, takesPledges, currentRaised, meta: [stateText, keeperText].filter(Boolean).join(' · ') };
}

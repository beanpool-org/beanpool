import type { TreasurySummary } from './db';

/**
 * What an enterprise card on the Commons list says about the enterprise's state.
 *
 * Mirrors the PWA's ProjectsPage card so a paused or winding-up enterprise reads the same on both
 * clients: a state badge (Paused / Winding up / Closed) beside the lifecycle badge, and a meta line
 * that names the state instead of a live-offer count nobody can buy from. Everything comes from the
 * /api/treasuries list row — no per-card detail fetch.
 */

export type EnterpriseStateBadge = 'paused' | 'winding_up' | 'closed' | null;
export type EnterpriseKindBadge = 'funded' | 'project' | 'ongoing';

export interface EnterpriseCardStatus {
    stateBadge: EnterpriseStateBadge;
    kindBadge: EnterpriseKindBadge;
    hasGoal: boolean;
    isFunded: boolean;
    currentRaised: number;
    /** Meta line under the name, e.g. "Paused for season · 2 keepers". */
    meta: string;
}

type CardInput = Pick<TreasurySummary, 'balance' | 'liveOffers' | 'goalAmount' | 'currentAmount' | 'lifecycle' | 'status' | 'paused' | 'keepers'>;

export function enterpriseCardStatus(item: CardInput): EnterpriseCardStatus {
    const hasGoal = item.goalAmount != null && item.goalAmount > 0;
    const currentRaised = item.currentAmount != null ? item.currentAmount : Math.max(0, item.balance);
    const goalAmount = item.goalAmount || 1;
    const isFunded = hasGoal && (currentRaised >= goalAmount || item.status === 'funded' || item.status === 'completed');

    let stateBadge: EnterpriseStateBadge = null;
    if (item.status === 'completed') stateBadge = 'closed';
    else if (item.status === 'winding_up') stateBadge = 'winding_up';
    else if (item.paused) stateBadge = 'paused';

    const kindBadge: EnterpriseKindBadge = isFunded
        ? 'funded'
        : hasGoal || item.lifecycle === 'bounded' ? 'project' : 'ongoing';

    const liveOffers = item.liveOffers ?? 0;
    const stateText = item.status === 'completed'
        ? 'Completed · Closed'
        : item.status === 'winding_up'
            ? 'Winding up'
            : item.paused
                ? 'Paused for season'
                : `${liveOffers} live offer${liveOffers === 1 ? '' : 's'}`;
    const keeperCount = item.keepers?.length ?? 0;
    const keeperText = keeperCount > 0 ? ` · ${keeperCount} keeper${keeperCount === 1 ? '' : 's'}` : '';

    return { stateBadge, kindBadge, hasGoal, isFunded, currentRaised, meta: stateText + keeperText };
}

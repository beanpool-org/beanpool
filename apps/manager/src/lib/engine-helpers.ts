/**
 * Shared Engine Helpers — Pure constants and interfaces re-exported from @beanpool/engine for display and audit calculations
 */

import { PER_COUNTERPARTY_VOLUME_CAP } from '../../../../packages/beanpool-engine/src/index.js';

export function getEngineVolumeCap(): number {
    return PER_COUNTERPARTY_VOLUME_CAP;
}

export function computeSampleTrustSummary(
    voucherCount: number,
    completedDeals: number,
    disputeCount: number,
    accountAgeDays: number
) {
    const rawScore = (voucherCount * 25) + (completedDeals * 5) - (disputeCount * 50) + (accountAgeDays * 0.5);
    const score = Math.max(0, Math.min(100, Math.round(rawScore)));
    let trustLevel = 'Newcomer';
    if (score >= 80) trustLevel = 'Elder';
    else if (score >= 60) trustLevel = 'Steward';
    else if (score >= 30) trustLevel = 'Resident';

    return {
        score,
        trustLevel,
        perCounterpartyVolumeCap: PER_COUNTERPARTY_VOLUME_CAP,
    };
}

/**
 * A standing deal's fields on the phone's copy of a deal row (DESIGN-standing-deals-fable §2.1; slice S2): pure, so a screen
 * can read a row it holds (the listing page's pinned deal) without a round trip through utils/db.ts, which writes and reads
 * them (applyDelta, acceptMarketplacePost, getMarketplaceTransactions' local copy).
 */
import type { StandingPeriodUnit, StandingPhase } from '@beanpool/core';

/**
 * The standing deal's fields of a deal row as the node reads it (@beanpool/engine escrow.ts standingFields), kept as one JSON
 * column on the phone's copy (`standing`), or null on a one-off deal or an older period's row (which carry no phase).
 */
export function standingJsonOf(tx: any): string | null {
    if (!tx?.standingId || !tx.standingPhase) return null;
    return JSON.stringify({
        phase: tx.standingPhase, beans: tx.standingBeans ?? null, unit: tx.standingUnit ?? null, max: tx.standingMaxPeriods ?? null,
        nextDueAt: tx.standingNextDueAt ?? null, startsAt: tx.standingStartsAt ?? null, shortSince: tx.standingShortSince ?? null,
        stopped: !!tx.standingStopped,
    });
}

/** A local row's standing deal fields, in the node's read's names (standingJsonOf's inverse). */
export interface StandingRowFields {
    standingId?: string;
    periodNo?: number | null;
    standingPhase?: StandingPhase;
    standingBeans?: number | null;
    standingUnit?: StandingPeriodUnit | null;
    standingMaxPeriods?: number | null;
    standingNextDueAt?: string | null;
    standingStartsAt?: string | null;
    standingShortSince?: string | null;
    standingStopped?: boolean;
}

export function standingOfRow(r: { standing_id?: string | null; period_no?: number | null; standing?: string | null }): StandingRowFields {
    if (!r.standing_id) return {};
    const out: StandingRowFields = { standingId: r.standing_id, periodNo: r.period_no ?? null };
    try {
        const s = r.standing ? JSON.parse(r.standing) : null;
        if (s && typeof s === 'object' && typeof s.phase === 'string') {
            Object.assign(out, {
                standingPhase: s.phase, standingBeans: s.beans, standingUnit: s.unit, standingMaxPeriods: s.max,
                standingNextDueAt: s.nextDueAt, standingStartsAt: s.startsAt, standingShortSince: s.shortSince, standingStopped: !!s.stopped,
            });
        }
    } catch {}
    return out;
}

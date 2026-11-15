/**
 * A standing deal's fields on the phone's copy of a deal row (DESIGN-standing-deals-fable §2.1; slice S2): pure, so a screen
 * can read a row it holds (the listing page's pinned deal) without a round trip through utils/db.ts, which writes and reads
 * them (applyDelta, acceptMarketplacePost, getMarketplaceTransactions' local copy).
 */
import { isHundredths, type StandingAsk, type StandingPeriodUnit, type StandingPhase } from '@beanpool/core';

/** The payer's open ask as the node's read carries it (standingAsk), or null for anything else. */
function askOf(a: any): StandingAsk | null {
    return a && typeof a === 'object' && typeof a.id === 'string' && isHundredths(a.beans_c) && Number.isInteger(a.periodNo)
        ? { id: a.id, beans_c: a.beans_c, periodNo: a.periodNo, askedAt: typeof a.askedAt === 'string' ? a.askedAt : '' } : null;
}

/**
 * The standing deal's fields of a deal row as the node reads it (@beanpool/engine escrow.ts standingFields), kept as one JSON
 * column on the phone's copy (`standing`), or null on a one-off deal or an older period's row (which carry no phase).
 */
export function standingJsonOf(tx: any): string | null {
    if (!tx?.standingId || !tx.standingPhase) return null;
    return JSON.stringify({
        // Per period, whole hundredths of a Bean (the node's standingBeans_c); anything else, no figure.
        phase: tx.standingPhase, beans_c: isHundredths(tx.standingBeans_c) ? tx.standingBeans_c : null, unit: tx.standingUnit ?? null, max: tx.standingMaxPeriods ?? null,
        nextDueAt: tx.standingNextDueAt ?? null, startsAt: tx.standingStartsAt ?? null, shortSince: tx.standingShortSince ?? null,
        stopped: !!tx.standingStopped,
        endedReason: tx.standingEndedReason ?? null, stoppedBy: tx.standingStoppedBy ?? null, endedAt: tx.standingEndedAt ?? null,
        // A short week (DESIGN-getting-paid-fable §5: "the phone keeps them in the `standing` JSON it already stores"): what the
        // period due costs when lowered, the payer's open ask, and how many asks are left. A node with no lowering sends no
        // asksLeft, so the phone shows no lowering for it (core standingLowerable).
        dueBeans_c: isHundredths(tx.standingDueBeans_c) ? tx.standingDueBeans_c : null,
        ask: askOf(tx.standingAsk),
        asksLeft: Number.isInteger(tx.standingAsksLeft) && tx.standingAsksLeft >= 0 ? tx.standingAsksLeft : null,
    });
}

/** A local row's standing deal fields, in the node's read's names (standingJsonOf's inverse). */
export interface StandingRowFields {
    standingId?: string;
    periodNo?: number | null;
    standingPhase?: StandingPhase;
    /** Per period, whole hundredths of a Bean. */
    standingBeans_c?: number | null;
    standingUnit?: StandingPeriodUnit | null;
    standingMaxPeriods?: number | null;
    standingNextDueAt?: string | null;
    standingStartsAt?: string | null;
    standingShortSince?: string | null;
    standingStopped?: boolean;
    standingEndedReason?: string | null;
    standingStoppedBy?: string | null;
    standingEndedAt?: string | null;
    /** A short week: the period due's lowered amount (whole hundredths), the payer's open ask, how many asks are left. */
    standingDueBeans_c?: number | null;
    standingAsk?: StandingAsk | null;
    standingAsksLeft?: number | null;
}

export function standingOfRow(r: { standing_id?: string | null; period_no?: number | null; standing?: string | null }): StandingRowFields {
    if (!r.standing_id) return {};
    const out: StandingRowFields = { standingId: r.standing_id, periodNo: r.period_no ?? null };
    try {
        const s = r.standing ? JSON.parse(r.standing) : null;
        if (s && typeof s === 'object' && typeof s.phase === 'string') {
            Object.assign(out, {
                standingPhase: s.phase, standingBeans_c: isHundredths(s.beans_c) ? s.beans_c : null, standingUnit: s.unit, standingMaxPeriods: s.max,
                standingNextDueAt: s.nextDueAt, standingStartsAt: s.startsAt, standingShortSince: s.shortSince, standingStopped: !!s.stopped,
                standingEndedReason: s.endedReason ?? null, standingStoppedBy: s.stoppedBy ?? null, standingEndedAt: s.endedAt ?? null,
                standingDueBeans_c: isHundredths(s.dueBeans_c) ? s.dueBeans_c : null, standingAsk: askOf(s.ask),
                standingAsksLeft: Number.isInteger(s.asksLeft) && s.asksLeft >= 0 ? s.asksLeft : null,
            });
        }
    } catch {}
    return out;
}

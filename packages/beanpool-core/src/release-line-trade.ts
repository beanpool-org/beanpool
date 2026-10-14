/**
 * Which finished trade an older ESCROW_RELEASED chat line is about: one written before #1604 (2026-10-04) carries no
 * `transactionId`, only its post and its two people. Among the completed trades on that post between those two, it is
 * the one that finished nearest the line's own time: the node writes the line in the same call that completes the trade,
 * so the two are milliseconds apart. One pair can buy a repeatable offer twice, so "the first one on the post" answers
 * for the other deal (review #1980 B1: "✓ Rating Submitted" on a trade nobody rated).
 *
 * The web (apps/pwa lib/trade-review) and the phone (app/chat/[id]) both read an old line through this, so they agree.
 * Without a readable line time, the first candidate, as before. A candidate whose own time can't be read is taken only
 * when nothing better is found.
 */
export function nearestFinishedTrade<T>(
    candidates: readonly T[],
    lineAt: string | null | undefined,
    finishedAtOf: (trade: T) => string | null | undefined,
): T | undefined {
    const at = lineAt ? Date.parse(lineAt) : NaN;
    if (Number.isNaN(at)) return candidates[0];
    let best: T | undefined;
    let bestGap = Infinity;
    for (const trade of candidates) {
        const finished = finishedAtOf(trade);
        const gap = finished ? Math.abs(Date.parse(finished) - at) : NaN;
        if (best === undefined || gap < bestGap) {
            best = trade;
            if (!Number.isNaN(gap)) bestGap = gap;
        }
    }
    return best;
}

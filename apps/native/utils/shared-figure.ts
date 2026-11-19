/**
 * A count the node shared, or null where it left it out. With Share Member Count off (#3292), the node gives its member,
 * listing and trade counts only to a reader it answers as a member: a suspended member or a visitor's row gets the answer
 * without them. Settings → Diagnostics compares a count only when it is a number here, and never states 0 for one it was
 * not given. The web app keeps the same rule (apps/pwa/src/lib/shared-figure.ts).
 */
export function sharedFigure(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The node's counts as Diagnostics compares them, each null where the node left it out. */
export interface RemoteStats { members: number | null; posts: number | null; transactions: number | null }

/**
 * The node's counts from GET /api/community/info, with the member's own count of ledger lines in place of the node's
 * trade count where it was read (utils/diagnostics-own-count.ts).
 */
export function remoteStatsFrom(info: unknown, ownTransactionCount: number | null): RemoteStats {
    const body = (info && typeof info === 'object' ? info : {}) as Record<string, unknown>;
    return {
        members: sharedFigure(body.memberCount),
        posts: sharedFigure(body.postCount),
        transactions: ownTransactionCount ?? sharedFigure(body.transactionCount),
    };
}

/** Whether this phone's copy matches the node, on the counts the node gave: a count it left out is not compared. */
export function inSyncWith(local: { members: number; posts: number } | null, remote: RemoteStats | null): boolean {
    if (!remote) return true;
    if (!local) return false;
    return (remote.members === null || local.members === remote.members)
        && (remote.posts === null || local.posts === remote.posts);
}

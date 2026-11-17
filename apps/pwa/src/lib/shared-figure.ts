/**
 * A count the node shared, or null where it left it out. With Share Member Count or Share Node Health off (#3292), the
 * node gives its member, listing and trade counts only to a reader it answers as a member: someone signed out, a visitor's
 * row or a suspended member gets the answer without them. A screen shows a count only when it is a number here, and never
 * states 0 for one it was not given. The phone keeps the same rule (apps/native/utils/shared-figure.ts).
 */
export function sharedFigure(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The figures the header's status panel reads out of GET /api/community/health: each null where the node left it out. */
export function healthFigures(health: {
    memberCount?: unknown; postCount?: unknown;
    tree?: { totalMembers?: unknown } | null; activity?: { totalPosts?: unknown } | null;
} | null | undefined): { members: number | null; posts: number | null } {
    return {
        members: sharedFigure(health?.memberCount) ?? sharedFigure(health?.tree?.totalMembers),
        posts: sharedFigure(health?.postCount) ?? sharedFigure(health?.activity?.totalPosts),
    };
}

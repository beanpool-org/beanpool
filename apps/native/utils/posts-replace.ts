/**
 * The listings this phone holds that a whole posts pull (`sync=true`, no cursor) shows the node no longer has: after a
 * take-over, what the old main server wrote after its standby's last copy (services/pillar-sync.ts). No tombstone
 * will ever come for them, so utils/db.ts `applyDelta` deletes them when it is told to replace (`postsReplace`).
 *
 * The node sends its most recently changed listings first, capped at a page (200 today), so its answer speaks for
 * every listing changed after the oldest one it carries, and for all of them when it carries none. A cached row
 * changed after that and missing from the answer goes. An older row may just be past the page, so it stays, as it
 * would on a fresh install that never had it. A row the phone wrote itself has no `updated_at` until a sync brings
 * one, so its `created_at` stands in (`at`).
 *
 * It speaks only for the scopes it could carry. The pull is signed on its way out, but only best-effort
 * (node-request-signing.ts), and the node answers a reader it cannot name with the public listings alone (engine
 * posts.ts), so a group's or a person's listing is judged only when the answer carries one: only a signed reader is
 * sent those, and the one key this phone signs with is its own. Otherwise the public listings alone are judged.
 *
 * Pure, with no imports, so the server's take-over suite (apps/server test-takeover-keeps-listing-times.ts) runs this
 * same rule on a promoted server's real answer.
 */

/** A listing this phone holds: its id, the time it holds it at (`updated_at`, else `created_at`), its scope. */
export interface HeldListing {
    id: string;
    at: string | null;
    scope: string | null;
}

/** The ids of the `held` listings that the whole pull `posts` shows the node no longer has. */
export function postsTheNodeNoLongerHas(posts: any[], held: HeldListing[]): string[] {
    const sent = new Set<string>();
    let oldest: string | null = null;
    let membersView = false;
    for (const p of posts) {
        if (p?.id) sent.add(String(p.id));
        // Only a time that reads as one: an empty or malformed one (`''`, `'0'`) would sort before every row held.
        const at = p?.updatedAt || p?.updated_at || p?.createdAt || p?.created_at;
        const isTime = typeof at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(at) && Number.isFinite(Date.parse(at));
        if (isTime && (oldest === null || at < oldest)) oldest = at;
        // As writeSyncedPost reads the scope.
        if ((p?.audienceScope || p?.audience_scope || 'public') !== 'public') membersView = true;
    }
    // An answer with listings and no times speaks for nothing it left out.
    if (posts.length > 0 && oldest === null) return [];
    return held
        .filter(r => membersView || r.scope === null || r.scope === 'public')
        .filter(r => !sent.has(r.id) && (oldest === null || (r.at !== null && r.at > oldest)))
        .map(r => r.id);
}

/**
 * Where a Community Pulse row goes when it is opened. One rule for the web's Live Pulse chips, the web's
 * full list and the phone's list, so the three can never disagree. Pure and universal.
 *
 * Every event type is mapped; one with nothing sensible to open returns null and stays plain text
 * rather than pretending to be a control. Nothing here decides visibility: a profile and a listing are
 * both opened through each app's own handlers, so the node applies the rules it applies to every card.
 */

export type ActivityTarget =
    | { kind: 'post'; postId: string }
    | { kind: 'profile'; pubkey: string }
    | null;

/** The few fields of a feed item the rule reads; the web's and the phone's item types both fit it. */
export interface ActivityTargetItem {
    eventType: string;
    actorPubkey?: string;
    targetPubkey?: string;
    metadata?: Record<string, any>;
}

export function activityTarget(item: ActivityTargetItem): ActivityTarget {
    const raw = item.metadata?.postId;
    const postId = raw === undefined || raw === null || raw === '' ? '' : String(raw);

    switch (item.eventType) {
        case 'member_joined':
            return item.actorPubkey ? { kind: 'profile', pubkey: item.actorPubkey } : null;
        case 'post_created':
            // Only public posts are recorded to this feed (server engine/posts.ts), so the listing a
            // row names is one every member may open.
            return postId ? { kind: 'post', postId } : null;
        case 'trade_completed':
        case 'rating_given':
            // The related listing when the item carries one, otherwise the other member's profile.
            if (postId) return { kind: 'post', postId };
            if (item.targetPubkey) return { kind: 'profile', pubkey: item.targetPubkey };
            return item.actorPubkey ? { kind: 'profile', pubkey: item.actorPubkey } : null;
        case 'dispute_resolved':
        default:
            // The actor of a dispute is whoever ruled; the row stays impersonal and opens nothing.
            return null;
    }
}

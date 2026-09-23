/**
 * Creating an event from a request body — ONE definition, shared by the two routes that can do it.
 *
 * There are two, because an event's host can be a member or an enterprise, and those reach the node by
 * different doors:
 *   - POST /api/marketplace/posts      — a member hosting as themselves, or a convenor hosting for a group.
 *     The signer IS the author.
 *   - POST /api/treasury/:treasury/event — a keeper hosting as the enterprise. The enterprise rides the URL
 *     PATH, as it does for the enterprise's Offer and Need, because the signature middleware pins every body
 *     field ending in `pubkey`/`publickey` to the signer: an enterprise named in the body is a spoof by
 *     definition, and that rule has no exception (see https-server.ts).
 *
 * Both doors land here so "what an event is" cannot drift between them. The validation itself — times, the
 * pin, the place name, the going-note, photos, the upcoming cap, the group membership check — lives in the
 * engine's createPost and is NOT repeated here; this only maps a request body onto that one call.
 *
 * The engine forces an event's trade fields (category 'community', 0 Beans, fixed, not repeatable, no cash,
 * reach local), so the body's versions of those are deliberately ignored rather than passed and overridden.
 */

import { createPost } from '../state-engine.js';

/**
 * @param body      the parsed request body
 * @param author    the event's host: the signer, or the enterprise from the URL path
 * @param createdBy the member who really did it, when that is not the author (a keeper acting for an
 *                  enterprise). Recorded as `created_by`, exactly as the enterprise's Offer and Need are.
 */
export function createEventFromBody(body: any, author: string, createdBy?: string) {
    const b = body || {};
    return createPost(
        'event', 'community', b.title, b.description || '',
        0, 'fixed', author,
        b.lat != null ? Number(b.lat) : undefined,
        b.lng != null ? Number(b.lng) : undefined,
        b.photos,
        false,
        b.id,
        false,
        {
            // Passed through RAW, like the marketplace route's other fields: the engine is the single place
            // that decides what each of these means, and what an unrecognised value falls back to.
            reach: b.reach, reachPeers: b.reachPeers,
            audienceScope: b.audienceScope, targetGroupId: b.targetGroupId,
            eventStartAt: b.eventStartAt, eventEndAt: b.eventEndAt,
            eventPlaceName: b.eventPlaceName, eventPrivateNote: b.eventPrivateNote,
            createdBy,
        }
    );
}

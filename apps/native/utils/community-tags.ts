/**
 * The tags members of this community typed that the Tags field offers (GET /api/free-tags, DESIGN-tags-free-entry-fable.md
 * §3, slice F3), held to the rule by core's communityTagsOf, as the web's lib/api.ts getCommunityTags reads them. None when
 * they can't be had (offline, a node older than the route, a refusal): never an error, and the field works as before.
 */
import { communityTagsOf, type CommunityTag } from '@beanpool/core';

export async function loadCommunityTags(): Promise<CommunityTag[]> {
    try {
        // Loaded when the sheet first asks, not with the picker: the node client is the app's heaviest module.
        const { signedGet } = await import('./db');
        const res = await signedGet('/api/free-tags');
        return res.ok ? communityTagsOf(await res.json()) : [];
    } catch {
        return [];
    }
}

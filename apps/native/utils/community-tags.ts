/**
 * The tags members of this community typed that the Tags field offers (GET /api/free-tags, DESIGN-tags-free-entry-fable.md
 * §3, slice F3), held to the rule by core's communityTagsOf, as the web's lib/api.ts getCommunityTags reads them. None when
 * they can't be had (offline, a node older than the route, a refusal): never an error, and the field works as before.
 */
import { communityTagsOf, libraryTagOf, type CommunityTag } from '@beanpool/core';

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

/**
 * The library tag a typed word is the label of in any of the 25 languages, as the node knows them (GET /api/free-tags?q=,
 * slice F5), read by core's libraryTagOf, as the web's getLibraryTagFor. Null when it names none, or when it can't be had
 * (offline, a node older than F5): the field then adds the word as the member's own, as before.
 */
export async function loadLibraryTagFor(text: string): Promise<string | null> {
    try {
        const { signedGet } = await import('./db');
        const res = await signedGet(`/api/free-tags?q=${encodeURIComponent(text)}`);
        return res.ok ? libraryTagOf(await res.json()) : null;
    } catch {
        return null;
    }
}

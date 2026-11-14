/**
 * The tags members of this community typed that the Tags field offers (GET /api/free-tags, DESIGN-tags-free-entry-fable.md
 * §3, slice F3), held to the rule by core's communityTagsOf, as the web's lib/api.ts getCommunityTags reads them. None when
 * they can't be had (offline, a node older than the route, a refusal): never an error, and the field works as before.
 */
import { communityTagsOf, libraryTagOf, type CommunityTag, type LibraryLabel } from '@beanpool/core';

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
 * The library tag a typed word is exactly the label of in one of the 25 languages, and that language, as the node knows
 * them (GET /api/free-tags?q=, slice F5), read by core's libraryTagOf, as the web's getLibraryTagFor. Null when the node
 * names none (an F3 node answers its tag list, which names none). A failed ask REJECTS (offline, a refusal, a node without
 * the route): the picker keeps only an answer, so a word asked during a network blip is asked again the next time the
 * field rests on it, and meanwhile the field adds the word as the member's own, as before.
 */
export async function loadLibraryTagFor(text: string): Promise<LibraryLabel | null> {
    const { signedGet } = await import('./db');
    const res = await signedGet(`/api/free-tags?q=${encodeURIComponent(text)}`);
    if (!res.ok) throw new Error(`free-tags ask: ${res.status}`);
    return libraryTagOf(await res.json());
}

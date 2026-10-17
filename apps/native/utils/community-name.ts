/**
 * The one name the app shows for a community, in the BeanPool sheet's heading and in its list.
 *
 * The node's own name comes first. The saved alias is a copy of that name (the community list writes the
 * node's name into it whenever the node answers, and every join path saves it from the node), so it is only
 * the fallback for a node that hasn't answered yet, or a manual add the member typed a label for. The host
 * comes last, so something readable always shows.
 */

/** What a node calls itself when it has no directory entry. A placeholder, not a name. */
export const NODE_NAME_PLACEHOLDER = 'Local Discovery';

/** A usable name, or null for an empty value or the placeholder. */
export function realName(name: unknown): string | null {
    if (typeof name !== 'string') return null;
    const n = name.trim();
    return n && n !== NODE_NAME_PLACEHOLDER ? n : null;
}

function hostOf(url: string): string {
    try { return new URL(url).host || url; } catch { return url.replace(/^https?:\/\//, '').replace(/\/.*$/, ''); }
}

export function communityName(c: { url?: string | null; nodeName?: unknown; alias?: string | null }): string {
    return realName(c.nodeName) ?? realName(c.alias) ?? (c.url ? hostOf(c.url) : 'BeanPool');
}

const NAME_TIMEOUT_MS = 8_000;

/**
 * The community's own name, as it answers it (`GET /api/community/health`, public and unsigned, as the BeanPool sheet asks
 * it of every saved community), or null when it doesn't answer or names none: the door screen and the not-recognised
 * screen name an open-door community by it (app/join-open-door.tsx). Never a name a link carried.
 */
export async function askCommunityName(url: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NAME_TIMEOUT_MS);
    try {
        const res = await fetchImpl(`${url}/api/community/health`, { method: 'GET', signal: controller.signal });
        if (!res.ok) return null;
        const health = await res.json().catch(() => null) as { nodeName?: unknown; name?: unknown } | null;
        return realName(health?.nodeName) ?? realName(health?.name);
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

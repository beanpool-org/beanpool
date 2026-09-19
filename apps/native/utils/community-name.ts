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

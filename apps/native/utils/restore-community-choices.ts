/**
 * The 12-words restore's community choices (DESIGN-global-entry-fable.md §A row 8, decision 5): **Global community**, each
 * community saved on this phone, and **another address**, as taps above the address field (components/
 * RestoreCommunityChips.tsx, app/welcome.tsx's `recover`). Someone who joined the global community in a web browser and
 * then installs the app taps Global community and types their words; nobody types global.beanpool.org.
 *
 * Only the field is filled: the restore itself, and its check of the address, are the screen's as before. A tap sends
 * nothing. No lock-in: the global chip is one choice among the phone's own communities, and any address can still be
 * typed.
 */
import { GLOBAL_NODE_URL } from './global-node-url';
import { copyCommunityUrl, type CopyCommunity } from '@beanpool/core';
import { isPlainNodeAddress, normalizeNodeUrl } from './node-url';
import type { SavedNode } from './nodes';

/** One chip: the global community, or a community saved on this phone, with the address it puts in the field. */
export type RestoreChoice =
    | { kind: 'global'; url: string; fills: string }
    | { kind: 'saved'; url: string; fills: string; name: string };

/**
 * What a community's address looks like in the field: its bare host when the field reads that back as the same address
 * (`global.beanpool.org`, as the sign-in restore shows it: with the scheme, a 320 dp field showed only
 * "://global.beanpool.org"), else the address whole (a community on a private network reached over plain http, or with a
 * path).
 */
export function fieldTextFor(url: string): string {
    const bare = url.replace(/^https:\/\//i, '');
    return bare !== url && normalizeNodeUrl(bare) === url ? bare : url;
}

/** The address a saved community or a typed field stands for, so two spellings of one address match. */
function sameAddress(a: string): string {
    return normalizeNodeUrl(a.trim()).replace(/\/+$/, '').toLowerCase();
}

/**
 * The chips, in order: the global community first, then each community saved on this phone by its name (or its host),
 * once each. A saved global community is the global chip, not a second one.
 */
export function restoreCommunityChoices(saved: readonly SavedNode[], globalUrl: string = GLOBAL_NODE_URL): RestoreChoice[] {
    const choices: RestoreChoice[] = [{ kind: 'global', url: globalUrl, fills: fieldTextFor(globalUrl) }];
    const seen = new Set([sameAddress(globalUrl)]);
    for (const node of saved) {
        if (!node || typeof node.url !== 'string' || !node.url.trim()) continue;
        const key = sameAddress(node.url);
        if (seen.has(key)) continue;
        seen.add(key);
        let host = node.url;
        try { host = new URL(node.url).host; } catch { /* not a URL: shown as saved */ }
        choices.push({ kind: 'saved', url: node.url, fills: fieldTextFor(node.url), name: node.alias?.trim() || host });
    }
    return choices;
}

/**
 * The phone's saved communities, then each community a restored copy listed that the phone hasn't saved (vault rethink
 * VR5, utils/copy-communities.ts), by the name the copy gives it: what a restore from such a copy offers to open the
 * account in. A copy without a list leaves the saved list exactly as it is. Nothing is saved here.
 */
export function withCopyCommunities(
    saved: readonly SavedNode[], fromCopy: readonly CopyCommunity[] | null | undefined,
): SavedNode[] {
    const out = [...saved];
    const seen = new Set(saved.filter((n) => n && typeof n.url === 'string').map((n) => sameAddress(n.url)));
    for (const c of fromCopy ?? []) {
        // A community's address and nothing more (core copyCommunityUrl: no path, no user part), as the phone saves one.
        const url = copyCommunityUrl(c?.url);
        if (!url || !isPlainNodeAddress(url)) continue;
        const key = sameAddress(url);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ url, ...(c.name?.trim() ? { alias: c.name.trim() } : {}) });
    }
    return out;
}

/**
 * Which chip the field shows chosen: the one whose address it holds, `another` for any other address typed, or null for
 * an empty field (nothing chosen yet).
 */
export function chosenRestoreChoice(typed: string, choices: readonly RestoreChoice[]): RestoreChoice | 'another' | null {
    if (!typed.trim()) return null;
    const key = sameAddress(typed);
    return choices.find((c) => sameAddress(c.url) === key) ?? 'another';
}

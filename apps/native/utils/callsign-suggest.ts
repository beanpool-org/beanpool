/**
 * Per-node callsign availability + friendly suggestions.
 *
 * Callsigns are unique per community node (case-insensitive). This module talks to
 * the node's `/api/members/callsign-available` endpoint to power the profile
 * wizard's live "✓ available / ✗ taken" hint, and to generate fun alternatives when
 * a name is taken — appending a nature word ("Sarah" → "Sarah Fox") rather than a
 * bare number, and only ever offering variants that are actually free on this node.
 *
 * The server is the authority: it enforces uniqueness on save and rejects a taken
 * rename with 409. These checks are UX only — a slow/offline check returns 'unknown'
 * so the user is never blocked; the server has the final say at publish time.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export type CallsignStatus = 'available' | 'taken' | 'too_short' | 'unknown';

// Friendly, culturally-neutral suffix words (nature / birds / plants). Kept short so
// "<name> <word>" stays well under the 32-char callsign cap. Mixed AU + generic flora
// and fauna to suit the target communities without leaning on any one culture.
const FUN_WORDS = [
    'Fox', 'Wren', 'Maple', 'River', 'Willow', 'Otter', 'Clover', 'Finch', 'Reed',
    'Sage', 'Robin', 'Heron', 'Aspen', 'Fern', 'Lark', 'Cedar', 'Moss', 'Kite',
    'Bay', 'Wattle', 'Rosella', 'Pepper', 'Juniper', 'Hazel', 'Bramble', 'Coral',
    'Pippin', 'Sparrow', 'Banjo', 'Poppy', 'Reef', 'Dingo', 'Galah', 'Jarrah',
];

/**
 * Ask the active node whether `callsign` is free. `excludePublicKey` lets a rename
 * ignore the caller's own current name (so re-confirming your own name reads as
 * available). Returns 'unknown' when the node can't be reached — never blocks.
 *
 * `signal` drops the request (and reads as 'unknown'): the global community's door stops a check
 * the member has walked away from, or that ran out of time (global-join.ts `checkNameAtDoor`).
 */
export async function checkCallsignAvailable(
    callsign: string,
    excludePublicKey?: string,
    anchorUrlOverride?: string,
    options: { signal?: AbortSignal } = {},
): Promise<CallsignStatus> {
    const c = callsign.trim();
    if (c.length < 2) return 'too_short';
    try {
        // First-join checks the target node before its URL is stored as the active
        // anchor, so callers can pass it explicitly; otherwise use the active node.
        const anchorUrl = anchorUrlOverride || await AsyncStorage.getItem('beanpool_anchor_url');
        if (!anchorUrl) return 'unknown';
        const qs = excludePublicKey ? `?exclude=${encodeURIComponent(excludePublicKey)}` : '';
        const res = await fetch(`${anchorUrl}/api/members/callsign-available/${encodeURIComponent(c)}${qs}`, { signal: options.signal });
        if (!res.ok) return 'unknown';
        const data = await res.json();
        if (data?.tooShort) return 'too_short';
        return data?.available ? 'available' : 'taken';
    } catch {
        return 'unknown';
    }
}

/**
 * "<base> <word>" within `maxLength`. When it doesn't fit, the base gives way and the word stays whole:
 * a cut word ("Sarah Jane Smith Jun") is a name nobody would choose. The base is cut between its words
 * where it has a space to cut at ("Sarah Jane Juniper", not "Sarah Jane S Juniper").
 */
export function suggestionFor(base: string, word: string, maxLength = 32): string {
    const full = `${base} ${word}`;
    if (full.length <= maxLength) return full;
    let head = base.slice(0, Math.max(0, maxLength - word.length - 1));
    if (base[head.length] !== ' ' && head.includes(' ')) head = head.slice(0, head.lastIndexOf(' '));
    head = head.trim();
    return head ? `${head} ${word}` : word.slice(0, maxLength);
}

/**
 * Build up to `count` available "<base> <word>" suggestions, checked against the
 * node in parallel. Returns [] if the base is empty or nothing free was found in
 * the sampled words (the editable field is the fallback either way).
 *
 * `maxLength` is the longest name the caller will send: the global community's join keeps 20
 * characters, so a longer suggestion would be cut after it was checked, into a name the member
 * never saw.
 *
 * `signal` stops it between chunks and drops the checks in flight, as for `checkCallsignAvailable`.
 */
export async function suggestCallsigns(
    base: string,
    excludePublicKey?: string,
    count = 3,
    anchorUrlOverride?: string,
    maxLength = 32,
    options: { signal?: AbortSignal } = {},
): Promise<string[]> {
    const clean = base.trim().replace(/\s+/g, ' ');
    if (clean.length < 1) return [];
    const candidates = [...FUN_WORDS]
        .sort(() => Math.random() - 0.5)
        .map((w) => suggestionFor(clean, w, maxLength));
    // Check in small chunks rather than one wide burst, and stop as soon as we have
    // enough free names — a single 8-wide Promise.all can trip the node's per-IP
    // rate limiter (429), especially alongside the live typing check.
    const available: string[] = [];
    for (let i = 0; i < candidates.length && available.length < count && !options.signal?.aborted; i += 3) {
        const chunk = candidates.slice(i, i + 3);
        const results = await Promise.all(
            chunk.map(async (cand) => ({
                cand,
                ok: (await checkCallsignAvailable(cand, excludePublicKey, anchorUrlOverride, options)) === 'available',
            })),
        );
        for (const r of results) if (r.ok) available.push(r.cand);
    }
    return available.slice(0, count);
}

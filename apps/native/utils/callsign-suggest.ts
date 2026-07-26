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
 */
export async function checkCallsignAvailable(
    callsign: string,
    excludePublicKey?: string,
    anchorUrlOverride?: string,
): Promise<CallsignStatus> {
    const c = callsign.trim();
    if (c.length < 2) return 'too_short';
    try {
        // First-join checks the target node before its URL is stored as the active
        // anchor, so callers can pass it explicitly; otherwise use the active node.
        const anchorUrl = anchorUrlOverride || await AsyncStorage.getItem('beanpool_anchor_url');
        if (!anchorUrl) return 'unknown';
        const qs = excludePublicKey ? `?exclude=${encodeURIComponent(excludePublicKey)}` : '';
        const res = await fetch(`${anchorUrl}/api/members/callsign-available/${encodeURIComponent(c)}${qs}`);
        if (!res.ok) return 'unknown';
        const data = await res.json();
        if (data?.tooShort) return 'too_short';
        return data?.available ? 'available' : 'taken';
    } catch {
        return 'unknown';
    }
}

/**
 * Build up to `count` available "<base> <word>" suggestions, checked against the
 * node in parallel. Returns [] if the base is empty or nothing free was found in
 * the sampled words (the editable field is the fallback either way).
 */
export async function suggestCallsigns(
    base: string,
    excludePublicKey?: string,
    count = 3,
    anchorUrlOverride?: string,
): Promise<string[]> {
    const clean = base.trim().replace(/\s+/g, ' ');
    if (clean.length < 1) return [];
    const candidates = [...FUN_WORDS]
        .sort(() => Math.random() - 0.5)
        .map((w) => `${clean} ${w}`.slice(0, 32));
    // Check in small chunks rather than one wide burst, and stop as soon as we have
    // enough free names — a single 8-wide Promise.all can trip the node's per-IP
    // rate limiter (429), especially alongside the live typing check.
    const available: string[] = [];
    for (let i = 0; i < candidates.length && available.length < count; i += 3) {
        const chunk = candidates.slice(i, i + 3);
        const results = await Promise.all(
            chunk.map(async (cand) => ({
                cand,
                ok: (await checkCallsignAvailable(cand, excludePublicKey, anchorUrlOverride)) === 'available',
            })),
        );
        for (const r of results) if (r.ok) available.push(r.cand);
    }
    return available.slice(0, count);
}

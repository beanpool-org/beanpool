/**
 * Update-banner logic, kept out of GlobalHeader so it can be tested without a renderer.
 *
 * The version comparison this replaces was `v.split('.').map(Number)` with a
 * `|| 0` fallback, which meant a single non-numeric character silently turned a
 * store version into 0.x.x. The App Store reports "V1.2.31" — capital V — so
 * every iOS install has compared itself against version 0 since the feature was
 * written, always looked newer, and could never show the banner.
 *
 * The store lookup itself now happens on the node (see apps/server/src/app-store-versions.ts)
 * and arrives in the /api/community/health payload the app already fetches. Nothing
 * here talks to a store.
 */

export interface AppStoreVersions {
    android?: string | null;
    ios?: string | null;
    checkedAt?: string | null;
}

/**
 * Strip anything that is not a digit or a dot, then insist on a real dotted version.
 *
 * The stripping is what fixes iOS. The shape check is what stops a half-parsed
 * string ("1..31", "") from being treated as a version and compared against.
 */
export function normaliseVersion(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const stripped = raw.replace(/[^0-9.]/g, '');
    if (!/^\d+(\.\d+){0,2}$/.test(stripped)) return null;
    return stripped;
}

export function isVersionOlder(local: string, latest: string): boolean {
    const a = normaliseVersion(local);
    const b = normaliseVersion(latest);
    // An unparseable version on either side means we do not know, and "we do not know"
    // must never resolve to "you are out of date" — that is a banner nobody can clear.
    if (!a || !b) return false;
    const parse = (v: string) => v.split('.').map((n) => parseInt(n, 10));
    const localParts = parse(a);
    const latestParts = parse(b);
    for (let i = 0; i < 3; i++) {
        const l = localParts[i] || 0;
        const r = latestParts[i] || 0;
        if (l < r) return true;
        if (l > r) return false;
    }
    return false;
}

/** The store version for the platform this build is running on. */
export function pickStoreVersion(versions: AppStoreVersions | null | undefined, platform: string): string | null {
    if (!versions) return null;
    return normaliseVersion(platform === 'ios' ? versions.ios : versions.android);
}

export type UpdateState =
    | { kind: 'none' }
    | { kind: 'available'; version: string }
    | { kind: 'required'; version: string };

/**
 * What the banner should say.
 *
 * `required` means the installed app is below the node's declared floor: things will
 * misbehave, so that banner is not dismissible. `available` is the ordinary "there is
 * a newer build" nudge and can be dismissed per version. A node that reports no floor
 * and no store version produces no banner at all — the same as before, but silently
 * rather than after a timed-out 1.1 MB download.
 */
export function evaluateUpdate(
    localVersion: string,
    latest: string | null | undefined,
    minimum: string | null | undefined
): UpdateState {
    const local = normaliseVersion(localVersion);
    if (!local) return { kind: 'none' };
    const latestClean = normaliseVersion(latest);
    const minClean = normaliseVersion(minimum);
    if (minClean && isVersionOlder(local, minClean)) {
        // Point at the newest build we know exists, falling back to the floor itself.
        return { kind: 'required', version: latestClean && isVersionOlder(local, latestClean) ? latestClean : minClean };
    }
    if (latestClean && isVersionOlder(local, latestClean)) {
        return { kind: 'available', version: latestClean };
    }
    return { kind: 'none' };
}

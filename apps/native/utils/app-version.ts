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
 * Drop the decoration we actually understand, then insist on a real dotted version.
 *
 * A leading v/V is the App Store's "V1.2.31" and is what fixes iOS. Everything else is
 * rejected rather than scrubbed: stripping every non-digit would turn "1.2.3-1" into
 * "1.2.31" — a version that exists and is the wrong one, which is worse than admitting
 * we do not know. The shape check is what stops a half-parse ("1..31", "") from being
 * compared against at all.
 */
export function normaliseVersion(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim().replace(/^[vV]\s*/, '');
    if (!/^\d+(\.\d+){0,2}$/.test(trimmed)) return null;
    return trimmed;
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
    if (platform === 'ios') return normaliseVersion(versions.ios);
    if (platform === 'android') return normaliseVersion(versions.android);
    // Anywhere else (expo web) there is no store to send anyone to.
    return null;
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
    const updateExists = !!latestClean && isVersionOlder(local, latestClean);

    if (minClean && isVersionOlder(local, minClean)) {
        // Below the node's floor. Refuse dismissal ONLY when doing what the banner asks
        // would actually clear it. A floor the stores cannot satisfy yet — an operator who
        // raised MIN_APP_VERSION ahead of a release — would otherwise leave the user behind
        // an undismissible banner after they had already done everything it told them to.
        if (latestClean && !isVersionOlder(latestClean, minClean)) {
            return { kind: 'required', version: latestClean };
        }
        // No published version known at all (an older node sends no appVersions): the floor
        // is the only thing we can name, and the store will have something newer than a
        // build old enough to fall below it.
        if (!latestClean) return { kind: 'required', version: minClean };
        // The newest published build is itself below the floor. Say the honest, dismissible
        // thing rather than promise an update that cannot fix it.
        return updateExists ? { kind: 'available', version: latestClean } : { kind: 'none' };
    }
    if (updateExists) return { kind: 'available', version: latestClean as string };
    return { kind: 'none' };
}

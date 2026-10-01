/**
 * App-store version lookup — done by the NODE, served in the health payload.
 *
 * The phone used to do this itself, once per app, per install, on every ping:
 *
 *   - iOS asked itunes.apple.com/lookup. That has never once worked. The store
 *     answers "V1.2.31" — capital V — and the client parsed it with
 *     `v.split('.').map(Number)`, so the store version read [NaN, 2, 31], the NaN
 *     was coerced to 0, and the installed app always compared as newer. The iOS
 *     banner could not appear, and never has.
 *   - Android downloaded the whole Play Store listing page — 1.10 MB of HTML —
 *     behind a 4-second timeout, to read one version string out of it. Measured:
 *     1.9 s at 5 Mbps, 6.2 s at 1.5 Mbps, 18.5 s at 0.5 Mbps. Our users are on
 *     regional and off-grid connections, so for most of them it simply timed out,
 *     and because the "last checked" timestamp was only written on success, it
 *     retried on every 30-second ping — 1.1 MB a time, on metered data.
 *
 * So the node does it instead: every six hours, once, for the whole community, and
 * hands the answer to every phone in the `/api/community/health` payload they
 * already fetch. The phone compares two short strings and spends no bytes of its
 * own. The Play scrape can still break when Google changes their markup, but it
 * breaks here — on a node with real bandwidth and a log — instead of on a phone.
 *
 * Nothing here is load-bearing: an unknown version means no banner, which is what
 * a phone that could not reach the store had anyway.
 *
 * The floors (getAppFloors) are what can stop an app: from the build that has it, an app
 * below its platform's floor shows a full-screen "Update required" at a safe moment
 * (apps/native/utils/force-update.ts). So every rule here fails towards NOT stopping
 * anyone: a floor is enforced only once that platform's store has a build that meets it
 * (an unknown store version enforces nothing), a grace date that is not a date turns the
 * block off, and nothing on the server ever refuses a request for the app's version.
 */

import { logger } from './logger.js';

const IOS_BUNDLE_ID = 'org.beanpool.pillar';
const ANDROID_PACKAGE = 'org.beanpool.pillar';

/**
 * The oldest app build this node expects to work with, as served to clients.
 *
 * Deliberately far below anything in the field. The field exists so a node CAN say
 * "the app talking to me is too old to work properly", and until now it has been a
 * hardcoded string in the health payload that no client ever read. Raising it makes
 * every phone below the value show a banner it cannot dismiss, so it is an operator
 * decision (MIN_APP_VERSION), not a default.
 */
const DEFAULT_MIN_APP_VERSION = '1.0.75';

export function getMinAppVersion(): string {
    return normaliseVersion(process.env.MIN_APP_VERSION) || DEFAULT_MIN_APP_VERSION;
}

/** The phone platforms that have a store, a floor and a block. The web app has none of the three: see getAppFloors. */
export const APP_PLATFORMS = ['android', 'ios'] as const;
export type AppPlatform = typeof APP_PLATFORMS[number];

const PLATFORM_ENV: Record<AppPlatform, string> = { android: 'ANDROID', ios: 'IOS' };

/**
 * One platform's floor as the operator set it: MIN_APP_VERSION_IOS / MIN_APP_VERSION_ANDROID, else MIN_APP_VERSION, else
 * the default. A platform value that is not a version is ignored (the generic floor stands), never read as a higher one.
 */
export function getPlatformFloor(platform: AppPlatform): string {
    return normaliseVersion(process.env[`MIN_APP_VERSION_${PLATFORM_ENV[platform]}`]) || getMinAppVersion();
}

/**
 * The banner's number for an app that does not say which kind of phone it is on (health's `minAppVersion` without an
 * X-BeanPool-App header): every phone app from before the full-screen update, and anything else that reads health. The
 * lower of the two platforms' floors, so no app is ever shown a floor above its own platform's: an operator raising
 * one kind of phone at a time (MIN_APP_VERSION_ANDROID / _IOS) leaves these apps' banner where it was until both are
 * raised, and then they see it too. With MIN_APP_VERSION alone (or both platforms at one floor) it is that floor, as it
 * always was. A banner only: those builds have no full-screen update.
 */
export function getUnnamedAppFloor(): string {
    const android = getPlatformFloor('android');
    const ios = getPlatformFloor('ios');
    return isOlder(ios, android) ? ios : android;
}

/**
 * When a floor starts to stop apps below it (the grace window): MIN_APP_VERSION_FROM_IOS / _ANDROID, else
 * MIN_APP_VERSION_FROM, as a date or a date and time ("2026-10-15", "2026-10-15T09:00:00+10:00"; a bare date is
 * midnight UTC). Before it the app shows its banner only; from it, the full-screen "Update required" at its next safe
 * moment (apps/native/utils/force-update.ts). Unset: the block applies already. Set but not a date: `invalid`, and the
 * block never applies — an operator's typo must not lock anyone out.
 */
export function getFloorFrom(platform?: AppPlatform): { iso: string | null; invalid: boolean } {
    const own = platform ? process.env[`MIN_APP_VERSION_FROM_${PLATFORM_ENV[platform]}`] : undefined;
    const raw = (own && own.trim()) ? own : process.env.MIN_APP_VERSION_FROM;
    if (raw === undefined || raw.trim() === '') return { iso: null, invalid: false };
    const text = raw.trim();
    // A date first: Date.parse also takes "1", "2026" and "March 7", which are not what anyone means here.
    if (!/^\d{4}-\d{2}-\d{2}([T ].+)?$/.test(text)) return { iso: null, invalid: true };
    const ms = Date.parse(text);
    if (!Number.isFinite(ms)) return { iso: null, invalid: true };
    return { iso: new Date(ms).toISOString(), invalid: false };
}

/** The grace date every platform falls back to (MIN_APP_VERSION_FROM), served as `minAppVersionFrom`; null when unset or not a date. */
export function getMinAppVersionFrom(): string | null {
    return getFloorFrom().iso;
}

/** Everything this node knows about one platform's floor: the manager's view (GET /api/local/admin/app-versions). */
export interface PlatformFloorDetail {
    /** The floor the operator set for this platform (getPlatformFloor). */
    floor: string;
    /** The newest build this node has seen in the platform's store, or null if it has never read one. */
    store: string | null;
    /**
     * The floor an app is held to: `floor` once the store has it. Null while the store is behind it (`held`) or unknown:
     * a node never holds anyone to a build they cannot download (iOS review lag, an operator ahead of a release).
     */
    enforced: string | null;
    /** True when the store has a build but it is below `floor`: the floor waits for it, and the log says so. */
    held: boolean;
    /** From when an app below `enforced` is stopped at its next safe moment (ISO), or null for "already". */
    from: string | null;
    /** The grace date was set but is not a date: the block never applies until it is fixed. */
    fromInvalid: boolean;
    /** On this node's clock: an app below `enforced` is stopped now, at its next safe moment. */
    blocking: boolean;
}

export function getPlatformFloorDetail(platform: AppPlatform, now: Date = new Date()): PlatformFloorDetail {
    const floor = getPlatformFloor(platform);
    const store = normaliseVersion(cached[platform]);
    const reachable = !!store && !isOlder(store, floor);
    const held = !!store && !reachable;
    const { iso: from, invalid: fromInvalid } = getFloorFrom(platform);
    const enforced = reachable ? floor : null;
    const blocking = !!enforced && !fromInvalid && (from === null || now.getTime() >= Date.parse(from));
    noteHeldFloor(platform, floor, store, held, fromInvalid);
    return { floor, store, enforced, held, from, fromInvalid, blocking };
}

/**
 * What the app reads for one platform, in /api/community/health. Kept short: the payload goes to every phone every 30 s.
 * The grace date itself is not repeated per platform (`blocking` already applies it, on this node's clock); the generic
 * one is health's `minAppVersionFrom`, and the manager's route has each platform's.
 */
export interface PlatformFloor {
    /** PlatformFloorDetail.enforced: the floor, once the store has it; null while it doesn't, or isn't known. */
    min: string | null;
    /** PlatformFloorDetail.blocking: an app below `min` stops at its next safe moment. */
    blocking: boolean;
}

/**
 * The floors the app enforces, per platform (health's `appFloors`). The web app is not here: it is this server's own
 * copy, loaded fresh with every page load, so no store, no floor and no block apply to it (apps/pwa compares itself
 * with the server's `version` instead and offers a reload).
 */
export function getAppFloors(now: Date = new Date()): Record<AppPlatform, PlatformFloor> {
    const pick = (p: AppPlatform): PlatformFloor => {
        const d = getPlatformFloorDetail(p, now);
        return { min: d.enforced, blocking: d.blocking };
    };
    return { android: pick('android'), ios: pick('ios') };
}

/**
 * The log line for a floor the store has not reached yet, and for a grace date that is not a date: once each time
 * what it says changes, not on every health read. Reset with the cache in tests.
 */
const lastFloorNote: Partial<Record<AppPlatform, string>> = {};
function noteHeldFloor(platform: AppPlatform, floor: string, store: string | null, held: boolean, fromInvalid: boolean): void {
    const key = `${floor}|${store}|${held}|${fromInvalid}`;
    if (lastFloorNote[platform] === key) return;
    lastFloorNote[platform] = key;
    const env = `MIN_APP_VERSION_${PLATFORM_ENV[platform]}`;
    if (held) {
        logger.warn('SYS', `[AppVersions] ${platform} floor ${floor} is held: the store has ${store}, so no ${platform} app is stopped until it has ${floor} (${env} / MIN_APP_VERSION)`);
    }
    if (fromInvalid) {
        logger.warn('SYS', `[AppVersions] ${platform}: MIN_APP_VERSION_FROM_${PLATFORM_ENV[platform]} / MIN_APP_VERSION_FROM is not a date (use 2026-10-15 or 2026-10-15T09:00:00+10:00) — the ${platform} update block is off until it is`);
    }
}

export interface AppStoreVersions {
    /** Latest version on Google Play, or null if we have never successfully read it. */
    android: string | null;
    /** Latest version on the App Store, or null if we have never successfully read it. */
    ios: string | null;
    /** ISO timestamp of the last check that returned at least one version. */
    checkedAt: string | null;
}

let cached: AppStoreVersions = { android: null, ios: null, checkedAt: null };

export function getAppStoreVersions(): AppStoreVersions {
    return { ...cached };
}

/**
 * Coerce whatever a store hands back into a bare dotted version, or null.
 *
 * Apple's "V1.2.31" is the specific case that broke the client for the life of the
 * feature, so a leading v/V and surrounding whitespace come off. Nothing else does:
 * stripping every non-digit would fold "1.2.3-1" into "1.2.31", a version that exists
 * and is the wrong one. Anything that is not already a dotted version is refused —
 * "we do not know" is a safe answer here, a wrong number is not.
 *
 * Mirrors apps/native/utils/app-version.ts, which has to make the same judgement about
 * whatever an older node sends it.
 */
export function normaliseVersion(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim().replace(/^[vV]\s*/, '');
    if (!/^\d+(\.\d+){0,2}$/.test(trimmed)) return null;
    return trimmed;
}

/** Pull the version out of an itunes.apple.com/lookup response body. */
export function parseItunesLookup(body: unknown): string | null {
    const results = (body as any)?.results;
    if (!Array.isArray(results) || results.length === 0) return null;
    return normaliseVersion(results[0]?.version);
}

/**
 * Pull the version out of a Play Store listing page.
 *
 * Same regex the app shipped with — verified against the live page under three
 * user-agents. The scrape was never the broken part; the 1.1 MB payload was.
 */
export function parsePlayStoreHtml(html: string): string | null {
    const match = html.match(/\[\[\["([0-9]+\.[0-9]+\.[0-9]+)"\]\]/);
    return match ? normaliseVersion(match[1]) : null;
}

/**
 * Fold one check's results into the cache.
 *
 * A store that failed keeps its previous answer rather than blanking it: a phone
 * that has been told 1.2.32 exists should not be told it does not because the node
 * had a bad minute. `checkedAt` only moves when something actually answered, so it
 * reads as "when we last knew this to be true", not "when we last tried".
 */
export function applyCheckResult(
    result: { android: string | null; ios: string | null },
    now: Date = new Date()
): AppStoreVersions {
    const android = result.android ?? cached.android;
    const ios = result.ios ?? cached.ios;
    const answered = result.android !== null || result.ios !== null;
    cached = { android, ios, checkedAt: answered ? now.toISOString() : cached.checkedAt };
    return getAppStoreVersions();
}

/** Test seam — resets the module cache between assertions. */
export function __resetAppStoreVersionsForTest(): void {
    cached = { android: null, ios: null, checkedAt: null };
    for (const p of APP_PLATFORMS) delete lastFloorNote[p];
}

/** Numeric segment-wise compare, for the operator warning below. */
function isOlder(a: string, b: string): boolean {
    const pa = a.split('.').map(n => parseInt(n, 10));
    const pb = b.split('.').map(n => parseInt(n, 10));
    for (let i = 0; i < 3; i++) {
        const l = pa[i] || 0;
        const r = pb[i] || 0;
        if (l < r) return true;
        if (l > r) return false;
    }
    return false;
}

const FETCH_TIMEOUT_MS = 15000;

async function fetchIosVersion(): Promise<string | null> {
    try {
        const res = await fetch(
            `https://itunes.apple.com/lookup?bundleId=${IOS_BUNDLE_ID}&_t=${Date.now()}`,
            { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'User-Agent': 'BeanPool-Node' } }
        );
        if (!res.ok) return null;
        return parseItunesLookup(await res.json());
    } catch {
        return null;
    }
}

async function fetchAndroidVersion(): Promise<string | null> {
    try {
        const res = await fetch(
            `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}&hl=en`,
            {
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                // Play serves a stripped page to unrecognised agents, and the version
                // block is one of the things it strips.
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
            }
        );
        if (!res.ok) return null;
        return parsePlayStoreHtml(await res.text());
    } catch {
        return null;
    }
}

export async function checkAppStoreVersions(): Promise<AppStoreVersions> {
    const [android, ios] = await Promise.all([fetchAndroidVersion(), fetchIosVersion()]);
    const next = applyCheckResult({ android, ios });
    if (android === null || ios === null) {
        // Worth a line: if one store stops answering for weeks, the phones quietly stop
        // being told about updates, and the only place that is visible is here.
        logger.warn('SYS', `[AppVersions] store check incomplete (android=${android ?? 'miss'} ios=${ios ?? 'miss'})`);
    } else {
        logger.info('SYS', `[AppVersions] android=${android} ios=${ios}`);
    }
    // An operator who sets a floor above what a store actually serves gets a floor their community cannot act on. The
    // node holds it (getPlatformFloorDetail: never enforced above the store's build) and the app degrades the banner to a
    // dismissible notice, so nobody is trapped, but the operator still wants to hear about it: reading each platform's
    // floor logs a held one, once each time it changes.
    for (const p of APP_PLATFORMS) getPlatformFloorDetail(p);
    return next;
}

let started = false;

/**
 * Start the periodic check. Same cadence and startup delay as the node's own
 * GitHub release check in routes/settings.ts — the store is not going to publish
 * anything we need within seconds of a boot, and a node restart loop should not
 * turn into a burst of store traffic.
 */
export function initAppStoreVersionChecks(): void {
    if (started) return;
    started = true;
    setTimeout(() => { void checkAppStoreVersions(); }, 30000).unref();
    setInterval(() => { void checkAppStoreVersions(); }, 6 * 60 * 60 * 1000).unref();
}

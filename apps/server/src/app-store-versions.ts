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
 * So the node does it instead: twice a day, once, for the whole community, and
 * hands the answer to every phone in the `/api/community/health` payload they
 * already fetch. The phone compares two short strings and spends no bytes of its
 * own. The Play scrape can still break when Google changes their markup, but it
 * breaks here — on a node with real bandwidth and a log — instead of on a phone.
 *
 * Nothing here is load-bearing: an unknown version means no banner, which is what
 * a phone that could not reach the store had anyway.
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
    // An operator who sets the floor above what the stores actually serve gets a banner
    // their community cannot act on. The app degrades that to a dismissible notice rather
    // than trapping anyone, but the operator still wants to hear about it — this is the
    // only place that knows both numbers.
    const floor = getMinAppVersion();
    const unreachable = [next.android, next.ios].filter((v): v is string => !!v).every(v => isOlder(v, floor));
    if (unreachable && (next.android || next.ios)) {
        logger.warn('SYS', `[AppVersions] MIN_APP_VERSION=${floor} is above every published build (android=${next.android ?? '?'} ios=${next.ios ?? '?'}) — nobody can reach it`);
    }
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

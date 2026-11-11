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
 * The floors (getAppFloors) are what can stop an app. From the build that has it (2 Oct,
 * #1415), an app below its platform's floor shows a full-screen "Update required" at its
 * next safe moment: a start, or a return after 5 minutes or more away
 * (apps/native/utils/force-update.ts). While that block applies, the server also refuses
 * such an app its gated reads and writes, 426 app_too_old (floorRefusing, https-server.ts
 * requireSignature), all but its ways out (floorLetsThrough). An app from 1.4.0 on, which
 * only a floor raised past it refuses, reads that answer and puts "Update required" up at
 * once (#3043). An older one doesn't: what it tries fails until its next safe moment puts
 * the screen up. An app from before the
 * full-screen update sends no version, so it is never refused, and shows its banner only.
 * So every rule here fails towards NOT stopping anyone: a floor is enforced only once that
 * platform's store has a build that meets it (an unknown store version enforces nothing), a
 * grace date that is not a date turns the block off, and the server refuses an app only
 * where the app's own block applies.
 *
 * DISABLE_APP_STORE_CHECK=true turns the lookup off (appStoreCheckDisabled): no request to
 * either store, ever. The versions then stay unknown (null), never "up to date", with what
 * unknown already means above: no phone is told of a newer build, and no floor is
 * enforced, so an app below one gets its banner only.
 *
 * APP_STORE_VERSIONS (e.g. `android=1.4.0,ios=1.4.0`) says what a store has in place of asking it, for a test community
 * to try "Update required" before the stores have the build (storeVersionsSetting). A platform it names is never asked;
 * everything downstream reads the version it gives as a store's. It is the one setting here that can stop an app the
 * store cannot replace yet, which is why it is for a test community only, and why what it can't read stops nobody.
 */

import { logger } from './logger.js';

const IOS_BUNDLE_ID = 'org.beanpool.pillar';
const ANDROID_PACKAGE = 'org.beanpool.pillar';

/**
 * The oldest app build this node works with, as served to clients: 1.4.0, the clean-slate cutover (design §1). In code,
 * not .env, so every self-hoster's node holds old apps off without configuring anything. It is also the lowest floor
 * there is: a floor set in .env (MIN_APP_VERSION, or per platform) can raise it and never lower it. One below it is
 * ignored, and the log says so once, at start (noteFloorsBelowBuiltIn). It brings no grace date of its own: unless the
 * operator sets one (MIN_APP_VERSION_FROM), it stops apps below it as soon as their store has 1.4.0, and never before
 * (getPlatformFloorDetail). What a stopped app then does: the file comment above.
 */
const DEFAULT_MIN_APP_VERSION = '1.4.0';

/** The floors an operator can set in .env, in the order the start-up line names them. */
const FLOOR_ENV = ['MIN_APP_VERSION', 'MIN_APP_VERSION_ANDROID', 'MIN_APP_VERSION_IOS'] as const;

/**
 * A floor from .env as the server applies it: null when unset or not a version (the next one down stands), the built-in
 * floor in place of one below it, otherwise the value itself.
 */
function raisedFloor(raw: unknown): string | null {
    const set = normaliseVersion(raw);
    if (!set) return null;
    return isOlder(set, DEFAULT_MIN_APP_VERSION) ? DEFAULT_MIN_APP_VERSION : set;
}

/** The floor for both kinds of phone: the higher of MIN_APP_VERSION and the built-in floor. */
export function getMinAppVersion(): string {
    return raisedFloor(process.env.MIN_APP_VERSION) ?? DEFAULT_MIN_APP_VERSION;
}

/**
 * The floors set in .env below the built-in one, which the server ignores (raisedFloor), each as NAME=version. Empty when
 * there are none.
 */
export function floorsBelowBuiltIn(): string[] {
    return FLOOR_ENV.flatMap((name) => {
        const set = normaliseVersion(process.env[name]);
        return set && isOlder(set, DEFAULT_MIN_APP_VERSION) ? [`${name}=${set}`] : [];
    });
}

/**
 * At start (initAppStoreVersionChecks): one line in the log when a floor in .env is ignored for being below the built-in
 * one. A node that set a floor before 1.4.0 (G7's, say) would otherwise still read it there and never learn why its
 * phones are held to 1.4.0. Returns the line, or null when nothing is ignored.
 */
export function noteFloorsBelowBuiltIn(): string | null {
    const ignored = floorsBelowBuiltIn();
    if (!ignored.length) return null;
    const one = ignored.length === 1;
    const line = `[AppVersions] ${ignored.join(', ')} in .env ${one ? 'is' : 'are'} below this server's own floor, `
        + `${DEFAULT_MIN_APP_VERSION}, so ${one ? 'it is' : 'they are'} ignored and ${DEFAULT_MIN_APP_VERSION} applies. `
        + `A floor in .env can only raise it: remove ${one ? 'that line' : 'those lines'}, or set ${DEFAULT_MIN_APP_VERSION} or higher.`;
    logger.warn('SYS', line);
    return line;
}

/** The phone platforms that have a store, a floor and a block. The web app has none of the three: see getAppFloors. */
export const APP_PLATFORMS = ['android', 'ios'] as const;
export type AppPlatform = typeof APP_PLATFORMS[number];

const PLATFORM_ENV: Record<AppPlatform, string> = { android: 'ANDROID', ios: 'IOS' };

/**
 * One platform's floor: MIN_APP_VERSION_IOS / MIN_APP_VERSION_ANDROID, else MIN_APP_VERSION, else the default, and never
 * below the default (raisedFloor). A platform value that is not a version is ignored (the generic floor stands), never
 * read as a higher one. A platform value may sit below MIN_APP_VERSION (one kind of phone held back), but not below the
 * built-in floor: there it is the built-in floor.
 */
export function getPlatformFloor(platform: AppPlatform): string {
    return raisedFloor(process.env[`MIN_APP_VERSION_${PLATFORM_ENV[platform]}`]) ?? getMinAppVersion();
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
    /** This platform's floor (getPlatformFloor): the operator's, never below the built-in one. */
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
    const store = normaliseVersion(storeVersion(platform));
    const reachable = !!store && !isOlder(store, floor);
    const held = !!store && !reachable;
    const { iso: from, invalid: fromInvalid } = getFloorFrom(platform);
    const enforced = reachable ? floor : null;
    const blocking = !!enforced && !fromInvalid && (from === null || now.getTime() >= Date.parse(from));
    noteHeldFloor(platform, floor, store, held, fromInvalid);
    return { floor, store, enforced, held, from, fromInvalid, blocking };
}

/**
 * The floor the `platform` app at `version` is refused below, or null when it isn't: the platform's enforced floor while
 * its update block applies (getPlatformFloorDetail `blocking`), so a node never refuses an app its store cannot replace
 * yet (a floor ahead of the store, an unknown store, or a grace date still ahead). The signature middleware answers such
 * an app's gated reads and writes 426 app_too_old with this floor (https-server.ts requireSignature).
 */
export function floorRefusing(platform: AppPlatform, version: string, now: Date = new Date()): string | null {
    const d = getPlatformFloorDetail(platform, now);
    return d.blocking && d.enforced && isOlder(version, d.enforced) ? d.enforced : null;
}

/**
 * The ways out, which the floor never refuses (#3047's deciding review, finding 1). "Update required" offers Leave this
 * community (apps/native utils/update-block-escape.ts): with another community on the phone, it asks this one to stop
 * that phone's alerts (account-leaves-phone.ts stopPushAlertsAt); as the last, it takes the account off the phone as
 * Sign Out does, which asks the same with the leave's stamp (unregisterPushToken). A phone that couldn't reach it then
 * presents the signed leave statement later (push-leave.ts). The phone sends its version on each of these while it is
 * still set to this community, so refused, the node would go on pushing the account's alerts to a phone that left it.
 * Each only ever takes away: the push token's row for the signer, or for the statement's own key. Its route still checks
 * it as it checks any request. A registration (POST /api/push-tokens) is no way out. Matched on the path as the router
 * answers it (one trailing slash is the path itself); any other spelling stays refused.
 */
const FLOOR_WAYS_OUT: ReadonlyArray<{ method: string; path: RegExp }> = [
    { method: 'DELETE', path: /^\/api\/push-tokens\/?$/ },
    { method: 'POST', path: /^\/api\/push-tokens\/leave\/[^/]+\/?$/ },
];

/** Whether the floor lets this request through to its route, whatever the app's version: FLOOR_WAYS_OUT. */
export function floorLetsThrough(method: string, path: string): boolean {
    return FLOOR_WAYS_OUT.some((w) => w.method === method && w.path.test(path));
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

/** What the stores last answered. Read through storeVersion, which puts APP_STORE_VERSIONS first. */
let cached: AppStoreVersions = { android: null, ios: null, checkedAt: null };

/**
 * The store versions as this node uses them (health's `appVersions`): for a platform APP_STORE_VERSIONS names, the version
 * it gives (null where it can't read it); for any other, what its store last answered. `checkedAt` is the stores' own:
 * when one last answered, never moved by the setting.
 */
export function getAppStoreVersions(): AppStoreVersions {
    return { android: storeVersion('android'), ios: storeVersion('ios'), checkedAt: cached.checkedAt };
}

/** One platform's store version (getAppStoreVersions). */
function storeVersion(platform: AppPlatform): string | null {
    const { stores } = storeVersionsSetting();
    return platform in stores ? stores[platform] ?? null : cached[platform];
}

const STORE_NAME: Record<AppPlatform, string> = { android: 'Google Play', ios: 'the App Store' };

/** APP_STORE_VERSIONS as read: see storeVersionsSetting. */
interface StoreVersionsSetting {
    /**
     * Each platform the setting takes over from its store, which is then never asked: the version it gives, or null where
     * it can't read one for it (an unknown store, so nothing is enforced there).
     */
    stores: Partial<Record<AppPlatform, string | null>>;
    /** Why each entry it couldn't read was not read, for the log. */
    unread: string[];
}

/**
 * APP_STORE_VERSIONS: what a platform's store has, as the operator says, in place of asking it. Comma-separated
 * `platform=version` entries, `android=1.4.0,ios=1.4.0`, each version read as a store's is (normaliseVersion). It is for a
 * test community, to try the update block before the stores have the build (Marty, 11 Nov: the stores still had 1.3.4, so
 * a 1.4.0 node let 1.3.4 in). With android=1.4.0 the floor 1.4.0 is enforced on Android as if Google Play had 1.4.0, so a
 * 1.3.4 Android app gets "Update required" and its gated requests 426 app_too_old, its ways out still answered.
 *
 * A platform it names is never asked (checkAppStoreVersions). One it doesn't name is asked as without it. Nothing else
 * changes: the floors, the grace dates, `blocking`, health's appVersions and appFloors, floorRefusing and the ways out read
 * the version it gives as they read a store's, and the phone checks appVersions against the floor as it always does. It
 * only says what a store has, so it lowers no floor: a version below the floor holds that floor (`held`), as a store
 * behind it does, and MIN_APP_VERSION and MIN_APP_VERSION_FROM apply as without it.
 *
 * On a real community it would stop older apps before their members can get the new build. So what it can't read stops
 * nobody: an entry it can't read leaves every platform it could mean with no store version, and asks no store for them
 * either, so a typo never falls back to a store that may meet the floor. That is the one platform an entry names
 * (`android=banana`, android named twice), or both when it names neither (`1.4.0`, `android:1.4.0`, `web=1.4.0`). The log
 * says why, once each time the value changes.
 */
function readStoreVersionsSetting(raw: string | undefined): StoreVersionsSetting {
    const given: Partial<Record<AppPlatform, string>> = {};
    const named = new Set<AppPlatform>();
    const unreadable = new Set<AppPlatform>();
    const unread: string[] = [];
    for (const entry of (raw ?? '').split(',').map(e => e.trim()).filter(Boolean)) {
        const eq = entry.indexOf('=');
        const name = eq > 0 ? entry.slice(0, eq).trim().toLowerCase() : '';
        const platform = APP_PLATFORMS.find(p => p === name);
        if (!platform) {
            for (const p of APP_PLATFORMS) unreadable.add(p);
            unread.push(`"${entry}" names neither android nor ios`);
            continue;
        }
        if (named.has(platform)) {
            unreadable.add(platform);
            unread.push(`${platform} is named twice`);
            continue;
        }
        named.add(platform);
        const version = normaliseVersion(entry.slice(eq + 1));
        if (!version) {
            unreadable.add(platform);
            unread.push(`"${entry}" is not a version`);
            continue;
        }
        given[platform] = version;
    }
    const stores: StoreVersionsSetting['stores'] = {};
    for (const p of APP_PLATFORMS) {
        if (unreadable.has(p)) stores[p] = null;
        else if (given[p]) stores[p] = given[p];
    }
    return { stores, unread };
}

/** APP_STORE_VERSIONS read once each time its value changes, which is when the log says what it couldn't read. */
let settingRead: { raw: string | undefined; setting: StoreVersionsSetting } | null = null;
function storeVersionsSetting(): StoreVersionsSetting {
    const raw = process.env.APP_STORE_VERSIONS;
    if (settingRead && settingRead.raw === raw) return settingRead.setting;
    const setting = readStoreVersionsSetting(raw);
    settingRead = { raw, setting };
    if (setting.unread.length) {
        const off = APP_PLATFORMS.filter(p => setting.stores[p] === null);
        logger.warn('SYS', `[AppVersions] APP_STORE_VERSIONS=${raw} can't be read: ${setting.unread.join('; ')}. Write it as `
            + `android=1.4.0,ios=1.4.0. Until it is fixed, no ${off.join(' or ')} app is stopped for its version, and `
            + `${off.map(p => STORE_NAME[p]).join(' and ')} ${off.length === 1 ? 'is' : 'are'} not asked`);
    }
    return setting;
}

/**
 * At start (initAppStoreVersionChecks): the one line that says APP_STORE_VERSIONS is in use, naming the versions it gives
 * and that those stores are not asked. Returns the line, or null when it gives none (unset, or nothing it can read).
 */
export function noteStoreVersionsGiven(): string | null {
    const { stores } = storeVersionsSetting();
    const given = APP_PLATFORMS.filter(p => typeof stores[p] === 'string');
    if (!given.length) return null;
    const one = given.length === 1;
    const line = `[AppVersions] APP_STORE_VERSIONS gives ${given.map(p => `${p}=${stores[p]}`).join(' and ')}: this server `
        + `takes ${one ? 'that' : 'those'} as what ${given.map(p => STORE_NAME[p]).join(' and ')} ${one ? 'has' : 'have'}, and `
        + `does not ask ${one ? 'it' : 'them'}. A floor ${one ? 'that version' : 'those versions'} meet${one ? 's' : ''} stops older `
        + `apps there as if the store had the build: for a test community only, never a real one`;
    logger.warn('SYS', line);
    return line;
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
    settingRead = null;
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

/**
 * DISABLE_APP_STORE_CHECK=true: this node never asks itunes.apple.com or play.google.com, as
 * DISABLE_UPDATE_CHECK=true stops it asking GitHub on its own (routes/settings.ts). For an
 * operator who wants no call to anyone's servers but their own, and for a suite that proves
 * none is made (test-no-mothership). Unset, or anything but 'true', the check runs as it
 * always has.
 */
export function appStoreCheckDisabled(): boolean {
    return process.env.DISABLE_APP_STORE_CHECK === 'true';
}

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
    // Off: nothing is asked and nothing is folded in, so the versions stay what they were
    // (null on a node that never asked): unknown, not "up to date".
    if (appStoreCheckDisabled()) return getAppStoreVersions();
    // A platform APP_STORE_VERSIONS names is never asked: the setting says what its store has (storeVersionsSetting).
    const named = storeVersionsSetting().stores;
    const asked = APP_PLATFORMS.filter(p => !(p in named));
    if (asked.length) {
        const fetchers: Record<AppPlatform, () => Promise<string | null>> = { android: fetchAndroidVersion, ios: fetchIosVersion };
        const answers = await Promise.all(asked.map(p => fetchers[p]()));
        const got: Record<AppPlatform, string | null> = { android: null, ios: null };
        asked.forEach((p, i) => { got[p] = answers[i]; });
        applyCheckResult(got);
        const said = asked.map(p => `${p}=${got[p] ?? 'miss'}`).join(' ');
        if (asked.some(p => got[p] === null)) {
            // Worth a line: if one store stops answering for weeks, the phones quietly stop
            // being told about updates, and the only place that is visible is here.
            logger.warn('SYS', `[AppVersions] store check incomplete (${said})`);
        } else {
            logger.info('SYS', `[AppVersions] ${said}`);
        }
    }
    // An operator who sets a floor above what a store actually serves gets a floor their community cannot act on. The
    // node holds it (getPlatformFloorDetail: never enforced above the store's build) and the app degrades the banner to a
    // dismissible notice, so nobody is trapped, but the operator still wants to hear about it: reading each platform's
    // floor logs a held one, once each time it changes.
    for (const p of APP_PLATFORMS) getPlatformFloorDetail(p);
    return getAppStoreVersions();
}

let started = false;

/**
 * Start the periodic check. Same cadence and startup delay as the node's own
 * GitHub release check in routes/settings.ts — the store is not going to publish
 * anything we need within seconds of a boot, and a node restart loop should not
 * turn into a burst of store traffic. With DISABLE_APP_STORE_CHECK=true: no timer at all,
 * and one line in the log saying so. Either way, first, one line for a floor in .env that is
 * ignored for being below the built-in one (noteFloorsBelowBuiltIn), and one for the store
 * versions APP_STORE_VERSIONS gives (noteStoreVersionsGiven), which apply either way.
 */
export function initAppStoreVersionChecks(): void {
    if (started) return;
    started = true;
    noteFloorsBelowBuiltIn();
    const given = noteStoreVersionsGiven() !== null;
    if (appStoreCheckDisabled()) {
        const still = given ? '. The versions APP_STORE_VERSIONS gives (the line above) still apply to the platforms it names' : '';
        logger.info('SYS', `[AppVersions] the app-store check is off (DISABLE_APP_STORE_CHECK=true): this server never asks Google Play or the App Store, so phones are told of no newer app, and an app below its floor gets a banner only${still}`);
        return;
    }
    setTimeout(() => { void checkAppStoreVersions(); }, 30000).unref();
    setInterval(() => { void checkAppStoreVersions(); }, 6 * 60 * 60 * 1000).unref();
}

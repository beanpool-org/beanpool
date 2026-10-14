/**
 * Which phone app versions this community runs: counts only, for the manager (GET /api/local/admin/app-versions), so an
 * operator can see whom raising a floor would stop before they raise it (app-store-versions.ts getAppFloors).
 *
 * The app says its version in a header on every request to its own community, `X-BeanPool-App: <version> <platform>`
 * (apps/native/utils/node-request-signing.ts), from the build that has the update block. A request is counted only once
 * its signature has been checked (https-server.ts requireSignature) and its signer is one of this community's members or a
 * visitor's row: a key anyone can mint counts for nothing. Nothing is ever refused or slowed for the header, or for a
 * version: an app below the floor keeps working with the server until the app itself stops at a safe moment.
 *
 * What is kept is in this process's memory and nowhere else: no table, no file, no log line. For each member and
 * platform, a tag (HMAC-SHA-256 of the member's key under 32 random bytes made when the process starts, first 16
 * characters), the version and when it was last seen. The key is never written down, so a tag cannot be matched to a
 * member. A tag not seen for COUNT_WINDOW_DAYS is dropped, and a restart drops them all: the counts then cover the
 * members seen since it started, and the manager shows that date. Same shape as engine/web-visits.ts.
 *
 * At most MAX_COUNTED tags (a few MB): past that a new one is not counted until old ones expire.
 */

import crypto from 'node:crypto';
import { normaliseVersion, APP_PLATFORMS, type AppPlatform } from './app-store-versions.js';

export const APP_VERSION_HEADER = 'X-BeanPool-App';
/** A member not seen for this long is no longer counted. */
export const COUNT_WINDOW_DAYS = 30;
export const MAX_COUNTED = 50_000;
/** How often a counted member's standing is asked again (a member who leaves stops counting within this). */
const RECHECK_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TAG_CHARS = 16;
/** "1.2.57 android" is 14 characters; anything much longer is not this header. */
const MAX_HEADER_CHARS = 64;

interface Seen { platform: AppPlatform; version: string; at: number; checkedAt: number }

let key = crypto.randomBytes(32);
let startedAt = Date.now();
const seen = new Map<string, Seen>();

/** `<version> <platform>` → its parts, or null for anything else (an unknown platform, a version that isn't one). */
export function parseAppVersionHeader(raw: unknown): { version: string; platform: AppPlatform } | null {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_HEADER_CHARS) return null;
    const parts = raw.trim().split(/\s+/);
    if (parts.length !== 2) return null;
    const version = normaliseVersion(parts[0]);
    const platform = parts[1].toLowerCase() as AppPlatform;
    if (!version || !APP_PLATFORMS.includes(platform)) return null;
    return { version, platform };
}

function tagFor(member: string, platform: AppPlatform): string {
    return `${platform}:${crypto.createHmac('sha256', key).update(member).digest('base64url').slice(0, TAG_CHARS)}`;
}

function prune(now: number): void {
    const cutoff = now - COUNT_WINDOW_DAYS * DAY_MS;
    for (const [tag, s] of seen) if (s.at < cutoff) seen.delete(tag);
}

/**
 * Count a verified signer's app version. `counts` says whether the signer belongs here (a member or a visitor's row); it
 * is asked when a tag is new, when its version changes, and at most hourly after. Never throws.
 */
export function noteAppVersion(signer: string, header: unknown, counts: (signer: string) => boolean, now = Date.now()): void {
    try {
        const parsed = parseAppVersionHeader(header);
        if (!parsed || !signer) return;
        const tag = tagFor(signer, parsed.platform);
        const prev = seen.get(tag);
        if (prev && prev.version === parsed.version && now - prev.checkedAt < RECHECK_MS) {
            prev.at = now;
            return;
        }
        if (!counts(signer)) {
            seen.delete(tag);
            return;
        }
        if (!prev && seen.size >= MAX_COUNTED) {
            prune(now);
            if (seen.size >= MAX_COUNTED) return;
        }
        seen.set(tag, { platform: parsed.platform, version: parsed.version, at: now, checkedAt: now });
    } catch { /* a count is never worth a failed request */ }
}

export interface VersionCount { version: string; members: number }

export interface AppVersionCounts {
    /** Counted from: the later of this process's start and COUNT_WINDOW_DAYS ago (ISO). */
    since: string;
    windowDays: number;
    /** Per platform, newest version first. */
    platforms: Record<AppPlatform, VersionCount[]>;
}

function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(n => parseInt(n, 10));
    const pb = b.split('.').map(n => parseInt(n, 10));
    for (let i = 0; i < 3; i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d;
    }
    return 0;
}

export function getAppVersionCounts(now = Date.now()): AppVersionCounts {
    prune(now);
    const tally: Record<AppPlatform, Map<string, number>> = { android: new Map(), ios: new Map() };
    for (const s of seen.values()) tally[s.platform].set(s.version, (tally[s.platform].get(s.version) ?? 0) + 1);
    const list = (m: Map<string, number>): VersionCount[] => [...m.entries()]
        .map(([version, members]) => ({ version, members }))
        .sort((a, b) => compareVersions(b.version, a.version));
    return {
        since: new Date(Math.max(startedAt, now - COUNT_WINDOW_DAYS * DAY_MS)).toISOString(),
        windowDays: COUNT_WINDOW_DAYS,
        platforms: { android: list(tally.android), ios: list(tally.ios) },
    };
}

/** Test seam: forget every tag, start a new key, and count from `now`. */
export function __resetAppVersionCountsForTest(now = Date.now()): void {
    seen.clear();
    key = crypto.randomBytes(32);
    startedAt = now;
}

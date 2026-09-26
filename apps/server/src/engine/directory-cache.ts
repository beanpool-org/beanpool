/**
 * The communities directory as this node last fetched it (global node G5, design §3.2): `directory_cache`, written by
 * the hourly mirror (services/directory-mirror.ts) and read by GET /api/global/communities and /api/global/home.
 *
 * ## Every registry row is untrusted
 *
 * Anyone who runs a node can publish a row to the public registry, so each field is checked on its own
 * (normaliseRegistryRow) and a field that isn't what it claims to be is dropped, never guessed:
 *   - the key (`node_id`, else `nodeId`, else `id`) must be there, or the row is left out: without it a community
 *     can't be told apart from the next, nor recognised when it comes back;
 *   - the address must be https, or a bare hostname (which is its https address); anything else (http, javascript:,
 *     an IP literal, a path-only string) is no address. A community with no address is listed by name and distance,
 *     with no link and nothing to knock on (the registry gap, design §11: rows had no `node_url` until #1112);
 *   - the place is `service_radius {lat, lng, radiusKm}` (an object, or its JSON text), else top-level `lat`/`lng`: a
 *     point off the Earth, or exactly 0,0, is no place, and a radius that isn't a positive distance is none;
 *   - the name is `community_name`, else `callsign`, else `name`, with control and direction-changing characters taken
 *     out and at most 80 characters: it is shown in other people's notifications;
 *   - a member count is a whole number from 0; contacts are an email and a phone number or nothing.
 *
 * ## Written once a run, in one transaction (writeDirectoryRows)
 *
 * A community seen for the first time is inserted with `first_seen_at`; one seen before is updated where anything
 * shown changed; one that has left the registry is kept as its key and `first_seen_at` only (`listed` 0, everything
 * it published cleared, so an unlisted community's contacts don't linger here). A row is never deleted, so a
 * community is new to this node once in the life of its database: that is what makes a watcher's notice once only.
 *
 * ## A standby holds the same rows (mergeReplicatedDirectory)
 *
 * The table travels to a standby (SyncPayload.directoryCache, watermarked on `updated_at`, which a run stamps only on a
 * row it changed), so a server that takes over knows every community the old one had already seen and its first run
 * tells no watcher about them again (engine/place-watches.ts). It also lists the directory from its first minute. A
 * standby never fetches; a copy is its only writer until it takes over.
 */
import { db } from '../db/db.js';
import { haversineKm, type SyncDirectoryCommunity } from '@beanpool/engine';

/** What a registry row holds once checked. */
export interface DirectoryRow {
    key: string;
    name: string | null;
    url: string | null;
    lat: number | null;
    lng: number | null;
    radiusKm: number | null;
    memberCount: number | null;
    contactEmail: string | null;
    contactPhone: string | null;
    registryUpdatedAt: string | null;
}

/** A listed community as the API gives it: a DirectoryRow, and how far it is from the reader's point (km, 0.1). */
export interface Community {
    key: string;
    name: string | null;
    /** The community's https origin, or null: shown with no link and no knock target. */
    url: string | null;
    lat: number | null;
    lng: number | null;
    radiusKm: number | null;
    memberCount: number | null;
    contactEmail: string | null;
    contactPhone: string | null;
    /** When the community last published itself to the registry, as the registry said. */
    updatedAt: string | null;
    distanceKm: number | null;
}

export const MAX_NAME_CHARS = 80;
/** More than any registry will hold for a long time; a response past it is cut here and the rest logged. */
export const MAX_DIRECTORY_ROWS = 10_000;
const MAX_KEY_CHARS = 200;

// ── checking a row ───────────────────────────────────────────────────────────────────────────────────────────────

const DECIMAL = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;

/** A finite number, or a string that is plainly one. Anything else is undefined. */
function num(v: unknown): number | undefined {
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    if (typeof v === 'string' && DECIMAL.test(v.trim())) {
        const n = Number(v.trim());
        return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
}

/** Text to show someone: control characters become spaces, format characters (direction overrides, zero-width
 *  characters) go, runs of space become one, at most `max` characters. Null when nothing is left. */
export function cleanText(v: unknown, max: number): string | null {
    if (typeof v !== 'string') return null;
    const s = v.replace(/\p{Cc}/gu, ' ').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    const chars = Array.from(s);
    return chars.length > max ? chars.slice(0, max).join('').trim() : s;
}

function communityKey(r: Record<string, unknown>): string | null {
    for (const v of [r.node_id, r.nodeId, r.id]) {
        if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v);
        if (typeof v === 'string') {
            const s = v.trim();
            if (s && s.length <= MAX_KEY_CHARS && !/[\p{Cc}\p{Cf}\s]/u.test(s)) return s;
            return null;
        }
    }
    return null;
}

const BARE_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?\/?$/i;

/**
 * A community's address: its https origin, or null. A bare hostname is its https address (as resolvePublicNodeUrl
 * writes one); a host must be a name with a dot and a top-level domain that starts with a letter, so no IP literal
 * and no `localhost` is ever handed to a phone as a place to knock.
 */
export function communityUrl(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!s || s.length > 300) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : BARE_HOST.test(s) ? `https://${s}` : null;
    if (!withScheme) return null;
    let u: URL;
    try { u = new URL(withScheme); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (!/\.[a-z][a-z0-9-]*$/i.test(u.hostname)) return null;
    return u.origin;
}

function place(r: Record<string, unknown>): { lat: number | null; lng: number | null; radiusKm: number | null } {
    let sr: unknown = r.service_radius ?? r.serviceRadius;
    if (typeof sr === 'string') {
        try { sr = JSON.parse(sr); } catch { sr = null; }
    }
    const s = sr && typeof sr === 'object' && !Array.isArray(sr) ? sr as Record<string, unknown> : {};
    const lat = num(s.lat ?? r.lat);
    const lng = num(s.lng ?? r.lng);
    const radius = num(s.radiusKm);
    const onEarth = lat !== undefined && lng !== undefined && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
        // 0,0 is in the Gulf of Guinea: a default nobody changed, not a community.
        && !(lat === 0 && lng === 0);
    return {
        lat: onEarth ? lat! : null,
        lng: onEarth ? lng! : null,
        radiusKm: radius !== undefined && radius > 0 && radius <= 20_037 ? radius : null,
    };
}

function memberCount(v: unknown): number | null {
    const n = num(v);
    return n !== undefined && Number.isSafeInteger(n) && n >= 0 && n <= 100_000_000 ? n : null;
}

const EMAIL = /^[^\s@<>"'(),;:\\[\]]{1,64}@[^\s@<>"'(),;:\\[\]]+\.[^\s@<>"'(),;:\\[\]]+$/;
function email(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s.length <= 254 && EMAIL.test(s) ? s : null;
}

function phone(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return /^[+()0-9 .-]{3,32}$/.test(s) && (s.match(/\d/g)?.length ?? 0) >= 3 ? s : null;
}

function isoTime(v: unknown): string | null {
    if (typeof v !== 'string' || v.length > 64) return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** A registry row, checked (see the header), or null when it has no key to know it by. */
export function normaliseRegistryRow(raw: unknown): DirectoryRow | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const key = communityKey(r);
    if (!key) return null;
    const where = place(r);
    return {
        key,
        name: cleanText(r.community_name, MAX_NAME_CHARS) ?? cleanText(r.callsign, MAX_NAME_CHARS) ?? cleanText(r.name, MAX_NAME_CHARS),
        url: communityUrl(r.node_url ?? r.nodeUrl ?? r.public_url ?? r.publicUrl),
        ...where,
        memberCount: memberCount(r.member_count ?? r.memberCount),
        contactEmail: email(r.contact_email ?? r.contactEmail),
        contactPhone: phone(r.contact_phone ?? r.contactPhone),
        registryUpdatedAt: isoTime(r.updated_at ?? r.updatedAt ?? r.last_seen_at),
    };
}

// ── writing a run ────────────────────────────────────────────────────────────────────────────────────────────────

interface CacheRecord {
    community_key: string;
    listed: number;
    name: string | null;
    node_url: string | null;
    lat: number | null;
    lng: number | null;
    radius_km: number | null;
    member_count: number | null;
    contact_email: string | null;
    contact_phone: string | null;
    registry_updated_at: string | null;
    first_seen_at: string;
    updated_at: string;
}

function columns(r: DirectoryRow): unknown[] {
    return [r.name, r.url, r.lat, r.lng, r.radiusKm, r.memberCount, r.contactEmail, r.contactPhone, r.registryUpdatedAt];
}

function stored(c: CacheRecord): unknown[] {
    return [c.name, c.node_url, c.lat, c.lng, c.radius_km, c.member_count, c.contact_email, c.contact_phone, c.registry_updated_at];
}

export interface DirectoryWrite {
    /** Communities this node had never seen, in the order the registry gave them. */
    added: DirectoryRow[];
    /** Seen before: listed again, or something shown changed. */
    updated: number;
    /** Listed before and missing now: unlisted and scrubbed. */
    removed: number;
}

// The listed communities in memory, each with its name folded for search, for the reads. Only writeDirectoryRows
// writes the table, and it drops this.
let listedRows: Array<{ row: DirectoryRow; folded: string | null }> | null = null;

/**
 * One run's rows (checked, one per key: the caller keeps the last of a repeated key), written in one transaction.
 * `now` stamps `first_seen_at` for the new and `updated_at` for anything that changed.
 */
export function writeDirectoryRows(rows: readonly DirectoryRow[], now: string): DirectoryWrite {
    const existing = new Map((db.prepare('SELECT * FROM directory_cache').all() as CacheRecord[]).map(c => [c.community_key, c]));
    const insert = db.prepare(`INSERT INTO directory_cache (community_key, listed, name, node_url, lat, lng, radius_km, member_count,
        contact_email, contact_phone, registry_updated_at, first_seen_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const update = db.prepare(`UPDATE directory_cache SET listed = 1, name = ?, node_url = ?, lat = ?, lng = ?, radius_km = ?,
        member_count = ?, contact_email = ?, contact_phone = ?, registry_updated_at = ?, updated_at = ? WHERE community_key = ?`);
    const scrub = db.prepare(`UPDATE directory_cache SET listed = 0, name = NULL, node_url = NULL, lat = NULL, lng = NULL,
        radius_km = NULL, member_count = NULL, contact_email = NULL, contact_phone = NULL, registry_updated_at = NULL,
        updated_at = ? WHERE community_key = ?`);
    const out: DirectoryWrite = { added: [], updated: 0, removed: 0 };
    const seen = new Set<string>();
    db.transaction(() => {
        for (const row of rows) {
            seen.add(row.key);
            const old = existing.get(row.key);
            if (!old) {
                insert.run(row.key, ...columns(row), now, now);
                out.added.push(row);
            } else if (old.listed !== 1 || JSON.stringify(stored(old)) !== JSON.stringify(columns(row))) {
                update.run(...columns(row), now, row.key);
                out.updated++;
            }
        }
        for (const old of existing.values()) {
            if (old.listed === 1 && !seen.has(old.community_key)) {
                scrub.run(now, old.community_key);
                out.removed++;
            }
        }
    })();
    listedRows = null;
    return out;
}

// ── on a standby ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface DirectoryMerge { written: number; kept: number; invalid: number }

const isStamp = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 40;

/**
 * The main server's cache as a copy carries it, merged into this standby's database inside the import's transaction
 * (engine/sync.ts). Per community, the newer `updated_at` wins, and the main server's row is taken as it is, its first
 * sighting included. Every field goes through the same checks a registry row does (normaliseRegistryRow), so a copy
 * can't put here what a fetch couldn't. A row that fails them, or that this database refuses, is left out and counted.
 * It never fails the copy it came in.
 */
export function mergeReplicatedDirectory(communities: unknown): DirectoryMerge {
    const merge: DirectoryMerge = { written: 0, kept: 0, invalid: 0 };
    if (!Array.isArray(communities) || communities.length === 0) return merge;
    const current = db.prepare('SELECT updated_at FROM directory_cache WHERE community_key = ?');
    const upsert = db.prepare(`INSERT INTO directory_cache (community_key, listed, name, node_url, lat, lng, radius_km, member_count,
        contact_email, contact_phone, registry_updated_at, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(community_key) DO UPDATE SET listed = excluded.listed, name = excluded.name, node_url = excluded.node_url,
            lat = excluded.lat, lng = excluded.lng, radius_km = excluded.radius_km, member_count = excluded.member_count,
            contact_email = excluded.contact_email, contact_phone = excluded.contact_phone,
            registry_updated_at = excluded.registry_updated_at, first_seen_at = excluded.first_seen_at, updated_at = excluded.updated_at`);
    db.transaction(() => {
        for (const raw of communities) {
            const c = raw as Partial<SyncDirectoryCommunity> | null;
            if (!c || typeof c.key !== 'string' || typeof c.listed !== 'boolean' || !isStamp(c.firstSeenAt) || !isStamp(c.updatedAt)) {
                merge.invalid++;
                continue;
            }
            const row = normaliseRegistryRow({
                node_id: c.key, community_name: c.name, node_url: c.url,
                service_radius: { lat: c.lat, lng: c.lng, radiusKm: c.radiusKm },
                member_count: c.memberCount, contact_email: c.contactEmail, contact_phone: c.contactPhone, updated_at: c.registryUpdatedAt,
            });
            if (!row || row.key !== c.key) { merge.invalid++; continue; }
            const here = current.get(row.key) as { updated_at: string } | undefined;
            if (here && here.updated_at > c.updatedAt) { merge.kept++; continue; }
            try {
                upsert.run(row.key, c.listed ? 1 : 0, ...columns(row), c.firstSeenAt, c.updatedAt);
                merge.written++;
            } catch (e: any) {
                console.warn(`[Directory] A copied community could not be stored here, left out: ${e?.message || e}`);
                merge.invalid++;
            }
        }
    })();
    listedRows = null;
    return merge;
}

/** The listed communities are read again at the next request. For a force-resync, which empties the table. */
export function forgetListedCommunities(): void {
    listedRows = null;
}

// ── reading ──────────────────────────────────────────────────────────────────────────────────────────────────────

function listed(): Array<{ row: DirectoryRow; folded: string | null }> {
    if (listedRows) return listedRows;
    listedRows = (db.prepare('SELECT * FROM directory_cache WHERE listed = 1').all() as CacheRecord[]).map(c => ({
        row: {
            key: c.community_key,
            name: c.name,
            url: c.node_url,
            lat: c.lat,
            lng: c.lng,
            radiusKm: c.radius_km,
            memberCount: c.member_count,
            contactEmail: c.contact_email,
            contactPhone: c.contact_phone,
            registryUpdatedAt: c.registry_updated_at,
        },
        folded: c.name === null ? null : foldForSearch(c.name),
    }));
    return listedRows;
}

/** For a name search: case and accents forgiven ("sao paulo" finds São Paulo). */
export function foldForSearch(s: string): string {
    return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

function toCommunity(r: DirectoryRow, distanceKm: number | null): Community {
    return {
        key: r.key,
        name: r.name,
        url: r.url,
        lat: r.lat,
        lng: r.lng,
        radiusKm: r.radiusKm,
        memberCount: r.memberCount,
        contactEmail: r.contactEmail,
        contactPhone: r.contactPhone,
        updatedAt: r.registryUpdatedAt,
        distanceKm,
    };
}

export interface CommunityQuery {
    point?: { lat: number; lng: number } | null;
    /** A name search, as the reader typed it. */
    q?: string | null;
    limit: number;
    offset: number;
}

/**
 * The listed communities: from a point, nearest first by the centre of each one's service radius, those with no place
 * after them; without one, by name. Ties by name, then key, so paging never skips or repeats. `total` is how many match.
 */
export function listCommunities(query: CommunityQuery): { communities: Community[]; total: number } {
    const needle = query.q ? foldForSearch(query.q.trim()) : '';
    const rows = listed()
        .filter(x => !needle || (x.folded !== null && x.folded.includes(needle)))
        .map(({ row: r, folded }) => {
            const d = query.point && r.lat !== null && r.lng !== null ? haversineKm(query.point.lat, query.point.lng, r.lat, r.lng) : null;
            return { r, d, name: folded };
        });
    const byName = (a: typeof rows[number], b: typeof rows[number]) => {
        if (a.name !== b.name) {
            if (a.name === null) return 1;
            if (b.name === null) return -1;
            return a.name < b.name ? -1 : 1;
        }
        return a.r.key < b.r.key ? -1 : a.r.key > b.r.key ? 1 : 0;
    };
    rows.sort((a, b) => {
        if (query.point && a.d !== b.d) {
            if (a.d === null) return 1;
            if (b.d === null) return -1;
            return a.d - b.d;
        }
        return byName(a, b);
    });
    const page = rows.slice(query.offset, query.offset + query.limit)
        .map(x => toCommunity(x.r, x.d === null ? null : Math.round(x.d * 10) / 10));
    return { communities: page, total: rows.length };
}

/** How many communities are listed. */
export function listedCommunityCount(): number {
    return listed().length;
}

/** A listed community with a place, and when this node first saw it. */
export interface FirstSighting { key: string; lat: number; lng: number; radiusKm: number | null; firstSeenAt: string }

/**
 * The listed communities with a place first seen from `since` to `until`, for the place watches' notices
 * (engine/place-watches.ts). A run stamps every community it sees for the first time with the same `first_seen_at`, so
 * those first seen together are one run's: a run's worth with more than `batchMax` places is left out whole (a flood).
 * A community of that run that has left the registry since still counts toward it (its place was scrubbed, not its
 * sighting), so leaving never turns a flood into news.
 */
export function firstSightings(since: string, until: string, batchMax: number): FirstSighting[] {
    const rows = db.prepare(`SELECT community_key, lat, lng, radius_km, first_seen_at FROM directory_cache
        WHERE listed = 1 AND lat IS NOT NULL AND lng IS NOT NULL AND first_seen_at >= ? AND first_seen_at <= ?`)
        .all(since, until) as Array<{ community_key: string; lat: number; lng: number; radius_km: number | null; first_seen_at: string }>;
    if (rows.length === 0) return [];
    const floods = new Set((db.prepare(`SELECT first_seen_at FROM directory_cache
        WHERE first_seen_at >= ? AND first_seen_at <= ? AND (lat IS NOT NULL OR listed = 0)
        GROUP BY first_seen_at HAVING COUNT(*) > ?`).all(since, until, batchMax) as { first_seen_at: string }[]).map(r => r.first_seen_at));
    return rows.filter(r => !floods.has(r.first_seen_at))
        .map(r => ({ key: r.community_key, lat: r.lat, lng: r.lng, radiusKm: r.radius_km, firstSeenAt: r.first_seen_at }));
}

// ── the mirror's status ──────────────────────────────────────────────────────────────────────────────────────────

/** Kept in node_config (`directoryMirror`), so a restart still knows how fresh the cache is. */
export interface MirrorStatus {
    /** The last fetch that succeeded, whatever it changed. The communities ETag is made from it. */
    fetchedAt: string | null;
    lastAttemptAt: string | null;
    /** Why the last run failed, for the operator's log and Settings; never in a public response. */
    lastError: string | null;
}

const STATUS_KEY = 'directoryMirror';

export function readMirrorStatus(): MirrorStatus {
    const empty: MirrorStatus = { fetchedAt: null, lastAttemptAt: null, lastError: null };
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(STATUS_KEY) as { value?: string } | undefined;
    if (!row?.value) return empty;
    try {
        const v = JSON.parse(row.value);
        const s = (k: keyof MirrorStatus) => (typeof v?.[k] === 'string' ? v[k] : null);
        return { fetchedAt: s('fetchedAt'), lastAttemptAt: s('lastAttemptAt'), lastError: s('lastError') };
    } catch {
        return empty;
    }
}

export function writeMirrorStatus(patch: Partial<MirrorStatus>): MirrorStatus {
    const next = { ...readMirrorStatus(), ...patch };
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(STATUS_KEY, JSON.stringify(next));
    return next;
}

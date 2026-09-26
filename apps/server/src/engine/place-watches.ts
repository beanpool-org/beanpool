/**
 * Place watches (global node G5, design §3.5): "tell me when a community starts near here". Most people who arrive at
 * the global node will have no community near them yet; a watch is how they hear when one appears.
 *
 * - A member's own, set, listed and removed only with their own signed request (routes/global-directory.ts). The
 *   member comes from the signature, never the body. At most PLACE_WATCH_LIMIT each.
 * - Stored as the 0.1° cell (roundToArea, the rounding G4 uses for a person's area), rounded BEFORE the write, so the
 *   spot a phone sent never reaches the disk. The same cell again changes that watch's radius, not a second watch.
 * - A community reaches a watch when its centre is within the watch's radius plus its own service radius (counted up
 *   to SERVICE_REACH_CAP_KM, so a row claiming to serve half the Earth can't reach every watcher).
 * - Gone with the member on a prune or a self-deletion, moved on a re-key.
 *
 * ## Who is owed a notice, and when it counts as sent
 *
 * Worked out afresh at every mirror run (owedNotices) from what this node already keeps, so nothing about a notice is
 * stored but the member's last one: a member is owed the listed communities first seen here (`first_seen_at`,
 * engine/directory-cache.ts) that reach a watch of theirs set before that sighting, at least a quiet day after they
 * last heard (`last_notified_at`), and no longer ago than PLACE_WATCH_NOTICE_KEEP_MS. A community is first seen once in
 * the life of the database, and a notice stamps the member's last one, so nobody hears about a community twice; a watch
 * set after a community was first seen never hears about it (it was already there to find). The watch's radius and the
 * community's place are read as they are at the run.
 *
 * Everything a member is owed goes in one notice: one push and one live announcement to their own sockets. It counts,
 * and is stamped, only when it reached them: a push handed to the push service for a phone of theirs, or the
 * announcement written to an open socket of theirs. One that reached nobody (no phone of theirs has registered its
 * push token here, no socket open, their Marketplace notifications off) spends nothing: it waits for a push to be
 * able to reach them. Their phone registering its token (notifyOwedPlaceWatcher) tells them then, or the next run
 * does, once. After PLACE_WATCH_NOTICE_KEEP_MS it is dropped rather than told late: the community has been on the card
 * that long.
 *
 * A run compares the week's sightings only with the watches of members a push reaches now, and only near each watch
 * (owedFrom, SightingIndex); every other watch only with that run's new communities, so a socket alone is told only of
 * those. The registry is open, so the week can be full of rows placed where they reach nobody: they cost a run nothing
 * per watch unless they are near it.
 *
 * ## A standby holds every watch (mergeReplicatedWatches)
 *
 * Nothing re-creates a watch: the member set it once. So watches travel to a standby with the rest of the member's
 * data (SyncPayload.placeWatches), watermarked on `updated_at`, which every change stamps: a set, a radius change, a
 * notice (`last_notified_at`) and a re-key. Each removal (the member's own, a prune, a self-deletion, a cell both keys
 * of a re-key watched) writes a `place_watches` tombstone keyed by the watch's id, which is never used again. A
 * server that takes over therefore has every watch as of its last copy, each member's quiet day with it. And it knows
 * which communities the old one had already seen, and when (directory_cache travels too), so it tells a watcher only
 * about communities that are new to both, and still owes what the old one owed. The one gap is the copy's own: a
 * community the old main server first saw after the standby's last copy (a pull a minute) is new again to the new one,
 * so a watcher it reaches can hear about it a second time, once.
 *
 * Push tokens don't travel (each server holds its own), and a take-over restarts the server, so its first mirror run,
 * 10 s after boot, finds no phone registered and usually no socket open: it tells nobody and stamps nothing. Each
 * watcher is told when their phone registers its token here (the app does when it starts), or at the first run after.
 *
 * ## The registry is open, so a notice is plain and rare
 *
 * Anyone with a node key (free to make) can publish a row to the public registry, name and place included, and a
 * notice lands on a stranger's lock screen as coming from BeanPool. So:
 *   - a notice carries no text from the registry: how many, how far, and the keys for the app to find them. The names
 *     are on the landing card, as they are on the website's map;
 *   - a member hears at most once a day (PLACE_WATCH_NOTICE_GAP_MS). A community first seen in their quiet day is not
 *     pushed to them; it is on the card, which is where a notice leads anyway;
 *   - a run that brings more than PLACE_WATCH_FLOOD new communities with a place tells nobody about them, then or
 *     later, and says so in the log: that many at once is a flood, not communities starting.
 * Verified listings (the registrar vouching for an address) would let a notice name the community; not built here.
 */
import crypto from 'node:crypto';
import { db, writeTombstone } from '../db/db.js';
import { EARTH_RADIUS_KM, haversineKm, type SyncPlaceWatch } from '@beanpool/engine';
import { roundToArea } from './member-area.js';
import { firstSightings, type DirectoryRow, type FirstSighting } from './directory-cache.js';

export const PLACE_WATCH_LIMIT = 3;
export const PLACE_WATCH_RADIUS_KM = { min: 10, max: 200, default: 50 } as const;
/** How much of a community's own service radius counts toward reaching a watch. */
export const SERVICE_REACH_CAP_KM = 100;
/** At most this many community keys ride in one notice's data. */
const KEYS_IN_NOTICE = 10;
/** A member hears about new communities near them at most once in this long. */
export const PLACE_WATCH_NOTICE_GAP_MS = 24 * 60 * 60 * 1000;
/** A notice that has reached nobody yet is owed this long after the community's first sighting, then dropped. */
export const PLACE_WATCH_NOTICE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** More new communities with a place than this in one run is a flood, and nobody is told about them. */
export const PLACE_WATCH_FLOOD = 25;

export interface PlaceWatch {
    id: string;
    /** The 0.1° cell. */
    lat: number;
    lng: number;
    radiusKm: number;
    createdAt: string;
}

interface WatchRecord { id: string; pubkey: string; lat: number; lng: number; radius_km: number; created_at: string; last_notified_at: string | null; updated_at: string }

const toWatch = (w: WatchRecord): PlaceWatch => ({ id: w.id, lat: w.lat, lng: w.lng, radiusKm: w.radius_km, createdAt: w.created_at });

export class PlaceWatchLimitError extends Error {
    readonly code = 'watch_limit';
    readonly status = 409;
    constructor() {
        super(`You can watch up to ${PLACE_WATCH_LIMIT} places. Remove one to watch another.`);
        this.name = 'PlaceWatchLimitError';
    }
}

/** A member's own watches, oldest first. */
export function listPlaceWatches(pubkey: string): PlaceWatch[] {
    return (db.prepare('SELECT * FROM place_watches WHERE pubkey = ? ORDER BY created_at, id').all(pubkey) as WatchRecord[]).map(toWatch);
}

/**
 * Sets a watch on the cell holding `point` (the same cell again: its radius), and returns what is stored. The point is
 * rounded here, before any write. Throws PlaceWatchLimitError for a new cell past the limit. The caller has checked
 * the point is on the Earth and the radius is within PLACE_WATCH_RADIUS_KM.
 */
export function setPlaceWatch(pubkey: string, point: { lat: number; lng: number }, radiusKm: number): { watch: PlaceWatch; created: boolean } {
    const lat = roundToArea(point.lat);
    const lng = roundToArea(point.lng);
    return db.transaction(() => {
        const now = new Date().toISOString();
        const same = db.prepare('SELECT * FROM place_watches WHERE pubkey = ? AND lat = ? AND lng = ?').get(pubkey, lat, lng) as WatchRecord | undefined;
        if (same) {
            if (same.radius_km !== radiusKm) db.prepare('UPDATE place_watches SET radius_km = ?, updated_at = ? WHERE id = ?').run(radiusKm, now, same.id);
            return { watch: toWatch({ ...same, radius_km: radiusKm }), created: false };
        }
        const count = (db.prepare('SELECT COUNT(*) AS n FROM place_watches WHERE pubkey = ?').get(pubkey) as { n: number }).n;
        if (count >= PLACE_WATCH_LIMIT) throw new PlaceWatchLimitError();
        const row: WatchRecord = { id: crypto.randomUUID(), pubkey, lat, lng, radius_km: radiusKm, created_at: now, last_notified_at: null, updated_at: now };
        db.prepare('INSERT INTO place_watches (id, pubkey, lat, lng, radius_km, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(row.id, row.pubkey, row.lat, row.lng, row.radius_km, row.created_at, row.updated_at);
        return { watch: toWatch(row), created: true };
    })();
}

/** Deletes these watches, each with its tombstone, so the standby deletes them too. */
function deleteWatches(ids: string[]): void {
    const del = db.prepare('DELETE FROM place_watches WHERE id = ?');
    for (const id of ids) {
        del.run(id);
        writeTombstone('place_watches', id);
    }
}

const idsOf = (pubkey: string): string[] =>
    (db.prepare('SELECT id FROM place_watches WHERE pubkey = ?').all(pubkey) as { id: string }[]).map(r => r.id);

/** Removes a member's own watch. False when they have no watch with that id (another member's included). */
export function removePlaceWatch(pubkey: string, id: string): boolean {
    return db.transaction(() => {
        if (!db.prepare('SELECT 1 FROM place_watches WHERE id = ? AND pubkey = ?').get(id, pubkey)) return false;
        deleteWatches([id]);
        return true;
    })();
}

/** A prune or a self-deletion: the member's watches go with them. */
export function dropPlaceWatches(pubkey: string): void {
    db.transaction(() => deleteWatches(idsOf(pubkey)))();
}

/** A re-key: the member's watches move to their new key (a cell both keys watch is kept once), their quiet day with them. */
export function movePlaceWatches(oldPubkey: string, newPubkey: string): void {
    db.transaction(() => {
        db.prepare('UPDATE OR IGNORE place_watches SET pubkey = ?, updated_at = ? WHERE pubkey = ?').run(newPubkey, new Date().toISOString(), oldPubkey);
        deleteWatches(idsOf(oldPubkey));
    })();
}

// ── on a standby ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface WatchMerge { written: number; kept: number; skipped: number; invalid: number }

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isIn = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * The main server's watches as a copy carries them (SyncPayload.placeWatches), merged into this standby's database
 * inside the import's transaction (engine/sync.ts), after the members. Per watch, the newer `updated_at` wins, and
 * everything the main server's row says is taken as it is: member (a re-key moved it), radius, and last notice.
 *
 * - A watch whose member this database doesn't have is skipped: nobody here could hear from it or remove it.
 * - A watch this database has a tombstone for was removed, and ids are never used again: it stays removed.
 * - The cell is rounded again, so the spot never reaches this disk either, whatever arrives.
 * - The main server holds one watch per member and cell, so another watch of this member on the same cell is gone
 *   there (its tombstone may be later in this copy): it goes, or the unique cell would refuse the newer one.
 * - A row that is malformed, or that this database refuses for any reason, is left out and counted. It never fails
 *   the copy it came in.
 */
export function mergeReplicatedWatches(watches: unknown): WatchMerge {
    const merge: WatchMerge = { written: 0, kept: 0, skipped: 0, invalid: 0 };
    if (!Array.isArray(watches) || watches.length === 0) return merge;
    const memberExists = db.prepare('SELECT 1 FROM members WHERE public_key = ?');
    const current = db.prepare('SELECT updated_at FROM place_watches WHERE id = ?');
    const removed = db.prepare("SELECT 1 FROM tombstones WHERE table_name = 'place_watches' AND row_key = ?");
    const sameCell = db.prepare('DELETE FROM place_watches WHERE pubkey = ? AND lat = ? AND lng = ? AND id != ?');
    const upsert = db.prepare(`INSERT INTO place_watches (id, pubkey, lat, lng, radius_km, created_at, last_notified_at, updated_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                               ON CONFLICT(id) DO UPDATE SET
                                   pubkey = excluded.pubkey, lat = excluded.lat, lng = excluded.lng, radius_km = excluded.radius_km,
                                   created_at = excluded.created_at, last_notified_at = excluded.last_notified_at,
                                   updated_at = excluded.updated_at`);
    db.transaction(() => {
        for (const raw of watches) {
            const w = raw as Partial<SyncPlaceWatch> | null;
            if (!w || !isText(w.id, 64) || !isText(w.pubkey, 128) || !isIn(w.lat, -90, 90) || !isIn(w.lng, -180, 180)
                || !isIn(w.radiusKm, Number.MIN_VALUE, PLACE_WATCH_RADIUS_KM.max) || !isText(w.createdAt, 40) || !isText(w.updatedAt, 40)
                || !(w.lastNotifiedAt === null || w.lastNotifiedAt === undefined || isText(w.lastNotifiedAt, 40))) {
                merge.invalid++;
                continue;
            }
            if (!memberExists.get(w.pubkey) || removed.get(w.id)) { merge.skipped++; continue; }
            const here = current.get(w.id) as { updated_at: string | null } | undefined;
            if (here?.updated_at && here.updated_at > w.updatedAt) { merge.kept++; continue; }
            const lat = roundToArea(w.lat);
            const lng = roundToArea(w.lng);
            try {
                sameCell.run(w.pubkey, lat, lng, w.id);
                upsert.run(w.id, w.pubkey, lat, lng, w.radiusKm, w.createdAt, w.lastNotifiedAt ?? null, w.updatedAt);
                merge.written++;
            } catch (e: any) {
                console.warn(`[Place watches] A copied watch could not be stored here, left out: ${e?.message || e}`);
                merge.invalid++;
            }
        }
    })();
    return merge;
}

// ── telling watchers ─────────────────────────────────────────────────────────────────────────────────────────────

/** Returns how many open sockets it was written to. */
type BroadcastFn = (event: any, recipients?: string[]) => number;
/** Returns how many notifications it handed to the push service. */
type PushFn = (targetPubkeys: string[], actorPubkey: string, title: string, body: string, data: Record<string, any>, categoryId: 'chat' | 'marketplace' | 'escrow' | 'recovery') => number;

export interface PlaceWatchNoticeCallbacks {
    broadcast: BroadcastFn;
    dispatchPushNotification: PushFn;
    /** A member who may still hear from this node (not pruned, not a replaced key). */
    isMember: (pubkey: string) => boolean;
    /** The members a marketplace push would reach now (a phone registered here, the category on); only `pubkey`, when given. */
    pushable: (pubkey?: string) => ReadonlySet<string>;
}

export const COMMUNITY_NEAR_TITLE = '🌱 A community near you';
export const COMMUNITIES_NEAR_TITLE = '🌱 Communities near you';

// No registry text in either (see the header): the count and the distance only.
export function communityNearBody(km: number): string {
    return `A new community is now in the BeanPool directory, about ${km} km from a place you're watching.`;
}

export function communitiesNearBody(count: number, km: number): string {
    return `${count} new communities are now in the BeanPool directory near a place you're watching. The nearest is about ${km} km away.`;
}

// ── which sightings can reach a watch ────────────────────────────────────────────────────────────────────────────

/** A community first seen, as a run compares it with the watches. */
export interface Sighting {
    c: FirstSighting;
    seenMs: number;
    /** How much of its own service radius counts toward reaching a watch: up to SERVICE_REACH_CAP_KM, none if it has none. */
    extraKm: number;
}

export function toSighting(c: FirstSighting): Sighting {
    const r = c.radiusKm ?? 0;
    return { c, seenMs: Date.parse(c.firstSeenAt), extraKm: r > 0 ? Math.min(r, SERVICE_REACH_CAP_KM) : 0 };
}

const KM_PER_DEGREE = EARTH_RADIUS_KM * Math.PI / 180;
const RADIANS = Math.PI / 180;
/** The index's rows, in degrees of latitude. A watch reaches at most 300 km, about 2.7°: two to four rows. */
const ROW_DEGREES = 2;
const ROWS = 180 / ROW_DEGREES + 1;
const rowOf = (lat: number): number => Math.min(ROWS - 1, Math.max(0, Math.floor((lat + 90) / ROW_DEGREES)));

/**
 * One run's sightings by place, so a watch compares only those near enough to reach it and a sighting far from every
 * watch costs each one nothing, however many there are (#1202 review 4112143174). Rows of latitude, each sorted by
 * longitude: a watch looks in the rows its reach spans and, in each, at the longitudes its reach spans (a binary
 * search), then measures what it finds (haversineKm) as before.
 *
 * It may leave out only a sighting that can't reach, so it bounds with a kilometre to spare against rounding, and:
 *   - north and south: two places are never nearer than the difference in their latitudes (along the meridian);
 *   - east and west: every place within an angle δ of a watch at latitude φ is within asin(sin δ / cos φ) of its
 *     longitude, as long as that circle doesn't take in a pole. When it does (|φ| + δ ≥ 90°), every longitude counts;
 *   - longitudes wrap at ±180°: a watch by the antimeridian looks on both sides of it.
 * Every stored place is on the Earth (the checks on place_watches, normaliseRegistryRow for a community).
 */
export class SightingIndex {
    private readonly rows: Sighting[][] = Array.from({ length: ROWS }, () => []);
    /** The most any sighting here adds to a watch's radius. */
    private readonly extraKm: number = 0;

    constructor(sightings: readonly Sighting[]) {
        for (const s of sightings) {
            this.rows[rowOf(s.c.lat)].push(s);
            if (s.extraKm > this.extraKm) this.extraKm = s.extraKm;
        }
        for (const row of this.rows) row.sort((a, b) => a.c.lng - b.c.lng);
    }

    /** Visits every sighting that can reach a watch of `radiusKm` at `lat`, `lng` (and a few that can't), once each. */
    near(lat: number, lng: number, radiusKm: number, visit: (s: Sighting) => void): void {
        const reach = (radiusKm + this.extraKm + 1) / KM_PER_DEGREE;
        if (!(reach >= 0 && Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) {
            for (const row of this.rows) for (const s of row) visit(s);
            return;
        }
        const span = Math.abs(lat) + reach >= 90 ? 180 : Math.asin(Math.sin(reach * RADIANS) / Math.cos(lat * RADIANS)) / RADIANS;
        const west = lng - span, east = lng + span;
        for (let r = rowOf(lat - reach); r <= rowOf(lat + reach); r++) {
            const row = this.rows[r];
            if (row.length === 0) continue;
            if (span >= 180) {
                scanRow(row, -180, 180, lat, reach, visit);
            } else if (west < -180) {
                scanRow(row, west + 360, 180, lat, reach, visit);
                scanRow(row, -180, east, lat, reach, visit);
            } else if (east > 180) {
                scanRow(row, west, 180, lat, reach, visit);
                scanRow(row, -180, east - 360, lat, reach, visit);
            } else {
                scanRow(row, west, east, lat, reach, visit);
            }
        }
    }
}

/** A row's sightings from longitude `west` to `east`, within `reach` degrees of latitude of `lat`. */
function scanRow(row: readonly Sighting[], west: number, east: number, lat: number, reach: number, visit: (s: Sighting) => void): void {
    let lo = 0, hi = row.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (row[mid].c.lng < west) lo = mid + 1;
        else hi = mid;
    }
    for (let i = lo; i < row.length && row[i].c.lng <= east; i++) {
        if (Math.abs(row[i].c.lat - lat) <= reach) visit(row[i]);
    }
}

// ── who is owed what ─────────────────────────────────────────────────────────────────────────────────────────────

export type Owed = Map<string, { c: FirstSighting; km: number }>;

/** A watch as the notices read it. */
export type NoticeWatch = Pick<WatchRecord, 'pubkey' | 'lat' | 'lng' | 'radius_km' | 'created_at' | 'last_notified_at'>;

/**
 * What each member is owed at `nowMs` (see the header), by member: each community once, at its nearest to one of their
 * watches. `week` is every sighting still owed (firstSightings); `fresh` the keys of this run's new communities.
 *
 * Only a member a push reaches now (`pushable`) is compared with the whole week: anyone else has no phone to be told
 * on, so what an earlier run owed them waits, within the week, for one to register its token (notifyOwedPlaceWatcher
 * and the next run then find it). They are compared with this run's new communities only, as before notices waited,
 * and are told of those on an open socket. So however many rows fill the week, a run compares them only with the
 * watches of members who can hear, and only near those watches (SightingIndex).
 */
export function owedFrom(watches: readonly NoticeWatch[], week: readonly Sighting[], fresh: ReadonlySet<string>,
    pushable: ReadonlySet<string>, nowMs: number): Map<string, Owed> {
    const byMember = new Map<string, Owed>();
    const everyone = new SightingIndex(week);
    const thisRun = new SightingIndex(week.filter(s => fresh.has(s.c.key)));
    const lastHeard = new Map<string, number>();
    for (const w of watches) {
        const t = w.last_notified_at ? Date.parse(w.last_notified_at) : NaN;
        if (Number.isFinite(t)) lastHeard.set(w.pubkey, Math.max(lastHeard.get(w.pubkey) ?? t, t));
    }
    for (const w of watches) {
        const last = lastHeard.get(w.pubkey);
        // In their quiet day: nothing now.
        if (last !== undefined && nowMs - last < PLACE_WATCH_NOTICE_GAP_MS) continue;
        const setMs = Date.parse(w.created_at);
        if (!Number.isFinite(setMs)) continue;
        (pushable.has(w.pubkey) ? everyone : thisRun).near(w.lat, w.lng, w.radius_km, ({ c, seenMs, extraKm }) => {
            // Set after the community was first seen: it was already there to find.
            if (seenMs <= setMs) return;
            // First seen before they last heard (told then) or in the quiet day after it (not pushed, on the card).
            if (last !== undefined && seenMs - last < PLACE_WATCH_NOTICE_GAP_MS) return;
            const d = haversineKm(w.lat, w.lng, c.lat, c.lng);
            if (d > w.radius_km + extraKm) return;
            const found: Owed = byMember.get(w.pubkey) ?? new Map();
            const prev = found.get(c.key);
            if (!prev || d < prev.km) found.set(c.key, { c, km: d });
            byMember.set(w.pubkey, found);
        });
    }
    return byMember;
}

/** What each member is owed at `now` (owedFrom), from the database. Only `pubkey`'s, when given. */
function owedNotices(cb: PlaceWatchNoticeCallbacks, now: string, fresh: ReadonlySet<string>, pubkey?: string): Map<string, Owed> {
    const nowMs = Date.parse(now);
    const week = firstSightings(new Date(nowMs - PLACE_WATCH_NOTICE_KEEP_MS).toISOString(), now, PLACE_WATCH_FLOOD).map(toSighting);
    if (week.length === 0) return new Map();
    const columns = 'pubkey, lat, lng, radius_km, created_at, last_notified_at';
    const watches = (pubkey === undefined
        ? db.prepare(`SELECT ${columns} FROM place_watches`).all()
        : db.prepare(`SELECT ${columns} FROM place_watches WHERE pubkey = ?`).all(pubkey)) as NoticeWatch[];
    if (watches.length === 0) return new Map();
    return owedFrom(watches, week, fresh, cb.pushable(pubkey), nowMs);
}

/**
 * Tells each member what they are owed at `now` (owedNotices; only `pubkey`, when given), in one notice: one push
 * (marketplace category, so their Marketplace notification setting applies) and one `system_announcement` to their own
 * sockets. Stamped only when it reached them (see the header). Returns how many members it reached.
 */
function tellOwed(cb: PlaceWatchNoticeCallbacks, now: string, fresh: ReadonlySet<string>, pubkey?: string): number {
    // Stamped, so the quiet day travels to a standby with the watch, and nothing in this notice is owed again.
    const heard = db.prepare('UPDATE place_watches SET last_notified_at = ?, updated_at = ? WHERE pubkey = ?');
    let told = 0;
    for (const [member, found] of owedNotices(cb, now, fresh, pubkey)) {
        if (!cb.isMember(member)) continue;
        const near = [...found.values()].sort((a, b) => a.km - b.km || (a.c.key < b.c.key ? -1 : 1));
        const km = Math.max(1, Math.round(near[0].km));
        const title = near.length === 1 ? COMMUNITY_NEAR_TITLE : COMMUNITIES_NEAR_TITLE;
        const body = near.length === 1 ? communityNearBody(km) : communitiesNearBody(near.length, km);
        const data = { kind: 'community_near_you', communities: near.slice(0, KEYS_IN_NOTICE).map(n => n.c.key) };
        let reached = false;
        try {
            reached = cb.broadcast({ type: 'system_announcement', title, body, severity: 'info', ...data }, [member]) > 0;
        } catch (e: any) {
            console.warn('[Place watches] Live notice failed:', e?.message || e);
        }
        try {
            reached = cb.dispatchPushNotification([member], 'SYSTEM', title, body, data, 'marketplace') > 0 || reached;
        } catch (e: any) {
            console.warn('[Place watches] Push failed:', e?.message || e);
        }
        // No phone of theirs registered here and no socket of theirs open: nothing is spent, and it is still owed.
        if (!reached) continue;
        heard.run(now, new Date().toISOString(), member);
        told++;
    }
    return told;
}

/**
 * A mirror run (services/directory-mirror.ts), after it wrote `added`, the communities it saw for the first time at
 * `now`: every member owed a notice is told (tellOwed), for this run's communities and, if a push reaches them now,
 * any still owed from earlier ones (owedFrom). A run whose new communities are a flood says so here; they are left out
 * of every notice (firstSightings).
 * Returns how many members it reached.
 */
export function notifyPlaceWatchers(cb: PlaceWatchNoticeCallbacks, added: readonly DirectoryRow[], now: string): number {
    const placed = added.filter(c => c.lat !== null && c.lng !== null).length;
    if (placed > PLACE_WATCH_FLOOD) {
        console.warn(`[Place watches] ⚠️ ${placed} new communities with a place in one run, more than ${PLACE_WATCH_FLOOD}: `
            + 'a flood, not communities starting, so no watcher is told about them. They are listed as usual.');
    }
    return tellOwed(cb, now, new Set(added.map(c => c.key)));
}

/** A member's phone registered its push token here: they are told what they are owed now, not at the next run. */
export function notifyOwedPlaceWatcher(cb: PlaceWatchNoticeCallbacks, pubkey: string): boolean {
    return tellOwed(cb, new Date().toISOString(), new Set(), pubkey) > 0;
}

/**
 * A person's coarse area (global node G4, design §3.2): opt-in, so the People list can say how far away someone is
 * without ever saying where they are. The global node is a public lobby for strangers; hostile attention is plausible,
 * so a person's position is never learnable to better than a coarse area.
 *
 * - Set and cleared by the member alone, with their own signed request (POST /api/community/me/area,
 *   routes/community.ts). The actor comes from the signature, never the body.
 * - Rounded to 0.1° of latitude and of longitude (about 11 km north-south; east-west it narrows towards the poles, 5.5 km
 *   at 60°) BEFORE it is written, so a precise position never reaches the disk, the write-ahead log included.
 * - Read back by its member alone (GET /api/community/me), and used for their own set of listings (routes/marketplace.ts,
 *   `nearby=1`). Anyone else gets a distance in whole km from the People list, and only as a signed member. Distances
 *   from many points can at best find the 0.1° cell, never anything finer: that is why the rounding happens before the
 *   write and not on the way out.
 * - Published, on a node that syncs by area (the global profile's `nearbyListings`), as the place of each listing its
 *   member posts with no place, or edits to have none (engine/posts.ts placelessListingArea; DESIGN-global-sync-by-area
 *   §3.4, Q4: Marty, 2026-10-09). Such a listing's lat/lng IS the area, exactly, to every reader of that listing, an
 *   unsigned visitor included. The posting form is to say so (S4); until it does, a member posting with no pin there
 *   publishes their area without being told.
 * - Kept in members.area_lat / area_lng / area_updated_at, never in members.lat / lng: those are an enterprise's public,
 *   precise, signer-stamped map location, read by the map and the treasury routes.
 *
 * Every reader of the three columns: this module (the member's own read, the People list's distances, and the map that
 * decides which members a listing's push reaches on a node that syncs by area, below), engine/posts.ts (a placeless
 * listing's place, above), the replication export and import (beanpool-engine sync.ts, engine/sync.ts: a
 * standby and so a take-over, the same trust as the database file), and file and sealed backups (the database itself).
 * Nothing else reads them: not the member directory, profiles, federation, the public directory, the map or the
 * activity feed.
 */
import { db, afterTransactionCommit } from '../db/db.js';
import { haversineKm, roundToArea } from '@beanpool/engine';
import { bumpMembersVersion } from './versions.js';

// The 0.1° rounding lives in the engine (geo.ts), beside the SQL `area_km` that measures posts the same way for a
// visitor on the global node: one rule and one implementation for a person's area and a post's.
export { roundToArea };

export interface MemberArea {
    lat: number;
    lng: number;
    updatedAt: string | null;
}

/** A place on the Earth: two finite numbers, latitude within ±90 and longitude within ±180. */
export function isPoint(lat: unknown, lng: unknown): lat is number {
    return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)
        && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/** The member's own area, or null. For them alone. */
export function readMemberArea(publicKey: string): MemberArea | null {
    const row = db.prepare('SELECT area_lat, area_lng, area_updated_at FROM members WHERE public_key = ?').get(publicKey) as
        { area_lat: number | null; area_lng: number | null; area_updated_at: string | null } | undefined;
    if (!row || row.area_lat == null || row.area_lng == null) return null;
    return { lat: row.area_lat, lng: row.area_lng, updatedAt: row.area_updated_at };
}

/**
 * Sets (a point) or clears (null) a member's area and returns what is stored. The point is rounded here, before the
 * write. Asking for what is already stored writes nothing, so a phone that sends its area on every start doesn't churn
 * the row or delta sync.
 */
export function setMemberArea(publicKey: string, point: { lat: number; lng: number } | null): MemberArea | null {
    const lat = point ? roundToArea(point.lat) : null;
    const lng = point ? roundToArea(point.lng) : null;
    const current = readMemberArea(publicKey);
    if ((current?.lat ?? null) === lat && (current?.lng ?? null) === lng) return current;
    const now = new Date().toISOString();
    db.prepare('UPDATE members SET area_lat = ?, area_lng = ?, area_updated_at = ?, updated_at = ? WHERE public_key = ?')
        .run(lat, lng, point ? now : null, now, publicKey);
    // The People list's ETag: a list read with a point must not answer 304 with the old distances.
    bumpMembersVersion();
    // And the listing pushes: from the next event on, this member hears what is near the new area.
    refreshMemberAreas([publicKey]);
    return readMemberArea(publicKey);
}

/**
 * The People list from a point: each member's distance in whole km (null without an area), nearest first, and the
 * members without an area after them in the order they came. Never a coordinate.
 */
export function withAreaDistances<T extends { publicKey: string }>(people: T[], lat: number, lng: number): Array<T & { distanceKm: number | null }> {
    const rows = db.prepare('SELECT public_key, area_lat, area_lng FROM members WHERE area_lat IS NOT NULL AND area_lng IS NOT NULL').all() as
        { public_key: string; area_lat: number; area_lng: number }[];
    const km = new Map(rows.map(r => [r.public_key, Math.round(haversineKm(lat, lng, r.area_lat, r.area_lng))]));
    return people
        .map((p, i) => ({ p: { ...p, distanceKm: km.get(p.publicKey) ?? null }, i }))
        .sort((a, b) => {
            const da = a.p.distanceKm, dbKm = b.p.distanceKm;
            if (da === null || dbKm === null) return da === dbKm ? a.i - b.i : da === null ? 1 : -1;
            return da - dbKm || a.i - b.i;
        })
        .map(x => x.p);
}

/**
 * A replicated member's area as a standby writes it: [area_lat, area_lng, area_updated_at]. Both or neither, rounded
 * again (nothing for what a main server wrote) and in range, so a payload can neither place anyone more precisely nor
 * fail the import on the columns' checks. A main server from before G4 sends none, and never had any.
 */
export function importedArea(rm: { areaLat?: unknown; areaLng?: unknown; areaUpdatedAt?: unknown }): [number | null, number | null, string | null] {
    if (!isPoint(rm.areaLat, rm.areaLng)) return [null, null, null];
    const at = typeof rm.areaUpdatedAt === 'string' && rm.areaUpdatedAt ? rm.areaUpdatedAt : null;
    return [roundToArea(rm.areaLat), roundToArea(rm.areaLng as number), at];
}

/**
 * Every member's area, in memory, for the listing pushes of a node that syncs by area (state-engine.ts listingReach,
 * DESIGN-global-sync-by-area §2.5): one lookup per socket per listing event, never a read of the table. Loaded from
 * `members` at boot (loadMemberAreas) or on first use, and kept by every writer of the area: setMemberArea, the
 * replication import (engine/sync.ts), a re-key (engine/key-move.ts moveMemberKeyRows moves the row to the new key, on
 * the main server and on a standby following it) and a member's removal (a prune or a Delete account clears it;
 * state-engine.ts refreshes the key on user_pruned), each through refreshMemberAreas.
 */
let areasByKey: Map<string, { lat: number; lng: number }> | null = null;

/**
 * Told of every change to the map, right after it: the keys read again, or null when it was loaded again whole. The
 * sockets' index by area (ws-area-index.ts) files each open socket's member by this map, so it moves with it.
 */
type AreaListener = (keys: string[] | null) => void;
const areaListeners: AreaListener[] = [];
export function onMemberAreasChanged(listener: AreaListener): void {
    areaListeners.push(listener);
}

/** Loads the map if nothing has yet. */
export function memberAreasReady(): void {
    if (!areasByKey) loadMemberAreas();
}

/** Loads (or loads again) every member's area from the table. */
export function loadMemberAreas(): void {
    const rows = db.prepare('SELECT public_key, area_lat, area_lng FROM members WHERE area_lat IS NOT NULL AND area_lng IS NOT NULL').all() as
        { public_key: string; area_lat: number; area_lng: number }[];
    areasByKey = new Map(rows.map(r => [r.public_key, { lat: r.area_lat, lng: r.area_lng }]));
    for (const listener of areaListeners) listener(null);
}

/** A member's area as the pushes see it (the map above), or undefined. */
export function memberAreaFor(publicKey: string): { lat: number; lng: number } | undefined {
    if (!areasByKey) loadMemberAreas();
    return areasByKey!.get(publicKey);
}

/**
 * Reads these members' areas from the table into the map, after any write of them: once the transaction in hand (an
 * import's) commits, so one that unwinds leaves the map as the table is. Nothing before the map is loaded.
 */
export function refreshMemberAreas(keys: Iterable<string>): void {
    const list = [...keys];
    afterTransactionCommit(() => {
        if (!areasByKey) return;
        const read = db.prepare('SELECT area_lat, area_lng FROM members WHERE public_key = ?');
        for (const key of list) {
            const row = read.get(key) as { area_lat: number | null; area_lng: number | null } | undefined;
            if (row && row.area_lat != null && row.area_lng != null) areasByKey.set(key, { lat: row.area_lat, lng: row.area_lng });
            else areasByKey.delete(key);
        }
        for (const listener of areaListeners) listener(list);
    });
}

/**
 * A person's coarse area (global node G4, design §3.2): opt-in, so the People list can say how far away someone is
 * without ever saying where they are. The global node is a public lobby for strangers; hostile attention is plausible,
 * so a person's position is never learnable to better than a coarse area.
 *
 * - Set and cleared by the member alone, with their own signed request (POST /api/community/me/area,
 *   routes/community.ts). The actor comes from the signature, never the body.
 * - Rounded to 0.1° of latitude and of longitude (about 11 km north-south; east-west it narrows towards the poles, 5.5 km
 *   at 60°) BEFORE it is written, so a precise position never reaches the disk, the write-ahead log included.
 * - Read back by its member alone (GET /api/community/me). Anyone else gets a distance in whole km from the People list,
 *   and only as a signed member. Distances from many points can at best find the 0.1° cell, never anything finer: that
 *   is why the rounding happens before the write and not on the way out.
 * - Kept in members.area_lat / area_lng / area_updated_at, never in members.lat / lng: those are an enterprise's public,
 *   precise, signer-stamped map location, read by the map and the treasury routes.
 *
 * Every reader of the three columns: this module (the member's own read, the People list's distances), the replication
 * export and import (beanpool-engine sync.ts, engine/sync.ts: a standby and so a take-over, the same trust as the
 * database file), and file and sealed backups (the database itself). Nothing else reads them: not the member directory,
 * profiles, federation, the public directory, the map or the activity feed.
 */
import { db } from '../db/db.js';
import { haversineKm } from '@beanpool/engine';
import { bumpMembersVersion } from './versions.js';

export interface MemberArea {
    lat: number;
    lng: number;
    updatedAt: string | null;
}

/** 0.1°, to the nearest step. Never -0, which would read back as a different number from 0. */
export function roundToArea(deg: number): number {
    return Math.round(deg * 10) / 10 + 0;
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

// Distance on the Earth, for listings searched by place (global node G4, design §3.2).
//
// `haversine_km(lat1, lng1, lat2, lng2)` is a SQL function the posts listing calls (posts.ts getPosts). SQLite has
// none, so it is registered on every connection that can run that query: the node's database handle
// (apps/server/src/db/db.ts) and the engine's test fixtures. Nothing in the schema uses it — no view, index or
// trigger — so a database opened anywhere else (the sqlite3 shell, a backup probe) still opens and reads.
//
// Postgres (storage design, decision 3) runs the same SQL text: a plain-SQL function of the same name and arguments,
// no PostGIS. That is why the listing keeps its distance SQL to a function call, BETWEEN, OR and NULLS LAST.

import type Database from 'better-sqlite3';

type Db = Database.Database;

/** The mean Earth radius the apps have always used (PWA lib/geo.ts, native market-filters.ts), so a distance the
 *  node reports is the one a phone would have worked out. */
export const EARTH_RADIUS_KM = 6371;

/** Half the Earth's circumference at the equator. No two places are further apart, so no radius needs to be larger. */
export const MAX_RADIUS_KM = 20037;

const toRad = (deg: number) => deg * Math.PI / 180;
const toDeg = (r: number) => r * 180 / Math.PI;

/** Great-circle distance in km. Right across the antimeridian and at the poles: it only ever sees differences of angles. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2
        + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
    // Rounding can put `a` a hair outside [0, 1] for antipodal points; the square roots would then be NaN.
    return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)));
}

/** Registers `haversine_km` on a connection. NULL for any NULL or non-numeric argument: a post with no place has no distance. */
export function registerGeoFunctions(db: Db): void {
    db.function('haversine_km', { deterministic: true }, (lat1: unknown, lng1: unknown, lat2: unknown, lng2: unknown) => {
        if (typeof lat1 !== 'number' || typeof lng1 !== 'number' || typeof lat2 !== 'number' || typeof lng2 !== 'number') return null;
        const d = haversineKm(lat1, lng1, lat2, lng2);
        return Number.isFinite(d) ? d : null;
    });
}

/** The latitude band and longitude ranges that hold every point within a radius. One longitude range, or two where the
 *  circle crosses the antimeridian, or the whole of [-180, 180] where it covers a pole. */
export interface GeoBox {
    latMin: number;
    latMax: number;
    lngRanges: Array<[number, number]>;
}

/** A sliver added all round the box (about a centimetre), so a place exactly on the circle is never lost to rounding in
 *  the box before the exact distance decides. A wider box costs nothing but a few more rows to measure. */
const BOX_MARGIN_DEG = 1e-7;

/**
 * The smallest latitude/longitude box that holds the whole circle (J. Matuschek, "Finding points within a distance of a
 * latitude/longitude using bounding coordinates"): a prefilter an index can answer. The exact distance decides after.
 */
export function boundingBox(lat: number, lng: number, radiusKm: number): GeoBox {
    const angular = radiusKm / EARTH_RADIUS_KM;
    const dLat = toDeg(angular) + BOX_MARGIN_DEG;
    const latMin = lat - dLat;
    const latMax = lat + dLat;
    const everyLongitude: Array<[number, number]> = [[-180, 180]];
    // A circle that reaches a pole takes in every longitude there. An angular radius of 90° or more always does.
    if (latMin <= -90 || latMax >= 90) return { latMin: Math.max(-90, latMin), latMax: Math.min(90, latMax), lngRanges: everyLongitude };
    const ratio = Math.sin(angular) / Math.cos(toRad(lat));
    if (!(ratio < 1)) return { latMin, latMax, lngRanges: everyLongitude };
    const dLng = toDeg(Math.asin(ratio)) + BOX_MARGIN_DEG;
    const lo = lng - dLng;
    const hi = lng + dLng;
    if (hi - lo >= 360) return { latMin, latMax, lngRanges: everyLongitude };
    // Across the antimeridian the range wraps, and splits in two.
    if (lo < -180) return { latMin, latMax, lngRanges: [[lo + 360, 180], [-180, hi]] };
    if (hi > 180) return { latMin, latMax, lngRanges: [[lo, 180], [-180, hi - 360]] };
    return { latMin, latMax, lngRanges: [[lo, hi]] };
}

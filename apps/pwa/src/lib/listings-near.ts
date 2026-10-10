/**
 * Where the web Market and Map read listings from on a node that syncs by area (DESIGN-global-sync-by-area §5, S5).
 *
 * On such a node (`features.nearbyListings`, the worldwide community) the node's newest 50 are mostly far away, so the
 * Market and the Map ask the node for the nearest within the member's distance setting, else within the node's radius
 * of the member's stored area (`GET /api/community/me` `area`, rounded to 0.1°): `lat/lng/radiusKm/sort=distance`, which
 * the posts listing already takes (routes/distance-query.ts). The node then says how far each listing is (`distanceKm`).
 *
 * Everywhere else nothing changes: a node without the switch (a local community), a visitor (no area, the lobby's own
 * read), a member with neither a distance setting nor an area, and a member who asked to see everywhere all read
 * exactly as before.
 */
import type { RadiusSettings } from './geo';

/** The distance parameters of one listings read (lib/api.ts getMarketplacePosts). */
export interface NearRead {
    lat: number;
    lng: number;
    radiusKm: number;
    sort: 'distance';
    /** Which point it measures from: the member's distance setting, or their stored area. */
    from: 'setting' | 'area';
}

export interface NearInputs {
    /** The node's `features.nearbyListings`; absent on a node that does not sync by area. */
    nearbyListings?: { radiusKm: number } | null;
    /** The distance the member picked in this browser (lib/geo loadRadiusSettings). */
    setting: RadiusSettings | null;
    /** The member's stored area, as the node keeps it. */
    area: { lat: number; lng: number } | null;
    visitor: boolean;
    /** The member asked to see listings from everywhere for now. */
    everywhere?: boolean;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** The point and radius to read from, or null to read as before. */
export function nearRead({ nearbyListings, setting, area, visitor, everywhere }: NearInputs): NearRead | null {
    if (visitor || everywhere || !nearbyListings) return null;
    if (setting && finite(setting.lat) && finite(setting.lng) && finite(setting.radiusKm) && setting.radiusKm > 0) {
        return { lat: setting.lat, lng: setting.lng, radiusKm: setting.radiusKm, sort: 'distance', from: 'setting' };
    }
    if (area && finite(area.lat) && finite(area.lng) && finite(nearbyListings.radiusKm) && nearbyListings.radiusKm > 0) {
        return { lat: area.lat, lng: area.lng, radiusKm: nearbyListings.radiusKm, sort: 'distance', from: 'area' };
    }
    return null;
}

/** The listings-read parameters of a NearRead, or none. */
export function nearParams(near: NearRead | null): { lat?: number; lng?: number; radiusKm?: number; sort?: 'distance' } {
    return near ? { lat: near.lat, lng: near.lng, radiusKm: near.radiusKm, sort: near.sort } : {};
}

/**
 * How far a listing is: the node's `distanceKm` when it measured one, else from the viewer's own centre in the browser,
 * else unknown.
 */
export function listingDistanceKm(
    post: { distanceKm?: number | null; lat?: number; lng?: number },
    measure: ((lat: number, lng: number) => number) | null,
): number | null {
    if (finite(post.distanceKm)) return post.distanceKm;
    if (measure && post.lat != null && post.lng != null) return measure(post.lat, post.lng);
    return null;
}

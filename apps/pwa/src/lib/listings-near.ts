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
 *
 * A read from the distance setting sends its centre only as precisely as its radius needs, and asks for a tenth more
 * radius; the browser keeps the exact circle, cuts the list to it and measures from it (scratch/fable-redo/
 * verdict-privacy.md §6, N5). The stored area is a 0.1° cell by design (apps/server/src/engine/member-area.ts), and a
 * query string is what proxies, tunnels and CDNs log by default.
 */
import { haversineDistance, type RadiusSettings } from './geo';

export interface Circle { lat: number; lng: number; radiusKm: number }

/** The distance parameters of one listings read (lib/api.ts getMarketplacePosts), and the circle it stands for. */
export interface NearRead {
    /** The centre the node is sent: a setting's rounded by its radius (centreDecimals), the area as stored. */
    lat: number;
    lng: number;
    /** The radius the node is asked for: a setting's a tenth wider, so the exact circle is inside it. */
    radiusKm: number;
    sort: 'distance';
    /** Which point it measures from: the member's distance setting, or their stored area. */
    from: 'setting' | 'area';
    /**
     * The circle the member sees: the exact centre and radius they picked, or their area at the node's radius. The
     * browser cuts and measures by it; it is never sent (nearParams).
     */
    circle: Circle;
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

/**
 * A longitude in [-180, 180]. The picker's map gives unwrapped ones past the antimeridian (Tonga tapped with the map on
 * Fiji is 185), which the node refuses (routes/distance-query.ts).
 */
const wrapLng = (lng: number): number => (lng >= -180 && lng <= 180 ? lng : ((((lng + 180) % 360) + 360) % 360) - 180);

/**
 * How many decimals of a setting's centre the node is sent: the shift is at most half a unit on each axis, 7.9 m at
 * 4 dp, 79 m at 3 dp and 786 m at 2 dp on the equator (less towards the poles), so it stays under 8 % of the radius.
 * The picker's radii run from 100 m to 50 km.
 */
const centreDecimals = (radiusKm: number): number => (radiusKm < 1 ? 4 : radiusKm < 10 ? 3 : 2);

const round = (n: number, decimals: number): number => Number(n.toFixed(decimals));

/** A setting's radius a tenth wider, to the metre: more than the rounded centre can shift, so no edge is lost. */
const widened = (radiusKm: number): number => round(radiusKm * 1.1, 3);

/** The point and radius to read from, or null to read as before. */
export function nearRead({ nearbyListings, setting, area, visitor, everywhere }: NearInputs): NearRead | null {
    if (visitor || everywhere || !nearbyListings) return null;
    if (setting && finite(setting.lat) && finite(setting.lng) && finite(setting.radiusKm) && setting.radiusKm > 0) {
        const circle = { lat: setting.lat, lng: wrapLng(setting.lng), radiusKm: setting.radiusKm };
        const decimals = centreDecimals(circle.radiusKm);
        return {
            lat: round(circle.lat, decimals), lng: round(circle.lng, decimals), radiusKm: widened(circle.radiusKm),
            sort: 'distance', from: 'setting', circle,
        };
    }
    if (area && finite(area.lat) && finite(area.lng) && finite(nearbyListings.radiusKm) && nearbyListings.radiusKm > 0) {
        const circle = { lat: area.lat, lng: area.lng, radiusKm: nearbyListings.radiusKm };
        return { ...circle, sort: 'distance', from: 'area', circle };
    }
    return null;
}

/** The listings-read parameters of a NearRead, or none. Never the exact circle. */
export function nearParams(near: NearRead | null): { lat?: number; lng?: number; radiusKm?: number; sort?: 'distance' } {
    return near ? { lat: near.lat, lng: near.lng, radiusKm: near.radiusKm, sort: near.sort } : {};
}

/**
 * How far a listing is: the node's `distanceKm` when it measured one, else from the viewer's own centre in the browser,
 * else unknown. A read from the distance setting is measured in the browser first: the node measured from the rounded
 * centre it was sent, not the one the member picked.
 */
export function listingDistanceKm(
    post: { distanceKm?: number | null; lat?: number; lng?: number },
    measure: ((lat: number, lng: number) => number) | null,
    near?: Pick<NearRead, 'from'> | null,
): number | null {
    const measured = measure && post.lat != null && post.lng != null ? measure(post.lat, post.lng) : null;
    if (near?.from === 'setting' && measured !== null) return measured;
    if (finite(post.distanceKm)) return post.distanceKm;
    return measured;
}

/**
 * What a read from the distance setting brought back, cut to the exact circle and nearest first from its centre: the
 * node was asked for a wider circle round a rounded centre, and ordered from that. Any other read as the node sent it.
 */
export function nearestInCircle<T extends { lat?: number | null; lng?: number | null }>(posts: T[], near: NearRead | null): T[] {
    if (near?.from !== 'setting') return posts;
    const { lat, lng, radiusKm } = near.circle;
    return posts
        .flatMap(p => (p.lat != null && p.lng != null ? [{ p, km: haversineDistance(lat, lng, p.lat, p.lng) }] : []))
        .filter(x => x.km <= radiusKm)
        .sort((a, b) => a.km - b.km)
        .map(x => x.p);
}

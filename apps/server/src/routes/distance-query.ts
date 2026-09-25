/**
 * The distance parameters of the listings (global node G4, design §3.2): `lat` and `lng` (a point), `radiusKm`, and
 * `sort` (`distance` or `recent`). The posts listing takes all four, the People lists a point. Anything that isn't a
 * real place or radius is a 400 that says what was wrong, never a guess: a request is answered as asked or not at all.
 */
import { MAX_RADIUS_KM } from '@beanpool/engine';

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export interface Point { lat: number; lng: number }

export interface DistanceQuery {
    point: Point | null;
    /** Only with a point. */
    radiusKm?: number;
    /** `distance` only with a point. Absent: the profile decides (routes/marketplace.ts). */
    sort?: 'distance' | 'recent';
}

// A plain decimal, optionally with an exponent (a phone writes 1e-7 for a place a hair off the equator). Not hex, not
// Infinity, not NaN, not blank: Number() would take all of those.
const DECIMAL = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;

function number(query: Record<string, unknown>, name: string): Parsed<number | undefined> {
    const raw = query[name];
    if (raw === undefined) return { ok: true, value: undefined };
    if (typeof raw !== 'string') return { ok: false, error: `${name} is given more than once.` };
    const n = Number(raw);
    if (!DECIMAL.test(raw) || !Number.isFinite(n)) return { ok: false, error: `${name} must be a number (got ${JSON.stringify(raw.slice(0, 40))}).` };
    return { ok: true, value: n };
}

/** `lat` and `lng`: both or neither, latitude within ±90, longitude within ±180. */
export function parsePoint(query: Record<string, unknown>): Parsed<Point | null> {
    const lat = number(query, 'lat');
    if (!lat.ok) return lat;
    const lng = number(query, 'lng');
    if (!lng.ok) return lng;
    if (lat.value === undefined && lng.value === undefined) return { ok: true, value: null };
    if (lat.value === undefined || lng.value === undefined) return { ok: false, error: 'lat and lng go together: give both, or neither.' };
    if (lat.value < -90 || lat.value > 90) return { ok: false, error: 'lat must be between -90 and 90.' };
    if (lng.value < -180 || lng.value > 180) return { ok: false, error: 'lng must be between -180 and 180.' };
    return { ok: true, value: { lat: lat.value, lng: lng.value } };
}

/** The posts listing's four: a point, a radius around it, and the order. */
export function parseDistanceQuery(query: Record<string, unknown>): Parsed<DistanceQuery> {
    const point = parsePoint(query);
    if (!point.ok) return point;
    const radius = number(query, 'radiusKm');
    if (!radius.ok) return radius;
    if (radius.value !== undefined) {
        if (!point.value) return { ok: false, error: 'radiusKm needs a point to measure from: give lat and lng too.' };
        if (radius.value <= 0 || radius.value > MAX_RADIUS_KM) {
            return { ok: false, error: `radiusKm must be more than 0 and at most ${MAX_RADIUS_KM} (half the Earth round).` };
        }
    }
    const rawSort = query.sort;
    let sort: DistanceQuery['sort'];
    if (rawSort !== undefined) {
        if (rawSort !== 'distance' && rawSort !== 'recent') return { ok: false, error: 'sort must be distance or recent.' };
        if (rawSort === 'distance' && !point.value) return { ok: false, error: 'sort=distance needs a point to measure from: give lat and lng too.' };
        sort = rawSort;
    }
    return { ok: true, value: { point: point.value, radiusKm: radius.value, sort } };
}

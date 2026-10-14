/**
 * Geolocation helpers for BeanPool (docs/the-commons.md §2.2).
 */

/**
 * Round geographic coordinates to roughly 100 meters (3 decimal places).
 * 0.001 degrees of latitude is ~111 meters.
 */
export function approximateLocation(lat: number, lng: number): { lat: number; lng: number } {
    return {
        lat: Math.round(lat * 1000) / 1000,
        lng: Math.round(lng * 1000) / 1000,
    };
}

export const roundToRoughly100m = approximateLocation;

/**
 * A coarse area: a latitude or longitude to the nearest 0.1° (about 11 km north-south; east-west it narrows towards the
 * poles). A person's area is stored rounded to it, and both apps round a position to it BEFORE it leaves the device
 * (signup's "Roughly where are you?", Settings → Your area), so a precise position is never on the wire. The engine's
 * `roundToArea` (and through it the node's SQL `area_km`) is this function: one rule and one implementation. Halves round
 * up (Math.round), never away from zero. Never -0, which would read back as a different number from 0.
 */
export function roundToArea(deg: number): number {
    return Math.round(deg * 10) / 10 + 0;
}

/** A point rounded to its 0.1° area (see roundToArea). */
export function roundPointToArea(lat: number, lng: number): { lat: number; lng: number } {
    return { lat: roundToArea(lat), lng: roundToArea(lng) };
}

/**
 * A neighbourhood: a latitude or longitude to the nearest 0.01° (about 1.1 km north-south). Where anyone can join in a
 * minute (the node's `openMembership`, the global node), a listing's place is served to its members rounded to it, all
 * but its author and the people the author chose (scratch/global-node/DESIGN-global-member-privacy-fable.md §4): a
 * block of houses is what a hostile reader wants, and a town's 0.1° area means nothing to someone there to meet people.
 * The node's SQL `neighbourhood_km` measures from it. Halves round up, never -0, as roundToArea.
 */
export function roundToNeighbourhood(deg: number): number {
    return Math.round(deg * 100) / 100 + 0;
}

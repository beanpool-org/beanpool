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
 * A neighbourhood: a cell about 1.1 km across both ways, everywhere. Where anyone can join in a minute (the node's
 * `openMembership`, the global node), a listing's place is served to its members as its neighbourhood's centre, all but
 * its author and the people the author chose (scratch/global-node/DESIGN-global-member-privacy-fable.md §4): a block of
 * houses is what a hostile reader wants, and a town's 0.1° area means nothing to someone there to meet people. The
 * node's SQL `neighbourhood_km` measures from it.
 *
 * North–south a row is 0.01° (1.11 km) everywhere. East–west a fixed 0.01° narrows with the latitude (0.56 km at 60°,
 * 0.40 km at 69°), so the longitude step widens instead (Marty, 15 Oct 2026, "Widen by latitude"): NEIGHBOURHOOD_LAT_STEP
 * over the cosine of the middle of the row's 1° band of latitude (neighbourhoodLngStep), so every row of a band shares
 * one step and the cells of a row tile it. Halves round up, never -0, as roundToArea.
 */
export const NEIGHBOURHOOD_LAT_STEP = 0.01;

/** The longitude step of each 1° band of latitude, from -90 (the band [-90, -89)) to 89, worked out once. */
const lngStepByBand = new Map<number, number>();

/**
 * The longitude step of the neighbourhoods in a row, by the row's latitude (a neighbourhood's `lat`): about 1.1 km
 * east–west at the middle of its 1° band, as a whole number of cells round the Earth, so the cells meet at the
 * antimeridian; never less than 0.01°. Clamped by the poles: the band's middle is at most 89.5° from the equator, so the
 * step stops widening at about 1.15° (314 cells round the band).
 */
export function neighbourhoodLngStep(cellLat: number): number {
    const band = Math.min(89, Math.max(-90, Math.floor(cellLat)));
    let step = lngStepByBand.get(band);
    if (step === undefined) {
        const cells = Math.max(1, Math.min(36000, Math.round(36000 * Math.cos((band + 0.5) * Math.PI / 180))));
        step = 360 / cells;
        lngStepByBand.set(band, step);
    }
    return step;
}

/**
 * A place's neighbourhood, as its centre: the latitude to the nearest NEIGHBOURHOOD_LAT_STEP, the longitude to the
 * nearest step of that row (neighbourhoodLngStep), to six decimals. The cell on the antimeridian, in a row with an even
 * number of cells, goes by two names, 180 and -180, as the 0.1° area's does.
 */
export function neighbourhoodOf(lat: number, lng: number): { lat: number; lng: number } {
    const cellLat = Math.round(lat * 100) / 100 + 0;
    const step = neighbourhoodLngStep(cellLat);
    const cells = Math.round(360 / step);
    let k = Math.round(lng / step);
    if (k > cells / 2) k -= cells;
    if (k < -cells / 2) k += cells;
    const cellLng = Math.round(k * 360 / cells * 1e6) / 1e6 + 0;
    return { lat: cellLat, lng: Math.max(-180, Math.min(180, cellLng)) };
}

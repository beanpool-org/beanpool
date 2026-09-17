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

/**
 * geo.ts — Geolocation utilities
 *
 * Haversine distance formula for radius-based marketplace filtering.
 */

/** Returns distance in kilometers between two lat/lng points */
export function haversineDistance(
    lat1: number, lng1: number,
    lat2: number, lng2: number,
): number {
    const R = 6371; // Earth radius in km
    const toRad = (deg: number) => (deg * Math.PI) / 180;

    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLng / 2) ** 2;

    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Storage key for persisted radius settings */
export const RADIUS_STORAGE_KEY = 'beanpool-radius';

export interface RadiusSettings {
    lat: number;
    lng: number;
    radiusKm: number;
    label: string;
}

export function loadRadiusSettings(): RadiusSettings | null {
    try {
        const raw = localStorage.getItem(RADIUS_STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

export function saveRadiusSettings(settings: RadiusSettings): void {
    localStorage.setItem(RADIUS_STORAGE_KEY, JSON.stringify(settings));
}

export function clearRadiusSettings(): void {
    localStorage.removeItem(RADIUS_STORAGE_KEY);
}

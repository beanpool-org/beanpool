/**
 * "Or type your town" (Marty, 14 Oct): a place the member typed and picked in "Find your community", in place of the
 * phone's location. The search is the shared one (components/AddressSearch.tsx over @beanpool/core's address lookup,
 * the settings app's location search); this keeps only what was picked, and only as roughly as Home keeps the phone's
 * own place (utils/home-store.ts coarseHomePoint: two decimals, about a kilometre), with its short name ("Lismore").
 *
 * It goes where the phone's place goes (GET /api/global/home and /api/global/communities `lat`/`lng`), so the nearest
 * communities follow it. The member chose it, so it wins over the phone's last known place until "Use my location"
 * forgets it. Where someone lives is the account's: Sign Out and Replace wipe it (identity.ts wipeIdentityScopedStorage).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AddressResult } from '@beanpool/core';
import { TYPED_PLACE_STORE_KEY } from './storage-keys';

export { TYPED_PLACE_STORE_KEY };

const MAX_NAME_CHARS = 60;

export interface TypedPlace { lat: number; lng: number; name: string }

/** The same two decimals as Home's place (home-store.ts coarseHomePoint). */
const two = (n: number) => Math.round(n * 100) / 100;

function place(lat: unknown, lng: unknown, name: unknown): TypedPlace | null {
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    const words = typeof name === 'string' ? Array.from(name.replace(/\s+/g, ' ').trim()).slice(0, MAX_NAME_CHARS).join('') : '';
    return { lat: two(lat), lng: two(lng), name: words };
}

/** What a picked match keeps: the coarse point and its short name. Null for a match that isn't a place. */
export function typedPlaceFrom(result: Pick<AddressResult, 'lat' | 'lng' | 'shortName' | 'displayName'>): TypedPlace | null {
    return place(result.lat, result.lng, result.shortName || result.displayName);
}

/** "Near Lismore", for the line with "change". */
export function nearLine(p: TypedPlace): string {
    return p.name ? `Near ${p.name}` : 'Near the place you typed';
}

export async function readTypedPlace(): Promise<TypedPlace | null> {
    try {
        const raw = await AsyncStorage.getItem(TYPED_PLACE_STORE_KEY);
        if (!raw) return null;
        const v = JSON.parse(raw);
        return v && typeof v === 'object' ? place(v.lat, v.lng, v.name) : null;
    } catch {
        return null;
    }
}

/** Keeps a picked match (coarse) and returns what was kept; null when it isn't a place. A failed write still returns it. */
export async function saveTypedPlace(result: Pick<AddressResult, 'lat' | 'lng' | 'shortName' | 'displayName'>): Promise<TypedPlace | null> {
    const p = typedPlaceFrom(result);
    if (!p) return null;
    await AsyncStorage.setItem(TYPED_PLACE_STORE_KEY, JSON.stringify(p)).catch(() => {});
    return p;
}

/** "Use my location" after a typed town: the phone's place again. */
export async function forgetTypedPlace(): Promise<void> {
    await AsyncStorage.removeItem(TYPED_PLACE_STORE_KEY).catch(() => {});
}

/** The find screen's notes when the phone's location can't be had: each offers typing the town. */
export const LOCATION_NOTES = {
    off: 'Location is off for BeanPool. Type your town instead, or search by name below.',
    failed: "Couldn't find where you are. Type your town instead, or search by name below.",
} as const;

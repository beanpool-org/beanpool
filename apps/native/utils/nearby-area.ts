/**
 * This phone's copy of its member's area on a community that syncs listings by area (`features.nearbyListings`,
 * scratch/global-node/DESIGN-global-sync-by-area-fable.md §2.4 step 2): what the local prune measures from
 * (utils/posts-nearby.ts) and what the Market's no-area line reads. Kept per community, next to the sync cursors.
 *
 * The node's word is the truth (`GET /api/community/me`); services/pillar-sync.ts asks it at most once an hour, and the
 * phone notes what it sent itself (utils/member-area.ts writeMemberArea). An area that changed (set, cleared, or another
 * device of the account moved it) makes the next posts read a whole one: the new neighbourhood in three pages, not a
 * trickle of `ids=` reads. A copy of another key's area (another account on this phone) is no copy.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDatabaseFilenameForNode } from './nodes';

export interface NearbyArea {
    lat: number;
    lng: number;
}

export interface NearbyAreaCopy {
    /** Whose area it is. */
    key: string;
    /** The area, or null: the member has none (the node gives them the newest listings worldwide). */
    area: NearbyArea | null;
    /** When the node last said it, or this phone last sent it (ms). */
    checkedAt: number;
    /** The area changed since the last whole posts read: the next one is whole. */
    whole: boolean;
}

/** How long a copy stands before the sync asks the node again. */
export const NEARBY_AREA_RECHECK_MS = 60 * 60 * 1000;

export function nearbyAreaKeyOf(url: string | null): string {
    return `pillar_sync_${getDatabaseFilenameForNode(url)}_nearby_area`;
}

function areaOrNull(a: unknown): NearbyArea | null | undefined {
    if (a === null) return null;
    if (!a || typeof a !== 'object') return undefined;
    const { lat, lng } = a as Record<string, unknown>;
    return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined;
}

/** The copy for `publicKey` on the community at `url`, or null when there is none (or it is another key's). */
export async function readNearbyAreaCopy(url: string | null, publicKey: string | null | undefined): Promise<NearbyAreaCopy | null> {
    if (!url || !publicKey) return null;
    try {
        const raw = await AsyncStorage.getItem(nearbyAreaKeyOf(url));
        const c = raw ? JSON.parse(raw) : null;
        if (!c || c.key !== publicKey || !Number.isFinite(c.checkedAt)) return null;
        const area = areaOrNull(c.area);
        if (area === undefined) return null;
        return { key: c.key, area, checkedAt: c.checkedAt, whole: c.whole === true };
    } catch {
        return null;
    }
}

export async function storeNearbyAreaCopy(url: string, copy: NearbyAreaCopy): Promise<void> {
    await AsyncStorage.setItem(nearbyAreaKeyOf(url), JSON.stringify(copy));
}

export function sameArea(a: NearbyArea | null | undefined, b: NearbyArea | null | undefined): boolean {
    if (!a || !b) return !a && !b;
    return a.lat === b.lat && a.lng === b.lng;
}

/**
 * The copy after the node said `area` (or this phone sent it): whole when there was no copy (the first by-area read is
 * whole on every phone), when one was already due, or when the area moved.
 */
export function nextNearbyAreaCopy(held: NearbyAreaCopy | null, publicKey: string, area: NearbyArea | null, nowMs = Date.now()): NearbyAreaCopy {
    return { key: publicKey, area, checkedAt: nowMs, whole: !held || held.whole || !sameArea(held.area, area) };
}

/** After the member set or cleared their area on `url` (the signup step, Settings → Your area). Never throws. */
export async function noteAreaSent(url: string, publicKey: string, area: NearbyArea | null): Promise<void> {
    try {
        const held = await readNearbyAreaCopy(url, publicKey);
        await storeNearbyAreaCopy(url, nextNearbyAreaCopy(held, publicKey, area ? { lat: area.lat, lng: area.lng } : null));
    } catch {
        // The sync asks the node within the hour.
    }
}

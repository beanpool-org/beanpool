/**
 * A member's rough area on a community that syncs listings by area (the worldwide one: `features.nearbyListings`,
 * design scratch/global-node/DESIGN-global-sync-by-area-fable.md §3). Asked once at signup, after the photo
 * (app/profile-setup.tsx), and changed or cleared in Settings → Your area.
 *
 * The node keeps it to 0.1° (about 11 km), and so does this phone: a position is rounded with @beanpool/core's
 * roundToArea (the engine's own rule, one implementation) BEFORE the request is built, so a precise position is never
 * on the wire. The node rounds again on the write (apps/server engine/member-area.ts).
 *
 * Skipping writes nothing: no request, no stored flag. A member without an area still gets in and sees the newest
 * listings worldwide (§3.4); nothing here may block the wizard or pretend a save worked.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { roundToArea } from '@beanpool/core';
import { buildSignedHeaders } from './crypto';
import type { NodeFeatures } from './node-profile';

export type ProfileStep = 'name' | 'avatar' | 'area' | 'guide';

/** The wizard's steps: the area step only on a community that syncs by area, so a local community's is unchanged. */
export function profileSteps(features: NodeFeatures | null | undefined): ProfileStep[] {
    return nearbyListingsOn(features) ? ['name', 'avatar', 'area', 'guide'] : ['name', 'avatar', 'guide'];
}

/** Whether this community gives each member the listings near their area (the worldwide one). Not said = no. */
export function nearbyListingsOn(features: NodeFeatures | null | undefined): boolean {
    return !!features?.nearbyListings;
}

/** One wording for both apps (design §3.2). No currency, five short lines, three stacked controls. */
export const AREA_WORDS = {
    title: 'Roughly where are you?',
    why: "The worldwide community shows you what's on offer near you: the nearest 500 listings within 250 km.",
    privacy: 'We keep your area to about 10 km, never your exact spot. Other members see only a distance in km.',
    useLocation: 'Use my location',
    typeTown: 'Type a town or suburb',
    skip: 'Skip for now',
    later: 'You can change or clear this any time in Settings → Your area.',
} as const;

/** The why line with the node's own numbers, when it says them (`features.nearbyListings`). */
export function areaWhyLine(features: NodeFeatures | null | undefined): string {
    const n = features?.nearbyListings;
    if (!n) return AREA_WORDS.why;
    return `The worldwide community shows you what's on offer near you: the nearest ${n.max} listings within ${n.radiusKm} km.`;
}

export interface MemberArea {
    lat: number;
    lng: number;
    updatedAt?: string | null;
}

/** "About 10 km around <place or lat, lng>", or "Not set". */
export function describeArea(area: MemberArea | null | undefined, placeName?: string | null): string {
    if (!area) return 'Not set';
    const where = placeName?.trim() || `${area.lat.toFixed(1)}, ${area.lng.toFixed(1)}`;
    return `About 10 km around ${where}`;
}

/** A position as it may leave this phone: its 0.1° area, never finer. */
export function areaOf(lat: number, lng: number): { lat: number; lng: number } {
    return { lat: roundToArea(lat), lng: roundToArea(lng) };
}

export type AreaWriteResult = { ok: true; area: MemberArea | null } | { ok: false; error: string };

interface Signer { publicKey: string; privateKey: string }

/**
 * Sets (a point, rounded here first) or clears (null) the signer's area on the community at `url`: one signed
 * `POST /api/community/me/area`. Never throws: a failure is a plain sentence for the screen to show.
 */
export async function writeMemberArea(url: string, identity: Signer, point: { lat: number; lng: number } | null): Promise<AreaWriteResult> {
    const body = point ? areaOf(point.lat, point.lng) : { lat: null, lng: null };
    if (point && (!Number.isFinite(body.lat as number) || !Number.isFinite(body.lng as number))) {
        return { ok: false, error: "That place couldn't be read. Try again or type a town." };
    }
    const endpoint = `${url.replace(/\/+$/, '')}/api/community/me/area`;
    try {
        const bodyString = JSON.stringify(body);
        const headers = await buildSignedHeaders('POST', endpoint, bodyString, identity.privateKey, identity.publicKey);
        const res = await fetch(endpoint, { method: 'POST', headers, body: bodyString });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            return { ok: false, error: typeof data?.error === 'string' ? data.error : `The community said no (${res.status}). Try again later.` };
        }
        const data = await res.json().catch(() => ({}));
        return { ok: true, area: readArea(data?.area) };
    } catch {
        return { ok: false, error: "Couldn't reach the community. Check your connection and try again." };
    }
}

/** The signer's stored area from `GET /api/community/me`: an area, null (none set), or undefined (couldn't ask). */
export async function readMemberArea(url: string, identity: Signer): Promise<MemberArea | null | undefined> {
    const endpoint = `${url.replace(/\/+$/, '')}/api/community/me`;
    try {
        const headers = await buildSignedHeaders('GET', endpoint, '', identity.privateKey, identity.publicKey);
        const res = await fetch(endpoint, { headers });
        if (!res.ok) return undefined;
        const data = await res.json();
        return readArea(data?.area);
    } catch {
        return undefined;
    }
}

function readArea(a: unknown): MemberArea | null {
    if (!a || typeof a !== 'object') return null;
    const { lat, lng, updatedAt } = a as Record<string, unknown>;
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    return { lat, lng, updatedAt: typeof updatedAt === 'string' ? updatedAt : null };
}

// The town a member typed, kept on this phone only, so Settings can say "About 10 km around Byron Bay" rather than two
// numbers. The node never sees it. A reading of the location, or a clear, forgets it.
const PLACE_KEY = 'beanpool_area_place:';

function placeKey(url: string): string {
    return PLACE_KEY + url.trim().replace(/\/+$/, '').toLowerCase();
}

export async function rememberAreaPlace(url: string, placeName: string | null): Promise<void> {
    try {
        if (placeName && placeName.trim()) await AsyncStorage.setItem(placeKey(url), placeName.trim().slice(0, 80));
        else await AsyncStorage.removeItem(placeKey(url));
    } catch { /* display only */ }
}

export async function recallAreaPlace(url: string): Promise<string | null> {
    try { return await AsyncStorage.getItem(placeKey(url)); } catch { return null; }
}

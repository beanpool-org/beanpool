/**
 * A member's rough area on a community that gives each member the listings near it (`features.nearbyListings`, the
 * worldwide one; design scratch/global-node/DESIGN-global-sync-by-area-fable.md §3). Asked at signup as the "Your Area"
 * step after the photo (pages/WelcomePage.tsx), and changed or cleared in Settings → Your area.
 *
 * A position is rounded to its 0.1° area with @beanpool/core's roundToArea (the engine's own rule, one implementation)
 * BEFORE any request is built, so a precise position is never on the wire; the node rounds again on the write. Skipping
 * writes nothing.
 */
import { useEffect, useState } from 'react';
import { roundToArea } from '@beanpool/core';
import { request, signedFetchWithKey, type CommunityInfo } from './api';
import { communityInfoOnce } from './visitor-lobby-gate';

export interface MemberArea { lat: number; lng: number; updatedAt?: string | null }
export type AreaWriteResult = { ok: true; area: MemberArea | null } | { ok: false; error: string };

/** Whether this community syncs listings by area. A node that doesn't say: no. */
export function nearbyListingsOn(info: CommunityInfo | null | undefined): boolean {
    const n = info?.features?.nearbyListings;
    return !!n && typeof n === 'object';
}

/** A position as it may leave this browser: its 0.1° area, never finer. */
export function areaOf(lat: number, lng: number): { lat: number; lng: number } {
    return { lat: roundToArea(lat), lng: roundToArea(lng) };
}

/** How the body reaches the node: signed with the joining key at signup, with the stored one in Settings. */
export type AreaSender = (body: { lat: number | null; lng: number | null }) => Promise<{ area?: unknown }>;

/** Sets (a point, rounded here first) or clears (null). Never throws: a failure is a sentence for the screen. */
export async function writeArea(send: AreaSender, point: { lat: number; lng: number } | null): Promise<AreaWriteResult> {
    const body = point ? areaOf(point.lat, point.lng) : { lat: null, lng: null };
    if (point && (!Number.isFinite(body.lat as number) || !Number.isFinite(body.lng as number))) {
        return { ok: false, error: "That place couldn't be read. Try again or type a town." };
    }
    try {
        const data = await send(body);
        return { ok: true, area: readArea(data?.area) };
    } catch (e) {
        const msg = e instanceof Error && e.message ? e.message : '';
        return { ok: false, error: msg || "Couldn't reach the community. Check your connection and try again." };
    }
}

/** The sender for a key that isn't stored yet (signup): signed with that key. */
export function senderForKey(privateKey: string, publicKey: string): AreaSender {
    return async (body) => {
        const res = await signedFetchWithKey('POST', '/api/community/me/area', body, privateKey, publicKey);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : `The community said no (${res.status}). Try again later.`);
        return data;
    };
}

/** The sender for the signed-in member (Settings). */
export const senderForMe: AreaSender = (body) => request('POST', '/api/community/me/area', body);

/** The signed-in member's stored area: an area, null (none), or undefined (couldn't ask). */
export async function readMyArea(): Promise<MemberArea | null | undefined> {
    try {
        const me = await request<{ area?: unknown }>('GET', '/api/community/me');
        return readArea(me?.area);
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

// The town a member typed, kept in this browser only (Settings says "About 10 km around Byron Bay"); never sent.
const PLACE_KEY = 'beanpool_area_place';

export function rememberAreaPlace(placeName: string | null): void {
    try {
        if (placeName && placeName.trim()) localStorage.setItem(PLACE_KEY, placeName.trim().slice(0, 80));
        else localStorage.removeItem(PLACE_KEY);
    } catch { /* display only */ }
}

export function recallAreaPlace(): string | null {
    try { return localStorage.getItem(PLACE_KEY); } catch { return null; }
}

/** One reading of the browser's position, at low accuracy. Rejects with a sentence when refused or unavailable. */
export function readBrowserPosition(): Promise<{ lat: number; lng: number }> {
    return new Promise((resolve, reject) => {
        if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
            reject(new Error("This browser can't share a location. Type a town instead, or skip for now."));
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
            (err) => reject(new Error(err?.code === 1
                ? 'Location is off for this site. Type a town instead, or skip for now.'
                : "Couldn't read your location. Type a town instead, or skip for now.")),
            { enableHighAccuracy: false, maximumAge: 10 * 60 * 1000, timeout: 20_000 },
        );
    });
}

/**
 * The community's by-area limits (`features.nearbyListings`), or null on a community that doesn't sync by area. Asked
 * only while `enabled`, so a screen a visitor sees (the Map) asks nothing until a member opens the form that needs it.
 */
export function useNearbyLimits(enabled = true): { radiusKm: number; max: number } | null {
    const [limits, setLimits] = useState<{ radiusKm: number; max: number } | null>(null);
    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        communityInfoOnce()
            .then((info) => { if (!cancelled && nearbyListingsOn(info)) setLimits(info.features!.nearbyListings!); })
            .catch(() => { /* a node that can't be asked says nothing about areas */ });
        return () => { cancelled = true; };
    }, [enabled]);
    return limits;
}

/** The signed-in member's area while `enabled`: an area, null (known unset), or undefined (not asked, or couldn't ask). */
export function useMyArea(enabled: boolean): MemberArea | null | undefined {
    const [area, setArea] = useState<MemberArea | null | undefined>(undefined);
    useEffect(() => {
        if (!enabled) { setArea(undefined); return; }
        let cancelled = false;
        readMyArea().then((a) => { if (!cancelled) setArea(a); });
        return () => { cancelled = true; };
    }, [enabled]);
    return area;
}

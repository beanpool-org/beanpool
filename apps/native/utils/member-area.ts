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
import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { roundToArea, AREA_STEP_WORDS, areaWhyLine as coreWhyLine, describeArea } from '@beanpool/core';
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

/** One wording for both apps (design §3.2), from @beanpool/core so the web's step says exactly the same. */
export const AREA_WORDS = { ...AREA_STEP_WORDS, why: coreWhyLine(null) } as const;

/** The why line with the node's own numbers, when it says them (`features.nearbyListings`). */
export function areaWhyLine(features: NodeFeatures | null | undefined): string {
    return coreWhyLine(features?.nearbyListings ?? null);
}

export interface MemberArea {
    lat: number;
    lng: number;
    updatedAt?: string | null;
}

export { describeArea };

/** A position as it may leave this phone: its 0.1° area, never finer. */
export function areaOf(lat: number, lng: number): { lat: number; lng: number } {
    return { lat: roundToArea(lat), lng: roundToArea(lng) };
}

export type AreaWriteResult = { ok: true; area: MemberArea | null } | { ok: false; error: string };

interface Signer { publicKey: string; privateKey: string }

// Time limits (deciding review of #1766, B2). React Native's fetch has none, and expo-location's reading takes no
// timeout, so on old Android over a slow network either could wait for good. The reading gets what the web's
// navigator.geolocation call is given; a request gets the global join's own limit (utils/global-join.ts JOIN_TIMEOUT_MS).
export const AREA_READING_TIMEOUT_MS = 20_000;
export const AREA_REQUEST_TIMEOUT_MS = 30_000;

/** `promise`, or null once `ms` have passed without an answer. The work itself goes on; its answer is dropped. */
export function withTimeLimit<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        promise,
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * Runs `work` with a signal that stops at `ms` or when `outer` does (Skip, Cancel, leaving the screen), and rejects
 * the moment it stops, even if the work ignores its signal.
 */
async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, outer?: AbortSignal): Promise<T> {
    const stop = new AbortController();
    const onOuter = () => stop.abort();
    if (outer?.aborted) stop.abort();
    else outer?.addEventListener('abort', onOuter);
    const timer = setTimeout(() => stop.abort(), ms);
    try {
        return await new Promise<T>((resolve, reject) => {
            if (stop.signal.aborted) { reject(new Error('stopped')); return; }
            stop.signal.addEventListener('abort', () => reject(new Error('stopped')));
            work(stop.signal).then(resolve, reject);
        });
    } finally {
        clearTimeout(timer);
        outer?.removeEventListener('abort', onOuter);
    }
}

/**
 * Sets (a point, rounded here first) or clears (null) the signer's area on the community at `url`: one signed
 * `POST /api/community/me/area`, given up after AREA_REQUEST_TIMEOUT_MS or when `signal` stops it (nothing is sent
 * once it has). Never throws: a failure is a plain sentence for the screen to show.
 */
export async function writeMemberArea(
    url: string,
    identity: Signer,
    point: { lat: number; lng: number } | null,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<AreaWriteResult> {
    const body = point ? areaOf(point.lat, point.lng) : { lat: null, lng: null };
    if (point && (!Number.isFinite(body.lat as number) || !Number.isFinite(body.lng as number))) {
        return { ok: false, error: "That place couldn't be read. Try again or type a town." };
    }
    const endpoint = `${url.replace(/\/+$/, '')}/api/community/me/area`;
    try {
        return await bounded(async (signal): Promise<AreaWriteResult> => {
            const bodyString = JSON.stringify(body);
            const headers = await buildSignedHeaders('POST', endpoint, bodyString, identity.privateKey, identity.publicKey);
            if (signal.aborted) throw new Error('stopped');
            const res = await fetch(endpoint, { method: 'POST', headers, body: bodyString, signal });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                return { ok: false, error: typeof data?.error === 'string' ? data.error : `The community said no (${res.status}). Try again later.` };
            }
            const data = await res.json().catch(() => ({}));
            return { ok: true, area: readArea(data?.area) };
        }, options.timeoutMs ?? AREA_REQUEST_TIMEOUT_MS, options.signal);
    } catch {
        return { ok: false, error: "Couldn't reach the community. Check your connection and try again." };
    }
}

/**
 * The signer's stored area from `GET /api/community/me`: an area, null (none set), or undefined (couldn't ask, which
 * includes no answer within AREA_REQUEST_TIMEOUT_MS).
 */
export async function readMemberArea(url: string, identity: Signer): Promise<MemberArea | null | undefined> {
    const endpoint = `${url.replace(/\/+$/, '')}/api/community/me`;
    try {
        return await bounded(async (signal) => {
            const headers = await buildSignedHeaders('GET', endpoint, '', identity.privateKey, identity.publicKey);
            const res = await fetch(endpoint, { headers, signal });
            if (!res.ok) return undefined;
            const data = await res.json();
            return readArea(data?.area);
        }, AREA_REQUEST_TIMEOUT_MS);
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

/**
 * The member's area on the current community while `enabled` (a form is open on a by-area community): an area, null
 * (known unset), or undefined (not asked yet, or couldn't ask). For the placeless listing's note (core
 * placelessListingNote), which says nothing on undefined rather than something false.
 */
export function useMyArea(enabled: boolean, identity: Signer | null | undefined): MemberArea | null | undefined {
    const [area, setArea] = useState<MemberArea | null | undefined>(undefined);
    useEffect(() => {
        if (!enabled || !identity) { setArea(undefined); return; }
        let cancelled = false;
        (async () => {
            const url = await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null);
            if (!url) return;
            const a = await readMemberArea(url, identity);
            if (!cancelled) setArea(a);
        })();
        return () => { cancelled = true; };
    }, [enabled, identity?.publicKey]);
    return area;
}

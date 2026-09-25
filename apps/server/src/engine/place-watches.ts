/**
 * Place watches (global node G5, design §3.5): "tell me when a community starts near here". Most people who arrive at
 * the global node will have no community near them yet; a watch is how they hear when one appears.
 *
 * - A member's own, set, listed and removed only with their own signed request (routes/global-directory.ts). The
 *   member comes from the signature, never the body. At most PLACE_WATCH_LIMIT each.
 * - Stored as the 0.1° cell (roundToArea, the rounding G4 uses for a person's area), rounded BEFORE the write, so the
 *   spot a phone sent never reaches the disk. The same cell again changes that watch's radius, not a second watch.
 * - A community reaches a watch when its centre is within the watch's radius plus its own service radius (counted up
 *   to SERVICE_REACH_CAP_KM, so a row claiming to serve half the Earth can't reach every watcher).
 * - The mirror hands over the communities it saw for the first time (engine/directory-cache.ts). Each member with a
 *   watch one of them reaches hears once for the run: one push and one live announcement to their own sockets. A
 *   community is new once in the life of the database, so nobody hears about it twice; a watch set after a community
 *   was first seen never hears about it (it was already there to find).
 * - Node-local, like push tokens. Gone with the member on a prune or a self-deletion, moved on a re-key.
 *
 * ## The registry is open, so a notice is plain and rare
 *
 * Anyone with a node key (free to make) can publish a row to the public registry, name and place included, and a
 * notice lands on a stranger's lock screen as coming from BeanPool. So:
 *   - a notice carries no text from the registry: how many, how far, and the keys for the app to find them. The names
 *     are on the landing card, as they are on the website's map;
 *   - a member hears at most once a day (PLACE_WATCH_NOTICE_GAP_MS). A community first seen in their quiet day is not
 *     pushed to them; it is on the card, which is where a notice leads anyway;
 *   - a run that brings more than PLACE_WATCH_FLOOD new communities with a place tells nobody, and says so in the log:
 *     that many at once is a flood, not communities starting.
 * Verified listings (the registrar vouching for an address) would let a notice name the community; not built here.
 */
import crypto from 'node:crypto';
import { db } from '../db/db.js';
import { haversineKm } from '@beanpool/engine';
import { roundToArea } from './member-area.js';
import type { DirectoryRow } from './directory-cache.js';

export const PLACE_WATCH_LIMIT = 3;
export const PLACE_WATCH_RADIUS_KM = { min: 10, max: 200, default: 50 } as const;
/** How much of a community's own service radius counts toward reaching a watch. */
export const SERVICE_REACH_CAP_KM = 100;
/** At most this many community keys ride in one notice's data. */
const KEYS_IN_NOTICE = 10;
/** A member hears about new communities near them at most once in this long. */
export const PLACE_WATCH_NOTICE_GAP_MS = 24 * 60 * 60 * 1000;
/** More new communities with a place than this in one run is a flood, and nobody is told about them. */
export const PLACE_WATCH_FLOOD = 25;

export interface PlaceWatch {
    id: string;
    /** The 0.1° cell. */
    lat: number;
    lng: number;
    radiusKm: number;
    createdAt: string;
}

interface WatchRecord { id: string; pubkey: string; lat: number; lng: number; radius_km: number; created_at: string; last_notified_at: string | null }

const toWatch = (w: WatchRecord): PlaceWatch => ({ id: w.id, lat: w.lat, lng: w.lng, radiusKm: w.radius_km, createdAt: w.created_at });

export class PlaceWatchLimitError extends Error {
    readonly code = 'watch_limit';
    readonly status = 409;
    constructor() {
        super(`You can watch up to ${PLACE_WATCH_LIMIT} places. Remove one to watch another.`);
        this.name = 'PlaceWatchLimitError';
    }
}

/** A member's own watches, oldest first. */
export function listPlaceWatches(pubkey: string): PlaceWatch[] {
    return (db.prepare('SELECT * FROM place_watches WHERE pubkey = ? ORDER BY created_at, id').all(pubkey) as WatchRecord[]).map(toWatch);
}

/**
 * Sets a watch on the cell holding `point` (the same cell again: its radius), and returns what is stored. The point is
 * rounded here, before any write. Throws PlaceWatchLimitError for a new cell past the limit. The caller has checked
 * the point is on the Earth and the radius is within PLACE_WATCH_RADIUS_KM.
 */
export function setPlaceWatch(pubkey: string, point: { lat: number; lng: number }, radiusKm: number): { watch: PlaceWatch; created: boolean } {
    const lat = roundToArea(point.lat);
    const lng = roundToArea(point.lng);
    return db.transaction(() => {
        const same = db.prepare('SELECT * FROM place_watches WHERE pubkey = ? AND lat = ? AND lng = ?').get(pubkey, lat, lng) as WatchRecord | undefined;
        if (same) {
            if (same.radius_km !== radiusKm) db.prepare('UPDATE place_watches SET radius_km = ? WHERE id = ?').run(radiusKm, same.id);
            return { watch: toWatch({ ...same, radius_km: radiusKm }), created: false };
        }
        const count = (db.prepare('SELECT COUNT(*) AS n FROM place_watches WHERE pubkey = ?').get(pubkey) as { n: number }).n;
        if (count >= PLACE_WATCH_LIMIT) throw new PlaceWatchLimitError();
        const row: WatchRecord = { id: crypto.randomUUID(), pubkey, lat, lng, radius_km: radiusKm, created_at: new Date().toISOString(), last_notified_at: null };
        db.prepare('INSERT INTO place_watches (id, pubkey, lat, lng, radius_km, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(row.id, row.pubkey, row.lat, row.lng, row.radius_km, row.created_at);
        return { watch: toWatch(row), created: true };
    })();
}

/** Removes a member's own watch. False when they have no watch with that id (another member's included). */
export function removePlaceWatch(pubkey: string, id: string): boolean {
    return db.prepare('DELETE FROM place_watches WHERE id = ? AND pubkey = ?').run(id, pubkey).changes > 0;
}

/** A prune or a self-deletion: the member's watches go with them. */
export function dropPlaceWatches(pubkey: string): void {
    db.prepare('DELETE FROM place_watches WHERE pubkey = ?').run(pubkey);
}

/** A re-key: the member's watches move to their new key (a cell both keys watch is kept once), their quiet day with them. */
export function movePlaceWatches(oldPubkey: string, newPubkey: string): void {
    db.prepare('UPDATE OR IGNORE place_watches SET pubkey = ? WHERE pubkey = ?').run(newPubkey, oldPubkey);
    db.prepare('DELETE FROM place_watches WHERE pubkey = ?').run(oldPubkey);
}

// ── telling watchers ─────────────────────────────────────────────────────────────────────────────────────────────

type BroadcastFn = (event: any, recipients?: string[]) => void;
type PushFn = (targetPubkeys: string[], actorPubkey: string, title: string, body: string, data: Record<string, any>, categoryId: 'chat' | 'marketplace' | 'escrow' | 'recovery') => void;

export interface PlaceWatchNoticeCallbacks {
    broadcast: BroadcastFn;
    dispatchPushNotification: PushFn;
    /** A member who may still hear from this node (not pruned, not a replaced key). */
    isMember: (pubkey: string) => boolean;
}

export const COMMUNITY_NEAR_TITLE = '🌱 A community near you';
export const COMMUNITIES_NEAR_TITLE = '🌱 Communities near you';

// No registry text in either (see the header): the count and the distance only.
export function communityNearBody(km: number): string {
    return `A new community is now in the BeanPool directory, about ${km} km from a place you're watching.`;
}

export function communitiesNearBody(count: number, km: number): string {
    return `${count} new communities are now in the BeanPool directory near a place you're watching. The nearest is about ${km} km away.`;
}

/**
 * Tells each member whose watch one of `added` reaches, once: one push (marketplace category, so their Marketplace
 * notification setting applies) and one `system_announcement` to their own sockets, unless they heard within
 * PLACE_WATCH_NOTICE_GAP_MS or the run is a flood (see the header). Only watches set before `now` count (all of them,
 * in a run: the communities are new at `now`). Returns how many members were told.
 */
export function notifyPlaceWatchers(cb: PlaceWatchNoticeCallbacks, added: readonly DirectoryRow[], now: string): number {
    const placed = added.filter(c => c.lat !== null && c.lng !== null);
    if (placed.length === 0) return 0;
    if (placed.length > PLACE_WATCH_FLOOD) {
        console.warn(`[Place watches] ⚠️ ${placed.length} new communities with a place in one run, more than ${PLACE_WATCH_FLOOD}: `
            + 'a flood, not communities starting, so no watcher is told about them. They are listed as usual.');
        return 0;
    }
    const nowMs = Date.parse(now);
    const watches = db.prepare('SELECT * FROM place_watches WHERE created_at < ?').all(now) as WatchRecord[];
    const lastHeard = new Map<string, number>();
    for (const w of watches) {
        const t = w.last_notified_at ? Date.parse(w.last_notified_at) : NaN;
        if (Number.isFinite(t)) lastHeard.set(w.pubkey, Math.max(lastHeard.get(w.pubkey) ?? t, t));
    }
    const byMember = new Map<string, Map<string, { c: DirectoryRow; km: number }>>();
    for (const w of watches) {
        for (const c of placed) {
            const d = haversineKm(w.lat, w.lng, c.lat!, c.lng!);
            if (d > w.radius_km + Math.min(c.radiusKm ?? 0, SERVICE_REACH_CAP_KM)) continue;
            const found = byMember.get(w.pubkey) ?? new Map();
            const prev = found.get(c.key);
            if (!prev || d < prev.km) found.set(c.key, { c, km: d });
            byMember.set(w.pubkey, found);
        }
    }
    const heard = db.prepare('UPDATE place_watches SET last_notified_at = ? WHERE pubkey = ?');
    let told = 0;
    for (const [pubkey, found] of byMember) {
        if (!cb.isMember(pubkey)) continue;
        const last = lastHeard.get(pubkey);
        if (last !== undefined && nowMs - last < PLACE_WATCH_NOTICE_GAP_MS) continue;
        const near = [...found.values()].sort((a, b) => a.km - b.km || (a.c.key < b.c.key ? -1 : 1));
        const km = Math.max(1, Math.round(near[0].km));
        const title = near.length === 1 ? COMMUNITY_NEAR_TITLE : COMMUNITIES_NEAR_TITLE;
        const body = near.length === 1 ? communityNearBody(km) : communitiesNearBody(near.length, km);
        // Stamped before sending: a notice that throws below still starts the member's quiet day.
        heard.run(now, pubkey);
        const data = { kind: 'community_near_you', communities: near.slice(0, KEYS_IN_NOTICE).map(n => n.c.key) };
        try {
            cb.broadcast({ type: 'system_announcement', title, body, severity: 'info', ...data }, [pubkey]);
        } catch (e: any) {
            console.warn('[Place watches] Live notice failed:', e?.message || e);
        }
        try {
            cb.dispatchPushNotification([pubkey], 'SYSTEM', title, body, data, 'marketplace');
        } catch (e: any) {
            console.warn('[Place watches] Push failed:', e?.message || e);
        }
        told++;
    }
    return told;
}

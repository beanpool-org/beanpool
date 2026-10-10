/**
 * What a phone keeps of a community that syncs listings by area (the worldwide one: `features.nearbyListings`,
 * scratch/global-node/DESIGN-global-sync-by-area-fable.md §2.4). Its posts read says `nearby=1`, and every answer
 * carries the member's set: the ids of the nearest `max` listings within the node's radius of the member's stored area,
 * their own listings and the ones they are tied to (apps/server routes/marketplace.ts). The node can't know what a phone
 * holds, and a listing leaves the set for reasons that move no row of it (a nearer one appeared, the member moved, the
 * author paused), so no tombstone tells the phone. The set does: the phone drops what it holds outside it and fetches
 * what it lacks by `ids=`. After a take-over the same rule is the replace, exact where the recency rule of
 * utils/posts-replace.ts is a guess.
 *
 * Between two reads a pushed listing (the node pushes only within the radius) or a listing opened by id adds a row, so
 * after every write the phone also keeps itself to at most `max` others: the nearest to the member's area, or without
 * one the newest. The node guarantees "within the radius, or yours"; the phone guarantees "at most max".
 *
 * Never dropped by either rule: the member's own listings and the ones tied to them on this phone (one they took, a
 * deal on it, a conversation about it, their answer to an event), whatever the node's set says, so a deal or a chat
 * never loses its listing.
 *
 * Pure, with no imports (as posts-replace.ts), so a server suite may run the same rule on a node's real answer.
 */

/** A listing this phone holds, as the rules read it. */
export interface NearbyHeld {
    id: string;
    lat: number | null;
    lng: number | null;
    /** `updated_at`, else `created_at`: the newest-first order without an area. */
    at: string | null;
    /** The member's own, or tied to them on this phone: never dropped. */
    kept: boolean;
}

/** The most ids one `ids=` read names (the node's IDS_MAX), and the most such reads in one cycle (design §2.4 step 3). */
export const NEARBY_IDS_PER_READ = 100;
export const NEARBY_ID_READS_PER_CYCLE = 3;

/** The listings a node's answer says are the member's set, or null when the answer carries none (a node without it). */
export function nearbySetOf(body: unknown): { posts: any[]; set: string[] } | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const b = body as { posts?: unknown; set?: unknown };
    if (!Array.isArray(b.posts) || !Array.isArray(b.set)) return null;
    if (!b.set.every(id => typeof id === 'string' && id !== '')) return null;
    return { posts: b.posts, set: b.set as string[] };
}

/**
 * What the set says to do: `drop`, the held listings outside it that are neither kept nor `fresh` (written after the set
 * was worked out: a push replayed over this cycle, which the next set will name or drop); `missing`, the set's ids this
 * phone doesn't hold, in the set's order (nearest first), each once.
 */
export function nearbyReconcile(
    held: readonly NearbyHeld[],
    set: readonly string[],
    fresh: ReadonlySet<string> = new Set(),
): { drop: string[]; missing: string[] } {
    const inSet = new Set(set);
    const holding = new Set(held.map(h => h.id));
    const drop = held.filter(h => !h.kept && !inSet.has(h.id) && !fresh.has(h.id)).map(h => h.id);
    const missing: string[] = [];
    const named = new Set<string>();
    for (const id of set) {
        if (holding.has(id) || named.has(id)) continue;
        named.add(id);
        missing.push(id);
    }
    return { drop, missing };
}

/** The `ids=` reads for `missing`: at most `perRead` ids each, at most `reads` of them; the rest wait for the next cycle. */
export function nearbyIdReads(missing: readonly string[], perRead = NEARBY_IDS_PER_READ, reads = NEARBY_ID_READS_PER_CYCLE): string[][] {
    const out: string[][] = [];
    for (let i = 0; i < missing.length && out.length < reads; i += perRead) out.push(missing.slice(i, i + perRead));
    return out;
}

const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle km, as the node measures (engine geo.ts haversineKm). */
export function nearbyKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2
        + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)));
}

function placed(h: NearbyHeld): boolean {
    return typeof h.lat === 'number' && typeof h.lng === 'number' && Number.isFinite(h.lat) && Number.isFinite(h.lng);
}

/**
 * The held listings beyond the `max` this phone keeps besides its kept ones: with an area, the nearest `max` stay (a
 * listing with no place counts as the farthest); without one, the newest `max`. Nothing goes while the others number
 * `max` or fewer, so a reconciled set (at most `max` near listings) is never cut by it.
 */
export function nearbyPrune(held: readonly NearbyHeld[], area: { lat: number; lng: number } | null, max: number): string[] {
    const others = held.filter(h => !h.kept);
    const cap = Number.isFinite(max) && max >= 0 ? Math.floor(max) : Infinity;
    if (others.length <= cap) return [];
    const byTime = (a: NearbyHeld, b: NearbyHeld) => ((b.at ?? '') < (a.at ?? '') ? -1 : (b.at ?? '') > (a.at ?? '') ? 1 : 0)
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    let ranked: NearbyHeld[];
    if (area && Number.isFinite(area.lat) && Number.isFinite(area.lng)) {
        const measured = others.map(h => ({ h, d: placed(h) ? nearbyKm(area.lat, area.lng, h.lat as number, h.lng as number) : Infinity }));
        measured.sort((a, b) => (a.d === b.d ? 0 : a.d < b.d ? -1 : 1) || byTime(a.h, b.h));
        ranked = measured.map(m => m.h);
    } else {
        ranked = [...others].sort(byTime);
    }
    return ranked.slice(cap).map(h => h.id);
}

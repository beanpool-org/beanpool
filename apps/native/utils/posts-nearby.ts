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
 * never loses its listing; and the ones the node's answer names `tied` (its own and tied ids of the set), which covers
 * a tie this phone holds no row for: a deal made on another device, or older than the newest deals it reads.
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
    /** Taken off (a removal pushed: `cancelled`, inactive): no longer on the board, so it goes before any listing that is. */
    off?: boolean;
}

/** The most ids one `ids=` read names (the node's IDS_MAX), and the most such reads in one cycle (design §2.4 step 3). */
export const NEARBY_IDS_PER_READ = 100;
export const NEARBY_ID_READS_PER_CYCLE = 3;

const isIds = (v: unknown[]): v is string[] => v.every(id => typeof id === 'string' && id !== '');

/**
 * The listings a node's answer says are the member's set, or null when the answer carries none (a node without it).
 * `tied`: the ids of the set the node says are the member's own or tied to them, or null from a node that doesn't say.
 *
 * The contract: `tied` stays string[]; a new shape gets a new field name (the node writes it in apps/server routes/
 * marketplace.ts). One this phone can't read (not a list, an id not a string) is read as absent, never as a refused
 * answer: `tied` only adds keeps, so the phone keeps its stored ties (nearby_tied) and nothing goes on its account, where
 * refusing would stop every listing update on this build (the confirmation review of #1778, finding 2).
 */
export function nearbySetOf(body: unknown): { posts: any[]; set: string[]; tied: string[] | null } | null {
    const page = nearbyPageOf(body);
    return page && page.set ? { posts: page.posts, set: page.set, tied: page.tied } : null;
}

/** One page of a read by area, as nearbyPageOf reads it. */
export interface NearbyPage {
    posts: any[];
    /** The member's set, where the page names it: the read's last page, or each page from a node before `setOnce`. */
    set: string[] | null;
    /** As nearbySetOf reads it, beside a set only. */
    tied: string[] | null;
    /** The node's hash of the set, where it says one. */
    setHash: string | null;
    /** Where the page names no set because the one this phone holds is still the set: the hash this phone sent. */
    setUnchanged: string | null;
    /**
     * Where the page names the set as what changed against the one this phone holds (`setAdd`, `setDrop`: a phone that
     * says `setDiff=1`), each as an id list or null for one this phone can't read; absent on a page that carries neither.
     */
    diff?: { setAdd: string[] | null; setDrop: string[] | null };
}

/**
 * One page of a read by area, or null for an answer that isn't one (a bare list: the node's switch went off; a set this
 * phone can't read). The phone says `setOnce=1`, and a node that knows it names the set on the read's last page only
 * (the pages before it are `{ posts }`), since the phone reconciles after the last page anyway (REPORT-geosync-load-B,
 * item 1: at a busy town the ids are ~11 KB gzipped, and rode on each page). A node before it names the set on each.
 */
export function nearbyPageOf(body: unknown): NearbyPage | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const b = body as { posts?: unknown; set?: unknown; tied?: unknown; setHash?: unknown; setUnchanged?: unknown; setAdd?: unknown; setDrop?: unknown };
    if (!Array.isArray(b.posts)) return null;
    if (b.set !== undefined && !(Array.isArray(b.set) && isIds(b.set))) return null;
    const set = Array.isArray(b.set) ? b.set : null;
    const idsOf = (v: unknown) => (Array.isArray(v) && isIds(v) ? v : null);
    const diff = b.setAdd !== undefined || b.setDrop !== undefined ? { setAdd: idsOf(b.setAdd), setDrop: idsOf(b.setDrop) } : undefined;
    return {
        posts: b.posts,
        set,
        tied: (set || diff) && Array.isArray(b.tied) && isIds(b.tied) ? b.tied : null,
        setHash: typeof b.setHash === 'string' && b.setHash !== '' ? b.setHash : null,
        setUnchanged: typeof b.setUnchanged === 'string' && b.setUnchanged !== '' ? b.setUnchanged : null,
        ...(diff ? { diff } : {}),
    };
}

/**
 * The set a diff names (scratch/global-node/DESIGN-nearby-set-diff-fable.md §2): the one held less `setDrop`, then
 * `setAdd` (in the node's order, nearest first), each id once; `tied` the page's where it names one, else the held. The
 * phone writes it only where it hashes to the page's `setHash` (nearbyLastSet).
 */
export function nearbyApplyDiff(
    held: { set: readonly string[]; tied: readonly string[] },
    page: { setAdd: readonly string[]; setDrop: readonly string[]; tied: readonly string[] | null },
): { set: string[]; tied: string[] } {
    const drop = new Set(page.setDrop);
    const seen = new Set<string>();
    const set: string[] = [];
    for (const id of held.set) if (!drop.has(id) && !seen.has(id)) { seen.add(id); set.push(id); }
    for (const id of page.setAdd) if (!seen.has(id)) { seen.add(id); set.push(id); }
    return { set, tied: [...(page.tied ?? held.tied)] };
}

/**
 * The set a read ends with, from its last page: the one the node names (`named`); or, when the page names none and says
 * `setUnchanged` with the hash this phone sent (`held.hash`, the set it holds), that one (REPORT-geosync-load-B, item 2).
 * A field no node before it sends: an answer that merely lacks the set (a node before it, cut or altered on the way, whose
 * `setHash` may well equal the held one) is no end this phone can read (null), and the read is cut short there. So is
 * another hash.
 *
 * Or, where the page names what changed (`setAdd`, `setDrop`), the held set with the diff applied (nearbyApplyDiff),
 * only when that hashes (`hashOf`: utils/nearby-hash.ts, passed in so this file stays import-free) to the page's
 * `setHash`. A diff that doesn't, one with no held set (or its `tied`) to apply to, or one this phone can't read is no
 * end (null): never a silently wrong set. The caller then forgets what it holds (services/pillar-sync.ts), so the next
 * read is named the set whole.
 */
export function nearbyLastSet(
    last: NearbyPage,
    held: { set: string[]; tied?: string[] | null; hash: string } | null,
    hashOf?: (ids: readonly string[], tied: readonly string[]) => string,
): { set: string[]; tied: string[] | null; setHash: string | null; named: boolean } | null {
    if (last.set) return { set: last.set, tied: last.tied, setHash: last.setHash, named: true };
    if (last.diff) {
        const { setAdd, setDrop } = last.diff;
        const heldTied = held?.tied ?? null;
        if (!held || !hashOf || !setAdd || !setDrop || last.setHash === null || (last.tied === null && heldTied === null)) return null;
        const applied = nearbyApplyDiff({ set: held.set, tied: heldTied ?? [] }, { setAdd, setDrop, tied: last.tied });
        return hashOf(applied.set, applied.tied) === last.setHash ? { set: applied.set, tied: applied.tied, setHash: last.setHash, named: true } : null;
    }
    if (held && last.setUnchanged !== null && last.setUnchanged === held.hash) return { set: held.set, tied: null, setHash: held.hash, named: false };
    return null;
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
 * listing with no place counts as the farthest); without one, the newest `max`. One taken off ranks after every one
 * still on the board, so a removal frees its slot at the next listing pushed past the cap, rather than the farthest live
 * listing going while the removed one waits for the next reconcile (the review of #1778, finding 7). Nothing goes while
 * the others number `max` or fewer, so a reconciled set (at most `max` near listings) is never cut by it.
 */
export function nearbyPrune(held: readonly NearbyHeld[], area: { lat: number; lng: number } | null, max: number): string[] {
    const others = held.filter(h => !h.kept);
    const cap = Number.isFinite(max) && max >= 0 ? Math.floor(max) : Infinity;
    if (others.length <= cap) return [];
    const byTime = (a: NearbyHeld, b: NearbyHeld) => ((b.at ?? '') < (a.at ?? '') ? -1 : (b.at ?? '') > (a.at ?? '') ? 1 : 0)
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const byOff = (a: NearbyHeld, b: NearbyHeld) => (a.off ? 1 : 0) - (b.off ? 1 : 0);
    let ranked: NearbyHeld[];
    if (area && Number.isFinite(area.lat) && Number.isFinite(area.lng)) {
        const measured = others.map(h => ({ h, d: placed(h) ? nearbyKm(area.lat, area.lng, h.lat as number, h.lng as number) : Infinity }));
        measured.sort((a, b) => byOff(a.h, b.h) || (a.d === b.d ? 0 : a.d < b.d ? -1 : 1) || byTime(a.h, b.h));
        ranked = measured.map(m => m.h);
    } else {
        ranked = [...others].sort((a, b) => byOff(a, b) || byTime(a, b));
    }
    return ranked.slice(cap).map(h => h.id);
}

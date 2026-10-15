/**
 * Finding people on a community that says `membersOnDemand` (DESIGN-global-members-by-area §2.3, #1792): the phone holds
 * only the cards it has a reason to show (utils/members-on-demand.ts), so a search asks the node (`q=`, a name's first
 * 2 characters or more, at most 20 answers) and "Near you" is the node's 50 closest members to the member's area
 * (`lat&lng&limit=50`). Offline, or when the node can't answer, the screens fall back to the cards held, with the local
 * search they always had. An answer is shown, not kept: a card is kept when the member opens it (the profile by key,
 * §2.2.4), so the held cards stay the people this member has dealt with.
 */
import { applyDelta, copyForRead, signedGet } from './db';
import { isMemberKey, membersKeysPath } from './members-on-demand';

/** The node refuses a shorter search: nobody lists a membership by typing a letter. */
export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX = 20;
export const NEAR_MAX = 50;

/** The search read for what was typed, or null when it is too short to ask the node. */
export function searchPath(typed: string): string | null {
    const q = typed.trim();
    if (q.length < SEARCH_MIN_CHARS) return null;
    return `/api/members?q=${encodeURIComponent(q)}&limit=${SEARCH_MAX}`;
}

/** The "near you" read: the node's nearest members to the area, at most 50. */
export function nearPath(area: { lat: number; lng: number }): string {
    return `/api/members?lat=${encodeURIComponent(String(area.lat))}&lng=${encodeURIComponent(String(area.lng))}&limit=${NEAR_MAX}`;
}

/** A directory row as the node sends it, in the shape of a held card (the members table's columns the lists read). */
export function asHeldRow(m: any): { public_key: string; callsign: string; avatar_url: string | null; joined_at: string | null; earned_credit: number; last_active_at: null; distance_km: number | null } | null {
    const key = m?.publicKey ?? m?.public_key;
    if (typeof key !== 'string' || key === '') return null;
    return {
        public_key: key,
        callsign: typeof m.callsign === 'string' && m.callsign !== '' ? m.callsign : key.slice(0, 8),
        avatar_url: m.avatarUrl ?? m.avatar_url ?? null,
        joined_at: m.joinedAt ?? m.joined_at ?? null,
        earned_credit: Number(m.earnedCredit ?? m.earned_credit ?? 0) || 0,
        last_active_at: null,
        distance_km: typeof m.distanceKm === 'number' ? m.distanceKm : null,
    };
}

/** The copy each answered row was read for, so a card kept from it later lands only there (keepCards). */
const readFor = new WeakMap<object, Awaited<ReturnType<typeof copyForRead>>>();

/**
 * Where anyone can join in a minute the node counts each search by name and each "near you" against a day's budget
 * (100 each a member), so the phone never spends one the member didn't ask for (Marty's call 3, 15 Oct 2026): the same
 * search or "near you" asked again soon, for the same copy, is answered from here. A re-render, a sort, a block, a
 * screen opened again: none of them asks the node twice. Only those two reads; a read by key is never counted.
 */
export const RECENT_LOOKUP_MS = 2 * 60 * 1000;
const RECENT_LOOKUPS_MAX = 50;
const recentLookups = new Map<string, { at: number; rows: any[] }>();
const COUNTED_LOOKUP = /^\/api\/members\?(q|lat)=/;
/** Which day the last refused lookup had used up: the searches by name, the "near you" reads, or neither. */
let lastSpent: 'search' | 'near' | null = null;

/** Whether the last lookup the node refused was refused because the member had used up today's (a 429 day budget). */
export function lookUpWasSpent(): boolean {
    return lastSpent !== null;
}

/**
 * Which of today's lookups is used up, by the last refusal: 'near' while a search by name still works (the node's own
 * words say so), 'search' for the searches by name, or null (#1965 review N4).
 */
export function lookUpSpentKind(): 'search' | 'near' | null {
    return lastSpent;
}

/** Forget the answers kept (tests). Another identity or node never reads them: each is kept under its copy's name and generation. */
export function forgetRecentLookups(): void {
    recentLookups.clear();
    lastSpent = null;
}

/**
 * Ask the node one of the small reads above. The rows, or null when the node could not be asked or did not answer a list
 * (offline, busy, refused): the screen then shows the cards held.
 */
export async function lookUpMembers(path: string, options?: { signal?: AbortSignal }, nowMs = Date.now()): Promise<any[] | null> {
    try {
        const copy = await copyForRead();
        const counted = COUNTED_LOOKUP.test(path);
        const key = `${copy.dbName ?? ''}|${copy.generation}|${path}`;
        const kept = counted ? recentLookups.get(key) : undefined;
        if (kept && nowMs - kept.at < RECENT_LOOKUP_MS) return kept.rows;
        const res = await signedGet(path, { signal: options?.signal });
        if (!res.ok) {
            if (res.status === 429) {
                const refusal = await res.json().catch(() => null);
                const code = typeof refusal?.code === 'string' ? refusal.code : '';
                lastSpent = !code.endsWith('_day_budget') ? null : code.startsWith('nearest') ? 'near' : 'search';
            }
            return null;
        }
        const body = await res.json();
        if (!Array.isArray(body)) return null;
        const rows = body.map(asHeldRow).filter((r): r is NonNullable<ReturnType<typeof asHeldRow>> => r !== null);
        for (const r of rows) readFor.set(r, copy);
        lastSpent = null;
        if (counted) {
            recentLookups.delete(key);
            recentLookups.set(key, { at: nowMs, rows });
            if (recentLookups.size > RECENT_LOOKUPS_MAX) recentLookups.delete(recentLookups.keys().next().value!);
        }
        return rows;
    } catch {
        return null;
    }
}

/** A card opened on a profile is fetched again by key when it is missing or older than this (§1, the public profile). */
export const CARD_FRESH_MS = 24 * 60 * 60 * 1000;

/** True when a profile should fetch this card by key: none held, never fetched by key, or fetched over a day ago. */
export function cardNeedsFetch(row: { card_fetched_at?: string | null } | null | undefined, nowMs: number): boolean {
    if (!row) return true;
    const at = row.card_fetched_at ? Date.parse(row.card_fetched_at) : NaN;
    return !Number.isFinite(at) || nowMs - at > CARD_FRESH_MS;
}

/**
 * The card of one member, fetched by key and kept, stamped now (§2.2.4): 'fetched', 'none' when the node has no such
 * member, or 'unreachable' (offline, busy, refused), when the profile shows the name it was given and "Connect to see
 * more", never a spinner that never ends. Written only into the copy open when the read started (copyForRead).
 */
export async function fetchCardByKey(key: string): Promise<'fetched' | 'none' | 'unreachable'> {
    if (!isMemberKey(key)) return 'none';
    try {
        const copy = await copyForRead();
        const res = await signedGet(membersKeysPath([key]));
        if (!res.ok) return 'unreachable';
        const body = await res.json();
        if (!Array.isArray(body)) return 'unreachable';
        const row = body.find(m => m?.publicKey === key);
        if (!row) return 'none';
        const wrote = await applyDelta({ members: [row], membersByKey: true, membersFetched: { keys: [key], at: new Date().toISOString() } }, copy.dbName, copy.generation);
        return wrote === false ? 'unreachable' : 'fetched';
    } catch {
        return 'unreachable';
    }
}

/**
 * Keep the cards of results the member acted on (a DM started from a search result, §2.2.4), stamped now, in the copy
 * their search was read for (a row from elsewhere: the copy open now). Rows read for different copies are not kept.
 */
export async function keepCards(rows: readonly any[]): Promise<void> {
    const keys = rows.map(r => r?.public_key ?? r?.publicKey).filter(isMemberKey);
    if (keys.length === 0) return;
    try {
        const copies = rows.map(r => (r && typeof r === 'object' ? readFor.get(r) : undefined));
        const copy = copies[0] ?? await copyForRead();
        if (copies.some(c => (c?.dbName ?? copy.dbName) !== copy.dbName)) return;
        await applyDelta({ members: rows, membersFetched: { keys, at: new Date().toISOString() } }, copy.dbName, copy.generation);
    } catch {
        // Kept next time the member opens the card.
    }
}

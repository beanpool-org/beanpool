/**
 * The global community's way out, read by the phone (design §3.1, §3.2, §3.5; the server is
 * apps/server/src/routes/global-directory.ts, G5): communities near you, the "Find your community"
 * card's one request, and a member's place watches.
 *
 *   GET    /api/global/communities?lat&lng&q&limit   public: the mirrored directory, nearest first from a point
 *   GET    /api/global/home?lat&lng                  public, better signed: everything the card needs at once
 *   POST   /api/global/watches { lat, lng }          signed, a member: "tell me when one starts near here"
 *   DELETE /api/global/watches/:id                   signed, a member: stop watching
 *
 * Every row the directory gives is somebody else's publication (anyone who runs a node can publish one), so
 * each field is checked here again and one that isn't what it claims is dropped: the server already does this,
 * and the phone does not take its word for it. Above all a community's address: it is where a knock goes, signed
 * with the member's key, so it must be an https origin, and never the global node itself (utils/knock.ts).
 *
 * A node without these routes (every local community: they answer 404 `feature_off`) reads as "not available".
 */

import { buildSignedHeaders } from './crypto';
import { signedDelete, signedPost } from './node-post';
import { GLOBAL_NODE_URL } from './node-profile';
import type { BeanPoolIdentity } from './identity';

const TIMEOUT_MS = 15_000;
const MAX_NAME_CHARS = 80;

export interface Point { lat: number; lng: number }

/** A community as the directory lists it. */
export interface DirectoryCommunity {
    key: string;
    /** Null when it published none: shown as "A community". */
    name: string | null;
    /** Its https origin, or null: listed by name and distance, with nothing to knock on. */
    url: string | null;
    lat: number | null;
    lng: number | null;
    radiusKm: number | null;
    memberCount: number | null;
    contactEmail: string | null;
    contactPhone: string | null;
    /** Kilometres from the point asked about (0.1 km), or null with no point or no place. */
    distanceKm: number | null;
}

export interface PlaceWatch { id: string; lat: number; lng: number; radiusKm: number; createdAt: string }

/** What the "Find your community" card reads, in one request. */
export interface GlobalHome {
    /** Where the point came from: the phone's (`request`), the member's own coarse area (`area`), or none. */
    point: 'request' | 'area' | null;
    communities: DirectoryCommunity[];
    communityCount: number;
    nearbyPosts: { radiusKm: number; count: number; more: boolean } | null;
    /** null: not a member's read. */
    watches: PlaceWatch[] | null;
}

export type Fetched<T> =
    | { ok: true; value: T }
    /** The node answered and said no, in its own words when it gave them. */
    | { ok: false; kind: 'refused'; status: number; message: string }
    /** This node has no directory (a local community, or the switch is off). */
    | { ok: false; kind: 'unavailable'; message: string }
    /** No answer, or not one we can read. */
    | { ok: false; kind: 'unreachable'; message: string };

export const DIRECTORY_MESSAGES = {
    unavailable: 'Finding communities works on the worldwide community only.',
    unreachable: "Couldn't reach the worldwide community. Check your connection and try again.",
    unreadable: 'The worldwide community sent an answer this app could not read. Please try again later.',
} as const;

// ── Checking what the directory says ────────────────────────────────────────────────────────────────────────

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function text(v: unknown, max: number): string | null {
    if (typeof v !== 'string') return null;
    // Control and direction-changing characters out: this is a stranger's text shown on this phone.
    const clean = v.replace(/[\p{Cc}‎‏‪-‮⁦-⁩]/gu, '').replace(/\s+/g, ' ').trim();
    if (!clean) return null;
    return Array.from(clean).slice(0, max).join('');
}

function host(url: string): string | null {
    // The host must run to the end or to a path, query or fragment: a login (`user.name:1234@real-host`) would
    // otherwise read as the host `user.name:1234`, so anything with an `@` before the path is no host at all.
    const m = /^https:\/\/([^/?#@\s]+)(?=[/?#]|$)/i.exec(url);
    return m ? m[1].toLowerCase().replace(/:443$/, '') : null;
}

/**
 * A community's address as the phone will use it: an https origin with a host name, no path, no credentials.
 * Anything else (http, a path-only string, an IP address, a login in the URL) is no address. The global node
 * itself is never a community's address here: nobody knocks on the lobby, and a stale or hostile directory row
 * pointing at it must not become a signed request to it.
 */
export function communityOrigin(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!/^https:\/\//i.test(trimmed) || trimmed.length > 300) return null;
    const h = host(trimmed);
    if (!h) return null;
    const name = h.replace(/:\d{1,5}$/, '');
    const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
    // A host name with at least one dot, made of labels; an IPv4 literal is refused (it is all digits).
    if (!new RegExp(`^${label}(?:\\.${label})+$`).test(name) || /^[\d.]+$/.test(name)) return null;
    if (h === host(GLOBAL_NODE_URL)) return null;
    return `https://${h}`;
}

export function readCommunity(raw: unknown): DirectoryCommunity | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const key = text(r.key, 200);
    if (!key) return null;
    const placed = finite(r.lat) && finite(r.lng) && Math.abs(r.lat as number) <= 90 && Math.abs(r.lng as number) <= 180;
    const count = finite(r.memberCount) && (r.memberCount as number) >= 0 ? Math.floor(r.memberCount as number) : null;
    return {
        key,
        name: text(r.name, MAX_NAME_CHARS),
        url: communityOrigin(r.url),
        lat: placed ? (r.lat as number) : null,
        lng: placed ? (r.lng as number) : null,
        radiusKm: finite(r.radiusKm) && (r.radiusKm as number) > 0 ? (r.radiusKm as number) : null,
        memberCount: count,
        contactEmail: text(r.contactEmail, 200),
        contactPhone: text(r.contactPhone, 60),
        distanceKm: finite(r.distanceKm) && (r.distanceKm as number) >= 0 ? (r.distanceKm as number) : null,
    };
}

function readCommunities(raw: unknown): DirectoryCommunity[] {
    return Array.isArray(raw) ? raw.map(readCommunity).filter((c): c is DirectoryCommunity => c !== null) : [];
}

function readWatch(raw: unknown): PlaceWatch | null {
    if (!raw || typeof raw !== 'object') return null;
    const w = raw as Record<string, unknown>;
    if (typeof w.id !== 'string' || !finite(w.lat) || !finite(w.lng) || !finite(w.radiusKm)) return null;
    return { id: w.id, lat: w.lat, lng: w.lng, radiusKm: w.radiusKm, createdAt: typeof w.createdAt === 'string' ? w.createdAt : '' };
}

export function readGlobalHome(body: unknown): GlobalHome | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const b = body as Record<string, unknown>;
    if (!Array.isArray(b.communities)) return null;
    const np = b.nearbyPosts as Record<string, unknown> | null | undefined;
    return {
        point: b.point === 'request' || b.point === 'area' ? b.point : null,
        communities: readCommunities(b.communities),
        communityCount: finite(b.communityCount) ? Math.max(0, Math.floor(b.communityCount)) : 0,
        nearbyPosts: np && finite(np.count) && finite(np.radiusKm)
            ? { radiusKm: np.radiusKm, count: Math.max(0, Math.floor(np.count)), more: np.more === true }
            : null,
        watches: Array.isArray(b.watches) ? b.watches.map(readWatch).filter((w): w is PlaceWatch => w !== null) : null,
    };
}

// ── Asking ──────────────────────────────────────────────────────────────────────────────────────────────────

function pointQuery(point: Point | null | undefined): string[] {
    if (!point || !finite(point.lat) || !finite(point.lng)) return [];
    // Four decimals (~11 m) is plenty for "near"; the node rounds what it keeps anyway.
    return [`lat=${point.lat.toFixed(4)}`, `lng=${point.lng.toFixed(4)}`];
}

async function errorText(res: Response): Promise<string | null> {
    try {
        const body = await res.json();
        return typeof body?.error === 'string' && body.error.trim() ? body.error : null;
    } catch {
        return null;
    }
}

/**
 * A GET to the global node. Signed when an identity is given (the signature covers the path, never the query:
 * the node verifies over `ctx.path`), so a member's own watches come back with the card.
 */
async function getJson<T>(
    path: string, query: string[], read: (body: unknown) => T | null,
    identity?: BeanPoolIdentity | null, base: string = GLOBAL_NODE_URL,
): Promise<Fetched<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const headers: Record<string, string> = identity?.privateKey && identity.publicKey
            ? await buildSignedHeaders('GET', path, '', identity.privateKey, identity.publicKey)
            : { Accept: 'application/json' };
        const url = `${base.replace(/\/+$/, '')}${path}${query.length ? `?${query.join('&')}` : ''}`;
        const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
        if (res.status === 404) {
            return { ok: false, kind: 'unavailable', message: (await errorText(res)) ?? DIRECTORY_MESSAGES.unavailable };
        }
        if (!res.ok) {
            return { ok: false, kind: 'refused', status: res.status, message: (await errorText(res)) ?? DIRECTORY_MESSAGES.unreadable };
        }
        const value = read(await res.json().catch(() => null));
        return value ? { ok: true, value } : { ok: false, kind: 'unreachable', message: DIRECTORY_MESSAGES.unreadable };
    } catch {
        return { ok: false, kind: 'unreachable', message: DIRECTORY_MESSAGES.unreachable };
    } finally {
        clearTimeout(timer);
    }
}

/** The card's one request. Signed when the member has an identity, so their watches come back with it. */
export function fetchGlobalHome(point: Point | null, identity?: BeanPoolIdentity | null, base?: string): Promise<Fetched<GlobalHome>> {
    return getJson('/api/global/home', pointQuery(point), readGlobalHome, identity, base);
}

export interface CommunitySearch { communities: DirectoryCommunity[]; total: number }

/** Communities nearest `point` first (by name without one), optionally only those whose name matches `q`. */
export function fetchCommunities(
    opts: { point?: Point | null; q?: string; limit?: number; offset?: number } = {}, base?: string,
): Promise<Fetched<CommunitySearch>> {
    const query = pointQuery(opts.point);
    const q = opts.q?.trim();
    if (q) query.push(`q=${encodeURIComponent(Array.from(q).slice(0, 80).join(''))}`);
    if (opts.limit !== undefined) query.push(`limit=${Math.max(1, Math.min(50, Math.floor(opts.limit)))}`);
    if (opts.offset) query.push(`offset=${Math.max(0, Math.floor(opts.offset))}`);
    return getJson('/api/global/communities', query, body => {
        if (!body || typeof body !== 'object' || !Array.isArray((body as any).communities)) return null;
        const b = body as { communities: unknown[]; total?: unknown };
        const communities = readCommunities(b.communities);
        return { communities, total: finite(b.total) ? b.total : communities.length };
    }, null, base);
}

/** "Tell me when a community starts near here": the node keeps the ~10 km cell, never the exact point. */
export async function watchPlace(identity: BeanPoolIdentity, point: Point, base: string = GLOBAL_NODE_URL): Promise<Fetched<PlaceWatch>> {
    try {
        const res = await signedPost(base, '/api/global/watches', { lat: point.lat, lng: point.lng }, identity);
        if (res.status === 404) return { ok: false, kind: 'unavailable', message: (await errorText(res)) ?? DIRECTORY_MESSAGES.unavailable };
        if (!res.ok) return { ok: false, kind: 'refused', status: res.status, message: (await errorText(res)) ?? DIRECTORY_MESSAGES.unreadable };
        const watch = readWatch((await res.json().catch(() => null))?.watch);
        return watch ? { ok: true, value: watch } : { ok: false, kind: 'unreachable', message: DIRECTORY_MESSAGES.unreadable };
    } catch {
        return { ok: false, kind: 'unreachable', message: DIRECTORY_MESSAGES.unreachable };
    }
}

export async function unwatchPlace(identity: BeanPoolIdentity, id: string, base: string = GLOBAL_NODE_URL): Promise<Fetched<true>> {
    try {
        const res = await signedDelete(base, `/api/global/watches/${encodeURIComponent(id)}`, identity);
        if (!res.ok) return { ok: false, kind: 'refused', status: res.status, message: (await errorText(res)) ?? DIRECTORY_MESSAGES.unreadable };
        return { ok: true, value: true };
    } catch {
        return { ok: false, kind: 'unreachable', message: DIRECTORY_MESSAGES.unreachable };
    }
}

// ── Showing it ──────────────────────────────────────────────────────────────────────────────────────────────

export function communityLabel(c: Pick<DirectoryCommunity, 'name'>): string {
    return c.name ?? 'A community';
}

/** "12 km away · 40 members", whatever of that is known. */
export function communityFacts(c: Pick<DirectoryCommunity, 'distanceKm' | 'memberCount'>): string {
    const parts: string[] = [];
    if (c.distanceKm !== null) {
        parts.push(c.distanceKm < 1 ? 'Less than 1 km away' : `${c.distanceKm < 10 ? c.distanceKm.toFixed(1) : Math.round(c.distanceKm).toLocaleString('en')} km away`);
    }
    if (c.memberCount !== null) parts.push(c.memberCount === 1 ? '1 member' : `${c.memberCount.toLocaleString('en')} members`);
    return parts.join(' · ');
}

/** The card's headline, from what the node said (or couldn't). */
export function findCommunityCardCopy(home: Fetched<GlobalHome> | null, hasPoint: boolean): { title: string; body: string } {
    const title = 'Find your community';
    if (!home) return { title, body: 'Looking for communities near you…' };
    if (!home.ok) return { title, body: home.message };
    const { communities, communityCount } = home.value;
    if (communities.length > 0) {
        const nearest = communities[0];
        const where = communityFacts({ distanceKm: nearest.distanceKm, memberCount: null }).toLowerCase() || 'near you';
        const more = communities.length > 1 ? `, and ${communities.length - 1} more nearby` : '';
        return { title, body: `${communityLabel(nearest)} is ${where}${more}. Ask to join, and trade with your neighbours there.` };
    }
    if (!hasPoint && home.value.point === null) {
        return { title, body: `${communityCount.toLocaleString('en')} communit${communityCount === 1 ? 'y is' : 'ies are'} listed. Share your location to see the nearest.` };
    }
    return { title, body: 'No community is listed near you yet. Start one, or ask to be told when one starts here.' };
}

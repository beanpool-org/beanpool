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
import { communityOrigin } from './community-origin';
import { signedDelete, signedPost } from './node-post';
import { GLOBAL_NODE_URL } from './node-profile';
import type { BeanPoolIdentity } from './identity';
import {
    FIND_COMMUNITY_WORDS, PLACE_WATCH_LIMIT_CODE, communitiesNear, findCommunityState, formatCount, formatNumber, knownCommunityCount, notAnsweringLately, placeWatchLimitLine, roundPointToArea, t, tn, shownCount, type CircleCard, type CircleDemand,
} from '@beanpool/core';

/** A community's address as the phone will use it (utils/community-origin.ts): kept there so Home's pure rules share it. */
export { communityOrigin };

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
    /**
     * Its last push to the directory (an ISO time), or null when the node didn't say (an older global node). Past 36 h
     * the row says "Not answering lately" (notAnsweringLine; front doors S13).
     */
    lastSeenAt?: string | null;
    /** How quickly it answers requests to join (Lounge L1, entry S1: 'week' | 'slow' | 'none' | null). */
    answers?: 'week' | 'slow' | 'none' | null;
}

export interface PlaceWatch { id: string; lat: number; lng: number; radiusKm: number; createdAt: string; wouldHelp?: boolean }

/** What the "Find your community" card reads, in one request. */
export interface GlobalHome {
    /** Where the point came from: the phone's (`request`), the member's own coarse area (`area`), or none. */
    point: 'request' | 'area' | null;
    communities: DirectoryCommunity[];
    /** Every community listed; null when the node didn't say (unknown, never 0). */
    communityCount: number | null;
    nearbyPosts: { radiusKm: number; count: number; more: boolean } | null;
    /** null: not a member's read. */
    watches: PlaceWatch[] | null;
    /** When the node last fetched the directory; null: never, so "none" is not said (@beanpool/core find-community.ts). */
    directoryFetchedAt: string | null;
    /** How many are waiting around here (place circle): each null below 3. Absent from an older node. */
    demand?: CircleDemand | null;
    /** The reader's own place circle. */
    circle?: (CircleCard & { id: string }) | null;
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
        lastSeenAt: typeof r.lastSeenAt === 'string' && r.lastSeenAt.length <= 64 && Number.isFinite(Date.parse(r.lastSeenAt)) ? r.lastSeenAt : null,
        answers: r.answers === 'week' || r.answers === 'slow' || r.answers === 'none' ? r.answers : null,
    };
}

function readCommunities(raw: unknown): DirectoryCommunity[] {
    return Array.isArray(raw) ? raw.map(readCommunity).filter((c): c is DirectoryCommunity => c !== null) : [];
}

function readWatch(raw: unknown): PlaceWatch | null {
    if (!raw || typeof raw !== 'object') return null;
    const w = raw as Record<string, unknown>;
    if (typeof w.id !== 'string' || !finite(w.lat) || !finite(w.lng) || !finite(w.radiusKm)) return null;
    return { id: w.id, lat: w.lat, lng: w.lng, radiusKm: w.radiusKm, createdAt: typeof w.createdAt === 'string' ? w.createdAt : '', ...(w.wouldHelp === true ? { wouldHelp: true } : {}) };
}

function readDemand(raw: unknown): CircleDemand | null {
    if (!raw || typeof raw !== 'object') return null;
    const d = raw as Record<string, unknown>;
    return { waiting: shownCount(d.waiting), helping: shownCount(d.helping) };
}

/** A circle as the node said it, or null. Its count holds to the floor here too, whatever a node sends. */
export function readCircleCard(raw: unknown): CircleCard | null {
    if (!raw || typeof raw !== 'object') return null;
    const c = raw as Record<string, unknown>;
    const community = c.community && typeof c.community === 'object' ? c.community as Record<string, unknown> : null;
    return {
        people: shownCount(c.people),
        starting: c.starting === 'you' || c.starting === 'someone' ? c.starting : null,
        doneAt: typeof c.doneAt === 'string' ? c.doneAt : null,
        community: community && typeof community.key === 'string' ? {
            key: community.key,
            name: typeof community.name === 'string' ? community.name : null,
            url: typeof community.url === 'string' ? community.url : null,
            acceptingKnocks: typeof community.acceptingKnocks === 'boolean' ? community.acceptingKnocks : null,
        } : null,
    };
}

function readOwnCircle(raw: unknown): (CircleCard & { id: string }) | null {
    const id = (raw as { id?: unknown } | null)?.id;
    const card = readCircleCard(raw);
    return card && typeof id === 'string' && id ? { ...card, id } : null;
}

export function readGlobalHome(body: unknown): GlobalHome | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const b = body as Record<string, unknown>;
    if (!Array.isArray(b.communities)) return null;
    const np = b.nearbyPosts as Record<string, unknown> | null | undefined;
    return {
        point: b.point === 'request' || b.point === 'area' ? b.point : null,
        communities: readCommunities(b.communities),
        communityCount: knownCommunityCount(b.communityCount),
        nearbyPosts: np && finite(np.count) && finite(np.radiusKm)
            ? { radiusKm: np.radiusKm, count: Math.max(0, Math.floor(np.count)), more: np.more === true }
            : null,
        watches: Array.isArray(b.watches) ? b.watches.map(readWatch).filter((w): w is PlaceWatch => w !== null) : null,
        directoryFetchedAt: typeof b.directoryFetchedAt === 'string' && b.directoryFetchedAt ? b.directoryFetchedAt : null,
        ...(b.demand ? { demand: readDemand(b.demand) } : {}),
        ...(b.circle ? { circle: readOwnCircle(b.circle) } : {}),
    };
}

// ── Asking ──────────────────────────────────────────────────────────────────────────────────────────────────

function pointQuery(point: Point | null | undefined): string[] {
    if (!point || !finite(point.lat) || !finite(point.lng)) return [];
    // Two decimals (about a kilometre), as Home and the Market send theirs (home-store.ts, market-global.ts): the node
    // orders communities in 25 km bands and counts posts within 50 km. A query string is what proxies and CDNs log (N5).
    return [`lat=${point.lat.toFixed(2)}`, `lng=${point.lng.toFixed(2)}`];
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
        const url = `${base.replace(/\/+$/, '')}${path}${query.length ? `?${query.join('&')}` : ''}`;
        // Signed for the host of `url`: the global node's own name, so the signature is good there and nowhere else.
        const headers: Record<string, string> = identity?.privateKey && identity.publicKey
            ? await buildSignedHeaders('GET', url, '', identity.privateKey, identity.publicKey)
            : { Accept: 'application/json' };
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

/** `fetchedAt`: when the node last fetched the directory; null: never, so an empty list is unknown, not empty. */
export interface CommunitySearch { communities: DirectoryCommunity[]; total: number; fetchedAt: string | null }

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
        const b = body as { communities: unknown[]; total?: unknown; fetchedAt?: unknown };
        const communities = readCommunities(b.communities);
        const fetchedAt = typeof b.fetchedAt === 'string' && b.fetchedAt ? b.fetchedAt : null;
        return { communities, total: finite(b.total) ? b.total : communities.length, fetchedAt };
    }, null, base);
}

/**
 * "Tell me when a community starts near here": the node keeps the ~10 km cell, never the exact point, so that cell is all
 * the phone sends (@beanpool/core roundPointToArea, the node's own rule).
 */
export async function watchPlace(identity: BeanPoolIdentity, point: Point, base: string = GLOBAL_NODE_URL, opts: { wouldHelp?: boolean } = {}): Promise<Fetched<PlaceWatch>> {
    try {
        const res = await signedPost(base, '/api/global/watches', { ...roundPointToArea(point.lat, point.lng), ...opts }, identity);
        if (res.status === 404) return { ok: false, kind: 'unavailable', message: (await errorText(res)) ?? DIRECTORY_MESSAGES.unavailable };
        if (!res.ok) {
            const body = await res.json().catch(() => null) as { error?: unknown; code?: unknown; limit?: unknown } | null;
            // Watching as many places as the node allows: said in the member's language, with the node's number.
            const atLimit = body?.code === PLACE_WATCH_LIMIT_CODE && typeof body.limit === 'number' && Number.isInteger(body.limit) && body.limit > 0;
            const said = typeof body?.error === 'string' && body.error.trim() ? body.error : null;
            return { ok: false, kind: 'refused', status: res.status, message: atLimit ? placeWatchLimitLine(body!.limit as number) : said ?? DIRECTORY_MESSAGES.unreadable };
        }
        const watch = readWatch((await res.json().catch(() => null))?.watch);
        return watch ? { ok: true, value: watch } : { ok: false, kind: 'unreachable', message: DIRECTORY_MESSAGES.unreadable };
    } catch {
        return { ok: false, kind: 'unreachable', message: DIRECTORY_MESSAGES.unreachable };
    }
}

/** "I'm starting one here", on or off, by someone in the circle. The node's answer is the card as it now stands. */
export async function setCircleStarting(identity: BeanPoolIdentity, id: string, starting: boolean, base: string = GLOBAL_NODE_URL): Promise<Fetched<CircleCard>> {
    try {
        const res = await signedPost(base, `/api/global/circles/${encodeURIComponent(id)}/starting`, { starting }, identity);
        if (!res.ok) return { ok: false, kind: 'refused', status: res.status, message: (await errorText(res)) ?? DIRECTORY_MESSAGES.unreadable };
        const card = readCircleCard((await res.json().catch(() => null))?.circle);
        return card ? { ok: true, value: card } : { ok: false, kind: 'unreachable', message: DIRECTORY_MESSAGES.unreadable };
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
    return c.name ?? t('A community');
}

/**
 * "Not answering lately", in the member's language, under a community whose last push to the directory is more than 36 h
 * ago (core notAnsweringLately), or null. It is still listed, and Ask to join still works: the knock waits until it
 * answers. The web's find rows say the same (apps/pwa/src/lib/home-cards.ts).
 */
export function notAnsweringLine(c: Pick<DirectoryCommunity, 'lastSeenAt'>, now: number = Date.now()): string | null {
    return notAnsweringLately(c.lastSeenAt, now) ? t(FIND_COMMUNITY_WORDS.notAnswering) : null;
}

/** A distance of 1 km or more as the lines write it: "3.4", "12", "12,000" (one decimal under 10 km). */
const kmText = (km: number) => (km < 10 ? formatNumber(km, 1) : formatCount(Math.round(km)));

/** "12 km away · 40 members", whatever of that is known. */
export function communityFacts(c: Pick<DirectoryCommunity, 'distanceKm' | 'memberCount'>): string {
    const parts: string[] = [];
    if (c.distanceKm !== null) parts.push(c.distanceKm < 1 ? t('Less than 1 km away') : t('{distance} km away', { distance: kmText(c.distanceKm) }));
    if (c.memberCount !== null) parts.push(tn(c.memberCount, '{n} member', '{n} members', { n: formatCount(c.memberCount) }));
    return parts.join(' · ');
}

/** "9 listings within 25 km of you" (the card's count, design §3.1), or null when the node measured from no point. */
export function nearbyPostsLine(home: Pick<GlobalHome, 'nearbyPosts'>): string | null {
    if (!home.nearbyPosts) return null;
    const { count, more, radiusKm } = home.nearbyPosts;
    const values = { n: formatCount(count), km: radiusKm };
    return more ? t('{n}+ listings within {km} km of you', values) : tn(count, '{n} listing within {km} km of you', '{n} listings within {km} km of you', values);
}

/**
 * The community the card's headline names (findCommunityCardCopy): the nearest while one is near, the nearest listed
 * with a distance while all are far, else none. The card says "Not answering lately" under it (notAnsweringLine), as
 * the web's card does under its first row.
 */
export function findCardNamed(home: GlobalHome): DirectoryCommunity | null {
    const { communities } = home;
    switch (findCommunityState(home)) {
        case 'near': return communities[0];
        case 'far': return communities.find(c => c.distanceKm !== null) ?? communities[0];
        default: return null;
    }
}

/**
 * The card's headline, from what the node said (or couldn't). The rule is @beanpool/core's, shared with the web: "No
 * community near you yet." is the one "none" sentence, said only once the directory has loaded; a community 12,000 km
 * away is named with its distance under it, never as near you. The card's buttons (Start a community, Tell me when
 * one starts here) carry the actions, so the sentence names none.
 */
export function findCommunityCardCopy(home: Fetched<GlobalHome> | null, hasPoint: boolean): { title: string; body: string } {
    const title = t(FIND_COMMUNITY_WORDS.title);
    if (!home) return { title, body: t('Looking for communities near you…') };
    if (!home.ok) return { title, body: home.message };
    const { communities } = home.value;
    switch (findCommunityState(home.value)) {
        case 'near': {
            const nearest = findCardNamed(home.value)!;
            const name = communityLabel(nearest);
            const km = nearest.distanceKm;
            // "More nearby" counts only those within 250 km: never one 12,000 km away.
            const more = communitiesNear(communities).length - 1;
            return { title, body: nearSentence(name, km, more) };
        }
        case 'far': {
            const nearest = findCardNamed(home.value)!;
            const where = communityFacts({ distanceKm: nearest.distanceKm, memberCount: null });
            return { title, body: t('{none} The nearest listed is {name}, {where}.', { none: t(FIND_COMMUNITY_WORDS.noneNear), name: communityLabel(nearest), where }) };
        }
        case 'none':
            return { title, body: t(FIND_COMMUNITY_WORDS.noneNear) };
        case 'not_loaded':
            return { title, body: t(FIND_COMMUNITY_WORDS.notLoaded) };
        case 'no_point': {
            const n = home.value.communityCount;
            const see = hasPoint ? t('Tap Communities near you to see the nearest.') : t('Use your location, or type your town, to see the nearest.');
            return { title, body: n === null ? see : tn(n, '{n} community is listed. {see}', '{n} communities are listed. {see}', { n: formatCount(n), see }) };
        }
    }
}

/** The near card's sentence: where the nearest is (its distance, or near you), and how many more are near. */
function nearSentence(name: string, km: number | null, more: number): string {
    if (km === null) {
        return more > 0
            ? tn(more, '{name} is near you, and {n} more nearby. Ask to join, and trade with your neighbours there.', '{name} is near you, and {n} more nearby. Ask to join, and trade with your neighbours there.', { name })
            : t('{name} is near you. Ask to join, and trade with your neighbours there.', { name });
    }
    if (km < 1) {
        return more > 0
            ? tn(more, '{name} is less than 1 km away, and {n} more nearby. Ask to join, and trade with your neighbours there.', '{name} is less than 1 km away, and {n} more nearby. Ask to join, and trade with your neighbours there.', { name })
            : t('{name} is less than 1 km away. Ask to join, and trade with your neighbours there.', { name });
    }
    const distance = kmText(km);
    return more > 0
        ? tn(more, '{name} is {distance} km away, and {n} more nearby. Ask to join, and trade with your neighbours there.', '{name} is {distance} km away, and {n} more nearby. Ask to join, and trade with your neighbours there.', { name, distance })
        : t('{name} is {distance} km away. Ask to join, and trade with your neighbours there.', { name, distance });
}

/**
 * The global node's way out (G5, design §3.1, §3.2, §3.5): communities near you, place watches, and the landing card.
 *
 *   GET    /api/global/communities?lat&lng&q=&limit&offset   public. The mirrored directory (services/directory-mirror.ts):
 *          nearest first from a point, else by name; `q` searches names. → { communities, total, limit, offset, fetchedAt }
 *   GET    /api/global/home?lat&lng                           public, better signed. Everything the "Find your community"
 *          card needs in one request (session-cost-baselines). → { point, communities, communityCount, nearbyPosts,
 *          watches, knock, directoryFetchedAt }
 *   GET    /api/global/watches                                a member's own watches. → { watches, limit }
 *   POST   /api/global/watches  { lat, lng, radiusKm? }       set one (the 0.1° cell; the same cell again: its radius;
 *                                                            radiusKm left out or null: the default)
 *   DELETE /api/global/watches/:id                            remove one's own
 *
 * Every route is 404 `feature_off` unless the profile switch `directoryMirror` is on (the global profile's default),
 * before any handler runs (routes/profile-feature-gate.ts): nothing here exists on a local community.
 *
 * The watch routes act for the signer (`ctx.state.actor`) and nobody else: no route takes a member's key from the
 * body, and the signature middleware's spoof check refuses a body key that names anyone but the signer. The two reads
 * are on the public list (https-server.ts): a guest deciding whether to join can see what is near, and a signed read
 * adds the caller's own watches to the card.
 */
import crypto from 'node:crypto';
import Router from '@koa/router';
import { getPosts, isNodeMember } from '../state-engine.js';
import { parsePoint, type Point } from './distance-query.js';
import { isPoint, readMemberArea } from '../engine/member-area.js';
import { listCommunities, listedCommunityCount, readMirrorStatus } from '../engine/directory-cache.js';
import {
    listPlaceWatches, setPlaceWatch, removePlaceWatch, PlaceWatchLimitError, PLACE_WATCH_LIMIT, PLACE_WATCH_RADIUS_KM,
} from '../engine/place-watches.js';
import type { RouteDeps } from './types.js';

const MAX_QUERY_CHARS = 80;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_OFFSET = 100_000;
/** The landing card's list: the few nearest. */
const HOME_COMMUNITIES = 3;
/** "Posts near you" on the card: within this far of the point, counted up to NEARBY_POSTS_CAP (then "99+"). */
const NEARBY_POSTS_RADIUS_KM = 50;
const NEARBY_POSTS_CAP = 99;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function whole(query: Record<string, unknown>, name: string, fallback: number, min: number, max: number): Parsed<number> {
    const raw = query[name];
    if (raw === undefined) return { ok: true, value: fallback };
    if (typeof raw !== 'string' || !/^\d{1,7}$/.test(raw)) return { ok: false, error: `${name} must be a whole number from ${min} to ${max}.` };
    const n = Number(raw);
    if (n < min || n > max) return { ok: false, error: `${name} must be a whole number from ${min} to ${max}.` };
    return { ok: true, value: n };
}

function nameQuery(query: Record<string, unknown>): Parsed<string | null> {
    const raw = query.q;
    if (raw === undefined) return { ok: true, value: null };
    if (typeof raw !== 'string') return { ok: false, error: 'q is given more than once.' };
    const q = raw.trim();
    if (Array.from(q).length > MAX_QUERY_CHARS) return { ok: false, error: `q must be at most ${MAX_QUERY_CHARS} characters.` };
    return { ok: true, value: q || null };
}

function badRequest(ctx: any, error: string): void {
    ctx.status = 400;
    ctx.body = { error };
}

/** The signer, when they are a member who may keep watches here; otherwise the refusal is written and null returned. */
function watcher(ctx: any): string | null {
    const actor = ctx.state.actor as string | undefined;
    if (!actor) {
        // With read auth on, the middleware refuses an unsigned list first; kept so the handler never relies on it.
        ctx.status = 401;
        ctx.body = { error: 'A signed request is required' };
        return null;
    }
    if (!isNodeMember(actor)) {
        ctx.status = 403;
        ctx.body = { error: 'Only a member of this community can watch a place here' };
        return null;
    }
    return actor;
}

/**
 * The caller's open knock on a local community, for the card (design §3.1). G6 builds the knock, and by its design the
 * knock lives on the LOCAL node the app writes to directly (§3.3: "global: nothing"), so until G6 decides this node
 * records one, there is nothing here to report and the card reads the knock's status from the local node itself.
 */
function openKnockFor(_actor: string | undefined): null {
    return null;
}

export function createGlobalDirectoryRoutes(_deps: RouteDeps): Router {
    const router = new Router();

    router.get('/api/global/communities', async (ctx) => {
        const point = parsePoint(ctx.query);
        if (!point.ok) return badRequest(ctx, point.error);
        const q = nameQuery(ctx.query);
        if (!q.ok) return badRequest(ctx, q.error);
        const limit = whole(ctx.query, 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT);
        if (!limit.ok) return badRequest(ctx, limit.error);
        const offset = whole(ctx.query, 'offset', 0, 0, MAX_OFFSET);
        if (!offset.ok) return badRequest(ctx, offset.error);

        // Only the mirror writes the cache, and every run that writes it moves fetchedAt (which the answer carries), so
        // the answer is fixed by the query and fetchedAt: the ETag is made of those two, and a repeat read is a 304
        // before anything is read.
        const status = readMirrorStatus();
        const tag = crypto.createHash('sha256').update(`${status.fetchedAt ?? 'never'}|${ctx.querystring}`).digest('hex').slice(0, 16);
        const etag = `W/"communities-${tag}"`;
        ctx.set('ETag', etag);
        // Public and the same for every reader, but short-lived: the cache changes hourly.
        ctx.set('Cache-Control', 'public, max-age=0, must-revalidate');
        const inm = ctx.get('If-None-Match');
        if (inm && inm.split(',').some(t => t.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''))) {
            ctx.status = 304;
            return;
        }
        const { communities, total } = listCommunities({ point: point.value, q: q.value, limit: limit.value, offset: offset.value });
        ctx.body = { communities, total, limit: limit.value, offset: offset.value, fetchedAt: status.fetchedAt };
    });

    router.get('/api/global/home', async (ctx) => {
        const asked = parsePoint(ctx.query);
        if (!asked.ok) return badRequest(ctx, asked.error);
        const actor = ctx.state.actor as string | undefined;
        const member = !!actor && isNodeMember(actor);
        // The point the phone sent, else the member's own coarse area (G4), which only they can read back anyway.
        let point: Point | null = asked.value;
        let from: 'request' | 'area' | null = point ? 'request' : null;
        if (!point && member) {
            const area = readMemberArea(actor!);
            if (area) {
                point = { lat: area.lat, lng: area.lng };
                from = 'area';
            }
        }
        const status = readMirrorStatus();
        let nearbyPosts: { radiusKm: number; count: number; more: boolean } | null = null;
        if (point) {
            // The listing's own read, with the reader's own visibility (hidden, group and paused posts as the Market
            // shows them), cut at one past the cap: a count, never a second copy of the listing's rules.
            const posts = getPosts({
                types: ['offer', 'need', 'poll', 'event'], viewerPubkey: actor, limit: NEARBY_POSTS_CAP + 1,
                near: { ...point, radiusKm: NEARBY_POSTS_RADIUS_KM },
            });
            nearbyPosts = { radiusKm: NEARBY_POSTS_RADIUS_KM, count: Math.min(posts.length, NEARBY_POSTS_CAP), more: posts.length > NEARBY_POSTS_CAP };
        }
        ctx.set('Cache-Control', 'private, no-store');
        ctx.body = {
            point: from,
            // Nearest first puts the communities with a place first: none with no distance is "near you".
            communities: point ? listCommunities({ point, limit: HOME_COMMUNITIES, offset: 0 }).communities.filter(c => c.distanceKm !== null) : [],
            communityCount: listedCommunityCount(),
            nearbyPosts,
            // null: not a member's read, so no watches to show; [] a member with none.
            watches: member ? listPlaceWatches(actor!) : null,
            knock: openKnockFor(actor),
            directoryFetchedAt: status.fetchedAt,
        };
    });

    router.get('/api/global/watches', async (ctx) => {
        const actor = watcher(ctx);
        if (!actor) return;
        ctx.set('Cache-Control', 'private, no-store');
        ctx.body = { watches: listPlaceWatches(actor), limit: PLACE_WATCH_LIMIT };
    });

    router.post('/api/global/watches', async (ctx) => {
        const actor = watcher(ctx);
        if (!actor) return;
        const { lat, lng, radiusKm } = (ctx as any).requestBody || {};
        if (!isPoint(lat, lng)) {
            return badRequest(ctx, 'Send lat (-90 to 90) and lng (-180 to 180) as numbers: the place to watch.');
        }
        const { min, max } = PLACE_WATCH_RADIUS_KM;
        // Left out or null: the default.
        const radius = radiusKm ?? PLACE_WATCH_RADIUS_KM.default;
        if (typeof radius !== 'number' || !Number.isFinite(radius) || radius < min || radius > max) {
            return badRequest(ctx, `radiusKm must be a number from ${min} to ${max}, or left out for ${PLACE_WATCH_RADIUS_KM.default}.`);
        }
        try {
            const r = setPlaceWatch(actor, { lat, lng }, Math.round(radius));
            ctx.set('Cache-Control', 'private, no-store');
            ctx.body = { success: true, watch: r.watch, created: r.created };
        } catch (e) {
            if (e instanceof PlaceWatchLimitError) {
                ctx.status = e.status;
                ctx.body = { error: e.message, code: e.code, limit: PLACE_WATCH_LIMIT };
                return;
            }
            throw e;
        }
    });

    router.delete('/api/global/watches/:id', async (ctx) => {
        const actor = watcher(ctx);
        if (!actor) return;
        if (!removePlaceWatch(actor, String(ctx.params.id))) {
            ctx.status = 404;
            ctx.body = { error: 'You have no watch with that id.' };
            return;
        }
        ctx.body = { success: true };
    });

    return router;
}

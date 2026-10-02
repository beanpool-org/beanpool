/**
 * Home in one request (scratch/global-node/DESIGN-home-dashboard-fable.md §5, slices H0 and H0b).
 *
 *   GET /api/home?cards=needs,steps,…&lat=&lng=   → { generatedAt, profile, features, welcome?, me, layout, cards }
 *
 * The whole Home screen from one signed read, assembled in-process (routes/home-answer.ts buildHome), never by fanning out
 * over HTTP. `cards` limits the work to the cards asked for (absent: every card but the ones the member's own layout
 * hides); unknown ids are dropped, never refused. `lat`/`lng` is the point "near you" is measured from; without one, a
 * member's own coarse area.
 *
 * ## Who is answered
 *
 * Signed, on every node: the verified signer's own Home (ctx.state.actor, never a key from the query). On a node that
 * shows visitors the listings and not the people (`guestListingsOnly`, the global profile) it is also a public read
 * (https-server.ts HOME_READ_EXACT): an unsigned reader, or a key that is no member here, gets the visitors' subset (§5.3).
 * Elsewhere, a local community, it is a member's read only: the read gate answers an unsigned call 401 and a signed
 * non-member 403 with the members-only words, and this route answers the same where the gate lets a request through (a
 * node with ENFORCE_READ_AUTH=false), as GET /api/community/me does.
 *
 * ## The ETag
 *
 * `W/"home-<hash>"`, a hash of the reader and of the answer itself (without `generatedAt`), `Cache-Control: private,
 * max-age=0, must-revalidate`, and a 304 when the app's copy is still the answer (as routes/activity.ts answers). Not a
 * tag made of the version counters alone, as the design first proposed (§5.2): most of what Home shows has no counter to
 * bump (a message read or unread, a kept notice, a vote cast, a mute, a probation limit coming back, the layout and
 * interests, a Pulse item, the time words of a vote closing), and a tag that misses a change pins the app to the old
 * answer until something else moves (engine/versions.ts). So the answer is assembled on every request (its reads are
 * small and each has a limit) and the tag can never confirm a copy that is no longer true. What a 304 saves is what Home
 * costs a phone, the bytes on the wire; the round trip is the request the app makes anyway (session-cost-baselines).
 */
import crypto from 'node:crypto';
import Router from '@koa/router';
import { parsePoint } from './distance-query.js';
import { buildHome, homeReaderStanding, parseAskedCards } from './home-answer.js';
import type { RouteDeps } from './types.js';

/** The answer's tag: the reader and the answer, never the moment it was made. */
export function homeEtag(actor: string | undefined, body: { generatedAt: string }): string {
    const { generatedAt: _at, ...rest } = body;
    const hash = crypto.createHash('sha256').update(`${actor ?? ''}\n${JSON.stringify(rest)}`).digest('hex').slice(0, 24);
    return `W/"home-${hash}"`;
}

export function createHomeRoutes(_deps: RouteDeps): Router {
    const router = new Router();

    router.get('/api/home', async (ctx) => {
        const actor = ctx.state.actor as string | undefined;
        const standing = homeReaderStanding(actor);
        if (standing === 'refused') {
            ctx.status = actor ? 403 : 401;
            ctx.body = { error: actor ? 'Read access requires a member identity' : 'A signed request is required', code: 'members_only' };
            return;
        }
        const point = parsePoint(ctx.query);
        if (!point.ok) {
            ctx.status = 400;
            ctx.body = { error: point.error };
            return;
        }
        const asked = parseAskedCards(ctx.query.cards);
        if (asked === null) {
            ctx.status = 400;
            ctx.body = { error: 'cards is given more than once: send one comma-separated list.' };
            return;
        }

        const body = buildHome({ actor, point: point.value, asked });
        const etag = homeEtag(actor, body);
        ctx.set('ETag', etag);
        // `private`: the answer is the reader's own, so no shared cache (a CDN or proxy in front of the node) may store it.
        ctx.set('Cache-Control', 'private, max-age=0, must-revalidate');
        const inm = ctx.get('If-None-Match');
        if (inm && inm.split(',').some(t => t.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''))) {
            ctx.status = 304;
            return;
        }
        ctx.body = body;
    });

    return router;
}

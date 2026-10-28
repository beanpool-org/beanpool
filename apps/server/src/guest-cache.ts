/**
 * The visitors' reads a shared cache in front of the node may keep for a minute, and the rule that it keeps nothing
 * else (scratch/fable-design/DESIGN-global-lounge-fable.md §5.2 item 1, slice L0).
 *
 * On a launch day the global node's first wall is its visitors: a guest board read costs about 10 ms of the droplet's
 * one core, so it serves 35-50 a second (§1.4). Every read a visitor makes there is for nobody in particular (the
 * visitors' view, G9a: no author, no exact place), so one URL is one answer for every unsigned reader, and an edge in
 * front of the node (Cloudflare, with the operator's own cache rules) can give it for a minute: 500 visitor tabs then
 * cost the node one read a minute per URL. So those reads, and only those, say GUEST_CACHE_CONTROL:
 *   - the board and the map: GET /api/marketplace/posts in the visitors' view, not a sync or a delta, not a peer's
 *     (routes/marketplace.ts),
 *   - the visitors' Home: GET /api/home unsigned, on a node with the visitors' view (routes/home.ts),
 *   - the communities and the landing card: GET /api/global/communities, /api/global/home (routes/global-directory.ts),
 * each only when the request is anonymous ({@link isAnonymousRead}). A member's read of the same URL, a signed
 * visitor's, a cross-origin one, and every read on a local community: the reader's own header, never `public`.
 *
 * And for every /api answer, whatever the route said ({@link sharedCachesKeepOnlyAnonymousReads}): an answer to a request
 * that is not anonymous, and a refusal or a fault (400 and up), never leaves saying `public` or `s-maxage`. So a route
 * that marks itself public by mistake can never put a member's answer, or one minute's 503, in a shared cache.
 *
 * Every guest answer varies on the signature's headers and Authorization, so a cache that honours Vary (nginx, Varnish,
 * a browser) never hands the guests' copy to a signed request. Cloudflare ignores Vary but for Accept-Encoding unless
 * told otherwise; there the operator's bypass rule does it (operators/server/global-limits.md).
 *
 * No CDN is needed for any of this (no-domain-lock-in). With nothing in front, nothing changes for a phone or a browser:
 * max-age=0 and must-revalidate as before, so each asks every time, and the route's ETag makes that a 304.
 */
import type Koa from 'koa';

/** A visitors' read: a shared cache may keep it 60 s; a browser or a phone asks again every time. */
export const GUEST_CACHE_CONTROL = 'public, max-age=0, s-maxage=60';
/** Anyone else's read: theirs alone, asked again every time. */
export const READER_CACHE_CONTROL = 'private, max-age=0, must-revalidate';

/**
 * The request headers that make a read someone's: the member's signature (any part of it, verified or not: an old app's
 * signature on a public read is answered as unsigned, https-server.ts requireSignature, and is still a member's read),
 * the admin's credentials, and a web origin of its own, whose answer carries that origin's CORS headers.
 */
export const CREDENTIAL_HEADERS: readonly string[] = [
    'x-public-key', 'x-signature', 'x-timestamp', 'x-nonce', 'x-signed-for', 'authorization', 'x-admin-password', 'origin',
];
/** The one cookie that names anyone to this node: an admin's session (admin-key-auth.ts ADMIN_SESSION_COOKIE). */
export const CREDENTIAL_COOKIES: readonly string[] = ['admin_session'];
/** What a guest answer varies on: the headers every signed request carries, and Authorization. */
export const GUEST_VARY: readonly string[] = ['X-Public-Key', 'X-Signature', 'Authorization'];

type ReadCtx = Pick<Koa.Context, 'method' | 'state' | 'set'> & Partial<Pick<Koa.Context, 'get' | 'vary' | 'cookies' | 'headers'>>;

function header(ctx: ReadCtx, name: string): string {
    if (typeof ctx.get === 'function') return ctx.get(name);
    const raw = ctx.headers?.[name];
    return typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join(',') : '';
}

/** A GET or HEAD carrying none of CREDENTIAL_HEADERS or CREDENTIAL_COOKIES, read by no actor. */
export function isAnonymousRead(ctx: ReadCtx): boolean {
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return false;
    if (ctx.state?.actor) return false;
    if (CREDENTIAL_HEADERS.some(name => header(ctx, name) !== '')) return false;
    const cookies = ctx.cookies && typeof ctx.cookies.get === 'function' ? ctx.cookies : null;
    if (cookies && CREDENTIAL_COOKIES.some(name => !!cookies.get(name))) return false;
    return true;
}

/**
 * A read's Cache-Control: GUEST_CACHE_CONTROL, with GUEST_VARY, when `sameForEveryGuest` (the route's own word that this
 * answer is the visitors' view, the same for every unsigned reader of this URL) and the request is anonymous; otherwise
 * `forReader`, the route's header for everyone else.
 */
export function setReadCaching(ctx: ReadCtx, sameForEveryGuest: boolean, forReader: string = READER_CACHE_CONTROL): void {
    if (sameForEveryGuest && isAnonymousRead(ctx)) {
        ctx.set('Cache-Control', GUEST_CACHE_CONTROL);
        if (typeof ctx.vary === 'function') for (const name of GUEST_VARY) ctx.vary(name);
        return;
    }
    ctx.set('Cache-Control', forReader);
}

/** A shared cache may store an answer that says this (`public`, `s-maxage`, `proxy-revalidate`). */
const SHARED_DIRECTIVE = /^(?:public|s-maxage(?:=.*)?|proxy-revalidate)$/i;

/**
 * The same Cache-Control for the reader's own cache only: `public` becomes `private`, `s-maxage` and `proxy-revalidate`
 * go, and the rest stays (`private, max-age=31536000, immutable` for a listing photo a signed request fetched). An
 * answer that said nothing a shared cache could use comes back as it was.
 */
export function privateOnly(cacheControl: string): string {
    const parts = cacheControl.split(',').map(p => p.trim()).filter(Boolean);
    if (!parts.some(p => SHARED_DIRECTIVE.test(p))) return cacheControl;
    const kept = parts.filter(p => !SHARED_DIRECTIVE.test(p) && p.toLowerCase() !== 'private');
    return ['private', ...kept].join(', ');
}

/** Is this an /api path (/api itself, or anything under it)? */
function isApiPath(path: string): boolean {
    return path === '/api' || path.startsWith('/api/');
}

/**
 * Outermost on the node's app: an /api answer a shared cache could store leaves so only for an anonymous request, and
 * never as a refusal or a fault. An answer to anyone else is made the reader's own (privateOnly); a refusal or a fault
 * that said so is `private, no-store`.
 */
export function sharedCachesKeepOnlyAnonymousReads(): Koa.Middleware {
    return async (ctx, next) => {
        await next();
        if (!isApiPath(ctx.path)) return;
        const said = ctx.response.get('Cache-Control');
        if (!said) return;
        if (ctx.status >= 400) {
            if (privateOnly(said) !== said) ctx.set('Cache-Control', 'private, no-store');
            return;
        }
        if (!isAnonymousRead(ctx)) {
            const own = privateOnly(said);
            if (own !== said) ctx.set('Cache-Control', own);
        }
    };
}

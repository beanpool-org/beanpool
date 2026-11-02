/**
 * The web app's "Also show this on the global community" (DESIGN-list-on-global-fable.md §11 slice G3). The web app runs at the
 * member's own community, so every call it makes to the global community is cross-origin, and a browser preflights each. What
 * the phone sends here it can now send, and nothing more:
 *
 * - **Only a node that keeps copies** (`directoryMirror`, engine/event-copy.ts). A local community's CORS is as it was.
 * - **Only what the tick calls**: the copy's create, edit and remove, a read by id, a cancelled date, and the signer's own
 *   "am I a member here?", which the tick asks at the tap. Each for its own methods. A photo needs nothing of its own: it
 *   travels inside the create and the edit, as the phone's does.
 * - **Only a signed request**: the answer is readable for a call that carries the signature's headers, and a preflight is
 *   allowed only for one that says it will. The signature is checked as any other, after this: the limits a phone's calls
 *   count against are the signer's, whichever door they came by. No cookie and no credential is ever allowed.
 * - **Only a copy**: from another site, a request that reaches a post that isn't a copy is refused
 *   ({@link copyOnlyFromOtherSites}). A preflight can't see a body, so this is what holds that line.
 *
 * **The Origin says where the member's browser is, so it is used for nothing.** The answer is `*`, the same for every origin,
 * with no `Vary` to key on it, and it is read here for nothing and written nowhere: a copy from a community that isn't listed
 * keeps nothing of where it came from (engine/event-copy.ts), and a log line of this header would undo that. `shownFrom`
 * stays the one way a host reaches this node, and only what the directory shows of it is kept.
 *
 * An operator's listed origins and the wildcard keep their own rule (https-server.ts), and the signed knock its own.
 */
import type Koa from 'koa';
import { word } from '@beanpool/core';
import { getProfileSwitches } from './config/node-profile.js';
import { db } from './db/db.js';

/** The signature's headers and a JSON body: what the phone sends. No language, no cookie, no admin header. */
export const SIGNED_COPY_HEADERS = 'Content-Type, x-signature, x-public-key, x-timestamp, x-nonce, x-signed-for';

export const COPY_ONLY_CODE = 'copy_only';
const COPY_ONLY = word('Only a copy of your own post can be changed from another community.');

const POSTS = '/api/marketplace/posts';
const SKIP = /^\/api\/events\/([^/]+)\/skip$/;
const MEMBERSHIP = /^\/api\/community\/membership\/[^/]+$/;

function methodsAt(path: string): readonly string[] | null {
    if (path === POSTS) return ['GET', 'POST'];
    if (path === `${POSTS}/update` || path === `${POSTS}/remove`) return ['POST'];
    if (SKIP.test(path)) return ['POST', 'DELETE'];
    return MEMBERSHIP.test(path) ? ['GET'] : null;
}

/** The listings' read is open by id alone: nothing that searches, lists a member or reaches a place. */
function readsById(query: Record<string, unknown>): boolean {
    const asked = Object.keys(query);
    // One value: a repeated `id` is an array, which the guard below couldn't look up.
    return asked.length === 1 && (asked[0] === 'id' || asked[0] === 'ids') && typeof query[asked[0]] === 'string';
}

function saysItIsSigned(ctx: Koa.Context): boolean {
    const asked = ctx.get('Access-Control-Request-Headers').toLowerCase().split(',').map((h) => h.trim());
    return asked.includes('x-signature') && asked.includes('x-public-key');
}

/** What this request may do from another origin, as `Access-Control-Allow-Methods`, or null for nothing. */
export function copyCorsMethods(ctx: Koa.Context): string | null {
    if (!getProfileSwitches().directoryMirror) return null;
    const preflight = ctx.method === 'OPTIONS';
    const method = preflight ? ctx.get('Access-Control-Request-Method').toUpperCase() : ctx.method;
    const methods = methodsAt(ctx.path);
    if (!methods?.includes(method)) return null;
    if (ctx.path === POSTS && method === 'GET' && !readsById(ctx.query)) return null;
    const signed = preflight ? saysItIsSigned(ctx) : !!ctx.get('x-signature') && !!ctx.get('x-public-key');
    return signed ? `${methods.join(', ')}, OPTIONS` : null;
}

/** The browser's own word that this call came from another site: a page can't write this header, and a same-origin call says so. */
function fromAnotherSite(ctx: Koa.Context): boolean {
    const site = ctx.get('Sec-Fetch-Site').toLowerCase();
    return site === 'cross-site' || site === 'same-site';
}

/** The posts this request names. A body or a query the routes will refuse names none, and they refuse it. */
function postsNamed(ctx: Koa.Context): string[] {
    const body = (ctx as any).requestBody as { id?: unknown } | undefined;
    const fromQuery = typeof ctx.query.ids === 'string' ? ctx.query.ids.split(',').map((id) => id.trim()).filter(Boolean)
        : typeof ctx.query.id === 'string' ? [ctx.query.id] : [];
    if (ctx.path === POSTS) return ctx.method === 'GET' ? fromQuery : [];
    const skip = SKIP.exec(ctx.path);
    if (skip) return [decodeURIComponent(skip[1])];
    return typeof body?.id === 'string' ? [body.id] : [];
}

function namesAnotherPost(ids: string[]): boolean {
    if (ids.length === 0) return false;
    const someOther = db.prepare(`SELECT 1 FROM posts WHERE id IN (${ids.map(() => '?').join(', ')}) AND shown_from_host IS NULL LIMIT 1`);
    return someOther.get(...ids) !== undefined;
}

/**
 * Behind the signature check. From another site, by the opening above, only a copy goes through: a create that says it is one,
 * and an edit, a remove, a date or a read of posts that are. A post from global's own web app, an operator's listed site, or
 * anything else that isn't a browser on another site's page never has `copyCors` set with such a header, and is as it was.
 */
export async function copyOnlyFromOtherSites(ctx: Koa.Context, next: Koa.Next): Promise<void> {
    if (ctx.state.copyCors && fromAnotherSite(ctx) && !MEMBERSHIP.test(ctx.path)) {
        let refused = false;
        try {
            const creates = ctx.path === POSTS && ctx.method === 'POST';
            refused = creates ? !(ctx as any).requestBody?.shownFrom : namesAnotherPost(postsNamed(ctx));
        } catch {
            refused = true;
        }
        if (refused) {
            ctx.status = 403;
            ctx.body = { error: COPY_ONLY, code: COPY_ONLY_CODE };
            return;
        }
    }
    await next();
}

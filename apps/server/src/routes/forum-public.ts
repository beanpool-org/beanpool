/**
 * The worldwide community's forum for anyone on the web (slice F7; scratch/fable-design/DESIGN-forums-fable.md §7, §15).
 * engine/forum-public.ts says what is public; forum-public-pages.ts draws the pages. Only where the forum is on and public
 * (`forum` and `forumPublic`: the global community), and not in a private preview (engine/forum-public.ts forumPublicOn);
 * anywhere else every route here answers 404 (the /api ones `feature_off`, routes/profile-feature-gate.ts; a visitor in a
 * preview meets its 403 `private_preview` first), never cacheable, and robots.txt is left as it was (no sitemap line).
 *
 * JSON, unsigned or signed, the same body for everyone (exactly @beanpool/core FORUM_PUBLIC_FIELDS for each section, topic,
 * post and writer):
 *   GET /api/forum/public?offset=<n>                 → { sections: [section], topics: [topic], next }   newest activity first,
 *                                                       pinned first, 30 a page, every section but a group's or an archived one
 *   GET /api/forum/public/sections/:id?offset=<n>    → { section, topics: [topic], next }   | 404 `not_found`
 *   GET /api/forum/public/topics/:id?after=<n>       → { section, topic, posts: [post], next }   30 public posts after number n,
 *                                                       `next` the number to ask after | 404 `not_found`
 *   GET /api/forum/photos/:postId/:n                 → a public post's photo n (0, 1, 2) | 404
 * A section: { id, starter, name, about, position, topicCount }. A topic: { id, sectionId, title, writer, createdAt,
 * lastActivityAt, replyCount, pinned, closed, place, lang, indexable }. A post: { id, topicId, number, writer, words, quotes,
 * createdAt, edited, photos, lang }. A writer: { name, community: { kind: 'community', community } | { kind: 'waiting' } | null }.
 *
 * Pages, plain HTML, no script: GET /forum, /forum/s/:id, /forum/t/:id (`?offset`, `?after`, `?hl=<language>`),
 * /forum/sitemap.xml, /robots.txt.
 *
 * Caching (guest-cache.ts): an unsigned read says `public, max-age=0, s-maxage=60`, so an edge keeps one copy a minute per
 * address; a signed one (or a browser with an admin's session, or another website's Origin) `private, max-age=0,
 * must-revalidate`. A photo: a year in the browser, an hour at the edge (`s-maxage=3600`), private when signed. A refusal is
 * never kept by a shared cache.
 */
import Router from '@koa/router';
import type Koa from 'koa';
import { FORUM_LIMITS, word } from '@beanpool/core';
import {
    forumPublicOn, publicForumFront, publicForumPhoto, publicForumSection, publicForumSitemap, publicForumTopic,
} from '../engine/forum-public.js';
import {
    forumPageLang, renderForumFront, renderForumGone, renderForumRobots, renderForumSection, renderForumSitemap, renderForumTopic,
    type ForumPageContext,
} from '../forum-public-pages.js';
import { setReadCaching, READER_CACHE_CONTROL, PHOTO_EDGE_MAX_S } from '../guest-cache.js';
import { useAppDocumentPolicy } from '../app-document-csp.js';
import { parseDataUrl } from '../storage/image-columns.js';
import { resolvePublicNodeUrl, PUBLIC_URL_RULES } from '../state-engine.js';
import type { RouteDeps } from './types.js';

const NOT_FOUND = word('This isn’t in the forum any more.');

/** A whole number from a query value, between 0 and `max`; anything else 0. */
function count(raw: unknown, max = Number.MAX_SAFE_INTEGER): number {
    const n = typeof raw === 'string' && /^\d{1,15}$/.test(raw) ? Number(raw) : 0;
    return Math.min(n, max);
}

/** This community's public address (`https://<host>`), or null when the server knows none (web-app-robots.ts's rule). */
function publicOrigin(): string | null {
    const url = resolvePublicNodeUrl(PUBLIC_URL_RULES.community);
    if (!url) return null;
    try {
        const origin = new URL(url).origin;
        return origin && origin !== 'null' ? origin : null;
    } catch {
        return null;
    }
}

function json(ctx: Koa.Context, body: unknown): void {
    setReadCaching(ctx, true);
    ctx.body = body;
}

function notFound(ctx: Koa.Context): void {
    ctx.set('Cache-Control', READER_CACHE_CONTROL);
    ctx.status = 404;
    ctx.body = { error: NOT_FOUND, code: 'not_found' };
}

function pageContext(ctx: Koa.Context): ForumPageContext {
    const origin = publicOrigin();
    return { lang: forumPageLang(ctx.query.hl), publicOrigin: origin, appOrigin: origin ?? ctx.origin };
}

/** A page: the visitors' cache header for an unsigned read, `noindex` by header too where the page says so. */
function html(ctx: Koa.Context, status: number, body: string, indexable: boolean): void {
    useAppDocumentPolicy(ctx);
    if (status === 200) setReadCaching(ctx, true);
    else ctx.set('Cache-Control', READER_CACHE_CONTROL);
    if (!indexable) ctx.set('X-Robots-Tag', 'noindex');
    ctx.status = status;
    ctx.type = 'html';
    ctx.body = body;
}

/** Off: the forum is not public here. A local community's forum is for its members; nothing at these addresses. */
function off(ctx: Koa.Context): void {
    ctx.set('Cache-Control', READER_CACHE_CONTROL);
    ctx.set('X-Robots-Tag', 'noindex');
    ctx.status = 404;
    ctx.type = 'text';
    ctx.body = 'Not Found';
}

export function createForumPublicRoutes(_deps: RouteDeps): Router {
    const router = new Router();

    router.get('/api/forum/public', (ctx) => {
        if (!forumPublicOn()) return notFound(ctx);
        json(ctx, publicForumFront(count(ctx.query.offset)));
    });

    router.get('/api/forum/public/sections/:id', (ctx) => {
        const found = forumPublicOn() ? publicForumSection(ctx.params.id, count(ctx.query.offset)) : null;
        if (!found) return notFound(ctx);
        const { section, topics, next } = found;
        json(ctx, { section, topics, next });
    });

    router.get('/api/forum/public/topics/:id', (ctx) => {
        const found = forumPublicOn() ? publicForumTopic(ctx.params.id, count(ctx.query.after)) : null;
        if (!found) return notFound(ctx);
        json(ctx, found);
    });

    router.get('/api/forum/photos/:postId/:n', (ctx) => {
        const n = /^\d$/.test(ctx.params.n) ? Number(ctx.params.n) : -1;
        const data = forumPublicOn() && n >= 0 && n < FORUM_LIMITS.photos ? publicForumPhoto(ctx.params.postId, n) : null;
        const parsed = data ? parseDataUrl(data) : null;
        if (!parsed) return notFound(ctx);
        // A photo's address never names other bytes (a post's photos are never replaced, only deleted with it), so the browser
        // keeps it a year; an edge an hour at most, so a removal or a hide reaches it within the hour (as listing photos).
        // A signed read's copy is made the reader's own (guest-cache.ts sharedCachesKeepOnlyAnonymousReads).
        ctx.set('Cache-Control', `public, max-age=31536000, s-maxage=${PHOTO_EDGE_MAX_S}, immutable`);
        ctx.type = parsed.mime;
        ctx.body = Buffer.from(parsed.base64, 'base64');
    });

    router.get('/forum', (ctx) => {
        if (!forumPublicOn()) return off(ctx);
        const offset = count(ctx.query.offset);
        html(ctx, 200, renderForumFront(publicForumFront(offset), offset, pageContext(ctx)), true);
    });

    router.get('/forum/s/:id', (ctx) => {
        if (!forumPublicOn()) return off(ctx);
        const offset = count(ctx.query.offset);
        const found = publicForumSection(ctx.params.id, offset);
        if (!found) return html(ctx, 404, renderForumGone('section', pageContext(ctx)), false);
        html(ctx, 200, renderForumSection(found, offset, pageContext(ctx)), found.listed);
    });

    router.get('/forum/t/:id', (ctx) => {
        if (!forumPublicOn()) return off(ctx);
        const after = count(ctx.query.after);
        const found = publicForumTopic(ctx.params.id, after);
        if (!found) return html(ctx, 404, renderForumGone('topic', pageContext(ctx)), false);
        html(ctx, 200, renderForumTopic(found, after, pageContext(ctx)), found.topic.indexable);
    });

    router.get('/forum/sitemap.xml', (ctx) => {
        const origin = publicOrigin();
        // A sitemap names full addresses: with none known there is nothing to list.
        if (!forumPublicOn() || !origin) return off(ctx);
        setReadCaching(ctx, true);
        ctx.type = 'application/xml';
        ctx.body = renderForumSitemap(origin, publicForumSitemap());
    });

    router.get('/robots.txt', async (ctx, next) => {
        // Not public here (or not now: a private preview): left as it was, but never kept by a shared cache, so the forum's
        // lines are there at once when it is public again (`.txt` is an address Cloudflare caches by default).
        if (!forumPublicOn()) {
            ctx.set('Cache-Control', READER_CACHE_CONTROL);
            return next();
        }
        setReadCaching(ctx, true);
        ctx.type = 'text/plain';
        ctx.body = renderForumRobots(publicOrigin());
    });

    return router;
}

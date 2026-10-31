/**
 * POST /mcp/photos (slice S4, design §2.4; Marty chose uploads too, 31 Oct): one photo for an owner's assistant's posts, sent
 * as the request's whole body by a program (Claude Code, a script with curl), for `photo_ids` on the create tools
 * (agent/owner-posts.ts). The design had set a second door aside, so this one is kept narrow. Beside it, /mcp/photos/u/<token>
 * (the director, 31 Oct, for seeding): the same upload for an assistant that runs commands but never sees its bearer, through a
 * link photo_upload_link made (agent/owner-photos.ts). The doors differ in steps 1 to 3 and share the rest, one function
 * (takePhoto). In order, every request:
 *
 *   1. the owners' switch (off: 404), the Origin rule (another site's page: 403) and POST only, or on a link POST or PUT (405),
 *      as /mcp;
 *   2. /mcp/photos: the bearer /mcp takes and nothing else: an agent token or an OAuth access token, its member an owner or admin
 *      now (agent/mcp-route.ts agentGrantFrom), else 401 (403 for another scope). A link: a live token whose grant may still post
 *      (owner-posts.ts grantMayStillPost), read now; anything else is one answer, 401 in the same words (no oracle), and a link
 *      found with a grant that may not post is dropped for good;
 *   3. /mcp/photos: only a grant that posts: an owner's, ticked "May post for me" (tools.ts grantPosts), else 403 in words;
 *   4. the door's own 60 a minute and 2,000 a day for the grant (limits.ts admitAgentCall): an upload is one of its calls, until
 *      step 6 counts it as a photo: then its day is the photos' own (returnAgentDayCall);
 *   5. a server another took over takes nothing (503), as the posting tools;
 *   6. a Content-Type of image/jpeg, image/png or image/webp (415), and a Content-Length over 5 MB refused before a byte is
 *      read (413); at most PHOTO_UPLOADS_AT_ONCE bodies read at once on this server (503, Retry-After); then the grant's
 *      photos for the day, shared by both doors and photo_urls (limits.ts agentPhotosPerDay: 429);
 *   7. the body read with a hard limit (413 the moment it passes 5 MB, nothing kept) and a deadline (408);
 *   8. the photo made what the apps send (owner-posts.ts storableImage: sniffed whatever the Content-Type said, at most
 *      2,048 px a side, at least 200 px on its shorter side, made 800 px with no metadata, a PNG as a JPEG; else 400 in words);
 *   9. kept for 24 hours only while the grant may still post (401 and nothing kept once revoked, unticked or switched off; agent/
 *      owner-photos.ts), answered 201 with `{ photoId, expiresAt, photosToday, photosPerDay }` and nothing else.
 *
 * Nothing more is here: no list of uploads, no reading a photo back, no delete (an unused one goes after 24 hours, or with
 * its grant). A link answers no-referrer and no-store whatever it answers (https-server.ts, for every method and every refusal
 * in front of this route), and adds no CORS. A refusal before the grant is known writes the door's "Assistant refused" line
 * (mcp-route.ts logRefusal); after it, an AGENT line with the grant. An upload kept writes an AGENT line with the grant and the
 * photo's id. Nothing here writes a link's token: a line names its route PHOTO_LINK_LOG_PATH.
 */
import Router from '@koa/router';
import type { IncomingMessage } from 'node:http';
import { noteAutomationTokenUse } from '../automation-tokens.js';
import { clientLimiterKey } from '../client-ip.js';
import { logAddressTag } from '../log-address.js';
import { logger } from '../logger.js';
import { getReplacedInfo } from '../services/identity-epoch.js';
import { admitAgentCall, admitAgentPhoto, agentPhotosPerDay, agentPhotosToday, returnAgentDayCall } from './limits.js';
import { agentGrantFrom, aiAssistantsAllowed, logRefusal, ownOrigin } from './mcp-route.js';
import { noteOAuthGrantUse } from './oauth.js';
import {
    dropPhotoLink, keepUploadedPhoto, photoDayFull, photoLinkOf, PHOTO_LINK_LOG_PATH, PHOTO_LINK_PATH, PHOTO_SOURCE_MAX_BYTES, PHOTO_SOURCE_TYPES,
    PHOTO_UPLOAD_PATH, startSweepingUploadedPhotos,
} from './owner-photos.js';
import { grantMayStillPost, noUploadWords, sourceImageWords, storableImage } from './owner-posts.js';
import { grantPosts, type AgentGrant } from './tools.js';

export { PHOTO_UPLOAD_PATH };
/** Bodies read at once on this server: each is held in memory (at most 5 MB) until it is made 800 px. */
export const PHOTO_UPLOADS_AT_ONCE = 2;
/** How long a body may take to arrive. */
export const PHOTO_UPLOAD_READ_MS = 60_000;
const MAX_WORDS = `${PHOTO_SOURCE_MAX_BYTES / (1024 * 1024)} MB`;
/** The one answer to a link that is no use: never was, replaced, past its hour, or its grant may no longer post. */
const PHOTO_LINK_DEAD = 'This upload link is no longer good: ask for a new one with photo_upload_link.';

let reading = 0;

class BodyTooBig extends Error {}
class BodyTooSlow extends Error {}

/**
 * The body, at most `max` bytes, within `ms`: refused the moment it passes `max` (what came is dropped, and the rest never
 * read: the answer closes the connection), or when it is not all there in time.
 */
function readImageBody(req: IncomingMessage, max: number, ms: number): Promise<Buffer> {
    // A request that closed before its body is asked for (its client went while the JSON reader in front of every route had
    // it, https-server.ts) emits nothing more, not even 'close': refused now, or it would hold its place until the deadline.
    if (req.destroyed) return Promise.reject(new Error('closed'));
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let done = false;
        const finish = (err: Error | null): void => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (err) {
                chunks.length = 0;
                req.pause();
                reject(err);
            } else {
                resolve(Buffer.concat(chunks));
            }
        };
        const timer = setTimeout(() => finish(new BodyTooSlow()), ms);
        timer.unref?.();
        req.on('data', (chunk: Buffer) => {
            if (done) return;
            total += chunk.length;
            if (total > max) {
                finish(new BodyTooBig());
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => finish(null));
        req.on('error', (e) => finish(e));
        // A client gone before its body ended frees its place at once, not at the deadline ('close' after 'end' does nothing).
        req.on('aborted', () => finish(new Error('aborted')));
        req.on('close', () => finish(new Error('closed')));
    });
}

/** An answer in words. A refusal that leaves a body unread closes the connection, so the rest of it is never read. */
function say(ctx: any, status: number, error: string, opts: { close?: boolean; retryAfter?: number } = {}): void {
    ctx.status = status;
    ctx.set('Cache-Control', 'no-store');
    if (opts.retryAfter) ctx.set('Retry-After', String(opts.retryAfter));
    if (opts.close) ctx.set('Connection', 'close');
    ctx.body = { error };
}

/** Step 1, both doors': the switch, the Origin rule and the method. False once the answer is set. */
function doorOpen(ctx: any, methods: readonly string[]): boolean {
    if (!aiAssistantsAllowed()) {
        ctx.status = 404;
        ctx.body = 'Not Found';
        return false;
    }
    const origin = ctx.get('origin');
    if (origin && origin !== ownOrigin()) {
        say(ctx, 403, 'This endpoint does not answer web pages from other sites', { close: true });
        return false;
    }
    if (!methods.includes(ctx.method)) {
        ctx.set('Allow', methods.join(', '));
        say(ctx, 405, 'Method not allowed: send the photo with POST', { close: true });
        return false;
    }
    return true;
}

/** Steps 4 to 9, once a door has its grant, for both doors. `route` is how a line names the door: never a link's token. */
async function takePhoto(ctx: any, grant: AgentGrant, route: string): Promise<void> {
    // 4. The door's limits.
    const admitted = admitAgentCall(grant.id);
    if (!admitted.ok) {
        logRefusal('Assistant refused: over its limit', { grant: grant.id, route }, '429');
        return say(ctx, 429, admitted.error, { close: true, retryAfter: admitted.retryAfterSeconds });
    }
    if (grant.via === 'oauth') noteOAuthGrantUse(grant.id);
    else noteAutomationTokenUse(grant.id, `${ctx.method} ${route}`);
    // 5. A server another took over.
    const replaced = getReplacedInfo();
    if (replaced) return say(ctx, 503, `${replaced.message} This server takes no new photos; use the one that took over.`, { close: true });
    // 6. One image, of a size the server takes, when there is room to read it.
    const refuse = (status: number, refused: string, error: string, opts: { close?: boolean; retryAfter?: number } = { close: true }): void => {
        logger.info('AGENT', 'Assistant photo upload refused', { grant: grant.id, refused });
        say(ctx, status, error, opts);
    };
    const type = String(ctx.get('content-type') || '').split(';')[0].trim().toLowerCase();
    // A body the JSON reader in front of every route took (https-server.ts) is not one image.
    if (!(PHOTO_SOURCE_TYPES as readonly string[]).includes(type) || typeof (ctx as any).rawBody === 'string') {
        return refuse(415, 'not an image', `Send one image as the whole body, with Content-Type ${PHOTO_SOURCE_TYPES.join(', ')}.`);
    }
    const declared = Number(ctx.get('content-length'));
    if (Number.isFinite(declared) && declared > PHOTO_SOURCE_MAX_BYTES) {
        return refuse(413, 'too big', `The photo is too big: at most ${MAX_WORDS}. Send a smaller copy.`);
    }
    if (reading >= PHOTO_UPLOADS_AT_ONCE) {
        return refuse(503, 'busy', 'This server is taking other photos now: send it again in a few seconds.', { close: true, retryAfter: 5 });
    }
    if (!admitAgentPhoto(grant.id)) return refuse(429, 'day full', photoDayFull(grant.id), { close: true, retryAfter: secondsToUtcMidnight() });
    returnAgentDayCall(grant.id);
    // 7. The body, counted in `reading` until it is made 800 px (step 8), so at most PHOTO_UPLOADS_AT_ONCE are held at once.
    reading++;
    let made: Awaited<ReturnType<typeof storableImage>>;
    let body: Buffer;
    try {
        try {
            body = await readImageBody(ctx.req, PHOTO_SOURCE_MAX_BYTES, PHOTO_UPLOAD_READ_MS);
        } catch (e) {
            if (e instanceof BodyTooBig) return refuse(413, 'too big', `The photo is too big: at most ${MAX_WORDS}. Send a smaller copy.`);
            if (e instanceof BodyTooSlow) return refuse(408, 'timed out', `The photo did not arrive within ${PHOTO_UPLOAD_READ_MS / 1000} seconds: send it again.`);
            return refuse(400, 'cut off', 'The photo was cut off: send it again.');
        }
        // 8. Made what the apps send.
        made = await storableImage(body, sourceImageWords('The upload', 'upload'));
    } finally {
        reading--;
    }
    if (!made.ok) return refuse(400, 'not an image', made.error, {});
    // 9. Kept, only while the grant may still post: disconnected, unticked or switched off during the upload keeps nothing.
    if (!grantMayStillPost(grant)) return refuse(401, 'stopped meanwhile', 'This assistant was disconnected, or may no longer post, while the photo arrived: it was not kept.');
    const kept = keepUploadedPhoto(grant.id, made.value);
    logger.info('AGENT', 'Assistant uploaded a photo', { grant: grant.id, photo: kept.photoId, bytes: body.length });
    ctx.status = 201;
    ctx.set('Cache-Control', 'no-store');
    ctx.body = { photoId: kept.photoId, expiresAt: kept.expiresAt, photosToday: agentPhotosToday(grant.id), photosPerDay: agentPhotosPerDay() };
}

export function createPhotoUploadRoutes(): Router {
    const router = new Router();
    // Uploads no call comes back for are deleted after 24 hours, also on a quiet server.
    startSweepingUploadedPhotos();

    const upload: Router.Middleware = async (ctx) => {
        // 1. As /mcp: the switch, a web page from elsewhere, POST only.
        if (!doorOpen(ctx, ['POST'])) return;
        // 2. The bearer /mcp takes.
        const check = agentGrantFrom(ctx);
        if (!check.ok) {
            if (check.status === 401) ctx.set('WWW-Authenticate', `Bearer realm="beanpool", error="invalid_token", scope="agent"`);
            const from = logAddressTag(clientLimiterKey(ctx));
            if (check.status === 401 && check.grantId) logRefusal('Assistant refused: its member is no longer an owner or admin', { grant: check.grantId, from, route: PHOTO_UPLOAD_PATH }, 'demoted');
            else logRefusal('Assistant refused a request', { status: check.status, from, route: PHOTO_UPLOAD_PATH, ...(check.grantId ? { grant: check.grantId } : {}) }, check.status === 403 ? '403' : '401');
            return say(ctx, check.status, check.error, { close: true });
        }
        const grant = check.grant;
        // 3. A grant that posts.
        if (!grantPosts(grant)) {
            logRefusal('Assistant refused: an upload from an assistant that does not post', { grant: grant.id, route: PHOTO_UPLOAD_PATH }, '403');
            return say(ctx, 403, noUploadWords(grant), { close: true });
        }
        return takePhoto(ctx, grant, PHOTO_UPLOAD_PATH);
    };

    const viaLink: Router.Middleware = async (ctx) => {
        // 1. As /mcp/photos, and a PUT too (curl -T): the token isn't looked at until here, so a GET says nothing about it.
        if (!doorOpen(ctx, ['POST', 'PUT'])) return;
        // 2. A live link whose grant may still post. One that fails is dropped, so its grant coming back doesn't revive it.
        const token = String(ctx.params.token ?? '');
        const link = photoLinkOf(token);
        if (!link || !grantMayStillPost(link.grant)) {
            dropPhotoLink(token);
            logRefusal('Assistant refused a request', {
                status: 401, from: logAddressTag(clientLimiterKey(ctx)), route: PHOTO_LINK_LOG_PATH, ...(link ? { grant: link.grant.id } : {}),
            }, '401');
            return say(ctx, 401, PHOTO_LINK_DEAD, { close: true });
        }
        return takePhoto(ctx, link.grant, PHOTO_LINK_LOG_PATH);
    };

    // POST carries the photo; GET is answered here too (404 while the switch is off, else 405), as /mcp's is. Every other
    // method is no route: the router answers it 405.
    router.post(PHOTO_UPLOAD_PATH, upload);
    router.get(PHOTO_UPLOAD_PATH, upload);
    // Upload-only: a GET reads nothing, whatever the token.
    router.post(`${PHOTO_LINK_PATH}/:token`, viaLink);
    router.put(`${PHOTO_LINK_PATH}/:token`, viaLink);
    router.get(`${PHOTO_LINK_PATH}/:token`, viaLink);
    return router;
}

/** Seconds until the next UTC day, when the grant's photos start again. */
function secondsToUtcMidnight(now = Date.now()): number {
    const d = new Date(now);
    return Math.max(1, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now) / 1000));
}

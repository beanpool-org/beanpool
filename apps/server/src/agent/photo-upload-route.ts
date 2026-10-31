/**
 * POST /mcp/photos (slice S4, design §2.4; Marty chose uploads too, 31 Oct): one photo for an owner's assistant's posts, sent
 * as the request's whole body by a program (Claude Code, a script with curl), for `photo_ids` on the create tools
 * (agent/owner-posts.ts). The design had set a second door aside, so this one is kept narrow. In order, every request:
 *
 *   1. the owners' switch (off: 404), the Origin rule (another site's page: 403) and POST only (405), as /mcp;
 *   2. the bearer /mcp takes and nothing else: an agent token or an OAuth access token, its member an owner or admin now
 *      (agent/mcp-route.ts agentGrantFrom), else 401 (403 for another scope);
 *   3. only a grant that posts: an owner's, ticked "May post for me" (tools.ts grantPosts), else 403 in words;
 *   4. the door's own 60 a minute and 2,000 a day for the grant (limits.ts admitAgentCall): an upload is one of its calls;
 *   5. a server another took over takes nothing (503), as the posting tools;
 *   6. a Content-Type of image/jpeg, image/png or image/webp (415), and a Content-Length over 5 MB refused before a byte is
 *      read (413); at most PHOTO_UPLOADS_AT_ONCE bodies read at once on this server (503, Retry-After); then the grant's
 *      photos for the day, shared with photo_urls (limits.ts AGENT_PHOTOS_PER_DAY: 429);
 *   7. the body read with a hard limit (413 the moment it passes 5 MB, nothing kept) and a deadline (408);
 *   8. the photo made what the apps send (owner-posts.ts storableImage: sniffed whatever the Content-Type said, at most
 *      2,048 px a side, made 800 px with no metadata, a PNG as a JPEG; else 400 in words) and kept for 24 hours
 *      (agent/owner-photos.ts), answered 201 with `{ photoId, expiresAt, photosToday, photosPerDay }` and nothing else.
 *
 * Nothing more is here: no list of uploads, no reading a photo back, no delete (an unused one goes after 24 hours, or with
 * its grant). A refusal before the grant is known writes the door's "Assistant refused" line (mcp-route.ts logRefusal);
 * after it, an AGENT line with the grant. An upload kept writes an AGENT line with the grant and the photo's id.
 */
import Router from '@koa/router';
import type { IncomingMessage } from 'node:http';
import { noteAutomationTokenUse } from '../automation-tokens.js';
import { clientLimiterKey } from '../client-ip.js';
import { logAddressTag } from '../log-address.js';
import { logger } from '../logger.js';
import { getReplacedInfo } from '../services/identity-epoch.js';
import { admitAgentCall, admitAgentPhoto, agentPhotosToday, AGENT_PHOTOS_PER_DAY } from './limits.js';
import { agentGrantFrom, aiAssistantsAllowed, logRefusal, ownOrigin } from './mcp-route.js';
import { noteOAuthGrantUse } from './oauth.js';
import {
    keepUploadedPhoto, photoDayFull, PHOTO_SOURCE_MAX_BYTES, PHOTO_SOURCE_TYPES, PHOTO_UPLOAD_PATH, startSweepingUploadedPhotos,
} from './owner-photos.js';
import { sourceImageWords, storableImage } from './owner-posts.js';
import { grantPosts } from './tools.js';

export { PHOTO_UPLOAD_PATH };
/** Bodies read at once on this server: each is held in memory (at most 5 MB) until it is made 800 px. */
export const PHOTO_UPLOADS_AT_ONCE = 2;
/** How long a body may take to arrive. */
export const PHOTO_UPLOAD_READ_MS = 60_000;
const MAX_WORDS = `${PHOTO_SOURCE_MAX_BYTES / (1024 * 1024)} MB`;

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

export function createPhotoUploadRoutes(): Router {
    const router = new Router();
    // Uploads no call comes back for are deleted after 24 hours, also on a quiet server.
    startSweepingUploadedPhotos();

    const upload: Router.Middleware = async (ctx) => {
        // 1. As /mcp: the switch, a web page from elsewhere, POST only.
        if (!aiAssistantsAllowed()) {
            ctx.status = 404;
            ctx.body = 'Not Found';
            return;
        }
        const origin = ctx.get('origin');
        if (origin && origin !== ownOrigin()) return say(ctx, 403, 'This endpoint does not answer web pages from other sites', { close: true });
        if (ctx.method !== 'POST') {
            ctx.set('Allow', 'POST');
            return say(ctx, 405, 'Method not allowed: send the photo with POST', { close: true });
        }
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
            return say(ctx, 403, grant.role !== 'owner'
                ? "Only an owner's assistant can upload photos: an admin's cannot post."
                : 'This assistant was connected without "May post for me", so it cannot upload photos. The owner can connect it again with that ticked.', { close: true });
        }
        // 4. The door's limits.
        const admitted = admitAgentCall(grant.id);
        if (!admitted.ok) {
            logRefusal('Assistant refused: over its limit', { grant: grant.id, route: PHOTO_UPLOAD_PATH }, '429');
            return say(ctx, 429, admitted.error, { close: true, retryAfter: admitted.retryAfterSeconds });
        }
        if (grant.via === 'oauth') noteOAuthGrantUse(grant.id);
        else noteAutomationTokenUse(grant.id, `POST ${PHOTO_UPLOAD_PATH}`);
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
        // 7. The body.
        reading++;
        let body: Buffer;
        try {
            body = await readImageBody(ctx.req, PHOTO_SOURCE_MAX_BYTES, PHOTO_UPLOAD_READ_MS);
        } catch (e) {
            if (e instanceof BodyTooBig) return refuse(413, 'too big', `The photo is too big: at most ${MAX_WORDS}. Send a smaller copy.`);
            if (e instanceof BodyTooSlow) return refuse(408, 'timed out', `The photo did not arrive within ${PHOTO_UPLOAD_READ_MS / 1000} seconds: send it again.`);
            return refuse(400, 'cut off', 'The photo was cut off: send it again.');
        } finally {
            reading--;
        }
        // 8. Made what the apps send, and kept.
        const made = await storableImage(body, sourceImageWords('The upload', 'upload'));
        if (!made.ok) return refuse(400, 'not an image', made.error, {});
        const kept = keepUploadedPhoto(grant.id, made.value);
        logger.info('AGENT', 'Assistant uploaded a photo', { grant: grant.id, photo: kept.photoId, bytes: body.length });
        ctx.status = 201;
        ctx.set('Cache-Control', 'no-store');
        ctx.body = { photoId: kept.photoId, expiresAt: kept.expiresAt, photosToday: agentPhotosToday(grant.id), photosPerDay: AGENT_PHOTOS_PER_DAY };
    };
    // POST carries the photo; GET is answered here too (404 while the switch is off, else 405), as /mcp's is. Every other
    // method is no route: the router answers it 405.
    router.post(PHOTO_UPLOAD_PATH, upload);
    router.get(PHOTO_UPLOAD_PATH, upload);
    return router;
}

/** Seconds until the next UTC day, when the grant's photos start again. */
function secondsToUtcMidnight(now = Date.now()): number {
    const d = new Date(now);
    return Math.max(1, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now) / 1000));
}

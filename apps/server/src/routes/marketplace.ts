/**
 * Marketplace Posts and Escrow Transaction routes.
 */

import Router from '@koa/router';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
    createPost, getPosts, removePost, updatePost,
    acceptPost, completePostTransaction, cancelPostTransaction,
    pausePost, resumePost, getMarketplaceTransactions,
    requestPost, approvePostRequest, rejectPostRequest, cancelPostRequest,
    getMember, getBalance, getPostsVersion,
    canOperateTreasury,
    closePoll, votePoll, rsvpEvent,
    getEventThread, postEventThreadMessage, removeEventThreadMessage,
    nodeRoleOf,
} from '../state-engine.js';
import { assertMayPost, assertMayEditPhotos } from '../engine/probation.js';
import { assertNotMuted } from '../engine/auto-moderation.js';
import { db } from '../db/db.js';
import { getImageStore } from '../storage/image-store.js';
import {
    MissingObjectError, attachmentDataOfAsync, openPhotoOf, type AttachmentRow, type PostPhotoRow,
} from '../storage/image-columns.js';
import { getPeerOrigins } from '../connector-manager.js';
import { respondSettlementAware } from '../federation-settlement.js';
import { syncPulseMarketplaceGate } from '../daily-pulse.js';
import { chatRateLimit } from '../chat-rate-limit.js';
import { createEventFromBody } from './event-post.js';
import { respondProfileRefusal } from './profile-feature-gate.js';
import type { RouteDeps } from './types.js';

export function createMarketplaceRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { clampLimit, clampOffset, enforceReadAuth: ENFORCE_READ_AUTH } = deps;

    const isTreasury = (pk: string): boolean =>
        !!(db.prepare('SELECT is_treasury FROM members WHERE public_key=?').get(pk) as any)?.is_treasury;

    /**
     * Authenticated actor authorization check.
     * The actor must come from the verified session (ctx.state.actor).
     * A body-supplied identity is accepted only when the actor is that identity,
     * or is a keeper entitled to act for it (via canOperateTreasury for enterprises).
     */
    function assertActorEntitled(ctx: any, targetPubkey: string): boolean {
        const actor = ctx.state?.actor as string | undefined;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Authentication required' };
            return false;
        }
        if (actor === targetPubkey) {
            return true;
        }
        if (isTreasury(targetPubkey) && canOperateTreasury(actor, targetPubkey)) {
            return true;
        }
        ctx.status = 403;
        ctx.body = { error: isTreasury(targetPubkey)
            ? 'You are not an authorized keeper of this enterprise'
            : 'Not authorized to act on behalf of this identity'
        };
        return false;
    }

// ===================== MARKETPLACE API (PUBLIC) =====================

router.get('/api/marketplace/posts/:id/photos/:orderNum', async (ctx) => {
    const { id, orderNum } = ctx.params;
    // THE ROW FIRST, ALWAYS (storage design §7). Existence, and therefore deletion, is decided here and
    // never by asking the store whether a file happens to be lying around: the delete paths remove the row
    // inside their transaction and the object only after it commits, so between those two moments the file
    // still exists and must not be served. Reading the row first is what makes that window safe.
    const photo = db.prepare(
        `SELECT photo_data, storage_key, sha256, bytes, mime FROM post_photos WHERE post_id = ? AND order_num = ?`
    ).get(id, Number(orderNum)) as PostPhotoRow | undefined;

    if (!photo) {
        ctx.status = 404;
        ctx.body = { error: 'Photo not found' };
        return;
    }
    // A post hidden by reports (G3) shows its photos to its author and the moderators only, and only when they sign
    // the request; to anyone else, as to an <img>, it has none. Never stored by a shared cache.
    const hidden = db.prepare('SELECT author_pubkey FROM posts WHERE id = ? AND hidden_by_reports_at IS NOT NULL').get(id) as { author_pubkey: string } | undefined;
    if (hidden) {
        const viewer = ctx.state.actor as string | undefined;
        if (!viewer || (viewer !== hidden.author_pubkey && !nodeRoleOf(viewer))) {
            ctx.status = 404;
            ctx.body = { error: 'Photo not found' };
            return;
        }
    }

    // A row that has not been evacuated yet is served from the row, exactly as it always was; an evacuated
    // one is served from the store. The two produce identical bytes and an identical content type — that is
    // the whole contract of storage/image-columns.ts, and what lets a photo be evacuated under a client's
    // immutable cache entry without invalidating it.
    //
    // From the store it is STREAMED, through the store's non-blocking read: on an S3 node the bytes come from
    // the bucket, and neither the node's event loop nor its memory is held for the whole photo on the way.
    let served: Awaited<ReturnType<typeof openPhotoOf>>;
    try {
        served = await openPhotoOf(photo, getImageStore());
    } catch (e) {
        // The read is async, so the row can have been deleted while it was in flight — and the delete paths
        // remove the object right after the row. That is a photo that no longer exists, not an outage. So is
        // one REPLACED in flight: an edit writes a new row at the same (post, order) with a new key and removes
        // the old object, so the question is whether the row still names the object this request read.
        if (e instanceof MissingObjectError) {
            const still = db.prepare(`SELECT 1 FROM post_photos WHERE post_id = ? AND order_num = ? AND storage_key = ?`)
                .get(id, Number(orderNum), photo.storage_key);
            if (!still) {
                ctx.status = 404;
                ctx.body = { error: 'Photo not found' };
                return;
            }
        }
        // The row says the bytes are in the store and they are not — a lost or unmounted images directory —
        // or the bucket did not answer. 404 would tell the member their photo never existed and tell the
        // operator nothing.
        console.error(`[Photos] ${id}/${orderNum}:`, e);
        ctx.status = 503;
        ctx.body = { error: 'This photo is temporarily unavailable' };
        return;
    }
    if (!served) {
        ctx.status = 404;
        ctx.body = { error: 'Photo not found' };
        return;
    }

    // Post photos are immutable per (id, order_num): getPosts versions the URL with the photo's
    // updated_at (?v=…), so an edited photo is served under a NEW url. That lets clients cache
    // the bytes forever — killing the cold-start re-download of every photo — with no staleness.
    ctx.set('Cache-Control', hidden ? 'private, no-store' : 'public, max-age=31536000, immutable');
    ctx.type = served.contentType;
    ctx.body = served.body;
    if (served.bytes !== null) ctx.length = served.bytes;
});

// Lazy-load an encrypted message attachment (image). Returns ciphertext only —
// the node can't read it; the recipient decrypts with the DM key + nonce.
router.get('/api/messages/:id/attachment', async (ctx) => {
    const { id } = ctx.params;
    // The row first, for the same reason as the photo route above.
    const row = db.prepare(`SELECT data, nonce, mime, storage_key FROM message_attachments WHERE message_id = ?`).get(id) as AttachmentRow | undefined;
    if (!row) {
        ctx.status = 404;
        ctx.body = { error: 'Attachment not found' };
        return;
    }
    // `data` is the same base64 ciphertext whether it came from the row or from the store, and `nonce` never
    // left the row: the recipient's decryption cannot tell the two apart, which it must not be able to.
    let data: string | null;
    try {
        // Non-blocking: on an S3 node this is a round trip to the bucket, and the event loop is not held for it.
        data = await attachmentDataOfAsync(row, getImageStore());
    } catch (e) {
        // As on the photo route: a message deleted for everyone while this read was in flight removes the row,
        // then the object — an attachment that no longer exists, not an outage. One per message, never
        // replaced, but the key is still what says the row is the one this request read.
        if (e instanceof MissingObjectError) {
            const still = db.prepare(`SELECT 1 FROM message_attachments WHERE message_id = ? AND storage_key = ?`)
                .get(id, row.storage_key);
            if (!still) {
                ctx.status = 404;
                ctx.body = { error: 'Attachment not found' };
                return;
            }
        }
        console.error(`[Attachments] ${id}:`, e);
        ctx.status = 503;
        ctx.body = { error: 'This attachment is temporarily unavailable' };
        return;
    }
    if (data === null) {
        ctx.status = 404;
        ctx.body = { error: 'Attachment not found' };
        return;
    }
    ctx.body = { data, nonce: row.nonce, mime: row.mime || 'image/jpeg' };
});

const KNOWN_POST_TYPES = ['offer', 'need', 'poll', 'event'] as const;

router.get('/api/marketplace/posts', async (ctx) => {
    const id = ctx.query.id as string | undefined;
    const type = ctx.query.type as string | undefined;
    const category = ctx.query.category as string | undefined;
    const author = ctx.query.author as string | undefined;
    const q = ctx.query.q as string | undefined;
    const limit = clampLimit(ctx.query.limit);
    const offset = clampOffset(ctx.query.offset);
    const updatedAfter = ctx.query.updatedAfter as string | undefined;
    const sync = ctx.query.sync === 'true';
    const audienceScope = ctx.query.audienceScope as string | undefined;
    const targetGroupId = ctx.query.targetGroupId as string | undefined;
    const assignedTo = ctx.query.assignedTo as string | undefined;

    // #108: beans-only browse, so nobody is ambushed by a cash requirement in paragraph three of a
    // description. Forced on for a peer node's request — cash cannot cross a boundary, so a listing
    // with a cash outlay is meaningless to a remote member. Remote browsing hits this same public
    // endpoint, so the peer origin is the only signal available.
    //
    // Origin is a HINT, not a credential, and that is the right strength here: reach is a discovery
    // filter, not an access control (docs/federation-economics.md Rule 9). Nothing is protected by
    // this — a cash listing exposes no secret, and physicality self-enforces the rest.
    const isPeerRequest = (() => {
        const origin = ctx.get('Origin');
        return !!origin && getPeerOrigins().includes(origin);
    })();
    const beansOnly = isPeerRequest || ctx.query.beansOnly === 'true';

    const viewerPubkey = ctx.state.actor as string | undefined;

    const queryPart = `${ctx.querystring || ''}:${viewerPubkey || ''}:${beansOnly}`;
    const queryHash = crypto.createHash('sha256').update(queryPart).digest('hex').slice(0, 8);
    const etag = `W/"posts-${getPostsVersion()}-${queryHash}"`;

    ctx.set('ETag', etag);
    // `private`, not `public`: this response varies by viewer — an author sees their OWN paused
    // posts and nobody else does (see getPosts below). The viewer is folded into the ETag, so a
    // shared cache that revalidates would be corrected, but a response keyed only on URL must
    // never be storable by one, because two members asking for the same URL get different bodies.
    ctx.set('Cache-Control', 'private, max-age=0, must-revalidate');

    const ifNoneMatch = typeof ctx.get === 'function' ? ctx.get('If-None-Match') : ctx.headers?.['if-none-match'];
    if (ifNoneMatch) {
        const cleanInm = ifNoneMatch.replace(/^W\//, '');
        const cleanEtag = etag.replace(/^W\//, '');
        if (cleanInm === cleanEtag || ifNoneMatch.includes(cleanEtag)) {
            ctx.status = 304;
            return;
        }
    }

    // Events are OPT-IN on this route (docs/events-on-the-map.md §2.6). Every app already in the store pulls
    // the whole feed with no type filter and renders anything that is not a poll as an offer, so it must never
    // receive an event: a client that knows events says `types=offer,need,poll,event` or `type=event`. A by-id
    // fetch is not guarded — only a screen that knows events can hold an event's id.
    // The list is intersected with the known post types before it reaches SQL: each entry is a bound
    // variable, so an unchecked list of tens of thousands would exceed SQLite's limit and 500 the route.
    const types = typeof ctx.query.types === 'string'
        ? KNOWN_POST_TYPES.filter(t => (ctx.query.types as string).split(',').some(q => q.trim() === t))
        : undefined;
    if (types && types.length === 0) {
        // Only unknown types asked for: nothing matches. An empty list must not fall through to "no filter".
        ctx.status = 200;
        ctx.type = 'application/json';
        ctx.body = '[]';
        return;
    }
    const wantsEvents = type === 'event' || !!types?.includes('event');
    const excludeEvents = !id && !wantsEvents;

    // viewerPubkey (the signed requester) lets an author see their OWN paused posts; others don't. A post hidden by
    // reports (G3) reaches its author, and the moderators (includeHidden), and nobody else.
    const includeHidden = !!viewerPubkey && !!nodeRoleOf(viewerPubkey);
    const posts = getPosts({ id, type, types, excludeEvents, category, query: q, limit, offset, updatedAfter, authorPubkey: author, viewerPubkey, sync, beansOnly, audienceScope, targetGroupId, assignedTo, includeHidden });
    const bodyStr = JSON.stringify(posts);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = bodyStr;
});

router.post('/api/marketplace/posts', async (ctx) => {
    // The event fields are not read here: an event is built by `createEventFromBody` from the whole body.
    const { id, type, category, title, description, credits, priceType, authorPublicKey, lat, lng, photos, repeatable, cashAlsoNeeded, reach, reachPeers, pollOptions, durationDays, audienceScope, targetGroupId, targetPubkey, assignedTo } =
        (ctx as any).requestBody || {};
    if (!type || !title || !authorPublicKey) {
        ctx.status = 400;
        ctx.body = { error: 'type, title, and authorPublicKey are required' };
        return;
    }
    if (!assertActorEntitled(ctx, authorPublicKey)) return;
    // This route posts as the SIGNER and nobody else.
    //
    // It used to accept a keeper naming their enterprise as `authorPublicKey` and record them as
    // `created_by` — and the comment here said the web app's event form hosted through it with "Post as".
    // It never could: the signature middleware (https-server.ts) refuses ANY body field ending in
    // `pubkey`/`publickey` that is not the signer, and `authorPublicKey` is not on the allowlist of fields
    // that name someone else on purpose — it must not be, or this route would become spoofable. So an
    // enterprise-hosted event died with 403 "Signature validation failed" before the handler ran, while
    // the handler's own tests passed, because they drive the router directly and never cross the
    // middleware. That is the same trap the middleware's note about `seller` describes.
    //
    // Acting FOR an enterprise puts it in the URL path instead, where no spoof check applies and the
    // treasury route checks keepership: POST /api/treasury/:treasury/{offer,need,event}. So refuse here
    // rather than keep a keeper branch nothing can reach. A non-keeper naming an enterprise has already
    // been refused above, with the answer that fits their case.
    const actor = ctx.state?.actor as string | undefined;
    if (actor !== authorPublicKey) {
        ctx.status = 403;
        ctx.body = { error: 'Post as an enterprise through its own route: POST /api/treasury/:treasury/{offer,need,event}' };
        return;
    }
    try {
        // G3, global profile: a muted member can't post (403), and a new account has its daily limits (429).
        assertNotMuted(actor);
        // A poll keeps no photos, and more than a post can hold is the engine's 400, not a limit.
        assertMayPost(authorPublicKey, type !== 'poll' && Array.isArray(photos) ? Math.min(photos.length, 5) : 0);
        // Events go through the shared builder, so this route and the enterprise's own cannot drift on
        // what an event is (routes/event-post.ts).
        const post = type === 'event'
            ? createEventFromBody((ctx as any).requestBody, authorPublicKey)
            : createPost(
            type, category || 'other', title, description || '',
            Number(credits) || 0, priceType === 'hourly' ? 'hourly' : 'fixed', authorPublicKey,
            lat != null ? Number(lat) : undefined,
            lng != null ? Number(lng) : undefined,
            photos,
            repeatable === true || repeatable === 'true',
            id,
            cashAlsoNeeded === true || cashAlsoNeeded === 'true',
            // #143 step 4. Passed through RAW — `normaliseReach` in the engine is the single place that
            // decides what an unrecognised reach means, and it fail-closes to 'local'. Validating here as
            // well would put two answers in the codebase for "what if this is nonsense".
            { reach, reachPeers, pollOptions, durationDays, audienceScope, targetGroupId, targetPubkey, assignedTo }
        );
        if (!post) {
            ctx.status = 400;
            ctx.body = { error: 'Failed — author must be a registered member' };
            return;
        }

        // Synchronize Daily Pulse marketplace gate (< 2 threshold)
        syncPulseMarketplaceGate();

        ctx.body = { success: true, post };
    } catch (e: any) {
        // A Beans price on a node with Beans off: 403 profile_no_beans, with the plain message (state-engine).
        if (respondProfileRefusal(ctx, e)) return;
        ctx.status = 400;
        ctx.body = { error: e.message || 'Failed to create post' };
    }
});

router.post('/api/marketplace/posts/remove', async (ctx) => {
    try {
        const { id, authorPublicKey } = (ctx as any).requestBody || {};
        if (!id || !authorPublicKey) {
            ctx.status = 400;
            ctx.body = { error: 'id and authorPublicKey are required' };
            return;
        }
        const actor = ctx.state?.actor as string | undefined;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Authentication required' };
            return;
        }

        const postRow = db.prepare("SELECT author_pubkey, target_group_id, audience_scope FROM posts WHERE id = ?").get(id) as any;
        if (!postRow) {
            ctx.status = 404;
            ctx.body = { error: 'Post not found' };
            return;
        }

        let entitled = false;
        if (actor === postRow.author_pubkey) {
            entitled = true;
        } else if (postRow.audience_scope === 'group' && postRow.target_group_id) {
            const isConv = db.prepare(
                "SELECT 1 FROM group_members WHERE group_id = ? AND member_pubkey = ? AND role = 'convenor' AND status = 'active'"
            ).get(postRow.target_group_id, actor);
            if (isConv) {
                entitled = true;
            }
        } else if (isTreasury(postRow.author_pubkey) && canOperateTreasury(actor, postRow.author_pubkey)) {
            entitled = true;
        }

        if (!entitled) {
            ctx.status = 403;
            ctx.body = { error: isTreasury(postRow.author_pubkey)
                ? 'You are not an authorized keeper of this enterprise'
                : 'Not authorized to act on behalf of this identity'
            };
            return;
        }

        const removed = removePost(id, actor);
        if (removed) {
            syncPulseMarketplaceGate();
        }
        ctx.body = { success: removed };
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e.message || 'Failed to remove post' };
    }
});

router.post('/api/marketplace/posts/update', async (ctx) => {
    try {
        const { id, authorPublicKey, ...updates } = (ctx as any).requestBody || {};
        if (!id || !authorPublicKey) {
            ctx.status = 400;
            ctx.body = { error: 'id and authorPublicKey are required' };
            return;
        }
        if (!assertActorEntitled(ctx, authorPublicKey)) return;
        // G3, global profile: an edit publishes too, so a muted member can't make one; on probation, an edit can't
        // bring in photos past the day's allowance. A photo the post already has comes back as its own URL.
        const actor = ctx.state?.actor as string;
        assertNotMuted(actor);
        if (Array.isArray(updates.photos)) {
            const own = new RegExp(`/api/marketplace/posts/${String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/photos/\\d+(\\?.*)?$`);
            const fresh = updates.photos.filter((p: unknown) => !(typeof p === 'string' && own.test(p))).length;
            assertMayEditPhotos(actor, String(id), Math.min(updates.photos.length, 5), fresh);
        }
        const post = updatePost(id, authorPublicKey, updates, ctx.state?.actor);
        if (!post) {
            ctx.status = 404;
            ctx.body = { error: 'Post not found or not owned by you' };
            return;
        }
        ctx.body = { success: true, post };
    } catch (e: any) {
        if (respondProfileRefusal(ctx, e)) return;
        ctx.status = 400;
        ctx.body = { error: e.message || 'Failed to update post' };
    }
});

// ===================== POLLS API =====================

router.post('/api/marketplace/posts/:id/vote', async (ctx) => {
    try {
        const { id } = ctx.params;
        const { optionId, voterPublicKey, voterPubkey, signature } = (ctx as any).requestBody || {};
        const actor = ctx.state?.actor as string | undefined;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Authentication required' };
            return;
        }
        if ((voterPublicKey && voterPublicKey !== actor) || (voterPubkey && voterPubkey !== actor)) {
            ctx.status = 403;
            ctx.body = { error: 'Cannot vote on behalf of another member' };
            return;
        }
        if (!id || !optionId) {
            ctx.status = 400;
            ctx.body = { error: 'id and optionId are required' };
            return;
        }
        const voter = actor;
        const sig = signature;
        const result = votePoll(id, voter, optionId, sig);
        ctx.body = result;
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e.message || 'Failed to record vote' };
    }
});

router.post('/api/marketplace/polls/vote', async (ctx) => {
    try {
        const { postId, id, optionId, voterPublicKey, voterPubkey, signature } = (ctx as any).requestBody || {};
        const targetId = postId || id;
        const actor = ctx.state?.actor as string | undefined;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Authentication required' };
            return;
        }
        if ((voterPublicKey && voterPublicKey !== actor) || (voterPubkey && voterPubkey !== actor)) {
            ctx.status = 403;
            ctx.body = { error: 'Cannot vote on behalf of another member' };
            return;
        }
        if (!targetId || !optionId) {
            ctx.status = 400;
            ctx.body = { error: 'postId and optionId are required' };
            return;
        }
        const voter = actor;
        const sig = signature;
        const result = votePoll(targetId, voter, optionId, sig);
        ctx.body = result;
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e.message || 'Failed to record vote' };
    }
});

router.post('/api/marketplace/posts/:id/close', async (ctx) => {
    try {
        const { id } = ctx.params;
        const { authorPublicKey, authorPubkey } = (ctx as any).requestBody || {};
        const actor = ctx.state?.actor as string | undefined;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Authentication required' };
            return;
        }
        if ((authorPublicKey && authorPublicKey !== actor) || (authorPubkey && authorPubkey !== actor)) {
            ctx.status = 403;
            ctx.body = { error: 'Cannot close poll on behalf of another member' };
            return;
        }
        if (!id) {
            ctx.status = 400;
            ctx.body = { error: 'id is required' };
            return;
        }
        const post = closePoll(id, actor);
        if (!post) {
            ctx.status = 404;
            ctx.body = { error: 'Poll not found or unauthorized' };
            return;
        }
        ctx.body = { success: true, post };
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e.message || 'Failed to close poll' };
    }
});

router.post('/api/marketplace/polls/close', async (ctx) => {
    try {
        const { postId, id, authorPublicKey, authorPubkey } = (ctx as any).requestBody || {};
        const targetId = postId || id;
        const actor = ctx.state?.actor as string | undefined;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Authentication required' };
            return;
        }
        if ((authorPublicKey && authorPublicKey !== actor) || (authorPubkey && authorPubkey !== actor)) {
            ctx.status = 403;
            ctx.body = { error: 'Cannot close poll on behalf of another member' };
            return;
        }
        if (!targetId) {
            ctx.status = 400;
            ctx.body = { error: 'postId is required' };
            return;
        }
        const post = closePoll(targetId, actor);
        if (!post) {
            ctx.status = 404;
            ctx.body = { error: 'Poll not found or unauthorized' };
            return;
        }
        ctx.body = { success: true, post };
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e.message || 'Failed to close poll' };
    }
});

// ===================== EVENTS API =====================

// RSVP: body `{ status: 'going' | 'interested' | null }`; null is "not going". The member is always the
// signed actor — nobody RSVPs for someone else. Cancelling an event is the existing remove route.
router.post('/api/marketplace/posts/:id/rsvp', async (ctx) => {
    try {
        const { id } = ctx.params;
        const body = (ctx as any).requestBody || {};
        const actor = ctx.state?.actor as string | undefined;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Authentication required' };
            return;
        }
        if ((body.memberPublicKey && body.memberPublicKey !== actor) || (body.memberPubkey && body.memberPubkey !== actor)) {
            ctx.status = 403;
            ctx.body = { error: 'Cannot RSVP on behalf of another member' };
            return;
        }
        const status = body.status ?? null;
        if (status !== null && status !== 'going' && status !== 'interested') {
            ctx.status = 400;
            ctx.body = { error: "status must be 'going', 'interested' or null" };
            return;
        }
        ctx.body = rsvpEvent(id, actor, status, body.signature);
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e.message || 'Failed to record RSVP' };
    }
});

// --------------------- Event chat (docs/events-on-the-map.md §2.2, slice 4) ---------------------
//
// The chat's id IS the event's id. Every call is signed: the host and everyone marked Going may read and
// post, the host may remove a message, and the chat is read-only once the event ends or is cancelled. The
// private note rides on the read so the client can pin it at the top without storing it as a message.

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Map an event-chat refusal onto a status. Anything unrecognised is a 400, as elsewhere on this router. */
function eventChatStatus(msg: string): number {
    if (msg.includes('Event not found')) return 404;
    if (msg.includes('no longer available')) return 410;
    if (msg.includes('Only the host and people going') || msg.includes('Only the host can remove')) return 403;
    if (msg.includes('Frozen') || msg.includes('disabled') || msg.includes('suspended')
        || msg.includes('pruned') || msg.includes('Account closed')
        || msg.includes('Device key has been invalidated') || msg.includes('Member not found')) return 403;
    if (msg.includes('Message not found')) return 404;
    return 400;
}

router.get('/api/marketplace/posts/:id/chat', async (ctx) => {
    const actor = ctx.state?.actor as string | undefined;
    if (!actor) {
        ctx.status = 401;
        ctx.body = { error: 'Authentication required' };
        return;
    }
    // Same clamping as every other paged route, capped at this chat's page of 100.
    const limit = Math.min(clampLimit(ctx.query.limit), 100);
    const offset = clampOffset(ctx.query.offset);
    try {
        ctx.body = getEventThread(ctx.params.id, actor, limit, offset);
    } catch (e: any) {
        const msg = e?.message || 'Could not open the event chat';
        ctx.status = eventChatStatus(msg);
        ctx.body = { error: msg };
    }
});

router.post('/api/marketplace/posts/:id/chat/message', async (ctx) => {
    // The only route on this router that writes a row per call with no cost, no cap and no cooldown: an
    // event chat is the host plus everyone Going, so a flood lands in a real inbox and a push-free write
    // loop is cheap to run. Throttled per signed member in the chat bucket, as group chat is — not the per-IP
    // auth limiter, which also guards recovery and pairing for everyone behind the same NAT.
    const actor = ctx.state?.actor as string | undefined;
    if (!actor) {
        ctx.status = 401;
        ctx.body = { error: 'Authentication required' };
        return;
    }
    if (!chatRateLimit(ctx, actor)) return;
    const body = (ctx as any).requestBody || {};
    const text = typeof body.text === 'string' ? body.text : (typeof body.message === 'string' ? body.message : '');
    let clientId: string | undefined;
    if (body.clientId !== undefined && body.clientId !== null) {
        if (typeof body.clientId !== 'string' || !UUID_V4.test(body.clientId)) {
            ctx.status = 400;
            ctx.body = { error: 'clientId must be a UUID v4' };
            return;
        }
        clientId = body.clientId.toLowerCase();
    }
    if (!text.trim()) {
        ctx.status = 400;
        ctx.body = { error: 'Message text cannot be empty' };
        return;
    }
    try {
        // A muted member (G3) sends nothing anyone else reads.
        assertNotMuted(actor);
        const message = postEventThreadMessage(ctx.params.id, actor, text, clientId);
        ctx.status = 201;
        ctx.body = { success: true, message };
    } catch (e: any) {
        if (respondProfileRefusal(ctx, e)) return;
        const msg = e?.message || 'Could not post the message';
        if (e?.code === 'ID_CONFLICT' || msg.includes('already exists')) {
            ctx.status = 409;
            ctx.body = { error: msg };
            return;
        }
        ctx.status = eventChatStatus(msg);
        ctx.body = { error: msg };
    }
});

router.post('/api/marketplace/posts/:id/chat/remove', async (ctx) => {
    const actor = ctx.state?.actor as string | undefined;
    if (!actor) {
        ctx.status = 401;
        ctx.body = { error: 'Authentication required' };
        return;
    }
    const body = (ctx as any).requestBody || {};
    const messageId = body.messageId || body.id;
    if (!messageId || typeof messageId !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'messageId is required' };
        return;
    }
    try {
        const message = removeEventThreadMessage(ctx.params.id, messageId, actor);
        ctx.body = { success: true, message };
    } catch (e: any) {
        const msg = e?.message || 'Could not remove the message';
        ctx.status = eventChatStatus(msg);
        ctx.body = { error: msg };
    }
});

// ===================== MARKETPLACE TRANSACTIONS =====================

router.post('/api/marketplace/posts/accept', async (ctx) => {
    try {
        const { postId, buyerPublicKey, hours } = (ctx as any).requestBody || {};
        if (!postId || !buyerPublicKey) {
            ctx.status = 400;
            ctx.body = { error: 'postId and buyerPublicKey are required' };
            return;
        }
        if (!assertActorEntitled(ctx, buyerPublicKey)) return;
        const actor = ctx.state?.actor as string | undefined;
        const parsedHours = hours != null ? Number(hours) : undefined;
        const tx = acceptPost(postId, buyerPublicKey, parsedHours, actor ? { authSigner: actor } : undefined);
        if (tx) {
            syncPulseMarketplaceGate();
        }
        ctx.body = { success: true, transaction: tx };
    } catch (err: any) {
        // #102: the escrow engine refuses a visitor's draw — surface it as 503 + code, not a 400.
        respondSettlementAware(ctx, err, 'Failed to accept post');
    }
});

router.post('/api/marketplace/posts/request', async (ctx) => {
    try {
        const { postId, buyerPublicKey, hours } = (ctx as any).requestBody || {};
        if (!postId || !buyerPublicKey) {
            ctx.status = 400;
            ctx.body = { error: 'postId and buyerPublicKey are required' };
            return;
        }
        if (!assertActorEntitled(ctx, buyerPublicKey)) return;
        const parsedHours = hours != null ? Number(hours) : undefined;
        const tx = requestPost(postId, buyerPublicKey, parsedHours);
        if (!tx) throw new Error('Cannot request — post not found or unauthorized');
        ctx.body = { success: true, transaction: tx };
    } catch (err: any) {
        respondSettlementAware(ctx, err, 'Failed to request post');
    }
});

router.post('/api/marketplace/transactions/approve', async (ctx) => {
    try {
        const { transactionId, authorPublicKey } = (ctx as any).requestBody || {};
        if (!transactionId || !authorPublicKey) {
            ctx.status = 400;
            ctx.body = { error: 'transactionId and authorPublicKey are required' };
            return;
        }
        if (!assertActorEntitled(ctx, authorPublicKey)) return;
        const actor = ctx.state?.actor as string;
        const tx = approvePostRequest(transactionId, authorPublicKey, { authSigner: actor });
        if (!tx) {
            ctx.status = 400;
            ctx.body = { error: 'Cannot approve — request not found or unauthorized' };
            return;
        }
        ctx.body = { success: true, transaction: tx };
    } catch (err: any) {
        respondSettlementAware(ctx, err, 'Failed to approve request');
    }
});

router.post('/api/marketplace/transactions/reject', async (ctx) => {
    try {
        const { transactionId, authorPublicKey } = (ctx as any).requestBody || {};
        if (!transactionId || !authorPublicKey) {
            ctx.status = 400;
            ctx.body = { error: 'transactionId and authorPublicKey are required' };
            return;
        }
        if (!assertActorEntitled(ctx, authorPublicKey)) return;
        const tx = rejectPostRequest(transactionId, authorPublicKey);
        if (!tx) {
            ctx.status = 400;
            ctx.body = { error: 'Cannot reject — request not found or unauthorized' };
            return;
        }
        ctx.body = { success: true, transaction: tx };
    } catch (err: any) {
        respondSettlementAware(ctx, err, 'Failed to reject request');
    }
});

router.post('/api/marketplace/transactions/cancel-request', async (ctx) => {
    try {
        const { transactionId, buyerPublicKey } = (ctx as any).requestBody || {};
        if (!transactionId || !buyerPublicKey) {
            ctx.status = 400;
            ctx.body = { error: 'transactionId and buyerPublicKey are required' };
            return;
        }
        if (!assertActorEntitled(ctx, buyerPublicKey)) return;
        const tx = cancelPostRequest(transactionId, buyerPublicKey);
        if (!tx) {
            ctx.status = 400;
            ctx.body = { error: 'Cannot cancel — request not found or unauthorized' };
            return;
        }
        ctx.body = { success: true, transaction: tx };
    } catch (err: any) {
        respondSettlementAware(ctx, err, 'Failed to cancel request');
    }
});

router.post('/api/marketplace/transactions/complete', async (ctx) => {
    const { transactionId, confirmerPublicKey, finalHours, hours } = (ctx as any).requestBody || {};
    if (!transactionId || !confirmerPublicKey) {
        ctx.status = 400;
        ctx.body = { error: 'transactionId and confirmerPublicKey are required' };
        return;
    }
    if (!assertActorEntitled(ctx, confirmerPublicKey)) return;
    const rawHours = finalHours !== undefined ? finalHours : hours;
    const parsedFinalHours = rawHours != null && !isNaN(Number(rawHours)) ? Number(rawHours) : undefined;
    try {
        const actor = ctx.state?.actor as string;
        const tx = completePostTransaction(transactionId, confirmerPublicKey, parsedFinalHours, { authSigner: actor });
        if (!tx) {
            ctx.status = 400;
            ctx.body = { error: 'Cannot complete — transaction not found or not authorized' };
            return;
        }
        syncPulseMarketplaceGate();
        ctx.body = { success: true, transaction: tx, alreadyCompleted: !!(tx as any).alreadyCompleted };
    } catch (e: any) {
        const rawCode = e?.status ?? e?.statusCode;
        const statusCode = typeof rawCode === 'number' && Number.isInteger(rawCode) && rawCode >= 400 && rawCode <= 599
            ? rawCode
            : 400;
        ctx.status = statusCode;
        ctx.body = { error: e.message || 'Escrow release failed' };
    }
});

router.post('/api/marketplace/transactions/cancel', async (ctx) => {
    try {
        const { transactionId, cancellerPublicKey } = (ctx as any).requestBody || {};
        if (!transactionId || !cancellerPublicKey) {
            ctx.status = 400;
            ctx.body = { error: 'transactionId and cancellerPublicKey are required' };
            return;
        }
        if (!assertActorEntitled(ctx, cancellerPublicKey)) return;
        const tx = cancelPostTransaction(transactionId, cancellerPublicKey);
        if (!tx) {
            ctx.status = 400;
            ctx.body = { error: 'Cannot cancel — transaction not found or not authorized' };
            return;
        }
        syncPulseMarketplaceGate();
        ctx.body = { success: true, transaction: tx };
    } catch (err: any) {
        respondSettlementAware(ctx, err, 'Failed to cancel transaction');
    }
});

router.post('/api/marketplace/posts/pause', async (ctx) => {
    try {
        const { postId, authorPublicKey } = (ctx as any).requestBody || {};
        if (!postId || !authorPublicKey) {
            ctx.status = 400;
            ctx.body = { error: 'postId and authorPublicKey are required' };
            return;
        }
        if (!assertActorEntitled(ctx, authorPublicKey)) return;
        const success = pausePost(postId, authorPublicKey);
        if (success) {
            syncPulseMarketplaceGate();
            ctx.body = { success: true };
            return;
        }
        // Return 400 status on failed mutation instead of HTTP 200 with { success: false }
        ctx.status = 400;
        ctx.body = { success: false, error: 'Post not found, not active, or not owned by author' };
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e.message || 'Failed to pause post' };
    }
});

router.post('/api/marketplace/posts/resume', async (ctx) => {
    try {
        const { postId, authorPublicKey } = (ctx as any).requestBody || {};
        if (!postId || !authorPublicKey) {
            ctx.status = 400;
            ctx.body = { error: 'postId and authorPublicKey are required' };
            return;
        }
        if (!assertActorEntitled(ctx, authorPublicKey)) return;
        const success = resumePost(postId, authorPublicKey);
        if (success) {
            syncPulseMarketplaceGate();
            ctx.body = { success: true };
            return;
        }
        // Return 400 status on failed mutation instead of HTTP 200 with { success: false }
        ctx.status = 400;
        ctx.body = { success: false, error: 'Post not found, not paused, or not owned by author' };
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e.message || 'Failed to resume post' };
    }
});

router.get('/api/marketplace/transactions', async (ctx) => {
    const publicKey = ctx.query.publicKey as string;
    const status = ctx.query.status as string | undefined;
    if (!publicKey) {
        ctx.status = 400;
        ctx.body = { error: 'publicKey query parameter is required' };
        return;
    }
    if (ENFORCE_READ_AUTH) {
        const actor = ctx.state?.actor as string | undefined;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Authentication required' };
            return;
        }
        const isSelf = actor === publicKey;
        const isAuthorizedKeeper = Boolean(isTreasury(publicKey) && canOperateTreasury(actor, publicKey));
        if (!isSelf && !isAuthorizedKeeper) {
            ctx.status = 403;
            ctx.body = { error: isTreasury(publicKey)
                ? 'You are not authorized to view transactions for this enterprise'
                : 'You may only view your own marketplace transactions'
            };
            return;
        }
    }
    const limit = clampLimit(ctx.query.limit);
    const offset = clampOffset(ctx.query.offset);
    ctx.body = getMarketplaceTransactions(publicKey, status ? { status } : undefined, limit, offset);
});


    return router;
}

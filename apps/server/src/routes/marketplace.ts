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
} from '../state-engine.js';
import { db } from '../db/db.js';
import { getPeerOrigins } from '../connector-manager.js';
import { respondSettlementAware } from '../federation-settlement.js';
import { syncPulseMarketplaceGate } from '../daily-pulse.js';
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
    const photo = db.prepare(`SELECT photo_data FROM post_photos WHERE post_id = ? AND order_num = ?`).get(id, Number(orderNum)) as { photo_data: string } | undefined;
    
    if (!photo) {
        ctx.status = 404;
        ctx.body = { error: 'Photo not found' };
        return;
    }

    // Post photos are immutable per (id, order_num): getPosts versions the URL with the photo's
    // updated_at (?v=…), so an edited photo is served under a NEW url. That lets clients cache
    // the bytes forever — killing the cold-start re-download of every photo — with no staleness.
    ctx.set('Cache-Control', 'public, max-age=31536000, immutable');

    // Parse out data URL if present
    const match = photo.photo_data.match(/^data:([^;]+);base64,(.*)$/);
    if (match) {
        ctx.type = match[1];
        ctx.body = Buffer.from(match[2], 'base64');
    } else {
        ctx.type = 'image/jpeg';
        ctx.body = Buffer.from(photo.photo_data, 'base64');
    }
});

// Lazy-load an encrypted message attachment (image). Returns ciphertext only —
// the node can't read it; the recipient decrypts with the DM key + nonce.
router.get('/api/messages/:id/attachment', async (ctx) => {
    const { id } = ctx.params;
    const row = db.prepare(`SELECT data, nonce, mime FROM message_attachments WHERE message_id = ?`).get(id) as { data: string; nonce: string; mime: string } | undefined;
    if (!row) {
        ctx.status = 404;
        ctx.body = { error: 'Attachment not found' };
        return;
    }
    ctx.body = { data: row.data, nonce: row.nonce, mime: row.mime || 'image/jpeg' };
});

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
    const types = typeof ctx.query.types === 'string'
        ? ctx.query.types.split(',').map(t => t.trim()).filter(Boolean)
        : undefined;
    const wantsEvents = type === 'event' || !!types?.includes('event');
    const excludeEvents = !id && !wantsEvents;

    // viewerPubkey (the signed requester) lets an author see their OWN paused posts; others don't.
    const posts = getPosts({ id, type, types, excludeEvents, category, query: q, limit, offset, updatedAfter, authorPubkey: author, viewerPubkey, sync, beansOnly, audienceScope, targetGroupId, assignedTo });
    const bodyStr = JSON.stringify(posts);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = bodyStr;
});

router.post('/api/marketplace/posts', async (ctx) => {
    const { id, type, category, title, description, credits, priceType, authorPublicKey, lat, lng, photos, repeatable, cashAlsoNeeded, reach, reachPeers, pollOptions, durationDays, audienceScope, targetGroupId, targetPubkey, assignedTo,
        eventStartAt, eventEndAt, eventPlaceName, eventPrivateNote } =
        (ctx as any).requestBody || {};
    if (!type || !title || !authorPublicKey) {
        ctx.status = 400;
        ctx.body = { error: 'type, title, and authorPublicKey are required' };
        return;
    }
    if (!assertActorEntitled(ctx, authorPublicKey)) return;
    try {
        const post = createPost(
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
            { reach, reachPeers, pollOptions, durationDays, audienceScope, targetGroupId, targetPubkey, assignedTo,
              eventStartAt, eventEndAt, eventPlaceName, eventPrivateNote }
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
        const post = updatePost(id, authorPublicKey, updates);
        if (!post) {
            ctx.status = 404;
            ctx.body = { error: 'Post not found or not owned by you' };
            return;
        }
        ctx.body = { success: true, post };
    } catch (e: any) {
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
        }
        ctx.body = { success };
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
        }
        ctx.body = { success };
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

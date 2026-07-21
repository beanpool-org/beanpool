/**
 * Marketplace Posts and Escrow Transaction routes.
 */

import Router from '@koa/router';
import fs from 'node:fs';
import path from 'node:path';
import {
    createPost, getPosts, removePost, updatePost,
    acceptPost, completePostTransaction, cancelPostTransaction,
    pausePost, resumePost, getMarketplaceTransactions,
    requestPost, approvePostRequest, rejectPostRequest, cancelPostRequest,
    getMember, getBalance,
} from '../state-engine.js';
import { db } from '../db/db.js';
import type { RouteDeps } from './types.js';

export function createMarketplaceRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { clampLimit, clampOffset } = deps;

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
    // viewerPubkey (the signed requester) lets an author see their OWN paused posts; others don't.
    ctx.body = getPosts({ id, type, category, query: q, limit, offset, updatedAfter, authorPubkey: author, viewerPubkey: ctx.state.actor as string | undefined, sync });
});

router.post('/api/marketplace/posts', async (ctx) => {
    const { id, type, category, title, description, credits, priceType, authorPublicKey, lat, lng, photos, repeatable } =
        (ctx as any).requestBody || {};
    if (!type || !title || !authorPublicKey) {
        ctx.status = 400;
        ctx.body = { error: 'type, title, and authorPublicKey are required' };
        return;
    }
    try {
        const post = createPost(
            type, category || 'other', title, description || '',
            Number(credits) || 0, priceType === 'hourly' ? 'hourly' : 'fixed', (ctx.state.actor as string) || authorPublicKey,
            lat != null ? Number(lat) : undefined,
            lng != null ? Number(lng) : undefined,
            photos,
            repeatable === true || repeatable === 'true',
            id
        );
        if (!post) {
            ctx.status = 400;
            ctx.body = { error: 'Failed — author must be a registered member' };
            return;
        }
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
        const removed = removePost(id, (ctx.state.actor as string) || authorPublicKey);
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
        const post = updatePost(id, (ctx.state.actor as string) || authorPublicKey, updates);
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

// ===================== MARKETPLACE TRANSACTIONS =====================

router.post('/api/marketplace/posts/accept', async (ctx) => {
    try {
        const { postId, buyerPublicKey, hours } = (ctx as any).requestBody || {};
        if (!postId || !buyerPublicKey) {
            ctx.status = 400;
            ctx.body = { error: 'postId and buyerPublicKey are required' };
            return;
        }
        const parsedHours = hours != null ? Number(hours) : undefined;
        const tx = acceptPost(postId, (ctx.state.actor as string) || buyerPublicKey, parsedHours);
        ctx.body = { success: true, transaction: tx };
    } catch (err: any) {
        ctx.status = 400;
        ctx.body = { error: err.message };
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
        const parsedHours = hours != null ? Number(hours) : undefined;
        const tx = requestPost(postId, (ctx.state.actor as string) || buyerPublicKey, parsedHours);
        if (!tx) throw new Error('Cannot request — post not found or unauthorized');
        ctx.body = { success: true, transaction: tx };
    } catch (err: any) {
        ctx.status = 400;
        ctx.body = { error: err.message };
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
        const tx = approvePostRequest(transactionId, (ctx.state.actor as string) || authorPublicKey);
        ctx.body = { success: true, transaction: tx };
    } catch (err: any) {
        ctx.status = 400;
        ctx.body = { error: err.message };
    }
});

router.post('/api/marketplace/transactions/reject', async (ctx) => {
    const { transactionId, authorPublicKey } = (ctx as any).requestBody || {};
    if (!transactionId || !authorPublicKey) {
        ctx.status = 400;
        ctx.body = { error: 'transactionId and authorPublicKey are required' };
        return;
    }
    const tx = rejectPostRequest(transactionId, (ctx.state.actor as string) || authorPublicKey);
    if (!tx) {
        ctx.status = 400;
        ctx.body = { error: 'Cannot reject — request not found or unauthorized' };
        return;
    }
    ctx.body = { success: true, transaction: tx };
});

router.post('/api/marketplace/transactions/cancel-request', async (ctx) => {
    const { transactionId, buyerPublicKey } = (ctx as any).requestBody || {};
    if (!transactionId || !buyerPublicKey) {
        ctx.status = 400;
        ctx.body = { error: 'transactionId and buyerPublicKey are required' };
        return;
    }
    const tx = cancelPostRequest(transactionId, (ctx.state.actor as string) || buyerPublicKey);
    if (!tx) {
        ctx.status = 400;
        ctx.body = { error: 'Cannot cancel — request not found or unauthorized' };
        return;
    }
    ctx.body = { success: true, transaction: tx };
});

router.post('/api/marketplace/transactions/complete', async (ctx) => {
    const { transactionId, confirmerPublicKey, finalHours } = (ctx as any).requestBody || {};
    if (!transactionId || !confirmerPublicKey) {
        ctx.status = 400;
        ctx.body = { error: 'transactionId and confirmerPublicKey are required' };
        return;
    }
    const parsedFinalHours = finalHours != null ? Number(finalHours) : undefined;
    try {
        const tx = completePostTransaction(transactionId, (ctx.state.actor as string) || confirmerPublicKey, parsedFinalHours);
        if (!tx) {
            ctx.status = 400;
            ctx.body = { error: 'Cannot complete — transaction not found or not authorized' };
            return;
        }
        ctx.body = { success: true, transaction: tx, alreadyCompleted: !!(tx as any).alreadyCompleted };
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e.message || 'Escrow release failed' };
    }
});

router.post('/api/marketplace/transactions/cancel', async (ctx) => {
    const { transactionId, cancellerPublicKey } = (ctx as any).requestBody || {};
    if (!transactionId || !cancellerPublicKey) {
        ctx.status = 400;
        ctx.body = { error: 'transactionId and cancellerPublicKey are required' };
        return;
    }
    const tx = cancelPostTransaction(transactionId, (ctx.state.actor as string) || cancellerPublicKey);
    if (!tx) {
        ctx.status = 400;
        ctx.body = { error: 'Cannot cancel — transaction not found or not authorized' };
        return;
    }
    ctx.body = { success: true, transaction: tx };
});

router.post('/api/marketplace/posts/pause', async (ctx) => {
    try {
        const { postId, authorPublicKey } = (ctx as any).requestBody || {};
        if (!postId || !authorPublicKey) {
            ctx.status = 400;
            ctx.body = { error: 'postId and authorPublicKey are required' };
            return;
        }
        const success = pausePost(postId, (ctx.state.actor as string) || authorPublicKey);
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
        const success = resumePost(postId, (ctx.state.actor as string) || authorPublicKey);
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
    const limit = clampLimit(ctx.query.limit);
    const offset = clampOffset(ctx.query.offset);
    ctx.body = getMarketplaceTransactions(publicKey, status ? { status } : undefined, limit, offset);
});


    return router;
}

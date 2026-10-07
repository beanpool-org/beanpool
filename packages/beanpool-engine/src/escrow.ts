// Marketplace Transactions & Escrow pure database queries.
//
// Extracted from apps/server/src/state-engine.ts.

import type Database from 'better-sqlite3';
import { authorsOnly, postPhotoUrl, type OffListingPhotoShown } from './photo-url.js';

type Db = Database.Database;

export interface MarketplaceTransaction {
    id: string;
    postId: string;
    postTitle: string;
    buyerPublicKey: string;
    buyerCallsign: string;
    sellerPublicKey: string;
    sellerCallsign: string;
    credits: number;
    hours?: number;
    status: 'requested' | 'pending' | 'completed' | 'cancelled' | 'rejected' | string;
    createdAt: string;
    completedAt?: string;
    ratedByBuyer?: boolean;
    ratedBySeller?: boolean;
    coverImage?: string | null;
    disputeResolution?: 'release_to_seller' | 'refund_to_buyer' | 'split' | string;
    disputeResolvedAt?: string;
    // No disputeResolvedBy: this is the parties' view of their trade, and the admin who ruled is named in
    // words on the ruling itself. The signer stays on the row for the admin dispute views.
}

function selectInChunks<T = any>(db: Db, ids: string[], queryBuilder: (placeholders: string) => string, chunkSize = 500): T[] {
    if (ids.length === 0) return [];
    const results: T[] = [];
    for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = db.prepare(queryBuilder(placeholders)).all(...chunk) as T[];
        results.push(...rows);
    }
    return results;
}

export function getMarketplaceTransaction(db: Db, transactionId: string): MarketplaceTransaction | null {
    const r = db.prepare(`
        SELECT mt.*, p.title as postTitle, p.audience_scope as postAudienceScope, p.author_pubkey as postAuthor,
               COALESCE(p.active, 0) = 1 as postLive, m1.callsign as buyerCallsign, m2.callsign as sellerCallsign,
               EXISTS(SELECT 1 FROM ratings r WHERE r.transaction_id = mt.id AND r.rater_pubkey = mt.buyer_pubkey) as ratedByBuyer,
               EXISTS(SELECT 1 FROM ratings r WHERE r.transaction_id = mt.id AND r.rater_pubkey = mt.seller_pubkey) as ratedBySeller
        FROM marketplace_transactions mt
        LEFT JOIN posts p ON mt.post_id = p.id
        LEFT JOIN members m1 ON mt.buyer_pubkey = m1.public_key
        LEFT JOIN members m2 ON mt.seller_pubkey = m2.public_key
        WHERE mt.id = ?
    `).get(transactionId) as any;
    if (!r) return null;

    // Keyed as its listing's photos are, from the listing's audience (photo-url.ts). One trade goes to both its parties
    // (the escrow broadcasts), and a reader's own list is getMarketplaceTransactions: so a listing taken off, or gone,
    // has no cover here, as the photo route answers its photo to neither party's app.
    const coverImageRow = r.postLive
        ? db.prepare(`SELECT order_num, updated_at FROM post_photos WHERE post_id = ? ORDER BY order_num ASC LIMIT 1`).get(r.post_id) as any
        : undefined;
    const coverImage = coverImageRow
        ? postPhotoUrl(r.post_id, coverImageRow.order_num, coverImageRow.updated_at, r.postAudienceScope)
        : null;

    return {
        id: r.id,
        postId: r.post_id,
        postTitle: r.postTitle,
        buyerPublicKey: r.buyer_pubkey,
        buyerCallsign: r.buyerCallsign,
        sellerPublicKey: r.seller_pubkey,
        sellerCallsign: r.sellerCallsign,
        credits: r.credits,
        hours: r.hours ?? undefined,
        status: r.status,
        createdAt: r.created_at,
        completedAt: r.completed_at,
        ratedByBuyer: !!r.ratedByBuyer,
        ratedBySeller: !!r.ratedBySeller,
        coverImage,
        disputeResolution: r.dispute_resolution || undefined,
        disputeResolvedAt: r.dispute_resolved_at || undefined
    };
}

/**
 * A member's trades, newest first. A trade's cover is its listing's first photo, by the URL the photo route serves to this
 * member: none when the listing was taken off (`active` not 1) and the photo route would answer this member 404
 * (offPhotoShown, the server's rule; its author's part when none is given), or when the listing is gone.
 */
export function getMarketplaceTransactions(db: Db, publicKey: string, filter?: { status?: string }, limit = 50, offset = 0, offPhotoShown: OffListingPhotoShown = authorsOnly(publicKey)): MarketplaceTransaction[] {
    let query = `
        SELECT mt.*, p.title as postTitle, p.audience_scope as postAudienceScope, p.author_pubkey as postAuthor,
               COALESCE(p.active, 0) = 1 as postLive, m1.callsign as buyerCallsign, m2.callsign as sellerCallsign,
               EXISTS(SELECT 1 FROM ratings r WHERE r.transaction_id = mt.id AND r.rater_pubkey = mt.buyer_pubkey) as ratedByBuyer,
               EXISTS(SELECT 1 FROM ratings r WHERE r.transaction_id = mt.id AND r.rater_pubkey = mt.seller_pubkey) as ratedBySeller
        FROM marketplace_transactions mt
        LEFT JOIN posts p ON mt.post_id = p.id
        LEFT JOIN members m1 ON mt.buyer_pubkey = m1.public_key
        LEFT JOIN members m2 ON mt.seller_pubkey = m2.public_key
        WHERE (mt.buyer_pubkey = ? OR mt.seller_pubkey = ?)
    `;
    const params: any[] = [publicKey, publicKey];
    if (filter?.status) { query += " AND mt.status = ?"; params.push(filter.status); }
    query += " ORDER BY mt.created_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = db.prepare(query).all(...params) as any[];
    const postIds = Array.from(new Set(rows.map(r => r.post_id)));
    // ORDER BY order_num ASC ensures postPhotos[0] is always the cover photo (order_num = 0 or lowest available)
    const photos = selectInChunks(db, postIds, ph => `SELECT post_id, order_num, updated_at FROM post_photos WHERE post_id IN (${ph}) ORDER BY order_num ASC`);

    const photosByPost = new Map<string, any[]>();
    for (const p of photos as any[]) {
        if (!photosByPost.has(p.post_id)) {
            photosByPost.set(p.post_id, []);
        }
        photosByPost.get(p.post_id)!.push(p);
    }

    return rows.map(r => {
        const photoShown = !!r.postLive || (r.postAuthor != null && offPhotoShown(r.post_id, r.postAuthor));
        const postPhotos = photoShown ? photosByPost.get(r.post_id) || [] : [];
        // ⚡ Bolt: Photos are ordered by order_num ASC, so postPhotos[0] is the cover photo in O(1) time without .find()
        const coverImageRow = postPhotos[0];
        const coverImage = coverImageRow
            ? postPhotoUrl(r.post_id, coverImageRow.order_num, coverImageRow.updated_at, r.postAudienceScope)
            : null;
        return {
            id: r.id,
            postId: r.post_id,
            postTitle: r.postTitle,
            buyerPublicKey: r.buyer_pubkey,
            buyerCallsign: r.buyerCallsign,
            sellerPublicKey: r.seller_pubkey,
            sellerCallsign: r.sellerCallsign,
            credits: r.credits,
            hours: r.hours ?? undefined,
            status: r.status,
            createdAt: r.created_at,
            completedAt: r.completed_at,
            ratedByBuyer: !!r.ratedByBuyer,
            ratedBySeller: !!r.ratedBySeller,
            coverImage,
            disputeResolution: r.dispute_resolution || undefined,
            disputeResolvedAt: r.dispute_resolved_at || undefined
        };
    });
}

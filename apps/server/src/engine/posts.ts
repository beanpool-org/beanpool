// Stateful mutations for Marketplace Posts.
//
// Extracted from apps/server/src/state-engine.ts.

import { db } from '../db/db.js';
import crypto from 'node:crypto';
import {
    getMember,
    getPosts,
    validatePostPhotos,
    generateSearchKeywords,
    hasListedOffer,
    CONTRIBUTION_REQUIRED_ERROR,
    type MarketplacePost
} from '@beanpool/engine';

type BroadcastFn = (event: any, recipients?: string[]) => void;

const HOLIDAY_MODE_ERROR = 'HOLIDAY_MODE: turn off holiday mode in Settings before trading.';

function assertMemberActive(publicKey: string): void {
    if (publicKey.startsWith('escrow_') || publicKey.startsWith('project_') || publicKey === 'COMMONS_POOL' || publicKey === 'SYSTEM' || publicKey === 'genesis') return;
    const member = db.prepare("SELECT status FROM members WHERE public_key = ?").get(publicKey) as any;
    if (!member) throw new Error('Member not found');
    if (member.status === 'disabled') throw new Error('Account is disabled');
    if (member.status === 'pruned') throw new Error('Account has been pruned');
}

function assertProfileComplete(publicKey: string): void {
    const member = db.prepare("SELECT avatar_url, callsign FROM members WHERE public_key = ?").get(publicKey) as any;
    if (!member) return;
    if (!member.avatar_url) {
        throw new Error('Please set a profile photo before using the marketplace. Tap your profile to add one.');
    }
    if (!member.callsign || member.callsign.trim().length < 2) {
        throw new Error('Please set a display name before using the marketplace.');
    }
}

function isOnHoliday(publicKey: string): boolean {
    const row = db.prepare("SELECT pref_value FROM member_preferences WHERE public_key = ? AND pref_key = 'holiday_mode'").get(publicKey) as any;
    return row?.pref_value === 'true';
}

function assertNotOnHoliday(publicKey: string): void {
    if (isOnHoliday(publicKey)) throw new Error(HOLIDAY_MODE_ERROR);
}

export function createPost(
    broadcast: BroadcastFn,
    type: 'offer' | 'need',
    category: string,
    title: string,
    description: string,
    credits: number,
    priceType: 'fixed' | 'hourly' | 'daily' | 'weekly' | 'monthly' | string,
    authorPublicKey: string,
    lat?: number,
    lng?: number,
    photos?: string[],
    repeatable?: boolean,
    id?: string
): MarketplacePost | null {
    assertMemberActive(authorPublicKey);
    if (!getMember(db, authorPublicKey)) {
        return null;
    }
    assertProfileComplete(authorPublicKey);
    assertNotOnHoliday(authorPublicKey);
    validatePostPhotos(photos);

    if (type === 'need' && !hasListedOffer(db, authorPublicKey)) throw new Error(CONTRIBUTION_REQUIRED_ERROR);

    const finalId = id || crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const searchKeywords = generateSearchKeywords(title, description, category);
    
    db.transaction(() => {
        db.prepare(`INSERT INTO posts (
            id, type, category, title, description, credits, price_type, author_pubkey, created_at, active, status, repeatable, lat, lng, updated_at, search_keywords
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?, ?, ?)`).run(finalId, type, category, title, description, credits, priceType, authorPublicKey, createdAt, repeatable ? 1 : 0, lat ?? null, lng ?? null, createdAt, searchKeywords);

        if (photos && photos.length > 0) {
            const insertPhoto = db.prepare(`INSERT INTO post_photos (post_id, photo_data, order_num) VALUES (?, ?, ?)`);
            photos.slice(0, 5).forEach((p, idx) => insertPhoto.run(finalId, p, idx));
        }
    })();

    const post = getPosts(db, { id: finalId }).find(p => p.id === finalId)!;
    broadcast({ type: 'new_post', post });
    return post;
}

export function removePost(broadcast: BroadcastFn, id: string, authorPublicKey: string): boolean {
    const pendingTx = db.prepare(`SELECT COUNT(*) as c FROM marketplace_transactions WHERE post_id = ? AND status = 'pending'`).get(id) as any;
    if (pendingTx.c > 0) throw new Error('This post has a deal in escrow — complete or cancel the deal before deleting it');

    let removed = false;
    db.transaction(() => {
        const result = db.prepare(`UPDATE posts SET active = 0, status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND author_pubkey = ?`).run(id, authorPublicKey);
        if (result.changes === 0) return;
        removed = true;
        db.prepare(`UPDATE marketplace_transactions SET status='rejected', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE post_id=? AND status='requested'`).run(id);
    })();
    if (!removed) return false;
    broadcast({ type: 'post_removed', id });
    return true;
}

export function updatePost(broadcast: BroadcastFn, id: string, authorPublicKey: string, updates: Partial<MarketplacePost>): MarketplacePost | null {
    if (updates.photos !== undefined && Array.isArray(updates.photos)) {
        const existingByOrder = new Map<number, string>(
            (db.prepare(`SELECT order_num, photo_data FROM post_photos WHERE post_id=?`).all(id) as any[])
                .map(r => [r.order_num, r.photo_data])
        );
        updates.photos = updates.photos.map(p => {
            const m = typeof p === 'string' ? p.match(/\/api\/marketplace\/posts\/([^/]+)\/photos\/(\d+)(?:\?.*)?$/) : null;
            if (m && m[1] === id) {
                const data = existingByOrder.get(Number(m[2]));
                if (data) return data;
            }
            return p;
        });
        validatePostPhotos(updates.photos);
    }

    const fields: string[] = [];
    const values: any[] = [];

    if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title); }
    if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
    if (updates.category !== undefined) { fields.push('category = ?'); values.push(updates.category); }
    if (updates.credits !== undefined) { fields.push('credits = ?'); values.push(updates.credits); }
    if (updates.priceType !== undefined) { fields.push('price_type = ?'); values.push(updates.priceType); }
    if (updates.repeatable !== undefined) { fields.push('repeatable = ?'); values.push(updates.repeatable ? 1 : 0); }
    if (updates.lat !== undefined) { fields.push('lat = ?'); values.push(updates.lat); }
    if (updates.lng !== undefined) { fields.push('lng = ?'); values.push(updates.lng); }

    const now = new Date().toISOString();
    fields.push('updated_at = ?');
    values.push(now);

    const existingPost = getPosts(db, { id }).find(p => p.id === id);
    if (!existingPost || existingPost.authorPublicKey !== authorPublicKey) return null;

    const newTitle = updates.title ?? existingPost.title;
    const newDesc = updates.description ?? existingPost.description;
    const newCat = updates.category ?? existingPost.category;
    const newKeywords = generateSearchKeywords(newTitle, newDesc, newCat);
    fields.push('search_keywords = ?');
    values.push(newKeywords);

    values.push(id, authorPublicKey);

    db.transaction(() => {
        db.prepare(`UPDATE posts SET ${fields.join(', ')} WHERE id = ? AND author_pubkey = ?`).run(...values);

        if (updates.photos !== undefined && Array.isArray(updates.photos)) {
            db.prepare(`DELETE FROM post_photos WHERE post_id = ?`).run(id);
            const insertPhoto = db.prepare(`INSERT INTO post_photos (post_id, photo_data, order_num, updated_at) VALUES (?, ?, ?, ?)`);
            updates.photos.slice(0, 5).forEach((p, idx) => insertPhoto.run(id, p, idx, now));
        }
    })();

    const updated = getPosts(db, { id }).find(p => p.id === id) || null;
    if (updated) broadcast({ type: 'post_updated', post: updated });
    return updated;
}

export function pausePost(broadcast: BroadcastFn, postId: string, authorPublicKey: string): boolean {
    const res = db.prepare(`UPDATE posts SET status = 'paused', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND author_pubkey = ? AND status = 'active'`).run(postId, authorPublicKey);
    if (res.changes > 0) {
        broadcast({ type: 'post_updated', id: postId });
        return true;
    }
    return false;
}

export function resumePost(broadcast: BroadcastFn, postId: string, authorPublicKey: string): boolean {
    const res = db.prepare(`UPDATE posts SET status = 'active', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND author_pubkey = ? AND status = 'paused'`).run(postId, authorPublicKey);
    if (res.changes > 0) {
        broadcast({ type: 'post_updated', id: postId });
        return true;
    }
    return false;
}

type TransferFn = (from: string, to: string, amount: number, memo: string, method?: 'direct' | 'escrow', isFeeExempt?: boolean) => any;

export function adminDeletePost(broadcast: BroadcastFn, postId: string, transferFn?: TransferFn): boolean {
    let deleted = false;
    db.transaction(() => {
        if (transferFn) {
            const pending = db.prepare("SELECT * FROM marketplace_transactions WHERE post_id=? AND status='pending'").all(postId) as any[];
            for (const tx of pending) {
                transferFn(`escrow_${tx.id}`, tx.buyer_pubkey, tx.credits, `Escrow refund for removed post`, 'escrow', true);
                db.prepare("UPDATE marketplace_transactions SET status='cancelled', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?").run(tx.id);
            }
        }
        db.prepare("UPDATE marketplace_transactions SET status='cancelled', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE post_id=? AND status='requested'").run(postId);
        const result = db.prepare("UPDATE posts SET active=0, status='cancelled', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?").run(postId);
        if (result.changes > 0) deleted = true;
    })();
    if (!deleted) return false;
    broadcast({ type: 'post_removed', id: postId });
    return true;
}

export function adminBulkDeletePosts(broadcast: BroadcastFn, postIds: string[], transferFn?: TransferFn): number {
    let deletedCount = 0;
    for (const postId of postIds) {
        if (adminDeletePost(broadcast, postId, transferFn)) {
            deletedCount++;
        }
    }
    return deletedCount;
}

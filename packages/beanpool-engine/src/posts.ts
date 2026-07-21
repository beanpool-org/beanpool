// Marketplace Posts pure database reads, search keyword generators, and offer covenant calculations.
//
// Extracted from apps/server/src/state-engine.ts.

import type Database from 'better-sqlite3';
import {
    OFFER_BANDS,
    getTier,
    grantedCreditForTier
} from '@beanpool/core';
import { getMemberTrustProfile } from './trust.js';

type Db = Database.Database;

export interface MarketplacePost {
    id: string;
    type: 'offer' | 'need';
    category: string;
    title: string;
    description: string;
    credits: number;
    priceType?: 'fixed' | 'hourly' | 'daily' | 'weekly' | 'monthly' | string;
    authorPublicKey: string;
    authorCallsign: string;
    createdAt: string;
    updatedAt?: string;
    active: boolean;
    status: 'active' | 'pending' | 'completed' | 'cancelled' | 'paused' | string;
    repeatable?: boolean;
    acceptedBy?: string;
    acceptedByCallsign?: string;
    acceptedAt?: string;
    pendingTransactionId?: string;
    completedAt?: string;
    lat?: number;
    lng?: number;
    photos?: string[];
    originNode?: string;
    authorEnergyCycled?: number;
    authorFoundingNeeded?: boolean;
    authorAvatarUrl?: string | null;
}

export interface PostFilter {
    id?: string;
    type?: string;
    category?: string;
    status?: string;
    offset?: number;
    limit?: number;
    updatedAfter?: string;
    query?: string;
    authorPubkey?: string;
    viewerPubkey?: string;
    sync?: boolean;
}

// Server-side photo limits. Clients resize to ≤800px JPEG at 0.7 quality.
export const MAX_POST_PHOTOS = 5;
export const MAX_PHOTO_BASE64_CHARS = 600_000;

export const CONTRIBUTION_REQUIRED_ERROR = 'CONTRIBUTION_REQUIRED: list at least one Offer before you can post Needs or accept Offers.';
export const COVENANT_REQUIRED_ERROR = 'COVENANT_REQUIRED: keep at least one active Offer posted to spend on community credit (a negative balance).';

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

export function validatePostPhotos(photos: string[] | undefined): void {
    if (photos === undefined) return;
    if (!Array.isArray(photos)) throw new Error('photos must be an array');
    if (photos.length > MAX_POST_PHOTOS) throw new Error(`A post can have at most ${MAX_POST_PHOTOS} photos`);
    for (const p of photos) {
        if (typeof p !== 'string' || !/^data:image\/(jpeg|jpg|png|webp);base64,/.test(p)) {
            throw new Error('Each photo must be a base64 data URL (JPEG, PNG, or WebP)');
        }
        if (p.length > MAX_PHOTO_BASE64_CHARS) {
            throw new Error('Photo too large — resize to 800px JPEG before uploading');
        }
    }
}

export function generateSearchKeywords(title: string, description: string, category: string, synonymMap?: Record<string, string[]>): string {
    const text = `${title} ${description}`.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    const words = text.split(/\s+/).filter(w => w.length > 2);
    const expanded = new Set<string>();
    expanded.add(category);

    if (!synonymMap) return [...expanded].join(' ');

    const lookup = (word: string): string[] | undefined => {
        if (synonymMap[word]) return synonymMap[word];
        if (word.endsWith('ies')) { const stem = word.slice(0, -3) + 'y'; if (synonymMap[stem]) return synonymMap[stem]; }
        if (word.endsWith('es')) { const stem = word.slice(0, -2); if (synonymMap[stem]) return synonymMap[stem]; }
        if (word.endsWith('s')) { const stem = word.slice(0, -1); if (synonymMap[stem]) return synonymMap[stem]; }
        if (word.endsWith('ing')) { const stem = word.slice(0, -3); if (synonymMap[stem]) return synonymMap[stem]; }
        if (word.endsWith('ed')) { const stem = word.slice(0, -2); if (synonymMap[stem]) return synonymMap[stem]; }
        return undefined;
    };

    for (const word of words) {
        const syns = lookup(word);
        if (syns) {
            for (const syn of syns) expanded.add(syn);
        }
    }
    const allWords = text.split(/\s+/);
    for (let i = 0; i < allWords.length - 1; i++) {
        const two = `${allWords[i]} ${allWords[i+1]}`;
        if (synonymMap[two]) {
            for (const syn of synonymMap[two]) expanded.add(syn);
        }
        if (i < allWords.length - 2) {
            const three = `${allWords[i]} ${allWords[i+1]} ${allWords[i+2]}`;
            if (synonymMap[three]) {
                for (const syn of synonymMap[three]) expanded.add(syn);
            }
        }
    }
    return [...expanded].join(' ');
}

export function rowToPost(db: Db, row: any, photosByPost: Map<string, any[]>): MarketplacePost {
    const postPhotos = photosByPost.get(row.id) || [];
    let trustPoints = 0;
    try {
        const trustProfile = getMemberTrustProfile(db, row.author_pubkey);
        trustPoints = trustProfile.earnedCredit;
    } catch (e) {
        trustPoints = row.author_energy_cycled ?? 0;
    }

    return {
        id: row.id,
        type: row.type,
        category: row.category,
        title: row.title,
        description: row.description,
        credits: row.credits,
        priceType: row.price_type || 'fixed',
        authorPublicKey: row.author_pubkey,
        authorCallsign: row.author_callsign,
        createdAt: row.created_at,
        updatedAt: row.updated_at || row.created_at,
        active: Boolean(row.active),
        status: row.status,
        repeatable: Boolean(row.repeatable),
        acceptedBy: row.accepted_by,
        acceptedByCallsign: row.accepted_callsign,
        acceptedAt: row.accepted_at,
        pendingTransactionId: row.pending_transaction_id,
        completedAt: row.completed_at,
        lat: row.lat,
        lng: row.lng,
        photos: postPhotos.sort((a: any, b: any) => a.order_num - b.order_num).map((p: any) => `/api/marketplace/posts/${row.id}/photos/${p.order_num}?v=${p.updated_at ? new Date(p.updated_at).getTime() : 0}`),
        originNode: row.origin_node,
        authorEnergyCycled: trustPoints,
        authorFoundingNeeded: (row.author_trade_count ?? 0) === 0 && (row.author_earned_credit ?? 0) === 0,
        authorAvatarUrl: row.author_avatar ?? null
    };
}

export function hasListedOffer(db: Db, publicKey: string): boolean {
    const row = db.prepare("SELECT 1 FROM posts WHERE author_pubkey = ? AND type = 'offer' LIMIT 1").get(publicKey);
    return !!row;
}

export function hasLiveOffer(db: Db, publicKey: string): boolean {
    const row = db.prepare("SELECT 1 FROM posts WHERE author_pubkey = ? AND type = 'offer' AND active = 1 AND status = 'active' LIMIT 1").get(publicKey);
    return !!row;
}

export function liveOfferCount(db: Db, publicKey: string): number {
    const row = db.prepare("SELECT COUNT(*) as c FROM posts WHERE author_pubkey = ? AND type = 'offer' AND active = 1 AND status = 'active'").get(publicKey) as any;
    return row?.c || 0;
}

export function usableFloor(db: Db, publicKey: string): number {
    const member = db.prepare("SELECT credit_frozen, vouch_credit, earned_credit, status, joined_at FROM members WHERE public_key = ?").get(publicKey) as any;
    if (!member || member.credit_frozen) return 0;

    const count = liveOfferCount(db, publicKey);
    const bandLimit = OFFER_BANDS[Math.min(count, OFFER_BANDS.length - 1)];

    const tier = getTier(member);
    const granted = grantedCreditForTier(tier.name);
    const earned = member.earned_credit || 0;
    const vouch = member.vouch_credit || 0;

    const totalCalculated = Math.max(vouch + earned, granted);
    return Math.min(bandLimit, totalCalculated);
}

export function getPosts(db: Db, filter?: PostFilter): MarketplacePost[] {
    let query = `
        SELECT p.*, m.callsign as author_callsign, m.avatar_url as author_avatar, a.callsign as accepted_callsign,
               COALESCE((SELECT SUM(amount) FROM transactions WHERE from_pubkey = m.public_key), 0) as author_energy_cycled,
               COALESCE(m.earned_credit, 0) as author_earned_credit,
               (
                 COALESCE((SELECT COUNT(*) FROM transactions t
                      WHERE (t.from_pubkey = m.public_key OR t.to_pubkey = m.public_key)
                        AND t.from_pubkey != t.to_pubkey
                        AND t.from_pubkey NOT LIKE 'escrow_%' AND t.to_pubkey NOT LIKE 'escrow_%'
                        AND t.from_pubkey != 'SYSTEM' AND t.to_pubkey != 'SYSTEM'), 0) +
                 COALESCE((SELECT COUNT(*) FROM marketplace_transactions mt
                      WHERE (mt.buyer_pubkey = m.public_key OR mt.seller_pubkey = m.public_key)
                        AND mt.status = 'completed'), 0)
               ) as author_trade_count
        FROM posts p
        LEFT JOIN members m ON p.author_pubkey = m.public_key
        LEFT JOIN members a ON p.accepted_by = a.public_key
        WHERE 1=1
    `;
    const params: any[] = [];

    if (!filter?.id && !filter?.updatedAfter && !filter?.sync) {
        const selfView = !!filter?.authorPubkey && filter.authorPubkey === filter.viewerPubkey;
        query += selfView
            ? " AND p.active = 1 AND p.status IN ('active', 'pending', 'paused')"
            : " AND p.active = 1 AND p.status IN ('active', 'pending')";
        if (!filter?.authorPubkey) {
            query += " AND p.author_pubkey NOT IN (SELECT public_key FROM member_preferences WHERE pref_key='holiday_mode' AND pref_value='true')";
        }
    } else if (filter?.updatedAfter || filter?.sync) {
        // Include completed/cancelled/deleted states for sync
    } else {
        query += " AND p.active = 1";
    }

    if (filter?.id) { query += " AND p.id = ?"; params.push(filter.id); }
    if (filter?.type && filter.type !== 'all') { query += " AND p.type = ?"; params.push(filter.type); }
    if (filter?.category && filter.category !== 'all') { query += " AND p.category = ?"; params.push(filter.category); }
    if (filter?.status) { query += " AND p.status = ?"; params.push(filter.status); }
    if (filter?.authorPubkey) { query += " AND p.author_pubkey = ?"; params.push(filter.authorPubkey); }

    if (filter?.query && filter.query.trim()) {
        const searchTerms = filter.query.trim().replace(/["']/g, '').split(/\s+/).filter(w => w.length > 0);
        if (searchTerms.length > 0) {
            const ftsQuery = searchTerms.map(t => `"${t}"*`).join(' OR ');
            query += ` AND p.rowid IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?)`;
            params.push(ftsQuery);
        }
    }

    if (filter?.updatedAfter) {
        query += " AND p.updated_at >= ?";
        params.push(filter.updatedAfter);
    }

    query += " ORDER BY p.updated_at DESC, p.created_at DESC";
    
    if (filter?.limit) {
        query += " LIMIT ? OFFSET ?";
        params.push(filter.limit, filter.offset || 0);
    }

    const rows = db.prepare(query).all(...params) as any[];
    const postIds = rows.map(r => r.id);

    const photos = selectInChunks(db, postIds, ph => `SELECT post_id, order_num, updated_at FROM post_photos WHERE post_id IN (${ph})`);

    const photosByPost = new Map<string, any[]>();
    for (const p of photos as any[]) {
        if (!photosByPost.has(p.post_id)) {
            photosByPost.set(p.post_id, []);
        }
        photosByPost.get(p.post_id)!.push(p);
    }

    return rows.map(r => rowToPost(db, r, photosByPost));
}

export function getActivePostCount(db: Db): number {
    const row = db.prepare("SELECT COUNT(*) as c FROM posts WHERE active = 1 AND status = 'active'").get() as any;
    return row?.c || 0;
}

export function getPostCount(db: Db, filter?: { type?: string; category?: string; status?: string; query?: string }): number {
    let query = "SELECT COUNT(*) as c FROM posts WHERE active = 1";
    const params: any[] = [];

    if (filter?.type && filter.type !== 'all') { query += " AND type = ?"; params.push(filter.type); }
    if (filter?.category && filter.category !== 'all') { query += " AND category = ?"; params.push(filter.category); }
    if (filter?.status) { query += " AND status = ?"; params.push(filter.status); }

    if (filter?.query && filter.query.trim()) {
        const searchTerms = filter.query.trim().replace(/["']/g, '').split(/\s+/).filter(w => w.length > 0);
        if (searchTerms.length > 0) {
            const ftsQuery = searchTerms.map(t => `"${t}"*`).join(' OR ');
            query += ` AND rowid IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?)`;
            params.push(ftsQuery);
        }
    }

    const row = db.prepare(query).get(...params) as any;
    return row?.c || 0;
}

// Ratings and Friends pure database queries.
//
// Extracted from apps/server/src/state-engine.ts so both the node server
// and the fleet manager can run identical queries and social graph logic.
//
// Pure reads (parameterized on better-sqlite3 Database handle).

import type Database from 'better-sqlite3';
import { avatarUrlOf } from '@beanpool/core';

type Db = Database.Database;

export interface Rating {
    id: string;
    targetPubkey: string;
    raterPubkey: string;
    stars: number;
    comment: string;
    role: 'provider' | 'receiver';
    transactionId: string;
    createdAt: string;
    rater_callsign?: string;
    rater_avatar?: string | null;
    target_callsign?: string;
    target_avatar?: string | null;
}

export interface FriendEntry {
    publicKey: string;
    callsign: string;
    addedAt: string;
    isGuardian: boolean;
    avatarUrl?: string | null;
}

export interface AverageRatingResult {
    average: number;
    count: number;
    /** How many different members wrote the reviews ("12 reviews from 9 members"), against one member's many. */
    raters: number;
    asProvider: { average: number; count: number };
    asReceiver: { average: number; count: number };
}

export function getRatings(db: Db, targetPubkey: string): any[] {
    const rows = db.prepare(`
        SELECT r.*, m.callsign as rater_callsign, m.avatar_ref as rater_avatar
        FROM ratings r
        LEFT JOIN members m ON r.rater_pubkey = m.public_key
        WHERE r.target_pubkey=?
        ORDER BY r.created_at DESC, r.rowid DESC
    `).all(targetPubkey) as any[];

    return rows.map(r => ({
        id: r.id,
        targetPubkey: r.target_pubkey,
        raterPubkey: r.rater_pubkey,
        stars: r.stars,
        comment: r.comment,
        role: r.role,
        transactionId: r.transaction_id,
        createdAt: r.created_at,
        rater_callsign: r.rater_callsign,
        rater_avatar: avatarUrlOf(r.rater_pubkey, r.rater_avatar)
    }));
}

export function getRatingsGiven(db: Db, raterPubkey: string): Rating[] {
    const rows = db.prepare(`
        SELECT r.id, r.target_pubkey, r.rater_pubkey, r.stars, r.comment, r.role, r.transaction_id, r.created_at,
               m.callsign as target_callsign, m.avatar_ref as target_avatar
        FROM ratings r
        LEFT JOIN members m ON r.target_pubkey = m.public_key
        WHERE r.rater_pubkey=?
        ORDER BY r.created_at DESC
    `).all(raterPubkey) as any[];

    return rows.map(r => ({
        id: r.id,
        targetPubkey: r.target_pubkey,
        raterPubkey: r.rater_pubkey,
        stars: r.stars,
        comment: r.comment,
        role: r.role,
        transactionId: r.transaction_id,
        createdAt: r.created_at,
        target_callsign: r.target_callsign,
        target_avatar: avatarUrlOf(r.target_pubkey, r.target_avatar)
    }));
}

export function getAverageRating(db: Db, targetPubkey: string): AverageRatingResult {
    const all = db.prepare("SELECT AVG(stars) as avg, COUNT(*) as cnt, COUNT(DISTINCT rater_pubkey) as raters FROM ratings WHERE target_pubkey=?").get(targetPubkey) as any;
    const prov = db.prepare("SELECT AVG(stars) as avg, COUNT(*) as cnt FROM ratings WHERE target_pubkey=? AND role='provider'").get(targetPubkey) as any;
    const recv = db.prepare("SELECT AVG(stars) as avg, COUNT(*) as cnt FROM ratings WHERE target_pubkey=? AND role='receiver'").get(targetPubkey) as any;

    const round = (val: number) => Math.round((val || 0) * 10) / 10;
    return {
        average: round(all.avg), count: all.cnt || 0, raters: all.raters || 0,
        asProvider: { average: round(prov.avg), count: prov.cnt || 0 },
        asReceiver: { average: round(recv.avg), count: recv.cnt || 0 }
    };
}

/** A review as a member who is neither party reads it: the stars, the words, which side the rated member was on, and the
 *  day (not the second). */
export interface RatingForThirdMember {
    stars: number;
    comment: string;
    role: 'provider' | 'receiver';
    createdAt: string;
}

/** The day of a review, at noon UTC: no reader's time zone moves it into another day or month. */
function reviewDay(createdAt: unknown): string {
    return typeof createdAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(createdAt) ? `${createdAt.slice(0, 10)}T12:00:00.000Z` : '';
}

/**
 * A member's received reviews (getRatings) as `reader` may read them (Marty, 2026-10-14, decision A: a review is public
 * opinion about the RATED member; the trade behind it stays the two parties'). The rated member reads their list in
 * full: they know these trades and may need to answer one. A rater reads their own review in full, marked `mine`. To
 * anyone else a review names nobody and no deal: no rater key, name or picture (its URL carries the key), no deal id,
 * no review id, and the day rather than the second, so a member's reviews cannot be read as a list of who traded with
 * whom and when. `reader` is the verified signer only, never a key from the request.
 */
export function ratingsForReader(rows: any[], reader: string, targetPubkey: string): any[] {
    if (reader === targetPubkey) return rows;
    return rows.map((r): any => r.raterPubkey === reader
        ? { ...r, mine: true }
        : { stars: r.stars, comment: r.comment, role: r.role, createdAt: reviewDay(r.createdAt) } satisfies RatingForThirdMember);
}

export function getFriends(db: Db, pubkey: string): FriendEntry[] {
    const rows = db.prepare(`
        SELECT f.friend_pubkey, m.callsign, f.added_at, m.avatar_ref
        FROM friends f 
        JOIN members m ON f.friend_pubkey = m.public_key 
        WHERE f.owner_pubkey=?
    `).all(pubkey) as any[];

    return rows.map(r => ({
        publicKey: r.friend_pubkey,
        callsign: r.callsign,
        addedAt: r.added_at,
        isGuardian: false,
        avatarUrl: avatarUrlOf(r.friend_pubkey, r.avatar_ref),
    }));
}

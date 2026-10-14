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
 *  month (not the day or the second). */
export interface RatingForThirdMember {
    stars: number;
    comment: string;
    role: 'provider' | 'receiver';
    createdAt: string;
}

/** The UTC month of a stored time ("YYYY-MM"), or '' for anything else. */
function utcMonth(createdAt: unknown): string {
    return typeof createdAt === 'string' && /^\d{4}-\d{2}/.test(createdAt) ? createdAt.slice(0, 7) : '';
}

/**
 * The month of a review, as the 1st at noon UTC ("YYYY-MM-01T12:00:00Z"), which is the 1st or the 2nd of that month in
 * every time zone from UTC-12 to UTC+14, so no reader's zone moves it into another month. Both apps show the month and
 * year only. The month is the UTC month of the exact time: a review written on the morning of the 1st east of UTC (before
 * 11:00 in Melbourne in summer, before 13:00 in New Zealand) is in the month before in UTC, and every member but its two
 * parties sees that month (#1914 review, findings 3 and 5, 2026-10-14: accepted).
 */
function reviewMonth(createdAt: unknown): string {
    const month = utcMonth(createdAt);
    return month ? `${month}-01T12:00:00Z` : '';
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The order a non-party reads a list in: month (newest first), then stars (most first), words, side, and the reader's
 *  own review before an identical one. Nothing in it follows the exact time, so a rater whose own review carries its
 *  exact time can't bracket when the others were written. */
function byMonthThenWords(a: any, b: any): number {
    return compare(utcMonth(b.createdAt), utcMonth(a.createdAt))
        || (Number(b.stars) || 0) - (Number(a.stars) || 0)
        || compare(String(a.comment ?? ''), String(b.comment ?? ''))
        || compare(String(a.role ?? ''), String(b.role ?? ''))
        || (b.mine ? 1 : 0) - (a.mine ? 1 : 0);
}

/**
 * A member's received reviews (getRatings) as `reader` may read them (Marty, 2026-10-14, decision A: a review is public
 * opinion about the RATED member; the trade behind it stays the two parties'). The rated member reads their list in
 * full: they know these trades and may need to answer one. A rater reads their own review in full, marked `mine`. To
 * anyone else a review names nobody and no deal: no rater key, name or picture (its URL carries the key), no deal id,
 * no review id, and the month rather than the day or the second, in an order that doesn't follow the time
 * (byMonthThenWords), so a member's reviews cannot be read as a list of who traded with whom and when, nor paired with
 * the review written back on the same day. `reader` is the verified signer only, never a key from the request.
 */
export function ratingsForReader(rows: any[], reader: string, targetPubkey: string): any[] {
    if (reader === targetPubkey) return rows;
    return rows.map((r): any => r.raterPubkey === reader
        ? { ...r, mine: true }
        : { stars: r.stars, comment: r.comment, role: r.role, createdAt: reviewMonth(r.createdAt) } satisfies RatingForThirdMember)
        .sort(byMonthThenWords);
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

// Ratings and Friends pure database queries.
//
// Extracted from apps/server/src/state-engine.ts so both the node server
// and the fleet manager can run identical queries and social graph logic.
//
// Pure reads (parameterized on better-sqlite3 Database handle).

import type Database from 'better-sqlite3';

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
}

export interface AverageRatingResult {
    average: number;
    count: number;
    asProvider: { average: number; count: number };
    asReceiver: { average: number; count: number };
}

export function getRatings(db: Db, targetPubkey: string): any[] {
    const rows = db.prepare(`
        SELECT r.*, m.callsign as rater_callsign, m.avatar_url as rater_avatar
        FROM ratings r
        LEFT JOIN members m ON r.rater_pubkey = m.public_key
        WHERE r.target_pubkey=?
        ORDER BY r.created_at DESC
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
        rater_avatar: r.rater_avatar
    }));
}

export function getRatingsGiven(db: Db, raterPubkey: string): Rating[] {
    const rows = db.prepare(`
        SELECT r.id, r.target_pubkey, r.rater_pubkey, r.stars, r.comment, r.role, r.transaction_id, r.created_at,
               m.callsign as target_callsign, m.avatar_url as target_avatar
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
        target_avatar: r.target_avatar
    }));
}

export function getAverageRating(db: Db, targetPubkey: string): AverageRatingResult {
    const all = db.prepare("SELECT AVG(stars) as avg, COUNT(*) as cnt FROM ratings WHERE target_pubkey=?").get(targetPubkey) as any;
    const prov = db.prepare("SELECT AVG(stars) as avg, COUNT(*) as cnt FROM ratings WHERE target_pubkey=? AND role='provider'").get(targetPubkey) as any;
    const recv = db.prepare("SELECT AVG(stars) as avg, COUNT(*) as cnt FROM ratings WHERE target_pubkey=? AND role='receiver'").get(targetPubkey) as any;

    const round = (val: number) => Math.round((val || 0) * 10) / 10;
    return {
        average: round(all.avg), count: all.cnt || 0,
        asProvider: { average: round(prov.avg), count: prov.cnt || 0 },
        asReceiver: { average: round(recv.avg), count: recv.cnt || 0 }
    };
}

export function getFriends(db: Db, pubkey: string): FriendEntry[] {
    const rows = db.prepare(`
        SELECT f.friend_pubkey, m.callsign, f.added_at, f.is_guardian 
        FROM friends f 
        JOIN members m ON f.friend_pubkey = m.public_key 
        WHERE f.owner_pubkey=?
    `).all(pubkey) as any[];

    return rows.map(r => ({
        publicKey: r.friend_pubkey,
        callsign: r.callsign,
        addedAt: r.added_at,
        isGuardian: Boolean(r.is_guardian)
    }));
}

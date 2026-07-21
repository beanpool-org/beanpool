// Stateful mutations for ratings, reviews, and friend/guardian relationships.
//
// Bridges the database storage layer with server singletons and tombstone logs.

import { db, writeTombstone } from '../db/db.js';
import crypto from 'node:crypto';
import {
    getMember,
    getFriends,
    type Rating,
    type FriendEntry
} from '@beanpool/engine';

function assertMemberActive(publicKey: string): void {
    if (publicKey.startsWith('escrow_') || publicKey.startsWith('project_') || publicKey === 'COMMONS_POOL' || publicKey === 'SYSTEM' || publicKey === 'genesis') return;
    if (!getMember(db, publicKey)) throw new Error('Member not found');
}

/**
 * Inserts or updates a review rating for a completed marketplace transaction.
 */
export function addRating(
    raterPubkey: string,
    targetPubkey: string,
    stars: number,
    comment: string,
    transactionId: string
): Rating | null {
    assertMemberActive(raterPubkey);
    if (!getMember(db, raterPubkey) || !getMember(db, targetPubkey) || raterPubkey === targetPubkey || stars < 1 || stars > 5) return null;

    const tx = db.prepare("SELECT * FROM marketplace_transactions WHERE id=? AND status='completed'").get(transactionId) as any;
    if (!tx || (tx.buyer_pubkey !== raterPubkey && tx.seller_pubkey !== raterPubkey) || (tx.buyer_pubkey !== targetPubkey && tx.seller_pubkey !== targetPubkey)) return null;

    const post = db.prepare("SELECT type FROM posts WHERE id=?").get(tx.post_id) as any;
    const isOffer = post?.type === 'offer';
    const targetRole: 'provider' | 'receiver' = (tx.seller_pubkey === targetPubkey) 
        ? (isOffer ? 'provider' : 'receiver') 
        : (isOffer ? 'receiver' : 'provider');

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    
    // UPSERT pattern
    const existing = db.prepare("SELECT * FROM ratings WHERE transaction_id=? AND rater_pubkey=?").get(transactionId, raterPubkey) as any;
    if (existing) {
        db.prepare("UPDATE ratings SET stars=?, comment=?, created_at=? WHERE id=?").run(stars, comment.slice(0, 200), createdAt, existing.id);
        return { ...existing, stars, comment, createdAt };
    }

    db.prepare(`INSERT INTO ratings (id, target_pubkey, rater_pubkey, stars, comment, role, transaction_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, targetPubkey, raterPubkey, stars, comment.slice(0, 200), targetRole, transactionId, createdAt);
    return { id, targetPubkey, raterPubkey, stars, comment: comment.slice(0, 200), role: targetRole, transactionId, createdAt };
}

/**
 * Add a connection between two members.
 */
export function addFriend(ownerPubkey: string, friendPubkey: string): FriendEntry | null {
    if (!getMember(db, ownerPubkey) || !getMember(db, friendPubkey) || ownerPubkey === friendPubkey) return null;
    
    const exists = db.prepare("SELECT * FROM friends WHERE owner_pubkey=? AND friend_pubkey=?").get(ownerPubkey, friendPubkey);
    if (!exists) {
        db.prepare("INSERT INTO friends (owner_pubkey, friend_pubkey, added_at) VALUES (?, ?, ?)").run(ownerPubkey, friendPubkey, new Date().toISOString());
    }
    return getFriends(db, ownerPubkey).find(f => f.publicKey === friendPubkey) || null;
}

/**
 * Removes a connection, logging a synchronization tombstone.
 */
export function removeFriend(ownerPubkey: string, friendPubkey: string): boolean {
    const res = db.prepare("DELETE FROM friends WHERE owner_pubkey=? AND friend_pubkey=?").run(ownerPubkey, friendPubkey);
    if (res.changes > 0) {
        writeTombstone('friends', `${ownerPubkey}|${friendPubkey}`);
    }
    return res.changes > 0;
}

/**
 * Promotes a connection to guardian role.
 */
export function setGuardian(ownerPubkey: string, friendPubkey: string, isGuardian: boolean): boolean {
    if (!getMember(db, ownerPubkey) || !getMember(db, friendPubkey) || ownerPubkey === friendPubkey) return false;
    
    const exists = db.prepare("SELECT * FROM friends WHERE owner_pubkey=? AND friend_pubkey=?").get(ownerPubkey, friendPubkey);
    if (!exists) {
        db.prepare("INSERT INTO friends (owner_pubkey, friend_pubkey, added_at) VALUES (?, ?, ?)").run(ownerPubkey, friendPubkey, new Date().toISOString());
    }

    const res = db.prepare("UPDATE friends SET is_guardian=? WHERE owner_pubkey=? AND friend_pubkey=?").run(isGuardian ? 1 : 0, ownerPubkey, friendPubkey);
    return res.changes > 0;
}

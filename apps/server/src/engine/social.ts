// Stateful mutations for ratings, reviews, and friend relationships.
//
// Bridges the database storage layer with server singletons and tombstone logs.

import { isSyntheticAccount } from '@beanpool/core';
import { db, writeTombstone } from '../db/db.js';
import { recordActivity } from '../db/activity-feed-db.js';
import crypto from 'node:crypto';
import { hasBlocked } from './member-blocks.js';
import { assertMayAddFriendToday } from './writer-bounds.js';
import { addedYouSince } from './friends-added-you.js';
import {
    getMember,
    isNodeMember,
    isVisitorKey,
    getFriends,
    type Rating,
    type FriendEntry
} from '@beanpool/engine';

/** The actor has a member's row here. A visitor's row is refused in the same words as a key with no row. */
function assertMemberActive(publicKey: string): void {
    if (isSyntheticAccount(publicKey)) return;
    if (!getMember(db, publicKey) || isVisitorKey(db, publicKey)) throw new Error('Member not found');
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
    // A member of this node, not just a row: a pruned account, or a re-keyed phone's old key, rates nobody.
    if (!isNodeMember(db, raterPubkey) || !getMember(db, targetPubkey) || raterPubkey === targetPubkey || stars < 1 || stars > 5) return null;

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
    try {
        recordActivity('rating_given', raterPubkey, targetPubkey, { stars, comment: comment.slice(0, 100) });
    } catch (e) {
        console.warn('[ActivityFeed] Could not record rating_given:', e);
    }
    return { id, targetPubkey, raterPubkey, stars, comment: comment.slice(0, 200), role: targetRole, transactionId, createdAt };
}

/** An add this node refuses, in words for the member who asked. */
export class FriendRefusal extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FriendRefusal';
    }
}
export const FRIEND_BLOCKED_ERROR = 'You have blocked them. Unblock them first to add them.';

/**
 * Add a connection between two members. A visitor's row adds nobody, as a key with no row adds nobody.
 *
 * The person added is told, on their People tab (engine/friends-added-you.ts), so an add is refused, never dropped:
 * - to someone the owner blocked (member_blocks, engine/member-blocks.ts): THROWS FriendRefusal, saying so;
 * - past WRITER_LIMITS.friendAddsPerDay new adds in a day: THROWS WriterLimitError (engine/writer-bounds.ts).
 * An add to someone who blocked the owner is taken as any add is (and counts against the day's adds): refusing it would
 * tell the blocked member of the block, which a block never does (engine/member-blocks.ts). The person who blocked them
 * is never told either: engine/friends-added-you.ts leaves out an adder they blocked.
 * Adding someone already added is no new add: it answers as before and counts nothing.
 */
export function addFriend(ownerPubkey: string, friendPubkey: string): FriendEntry | null {
    if (!getMember(db, ownerPubkey) || isVisitorKey(db, ownerPubkey) || !getMember(db, friendPubkey) || ownerPubkey === friendPubkey) return null;
    if (hasBlocked(ownerPubkey, friendPubkey)) throw new FriendRefusal(FRIEND_BLOCKED_ERROR);

    const exists = db.prepare("SELECT * FROM friends WHERE owner_pubkey=? AND friend_pubkey=?").get(ownerPubkey, friendPubkey);
    if (!exists) {
        assertMayAddFriendToday(ownerPubkey);
        // Stamped before the row, so this add is after it and is news to the person added.
        addedYouSince();
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

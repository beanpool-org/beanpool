// Stateful deal workflows & escrow ledger transactions.
//
// Extracted from apps/server/src/state-engine.ts.

import { db } from '../db/db.js';
import crypto from 'node:crypto';
import {
    getMember,
    getPosts,
    hasListedOffer,
    getMarketplaceTransaction,
    CONTRIBUTION_REQUIRED_ERROR,
    type MarketplaceTransaction
} from '@beanpool/engine';

type BroadcastFn = (event: any, recipients?: string[]) => void;
type TransferFn = (from: string, to: string, amount: number, memo: string, method?: 'direct' | 'escrow', isFeeExempt?: boolean) => any;
type EnsureConvFn = (postId: string, buyerPubkey: string, sellerPubkey: string) => string;
type SystemMsgFn = (postId: string, type: any, payload: any, senderPubkey: string, recipientPubkey: string) => any;
type PushFn = (targetPubkeys: string[], actorPubkey: string, title: string, body: string, data: Record<string, any>, categoryId: 'chat' | 'marketplace' | 'escrow') => void;

export interface EscrowCallbacks {
    broadcast: BroadcastFn;
    transfer: TransferFn;
    ensureTransactionConversation: EnsureConvFn;
    injectSystemMessage: SystemMsgFn;
    dispatchPushNotification: PushFn;
    getBalance: (publicKey: string) => any;
    floorLockedError: (publicKey: string, postBalance: number) => Error;
    SystemMessageType: any;
}

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

export function requestPost(
    cb: EscrowCallbacks,
    postId: string,
    requesterPublicKey: string,
    hours?: number
): MarketplaceTransaction {
    assertMemberActive(requesterPublicKey);
    assertProfileComplete(requesterPublicKey);
    assertNotOnHoliday(requesterPublicKey);
    const post = db.prepare(`SELECT * FROM posts WHERE id=?`).get(postId) as any;
    if (!post) throw new Error('Post not found');
    if (post.status !== 'active') throw new Error('Post is not active');
    if (post.author_pubkey === requesterPublicKey) throw new Error('You cannot request your own post');
    if (isOnHoliday(post.author_pubkey)) throw new Error('This member is away (holiday mode) and not trading right now.');

    const isOffer = post.type === 'offer';
    if (isOffer) {
        if (!hasListedOffer(db, requesterPublicKey)) throw new Error(CONTRIBUTION_REQUIRED_ERROR);
    }

    if (post.price_type !== 'fixed' && (typeof hours !== 'number' || hours <= 0)) {
        throw new Error(`Must provide a valid quantity for a ${post.price_type} post`);
    }

    const requester = getMember(db, requesterPublicKey);
    const author = getMember(db, post.author_pubkey);
    const finalCredits = post.price_type !== 'fixed' ? post.credits * hours! : post.credits;

    const payerPubkey = isOffer ? requesterPublicKey : post.author_pubkey;
    const { balance, floor, usableFloor: uFloor } = cb.getBalance(payerPubkey);
    if (balance - finalCredits < floor) throw new Error('Insufficient balance to request this post.');
    if (balance - finalCredits < uFloor) throw cb.floorLockedError(payerPubkey, balance - finalCredits);

    const buyerPublicKey = isOffer ? requesterPublicKey : post.author_pubkey;
    const sellerPublicKey = isOffer ? post.author_pubkey : requesterPublicKey;
    const buyerCallsign = isOffer ? (requester?.callsign || 'Anonymous') : (author?.callsign || 'Anonymous');
    const sellerCallsign = isOffer ? (author?.callsign || 'Anonymous') : (requester?.callsign || 'Anonymous');

    const existingReq = db.prepare(`SELECT * FROM marketplace_transactions WHERE post_id=? AND buyer_pubkey=? AND seller_pubkey=? AND status='requested'`).get(postId, buyerPublicKey, sellerPublicKey) as any;
    if (existingReq) {
        const existingTx = getMarketplaceTransaction(db, existingReq.id);
        if (existingTx) return existingTx;
    }

    const tx: MarketplaceTransaction = {
        id: crypto.randomUUID(),
        postId: post.id,
        postTitle: post.title,
        buyerPublicKey,
        buyerCallsign,
        sellerPublicKey,
        sellerCallsign,
        credits: finalCredits,
        hours: post.price_type !== 'fixed' ? hours : undefined,
        status: 'requested',
        createdAt: new Date().toISOString()
    };

    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, hours, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'requested', ?)`).run(tx.id, tx.postId, tx.buyerPublicKey, tx.sellerPublicKey, tx.credits, tx.hours ?? null, tx.createdAt);

    cb.broadcast({ type: 'transaction_requested', transaction: tx });

    cb.dispatchPushNotification(
        [post.author_pubkey],
        requesterPublicKey,
        isOffer ? '📩 New Request' : '🤝 Help Offered',
        `${requester?.callsign || 'A member'} ${isOffer ? 'requested' : 'offered to help with'} "${post.title}"`,
        { screen: 'post', postId: post.id },
        'marketplace'
    );

    return tx;
}

export function approvePostRequest(
    cb: EscrowCallbacks,
    transactionId: string,
    authorPublicKey: string
): MarketplaceTransaction | null {
    const row = db.prepare("SELECT * FROM marketplace_transactions WHERE id=? AND status='requested'").get(transactionId) as any;
    if (!row) return null;

    const post = db.prepare(`SELECT * FROM posts WHERE id=?`).get(row.post_id) as any;
    if (!post) return null;

    const isOffer = post.type === 'offer';
    const expectedAuthorRole = isOffer ? row.seller_pubkey : row.buyer_pubkey;
    if (expectedAuthorRole !== authorPublicKey) return null;

    assertMemberActive(authorPublicKey);
    assertNotOnHoliday(authorPublicKey);
    if (isOnHoliday(row.buyer_pubkey) || isOnHoliday(row.seller_pubkey)) {
        throw new Error('Trading is paused while a member is in holiday mode.');
    }

    const { balance, floor, usableFloor: uFloor } = cb.getBalance(row.buyer_pubkey);
    if (balance - row.credits < floor) throw new Error('Buyer has insufficient balance to cover escrow');
    if (balance - row.credits < uFloor) throw cb.floorLockedError(row.buyer_pubkey, balance - row.credits);

    cb.ensureTransactionConversation(row.post_id, row.buyer_pubkey, row.seller_pubkey);

    db.transaction(() => {
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(`escrow_${row.id}`);

        const escrowResult = cb.transfer(row.buyer_pubkey, `escrow_${row.id}`, row.credits, `Escrow hold for approved deal ${row.post_id}`, 'escrow', true);
        if (!escrowResult) throw new Error('Failed to lock funds in escrow');

        db.prepare(`UPDATE marketplace_transactions SET status='pending' WHERE id=?`).run(transactionId);

        if (!post.repeatable) {
            const updated = db.prepare(`UPDATE posts SET status='pending', accepted_by=?, accepted_at=?, pending_transaction_id=?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=? AND status='active'`).run(row.buyer_pubkey, new Date().toISOString(), row.id, post.id);
            if (updated.changes === 0) throw new Error('Post is no longer available');

            db.prepare(`UPDATE marketplace_transactions SET status='rejected', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE post_id=? AND id!=? AND status='requested'`)
              .run(post.id, row.id);
        }
    })();

    const tx = getMarketplaceTransaction(db, transactionId)!;
    cb.broadcast({ type: 'post_accepted', postId: post.id, transaction: tx });

    try {
        cb.injectSystemMessage(post.id, cb.SystemMessageType.ESCROW_FUNDED, {
            amount: row.credits,
            postId: post.id,
            actorPubkey: authorPublicKey,
            buyerPubkey: row.buyer_pubkey,
            sellerPubkey: row.seller_pubkey
        }, row.buyer_pubkey, row.seller_pubkey);
    } catch (e) {
        console.warn('[Marketplace] ESCROW_FUNDED system message failed:', e);
    }

    const requesterPubkey = isOffer ? row.buyer_pubkey : row.seller_pubkey;
    cb.dispatchPushNotification(
        [requesterPubkey],
        authorPublicKey,
        '✅ Request Approved',
        `Your request for "${post.title}" was approved!`,
        { screen: 'post', postId: row.post_id },
        'marketplace'
    );

    return tx;
}

export function rejectPostRequest(
    cb: EscrowCallbacks,
    transactionId: string,
    authorPublicKey: string
): MarketplaceTransaction | null {
    const row = db.prepare("SELECT * FROM marketplace_transactions WHERE id=? AND status='requested'").get(transactionId) as any;
    if (!row) return null;

    const post = db.prepare(`SELECT * FROM posts WHERE id=?`).get(row.post_id) as any;
    if (!post) return null;

    const isOffer = post.type === 'offer';
    const expectedAuthorRole = isOffer ? row.seller_pubkey : row.buyer_pubkey;
    if (expectedAuthorRole !== authorPublicKey) return null;

    db.prepare(`UPDATE marketplace_transactions SET status='rejected', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`).run(transactionId);
    
    const tx = getMarketplaceTransaction(db, transactionId)!;
    cb.broadcast({ type: 'transaction_rejected', transaction: tx });

    const requesterPubkey = isOffer ? row.buyer_pubkey : row.seller_pubkey;
    cb.dispatchPushNotification(
        [requesterPubkey],
        authorPublicKey,
        '❌ Request Declined',
        `Your request for "${post.title}" was declined`,
        { screen: 'post', postId: row.post_id },
        'marketplace'
    );

    return tx;
}

export function cancelPostRequest(
    cb: EscrowCallbacks,
    transactionId: string,
    requesterPublicKey: string
): MarketplaceTransaction | null {
    const row = db.prepare("SELECT * FROM marketplace_transactions WHERE id=? AND status='requested'").get(transactionId) as any;
    if (!row) return null;

    const post = db.prepare(`SELECT * FROM posts WHERE id=?`).get(row.post_id) as any;
    if (!post) return null;

    const isOffer = post.type === 'offer';
    const expectedRequesterRole = isOffer ? row.buyer_pubkey : row.seller_pubkey;
    if (expectedRequesterRole !== requesterPublicKey) return null;

    db.prepare(`UPDATE marketplace_transactions SET status='cancelled', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`).run(transactionId);
    
    const tx = getMarketplaceTransaction(db, transactionId)!;
    cb.broadcast({ type: 'transaction_cancelled', transaction: tx });
    return tx;
}

export function acceptPost(
    cb: EscrowCallbacks,
    postId: string,
    buyerPublicKey: string,
    hours?: number
): MarketplaceTransaction {
    assertMemberActive(buyerPublicKey);
    assertNotOnHoliday(buyerPublicKey);
    const post = getPosts(db, { id: postId, status: 'active' })[0];
    if (!post) throw new Error('Post not found or not active');
    if (post.authorPublicKey === buyerPublicKey) throw new Error('Cannot accept your own post');
    if (isOnHoliday(post.authorPublicKey)) throw new Error('This member is away (holiday mode) and not trading right now.');

    if (post.type !== 'offer') {
        throw new Error('Only Offers can be 1-step accepted');
    }

    if (!hasListedOffer(db, buyerPublicKey)) throw new Error(CONTRIBUTION_REQUIRED_ERROR);

    if (post.priceType !== 'fixed' && (typeof hours !== 'number' || hours <= 0)) {
        throw new Error(`Must provide a valid quantity for a ${post.priceType} post`);
    }

    const buyer = getMember(db, buyerPublicKey);
    const finalCredits = post.priceType !== 'fixed' ? post.credits * hours! : post.credits;

    const { balance, floor, usableFloor: uFloor } = cb.getBalance(buyerPublicKey);
    if (balance - finalCredits < floor) throw new Error('Insufficient balance to accept this offer');
    if (balance - finalCredits < uFloor) throw cb.floorLockedError(buyerPublicKey, balance - finalCredits);

    const tx: MarketplaceTransaction = {
        id: crypto.randomUUID(),
        postId: post.id,
        postTitle: post.title,
        buyerPublicKey,
        buyerCallsign: buyer?.callsign || 'Anonymous',
        sellerPublicKey: post.authorPublicKey,
        sellerCallsign: post.authorCallsign,
        credits: finalCredits,
        hours: post.priceType !== 'fixed' ? hours : undefined,
        status: 'pending',
        createdAt: new Date().toISOString()
    };

    cb.ensureTransactionConversation(post.id, buyerPublicKey, post.authorPublicKey);

    db.transaction(() => {
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(`escrow_${tx.id}`);

        const escrowResult = cb.transfer(buyerPublicKey, `escrow_${tx.id}`, finalCredits, `Escrow hold for offer ${post.id}`, 'escrow', true);
        if (!escrowResult) throw new Error('Failed to lock funds in escrow — insufficient balance or ledger error');

        db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, hours, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`).run(tx.id, tx.postId, tx.buyerPublicKey, tx.sellerPublicKey, tx.credits, tx.hours ?? null, tx.createdAt);
        
        if (!post.repeatable) {
            const updated = db.prepare(`UPDATE posts SET status='pending', accepted_by=?, accepted_at=?, pending_transaction_id=?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=? AND status='active'`).run(buyerPublicKey, tx.createdAt, tx.id, post.id);
            if (updated.changes === 0) throw new Error('Post is no longer available — it is already committed to another deal');

            db.prepare(`UPDATE marketplace_transactions SET status='rejected', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE post_id=? AND id!=? AND status='requested'`)
              .run(post.id, tx.id);
        }
    })();

    cb.broadcast({ type: 'post_accepted', postId: post.id, transaction: tx });

    try {
        cb.injectSystemMessage(post.id, cb.SystemMessageType.ESCROW_FUNDED, {
            amount: finalCredits,
            postId: post.id,
            actorPubkey: buyerPublicKey,
            buyerPubkey: buyerPublicKey,
            sellerPubkey: post.authorPublicKey
        }, buyerPublicKey, post.authorPublicKey);
    } catch (e) {
        console.warn('[Marketplace] ESCROW_FUNDED system message failed:', e);
    }

    cb.dispatchPushNotification(
        [post.authorPublicKey],
        buyerPublicKey,
        '🛒 Offer Accepted',
        `${buyer?.callsign || 'A member'} accepted "${post.title}" — ${finalCredits} Beans are now in escrow.`,
        { screen: 'post', postId: post.id },
        'marketplace'
    );

    return tx;
}

export function completePostTransaction(
    cb: EscrowCallbacks,
    transactionId: string,
    confirmerPublicKey: string,
    finalHours?: number
): MarketplaceTransaction & { alreadyCompleted?: boolean } | null {
    const row = db.prepare("SELECT * FROM marketplace_transactions WHERE id=? AND status='pending'").get(transactionId) as any;
    
    if (!row) {
        const completedRow = db.prepare("SELECT * FROM marketplace_transactions WHERE id=? AND status='completed'").get(transactionId) as any;
        if (completedRow && completedRow.buyer_pubkey === confirmerPublicKey) {
            const existing = getMarketplaceTransaction(db, transactionId);
            if (existing) return { ...existing, alreadyCompleted: true };
        }
        return null;
    }
    
    if (row.buyer_pubkey !== confirmerPublicKey) return null;

    const post = db.prepare(`SELECT * FROM posts WHERE id=?`).get(row.post_id) as any;
    const isHourly = post && post.price_type !== 'fixed';
    
    let releaseCredits = row.credits;
    if (isHourly && typeof finalHours === 'number' && finalHours > 0) {
        releaseCredits = post.credits * finalHours;
    }

    const completedAt = new Date().toISOString();
    let releaseResult: any = null;

    db.transaction(() => {
        if (isHourly && releaseCredits !== row.credits) {
            const diff = releaseCredits - row.credits;
            if (diff > 0) {
                const { balance, floor, usableFloor: uFloor } = cb.getBalance(row.buyer_pubkey);
                if (balance - diff < floor) throw new Error('Insufficient balance to cover extra hours');
                if (balance - diff < uFloor) throw cb.floorLockedError(row.buyer_pubkey, balance - diff);
                cb.transfer(row.buyer_pubkey, `escrow_${row.id}`, diff, `Adjust escrow for ${finalHours} hours`, 'escrow', true);
            } else if (diff < 0) {
                cb.transfer(`escrow_${row.id}`, row.buyer_pubkey, Math.abs(diff), `Refund unearned escrow for ${finalHours} hours`, 'escrow', true);
            }
            db.prepare(`UPDATE marketplace_transactions SET credits=?, hours=? WHERE id=?`).run(releaseCredits, finalHours, transactionId);
        }

        releaseResult = cb.transfer(`escrow_${row.id}`, row.seller_pubkey, releaseCredits, `Escrow payout for completed post ${row.post_id}`, 'escrow', true);
        if (!releaseResult) throw new Error('Failed to release escrow funds');

        db.prepare(`UPDATE marketplace_transactions SET status = 'completed', completed_at = ? WHERE id = ?`).run(completedAt, transactionId);

        if (post && !post.repeatable) {
            db.prepare(`UPDATE posts SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`).run(completedAt, completedAt, row.post_id);
        } else if (post && post.repeatable) {
            db.prepare(`UPDATE posts SET status = 'active', accepted_by = NULL, accepted_at = NULL, pending_transaction_id = NULL, updated_at = ? WHERE id = ?`).run(completedAt, row.post_id);
        }
    })();

    const tx = getMarketplaceTransaction(db, transactionId)!;
    cb.broadcast({ type: 'transaction_completed', transaction: tx });

    try {
        cb.injectSystemMessage(row.post_id, cb.SystemMessageType.ESCROW_RELEASED, {
            amount: releaseCredits,
            postId: row.post_id,
            actorPubkey: confirmerPublicKey,
            buyerPubkey: row.buyer_pubkey,
            sellerPubkey: row.seller_pubkey,
            txHash: releaseResult?.id
        }, row.buyer_pubkey, row.seller_pubkey);
    } catch (e) {
        console.warn('[Marketplace] ESCROW_RELEASED system message failed:', e);
    }

    cb.dispatchPushNotification(
        [row.seller_pubkey],
        confirmerPublicKey,
        '🎉 Deal Completed!',
        `Payment of ${releaseCredits} Beans was released for "${post?.title || 'your post'}"`,
        { screen: 'post', postId: row.post_id },
        'escrow'
    );

    return tx;
}

export function cancelPostTransaction(
    cb: EscrowCallbacks,
    transactionId: string,
    cancellerPublicKey: string
): MarketplaceTransaction | null {
    const row = db.prepare("SELECT * FROM marketplace_transactions WHERE id=? AND status='pending'").get(transactionId) as any;
    if (!row) return null;
    if (row.buyer_pubkey !== cancellerPublicKey && row.seller_pubkey !== cancellerPublicKey) return null;

    const post = db.prepare(`SELECT * FROM posts WHERE id=?`).get(row.post_id) as any;
    const completedAt = new Date().toISOString();

    db.transaction(() => {
        const refundResult = cb.transfer(`escrow_${row.id}`, row.buyer_pubkey, row.credits, `Escrow refund for cancelled post ${row.post_id}`, 'escrow', true);
        if (!refundResult) throw new Error('Failed to refund escrow funds');

        db.prepare(`UPDATE marketplace_transactions SET status = 'cancelled', completed_at = ? WHERE id = ?`).run(completedAt, transactionId);

        if (post) {
            db.prepare(`UPDATE posts SET status = 'active', accepted_by = NULL, accepted_at = NULL, pending_transaction_id = NULL, updated_at = ? WHERE id = ?`).run(completedAt, row.post_id);
        }
    })();

    const tx = getMarketplaceTransaction(db, transactionId)!;
    cb.broadcast({ type: 'transaction_cancelled', transaction: tx });

    try {
        cb.injectSystemMessage(row.post_id, cb.SystemMessageType.ESCROW_CANCELLED, {
            amount: row.credits,
            postId: row.post_id,
            actorPubkey: cancellerPublicKey,
            buyerPubkey: row.buyer_pubkey,
            sellerPubkey: row.seller_pubkey
        }, row.buyer_pubkey, row.seller_pubkey);
    } catch (e) {
        console.warn('[Marketplace] ESCROW_CANCELLED system message failed:', e);
    }

    const otherParty = cancellerPublicKey === row.buyer_pubkey ? row.seller_pubkey : row.buyer_pubkey;
    cb.dispatchPushNotification(
        [otherParty],
        cancellerPublicKey,
        '🚫 Deal Cancelled',
        `Deal for "${post?.title || 'the post'}" was cancelled — escrow funds refunded.`,
        { screen: 'post', postId: row.post_id },
        'escrow'
    );

    return tx;
}

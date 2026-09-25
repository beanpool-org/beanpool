// Stateful deal workflows & escrow ledger transactions.
//
// Extracted from apps/server/src/state-engine.ts.

import { isSyntheticAccount } from '@beanpool/core';
import { db } from '../db/db.js';
import { isNodeOwner } from './node-roles.js';
import { isServableAvatarValue } from '@beanpool/core';
import { recordActivity } from '../db/activity-feed-db.js';
import { adminActorName } from './admin-actor-name.js';
import { assertLocalSettlement, assertTradableHere } from '../federation-settlement.js';
import { assertFeatureOn } from '../config/node-profile.js';
import crypto from 'node:crypto';
import {
    getMember,
    getPosts,
    hasListedOffer,
    getMarketplaceTransaction,
    CONTRIBUTION_REQUIRED_ERROR,
    type MarketplaceTransaction
} from '@beanpool/engine';

type BroadcastFn = (event: any, recipients?: string[], opts?: { othersGetDoorbell?: boolean }) => void;
type TransferFn = (from: string, to: string, amount: number, memo: string, method?: 'direct' | 'escrow', isFeeExempt?: boolean, auth?: { signer: string; signature?: string; payload?: string }) => any;
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
    canOperateTreasury: (operator: string, treasury: string) => boolean;
    conservingTransaction: <T>(fn: () => T) => T;
    processDeferredWageClaims?: (enterprisePubkey: string) => number;
    sweepEnterpriseCeiling?: (enterprisePubkey: string) => number;
}

export function recordDeferredWageClaim(
    enterprisePubkey: string,
    keeperPubkey: string,
    amount: number,
    postId?: string,
    transactionId?: string
): string {
    let existing: any = null;
    if (transactionId) {
        existing = db.prepare("SELECT id FROM deferred_wage_claims WHERE transaction_id = ? AND status IN ('pending', 'paid')").get(transactionId) as any;
    } else if (postId) {
        existing = db.prepare("SELECT id FROM deferred_wage_claims WHERE enterprise_pubkey = ? AND keeper_pubkey = ? AND post_id = ? AND status = 'pending'").get(enterprisePubkey, keeperPubkey, postId) as any;
    }
    if (existing) return existing.id;
    const id = crypto.randomUUID();
    db.prepare(`
        INSERT INTO deferred_wage_claims (id, enterprise_pubkey, keeper_pubkey, post_id, transaction_id, amount, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run(id, enterprisePubkey, keeperPubkey, postId || null, transactionId || null, amount);
    return id;
}

/**
 * May this signer act for this enterprise in a deal? Only canOperateTreasury answers that: it applies the
 * operator switch and the signer's account status as well as the binding. There is no fallback to a bare
 * treasury_operators lookup, which would let a suspended or switched-off keeper approve and pay out; without
 * the callback the answer is no.
 */
function signerKeepsEnterprise(cb: EscrowCallbacks, signer: string, enterprisePubkey: string): boolean {
    if (typeof cb.canOperateTreasury !== 'function') return false;
    return cb.canOperateTreasury(signer, enterprisePubkey);
}

/**
 * Who a trade's live events go to: the buyer and the seller, and for an enterprise side the keepers who may
 * act for it (canOperateTreasury — the same test that lets them approve and complete its deals). A trade names
 * both parties, the amount and the listing, so it never goes to the whole feed.
 */
function tradeRecipients(cb: EscrowCallbacks, tx: { buyerPublicKey: string; sellerPublicKey: string }): string[] {
    const out = new Set<string>([tx.buyerPublicKey, tx.sellerPublicKey]);
    for (const side of [tx.buyerPublicKey, tx.sellerPublicKey]) {
        const keepers = db.prepare('SELECT member_pubkey FROM treasury_operators WHERE treasury_pubkey = ?').all(side) as { member_pubkey: string }[];
        for (const k of keepers) if (signerKeepsEnterprise(cb, k.member_pubkey, side)) out.add(k.member_pubkey);
    }
    return [...out];
}

const HOLIDAY_MODE_ERROR = 'HOLIDAY_MODE: turn off holiday mode in Settings before trading.';

function assertMemberActive(publicKey: string): void {
    if (isSyntheticAccount(publicKey)) return;
    const member = db.prepare("SELECT status FROM members WHERE public_key = ?").get(publicKey) as any;
    if (!member) throw new Error('Member not found');
    if (member.status === 'disabled') throw new Error('Account is disabled');
    if (member.status === 'pruned') throw new Error('Account has been pruned');
    if (member.status === 'completed') throw new Error('Enterprise has wound up — account closed');
}

function assertProfileComplete(publicKey: string): void {
    const member = db.prepare("SELECT avatar_url, callsign FROM members WHERE public_key = ?").get(publicKey) as any;
    if (!member) return;
    // See the identical gate in engine/posts.ts: a stored /api/avatar/ URL is not a photo.
    if (!isServableAvatarValue(member.avatar_url)) {
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

/**
 * A group post this caller cannot see in any feed (getPosts: only its author and the group's active members), so the
 * trade routes must answer exactly as for an id nobody has. The old "Must be an active member of the group" told
 * a non-member holding the id that it was a group post, and of which group — an invite-only one included.
 */
function cannotSeeGroupPost(scope: string | null | undefined, groupId: string | null | undefined, authorPubkey: string, caller: string): boolean {
    if (scope !== 'group' || !groupId || authorPubkey === caller) return false;
    return !db.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND member_pubkey = ? AND status = 'active'").get(groupId, caller);
}

/**
 * A post hidden by reports (G3) is not there for anyone but its author, here as when read by id (getPosts): a
 * request or an accept would start a deal, and put Beans in escrow, on a post waiting for a moderator (most likely
 * one reported as a scam), and its answer would name the post. So the trade routes answer as for an id nobody has.
 */
function hiddenFromCaller(hiddenAt: string | null | undefined, authorPubkey: string, caller: string): boolean {
    return !!hiddenAt && authorPubkey !== caller;
}

/**
 * Approving a request opens an escrow, funded (on an Offer) by a requester the post is now hidden from. The author
 * knows it is hidden, so they are told why; the request waits, and either side can still back out of it.
 */
function postHiddenNoNewDeal(): Error {
    return Object.assign(
        new Error('This post is hidden while a moderator looks at reports about it, so no new deal can start on it. You can approve this request once it is restored.'),
        { status: 409, statusCode: 409, code: 'post_hidden' },
    );
}

export function requestPost(
    cb: EscrowCallbacks,
    postId: string,
    requesterPublicKey: string,
    hours?: number
): MarketplaceTransaction {
    // Every escrow starts at one of the three doors (request, approve, accept); each refuses when escrow is off
    // on this node (config/node-profile.ts), before a row is written. The routes answer 404 before this.
    assertFeatureOn('escrow');
    assertMemberActive(requesterPublicKey);
    assertProfileComplete(requesterPublicKey);
    assertNotOnHoliday(requesterPublicKey);
    const post = db.prepare(`SELECT * FROM posts WHERE id=?`).get(postId) as any;
    if (!post || cannotSeeGroupPost(post.audience_scope, post.target_group_id, post.author_pubkey, requesterPublicKey)
        || hiddenFromCaller(post.hidden_by_reports_at, post.author_pubkey, requesterPublicKey)) {
        throw new Error('Post not found');
    }
    if (post.status !== 'active') throw new Error('Post is not active');
    assertMemberActive(post.author_pubkey);
    const authorMember = db.prepare('SELECT is_treasury, paused, status FROM members WHERE public_key=?').get(post.author_pubkey) as any;
    if (authorMember?.is_treasury) {
        if (authorMember.paused === 1) throw new Error('Enterprise is paused — cannot request posts while paused');
        if (authorMember.status === 'winding_up') throw new Error('Enterprise is winding up — cannot accept new requests');
        if (authorMember.status === 'completed') throw new Error('Enterprise has wound up — trading closed');
    }
    const requesterMember = db.prepare('SELECT is_treasury, paused, status FROM members WHERE public_key=?').get(requesterPublicKey) as any;
    if (requesterMember?.is_treasury) {
        if (requesterMember.paused === 1) throw new Error('Enterprise is paused — cannot request posts while paused');
        if (requesterMember.status === 'winding_up') throw new Error('Enterprise is winding up — cannot place new requests');
        if (requesterMember.status === 'completed') throw new Error('Enterprise has wound up — trading closed');
    }
    if (post.author_pubkey === requesterPublicKey) throw new Error('You cannot request your own post');
    if (isOnHoliday(post.author_pubkey)) throw new Error('This member is away (holiday mode) and not trading right now.');

    // NOTE: post is a raw DB row here (snake_case), not a MarketplacePost (camelCase).
    // acceptPost uses getPosts() which returns camelCase. Support both for resilience.
    const audienceScope = post.audience_scope ?? post.audienceScope;
    const targetGroupId = post.target_group_id ?? post.targetGroupId;
    const targetPubkey = post.target_pubkey ?? post.targetPubkey;
    const assignedTo = post.assigned_to ?? post.assignedTo;
    const authorPubkey = post.author_pubkey ?? post.authorPublicKey;

    if (audienceScope === 'group' && targetGroupId) {
        const isMem = db.prepare(
            "SELECT 1 FROM group_members WHERE group_id = ? AND member_pubkey = ? AND status = 'active' AND role IN ('convenor', 'member')"
        ).get(targetGroupId, requesterPublicKey);
        if (!isMem && authorPubkey !== requesterPublicKey) {
            throw new Error('UNAUTHORIZED: Must be an active member of the group to request this post');
        }
    }
    if (audienceScope === 'direct') {
        const isTarget = targetPubkey === requesterPublicKey || assignedTo === requesterPublicKey || authorPubkey === requesterPublicKey;
        if (!isTarget) {
            throw new Error('UNAUTHORIZED: This direct post is not addressed to you');
        }
    }

    const author = getMember(db, post.author_pubkey);
    if (post.id?.startsWith('pulse_') || (author?.isTreasury && author?.callsign?.toLowerCase() === 'daily pulse')) {
        throw new Error('Daily Pulse inspirational posts cannot be requested or transacted');
    }
    if (post.type === 'poll' || post.type === 'event') {
        throw new Error(post.type === 'event' ? 'Events cannot be requested or transacted' : 'Polls cannot be requested or transacted');
    }

    const isOffer = post.type === 'offer';
    if (isOffer) {
        if (!hasListedOffer(db, requesterPublicKey)) throw new Error(CONTRIBUTION_REQUIRED_ERROR);
    }

    if (post.price_type !== 'fixed' && (typeof hours !== 'number' || hours <= 0)) {
        throw new Error(`Must provide a valid quantity for a ${post.price_type} post`);
    }

    const requester = getMember(db, requesterPublicKey);
    const finalCredits = post.price_type !== 'fixed' ? post.credits * hours! : post.credits;

    const payerPubkey = isOffer ? requesterPublicKey : post.author_pubkey;
    // #102: on a Need the payer is the post's author, NOT the requester — which is exactly why this
    // check belongs at the draw point instead of the route's actor.
    assertLocalSettlement(payerPubkey);
    // #143 step 4 fallout: a PULLED listing is on this board but belongs to a peer. Raw row here, so the
    // column name rather than the mapped field. The payee is the other side of the same swap as the payer.
    assertTradableHere({ originNode: post.origin_node }, isOffer ? post.author_pubkey : requesterPublicKey);
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

    cb.broadcast({ type: 'transaction_requested', transaction: tx }, tradeRecipients(cb, tx));

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
    authorPublicKey: string,
    opts?: { authSigner?: string }
): MarketplaceTransaction | null {
    assertFeatureOn('escrow');
    const row = db.prepare("SELECT * FROM marketplace_transactions WHERE id=? AND status='requested'").get(transactionId) as any;
    if (!row) return null;

    const post = db.prepare(`SELECT * FROM posts WHERE id=?`).get(row.post_id) as any;
    if (!post || post.type === 'poll' || post.type === 'event') return null;

    const isOffer = post.type === 'offer';
    const expectedAuthorRole = isOffer ? row.seller_pubkey : row.buyer_pubkey;
    if (expectedAuthorRole !== authorPublicKey) return null;
    if (post.hidden_by_reports_at) throw postHiddenNoNewDeal();

    // Two-person rule (docs/the-commons.md §2.3 and docs/admin-surface.md §6):
    // When an enterprise authors a Need, the acting operator approving the bid
    // must NOT be the counterparty being paid (self-dealing prevention).
    const buyerMember = db.prepare('SELECT is_treasury, paused, status, callsign FROM members WHERE public_key=?').get(row.buyer_pubkey) as any;
    const isEnterpriseNeed = !isOffer && Boolean(buyerMember?.is_treasury);
    if (isEnterpriseNeed && opts?.authSigner && opts.authSigner === row.seller_pubkey) {
        const name = buyerMember?.callsign?.trim() || 'this enterprise';
        const err: any = new Error(`Another keeper of ${name} needs to approve this — you cannot approve a job you are being paid for.`);
        err.status = 403;
        err.statusCode = 403;
        err.code = 'TWO_PERSON_RULE';
        throw err;
    }

    assertMemberActive(authorPublicKey);
    assertNotOnHoliday(authorPublicKey);
    if (isOnHoliday(row.buyer_pubkey) || isOnHoliday(row.seller_pubkey)) {
        throw new Error('Trading is paused while a member is in holiday mode.');
    }

    const authorMember = db.prepare('SELECT is_treasury, paused, status FROM members WHERE public_key=?').get(authorPublicKey) as any;
    if (authorMember?.is_treasury) {
        if (authorMember.paused === 1) throw new Error('Enterprise is paused — cannot approve bids while paused');
        if (authorMember.status === 'winding_up') throw new Error('Enterprise is winding up — cannot accept new orders');
        if (authorMember.status === 'completed') throw new Error('Enterprise has wound up — trading closed');
    }
    if (buyerMember?.is_treasury) {
        if (buyerMember.paused === 1) throw new Error('Enterprise is paused — cannot approve bids while paused');
        if (buyerMember.status === 'winding_up') throw new Error('Enterprise is winding up — cannot accept new orders');
        if (buyerMember.status === 'completed') throw new Error('Enterprise has wound up — trading closed');
    }

    // #102: the approver is the post author, but the money moves from the BUYER on this row.
    assertLocalSettlement(row.buyer_pubkey);
    // #143 step 4 fallout. Checked again here and not only in `requestPost`, because a row created before
    // this guard existed — or on a listing whose author has migrated away since — reaches its draw point
    // through THIS function. The escrow is funded below either way, so this is a draw point in its own right.
    const originRow = db.prepare('SELECT origin_node FROM posts WHERE id = ?').get(row.post_id) as any;
    assertTradableHere({ originNode: originRow?.origin_node }, row.seller_pubkey);

    const isEnterprisePayer = Boolean(buyerMember?.is_treasury);
    const isPayeeKeeper = isEnterprisePayer && Boolean(
        db.prepare('SELECT 1 FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?')
            .get(row.buyer_pubkey, row.seller_pubkey)
    );

    const { balance, floor, usableFloor: uFloor } = cb.getBalance(row.buyer_pubkey);

    if (isPayeeKeeper) {
        const trow = db.prepare('SELECT earned_surplus FROM members WHERE public_key = ?').get(row.buyer_pubkey) as any;
        const earnedSurplus = Number(trow?.earned_surplus) || 0;
        const name = buyerMember?.callsign || 'This enterprise';

        // Rule 5: credit buys inputs, profit pays people (docs/the-commons.md §2.4).
        // An enterprise may borrow from the community to buy things. It may NOT borrow
        // from the community to pay itself. Keepers eat last: paid only while
        // balance - amount >= 0. NEVER into credit.
        if (balance - row.credits < 0) {
            recordDeferredWageClaim(row.buyer_pubkey, row.seller_pubkey, row.credits, row.post_id, transactionId);
            const msg = balance <= 0
                ? `${name} is in deficit and cannot borrow to pay its keepers — credit buys inputs, but keepers can only be paid from profit.`
                : `${name} cannot borrow into credit to pay its keepers — credit buys inputs, but keepers can only be paid from profit.`;
            const err: any = new Error(msg);
            err.status = 403;
            err.statusCode = 403;
            throw err;
        }

        // Rule 6: keeper pay is capped by EARNED SURPLUS (docs/the-commons.md §2.4).
        // A positive balance is not profit: grants, pledges and gifts raise balance
        // but cannot become wages.
        if (row.credits > earnedSurplus) {
            recordDeferredWageClaim(row.buyer_pubkey, row.seller_pubkey, row.credits, row.post_id, transactionId);
            const msg = `${name} has insufficient earned surplus (${earnedSurplus} Beans) to pay keeper wages (${row.credits} Beans) — grants and pledges cannot become wages, only genuine trading profit.`;
            const err: any = new Error(msg);
            err.status = 403;
            err.statusCode = 403;
            throw err;
        }
    } else {
        if (balance - row.credits < floor) throw new Error('Buyer has insufficient balance to cover escrow');
        if (balance - row.credits < uFloor) throw cb.floorLockedError(row.buyer_pubkey, balance - row.credits);
    }

    // Enterprise needs require an authenticated keeper signature (docs/admin-surface.md §6).
    if (isEnterpriseNeed) {
        if (!opts?.authSigner) {
            const err: any = new Error('Enterprise approval requires an authenticated keeper signature.');
            err.status = 401;
            err.statusCode = 401;
            throw err;
        }
        const isKeeper = signerKeepsEnterprise(cb, opts.authSigner, row.buyer_pubkey);
        if (!isKeeper) {
            const err: any = new Error('Signer is not an authorized keeper of this enterprise.');
            err.status = 403;
            err.statusCode = 403;
            throw err;
        }
    }

    cb.ensureTransactionConversation(row.post_id, row.buyer_pubkey, row.seller_pubkey);

    cb.conservingTransaction(() => {
        const res = db.prepare(`UPDATE marketplace_transactions SET status='pending' WHERE id=? AND status='requested'`).run(transactionId);
        if (res.changes === 0) throw new Error('Transaction is no longer in requested state');

        if (!post.repeatable) {
            const updated = db.prepare(`UPDATE posts SET status='pending', accepted_by=?, accepted_at=?, pending_transaction_id=?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=? AND status='active'`).run(row.buyer_pubkey, new Date().toISOString(), row.id, post.id);
            if (updated.changes === 0) throw new Error('Post is no longer available');

            db.prepare(`UPDATE marketplace_transactions SET status='rejected', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE post_id=? AND id!=? AND status='requested'`)
              .run(post.id, row.id);
        }

        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(`escrow_${row.id}`);

        // Only attribute authSigner when the debited account is the enterprise itself (Need listings)
        const escrowResult = cb.transfer(
            row.buyer_pubkey,
            `escrow_${row.id}`,
            row.credits,
            `Escrow hold for approved deal ${row.post_id}`,
            'escrow',
            true,
            (isEnterprisePayer && opts?.authSigner) ? { signer: opts.authSigner } : undefined
        );
        if (!escrowResult) throw new Error('Failed to lock funds in escrow');

        if (isPayeeKeeper) {
            db.prepare('UPDATE members SET earned_surplus = COALESCE(earned_surplus, 0) - ? WHERE public_key = ?')
                .run(row.credits, row.buyer_pubkey);
        }
    });

    const tx = getMarketplaceTransaction(db, transactionId)!;
    // The listing is now pending on everyone's board: the others get a bare doorbell to re-fetch it.
    cb.broadcast({ type: 'post_accepted', postId: post.id, transaction: tx }, tradeRecipients(cb, tx), { othersGetDoorbell: true });

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
    if (!post || post.type === 'poll' || post.type === 'event') return null;

    const isOffer = post.type === 'offer';
    const expectedAuthorRole = isOffer ? row.seller_pubkey : row.buyer_pubkey;
    if (expectedAuthorRole !== authorPublicKey) return null;

    const res = db.prepare(`UPDATE marketplace_transactions SET status='rejected', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=? AND status='requested'`).run(transactionId);
    if (res.changes === 0) return null;
    db.prepare("UPDATE deferred_wage_claims SET status = 'cancelled' WHERE transaction_id = ? AND status = 'pending'").run(transactionId);
    
    const tx = getMarketplaceTransaction(db, transactionId)!;
    cb.broadcast({ type: 'transaction_rejected', transaction: tx }, tradeRecipients(cb, tx));

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
    if (!post || post.type === 'poll' || post.type === 'event') return null;

    const isOffer = post.type === 'offer';
    const expectedRequesterRole = isOffer ? row.buyer_pubkey : row.seller_pubkey;
    if (expectedRequesterRole !== requesterPublicKey) return null;

    db.prepare(`UPDATE marketplace_transactions SET status='cancelled', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`).run(transactionId);
    db.prepare("UPDATE deferred_wage_claims SET status = 'cancelled' WHERE transaction_id = ? AND status = 'pending'").run(transactionId);
    
    const tx = getMarketplaceTransaction(db, transactionId)!;
    cb.broadcast({ type: 'transaction_cancelled', transaction: tx }, tradeRecipients(cb, tx));
    return tx;
}

export function acceptPost(
    cb: EscrowCallbacks,
    postId: string,
    buyerPublicKey: string,
    hours?: number,
    opts?: { authSigner?: string }
): MarketplaceTransaction {
    assertFeatureOn('escrow');
    assertMemberActive(buyerPublicKey);
    assertNotOnHoliday(buyerPublicKey);
    const post = getPosts(db, { id: postId, status: 'active', includeAllScopes: true })[0];
    if (!post || cannotSeeGroupPost(post.audienceScope, post.targetGroupId, post.authorPublicKey, buyerPublicKey)
        || hiddenFromCaller(post.hiddenByReportsAt, post.authorPublicKey, buyerPublicKey)) {
        throw new Error('Post not found or not active');
    }
    assertMemberActive(post.authorPublicKey);
    const authorMember = db.prepare('SELECT is_treasury, paused, status FROM members WHERE public_key=?').get(post.authorPublicKey) as any;
    if (authorMember?.is_treasury) {
        if (authorMember.paused === 1) throw new Error('Enterprise is paused — cannot transact while paused');
        if (authorMember.status === 'winding_up') throw new Error('Enterprise is winding up — cannot accept new orders');
        if (authorMember.status === 'completed') throw new Error('Enterprise has wound up — trading closed');
    }
    const buyerMember = db.prepare('SELECT is_treasury, paused, status, callsign FROM members WHERE public_key=?').get(buyerPublicKey) as any;
    if (buyerMember?.is_treasury) {
        if (buyerMember.paused === 1) throw new Error('Enterprise is paused — cannot transact while paused');
        if (buyerMember.status === 'winding_up') throw new Error('Enterprise is winding up — cannot accept new orders');
        if (buyerMember.status === 'completed') throw new Error('Enterprise has wound up — trading closed');
    }

    // NOTE: post comes from getPosts() which returns camelCase MarketplacePost.
    // Support both camelCase and snake_case for resilience across refactors.
    const audienceScope = post.audienceScope ?? (post as any).audience_scope;
    const targetGroupId = post.targetGroupId ?? (post as any).target_group_id;
    const targetPubkey = post.targetPubkey ?? (post as any).target_pubkey;
    const assignedTo = post.assignedTo ?? (post as any).assigned_to;

    if (audienceScope === 'group' && targetGroupId) {
        const isMem = db.prepare(
            "SELECT 1 FROM group_members WHERE group_id = ? AND member_pubkey = ? AND status = 'active' AND role IN ('convenor', 'member')"
        ).get(targetGroupId, buyerPublicKey);
        if (!isMem) {
            throw new Error('UNAUTHORIZED: Must be an active member of the group to accept this offer');
        }
    }
    if (audienceScope === 'direct') {
        const isTarget = targetPubkey === buyerPublicKey || assignedTo === buyerPublicKey;
        if (!isTarget) {
            throw new Error('UNAUTHORIZED: This direct offer is not addressed to you');
        }
    }
    if (post.authorPublicKey === buyerPublicKey) throw new Error('Cannot accept your own post');
    if (isOnHoliday(post.authorPublicKey)) throw new Error('This member is away (holiday mode) and not trading right now.');

    const author = getMember(db, post.authorPublicKey);
    if (post.id?.startsWith('pulse_') || (author?.isTreasury && author?.callsign?.toLowerCase() === 'daily pulse')) {
        throw new Error('Daily Pulse inspirational posts cannot be requested or transacted');
    }
    if (post.type === 'poll' || post.type === 'event') {
        throw new Error(post.type === 'event' ? 'Events cannot be requested or transacted' : 'Polls cannot be requested or transacted');
    }

    if (post.type !== 'offer') {
        throw new Error('Only Offers can be 1-step accepted');
    }

    if (!hasListedOffer(db, buyerPublicKey)) throw new Error(CONTRIBUTION_REQUIRED_ERROR);

    if (post.priceType !== 'fixed' && (typeof hours !== 'number' || hours <= 0)) {
        throw new Error(`Must provide a valid quantity for a ${post.priceType} post`);
    }

    const buyer = getMember(db, buyerPublicKey);
    const finalCredits = post.priceType !== 'fixed' ? post.credits * hours! : post.credits;

    // #102: a visitor's beans live on their home ledger, so this node cannot fund escrow for them.
    // Guarded here rather than only at the route because the PAYER is not always the actor.
    assertLocalSettlement(buyerPublicKey);
    // #143 step 4 fallout, and the call site the live bug came through: this is the one-step accept, so the
    // payee is always the post's author — a visitor, on a pulled listing.
    assertTradableHere(post, post.authorPublicKey);

    const isEnterprisePayer = Boolean(buyerMember?.is_treasury);

    // Two-person rule (docs/the-commons.md §2.3 and docs/admin-surface.md §6):
    // When an enterprise accepts an Offer, the acting keeper cannot accept their own personal offer on behalf of the enterprise.
    if (isEnterprisePayer && opts?.authSigner && opts.authSigner === post.authorPublicKey) {
        const name = buyerMember?.callsign?.trim() || 'this enterprise';
        const err: any = new Error(`Another keeper of ${name} needs to approve this — you cannot approve a job you are being paid for.`);
        err.status = 403;
        err.statusCode = 403;
        err.code = 'TWO_PERSON_RULE';
        throw err;
    }

    const isPayeeKeeper = isEnterprisePayer && Boolean(
        db.prepare('SELECT 1 FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?')
            .get(buyerPublicKey, post.authorPublicKey)
    );

    const { balance, floor, usableFloor: uFloor } = cb.getBalance(buyerPublicKey);

    if (isPayeeKeeper) {
        const trow = db.prepare('SELECT earned_surplus FROM members WHERE public_key = ?').get(buyerPublicKey) as any;
        const earnedSurplus = Number(trow?.earned_surplus) || 0;
        const name = buyerMember?.callsign || 'This enterprise';

        if (balance - finalCredits < 0) {
            recordDeferredWageClaim(buyerPublicKey, post.authorPublicKey, finalCredits, post.id);
            const msg = balance <= 0
                ? `${name} is in deficit and cannot borrow to pay its keepers — credit buys inputs, but keepers can only be paid from profit.`
                : `${name} cannot borrow into credit to pay its keepers — credit buys inputs, but keepers can only be paid from profit.`;
            const err: any = new Error(msg);
            err.status = 403;
            err.statusCode = 403;
            throw err;
        }

        if (finalCredits > earnedSurplus) {
            recordDeferredWageClaim(buyerPublicKey, post.authorPublicKey, finalCredits, post.id);
            const msg = `${name} has insufficient earned surplus (${earnedSurplus} Beans) to pay keeper wages (${finalCredits} Beans) — grants and pledges cannot become wages, only genuine trading profit.`;
            const err: any = new Error(msg);
            err.status = 403;
            err.statusCode = 403;
            throw err;
        }
    } else {
        if (balance - finalCredits < floor) throw new Error('Insufficient balance to accept this offer');
        if (balance - finalCredits < uFloor) throw cb.floorLockedError(buyerPublicKey, balance - finalCredits);
    }

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

    cb.conservingTransaction(() => {
        if (!post.repeatable) {
            const updated = db.prepare(`UPDATE posts SET status='pending', accepted_by=?, accepted_at=?, pending_transaction_id=?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=? AND status='active'`).run(buyerPublicKey, tx.createdAt, tx.id, post.id);
            if (updated.changes === 0) throw new Error('Post is no longer available — it is already committed to another deal');

            db.prepare(`UPDATE marketplace_transactions SET status='rejected', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE post_id=? AND id!=? AND status='requested'`)
              .run(post.id, tx.id);
        }

        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(`escrow_${tx.id}`);

        const escrowResult = cb.transfer(
            buyerPublicKey,
            `escrow_${tx.id}`,
            finalCredits,
            `Escrow hold for offer ${post.id}`,
            'escrow',
            true,
            (isEnterprisePayer && opts?.authSigner) ? { signer: opts.authSigner } : undefined
        );
        if (!escrowResult) throw new Error('Failed to lock funds in escrow — insufficient balance or ledger error');

        if (isPayeeKeeper) {
            db.prepare('UPDATE members SET earned_surplus = COALESCE(earned_surplus, 0) - ? WHERE public_key = ?')
                .run(finalCredits, buyerPublicKey);
        }

        db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, hours, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`).run(tx.id, tx.postId, tx.buyerPublicKey, tx.sellerPublicKey, tx.credits, tx.hours ?? null, tx.createdAt);
    });

    // The listing is now pending on everyone's board: the others get a bare doorbell to re-fetch it.
    cb.broadcast({ type: 'post_accepted', postId: post.id, transaction: tx }, tradeRecipients(cb, tx), { othersGetDoorbell: true });

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
    finalHours?: number,
    opts?: { authSigner?: string }
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

    // Two-person rule (docs/the-commons.md §2.3 and docs/admin-surface.md §6):
    // When an enterprise authors a Need, the acting operator completing the deal
    // and releasing payment must NOT be the counterparty being paid, must provide an
    // authenticated keeper signature, and must be an authorized keeper of the enterprise.
    const buyerMember = db.prepare('SELECT is_treasury, callsign FROM members WHERE public_key=?').get(row.buyer_pubkey) as any;
    const isEnterpriseBuyer = Boolean(buyerMember?.is_treasury);
    if (isEnterpriseBuyer) {
        if (!opts?.authSigner) {
            const err: any = new Error('Enterprise completion requires an authenticated keeper signature.');
            err.status = 401;
            err.statusCode = 401;
            throw err;
        }
        const isKeeper = signerKeepsEnterprise(cb, opts.authSigner, row.buyer_pubkey);
        if (!isKeeper) {
            const err: any = new Error('Signer is not an authorized keeper of this enterprise.');
            err.status = 403;
            err.statusCode = 403;
            throw err;
        }
        if (opts.authSigner === row.seller_pubkey) {
            const name = buyerMember?.callsign?.trim() || 'this enterprise';
            const err: any = new Error(`Another keeper of ${name} needs to complete this — you cannot complete a job you are being paid for.`);
            err.status = 403;
            err.statusCode = 403;
            err.code = 'TWO_PERSON_RULE';
            throw err;
        }

        const isPayeeKeeper = Boolean(
            db.prepare('SELECT 1 FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?')
                .get(row.buyer_pubkey, row.seller_pubkey)
        );
        const trow = db.prepare('SELECT paused FROM members WHERE public_key = ?').get(row.buyer_pubkey) as any;
        if (trow?.paused === 1 && isPayeeKeeper) {
            const err: any = new Error('Enterprise is paused — wage payments to keepers cannot be made while paused.');
            err.status = 403;
            err.statusCode = 403;
            throw err;
        }
    }

    const post = db.prepare(`SELECT * FROM posts WHERE id=?`).get(row.post_id) as any;
    if (post && (post.type === 'poll' || post.type === 'event')) return null;
    const isHourly = post && post.price_type !== 'fixed';
    
    let releaseCredits = row.credits;
    if (isHourly && typeof finalHours === 'number' && finalHours > 0) {
        releaseCredits = post.credits * finalHours;
    }

    const completedAt = new Date().toISOString();
    let releaseResult: any = null;

    cb.conservingTransaction(() => {
        const updateRes = db.prepare(`UPDATE marketplace_transactions SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'pending'`).run(completedAt, transactionId);
        if (updateRes.changes === 0) throw new Error('Deal was already completed or cancelled');

        if (isHourly && releaseCredits !== row.credits) {
            const diff = releaseCredits - row.credits;
            if (diff > 0) {
                const buyerMember = db.prepare('SELECT is_treasury, callsign FROM members WHERE public_key=?').get(row.buyer_pubkey) as any;
                const isEnterprisePayer = Boolean(buyerMember?.is_treasury);
                const isPayeeKeeper = isEnterprisePayer && Boolean(
                    db.prepare('SELECT 1 FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?')
                        .get(row.buyer_pubkey, row.seller_pubkey)
                );
                const { balance, floor, usableFloor: uFloor } = cb.getBalance(row.buyer_pubkey);
                if (isPayeeKeeper) {
                    const trow = db.prepare('SELECT earned_surplus FROM members WHERE public_key = ?').get(row.buyer_pubkey) as any;
                    const earnedSurplus = Number(trow?.earned_surplus) || 0;
                    if (balance - diff < 0 || diff > earnedSurplus) {
                        // Extra hours cannot be funded from balance or earned surplus.
                        // Record deferred wage claim for the difference (diff), release the base hold
                        // (row.credits) already secured in escrow to the keeper, and avoid stranding funds.
                        recordDeferredWageClaim(row.buyer_pubkey, row.seller_pubkey, diff, row.post_id, transactionId);
                        releaseCredits = row.credits;
                    } else {
                        db.prepare('UPDATE members SET earned_surplus = COALESCE(earned_surplus, 0) - ? WHERE public_key = ?')
                            .run(diff, row.buyer_pubkey);
                        // THROW, don't ignore. The release below pays the seller `releaseCredits`, which is
                        // the base hold PLUS this top-up. If the top-up silently fails the escrow is short by
                        // `diff` and the seller is paid beans that were never held — the escrow ends at -diff
                        // and the node stops summing to zero. We are inside the enclosing conservingTransaction,
                        // so a throw unwinds the status update, the earned_surplus debit and the ledger together.
                        const toppedUp = cb.transfer(row.buyer_pubkey, `escrow_${row.id}`, diff, `Adjust escrow for ${finalHours} hours`, 'escrow', true, opts?.authSigner ? { signer: opts.authSigner } : undefined);
                        if (!toppedUp) throw new Error('Failed to top up escrow for the extra hours');
                    }
                } else {
                    if (balance - diff < floor) throw new Error('Insufficient balance to cover extra hours');
                    if (balance - diff < uFloor) throw cb.floorLockedError(row.buyer_pubkey, balance - diff);
                    // Same reasoning as the keeper branch above: an ignored failure here pays the seller out
                    // of an escrow that never received the top-up. The floor checks on the two lines above
                    // are a pre-flight, not the authority — `transfer()` re-checks and can still refuse.
                    const toppedUp = cb.transfer(row.buyer_pubkey, `escrow_${row.id}`, diff, `Adjust escrow for ${finalHours} hours`, 'escrow', true, opts?.authSigner ? { signer: opts.authSigner } : undefined);
                    if (!toppedUp) throw new Error('Failed to top up escrow for the extra hours');
                }
            } else if (diff < 0) {
                const buyerMember = db.prepare('SELECT is_treasury FROM members WHERE public_key=?').get(row.buyer_pubkey) as any;
                const isEnterprisePayer = Boolean(buyerMember?.is_treasury);
                const isPayeeKeeper = isEnterprisePayer && Boolean(
                    db.prepare('SELECT 1 FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?')
                        .get(row.buyer_pubkey, row.seller_pubkey)
                );
                if (isPayeeKeeper) {
                    db.prepare('UPDATE members SET earned_surplus = COALESCE(earned_surplus, 0) + ? WHERE public_key = ?')
                        .run(Math.abs(diff), row.buyer_pubkey);
                }
                // The mirror case, and it was ignored too: fewer hours than booked, so the unearned part goes back
                // to the buyer before the rest is released. A silent failure here strands `|diff|` in an escrow
                // that the release then closes, and the buyer never sees their change.
                const refunded = cb.transfer(`escrow_${row.id}`, row.buyer_pubkey, Math.abs(diff), `Refund unearned escrow for ${finalHours} hours`, 'escrow', true, opts?.authSigner ? { signer: opts.authSigner } : undefined);
                if (!refunded) throw new Error('Failed to refund the unearned escrow hours');
            }
            db.prepare(`UPDATE marketplace_transactions SET credits=?, hours=? WHERE id=?`).run(releaseCredits, finalHours, transactionId);
        }

        // The 1.5% community fee is charged HERE — the seller receives (amount − fee), the fee goes to
        // the Commons. Holds, adjustments and refunds stay exempt; this is the one transfer where value
        // settles to a real member's account. Cross-node settlement handles its own fee separately
        // (federation-settlement-exchange.ts § commitOutboundSettlement → moveToCommons).
        releaseResult = cb.transfer(`escrow_${row.id}`, row.seller_pubkey, releaseCredits, `Escrow payout for completed post ${row.post_id}`, 'escrow', false, opts?.authSigner ? { signer: opts.authSigner } : undefined);
        if (!releaseResult) throw new Error('Failed to release escrow funds');

        if (post && !post.repeatable) {
            db.prepare(`UPDATE posts SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`).run(completedAt, completedAt, row.post_id);
        } else if (post && post.repeatable) {
            db.prepare(`UPDATE posts SET status = 'active', accepted_by = NULL, accepted_at = NULL, pending_transaction_id = NULL, updated_at = ? WHERE id = ?`).run(completedAt, row.post_id);
        }
    });

    // Rule 6 & 7: Earned surplus tracking, deferred wage claims, and working capital ceiling sweep (docs/the-commons.md §2.4).
    const sellerMember = db.prepare('SELECT is_treasury FROM members WHERE public_key = ?').get(row.seller_pubkey) as any;
    if (sellerMember?.is_treasury === 1) {
        const isBuyerKeeper = Boolean(
            db.prepare('SELECT 1 FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?')
                .get(row.seller_pubkey, row.buyer_pubkey)
        );
        // Rule 6: Only genuine external sales count toward earned surplus (exclude wash trades with own keepers)
        if (!isBuyerKeeper) {
            db.prepare('UPDATE members SET earned_surplus = COALESCE(earned_surplus, 0) + ? WHERE public_key = ?')
                .run(releaseCredits, row.seller_pubkey);
        }
        // Process any deferred wage claims now that the enterprise has earned surplus and balance
        if (cb.processDeferredWageClaims) {
            cb.processDeferredWageClaims(row.seller_pubkey);
        }
        // Sweep any surplus above the working capital ceiling to Commons
        if (cb.sweepEnterpriseCeiling) {
            cb.sweepEnterpriseCeiling(row.seller_pubkey);
        }
    }

    const tx = getMarketplaceTransaction(db, transactionId)!;
    // The listing's status and the members' activity feed change for everyone: a bare doorbell for the others.
    cb.broadcast({ type: 'transaction_completed', transaction: tx }, tradeRecipients(cb, tx), { othersGetDoorbell: true });
    try {
        recordActivity('trade_completed', row.seller_pubkey, row.buyer_pubkey, {
            postId: row.post_id,
            postTitle: post?.title,
            credits: releaseCredits,
        });
    } catch (e) {
        console.warn('[ActivityFeed] Could not record trade_completed:', e);
    }

    const netPayout = releaseCredits - (releaseResult?.taxFee ?? 0);
    try {
        cb.injectSystemMessage(row.post_id, cb.SystemMessageType.ESCROW_RELEASED, {
            amount: netPayout,
            grossAmount: releaseCredits,
            fee: releaseResult?.taxFee ?? 0,
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
        `Payment of ${netPayout} Beans was released for "${post?.title || 'your post'}"`,
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
    if (post && (post.type === 'poll' || post.type === 'event')) return null;
    const completedAt = new Date().toISOString();

    cb.conservingTransaction(() => {
        const updateRes = db.prepare(`UPDATE marketplace_transactions SET status = 'cancelled', completed_at = ? WHERE id = ? AND status = 'pending'`).run(completedAt, transactionId);
        if (updateRes.changes === 0) throw new Error('Deal was already completed or cancelled');

        const refundResult = cb.transfer(`escrow_${row.id}`, row.buyer_pubkey, row.credits, `Escrow refund for cancelled post ${row.post_id}`, 'escrow', true);
        if (!refundResult) throw new Error('Failed to refund escrow funds');

        const buyerMember = db.prepare('SELECT is_treasury FROM members WHERE public_key=?').get(row.buyer_pubkey) as any;
        if (buyerMember?.is_treasury === 1) {
            // Cancel any pending deferred wage claim associated with this transaction
            db.prepare("UPDATE deferred_wage_claims SET status = 'cancelled' WHERE transaction_id = ? AND status = 'pending'")
                .run(transactionId);
            const isPayeeKeeper = Boolean(
                db.prepare('SELECT 1 FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?')
                    .get(row.buyer_pubkey, row.seller_pubkey)
            );
            if (isPayeeKeeper) {
                db.prepare('UPDATE members SET earned_surplus = COALESCE(earned_surplus, 0) + ? WHERE public_key = ?')
                    .run(row.credits, row.buyer_pubkey);
            }
        }

        if (post) {
            db.prepare(`UPDATE posts SET status = 'active', accepted_by = NULL, accepted_at = NULL, pending_transaction_id = NULL, updated_at = ? WHERE id = ?`).run(completedAt, row.post_id);
        }
    });

    const tx = getMarketplaceTransaction(db, transactionId)!;
    // The listing is back to active on everyone's board: a bare doorbell for the others.
    cb.broadcast({ type: 'transaction_cancelled', transaction: tx }, tradeRecipients(cb, tx), { othersGetDoorbell: true });

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

export type EscrowDisputeAction = 'release_to_seller' | 'refund_to_buyer' | 'split';

/**
 * An admin may not arbitrate a dispute they are a party to: the buyer, the seller, or a keeper of an
 * enterprise that is either. The password cannot show which owner is acting, so it is refused when an owner
 * is a party — another admin resolves it from their own signed-in session.
 */
function assertNotPartyToDispute(row: { buyer_pubkey: string; seller_pubkey: string }, adminSigner: string): void {
    const parties = new Set<string>([row.buyer_pubkey, row.seller_pubkey]);
    for (const side of [row.buyer_pubkey, row.seller_pubkey]) {
        const keepers = db.prepare('SELECT member_pubkey FROM treasury_operators WHERE treasury_pubkey = ?').all(side) as { member_pubkey: string }[];
        for (const k of keepers) parties.add(k.member_pubkey);
    }
    const refuse = (message: string) => {
        const err: any = new Error(message);
        err.status = 403;
        throw err;
    };
    if (parties.has(adminSigner)) {
        refuse('You are a party to this dispute (the buyer, the seller, or a keeper of one of them), so you cannot resolve it. Ask another admin to do this');
    }
    if (adminSigner === 'owner:password' && [...parties].some(pk => isNodeOwner(pk))) {
        refuse('An owner is a party to this dispute, and the password cannot show which owner is acting. Another admin must resolve it from their own signed-in session');
    }
}

export function resolveEscrowDispute(
    cb: EscrowCallbacks,
    transactionId: string,
    action: EscrowDisputeAction,
    adminSigner: string,
    opts?: { reason?: string }
): MarketplaceTransaction {
    if (!['release_to_seller', 'refund_to_buyer', 'split'].includes(action)) {
        throw new Error("Invalid dispute resolution action. Must be 'release_to_seller', 'refund_to_buyer', or 'split'.");
    }

    if (!adminSigner || typeof adminSigner !== 'string' || !adminSigner.trim()) {
        throw new Error('Missing admin authSigner for escrow dispute resolution');
    }

    const row = db.prepare("SELECT * FROM marketplace_transactions WHERE id=? AND status='pending'").get(transactionId) as any;
    if (!row) {
        throw new Error('Transaction not found or not in pending escrow');
    }

    assertNotPartyToDispute(row, adminSigner.trim());

    const post = db.prepare('SELECT * FROM posts WHERE id=?').get(row.post_id) as any;
    const authSigner = adminSigner.trim();
    const completedAt = new Date().toISOString();
    const reasonText = opts?.reason ? ` (Reason: ${opts.reason})` : '';
    // Members read who ruled in words; the signer itself stays on the audit columns (dispute_resolved_by,
    // the ledger rows' auth_signer) and never reaches a memo, a chat line or a push.
    const resolverName = adminActorName(authSigner);

    const buyerMember = db.prepare('SELECT is_treasury, callsign FROM members WHERE public_key=?').get(row.buyer_pubkey) as any;
    const sellerMember = db.prepare('SELECT is_treasury, callsign FROM members WHERE public_key=?').get(row.seller_pubkey) as any;

    let buyerShare = 0;
    let sellerShare = 0;

    if (action === 'release_to_seller') {
        sellerShare = row.credits;
    } else if (action === 'refund_to_buyer') {
        buyerShare = row.credits;
    } else if (action === 'split') {
        // The seller's half is the EXACT remainder, not a second independent rounding. Rounding both to 2dp
        // could make them sum to more than the escrow holds: at row.credits = 12.345 (an hourly deal is not
        // a round number of cents) the old arithmetic gave 6.17 + 6.18 = 12.35, so a split paid out half a
        // cent that nobody put in. Under the escrow floor that no longer mints beans — the second transfer
        // is refused and the arbitration throws — which would be a working dispute turning into an error.
        // So fix the arithmetic: round the buyer's half for legibility, and give the seller what is left.
        buyerShare = Math.round((row.credits / 2) * 100) / 100;
        sellerShare = row.credits - buyerShare;
    }

    cb.conservingTransaction(() => {
        const updateStatus = action === 'refund_to_buyer' ? 'cancelled' : 'completed';
        const updateRes = db.prepare(`
            UPDATE marketplace_transactions
            SET status = ?, completed_at = ?, dispute_resolution = ?, dispute_resolved_at = ?, dispute_resolved_by = ?
            WHERE id = ? AND status = 'pending'
        `).run(updateStatus, completedAt, action, completedAt, authSigner, transactionId);

        if (updateRes.changes === 0) {
            throw new Error('Transaction is no longer in pending state');
        }

        // Ledger transfers carrying auth_signer
        if (action === 'release_to_seller') {
            const releaseResult = cb.transfer(
                `escrow_${row.id}`,
                row.seller_pubkey,
                sellerShare,
                `Dispute arbitrated by ${resolverName}: released to seller for ${row.post_id}${reasonText}`,
                'escrow',
                false,
                { signer: authSigner }
            );
            if (!releaseResult) throw new Error('Failed to release escrow funds to seller');

            if (sellerMember?.is_treasury === 1) {
                const isBuyerKeeper = Boolean(
                    db.prepare('SELECT 1 FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?')
                        .get(row.seller_pubkey, row.buyer_pubkey)
                );
                if (!isBuyerKeeper) {
                    db.prepare('UPDATE members SET earned_surplus = COALESCE(earned_surplus, 0) + ? WHERE public_key = ?')
                        .run(sellerShare, row.seller_pubkey);
                }
            }

            if (post && !post.repeatable) {
                db.prepare(`UPDATE posts SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`).run(completedAt, completedAt, row.post_id);
            } else if (post && post.repeatable) {
                db.prepare(`UPDATE posts SET status = 'active', accepted_by = NULL, accepted_at = NULL, pending_transaction_id = NULL, updated_at = ? WHERE id = ?`).run(completedAt, row.post_id);
            }
        } else if (action === 'refund_to_buyer') {
            const refundResult = cb.transfer(
                `escrow_${row.id}`,
                row.buyer_pubkey,
                buyerShare,
                `Dispute arbitrated by ${resolverName}: refunded to buyer for ${row.post_id}${reasonText}`,
                'escrow',
                true,
                { signer: authSigner }
            );
            if (!refundResult) throw new Error('Failed to refund escrow funds to buyer');

            if (buyerMember?.is_treasury === 1) {
                db.prepare("UPDATE deferred_wage_claims SET status = 'cancelled' WHERE transaction_id = ? AND status = 'pending'")
                    .run(transactionId);
                const isPayeeKeeper = Boolean(
                    db.prepare('SELECT 1 FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?')
                        .get(row.buyer_pubkey, row.seller_pubkey)
                );
                if (isPayeeKeeper) {
                    db.prepare('UPDATE members SET earned_surplus = COALESCE(earned_surplus, 0) + ? WHERE public_key = ?')
                        .run(row.credits, row.buyer_pubkey);
                }
            }

            if (post) {
                db.prepare(`UPDATE posts SET status = 'active', accepted_by = NULL, accepted_at = NULL, pending_transaction_id = NULL, updated_at = ? WHERE id = ?`).run(completedAt, row.post_id);
            }
        } else if (action === 'split') {
            // Buyer refund half (fee-exempt)
            if (buyerShare > 0) {
                const refundRes = cb.transfer(
                    `escrow_${row.id}`,
                    row.buyer_pubkey,
                    buyerShare,
                    `Dispute arbitrated by ${resolverName}: 50% split refund to buyer for ${row.post_id}${reasonText}`,
                    'escrow',
                    true,
                    { signer: authSigner }
                );
                if (!refundRes) throw new Error('Failed to execute buyer refund half of split');
            }

            // Seller payout half (standard fee)
            if (sellerShare > 0) {
                const payoutRes = cb.transfer(
                    `escrow_${row.id}`,
                    row.seller_pubkey,
                    sellerShare,
                    `Dispute arbitrated by ${resolverName}: 50% split payout to seller for ${row.post_id}${reasonText}`,
                    'escrow',
                    false,
                    { signer: authSigner }
                );
                if (!payoutRes) throw new Error('Failed to execute seller payout half of split');

                if (sellerMember?.is_treasury === 1) {
                    const isBuyerKeeper = Boolean(
                        db.prepare('SELECT 1 FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?')
                            .get(row.seller_pubkey, row.buyer_pubkey)
                    );
                    if (!isBuyerKeeper) {
                        db.prepare('UPDATE members SET earned_surplus = COALESCE(earned_surplus, 0) + ? WHERE public_key = ?')
                            .run(sellerShare, row.seller_pubkey);
                    }
                }
            }

            if (buyerMember?.is_treasury === 1) {
                db.prepare("UPDATE deferred_wage_claims SET status = 'cancelled' WHERE transaction_id = ? AND status = 'pending'")
                    .run(transactionId);
                const isPayeeKeeper = Boolean(
                    db.prepare('SELECT 1 FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?')
                        .get(row.buyer_pubkey, row.seller_pubkey)
                );
                if (isPayeeKeeper) {
                    db.prepare('UPDATE members SET earned_surplus = COALESCE(earned_surplus, 0) + ? WHERE public_key = ?')
                        .run(buyerShare, row.buyer_pubkey);
                }
            }

            if (post && !post.repeatable) {
                db.prepare(`UPDATE posts SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`).run(completedAt, completedAt, row.post_id);
            } else if (post && post.repeatable) {
                db.prepare(`UPDATE posts SET status = 'active', accepted_by = NULL, accepted_at = NULL, pending_transaction_id = NULL, updated_at = ? WHERE id = ?`).run(completedAt, row.post_id);
            }
        }
    });

    // Wage claims and ceiling sweep executed outside conservingTransaction to prevent nested transactions
    if (sellerMember?.is_treasury === 1 && (action === 'release_to_seller' || (action === 'split' && sellerShare > 0))) {
        if (cb.processDeferredWageClaims) cb.processDeferredWageClaims(row.seller_pubkey);
        if (cb.sweepEnterpriseCeiling) cb.sweepEnterpriseCeiling(row.seller_pubkey);
    }

    const tx = getMarketplaceTransaction(db, transactionId)!;
    // The parties and the admin who ruled get the ruling; the listing and the activity feed change for everyone
    // else, who get a bare doorbell (other admins' dispute lists re-fetch on it too).
    const disputeRecipients = tradeRecipients(cb, tx);
    if (authSigner && !disputeRecipients.includes(authSigner)) disputeRecipients.push(authSigner);
    // The ruling names who ruled in words: the parties' sockets never carry the admin's key or 'owner:password'.
    cb.broadcast({ type: 'dispute_resolved', transactionId, action, resolvedBy: resolverName, transaction: tx }, disputeRecipients, { othersGetDoorbell: true });

    // Public record on both parties' activity views
    try {
        recordActivity('dispute_resolved', authSigner, row.buyer_pubkey, {
            postId: row.post_id,
            postTitle: post?.title,
            transactionId: row.id,
            resolution: action,
            credits: row.credits,
            counterpartyPubkey: row.seller_pubkey,
            counterpartyCallsign: sellerMember?.callsign || 'counterparty',
            role: 'buyer',
            authSigner,
            reason: opts?.reason
        });
        recordActivity('dispute_resolved', authSigner, row.seller_pubkey, {
            postId: row.post_id,
            postTitle: post?.title,
            transactionId: row.id,
            resolution: action,
            credits: row.credits,
            counterpartyPubkey: row.buyer_pubkey,
            counterpartyCallsign: buyerMember?.callsign || 'counterparty',
            role: 'seller',
            authSigner,
            reason: opts?.reason
        });
    } catch (e) {
        console.warn('[ActivityFeed] Could not record dispute_resolved:', e);
    }

    // Chat context system message
    try {
        cb.injectSystemMessage(row.post_id, cb.SystemMessageType.ESCROW_DISPUTE_RESOLVED, {
            postId: row.post_id,
            transactionId: row.id,
            resolution: action,
            amount: row.credits,
            resolvedByName: resolverName,
            buyerPubkey: row.buyer_pubkey,
            sellerPubkey: row.seller_pubkey,
            reason: opts?.reason
        }, row.buyer_pubkey, row.seller_pubkey);
    } catch (e) {
        console.warn('[Marketplace] ESCROW_DISPUTE_RESOLVED system message failed:', e);
    }

    // Push notification to both parties
    const actionLabel = action === 'release_to_seller'
        ? 'released to seller'
        : action === 'refund_to_buyer'
        ? 'refunded to buyer'
        : 'split 50/50';

    cb.dispatchPushNotification(
        [row.buyer_pubkey, row.seller_pubkey],
        authSigner,
        '⚖️ Escrow Dispute Resolved',
        `Dispute arbitrated by ${resolverName}: ${actionLabel} for "${post?.title || 'deal'}"`,
        { screen: 'post', postId: row.post_id },
        'escrow'
    );

    return tx;
}

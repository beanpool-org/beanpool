// Stateful mutations for Marketplace Posts.
//
// Extracted from apps/server/src/state-engine.ts.

import { isSyntheticAccount, parseReachPeers, type PostReach } from '@beanpool/core';
import { db } from '../db/db.js';
import { recordActivity } from '../db/activity-feed-db.js';
import crypto from 'node:crypto';
import { bumpPostsVersion } from './versions.js';
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

function assertEnterpriseCanPost(publicKey: string): void {
    const member = db.prepare("SELECT is_treasury, paused, status FROM members WHERE public_key = ?").get(publicKey) as any;
    if (member?.is_treasury) {
        if (member.paused === 1) throw new Error('Enterprise is paused — cannot post offers or needs while paused');
        if (member.status === 'winding_up') throw new Error('Enterprise is winding up — no new listings allowed');
        if (member.status === 'completed') throw new Error('Enterprise has wound up — trading closed');
    }
}

/**
 * Turn whatever a client sent for reach into the two columns, fail-closed (#143 step 4).
 *
 * FAIL-CLOSED MEANS 'local' HERE. Everything unrecognised — a typo, a number, a reach the client invented,
 * `reach: 'peers'` with an empty list — becomes a listing that stays home. The alternative, throwing, would
 * turn a client bug into a member unable to post at all; and the alternative default, letting it travel, would
 * export a listing whose author asked for something we did not understand.
 *
 * `reach: 'peers'` with NO usable peer ids collapses to 'local' rather than being stored as a 'peers' row with
 * an empty list. Both behave identically today, but the collapsed form cannot later be misread as "named peers,
 * we just lost the names" — and it keeps the partial index (which excludes 'local') free of rows that can never
 * be served.
 */
/** The reach currently stored for a post, for an update that changes only the peer list. */
function existingReach(id: string): PostReach {
    const row = db.prepare('SELECT reach FROM posts WHERE id = ?').get(id) as any;
    return (row?.reach ?? 'local') as PostReach;
}

/** The peer list currently stored, for an update that changes only the reach. */
function existingReachPeers(id: string): string[] {
    const row = db.prepare('SELECT reach_peers FROM posts WHERE id = ?').get(id) as any;
    return parseReachPeers(row?.reach_peers);
}

function normaliseReach(rawReach: unknown, rawPeers: unknown): { reach: PostReach; reachPeers: string | null } {
    if (rawReach === 'everywhere') return { reach: 'everywhere', reachPeers: null };
    if (rawReach === 'peers') {
        const peers = Array.isArray(rawPeers)
            ? [...new Set(rawPeers.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map(p => p.trim()))]
            : [];
        if (peers.length === 0) return { reach: 'local', reachPeers: null };
        return { reach: 'peers', reachPeers: JSON.stringify(peers) };
    }
    return { reach: 'local', reachPeers: null };
}

export function createPost(
    broadcast: BroadcastFn,
    type: 'offer' | 'need' | 'poll',
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
    id?: string,
    cashAlsoNeeded?: boolean,
    // #143 step 4. An OPTIONS OBJECT rather than positions 15 and 16: this list is already fourteen
    // positional parameters deep, and `createPost(…, undefined, undefined, 'peers', [id])` at a call site
    // is how the wrong argument ends up in the wrong slot.
    options?: { reach?: unknown; reachPeers?: unknown; createdBy?: string; pollOptions?: Array<{ id: string; text: string }>; durationDays?: number },
): MarketplacePost | null {
    assertMemberActive(authorPublicKey);
    if (!getMember(db, authorPublicKey)) {
        return null;
    }
    assertProfileComplete(authorPublicKey);
    assertNotOnHoliday(authorPublicKey);
    assertEnterpriseCanPost(authorPublicKey);

    let cleanPollOptions: Array<{ id: string; text: string }> | null = null;
    let pollClosesAt: string | null = null;

    if (type === 'poll') {
        const memberRow = db.prepare("SELECT status, credit_frozen FROM members WHERE public_key = ?").get(authorPublicKey) as any;
        if (!memberRow || memberRow.status !== 'active') {
            throw new Error('Only active members can create polls');
        }
        if (memberRow.credit_frozen) {
            throw new Error('Credit-frozen members cannot create polls');
        }

        // Sweep expired polls before rate limit check
        const nowIso = new Date().toISOString();
        db.prepare("UPDATE posts SET status = 'completed', updated_at = ? WHERE type = 'poll' AND status = 'active' AND poll_closes_at <= ?").run(nowIso, nowIso);

        const rawOpts = options?.pollOptions;
        if (!Array.isArray(rawOpts) || rawOpts.length < 2 || rawOpts.length > 4) {
            throw new Error('Polls must have between 2 and 4 options');
        }
        const seenIds = new Set<string>();
        cleanPollOptions = (rawOpts as any[]).map((opt: any, idx: number) => {
            const text = typeof opt === 'string' ? opt.trim() : (typeof opt?.text === 'string' ? opt.text.trim() : '');
            if (!text || text.length > 80) {
                throw new Error('Poll options must be between 1 and 80 characters');
            }
            const rawId = (typeof opt === 'object' && opt?.id) ? String(opt.id).trim() : `opt_${idx + 1}`;
            const optId = /^[a-zA-Z0-9_-]{1,32}$/.test(rawId) ? rawId : `opt_${idx + 1}`;
            if (seenIds.has(optId)) {
                throw new Error(`Duplicate option ID detected: ${optId}`);
            }
            seenIds.add(optId);
            return { id: optId, text };
        });

        const durationDays = options?.durationDays ? Number(options.durationDays) : 7;
        if (![3, 7, 14].includes(durationDays)) {
            throw new Error('Poll duration must be 3, 7, or 14 days');
        }
        pollClosesAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();

        // Enforce poll isolation defaults
        category = 'community';
        credits = 0;
        priceType = 'fixed';
        repeatable = false;
        lat = undefined;
        lng = undefined;
        photos = [];
        cashAlsoNeeded = false;
        options = { ...options, reach: 'local', reachPeers: null };
    } else {
        validatePostPhotos(photos);
    }

    if (type === 'need' && !hasListedOffer(db, authorPublicKey)) throw new Error(CONTRIBUTION_REQUIRED_ERROR);

    const finalId = id || crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const searchKeywords = generateSearchKeywords(title, description, category);
    const { reach, reachPeers } = normaliseReach(options?.reach, options?.reachPeers);

    db.transaction(() => {
        if (type === 'poll') {
            const authorOpen = db.prepare("SELECT COUNT(*) as c FROM posts WHERE author_pubkey = ? AND type = 'poll' AND status = 'active'").get(authorPublicKey) as any;
            if (authorOpen && authorOpen.c >= 1) {
                throw new Error('Rate limit: You can only have 1 active poll at a time');
            }

            const nodeOpen = db.prepare("SELECT COUNT(*) as c FROM posts WHERE type = 'poll' AND status = 'active'").get() as any;
            if (nodeOpen && nodeOpen.c >= 5) {
                throw new Error('Rate limit: Node limit of 5 active polls reached');
            }
        }

        db.prepare(`INSERT INTO posts (
            id, type, category, title, description, credits, price_type, author_pubkey, created_at, active, status, repeatable, lat, lng, updated_at, search_keywords, cash_also_needed, reach, reach_peers, created_by, poll_options, poll_closes_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            finalId, type, category, title, description, credits, priceType, authorPublicKey, createdAt,
            repeatable ? 1 : 0, lat ?? null, lng ?? null, createdAt, searchKeywords,
            cashAlsoNeeded ? 1 : 0, reach, reachPeers, options?.createdBy ?? null,
            cleanPollOptions ? JSON.stringify(cleanPollOptions) : null,
            pollClosesAt
        );

        if (photos && photos.length > 0) {
            const insertPhoto = db.prepare(`INSERT INTO post_photos (post_id, photo_data, order_num) VALUES (?, ?, ?)`);
            photos.slice(0, 5).forEach((p, idx) => insertPhoto.run(finalId, p, idx));
        }
    })();

    // getPosts appends `AND p.id = ?` and posts.id is the primary key, so the row is unique and
    // the old `.find(p => p.id === id)` only re-checked what the SQL already guaranteed.
    bumpPostsVersion();
    const post = getPosts(db, { id: finalId })[0]!;
    broadcast({ type: 'new_post', post });
    try {
        recordActivity('post_created', authorPublicKey, null, { postId: finalId, title, type, category, credits });
    } catch (e) {
        console.warn('[ActivityFeed] Could not record post_created:', e);
    }
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
        db.prepare(`UPDATE deferred_wage_claims SET status = 'cancelled' WHERE post_id = ? AND status = 'pending'`).run(id);
    })();
    if (!removed) return false;
    bumpPostsVersion();
    broadcast({ type: 'post_removed', id });
    return true;
}

export function updatePost(broadcast: BroadcastFn, id: string, authorPublicKey: string, updates: Partial<MarketplacePost> & { pollOptions?: Array<{ id: string; text: string }> }): MarketplacePost | null {
    const existingPost = getPosts(db, { id })[0] ?? null;
    if (!existingPost || existingPost.authorPublicKey !== authorPublicKey) return null;

    if (existingPost.type === 'poll') {
        if (existingPost.status !== 'active') {
            throw new Error('Cannot edit a closed poll');
        }
        const voteCountRow = db.prepare("SELECT COUNT(*) as c FROM poll_votes WHERE post_id = ?").get(id) as any;
        const hasVotes = (voteCountRow?.c || 0) > 0;
        if (hasVotes) {
            if (updates.title !== undefined && updates.title !== existingPost.title) {
                throw new Error('Cannot edit poll question once votes have been cast');
            }
            if (updates.pollOptions !== undefined) {
                throw new Error('Cannot edit poll options once votes have been cast');
            }
        }
        // Enforce poll isolation during updates
        delete updates.credits;
        delete updates.lat;
        delete updates.lng;
        delete updates.photos;
        delete updates.category;
        delete updates.priceType;
        delete updates.repeatable;
        delete updates.cashAlsoNeeded;
        delete updates.reach;
        delete (updates as any).reachPeers;
    }

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
    // The string "false" is truthy, so a stringified payload could never CLEAR the flag.
    // Normalise the same way the create route does.
    if (updates.cashAlsoNeeded !== undefined) { fields.push('cash_also_needed = ?'); values.push((updates.cashAlsoNeeded === true || (updates.cashAlsoNeeded as any) === 'true') ? 1 : 0); }
    if (updates.lat !== undefined) { fields.push('lat = ?'); values.push(updates.lat); }
    if (updates.lng !== undefined) { fields.push('lng = ?'); values.push(updates.lng); }

    if (existingPost.type === 'poll' && updates.pollOptions !== undefined) {
        const rawOpts = updates.pollOptions;
        if (!Array.isArray(rawOpts) || rawOpts.length < 2 || rawOpts.length > 4) {
            throw new Error('Polls must have between 2 and 4 options');
        }
        const seenIds = new Set<string>();
        const cleanPollOptions = (rawOpts as any[]).map((opt: any, idx: number) => {
            const text = typeof opt === 'string' ? opt.trim() : (typeof opt?.text === 'string' ? opt.text.trim() : '');
            if (!text || text.length > 80) {
                throw new Error('Poll options must be between 1 and 80 characters');
            }
            const rawId = (typeof opt === 'object' && opt?.id) ? String(opt.id).trim() : `opt_${idx + 1}`;
            const optId = /^[a-zA-Z0-9_-]{1,32}$/.test(rawId) ? rawId : `opt_${idx + 1}`;
            if (seenIds.has(optId)) {
                throw new Error(`Duplicate option ID detected: ${optId}`);
            }
            seenIds.add(optId);
            return { id: optId, text };
        });
        fields.push('poll_options = ?');
        values.push(JSON.stringify(cleanPollOptions));
    }

    // #143 step 4. BOTH columns always move together, through the same normaliser the create path uses —
    // otherwise switching 'peers' → 'everywhere' would leave a stale peer list behind, and a client sending
    // only `reachPeers` could leave a listing claiming named peers that no longer match the reach.
    // `reachPeers` alone is accepted so a member can edit the named list without restating the reach.
    if (updates.reach !== undefined || (updates as any).reachPeers !== undefined) {
        const nextReach = updates.reach !== undefined ? updates.reach : existingReach(id);
        const norm = normaliseReach(nextReach, (updates as any).reachPeers ?? existingReachPeers(id));
        fields.push('reach = ?'); values.push(norm.reach);
        fields.push('reach_peers = ?'); values.push(norm.reachPeers);
    }

    const now = new Date().toISOString();
    fields.push('updated_at = ?');
    values.push(now);

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

    // getPosts appends `AND p.id = ?` and posts.id is the primary key, so the row is unique and
    // the old `.find(p => p.id === id)` only re-checked what the SQL already guaranteed.
    bumpPostsVersion();
    const updated = getPosts(db, { id, viewerPubkey: authorPublicKey })[0] ?? null;
    if (updated) broadcast({ type: 'post_updated', post: updated });
    return updated;
}

export function closePoll(broadcast: BroadcastFn, postId: string, authorPublicKey: string): MarketplacePost | null {
    const post = getPosts(db, { id: postId })[0];
    if (!post || post.type !== 'poll') {
        throw new Error('Poll not found');
    }
    if (post.authorPublicKey !== authorPublicKey) {
        throw new Error('Only the author can close a poll');
    }
    if (post.status === 'completed') {
        return post;
    }
    const now = new Date().toISOString();
    db.prepare("UPDATE posts SET status = 'completed', updated_at = ? WHERE id = ?").run(now, postId);
    bumpPostsVersion();
    const updated = getPosts(db, { id: postId, viewerPubkey: authorPublicKey })[0] ?? null;
    if (updated) broadcast({ type: 'post_updated', post: updated });
    return updated;
}

export function votePoll(
    broadcast: BroadcastFn,
    postId: string,
    voterPublicKey: string,
    optionId: string,
    signature?: string
): { success: boolean; post: MarketplacePost } {
    assertMemberActive(voterPublicKey);
    const memberRow = db.prepare("SELECT status, credit_frozen FROM members WHERE public_key = ?").get(voterPublicKey) as any;
    if (!memberRow || memberRow.status !== 'active') {
        throw new Error('Only active members can vote in polls');
    }
    if (memberRow.credit_frozen) {
        throw new Error('Credit-frozen members cannot vote in polls');
    }

    const post = getPosts(db, { id: postId })[0];
    if (!post || post.type !== 'poll') {
        throw new Error('Poll not found');
    }
    if (post.status !== 'active') {
        throw new Error('This poll is closed');
    }
    const nowIso = new Date().toISOString();
    if (post.pollClosesAt && post.pollClosesAt <= nowIso) {
        db.prepare("UPDATE posts SET status = 'completed', updated_at = ? WHERE id = ?").run(nowIso, postId);
        bumpPostsVersion();
        throw new Error('This poll is closed');
    }

    const options = post.pollOptions || [];
    const validOption = options.some(opt => opt.id === optionId);
    if (!validOption) {
        throw new Error('Invalid poll option');
    }

    if (signature) {
        try {
            const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex');
            const spki = Buffer.concat([spkiHeader, Buffer.from(voterPublicKey, 'hex')]);
            const publicKeyObject = crypto.createPublicKey({
                key: spki,
                format: 'der',
                type: 'spki'
            });
            const sigBuf = Buffer.from(signature, 'base64');
            const valid = crypto.verify(undefined, Buffer.from(`${postId}:${optionId}`), publicKeyObject, sigBuf)
                || crypto.verify(undefined, Buffer.from(JSON.stringify({ postId, optionId })), publicKeyObject, sigBuf);
            if (!valid) {
                throw new Error('Invalid cryptographic signature for vote');
            }
        } catch (err: any) {
            if (err.message === 'Invalid cryptographic signature for vote') {
                throw err;
            }
            throw new Error('Invalid vote signature format');
        }
    }

    db.transaction(() => {
        // Atomically verify poll is active and bump updated_at for delta sync
        const res = db.prepare(
            "UPDATE posts SET updated_at = ? WHERE id = ? AND status = 'active' AND (poll_closes_at IS NULL OR poll_closes_at > ?)"
        ).run(nowIso, postId, nowIso);
        if (res.changes === 0) {
            throw new Error('This poll is closed');
        }

        db.prepare(`
            INSERT INTO poll_votes (post_id, voter_pubkey, option_id, signature, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(post_id, voter_pubkey) DO UPDATE SET
                option_id = excluded.option_id,
                signature = excluded.signature,
                created_at = excluded.created_at
        `).run(postId, voterPublicKey, optionId, signature || '', nowIso);
    })();

    bumpPostsVersion();
    const updatedPost = getPosts(db, { id: postId, viewerPubkey: voterPublicKey })[0]!;
    broadcast({ type: 'post_updated', post: updatedPost });
    return { success: true, post: updatedPost };
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
type ConservingTxnFn = <T>(fn: () => T) => T;

export function adminDeletePost(broadcast: BroadcastFn, postId: string, transferFn?: TransferFn, conservingTxn?: ConservingTxnFn): boolean {
    let deleted = false;
    const runTx = conservingTxn ? (fn: () => void) => conservingTxn(fn) : (fn: () => void) => db.transaction(fn)();
    runTx(() => {
        if (transferFn) {
            const pending = db.prepare("SELECT * FROM marketplace_transactions WHERE post_id=? AND status='pending'").all(postId) as any[];
            for (const tx of pending) {
                transferFn(`escrow_${tx.id}`, tx.buyer_pubkey, tx.credits, `Escrow refund for removed post`, 'escrow', true);
                db.prepare("UPDATE marketplace_transactions SET status='cancelled', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?").run(tx.id);
            }
        }
        db.prepare("UPDATE marketplace_transactions SET status='cancelled', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE post_id=? AND status='requested'").run(postId);
        const result = db.prepare("UPDATE posts SET active=0, status='cancelled', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?").run(postId);
        if (result.changes > 0) {
            deleted = true;
            db.prepare("UPDATE deferred_wage_claims SET status = 'cancelled' WHERE post_id = ? AND status = 'pending'").run(postId);
        }
    });
    if (!deleted) return false;
    broadcast({ type: 'post_removed', id: postId });
    return true;
}

export function adminBulkDeletePosts(broadcast: BroadcastFn, postIds: string[], transferFn?: TransferFn, conservingTxn?: ConservingTxnFn): number {
    let deletedCount = 0;
    for (const postId of postIds) {
        if (adminDeletePost(broadcast, postId, transferFn, conservingTxn)) {
            deletedCount++;
        }
    }
    return deletedCount;
}

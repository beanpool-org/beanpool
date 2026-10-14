/**
 * "Added you · add back": the people who added a member as a friend lately, on that member's own People tab (phone and
 * web), so an add is no longer silent (PR-B of the connections-in-common design,
 * scratch/global-node/DESIGN-mutual-connections-fable.md §2; Marty chose it, 2026-10-14).
 *
 * A friend row is one-way and needs nobody's consent (engine/social.ts addFriend). A connection in common needs four
 * of them, two each way (state-engine.ts getTrustProfileForViewer), so telling the person added is what lets them add
 * back, and what makes mass-adding visible to everyone it touches. It buys nothing besides: one line each, no push.
 *
 * - The member's own, read with their own signed request (GET /api/friends/added-you). Nobody else's.
 * - New adds only: rows added since this server first told anyone (ADDED_YOU_SINCE_ROW, stamped by the first add or
 *   read after this version starts, so a row from before it never comes back as news), within ADDED_YOU_DAYS.
 * - Gone once they are added back (it is a friendship both ways then), once the member has blocked the adder on this node
 *   (member_blocks; an adder's block of the member changes nothing the member reads, engine/member-blocks.ts), and when the adder is no member here (a visitor, pruned, a replaced key).
 * - Newest first, at most ADDED_YOU_MAX named, with how many more there are. Each adder adds at most
 *   WRITER_LIMITS.friendAddsPerDay people a day (engine/writer-bounds.ts assertMayAddFriendToday).
 */
import { avatarUrlOf } from '@beanpool/core';
import { isNodeMember } from '@beanpool/engine';
import { db } from '../db/db.js';

/** node_config: when this server began telling members who added them (per-server, engine/replication-manifest.ts). */
export const ADDED_YOU_SINCE_ROW = 'friendsAddedYouSince';
/** How long an add stays on the added member's People tab. */
export const ADDED_YOU_DAYS = 30;
/** The most adders named at once; the rest are counted. */
export const ADDED_YOU_MAX = 20;
/** The most rows read for one answer (before the member checks), so a member added by thousands is still one bounded read. */
const ADDED_YOU_SCAN = 500;

export interface AddedYou {
    publicKey: string;
    callsign: string;
    avatarUrl: string | null;
    addedAt: string;
}

/** The stamp, written by whoever asks first (INSERT OR IGNORE, then read back). */
export function addedYouSince(): string {
    db.prepare('INSERT OR IGNORE INTO node_config (key, value) VALUES (?, ?)').run(ADDED_YOU_SINCE_ROW, new Date().toISOString());
    return (db.prepare('SELECT value FROM node_config WHERE key = ?').get(ADDED_YOU_SINCE_ROW) as { value: string }).value;
}

/** Who added `member` lately and hasn't been added back: newest first, at most ADDED_YOU_MAX, and how many more. */
export function getAddedYou(member: string, now = Date.now()): { addedYou: AddedYou[]; more: number } {
    const since = addedYouSince();
    const windowStart = new Date(now - ADDED_YOU_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const rows = db.prepare(`
        SELECT f.owner_pubkey AS publicKey, m.callsign, m.avatar_ref AS avatarRef, f.added_at AS addedAt
          FROM friends f
          JOIN members m ON m.public_key = f.owner_pubkey
         WHERE f.friend_pubkey = ? AND f.owner_pubkey != ?
           AND f.added_at >= ? AND f.added_at >= ?
           AND NOT EXISTS (SELECT 1 FROM friends back WHERE back.owner_pubkey = ? AND back.friend_pubkey = f.owner_pubkey)
           AND NOT EXISTS (SELECT 1 FROM member_blocks b WHERE b.owner_pubkey = ? AND b.blocked_pubkey = f.owner_pubkey)
         ORDER BY f.added_at DESC, f.owner_pubkey
         LIMIT ?`).all(member, member, since, windowStart, member, member, ADDED_YOU_SCAN) as
        { publicKey: string; callsign: string; avatarRef: string | null; addedAt: string }[];
    const adders = rows.filter(r => isNodeMember(db, r.publicKey));
    return {
        addedYou: adders.slice(0, ADDED_YOU_MAX).map(r => ({
            publicKey: r.publicKey,
            callsign: r.callsign,
            avatarUrl: avatarUrlOf(r.publicKey, r.avatarRef),
            addedAt: r.addedAt,
        })),
        more: Math.max(0, adders.length - ADDED_YOU_MAX),
    };
}

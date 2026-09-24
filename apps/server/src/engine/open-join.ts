// The open door (global profile, design §2.2): join with a one-time sign-in instead of an invite.
//
// The route (routes/open-join.ts) checks the request and verifies the sign-in; this file owns what the node
// keeps: the `open_joins` row that makes one sign-in account one identity here, the per-address sign-up limit,
// and the one call that registers a member with no invite. Nothing else in the codebase registers a member with
// `invite_code` NULL: the invite-only refusal in `registerMemberInternal` (both `inviteCode` and `invitedBy`
// null) is untouched, and this path passes it only because it names the door, `invited_by = 'open:<provider>'`.
//
// What is kept about the sign-in account, and what is not:
//   - `join_hash`: HMAC-SHA-256, keyed by a random secret held in this node's `node_config` (`openJoinSalt`),
//     over a domain tag, the provider and the provider's `sub`. Never the raw `sub`, never the email. Keyed per
//     node so two nodes' tables cannot be matched against each other. The key travels with snapshots and sealed
//     backups (it is a node_config row), so a restored node still recognises every account that joined.
//   - `ip_hash`: the same key, its own domain tag, over the limiter's view of the address (an IPv6 client by its
//     /64, client-ip.ts). Only the limiter reads it, and only for a day, so it is cleared once a day old: kept
//     beside a member's key for longer it would be that member's address to anyone holding the database and the
//     key, because the IPv4 space is small enough to try in full.

import crypto from 'node:crypto';
import { db, afterTransactionCommit } from '../db/db.js';
import { getMember, type Member } from '@beanpool/engine';
import { registerMemberInternal } from './members.js';
import type { SsoProvider } from '../sso.js';

/** Sign-ups through the open door per address (design §2.5). Sliding windows over `open_joins`. */
export const OPEN_JOIN_LIMITS = { perHour: 5, perDay: 20 } as const;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The node_config row holding this node's key for both hashes. Created on first use. */
export const OPEN_JOIN_KEY_ROW = 'openJoinSalt';

/** `invited_by` for a member who came in through the open door. The only writer of this prefix is this file. */
export function openJoinInvitedBy(provider: SsoProvider): string {
    return `open:${provider}`;
}

function nodeKey(): Buffer {
    let row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(OPEN_JOIN_KEY_ROW) as { value: string } | undefined;
    if (!row) {
        // INSERT OR IGNORE then read back: whoever wrote first wins, and every caller uses what was written.
        db.prepare('INSERT OR IGNORE INTO node_config (key, value) VALUES (?, ?)')
            .run(OPEN_JOIN_KEY_ROW, crypto.randomBytes(32).toString('base64url'));
        row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(OPEN_JOIN_KEY_ROW) as { value: string };
    }
    const key = Buffer.from(String(row.value), 'base64url');
    // A key edited down to nothing would make every hash guessable, so the door stays shut instead.
    if (key.length < 16) throw new Error(`node_config ${OPEN_JOIN_KEY_ROW} is too short to key the open door`);
    return key;
}

function keyedHash(domain: string, parts: string[]): string {
    // Only the last part can contain '|' (the provider is from a fixed table), so the joined string is unambiguous.
    return crypto.createHmac('sha256', nodeKey()).update([domain, ...parts].join('|'), 'utf-8').digest('base64url');
}

/** What `open_joins.join_hash` holds for a sign-in account. Domain-separated from the recovery lookup hash. */
export function openJoinHash(provider: SsoProvider, sub: string): string {
    return keyedHash('beanpool-open-join/v1', [provider, sub]);
}

/** What `open_joins.ip_hash` holds for an address, given as the limiter's key for it (client-ip.ts). */
export function openJoinAddressHash(limiterKey: string): string {
    return keyedHash('beanpool-open-join-ip/v1', [limiterKey]);
}

/** Clear the address from rows older than a day: past the longest window, the limiter never reads them again. */
export function forgetOldJoinAddresses(now = Date.now()): number {
    return db.prepare('UPDATE open_joins SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND joined_at < ?')
        .run(new Date(now - DAY_MS).toISOString()).changes;
}

let addressSweep: ReturnType<typeof setInterval> | null = null;

/**
 * Clear old addresses on a timer as well as on each join. Otherwise a node nobody joins for a while keeps them
 * past the day, and so does every snapshot and backup taken meanwhile. Every node runs it (the table is on every
 * node, and a node switched back to local still holds what it had). Started by the HTTPS server; calling it again
 * restarts it with the new period, which is how the test shortens it.
 */
export function startForgettingJoinAddresses(everyMs = 60_000): void {
    if (addressSweep) clearInterval(addressSweep);
    addressSweep = setInterval(() => {
        try { forgetOldJoinAddresses(); } catch (e) { console.warn('[OpenJoin] could not clear old join addresses:', (e as Error)?.message || e); }
    }, everyMs);
    addressSweep.unref?.();
}

/** Which window, if any, an address has used up. The day first: when both are, it is the one to wait out. */
export function openJoinLimitReached(ipHash: string, now = Date.now()): 'hour' | 'day' | null {
    const row = db.prepare(`
        SELECT COUNT(*) AS day,
               COALESCE(SUM(CASE WHEN joined_at >= ? THEN 1 ELSE 0 END), 0) AS hour
        FROM open_joins
        WHERE ip_hash = ? AND joined_at >= ?
    `).get(new Date(now - HOUR_MS).toISOString(), ipHash, new Date(now - DAY_MS).toISOString()) as { day: number; hour: number };
    if (row.day >= OPEN_JOIN_LIMITS.perDay) return 'day';
    if (row.hour >= OPEN_JOIN_LIMITS.perHour) return 'hour';
    return null;
}

/**
 * Whether this sign-in account has already joined. `removed` when the member it joined as is gone (pruned) and
 * the row was kept on purpose: removed by the community, or deleted while suspended. That account cannot simply
 * join again. (A member in good standing who deletes their account takes the row with them: releaseOpenJoin.)
 */
export function openJoinTaken(joinHash: string): 'joined' | 'removed' | null {
    const row = db.prepare(`
        SELECT m.status AS status FROM open_joins oj
        LEFT JOIN members m ON m.public_key = oj.member_pubkey
        WHERE oj.join_hash = ?
    `).get(joinHash) as { status: string | null } | undefined;
    if (!row) return null;
    return row.status === 'pruned' ? 'removed' : 'joined';
}

export interface OpenJoinInput {
    /** The key that signed the request. Never a body field. */
    publicKey: string;
    callsign: string;
    /** The provider whose token VERIFIED, not the one the request named. */
    provider: SsoProvider;
    joinHash: string;
    ipHash: string;
}

export type OpenJoinRefusal = 'already_member' | 'already_joined' | 'removed' | 'rate_limited';

export type OpenJoinOutcome =
    | { ok: true; member: Member }
    | { ok: false; reason: OpenJoinRefusal; window?: 'hour' | 'day' };

/**
 * Register a member through the open door, and record the sign-in account that let them in.
 *
 * Every check that decides runs HERE, in one transaction with the writes, after the sign-in was verified: the
 * route's earlier checks exist to refuse fast without spending the member's nonce, but the verification awaits,
 * and another join can land meanwhile. The member row and the `open_joins` row commit together or not at all,
 * so there is never an identity without its sign-in account (which would let that account join again), nor an
 * account marked used with no identity (which would lock it out). The `member_joined` broadcast waits for the
 * commit. What a rollback does not undo is the in-memory ledger's zero-balance account, which moves no sum and
 * is gone at the next boot, as federation-link.ts sets out.
 */
export function registerOpenJoin(broadcast: (event: any) => void, input: OpenJoinInput): OpenJoinOutcome {
    const { publicKey, callsign, provider, joinHash, ipHash } = input;
    return db.transaction((): OpenJoinOutcome => {
        if (getMember(db, publicKey)) return { ok: false, reason: 'already_member' };
        const taken = openJoinTaken(joinHash);
        if (taken === 'removed') return { ok: false, reason: 'removed' };
        if (taken) return { ok: false, reason: 'already_joined' };
        const window = openJoinLimitReached(ipHash);
        if (window) return { ok: false, reason: 'rate_limited', window };

        const member = registerMemberInternal(
            (event) => afterTransactionCommit(() => broadcast(event)),
            publicKey,
            callsign,
            openJoinInvitedBy(provider),
            null,
        );
        // registerMemberInternal refuses only a callsign under two characters, which the route has already
        // refused. Thrown, not returned, so nothing above commits.
        if (!member) throw new Error('open join: registration was refused');
        db.prepare('INSERT INTO open_joins (member_pubkey, provider, join_hash, joined_at, ip_hash) VALUES (?, ?, ?, ?, ?)')
            .run(publicKey, provider, joinHash, new Date().toISOString(), ipHash);
        return { ok: true, member };
    })();
}

/** A member in good standing deleting their own account frees the sign-in account they joined with (purgeMemberSelf). */
export function releaseOpenJoin(publicKey: string): void {
    db.prepare('DELETE FROM open_joins WHERE member_pubkey = ?').run(publicKey);
}

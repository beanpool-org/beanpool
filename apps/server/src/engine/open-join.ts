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
//
// What travels, so a server that takes over still knows who joined (`readOpenJoinRecord`, `writeOpenJoinRecord`):
//   - A file or sealed backup is the whole database: the rows and the key.
//   - Every replication payload to a standby carries the rows changed since its last copy (`SyncPayload.openJoins`,
//     watermarked on `updated_at`, which a join, a release and a re-key all stamp) and the key
//     (`SyncPayload.openJoinSalt`), signed with the rest; the standby merges them as they arrive (engine/sync.ts).
//     A standby promoted by hand has them.
//   - The take-over bundle carries the key and the newest OPEN_JOINS_IN_BUNDLE rows, sealed (services/takeover-
//     envelope.ts), and the take-over's `open-door` step merges them (services/takeover.ts). Not every row: the
//     bundle is re-sealed and re-pulled whenever it changes, and a standby refuses an envelope over 4 MB
//     (services/standby-envelopes.ts), which every row of a busy open door would pass. A take-over only ever runs
//     on a standby, which has every older row from its copies; the bundle covers what its last copy may have missed.
//   - Never `ip_hash`: it is the limiter's for a day and nobody else's, so after a failover the sign-up limits
//     start again.
// A merge keeps, per member, whichever row is newer, and writes only rows whose member is in this database: a row
// for a member this server does not have would lock that sign-in account out of an identity that no longer exists
// here, when joining again gives it back one.

import crypto from 'node:crypto';
import { db, afterTransactionCommit } from '../db/db.js';
import { getMember, type Member, type SyncOpenJoin } from '@beanpool/engine';
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

/** A key this node could hash with: base64url, at least the 16 bytes `nodeKey` insists on. */
function usableKey(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value)
        && Buffer.from(value, 'base64url').length >= 16;
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
 * join again. (A member in good standing who deletes their account frees it: releaseOpenJoin overwrites the hash.)
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

/**
 * Whether a re-key replaced this key, or is replacing it (engine/member-wizards.ts). A replaced key is no member any
 * more, but it is not a newcomer's either: every write it signs is refused (assertMemberActive), so it is refused
 * here too, rather than joined as a second member nobody can use. Both writers of `invalidated_keys` lowercase.
 */
export function openJoinKeyInvalidated(publicKey: string): boolean {
    return !!db.prepare('SELECT 1 FROM invalidated_keys WHERE public_key = ?').get(publicKey.toLowerCase());
}

export interface OpenJoinInput {
    /** The key that signed the request, never a body field. Checked and written in lower case, as the member table keeps keys. */
    publicKey: string;
    callsign: string;
    /** The provider whose token VERIFIED, not the one the request named. */
    provider: SsoProvider;
    joinHash: string;
    ipHash: string;
}

export type OpenJoinRefusal = 'already_member' | 'key_invalidated' | 'already_joined' | 'removed' | 'rate_limited';

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
    const { callsign, provider, joinHash, ipHash } = input;
    // The route already sends the member table's spelling (routes/open-join.ts `canonicalKey`); this keeps the one
    // writer of a door member from ever storing another, so one keypair can never be two members.
    const publicKey = input.publicKey.toLowerCase();
    return db.transaction((): OpenJoinOutcome => {
        if (getMember(db, publicKey)) return { ok: false, reason: 'already_member' };
        if (openJoinKeyInvalidated(publicKey)) return { ok: false, reason: 'key_invalidated' };
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
        const now = new Date().toISOString();
        db.prepare('INSERT INTO open_joins (member_pubkey, provider, join_hash, joined_at, ip_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(publicKey, provider, joinHash, now, ipHash, now);
        return { ok: true, member };
    })();
}

/**
 * A member in good standing deleting their own account frees the sign-in account they joined with (purgeMemberSelf).
 * The join stays on record: only its hash is overwritten, with a random tombstone that `openJoinTaken` never matches
 * (a real hash is base64url, with no ':'). `joined_at` and `ip_hash` still count against the address's limits until
 * the sweep clears the address. Deleting the row gave the sign-up back, so join, delete, join again never reached them.
 */
export function releaseOpenJoin(publicKey: string): void {
    db.prepare("UPDATE open_joins SET join_hash = 'released:' || hex(randomblob(16)), updated_at = ? WHERE member_pubkey = ?")
        .run(new Date().toISOString(), publicKey);
}

// ── What travels ────────────────────────────────────────────────────────────────────────────

/** How many rows the take-over bundle carries, newest first: about 250 bytes each sealed, so about 500 KB. */
export const OPEN_JOINS_IN_BUNDLE = 2_000;

/** The door's record as it travels: this node's key and its rows, without the address hash. */
export interface OpenJoinRecord {
    /** node_config `openJoinSalt`, or null when the door has never hashed anything here. */
    salt: string | null;
    /** Newest change first. */
    joins: SyncOpenJoin[];
    /** How many rows this node holds, however many `joins` carries. */
    total: number;
}

/** This node's key for the door's hashes, or null when it has none. Never creates one. */
export function readOpenJoinSalt(): string | null {
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(OPEN_JOIN_KEY_ROW) as { value?: string } | undefined;
    return row?.value == null ? null : String(row.value);
}

/** The key and the newest `limit` rows (all of them when unset), for the take-over bundle. */
export function readOpenJoinRecord(limit?: number): OpenJoinRecord {
    const rows = db.prepare(`SELECT member_pubkey, provider, join_hash, joined_at, updated_at FROM open_joins
                             ORDER BY COALESCE(updated_at, joined_at) DESC, member_pubkey
                             ${limit === undefined ? '' : 'LIMIT ?'}`)
        .all(...(limit === undefined ? [] : [limit])) as any[];
    const total = (db.prepare('SELECT COUNT(*) AS n FROM open_joins').get() as { n: number }).n;
    return {
        salt: readOpenJoinSalt(),
        joins: rows.map((r) => ({
            memberPubkey: r.member_pubkey, provider: r.provider, joinHash: r.join_hash,
            joinedAt: r.joined_at, updatedAt: r.updated_at || r.joined_at,
        })),
        total,
    };
}

export interface OpenJoinMerge {
    /** The key was written (it was absent or different here). */
    saltWritten: boolean;
    /** Rows written: new here, or newer than the copy here. */
    written: number;
    /** Rows where the copy here was as new or newer. */
    kept: number;
    /** Rows whose member is not in this database. */
    skipped: number;
    /** Rows that were not rows (a field missing or not a string). */
    invalid: number;
}

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/**
 * Merge the door's record from the main server (a replication payload, a take-over bundle) into this database, in
 * one transaction. `salt` undefined leaves the key here alone (a payload from a server older than this), a string
 * replaces it, as the main server's is the one every hash was made with. Each row is kept only when newer than the
 * copy here, and only for a member this database has. `join_hash` is unique here as on the main server, whose rows
 * never share one: a row here with the same hash under another key is the one a re-key has since moved, so when
 * the incoming row is newer it goes, and when it is older the incoming row is the stale one.
 */
export function writeOpenJoinRecord(salt: unknown, joins: unknown): OpenJoinMerge {
    const merge: OpenJoinMerge = { saltWritten: false, written: 0, kept: 0, skipped: 0, invalid: 0 };
    const memberExists = db.prepare('SELECT 1 FROM members WHERE public_key = ?');
    const current = db.prepare('SELECT updated_at FROM open_joins WHERE member_pubkey = ?');
    const sameHash = db.prepare('SELECT member_pubkey, updated_at FROM open_joins WHERE join_hash = ? AND member_pubkey != ?');
    const drop = db.prepare('DELETE FROM open_joins WHERE member_pubkey = ?');
    const upsert = db.prepare(`INSERT INTO open_joins (member_pubkey, provider, join_hash, joined_at, updated_at)
                               VALUES (?, ?, ?, ?, ?)
                               ON CONFLICT(member_pubkey) DO UPDATE SET
                                   provider = excluded.provider, join_hash = excluded.join_hash,
                                   joined_at = excluded.joined_at, updated_at = excluded.updated_at`);
    db.transaction(() => {
        if (usableKey(salt) && salt !== readOpenJoinSalt()) {
            db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
                .run(OPEN_JOIN_KEY_ROW, salt);
            merge.saltWritten = true;
        }
        for (const raw of Array.isArray(joins) ? joins : []) {
            const r = raw as Partial<SyncOpenJoin> | null;
            if (!r || !isText(r.memberPubkey, 128) || !isText(r.provider, 32) || !isText(r.joinHash, 128)
                || !isText(r.joinedAt, 40) || !isText(r.updatedAt, 40)) {
                merge.invalid++;
                continue;
            }
            if (!memberExists.get(r.memberPubkey)) { merge.skipped++; continue; }
            const here = current.get(r.memberPubkey) as { updated_at: string | null } | undefined;
            if (here?.updated_at && here.updated_at >= r.updatedAt) { merge.kept++; continue; }
            const other = sameHash.get(r.joinHash, r.memberPubkey) as { member_pubkey: string; updated_at: string | null } | undefined;
            if (other) {
                if (other.updated_at && other.updated_at > r.updatedAt) { merge.kept++; continue; }
                drop.run(other.member_pubkey);
            }
            upsert.run(r.memberPubkey, r.provider, r.joinHash, r.joinedAt, r.updatedAt);
            merge.written++;
        }
    })();
    return merge;
}

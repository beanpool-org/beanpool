// The open door (global profile, design §2.2): join with a one-time sign-in instead of an invite.
//
// The route (routes/open-join.ts) checks the request and verifies the sign-in; this file owns what the node
// keeps: the `open_joins` row that makes one sign-in account one identity here, the per-address sign-up limit,
// and the one call that registers a member with no invite. Nothing else in the codebase registers a member with
// `invite_code` NULL: the invite-only refusal in `registerMemberInternal` (both `inviteCode` and `invitedBy`
// null) is untouched, and this path passes it only because it names the door, `invited_by = 'open:<provider>'`.
//
// What is kept about the sign-in account, and what is not:
//   - `join_hash`: HMAC-SHA-256, keyed by a random secret kept in a FILE beside this node's database,
//     `data/open-join.key` (services/open-join-key.ts), over a domain tag, the provider and the provider's `sub`. Never
//     the raw `sub`, never the email. Keyed per node so two nodes' tables cannot be matched against each other. The key
//     is never in the database, so no copy of it (a standby's, a snapshot, a plain backup) can test a known `sub`
//     against these rows (report C12). The database records only WHICH key made them (`openJoinKeyId`), so a server
//     without that key refuses a join with a sign-in rather than let an account already here join twice.
//   - `ip_hash`: the same key, its own domain tag, over the limiter's view of the address (an IPv6 client by its
//     /64, client-ip.ts). Only the limiter reads it, and only for a day, so it is cleared once a day old: kept
//     beside a member's key for longer it would be that member's address to anyone holding the database and the
//     key, because the IPv4 space is small enough to try in full.
//   - `join_cohort`: a random label, the same for everyone who joined from one address within a day of each other
//     (`joinCohortFor`). Not the address and not derived from it: what it keeps is only that those members joined from
//     one connection. Auto-hide reads it so that they count as one reporter (engine/auto-moderation.ts). It is cleared
//     with the sign-in account when a member deletes their own account (`releaseOpenJoin`).
//
// What travels, so a server that takes over still knows who joined (`readOpenJoinRecord`, `writeOpenJoinRecord`):
//   - Every replication payload to a standby carries the rows changed since its last copy (`SyncPayload.openJoins`,
//     watermarked on `updated_at`, which a join, a release and a re-key all stamp) and which key made them
//     (`SyncPayload.openJoinKeyId`), signed with the rest; the standby merges them as they arrive (engine/sync.ts).
//     Never the key: a standby holds none, and one promoted by hand keeps the door shut until the key is put back.
//   - The take-over bundle carries the key (a file, services/takeover-envelope.ts BUNDLED_FILES) and the newest
//     OPEN_JOINS_IN_BUNDLE rows, sealed, and the take-over's `open-door` step installs the key and merges the rows
//     (services/takeover.ts). Not every row: the bundle is re-sealed and re-pulled whenever it changes, and a standby
//     refuses an envelope over 4 MB (services/standby-envelopes.ts), which every row of a busy open door would pass. A
//     take-over only ever runs on a standby, which has every older row from its copies; the bundle covers what its
//     last copy may have missed. A sealed backup carries the same bundle, and its restore installs the key too.
//   - A file or plain backup is the database: the rows, never the key. A server restored from one keeps the door shut
//     until the key is back (services/open-join-key.ts).
//   - Never `ip_hash`: it is the limiter's for a day and nobody else's, so after a failover the sign-up limits
//     start again. `join_cohort` travels with its row (both ways above), so a server that takes over still counts
//     reporters who joined from one connection as one.
// A merge keeps, per member, whichever row is newer, and writes only rows whose member is in this database: a row
// for a member this server does not have would lock that sign-in account out of an identity that no longer exists
// here, when joining again gives it back one.

import crypto from 'node:crypto';
import { db, afterTransactionCommit } from '../db/db.js';
import { alreadyJoined, type Member, type SyncOpenJoin } from '@beanpool/engine';
import { registerMemberInternal } from './members.js';
import { isSsoProvider, type SsoProvider } from '../sso.js';
import { openJoinAddressKey, openJoinKey } from '../services/open-join-key.js';

/** Sign-ups through the open door per address (design §2.5). Sliding windows over `open_joins`. */
export const OPEN_JOIN_LIMITS = { perHour: 5, perDay: 20 } as const;

/** Joins from one address within this many hours of each other share a `join_cohort` (`joinCohortFor`). At most a day: `ip_hash` is kept no longer. */
export const JOIN_COHORT_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** `invited_by` for a member who came in through the open door. The only writer of this prefix is this file. */
export function openJoinInvitedBy(provider: SsoProvider): string {
    return `open:${provider}`;
}

function keyedHash(key: Buffer, domain: string, parts: string[]): string {
    // Only the last part can contain '|' (the provider is from a fixed table), so the joined string is unambiguous.
    return crypto.createHmac('sha256', key).update([domain, ...parts].join('|'), 'utf-8').digest('base64url');
}

/**
 * What `open_joins.join_hash` holds for a sign-in account. Domain-separated from the recovery lookup hash. Throws
 * OpenJoinKeyMissing when this server cannot check a sign-in (services/open-join-key.ts): no key, or not the key its
 * records were made with.
 */
export function openJoinHash(provider: SsoProvider, sub: string): string {
    return keyedHash(openJoinKey(), 'beanpool-open-join/v1', [provider, sub]);
}

/**
 * What `open_joins.ip_hash` holds for an address, given as the limiter's key for it (client-ip.ts). This and the two
 * below never throw for want of the door's key (services/open-join-key.ts openJoinAddressKey).
 */
export function openJoinAddressHash(limiterKey: string): string {
    return keyedHash(openJoinAddressKey(), 'beanpool-open-join-ip/v1', [limiterKey]);
}

/**
 * What `join_requests.ip_hash` holds for an address (engine/knocks.ts): the same key, its own domain, so a knock's
 * address and a sign-up's never compare equal.
 */
export function knockAddressHash(limiterKey: string): string {
    return keyedHash(openJoinAddressKey(), 'beanpool-knock-ip/v1', [limiterKey]);
}

/**
 * What `writes_by_address.ip_hash` holds for an address (db/writes-by-address.ts: a stranger's push token or leave, a
 * price report without a member's key): the same key, its own domain again.
 */
export function writeAddressHash(limiterKey: string): string {
    return keyedHash(openJoinAddressKey(), 'beanpool-write-ip/v1', [limiterKey]);
}

/**
 * Clear the address from rows older than a day, the door's and the knocks' (engine/knocks.ts), and the record of where
 * the writes a day cap by address bounds came from (db/writes-by-address.ts): past the longest window, no limiter reads
 * them again. Neither of the first two stamps `updated_at` for it: the hash never travels, and the third is local.
 */
export function forgetOldJoinAddresses(now = Date.now()): number {
    const dayAgo = new Date(now - DAY_MS).toISOString();
    return db.prepare('UPDATE open_joins SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND joined_at < ?').run(dayAgo).changes
        + db.prepare('UPDATE join_requests SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND created_at < ?').run(dayAgo).changes
        + db.prepare('DELETE FROM writes_by_address WHERE made_at < ?').run(dayAgo).changes;
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
 * The label for a join from this address now (`open_joins.join_cohort`): the label of the earliest join from the same
 * address in the last JOIN_COHORT_HOURS, so a chain of joins a day apart or less shares one, or a new random one.
 * Reads `ip_hash`, which is there for a day only, so the window can't be longer than that.
 */
export function joinCohortFor(ipHash: string, now = Date.now()): string {
    const row = db.prepare(`
        SELECT join_cohort FROM open_joins
        WHERE ip_hash = ? AND joined_at >= ? AND join_cohort IS NOT NULL
        ORDER BY joined_at ASC LIMIT 1
    `).get(ipHash, new Date(now - Math.min(JOIN_COHORT_HOURS * HOUR_MS, DAY_MS)).toISOString()) as { join_cohort: string } | undefined;
    return row?.join_cohort ?? crypto.randomUUID();
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
        // A visitor's row joins like anyone new, and registerMemberInternal makes it a member's (alreadyJoined).
        if (alreadyJoined(db, publicKey)) return { ok: false, reason: 'already_member' };
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
        db.prepare('INSERT INTO open_joins (member_pubkey, provider, join_hash, joined_at, ip_hash, updated_at, join_cohort) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(publicKey, provider, joinHash, now, ipHash, now, joinCohortFor(ipHash, Date.parse(now)));
        return { ok: true, member };
    })();
}

/**
 * A member in good standing deleting their own account frees the sign-in account they joined with (purgeMemberSelf).
 * The join stays on record: only its hash is overwritten, with a random tombstone that `openJoinTaken` never matches
 * (a real hash is base64url, with no ':'). `joined_at` and `ip_hash` still count against the address's limits until
 * the sweep clears the address. Deleting the row gave the sign-up back, so join, delete, join again never reached them.
 * Its connection label goes too: who joined alongside a member who has left is nobody's business.
 */
export function releaseOpenJoin(publicKey: string): void {
    db.prepare("UPDATE open_joins SET join_hash = 'released:' || hex(randomblob(16)), join_cohort = NULL, updated_at = ? WHERE member_pubkey = ?")
        .run(new Date().toISOString(), publicKey);
}

// ── What travels ────────────────────────────────────────────────────────────────────────────

/** How many rows the take-over bundle carries, newest first: about 250 bytes each sealed, so about 500 KB. */
export const OPEN_JOINS_IN_BUNDLE = 2_000;

/** The door's record as it travels in the take-over bundle: its rows, without the address hash. Never the key, which is a
 *  bundled file (services/takeover-envelope.ts BUNDLED_FILES). */
export interface OpenJoinRecord {
    /** Newest change first. */
    joins: SyncOpenJoin[];
    /** How many rows this node holds, however many `joins` carries. */
    total: number;
}

/** The newest `limit` rows (all of them when unset), for the take-over bundle. */
export function readOpenJoinRecord(limit?: number): OpenJoinRecord {
    // On the index: the take-over envelope's consistency check reads this every 30 seconds.
    const rows = db.prepare(`SELECT member_pubkey, provider, join_hash, joined_at, updated_at, join_cohort FROM open_joins
                             ORDER BY updated_at DESC ${limit === undefined ? '' : 'LIMIT ?'}`)
        .all(...(limit === undefined ? [] : [limit])) as any[];
    const total = (db.prepare('SELECT COUNT(*) AS n FROM open_joins').get() as { n: number }).n;
    return {
        joins: rows.map((r) => ({
            memberPubkey: r.member_pubkey, provider: r.provider, joinHash: r.join_hash,
            joinedAt: r.joined_at, updatedAt: r.updated_at || r.joined_at, joinCohort: r.join_cohort ?? null,
        })),
        total,
    };
}

export interface OpenJoinMerge {
    /** Rows written: new here, or newer than the copy here. */
    written: number;
    /** Rows where the copy here was as new or newer. */
    kept: number;
    /** Rows whose member is not in this database. */
    skipped: number;
    /** Rows that were not rows (a field missing or not a string), or name a sign-in this server has not got. */
    invalid: number;
}

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/**
 * Merge the door's rows from the main server (a replication payload, a take-over bundle) into this database, in one
 * transaction. The key never comes this way (services/open-join-key.ts). Each row is kept only when newer than the
 * copy here, and only for a member this database has. `join_hash` is unique here as on the main server, whose rows
 * never share one: a row here with the same hash under another key is the one a re-key has since moved, so when
 * the incoming row is newer it goes, and when it is older the incoming row is the stale one. A row naming a provider
 * that is not a sign-in here (GitHub, which no longer is one: engine/github-sign-in-removal.ts) is not stored, so no
 * copy of an older server's record brings one back.
 */
export function writeOpenJoinRecord(joins: unknown): OpenJoinMerge {
    const merge: OpenJoinMerge = { written: 0, kept: 0, skipped: 0, invalid: 0 };
    const memberExists = db.prepare('SELECT 1 FROM members WHERE public_key = ?');
    const current = db.prepare('SELECT updated_at FROM open_joins WHERE member_pubkey = ?');
    const sameHash = db.prepare('SELECT member_pubkey, updated_at FROM open_joins WHERE join_hash = ? AND member_pubkey != ?');
    const drop = db.prepare('DELETE FROM open_joins WHERE member_pubkey = ?');
    const upsert = db.prepare(`INSERT INTO open_joins (member_pubkey, provider, join_hash, joined_at, updated_at, join_cohort)
                               VALUES (?, ?, ?, ?, ?, ?)
                               ON CONFLICT(member_pubkey) DO UPDATE SET
                                   provider = excluded.provider, join_hash = excluded.join_hash,
                                   joined_at = excluded.joined_at, updated_at = excluded.updated_at,
                                   join_cohort = excluded.join_cohort`);
    db.transaction(() => {
        for (const raw of Array.isArray(joins) ? joins : []) {
            const r = raw as Partial<SyncOpenJoin> | null;
            if (!r || !isText(r.memberPubkey, 128) || !isText(r.provider, 32) || !isSsoProvider(r.provider) || !isText(r.joinHash, 128)
                || !isText(r.joinedAt, 40) || !isText(r.updatedAt, 40)
                // A main server from before the label sends none: the row is a circle of its own, as it is there.
                || (r.joinCohort != null && !isText(r.joinCohort, 64))) {
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
            upsert.run(r.memberPubkey, r.provider, r.joinHash, r.joinedAt, r.updatedAt, r.joinCohort ?? null);
            merge.written++;
        }
    })();
    return merge;
}

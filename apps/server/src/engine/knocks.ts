/**
 * "Ask to join" (global node G6, design §3.3): a knock on a local community that any of its members can answer with
 * an invite. The routes are routes/knocks.ts; this file owns the rules and what the node keeps (`join_requests`).
 *
 * Local communities stay invite-only, and anyone can invite (tiers gate nothing), so a knock creates no new authority:
 * a member who answers "Invite" makes an ordinary invite (`generateInvite`), for the applicant's key, and the
 * applicant's app redeems it through today's redeem path. The global node plays no part: the app signs the knock with
 * the applicant's own key (the same key on every node) and sends it to the community itself.
 *
 * ## Who may knock
 *
 * The key that signed the request, in the member table's spelling (lower-case hex). Never a key this community knows
 * as a member (409: they are already in), nor one whose account here was closed (403: pruned by the community, or
 * deleted by its owner; a closed account's key can never be admitted again by an invite, so a knock would lead
 * nowhere), nor one a re-key replaced (403).
 *
 * ## Limits (design §3.3)
 *
 *   - One open knock per key (the partial unique index): another while it is open is 409 `knock_open`.
 *   - A decline blocks the key for KNOCK_RULES.declineBlockDays from the decline, and in that time the applicant is
 *     answered exactly as if the knock were still open (409 `knock_open`; status `pending`): a decline is never a
 *     message ("people are kinder when a no isn't a message").
 *   - KNOCK_RULES.perAddressPerDay knocks from one address in any 24 hours (429), counted over `ip_hash`, which is
 *     the open door's keyed hash with its own domain (engine/open-join.ts) and is cleared once a day old.
 *   - Node-wide, from every address together: KNOCK_RULES.perNodePerDay knocks made in any 24 hours, and
 *     KNOCK_RULES.openAtOnce open at once (what the members' list shows). A key costs nothing to make and neither does
 *     an address (a free IPv6 /48 is 65,536 /64s), so without these one machine could fill the disk. Over either, the
 *     answer is the address limit's own 429, word for word, so a flood can't tell which one it hit. A reopened knock
 *     counts as a new one. The design's other brake, knocks from SSO-verified accounts only, can't be checked here: a
 *     local node gets a bare signed key. These ceilings and the tidy-up below stand in for it. What is left: a flood
 *     can fill both and crowd out genuine knocks for up to a day. Members can still decline, and the operator can
 *     switch knocks off.
 *
 * ## A knock lapses
 *
 * A knock is open for KNOCK_RULES.openDays. Unanswered by then, it leaves the members' list, the applicant's status
 * reads `none`, and they may ask again, which reopens the same row with what they now send. So a knock nobody answers
 * and a knock somebody declined both end the same way for the applicant, "no answer", then free to ask again; the
 * only difference is when (a decline blocks for its 30 days from the decline, a lapse ends 30 days after the knock).
 * An approved knock whose invite expired unused (invites last 30 days) also reads `none`, and the key may ask again.
 *
 * ## The invite admits the applicant's key and no other
 *
 * `generateInvite(approver, applicantKey)` writes an ordinary invite row, made by the approver, with the applicant's
 * key as `intended_for`, and the knock row keeps the code. `redeemInvite` (engine/invites.ts) looks every code up
 * here: a code that answers a knock is refused for any other key than the row's `pubkey`, and for a key a re-key
 * replaced, before anything is written. (`intended_for` alone enforces nothing: on every other invite it is a
 * free-text note for the inviter.)
 *
 * ## A re-key
 *
 * The lost-phone flow (`completeRekey`, engine/member-wizards.ts) moves a member's knocks, and their answers to other
 * people's, to the new key like every other row of theirs (`moveKnocks`). A member's knock is one they made before
 * they joined, by this knock or some other way. Left on the old key, it would be back on the members' list (no member
 * has that key any more) and an approval would let the replaced key in as a second member; a prune or self-deletion
 * would miss what they wrote; and an answer would name a key that is no member, so a standby would not make its invite.
 * The second lock: a key a re-key replaced (`invalidated_keys`) is refused wherever a knock is listed, answered, read or
 * redeemed, whatever put a knock on it.
 *
 * ## Who sees what
 *
 * Members only: the list, the callsign, message, avatar and `fromNode` the applicant sent. The applicant: their own
 * knock's status and, once approved, the invite. Nobody else, and nothing about knocks is in a public read or on the
 * global node. `fromNode` is what the applicant's app says it came from; the node does not check it.
 *
 * ## What is kept, and for how long
 *
 * The members' list is the only thing that reads what an applicant sent (the name, message, picture and node), and it
 * shows open knocks only: the applicant's status read returns the status and the invite, the operator's Settings a
 * count. So once a knock is off the list (answered either way, lapsed, or from a key that has since joined some other
 * way or been replaced), the tidy-up (`tidyKnocks`) clears those four, and who declined it. What stays is what the
 * rules still read: the key, the times, the status, and an approval's invite code and who made it.
 *
 * A row is deleted once it can change no answer:
 *   - declined: when its block is over (declineBlockDays after the decline);
 *   - approved: when its invite can be redeemed nowhere, 30 days after the approval, used or not. A standby's copy of
 *     the invite is never marked used (`mergeReplicatedKnocks`), so until then it is this row that keeps it to the
 *     applicant's key. A key that joined with it is a member: a knock from it is refused as one;
 *   - lapsed: KNOCK_RULES.lapsedKeptDays after it lapsed. Until then a late answer reads "lapsed" and the applicant's
 *     next knock reopens the row; after, the answer is "no such request", and a knock makes a new row.
 * So no row outlives 60 days from when it was made or reopened, and with the ceilings above the table holds at most
 * openAtOnce rows with what was sent in them and 60 × perNodePerDay cleared ones, whatever a flood sends.
 *
 * It is housekeeping, not a request's job: no rule reads whether a row has been cleared (every answer comes from its
 * times and status), so no request needs it done first, and a node nobody knocks on must tidy too. So it runs on a
 * timer (`startTidyingKnocks`, every minute), beside the sweep that already clears these rows' address hashes
 * (engine/open-join.ts), and only on the main server: a standby takes the clearing and the deletions from the copy.
 *
 * ## What travels
 *
 * File and sealed backups carry the table. A standby gets every row (SyncPayload.joinRequests), watermarked on
 * `updated_at`, which every write here stamps, the tidy-up's clearing included. The tidy-up's deletions travel as
 * `join_requests` tombstones keyed by the row's id, which is never used again, so a copied row this database has a
 * tombstone for stays deleted: a stale copy can't bring it back. `ip_hash` never leaves this database. Invite codes do
 * not replicate, so a standby that merges an approved row makes that invite too (the same code, by the same member,
 * for the same key), or a server that takes over would tell the applicant about an invite it cannot redeem
 * (`mergeReplicatedKnocks`).
 */
import crypto from 'node:crypto';
import { db, writeTombstone } from '../db/db.js';
import { getMember, type SyncJoinRequest } from '@beanpool/engine';
import { generateInvite } from './invites.js';
import { forgetOldJoinAddresses, knockAddressHash, openJoinKeyInvalidated } from './open-join.js';
import { getNodeRole } from './sync.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const KNOCK_RULES = {
    /** An unanswered knock is open this long, then lapses (the applicant may ask again). */
    openDays: 30,
    /** A declined knock blocks the key this long from the decline, and reads as still open to the applicant. */
    declineBlockDays: 30,
    /** Knocks from one address in any 24 hours. */
    perAddressPerDay: 3,
    /** Knocks made on this node in any 24 hours, from every address together. A reopened knock counts. */
    perNodePerDay: 30,
    /** Knocks open at once on this node: what the members' list shows. */
    openAtOnce: 50,
    /** A lapsed knock is kept this long after it lapsed, what was sent in it cleared, then deleted. */
    lapsedKeptDays: 30,
    /** The applicant's introduction, in characters (code points). */
    messageChars: 280,
    /** The name the applicant gives, as `/api/invite/redeem` caps a joining name. */
    callsignChars: 20,
    /** An avatar sent as a data URL: the app's are 512 px JPEGs, well under this. */
    avatarChars: 150_000,
} as const;

/** How long an invite lasts: `redeemInvite` refuses one older than this. */
const INVITE_LIFETIME_MS = 30 * DAY_MS;

export type KnockStatus = 'pending' | 'approved' | 'declined';

interface KnockRow {
    id: string;
    pubkey: string;
    callsign: string;
    message: string;
    avatar: string | null;
    from_node: string | null;
    status: KnockStatus;
    created_at: string;
    decided_by: string | null;
    invite_code: string | null;
    decided_at: string | null;
    ip_hash: string | null;
    updated_at: string;
}

const iso = (ms: number) => new Date(ms).toISOString();
const ageMs = (at: string | null, now: number) => now - Date.parse(at ?? '');

function latestKnock(pubkey: string): KnockRow | undefined {
    return db.prepare('SELECT * FROM join_requests WHERE pubkey = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(pubkey) as KnockRow | undefined;
}

/** When the invite on an approved knock stops working, or null when this node has no such invite (or it is gone). */
function inviteExpiry(code: string | null): number | null {
    if (!code) return null;
    const invite = db.prepare('SELECT created_at FROM invite_codes WHERE code = ?').get(code) as { created_at: string } | undefined;
    if (!invite) return null;
    const created = Date.parse(invite.created_at);
    return Number.isFinite(created) ? created + INVITE_LIFETIME_MS : null;
}

/** Whether a pending knock is still open to members (it lapses `openDays` after it was made). */
function isOpen(row: Pick<KnockRow, 'status' | 'created_at'>, now: number): boolean {
    return row.status === 'pending' && ageMs(row.created_at, now) < KNOCK_RULES.openDays * DAY_MS;
}

/**
 * What the members' list shows, as SQL: open knocks from keys that are neither members here nor replaced by a re-key.
 * Its one parameter is the oldest `created_at` still open (`openSince`).
 */
const LISTED = `status = 'pending' AND created_at >= ?
    AND NOT EXISTS (SELECT 1 FROM members m WHERE m.public_key = join_requests.pubkey)
    AND NOT EXISTS (SELECT 1 FROM invalidated_keys i WHERE i.public_key = join_requests.pubkey)`;
const openSince = (now: number) => iso(now - KNOCK_RULES.openDays * DAY_MS);

function listedCount(now: number): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM join_requests WHERE ${LISTED}`).get(openSince(now)) as { n: number }).n;
}

/**
 * What the applicant's latest knock means for them now:
 *   - `waiting`: open, or declined within its block (the applicant can't tell which), so no new knock;
 *   - `invited`: approved with an invite that still works, or that this key has already used;
 *   - `lapsed`: an open knock past `openDays` (the same row reopens on the next knock);
 *   - `free`: none, an expired decline block, or an invite that expired unused (a new row on the next knock).
 */
type Standing =
    | { kind: 'waiting'; row: KnockRow }
    | { kind: 'invited'; row: KnockRow; expiresAt: number | null }
    | { kind: 'lapsed'; row: KnockRow }
    | { kind: 'free' };

function standingOf(row: KnockRow | undefined, now: number): Standing {
    if (!row) return { kind: 'free' };
    if (row.status === 'pending') return isOpen(row, now) ? { kind: 'waiting', row } : { kind: 'lapsed', row };
    if (row.status === 'declined') {
        return ageMs(row.decided_at, now) < KNOCK_RULES.declineBlockDays * DAY_MS ? { kind: 'waiting', row } : { kind: 'free' };
    }
    const expiresAt = inviteExpiry(row.invite_code);
    // Used, by this node's invite row, or by the member row (which replicates): a standby's copy of the invite is made
    // unused (mergeReplicatedKnocks), so after a take-over only the member row knows the applicant joined with it.
    const used = !!db.prepare('SELECT 1 FROM invite_codes WHERE code = ? AND used_by IS NOT NULL').get(row.invite_code)
        || !!db.prepare('SELECT 1 FROM members WHERE public_key = ? AND invite_code = ? COLLATE NOCASE').get(row.pubkey, row.invite_code);
    if (used || (expiresAt !== null && expiresAt > now)) return { kind: 'invited', row, expiresAt };
    return { kind: 'free' };
}

// ── The applicant ────────────────────────────────────────────────────────────────────────────────────────────────

export type KnockRefusal = 'already_member' | 'account_closed' | 'key_invalidated' | 'knock_open' | 'knock_approved' | 'rate_limited';

export interface KnockInput {
    /** The key that signed the knock, lower-case hex. Never a body field. */
    pubkey: string;
    callsign: string;
    message: string;
    avatar: string | null;
    fromNode: string | null;
    /** The limiter's key for the address it came from (client-ip.ts `clientLimiterKey`). */
    address: string;
}

export type KnockOutcome =
    | { ok: true; id: string; reopened: boolean }
    | { ok: false; reason: KnockRefusal };

/** Why this key can't knock at all, whatever its knocks: already a member, a closed account, or a replaced key. */
export function knockerRefusal(pubkey: string): 'already_member' | 'account_closed' | 'key_invalidated' | null {
    const member = getMember(db, pubkey);
    if (member) return member.status === 'pruned' ? 'account_closed' : 'already_member';
    if (openJoinKeyInvalidated(pubkey)) return 'key_invalidated';
    return null;
}

/**
 * Record a knock, or say why not. Every check runs here in one transaction with the write, so two knocks from one key
 * at once can't both land (the partial unique index is the backstop).
 */
export function submitKnock(input: KnockInput, now = Date.now()): KnockOutcome {
    const pubkey = input.pubkey.toLowerCase();
    forgetOldJoinAddresses(now);
    const ipHash = knockAddressHash(input.address);
    try {
        return db.transaction((): KnockOutcome => {
            const refusal = knockerRefusal(pubkey);
            if (refusal) return { ok: false, reason: refusal };
            const standing = standingOf(latestKnock(pubkey), now);
            if (standing.kind === 'waiting') return { ok: false, reason: 'knock_open' };
            if (standing.kind === 'invited') return { ok: false, reason: 'knock_approved' };
            const fromAddress = (db.prepare('SELECT COUNT(*) AS n FROM join_requests WHERE ip_hash = ? AND created_at >= ?')
                .get(ipHash, iso(now - DAY_MS)) as { n: number }).n;
            if (fromAddress >= KNOCK_RULES.perAddressPerDay) return { ok: false, reason: 'rate_limited' };
            // The node-wide ceilings, refused with the same answer. A reopened knock is dated now, so it counts.
            const madeToday = (db.prepare('SELECT COUNT(*) AS n FROM join_requests WHERE created_at >= ?').get(iso(now - DAY_MS)) as { n: number }).n;
            if (madeToday >= KNOCK_RULES.perNodePerDay || listedCount(now) >= KNOCK_RULES.openAtOnce) return { ok: false, reason: 'rate_limited' };

            const at = iso(now);
            if (standing.kind === 'lapsed') {
                db.prepare(`UPDATE join_requests SET callsign = ?, message = ?, avatar = ?, from_node = ?, created_at = ?, ip_hash = ?, updated_at = ?
                            WHERE id = ? AND status = 'pending'`)
                    .run(input.callsign, input.message, input.avatar, input.fromNode, at, ipHash, at, standing.row.id);
                return { ok: true, id: standing.row.id, reopened: true };
            }
            const id = crypto.randomUUID();
            db.prepare(`INSERT INTO join_requests (id, pubkey, callsign, message, avatar, from_node, status, created_at, ip_hash, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
                .run(id, pubkey, input.callsign, input.message, input.avatar, input.fromNode, at, ipHash, at);
            return { ok: true, id, reopened: false };
        })();
    } catch (e: any) {
        // Another knock from this key landed between the check and the write.
        if (String(e?.code ?? '').startsWith('SQLITE_CONSTRAINT') && /join_requests\.pubkey/.test(String(e?.message))) {
            return { ok: false, reason: 'knock_open' };
        }
        throw e;
    }
}

/** What the applicant's app reads (`GET /api/join/knock/status`). A decline in its block reads as `pending`. */
export type KnockStatusAnswer =
    | { status: 'none' }
    | { status: 'pending' }
    | { status: 'approved'; invite: string; expiresAt: string | null };

export function knockStatusFor(pubkey: string, now = Date.now()): KnockStatusAnswer {
    const key = pubkey.toLowerCase();
    // A key a re-key replaced is told nothing, least of all an invite (the route refuses it before this).
    if (openJoinKeyInvalidated(key)) return { status: 'none' };
    const standing = standingOf(latestKnock(key), now);
    switch (standing.kind) {
        case 'waiting': return { status: 'pending' };
        case 'invited': return { status: 'approved', invite: standing.row.invite_code!, expiresAt: standing.expiresAt === null ? null : iso(standing.expiresAt) };
        default: return { status: 'none' };
    }
}

// ── The members ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface OpenKnock {
    id: string;
    /** The applicant's key, which the invite will admit. */
    pubkey: string;
    callsign: string;
    message: string;
    avatar: string | null;
    fromNode: string | null;
    createdAt: string;
}

/** Open knocks from keys that are neither members here nor replaced by a re-key: newest first, and how many in all. */
export function listOpenKnocks(limit: number, offset: number, now = Date.now()): { knocks: OpenKnock[]; total: number } {
    const total = listedCount(now);
    const rows = db.prepare(`SELECT * FROM join_requests WHERE ${LISTED} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(openSince(now), limit, offset) as KnockRow[];
    return {
        knocks: rows.map((r) => ({
            id: r.id, pubkey: r.pubkey, callsign: r.callsign, message: r.message, avatar: r.avatar, fromNode: r.from_node, createdAt: r.created_at,
        })),
        total,
    };
}

/** How many knocks are open, for the operator's Settings. */
export function openKnockCount(now = Date.now()): number {
    return listOpenKnocks(0, 0, now).total;
}

export type AnswerRefusal = 'not_found' | 'answered' | 'lapsed' | 'already_member' | 'key_invalidated';

export type AnswerOutcome =
    | { ok: true; knockId: string; status: 'approved'; invite: { code: string; expiresAt: string } }
    | { ok: true; knockId: string; status: 'declined' }
    | { ok: false; reason: AnswerRefusal };

/** The checks both answers make, on the row as it is inside the answer's transaction. */
function answerable(id: string, now: number): { row: KnockRow } | { reason: AnswerRefusal } {
    const row = db.prepare('SELECT * FROM join_requests WHERE id = ?').get(id) as KnockRow | undefined;
    if (!row) return { reason: 'not_found' };
    if (row.status !== 'pending') return { reason: 'answered' };
    if (!isOpen(row, now)) return { reason: 'lapsed' };
    // They joined some other way meanwhile (a member's invite): there is nothing left to answer.
    if (getMember(db, row.pubkey)) return { reason: 'already_member' };
    // A key a re-key replaced. A re-key moves the knock with the member (`moveKnocks`), so this is the second lock: an
    // invite for the old key would let it back in as a second member, the thing the re-key was for stopping.
    if (openJoinKeyInvalidated(row.pubkey)) return { reason: 'key_invalidated' };
    return { row };
}

/**
 * "Invite": `member` (the signer, a member here, checked by the route) makes an invite for the applicant's key, and
 * the knock records it and who. Both writes commit together or not at all.
 */
export function approveKnock(id: string, member: string, now = Date.now()): AnswerOutcome {
    return db.transaction((): AnswerOutcome => {
        const found = answerable(id, now);
        if ('reason' in found) return { ok: false, reason: found.reason };
        const invite = generateInvite(member, found.row.pubkey);
        // generateInvite refuses only a key with no member row, which the route has ruled out. Thrown, so nothing commits.
        if (!invite) throw new Error('knock approval: the invite could not be made');
        db.prepare(`UPDATE join_requests SET status = 'approved', decided_by = ?, decided_at = ?, invite_code = ?, updated_at = ?
                    WHERE id = ? AND status = 'pending'`)
            .run(member, invite.createdAt, invite.code, invite.createdAt, id);
        const expires = Date.parse(invite.createdAt) + INVITE_LIFETIME_MS;
        return { ok: true, knockId: id, status: 'approved', invite: { code: invite.code, expiresAt: iso(expires) } };
    })();
}

/** "Not now": declined, by `member`. Nothing reaches the applicant; their status reads `pending` for the block. */
export function declineKnock(id: string, member: string, now = Date.now()): AnswerOutcome {
    return db.transaction((): AnswerOutcome => {
        const found = answerable(id, now);
        if ('reason' in found) return { ok: false, reason: found.reason };
        const at = iso(now);
        db.prepare(`UPDATE join_requests SET status = 'declined', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
            .run(member, at, at, id);
        return { ok: true, knockId: id, status: 'declined' };
    })();
}

/**
 * A prune, or the member deleting their own account: what they wrote when they knocked goes (the name, the message,
 * the picture, where they came from). The record stays, so the invite it names still admits only their key. By the
 * member's key: a re-key has moved their knocks to it (`moveKnocks`).
 */
export function scrubKnocksOf(pubkey: string): void {
    db.prepare(`UPDATE join_requests SET callsign = 'Deleted Member', message = '', avatar = NULL, from_node = NULL, updated_at = ?
                WHERE pubkey = ? AND (callsign != 'Deleted Member' OR message != '' OR avatar IS NOT NULL OR from_node IS NOT NULL)`)
        .run(iso(Date.now()), pubkey.toLowerCase());
}

/**
 * A re-key (`completeRekey`, engine/member-wizards.ts, inside its transaction): the member's knocks, and the knocks
 * they answered, move from the old key to the new one, stamped at `at` so a standby gets the move (see "A re-key",
 * above). One knock per key may be open: when the new key has an open one too (the new phone asked to join before the
 * operator re-keyed), the old key's is closed first, declined by nobody (no `decided_by`). The key is a member's now,
 * so neither is ever answered.
 */
export function moveKnocks(oldKey: string, newKey: string, at: string): void {
    const from = oldKey.toLowerCase();
    const to = newKey.toLowerCase();
    db.transaction(() => {
        db.prepare(`UPDATE join_requests SET status = 'declined', decided_at = ?, updated_at = ?
                    WHERE pubkey = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM join_requests o WHERE o.pubkey = ? AND o.status = 'pending')`)
            .run(at, at, from, to);
        db.prepare('UPDATE join_requests SET pubkey = ?, updated_at = ? WHERE pubkey = ?').run(to, at, from);
        db.prepare('UPDATE join_requests SET decided_by = ?, updated_at = ? WHERE decided_by = ?').run(to, at, from);
    })();
}

// ── The tidy-up ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Something on a row that no screen and no rule will read again: anything the applicant sent (a prune's scrub leaves
 * the name 'Deleted Member', which is not theirs), and who declined it. Who approved one is read again: a standby
 * makes the invite in that member's name.
 */
const UNREAD = `(callsign NOT IN ('', 'Deleted Member') OR message != '' OR avatar IS NOT NULL OR from_node IS NOT NULL
    OR (status = 'declined' AND decided_by IS NOT NULL))`;

/**
 * See "What is kept", above: clear what was sent in every knock the members' list no longer shows, and delete every
 * row past each of its windows, with its tombstone, in one transaction. On the main server only (`startTidyingKnocks`).
 */
export function tidyKnocks(now = Date.now()): { cleared: number; deleted: number } {
    const daysAgo = (days: number) => iso(now - days * DAY_MS);
    return db.transaction(() => {
        const past = db.prepare(`SELECT id FROM join_requests
                                 WHERE (status = 'pending' AND created_at < ?)
                                    OR (status = 'declined' AND decided_at < ?)
                                    OR (status = 'approved' AND decided_at < ?)`)
            .all(daysAgo(KNOCK_RULES.openDays + KNOCK_RULES.lapsedKeptDays), daysAgo(KNOCK_RULES.declineBlockDays), iso(now - INVITE_LIFETIME_MS)) as { id: string }[];
        const remove = db.prepare('DELETE FROM join_requests WHERE id = ?');
        for (const { id } of past) {
            remove.run(id);
            writeTombstone('join_requests', id);
        }
        const unread = db.prepare(`SELECT id, updated_at FROM join_requests WHERE ${UNREAD} AND NOT (${LISTED})`)
            .all(openSince(now)) as { id: string; updated_at: string }[];
        const clear = db.prepare(`UPDATE join_requests SET callsign = '', message = '', avatar = NULL, from_node = NULL,
                                      decided_by = CASE WHEN status = 'approved' THEN decided_by END, updated_at = ?
                                  WHERE id = ?`);
        for (const row of unread) {
            // Stamped later than the row's own stamp, even in the millisecond it was answered: a standby keeps its copy
            // on a tie, and would keep the words.
            const stamped = Date.parse(row.updated_at);
            clear.run(iso(Number.isFinite(stamped) && stamped >= now ? stamped + 1 : now), row.id);
        }
        return { cleared: unread.length, deleted: past.length };
    })();
}

let tidyTimer: ReturnType<typeof setInterval> | null = null;

/**
 * The tidy-up on a timer, on the main server only: a standby takes the clearing and the deletions from its copy, and
 * one that takes over starts tidying at the next tick. Started by the HTTPS server beside the address sweep; calling it
 * again restarts it with the new period, which is how the test drives it.
 */
export function startTidyingKnocks(everyMs = 60_000): void {
    if (tidyTimer) clearInterval(tidyTimer);
    tidyTimer = setInterval(() => {
        if (getNodeRole() !== 'primary') return;
        try { tidyKnocks(); } catch (e) { console.warn('[Knocks] could not tidy the requests to join:', (e as Error)?.message || e); }
    }, everyMs);
    tidyTimer.unref?.();
}

// ── What travels ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface KnockMerge { written: number; kept: number; removed: number; invitesMade: number; invalid: number }

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isNullableText = (v: unknown, max: number) => v === null || v === undefined || isText(v, max);
const STATUSES = new Set<string>(['pending', 'approved', 'declined']);

/**
 * The main server's knocks as a copy carries them (SyncPayload.joinRequests), merged into this standby's database in
 * one transaction, oldest change first (so a key's decided knock is written before the newer one that replaced it,
 * which the one-open-knock index needs). A row is written when it is new here or newer than the copy here. For an
 * approved row the standby also makes the invite it names, when it has no such code: the same code, by the member who
 * approved it, for the applicant's key, dated at the approval. Invite codes do not replicate, and a server that takes
 * over must not tell the applicant about an invite it cannot redeem. A row this database has a tombstone for was
 * deleted by the main server's tidy-up, and ids are never used again, so a copy that still carries it is older: it stays
 * deleted (`removed`). A malformed row, or one this database refuses, is left out and counted; it never fails the copy
 * it came in.
 */
export function mergeReplicatedKnocks(rows: unknown): KnockMerge {
    const merge: KnockMerge = { written: 0, kept: 0, removed: 0, invitesMade: 0, invalid: 0 };
    if (!Array.isArray(rows) || rows.length === 0) return merge;
    const current = db.prepare('SELECT updated_at FROM join_requests WHERE id = ?');
    const deleted = db.prepare("SELECT 1 FROM tombstones WHERE table_name = 'join_requests' AND row_key = ?");
    const upsert = db.prepare(`INSERT INTO join_requests (id, pubkey, callsign, message, avatar, from_node, status, created_at, decided_by, invite_code, decided_at, updated_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                               ON CONFLICT(id) DO UPDATE SET
                                   pubkey = excluded.pubkey, callsign = excluded.callsign, message = excluded.message, avatar = excluded.avatar,
                                   from_node = excluded.from_node, status = excluded.status, created_at = excluded.created_at,
                                   decided_by = excluded.decided_by, invite_code = excluded.invite_code, decided_at = excluded.decided_at,
                                   updated_at = excluded.updated_at`);
    const memberExists = db.prepare('SELECT 1 FROM members WHERE public_key = ?');
    const makeInvite = db.prepare('INSERT OR IGNORE INTO invite_codes (code, created_by, created_at, intended_for) VALUES (?, ?, ?, ?)');
    const valid = (rows as unknown[]).filter((raw): raw is SyncJoinRequest => {
        const r = raw as Partial<SyncJoinRequest> | null;
        const ok = !!r && isText(r.id, 64) && isText(r.pubkey, 128) && typeof r.callsign === 'string' && r.callsign.length <= 64
            && typeof r.message === 'string' && r.message.length <= 2_000 && isNullableText(r.avatar, KNOCK_RULES.avatarChars)
            && isNullableText(r.fromNode, 300) && typeof r.status === 'string' && STATUSES.has(r.status)
            && isText(r.createdAt, 40) && isNullableText(r.decidedBy, 128) && isNullableText(r.inviteCode, 64)
            && isNullableText(r.decidedAt, 40) && isText(r.updatedAt, 40);
        if (!ok) merge.invalid++;
        return ok;
    });
    // At the same moment, a decided row before a pending one, then by id: a prune's scrub stamps all of a key's rows
    // with one time, and the old knock must leave the one-open index here before the key's newer open one arrives.
    valid.sort((a, b) => {
        if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1;
        if ((a.status === 'pending') !== (b.status === 'pending')) return a.status === 'pending' ? 1 : -1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    db.transaction(() => {
        for (const r of valid) {
            if (deleted.get(r.id)) { merge.removed++; continue; }
            const here = current.get(r.id) as { updated_at: string } | undefined;
            if (here && here.updated_at >= r.updatedAt) { merge.kept++; continue; }
            try {
                upsert.run(r.id, r.pubkey, r.callsign, r.message, r.avatar ?? null, r.fromNode ?? null, r.status, r.createdAt,
                    r.decidedBy ?? null, r.inviteCode ?? null, r.decidedAt ?? null, r.updatedAt);
                merge.written++;
                if (r.status === 'approved' && r.inviteCode && r.decidedBy && memberExists.get(r.decidedBy)) {
                    merge.invitesMade += makeInvite.run(r.inviteCode, r.decidedBy, r.decidedAt ?? r.updatedAt, r.pubkey).changes;
                }
            } catch (e: any) {
                console.warn(`[Knocks] A copied request to join could not be stored here, left out: ${e?.message || e}`);
                merge.invalid++;
            }
        }
    })();
    return merge;
}

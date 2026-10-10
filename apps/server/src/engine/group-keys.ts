// A group chat's keys, as the node keeps them (group chats step 2; scratch/global-node/DESIGN-group-chat-encryption-
// fable.md §2–§3, §14 and DESIGN-group-chat-wrap-provenance-fable.md §5.3).
//
// Each membership state of a group is an epoch. The member whose action changed the membership makes its key on their
// own phone, wraps it to every active member and signs a record committing to the key, the recipients and the wraps
// (@beanpool/core group-crypto.ts). The node stores the record and the wraps and can open none. What it checks needs no
// key: the record's signature and digests, that its maker is the signed caller and an active member after the change,
// that it is exactly the next epoch, and that it covers exactly the active members (group_key_epochs, group_key_wraps).
//
// The roster an epoch must cover is the group's active rows whose key is a member of this node (isNodeMember): a pruned
// account, a visitor's row or the old key of a re-key is in no epoch. A line is accepted only under the current epoch,
// and only while that epoch is not stale: marked so when the membership changed without a new one, or found so because
// its recipients are no longer the roster. So every line is under a key the current membership holds, and a leaver's
// last key dies at the next line anyone writes.

import { db } from '../db/db.js';
import { isNodeMember } from '@beanpool/engine';
import {
    verifyGroupEpochRecord, verifyGroupTopUp, groupEpochCoversExactly, groupMembersDigest, GroupKeyNotVerifiedError,
    type GroupEpochReason, type GroupEpochRecord, type GroupKeyWrap, type GroupTopUp,
} from '@beanpool/core';

/** How many epochs one GET …/keys answers with at most (the PWA's `?epochs=` list is capped the same). */
export const GROUP_KEYS_PAGE = 100;
/** The mentions a line may declare (§9): more are cut. */
export const GROUP_MENTIONS_MAX = 20;

export type GroupKeyErrorCode =
    | 'epoch_needed' | 'epoch_stale' | 'epoch_not_current' | 'epoch_conflict' | 'epoch_refused' | 'epoch_not_applicable'
    | 'wrap_exists' | 'wrap_below_membership' | 'wrap_refused' | 'not_encrypted';

/** A refusal the routes answer with its status, its code and, for a 409, the epoch and roster the app should use. */
export class GroupKeyError extends Error {
    constructor(public status: 400 | 403 | 404 | 409, public code: GroupKeyErrorCode, message: string, public extra: Record<string, unknown> = {}) {
        super(message);
        this.name = 'GroupKeyError';
    }
}

/** Plain words an old app shows when it sends a readable line into a group chat (§14.2). */
export const GROUP_CHAT_UPDATE_APP = 'Update BeanPool to use this group chat: its messages are now end-to-end encrypted.';

interface EpochRow {
    group_id: string; epoch: number; created_by: string; reason: GroupEpochReason; subject_pubkey: string | null; created_at: string;
    key_commit: string; members_digest: string; wraps_digest: string; sig: string; stored_at: string; stale_since: string | null;
}

/** The active members an epoch of this group must cover, sorted: active rows whose key is a member of this node. */
export function groupKeyRoster(groupId: string): string[] {
    const rows = db.prepare("SELECT member_pubkey FROM group_members WHERE group_id = ? AND status = 'active'").all(groupId) as { member_pubkey: string }[];
    return rows.map((r) => r.member_pubkey).filter((pk) => isNodeMember(db, pk)).sort();
}

function epochRow(groupId: string, epoch: number): EpochRow | undefined {
    return db.prepare('SELECT * FROM group_key_epochs WHERE group_id = ? AND epoch = ?').get(groupId, epoch) as EpochRow | undefined;
}

function currentRow(groupId: string): EpochRow | undefined {
    return db.prepare('SELECT * FROM group_key_epochs WHERE group_id = ? ORDER BY epoch DESC LIMIT 1').get(groupId) as EpochRow | undefined;
}

/** True once a group has any epoch: from then on (and, since step 2, before it too) only locked lines go in. */
export function groupHasEpoch(groupId: string): boolean {
    return !!db.prepare('SELECT 1 FROM group_key_epochs WHERE group_id = ? LIMIT 1').get(groupId);
}

/** The current epoch and whether a line may be sealed under it, or null for a group with none yet. */
export function currentGroupEpoch(groupId: string, roster = groupKeyRoster(groupId)): { epoch: number; stale: boolean } | null {
    const row = currentRow(groupId);
    if (!row) return null;
    return { epoch: row.epoch, stale: row.stale_since !== null || !groupEpochCoversExactly({ membersDigest: row.members_digest }, roster) };
}

/**
 * The first epoch this member may hold (§3, §2.5): group_members.from_epoch, the number the transaction that admitted them
 * wrote (setMembershipFromEpoch; DESIGN-group-chat-epochs-over-time-fable.md §4). It may be past the current epoch ("you
 * hold keys from the next epoch on"). Null for someone not active in the group. Only a row no code wrote has none; it falls
 * back to the first epoch stored at or after joined_at, which compares two clocks' stamps and so is never the rule for a
 * row a join path wrote (review of #1762, confirmation round, finding 1).
 */
export function fromEpochOf(groupId: string, pubkey: string | undefined): number | null {
    if (!pubkey) return null;
    const row = db.prepare(`
        SELECT gm.from_epoch AS f,
               CASE WHEN gm.from_epoch IS NULL THEN
                   (SELECT MIN(e.epoch) FROM group_key_epochs e WHERE e.group_id = gm.group_id AND e.stored_at >= gm.joined_at)
               END AS legacy
        FROM group_members gm WHERE gm.group_id = ? AND gm.member_pubkey = ? AND gm.status = 'active'
    `).get(groupId, pubkey) as { f: number | null; legacy: number | null } | undefined;
    if (!row) return null;
    return row.f ?? row.legacy ?? null;
}

/**
 * Where a membership's keys begin, by number, inside the transaction that made the row active. The row's updated_at
 * moves strictly past the one it holds: left alone, the touch trigger would stamp the clock, which may be behind a stamp
 * membershipWriteAt moved ahead of it (a leave stamped later), and a standby would then take the re-join for older than
 * the leave. Moving it also carries the column to a standby with the row.
 */
export function setMembershipFromEpoch(groupId: string, pubkey: string, fromEpoch: number): void {
    const prev = (db.prepare('SELECT updated_at FROM group_members WHERE group_id = ? AND member_pubkey = ?').get(groupId, pubkey) as { updated_at: string | null } | undefined)?.updated_at ?? null;
    const nowIso = new Date().toISOString();
    const prevMs = prev ? Date.parse(prev) : NaN;
    const at = Number.isFinite(prevMs) && prevMs >= Date.parse(nowIso) ? new Date(prevMs + 1).toISOString() : nowIso;
    db.prepare('UPDATE group_members SET from_epoch = ?, updated_at = ? WHERE group_id = ? AND member_pubkey = ?').run(fromEpoch, at, groupId, pubkey);
}

function activeKeys(groupId: string): string[] {
    return (db.prepare("SELECT member_pubkey FROM group_members WHERE group_id = ? AND status = 'active'").all(groupId) as { member_pubkey: string }[])
        .map((r) => r.member_pubkey);
}

/** What GET /api/groups/:id/chat says about the chat's lock (§14.3): its absence tells an app it talks to an old node. */
export function groupChatEncryption(groupId: string, viewer: string): { current: number | null; stale: boolean; fromEpoch: number | null } {
    const cur = currentGroupEpoch(groupId);
    return { current: cur?.epoch ?? null, stale: cur ? cur.stale : true, fromEpoch: fromEpochOf(groupId, viewer) };
}

/** Mark the current epoch stale (a leaver, a prune, a membership change that carried no epoch). Inside the caller's transaction. */
export function markGroupEpochStale(groupId: string): void {
    db.prepare(`UPDATE group_key_epochs SET stale_since = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE group_id = ? AND stale_since IS NULL AND epoch = (SELECT MAX(epoch) FROM group_key_epochs WHERE group_id = ?)`)
        .run(new Date().toISOString(), groupId, groupId);
}

/** Every group `pubkey` is an active member of has its current epoch marked stale (a prune or an account deletion, §2.3). */
export function markGroupEpochsStaleFor(pubkey: string): void {
    const groups = db.prepare("SELECT group_id FROM group_members WHERE member_pubkey = ? AND status = 'active'").all(pubkey) as { group_id: string }[];
    for (const g of groups) markGroupEpochStale(g.group_id);
}

const MAX_FIELD = 200;

/** The record a request carried, shaped for the core check, or a 400. Nothing else in the body is read. */
function recordFrom(groupId: string, raw: unknown): GroupEpochRecord {
    const r = raw as Record<string, unknown> | null;
    const bad = () => new GroupKeyError(400, 'epoch_refused', 'An epoch record is an object with its wraps and its signature.');
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw bad();
    for (const f of ['createdBy', 'createdAt', 'keyCommit', 'membersDigest', 'wrapsDigest', 'sig', 'reason'] as const) {
        if (typeof r[f] !== 'string' || (r[f] as string).length > MAX_FIELD) throw bad();
    }
    if (r.subject !== null && r.subject !== undefined && typeof r.subject !== 'string') throw bad();
    if (!Array.isArray(r.wraps) || r.wraps.length === 0 || r.wraps.length > 5000) throw bad();
    const wraps: GroupKeyWrap[] = r.wraps.map((w: any) => ({ recipient: w?.recipient, ephPub: w?.ephPub, nonce: w?.nonce, wrapped: w?.wrapped }));
    return {
        groupId, epoch: r.epoch as number, reason: r.reason as GroupEpochReason, subject: (r.subject as string | null | undefined) ?? null,
        createdBy: r.createdBy as string, createdAt: r.createdAt as string, keyCommit: r.keyCommit as string,
        membersDigest: r.membersDigest as string, wrapsDigest: r.wrapsDigest as string, wraps, sig: r.sig as string,
    };
}

/**
 * Check and store the next epoch, inside the caller's transaction, against the membership as it is NOW (after the change
 * the caller just made). Throws GroupKeyError; the caller's transaction then rolls the membership change back with it.
 */
export function storeGroupEpoch(
    groupId: string, actor: string, raw: unknown,
    opts: { allowed: readonly GroupEpochReason[]; subject?: string | null; storedNotBefore?: string | null },
): { epoch: number } {
    const record = recordFrom(groupId, raw);
    if (record.createdBy !== actor) throw new GroupKeyError(403, 'epoch_refused', 'An epoch is made by the member who sends it.');
    if (!opts.allowed.includes(record.reason)) throw new GroupKeyError(400, 'epoch_refused', `This change takes an epoch made for: ${opts.allowed.join(', ')}.`);
    if (opts.subject !== undefined && record.subject !== opts.subject) throw new GroupKeyError(400, 'epoch_refused', 'The epoch names someone else as the member whose membership changed.');
    const roster = groupKeyRoster(groupId);
    const cur = currentRow(groupId);
    const expected = (cur?.epoch ?? 0) + 1;
    const conflict = (why: string) => new GroupKeyError(409, 'epoch_conflict', why, { current: cur?.epoch ?? null, roster });
    if (record.epoch !== expected) throw conflict(`The next epoch is ${expected}.`);
    try {
        verifyGroupEpochRecord(record, { groupId, epoch: expected, activeMembers: roster });
    } catch (e) {
        if (e instanceof GroupKeyNotVerifiedError && /not an active member/.test(e.message)) throw new GroupKeyError(403, 'epoch_refused', e.message, { roster });
        throw new GroupKeyError(400, 'epoch_refused', e instanceof Error ? e.message : 'Epoch record refused.');
    }
    if (!groupEpochCoversExactly(record, roster)) throw conflict("The epoch is not wrapped to exactly this group's active members.");
    const now = new Date().toISOString();
    const storedAt = opts.storedNotBefore && opts.storedNotBefore > now ? opts.storedNotBefore : now;
    db.prepare(`INSERT INTO group_key_epochs (group_id, epoch, created_by, reason, subject_pubkey, created_at, key_commit, members_digest,
                    wraps_digest, sig, stored_at, stale_since, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
        .run(groupId, record.epoch, record.createdBy, record.reason, record.subject, record.createdAt, record.keyCommit,
            record.membersDigest, record.wrapsDigest, record.sig, storedAt, now);
    const wrap = db.prepare(`INSERT INTO group_key_wraps (group_id, epoch, recipient_pubkey, wrapper_pubkey, eph_pub, nonce, wrapped, sig, created_at, updated_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`);
    for (const w of record.wraps!) wrap.run(groupId, record.epoch, w.recipient, record.createdBy, w.ephPub, w.nonce, w.wrapped, now, now);
    return { epoch: record.epoch };
}

/** POST …/keys/epoch, body `{ epoch: <record> }`: a member rotates (reason 'rotate'), or starts a group's first epoch ('start'). */
export function rotateGroupEpoch(groupId: string, actor: string, raw: unknown): { epoch: number } {
    return db.transaction(() => storeGroupEpoch(groupId, actor, raw, { allowed: ['rotate', 'start'], subject: null }))();
}

/**
 * A membership change and its epoch in one transaction (§2.3). With a record: the change, then the record checked against
 * the membership after it; either refused rolls both back. Without one (an old app, a leaver): the change applies and,
 * if it let anyone in or out, the current epoch is marked stale so the next member to write rotates first. Every row the
 * change made active gets its from_epoch by number: the epoch stored here, or the next one when none was (the stale path).
 */
export function withMembershipEpoch<T>(
    groupId: string, actor: string, raw: unknown, change: () => T,
    opts: { allowed: readonly GroupEpochReason[]; subject: string },
): T {
    return db.transaction(() => {
        const before = groupKeyRoster(groupId).join(',');
        const activeBefore = new Set(activeKeys(groupId));
        const next = (currentRow(groupId)?.epoch ?? 0) + 1;
        const res = change();
        const changed = groupKeyRoster(groupId).join(',') !== before;
        let fromEpoch = next;
        if (raw !== undefined && raw !== null) {
            if (!changed) throw new GroupKeyError(400, 'epoch_not_applicable', 'This change lets nobody in or out of the chat, so it takes no new key.');
            // stored_at is informational since from_epoch (§4), but it is still never stamped before the joiner's joined_at,
            // which groups.ts membershipWriteAt can move ahead of the clock (review of #1762, finding 6).
            const joinedAt = (db.prepare("SELECT joined_at FROM group_members WHERE group_id = ? AND member_pubkey = ? AND status = 'active'")
                .get(groupId, opts.subject) as { joined_at: string } | undefined)?.joined_at ?? null;
            fromEpoch = storeGroupEpoch(groupId, actor, raw, { ...opts, storedNotBefore: joinedAt }).epoch;
        } else if (changed) {
            markGroupEpochStale(groupId);
        }
        for (const pk of activeKeys(groupId)) if (!activeBefore.has(pk)) setMembershipFromEpoch(groupId, pk, fromEpoch);
        return res;
    })();
}

/** POST …/keys/wrap (§2.5, provenance §6): a member hands a key they hold to a member who lacks a wrap for it. */
export function storeGroupTopUp(groupId: string, actor: string, body: any): { epoch: number; recipient: string } {
    const t: GroupTopUp = {
        epoch: body?.epoch, recipient: body?.recipient, wrapper: actor, ephPub: body?.ephPub, nonce: body?.nonce, wrapped: body?.wrapped, sig: body?.sig,
    };
    return db.transaction(() => {
        const roster = groupKeyRoster(groupId);
        try {
            verifyGroupTopUp(groupId, t, { activeMembers: roster });
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Top-up refused.';
            throw new GroupKeyError(/not an active member/.test(msg) ? 403 : 400, 'wrap_refused', msg);
        }
        if (!epochRow(groupId, t.epoch)) throw new GroupKeyError(404, 'wrap_refused', 'This group has no such epoch.');
        const from = fromEpochOf(groupId, t.recipient);
        if (from === null || t.epoch < from) {
            throw new GroupKeyError(403, 'wrap_below_membership', 'Nobody is handed a key from before their membership began.');
        }
        if (db.prepare('SELECT 1 FROM group_key_wraps WHERE group_id = ? AND epoch = ? AND recipient_pubkey = ?').get(groupId, t.epoch, t.recipient)) {
            throw new GroupKeyError(409, 'wrap_exists', 'This member already holds a wrap for this epoch.');
        }
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO group_key_wraps (group_id, epoch, recipient_pubkey, wrapper_pubkey, eph_pub, nonce, wrapped, sig, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(groupId, t.epoch, t.recipient, actor, t.ephPub, t.nonce, t.wrapped, t.sig, now, now);
        return { epoch: t.epoch, recipient: t.recipient };
    })();
}

/** An epoch record as GET …/keys serves it: no wraps (provenance §5.3). */
function servedEpoch(r: EpochRow, current: { epoch: number; stale: boolean } | null) {
    return {
        epoch: r.epoch, createdBy: r.created_by, reason: r.reason, subject: r.subject_pubkey, createdAt: r.created_at,
        keyCommit: r.key_commit, membersDigest: r.members_digest, wrapsDigest: r.wraps_digest, sig: r.sig,
        stale: r.stale_since !== null || (current?.epoch === r.epoch && current.stale),
    };
}

/**
 * GET …/keys: the epochs this member may hold (from their fromEpoch), each record without its wraps, and only their own
 * wraps. `after` (the phone's incremental sync) and `epochs` (the PWA: current plus the epochs of the lines it loaded)
 * bound the answer to GROUP_KEYS_PAGE epochs.
 */
export function getGroupKeys(groupId: string, viewer: string, q: { after?: number; epochs?: number[] } = {}) {
    const roster = groupKeyRoster(groupId);
    const current = currentGroupEpoch(groupId, roster);
    const fromEpoch = fromEpochOf(groupId, viewer);
    let rows: EpochRow[] = [];
    if (fromEpoch !== null) {
        if (q.epochs && q.epochs.length > 0) {
            const wanted = [...new Set(q.epochs)].filter((e) => e >= fromEpoch).slice(0, GROUP_KEYS_PAGE);
            rows = wanted.length === 0 ? [] : db.prepare(`SELECT * FROM group_key_epochs WHERE group_id = ? AND epoch IN (${wanted.map(() => '?').join(',')}) ORDER BY epoch`)
                .all(groupId, ...wanted) as EpochRow[];
        } else {
            rows = db.prepare('SELECT * FROM group_key_epochs WHERE group_id = ? AND epoch >= ? AND epoch > ? ORDER BY epoch LIMIT ?')
                .all(groupId, fromEpoch, q.after ?? 0, GROUP_KEYS_PAGE) as EpochRow[];
        }
    }
    const epochList = rows.map((r) => r.epoch);
    const myWraps = epochList.length === 0 ? [] : (db.prepare(`
        SELECT epoch, wrapper_pubkey, eph_pub, nonce, wrapped, sig FROM group_key_wraps
        WHERE group_id = ? AND recipient_pubkey = ? AND epoch IN (${epochList.map(() => '?').join(',')}) ORDER BY epoch
    `).all(groupId, viewer, ...epochList) as any[]).map((w) => ({ epoch: w.epoch, wrapper: w.wrapper_pubkey, ephPub: w.eph_pub, nonce: w.nonce, wrapped: w.wrapped, sig: w.sig ?? null }));
    return {
        current: current?.epoch ?? null,
        stale: current ? current.stale : true,
        fromEpoch,
        roster,
        epochs: rows.map((r) => servedEpoch(r, current)),
        myWraps,
        more: rows.length === GROUP_KEYS_PAGE,
    };
}

/** GET …/keys/missing (§2.5): the active members who lack a wrap for an epoch since their fromEpoch, and which. */
export function getMissingGroupWraps(groupId: string) {
    const roster = groupKeyRoster(groupId);
    const cur = currentRow(groupId);
    const missing: { pubkey: string; fromEpoch: number; epochs: number[] }[] = [];
    if (cur) {
        for (const pk of roster) {
            const from = fromEpochOf(groupId, pk);
            if (from === null) continue;
            const lacking = (db.prepare(`
                SELECT e.epoch FROM group_key_epochs e
                WHERE e.group_id = ? AND e.epoch >= ?
                  AND NOT EXISTS (SELECT 1 FROM group_key_wraps w WHERE w.group_id = e.group_id AND w.epoch = e.epoch AND w.recipient_pubkey = ?)
                ORDER BY e.epoch LIMIT ?
            `).all(groupId, from, pk, GROUP_KEYS_PAGE) as { epoch: number }[]).map((r) => r.epoch);
            if (lacking.length > 0) missing.push({ pubkey: pk, fromEpoch: from, epochs: lacking });
        }
    }
    return { epoch: cur?.epoch ?? null, missing };
}

/**
 * GET …/keys/:epoch/wraps (provenance §5.3): one epoch's wraps in full, for a member settling whose wrap was wrong by
 * checking wrapsDigest. Not before the viewer's own fromEpoch.
 */
export function getGroupEpochWraps(groupId: string, viewer: string, epoch: number) {
    const from = fromEpochOf(groupId, viewer);
    const row = epochRow(groupId, epoch);
    if (!row || from === null || epoch < from) throw new GroupKeyError(404, 'wrap_refused', 'No such epoch for you in this group.');
    const wraps = (db.prepare('SELECT recipient_pubkey, wrapper_pubkey, eph_pub, nonce, wrapped, sig FROM group_key_wraps WHERE group_id = ? AND epoch = ? ORDER BY recipient_pubkey')
        .all(groupId, epoch) as any[]).map((w) => ({ recipient: w.recipient_pubkey, wrapper: w.wrapper_pubkey, ephPub: w.eph_pub, nonce: w.nonce, wrapped: w.wrapped, sig: w.sig ?? null }));
    return { epoch, wrapsDigest: row.wraps_digest, membersDigest: row.members_digest, wraps };
}

/**
 * The node's keyless check of a line's epoch (Appendix B): it names the current epoch, and that epoch is not stale.
 * Throws GroupKeyError 409 with what the app needs to rotate or retry.
 */
export function assertLineEpochIsCurrent(groupId: string, epoch: unknown): number {
    const roster = groupKeyRoster(groupId);
    const cur = currentGroupEpoch(groupId, roster);
    if (!cur) throw new GroupKeyError(409, 'epoch_needed', "This group's chat has no key yet: make its first epoch, then send.", { current: null, roster });
    if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch !== cur.epoch) {
        throw new GroupKeyError(409, 'epoch_not_current', `Lines go under the current epoch, ${cur.epoch}.`, { current: cur.epoch, stale: cur.stale, roster });
    }
    if (cur.stale) throw new GroupKeyError(409, 'epoch_stale', "The group's membership changed since this key was made: rotate, then send.", { current: cur.epoch, stale: true, roster });
    return cur.epoch;
}

/** The mentions a line declared (§9), as the node keeps them: active members of the group, not the author, at most 20. */
export function filterDeclaredMentions(groupId: string, author: string, declared: unknown): string[] {
    if (!Array.isArray(declared)) return [];
    const roster = new Set(groupKeyRoster(groupId));
    const out: string[] = [];
    for (const pk of declared) {
        if (typeof pk !== 'string' || pk === author || !roster.has(pk) || out.includes(pk)) continue;
        out.push(pk);
        if (out.length >= GROUP_MENTIONS_MAX) break;
    }
    return out;
}

/** A re-key (engine/key-move.ts): the old key's wraps can never open again, so they go (§6); the member shows as missing. */
export function dropGroupWrapsOf(oldKey: string): void {
    db.prepare('DELETE FROM group_key_wraps WHERE recipient_pubkey = ?').run(oldKey);
}

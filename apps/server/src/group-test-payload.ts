/**
 * A group chat line as the apps send one since group chats step 2: sealed on a member's phone under the group's current
 * epoch, 'group-xc20p-v1:' + a 24-byte nonce, with { epoch } in its metadata (engine/group-keys.ts, engine/group-thread.ts).
 * The node refuses any other form into a group chat, so a suite that needs a group line sends one of these. The bytes are
 * random: the node never holds the key, so it cannot tell them from a real sealed line, and a suite needs no key either.
 *
 * A suite's members are random hex with no private key, so they cannot sign an epoch record. freshGroupEpoch writes the
 * group's next epoch row straight into its table, covering the roster exactly as a member's app would after a rotation:
 * what the epoch checks themselves need is proved by test-group-keys-http.ts with real keys.
 *
 * The database is passed in, never imported: suites set BEANPOOL_DATA_DIR before they load it (dm-test-payload.ts).
 */
import crypto from 'node:crypto';
import { groupMembersDigest } from '@beanpool/core';
import { isNodeMember } from '@beanpool/engine';
import type Database from 'better-sqlite3';

const GROUP_NONCE_PREFIX = 'group-xc20p-v1:';
type Db = Database.Database;

/** Sealed-line bytes, shape only: `bytes` of ciphertext (at least the 82 of the smallest sealed line) and a 24-byte nonce. */
export function lockedGroupBytes(bytes = 120): { ciphertext: string; nonce: string } {
    return {
        ciphertext: crypto.randomBytes(Math.max(82, bytes)).toString('base64'),
        nonce: GROUP_NONCE_PREFIX + crypto.randomBytes(24).toString('base64'),
    };
}

/** The group's roster for its keys (engine/group-keys.ts groupKeyRoster), sorted. */
function rosterOf(db: Db, groupId: string): string[] {
    return (db.prepare("SELECT member_pubkey FROM group_members WHERE group_id = ? AND status = 'active'").all(groupId) as { member_pubkey: string }[])
        .map((r) => r.member_pubkey).filter((pk) => isNodeMember(db, pk)).sort();
}

/** The group's current epoch if a line may go under it, else a new one covering today's roster (what an app's rotate does). */
export function freshGroupEpoch(db: Db, groupId: string): number {
    const roster = rosterOf(db, groupId);
    const digest = groupMembersDigest(roster);
    const cur = db.prepare('SELECT epoch, members_digest, stale_since FROM group_key_epochs WHERE group_id = ? ORDER BY epoch DESC LIMIT 1')
        .get(groupId) as { epoch: number; members_digest: string; stale_since: string | null } | undefined;
    if (cur && cur.stale_since === null && cur.members_digest === digest) return cur.epoch;
    const epoch = (cur?.epoch ?? 0) + 1;
    const now = new Date().toISOString();
    const b = () => crypto.randomBytes(32).toString('base64');
    db.prepare(`INSERT INTO group_key_epochs (group_id, epoch, created_by, reason, subject_pubkey, created_at, key_commit, members_digest,
                    wraps_digest, sig, stored_at, stale_since, updated_at)
                VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?)`)
        .run(groupId, epoch, roster[0] ?? 'SYSTEM', epoch === 1 ? 'start' : 'rotate', now, b(), digest, b(), crypto.randomBytes(64).toString('base64'), now, now);
    return epoch;
}

/**
 * A sealed line under the group's current (fresh) epoch, with the id it was sealed under: `clientId` as
 * POST /api/groups/:id/chat/message and the engine take it, the same as `id` for POST /api/messages/send.
 */
export function lockedGroupLine(db: Db, groupId: string, extra: { replyToId?: string; mentions?: string[]; bytes?: number } = {}): { ciphertext: string; nonce: string; metadata: string; clientId: string; id: string } {
    const meta: Record<string, unknown> = { epoch: freshGroupEpoch(db, groupId) };
    if (extra.replyToId) meta.replyToId = extra.replyToId;
    if (extra.mentions) meta.mentions = extra.mentions;
    const id = crypto.randomUUID();
    return { ...lockedGroupBytes(extra.bytes), metadata: JSON.stringify(meta), clientId: id, id };
}

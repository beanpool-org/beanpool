// A member's key replaced by a re-key (engine/member-wizards.ts completeRekey): every row that names the old key names the
// new one, on the main server when the re-key completes, and on its standby when the copy that carries it arrives.
//
// A leaf module (the database and nothing else), so the standby's import (engine/sync.ts) and the re-key share one list.

import { db } from '../db/db.js';

// ── both ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether a table has an `updated_at` stamp, by table. The schema is fixed once the boot's migrations have run. */
const stamped = new Map<string, boolean>();
function hasStamp(table: string): boolean {
    let has = stamped.get(table);
    if (has === undefined) {
        has = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === 'updated_at');
        stamped.set(table, has);
    }
    return has;
}

/**
 * Every row that names the old key names the new one: the whole re-key but the old key's own `invalidated_keys` row,
 * the re-key's bookkeeping, and what the main server moves by rules of its own (the recovery copies, which it wraps
 * again; place watches, knocks and kept notices), each stamped there so a standby's copy carries the move.
 *
 * On the main server (`keepStamps: false`), inside completeRekey's conservingTransaction: each row is stamped as any
 * change is (the touch triggers, db/schema.sql), so a standby's next copy carries the move. `at` stamps the member's own
 * row and their open-door record.
 *
 * On a standby following its main server's re-key (`keepStamps: true`, {@link followReplicatedRekeys}), inside the
 * import's transaction: each moved row keeps the stamp it had. The main server's own rows, stamped by its move, come in
 * the same copy and win, with whatever else changed on them there. Stamped here with this server's clock, a row would
 * outrank every change the main server made to it before that time (a delta copy keeps the newer stamp), and the copy
 * would keep this one. The rows the main server does not stamp when it moves them (transactions, ratings, votes,
 * RSVPs, settlements, channels…) no copy ever sends again: the move here is the only one they get.
 *
 * Moves no Beans: `accounts` changes key, never balance, so conservation holds as it did.
 */
export function moveMemberKeyRows(oldKey: string, newKey: string, at: string, opts: { keepStamps: boolean }): void {
    const keepStamps = opts.keepStamps;
    /** `table.column` from the old key to the new, on the rows `where` (SQL, no parameters) also picks. */
    const move = (table: string, column: string, where?: string): void => {
        const cond = where ? `${column} = ? AND (${where})` : `${column} = ?`;
        const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${cond}`);
        if (!keepStamps || !hasStamp(table)) {
            update.run(newKey, oldKey);
            return;
        }
        // The touch triggers stamp any row an UPDATE leaves `updated_at` alone on, so each stamp is put back after. An
        // UPDATE of `updated_at` to another value fires none of them (`WHEN NEW.updated_at IS OLD.updated_at`), and the
        // members one fires only for its listed columns, which `updated_at` is not.
        const before = db.prepare(`SELECT rowid AS r, updated_at AS u FROM ${table} WHERE ${cond}`).all(oldKey) as { r: number; u: string | null }[];
        update.run(newKey, oldKey);
        const restore = db.prepare(`UPDATE ${table} SET updated_at = ? WHERE rowid = ? AND updated_at IS NOT ?`);
        for (const b of before) restore.run(b.u, b.r, b.u);
    };

    // (a) members row itself - update primary key and restore active status, unless the member is
    // suspended ('disabled'): a new key does not lift a suspension
    if (keepStamps) {
        const stamp = (db.prepare('SELECT updated_at FROM members WHERE public_key = ?').get(oldKey) as { updated_at: string | null } | undefined)?.updated_at ?? null;
        db.prepare("UPDATE members SET public_key = ?, status = CASE WHEN status = 'disabled' THEN 'disabled' ELSE 'active' END WHERE public_key = ?").run(newKey, oldKey);
        db.prepare('UPDATE members SET updated_at = ? WHERE public_key = ?').run(stamp, newKey);
    } else {
        db.prepare("UPDATE members SET public_key = ?, status = CASE WHEN status = 'disabled' THEN 'disabled' ELSE 'active' END, updated_at = ? WHERE public_key = ?").run(newKey, at, oldKey);
    }

    // (b) members foreign keys (referrals & vouches)
    move('members', 'invited_by');
    move('members', 'elder_vouched_by');

    // (c) accounts (ledger balance & epochs)
    move('accounts', 'public_key');

    // (d) transactions - preserve immutable cryptographic authorship
    move('transactions', 'from_pubkey');
    move('transactions', 'to_pubkey');
    // Note: auth_signer is left untouched because auth_signature was produced by the old key's private key

    // (e) marketplace_transactions
    move('marketplace_transactions', 'buyer_pubkey');
    move('marketplace_transactions', 'seller_pubkey');
    move('marketplace_transactions', 'dispute_resolved_by');

    // (f) posts
    move('posts', 'author_pubkey');
    move('posts', 'accepted_by');
    move('posts', 'created_by');
    // Who may read a post addressed to one member, and who does a task (engine/posts.ts): left on the old key, the
    // member could read neither on the new one.
    move('posts', 'target_pubkey');
    move('posts', 'assigned_to');

    // (g) poll_votes
    move('poll_votes', 'voter_pubkey');
    move('event_rsvps', 'member_pubkey');

    // (h) conversations & participants
    move('conversations', 'created_by');
    move('conversation_participants', 'public_key');

    // (i) messages
    move('messages', 'author_pubkey');

    // (j) friends & ratings
    move('friends', 'owner_pubkey');
    move('friends', 'friend_pubkey');
    move('ratings', 'target_pubkey');
    move('ratings', 'rater_pubkey');

    // (k) abuse_reports
    move('abuse_reports', 'reporter_pubkey');
    move('abuse_reports', 'target_pubkey');

    // (l) projects / enterprises
    move('projects', 'creator_pubkey');
    move('projects', 'enterprise_pubkey');

    // (m) invite_codes
    move('invite_codes', 'created_by');
    move('invite_codes', 'used_by');

    // (n) push_tokens (Purge old device tokens as device was lost)
    db.prepare('DELETE FROM push_tokens WHERE public_key = ?').run(oldKey);

    // (o) member_preferences
    move('member_preferences', 'public_key');
    move('chat_mutes', 'member_pubkey');
    db.prepare('UPDATE OR IGNORE thread_read_cursors SET member_pubkey = ? WHERE member_pubkey = ?').run(newKey, oldKey);
    db.prepare('DELETE FROM thread_read_cursors WHERE member_pubkey = ?').run(oldKey);

    // (o2) Commons groups: membership (and so the group's chat), the lead convenor, and convenor votes.
    // groups.lead_pubkey and groups.created_by both decide authorisation (the lead is the stored pointer
    // while it names an active convenor, and the creator is the backfill branch behind it). Leave either on
    // the invalidated key and a lead who recovers on a new key silently stops being the lead: the next
    // reconcile writes somebody else in for good, and the hand-over has been reversed by nobody's decision.
    move('groups', 'lead_pubkey');
    move('groups', 'created_by');
    move('group_members', 'member_pubkey');
    move('group_members', 'invited_by');
    move('group_convenor_proposals', 'convenor_pubkey');
    move('group_convenor_proposals', 'candidate_pubkey');
    move('group_convenor_proposals', 'proposer_pubkey');
    move('group_convenor_votes', 'voter_pubkey');

    // (p) recovery collections / releases (the recovery copies themselves: completeRekey, and on a standby
    // dropMovedRecoveryCopies)
    move('recovery_collections', 'owner_pubkey');
    move('recovery_releases', 'released_by');
    // The sign-in account the member joined with through the open door (engine/open-join.ts). Left on the
    // invalidated key, deleting the account would free nothing and a removal would read as still joined.
    // Stamped on the main server, so the move replicates (engine/open-join.ts).
    if (keepStamps) {
        move('open_joins', 'member_pubkey');
    } else {
        db.prepare('UPDATE open_joins SET member_pubkey = ?, updated_at = ? WHERE member_pubkey = ?').run(newKey, at, oldKey);
    }

    // (q) treasury_operators (Keeperships)
    move('treasury_operators', 'member_pubkey');
    move('treasury_operators', 'treasury_pubkey');
    move('treasury_operators', 'granted_by');

    // (r) node_roles (Governance: Owner, Admin, Moderator)
    move('node_roles', 'member_pubkey');
    move('node_roles', 'granted_by');
    // A role held aside while the member is suspended moves with the key, or lifting the suspension
    // would restore it to a key nobody holds.
    move('suspended_node_roles', 'member_pubkey');
    move('suspended_node_roles', 'granted_by');

    // (s) deferred_wage_claims
    move('deferred_wage_claims', 'keeper_pubkey');
    move('deferred_wage_claims', 'enterprise_pubkey');

    // (t) settlements
    move('settlements', 'buyer_pubkey');
    move('settlements', 'seller_pubkey');

    // (u) federation_links
    // KNOWN LIMITATION (federation key propagation):
    // Remote peer nodes retain the member's former public key in their cached member tables
    // and federation_links until peer-to-peer key rotation gossip is implemented. Consequently,
    // cross-village trust validation and settlements will fail verification against the new key.
    // Trades with other villages will need re-linking on peer nodes.
    move('federation_links', 'treasury_pubkey');

    // (v) activity_feed
    move('activity_feed', 'actor_pubkey');
    move('activity_feed', 'target_pubkey');

    // (w) pricing_reports
    move('pricing_reports', 'reporter_pubkey');

    // (x) creator_channels & pulse_items
    move('creator_channels', 'owner_pubkey');
    move('pulse_items', 'owner_pubkey');

    // (y) decisions & votes - update subject for member proposals and pool hardship grants
    move('decisions', 'author_pubkey');
    move('decisions', 'admin_halted_by');
    move('decisions', 'subject', "touches = 'member' OR touches = 'pool'");
    move('decision_votes', 'voter_pubkey');

    // (z) enterprise_pledges
    move('enterprise_pledges', 'keeper');
    move('enterprise_pledges', 'enterprise');

    // (z2) enterprise governance (docs/the-commons.md §2.3, §2.6): lead succession, keeper requests and keeper changes.
    // Left on the old key, a lead back on a new one could not close the vote to replace them (recordActivity finds it by
    // lead_pubkey), the vote would run on as if they never came back, and a member who had voted could vote again.
    move('enterprise_succession_proposals', 'enterprise_pubkey');
    move('enterprise_succession_proposals', 'lead_pubkey');
    move('enterprise_succession_proposals', 'candidate_pubkey');
    move('enterprise_succession_proposals', 'proposer_pubkey');
    move('enterprise_succession_votes', 'voter_pubkey');
    move('enterprise_keeper_requests', 'enterprise_pubkey');
    move('enterprise_keeper_requests', 'member_pubkey');
    move('enterprise_keeper_requests', 'decided_by');
    move('enterprise_keeper_changes', 'enterprise_pubkey');
    move('enterprise_keeper_changes', 'member_pubkey');
    move('enterprise_keeper_changes', 'proposed_by');
    move('enterprise_keeper_changes', 'resolved_by');
}

// ── on a standby ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A completed re-key a copy carries: the key replaced, the key that replaced it, and when (its `invalidated_at`). */
export interface ReplicatedRekey { oldKey: string; newKey: string; at: string }

export interface ReplacedKeyMerge { written: number; kept: number; invalid: number; rekeys: ReplicatedRekey[] }

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const NEW_KEY = /^[0-9a-f]{64}$/;

/**
 * The main server's replaced keys as a copy carries them (SyncPayload.invalidatedKeys), merged into this standby's
 * `invalidated_keys` inside the import's transaction (engine/sync.ts), before anything else in the copy. The newer
 * `invalidated_at` wins (a re-key's completion over its start, and on a tie too: both steps in one millisecond stamp
 * alike, and a start kept over its completion would leave no key that replaced the old one), and the main server's row is
 * taken as it is. Keys are written in lower case, as both writers on the main server write them. A row that is malformed
 * is left out and counted: it never fails the copy it came in.
 *
 * Returns the completed re-keys the copy carries (reason 'rekeyed', with the key that replaced it), oldest first, for
 * {@link followReplicatedRekeys}: each of them, not only the ones written now, since following is decided by what this
 * database holds.
 */
export function mergeReplicatedInvalidatedKeys(rows: unknown): ReplacedKeyMerge {
    const merge: ReplacedKeyMerge = { written: 0, kept: 0, invalid: 0, rekeys: [] };
    if (!Array.isArray(rows) || rows.length === 0) return merge;
    const current = db.prepare('SELECT invalidated_at, reason FROM invalidated_keys WHERE public_key = ?');
    const upsert = db.prepare(`INSERT INTO invalidated_keys (public_key, reason, invalidated_at, rekeyed_to) VALUES (?, ?, ?, ?)
                               ON CONFLICT(public_key) DO UPDATE SET
                                   reason = excluded.reason, invalidated_at = excluded.invalidated_at, rekeyed_to = excluded.rekeyed_to`);
    for (const raw of rows) {
        const r = raw as { publicKey?: unknown; reason?: unknown; invalidatedAt?: unknown; rekeyedTo?: unknown } | null;
        const key = isText(r?.publicKey, 128) ? r.publicKey.toLowerCase() : null;
        const rekeyedTo = typeof r?.rekeyedTo === 'string' ? r.rekeyedTo.toLowerCase() : r?.rekeyedTo ?? null;
        if (!r || !key || /\s/.test(key) || !isText(r.reason, 64) || !isText(r.invalidatedAt, 40)
            || !Number.isFinite(Date.parse(r.invalidatedAt))
            || (rekeyedTo !== null && (typeof rekeyedTo !== 'string' || !NEW_KEY.test(rekeyedTo) || rekeyedTo === key))) {
            merge.invalid++;
            continue;
        }
        if (r.reason === 'rekeyed' && typeof rekeyedTo === 'string') merge.rekeys.push({ oldKey: key, newKey: rekeyedTo, at: r.invalidatedAt });
        const here = current.get(key) as { invalidated_at: string; reason: string } | undefined;
        if (here && (here.invalidated_at > r.invalidatedAt
            || (here.invalidated_at === r.invalidatedAt && (here.reason === 'rekeyed' || r.reason !== 'rekeyed')))) {
            merge.kept++;
            continue;
        }
        upsert.run(key, r.reason, r.invalidatedAt, rekeyedTo);
        merge.written++;
    }
    merge.rekeys.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    return merge;
}

let bothKeysWarned = false;

/**
 * This standby follows each re-key its main server completed, in the order they happened, with the same move
 * ({@link moveMemberKeyRows}, keeping stamps): the old key's member row becomes the new key's, and every row that named
 * the old key names the new one, as on the main server. Inside the import's transaction, before the members: the copy's
 * row for the new key then updates the moved row instead of being inserted beside the old one, which the members'
 * callsign index refused (UNIQUE constraint failed: index 'idx_members_callsign_unique'), and with it the whole copy,
 * every pull after it, until a force-resync.
 *
 * A re-key is followed only while this database holds the old key's member row and none for the new key: so twice is
 * nothing, and a standby that never had the old key (it joined and was re-keyed between two pulls) takes the new row as
 * any new member's. Both rows here is a copy an older version let diverge (the member renamed between the re-key and
 * the pull); moving would refuse on the new key's row, so it is left, logged, for a force-resync: the old key is refused
 * everywhere all the same, since its `invalidated_keys` row is here.
 *
 * Returns the re-keys it followed, for {@link dropMovedRecoveryCopies} once the copy's recovery rows are in.
 */
export function followReplicatedRekeys(rekeys: ReplicatedRekey[]): ReplicatedRekey[] {
    const followed: ReplicatedRekey[] = [];
    const member = db.prepare('SELECT callsign FROM members WHERE public_key = ?');
    for (const r of rekeys) {
        const old = member.get(r.oldKey) as { callsign: string } | undefined;
        if (!old) continue;
        if (member.get(r.newKey)) {
            if (!bothKeysWarned) {
                bothKeysWarned = true;
                console.warn(`[Sync] ⚠️ The main server re-keyed ${old.callsign} (${r.oldKey.slice(0, 10)}… → ${r.newKey.slice(0, 10)}…), `
                    + 'and this standby holds a member row for both keys, so it cannot follow the re-key. The old key is refused all the '
                    + 'same. A force-resync makes this copy exact.');
            }
            continue;
        }
        moveMemberKeyRows(r.oldKey, r.newKey, r.at, { keepStamps: true });
        followed.push(r);
        console.log(`[Sync] Followed the main server's re-key of ${old.callsign}: ${r.oldKey.slice(0, 10)}… → ${r.newKey.slice(0, 10)}…`);
    }
    return followed;
}

/**
 * The recovery copies of a re-key this standby followed: the ones the main server moved to the new key go from the old
 * one here. The main server wraps each copy the member owns again for the new key (engine/recovery-shares.ts
 * moveRecoverySharesToNewKey), which this standby cannot (it holds no seal key), and stamps it, so the copy brings the
 * moved rows; the rows under the old key would stay beside them, a second copy of a replaced key's recovery. So a row
 * here goes once the copy has brought its moved counterpart, by the key the table is unique on, with the owner and a
 * keeper ref that named the old key naming the new one. One the main server left under the old key (locked with another
 * key, which it could not open) has no counterpart, and stays here as it stays there. After the copy's recovery rows,
 * inside the import's transaction; the connection deletes securely (db.ts).
 *
 * The counterpart is looked for under every key that came after: the copy brings each row as the main server holds it
 * now, after all the re-keys between two pulls. One member re-keyed twice (K1 → K2 → K3) has theirs under K3 alone; a
 * keeper and the owner of the copy they keep, both re-keyed, have it under both new keys.
 */
export function dropMovedRecoveryCopies(followed: ReplicatedRekey[]): number {
    const next = new Map(followed.map((r) => [r.oldKey, r.newKey]));
    /** A key and each key that replaced it in turn, as this standby followed them. */
    const keysOf = (key: string): string[] => {
        const keys = [key];
        for (let k = next.get(key); k !== undefined && !keys.includes(k); k = next.get(k)) keys.push(k);
        return keys;
    };
    const named = db.prepare(`SELECT id, owner_pubkey, holder_type, holder_ref, generation FROM recovery_shares
                              WHERE owner_pubkey = ? OR (holder_type = 'member' AND holder_ref = ?)`);
    const counterpart = db.prepare(`SELECT 1 FROM recovery_shares
                                    WHERE owner_pubkey = ? AND generation = ? AND holder_type = ? AND holder_ref = ? AND id != ?`);
    const drop = db.prepare('DELETE FROM recovery_shares WHERE id = ?');
    let dropped = 0;
    for (const oldKey of next.keys()) {
        const rows = named.all(oldKey, oldKey) as { id: number; owner_pubkey: string; holder_type: string; holder_ref: string; generation: number }[];
        for (const o of rows) {
            const owners = keysOf(o.owner_pubkey);
            const holders = o.holder_type === 'member' ? keysOf(o.holder_ref) : [o.holder_ref];
            // One row at a time, against what is here now: of two rows that could each pass for the other's
            // counterpart (a chain that loops back, which no main server writes), the second finds the first gone.
            const moved = owners.some((owner) => holders.some((holder) => (owner !== o.owner_pubkey || holder !== o.holder_ref)
                && counterpart.get(owner, o.generation, o.holder_type, holder, o.id)));
            if (moved) dropped += drop.run(o.id).changes;
        }
    }
    return dropped;
}

/**
 * node_config: this standby's replaced keys are its main server's. Written when a copy first carries them; 'copied' once
 * a whole copy has. Until then the keys the main server replaced before this standby's cursor (before either server had
 * this version) are missing here, and no delta brings them: its puller asks for one whole copy
 * ({@link replacedKeysWantWholeCopy}), as for the visitors' marks (db.ts).
 */
const REPLACED_KEYS = 'replicated_invalidated_keys_v1';
const BEFORE_WHOLE_COPY = 'copied, whole copy to come';

/** A standby's import, when its main server's copy carries its replaced keys. */
export function noteReplacedKeysFromMainServer(): void {
    db.prepare('INSERT OR IGNORE INTO node_config (key, value) VALUES (?, ?)').run(REPLACED_KEYS, BEFORE_WHOLE_COPY);
}

/** A standby's puller, before a pull: whether it still wants a whole copy of its main server's replaced keys. */
export function replacedKeysWantWholeCopy(): boolean {
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(REPLACED_KEYS) as { value: string } | undefined;
    return row?.value === BEFORE_WHOLE_COPY;
}

/** A standby's puller, after importing a whole copy that carried its main server's replaced keys: every one is here. */
export function noteWholeCopyOfReplacedKeys(): void {
    db.prepare("INSERT INTO node_config (key, value) VALUES (?, 'copied') ON CONFLICT(key) DO UPDATE SET value = 'copied'").run(REPLACED_KEYS);
}

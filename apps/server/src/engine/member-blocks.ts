/**
 * A member's block list, kept by the community for the account (Marty's card web-blocklist-where, 2026-09-27: "The
 * community keeps it for the account"). The web app kept it in the browser, browser-wide, and signing out cleared it: a
 * web member who blocked someone, signed out and came back had them unblocked with nothing said. Here it comes back on
 * any browser after signing in, and nothing about it stays on a shared computer.
 *
 * - The member's own: read, added to, removed from and cleared only with their own signed request (routes/blocks.ts).
 *   The member comes from the signature, never the body. Nothing else here reads it: no other member, no visitor, no
 *   unsigned request, not the activity feed, and no broadcast but a bare doorbell to the owner's own sockets. The
 *   blocked member is never told, and nothing they can read changes. The community's operator can see it, as they see
 *   reports (the trade Marty accepted).
 * - A blocked key is any key in the one spelling (engine/member-key.ts), a member's or not: a chat can be with someone
 *   from another community. Never the owner's own. At most MEMBER_BLOCKS_MAX each.
 * - Gone with the member on a prune or a self-deletion. A re-key moves it: the owner's list to their new key, and every
 *   block of the old key to the new one, so a blocked member re-keyed stays blocked.
 *
 * ## A standby holds every list (mergeReplicatedBlocks)
 *
 * Nothing re-creates a block: the member made it once. So the rows travel to a standby with the rest of the member's data
 * (SyncPayload.memberBlocks), watermarked on `updated_at`. Every removal (an unblock, a clear, a prune, a self-deletion, a
 * re-key's old key) writes a `member_blocks` tombstone keyed `<owner>|<blocked>`, stamped no earlier than the row it
 * deletes; a block made again is stamped after any tombstone for the same pair (blockStamp). A standby deletes a row
 * stamped no later than its tombstone and keeps one stamped after it (engine/sync.ts), so an unblock never comes back,
 * and a block made again after an unblock stays, in either order of arrival, even within one millisecond.
 *
 * A standby that copied from its main server before it had this table never stored the rows made meanwhile, and no delta
 * brings them again: it takes one whole copy (memberBlocksWantWholeCopy), as for the replaced keys (engine/key-move.ts).
 */
import { db } from '../db/db.js';
import { isMemberKeySpelling, BAD_KEY_CODE, BAD_KEY_ERROR } from './member-key.js';
import type { SyncMemberBlock } from '@beanpool/engine';

/** The most keys one member may block. Far past anyone's use, and it bounds the table and the list the app reads. */
export const MEMBER_BLOCKS_MAX = 500;

export interface MemberBlock {
    /** The key blocked. */
    publicKey: string;
    /** When the member blocked it. */
    blockedAt: string;
}

export class BlockRefusal extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
        this.name = 'BlockRefusal';
    }
}

export const BLOCK_SELF_ERROR = 'You can’t block yourself.';
export const BLOCK_LIMIT_ERROR = `You can block up to ${MEMBER_BLOCKS_MAX} people. Unblock someone to block another.`;

interface BlockRow { owner_pubkey: string; blocked_pubkey: string; created_at: string; updated_at: string }

const iso = (ms: number) => new Date(ms).toISOString();
const pairKey = (owner: string, blocked: string) => `${owner}|${blocked}`;

/** A member's own list, oldest block first. */
export function listBlocks(owner: string): MemberBlock[] {
    return (db.prepare('SELECT blocked_pubkey, created_at FROM member_blocks WHERE owner_pubkey = ? ORDER BY created_at, blocked_pubkey')
        .all(owner) as { blocked_pubkey: string; created_at: string }[])
        .map(r => ({ publicKey: r.blocked_pubkey, blockedAt: r.created_at }));
}

/**
 * The stamp for a block of this pair written now: `now`, or later than the pair's tombstone if it has one at or after
 * `now`, so a standby holding that tombstone takes the new row (engine/sync.ts keeps a row only when it is newer).
 */
function blockStamp(owner: string, blocked: string, now: number): string {
    const t = db.prepare("SELECT deleted_at FROM tombstones WHERE table_name = 'member_blocks' AND row_key = ?").get(pairKey(owner, blocked)) as
        { deleted_at: string } | undefined;
    const deletedMs = t ? Date.parse(t.deleted_at) : NaN;
    return iso(Number.isFinite(deletedMs) && deletedMs >= now ? deletedMs + 1 : now);
}

/**
 * Deletes these rows, each with its tombstone, stamped no earlier than the row: a standby deletes a row stamped no later
 * than its tombstone, so it deletes this one too.
 */
function deleteBlockRows(rows: BlockRow[], now: number): void {
    const del = db.prepare('DELETE FROM member_blocks WHERE owner_pubkey = ? AND blocked_pubkey = ?');
    const tomb = db.prepare("INSERT OR REPLACE INTO tombstones (table_name, row_key, deleted_at) VALUES ('member_blocks', ?, ?)");
    const nowIso = iso(now);
    for (const r of rows) {
        del.run(r.owner_pubkey, r.blocked_pubkey);
        tomb.run(pairKey(r.owner_pubkey, r.blocked_pubkey), r.updated_at > nowIso ? r.updated_at : nowIso);
    }
}

/**
 * Blocks each of `blocked` for `owner`, in one transaction: all of them or none. A key already on the list is left as it
 * is. Refused (BlockRefusal), with nothing written, for a key not in the one spelling (400 bad_key), the owner's own
 * (400), or when the list would pass MEMBER_BLOCKS_MAX (409 block_limit). Returns the keys it added.
 */
export function addBlocks(owner: string, blocked: readonly string[], now: number = Date.now()): string[] {
    const keys = [...new Set(blocked)];
    for (const k of keys) {
        if (!isMemberKeySpelling(k)) throw new BlockRefusal(400, BAD_KEY_CODE, BAD_KEY_ERROR);
        if (k === owner) throw new BlockRefusal(400, 'block_self', BLOCK_SELF_ERROR);
    }
    return db.transaction(() => {
        const has = db.prepare('SELECT 1 FROM member_blocks WHERE owner_pubkey = ? AND blocked_pubkey = ?');
        const fresh = keys.filter(k => !has.get(owner, k));
        if (fresh.length === 0) return [];
        const count = (db.prepare('SELECT COUNT(*) AS n FROM member_blocks WHERE owner_pubkey = ?').get(owner) as { n: number }).n;
        if (count + fresh.length > MEMBER_BLOCKS_MAX) throw new BlockRefusal(409, 'block_limit', BLOCK_LIMIT_ERROR);
        const insert = db.prepare('INSERT INTO member_blocks (owner_pubkey, blocked_pubkey, created_at, updated_at) VALUES (?, ?, ?, ?)');
        for (const k of fresh) insert.run(owner, k, iso(now), blockStamp(owner, k, now));
        return fresh;
    })();
}

/** Unblocks one key. False when it wasn't on the owner's list. */
export function removeBlock(owner: string, blocked: string, now: number = Date.now()): boolean {
    return db.transaction(() => {
        const row = db.prepare('SELECT * FROM member_blocks WHERE owner_pubkey = ? AND blocked_pubkey = ?').get(owner, blocked) as BlockRow | undefined;
        if (!row) return false;
        deleteBlockRows([row], now);
        return true;
    })();
}

/** Unblocks everyone on the owner's list ("Unblock All", a prune, a self-deletion). Returns how many. */
export function clearBlocks(owner: string, now: number = Date.now()): number {
    return db.transaction(() => {
        const rows = db.prepare('SELECT * FROM member_blocks WHERE owner_pubkey = ?').all(owner) as BlockRow[];
        deleteBlockRows(rows, now);
        return rows.length;
    })();
}

/** A prune or a self-deletion: the member's list goes with them. Lists that block them are their owners' and stay. */
export function dropBlocksOf(owner: string, now: number = Date.now()): void {
    clearBlocks(owner, now);
}

/**
 * A re-key (`completeRekey`, engine/member-wizards.ts, inside its transaction): the owner's list moves to the new key, and
 * every block of the old key names the new one, so a blocked member who is re-keyed stays blocked. Each moved row is
 * written again under the new key, stamped, and the old one goes with its tombstone, so the move replicates. A pair the
 * new key already has is kept as it is, and a row that would block its own owner goes. Returns the owners whose lists
 * changed, for the doorbell after the commit.
 */
export function moveBlocks(oldKey: string, newKey: string, now: number = Date.now()): string[] {
    return db.transaction(() => {
        const rows = db.prepare('SELECT * FROM member_blocks WHERE owner_pubkey = ? OR blocked_pubkey = ?').all(oldKey, oldKey) as BlockRow[];
        const insert = db.prepare('INSERT OR IGNORE INTO member_blocks (owner_pubkey, blocked_pubkey, created_at, updated_at) VALUES (?, ?, ?, ?)');
        const owners = new Set<string>();
        for (const r of rows) {
            const owner = r.owner_pubkey === oldKey ? newKey : r.owner_pubkey;
            const blocked = r.blocked_pubkey === oldKey ? newKey : r.blocked_pubkey;
            if (owner !== blocked) insert.run(owner, blocked, r.created_at, blockStamp(owner, blocked, now));
            owners.add(owner);
        }
        deleteBlockRows(rows, now);
        return [...owners];
    })();
}

// ── on a standby ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface BlockMerge { written: number; kept: number; skipped: number; invalid: number }

const isStamp = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 40 && Number.isFinite(Date.parse(v));

/**
 * The main server's block lists as a copy carries them (SyncPayload.memberBlocks), merged into this standby's database
 * inside the import's transaction (engine/sync.ts), after the members and before the tombstones. Per pair, the newer
 * `updated_at` wins.
 *
 * - A row whose owner this database has no member row for is skipped: nobody here could read it or change it.
 * - A row stamped no later than a tombstone this database holds for its pair was unblocked after it: it stays deleted.
 * - A row that is malformed, or that this database refuses for any reason, is left out and counted. It never fails the
 *   copy it came in.
 */
export function mergeReplicatedBlocks(rows: unknown): BlockMerge {
    const merge: BlockMerge = { written: 0, kept: 0, skipped: 0, invalid: 0 };
    if (!Array.isArray(rows) || rows.length === 0) return merge;
    const memberExists = db.prepare('SELECT 1 FROM members WHERE public_key = ?');
    const current = db.prepare('SELECT updated_at FROM member_blocks WHERE owner_pubkey = ? AND blocked_pubkey = ?');
    const tombstone = db.prepare("SELECT deleted_at FROM tombstones WHERE table_name = 'member_blocks' AND row_key = ?");
    const upsert = db.prepare(`INSERT INTO member_blocks (owner_pubkey, blocked_pubkey, created_at, updated_at) VALUES (?, ?, ?, ?)
                               ON CONFLICT(owner_pubkey, blocked_pubkey) DO UPDATE SET
                                   created_at = excluded.created_at, updated_at = excluded.updated_at`);
    db.transaction(() => {
        for (const raw of rows) {
            const b = raw as Partial<SyncMemberBlock> | null;
            if (!b || !isMemberKeySpelling(b.ownerPubkey) || !isMemberKeySpelling(b.blockedPubkey) || b.ownerPubkey === b.blockedPubkey
                || !isStamp(b.createdAt) || !isStamp(b.updatedAt)) {
                merge.invalid++;
                continue;
            }
            if (!memberExists.get(b.ownerPubkey)) { merge.skipped++; continue; }
            const deleted = tombstone.get(pairKey(b.ownerPubkey, b.blockedPubkey)) as { deleted_at: string } | undefined;
            if (deleted && deleted.deleted_at >= b.updatedAt) { merge.skipped++; continue; }
            const here = current.get(b.ownerPubkey, b.blockedPubkey) as { updated_at: string } | undefined;
            if (here && here.updated_at >= b.updatedAt) { merge.kept++; continue; }
            try {
                upsert.run(b.ownerPubkey, b.blockedPubkey, b.createdAt, b.updatedAt);
                merge.written++;
            } catch (e: any) {
                console.warn(`[Blocks] A copied block could not be stored here, left out: ${e?.message || e}`);
                merge.invalid++;
            }
        }
    })();
    return merge;
}

/**
 * node_config: this standby's block lists are its main server's. Written when a copy first carries them; 'copied' once a
 * whole copy has. Until then the blocks the main server made before this standby's cursor (while this standby ran a
 * version without the table) are missing here, and no delta brings them: its puller asks for one whole copy.
 */
const MEMBER_BLOCKS_COPIED = 'replicated_member_blocks_v1';
const BEFORE_WHOLE_COPY = 'copied, whole copy to come';

/** A standby's import, when its main server's copy carries block lists. */
export function noteMemberBlocksFromMainServer(): void {
    db.prepare('INSERT OR IGNORE INTO node_config (key, value) VALUES (?, ?)').run(MEMBER_BLOCKS_COPIED, BEFORE_WHOLE_COPY);
}

/** A standby's puller, before a pull: whether it still wants a whole copy of its main server's block lists. */
export function memberBlocksWantWholeCopy(): boolean {
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(MEMBER_BLOCKS_COPIED) as { value: string } | undefined;
    return row?.value === BEFORE_WHOLE_COPY;
}

/** A standby's puller, after importing a whole copy that carried its main server's block lists: every one is here. */
export function noteWholeCopyOfMemberBlocks(): void {
    db.prepare("INSERT INTO node_config (key, value) VALUES (?, 'copied') ON CONFLICT(key) DO UPDATE SET value = 'copied'").run(MEMBER_BLOCKS_COPIED);
}

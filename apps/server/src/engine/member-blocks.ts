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
 * - A blocked key is any key in the one spelling (engine/member-key.ts), a member's or not: the marketplace shows listings
 *   from a connected community's public board straight from that node (MarketplacePage's peer browse), and their author
 *   has no row here, yet has a Block button. Never the owner's own. At most MEMBER_BLOCKS_MAX each. The web app's one-time
 *   move of a list it kept in the browser (addKnownBlocks) takes only keys this node has a row for, and counts the rest.
 * - Gone with the member on a prune or a self-deletion. A re-key moves it: the owner's list to their new key, and every
 *   block of the old key to the new one, so a blocked member re-keyed stays blocked.
 *
 * ## A standby holds every list (mergeReplicatedBlocks)
 *
 * Nothing re-creates a block: the member made it once. So the rows travel to a standby with the rest of the member's data
 * (SyncPayload.memberBlocks), watermarked on `updated_at`. A removal travels as a `member_blocks` tombstone:
 *
 * - One unblock writes one keyed `<owner>|<blocked>`, stamped no earlier than the row it deletes.
 * - A removal of the whole list (Unblock All, a prune, a self-deletion, a re-key's old key) writes ONE, keyed `<owner>|*`
 *   (ownerTombstoneKey): every row of that owner stamped no later than it is gone. It is stamped no earlier than any row
 *   it deletes and any tombstone of that owner's, which it replaces: those are deleted with it.
 * - A block made again is stamped after both (blockStamp). A standby deletes a row stamped no later than a tombstone
 *   that covers it and keeps one stamped after (engine/sync.ts), so an unblock never comes back, and a block made again
 *   after it stays, in either order of arrival, even within one millisecond or after the clock stepped back.
 *
 * ## What one member can make this node keep
 *
 * No block, unblock or Unblock All (routes/blocks.ts), nor a self-deletion, writes more than MEMBER_BLOCKS_MAX rows or
 * adds more than one tombstone, and one owner's list is never more than MEMBER_BLOCKS_MAX rows and
 * MEMBER_BLOCK_TOMBSTONES_MAX + 1 tombstones, whatever they send (the deciding review of #1239 measured 500 tombstones
 * every two requests before this). Past MEMBER_BLOCK_TOMBSTONES_MAX single unblocks within the tombstones' 30 days, the
 * owner's are folded into their `<owner>|*` one, and the blocks they still hold are stamped after it, so a standby keeps
 * them (foldTombstones). Nothing the member sees changes. A re-key, which an operator runs, adds one tombstone for the
 * member's own list and one for each block of their old key, each counted against its owner's ceiling.
 *
 * A standby that copied from its main server before it had this table never stored the rows made meanwhile, and no delta
 * brings them again: it takes one whole copy (memberBlocksWantWholeCopy), as for the replaced keys (engine/key-move.ts).
 */
import { db } from '../db/db.js';
import { isMemberKeySpelling, BAD_KEY_CODE, BAD_KEY_ERROR } from './member-key.js';
import type { SyncMemberBlock } from '@beanpool/engine';

/** The most keys one member may block. Far past anyone's use, and it bounds the table and the list the app reads. */
export const MEMBER_BLOCKS_MAX = 500;

/**
 * The most single-unblock tombstones one member's list keeps (the tombstones' 30 days, connector-manager.ts). Nobody
 * unblocks this many people in a month; past it they are folded into one (foldTombstones), which the member never sees.
 */
export const MEMBER_BLOCK_TOMBSTONES_MAX = 500;

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
/** The tombstone of a whole list: every row of `owner` stamped no later than it is gone. */
export const ownerTombstoneKey = (owner: string) => `${owner}|*`;

/** A tombstone's stamp, or null. */
function tombstoneAt(rowKey: string): string | null {
    return (db.prepare("SELECT deleted_at FROM tombstones WHERE table_name = 'member_blocks' AND row_key = ?").get(rowKey) as
        { deleted_at: string } | undefined)?.deleted_at ?? null;
}

/**
 * The owner's single-unblock tombstones (`<owner>|<blocked>`): the keys from `<owner>|` up to `<owner>}` ('}' follows '|'),
 * but their `<owner>|*`. Also on a standby (engine/sync.ts), where a `<owner>|*` deletes those it covers.
 */
export const PAIR_TOMBSTONES_OF = "table_name = 'member_blocks' AND row_key >= ? || '|' AND row_key < ? || '}' AND row_key != ? || '|*'";

/** The later of two stamps, either possibly null. */
const later = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a > b ? a : b);

/** A member's own list, oldest block first. */
export function listBlocks(owner: string): MemberBlock[] {
    return (db.prepare('SELECT blocked_pubkey, created_at FROM member_blocks WHERE owner_pubkey = ? ORDER BY created_at, blocked_pubkey')
        .all(owner) as { blocked_pubkey: string; created_at: string }[])
        .map(r => ({ publicKey: r.blocked_pubkey, blockedAt: r.created_at }));
}

/**
 * The stamp for a block of this pair written now: `now`, or later than the pair's tombstone and the owner's `<owner>|*`
 * when either is at or after `now`, so a standby holding them takes the new row (engine/sync.ts keeps a row only when it
 * is newer).
 */
function blockStamp(owner: string, blocked: string, now: number): string {
    let at = now;
    for (const t of [tombstoneAt(pairKey(owner, blocked)), tombstoneAt(ownerTombstoneKey(owner))]) {
        const deletedMs = t === null ? NaN : Date.parse(t);
        if (Number.isFinite(deletedMs) && deletedMs >= at) at = deletedMs + 1;
    }
    return iso(at);
}

/**
 * Deletes these rows, one owner's or several, each with its own tombstone, stamped no earlier than the row: a standby
 * deletes a row stamped no later than its tombstone, so it deletes this one too. An owner past
 * MEMBER_BLOCK_TOMBSTONES_MAX then has theirs folded into one.
 */
function deleteBlockRows(rows: BlockRow[], now: number): void {
    const del = db.prepare('DELETE FROM member_blocks WHERE owner_pubkey = ? AND blocked_pubkey = ?');
    const tomb = db.prepare("INSERT OR REPLACE INTO tombstones (table_name, row_key, deleted_at) VALUES ('member_blocks', ?, ?)");
    const nowIso = iso(now);
    for (const r of rows) {
        del.run(r.owner_pubkey, r.blocked_pubkey);
        tomb.run(pairKey(r.owner_pubkey, r.blocked_pubkey), r.updated_at > nowIso ? r.updated_at : nowIso);
    }
    const count = db.prepare(`SELECT COUNT(*) AS n FROM tombstones WHERE ${PAIR_TOMBSTONES_OF}`);
    for (const owner of new Set(rows.map(r => r.owner_pubkey))) {
        if ((count.get(owner, owner, owner) as { n: number }).n > MEMBER_BLOCK_TOMBSTONES_MAX) foldTombstones(owner, now);
    }
}

/**
 * Writes the owner's `<owner>|*`, stamped `at` or later: no earlier than the one they have, nor than any tombstone of
 * theirs, which it replaces and which go. Returns its stamp.
 */
function writeOwnerTombstone(owner: string, at: string): string {
    const newest = db.prepare(`SELECT MAX(deleted_at) AS at FROM tombstones WHERE ${PAIR_TOMBSTONES_OF}`).get(owner, owner, owner) as { at: string | null };
    const stamp = later(later(at, tombstoneAt(ownerTombstoneKey(owner))), newest.at)!;
    db.prepare(`DELETE FROM tombstones WHERE ${PAIR_TOMBSTONES_OF}`).run(owner, owner, owner);
    db.prepare("INSERT OR REPLACE INTO tombstones (table_name, row_key, deleted_at) VALUES ('member_blocks', ?, ?)").run(ownerTombstoneKey(owner), stamp);
    return stamp;
}

/**
 * Deletes the owner's whole list with one tombstone, `<owner>|*`, stamped no earlier than any row it deletes. Nothing
 * when the list is empty. Returns how many rows went.
 */
function deleteOwnerRows(owner: string, now: number): number {
    const rows = db.prepare('SELECT updated_at FROM member_blocks WHERE owner_pubkey = ?').all(owner) as { updated_at: string }[];
    if (rows.length === 0) return 0;
    writeOwnerTombstone(owner, rows.reduce((at, r) => (r.updated_at > at ? r.updated_at : at), iso(now)));
    db.prepare('DELETE FROM member_blocks WHERE owner_pubkey = ?').run(owner);
    return rows.length;
}

/**
 * The owner's single-unblock tombstones, folded into their `<owner>|*` (stamped no earlier than any of them), and each
 * block they still hold stamped after it, so a standby, which deletes every row of theirs stamped no later, keeps these
 * (they come to it in the same copy, merged before the tombstones). The standby's copy of the list ends the same.
 */
function foldTombstones(owner: string, now: number): void {
    const stamp = writeOwnerTombstone(owner, iso(now));
    db.prepare('UPDATE member_blocks SET updated_at = ? WHERE owner_pubkey = ? AND updated_at <= ?').run(iso(Date.parse(stamp) + 1), owner, stamp);
}

/**
 * Blocks each of `blocked` for `owner`, in one transaction: all of them or none. A key already on the list is left as it
 * is. Refused (BlockRefusal), with nothing written, for a key not in the one spelling (400 bad_key), the owner's own
 * (400), or when the list would pass MEMBER_BLOCKS_MAX (409 block_limit). Returns the keys it added.
 */
export function addBlocks(owner: string, blocked: readonly string[], now: number = Date.now()): string[] {
    const keys = checkedKeys(owner, blocked);
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

/**
 * The web app's one-time move of a list it kept in the browser (POST /api/blocks with targetPubkeys): as addBlocks, but
 * only the keys this node has a row for, a member's or a visitor's, so a request adds only people this community knows.
 * A key with no row here is skipped and counted, never a reason to refuse the rest. Refused as addBlocks is, for the
 * whole list, over any key in it.
 */
export function addKnownBlocks(owner: string, blocked: readonly string[], now: number = Date.now()): { added: string[]; skipped: number } {
    const keys = checkedKeys(owner, blocked);
    const known = db.prepare('SELECT 1 FROM members WHERE public_key = ?');
    const here = keys.filter(k => known.get(k));
    return { added: addBlocks(owner, here, now), skipped: keys.length - here.length };
}

/** The keys once each, or a BlockRefusal for one not in the one spelling or the owner's own. */
function checkedKeys(owner: string, blocked: readonly string[]): string[] {
    const keys = [...new Set(blocked)];
    for (const k of keys) {
        if (!isMemberKeySpelling(k)) throw new BlockRefusal(400, BAD_KEY_CODE, BAD_KEY_ERROR);
        if (k === owner) throw new BlockRefusal(400, 'block_self', BLOCK_SELF_ERROR);
    }
    return keys;
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

/**
 * Unblocks everyone on the owner's list ("Unblock All", a prune, a self-deletion), with one tombstone however long the
 * list was. Returns how many.
 */
export function clearBlocks(owner: string, now: number = Date.now()): number {
    return db.transaction(() => deleteOwnerRows(owner, now))();
}

/** A prune or a self-deletion: the member's list goes with them. Lists that block them are their owners' and stay. */
export function dropBlocksOf(owner: string, now: number = Date.now()): void {
    clearBlocks(owner, now);
}

/**
 * A re-key (`completeRekey`, engine/member-wizards.ts, inside its transaction): the owner's list moves to the new key, and
 * every block of the old key names the new one, so a blocked member who is re-keyed stays blocked. Each moved row is
 * written again under the new key, stamped, and the old ones go with tombstones, so the move replicates: the old key's
 * own list with one `<old>|*`, and each other member's block of the old key with its pair's. A pair the new key already
 * has is kept as it is, and a row that would block its own owner goes. Returns the owners whose lists changed, for the
 * doorbell after the commit.
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
        deleteOwnerRows(oldKey, now);
        deleteBlockRows(rows.filter(r => r.owner_pubkey !== oldKey), now);
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
 * - A row stamped no later than a tombstone this database holds for its pair, or for its owner's whole list, was
 *   unblocked after it: it stays deleted.
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
            const deleted = later(
                (tombstone.get(pairKey(b.ownerPubkey, b.blockedPubkey)) as { deleted_at: string } | undefined)?.deleted_at ?? null,
                (tombstone.get(ownerTombstoneKey(b.ownerPubkey)) as { deleted_at: string } | undefined)?.deleted_at ?? null);
            if (deleted !== null && deleted >= b.updatedAt) { merge.skipped++; continue; }
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

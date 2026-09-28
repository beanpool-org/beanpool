// Stateful remote state sync import & topology node role management.
//
// Extracted from apps/server/src/state-engine.ts.

import type Database from 'better-sqlite3';
import { db, afterTransactionCommit, visitorsMarked, noteVisitorsMarkedByMainServer } from '../db/db.js';
import { getNodeRole } from '../config/node-role.js';
import crypto from 'node:crypto';
import { bodyOfSignedText, bytesOfSignedText } from '@beanpool/core';
import { getImageStore, postPhotoKey } from '../storage/image-store.js';
import { deleteStoredObjects, photoDataOfAsync, storePhotoColumnsAsync, type PhotoColumns } from '../storage/image-columns.js';
import { readProfileRecord } from '../config/node-profile.js';
import { readCommunitySettings } from '../config/community-settings.js';
import { readOpenJoinSalt, writeOpenJoinRecord } from './open-join.js';
import { recoverySealEpoch } from '../services/recovery-seal-key.js';
import { deleteTombstonedCopies } from './recovery-shares.js';
import { importedArea } from './member-area.js';
import { mergeReplicatedWatches } from './place-watches.js';
import { mergeReplicatedKnocks } from './knocks.js';
import { mergeReplicatedDirectory } from './directory-cache.js';
import { mergeReplicatedNotices } from './kept-notices.js';
import { mergeReplicatedBlocks, noteMemberBlocksFromMainServer, PAIR_TOMBSTONES_OF } from './member-blocks.js';
import {
    mergeReplicatedInvalidatedKeys, followReplicatedRekeys, dropMovedRecoveryCopies, noteReplacedKeysFromMainServer,
    type ReplicatedRekey,
} from './key-move.js';
import {
    exportSyncState as exportSyncStateEngine,
    clearEnterpriseFloorCache,
    isWellFormedKey,
    summariseLedger,
    type LedgerSummary,
    type SyncAccount,
    type SyncPayload,
    type Transaction
} from '@beanpool/engine';

// The node's role lives in config/node-role.ts, a leaf module the database's boot can ask too (db.ts
// markExistingVisitors); re-exported here, where the rest of the server imports it from.
export { getNodeRole, setNodeRole, type NodeRole } from '../config/node-role.js';

/**
 * What this importer keeps, as a number (design scratch/global-node/DESIGN-standby-takeover-gaps-opus.md §4.3). A standby
 * records the format its copy was made with (`replica_format` in node_config, noteReplicaFormat); while that is older than
 * this, its puller asks for one force-resync (services/backup-puller.ts). A whole copy can't repair what an older importer
 * got wrong: it skips every row whose stamp hasn't moved. Raise it in the PR that changes what the importer keeps.
 *
 *  1. The ledger is the main server's exactly: every account as it holds it and no other, each trade's fee and project;
 *     and a standby seeds no BeanPool enterprise of its own (G0, G9). A standby with no record of a format is older.
 *  2. Listings, deals, their photos and projects are the main server's rows verbatim (G1, G1b): a listing of this
 *     community's own names no origin (before, the main server's PeerId, so a promoted standby took every one for another
 *     community's), its category, cash note and search words follow each edit, a deal keeps its dispute resolution and
 *     last reminder, and every stamp is the main server's (IMPORT_KEEPS_STAMPS). A copy made by format 1 holds those
 *     rows under stamps no later copy moves past.
 *  3. No trade the standby made itself. Its own demurrage flush, and a Bean move made on it (a send, a trade, a member's
 *     own delete), wrote trades the main server never made, which no copy removes: the import never deletes a trade a
 *     copy doesn't name. Now the flush writes nothing on a standby (engine/audit.ts persistDecayAndCommons) and every
 *     Bean move refuses there before it writes (config/node-role.ts assertLedgerWritable). The force-resync this format
 *     asks for clears the ones a standby already holds, of both kinds, a format 2 standby's included.
 *  4. A member's and an enterprise's standing are the main server's (G2a, G2b, G2c): every members column, verbatim (an
 *     enterprise, a vouch, a freeze, granted credit, a pause, a map pin; before, a fixed list, and the first voucher kept
 *     over a withdrawal), each member's preferences (holiday, notification settings), who keeps each enterprise and the
 *     keepers' pledges. A copy made by format 3 holds members rows under the main server's stamps without those columns,
 *     which no later copy moves past.
 */
export const REPLICA_FORMAT = 4;

/**
 * The format this standby's copy was made with; 0 when it has no record of one: it has never landed a copy, or only
 * copies made before the record, or it cleared its copy for a seed of its own and none has landed since (clearForResync).
 * The next copy it lands is then its first, a seed (ImportOptions.seed). Only this standby writes the record: a copy can
 * neither set it nor take it away.
 */
export function replicaFormatOfCopy(): number {
    const row = db.prepare(`SELECT value FROM node_config WHERE key = 'replica_format'`).get() as { value: string } | undefined;
    const n = Number(row?.value);
    return Number.isInteger(n) && n > 0 ? n : 0;
}

/** This standby's copy is now one this importer made: a force-resync, or a first copy, landed. */
export function noteReplicaFormat(): void {
    db.prepare(`INSERT OR REPLACE INTO node_config (key, value) VALUES ('replica_format', ?)`).run(String(REPLICA_FORMAT));
}

/**
 * The total this standby's next copy is held to (ImportOptions.heldToSum): the ledger's sum before a clear it made for a
 * force-resync that isn't a seed, kept as node_config `replica_held_sum` until a copy lands (importRemoteState removes it
 * in the transaction that lands one). Null when there is none.
 */
export function heldLedgerSum(): number | null {
    const row = db.prepare(`SELECT value FROM node_config WHERE key = 'replica_held_sum'`).get() as { value: string } | undefined;
    if (!row) return null;
    const n = Number(row.value);
    return Number.isFinite(n) ? n : null;
}

/**
 * A force-resync's clear (services/backup-puller.ts), in one transaction with what this standby records about it.
 *  - A seed (the format re-seed, an operator's force-resync): the copy's format record goes, so until a copy lands the
 *    next one is this standby's first (replicaFormatOfCopy), and a pull after an import that failed is a seed too.
 *  - Not a seed (a whole copy that didn't match): the ledger's sum now, before the clear, is recorded, and returned, for
 *    the copy to be held to (heldLedgerSum). One already recorded, from a clear whose copy never landed, stays.
 * `clear` is the clear itself (state-engine.ts clearReplicatedTables); a throw from it undoes the record too.
 */
export function clearForResync(seed: boolean, clear: () => void): number | null {
    return db.transaction(() => {
        let held: number | null = null;
        if (seed) {
            db.prepare(`DELETE FROM node_config WHERE key IN ('replica_format', 'replica_held_sum')`).run();
        } else {
            held = heldLedgerSum() ?? (db.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM accounts').get() as { s: number }).s;
            db.prepare(`INSERT OR REPLACE INTO node_config (key, value) VALUES ('replica_held_sum', ?)`).run(String(held));
        }
        clear();
        return held;
    })();
}

/**
 * A whole copy found this standby's ledger isn't its main server's (services/backup-puller.ts checkWholeCopy): kept as
 * node_config `replica_ledger_mismatch`, the last one, for the owners' notice (design G8) to read.
 */
export function noteLedgerMismatch(record: {
    at: string; snapshotGeneratedAt: string | null; differing: number; unreadable: number; examples: string[]; resync: string;
}): void {
    db.prepare(`INSERT OR REPLACE INTO node_config (key, value) VALUES ('replica_ledger_mismatch', ?)`).run(JSON.stringify(record));
}

/** The main server's ledger as this standby last copied it (node_config `replica_main_ledger`), for a take-over's audit. */
export interface MainLedgerRecord extends LedgerSummary {
    /** The copy's `generatedAt`: when the main server's ledger was this. */
    generatedAt: string | null;
}

export function mainLedgerAtLastCopy(): MainLedgerRecord | null {
    const row = db.prepare(`SELECT value FROM node_config WHERE key = 'replica_main_ledger'`).get() as { value: string } | undefined;
    if (!row) return null;
    try {
        const r = JSON.parse(row.value);
        return r && typeof r.digest === 'string' ? r as MainLedgerRecord : null;
    } catch {
        return null;
    }
}

export function getSyncCursor(peerId: string): string | null {
    const row = db.prepare(`SELECT last_synced_at FROM sync_cursors WHERE peer_id=?`).get(peerId) as { last_synced_at: string } | undefined;
    return row?.last_synced_at ?? null;
}

/**
 * #134: Write one row to sync_audit_log recording the identity and change counts
 * of a completed importRemoteState() call. Exported separately so the production
 * code path can be exercised in tests without a live libp2p signature.
 * Failures are logged but never re-thrown — an audit write failure must never
 * abort or mask a successful import.
 */
export interface SyncAuditEntry {
    originPeerId: string;
    originNodeId: string;
    newMembers: number;
    updatedMembers: number;
    newPosts: number;
    updatedPosts: number;
    newTransactions: number;
    accountChanges: number;
    marketplaceTxns: number;
    newMessages: number;
    tombstonesApplied: number;
    conflictsSkipped: number;
    recoverySharesImported: number;
}

export function writeSyncAuditLog(entry: SyncAuditEntry): void {
    try {
        db.prepare(`
            INSERT INTO sync_audit_log
                (origin_peer_id, origin_node_id,
                 new_members, updated_members, new_posts, updated_posts,
                 new_transactions, account_changes, marketplace_txns,
                 new_messages, tombstones_applied, conflicts_skipped, recovery_shares_imported)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            entry.originPeerId, entry.originNodeId,
            entry.newMembers, entry.updatedMembers,
            entry.newPosts, entry.updatedPosts,
            entry.newTransactions, entry.accountChanges,
            entry.marketplaceTxns, entry.newMessages,
            entry.tombstonesApplied, entry.conflictsSkipped,
            entry.recoverySharesImported
        );
    } catch (auditErr: any) {
        console.error(`[Sync] ⚠️ Failed to write sync_audit_log row (import itself succeeded):`, auditErr?.message || auditErr);
    }
}

export function setSyncCursor(peerId: string, cursor: string): void {
    const now = new Date().toISOString();
    db.prepare(`
        INSERT INTO sync_cursors (peer_id, last_synced_at, last_sync_attempt_at)
        VALUES (?, ?, ?)
        ON CONFLICT(peer_id) DO UPDATE SET
            last_synced_at = excluded.last_synced_at,
            last_sync_attempt_at = excluded.last_sync_attempt_at
    `).run(peerId, cursor, now);
}

export function recordSyncAttempt(peerId: string): void {
    const now = new Date().toISOString();
    db.prepare(`
        INSERT INTO sync_cursors (peer_id, last_synced_at, last_sync_attempt_at)
        VALUES (?, ?, ?)
        ON CONFLICT(peer_id) DO UPDATE SET
            last_sync_attempt_at = excluded.last_sync_attempt_at
    `).run(peerId, now, now);
}

let currentImportOrigin: string | null = null;

export function getCurrentImportOrigin(): string | null {
    return currentImportOrigin;
}

export interface ImportResult {
    newMembers: number;
    updatedMembers: number;
    newPosts: number;
    updatedPosts: number;
    newTransactions: number;
    accountChanges: number;
    marketplaceTxns: number;
    newMessages: number;
    tombstonesApplied: number;
    conflictsSkipped: number;
    recoverySharesImported: number;
}

export interface SyncCallbacks {
    getPrivateKey: () => any;
    publicKeyToProtobuf: (key: any) => Uint8Array;
    publicKeyFromProtobuf: (bytes: Uint8Array) => any;
    /** Put the in-memory ledger (every account and the Commons pot) back to what the `accounts` rows hold. */
    resyncLedgerToRows: () => void;
    broadcast: (event: any) => void;
}

export async function signSyncPayload(cb: SyncCallbacks, payload: SyncPayload): Promise<SyncPayload> {
    const privateKey = cb.getPrivateKey();
    if (privateKey) {
        try {
            const rawBody = JSON.stringify(payload);
            const signatureBytes = await privateKey.sign(new TextEncoder().encode(rawBody));
            payload.signature = Buffer.from(signatureBytes).toString('hex');
            payload.publicKey = Buffer.from(cb.publicKeyToProtobuf(privateKey.publicKey)).toString('hex');
        } catch (e: any) {
            console.error(`[Sync] Failed to sign payload:`, e.message || e);
        }
    }
    return payload;
}

/**
 * Put the photo bytes back into the sync payload (storage design §7: the payload does NOT change this phase).
 *
 * `exportSyncStateEngine` does `SELECT * FROM post_photos`, so once a row has been evacuated its `photo_data`
 * is null and four new columns have appeared. Both would be a wire change, and a wire change here is a
 * compatibility break with every peer and every replica that has not been upgraded yet — including the delta
 * backup replica, which reconstructs a whole node from this payload. So the rows are put back exactly as they
 * were: `photo_data` rebuilt from the store, and the store's own columns stripped.
 *
 * `photoDataOf` reproduces the original string character for character (see storage/image-columns.ts), so a
 * peer's import is byte-identical to what it would have received before the photo was evacuated. Photos by
 * reference is a later phase; until then the saving is on disk here, not on the wire.
 *
 * ## A photo this node can no longer read is OMITTED, never exported empty
 *
 * If the images directory has been lost or unmounted, `photoDataOf` throws. That must not fail the whole
 * export — a replica pulling a delta needs the ledger rows in it far more than it needs one photo. But it
 * must not export the row either. The importer (`INSERT OR REPLACE INTO post_photos`, below) treats every
 * row it receives as authoritative, and an empty `photo_data` is not storable, so the replica would write
 * `photo_data = ''`: a row the evacuation job skips (`photo_data != ''`) and the photo route reads as
 * nothing. The replica's intact copy would be gone for good, because the row's `updated_at` never changed
 * and no later delta pull would ever send it again.
 *
 * So the row is dropped from the payload. The importer only upserts what it is given, so what it does not
 * receive it keeps. This is the one case where the backup copy is the only good one left, and the export's
 * job is to not destroy it.
 *
 * ## …and the payload SAYS which rows those were
 *
 * "What it does not receive it keeps" is true of an ordinary delta or full pull, and false of a FORCE-RESYNC:
 * `pullOnce('resync')` calls `clearReplicatedTables()` — which lists `post_photos` — before importing, so a
 * row dropped here is a row the replica deletes and never gets back. Its object becomes an orphan and the
 * daily sweep reclaims it after the grace period. The one case this omission exists for would be destroyed by
 * the natural thing an operator does when a replica "looks wrong".
 *
 * So the keys of the omitted rows go into {@link SyncPayload.photosOmitted} — an additive, optional field a
 * peer that does not know it simply ignores — and the resync keeps exactly those rows and their objects. It
 * is logged on both sides: this node says it could not read them, and the replica says it is keeping them.
 */
/**
 * Put every photo in an incoming payload through the image store, keyed `post_id|order_num`.
 *
 * A peer still sends bytes inline (the payload is frozen this phase), and they go straight through the store
 * on the way in — so an importing node's database does not re-grow by everything its peers hold. A value the
 * store cannot reproduce exactly stays in the row, as it would have before.
 *
 * Runs before the import transaction opens, so the write lock is never held across an fsync. See the call
 * site for why that matters on a small node.
 *
 * Through the store's NON-blocking write, a few at a time: on an S3 node each photo is a PUT to the bucket,
 * and a first full snapshot carries every photo a peer holds — one blocking round trip each would hold the
 * node for minutes, and the host watchdog restarts a node that stops answering for one.
 */
async function storeImportedPhotos(photos: any[]): Promise<Map<string, PhotoColumns & { updated_at: string | null }>> {
    const store = getImageStore();
    // Written a few at a time; results kept by index so "last one wins" below still means the payload's order.
    const written: (PhotoColumns | null)[] = new Array(photos.length).fill(null);
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < photos.length) {
            const i = next++;
            const ph = photos[i];
            if (typeof ph.photo_data !== 'string' || ph.photo_data.length === 0) continue;
            written[i] = await storePhotoColumnsAsync(
                store,
                sb => postPhotoKey(ph.post_id, ph.order_num, sb.sha256, sb.mime),
                ph.photo_data,
            );
        }
    };
    await Promise.all(Array.from({ length: Math.min(EXPORT_READ_CONCURRENCY, photos.length) }, worker));
    const out = new Map<string, PhotoColumns & { updated_at: string | null }>();
    for (let i = 0; i < photos.length; i++) {
        const ph = photos[i];
        // The other half of the rule `restoreInlinePhotos` keeps on the way out, enforced here on the way
        // in — because the peer sending this payload may be a node that has not been upgraded yet, and
        // during a rolling upgrade it usually is. A photo row with no bytes carries no information, and
        // applying one can only destroy: INSERT OR REPLACE would overwrite an intact local photo with a row
        // the evacuation job skips and the photo route serves as a 404, and the peer's unchanged
        // `updated_at` means no later delta pull ever corrects it. Nothing to apply, so apply nothing.
        if (typeof ph.photo_data !== 'string' || ph.photo_data.length === 0) continue;
        // Last one wins, exactly as the INSERT OR REPLACE loop did when a payload named the same slot twice. With the
        // main server's stamp: this standby's own would outrank a delete made there after it (a photo tombstone). Null
        // when it holds none; the row's INSERT fills that from the listing.
        out.set(`${ph.post_id}|${ph.order_num}`, { ...written[i]!, updated_at: typeof ph.updated_at === 'string' ? ph.updated_at : null });
    }
    return out;
}

/**
 * How many photos an export reads from the store at once. On disk each read is a local syscall and this changes
 * nothing; on S3 it is a round trip, and a full export names every photo on the node — one at a time that is
 * minutes, all at once it is thousands of sockets on a 1 GB host.
 */
const EXPORT_READ_CONCURRENCY = 8;

async function restoreInlinePhotos(payload: SyncPayload): Promise<SyncPayload> {
    const photos = (payload as any).photos as any[] | undefined;
    if (!Array.isArray(photos) || photos.length === 0) return payload;
    const store = getImageStore();
    // Filled by index, so the payload keeps exactly the order the engine exported — the reads finish in any order.
    const results: ({ row: any } | { omitted: string })[] = new Array(photos.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < photos.length) {
            const i = next++;
            const row = photos[i];
            let photoData: string | null;
            try {
                // Non-blocking: on an S3 node this is a bucket round trip, and the node keeps serving meanwhile.
                photoData = await photoDataOfAsync(row, store);
            } catch (e) {
                results[i] = { omitted: `${row.post_id}|${row.order_num}` };
                console.error('[Sync] Could not read a photo out of the image store; omitting the row from this export so a replica keeps its own copy:', e);
                continue;
            }
            // `photoDataOf` returns null only for a row that genuinely holds no image and names no object.
            // Such a row exported whatever its column held before this change, so it still does.
            const out: any = { post_id: row.post_id, photo_data: photoData ?? row.photo_data ?? null, order_num: row.order_num };
            if (row.updated_at !== undefined) out.updated_at = row.updated_at;
            results[i] = { row: out };
        }
    };
    await Promise.all(Array.from({ length: Math.min(EXPORT_READ_CONCURRENCY, photos.length) }, worker));
    const omitted: string[] = [];
    (payload as any).photos = results.flatMap((r) => {
        if ('omitted' in r) { omitted.push(r.omitted); return []; }
        return [r.row];
    });
    if (omitted.length > 0) {
        // Named in the payload so a resync can keep the replica's copies. Additive: a peer that does not know
        // the field ignores it, and the rows it receives are exactly the rows it received before.
        payload.photosOmitted = omitted;
        console.warn(
            `[Sync] ⚠️  ${omitted.length} photo row(s) are NOT in this export: this node cannot read the object `
            + `each one names, so sending the row would blank a peer's or a replica's good copy. `
            + `The payload names them so a force-resync keeps them: ${omitted.slice(0, 5).join(', ')}`
            + `${omitted.length > 5 ? ', …' : ''}`,
        );
    }
    return payload;
}

export async function exportSyncState(
    cb: SyncCallbacks,
    nodeId: string,
    since?: string | null,
    commonsBalance = 0
): Promise<SyncPayload> {
    const payload = await restoreInlinePhotos(exportSyncStateEngine(db, nodeId, since, commonsBalance));
    // What kind of node this is, so a standby keeps it and a take-over or a hand promotion from there can't run
    // the community as another kind (config/node-profile.ts). node_config itself is not replicated. Before the
    // signature, so it is signed with the rest.
    payload.nodeProfile = readProfileRecord();
    // The key the `openJoins` rows are hashed with, or they match nothing on a promoted standby (engine/open-join.ts).
    // A node_config row, so here rather than in the table export. Signed with the rest.
    payload.openJoinSalt = readOpenJoinSalt();
    // Whether this node's visitors' rows are marked (db.ts markExistingVisitors), so a standby, which marks none itself,
    // knows the marks in its copy are the main server's and a promotion doesn't mark again on less. A node_config row.
    payload.visitorsMarked = visitorsMarked();
    // The recovery seal's epoch (services/recovery-seal-key.ts): new each time this main server records clearing its
    // database after sealing, so a standby that cleared under another one clears again after a rollback past the seal,
    // whichever server was updated first. Only a main server names one. A node_config row.
    if (getNodeRole() === 'primary') {
        const sealEpoch = recoverySealEpoch();
        if (sealEpoch) payload.sealEpoch = sealEpoch;
    }
    // The community's own settings (config/community-settings.ts): a standby keeps them, applied to nothing, for a
    // take-over or a hand promotion to install. In every payload, delta or whole: a settings change moves no row.
    payload.communitySettings = readCommunitySettings();
    return signSyncPayload(cb, payload);
}

function applyTombstoneLocally(tableName: string, rowKey: string, deletedAt: string): boolean {
    switch (tableName) {
        case 'friends': {
            const [owner, friend] = rowKey.split('|');
            if (!owner || !friend) return false;
            const r = db.prepare(`DELETE FROM friends WHERE owner_pubkey=? AND friend_pubkey=?`).run(owner, friend);
            return r.changes > 0;
        }
        case 'projects': {
            // As the main server's delete does (db.ts deleteCrowdfundProject): the project's trades stay, no longer naming
            // it. That write moves no trade's watermark, so it reaches a standby with the project's tombstone, here.
            db.prepare(`UPDATE transactions SET project_id = NULL WHERE project_id = ?`).run(rowKey);
            const r = db.prepare(`DELETE FROM projects WHERE id=?`).run(rowKey);
            return r.changes > 0;
        }
        case 'post_photos': {
            const [postId, orderNum] = rowKey.split('|');
            if (!postId || orderNum === undefined) return false;
            // Row now, object after the commit (storage design §7).
            const key = (db.prepare(`SELECT storage_key FROM post_photos WHERE post_id=? AND order_num=?`)
                .get(postId, Number(orderNum)) as any)?.storage_key as string | undefined;
            const r = db.prepare(`DELETE FROM post_photos WHERE post_id=? AND order_num=?`).run(postId, Number(orderNum));
            if (r.changes > 0 && key) afterTransactionCommit(() => deleteStoredObjects([key]));
            return r.changes > 0;
        }
        case 'event_rsvps': {
            const [postId, memberPubkey] = rowKey.split('|');
            if (!postId || !memberPubkey) return false;
            const r = db.prepare(`DELETE FROM event_rsvps WHERE post_id=? AND member_pubkey=?`).run(postId, memberPubkey);
            return r.changes > 0;
        }
        // The event scrub deletes a chat's messages and its membership 30 days after the event ended
        // (docs/events-on-the-map.md §2.2). A backup is a full copy, so without these two cases the
        // primary would scrub and the replica would keep the only surviving copy of a private chat and
        // of who was going. `messages` is keyed by the message id, `conversation_participants` by
        // `conversationId|publicKey`, the same shape the conversation-consolidation migration writes.
        case 'messages': {
            const r = db.prepare(`DELETE FROM messages WHERE id=?`).run(rowKey);
            return r.changes > 0;
        }
        case 'conversation_participants': {
            const [conversationId, publicKey] = rowKey.split('|');
            if (!conversationId || !publicKey) return false;
            const r = db.prepare(`DELETE FROM conversation_participants WHERE conversation_id=? AND public_key=?`).run(conversationId, publicKey);
            return r.changes > 0;
        }
        // A whole conversation deleted on the primary: the old chat groups (removed 2026-09-19, groups decision 2)
        // and the per-post threads chat consolidation collapsed. Its messages and membership go with it.
        case 'conversations': {
            const doomedObjects = (db.prepare(
                `SELECT storage_key FROM message_attachments WHERE storage_key IS NOT NULL AND message_id IN (SELECT id FROM messages WHERE conversation_id=?)`
            ).all(rowKey) as any[]).map(r => r.storage_key as string);
            db.prepare(`DELETE FROM message_attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?)`).run(rowKey);
            if (doomedObjects.length > 0) afterTransactionCommit(() => deleteStoredObjects(doomedObjects));
            db.prepare(`DELETE FROM messages WHERE conversation_id=?`).run(rowKey);
            db.prepare(`DELETE FROM conversation_participants WHERE conversation_id=?`).run(rowKey);
            const r = db.prepare(`DELETE FROM conversations WHERE id=?`).run(rowKey);
            return r.changes > 0;
        }
        // A member leaving a group (or withdrawing a request, or declining an invitation) deletes their row.
        case 'group_members': {
            const [groupId, memberPubkey] = rowKey.split('|');
            if (!groupId || !memberPubkey) return false;
            const r = db.prepare(`DELETE FROM group_members WHERE group_id=? AND member_pubkey=?`).run(groupId, memberPubkey);
            return r.changes > 0;
        }
        // A deleted enterprise (state-engine.ts deleteProject, db.ts deleteCrowdfundProject): the main server deletes its
        // keepers and keeps its row, pruned, which the copy brings. So does this standby: the row is the main server's
        // (design §4.1), and the trades that name the enterprise still name who it was. Before its rows were copied whole,
        // no row here was an enterprise, and the delete of the row this made never matched one.
        case 'members': {
            const r = db.prepare(`DELETE FROM treasury_operators WHERE treasury_pubkey=?`).run(rowKey);
            return r.changes > 0;
        }
        // A place watch its member removed, or that went with them on a prune or a self-deletion (engine/place-watches.ts).
        // Keyed by the watch's id, which is never used again, so there is no newer row to protect and no lookup below.
        case 'place_watches': {
            const r = db.prepare(`DELETE FROM place_watches WHERE id=?`).run(rowKey);
            return r.changes > 0;
        }
        // A request to join past every window it has, deleted by the main server's tidy-up (engine/knocks.ts). Keyed by
        // its id, which is never used again: no newer row to protect, and no lookup below.
        case 'join_requests': {
            const r = db.prepare(`DELETE FROM join_requests WHERE id=?`).run(rowKey);
            return r.changes > 0;
        }
        // A moderation notice past its member's bounds, or gone with them on a prune or a self-deletion
        // (engine/kept-notices.ts). Keyed by its id, which is never used again: no newer row to protect, and no lookup below.
        case 'moderation_notices': {
            const r = db.prepare(`DELETE FROM moderation_notices WHERE id=?`).run(rowKey);
            return r.changes > 0;
        }
        // A key a member unblocked (`<owner>|<blocked>`), or a whole list gone with a clear, a prune, a self-deletion or a
        // re-key's old key (`<owner>|*`, engine/member-blocks.ts): every row of that owner stamped no later, and the owner's
        // single-unblock tombstones it replaces, as on the main server. A block made again is stamped after either, so
        // the lookup below keeps it, and so does the stamp test here.
        case 'member_blocks': {
            const cut = rowKey.indexOf('|');
            if (cut <= 0) return false;
            const owner = rowKey.slice(0, cut);
            if (rowKey.slice(cut + 1) === '*') {
                db.prepare(`DELETE FROM tombstones WHERE ${PAIR_TOMBSTONES_OF} AND deleted_at <= ?`).run(owner, owner, owner, deletedAt);
                return db.prepare(`DELETE FROM member_blocks WHERE owner_pubkey=? AND updated_at <= ?`).run(owner, deletedAt).changes > 0;
            }
            const r = db.prepare(`DELETE FROM member_blocks WHERE owner_pubkey=? AND blocked_pubkey=?`).run(owner, rowKey.slice(cut + 1));
            return r.changes > 0;
        }
        // A member's recovery copies the main server deleted (engine/recovery-shares.ts deleteAllShares): of this
        // generation or an older one, and stamped no later than the deletion, so a copy it holds now stays. No lookup
        // below: a later copy must not keep the older ones, so each row is judged by itself.
        case 'recovery_shares':
            return deleteTombstonedCopies(rowKey, deletedAt) > 0;
        default:
            console.warn(`[Sync] Ignoring tombstone for unknown table: ${tableName}`);
            return false;
    }
}

/**
 * The tables whose tombstone row key holds a member's key, and which of its `|` parts do: the rows a re-key moves to the
 * new key (engine/key-move.ts moveMemberKeyRows). Every other table's tombstone is keyed by an id or a post, which a
 * re-key leaves as it is. `members` is left out: its tombstone is an enterprise's treasury row, the row a re-key needs,
 * so no main server deletes it and then re-keys it.
 */
const MEMBER_KEY_PARTS: Record<string, number[]> = {
    friends: [0, 1],
    event_rsvps: [1],
    conversation_participants: [1],
    group_members: [1],
    // The owner (engine/recovery-shares.ts recoveryTombstoneKey). Its copies stay under the old key when this standby
    // follows (dropMovedRecoveryCopies goes by the main server's), so either order ends the same; this keeps the main
    // server's.
    recovery_shares: [0],
};

function tombstoneNamesKey(ts: { tableName: string; rowKey: string }, key: string): boolean {
    const parts = MEMBER_KEY_PARTS[ts.tableName];
    if (!parts) return false;
    const fields = ts.rowKey.split('|');
    return parts.some((i) => fields[i] === key);
}

function lookupLocalUpdatedAt(tableName: string, rowKey: string): string | null {
    switch (tableName) {
        case 'friends': {
            const [owner, friend] = rowKey.split('|');
            if (!owner || !friend) return null;
            const r = db.prepare(`SELECT added_at AS ts FROM friends WHERE owner_pubkey=? AND friend_pubkey=?`).get(owner, friend) as { ts: string } | undefined;
            return r?.ts ?? null;
        }
        case 'projects': {
            const r = db.prepare(`SELECT updated_at AS ts FROM projects WHERE id=?`).get(rowKey) as { ts: string } | undefined;
            return r?.ts ?? null;
        }
        case 'post_photos': {
            const [postId, orderNum] = rowKey.split('|');
            if (!postId || orderNum === undefined) return null;
            const r = db.prepare(`SELECT updated_at AS ts FROM post_photos WHERE post_id=? AND order_num=?`).get(postId, Number(orderNum)) as { ts: string } | undefined;
            return r?.ts ?? null;
        }
        case 'event_rsvps': {
            const [postId, memberPubkey] = rowKey.split('|');
            if (!postId || !memberPubkey) return null;
            const r = db.prepare(`SELECT updated_at AS ts FROM event_rsvps WHERE post_id=? AND member_pubkey=?`).get(postId, memberPubkey) as { ts: string } | undefined;
            return r?.ts ?? null;
        }
        case 'messages': {
            const r = db.prepare(`SELECT updated_at AS ts FROM messages WHERE id=?`).get(rowKey) as { ts: string } | undefined;
            return r?.ts ?? null;
        }
        // Meaningful only because the import above stores the PRIMARY's updated_at: a member who left an
        // event chat and rejoined has a row stamped after their tombstone, and must not be deleted again.
        case 'conversation_participants': {
            const [conversationId, publicKey] = rowKey.split('|');
            if (!conversationId || !publicKey) return null;
            const r = db.prepare(`SELECT updated_at AS ts FROM conversation_participants WHERE conversation_id=? AND public_key=?`).get(conversationId, publicKey) as { ts: string } | undefined;
            return r?.ts ?? null;
        }
        // A member who left and rejoined has a row stamped after their tombstone, and must not be deleted again.
        case 'group_members': {
            const [groupId, memberPubkey] = rowKey.split('|');
            if (!groupId || !memberPubkey) return null;
            const r = db.prepare(`SELECT updated_at AS ts FROM group_members WHERE group_id=? AND member_pubkey=?`).get(groupId, memberPubkey) as { ts: string } | undefined;
            return r?.ts ?? null;
        }
        case 'members': {
            const r = db.prepare(`SELECT updated_at AS ts FROM members WHERE public_key=?`).get(rowKey) as { ts: string } | undefined;
            return r?.ts ?? null;
        }
        // A block made again after an unblock is stamped after the unblock's tombstone, and must not be deleted by it. A
        // whole list's `<owner>|*` judges each row by its stamp itself; the one here, if later, is kept over an older one.
        case 'member_blocks': {
            const cut = rowKey.indexOf('|');
            if (cut <= 0) return null;
            if (rowKey.slice(cut + 1) === '*') {
                const t = db.prepare(`SELECT deleted_at AS ts FROM tombstones WHERE table_name='member_blocks' AND row_key=?`).get(rowKey) as { ts: string } | undefined;
                return t?.ts ?? null;
            }
            const r = db.prepare(`SELECT updated_at AS ts FROM member_blocks WHERE owner_pubkey=? AND blocked_pubkey=?`)
                .get(rowKey.slice(0, cut), rowKey.slice(cut + 1)) as { ts: string } | undefined;
            return r?.ts ?? null;
        }
        default:
            return null;
    }
}

const GROUP_ROLES = new Set(['convenor', 'member', 'observer']);
const GROUP_MEMBER_STATUSES = new Set(['active', 'pending_approval', 'invited', 'removed']);

/**
 * Who may see a post, as columns: audience_scope, target_group_id, target_pubkey, assigned_to, reach, reach_peers.
 * A payload without them (an older primary) gets the column defaults, which is no worse than before.
 */
function postScope(rp: any): [string, string | null, string | null, string | null, string, string | null] {
    const scope = rp.audienceScope === 'group' || rp.audienceScope === 'direct' ? rp.audienceScope : 'public';
    const reach = rp.reach === 'peers' || rp.reach === 'everywhere' ? rp.reach : 'local';
    const peers = reach === 'peers' && Array.isArray(rp.reachPeers) && rp.reachPeers.length > 0
        ? JSON.stringify(rp.reachPeers) : null;
    return [scope, rp.targetGroupId ?? null, rp.targetPubkey ?? null, rp.assignedTo ?? null, reach, peers];
}

/**
 * hidden_by_reports_at, removed_by_moderator_at (G3, engine/auto-moderation.ts), in that order. Plain assignment on
 * update: a restore clears the hide on the replica too. A main server from before G3 sends neither, and never set
 * either, so null is what it holds.
 */
function postModeration(rp: any): [string | null, string | null] {
    return [instantOrNull(rp.hiddenByReportsAt), instantOrNull(rp.removedByModeratorAt)];
}

/**
 * cash_also_needed, search_keywords (G1b), in that order: the cash note the "Beans only" filter reads, and the main
 * server's search words, synonyms included. A payload without the words (an older main server) sends null, and the row
 * keeps what it has (the INSERT's ''), which the boot backfill fills (state-engine.ts backfillSearchKeywords).
 */
function postSearch(rp: any): [number, string | null] {
    return [rp.cashAlsoNeeded ? 1 : 0, typeof rp.searchKeywords === 'string' ? rp.searchKeywords : null];
}

// members.area_lat / area_lng / area_updated_at (G4) come from importedArea (engine/member-area.ts): plain assignment,
// so a member who clears their area on the main server has none here either.

/** members.moderation_muted_until (G3): plain assignment, so a lift on the main server lifts it here too. */
function mutedUntil(rm: any): string | null {
    return instantOrNull(rm.moderationMutedUntil);
}

/**
 * members.deleted_by_owner_at: when the key's owner deleted the account, which nothing brings back. The main server sets
 * it once and never clears it, so an update keeps the one this copy has when a main server from before it sends none.
 */
function deletedByOwnerAt(rm: any): string | null {
    return instantOrNull(rm.deletedByOwnerAt);
}

/**
 * members.board_standing_changed_at: when what decides whether the board shows the member's listings last changed, which
 * the Market delta reads (engine posts.ts). The main server's, as it wrote it. It never clears one, so an update keeps
 * this copy's when a main server from before the column sends none; then a `status` it sends that changes the member's
 * standing stamps it here (members_touch_board_standing).
 */
function boardStandingChangedAt(rm: any): string | null {
    return instantOrNull(rm.boardStandingChangedAt);
}

/**
 * members.is_visitor, as the main server has it: 1 or 0, so a visitor who joins there is a member here too. Null from a
 * main server that predates the column, which sends no `isVisitor`: an update then keeps this row's own, and a new row
 * is a member's (the column's default), as every row was there. Once that server upgrades it marks its visitors
 * (db.ts markExistingVisitors) and stamps each row, so its next copy carries the mark.
 */
function importedVisitor(rm: any): 0 | 1 | null {
    return typeof rm.isVisitor === 'boolean' ? (rm.isVisitor ? 1 : 0) : null;
}

function instantOrNull(v: unknown): string | null {
    return typeof v === 'string' && v ? v : null;
}

const ENFORCE_LEDGER_AUTH = process.env.ENFORCE_LEDGER_AUTH === 'true';
const LEDGER_CONSERVATION_TOLERANCE = 0.5;

/**
 * The largest balance a copy may carry: 900,719,925,474.0991 Beans, Number.MAX_SAFE_INTEGER / 10,000. The ledger's
 * smallest unit is 0.0001 Bean (the engine rounds to it, round4), and past this a balance in those units is no longer a
 * safe integer, so it can't be held to the unit. No real ledger comes near it: every Bean an account holds is credit some
 * other account spent, and credit lines are a few thousand Beans (an earned one tops out below 1,920), so one account at
 * this bound takes some 470 million members each spending a full line into it. A copy carrying a balance beyond it, or one
 * that isn't a finite number (JSON's 1e400 parses to Infinity), is refused before anything is written.
 *
 * It also keeps the conservation guard's sum exact enough: SQLite's SUM compensates its rounding (Kahan-Babuska-Neumaier,
 * since 3.43; this build's better-sqlite3 carries 3.51), so over any copy the row cap lets in (250,000 accounts by default,
 * at most this much each) its error, beyond rounding the total itself, is under 1e-8 Beans. A running sum of doubles loses
 * up to half a step of the running total at each account instead (16 Beans near 2e17).
 */
const MAX_LEDGER_BALANCE = Number.MAX_SAFE_INTEGER / 10_000;

/** What this server's ledger holds between all its accounts, as SQLite sums it (compensated, MAX_LEDGER_BALANCE). */
function ledgerTotal(): number {
    return (db.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM accounts').get() as { s: number }).s;
}

function isRegularMemberAccount(pk: string): boolean {
    return pk !== 'COMMONS_POOL' && pk !== 'SYSTEM' && pk !== 'genesis'
        && !pk.startsWith('escrow_') && !pk.startsWith('project_');
}

function verifyTransactionAuthorship(tx: Transaction): boolean {
    if (!isRegularMemberAccount(tx.from) || !isRegularMemberAccount(tx.to)) return true;
    if (!tx.authSigner || !tx.authSignature || !tx.authPayload) return false;
    try {
        const spki = Buffer.concat([
            Buffer.from('302a300506032b6570032100', 'hex'),
            Buffer.from(tx.authSigner, 'hex'),
        ]);
        const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
        // The stored payload is the text signed, in either request format (@beanpool/core request-signing.ts): a
        // format-2 text (`beanpool-request/2\n<host>\n…`) was signed as 0xFF then the text, and its body starts after
        // line 6; an old one was signed as plain text, its body after line 4. Which community it named was checked by
        // the main server that accepted it; this re-checks who signed it and what it moved.
        const sigOk = crypto.verify(
            undefined, Buffer.from(bytesOfSignedText(tx.authPayload)), key, Buffer.from(tx.authSignature, 'base64'),
        );
        if (!sigOk) return false;
        if (tx.authSigner !== tx.from) return false;
        const body = bodyOfSignedText(tx.authPayload);
        const signed = JSON.parse(body || '{}');
        if (String(signed.to) !== String(tx.to)) return false;
        if (Number(signed.amount) !== Number(tx.amount)) return false;
        if (String(signed.memo ?? '') !== String(tx.memo ?? '')) return false;
        return true;
    } catch {
        return false;
    }
}

/**
 * What the puller decided about a copy before it asked for it (services/backup-puller.ts pullOnce), from this standby's
 * own records and never from anything a copy carries or changes.
 */
export interface ImportOptions {
    /**
     * A seed, which the conservation guard lets in whatever it sums to. Only three: this standby's first copy (it holds
     * none it landed: no `replica_format` record, replicaFormatOfCopy), the format re-seed (REPLICA_FORMAT, this
     * standby's own constant) and an operator's force-resync. Every other copy is held to the ledger here.
     */
    seed?: boolean;
    /**
     * Not a seed, and the ledger here isn't what to hold the copy to: this standby cleared it for a force-resync of its
     * own (a whole copy that didn't match), and this is the total it had before that clear (clearForResync).
     */
    heldToSum?: number | null;
}

/**
 * The touch triggers (db/schema.sql) of the tables whose rows this import writes with the main server's own stamps. Each
 * stamps `updated_at` with this server's clock on an UPDATE that leaves it as it was, so a copy that sends a row again
 * with its stamp unchanged (a whole copy, the deals' upsert) would restamp it here: after a take-over, phones' deltas and
 * every later tombstone are judged against that stamp (design §4.1: no trigger writes a replicated table during an
 * import). Set aside inside the import's transaction and put back exactly as the database held them, as the keyword
 * backfill does (state-engine.ts backfillSearchKeywords); a copy that throws rolls the drop back with the rest.
 */
const IMPORT_KEEPS_STAMPS = [
    'posts_touch_updated_at', 'post_photos_touch_updated_at', 'marketplace_transactions_touch_updated_at', 'projects_touch_updated_at',
] as const;

/**
 * The members' triggers, set aside too when the copy carries the members' whole rows (`standing`): the import then writes
 * `updated_at` and `board_standing_changed_at` as the main server holds them, and neither trigger may stamp either with
 * this server's clock (a pause copied onto a row whose standing stamp is already the main server's, a re-key followed
 * here). A main server older than `standing` sends neither, and the board standing trigger still stamps a change of
 * `status` it sends, as it did.
 */
const MEMBERS_KEEP_STAMPS = ['members_touch_updated_at', 'members_touch_board_standing'] as const;

/** Drops the named touch triggers; the function it returns creates again the ones this database had. In a transaction. */
function setTouchTriggersAside(names: readonly string[]): () => void {
    const held: string[] = [];
    for (const name of names) {
        const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(name) as { sql: string } | undefined)?.sql;
        if (!sql) continue;
        held.push(sql);
        db.exec(`DROP TRIGGER ${name}`);
    }
    return () => { for (const sql of held) db.exec(sql); };
}

/** A value SQLite stores as the main server held it: text, a finite number, or null. Anything else is left out. */
function isColumnValue(v: unknown): v is string | number | null {
    return v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * A member's row as the main server holds it (`standing`, design G2a, §4.1): every key of it that is a column of this
 * table, checked against this database's own `PRAGMA table_info` (a name the copy carries is never put in SQL unchecked),
 * with the main server's `updated_at`. No value here outlives the copy's: the main server is this standby's only writer
 * and the puller refuses an older copy, so a row that differs in any column is written, whatever its stamp (a withdrawn
 * vouch, a lifted freeze, an unset pin). A column this table has and the copy doesn't name (a standby newer than its main
 * server) keeps its own value, or its default on a new row. Returns 'new', 'updated' or null (already the main server's).
 */
function writeMemberStanding(
    memberColumns: ReadonlySet<string>, cache: Map<string, Database.Statement>, publicKey: string,
    standing: Record<string, unknown>, updatedAt: unknown,
): 'new' | 'updated' | null {
    const columns = Object.keys(standing).filter((c) => memberColumns.has(c) && isColumnValue(standing[c])).sort();
    const stamp = typeof updatedAt === 'string' && updatedAt ? updatedAt : null;
    const existing = db.prepare('SELECT * FROM members WHERE public_key = ?').get(publicKey) as Record<string, unknown> | undefined;
    const values = columns.map((c) => standing[c] as string | number | null);
    const q = (c: string) => `"${c}"`;
    if (!existing) {
        const sql = `INSERT INTO members (public_key, ${columns.map(q).join(', ')}${columns.length ? ', ' : ''}updated_at) VALUES (?, ${columns.map(() => '?, ').join('')}?)`;
        let insert = cache.get(sql);
        if (!insert) cache.set(sql, insert = db.prepare(sql));
        insert.run(publicKey, ...values, stamp);
        return 'new';
    }
    if (existing.updated_at === stamp && columns.every((c, i) => existing[c] === values[i])) return null;
    const sql = `UPDATE members SET ${columns.map((c) => `${q(c)} = ?, `).join('')}updated_at = ? WHERE public_key = ?`;
    let update = cache.get(sql);
    if (!update) cache.set(sql, update = db.prepare(sql));
    update.run(...values, stamp, publicKey);
    return 'updated';
}

/**
 * A member's preferences as the main server holds them (design G2b): the copy names every one the member has, so this
 * member's rows here are replaced by them when they differ. A malformed entry is left out. Only for a member this database
 * has (the members import above wrote each one the copy names).
 */
function replaceMemberPreferences(publicKey: string, preferences: Record<string, unknown>): boolean {
    const incoming = new Map<string, string>();
    for (const [key, value] of Object.entries(preferences)) {
        if (key.length > 0 && key.length <= 200 && typeof value === 'string' && value.length <= 10_000) incoming.set(key, value);
    }
    const here = db.prepare('SELECT pref_key, pref_value FROM member_preferences WHERE public_key = ?').all(publicKey) as { pref_key: string; pref_value: string }[];
    if (here.length === incoming.size && here.every((r) => incoming.get(r.pref_key) === r.pref_value)) return false;
    db.prepare('DELETE FROM member_preferences WHERE public_key = ?').run(publicKey);
    const insert = db.prepare('INSERT INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, ?, ?)');
    for (const [key, value] of incoming) insert.run(publicKey, key, value);
    return true;
}

/**
 * Who keeps each enterprise, as the main server holds it (design G2c): the copy carries the whole set, so it is applied as a
 * diff, a row it no longer has (a keeper unbound, an enterprise deleted) deleted here. After the re-key follow, which has
 * moved this standby's rows to the new keys the main server's rows name. A malformed row is left out and counted.
 */
function replaceTreasuryOperators(rows: unknown[]): { changes: number; skipped: number } {
    const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
    const orNull = <T>(v: unknown, ok: (x: unknown) => x is T): T | null => (ok(v) ? v : null);
    const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    const here = new Map((db.prepare('SELECT * FROM treasury_operators').all() as Record<string, unknown>[])
        .map((r) => [`${r.treasury_pubkey}|${r.member_pubkey}`, r]));
    const upsert = db.prepare(`INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_at, granted_by, backing, auto_promoted_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?)
                               ON CONFLICT(treasury_pubkey, member_pubkey) DO UPDATE SET
                                   role = excluded.role, granted_at = excluded.granted_at, granted_by = excluded.granted_by,
                                   backing = excluded.backing, auto_promoted_at = excluded.auto_promoted_at`);
    const named = new Set<string>();
    let changes = 0, skipped = 0;
    for (const raw of rows) {
        const r = raw as Record<string, unknown> | null;
        if (!r || !text(r.treasuryPubkey) || !text(r.memberPubkey) || !text(r.role)) { skipped++; continue; }
        const key = `${r.treasuryPubkey}|${r.memberPubkey}`;
        named.add(key);
        const row = [r.role, orNull(r.grantedAt, text), orNull(r.grantedBy, text), orNull(r.backing, isNumber), orNull(r.autoPromotedAt, text)] as const;
        const mine = here.get(key);
        if (mine && mine.role === row[0] && mine.granted_at === row[1] && mine.granted_by === row[2] && mine.backing === row[3] && mine.auto_promoted_at === row[4]) continue;
        upsert.run(r.treasuryPubkey, r.memberPubkey, ...row);
        changes++;
    }
    const drop = db.prepare('DELETE FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?');
    for (const [key, r] of here) {
        if (named.has(key)) continue;
        drop.run(r.treasury_pubkey, r.member_pubkey);
        changes++;
    }
    return { changes, skipped };
}

/**
 * Keepers' pledges as the main server holds them (design G2c), each row by its id, every column. A pledge is made and then
 * released, never deleted, so nothing here is deleted either. A malformed row is left out and counted.
 */
function mergeEnterprisePledges(rows: unknown[]): { changes: number; skipped: number } {
    const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
    const upsert = db.prepare(`INSERT INTO enterprise_pledges (id, keeper, enterprise, amount, pledged_at, released_at)
                               VALUES (?, ?, ?, ?, ?, ?)
                               ON CONFLICT(id) DO UPDATE SET
                                   keeper = excluded.keeper, enterprise = excluded.enterprise, amount = excluded.amount,
                                   pledged_at = excluded.pledged_at, released_at = excluded.released_at
                               WHERE enterprise_pledges.keeper IS NOT excluded.keeper OR enterprise_pledges.enterprise IS NOT excluded.enterprise
                                  OR enterprise_pledges.amount IS NOT excluded.amount OR enterprise_pledges.pledged_at IS NOT excluded.pledged_at
                                  OR enterprise_pledges.released_at IS NOT excluded.released_at`);
    let changes = 0, skipped = 0;
    for (const raw of rows) {
        const r = raw as Record<string, unknown> | null;
        if (!r || !text(r.id) || !text(r.keeper) || !text(r.enterprise) || typeof r.amount !== 'number' || !(r.amount > 0) || !Number.isFinite(r.amount)
            || (r.pledgedAt !== null && !text(r.pledgedAt)) || (r.releasedAt !== null && !text(r.releasedAt))) {
            skipped++;
            continue;
        }
        changes += upsert.run(r.id, r.keeper, r.enterprise, r.amount, r.pledgedAt, r.releasedAt).changes;
    }
    return { changes, skipped };
}

export async function importRemoteState(cb: SyncCallbacks, remote: SyncPayload, opts: ImportOptions = {}): Promise<ImportResult> {
    const seed = opts.seed === true;
    const heldToSum = typeof opts.heldToSum === 'number' && Number.isFinite(opts.heldToSum) ? opts.heldToSum : null;
    const role = getNodeRole();
    if (role !== 'backup') {
        throw new Error(`[Sync] This node runs as '${role}', which imports no remote state (one-directional backup topology). Inbound state rejected.`);
    }

    if (!remote.signature || !remote.publicKey) {
        throw new Error(`[Sync] Cryptographic validation failed: Missing SyncPayload signature or publicKey`);
    }

    // #134: Hoist signerPeerId so it's available for the audit log write after the import.
    let signerPeerId = 'unknown';
    try {
        const { signature, publicKey, ...basePayload } = remote;
        const serialized = JSON.stringify(basePayload);
        
        const pubKeyBuffer = Buffer.from(publicKey, 'hex');
        const pubKey = cb.publicKeyFromProtobuf(pubKeyBuffer);
        
        const isValid = await pubKey.verify(
            new TextEncoder().encode(serialized),
            Buffer.from(signature, 'hex')
        );

        if (!isValid) {
            throw new Error('Invalid cryptographic signature.');
        }

        const { peerIdFromPublicKey } = await import('@libp2p/peer-id');
        signerPeerId = peerIdFromPublicKey(pubKey as any).toString();
        const { isPeerTrusted } = await import('../connector-manager.js');
        const signerTrust = isPeerTrusted(signerPeerId);
        if (!signerTrust.trusted || signerTrust.trustLevel === 'blocked') {
            throw new Error(`Sync payload signing key maps to untrusted peer ${signerPeerId.slice(-8)}`);
        }

        if (signerTrust.trustLevel !== 'mirror') {
            throw new Error(`Sync payload signer ${signerPeerId.slice(-8)} is a '${signerTrust.trustLevel}' connector; only 'mirror' connectors may import state`);
        }

        console.log(`[Sync] ✓ Cryptographically validated sync payload from trusted mirror: ${signerPeerId.slice(-8)} (nodeId: ${remote.nodeId})`);
    } catch (e: any) {
        console.error(`[Sync] ❌ SyncPayload signature validation failed:`, e.message || e);
        throw new Error(`Cryptographic sync payload verification failed: ${e.message}`);
    }

    const MAX_IMPORT_ROWS = Number(process.env.MAX_IMPORT_ROWS_PER_CATEGORY) || 250_000;
    const importCategories: (keyof SyncPayload)[] = [
        'members', 'posts', 'photos', 'projects', 'ratings', 'accounts', 'transactions',
        'marketplaceTransactions', 'friends', 'conversations', 'conversationParticipants',
        'messages', 'abuseReports', 'creatorChannels', 'pulseItems', 'recoveryRequests', 'recoveryApprovals', 'recoveryShares', 'recoveryPins', 'settlements', 'pollVotes', 'eventRsvps', 'groups', 'groupMembers', 'openJoins', 'placeWatches', 'directoryCache', 'joinRequests', 'moderationNotices', 'memberBlocks', 'invalidatedKeys', 'treasuryOperators', 'enterprisePledges', 'tombstones',
    ];
    for (const cat of importCategories) {
        const arr = remote[cat];
        if (Array.isArray(arr) && arr.length > MAX_IMPORT_ROWS) {
            throw new Error(`[Sync] Import payload category '${String(cat)}' has ${arr.length} rows (> ${MAX_IMPORT_ROWS}); rejecting oversized payload to protect the event loop`);
        }
    }
    // A balance no ledger holds (MAX_LEDGER_BALANCE), before anything is written, the photo store included. An entry with
    // no number for a balance isn't one: the import leaves that account as it is, and the whole-copy check counts it.
    // A conservation violation, as the guard's refusals are, so the puller logs it at SECURITY, not as a pull to retry.
    for (const acc of Array.isArray(remote.accounts) ? remote.accounts : []) {
        const b = acc?.balance as unknown;
        if (typeof b === 'number' && !(Math.abs(b) <= MAX_LEDGER_BALANCE)) {
            throw new Error(`[Sync] Conservation violation: import payload account ${String(acc?.publicKey).slice(0, 16)} has a balance of ${b}, beyond what any ledger holds (|balance| ≤ ${MAX_LEDGER_BALANCE}); rejecting payload`);
        }
    }

    let newMembers = 0, newPosts = 0;
    let updatedMembers = 0, updatedPosts = 0;
    let newTransactions = 0, accountChanges = 0, marketplaceTxns = 0, newMessages = 0;
    let tombstonesApplied = 0, conflictsSkipped = 0, recoverySharesImported = 0;
    let groupChanges = 0;
    // Preferences, keepers and pledges written (design G2b, G2c).
    let standingChanges = 0;

    // Photos go through the store BEFORE the transaction opens, never inside it — the same rule the create
    // and update paths keep (`storedPhotoColumns` in engine/posts.ts). Each `store.put` is a mkdir, a temp
    // write, an `fsyncSync` and a rename; doing that per photo while holding the write lock would, on a
    // force-resync or a first full snapshot, stall a 1 vCPU node for one fsync per photo — thousands of them
    // on a mature node — with nothing else able to run.
    //
    // It also keeps a failed import honest. If the transaction rolls back after the puts, the objects it
    // wrote are orphans, but they are content-addressed: the retry re-derives the same keys and re-uses
    // them, and the storage-health sweep reclaims whatever is genuinely left over.
    const importedPhotoColumns = remote.photos ? await storeImportedPhotos(remote.photos) : null;

    currentImportOrigin = remote.nodeId;
    db.pragma('foreign_keys = OFF');

    // A main server that sends its members' whole rows (`standing`) sends its keepers too, the whole set in every copy: the
    // members' own triggers are set aside for such a copy (MEMBERS_KEEP_STAMPS).
    const standingCopy = Array.isArray(remote.treasuryOperators) || (remote.members ?? []).some((rm) => isPlainObject(rm?.standing));

    try {
        db.transaction(() => {
            // The ledger's total before this copy writes anything, what the conservation guard holds it to (below).
            const totalBefore = ledgerTotal();
            const putTouchTriggersBack = setTouchTriggersAside(standingCopy ? [...IMPORT_KEEPS_STAMPS, ...MEMBERS_KEEP_STAMPS] : IMPORT_KEEPS_STAMPS);
            const applyTombstones = (tombstones: NonNullable<SyncPayload['tombstones']>) => {
                for (const ts of tombstones) {
                    const localTs = lookupLocalUpdatedAt(ts.tableName, ts.rowKey);
                    if (localTs && localTs > ts.deletedAt) {
                        conflictsSkipped++;
                        continue;
                    }
                    const deleted = applyTombstoneLocally(ts.tableName, ts.rowKey, ts.deletedAt);
                    db.prepare(`INSERT OR REPLACE INTO tombstones (table_name, row_key, deleted_at)
                                VALUES (?, ?, ?)`).run(ts.tableName, ts.rowKey, ts.deletedAt);
                    if (deleted) tombstonesApplied++;
                    if (deleted && ts.tableName === 'group_members') groupChanges++;
                }
            };
            const tombstones = remote.tombstones ?? [];
            const appliedBeforeRekey = new Set<(typeof tombstones)[number]>();

            // The keys the main server replaced (engine/key-move.ts), first: a re-key there is followed here before the copy's
            // rows go in, so the member's row under the new key updates the moved row instead of meeting the old key's row
            // on the callsign index, and every row that named the old key names the new one, as there. A main server older
            // than this sends none, and this standby keeps the keys it has.
            // Before each re-key it follows, this copy's tombstones that name the old key, in the main server's order: it
            // deleted those rows, then re-keyed. After the move they would match no row, be recorded as applied all the same,
            // and the rows would be back under the new key (a member un-RSVPed, unfriended, or out of a group's chat, and a
            // server that takes over sending them its lines). Each one is from before that re-key: after it, no row there
            // names the old key. A delete between two re-keys names the key between them, and goes before the second.
            let followedRekeys: ReplicatedRekey[] = [];
            if (Array.isArray(remote.invalidatedKeys)) {
                followedRekeys = followReplicatedRekeys(mergeReplicatedInvalidatedKeys(remote.invalidatedKeys).rekeys, (rekey) => {
                    const naming = tombstones.filter((ts) => !appliedBeforeRekey.has(ts) && tombstoneNamesKey(ts, rekey.oldKey));
                    applyTombstones(naming);
                    for (const ts of naming) appliedBeforeRekey.add(ts);
                });
                noteReplacedKeysFromMainServer();
            }

            // This table's own columns, which alone a member's `standing` may name; never the key or the stamp, written apart.
            const memberColumns = new Set((db.prepare('SELECT name FROM pragma_table_info(?)').all('members') as { name: string }[])
                .map((c) => c.name).filter((c) => c !== 'public_key' && c !== 'updated_at'));
            const standingStatements = new Map<string, Database.Statement>();
            for (const rm of remote.members ?? []) {
                // The main server's whole row (design G2a, §4.1): every column as it holds it. The special cases below (the
                // visitor's mark never lowered by a copy, the owner's delete kept, the first voucher kept) are for a main
                // server older than that, which sends its members as a fixed list of fields.
                if (isPlainObject(rm.standing)) {
                    if (typeof rm.publicKey !== 'string' || !rm.publicKey) { conflictsSkipped++; continue; }
                    const wrote = writeMemberStanding(memberColumns, standingStatements, rm.publicKey, rm.standing, rm.updatedAt);
                    if (wrote === 'new') newMembers++;
                    else if (wrote === 'updated') updatedMembers++;
                    continue;
                }
                const existing = db.prepare("SELECT updated_at, is_visitor, board_standing_changed_at FROM members WHERE public_key=?").get(rm.publicKey) as { updated_at: string | null; is_visitor: number | null; board_standing_changed_at: string | null } | undefined;
                if (!existing) {
                    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, home_node_url, avatar_url, bio, contact_value, contact_visibility, status, last_active_at, elder_vouched_by, archetype, updated_at, moderation_muted_until,
                                area_lat, area_lng, area_updated_at, is_visitor, deleted_by_owner_at, board_standing_changed_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                        rm.publicKey,
                        rm.callsign,
                        rm.joinedAt,
                        rm.invitedBy,
                        rm.inviteCode,
                        rm.homeNodeUrl || null,
                        rm.avatarUrl || null,
                        rm.bio || null,
                        rm.contactValue || null,
                        rm.contactVisibility || null,
                        rm.status || 'active',
                        rm.lastActiveAt || null,
                        rm.elderVouchedBy || null,
                        rm.archetype || null,
                        rm.updatedAt || rm.joinedAt,
                        mutedUntil(rm),
                        ...importedArea(rm),
                        importedVisitor(rm) ?? 0,
                        deletedByOwnerAt(rm),
                        boardStandingChangedAt(rm)
                    );
                    // No account row here: the copy's own account set brings the member's (below). One made here was
                    // stamped with this standby's clock and then kept over the main server's older row (G0).
                    newMembers++;
                } else {
                    if (rm.updatedAt && existing.updated_at && existing.updated_at >= rm.updatedAt) {
                        // The same version of the row with another mark: a row an import from before the column copied
                        // (no mark, the main server's stamp), which the main server never stamps again (4110436371). The
                        // main server is the only writer of a standby's copy, so its mark is the row's. The touch trigger
                        // restamps a change of the mark, so the main server's stamp is put back (updated_at fires nothing).
                        const visitor = importedVisitor(rm);
                        // Likewise the board standing a node fills once as it gains the column (db.ts backfillBoardStanding),
                        // which stamps no row: this copy filled its own, and a whole copy brings the main server's. Setting it
                        // fires no trigger.
                        const standing = boardStandingChangedAt(rm);
                        let took = false;
                        if (existing.updated_at === rm.updatedAt && visitor !== null && visitor !== existing.is_visitor) {
                            db.prepare('UPDATE members SET is_visitor = ? WHERE public_key = ?').run(visitor, rm.publicKey);
                            db.prepare('UPDATE members SET updated_at = ? WHERE public_key = ?').run(rm.updatedAt, rm.publicKey);
                            took = true;
                        }
                        if (existing.updated_at === rm.updatedAt && standing !== null && standing !== existing.board_standing_changed_at) {
                            db.prepare('UPDATE members SET board_standing_changed_at = ? WHERE public_key = ?').run(standing, rm.publicKey);
                            took = true;
                        }
                        if (took) updatedMembers++;
                        else conflictsSkipped++;
                        continue;
                    }
                    // A visitor who joined on the primary: the row takes the join with it (who invited them, the code and
                    // when), which the update below otherwise leaves as it was. Before the update, which stamps updated_at.
                    if (existing.is_visitor && importedVisitor(rm) === 0) {
                        db.prepare("UPDATE members SET invited_by = ?, invite_code = ?, joined_at = ? WHERE public_key = ?")
                            .run(rm.invitedBy ?? null, rm.inviteCode ?? null, rm.joinedAt, rm.publicKey);
                    }
                    const res = db.prepare(`UPDATE members SET
                        callsign = ?,
                        avatar_url = ?,
                        bio = ?,
                        contact_value = ?,
                        contact_visibility = ?,
                        status = ?,
                        last_active_at = ?,
                        elder_vouched_by = COALESCE(elder_vouched_by, ?),
                        archetype = ?,
                        moderation_muted_until = ?,
                        area_lat = ?,
                        area_lng = ?,
                        area_updated_at = ?,
                        is_visitor = COALESCE(?, is_visitor),
                        deleted_by_owner_at = COALESCE(?, deleted_by_owner_at),
                        board_standing_changed_at = COALESCE(?, board_standing_changed_at),
                        updated_at = ?
                        WHERE public_key = ?`).run(
                        rm.callsign,
                        rm.avatarUrl || null,
                        rm.bio || null,
                        rm.contactValue || null,
                        rm.contactVisibility || null,
                        rm.status || 'active',
                        rm.lastActiveAt || null,
                        rm.elderVouchedBy || null,
                        rm.archetype || null,
                        mutedUntil(rm),
                        ...importedArea(rm),
                        importedVisitor(rm),
                        deletedByOwnerAt(rm),
                        boardStandingChangedAt(rm),
                        rm.updatedAt || existing.updated_at || new Date().toISOString(),
                        rm.publicKey
                    );
                    if (res.changes > 0) updatedMembers++;
                }
            }

            // Each member's preferences, with their row (design G2b): holiday, notification settings, reminder defaults.
            // A main server older than this sends none, and this standby keeps the rows it has.
            for (const rm of remote.members ?? []) {
                if (isPlainObject(rm.preferences) && replaceMemberPreferences(rm.publicKey, rm.preferences)) standingChanges++;
            }
            // Who keeps each enterprise, the whole set, after the re-key follow above (design G2c, §5.3), and the keepers'
            // pledges. A main server older than this sends neither, and this standby keeps the rows it has.
            if (Array.isArray(remote.treasuryOperators)) {
                const kept = replaceTreasuryOperators(remote.treasuryOperators);
                standingChanges += kept.changes;
                conflictsSkipped += kept.skipped;
            }
            if (Array.isArray(remote.enterprisePledges)) {
                const pledged = mergeEnterprisePledges(remote.enterprisePledges);
                standingChanges += pledged.changes;
                conflictsSkipped += pledged.skipped;
            }

            for (const rp of remote.posts ?? []) {
                const existing = db.prepare("SELECT updated_at, poll_options, poll_closes_at FROM posts WHERE id=?").get(rp.id) as { updated_at: string | null; poll_options?: string | null; poll_closes_at?: string | null } | undefined;
                const pollOptionsJson = rp.pollOptions != null
                    ? (typeof rp.pollOptions === 'string' ? rp.pollOptions : JSON.stringify(rp.pollOptions))
                    : null;
                const pollClosesAtVal = rp.pollClosesAt || null;
                if (!existing) {
                    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, active, status, repeatable, lat, lng, origin_node, price_type, accepted_by, accepted_at, pending_transaction_id, completed_at, updated_at, poll_options, poll_closes_at, created_by,
                                event_start_at, event_end_at, event_place_name, event_private_note, event_state,
                                audience_scope, target_group_id, target_pubkey, assigned_to, reach, reach_peers,
                                hidden_by_reports_at, removed_by_moderator_at, cash_also_needed, search_keywords)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, ''))`).run(
                        rp.id,
                        rp.type,
                        rp.category,
                        rp.title,
                        rp.description,
                        rp.credits,
                        rp.authorPublicKey,
                        rp.createdAt,
                        rp.active ? 1 : 0,
                        rp.status,
                        rp.repeatable ? 1 : 0,
                        rp.lat ?? null,
                        rp.lng ?? null,
                        // As the main server holds it (G1): null for this community's own listing, a linked community's
                        // address for one in its cache. Filled with the payload's nodeId, the main server's PeerId, which a
                        // take-over keeps, every listing was another community's on a promoted standby: none could be
                        // accepted, none counted toward probation or reached a linked community.
                        rp.originNode || null,
                        rp.priceType || 'fixed',
                        rp.acceptedBy || null,
                        rp.acceptedAt || null,
                        rp.pendingTransactionId || null,
                        rp.completedAt || null,
                        rp.updatedAt || rp.createdAt,
                        pollOptionsJson,
                        pollClosesAtVal,
                        rp.createdBy ?? null,
                        rp.eventStartAt ?? null,
                        rp.eventEndAt ?? null,
                        rp.eventPlaceName ?? null,
                        rp.eventPrivateNote ?? null,
                        rp.eventState ?? null,
                        ...postScope(rp),
                        ...postModeration(rp),
                        ...postSearch(rp),
                    );
                    newPosts++;
                } else {
                    if (rp.updatedAt && existing.updated_at && existing.updated_at >= rp.updatedAt) {
                        conflictsSkipped++;
                        continue;
                    }
                    const res = db.prepare(`UPDATE posts SET
                        category = ?,
                        origin_node = ?,
                        title = ?,
                        description = ?,
                        credits = ?,
                        active = ?,
                        status = ?,
                        repeatable = ?,
                        price_type = ?,
                        accepted_by = ?,
                        accepted_at = ?,
                        pending_transaction_id = ?,
                        completed_at = ?,
                        lat = ?,
                        lng = ?,
                        poll_options = COALESCE(?, poll_options),
                        poll_closes_at = COALESCE(?, poll_closes_at),
                        created_by = COALESCE(?, created_by),
                        event_start_at = ?,
                        event_end_at = ?,
                        event_place_name = ?,
                        event_private_note = ?,
                        event_state = ?,
                        audience_scope = ?,
                        target_group_id = ?,
                        target_pubkey = ?,
                        assigned_to = ?,
                        reach = ?,
                        reach_peers = ?,
                        hidden_by_reports_at = ?,
                        removed_by_moderator_at = ?,
                        cash_also_needed = ?,
                        search_keywords = COALESCE(?, search_keywords),
                        updated_at = ?
                        WHERE id = ?`).run(
                        rp.category,
                        rp.originNode || null,
                        rp.title,
                        rp.description,
                        rp.credits,
                        rp.active ? 1 : 0,
                        rp.status,
                        rp.repeatable ? 1 : 0,
                        rp.priceType || 'fixed',
                        rp.acceptedBy || null,
                        rp.acceptedAt || null,
                        rp.pendingTransactionId || null,
                        rp.completedAt || null,
                        rp.lat ?? null,
                        rp.lng ?? null,
                        pollOptionsJson,
                        pollClosesAtVal,
                        rp.createdBy ?? null,
                        // Plain assignment, not COALESCE: an edit that clears the place name or note must
                        // clear it on the replica too. Non-event rows carry none of these, so they stay null.
                        rp.eventStartAt ?? null,
                        rp.eventEndAt ?? null,
                        rp.eventPlaceName ?? null,
                        rp.eventPrivateNote ?? null,
                        rp.eventState ?? null,
                        ...postScope(rp),
                        ...postModeration(rp),
                        ...postSearch(rp),
                        rp.updatedAt || existing.updated_at || new Date().toISOString(),
                        rp.id
                    );
                    if (res.changes > 0) updatedPosts++;
                }
            }

            if (importedPhotoColumns) {
                // INSERT OR REPLACE over a row that already named an object leaves that object with
                // nothing pointing at it. Deliberately not deleted here: the import is a hot loop over a
                // whole payload, an unlink per row is a syscall per row, and the object is harmless where
                // it is. The storage-health orphan sweep reclaims it. Re-importing the SAME photo costs
                // nothing at all — the key is content-addressed, so it is the same key.
                //
                // The bytes are already on disk: `storeImportedPhotos` put them there before this
                // transaction opened. All that is left in here is the row, stamped as the main server stamped it.
                // A photo it holds unstamped (an older database's ALTER added the column with no default, and no backfill)
                // takes its listing's stamp, the main server's too: a NULL one is in no delta, and every tombstone for the
                // slot would outrank it. This server's clock only when the listing isn't here either.
                const insertPhoto = db.prepare(
                    `INSERT OR REPLACE INTO post_photos (post_id, photo_data, order_num, updated_at, storage_key, sha256, bytes, mime)
                     VALUES (?, ?, ?, COALESCE(?, (SELECT updated_at FROM posts WHERE id = ?), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ?, ?, ?, ?)`
                );
                for (const [key, cols] of importedPhotoColumns) {
                    const sep = key.lastIndexOf('|');
                    const postId = key.slice(0, sep);
                    const orderNum = Number(key.slice(sep + 1));
                    insertPhoto.run(postId, cols.photo_data, orderNum, cols.updated_at, postId, cols.storage_key, cols.sha256, cols.bytes, cols.mime);
                }
            }

            if (remote.projects) {
                // Every column, as the main server holds it (G1b). The legacy crowdfund row is still live: a bounded
                // enterprise writes one and its pledges count into it (routes/treasury.ts, db.ts pledgeToProject). Ten of
                // its columns left `migrated_at` and `enterprise_pubkey` empty and the stamp this standby's, so its boot
                // migrated each project again (db/unify-projects-migration.ts) and a project's delete could be skipped. One
                // the main server holds unstamped (an older database's ALTER, no backfill) takes its `created_at`, as the
                // stamp's own migration fills it (db.ts): a NULL one is in no delta, and any tombstone for it would win.
                const writeProject = db.prepare(`INSERT OR REPLACE INTO projects (id, creator_pubkey, title, description, photos, goal_amount, current_amount, deadline_at, status, migrated_at, enterprise_pubkey, created_at, updated_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
                for (const pr of remote.projects) {
                    writeProject.run(
                        pr.id,
                        pr.creator_pubkey,
                        pr.title,
                        pr.description,
                        pr.photos,
                        pr.goal_amount,
                        pr.current_amount,
                        pr.deadline_at,
                        pr.status,
                        pr.migrated_at ?? null,
                        pr.enterprise_pubkey ?? null,
                        pr.created_at,
                        pr.updated_at ?? pr.created_at ?? new Date().toISOString(),
                    );
                }
            }

            if (remote.ratings) {
                for (const rt of remote.ratings) {
                    db.prepare(`INSERT OR REPLACE INTO ratings (id, target_pubkey, rater_pubkey, role, stars, comment, transaction_id, created_at) 
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
                        rt.id,
                        rt.targetPubkey,
                        rt.raterPubkey,
                        rt.role,
                        rt.stars,
                        rt.comment || null,
                        rt.transactionId,
                        rt.createdAt
                    );
                }
            }

            // The accounts a copy names: its entries with a key this server stores as that same string. Another entry
            // names none (no key, or half a surrogate pair, which SQLite stores as U+FFFD: a row under another key), and
            // is never written; the whole-copy check counts it as unreadable (engine audit.ts getReplicaConsistency).
            const readableKey = (acc: { publicKey?: unknown } | null | undefined): acc is SyncAccount =>
                typeof acc?.publicKey === 'string' && !!acc.publicKey && isWellFormedKey(acc.publicKey);
            // A copy that names no account carries no ledger, and changes no account here: a main server always holds its
            // Commons account (state-engine.ts seeds it at every boot), so no main server's ledger is empty. Read as a
            // ledger, it emptied this standby's, and a ledger that sums to 0 lets that past the guard. That is a copy with
            // an empty account set, and one whose every entry names no account (none, or only unreadable keys).
            const carriesLedger = Array.isArray(remote.accounts) && remote.accounts.some(readableKey);
            if (carriesLedger) {
                // The main server's account set, exactly (design §4.1, G0). It is this standby's only writer, every copy,
                // delta or whole, carries every account it holds as of `generatedAt`, and the puller refuses an older copy,
                // so there is nothing for a stamp to decide. Each account is written as the main server holds it whenever
                // it differs here, stamps included, and one it no longer holds (an empty escrow its sweep deleted, a deleted
                // project's) goes. A comparison of stamps let this standby's own rows win: the members import made a zero
                // row for each new member stamped with this clock, and every balance made before the first copy stayed 0.
                const local = new Map((db.prepare('SELECT public_key, balance, last_updated_at, last_demurrage_epoch FROM accounts').all() as
                    { public_key: string; balance: number | null; last_updated_at: string | null; last_demurrage_epoch: number | null }[])
                    .map((r) => [r.public_key, r]));
                const named = new Set<string>();
                const writeAccount = db.prepare(`INSERT INTO accounts (public_key, balance, last_updated_at, last_demurrage_epoch)
                            VALUES (?, ?, ?, ?)
                            ON CONFLICT(public_key) DO UPDATE SET
                                balance = excluded.balance,
                                last_updated_at = excluded.last_updated_at,
                                last_demurrage_epoch = excluded.last_demurrage_epoch`);
                for (const acc of remote.accounts!) {
                    if (!readableKey(acc)) {
                        conflictsSkipped++;
                        continue;
                    }
                    named.add(acc.publicKey);
                    // No number to copy: the row here stays as it is, and the whole-copy check counts the entry.
                    if (typeof acc.balance !== 'number' || !Number.isFinite(acc.balance)) {
                        conflictsSkipped++;
                        continue;
                    }
                    const stamp = acc.lastUpdatedAt ?? null;
                    const epoch = acc.lastDemurrageEpoch ?? null;
                    const mine = local.get(acc.publicKey);
                    if (mine && mine.balance === acc.balance && mine.last_updated_at === stamp && mine.last_demurrage_epoch === epoch) continue;
                    writeAccount.run(acc.publicKey, acc.balance, stamp, epoch);
                    accountChanges++;
                    // What the row holds now: an account the copy names twice is written twice, and its second entry is
                    // compared with its first.
                    local.set(acc.publicKey, { public_key: acc.publicKey, balance: acc.balance, last_updated_at: stamp, last_demurrage_epoch: epoch });
                }
                const dropAccount = db.prepare('DELETE FROM accounts WHERE public_key = ?');
                for (const pk of local.keys()) {
                    if (named.has(pk)) continue; // every row the loop wrote is named: what is left here, it held before
                    dropAccount.run(pk);
                    accountChanges++;
                }

                // The main server's ledger as this copy carries it, which a take-over's audit holds the promoted ledger to
                // (services/takeover.ts). In this transaction, so it is the ledger of the last copy that landed; written
                // when it changes, so `generatedAt` is the first copy that carried it.
                const summary = summariseLedger(remote.accounts!.filter((a) => typeof a?.publicKey === 'string')
                    .map((a) => ({ publicKey: a.publicKey, balance: a.balance })));
                const last = mainLedgerAtLastCopy();
                if (!last || last.digest !== summary.digest || last.sum !== summary.sum) {
                    const record: MainLedgerRecord = { ...summary, generatedAt: remote.generatedAt ?? null };
                    db.prepare(`INSERT OR REPLACE INTO node_config (key, value) VALUES ('replica_main_ledger', ?)`).run(JSON.stringify(record));
                }
            } else if (!Array.isArray(remote.accounts)) {
                // A copy with no account set at all (none a main server sends: its export always carries every account).
                // Each member it named without an account gets an empty one, as the members import used to give them, stamped
                // with nothing, so nothing here claims to be newer than a main server's row.
                const openAccount = db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_updated_at, last_demurrage_epoch) VALUES (?, 0, NULL, 0)`);
                for (const rm of remote.members ?? []) {
                    if (typeof rm?.publicKey === 'string' && rm.publicKey && isWellFormedKey(rm.publicKey)) openAccount.run(rm.publicKey);
                }
            }

            // The conservation guard: what this copy moved the ledger's total by, measured as the total after its writes
            // against the total before them, both as SQLite sums the rows (exact enough, MAX_LEDGER_BALANCE). A running sum
            // of each account's change, in the copy's order, lost a change smaller than half a step of the running total:
            // +1e20, 1000, then -1e20 measured 0, and the next copy, dropping the two, measured 0 too, which left 1000 Beans
            // here that the main server's ledger doesn't have. Every write this copy makes to the accounts is before this
            // point, a re-key's move included, whatever branch above it took.
            const totalAfter = ledgerTotal();
            if (heldToSum !== null && !seed) {
                // After this standby cleared its own ledger for a force-resync that isn't a seed (a whole copy that didn't
                // match, services/backup-puller.ts): the copy is held to the total the ledger had before that clear, the
                // last accepted copy's, not to the rows the clear left. Only a copy's ledger puts back the one the clear
                // took, so one that carries none (it names no account, above) is refused too. The record of that total
                // goes when a copy lands, in this transaction.
                if (!carriesLedger) {
                    throw new Error('[Sync] Conservation violation: this standby cleared its ledger for a force-resync, and the copy carries none to put back; rejecting it');
                }
                if (Math.abs(totalAfter - heldToSum) > LEDGER_CONSERVATION_TOLERANCE) {
                    throw new Error(`[Sync] Conservation violation: import shifted total balance by ${(totalAfter - heldToSum).toFixed(4)} from the ${heldToSum} this standby held before its own clear (> ${LEDGER_CONSERVATION_TOLERANCE}); rejecting value-creating payload`);
                }
            } else if ((ENFORCE_LEDGER_AUTH || getNodeRole() === 'backup') && !seed
                && Math.abs(totalAfter - totalBefore) > LEDGER_CONSERVATION_TOLERANCE) {
                // A copy may not move this standby's total by more than the tolerance, unless the puller took it as a seed
                // (ImportOptions.seed), which it decides from this standby's own records and never from the ledger here: a
                // count of accounts let one copy that named none bring the ledger back to "empty", and the next went
                // unchecked. With every account the main server's, what it measures is the shift between the two ledgers,
                // which is 0 whenever the main server conserves.
                throw new Error(`[Sync] Conservation violation: import shifted total balance by ${(totalAfter - totalBefore).toFixed(4)} (> ${LEDGER_CONSERVATION_TOLERANCE}); rejecting value-creating payload`);
            }
            db.prepare(`DELETE FROM node_config WHERE key = 'replica_held_sum'`).run();

            // The in-memory ledger follows these rows once they are committed, after every copy that lands, and only then.
            // Loaded inside the transaction, it kept this copy's accounts and Commons pot when a later section threw and the
            // rows rolled back; this standby's flush then wrote that pot over its last good copy's, and every later copy was
            // refused by the guard above, for good. A hook queued here is dropped when the transaction rolls back (db.ts),
            // so memory stays at the rows. After every copy, not only one that writes an account: a re-key the copy
            // carries moves the member's account row (followReplicatedRekeys, above) in a copy that may name no account,
            // and memory left on the old key read that account's demurrage into a Commons pot the rows didn't have.
            afterTransactionCommit(() => cb.resyncLedgerToRows());

            if (remote.transactions) {
                // Each trade as the main server holds it, its Commons fee and its project included (G0). A trade never
                // changes there but for its project (cleared when the project is deleted, which reaches this standby with
                // the project's tombstone) and a re-key (which this standby follows before the copy goes in), so a row
                // here that isn't the main server's is one this standby wrote itself: the main server's is written over
                // it. A main server from before the fee and the project were sent sends neither: 0 and none, as its copy
                // always had them.
                const writeTransaction = db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, tax_fee, memo, timestamp, auth_signer, auth_signature, auth_payload, project_id)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(id) DO UPDATE SET
                                from_pubkey = excluded.from_pubkey,
                                to_pubkey = excluded.to_pubkey,
                                amount = excluded.amount,
                                tax_fee = excluded.tax_fee,
                                memo = excluded.memo,
                                timestamp = excluded.timestamp,
                                auth_signer = excluded.auth_signer,
                                auth_signature = excluded.auth_signature,
                                auth_payload = excluded.auth_payload,
                                project_id = excluded.project_id
                            WHERE transactions.from_pubkey IS NOT excluded.from_pubkey OR transactions.to_pubkey IS NOT excluded.to_pubkey
                               OR transactions.amount IS NOT excluded.amount OR transactions.tax_fee IS NOT excluded.tax_fee
                               OR transactions.memo IS NOT excluded.memo OR transactions.timestamp IS NOT excluded.timestamp
                               OR transactions.auth_signer IS NOT excluded.auth_signer OR transactions.auth_signature IS NOT excluded.auth_signature
                               OR transactions.auth_payload IS NOT excluded.auth_payload OR transactions.project_id IS NOT excluded.project_id`);
                for (const tx of remote.transactions) {
                    if (ENFORCE_LEDGER_AUTH && !verifyTransactionAuthorship(tx)) {
                        conflictsSkipped++;
                        continue;
                    }
                    if (!tx.from || !tx.to || typeof tx.amount !== 'number' || !Number.isFinite(tx.amount) || tx.amount <= 0) {
                        conflictsSkipped++;
                        continue;
                    }
                    const res = writeTransaction.run(
                        tx.id,
                        tx.from,
                        tx.to,
                        tx.amount,
                        typeof tx.taxFee === 'number' && Number.isFinite(tx.taxFee) ? tx.taxFee : 0,
                        tx.memo,
                        tx.timestamp,
                        tx.authSigner ?? null,
                        tx.authSignature ?? null,
                        tx.authPayload ?? null,
                        typeof tx.projectId === 'string' && tx.projectId ? tx.projectId : null,
                    );
                    if (res.changes > 0) newTransactions++;
                }
            }

            if (remote.marketplaceTransactions) {
                // Every column, as the main server holds it, its stamp included (G1b): a resolved dispute stays resolved
                // (the admin Disputes list reads the resolution), the hygiene's last nudge stays nudged, and the row's
                // stamp is the main server's, which phones' deltas read after a take-over.
                const writeDeal = db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, hours, status, created_at, completed_at,
                                    updated_at, last_reminded_at, dispute_resolution, dispute_resolved_at, dispute_resolved_by)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                ON CONFLICT(id) DO UPDATE SET
                                    post_id = excluded.post_id,
                                    buyer_pubkey = excluded.buyer_pubkey,
                                    seller_pubkey = excluded.seller_pubkey,
                                    created_at = excluded.created_at,
                                    status = excluded.status,
                                    completed_at = excluded.completed_at,
                                    hours = excluded.hours,
                                    credits = excluded.credits,
                                    updated_at = excluded.updated_at,
                                    last_reminded_at = excluded.last_reminded_at,
                                    dispute_resolution = excluded.dispute_resolution,
                                    dispute_resolved_at = excluded.dispute_resolved_at,
                                    dispute_resolved_by = excluded.dispute_resolved_by`);
                for (const mt of remote.marketplaceTransactions) {
                    const createdAt = mt.createdAt ?? mt.created_at ?? new Date().toISOString();
                    const completedAt = mt.completedAt ?? mt.completed_at ?? null;
                    const res = writeDeal.run(
                        mt.id,
                        mt.postId ?? mt.post_id ?? null,
                        mt.buyerPubkey ?? mt.buyerPublicKey ?? mt.buyer_pubkey ?? null,
                        mt.sellerPubkey ?? mt.sellerPublicKey ?? mt.seller_pubkey ?? null,
                        mt.credits ?? 0,
                        mt.hours ?? null,
                        mt.status ?? 'pending',
                        createdAt,
                        completedAt,
                        mt.updatedAt ?? completedAt ?? createdAt,
                        mt.lastRemindedAt ?? null,
                        mt.disputeResolution ?? null,
                        mt.disputeResolvedAt ?? null,
                        mt.disputeResolvedBy ?? null,
                    );
                    if (res.changes > 0) marketplaceTxns++;
                }
            }

            if (remote.friends) {
                for (const fr of remote.friends) {
                    db.prepare(`INSERT OR IGNORE INTO friends (owner_pubkey, friend_pubkey, added_at)
                                VALUES (?, ?, ?)`).run(
                        fr.ownerPubkey,
                        fr.friendPubkey,
                        fr.addedAt
                    );
                }
            }

            const droppedChatGroups = new Set<string>();
            if (remote.conversations) {
                for (const cv of remote.conversations) {
                    // The old chat group is gone (groups decision 2); a snapshot from a node not yet updated
                    // must not bring one back. Its participants and messages then have no conversation to land in.
                    if (cv.type === 'group') { droppedChatGroups.add(cv.id); conflictsSkipped++; continue; }
                    db.prepare(`INSERT INTO conversations (id, type, post_id, name, created_by, created_at)
                                VALUES (?, ?, ?, ?, ?, ?)
                                ON CONFLICT(id) DO UPDATE SET
                                    name = excluded.name`).run(
                        cv.id,
                        cv.type,
                        cv.postId || null,
                        cv.name || null,
                        cv.createdBy || null,
                        cv.createdAt
                    );
                }
            }

            if (remote.conversationParticipants) {
                // The PRIMARY's updated_at is written, not left to the local column default and touch
                // trigger. Without it a replica stamps every imported membership row with its own import
                // time, which is always later than the primary's delete — so the tombstone that carries a
                // member leaving an event chat, or the 30-day scrub emptying one, would be skipped as
                // "stale" forever. Storing the primary's clock is what makes last-write-wins decide.
                //
                // The DO UPDATE is guarded so an unchanged row is not rewritten: an UPDATE that sets
                // updated_at to the value it already holds fires the touch trigger, which would replace
                // the primary's clock with the replica's all over again.
                const importParticipant = db.prepare(`INSERT INTO conversation_participants (conversation_id, public_key, last_read_at, updated_at)
                            VALUES (?, ?, ?, ?)
                            ON CONFLICT(conversation_id, public_key) DO UPDATE SET
                                last_read_at = excluded.last_read_at,
                                updated_at = excluded.updated_at
                            WHERE excluded.updated_at IS NOT NULL
                              AND (conversation_participants.updated_at IS NULL
                                   OR excluded.updated_at > conversation_participants.updated_at)`);
                for (const cp of remote.conversationParticipants) {
                    if (droppedChatGroups.has(cp.conversationId)) continue;
                    importParticipant.run(
                        cp.conversationId,
                        cp.publicKey,
                        cp.lastReadAt || null,
                        cp.updatedAt || cp.lastReadAt || new Date().toISOString()
                    );
                }
            }

            if (remote.messages) {
                for (const msg of remote.messages) {
                    if (droppedChatGroups.has(msg.conversationId)) continue;
                    const res = db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, system_type, metadata, timestamp, edited_at, updated_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                ON CONFLICT(id) DO UPDATE SET
                                    conversation_id = excluded.conversation_id,
                                    author_pubkey = excluded.author_pubkey,
                                    ciphertext = excluded.ciphertext,
                                    nonce = excluded.nonce,
                                    type = excluded.type,
                                    system_type = excluded.system_type,
                                    metadata = excluded.metadata,
                                    edited_at = excluded.edited_at,
                                    updated_at = excluded.updated_at
                                WHERE excluded.updated_at IS NOT NULL
                                  AND (messages.updated_at IS NULL OR excluded.updated_at > messages.updated_at)`).run(
                        msg.id,
                        msg.conversationId,
                        msg.authorPubkey,
                        msg.ciphertext,
                        msg.nonce,
                        msg.type || 'text',
                        msg.systemType || null,
                        msg.metadata || null,
                        msg.timestamp,
                        msg.editedAt || null,
                        msg.updatedAt || msg.editedAt || msg.timestamp
                    );
                    if (res.changes > 0) newMessages++;
                }
            }

            if (remote.abuseReports) {
                for (const ar of remote.abuseReports) {
                    db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_post_id, target_pulse_item_id, reason, created_at, status, updated_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                                ON CONFLICT(id) DO UPDATE SET
                                    status = excluded.status,
                                    updated_at = excluded.updated_at
                                WHERE excluded.updated_at IS NOT NULL
                                  AND (abuse_reports.updated_at IS NULL OR excluded.updated_at > abuse_reports.updated_at)`).run(
                        ar.id,
                        ar.reporterPubkey,
                        ar.targetPubkey,
                        ar.targetPostId || null,
                        ar.targetPulseItemId || null,
                        ar.reason,
                        ar.createdAt,
                        ar.status || 'pending',
                        ar.updatedAt || ar.createdAt
                    );
                }
            }

            if (remote.creatorChannels) {
                // Prepared ONCE, above the loop. better-sqlite3 compiles on every db.prepare() —
                // there is no internal statement cache — so leaving this inside recompiled ~1.5KB
                // of SQL per row, up to MAX_IMPORT_ROWS_PER_CATEGORY (250k) of them, all inside the
                // single import transaction. On the 1cpu/1GB test VM that is event-loop block time
                // for nothing.
                //
                // Last-write-wins on `updated_at`, same as members and abuse_reports. A delete
                // is just a row whose deleted_at is set and whose url/handle are already NULL,
                // so it converges through the identical path — no separate tombstone needed,
                // and a replica can never resurrect a link the member removed.
                const importChannel = db.prepare(`INSERT INTO creator_channels
                                    (id, owner_pubkey, platform, url, handle, category, is_primary_video,
                                     supports_autolist, oauth_verified_at, post_count_seen, autopublish,
                                     syndicate_to_node, created_at, updated_at, deleted_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                ON CONFLICT(id) DO UPDATE SET
                                    -- Included because executeRecovery repoints channels at the
                                    -- member's NEW key. Without it a promoted backup keeps them
                                    -- attached to the dead key and the chips vanish from the
                                    -- member's profile after a recovery.
                                    owner_pubkey      = excluded.owner_pubkey,
                                    -- platform is scrubbed to 'deleted' by deleteChannel, so it
                                    -- has to converge like the rest. Omitted, a replica that held
                                    -- the live row keeps its original platform forever after
                                    -- importing its tombstone.
                                    platform          = excluded.platform,
                                    url               = excluded.url,
                                    handle            = excluded.handle,
                                    category          = excluded.category,
                                    is_primary_video  = excluded.is_primary_video,
                                    supports_autolist = excluded.supports_autolist,
                                    oauth_verified_at = excluded.oauth_verified_at,
                                    post_count_seen   = excluded.post_count_seen,
                                    autopublish       = excluded.autopublish,
                                    syndicate_to_node = excluded.syndicate_to_node,
                                    deleted_at        = excluded.deleted_at,
                                    updated_at        = excluded.updated_at
                                WHERE excluded.updated_at > creator_channels.updated_at`);
                for (const cc of remote.creatorChannels) {
                    importChannel.run(
                        cc.id,
                        cc.ownerPubkey,
                        cc.platform,
                        cc.url ?? null,
                        cc.handle ?? null,
                        cc.category,
                        cc.isPrimaryVideo ? 1 : 0,
                        cc.supportsAutolist ? 1 : 0,
                        cc.oauthVerifiedAt ?? null,
                        cc.postCountSeen ?? null,
                        cc.autopublish ? 1 : 0,
                        cc.syndicateToNode ? 1 : 0,
                        cc.createdAt,
                        cc.updatedAt,
                        cc.deletedAt ?? null
                    );
                }
            }

            if (remote.pulseItems) {
                // Prepared ONCE above the loop per Contract A rule 4 (better-sqlite3 compiles on prepare).
                // Last-write-wins on updated_at.
                const importPulseItem = db.prepare(`INSERT INTO pulse_items
                                    (id, channel_id, owner_pubkey, platform, external_id,
                                     url, title, thumbnail_url, published_at, category,
                                     source, muted, curated, created_at, updated_at, deleted_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                ON CONFLICT(id) DO UPDATE SET
                                    channel_id    = excluded.channel_id,
                                    owner_pubkey  = excluded.owner_pubkey,
                                    platform      = excluded.platform,
                                    external_id   = excluded.external_id,
                                    url           = excluded.url,
                                    title         = excluded.title,
                                    thumbnail_url = excluded.thumbnail_url,
                                    published_at  = excluded.published_at,
                                    category      = excluded.category,
                                    source        = excluded.source,
                                    muted         = excluded.muted,
                                    curated       = excluded.curated,
                                    deleted_at    = excluded.deleted_at,
                                    updated_at    = excluded.updated_at
                                WHERE excluded.updated_at > pulse_items.updated_at`);
                for (const item of remote.pulseItems) {
                    importPulseItem.run(
                        item.id,
                        item.channelId,
                        item.ownerPubkey,
                        item.platform,
                        item.externalId ?? null,
                        item.url ?? null,
                        item.title ?? null,
                        item.thumbnailUrl ?? null,
                        item.publishedAt ?? null,
                        item.category,
                        item.source,
                        item.muted ? 1 : 0,
                        // An older peer omits this; 0 is safe because every node re-seeds its
                        // own curated content on boot.
                        item.curated ? 1 : 0,
                        item.createdAt,
                        item.updatedAt,
                        item.deletedAt ?? null
                    );
                }
            }

            // Settlements (#104). INSERT OR REPLACE keyed on `key`, so a later state from the primary wins —
            // a settlement's states only ever move forward, and the primary is the only writer.
            if (remote.settlements) {
                // Prepared once, outside the loop — a snapshot can carry the whole outbox.
                const insertSettlement = db.prepare(`INSERT OR REPLACE INTO settlements
                    (key, direction, peer_id, buyer_pubkey, buyer_home_node, seller_pubkey, post_id,
                     amount, fee, reserved_until, state, receipt, receipt_payload, failure_reason,
                     created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
                for (const st of remote.settlements) {
                    insertSettlement.run(
                        st.key, st.direction, st.peerId, st.buyerPubkey, st.buyerHomeNode ?? null,
                        st.sellerPubkey ?? null, st.postId ?? null, st.amount, st.fee ?? 0,
                        st.reservedUntil ?? null, st.state, st.receipt ?? null, st.receiptPayload ?? null,
                        st.failureReason ?? null, st.createdAt, st.updatedAt,
                    );
                }
            }

            // Recovery shares — hub fragment A (XOR-mandatory) and keeper fragments.
            // INSERT OR REPLACE keyed on the UNIQUE(owner_pubkey, generation, holder_type, holder_ref) constraint,
            // so the latest version from the primary always wins. This is the critical path that closes
            // the live-replication gap: without it, a promoted backup node has an empty recovery_shares table.
            if (remote.recoveryShares) {
                const dropOlder = db.prepare(`DELETE FROM recovery_shares WHERE owner_pubkey = ? AND generation < ?`);
                const insertShare = db.prepare(`INSERT OR REPLACE INTO recovery_shares
                    (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share,
                     share_iv, share_tag, ephemeral_pubkey, sso_lookup_hash, sso_lookup_salt,
                     kdf_params, generation, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
                for (const rs of remote.recoveryShares) {
                    dropOlder.run(rs.ownerPubkey, rs.generation);
                    const res = insertShare.run(
                        rs.ownerPubkey, rs.holderType, rs.holderRef, rs.shareIndex,
                        rs.encryptedShare, rs.shareIv, rs.shareTag,
                        rs.ephemeralPubkey ?? null, rs.ssoLookupHash ?? null,
                        rs.ssoLookupSalt ?? null, rs.kdfParams ?? null,
                        rs.generation, rs.createdAt, rs.updatedAt || rs.createdAt,
                    );
                    if (res.changes > 0) recoverySharesImported++;
                }
            }
            // The copies the main server deleted (engine/recovery-shares.ts deleteAllShares), after this copy's own and
            // before a followed re-key's: a member re-keyed and then deleted theirs, so the copy brings none under the new
            // key, and dropMovedRecoveryCopies knows they went by this tombstone instead.
            const recoveryTombstones = tombstones.filter((ts) => ts.tableName === 'recovery_shares' && !appliedBeforeRekey.has(ts));
            applyTombstones(recoveryTombstones);
            // A followed re-key's recovery copies: the ones the main server moved to the new key go from the old one.
            if (followedRekeys.length > 0) dropMovedRecoveryCopies(followedRekeys);

            if (remote.pollVotes) {
                const importVote = db.prepare(`INSERT INTO poll_votes
                    (post_id, voter_pubkey, option_id, signature, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(post_id, voter_pubkey) DO UPDATE SET
                        option_id = excluded.option_id,
                        signature = excluded.signature,
                        created_at = excluded.created_at
                    WHERE excluded.created_at IS NOT NULL
                      AND (poll_votes.created_at IS NULL OR excluded.created_at >= poll_votes.created_at)`);
                for (const pv of remote.pollVotes) {
                    importVote.run(
                        pv.postId,
                        pv.voterPubkey,
                        pv.optionId,
                        pv.signature || '',
                        pv.createdAt || new Date().toISOString()
                    );
                }
            }

            // Event RSVPs: last-write-wins on updated_at. A row older than a local tombstone for the same key
            // is a "not going" that already happened, and must not come back.
            if (remote.eventRsvps) {
                // reminder_offsets (docs/events-on-the-map.md §2.1) rides along with the RSVP, on the same
                // last-write-wins rule. TWO statements, because "the peer left this field out" and "this
                // person cleared their choice back to my-default" both arrive as an absent value and must
                // NOT mean the same thing: a snapshot from a node older than reminders would otherwise
                // erase every stored choice on this replica, and a COALESCE that avoided that would in turn
                // make a clear-back-to-default unreplicable. `undefined` keeps what is here; an explicit
                // null or string is written as sent.
                const RSVP_CONFLICT_GUARD = `
                    WHERE excluded.updated_at IS NOT NULL
                      AND (event_rsvps.updated_at IS NULL OR excluded.updated_at >= event_rsvps.updated_at)`;
                const importRsvp = db.prepare(`INSERT INTO event_rsvps
                    (post_id, member_pubkey, status, signature, reminder_offsets, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(post_id, member_pubkey) DO UPDATE SET
                        status = excluded.status,
                        signature = excluded.signature,
                        reminder_offsets = excluded.reminder_offsets,
                        updated_at = excluded.updated_at
                    ${RSVP_CONFLICT_GUARD}`);
                // The pre-reminders peer: same row, same watermark, reminder_offsets untouched.
                const importRsvpNoOffsets = db.prepare(`INSERT INTO event_rsvps
                    (post_id, member_pubkey, status, signature, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(post_id, member_pubkey) DO UPDATE SET
                        status = excluded.status,
                        signature = excluded.signature,
                        updated_at = excluded.updated_at
                    ${RSVP_CONFLICT_GUARD}`);
                const tombstoneAt = db.prepare(`SELECT deleted_at FROM tombstones WHERE table_name = 'event_rsvps' AND row_key = ?`);
                for (const er of remote.eventRsvps) {
                    if (er.status !== 'going' && er.status !== 'interested') continue;
                    const updatedAt = er.updatedAt || new Date().toISOString();
                    const ts = tombstoneAt.get(`${er.postId}|${er.memberPubkey}`) as { deleted_at: string } | undefined;
                    if (ts && ts.deleted_at >= updatedAt) {
                        conflictsSkipped++;
                        continue;
                    }
                    if (er.reminderOffsets === undefined) {
                        importRsvpNoOffsets.run(er.postId, er.memberPubkey, er.status, er.signature || '', updatedAt);
                    } else {
                        importRsvp.run(er.postId, er.memberPubkey, er.status, er.signature || '',
                            er.reminderOffsets, updatedAt);
                    }
                }
            }

            // Commons groups (#823): last-write-wins on updated_at, the primary's clock stored so a later
            // tombstone or change compares against it. The DO UPDATE is guarded so an unchanged row is not
            // rewritten — the touch triggers would otherwise restamp it with the replica's clock.
            if (remote.groups) {
                // lead_pubkey travels with the group (2026-09-23). A snapshot from a node older than the lead
                // convenor sends null for it; COALESCE keeps whatever this node already knows rather than
                // erasing it, so a replica that has run the backfill is not un-backfilled by an old primary.
                const importGroup = db.prepare(`INSERT INTO groups
                    (id, name, slug, description, avatar_url, category, created_by, lead_pubkey, join_policy, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        name = excluded.name,
                        slug = excluded.slug,
                        description = excluded.description,
                        avatar_url = excluded.avatar_url,
                        category = excluded.category,
                        lead_pubkey = COALESCE(excluded.lead_pubkey, groups.lead_pubkey),
                        join_policy = excluded.join_policy,
                        updated_at = excluded.updated_at
                    WHERE excluded.updated_at IS NOT NULL
                      AND (groups.updated_at IS NULL OR excluded.updated_at > groups.updated_at)`);
                for (const g of remote.groups) {
                    if (!g?.id || !g.name || !g.slug || !g.createdBy) { conflictsSkipped++; continue; }
                    const res = importGroup.run(
                        g.id, g.name, g.slug, g.description ?? null, g.avatarUrl ?? null, g.category || 'general',
                        g.createdBy, g.leadPubkey ?? null, g.joinPolicy || 'open', g.createdAt, g.updatedAt || g.createdAt,
                    );
                    if (res.changes > 0) groupChanges++;
                }
            }

            // Memberships, every status — a 'removed' row is what keeps a removal in force after failover. A row
            // no newer than a local tombstone for the same key is a leave that already happened, and must not
            // come back (a re-join is stamped after the tombstone and passes).
            if (remote.groupMembers) {
                const importGroupMember = db.prepare(`INSERT INTO group_members
                    (group_id, member_pubkey, role, status, joined_at, invited_by, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(group_id, member_pubkey) DO UPDATE SET
                        role = excluded.role,
                        status = excluded.status,
                        joined_at = excluded.joined_at,
                        invited_by = excluded.invited_by,
                        updated_at = excluded.updated_at
                    WHERE excluded.updated_at IS NOT NULL
                      AND (group_members.updated_at IS NULL OR excluded.updated_at > group_members.updated_at)`);
                const tombstoneAt = db.prepare(`SELECT deleted_at FROM tombstones WHERE table_name = 'group_members' AND row_key = ?`);
                for (const gm of remote.groupMembers) {
                    if (!gm?.groupId || !gm.memberPubkey) { conflictsSkipped++; continue; }
                    if (!GROUP_ROLES.has(gm.role) || !GROUP_MEMBER_STATUSES.has(gm.status)) { conflictsSkipped++; continue; }
                    const updatedAt = gm.updatedAt || new Date().toISOString();
                    const ts = tombstoneAt.get(`${gm.groupId}|${gm.memberPubkey}`) as { deleted_at: string } | undefined;
                    if (ts && ts.deleted_at >= updatedAt) {
                        conflictsSkipped++;
                        continue;
                    }
                    const res = importGroupMember.run(
                        gm.groupId, gm.memberPubkey, gm.role, gm.status, gm.joinedAt ?? null, gm.invitedBy ?? null, updatedAt,
                    );
                    if (res.changes > 0) groupChanges++;
                }
            }

            // The open door's record (engine/open-join.ts): who joined with which sign-in account, and the key those
            // hashes are made with, so a promoted standby refuses an account that already joined. After the members,
            // because a row is kept only for a member this database has. A primary older than this sends neither and
            // changes nothing here.
            if (remote.openJoinSalt !== undefined || remote.openJoins) {
                writeOpenJoinRecord(remote.openJoinSalt, remote.openJoins);
            }

            // The main server's word that its visitors' rows are marked: its marks are in this copy (each marked row is
            // stamped, so it travels), and this standby, which marks none itself, takes them as its own (db.ts
            // markExistingVisitors). Its puller then takes one whole copy, for the rows it copied before it had the
            // column (db.ts visitorMarksWantWholeCopy). A main server older than that sends nothing, and the pass is
            // left for a promotion.
            if (remote.visitorsMarked === true) noteVisitorsMarkedByMainServer();

            // The global node's place watches and its mirror of the directory (G5), so a server that takes over has every
            // member's watch and quiet day, and knows which communities the old one had already told them about
            // (engine/place-watches.ts). After the members, because a watch is kept only for a member this database has;
            // before the tombstones, which remove a watch whatever this copy says of it. A bad row is left out, never the
            // copy. A main server older than this sends neither and changes nothing here.
            if (remote.placeWatches) mergeReplicatedWatches(remote.placeWatches);
            if (remote.directoryCache) mergeReplicatedDirectory(remote.directoryCache);

            // The moderation notices kept for each member, and when they saw them (engine/kept-notices.ts), so a server
            // that takes over still shows a web member what they have not seen, and nothing they have. After the members,
            // because a notice is kept only for a member this database has; before the tombstones, which delete the ones
            // past the bounds whatever this copy says of them. A bad row is left out, never the copy. A main server
            // older than this sends none and changes nothing here.
            if (remote.moderationNotices) mergeReplicatedNotices(remote.moderationNotices);

            // Each member's block list (engine/member-blocks.ts), so a server that takes over still hides whom each member
            // blocked. After the members, because a list is kept only for a member this database has; before the
            // tombstones, which delete an unblocked row whatever this copy says of it, and keep a block made again after
            // them. A bad row is left out, never the copy. The first copy that carries lists asks this standby's puller for
            // one whole copy, for the blocks made while it ran a version without them. A main server older than this sends
            // none and changes nothing here.
            if (Array.isArray(remote.memberBlocks)) {
                mergeReplicatedBlocks(remote.memberBlocks);
                noteMemberBlocksFromMainServer();
            }

            // Requests to join (G6, engine/knocks.ts): every knock and every answer, so a server that takes over still
            // has them. After the members, because an approved row's invite is made again here only by a member this
            // database has. The main server's tidy-up clears rows (stamped, so they come in here) and deletes them
            // (`join_requests` tombstones); a row this database already has a tombstone for is not written again. A
            // main server older than this sends none and changes nothing here.
            // This copy's knock tombstones go first. The tidy-up deletes a lapsed knock 60 days after it was made, and
            // the key's next knock is a new row, so one copy can carry both (one pull, or the first after the standby
            // was down). Still here, the old row would keep the new one out of the one-open index, and then be deleted
            // itself: neither. The other tables a function merges above lose nothing this way: place_watches replaces
            // a watch on the same cell itself, and directory_cache and open_joins have no tombstones.
            const knockTombstones = tombstones.filter((ts) => ts.tableName === 'join_requests');
            applyTombstones(knockTombstones);
            if (remote.joinRequests) mergeReplicatedKnocks(remote.joinRequests);

            applyTombstones(tombstones.filter((ts) => ts.tableName !== 'join_requests' && ts.tableName !== 'recovery_shares'
                && !appliedBeforeRekey.has(ts)));
            putTouchTriggersBack();
        })();
    } finally {
        currentImportOrigin = null;
    }

    // Updates and tombstones count, not just inserts. This was guarded on `newMembers > 0 ||
    // newPosts > 0`, which was fine when the broadcast only woke up sockets — but it now also
    // bumps the ETag version counters that let the list endpoints answer a conditional request
    // without reading the database. An import that only MODIFIED listings, or only applied
    // deletions, left both counters untouched, so every client on this node kept receiving 304
    // indefinitely and a removed listing stayed visible forever. A 304 never reads the database,
    // so nothing downstream would ever have noticed.
    // groupChanges too: the groups list answers conditional requests from its own version counter, which
    // 'state_synced' bumps — an import that only changed groups would otherwise leave it serving 304s.
    if (newMembers > 0 || newPosts > 0 || updatedMembers > 0 || updatedPosts > 0 || tombstonesApplied > 0 || groupChanges > 0 || standingChanges > 0) {
        cb.broadcast({
            type: 'state_synced',
            newMembers, newPosts, updatedMembers, updatedPosts, tombstonesApplied, groupChanges, standingChanges,
            from: remote.nodeId,
        });
    }
    // An enterprise's floor is kept in memory (engine trust.ts getEnterpriseFloor), and its keepers, pledges and legacy
    // floor may have changed with this copy.
    if (newMembers > 0 || updatedMembers > 0 || standingChanges > 0 || tombstonesApplied > 0) clearEnterpriseFloorCache(db);

    // #134: Permanent audit trail — write one row per import with origin peer identity and change counts.
    writeSyncAuditLog({
        originPeerId: signerPeerId,
        originNodeId: remote.nodeId,
        newMembers, updatedMembers, newPosts, updatedPosts,
        newTransactions, accountChanges, marketplaceTxns,
        newMessages, tombstonesApplied, conflictsSkipped, recoverySharesImported,
    });

    return {
        newMembers,
        updatedMembers,
        newPosts,
        updatedPosts,
        newTransactions,
        accountChanges,
        marketplaceTxns,
        newMessages,
        tombstonesApplied,
        conflictsSkipped,
        recoverySharesImported,
    };
}

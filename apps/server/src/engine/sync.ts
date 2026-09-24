// Stateful remote state sync import & topology node role management.
//
// Extracted from apps/server/src/state-engine.ts.

import { db, afterTransactionCommit } from '../db/db.js';
import crypto from 'node:crypto';
import { getImageStore, postPhotoKey } from '../storage/image-store.js';
import { deleteStoredObjects, photoDataOf, storePhotoColumns, type PhotoColumns } from '../storage/image-columns.js';
import { getLocalConfig } from '../config/local-config.js';
import {
    exportSyncState as exportSyncStateEngine,
    type SyncPayload,
    type Transaction
} from '@beanpool/engine';

export type NodeRole = 'primary' | 'backup';
let nodeRole: NodeRole | null = null;

/**
 * local-config.json's `nodeRole` wins over NODE_ROLE in the environment (sealed-keys.md §5.4 step 4). Only a
 * take-over writes it, so a promoted standby needs no .env edit, and a later redeploy with the standby's old .env
 * (NODE_ROLE=backup) cannot demote it. Read once, on first use; setNodeRole replaces it for this process.
 */
function resolveNodeRole(): NodeRole {
    try {
        const configured = getLocalConfig().nodeRole;
        if (configured === 'primary' || configured === 'backup') return configured;
    } catch { /* no readable config: the environment decides */ }
    return process.env.NODE_ROLE === 'backup' ? 'backup' : 'primary';
}

export function getNodeRole(): NodeRole {
    return (nodeRole ??= resolveNodeRole());
}

export function setNodeRole(role: NodeRole): void {
    nodeRole = role;
    console.log(`[Topology] NODE_ROLE set to '${role}'`);
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
    loadLedgerState: (accounts: any[]) => void;
    setCommonsBalance: (balance: number) => void;
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
 */
function storeImportedPhotos(photos: any[]): Map<string, PhotoColumns> {
    const store = getImageStore();
    const out = new Map<string, PhotoColumns>();
    for (const ph of photos) {
        // The other half of the rule `restoreInlinePhotos` keeps on the way out, enforced here on the way
        // in — because the peer sending this payload may be a node that has not been upgraded yet, and
        // during a rolling upgrade it usually is. A photo row with no bytes carries no information, and
        // applying one can only destroy: INSERT OR REPLACE would overwrite an intact local photo with a row
        // the evacuation job skips and the photo route serves as a 404, and the peer's unchanged
        // `updated_at` means no later delta pull ever corrects it. Nothing to apply, so apply nothing.
        if (typeof ph.photo_data !== 'string' || ph.photo_data.length === 0) continue;
        // Last one wins, exactly as the INSERT OR REPLACE loop did when a payload named the same slot twice.
        out.set(`${ph.post_id}|${ph.order_num}`, storePhotoColumns(
            store,
            sb => postPhotoKey(ph.post_id, ph.order_num, sb.sha256, sb.mime),
            ph.photo_data,
        ));
    }
    return out;
}

function restoreInlinePhotos(payload: SyncPayload): SyncPayload {
    const photos = (payload as any).photos as any[] | undefined;
    if (!Array.isArray(photos) || photos.length === 0) return payload;
    const store = getImageStore();
    (payload as any).photos = photos.flatMap(row => {
        let photoData: string | null;
        try {
            photoData = photoDataOf(row, store);
        } catch (e) {
            console.error('[Sync] Could not read a photo out of the image store; omitting the row from this export so a replica keeps its own copy:', e);
            return [];
        }
        // `photoDataOf` returns null only for a row that genuinely holds no image and names no object.
        // Such a row exported whatever its column held before this change, so it still does.
        const out: any = { post_id: row.post_id, photo_data: photoData ?? row.photo_data ?? null, order_num: row.order_num };
        if (row.updated_at !== undefined) out.updated_at = row.updated_at;
        return [out];
    });
    return payload;
}

export async function exportSyncState(
    cb: SyncCallbacks,
    nodeId: string,
    since?: string | null,
    commonsBalance = 0
): Promise<SyncPayload> {
    const payload = restoreInlinePhotos(exportSyncStateEngine(db, nodeId, since, commonsBalance));
    return signSyncPayload(cb, payload);
}

function applyTombstoneLocally(tableName: string, rowKey: string): boolean {
    switch (tableName) {
        case 'friends': {
            const [owner, friend] = rowKey.split('|');
            if (!owner || !friend) return false;
            const r = db.prepare(`DELETE FROM friends WHERE owner_pubkey=? AND friend_pubkey=?`).run(owner, friend);
            return r.changes > 0;
        }
        case 'projects': {
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
        case 'members': {
            const r = db.prepare(`DELETE FROM members WHERE public_key=? AND is_treasury=1`).run(rowKey);
            db.prepare(`DELETE FROM treasury_operators WHERE treasury_pubkey=?`).run(rowKey);
            return r.changes > 0;
        }
        default:
            console.warn(`[Sync] Ignoring tombstone for unknown table: ${tableName}`);
            return false;
    }
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
        default:
            return null;
    }
}

function parseLedgerTs(value: string | null | undefined): number {
    if (!value) return NaN;
    let s = String(value);
    if (s.length === 19 && s[10] === ' ') s = `${s.replace(' ', 'T')}Z`;
    return Date.parse(s);
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

const ENFORCE_LEDGER_AUTH = process.env.ENFORCE_LEDGER_AUTH === 'true';
const LEDGER_CONSERVATION_TOLERANCE = 0.5;

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
        const sigOk = crypto.verify(
            undefined, Buffer.from(tx.authPayload), key, Buffer.from(tx.authSignature, 'base64'),
        );
        if (!sigOk) return false;
        if (tx.authSigner !== tx.from) return false;
        const body = tx.authPayload.split('\n').slice(4).join('\n');
        const signed = JSON.parse(body || '{}');
        if (String(signed.to) !== String(tx.to)) return false;
        if (Number(signed.amount) !== Number(tx.amount)) return false;
        if (String(signed.memo ?? '') !== String(tx.memo ?? '')) return false;
        return true;
    } catch {
        return false;
    }
}

export async function importRemoteState(cb: SyncCallbacks, remote: SyncPayload): Promise<ImportResult> {
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
        'messages', 'abuseReports', 'creatorChannels', 'pulseItems', 'recoveryRequests', 'recoveryApprovals', 'recoveryShares', 'recoveryPins', 'settlements', 'pollVotes', 'eventRsvps', 'groups', 'groupMembers', 'tombstones',
    ];
    for (const cat of importCategories) {
        const arr = remote[cat];
        if (Array.isArray(arr) && arr.length > MAX_IMPORT_ROWS) {
            throw new Error(`[Sync] Import payload category '${String(cat)}' has ${arr.length} rows (> ${MAX_IMPORT_ROWS}); rejecting oversized payload to protect the event loop`);
        }
    }

    let newMembers = 0, newPosts = 0;
    let updatedMembers = 0, updatedPosts = 0;
    let newTransactions = 0, accountChanges = 0, marketplaceTxns = 0, newMessages = 0;
    let tombstonesApplied = 0, conflictsSkipped = 0, recoverySharesImported = 0;
    let groupChanges = 0;

    // Photos go through the store BEFORE the transaction opens, never inside it — the same rule the create
    // and update paths keep (`storedPhotoColumns` in engine/posts.ts). Each `store.put` is a mkdir, a temp
    // write, an `fsyncSync` and a rename; doing that per photo while holding the write lock would, on a
    // force-resync or a first full snapshot, stall a 1 vCPU node for one fsync per photo — thousands of them
    // on a mature node — with nothing else able to run.
    //
    // It also keeps a failed import honest. If the transaction rolls back after the puts, the objects it
    // wrote are orphans, but they are content-addressed: the retry re-derives the same keys and re-uses
    // them, and the storage-health sweep reclaims whatever is genuinely left over.
    const importedPhotoColumns = remote.photos ? storeImportedPhotos(remote.photos) : null;

    currentImportOrigin = remote.nodeId;
    db.pragma('foreign_keys = OFF');

    try {
        db.transaction(() => {
            for (const rm of remote.members ?? []) {
                const existing = db.prepare("SELECT updated_at FROM members WHERE public_key=?").get(rm.publicKey) as { updated_at: string | null } | undefined;
                if (!existing) {
                    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, home_node_url, avatar_url, bio, contact_value, contact_visibility, status, last_active_at, elder_vouched_by, archetype, updated_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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
                        rm.updatedAt || rm.joinedAt
                    );
                    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(rm.publicKey);
                    newMembers++;
                } else {
                    if (rm.updatedAt && existing.updated_at && existing.updated_at >= rm.updatedAt) {
                        conflictsSkipped++;
                        continue;
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
                        rm.updatedAt || existing.updated_at || new Date().toISOString(),
                        rm.publicKey
                    );
                    if (res.changes > 0) updatedMembers++;
                }
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
                                audience_scope, target_group_id, target_pubkey, assigned_to, reach, reach_peers)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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
                        rp.originNode || remote.nodeId,
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
                        ...postScope(rp)
                    );
                    newPosts++;
                } else {
                    if (rp.updatedAt && existing.updated_at && existing.updated_at >= rp.updatedAt) {
                        conflictsSkipped++;
                        continue;
                    }
                    const res = db.prepare(`UPDATE posts SET
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
                        updated_at = ?
                        WHERE id = ?`).run(
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
                // transaction opened. All that is left in here is the row.
                const insertPhoto = db.prepare(
                    `INSERT OR REPLACE INTO post_photos (post_id, photo_data, order_num, storage_key, sha256, bytes, mime)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`
                );
                for (const [key, cols] of importedPhotoColumns) {
                    const sep = key.lastIndexOf('|');
                    const postId = key.slice(0, sep);
                    const orderNum = Number(key.slice(sep + 1));
                    insertPhoto.run(postId, cols.photo_data, orderNum, cols.storage_key, cols.sha256, cols.bytes, cols.mime);
                }
            }

            if (remote.projects) {
                for (const pr of remote.projects) {
                    db.prepare(`INSERT OR REPLACE INTO projects (id, creator_pubkey, title, description, photos, goal_amount, current_amount, deadline_at, status, created_at) 
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                        pr.id,
                        pr.creator_pubkey,
                        pr.title,
                        pr.description,
                        pr.photos,
                        pr.goal_amount,
                        pr.current_amount,
                        pr.deadline_at,
                        pr.status,
                        pr.created_at
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

            if (remote.accounts) {
                const accountCountBefore = (db.prepare("SELECT COUNT(*) AS c FROM accounts").get() as { c: number }).c;
                let importedBalanceDelta = 0;

                for (const acc of remote.accounts) {
                    if (typeof acc.balance !== 'number' || !Number.isFinite(acc.balance)) {
                        conflictsSkipped++;
                        continue;
                    }
                    const existing = db.prepare("SELECT balance, last_updated_at FROM accounts WHERE public_key=?")
                        .get(acc.publicKey) as { balance: number; last_updated_at: string | null } | undefined;
                    if (existing) {
                        const localEpoch = parseLedgerTs(existing.last_updated_at);
                        const remoteEpoch = parseLedgerTs(acc.lastUpdatedAt);
                        if (Number.isFinite(localEpoch) && Number.isFinite(remoteEpoch) && localEpoch >= remoteEpoch) {
                            conflictsSkipped++;
                            continue;
                        }
                    }
                    const res = db.prepare(`INSERT INTO accounts (public_key, balance, last_updated_at, last_demurrage_epoch)
                                VALUES (?, ?, ?, ?)
                                ON CONFLICT(public_key) DO UPDATE SET
                                    balance = excluded.balance,
                                    last_updated_at = excluded.last_updated_at,
                                    last_demurrage_epoch = excluded.last_demurrage_epoch`).run(
                        acc.publicKey,
                        acc.balance,
                        acc.lastUpdatedAt,
                        acc.lastDemurrageEpoch
                    );
                    if (res.changes > 0) {
                        accountChanges++;
                        importedBalanceDelta += acc.balance - (existing?.balance ?? 0);
                    }
                }

                if ((ENFORCE_LEDGER_AUTH || getNodeRole() === 'backup') && accountCountBefore > 1
                    && Math.abs(importedBalanceDelta) > LEDGER_CONSERVATION_TOLERANCE) {
                    throw new Error(`[Sync] Conservation violation: import shifted total balance by ${importedBalanceDelta.toFixed(4)} (> ${LEDGER_CONSERVATION_TOLERANCE}); rejecting value-creating payload`);
                }

                const updatedAccs = db.prepare("SELECT public_key as id, balance, last_demurrage_epoch as lastDemurrageEpoch FROM accounts").all() as any[];
                cb.loadLedgerState(updatedAccs);

                if (remote.accounts.some(a => a.publicKey === 'COMMONS_POOL')) {
                    const commonsRow = db.prepare("SELECT balance FROM accounts WHERE public_key='COMMONS_POOL'")
                        .get() as { balance: number } | undefined;
                    if (commonsRow) {
                        cb.setCommonsBalance(commonsRow.balance);
                    }
                }
            }

            if (remote.transactions) {
                for (const tx of remote.transactions) {
                    if (ENFORCE_LEDGER_AUTH && !verifyTransactionAuthorship(tx)) {
                        conflictsSkipped++;
                        continue;
                    }
                    if (!tx.from || !tx.to || typeof tx.amount !== 'number' || !Number.isFinite(tx.amount) || tx.amount <= 0) {
                        conflictsSkipped++;
                        continue;
                    }
                    const res = db.prepare(`INSERT OR IGNORE INTO transactions (id, from_pubkey, to_pubkey, amount, memo, timestamp, auth_signer, auth_signature, auth_payload)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                        tx.id,
                        tx.from,
                        tx.to,
                        tx.amount,
                        tx.memo,
                        tx.timestamp,
                        tx.authSigner ?? null,
                        tx.authSignature ?? null,
                        tx.authPayload ?? null,
                    );
                    if (res.changes > 0) newTransactions++;
                }
            }

            if (remote.marketplaceTransactions) {
                for (const mt of remote.marketplaceTransactions) {
                    const res = db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, hours, status, created_at, completed_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                                ON CONFLICT(id) DO UPDATE SET
                                    status = excluded.status,
                                    completed_at = excluded.completed_at,
                                    hours = excluded.hours,
                                    credits = excluded.credits`).run(
                        mt.id,
                        mt.postId ?? mt.post_id ?? null,
                        mt.buyerPubkey ?? mt.buyerPublicKey ?? mt.buyer_pubkey ?? null,
                        mt.sellerPubkey ?? mt.sellerPublicKey ?? mt.seller_pubkey ?? null,
                        mt.credits ?? 0,
                        mt.hours ?? null,
                        mt.status ?? 'pending',
                        mt.createdAt ?? mt.created_at ?? new Date().toISOString(),
                        mt.completedAt ?? mt.completed_at ?? null
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

            if (remote.tombstones) {
                for (const ts of remote.tombstones) {
                    const localTs = lookupLocalUpdatedAt(ts.tableName, ts.rowKey);
                    if (localTs && localTs > ts.deletedAt) {
                        conflictsSkipped++;
                        continue;
                    }
                    const deleted = applyTombstoneLocally(ts.tableName, ts.rowKey);
                    db.prepare(`INSERT OR REPLACE INTO tombstones (table_name, row_key, deleted_at)
                                VALUES (?, ?, ?)`).run(ts.tableName, ts.rowKey, ts.deletedAt);
                    if (deleted) tombstonesApplied++;
                    if (deleted && ts.tableName === 'group_members') groupChanges++;
                }
            }
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
    if (newMembers > 0 || newPosts > 0 || updatedMembers > 0 || updatedPosts > 0 || tombstonesApplied > 0 || groupChanges > 0) {
        cb.broadcast({
            type: 'state_synced',
            newMembers, newPosts, updatedMembers, updatedPosts, tombstonesApplied, groupChanges,
            from: remote.nodeId,
        });
    }

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

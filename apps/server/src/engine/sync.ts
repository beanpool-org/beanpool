// Stateful remote state sync import & topology node role management.
//
// Extracted from apps/server/src/state-engine.ts.

import { db } from '../db/db.js';
import crypto from 'node:crypto';
import {
    exportSyncState as exportSyncStateEngine,
    type SyncPayload,
    type Transaction
} from '@beanpool/engine';

export type NodeRole = 'primary' | 'backup';
let nodeRole: NodeRole = process.env.NODE_ROLE === 'backup' ? 'backup' : 'primary';

export function getNodeRole(): NodeRole {
    return nodeRole;
}

export function setNodeRole(role: NodeRole): void {
    nodeRole = role;
    console.log(`[Topology] NODE_ROLE set to '${role}'`);
}

export function getSyncCursor(peerId: string): string | null {
    const row = db.prepare(`SELECT last_synced_at FROM sync_cursors WHERE peer_id=?`).get(peerId) as { last_synced_at: string } | undefined;
    return row?.last_synced_at ?? null;
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

export async function exportSyncState(
    cb: SyncCallbacks,
    nodeId: string,
    since?: string | null,
    commonsBalance = 0
): Promise<SyncPayload> {
    const payload = exportSyncStateEngine(db, nodeId, since, commonsBalance);
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
            const r = db.prepare(`DELETE FROM post_photos WHERE post_id=? AND order_num=?`).run(postId, Number(orderNum));
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
    if (nodeRole !== 'backup') {
        throw new Error(`[Sync] This node runs as '${nodeRole}', which imports no remote state (one-directional backup topology). Inbound state rejected.`);
    }

    if (!remote.signature || !remote.publicKey) {
        throw new Error(`[Sync] Cryptographic validation failed: Missing SyncPayload signature or publicKey`);
    }

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
        const signerPeerId = peerIdFromPublicKey(pubKey as any).toString();
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
        'messages', 'abuseReports', 'recoveryRequests', 'recoveryApprovals', 'tombstones',
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
    let tombstonesApplied = 0, conflictsSkipped = 0;

    currentImportOrigin = remote.nodeId;
    db.pragma('foreign_keys = OFF');

    try {
        db.transaction(() => {
            for (const rm of remote.members ?? []) {
                const existing = db.prepare("SELECT updated_at FROM members WHERE public_key=?").get(rm.publicKey) as { updated_at: string | null } | undefined;
                if (!existing) {
                    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, home_node_url, avatar_url, bio, contact_value, contact_visibility, status, last_active_at, elder_vouched_by, updated_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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
                        rm.updatedAt || existing.updated_at || new Date().toISOString(),
                        rm.publicKey
                    );
                    if (res.changes > 0) updatedMembers++;
                }
            }

            for (const rp of remote.posts ?? []) {
                const existing = db.prepare("SELECT updated_at FROM posts WHERE id=?").get(rp.id) as { updated_at: string | null } | undefined;
                if (!existing) {
                    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, active, status, repeatable, lat, lng, origin_node, price_type, accepted_by, accepted_at, pending_transaction_id, completed_at, updated_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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
                        rp.updatedAt || rp.createdAt
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
                        rp.updatedAt || existing.updated_at || new Date().toISOString(),
                        rp.id
                    );
                    if (res.changes > 0) updatedPosts++;
                }
            }

            if (remote.photos) {
                for (const ph of remote.photos) {
                    db.prepare(`INSERT OR REPLACE INTO post_photos (post_id, photo_data, order_num) 
                                VALUES (?, ?, ?)`).run(
                        ph.post_id,
                        ph.photo_data,
                        ph.order_num
                    );
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

                if ((ENFORCE_LEDGER_AUTH || nodeRole === 'backup') && accountCountBefore > 1
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
                    db.prepare(`INSERT INTO friends (owner_pubkey, friend_pubkey, added_at, is_guardian)
                                VALUES (?, ?, ?, ?)
                                ON CONFLICT(owner_pubkey, friend_pubkey) DO UPDATE SET
                                    is_guardian = excluded.is_guardian`).run(
                        fr.ownerPubkey,
                        fr.friendPubkey,
                        fr.addedAt,
                        fr.isGuardian ? 1 : 0
                    );
                }
            }

            if (remote.conversations) {
                for (const cv of remote.conversations) {
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
                for (const cp of remote.conversationParticipants) {
                    db.prepare(`INSERT INTO conversation_participants (conversation_id, public_key, last_read_at)
                                VALUES (?, ?, ?)
                                ON CONFLICT(conversation_id, public_key) DO UPDATE SET
                                    last_read_at = excluded.last_read_at`).run(
                        cp.conversationId,
                        cp.publicKey,
                        cp.lastReadAt || null
                    );
                }
            }

            if (remote.messages) {
                for (const msg of remote.messages) {
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
                    db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_post_id, reason, created_at, status, updated_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                                ON CONFLICT(id) DO UPDATE SET
                                    status = excluded.status,
                                    updated_at = excluded.updated_at
                                WHERE excluded.updated_at IS NOT NULL
                                  AND (abuse_reports.updated_at IS NULL OR excluded.updated_at > abuse_reports.updated_at)`).run(
                        ar.id,
                        ar.reporterPubkey,
                        ar.targetPubkey,
                        ar.targetPostId || null,
                        ar.reason,
                        ar.createdAt,
                        ar.status || 'pending',
                        ar.updatedAt || ar.createdAt
                    );
                }
            }

            if (remote.recoveryRequests) {
                for (const rr of remote.recoveryRequests) {
                    db.prepare(`INSERT INTO recovery_requests (id, old_pubkey, new_pubkey, status, quorum_required, created_at, cooldown_until, executed_at, expires_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                                ON CONFLICT(id) DO UPDATE SET
                                    status = excluded.status,
                                    cooldown_until = excluded.cooldown_until,
                                    executed_at = excluded.executed_at,
                                    expires_at = excluded.expires_at`).run(
                        rr.id,
                        rr.oldPubkey,
                        rr.newPubkey,
                        rr.status,
                        rr.quorumRequired,
                        rr.createdAt,
                        rr.cooldownUntil || null,
                        rr.executedAt || null,
                        rr.expiresAt || null
                    );
                }
            }

            if (remote.recoveryApprovals) {
                for (const ra of remote.recoveryApprovals) {
                    db.prepare(`INSERT OR IGNORE INTO recovery_approvals (request_id, guardian_pubkey, decision, created_at)
                                VALUES (?, ?, ?, ?)`).run(
                        ra.requestId,
                        ra.guardianPubkey,
                        ra.decision,
                        ra.createdAt
                    );
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
                }
            }
        })();
    } finally {
        db.pragma('foreign_keys = ON');
        currentImportOrigin = null;
    }

    if (newMembers > 0 || newPosts > 0) {
        cb.broadcast({ type: 'state_synced', newMembers, newPosts, from: remote.nodeId });
    }
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
    };
}

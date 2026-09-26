/**
 * Member Re-Keying & Offboarding Wizards Engine
 *
 * Implements docs/settings-ia.md §5 items 1 & 4 (Item 9b):
 *
 * (1) Lost Phone / Re-Keying:
 *     - Operator-assisted in-person verification flow
 *     - Immediately invalidates old device public key
 *     - Issues a secure one-time re-enrolment code
 *     - Atomic transfer of every database row keyed by the old pubkey across all consumers
 *     - Preserves balance, trade history, trust badges, node roles, and keeperships
 *     - In-memory ledger reconciliation & conservation asserted
 *     - Comprehensive audit records
 *
 * (2) Offboarding:
 *     - Wizard for departing members holding positive or negative balances
 *     - Positive balance: Donate to Commons Pool OR Gift to another active member
 *     - Two-person rule enforcement: Actor cannot gift departing balance to themselves
 *     - Negative balance: Formal write-off against the Commons pool using the existing prune path,
 *       with upfront calculation of community cost
 *     - Status set to pruned, conservation asserted
 */

import crypto from 'node:crypto';
import { db } from '../db/db.js';
import {
    conservingTransaction,
    moveToCommons,
    transfer,
    getMember,
    adminPruneUser,
    assertMayPrune,
    isSoleOwner,
    broadcast,
    getBalance,
    getCommonsBalanceExact,
    reconcileLedgerFromDb,
    countOpenTrades,
} from '../state-engine.js';
import { ledger } from './ledger.js';
import { logger } from '../logger.js';
import { revokeAllMemberSessions, purgeMemberSessions } from '../admin-key-auth.js';
import { noteTakeoverInputsChanged } from '../services/takeover-signal.js';
import { movePlaceWatches } from './place-watches.js';
import { moveRecoverySharesToNewKey } from './recovery-shares.js';
import { moveKnocks } from './knocks.js';
import { moveKeptNotices } from './kept-notices.js';
import { moveMemberKeyRows } from './key-move.js';

// ===================== TYPES =====================

export interface RekeyRequestRow {
    id: number;
    code: string;
    old_pubkey: string;
    new_pubkey: string | null;
    operator_pubkey: string;
    status: 'pending' | 'completed' | 'cancelled' | 'expired';
    created_at: string;
    expires_at: string;
    completed_at: string | null;
}

export interface RekeyAuditLogRow {
    id: number;
    old_pubkey: string;
    new_pubkey: string;
    reenrollment_code: string;
    operator_pubkey: string;
    performed_at: string;
    completed_at: string | null;
    details: string | null;
}

export interface InvalidatedKeyRow {
    public_key: string;
    reason: string;
    invalidated_at: string;
    rekeyed_to: string | null;
}

export interface OffboardPreview {
    member: {
        publicKey: string;
        callsign: string;
        status: string;
        joinedAt: string;
    };
    balance: number;
    commonsBalance: number;
    costToCommunity: number;
    projectedCommonsBalance: number;
    pendingEscrowsCount: number;
    isSoleOwner: boolean;
    activeMembers: Array<{
        publicKey: string;
        callsign: string;
    }>;
}

export interface OffboardOptions {
    resolution: 'donate_to_commons' | 'gift_to_member' | 'write_off_commons' | 'prune_zero_balance';
    giftRecipientPubkey?: string;
}

export const REKEY_CODE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** completeRekey's refusal for an account deleted or removed after its code was issued. */
export const REKEY_ACCOUNT_GONE = 'This account was deleted or removed from this community, so it can’t be moved to a new key.';

// ===================== KEY INVALIDATION HELPERS =====================

/**
 * Checks if a public key has been explicitly invalidated (e.g. lost phone, re-keyed).
 */
export function isKeyInvalidated(publicKey: string): boolean {
    if (!publicKey) return false;
    try {
        const row = db.prepare('SELECT 1 FROM invalidated_keys WHERE public_key = ?').get(publicKey);
        return !!row;
    } catch {
        return false;
    }
}

/**
 * Retrieves the invalidation details for a given public key if invalidated.
 */
export function getInvalidatedKeyInfo(publicKey: string): InvalidatedKeyRow | null {
    if (!publicKey) return null;
    try {
        return (db.prepare('SELECT * FROM invalidated_keys WHERE public_key = ?').get(publicKey) as InvalidatedKeyRow) || null;
    } catch {
        return null;
    }
}

// ===================== RE-KEYING FLOW =====================

/**
 * Generates an 8-character human-friendly one-time re-enrolment code (e.g. RK-A1B2-C3D4).
 */
export function generateRekeyCode(): string {
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `RK-${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

/**
 * Step 1 of Re-keying: Operator initiates re-keying for a verified member.
 * - Invalidates old key in `invalidated_keys` immediately
 * - Suspends member account to prevent old device actions
 * - Issues a secure one-time re-enrolment code
 * - Revokes any active admin sessions for the old key
 */
export function issueRekeyCode(
    oldPublicKey: string,
    operatorPubkey: string,
    opts?: { ttlMs?: number }
): { code: string; oldPubkey: string; callsign: string; expiresAt: string } {
    const cleanOld = oldPublicKey ? oldPublicKey.trim().toLowerCase() : '';
    const cleanOperator = operatorPubkey ? operatorPubkey.trim().toLowerCase() : 'owner:password';
    const member = getMember(cleanOld);
    if (!member) {
        throw new Error('Member not found');
    }
    if (member.status === 'pruned') {
        throw new Error('Cannot re-key a pruned member');
    }
    if (isKeyInvalidated(cleanOld)) {
        const info = getInvalidatedKeyInfo(cleanOld);
        if (info?.rekeyed_to) {
            throw new Error(`This key was already re-keyed to ${info.rekeyed_to}`);
        }
    }

    const ttl = opts?.ttlMs || REKEY_CODE_TTL_MS;
    const nowIso = new Date().toISOString();
    const expiresAtIso = new Date(Date.now() + ttl).toISOString();
    const code = generateRekeyCode();

    // Atomic issuance & invalidation
    db.transaction(() => {
        // Cancel any existing pending requests for this member
        db.prepare("UPDATE rekey_requests SET status = 'cancelled' WHERE old_pubkey = ? AND status = 'pending'").run(cleanOld);

        // Record in invalidated_keys
        db.prepare(`
            INSERT INTO invalidated_keys (public_key, reason, invalidated_at)
            VALUES (?, 'rekey_pending', ?)
            ON CONFLICT(public_key) DO UPDATE SET reason = 'rekey_pending', invalidated_at = excluded.invalidated_at
        `).run(cleanOld, nowIso);

        // Suspend member row so assertMemberActive rejects operations from old device. A member already
        // suspended by an admin or the community (status 'disabled') stays 'disabled': the invalidated key
        // already stops the old device, and overwriting it would let a rekey end the suspension.
        db.prepare("UPDATE members SET status = 'suspended', updated_at = ? WHERE public_key = ? AND status != 'disabled'").run(nowIso, cleanOld);

        // Insert new pending rekey request
        db.prepare(`
            INSERT INTO rekey_requests (code, old_pubkey, operator_pubkey, status, created_at, expires_at)
            VALUES (?, ?, ?, 'pending', ?, ?)
        `).run(code, cleanOld, cleanOperator, nowIso, expiresAtIso);

        // Write system log
        db.prepare(`
            INSERT INTO system_logs (timestamp, level, category, message, metadata)
            VALUES (?, 'INFO', 'AUTH', ?, ?)
        `).run(
            nowIso,
            `Re-enrolment code issued for member ${member.callsign} (${cleanOld.slice(0, 10)}...) by operator ${cleanOperator}`,
            JSON.stringify({ oldPubkey: cleanOld, operatorPubkey: cleanOperator, code, expiresAt: expiresAtIso })
        );
    })();

    // Revoke any web admin sessions for old key
    try {
        revokeAllMemberSessions(cleanOld);
        purgeMemberSessions(cleanOld);
    } catch {
        // Ignored if member is not an admin
    }

    // The old key is suspended, so an owner re-keying drops out of the take-over lock until the new key is bound.
    noteTakeoverInputsChanged('member re-key started');

    broadcast({ type: 'profile_updated', publicKey: cleanOld });
    logger.info('AUTH', `[Rekey] Re-enrolment code ${code} issued for ${member.callsign} by ${cleanOperator}`);

    return {
        code,
        oldPubkey: cleanOld,
        callsign: member.callsign,
        expiresAt: expiresAtIso,
    };
}

/**
 * Step 2 of Re-keying: Atomic transfer of all rows keyed by oldPubkey to newPubkey.
 * Enumerates all 32 consumers of members.public_key across the schema.
 */
export function completeRekey(
    oldPublicKey: string,
    newPublicKey: string,
    code: string,
    operatorPubkey: string
): { success: boolean; oldPubkey: string; newPubkey: string; callsign: string } {
    const cleanOld = oldPublicKey.trim().toLowerCase();
    const cleanNew = newPublicKey.trim().toLowerCase();

    if (!/^[0-9a-f]{64}$/.test(cleanNew)) {
        throw new Error('Invalid new public key: must be a 64-character hex string');
    }
    if (cleanNew === cleanOld) {
        throw new Error('New public key must be different from old public key');
    }
    if (isKeyInvalidated(cleanNew)) {
        throw new Error('New public key has been previously invalidated');
    }
    const existingNew = getMember(cleanNew);
    if (existingNew) {
        throw new Error('New public key is already registered to a member');
    }

    const req = db.prepare('SELECT * FROM rekey_requests WHERE code = ? AND old_pubkey = ?').get(code, cleanOld) as RekeyRequestRow | undefined;
    if (!req) {
        throw new Error('Invalid or unrecognised re-enrolment code');
    }
    if (req.status !== 'pending') {
        throw new Error(`Re-enrolment code is no longer active (status: ${req.status})`);
    }
    // An account deleted by its owner (purgeMemberSelf) or removed (adminPruneUser, by an admin or a community vote)
    // since the code was issued stays that way: issueRekeyCode refuses a pruned member, and this is its other half.
    // Completing used to set the row back to 'active' and hand it to the new key: a deleted account came back emptied
    // ("Deleted Member", no Beans), and a removed one came back with no decision after the removal. The way back from a
    // removal is the community's reinstate_member vote, after which a re-key works as usual. Refused before any write.
    if (getMember(cleanOld)?.status === 'pruned') {
        throw new Error(REKEY_ACCOUNT_GONE);
    }
    if (new Date(req.expires_at).getTime() < Date.now()) {
        db.prepare("UPDATE rekey_requests SET status = 'expired' WHERE id = ?").run(req.id);
        throw new Error('Re-enrolment code has expired; please request a new code from the operator');
    }

    const member = getMember(cleanOld);
    if (!member) {
        throw new Error('Old member record not found');
    }

    const nowIso = new Date().toISOString();

    // Atomic execution inside conservingTransaction
    conservingTransaction(() => {
        // 1. Invalidate old key permanently with rekeyed_to link
        db.prepare(`
            INSERT INTO invalidated_keys (public_key, reason, invalidated_at, rekeyed_to)
            VALUES (?, 'rekeyed', ?, ?)
            ON CONFLICT(public_key) DO UPDATE SET
                reason = 'rekeyed',
                invalidated_at = excluded.invalidated_at,
                rekeyed_to = excluded.rekeyed_to
        `).run(cleanOld, nowIso, cleanNew);

        // 2. Enumerate and transfer ALL 32 consumers of members.public_key (engine/key-move.ts, which a standby's copy
        // follows with too), each row stamped so the standby's next copy carries the move.
        moveMemberKeyRows(cleanOld, cleanNew, nowIso, { keepStamps: false });

        // What the main server moves by rules of its own, each stamped so the move replicates.
        // (n2) place watches (G5): the places the member watches are theirs, whatever device holds the key.
        movePlaceWatches(cleanOld, cleanNew);
        // (p) recovery shares
        // The owner is what a wrapped copy is bound to, so the move opens and re-wraps each copy the member owns. Without
        // the recovery-seal key it throws and this whole re-key rolls back (engine/recovery-shares.ts).
        moveRecoverySharesToNewKey(cleanOld, cleanNew);
        // (p2) Requests to join (G6): a knock the member made before they joined, and the knocks they answered. Left on
        // the invalidated key, the old knock would be back on the members' list and an approval would let that key in
        // as a second member; deleting the account would miss what they wrote. Stamped, so the move replicates
        // (engine/knocks.ts).
        moveKnocks(cleanOld, cleanNew, nowIso);
        // (p3) The moderation notices kept for them (engine/kept-notices.ts): what they have not seen yet is theirs on the
        // new key. Stamped, so the move replicates.
        moveKeptNotices(cleanOld, cleanNew);

        // 3. Mark rekey request completed
        db.prepare("UPDATE rekey_requests SET status = 'completed', new_pubkey = ?, completed_at = ? WHERE id = ?").run(cleanNew, nowIso, req.id);

        // 4. Record permanent rekey audit entry
        db.prepare(`
            INSERT INTO rekey_audit_log (old_pubkey, new_pubkey, reenrollment_code, operator_pubkey, completed_at, details)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            cleanOld,
            cleanNew,
            code,
            operatorPubkey,
            nowIso,
            JSON.stringify({
                callsign: member.callsign,
                operatorPubkey,
                completedAt: nowIso,
            })
        );

        // 5. System log entry
        db.prepare(`
            INSERT INTO system_logs (timestamp, level, category, message, metadata)
            VALUES (?, 'INFO', 'AUTH', ?, ?)
        `).run(
            nowIso,
            `Member ${member.callsign} re-keyed: ${cleanOld.slice(0, 10)}... -> ${cleanNew.slice(0, 10)}... bound to new key by operator ${operatorPubkey}`,
            JSON.stringify({ oldPubkey: cleanOld, newPubkey: cleanNew, operatorPubkey, code })
        );
    });

    // 6. Resync the in-memory LedgerManager from SQLite accounts after transaction commit succeeds
    reconcileLedgerFromDb();

    // Revoke any residual sessions for old key
    try {
        revokeAllMemberSessions(cleanOld);
        purgeMemberSessions(cleanOld);
    } catch {
        // Ignored
    }

    // node_roles.member_pubkey moved to the new key above: an owner's take-over lock must follow it now, not at the
    // next periodic check (sealed-keys.md §4).
    noteTakeoverInputsChanged('member re-keyed');

    broadcast({ type: 'profile_updated', publicKey: cleanNew });
    broadcast({ type: 'member_rekeyed', oldPublicKey: cleanOld, newPublicKey: cleanNew });
    logger.info('AUTH', `[Rekey] Completed atomic transfer for ${member.callsign}: ${cleanOld} -> ${cleanNew}`);

    return {
        success: true,
        oldPubkey: cleanOld,
        newPubkey: cleanNew,
        callsign: member.callsign,
    };
}

/**
 * Gets the current rekey status for a member.
 */
export function getRekeyStatus(publicKey: string): {
    isInvalidated: boolean;
    invalidatedInfo: InvalidatedKeyRow | null;
    pendingRequest: RekeyRequestRow | null;
    history: RekeyAuditLogRow[];
} {
    const cleanPub = publicKey.trim().toLowerCase();
    const isInvalidated = isKeyInvalidated(cleanPub);
    const invalidatedInfo = getInvalidatedKeyInfo(cleanPub);

    let pendingRequest: RekeyRequestRow | null = (db.prepare(
        "SELECT * FROM rekey_requests WHERE old_pubkey = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
    ).get(cleanPub) as RekeyRequestRow | undefined) || null;

    if (pendingRequest && new Date(pendingRequest.expires_at).getTime() < Date.now()) {
        db.prepare("UPDATE rekey_requests SET status = 'expired' WHERE id = ?").run(pendingRequest.id);
        pendingRequest = null;
    }

    const history = (db.prepare(
        'SELECT * FROM rekey_audit_log WHERE old_pubkey = ? OR new_pubkey = ? ORDER BY performed_at DESC'
    ).all(cleanPub, cleanPub) as RekeyAuditLogRow[]) || [];

    return {
        isInvalidated,
        invalidatedInfo,
        pendingRequest,
        history,
    };
}

// ===================== OFFBOARDING FLOW =====================

/**
 * Computes preview data for offboarding a member:
 * - Current balance
 * - Commons pool balance
 * - Community cost for negative debt write-off
 * - Projected Commons pool after write-off or donation
 * - Active members for gifting
 * - Check for pending escrows
 */
export function getOffboardPreview(publicKey: string): OffboardPreview {
    const cleanPub = publicKey.trim().toLowerCase();
    const member = getMember(cleanPub);
    if (!member) {
        throw new Error('Member not found');
    }

    const balanceInfo = getBalance(cleanPub);
    const balance = balanceInfo.balance;
    const commonsBalance = getCommonsBalanceExact();
    const isOwner = isSoleOwner(cleanPub);

    const pendingEscrows = countOpenTrades(cleanPub);

    const activeMembers = db.prepare(
        "SELECT public_key as publicKey, callsign FROM members WHERE status = 'active' AND public_key != ? AND is_treasury = 0 ORDER BY callsign COLLATE NOCASE ASC"
    ).all(cleanPub) as Array<{ publicKey: string; callsign: string }>;

    let costToCommunity = 0;
    let projectedCommonsBalance = commonsBalance;

    if (balance < 0) {
        costToCommunity = Math.abs(balance);
        projectedCommonsBalance = commonsBalance - costToCommunity;
    } else if (balance > 0) {
        // If donated to commons
        projectedCommonsBalance = commonsBalance + balance;
    }

    return {
        member: {
            publicKey: cleanPub,
            callsign: member.callsign,
            status: member.status || 'active',
            joinedAt: member.joinedAt || new Date().toISOString(),
        },
        balance,
        commonsBalance,
        costToCommunity,
        projectedCommonsBalance,
        pendingEscrowsCount: pendingEscrows,
        isSoleOwner: isOwner,
        activeMembers,
    };
}

function getPreviousOffboardResult(
    cleanPub: string,
    callsign: string,
    requestedResolution: string
): { success: boolean; memberPubkey: string; callsign: string; resolution: string; balanceSettled: number } {
    try {
        const row = db.prepare(`
            SELECT metadata FROM system_logs
            WHERE category = 'ADMIN'
              AND (
                  json_extract(metadata, '$.memberPubkey') = ?
                  OR message LIKE ?
              )
            ORDER BY timestamp DESC LIMIT 1
        `).get(cleanPub, `%Member ${callsign}%offboarded%`) as { metadata?: string } | undefined;

        if (row?.metadata) {
            const meta = JSON.parse(row.metadata);
            return {
                success: true,
                memberPubkey: cleanPub,
                callsign,
                resolution: meta.resolution || requestedResolution,
                balanceSettled: typeof meta.balanceSettled === 'number' ? meta.balanceSettled : 0,
            };
        }
    } catch {
        // Fall back to default
    }

    return {
        success: true,
        memberPubkey: cleanPub,
        callsign,
        resolution: requestedResolution,
        balanceSettled: 0,
    };
}

/**
 * Executes member offboarding:
 * - Positive balance: Donate to Commons OR Gift to active member
 *   * Two-person rule: Actor cannot gift to themselves
 * - Negative balance: Formally write off against Commons using adminPruneUser
 * - Prune member record and assert ledger conservation
 */
export function executeOffboard(
    publicKey: string,
    options: OffboardOptions,
    operatorPubkey: string
): { success: boolean; memberPubkey: string; callsign: string; resolution: string; balanceSettled: number } {
    const cleanPub = publicKey.trim().toLowerCase();
    const cleanOperator = operatorPubkey ? operatorPubkey.trim().toLowerCase() : 'owner:password';

    const member = getMember(cleanPub);
    if (!member) {
        throw new Error('Member not found');
    }
    if (member.status === 'pruned') {
        // Idempotent: already pruned member is a no-op that returns the first result
        return getPreviousOffboardResult(cleanPub, member.callsign, options.resolution);
    }
    if (isSoleOwner(cleanPub)) {
        throw new Error('Cannot offboard the sole node owner; appoint another owner first');
    }
    // Before any money moves: only an owner may offboard an owner or admin (403 otherwise).
    assertMayPrune(cleanPub, cleanOperator);

    // Guard against pending escrows or open trade requests before pruning
    const openTrades = countOpenTrades(cleanPub);
    if (openTrades > 0) {
        throw new Error('Cannot offboard member with active deals in escrow or open trade requests. Resolve or cancel pending trades first.');
    }

    const resolution = options.resolution;
    let balanceSettled = 0;
    let idempotentResult: { success: boolean; memberPubkey: string; callsign: string; resolution: string; balanceSettled: number } | null = null;

    // Execute in conservingTransaction to guarantee SUM(balances) + COMMONS_POOL = 0
    conservingTransaction(() => {
        const liveMember = getMember(cleanPub);
        if (liveMember?.status === 'pruned') {
            idempotentResult = getPreviousOffboardResult(cleanPub, member.callsign, resolution);
            return;
        }

        // Read balance INSIDE conservingTransaction so that any concurrent mutations are captured.
        //
        // TWO FIGURES, on purpose. What MOVES is the exact ledger balance. `getBalance()` rounds to 2dp for
        // display, and settling that figure fails whenever the two differ, which is routine: the 1.5% fee on
        // a 7-Bean sale leaves the seller 6.895, shown as 6.90, and debiting 6.90 from 6.895 breaks the
        // floor of 0, so the donation below was refused and the whole offboarding aborted; the gift was
        // refused the same way. Where the exact figure is the larger one, the rounded amount went through
        // and the prune confiscated the remainder, short-changing a gift's recipient.
        //
        // The ROUNDED figure still decides which resolution this member needs, because it is the one the
        // wizard showed the operator and picked the resolution from: a balance shown as 0.00 is sent as
        // prune_zero_balance. The two can only disagree about the sign when the shown figure is 0.00, i.e.
        // under half a cent either way, and that dust is left to `adminPruneUser`, which settles the exact
        // balance itself.
        const shownBalance = getBalance(cleanPub).balance;
        const balance = ledger.getAccount(cleanPub).balance;
        balanceSettled = balance;

        if (shownBalance > 0) {
            if (resolution === 'donate_to_commons') {
                // Refusal must abort the offboarding, not be ignored: the member is marked 'pruned' below,
                // so a swallowed null leaves their balance stranded on an account nobody can sign for and
                // the node no longer sums to zero. Inside the enclosing conservingTransaction.
                const donated = moveToCommons(cleanPub, balance, `Donation to Commons on member offboarding: ${member.callsign.trim()}`, {
                    allowMemberDebit: true,
                });
                if (!donated) throw new Error('Could not move the departing balance to the Commons — offboarding aborted');
            } else if (resolution === 'gift_to_member') {
                if (!cleanOperator || cleanOperator === 'owner:password') {
                    const err: any = new Error('Two-person rule requires signed key-based admin authentication to gift offboarding funds.');
                    err.status = 403;
                    err.statusCode = 403;
                    err.code = 'KEY_AUTH_REQUIRED';
                    throw err;
                }
                const recipientPub = options.giftRecipientPubkey?.trim().toLowerCase();
                if (!recipientPub) {
                    throw new Error('Recipient member must be specified for gifting offboarding balance');
                }
                if (recipientPub === cleanPub) {
                    throw new Error('Cannot gift offboarding balance to the departing member themselves');
                }

                // Two-person rule enforcement (docs/the-commons.md §2.3 and item 9b):
                // If the acting operator benefits from the gift, reject.
                if (cleanOperator === recipientPub) {
                    const err: any = new Error(
                        'Two-person rule violation: You cannot gift a departing member\'s balance to yourself. Another operator must execute this offboarding.'
                    );
                    err.status = 403;
                    err.statusCode = 403;
                    err.code = 'TWO_PERSON_RULE';
                    throw err;
                }

                const recipient = getMember(recipientPub);
                if (!recipient || recipient.status !== 'active') {
                    throw new Error('Selected gift recipient is not an active member');
                }

                const txRes = transfer(
                    cleanPub,
                    recipientPub,
                    balance,
                    `Offboarding gift from ${member.callsign.trim()}`,
                    'direct',
                    false,
                    { signer: cleanOperator, offboardOverride: true }
                );
                if (!txRes) {
                    throw new Error('Failed to transfer offboarding balance to recipient');
                }
            } else {
                throw new Error('Positive balance requires either donating to Commons or gifting to a member');
            }
        } else if (shownBalance < 0) {
            if (resolution !== 'write_off_commons') {
                throw new Error('Negative balance must be formally written off against Commons');
            }
            // Handled inside adminPruneUser below via payFromCommons(..., allowDeficit: true)
        }

        // Execute the formal prune path (scrubs roles, channels, cancels posts, sets status pruned)
        adminPruneUser(cleanPub, cleanOperator);

        // Purge device push tokens to prevent leaked notifications
        try {
            db.prepare('DELETE FROM push_tokens WHERE public_key = ?').run(cleanPub);
        } catch {
            // Non-blocking
        }

        // Full audit record in system_logs
        const nowIso = new Date().toISOString();
        db.prepare(`
            INSERT INTO system_logs (timestamp, level, category, message, metadata)
            VALUES (?, 'INFO', 'ADMIN', ?, ?)
        `).run(
            nowIso,
            `Member ${member.callsign} (${cleanPub.slice(0, 10)}...) offboarded with resolution '${resolution}' (settled balance: ${balance}) by operator ${cleanOperator}`,
            JSON.stringify({
                memberPubkey: cleanPub,
                callsign: member.callsign,
                operatorPubkey: cleanOperator,
                resolution,
                balanceSettled: balance,
                giftRecipient: options.giftRecipientPubkey || null,
            })
        );
    });

    if (idempotentResult) {
        return idempotentResult;
    }

    logger.info('ADMIN', `[Offboard] Offboarded member ${member.callsign} (${cleanPub}) with resolution ${resolution}`);

    return {
        success: true,
        memberPubkey: cleanPub,
        callsign: member.callsign,
        resolution,
        balanceSettled,
    };
}

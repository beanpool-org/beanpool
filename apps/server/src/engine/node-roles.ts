import { db } from '../db/db.js';
import { getMember } from '@beanpool/engine';

export type MemberNodeRole = 'owner' | 'admin' | 'moderator';
export type NodeRole = MemberNodeRole;

export interface NodeRoleRecord {
    member_pubkey: string;
    role: MemberNodeRole;
    granted_at: string;
    granted_by: string | null;
    session_epoch?: number;
    has_break_glass?: boolean;
    callsign?: string;
}

/**
 * Returns the primary node role of a member, or null if they hold none.
 * A member holds at most one role. Pruned members hold no node role.
 */
export function nodeRoleOf(pubkey: string): NodeRole | null {
    if (!pubkey) return null;
    const row = db.prepare(
        `SELECT nr.role FROM node_roles nr
         JOIN members m ON nr.member_pubkey = m.public_key
         WHERE nr.member_pubkey = ? AND m.status = 'active'`
    ).get(pubkey) as { role: NodeRole } | undefined;
    return row?.role || null;
}

/**
 * Returns whether the given pubkey is an explicit node owner.
 */
export function isNodeOwner(pubkey: string): boolean {
    if (!pubkey) return false;
    const row = db.prepare(
        `SELECT 1 FROM node_roles nr
         JOIN members m ON nr.member_pubkey = m.public_key
         WHERE nr.member_pubkey = ? AND nr.role = 'owner' AND m.status = 'active'`
    ).get(pubkey);
    return !!row;
}

/**
 * Returns whether the given pubkey has node administrative authority.
 * By default (`includeOwner = true`), owners have full admin authority.
 */
export function isNodeAdmin(pubkey: string, includeOwner: boolean = true): boolean {
    if (!pubkey) return false;
    if (includeOwner) {
        const row = db.prepare(
            `SELECT 1 FROM node_roles nr
             JOIN members m ON nr.member_pubkey = m.public_key
             WHERE nr.member_pubkey = ? AND (nr.role = 'admin' OR nr.role = 'owner') AND m.status = 'active'`
        ).get(pubkey);
        return !!row;
    }
    const row = db.prepare(
        `SELECT 1 FROM node_roles nr
         JOIN members m ON nr.member_pubkey = m.public_key
         WHERE nr.member_pubkey = ? AND nr.role = 'admin' AND m.status = 'active'`
    ).get(pubkey);
    return !!row;
}

/**
 * Returns the public key of the first node owner or admin, or '' if none exist.
 * Used for attribution on legacy/anonymous routes (e.g. admin inbox) where no caller key is provided.
 */
export function getFirstNodeAdminPubkey(): string {
    const row = db.prepare(
        `SELECT nr.member_pubkey FROM node_roles nr
         JOIN members m ON nr.member_pubkey = m.public_key
         WHERE m.status = 'active'
         ORDER BY (nr.role = 'owner') DESC, nr.rowid ASC LIMIT 1`
    ).get() as { member_pubkey: string } | undefined;
    return row ? row.member_pubkey : '';
}

/**
 * Lists all active node role assignments with member callsign.
 */
export function listNodeRoles(): NodeRoleRecord[] {
    const rows = db.prepare(
        `SELECT nr.member_pubkey, nr.role, nr.granted_at, nr.granted_by, nr.session_epoch,
                (nr.break_glass_hash IS NOT NULL) as has_break_glass, m.callsign
         FROM node_roles nr
         JOIN members m ON nr.member_pubkey = m.public_key
         WHERE m.status = 'active'
         ORDER BY (nr.role = 'owner') DESC, nr.granted_at ASC`
    ).all() as any[];
    return rows.map(r => ({
        ...r,
        has_break_glass: Boolean(r.has_break_glass),
    })) as NodeRoleRecord[];
}

/**
 * Grants a node role ('owner' or 'admin') to a member.
 * Each member holds at most ONE node role.
 *
 * Enforces:
 * - Target member must exist in members table and be active
 * - SYSTEM placeholder account can NEVER hold a node role
 * - A treasury (is_treasury=1) can NEVER hold a node role
 * - Only an owner may grant 'owner' (unless bootstrapping on a node with 0 owners)
 * - Only an owner may grant 'admin'
 * - Demoting the last owner to admin is blocked
 */
export function grantNodeRole(targetPubkey: string, role: NodeRole, actorPubkey?: string): void {
    if (role !== 'owner' && role !== 'admin' && role !== 'moderator') {
        throw new Error("Role must be 'owner', 'admin', or 'moderator'");
    }

    if (targetPubkey === 'SYSTEM' || targetPubkey.toUpperCase() === 'SYSTEM') {
        throw new Error('SYSTEM placeholder account cannot hold a node role');
    }

    const member = getMember(db, targetPubkey);
    if (!member) {
        throw new Error('Member not found');
    }

    if (member.callsign?.toUpperCase() === 'SYSTEM') {
        throw new Error('SYSTEM placeholder account cannot hold a node role');
    }

    if (member.isTreasury) {
        throw new Error('Treasury accounts cannot hold a node role');
    }

    if (member.status === 'pruned') {
        throw new Error('Pruned accounts cannot hold a node role');
    }

    if (member.status !== 'active') {
        throw new Error('Only active accounts can hold a node role');
    }

    db.transaction(() => {
        const ownerCount = (db.prepare(
            `SELECT COUNT(*) as c FROM node_roles nr
             JOIN members m ON nr.member_pubkey = m.public_key
             WHERE nr.role = 'owner' AND m.status = 'active'`
        ).get() as any)?.c || 0;

        const isOwner =
            actorPubkey === 'owner:password' ||
            actorPubkey === 'break-glass:enrolment' ||
            actorPubkey === 'SYSTEM' ||
            (!!actorPubkey && isNodeOwner(actorPubkey));

        if (role === 'owner') {
            if (ownerCount > 0 && !isOwner) {
                throw new Error('Only an owner may grant the owner role');
            }
        } else if (role === 'admin' || role === 'moderator') {
            if (!isOwner) {
                throw new Error(`Only an owner may grant the ${role} role`);
            }
            if (isNodeOwner(targetPubkey) && ownerCount <= 1) {
                throw new Error('Cannot remove the last owner');
            }
        }

        const existing = db.prepare("SELECT session_epoch, break_glass_hash FROM node_roles WHERE member_pubkey = ?").get(targetPubkey) as { session_epoch: number; break_glass_hash: string | null } | undefined;
        const epoch = existing?.session_epoch || 0;
        const breakGlass = existing?.break_glass_hash || null;

        db.prepare("DELETE FROM node_roles WHERE member_pubkey = ?").run(targetPubkey);
        db.prepare(
            `INSERT INTO node_roles (member_pubkey, role, granted_at, granted_by, session_epoch, break_glass_hash)
             VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?, ?)`
        ).run(targetPubkey, role, actorPubkey || null, epoch, breakGlass);
    })();
}

/**
 * Revokes a node role ('owner', 'admin', or 'moderator') from a member.
 *
 * Enforces:
 * - Only an owner may revoke 'owner'
 * - Never allow the last owner to be removed
 * - Only an owner may revoke 'admin' or 'moderator'
 */
export function revokeNodeRole(targetPubkey: string, role: NodeRole, actorPubkey?: string): void {
    if (role !== 'owner' && role !== 'admin' && role !== 'moderator') {
        throw new Error("Role must be 'owner', 'admin', or 'moderator'");
    }

    db.transaction(() => {
        const isOwner = actorPubkey === 'owner:password' || (!!actorPubkey && isNodeOwner(actorPubkey));

        if (role === 'owner') {
            if (!isOwner) {
                throw new Error('Only an owner may revoke the owner role');
            }
            if (!isNodeOwner(targetPubkey)) {
                return;
            }

            const ownerCount = (db.prepare(
                `SELECT COUNT(*) as c FROM node_roles nr
                 JOIN members m ON nr.member_pubkey = m.public_key
                 WHERE nr.role = 'owner' AND m.status = 'active'`
            ).get() as any)?.c || 0;
            if (ownerCount <= 1) {
                throw new Error('Cannot remove the last owner');
            }
        } else if (role === 'admin' || role === 'moderator') {
            if (!isOwner) {
                throw new Error(`Only an owner may revoke the ${role} role`);
            }
        }

        db.prepare("DELETE FROM node_roles WHERE member_pubkey = ? AND role = ?").run(targetPubkey, role);
    })();
}

/**
 * Returns the current session_epoch for a member holding a node role, or 0.
 */
export function getNodeRoleSessionEpoch(pubkey: string): number {
    if (!pubkey) return 0;
    const row = db.prepare("SELECT session_epoch FROM node_roles WHERE member_pubkey = ?").get(pubkey) as { session_epoch: number } | undefined;
    return row?.session_epoch ?? 0;
}

/**
 * Increments the session_epoch for a member holding a node role.
 * Invalidates all outstanding browser sessions for this member.
 * Returns the new epoch number.
 */
export function bumpNodeRoleSessionEpoch(pubkey: string): number {
    if (!pubkey) return 0;
    db.prepare("UPDATE node_roles SET session_epoch = session_epoch + 1 WHERE member_pubkey = ?").run(pubkey);
    return getNodeRoleSessionEpoch(pubkey);
}

/**
 * Sets or clears the break_glass_hash for an owner in node_roles.
 */
export function setNodeRoleBreakGlassHash(pubkey: string, hash: string | null): void {
    if (!pubkey) return;
    db.prepare("UPDATE node_roles SET break_glass_hash = ? WHERE member_pubkey = ?").run(hash, pubkey);
}

/**
 * Returns the stored break_glass_hash for an owner, or null.
 */
export function getNodeRoleBreakGlassHash(pubkey: string): string | null {
    if (!pubkey) return null;
    const row = db.prepare("SELECT break_glass_hash FROM node_roles WHERE member_pubkey = ?").get(pubkey) as { break_glass_hash: string | null } | undefined;
    return row?.break_glass_hash || null;
}

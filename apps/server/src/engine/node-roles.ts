import { db } from '../db/db.js';
import { getMember } from '@beanpool/engine';

export type MemberNodeRole = 'owner' | 'admin';
export type NodeRole = MemberNodeRole;

export interface NodeRoleRecord {
    member_pubkey: string;
    role: MemberNodeRole;
    granted_at: string;
    granted_by: string | null;
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
    return db.prepare(
        `SELECT nr.member_pubkey, nr.role, nr.granted_at, nr.granted_by, m.callsign
         FROM node_roles nr
         JOIN members m ON nr.member_pubkey = m.public_key
         WHERE m.status = 'active'
         ORDER BY (nr.role = 'owner') DESC, nr.granted_at ASC`
    ).all() as NodeRoleRecord[];
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
    if (role !== 'owner' && role !== 'admin') {
        throw new Error("Role must be 'owner' or 'admin'");
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

        const isOwner = actorPubkey === 'owner:password' || (!!actorPubkey && isNodeOwner(actorPubkey));

        if (role === 'owner') {
            if (ownerCount > 0 && !isOwner) {
                throw new Error('Only an owner may grant the owner role');
            }
        } else if (role === 'admin') {
            if (!isOwner) {
                throw new Error('Only an owner may grant the admin role');
            }
            if (isNodeOwner(targetPubkey) && ownerCount <= 1) {
                throw new Error('Cannot remove the last owner');
            }
        }

        db.prepare("DELETE FROM node_roles WHERE member_pubkey = ?").run(targetPubkey);
        db.prepare(
            `INSERT INTO node_roles (member_pubkey, role, granted_at, granted_by)
             VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)`
        ).run(targetPubkey, role, actorPubkey || null);
    })();
}

/**
 * Revokes a node role ('owner' or 'admin') from a member.
 *
 * Enforces:
 * - Only an owner may revoke 'owner'
 * - Never allow the last owner to be removed
 * - Only an owner may revoke 'admin'
 */
export function revokeNodeRole(targetPubkey: string, role: NodeRole, actorPubkey?: string): void {
    if (role !== 'owner' && role !== 'admin') {
        throw new Error("Role must be 'owner' or 'admin'");
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
        } else if (role === 'admin') {
            if (!isOwner) {
                throw new Error('Only an owner may revoke the admin role');
            }
        }

        db.prepare("DELETE FROM node_roles WHERE member_pubkey = ? AND role = ?").run(targetPubkey, role);
    })();
}

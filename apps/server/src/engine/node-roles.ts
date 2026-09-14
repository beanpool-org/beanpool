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
 * If a member somehow holds both 'owner' and 'admin', 'owner' takes precedence.
 */
export function nodeRoleOf(pubkey: string): NodeRole | null {
    if (!pubkey) return null;
    const row = db.prepare(
        "SELECT role FROM node_roles WHERE member_pubkey = ? ORDER BY (role = 'owner') DESC LIMIT 1"
    ).get(pubkey) as { role: NodeRole } | undefined;
    return row?.role || null;
}

/**
 * Returns whether the given pubkey is an explicit node owner.
 */
export function isNodeOwner(pubkey: string): boolean {
    if (!pubkey) return false;
    const row = db.prepare(
        "SELECT 1 FROM node_roles WHERE member_pubkey = ? AND role = 'owner'"
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
            "SELECT 1 FROM node_roles WHERE member_pubkey = ? AND (role = 'admin' OR role = 'owner')"
        ).get(pubkey);
        return !!row;
    }
    const row = db.prepare(
        "SELECT 1 FROM node_roles WHERE member_pubkey = ? AND role = 'admin'"
    ).get(pubkey);
    return !!row;
}

/**
 * Returns the public key of the first node owner or admin, or '' if none exist.
 * Used for attribution on legacy/anonymous routes (e.g. admin inbox) where no caller key is provided.
 */
export function getFirstNodeAdminPubkey(): string {
    const row = db.prepare(
        "SELECT member_pubkey FROM node_roles ORDER BY (role = 'owner') DESC, rowid ASC LIMIT 1"
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
         LEFT JOIN members m ON nr.member_pubkey = m.public_key
         ORDER BY (nr.role = 'owner') DESC, nr.granted_at ASC`
    ).all() as NodeRoleRecord[];
}

/**
 * Grants a node role ('owner' or 'admin') to a member.
 *
 * Enforces:
 * - Target member must exist in members table
 * - A treasury (is_treasury=1) can NEVER hold a node role
 * - Only an owner may grant 'owner' (unless bootstrapping on a node with 0 owners)
 * - Only an owner may grant 'admin'
 */
export function grantNodeRole(targetPubkey: string, role: NodeRole, actorPubkey?: string): void {
    if (role !== 'owner' && role !== 'admin') {
        throw new Error("Role must be 'owner' or 'admin'");
    }

    const member = getMember(db, targetPubkey);
    if (!member) {
        throw new Error('Member not found');
    }

    if (member.isTreasury) {
        throw new Error('Treasury accounts cannot hold a node role');
    }

    const ownerCount = (db.prepare("SELECT COUNT(*) as c FROM node_roles WHERE role = 'owner'").get() as any)?.c || 0;

    if (role === 'owner') {
        if (ownerCount > 0 && (!actorPubkey || !isNodeOwner(actorPubkey))) {
            throw new Error('Only an owner may grant the owner role');
        }
    } else if (role === 'admin') {
        if (!actorPubkey || !isNodeOwner(actorPubkey)) {
            throw new Error('Only an owner may grant the admin role');
        }
    }

    db.prepare(
        `INSERT INTO node_roles (member_pubkey, role, granted_at, granted_by)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)
         ON CONFLICT(member_pubkey, role) DO UPDATE SET
             granted_at = excluded.granted_at,
             granted_by = excluded.granted_by`
    ).run(targetPubkey, role, actorPubkey || null);
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
        if (role === 'owner') {
            if (!actorPubkey || !isNodeOwner(actorPubkey)) {
                throw new Error('Only an owner may revoke the owner role');
            }
            if (!isNodeOwner(targetPubkey)) {
                return;
            }

            const ownerCount = (db.prepare(
                `SELECT COUNT(*) as c FROM node_roles nr
                 JOIN members m ON nr.member_pubkey = m.public_key
                 WHERE nr.role = 'owner' AND m.status != 'pruned'`
            ).get() as any)?.c || 0;
            if (ownerCount <= 1) {
                throw new Error('Cannot remove the last owner');
            }
        } else if (role === 'admin') {
            if (!actorPubkey || !isNodeOwner(actorPubkey)) {
                throw new Error('Only an owner may revoke the admin role');
            }
        }

        db.prepare("DELETE FROM node_roles WHERE member_pubkey = ? AND role = ?").run(targetPubkey, role);
    })();
}

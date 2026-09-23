import { db } from '../db/db.js';
import { getMember } from '@beanpool/engine';
import { noteTakeoverInputsChanged } from '../services/takeover-signal.js';

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
 * Whether this node has an owner AT ALL — the one question the owner-bootstrap branch of
 * `grantNodeRole` asks. An owner role parked in `suspended_node_roles` counts: a community that
 * suspended its owner still HAS one. The role is held aside, it comes back the moment the
 * suspension lifts, and the member is still there. Genuinely ownerless means a node that never had
 * an owner, or whose owners were all removed outright (#1006).
 *
 * THE INVARIANT THIS RELIES ON: a parked row exists only while the member it names is still here and
 * still able to come back. Every path that takes them away for good deletes it — `adminPruneUser`,
 * `purgeMemberSelf` (which a suspended member CAN still reach: the signing middleware does not check
 * `members.status`), and the Decision machinery that settles a suspension one way or the other
 * (`restoreSuspendedNodeRole`, `liftEmergencySuspensionRow`, keeping the suspension). Break that and
 * this function reports an owner a node does not have, with no way to clear it.
 *
 * Revoking a role is deliberately NOT one of those paths: a suspended member's role is not in
 * `node_roles` for `revokeNodeRole` to reach, and it must not be — the community may yet lift the
 * suspension and get it back. Revocation only ever clears an ACTIVE owner, who has no parked row.
 *
 * NOT the "is this the last owner?" question. Every guard that stops a node losing its last USABLE
 * owner — demotion and revocation below, `adminPruneUser`, `purgeMemberSelf`, `isSoleOwner` — goes
 * on counting ACTIVE owners only, and so does who can open a sealed backup
 * (`services/takeover-envelope.ts`). A suspended owner cannot sign anything, so treating them as the
 * one owner still standing would let the last signing owner walk away and strand the node.
 */
export function nodeHasOwner(): boolean {
    const row = db.prepare(
        `SELECT 1 FROM node_roles nr
         JOIN members m ON nr.member_pubkey = m.public_key
         WHERE nr.role = 'owner' AND m.status = 'active'
         UNION ALL
         SELECT 1 FROM suspended_node_roles WHERE role = 'owner'
         LIMIT 1`
    ).get();
    return !!row;
}

/**
 * Grants a node role ('owner', 'admin' or 'moderator') to a member.
 * Each member holds at most ONE node role.
 *
 * Enforces:
 * - Target member must exist in members table and be active
 * - SYSTEM placeholder account can NEVER hold a node role
 * - A treasury (is_treasury=1) can NEVER hold a node role
 * - Only an owner may grant 'owner' (unless bootstrapping a node that has no owner at all — see nodeHasOwner)
 * - Only an owner may grant 'admin'
 * - An ADMIN may grant 'moderator', but only to someone who holds no role or is already a
 *   moderator (see below). Owners may grant it to anyone the other rules allow.
 * - Demoting the last owner to admin is blocked
 *
 * WHY THE ADMIN RULE KEYS OFF THE TARGET'S CURRENT ROLE, NOT THE REQUESTED ONE:
 * member_pubkey is the PRIMARY KEY and this function DELETEs the existing row before inserting,
 * so "grant moderator" is also a DEMOTION primitive. A rule of merely "an admin may grant
 * moderator" would let an admin strip any owner (whenever 2+ owners exist, so the last-owner
 * guard never fires) or any fellow admin, by "promoting" them to moderator. The guard below
 * therefore reads the target's CURRENT role from the same transaction and refuses unless it is
 * null or 'moderator'.
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

        // Read inside the transaction, BEFORE the guard: the admin rule below depends on it.
        const existing = db.prepare("SELECT role, session_epoch, break_glass_hash FROM node_roles WHERE member_pubkey = ?").get(targetPubkey) as { role: string; session_epoch: number; break_glass_hash: string | null } | undefined;
        const currentRole = existing?.role ?? null;

        if (role === 'owner') {
            if (!isOwner) {
                if (ownerCount > 0) {
                    throw new Error('Only an owner may grant the owner role');
                }
                // No ACTIVE owner. That is the bootstrap case — a fresh node whose first owner has to
                // come from somewhere — but ONLY if the node has no owner at all. A community Decision
                // that suspends the sole owner parks their role, which used to read as zero owners and
                // let any admin key session make itself owner (#1006). `isOwner` above is already true
                // for 'owner:password', so the operator's password remains the way out of this: the
                // node is never stranded.
                if (nodeHasOwner()) {
                    const err: any = new Error("This node has an owner (currently suspended). Ask the community, or use the node's admin password.");
                    err.status = 403;
                    throw err;
                }
            }
        } else if (role === 'admin') {
            if (!isOwner) {
                throw new Error('Only an owner may grant the admin role');
            }
            if (isNodeOwner(targetPubkey) && ownerCount <= 1) {
                throw new Error('Cannot remove the last owner');
            }
        } else if (role === 'moderator') {
            // An admin may appoint a moderator without troubling an owner. They may NOT use this
            // to demote anyone: the target must currently hold no role, or already be a moderator.
            const actorIsAdmin = !!actorPubkey && isNodeAdmin(actorPubkey, false);
            if (!isOwner && !actorIsAdmin) {
                throw new Error('Only an owner or an admin may grant the moderator role');
            }
            if (!isOwner && currentRole !== null && currentRole !== 'moderator') {
                throw new Error(`Only an owner may change the role of an existing ${currentRole}`);
            }
            if (isNodeOwner(targetPubkey) && ownerCount <= 1) {
                throw new Error('Cannot remove the last owner');
            }
        }
        const epoch = existing ? (existing.role !== role ? existing.session_epoch + 1 : existing.session_epoch) : 0;
        const breakGlass = role === 'owner' ? (existing?.break_glass_hash || null) : null;

        db.prepare("DELETE FROM node_roles WHERE member_pubkey = ?").run(targetPubkey);
        db.prepare(
            `INSERT INTO node_roles (member_pubkey, role, granted_at, granted_by, session_epoch, break_glass_hash)
             VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?, ?)`
        ).run(targetPubkey, role, actorPubkey || null, epoch, breakGlass);
    })();
    noteTakeoverInputsChanged(`${role} role granted`);
}

/**
 * Revokes a node role ('owner', 'admin', or 'moderator') from a member.
 *
 * Enforces:
 * - Only an owner may revoke 'owner'
 * - Never allow the last owner to be removed
 * - Only an owner may revoke 'admin'
 * - An owner OR an admin may revoke 'moderator' — including a moderator an OWNER appointed
 *   (Marty, 2026-09-20: one uniform rule, "if you can appoint you can un-appoint"; the
 *   granted_by-based variant was rejected because a list where some moderators are removable
 *   and some are not needs explaining). An owner can always re-appoint, and can revoke the admin.
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
        } else if (role === 'admin') {
            if (!isOwner) {
                throw new Error('Only an owner may revoke the admin role');
            }
        } else if (role === 'moderator') {
            const actorIsAdmin = !!actorPubkey && isNodeAdmin(actorPubkey, false);
            if (!isOwner && !actorIsAdmin) {
                throw new Error('Only an owner or an admin may revoke the moderator role');
            }
        }

        db.prepare("DELETE FROM node_roles WHERE member_pubkey = ? AND role = ?").run(targetPubkey, role);
    })();
    noteTakeoverInputsChanged(`${role} role revoked`);
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
    noteTakeoverInputsChanged('owner sessions reset');
    return getNodeRoleSessionEpoch(pubkey);
}

/**
 * Sets or clears the break_glass_hash for an owner in node_roles.
 */
export function setNodeRoleBreakGlassHash(pubkey: string, hash: string | null): void {
    if (!pubkey) return;
    db.prepare("UPDATE node_roles SET break_glass_hash = ? WHERE member_pubkey = ?").run(hash, pubkey);
    noteTakeoverInputsChanged('break-glass code changed');
}

/**
 * Returns the stored break_glass_hash for an owner, or null.
 */
export function getNodeRoleBreakGlassHash(pubkey: string): string | null {
    if (!pubkey) return null;
    const row = db.prepare("SELECT break_glass_hash FROM node_roles WHERE member_pubkey = ?").get(pubkey) as { break_glass_hash: string | null } | undefined;
    return row?.break_glass_hash || null;
}

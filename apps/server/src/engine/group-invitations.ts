// Who has been invited to a group and has not joined yet, and who said no — as a member of the group may read it
// ("Invitations should show whether they have been used", Rob, 11 Nov 2026).
//
// An invitation is between the member who made it and the person it names. The group is not told, so this module is the
// boundary: GET /api/groups/:id/invitations answers each viewer ONLY what they may see, and the apps draw what they are given.
//
//   - A convenor whose powers are not resting (a suspended convenor is any other member, as the roster has it) sees every
//     pending invitation, and who made each.
//   - Any other ACTIVE member sees the pending invitations they made, and no one else's.
//   - Someone who is not an active member of the group (an invitee, someone who asked to join, a stranger) sees none, and
//     is refused: `null` here, a 403 from the route.
//   - A declined invitation (group_invite_declines) is shown ONLY to the member who made it, "Declined" and dated, for
//     DECLINE_KEPT_DAYS. Never to the group, its convenors (unless they made it) or the person who declined.
//   - A person who joins leaves the pending list with the invitation (the row is 'active'); one withdrawn has no row left.
//   - A group its members closed takes nobody new, so it has nothing to show.
//
// The write side: removeGroupMember (packages/beanpool-engine) deletes a declined invitation's row, so the server's
// removeGroupMember (state-engine.ts) calls recordInviteDecline in the same transaction; a new invitation, a join and a
// leave clear the note (clearInviteDecline), and a read also leaves out one the person has since been admitted past.

import { avatarUrlOf } from '@beanpool/core';
import { isActingGroupConvenor, isGroupMember } from '@beanpool/engine';
import { db } from '../db/db.js';

/** How long the member who made an invitation still sees that it was declined. */
export const DECLINE_KEPT_DAYS = 30;
/** The most rows of each list one read carries; `pendingTotal` says how many there are. */
export const INVITATIONS_SHOWN = 200;

export interface PendingInvitation {
    memberPubkey: string;
    callsign?: string;
    avatarUrl?: string;
    /** When the invitation was made. */
    invitedAt: string | null;
    /** Who made it: in a convenor's view only (a member's own view is all their own). */
    invitedBy?: { pubkey: string; callsign?: string };
}

export interface DeclinedInvitation {
    memberPubkey: string;
    callsign?: string;
    avatarUrl?: string;
    invitedAt: string | null;
    declinedAt: string;
}

export interface GroupInvitations {
    /** 'convenor': every pending invitation. 'sender': the viewer's own. */
    view: 'convenor' | 'sender';
    /** Newest first, at most INVITATIONS_SHOWN. */
    pending: PendingInvitation[];
    pendingTotal: number;
    /** The viewer's own, newest first: other people's are never here. */
    declined: DeclinedInvitation[];
}

const NONE: Pick<GroupInvitations, 'pending' | 'pendingTotal' | 'declined'> = { pending: [], pendingTotal: 0, declined: [] };

function declineCutoff(now = Date.now()): string {
    return new Date(now - DECLINE_KEPT_DAYS * 86400_000).toISOString();
}

/**
 * Remembers that `inviteePubkey` declined the invitation `invitedBy` made, for `invitedBy` to read. Called in the
 * transaction that deletes the invitation's row. Nothing to remember for a row with no one who made it. Also drops this
 * group's notes that have outlived DECLINE_KEPT_DAYS, so the table never grows past what a month of declines makes.
 */
export function recordInviteDecline(groupId: string, inviteePubkey: string, invitedBy: string | null | undefined, invitedAt: string | null | undefined, at: string): void {
    db.prepare('DELETE FROM group_invite_declines WHERE group_id = ? AND declined_at < ?').run(groupId, declineCutoff(Date.parse(at) || Date.now()));
    if (!invitedBy || invitedBy === inviteePubkey) return;
    db.prepare(`INSERT INTO group_invite_declines (group_id, invitee_pubkey, invited_by, invited_at, declined_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(group_id, invitee_pubkey) DO UPDATE SET invited_by = excluded.invited_by, invited_at = excluded.invited_at, declined_at = excluded.declined_at`)
        .run(groupId, inviteePubkey, invitedBy, invitedAt ?? null, at);
}

/** The person is invited again, joins, or leaves: an earlier "Declined" is no longer the state of things. */
export function clearInviteDecline(groupId: string, inviteePubkey: string): void {
    db.prepare('DELETE FROM group_invite_declines WHERE group_id = ? AND invitee_pubkey = ?').run(groupId, inviteePubkey);
}

interface PendingRow { member_pubkey: string; joined_at: string | null; invited_by: string | null; callsign: string | null; avatar_ref: string | null; inviter_callsign: string | null }
interface DeclinedRow { invitee_pubkey: string; invited_at: string | null; declined_at: string; callsign: string | null; avatar_ref: string | null }

/**
 * What `viewer` may read of `groupId`'s invitations, or null when they may read none (not an active member of it). The
 * route turns null into a refusal; it has already answered an invite-only group the viewer has no live row in as not found.
 */
export function groupInvitationsFor(groupId: string, viewer: string, now = Date.now()): GroupInvitations | null {
    if (!viewer || !isGroupMember(db, groupId, viewer)) return null;
    const view: GroupInvitations['view'] = isActingGroupConvenor(db, groupId, viewer) ? 'convenor' : 'sender';
    if (db.prepare('SELECT 1 FROM group_closures WHERE group_id = ?').get(groupId)) return { view, ...NONE };

    // A convenor's read is the whole group's; anyone else's is filtered by who made the invitation, in the query itself.
    const scope = view === 'convenor' ? '' : 'AND gm.invited_by = @viewer';
    const live = `gm.group_id = @group AND gm.status = 'invited' AND m.status != 'pruned' ${scope}`;
    const pendingRows = db.prepare(`
        SELECT gm.member_pubkey, gm.joined_at, gm.invited_by, m.callsign, m.avatar_ref, i.callsign AS inviter_callsign
        FROM group_members gm
        JOIN members m ON m.public_key = gm.member_pubkey
        LEFT JOIN members i ON i.public_key = gm.invited_by
        WHERE ${live}
        ORDER BY gm.joined_at DESC, gm.member_pubkey
        LIMIT @limit
    `).all({ group: groupId, viewer, limit: INVITATIONS_SHOWN }) as PendingRow[];
    const pendingTotal = (db.prepare(`
        SELECT COUNT(*) AS c FROM group_members gm JOIN members m ON m.public_key = gm.member_pubkey WHERE ${live}
    `).get({ group: groupId, viewer }) as { c: number }).c;

    // Declined: the viewer's own, always — a convenor's other people's are not theirs to read.
    const declinedRows = db.prepare(`
        SELECT d.invitee_pubkey, d.invited_at, d.declined_at, m.callsign, m.avatar_ref
        FROM group_invite_declines d
        JOIN members m ON m.public_key = d.invitee_pubkey
        WHERE d.group_id = @group AND d.invited_by = @viewer AND d.declined_at >= @since AND m.status != 'pruned'
          AND NOT EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = d.group_id AND gm.member_pubkey = d.invitee_pubkey
                          AND gm.status IN ('invited', 'active', 'pending_approval'))
        ORDER BY d.declined_at DESC, d.invitee_pubkey
        LIMIT @limit
    `).all({ group: groupId, viewer, since: declineCutoff(now), limit: INVITATIONS_SHOWN }) as DeclinedRow[];

    return {
        view,
        pending: pendingRows.map(r => ({
            memberPubkey: r.member_pubkey,
            callsign: r.callsign || undefined,
            avatarUrl: avatarUrlOf(r.member_pubkey, r.avatar_ref) ?? undefined,
            invitedAt: r.joined_at,
            ...(view === 'convenor' && r.invited_by ? { invitedBy: { pubkey: r.invited_by, callsign: r.inviter_callsign || undefined } } : {}),
        })),
        pendingTotal,
        declined: declinedRows.map(r => ({
            memberPubkey: r.invitee_pubkey,
            callsign: r.callsign || undefined,
            avatarUrl: avatarUrlOf(r.invitee_pubkey, r.avatar_ref) ?? undefined,
            invitedAt: r.invited_at,
            declinedAt: r.declined_at,
        })),
    };
}

// A member's open invitations to groups (tester report 24 Oct, item 6: an invite showed only as an INVITED badge deep in
// Commons → "Groups you could join", with no push, no count and no line in Needs you).
//
// One read for the two places that say a member has been invited: Home's Needs-you line (routes/home-answer.ts, for an
// app that says it opens the invite landing with `lands=invite`) and GET /api/your-groups, from which the phone's header
// builds the same line when it reads the node itself (apps/native utils/needs-you.ts). The member's own rows only: an
// invitation is between the convenor who made it and the member it names, and no one else's appears here.
//
// What counts is what the member can answer now: a group_members row 'invited' (accepting it is a join, engine
// groups.ts joinGroup), in a group its members have not closed by a vote (a closed group takes nobody new). None while
// the member's own account is suspended: joinGroup refuses them until it ends, so a line would ask what they can't do.
// An invitation accepted, declined (the member leaves the row) or withdrawn (a convenor removes it) has no row left
// 'invited', so its line goes with it.

import { isSuspendedAccount } from '@beanpool/engine';
import { db } from '../db/db.js';

export interface PendingGroupInvite {
    groupId: string;
    name: string;
    category: string | null;
    joinPolicy: string | null;
    /** When the invitation was made (group_members.joined_at holds that while the row is an invitation). */
    invitedAt: string | null;
}

/** The member's open invitations, newest first. */
export function pendingGroupInvites(memberPubkey: string): PendingGroupInvite[] {
    if (isSuspendedAccount(db, memberPubkey)) return [];
    const rows = db.prepare(`
        SELECT g.id, g.name, g.category, g.join_policy, gm.joined_at
        FROM group_members gm JOIN groups g ON g.id = gm.group_id
        WHERE gm.member_pubkey = ? AND gm.status = 'invited'
          AND NOT EXISTS (SELECT 1 FROM group_closures gc WHERE gc.group_id = g.id)
        ORDER BY gm.joined_at DESC, g.id
    `).all(memberPubkey) as { id: string; name: string; category: string | null; join_policy: string | null; joined_at: string | null }[];
    return rows.map(r => ({ groupId: r.id, name: r.name, category: r.category, joinPolicy: r.join_policy, invitedAt: r.joined_at }));
}

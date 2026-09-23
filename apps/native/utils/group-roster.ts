/**
 * What the group roster offers on each row, and what the lead convenor sees (2026-09-23).
 *
 * The rules live in @beanpool/core (groupRowActions) so this screen, the PWA's roster and the engine all say the
 * same thing; the engine is what enforces them. This module is the adapter: it takes the group and its members as
 * the app holds them and hands the screen one object per row, so GroupDetailModal never re-derives a rule and
 * never draws a button the server would refuse.
 */

import {
    groupRowActions,
    groupRoleLabel,
    leadMustHandOverBeforeLeaving,
    type GroupRowActions,
} from '@beanpool/core';
import type { GroupItem, GroupMemberItem } from './db';

export interface RosterRow extends GroupRowActions {
    member: GroupMemberItem;
    /** Draw the "Lead" badge on this row. */
    isLead: boolean;
    isYou: boolean;
    /** "Lead convenor" / "Convenor" / "Member" / "Observer". */
    roleLabel: string;
}

export interface RosterView {
    rows: RosterRow[];
    /** The viewer is the group's lead convenor. */
    viewerIsLead: boolean;
    /** The viewer is an active convenor: they see Convenor Tools. */
    viewerIsConvenor: boolean;
    /** The lead's callsign for Group info, or null when the group has no lead. */
    leadCallsign: string | null;
    leadPubkey: string | null;
    /** Leaving must ask the lead to hand over first. */
    leaveNeedsHandOver: boolean;
    /** Who the lead may hand the lead to, in roster order. */
    handOverCandidates: GroupMemberItem[];
}

/**
 * Which pubkey leads the group. The server sends it; a group from a node older than this change sends neither
 * leadPubkey nor convenorPubkey, and then no row is marked — the rules still hold, because the server enforces
 * them, and nothing is claimed on screen that the app does not know.
 */
export function leadPubkeyOf(group: Pick<GroupItem, 'leadPubkey' | 'convenorPubkey'> | null | undefined): string | null {
    return group?.leadPubkey ?? group?.convenorPubkey ?? null;
}

export function buildRosterView(
    group: GroupItem | null | undefined,
    members: GroupMemberItem[],
    myPubkey?: string,
): RosterView {
    const leadPubkey = leadPubkeyOf(group);
    const activeMembers = members.filter(m => m.status === 'active');
    const mine = members.find(m => m.memberPubkey === myPubkey);
    // The group payload's viewerRole and the roster agree; either is enough, and on a first open only one is there.
    const viewerRole = (mine && mine.status === 'active' ? mine.role : undefined) ?? group?.viewerRole ?? null;
    const viewer = { role: viewerRole, status: 'active' as const, isLead: !!myPubkey && myPubkey === leadPubkey };

    const rows: RosterRow[] = activeMembers.map(m => {
        const isLead = m.memberPubkey === leadPubkey;
        const target = { memberPubkey: m.memberPubkey, role: m.role, status: m.status, isLead };
        return {
            member: m,
            isLead,
            isYou: !!myPubkey && m.memberPubkey === myPubkey,
            roleLabel: groupRoleLabel(m.role, isLead),
            ...groupRowActions(viewer, target, myPubkey),
        };
    });

    const leadRow = activeMembers.find(m => m.memberPubkey === leadPubkey);
    const othersActive = activeMembers.filter(m => m.memberPubkey !== myPubkey).length;

    return {
        rows,
        viewerIsLead: viewer.isLead,
        viewerIsConvenor: viewerRole === 'convenor',
        leadCallsign: leadRow?.callsign ?? group?.leadCallsign ?? group?.convenorCallsign ?? null,
        leadPubkey,
        leaveNeedsHandOver: leadMustHandOverBeforeLeaving(viewer.isLead, othersActive),
        handOverCandidates: rows.filter(r => r.canHandOverLead).map(r => r.member),
    };
}

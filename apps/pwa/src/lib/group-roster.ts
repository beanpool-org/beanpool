/**
 * What the group roster offers on each row, and what the lead convenor sees (2026-09-23).
 *
 * The rules live in @beanpool/core (groupRowActions) so this roster, the native one and the engine all say the
 * same thing; the engine is what enforces them. This module is the adapter: it takes the group and its members as
 * the app holds them and hands the component one object per row, so GroupDetailModal never re-derives a rule and
 * never draws a control the server would refuse.
 */

import {
    groupRowActions,
    groupRoleLabel,
    leadMustHandOverBeforeLeaving,
    leadHandOverBlockedByObservers,
    type GroupRowActions,
} from '@beanpool/core';
import type { Group, GroupMember } from './api';

export interface RosterRow extends GroupRowActions {
    member: GroupMember;
    /** Draw the "Lead" badge on this row. */
    isLead: boolean;
    isYou: boolean;
    /** "Lead convenor" / "Convenor" / "Member" / "Observer". */
    roleLabel: string;
}

export interface RosterView {
    rows: RosterRow[];
    viewerIsLead: boolean;
    viewerIsConvenor: boolean;
    leadCallsign: string | null;
    leadPubkey: string | null;
    /** Leaving must ask the lead to hand over first. */
    leaveNeedsHandOver: boolean;
    /** Who the lead may hand the lead to, in roster order. */
    handOverCandidates: GroupMember[];
    /**
     * The lead has nobody to hand to because everyone else active is an observer. The screens say to make one of
     * them a member first, rather than sending the lead round the hand-over dead end.
     */
    handOverBlockedByObservers: boolean;
}

/**
 * Which pubkey leads the group. The server sends it; a group from a node older than this change sends neither
 * leadPubkey nor convenorPubkey, and then no row is marked — the rules still hold, because the server enforces
 * them, and nothing is claimed on screen that the app does not know.
 */
export function leadPubkeyOf(group: Pick<Group, 'leadPubkey' | 'convenorPubkey'> | null | undefined): string | null {
    return group?.leadPubkey ?? group?.convenorPubkey ?? null;
}

export function buildRosterView(
    group: Group | null | undefined,
    members: GroupMember[],
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
    const handOverCandidates = rows.filter(r => r.canHandOverLead).map(r => r.member);
    const activeObservers = activeMembers.filter(m => m.role === 'observer' && m.memberPubkey !== myPubkey).length;

    return {
        rows,
        viewerIsLead: viewer.isLead,
        viewerIsConvenor: viewerRole === 'convenor',
        leadCallsign: leadRow?.callsign ?? group?.leadCallsign ?? group?.convenorCallsign ?? null,
        leadPubkey,
        leaveNeedsHandOver: leadMustHandOverBeforeLeaving(viewer.isLead, othersActive),
        handOverCandidates,
        handOverBlockedByObservers: viewer.isLead
            && leadHandOverBlockedByObservers(handOverCandidates.length, activeObservers),
    };
}

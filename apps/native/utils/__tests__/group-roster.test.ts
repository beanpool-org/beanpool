/**
 * What the group roster offers on each row (lead convenor, 2026-09-23).
 *
 * GroupDetailModal draws Role, ✕ and "Hand over lead" straight from buildRosterView, so these are the assertions
 * that keep a convenor from being shown an action the server refuses — and keep the lead's row from offering one
 * at all. The rules themselves are @beanpool/core's; this covers the adapter that feeds them the app's own data.
 */

import { describe, it, expect } from 'vitest';
import { buildRosterView, leadPubkeyOf } from '../group-roster';
import type { GroupItem, GroupMemberItem } from '../db';

const LEAD = 'pk-marty';
const CONVENOR = 'pk-damo';
const CONVENOR2 = 'pk-cass';
const MEMBER = 'pk-zed';
const OBSERVER = 'pk-obi';

const member = (pubkey: string, role: GroupMemberItem['role'], over: Partial<GroupMemberItem> = {}): GroupMemberItem => ({
    groupId: 'g1',
    memberPubkey: pubkey,
    callsign: pubkey.replace('pk-', ''),
    role,
    status: 'active',
    joinedAt: '2026-01-01T00:00:00.000Z',
    invitedBy: null,
    ...over,
});

const roster: GroupMemberItem[] = [
    member(LEAD, 'convenor'),
    member(CONVENOR, 'convenor'),
    member(CONVENOR2, 'convenor'),
    member(MEMBER, 'member'),
    member(OBSERVER, 'observer'),
];

const group = (over: Partial<GroupItem> = {}): GroupItem => ({
    id: 'g1',
    name: 'martys group',
    slug: 'martys-group',
    description: null,
    avatarUrl: null,
    category: 'social',
    createdBy: LEAD,
    joinPolicy: 'open',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    leadPubkey: LEAD,
    leadCallsign: 'marty',
    ...over,
});

const rowFor = (view: ReturnType<typeof buildRosterView>, pubkey: string) =>
    view.rows.find(r => r.member.memberPubkey === pubkey)!;

describe('the group roster and its lead convenor', () => {
    it('marks the lead, and only the lead', () => {
        const view = buildRosterView(group(), roster, MEMBER);
        expect(rowFor(view, LEAD).isLead).toBe(true);
        expect(rowFor(view, LEAD).roleLabel).toBe('Lead convenor');
        for (const pk of [CONVENOR, CONVENOR2, MEMBER, OBSERVER]) expect(rowFor(view, pk).isLead).toBe(false);
        expect(rowFor(view, CONVENOR).roleLabel).toBe('Convenor');
        expect(view.leadCallsign).toBe('marty');
    });

    it('shows a convenor no action on the lead, and none on another convenor', () => {
        const view = buildRosterView(group(), roster, CONVENOR);
        expect(view.viewerIsConvenor).toBe(true);
        expect(view.viewerIsLead).toBe(false);
        for (const pk of [LEAD, CONVENOR2]) {
            const row = rowFor(view, pk);
            expect(row.canChangeRole).toBe(false);
            expect(row.canRemove).toBe(false);
            expect(row.canHandOverLead).toBe(false);
        }
        // And every action on members and observers, as before.
        for (const pk of [MEMBER, OBSERVER]) {
            expect(rowFor(view, pk).canChangeRole).toBe(true);
            expect(rowFor(view, pk).canRemove).toBe(true);
        }
        // Their own row offers nothing: leaving is the Leave Group button.
        expect(rowFor(view, CONVENOR).canRemove).toBe(false);
    });

    it('shows the lead every action except on their own row', () => {
        const view = buildRosterView(group(), roster, LEAD);
        expect(view.viewerIsLead).toBe(true);
        for (const pk of [CONVENOR, CONVENOR2, MEMBER, OBSERVER]) {
            expect(rowFor(view, pk).canChangeRole).toBe(true);
            expect(rowFor(view, pk).canRemove).toBe(true);
        }
        const own = rowFor(view, LEAD);
        expect(own.canChangeRole).toBe(false);
        expect(own.canRemove).toBe(false);
        expect(own.canHandOverLead).toBe(false);
    });

    it('offers the lead to convenors and members, never to an observer or to nobody', () => {
        const view = buildRosterView(group(), roster, LEAD);
        expect(view.handOverCandidates.map(c => c.memberPubkey)).toEqual([CONVENOR, CONVENOR2, MEMBER]);
        expect(rowFor(view, OBSERVER).canHandOverLead).toBe(false);
        // A convenor is offered nobody: they cannot hand over a lead they do not hold.
        expect(buildRosterView(group(), roster, CONVENOR).handOverCandidates).toEqual([]);
    });

    it('asks a leaving lead to hand over — unless they are alone in the group', () => {
        expect(buildRosterView(group(), roster, LEAD).leaveNeedsHandOver).toBe(true);
        expect(buildRosterView(group(), [member(LEAD, 'convenor')], LEAD).leaveNeedsHandOver).toBe(false);
        // Nobody else is asked to hand anything over.
        expect(buildRosterView(group(), roster, CONVENOR).leaveNeedsHandOver).toBe(false);
        expect(buildRosterView(group(), roster, MEMBER).leaveNeedsHandOver).toBe(false);
    });

    it('gives a member and an observer no actions at all', () => {
        for (const viewer of [MEMBER, OBSERVER]) {
            const view = buildRosterView(group(), roster, viewer);
            expect(view.viewerIsConvenor).toBe(false);
            expect(view.rows.every(r => !r.canChangeRole && !r.canRemove && !r.canHandOverLead)).toBe(true);
            expect(view.leaveNeedsHandOver).toBe(false);
        }
    });

    it('lists only active members, so a pending request is no roster row', () => {
        const withPending = [...roster, member('pk-asker', 'member', { status: 'pending_approval' })];
        const view = buildRosterView(group(), withPending, LEAD);
        expect(view.rows.map(r => r.member.memberPubkey)).not.toContain('pk-asker');
        expect(view.handOverCandidates.map(c => c.memberPubkey)).not.toContain('pk-asker');
    });

    it('falls back to convenorPubkey, and marks nobody when the server named no lead', () => {
        // A group from a node older than this change: convenorPubkey only.
        expect(leadPubkeyOf({ leadPubkey: null, convenorPubkey: CONVENOR })).toBe(CONVENOR);
        expect(leadPubkeyOf({ leadPubkey: undefined, convenorPubkey: undefined })).toBe(null);
        const unknown = buildRosterView(group({ leadPubkey: null, convenorPubkey: undefined }), roster, CONVENOR);
        expect(unknown.rows.every(r => !r.isLead)).toBe(true);
        expect(unknown.leadPubkey).toBe(null);
        // Nothing is claimed that the app does not know — and the server still enforces the rule.
        expect(unknown.viewerIsLead).toBe(false);
    });

    it('trusts the roster over a stale viewerRole in the group payload', () => {
        // The group card can be cached from before a promotion; the roster row is the fresher fact.
        const promoted = buildRosterView(group({ viewerRole: 'member' }), roster, CONVENOR);
        expect(promoted.viewerIsConvenor).toBe(true);
        expect(rowFor(promoted, MEMBER).canRemove).toBe(true);
    });
});

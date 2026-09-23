/**
 * What the group roster offers on each row (lead convenor, 2026-09-23).
 *
 * GroupDetailModal draws the Role select, ✕ and "Make lead" straight from buildRosterView, so these are the
 * assertions that keep a convenor from being shown a control the server refuses — and keep the lead's row from
 * offering one at all. The rules themselves are @beanpool/core's; this covers the adapter that feeds them the
 * app's own data.
 */

import { describe, it, expect } from 'vitest';
import { buildRosterView, leadPubkeyOf } from './group-roster';
import type { Group, GroupMember } from './api';

const LEAD = 'pk-marty';
const CONVENOR = 'pk-damo';
const CONVENOR2 = 'pk-cass';
const MEMBER = 'pk-zed';
const OBSERVER = 'pk-obi';

const member = (pubkey: string, role: GroupMember['role'], over: Partial<GroupMember> = {}): GroupMember => ({
    groupId: 'g1',
    memberPubkey: pubkey,
    callsign: pubkey.replace('pk-', ''),
    role,
    status: 'active',
    joinedAt: '2026-01-01T00:00:00.000Z',
    ...over,
});

const roster: GroupMember[] = [
    member(LEAD, 'convenor'),
    member(CONVENOR, 'convenor'),
    member(CONVENOR2, 'convenor'),
    member(MEMBER, 'member'),
    member(OBSERVER, 'observer'),
];

const group = (over: Partial<Group> = {}): Group => ({
    id: 'g1',
    name: 'martys group',
    slug: 'martys-group',
    category: 'social',
    createdBy: LEAD,
    joinPolicy: 'open',
    createdAt: '2026-01-01T00:00:00.000Z',
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
        expect(view.leadCallsign).toBe('marty');
    });

    it('shows a convenor no control on the lead, and none on another convenor', () => {
        const view = buildRosterView(group(), roster, CONVENOR);
        expect(view.viewerIsConvenor).toBe(true);
        expect(view.viewerIsLead).toBe(false);
        for (const pk of [LEAD, CONVENOR2]) {
            expect(rowFor(view, pk)).toMatchObject({ canChangeRole: false, canRemove: false, canHandOverLead: false });
        }
        for (const pk of [MEMBER, OBSERVER]) {
            expect(rowFor(view, pk)).toMatchObject({ canChangeRole: true, canRemove: true });
        }
        expect(rowFor(view, CONVENOR).canRemove).toBe(false);
    });

    it('shows the lead every control except on their own row', () => {
        const view = buildRosterView(group(), roster, LEAD);
        expect(view.viewerIsLead).toBe(true);
        for (const pk of [CONVENOR, CONVENOR2, MEMBER, OBSERVER]) {
            expect(rowFor(view, pk)).toMatchObject({ canChangeRole: true, canRemove: true });
        }
        expect(rowFor(view, LEAD)).toMatchObject({ canChangeRole: false, canRemove: false, canHandOverLead: false });
    });

    it('offers the lead to convenors and members, never to an observer', () => {
        const view = buildRosterView(group(), roster, LEAD);
        expect(view.handOverCandidates.map(c => c.memberPubkey)).toEqual([CONVENOR, CONVENOR2, MEMBER]);
        expect(rowFor(view, OBSERVER).canHandOverLead).toBe(false);
        expect(buildRosterView(group(), roster, CONVENOR).handOverCandidates).toEqual([]);
    });

    it('tells a lead whose only company is observers to make one a member first', () => {
        const observersOnly = [member(LEAD, 'convenor'), member(OBSERVER, 'observer'), member('pk-obi2', 'observer')];
        const view = buildRosterView(group(), observersOnly, LEAD);
        // Leaving still needs a hand-over (observers are active people), but there is nobody to hand to: without
        // this flag the error line sends the lead round a dead end.
        expect(view.leaveNeedsHandOver).toBe(true);
        expect(view.handOverCandidates).toEqual([]);
        expect(view.handOverBlockedByObservers).toBe(true);

        // Not a dead end once one of them is a member.
        const promoted = [member(LEAD, 'convenor'), member(OBSERVER, 'member'), member('pk-obi2', 'observer')];
        expect(buildRosterView(group(), promoted, LEAD).handOverBlockedByObservers).toBe(false);
        // A lead alone in the group is not blocked — they may simply leave.
        expect(buildRosterView(group(), [member(LEAD, 'convenor')], LEAD).handOverBlockedByObservers).toBe(false);
        // Nor is anyone who does not hold the lead.
        expect(buildRosterView(group(), observersOnly, OBSERVER).handOverBlockedByObservers).toBe(false);
        // An observer who is not active is nobody to promote, so this is a lead alone, not a dead end.
        const invitedObserver = [member(LEAD, 'convenor'), member(OBSERVER, 'observer', { status: 'invited' })];
        expect(buildRosterView(group(), invitedObserver, LEAD).handOverBlockedByObservers).toBe(false);
    });

    it('asks a leaving lead to hand over — unless they are alone in the group', () => {
        expect(buildRosterView(group(), roster, LEAD).leaveNeedsHandOver).toBe(true);
        expect(buildRosterView(group(), [member(LEAD, 'convenor')], LEAD).leaveNeedsHandOver).toBe(false);
        expect(buildRosterView(group(), roster, CONVENOR).leaveNeedsHandOver).toBe(false);
    });

    it('gives a member and an observer no controls at all', () => {
        for (const viewer of [MEMBER, OBSERVER]) {
            const view = buildRosterView(group(), roster, viewer);
            expect(view.viewerIsConvenor).toBe(false);
            expect(view.rows.every(r => !r.canChangeRole && !r.canRemove && !r.canHandOverLead)).toBe(true);
        }
    });

    it('falls back to convenorPubkey, and marks nobody when the server named no lead', () => {
        expect(leadPubkeyOf({ leadPubkey: null, convenorPubkey: CONVENOR })).toBe(CONVENOR);
        expect(leadPubkeyOf({ leadPubkey: undefined, convenorPubkey: undefined })).toBe(null);
        const unknown = buildRosterView(group({ leadPubkey: null, convenorPubkey: undefined }), roster, CONVENOR);
        expect(unknown.rows.every(r => !r.isLead)).toBe(true);
        expect(unknown.leadPubkey).toBe(null);
        expect(unknown.viewerIsLead).toBe(false);
    });

    it('lists only active members, so a pending request is no roster row', () => {
        const withPending = [...roster, member('pk-asker', 'member', { status: 'pending_approval' })];
        const view = buildRosterView(group(), withPending, LEAD);
        expect(view.rows.map(r => r.member.memberPubkey)).not.toContain('pk-asker');
        expect(view.handOverCandidates.map(c => c.memberPubkey)).not.toContain('pk-asker');
    });
});

/**
 * The roster's row-action predicates for the lead convenor (2026-09-23).
 *
 * These decide whether a row shows Role and ✕, and they must say exactly what the engine enforces
 * (packages/beanpool-engine/src/groups.ts setMemberRole / removeGroupMember). A convenor must never be offered
 * an action the server would refuse, and the lead's row must never offer one at all.
 */

import { describe, it, expect } from 'vitest';
import {
    groupRowActions,
    groupRoleLabel,
    isActiveGroupConvenor,
    leadMustHandOverBeforeLeaving,
    leadHandOverBlockedByObservers,
    MAKE_OBSERVER_MEMBER_FIRST,
    type GroupRowTarget,
    type GroupRowViewer,
} from '../groups.js';

const lead: GroupRowViewer = { role: 'convenor', status: 'active', isLead: true };
const convenor: GroupRowViewer = { role: 'convenor', status: 'active', isLead: false };
const plainMember: GroupRowViewer = { role: 'member', status: 'active', isLead: false };
const observer: GroupRowViewer = { role: 'observer', status: 'active', isLead: false };

const row = (over: Partial<GroupRowTarget> = {}): GroupRowTarget =>
    ({ memberPubkey: 'target', role: 'member', status: 'active', isLead: false, ...over });

describe('who may act on a group roster row', () => {
    it('gives nobody but an active convenor any action', () => {
        for (const viewer of [plainMember, observer, { role: null, isLead: false }]) {
            const a = groupRowActions(viewer as GroupRowViewer, row());
            expect(a).toEqual({ canChangeRole: false, canRemove: false, canHandOverLead: false });
        }
        // A convenor whose own membership is not active moderates nothing either.
        expect(isActiveGroupConvenor({ role: 'convenor', status: 'invited', isLead: false })).toBe(false);
        expect(groupRowActions({ role: 'convenor', status: 'invited', isLead: false }, row()).canRemove).toBe(false);
    });

    it('offers no action at all on the lead convenor — to a convenor or to the lead themselves', () => {
        const leadRow = row({ memberPubkey: 'the-lead', role: 'convenor', isLead: true });
        expect(groupRowActions(convenor, leadRow)).toEqual({ canChangeRole: false, canRemove: false, canHandOverLead: false });
        expect(groupRowActions(lead, leadRow)).toEqual({ canChangeRole: false, canRemove: false, canHandOverLead: false });
    });

    it('hides Role and ✕ from a convenor looking at another convenor, and shows them to the lead', () => {
        const otherConvenor = row({ memberPubkey: 'other', role: 'convenor' });
        expect(groupRowActions(convenor, otherConvenor)).toEqual({ canChangeRole: false, canRemove: false, canHandOverLead: false });
        expect(groupRowActions(lead, otherConvenor)).toEqual({ canChangeRole: true, canRemove: true, canHandOverLead: true });
    });

    it('leaves a convenor every action on members and observers, as before', () => {
        for (const role of ['member', 'observer'] as const) {
            const a = groupRowActions(convenor, row({ role }));
            expect(a.canChangeRole).toBe(true);
            expect(a.canRemove).toBe(true);
            // Only the lead hands the lead on, and never to an observer.
            expect(a.canHandOverLead).toBe(false);
            expect(groupRowActions(lead, row({ role })).canHandOverLead).toBe(role === 'member');
        }
    });

    it('offers nothing on the viewer’s own row: leaving is the Leave button', () => {
        expect(groupRowActions(lead, row({ memberPubkey: 'me' }), 'me'))
            .toEqual({ canChangeRole: false, canRemove: false, canHandOverLead: false });
        expect(groupRowActions(convenor, row({ memberPubkey: 'me', role: 'convenor' }), 'me').canRemove).toBe(false);
    });

    it('still lets a convenor decline a request and withdraw an invitation', () => {
        expect(groupRowActions(convenor, row({ status: 'pending_approval' })).canRemove).toBe(true);
        expect(groupRowActions(convenor, row({ status: 'invited' })).canRemove).toBe(true);
        // A convenor-to-be who has not accepted yet is not an active convenor, so any convenor may withdraw it.
        expect(groupRowActions(convenor, row({ role: 'convenor', status: 'invited' })).canRemove).toBe(true);
        // But they are no candidate for the lead until they are actually in the group.
        expect(groupRowActions(lead, row({ role: 'convenor', status: 'invited' })).canHandOverLead).toBe(false);
    });

    it('labels the badge with the vocabulary Marty chose — lead convenor, never owner', () => {
        expect(groupRoleLabel('convenor', true)).toBe('Lead convenor');
        expect(groupRoleLabel('convenor', false)).toBe('Convenor');
        expect(groupRoleLabel('member', false)).toBe('Member');
        expect(groupRoleLabel('observer', false)).toBe('Observer');
        for (const role of ['convenor', 'member', 'observer'] as const) {
            expect(groupRoleLabel(role, true).toLowerCase()).not.toContain('owner');
        }
    });

    it('asks a leaving lead to hand over, unless they are the last one in the group', () => {
        expect(leadMustHandOverBeforeLeaving(true, 3)).toBe(true);
        expect(leadMustHandOverBeforeLeaving(true, 0)).toBe(false);
        expect(leadMustHandOverBeforeLeaving(false, 3)).toBe(false);
    });

    it('names the observer promotion when that is the only thing left to do', () => {
        // Nobody to hand to, but observers are there to promote: the dead end the screens have to explain.
        expect(leadHandOverBlockedByObservers(0, 2)).toBe(true);
        // Somebody can take the lead, so the ordinary hand-over wording stands.
        expect(leadHandOverBlockedByObservers(1, 2)).toBe(false);
        // A lead genuinely on their own: not blocked, they may simply leave.
        expect(leadHandOverBlockedByObservers(0, 0)).toBe(false);
        expect(MAKE_OBSERVER_MEMBER_FIRST).toMatch(/observers a member first/);
    });
});

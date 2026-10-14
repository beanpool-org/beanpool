/**
 * Who the web offers "Invite people" to: exactly whom the node lets invite (engine groups.ts inviteGroupMember: an
 * active convenor; state-engine assertGroupNotClosed; routes/groups.ts assertNotMuted). Pinned beside the server rule.
 */
import { describe, it, expect, vi } from 'vitest';
import { canInviteToGroup, alreadyInGroup, invitableShown, sendInvitations } from './group-invite';

const ME = 'pk-me';
const row = (role: 'convenor' | 'member' | 'observer', status: string) => [{ memberPubkey: ME, role, status } as any];

describe('canInviteToGroup mirrors the server', () => {
    it.each(['open', 'request_to_join', 'invite_only'])('an active convenor may invite to a %s group', () => {
        expect(canInviteToGroup({ group: { viewerRole: 'convenor', viewerStatus: 'active' }, members: row('convenor', 'active'), myPubkey: ME, muted: false })).toBe(true);
    });
    it('a member, an observer, an invited or asking convenor may not (the node answers 403)', () => {
        expect(canInviteToGroup({ group: { viewerRole: 'member', viewerStatus: 'active' }, members: row('member', 'active'), myPubkey: ME, muted: false })).toBe(false);
        expect(canInviteToGroup({ group: { viewerRole: 'observer', viewerStatus: 'active' }, members: row('observer', 'active'), myPubkey: ME, muted: false })).toBe(false);
        expect(canInviteToGroup({ group: { viewerRole: 'convenor', viewerStatus: 'invited' }, members: row('convenor', 'invited'), myPubkey: ME, muted: false })).toBe(false);
        expect(canInviteToGroup({ group: { viewerRole: 'convenor', viewerStatus: 'pending_approval' }, members: [], myPubkey: ME, muted: false })).toBe(false);
        expect(canInviteToGroup({ group: { viewerRole: null, viewerStatus: null }, members: [], myPubkey: ME, muted: false })).toBe(false);
    });
    it('the roster row wins over the card (a convenor demoted since the card was read)', () => {
        expect(canInviteToGroup({ group: { viewerRole: 'convenor', viewerStatus: 'active' }, members: row('member', 'active'), myPubkey: ME, muted: false })).toBe(false);
    });
    it('never in a closed group, never while muted, never while the mute is not known', () => {
        const g = { viewerRole: 'convenor' as const, viewerStatus: 'active' as const };
        expect(canInviteToGroup({ group: { ...g, closedAt: '2026-10-01T00:00:00Z' }, members: row('convenor', 'active'), myPubkey: ME, muted: false })).toBe(false);
        expect(canInviteToGroup({ group: g, members: row('convenor', 'active'), myPubkey: ME, muted: true })).toBe(false);
        expect(canInviteToGroup({ group: g, members: row('convenor', 'active'), myPubkey: ME, muted: null })).toBe(false);
    });
});

describe('the people offered and the send', () => {
    it('active, invited and asking members are already in; a removed member may be invited again', () => {
        const s = alreadyInGroup([
            { memberPubkey: 'a', status: 'active' }, { memberPubkey: 'b', status: 'invited' },
            { memberPubkey: 'c', status: 'pending_approval' }, { memberPubkey: 'd', status: 'removed' },
        ] as any);
        expect([...s].sort()).toEqual(['a', 'b', 'c']);
    });
    it('never the signer or a system account, matched by name, once each, by name', () => {
        const shown = invitableShown([
            { publicKey: 'z', callsign: 'zoe' }, { publicKey: ME, callsign: 'Me' }, { publicKey: 'SYSTEM', callsign: 'System' },
            { publicKey: 'escrow_1', callsign: 'Escrow' }, { publicKey: 'b', callsign: 'Bea' }, { publicKey: 'b', callsign: 'Bea' },
        ], '', ME);
        expect(shown.map(p => p.publicKey)).toEqual(['b', 'z']);
        expect(invitableShown(shown, 'ZO', ME).map(p => p.publicKey)).toEqual(['z']);
    });
    it('one call per person, four at a time, and what failed is named back', async () => {
        let inFlight = 0, most = 0;
        const invite = vi.fn(async (pk: string) => {
            inFlight++; most = Math.max(most, inFlight);
            await new Promise(r => setTimeout(r, 1));
            inFlight--;
            if (pk === 'p3') throw new Error('offline');
        });
        const keys = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
        const res = await sendInvitations(keys, invite);
        expect(invite.mock.calls.map(c => c[0])).toEqual(keys);
        expect(most).toBeLessThanOrEqual(4);
        expect(res).toEqual({ sent: ['p1', 'p2', 'p4', 'p5', 'p6'], failed: ['p3'] });
    });
});

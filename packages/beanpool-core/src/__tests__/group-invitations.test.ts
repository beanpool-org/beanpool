import { describe, it, expect } from 'vitest';
import {
    readGroupInvitations, hasInvitationsToShow, pendingInvitationLine, declinedInvitationLine, moreInvitationsLine,
    invitedListTitle, invitedName, withdrawWords,
} from '../group-invitations';

const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const DAYS_AGO = (d: number) => new Date(NOW - d * 86400_000).toISOString();

describe('the group invitations list (apps/server engine/group-invitations.ts)', () => {
    it('reads the node\'s answer, and nothing else', () => {
        const raw = {
            view: 'convenor', pendingTotal: 2,
            pending: [
                { memberPubkey: 'mia', callsign: 'Mia', avatarUrl: 'https://x/m.jpg', invitedAt: DAYS_AGO(2), invitedBy: { pubkey: 'cleo', callsign: 'Cleo' } },
                { memberPubkey: 'nat', invitedAt: DAYS_AGO(1) },
            ],
            declined: [{ memberPubkey: 'ola', callsign: 'Ola', invitedAt: DAYS_AGO(5), declinedAt: DAYS_AGO(3) }],
        };
        const inv = readGroupInvitations(raw)!;
        expect(inv.view).toBe('convenor');
        expect(inv.pending.map(p => p.memberPubkey)).toEqual(['mia', 'nat']);
        expect(inv.pending[0].invitedBy).toEqual({ pubkey: 'cleo', callsign: 'Cleo' });
        expect(inv.pending[1].invitedBy).toBeUndefined();
        expect(inv.declined[0].declinedAt).toBe(DAYS_AGO(3));
        expect(hasInvitationsToShow(inv)).toBe(true);
        // An older node answers 404 with an error body, a refusal an error: nothing to draw, never a guessed list.
        for (const bad of [null, undefined, 'x', [], {}, { error: 'Not found' }, { view: 'owner', pending: [], declined: [] }, { view: 'sender', pending: 'no', declined: [] }]) {
            expect(readGroupInvitations(bad)).toBeNull();
        }
        expect(hasInvitationsToShow(null)).toBe(false);
        expect(hasInvitationsToShow(readGroupInvitations({ view: 'sender', pending: [], pendingTotal: 0, declined: [] }))).toBe(false);
    });

    it('drops rows that name no one, and never reports fewer than it holds', () => {
        const inv = readGroupInvitations({
            view: 'sender', pendingTotal: 0,
            pending: [{ callsign: 'No key' }, { memberPubkey: '' }, { memberPubkey: 'a' }],
            declined: [{ memberPubkey: 'b' }, { memberPubkey: 'c', declinedAt: DAYS_AGO(1) }],
        })!;
        expect(inv.pending.map(p => p.memberPubkey)).toEqual(['a']);
        expect(inv.pendingTotal).toBe(1);
        expect(inv.declined.map(d => d.memberPubkey)).toEqual(['c']);
    });

    it('says when, and for a convenor who made it ("you" for their own)', () => {
        const mia = { memberPubkey: 'mia', callsign: 'Mia', invitedAt: DAYS_AGO(2), invitedBy: { pubkey: 'cleo', callsign: 'Cleo' } };
        expect(pendingInvitationLine(mia, 'cas', NOW)).toBe('Invited 2 days ago by Cleo');
        expect(pendingInvitationLine(mia, 'cleo', NOW)).toBe('Invited 2 days ago by you');
        // A member's own view carries no inviter.
        expect(pendingInvitationLine({ memberPubkey: 'nat', invitedAt: new Date(NOW - 5 * 3600_000).toISOString() }, 'hal', NOW)).toBe('Invited 5 hours ago');
        // An inviter with no name, or no date, is not invented.
        expect(pendingInvitationLine({ memberPubkey: 'x', invitedAt: DAYS_AGO(1), invitedBy: { pubkey: 'zz' } }, 'cas', NOW)).toBe('Invited 1 day ago');
        expect(pendingInvitationLine({ memberPubkey: 'x', invitedAt: null, invitedBy: { pubkey: 'cleo', callsign: 'Cleo' } }, 'cas', NOW)).toBe('Invited by Cleo');
        expect(pendingInvitationLine({ memberPubkey: 'x', invitedAt: 'not a date' }, 'cas', NOW)).toBe('Invited');
    });

    it('says a declined invitation was declined, and when', () => {
        expect(declinedInvitationLine({ memberPubkey: 'ola', invitedAt: null, declinedAt: DAYS_AGO(3) }, NOW)).toBe('Declined 3 days ago');
        expect(declinedInvitationLine({ memberPubkey: 'ola', invitedAt: null, declinedAt: 'soon' }, NOW)).toBe('Declined');
    });

    it('titles the list with the whole count and says how many the page leaves out', () => {
        expect(invitedListTitle(3)).toBe('Invited, not joined yet (3)');
        const inv = readGroupInvitations({ view: 'convenor', pendingTotal: 230, pending: [{ memberPubkey: 'a' }], declined: [] })!;
        expect(moreInvitationsLine(inv)).toBe('and 229 more');
        expect(moreInvitationsLine({ ...inv, pendingTotal: 1 })).toBe('');
    });

    it('names a person by callsign, or the start of the key', () => {
        expect(invitedName({ memberPubkey: 'abcdef0123456789', callsign: 'Mia' })).toBe('Mia');
        expect(invitedName({ memberPubkey: 'abcdef0123456789' })).toBe('abcdef0123');
        const w = withdrawWords({ memberPubkey: 'mia', callsign: 'Mia' });
        expect(w.label).toBe('Withdraw the invitation to Mia');
        expect(w.question).toBe('The invitation to Mia is taken back. You can invite them again.');
    });
});

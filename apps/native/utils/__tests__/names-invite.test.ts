import { describe, it, expect, vi } from 'vitest';
import { inviteThisPerson, boundInviteLine, invitesForEntry, inviteLink, BIND_OUTCOME_WORDS, type BoundInvite } from '../names-invite';

const at = (pk: string) => `@${pk.slice(0, 3)}`;
const inv = (over: Partial<BoundInvite>): BoundInvite => ({
    entryId: 'e1', createdBy: 'owen', createdAt: '2026-10-04T00:00:00Z', usedBy: null, usedAt: null, outcome: null, ...over,
});

describe('Invite this person (community modes slice 3)', () => {
    it('uses the node’s bound invite when it answers, and makes no ticket', async () => {
        const ticket = vi.fn(async () => 'BP-x');
        const r = await inviteThisPerson(async () => ({ ok: true, value: { invite: { code: 'INV-ABCD-EFGH' } } }), ticket);
        expect(r).toEqual({ ok: true, code: 'INV-ABCD-EFGH', offline: false });
        expect(ticket).not.toHaveBeenCalled();
    });

    it('with no signal (no answer at all), makes an offline ticket bound to the entry', async () => {
        const r = await inviteThisPerson(async () => ({ ok: false, status: 0, message: 'unreachable' }), async () => 'BP-ticket');
        expect(r).toEqual({ ok: true, code: 'BP-ticket', offline: true });
    });

    it('says a refusal and makes no ticket: it would not confirm for the same reason', async () => {
        const ticket = vi.fn(async () => 'BP-x');
        const r = await inviteThisPerson(async () => ({ ok: false, status: 409, message: 'A member is confirmed against this entry already. One person, one entry.' }), ticket);
        expect(r).toEqual({ ok: false, message: 'A member is confirmed against this entry already. One person, one entry.' });
        expect(ticket).not.toHaveBeenCalled();
    });

    it('says why a ticket could not be made (an older server)', async () => {
        const r = await inviteThisPerson(async () => ({ ok: false, status: 0, message: 'x' }), async () => { throw new Error('too old'); });
        expect(r).toEqual({ ok: false, message: 'too old' });
    });

    it('the entry’s line: waiting, confirmed, or why not', () => {
        expect(boundInviteLine(inv({}), at)).toBe('Invite made, not used yet');
        expect(boundInviteLine(inv({ usedBy: 'kim123', outcome: 'confirmed' }), at)).toBe('@kim joined and was confirmed');
        expect(boundInviteLine(inv({ usedBy: 'yan123', outcome: 'entry_taken' }), at)).toBe(`@yan ${BIND_OUTCOME_WORDS.entry_taken}`);
        expect(BIND_OUTCOME_WORDS.entry_taken).toMatch(/not confirmed/);
        // A debt that opened on the entry after the invite was made (#1589 × debts): a member, unconfirmed.
        expect(boundInviteLine(inv({ usedBy: 'jon123', outcome: 'open_debt' }), at)).toBe(`@jon ${BIND_OUTCOME_WORDS.open_debt}`);
        expect(BIND_OUTCOME_WORDS.open_debt).toMatch(/not confirmed.*debt/);
    });

    it('picks the entry’s invites and links the code as the People tab does', () => {
        expect(invitesForEntry([inv({ entryId: 'a' }), inv({ entryId: 'b', createdBy: 'ada' })], 'b').map((i) => i.createdBy)).toEqual(['ada']);
        expect(inviteLink('https://c.example', 'INV-1')).toBe('https://c.example/?invite=INV-1');
    });
});

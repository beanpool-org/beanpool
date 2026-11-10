import { describe, it, expect, vi } from 'vitest';
import {
    inviteThisPerson, boundInviteLine, invitesForEntry, inviteLink, namesInviteBody, showsBoundInviteLine, BIND_OUTCOME_WORDS, type BoundInvite,
} from '../names-invite';

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

    // #2970's deciding review, note 1: an outcome this phone has no words for (a newer node's, or a stray key) never throws
    // and never prints "undefined".
    it('an outcome it has no words for reads as "joined", with no clause, and never throws', () => {
        const odd = (over: Record<string, unknown>) => inv(over as Partial<BoundInvite>);
        expect(boundInviteLine(odd({ usedBy: 'kim123', outcome: 'merged_later' }), at)).toBe('@kim joined');
        expect(boundInviteLine(odd({ usedBy: 'kim123', outcome: 'confirmed', voucherOutcome: 'paused', voucherLevel: 90000 }), at)).toBe('@kim joined and was confirmed');
        expect(() => boundInviteLine(odd({ usedBy: 'kim123', outcome: 'constructor', voucherOutcome: 'toString' }), at)).not.toThrow();
        expect(boundInviteLine(odd({ usedBy: 'kim123', outcome: 'constructor', voucherOutcome: 'toString' }), at)).toBe('@kim joined');
        for (const line of [
            boundInviteLine(odd({ usedBy: 'kim123', outcome: 'merged_later', voucherOutcome: 'paused' }), at),
            boundInviteLine(odd({ usedBy: 'kim123', outcome: 'hasOwnProperty', voucherOutcome: '__proto__' }), at),
        ]) expect(line).not.toMatch(/undefined|function|\[object/);
        // The words it knows are unchanged. The level keeps its name on the node and carries whole hundredths of a Bean
        // (core formatHundredths writes it, grouped in English as on the web: 100000 is "1,000").
        expect(boundInviteLine(inv({ usedBy: 'kim123', outcome: 'confirmed', voucherOutcome: 'made', voucherLevel: 100000 }), at))
            .toBe('@kim joined and was confirmed; made a voucher with a budget of 1,000 Beans');
        expect(boundInviteLine(inv({ usedBy: 'kim123', outcome: 'confirmed', voucherOutcome: 'made', voucherLevel: 50000 }), at))
            .toBe('@kim joined and was confirmed; made a voucher with a budget of 500 Beans');
    });

    // Note 2: a confirmed or waiting entry shows its invite's line when the invite promised a voucher budget.
    it('which entries show their invite’s line', () => {
        expect(showsBoundInviteLine(undefined, false)).toBe(false);
        expect(showsBoundInviteLine(inv({}), false)).toBe(true);
        expect(showsBoundInviteLine(inv({ usedBy: 'kim123', outcome: 'confirmed' }), true)).toBe(false);
        for (const voucherOutcome of ['made', 'maker_not_committee', 'beans_off', 'not_made', 'awaiting_second'] as const) {
            expect(showsBoundInviteLine(inv({ usedBy: 'kim123', outcome: 'confirmed', voucherLevel: 100000, voucherOutcome }), true)).toBe(true);
        }
    });

    // A2 (amend3 §2, Q1): the body sends only what was chosen; a level only rides on an entry's invite.
    it('the entry invite’s body carries only what was chosen', () => {
        expect(namesInviteBody({})).toEqual({});
        expect(namesInviteBody({ vouchAmount: null, voucherLevel: null })).toEqual({});
        // Whole hundredths of a Bean, under the names the node kept: a vouch of 50, a budget of 1,000.
        expect(namesInviteBody({ vouchAmount: 5000 })).toEqual({ vouchAmount: 5000 });
        expect(namesInviteBody({ voucherLevel: 100000 })).toEqual({ voucherLevel: 100000 });
        expect(namesInviteBody({ vouchAmount: 10000, voucherLevel: 150000 })).toEqual({ vouchAmount: 10000, voucherLevel: 150000 });
        expect(namesInviteBody({ vouchAmount: Number.NaN, voucherLevel: Infinity })).toEqual({});
    });
});

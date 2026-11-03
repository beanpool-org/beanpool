import { describe, expect, it } from 'vitest';
import { INVITE_VOUCH_CHOICES, offersInviteVouch } from './invite-vouch.js';
import { isVouchLevel, vouchCreditForLevel } from './protocol.js';

describe('a vouch on an invite', () => {
    it('offers None first, then the three levels with the Beans each hands out', () => {
        expect(INVITE_VOUCH_CHOICES).toEqual([
            { level: null, amount: null },
            { level: 1, amount: 25 },
            { level: 2, amount: 50 },
            { level: 3, amount: 100 },
        ]);
        expect(INVITE_VOUCH_CHOICES.slice(1).map((c) => vouchCreditForLevel(c.level!))).toEqual([25, 50, 100]);
    });

    it('counts 1, 2 and 3 as levels and nothing else', () => {
        for (const level of [1, 2, 3]) expect(isVouchLevel(level)).toBe(true);
        for (const bad of [0, 4, -1, 1.5, 1e21, Number.MAX_SAFE_INTEGER, NaN, Infinity, '1', '2', '', true, false, null, undefined, [1], { level: 1 }]) {
            expect(isVouchLevel(bad)).toBe(false);
        }
    });

    it('shows the control only where the node says it can and this member can give one', () => {
        expect(offersInviteVouch({ inviteVouch: true }, true)).toBe(true);
        expect(offersInviteVouch({ inviteVouch: true }, false)).toBe(false);
        expect(offersInviteVouch({ inviteVouch: false }, true)).toBe(false);
        expect(offersInviteVouch({}, true)).toBe(false);
        expect(offersInviteVouch(null, true)).toBe(false);
        expect(offersInviteVouch({ inviteVouch: true }, undefined)).toBe(false);
    });
});

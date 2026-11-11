import { describe, it, expect } from 'vitest';
import {
    VOUCH_PRESETS,
    VOUCH_MAX,
    VOUCHES_PER_PERSON,
    OWNER_VOUCH_PRESETS,
    OWNER_VOUCH_MAX,
    PERSON_VOUCH_MAX,
    PERSON_VOUCH_MAX_WITH_OWNER,
    isOwnerVouchPreset,
    vouchPresetsFor,
    vouchMaxFor,
    raiseTargetsFor,
    personVouchMax,
    VOUCHER_BUDGET_MIN,
    VOUCHER_BUDGET_MAX,
    isVouchPreset,
    isBudgetLevel,
    formatHistoryLine,
    VOUCH_PRESET_WORDS,
    type HistoryLineLike,
} from '../vouch-presets.js';

describe('vouch-presets core logic and history line formatting', () => {
    it('validates presets and budget levels', () => {
        expect(VOUCH_PRESETS).toEqual([2500, 5000, 7500, 10000]);
        expect(VOUCH_MAX).toBe(10000);
        expect(VOUCHES_PER_PERSON).toBe(3);
        expect(VOUCHER_BUDGET_MIN).toBe(10000);
        expect(VOUCHER_BUDGET_MAX).toBe(200000);

        expect(isVouchPreset(2500)).toBe(true);
        expect(isVouchPreset(5000)).toBe(true);
        expect(isVouchPreset(7500)).toBe(true);
        expect(isVouchPreset(10000)).toBe(true);
        expect(isVouchPreset(3000)).toBe(false);

        expect(isBudgetLevel(10000)).toBe(true);
        expect(isBudgetLevel(50000)).toBe(true);
        expect(isBudgetLevel(100000)).toBe(true);
        expect(isBudgetLevel(200000)).toBe(true);
        expect(isBudgetLevel(210000)).toBe(false);
        expect(isBudgetLevel(15000)).toBe(false);
    });

    it("gives an owner 200 and 500 too, a 500 cap per person they vouch for, and nobody else either (Marty, 9 Nov)", () => {
        expect(OWNER_VOUCH_PRESETS).toEqual([2500, 5000, 7500, 10000, 20000, 50000]);
        expect(OWNER_VOUCH_MAX).toBe(50000);
        expect(PERSON_VOUCH_MAX).toBe(30000);
        expect(PERSON_VOUCH_MAX_WITH_OWNER).toBe(50000);
        expect(vouchPresetsFor(true)).toEqual([2500, 5000, 7500, 10000, 20000, 50000]);
        expect(vouchPresetsFor(false)).toEqual([2500, 5000, 7500, 10000]);
        expect(vouchMaxFor(true)).toBe(50000);
        expect(vouchMaxFor(false)).toBe(10000);
        expect(personVouchMax(true)).toBe(50000);
        expect(personVouchMax(false)).toBe(30000);
        expect(isOwnerVouchPreset(20000)).toBe(true);
        expect(isOwnerVouchPreset(50000)).toBe(true);
        expect(isOwnerVouchPreset(2500)).toBe(true);
        expect(isOwnerVouchPreset(30000)).toBe(false);
        expect(isVouchPreset(20000)).toBe(false);
        expect(isVouchPreset(50000)).toBe(false);
    });

    it('formats grant lines in plain words without keys or raw enums', () => {
        const h1: HistoryLineLike = {
            kind: 'grant',
            amount_c: 100000,
            actor: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            actorCallsign: 'marty',
            at: '2026-11-05T00:00:00Z',
        };
        const text1 = formatHistoryLine(h1);
        expect(text1).toBe('+1,000 budget, made a voucher by @marty');
        expect(text1).not.toMatch(/[0-9a-f]{64}/i);
        expect(text1).not.toMatch(/\bgrant\b/i);

        const h2: HistoryLineLike = {
            kind: 'grant',
            amount_c: 100000,
            actor: 'node:claim',
            actorCallsign: null,
            at: '2026-11-05T00:00:00Z',
        };
        const text2 = formatHistoryLine(h2);
        expect(text2).toBe('+1,000 budget, made a voucher');
        expect(text2).not.toMatch(/node:claim/);
        expect(text2).not.toMatch(/\bgrant\b/i);
    });

    it('formats top-up and lower lines', () => {
        const hTop: HistoryLineLike = {
            kind: 'top_up',
            amount_c: 50000,
            actor: 'a'.repeat(64),
            actorCallsign: 'damo',
            at: '2026-11-05T00:00:00Z',
        };
        const textTop = formatHistoryLine(hTop);
        expect(textTop).toBe('+500 top-up by @damo');
        expect(textTop).not.toMatch(/[0-9a-f]{64}/i);
        expect(textTop).not.toMatch(/\btop_up\b/i);

        const hLower: HistoryLineLike = {
            kind: 'lower',
            amount_c: -20000,
            actor: 'a'.repeat(64),
            actorCallsign: 'damo',
            at: '2026-11-05T00:00:00Z',
        };
        const textLower = formatHistoryLine(hLower);
        expect(textLower).toBe('−200 budget lowered by @damo');
        expect(textLower).not.toMatch(/[0-9a-f]{64}/i);
        expect(textLower).not.toMatch(/\blower\b/i);
    });

    it('formats hold and return lines', () => {
        const hHoldInvite: HistoryLineLike = {
            kind: 'hold',
            amount_c: -10000,
            actor: 'b'.repeat(64),
            at: '2026-11-05T00:00:00Z',
            for: 'invite',
        };
        const textHold = formatHistoryLine(hHoldInvite);
        expect(textHold).toBe('−100 held for an invite');
        expect(textHold).not.toMatch(/\bhold\b/i);

        const hHoldProfile: HistoryLineLike = {
            kind: 'hold',
            amount_c: -5000,
            actor: 'b'.repeat(64),
            at: '2026-11-05T00:00:00Z',
            for: 'profile',
            person: { memberPubkey: 'c'.repeat(64), callsign: 'sam' },
        };
        const textHoldProfile = formatHistoryLine(hHoldProfile);
        expect(textHoldProfile).toBe('−50 vouched for @sam');
        expect(textHoldProfile).not.toMatch(/[0-9a-f]{64}/i);

        const hReturnExpired: HistoryLineLike = {
            kind: 'return',
            amount_c: 10000,
            actor: 'node',
            at: '2026-11-05T00:00:00Z',
            why: 'expired',
        };
        const textExpired = formatHistoryLine(hReturnExpired);
        expect(textExpired).toBe('+100 back, invite expired');
        expect(textExpired).not.toMatch(/\breturn\b/i);

        const hReturnStopped: HistoryLineLike = {
            kind: 'return',
            amount_c: 10000,
            actor: 'node',
            at: '2026-11-05T00:00:00Z',
            why: 'stopped',
        };
        expect(formatHistoryLine(hReturnStopped)).toBe('+100 back, budget stopped');

        const hReturnNotLanded: HistoryLineLike = {
            kind: 'return',
            amount_c: 10000,
            actor: 'node',
            at: '2026-11-05T00:00:00Z',
            why: 'not_landed',
        };
        expect(formatHistoryLine(hReturnNotLanded)).toBe('+100 back, invite not landed');
    });

    it('formats stop budget lines', () => {
        const hStop: HistoryLineLike = {
            kind: 'stop',
            amount_c: -45000,
            actor: 'd'.repeat(64),
            actorCallsign: 'marty',
            at: '2026-11-05T00:00:00Z',
        };
        const textStop = formatHistoryLine(hStop);
        expect(textStop).toBe('−450 budget stopped by @marty');
        expect(textStop).not.toMatch(/[0-9a-f]{64}/i);
        expect(textStop).not.toMatch(/\bstop\b/i);
    });

    it("a raise is offered as the totals it can end at (slice I6): the voucher's own presets above what they vouched, up to their most", () => {
        // In hundredths, as every vouch is: an owner at 100 is offered 200 and 500: 300 is not a preset, so it is not a total anyone can vouch.
        expect(raiseTargetsFor(true, 10000)).toEqual([20000, 50000]);
        expect(raiseTargetsFor(true, 2500)).toEqual([5000, 7500, 10000, 20000, 50000]);
        expect(raiseTargetsFor(true, 20000)).toEqual([50000]);
        expect(raiseTargetsFor(true, 50000)).toEqual([]);
        // Everyone else tops out at 100 and is never offered an owner's 200 or 500.
        expect(raiseTargetsFor(false, 2500)).toEqual([5000, 7500, 10000]);
        expect(raiseTargetsFor(false, 7500)).toEqual([10000]);
        expect(raiseTargetsFor(false, 10000)).toEqual([]);
        // A total between presets is offered the presets above it only.
        expect(raiseTargetsFor(true, 12500)).toEqual([20000, 50000]);
        // Nothing offered is at or below the total, or past the voucher's most.
        for (const owner of [true, false]) {
            for (const total of [2500, 5000, 7500, 10000, 12500, 20000, 30000, 50000]) {
                for (const target of raiseTargetsFor(owner, total)) {
                    expect(target).toBeGreaterThan(total);
                    expect(target).toBeLessThanOrEqual(vouchMaxFor(owner));
                }
            }
        }
    });

    it('says "Raise to" once, and keeps no sentence for the old add-an-amount raise', () => {
        expect(VOUCH_PRESET_WORDS.raiseTo).toBe('Raise to');
        for (const gone of ['raiseConfirmQuestion', 'raise', 'raiseTitle', 'pastMax']) {
            expect(Object.keys(VOUCH_PRESET_WORDS)).not.toContain(gone);
        }
    });
});

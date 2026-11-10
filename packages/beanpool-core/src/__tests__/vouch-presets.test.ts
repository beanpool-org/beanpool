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
        expect(VOUCH_PRESETS).toEqual([25, 50, 75, 100]);
        expect(VOUCH_MAX).toBe(100);
        expect(VOUCHES_PER_PERSON).toBe(3);
        expect(VOUCHER_BUDGET_MIN).toBe(100);
        expect(VOUCHER_BUDGET_MAX).toBe(2000);

        expect(isVouchPreset(25)).toBe(true);
        expect(isVouchPreset(50)).toBe(true);
        expect(isVouchPreset(75)).toBe(true);
        expect(isVouchPreset(100)).toBe(true);
        expect(isVouchPreset(30)).toBe(false);

        expect(isBudgetLevel(100)).toBe(true);
        expect(isBudgetLevel(500)).toBe(true);
        expect(isBudgetLevel(1000)).toBe(true);
        expect(isBudgetLevel(2000)).toBe(true);
        expect(isBudgetLevel(2100)).toBe(false);
        expect(isBudgetLevel(150)).toBe(false);
    });

    it("gives an owner 200 and 500 too, a 500 cap per person they vouch for, and nobody else either (Marty, 9 Nov)", () => {
        expect(OWNER_VOUCH_PRESETS).toEqual([25, 50, 75, 100, 200, 500]);
        expect(OWNER_VOUCH_MAX).toBe(500);
        expect(PERSON_VOUCH_MAX).toBe(300);
        expect(PERSON_VOUCH_MAX_WITH_OWNER).toBe(500);
        expect(vouchPresetsFor(true)).toEqual([25, 50, 75, 100, 200, 500]);
        expect(vouchPresetsFor(false)).toEqual([25, 50, 75, 100]);
        expect(vouchMaxFor(true)).toBe(500);
        expect(vouchMaxFor(false)).toBe(100);
        expect(personVouchMax(true)).toBe(500);
        expect(personVouchMax(false)).toBe(300);
        expect(isOwnerVouchPreset(200)).toBe(true);
        expect(isOwnerVouchPreset(500)).toBe(true);
        expect(isOwnerVouchPreset(25)).toBe(true);
        expect(isOwnerVouchPreset(300)).toBe(false);
        expect(isVouchPreset(200)).toBe(false);
        expect(isVouchPreset(500)).toBe(false);
    });

    it('formats grant lines in plain words without keys or raw enums', () => {
        const h1: HistoryLineLike = {
            kind: 'grant',
            amount: 1000,
            actor: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            actorCallsign: 'marty',
            at: '2026-11-05T00:00:00Z',
        };
        const text1 = formatHistoryLine(h1);
        expect(text1).toBe('+1000 budget, made a voucher by @marty');
        expect(text1).not.toMatch(/[0-9a-f]{64}/i);
        expect(text1).not.toMatch(/\bgrant\b/i);

        const h2: HistoryLineLike = {
            kind: 'grant',
            amount: 1000,
            actor: 'node:claim',
            actorCallsign: null,
            at: '2026-11-05T00:00:00Z',
        };
        const text2 = formatHistoryLine(h2);
        expect(text2).toBe('+1000 budget, made a voucher');
        expect(text2).not.toMatch(/node:claim/);
        expect(text2).not.toMatch(/\bgrant\b/i);
    });

    it('formats top-up and lower lines', () => {
        const hTop: HistoryLineLike = {
            kind: 'top_up',
            amount: 500,
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
            amount: -200,
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
            amount: -100,
            actor: 'b'.repeat(64),
            at: '2026-11-05T00:00:00Z',
            for: 'invite',
        };
        const textHold = formatHistoryLine(hHoldInvite);
        expect(textHold).toBe('−100 held for an invite');
        expect(textHold).not.toMatch(/\bhold\b/i);

        const hHoldProfile: HistoryLineLike = {
            kind: 'hold',
            amount: -50,
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
            amount: 100,
            actor: 'node',
            at: '2026-11-05T00:00:00Z',
            why: 'expired',
        };
        const textExpired = formatHistoryLine(hReturnExpired);
        expect(textExpired).toBe('+100 back, invite expired');
        expect(textExpired).not.toMatch(/\breturn\b/i);

        const hReturnStopped: HistoryLineLike = {
            kind: 'return',
            amount: 100,
            actor: 'node',
            at: '2026-11-05T00:00:00Z',
            why: 'stopped',
        };
        expect(formatHistoryLine(hReturnStopped)).toBe('+100 back, budget stopped');

        const hReturnNotLanded: HistoryLineLike = {
            kind: 'return',
            amount: 100,
            actor: 'node',
            at: '2026-11-05T00:00:00Z',
            why: 'not_landed',
        };
        expect(formatHistoryLine(hReturnNotLanded)).toBe('+100 back, invite not landed');
    });

    it('formats stop budget lines', () => {
        const hStop: HistoryLineLike = {
            kind: 'stop',
            amount: -450,
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
        // An owner at 100 is offered 200 and 500: 300 is not a preset, so it is not a total anyone can vouch.
        expect(raiseTargetsFor(true, 100)).toEqual([200, 500]);
        expect(raiseTargetsFor(true, 25)).toEqual([50, 75, 100, 200, 500]);
        expect(raiseTargetsFor(true, 200)).toEqual([500]);
        expect(raiseTargetsFor(true, 500)).toEqual([]);
        // Everyone else tops out at 100 and is never offered an owner's 200 or 500.
        expect(raiseTargetsFor(false, 25)).toEqual([50, 75, 100]);
        expect(raiseTargetsFor(false, 75)).toEqual([100]);
        expect(raiseTargetsFor(false, 100)).toEqual([]);
        // A total between presets is offered the presets above it only.
        expect(raiseTargetsFor(true, 125)).toEqual([200, 500]);
        // Nothing offered is at or below the total, or past the voucher's most.
        for (const owner of [true, false]) {
            for (const total of [25, 50, 75, 100, 125, 200, 300, 500]) {
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

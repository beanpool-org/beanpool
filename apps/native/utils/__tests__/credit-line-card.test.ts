import { describe, it, expect } from 'vitest';
import { creditLineCard, knownFrozenPartNote, frozenDebitLine, KNOWN_FROZEN_BODY, KNOWN_FROZEN_PART } from '../credit-line-card';

// Rehearsal 5 Oct, b: a member whose known floor an admin froze was told their line "opens automatically after your
// first trade". The node now says so (knownFrozen), and the Ledger shows the truth.
describe('the Ledger credit-line card', () => {
    it('a member whose only line the admins froze sees the frozen card, not "No credit line yet"', () => {
        expect(creditLineCard({ activated: false, knownFrozen: true })).toBe('frozen');
        expect(KNOWN_FROZEN_BODY).toMatch(/admins have frozen your credit line/);
        expect(KNOWN_FROZEN_BODY).toMatch(/can't spend into debit/);
        expect(KNOWN_FROZEN_BODY).toMatch(/sell and receive Beans, and spend what you hold above zero/);
        expect(KNOWN_FROZEN_BODY).toMatch(/ask one of the admins/);
        expect(KNOWN_FROZEN_BODY).not.toMatch(/automatically|first trade|Ʀ|Newcomer/);
    });

    // r4178376534: a member frozen while in debit is already below zero and holds nothing to pay with. The body is true for
    // them too ("can't go below zero … pay with what you have" was not), and the card says how far down they are.
    it('a member frozen while in debit is told how far down they are and how they come back up; in credit, nothing more', () => {
        expect(KNOWN_FROZEN_BODY).not.toMatch(/can't go below zero|pay with what you have/);
        // The balance is whole hundredths of a Bean (the node's balance_c): −40000 is 400 Beans below zero. Exact now, never
        // rounded up (the old float figure was, to the tenth); grouped as every figure is (core formatHundredths).
        expect(frozenDebitLine(-40000)).toBe('You are 400 Beans in debit. Selling or receiving Beans brings you back up, and once you are above zero you can spend what you hold.');
        expect(frozenDebitLine(-1234)).toMatch(/^You are 12\.34 Beans in debit\./);
        expect(frozenDebitLine(-4)).toMatch(/^You are 0\.04 Beans in debit\./);
        expect(frozenDebitLine(-180000)).toMatch(/^You are 1,800 Beans in debit\./);
        expect(frozenDebitLine(-982)).toMatch(/^You are 9\.82 Beans in debit\./);
        expect(frozenDebitLine(-40000)).not.toMatch(/Ʀ/);
        expect(frozenDebitLine(0)).toBeNull();
        expect(frozenDebitLine(2500)).toBeNull();
        expect(frozenDebitLine(undefined)).toBeNull();
        expect(frozenDebitLine(NaN)).toBeNull();
        // Not whole hundredths: no line, never a number.
        expect(frozenDebitLine(-12.34)).toBeNull();
    });

    it('a member whose whole line the admins froze (the manager\'s Freeze) sees the same card, line or not', () => {
        expect(creditLineCard({ activated: true, creditFrozen: true })).toBe('frozen');
        expect(creditLineCard({ activated: false, creditFrozen: true })).toBe('frozen');
        expect(knownFrozenPartNote({ activated: true, creditFrozen: true, knownFrozen: true })).toBeNull();
    });

    it('with another line still working, the bar shows with a note that the known part is frozen', () => {
        expect(creditLineCard({ activated: true, knownFrozen: true })).toBe('bar');
        expect(knownFrozenPartNote({ activated: true, knownFrozen: true })).toBe(KNOWN_FROZEN_PART);
    });

    it('a lowered line and a normal one are unchanged', () => {
        // Lowered to 200 (rehearsal: "YOUR LIMIT -200") and the default: the node answers knownFrozen false.
        expect(creditLineCard({ activated: true, knownFrozen: false })).toBe('bar');
        expect(knownFrozenPartNote({ activated: true, knownFrozen: false })).toBeNull();
        expect(creditLineCard({ activated: false, knownFrozen: false })).toBe('none');
        // An older node sends no knownFrozen at all.
        expect(creditLineCard({ activated: false })).toBe('none');
        expect(creditLineCard({ activated: true })).toBe('bar');
        expect(creditLineCard({ activated: true, creditFrozen: false, knownFrozen: false })).toBe('bar');
        expect(knownFrozenPartNote({ activated: false, knownFrozen: true })).toBeNull();
    });
});

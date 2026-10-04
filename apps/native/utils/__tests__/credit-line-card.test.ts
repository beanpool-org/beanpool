import { describe, it, expect } from 'vitest';
import { creditLineCard, knownFrozenPartNote, KNOWN_FROZEN_BODY, KNOWN_FROZEN_PART } from '../credit-line-card';

// Rehearsal 5 Oct, b: a member whose known floor an admin froze was told their line "opens automatically after your
// first trade". The node now says so (knownFrozen), and the Ledger shows the truth.
describe('the Ledger credit-line card', () => {
    it('a member whose only line the admins froze sees the frozen card, not "No credit line yet"', () => {
        expect(creditLineCard({ activated: false, knownFrozen: true })).toBe('frozen');
        expect(KNOWN_FROZEN_BODY).toMatch(/admins have frozen your credit line/);
        expect(KNOWN_FROZEN_BODY).toMatch(/trade with the Beans you hold/);
        expect(KNOWN_FROZEN_BODY).toMatch(/ask one of the admins/);
        expect(KNOWN_FROZEN_BODY).not.toMatch(/automatically|first trade|Ʀ|Newcomer/);
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

import { describe, it, expect } from 'vitest';
import {
    beansAmount, beansHeld, wageNoteWords, payOutSplit, payOutFeeWords, checkPayOutAmount, scopedEffectsFor, scopedEffectLabel, rollChoices,
    scopedEffectWords, scopedTallyWords, scopedOutcomeWords, scopedClosesWords, type RollPerson,
} from '../scoped-decision';

const roll: RollPerson[] = [
    { pubkey: 'ann', name: 'Ann', role: 'lead' }, { pubkey: 'bob', name: 'Bob', role: 'keeper' }, { pubkey: 'cat', name: 'Cat', role: 'keeper' },
];
const tally = { voted: 2, roll: 4, quorumRequired: 3, thresholdRequired: 0.6 };

describe("an enterprise's keepers' vote, as the apps show it", () => {
    it('while open: turnout only, never Yes or No', () => {
        const w = scopedTallyWords({ status: 'open', tally: { ...tally, yes: 2, no: 0 } });
        expect(w).toBe('2 of 4 have voted. 3 must vote. Yes and No show when it closes.');
        expect(w).not.toMatch(/Yes \d|No \d/);
    });

    it('once closed: the split', () => {
        expect(scopedTallyWords({ status: 'executed', tally: { ...tally, voted: 3, yes: 2, no: 1 } })).toBe('Yes 2 · No 1. 3 of 4 voted.');
        expect(scopedOutcomeWords({ status: 'executed' })).toBe('Passed and carried out');
        expect(scopedOutcomeWords({ status: 'execution_void', executionReason: 'The enterprise is winding up' })).toBe('Passed, but there was nothing to do: The enterprise is winding up');
        expect(scopedOutcomeWords({ status: 'failed' })).toBe('Did not pass');
    });

    it('the pay-out carries the 1.5% fee, out of the amount, in Beans', () => {
        expect(payOutSplit(40)).toEqual({ receives: 39.4, fee: 0.6 });
        expect(payOutFeeWords(40, 'Ali')).toBe('Ali receives 39.4 Beans. The 1.5% trade fee (0.6 Beans) goes to the Commons.');
        expect(payOutFeeWords(40, 'Ali')).not.toMatch(/Ʀ/);
        expect(beansAmount(12.5)).toBe('12.5');
        expect(beansAmount(3)).toBe('3');
    });

    it('the amount: above 0, cents at most, no more than the enterprise holds', () => {
        expect(checkPayOutAmount('40', 120)).toEqual({ amount: 40 });
        expect(checkPayOutAmount('12.50', 120)).toEqual({ amount: 12.5 });
        expect(checkPayOutAmount('120', 120)).toEqual({ amount: 120 });
        expect(checkPayOutAmount('120.01', 120)).toHaveProperty('error');
        expect(checkPayOutAmount('0', 120)).toHaveProperty('error');
        expect(checkPayOutAmount('-5', 120)).toHaveProperty('error');
        expect(checkPayOutAmount('1.005', 120)).toHaveProperty('error');
        expect(checkPayOutAmount('abc', 120)).toHaveProperty('error');
        expect(checkPayOutAmount('5', -10)).toHaveProperty('error');
    });

    it('what it holds, rounded down to cents, as the node counts what it can pay (review opus-1767 N8)', () => {
        expect(beansHeld(112.3125)).toBe('112.31');
        expect(beansHeld(0.339)).toBe('0.33');
        expect(beansHeld(40)).toBe('40');
        expect(beansHeld(39.999)).toBe('39.99');
        expect(beansHeld(-5)).toBe('0');
        expect(checkPayOutAmount('113', 112.3125)).toEqual({ error: "The enterprise holds 112.31 Beans, so it can't pay more than that." });
    });

    it("a keeper's pay-out is a wage: capped at what it has earned above its costs, in the node's words (review opus-1767 N5)", () => {
        const wage = "Paying a keeper is a wage, and a wage comes only out of what the enterprise has earned above its costs (its earned surplus): 10 Beans now.";
        expect(checkPayOutAmount('50', 100, 10)).toEqual({ error: wage });
        expect(checkPayOutAmount('10.01', 100, 10.009)).toEqual({ error: wage });
        expect(checkPayOutAmount('10', 100, 10)).toEqual({ amount: 10 });
        // Held is the lower cap: its words.
        expect(checkPayOutAmount('50', 40, 100)).toEqual({ error: "The enterprise holds 40 Beans, so it can't pay more than that." });
        expect(checkPayOutAmount('5', 100, -3)).toEqual({ error: wage.replace('10 Beans', '0 Beans') });
        // Surplus not known: the node checks it.
        expect(checkPayOutAmount('50', 100, null)).toEqual({ amount: 50 });
        expect(checkPayOutAmount('50', 100)).toEqual({ amount: 50 });
        expect(wageNoteWords(12.345, 'ongoing')).toBe('Paying a keeper is a wage: only out of what the enterprise has earned above its costs, 12.34 Beans now.');
        expect(wageNoteWords(null, 'bounded')).toBe('Paying a keeper is a wage: only out of what the project has earned.');
    });

    it("a project's collaborators can't vote the leader out; an enterprise's keepers can choose a new lead", () => {
        expect(scopedEffectsFor('bounded')).toEqual(['pay_out', 'remove_keeper']);
        expect(scopedEffectsFor('ongoing')).toEqual(['pay_out', 'remove_keeper', 'replace_lead']);
        expect(scopedEffectLabel('remove_keeper', 'bounded')).toBe('Remove a collaborator');
        expect(scopedEffectLabel('remove_keeper', 'ongoing')).toBe('Remove a keeper');
    });

    it('the pickers come from the roll: never yourself as the one paid or removed, never the lead to remove or as the new lead', () => {
        expect(rollChoices('pay_out', roll, 'bob').map(p => p.pubkey)).toEqual(['ann', 'cat']);
        // The node refuses a vote to remove yourself ("To leave, step down instead."), so the picker never offers it.
        expect(rollChoices('remove_keeper', roll, 'bob').map(p => p.pubkey)).toEqual(['cat']);
        expect(rollChoices('replace_lead', roll, 'ann').map(p => p.pubkey)).toEqual(['bob', 'cat']);
        // A keeper may propose themselves as the new lead: the node allows it, and the keepers vote on it.
        expect(rollChoices('replace_lead', roll, 'bob').map(p => p.pubkey)).toEqual(['bob', 'cat']);
    });

    it('what it does, in one line', () => {
        const nameOf = (pk: string) => roll.find(p => p.pubkey === pk)?.name ?? 'a member';
        expect(scopedEffectWords({ effect: 'pay_out', subject: 'cat', params: { amount: 40 } }, nameOf)).toBe('Pay 40 Beans to Cat');
        expect(scopedEffectWords({ effect: 'remove_keeper', subject: 'bob', params: null }, nameOf, 'bounded')).toBe('Remove Bob as a collaborator');
        expect(scopedEffectWords({ effect: 'replace_lead', subject: 'bob', params: null }, nameOf)).toBe('Make Bob the lead keeper');
    });

    it('when it closes', () => {
        const now = Date.parse('2026-10-11T00:00:00Z');
        expect(scopedClosesWords('2026-10-14T00:00:00Z', now)).toBe('closes in 3 days');
        expect(scopedClosesWords('2026-10-11T05:30:00Z', now)).toBe('closes in 5 hours');
        expect(scopedClosesWords('2026-10-11T00:20:00Z', now)).toBe('closes within the hour');
    });
});

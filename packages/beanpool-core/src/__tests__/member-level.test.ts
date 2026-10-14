/**
 * memberLevel: the one source the Ledger's badge and its Levels card both read (phone and PWA), from the node's balance
 * answer. The answers below are shaped as getBalance sends them (floor = the line held now, tierCredit = the credit the
 * node read `tier` from, which a freeze keeps). Rehearsal 3 (5 Oct): one member, one level on one screen.
 */
import { describe, it, expect } from 'vitest';
import { PROTOCOL_CONSTANTS, TIER_LEVELS, memberLevel, tierForCredit } from '../protocol.js';

const B = PROTOCOL_CONSTANTS.CREDIT_BASE_FLOOR;
const answer = (tierCredit: number, floorCredit: number) =>
    ({ tier: { name: tierForCredit(tierCredit).name, emoji: tierForCredit(tierCredit).emoji }, tierCredit, floor: B - floorCredit });

describe('memberLevel', () => {
    const cases: Array<[string, ReturnType<typeof answer>, string, number]> = [
        ['admin with no trades and no grant', answer(0, 0), 'Newcomer', 0],
        ['admin with no trades, granted Steward credit', answer(600, 600), 'Steward', 600],
        ['granted Resident credit', answer(200, 200), 'Resident', 200],
        ['known floor frozen: the line is gone, the tier stays', answer(600, 0), 'Steward', 600],
        ['known floor lowered: the tier follows the lowered line', answer(150, 150), 'Newcomer', 150],
        ['known floor raised: the tier follows the raised line', answer(1400, 1400), 'Elder', 1400],
    ];
    for (const [what, a, name, credit] of cases) {
        it(`${what}: ${name}, ${credit} trust`, () => {
            const level = memberLevel(a);
            expect(TIER_LEVELS[level.index].name).toBe(name);
            expect(level.index).toBe(TIER_LEVELS.findIndex(t => t.name === a.tier.name));
            expect(level.credit).toBe(credit);
            // The trust figure lands in the level shown: the card's "N trust" never sits below its own level.
            expect(tierForCredit(level.credit).name).toBe(name);
        });
    }

    it("a frozen member's figure is the tier's credit, not the frozen floor's", () => {
        const level = memberLevel(answer(600, 0));
        expect(level).toEqual({ index: 2, credit: 600 });
        expect(Math.max(0, B - answer(600, 0).floor)).toBe(0);   // what the card read before
    });

    it('a node that sends no tierCredit: the floor, and its tier name still wins', () => {
        expect(memberLevel({ tier: { name: 'Resident' }, floor: B - 250 })).toEqual({ index: 1, credit: 250 });
        expect(memberLevel({ floor: B - 650 })).toEqual({ index: 2, credit: 650 });
        expect(memberLevel({ tier: { name: 'Steward' }, tierCredit: null, floor: B })).toEqual({ index: 2, credit: 0 });
    });

    it('nothing yet, or junk: Newcomer, 0 trust', () => {
        expect(memberLevel(null)).toEqual({ index: 0, credit: 0 });
        expect(memberLevel(undefined)).toEqual({ index: 0, credit: 0 });
        expect(memberLevel({ tier: { name: 'Overlord' }, tierCredit: Number.NaN, floor: 'x' })).toEqual({ index: 0, credit: 0 });
        expect(memberLevel({ tierCredit: -40 })).toEqual({ index: 0, credit: 0 });
    });
});

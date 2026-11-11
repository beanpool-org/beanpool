/**
 * memberLevel: the one source the Ledger's badge and its Levels card both read (phone and PWA), from the node's balance
 * answer. The answers below are shaped as getBalance sends them (floor_c = the line held now, tierCredit_c = the credit the
 * node read `tier` from, which a freeze keeps; both whole hundredths). Rehearsal 3 (5 Oct): one member, one level on one screen.
 * The cases are written in Beans and sent as hundredths (beans()).
 */
import { describe, it, expect } from 'vitest';
import { PROTOCOL_CONSTANTS, TIER_LEVELS, memberLevel, tierForCredit } from '../protocol.js';
import { beans } from '../hundredths.js';

const B = PROTOCOL_CONSTANTS.CREDIT_BASE_FLOOR;
const answer = (tierBeans: number, floorBeans: number) =>
    ({ tier: { name: tierForCredit(beans(tierBeans)).name, emoji: tierForCredit(beans(tierBeans)).emoji }, tierCredit_c: beans(tierBeans), floor_c: B - beans(floorBeans) });

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
            expect(level.credit).toBe(beans(credit));
            // The trust figure lands in the level shown: the card's "N trust" never sits below its own level.
            expect(tierForCredit(level.credit).name).toBe(name);
        });
    }

    it("a frozen member's figure is the tier's credit, not the frozen floor's", () => {
        const level = memberLevel(answer(600, 0));
        expect(level).toEqual({ index: 2, credit: beans(600) });
        expect(Math.max(0, B - answer(600, 0).floor_c)).toBe(0);   // what the card read before
    });

    it('a node that sends no tierCredit: the floor, and its tier name still wins', () => {
        expect(memberLevel({ tier: { name: 'Resident' }, floor_c: B - beans(250) })).toEqual({ index: 1, credit: beans(250) });
        expect(memberLevel({ floor_c: B - beans(650) })).toEqual({ index: 2, credit: beans(650) });
        expect(memberLevel({ tier: { name: 'Steward' }, tierCredit_c: null, floor_c: B })).toEqual({ index: 2, credit: 0 });
        // A figure that is not whole hundredths is not read: a float floor counts as none.
        expect(memberLevel({ floor_c: B - 650.5 })).toEqual({ index: 0, credit: 0 });
    });

    it('nothing yet, or junk: Newcomer, 0 trust', () => {
        expect(memberLevel(null)).toEqual({ index: 0, credit: 0 });
        expect(memberLevel(undefined)).toEqual({ index: 0, credit: 0 });
        expect(memberLevel({ tier: { name: 'Overlord' }, tierCredit_c: Number.NaN, floor_c: 'x' })).toEqual({ index: 0, credit: 0 });
        expect(memberLevel({ tierCredit_c: -4000 })).toEqual({ index: 0, credit: 0 });
    });
});

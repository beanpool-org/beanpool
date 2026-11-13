/**
 * The member's own credit card (DESIGN-credit-bar-amend-fable.md §11, slice R0): the eight tests that turn red.
 * Every figure is whole hundredths; `beans(n)` writes n Beans.
 */
import { describe, expect, it } from 'vitest';
import {
    BAR_FEE_AT,
    BAR_LIMIT_AT,
    BAR_ZERO_AT,
    CREDIT_METER_ROLES,
    CREDIT_RAINBOW,
    barPlace,
    creditBarPicture,
    creditLabelColours,
    creditLineParts,
    creditMeterColours,
    creditNoteColours,
    creditStanding,
    creditStandingCard,
    earningProgress,
    libraryLeaf,
    offerLadder,
    type CreditStandingAnswer,
} from '../credit-standing.js';
import { BRAND_SETS, brandColourLeaves, brandGrounds, colourIn, contrastRatio } from '../brand-colours.js';
import { beans } from '../hundredths.js';

const b = beans;

/** Marty on 14 Nov: owes 50 of a 500 line, all of it Damo's vouch, one live Offer. */
const MARTY: CreditStandingAnswer = {
    balance_c: -b(50), floor_c: -b(500), usableFloor_c: -b(500), knownGrant_c: 0, roomHeld_c: b(500), earnedCredit_c: 0, liveOffers: 1,
    vouchedBy: [{ callsign: 'Damo', amount_c: b(500) }],
};
/** Earned 600 and a vouch of 300: one live Offer opens 500 of 900. */
const EARNED_AND_VOUCH: CreditStandingAnswer = {
    balance_c: -b(120), floor_c: -b(900), usableFloor_c: -b(500), knownGrant_c: 0, roomHeld_c: b(300), earnedCredit_c: b(600), liveOffers: 1,
    vouchedBy: [{ callsign: 'Damo', amount_c: b(300) }],
};

describe('(1) the offer ladder reads the vouched part', () => {
    it('a vouched 500 line with one live Offer: nothing closed and no mark at 200', () => {
        const ladder = offerLadder(b(500), b(500));
        expect(ladder.openAt(1)).toBe(b(500));
        expect(ladder.rungs).toEqual([]);
        expect(ladder.offersForFull).toBe(1);
        const s = creditStanding(MARTY);
        expect(s.closed_c).toBe(0);
        expect(creditBarPicture(MARTY).stripes).toBeNull();
    });
    it('main\'s ladder (no vouched part) drew the stray rung at 200: the core ladder with the vouch does not', () => {
        expect(offerLadder(b(500), 0).rungs).toEqual([b(200)]);
        expect(offerLadder(b(500), b(500)).rungs).not.toContain(b(200));
    });
    it('earned 600 + vouch 300 with one Offer: 500 open, 400 closed, next 800', () => {
        const s = creditStanding(EARNED_AND_VOUCH);
        expect(s.open_c).toBe(b(500));
        expect(s.closed_c).toBe(b(400));
        expect(s.nextOpen_c).toBe(b(800));
        expect(offerLadder(b(900), b(300)).openAt(1)).toBe(b(500));
    });
});

describe('(2) the parts add up to the line, in the strip\'s order', () => {
    const sum = (a: CreditStandingAnswer) => creditLineParts(a).items.reduce((s, p) => s + p.inLine_c, 0);
    const fixtures: Record<string, CreditStandingAnswer> = {
        allVouch: MARTY,
        threeSources: { balance_c: 0, floor_c: -b(700), usableFloor_c: -b(700), earnedCredit_c: b(200), roomHeld_c: b(500), liveOffers: 1,
            vouchedBy: [{ callsign: 'Damo', amount_c: b(300) }, { callsign: 'Jane', amount_c: b(200) }] },
        confirmedAndVouch: { balance_c: 0, floor_c: -b(1100), usableFloor_c: -b(1100), knownGrant_c: b(1000), roomHeld_c: b(100), earnedCredit_c: 0, liveOffers: 1,
            vouchedBy: [{ callsign: 'Olive', amount_c: b(100) }] },
        passedOn: { balance_c: 0, floor_c: -b(400), usableFloor_c: -b(400), roomHeld_c: b(400), earnedCredit_c: 0, liveOffers: 1,
            vouchedBy: [{ callsign: 'Damo', amount_c: b(500) }] },
        aboveMost: { balance_c: 0, floor_c: -b(2000), usableFloor_c: -b(2000), knownGrant_c: b(1000), earnedCredit_c: b(1200), liveOffers: 5 },
        fromBefore: { balance_c: 0, floor_c: -b(300), usableFloor_c: -b(300), earnedCredit_c: b(100), liveOffers: 2 },
    };
    for (const [name, a] of Object.entries(fixtures)) {
        it(`${name}: the parts add up to the limit`, () => {
            expect(sum(a)).toBe(-(a.floor_c ?? 0));
        });
    }
    it('three sources: earned, then the vouches, the earliest nearest zero', () => {
        expect(creditLineParts(fixtures.threeSources!).line).toBe('Credit line 700: ■ Earned by trading 200 · □ @Jane vouched 200 · □ @Damo vouched 300');
    });
    it('a confirmed member with a vouch reads the whole line (F7)', () => {
        expect(creditLineParts(fixtures.confirmedAndVouch!).line).toBe('Credit line 1,100: ■ Earned by trading 0 so far · □ Confirmed member 1,000 · □ @Olive vouched 100');
    });
    it('a vouch of 500 with 100 passed on: the line is 400 and says so (F16)', () => {
        const p = creditLineParts(fixtures.passedOn!);
        expect(p.passedOn_c).toBe(b(100));
        expect(p.line).toBe('Credit line 400: ■ Earned by trading 0 so far · □ @Damo vouched 500 · you gave 100 to another member');
    });
    it('parts above the community\'s most: cut from the earned part, and named', () => {
        const p = creditLineParts(fixtures.aboveMost!);
        expect(p.capped).toBe(true);
        expect(p.items.map((i) => [i.kind, i.inLine_c])).toEqual([['earned', b(1000)], ['confirmed', b(1000)]]);
        expect(p.line).toBe('Credit line 2,000: ■ Earned by trading 1,200 · □ Confirmed member 1,000 · this community’s most is 2,000');
    });
    it('"from before" is what the line holds beyond the parts named', () => {
        expect(creditLineParts(fixtures.fromBefore!).line).toBe('Credit line 300: ■ Earned by trading 100 · □ From before 200');
    });
    it('all vouch: one outlined block (the earned part is 0 so far)', () => {
        expect(creditLineParts(MARTY).line).toBe('Credit line 500: ■ Earned by trading 0 so far · □ @Damo vouched 500');
        expect(creditBarPicture(MARTY).blocks.map((x) => [x.kind, x.solid])).toEqual([['vouch', false]]);
    });
    it('no line: no parts', () => {
        expect(creditLineParts({ balance_c: 0, floor_c: 0 }).line).toBeNull();
    });
});

describe('(3) owed + can spend = the open line; can spend = Home\'s room_c', () => {
    const homeRoom = (a: CreditStandingAnswer) => Math.max(0, (a.balance_c ?? 0) - (a.usableFloor_c ?? 0));
    for (const base of [MARTY, EARNED_AND_VOUCH, { ...MARTY, floor_c: -123456, usableFloor_c: -123456, roomHeld_c: 123456 }]) {
        it(`line ${-(base.floor_c ?? 0)}, open ${-(base.usableFloor_c ?? 0)}`, () => {
            const open = -(base.usableFloor_c ?? 0);
            const line = -(base.floor_c ?? 0);
            for (let bal = -line; bal <= 0; bal += 25) {
                const a = { ...base, balance_c: bal };
                const s = creditStanding(a);
                expect(s.canSpend_c).toBe(homeRoom(a));
                if (-bal <= open) expect(s.owed_c + s.canSpend_c).toBe(open);
                else expect(s.canSpend_c).toBe(0);
            }
        });
    }
});

describe('(4) the picture', () => {
    it('the dot is 50 at zero, 4 at the limit, 68 at +200, and rises with the balance', () => {
        expect(barPlace(0, b(500))).toBe(BAR_ZERO_AT);
        expect(BAR_ZERO_AT).toBe(50);
        expect(barPlace(-b(500), b(500))).toBe(BAR_LIMIT_AT);
        expect(BAR_LIMIT_AT).toBe(4);
        expect(barPlace(b(200), b(500))).toBe(68);
        expect(BAR_FEE_AT).toBe(68);
        let last = -1;
        for (let bal = -b(500); bal <= b(3000); bal += 50) {
            const at = barPlace(bal, b(500));
            expect(at).toBeGreaterThanOrEqual(last);
            expect(at).toBeGreaterThanOrEqual(BAR_LIMIT_AT);
            expect(at).toBeLessThanOrEqual(98);
            last = at;
        }
        expect(barPlace(-b(250), b(500))).toBe(27); // half the line is half the left half: straight
    });
    it('the blocks add up to the left half, each its share; the stripes cover the closed share, inside "earned"', () => {
        const pic = creditBarPicture(EARNED_AND_VOUCH);
        const half = BAR_ZERO_AT - BAR_LIMIT_AT;
        expect(pic.blocks.reduce((s, x) => s + x.width, 0)).toBeCloseTo(half, 9);
        expect(pic.blocks[0]!.kind).toBe('earned');
        expect(pic.blocks[0]!.width).toBeCloseTo((half * 600) / 900, 9);
        expect(pic.blocks[1]!.width).toBeCloseTo((half * 300) / 900, 9);
        expect(pic.blocks[pic.blocks.length - 1]!.from + pic.blocks[pic.blocks.length - 1]!.width).toBeCloseTo(BAR_ZERO_AT, 9);
        expect(pic.stripes!.from).toBe(BAR_LIMIT_AT);
        expect(pic.stripes!.width).toBeCloseTo((half * 400) / 900, 9);
        expect(pic.stripes!.from + pic.stripes!.width).toBeLessThanOrEqual(pic.blocks[0]!.from + pic.blocks[0]!.width);
    });
    it('no line yet: the left half is striped and says so', () => {
        const pic = creditBarPicture({ balance_c: b(40), floor_c: 0 });
        expect(pic.noLine).toBe(true);
        expect(pic.stripes).toEqual({ from: BAR_LIMIT_AT, width: BAR_ZERO_AT - BAR_LIMIT_AT });
        expect([pic.marks.limit.figure, pic.marks.limit.words]).toEqual(['', 'no credit line yet']);
    });
    it('the label: "−50 Beans", red at nine tenths, gold above 200', () => {
        expect(creditBarPicture(MARTY).label).toBe('−50 Beans');
        expect(creditBarPicture(MARTY).tone).toBe('calm');
        expect(creditBarPicture({ ...MARTY, balance_c: -b(450) }).tone).toBe('near');
        expect(creditBarPicture({ ...MARTY, balance_c: -b(449) }).tone).toBe('calm');
        expect(creditBarPicture({ ...MARTY, balance_c: b(260) }).tone).toBe('fee');
        expect(creditBarPicture({ ...MARTY, balance_c: b(260) }).label).toBe('+260 Beans');
        expect(creditBarPicture({ ...MARTY, balance_c: b(200) }).tone).toBe('calm');
    });
    it('the marks: −500 your limit, 0 balanced, +200 monthly fee starts', () => {
        const m = creditBarPicture(MARTY).marks;
        expect([m.limit.figure, m.limit.words, m.limit.at]).toEqual(['−500', 'your limit', 4]);
        expect(m.fee.line).toBe('Hold more than 200 Beans and a small monthly fee starts on the part above.');
        expect([m.zero.figure, m.zero.words, m.zero.at]).toEqual(['0', 'balanced', 50]);
        expect([m.fee.figure, m.fee.words, m.fee.at]).toEqual(['+200', 'monthly fee starts', 68]);
    });
});

describe('(5) earning, with the engine\'s own sum', () => {
    it('100, 500, 582, 1,000 and 5,000 traded give 37.64, 174.54, 200.18, 320 and 960', () => {
        expect([100, 500, 582, 1000, 5000].map((v) => earningProgress({ qualifiedValue: b(v) }).earned_c)).toEqual([3764, 17454, 20018, 32000, 96000]);
    });
    it('3 stars gives four fifths; no reviews keeps it all', () => {
        expect(earningProgress({ qualifiedValue: b(1000), avgRating: 3, reviewCount: 4 }).earned_c).toBe(25600);
        expect(earningProgress({ qualifiedValue: b(1000), avgRating: 3, reviewCount: 0 }).earned_c).toBe(32000);
    });
    it('the next 100 Beans traded at 582 add about 30', () => {
        expect(earningProgress({ qualifiedValue: b(582) }).nextHundred_c).toBe(3027);
    });
});

describe('(6) the sentences of every state, and the spoken sentence', () => {
    const card = (a: CreditStandingAnswer) => {
        const c = creditStandingCard(a);
        return [c.headline, c.sentence, c.note ? `${c.note.icon} ${c.note.text}` : null];
    };
    it('owing, room left (Marty): and the spoken sentence', () => {
        expect(card(MARTY)).toEqual(['You owe 50 Beans', 'You can spend 450 more of your 500 credit line.', null]);
        expect(creditStanding(MARTY).state).toBe('owing');
        expect(creditStandingCard(MARTY).spoken).toBe(
            'You owe 50 Beans. You can spend 450 more of your 500 credit line. Your limit is minus 500. Your credit line: @Damo vouched 500. Opens how this works.');
    });
    it('nearly', () => {
        expect(card({ ...MARTY, balance_c: -b(480) })).toEqual(['You owe 480 Beans', 'Only 20 left of your 500 credit line.', '! Sell or receive Beans to make room. Owing costs nothing.']);
    });
    it('at the limit', () => {
        expect(card({ ...MARTY, balance_c: -b(500) })).toEqual(['You owe 500 Beans', 'You have used all of your 500 credit line.',
            '! You can’t buy until you sell or receive Beans. Nothing is taken from you, and owing costs nothing.']);
    });
    it('spending paused by Offers', () => {
        const a = { ...EARNED_AND_VOUCH, floor_c: -b(1000), usableFloor_c: -b(200), roomHeld_c: 0, earnedCredit_c: b(1000), vouchedBy: [], balance_c: -b(350) };
        expect(card(a)).toEqual(['You owe 350 Beans', 'Spending paused: your live Offer opens 200 of your 1,000 credit line, and you owe 350.',
            '! Post an Offer, or sell, to lift it. You can still sell and receive Beans.']);
        expect(card({ ...a, liveOffers: 0, usableFloor_c: 0 })[1]).toBe('Spending paused: you have no live Offer, so your 1,000 credit line is asleep, and you owe 350.');
    });
    it('spending paused, line lowered', () => {
        expect(card({ ...MARTY, balance_c: -b(650) })).toEqual(['You owe 650 Beans', 'Spending paused: you owe 150 more than your credit line.',
            '! Selling or receiving Beans brings you back. Nothing is taken from you.']);
    });
    it('at zero, with a line', () => {
        expect(card({ ...MARTY, balance_c: 0 })).toEqual(['You are at zero', 'You have given as much as you have received. You can spend 500 from your credit line.', null]);
    });
    it('holding, 200 or less', () => {
        expect(card({ ...MARTY, balance_c: b(120) })).toEqual(['You hold 120 Beans', 'You can spend 620: your 120 Beans, then your 500 credit line.', null]);
    });
    it('holding, above 200', () => {
        expect(card({ ...MARTY, balance_c: b(260) })).toEqual(['You hold 260 Beans', 'You can spend 760: your 260 Beans, then your 500 credit line.',
            '! 60 of your Beans are above 200. A small monthly fee on them goes to the Commons: about 0.60 this month.']);
    });
    it('no line yet, at zero and holding', () => {
        const seed = '🌱 Your credit line opens with your first completed trade, or when someone who gives credit here vouches for you.';
        expect(card({ balance_c: 0, floor_c: 0 })).toEqual(['You are at zero', 'No credit line yet, so there is nothing to spend and nothing to repay.', seed]);
        expect(card({ balance_c: b(40), floor_c: 0 })).toEqual(['You hold 40 Beans', 'You can spend the 40 Beans you hold.', seed]);
    });
    it('a line, no live Offer (asleep)', () => {
        expect(card({ ...MARTY, balance_c: 0, liveOffers: 0, usableFloor_c: 0 })).toEqual(['You are at zero', 'You can’t spend below zero yet.',
            '🔒 Your 500 credit line is asleep. Post one Offer and all of it opens.']);
        const earned = { balance_c: 0, floor_c: -b(900), usableFloor_c: 0, earnedCredit_c: b(900), liveOffers: 0 };
        expect(card(earned)[2]).toBe('🔒 Your 900 credit line is asleep. Post one Offer and 200 of it opens.');
    });
    it('Offers hold part back', () => {
        expect(card(EARNED_AND_VOUCH)).toEqual(['You owe 120 Beans', 'You can spend 380 more: your live Offer opens 500 of your 900 credit line.',
            '🔒 400 is closed for now. One more live Offer opens 800 of your 900, and 3 live Offers open all of it.']);
        expect(card({ ...EARNED_AND_VOUCH, liveOffers: 2, usableFloor_c: -b(800) })[2]).toBe('🔒 100 is closed for now. One more live Offer opens all of it.');
    });
    it('frozen by an admin: no line, the frozen sentence', () => {
        expect(creditStanding({ ...MARTY, creditFrozen: true }).state).toBe('frozen');
    });
});

describe('(7) no old word, and no "B" after a figure', () => {
    const balances = [-b(700), -b(500), -b(480), -b(50), 0, b(120), b(260), b(5000)];
    const answers: CreditStandingAnswer[] = [MARTY, EARNED_AND_VOUCH, { balance_c: 0, floor_c: 0 }, { ...MARTY, liveOffers: 0, usableFloor_c: 0 },
        { balance_c: 0, floor_c: -b(2000), usableFloor_c: -b(2000), knownGrant_c: b(1000), earnedCredit_c: b(1200), liveOffers: 5 }];
    it('every string the card, the parts and the picture write', () => {
        for (const base of answers) {
            for (const balance_c of balances) {
                const a = { ...base, balance_c };
                const c = creditStandingCard(a);
                const p = creditBarPicture(a);
                const all = [c.headline, c.sentence, c.note?.text, c.parts, c.spoken, p.label, ...[p.marks.limit, p.marks.zero, p.marks.fee].flatMap((m) => [m.figure, m.words, m.line])]
                    .filter((x): x is string => typeof x === 'string');
                for (const s of all) {
                    expect(s).not.toMatch(/floor|overdraft|sweet spot|fee-free|carry credit|hold credit/i);
                    expect(s).not.toMatch(/\d\s?B\b/);
                }
            }
        }
    });
});

describe('(8) the colours', () => {
    it('the rainbow\'s stops are main\'s', () => {
        expect(CREDIT_RAINBOW.stops).toEqual(['#bb4b32', '#cf6a3f', '#e0a35a', '#7ccb90', '#2f9e44', '#7ccb90', '#e0a35a', '#c07d2a']);
        expect(CREDIT_RAINBOW.at).toEqual([0.04, 0.17, 0.29, 0.4, 0.5, 0.6, 0.74, 0.96]);
    });
    it('every meter leaf is a library leaf', () => {
        const paths = new Set(brandColourLeaves().map((l) => l.path));
        for (const path of Object.values(CREDIT_METER_ROLES)) {
            expect(paths.has(path), path).toBe(true);
            expect(() => libraryLeaf(path)).not.toThrow();
        }
    });
    it('words 4.5:1 and marks 3:1 on each card, in three looks', () => {
        for (const set of BRAND_SETS) {
            const m = creditMeterColours(set);
            const g = brandGrounds(set);
            for (const card of [g.phone.card, g.web.card]) {
                for (const ink of [m.limitInk, m.zeroInk, m.feeInk]) expect(contrastRatio(ink, card), `${set} ${ink} on ${card}`).toBeGreaterThanOrEqual(4.5);
                expect(contrastRatio(m.strip, card), `${set} strip on ${card}`).toBeGreaterThanOrEqual(3);
            }
            for (const tone of ['calm', 'near', 'fee'] as const) {
                const l = creditLabelColours(tone, m);
                expect(contrastRatio(l.on, l.fill), `${set} ${tone} label`).toBeGreaterThanOrEqual(4.5);
            }
            for (const tone of ['warn', 'danger', 'quiet', 'ok'] as const) {
                const n = creditNoteColours(tone, m);
                expect(contrastRatio(n.ink, n.tint), `${set} ${tone} note`).toBeGreaterThanOrEqual(4.5);
            }
            expect(m.limitInk).toBe(colourIn(libraryLeaf('ink.danger'), set));
        }
    });
});

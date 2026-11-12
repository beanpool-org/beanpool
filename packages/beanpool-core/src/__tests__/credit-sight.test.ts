/**
 * The giver's sight in core (scratch/fable-design/DESIGN-credit-list-amend-fable.md §3.2, §4.2, §5.3; slice C1): the position,
 * credit risk with each reason marked, the row's sentences, and the told sentence beside the reworded rule line. Each check
 * names the change that turns it red.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
    CREDIT_SIGHT_WORDS, GIFT_DAYS, RISK_LEVELS, balanceSentence, balanceSpoken, creditLineSentence, creditRisk, paidByGifts, position, riskForVoucher,
    riskReasonSentence, riskReasons, riskLevelSentence, type BalanceMove, type CreditRiskFacts, type RiskCode,
} from '../credit-sight.js';
import { COMMUNITY_SHAPE_CARD_WORDS, communityShapeLines, creditSightLine, joinRuleLines, knownRuleLine } from '../community-shape-card.js';
import { readKnownRule } from '../known-rule.js';
import { setLanguage } from '../words.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
afterEach(() => setLanguage('en'));

/** A member with nothing that trips a rule: no trade, here a day, no line. */
const facts = (over: Partial<CreditRiskFacts> = {}): CreditRiskFacts => ({
    completed: 0, cancelled: 0, daysHere: 1,
    balance_c: 0, line_c: 0, usable_c: 0, giftPaid_c: 0,
    frozen: false, ring: false, disputeAgainst: false, lastSaleDays: 1, confirmed: false,
    insideOnly: false, outsideTrades: 0, outsidePartners: 0, branchPeople: 0, branchBelowZero: 0, writtenOff_c: 0,
    debtLinePct: 50, quietDays: 60,
    ...over,
});
const codes = (f: CreditRiskFacts) => riskReasons(f).filter((r) => r.level !== 'not_known').map((r) => r.code);

describe('1. the position: the balance beside the whole line', () => {
    it('+340.00, 0, −420 of 1,300, −437.13, −60 on a line of 0, paused (red when the sign is dropped or "using" reads the usable line)', () => {
        expect(position(34000, 130000, 130000)).toEqual({ sign: 'plus', balance_c: 34000, owed_c: 0, line_c: 130000, over_c: 0, paused: false });
        expect(balanceSentence(position(34000, 130000, 130000))).toBe('Balance +340');
        expect(balanceSentence(position(0, 0, 0))).toBe('Balance 0');
        // "using 420 of 1,300": of the whole line, though only 500 of it is usable now.
        expect(balanceSentence(position(-42000, 130000, 50000))).toBe('Balance −420 · using 420 of 1,300');
        expect(balanceSentence(position(-43713, 100000, 100000))).toBe('Balance −437.13 · using 437.13 of 1,000');
        expect(balanceSentence(position(-6000, 0, 0))).toBe('Balance −60 · 60 more than their credit line');
        expect(position(-6000, 0, 0).over_c).toBe(6000);
        expect(position(-60000, 100000, 50000).paused).toBe(true);
        expect(position(-50000, 100000, 50000).paused).toBe(false);
    });
    it('a real minus sign, and a screen reader hears "minus"', () => {
        expect(balanceSentence(position(-42000, 130000, 130000))).toContain('−');
        expect(balanceSentence(position(-42000, 130000, 130000))).not.toContain('-4');
        expect(balanceSpoken(position(-42000, 130000, 130000))).toBe('Balance minus 420 Beans, using 420 of 1,300');
    });
});

describe('the row\'s credit sentence', () => {
    it('no credit (with the Offers), all, part, asleep, frozen, can\'t give (red when the sentence reads the limit as usable)', () => {
        expect(creditLineSentence({ line_c: 0, usable_c: 0, liveOffers: 4 })).toBe('No credit yet · 4 live Offers');
        expect(creditLineSentence({ line_c: 0, usable_c: 0, liveOffers: 1 })).toBe('No credit yet · 1 live Offer');
        expect(creditLineSentence({ line_c: 0, usable_c: 0, liveOffers: null })).toBe('No credit yet');
        expect(creditLineSentence({ line_c: 130000, usable_c: 130000, liveOffers: 1 })).toBe('Credit line 1,300 · can use all of it now');
        expect(creditLineSentence({ line_c: 130000, usable_c: 50000, liveOffers: 1 })).toBe('Credit line 1,300 · can use 500 of it now');
        expect(creditLineSentence({ line_c: 50000, usable_c: 0, liveOffers: 0 })).toBe('Credit line 500 · asleep until they post an Offer');
        expect(creditLineSentence({ line_c: 0, usable_c: 0, liveOffers: 0, frozen: true })).toBe('Credit line frozen by an admin');
        expect(creditLineSentence({ line_c: 0, usable_c: 0, liveOffers: 0, cantGive: true })).toBe('Can’t be given credit right now');
    });
});

describe('2. credit risk: one fixture per rule, worst wins, each reason marked', () => {
    const ONE: Array<[string, Partial<CreditRiskFacts>, string, string]> = [
        ['frozen', { frozen: true }, 'high', 'admins'],
        ['over', { balance_c: -6000, line_c: 0 }, 'high', 'giver'],
        ['paused', { balance_c: -30000, line_c: 100000, usable_c: 20000 }, 'high', 'giver'],
        ['ring', { ring: true }, 'high', 'admins'],
        ['dispute', { disputeAgainst: true }, 'high', 'admins'],
        ['completion', { completed: 1, cancelled: 3 }, 'high', 'open'],
        ['written_off', { writtenOff_c: 100 }, 'high', 'admins'],
        ['over_half', { balance_c: -50100, line_c: 100000, usable_c: 100000 }, 'medium', 'giver'],
        ['below_zero_quiet', { balance_c: -100, line_c: 100000, usable_c: 100000, lastSaleDays: 60 }, 'medium', 'admins'],
        ['branch_below', { branchPeople: 4, branchBelowZero: 2 }, 'medium', 'admins'],
        ['inside_only', { completed: 1, insideOnly: true }, 'medium', 'admins'],
        ['cancelled', { completed: 7, cancelled: 2 }, 'medium', 'open'],
        ['confirmed', { confirmed: true }, 'low', 'admins'],
        ['established', { completed: 3, outsideTrades: 3, outsidePartners: 2, daysHere: 30 }, 'low', 'admins'],
    ];
    for (const [code, over, level, mark] of ONE) {
        it(`${code}: only that rule trips, at ${level}, marked ${mark} (red when a rule, a threshold or a mark moves)`, () => {
            expect(codes(facts(over))).toEqual([code]);
            const r = riskReasons(facts(over)).find((x) => x.code === code)!;
            expect([r.level, r.mark]).toEqual([level, mark]);
            expect(creditRisk(facts(over)).level).toBe(level);
            expect(riskReasonSentence(r)).toBeTruthy();
        });
    }
    it('almost all of the line with no sale for the quiet days: high, the admins\'', () => {
        const f = facts({ balance_c: -90000, line_c: 100000, usable_c: 100000, lastSaleDays: 90 });
        expect(codes(f)).toEqual(['almost_all_quiet', 'over_half', 'below_zero_quiet']);
        expect(riskReasons(f)[0]).toMatchObject({ level: 'high', mark: 'admins', values: { owed: 90000, line: 100000, days: 60 } });
    });
    it('the thresholds at their edges: half is the owner\'s line, two below zero of four, 3 trades with 2 people and 30 days', () => {
        expect(codes(facts({ balance_c: -50000, line_c: 100000, usable_c: 100000 }))).toEqual([]);
        expect(codes(facts({ balance_c: -30100, line_c: 100000, usable_c: 100000, debtLinePct: 30 }))).toEqual(['over_half']);
        expect(codes(facts({ branchPeople: 5, branchBelowZero: 2 }))).toEqual([]);
        expect(codes(facts({ completed: 3, outsideTrades: 3, outsidePartners: 2, daysHere: 29 }))).toEqual([]);
        expect(codes(facts({ completed: 2, cancelled: 2 }))).toEqual(['cancelled']);
        expect(codes(facts({ balance_c: -100, line_c: 100000, usable_c: 100000, lastSaleDays: 59 }))).toEqual([]);
        // Never sold counts as no sale.
        expect(codes(facts({ balance_c: -100, line_c: 100000, usable_c: 100000, lastSaleDays: null }))).toEqual(['below_zero_quiet']);
    });
    it('a balance above zero is never a reason to trust; nothing reads not known yet', () => {
        expect(creditRisk(facts({ balance_c: 500000, line_c: 100000, usable_c: 100000 })).level).toBe('not_known');
        expect(creditRisk(facts()).reasons.map((r) => r.code)).toEqual(['new']);
        expect(creditRisk(facts({ completed: 2 })).reasons.map((r) => r.code)).toEqual(['few_trades']);
    });
    it('worst wins, and the reasons shown are every high and medium one', () => {
        const r = creditRisk(facts({ ring: true, branchPeople: 2, branchBelowZero: 2, confirmed: true }));
        expect(r.level).toBe('high');
        expect(r.reasons.map((x) => x.code)).toEqual(['ring', 'branch_below']);
    });
    it('5. a voucher: the same level, only open and giver reasons, `more` where an admins\' reason moved it (red when an admins\' reason is marked open or giver)', () => {
        const f = facts({ balance_c: -90000, line_c: 100000, usable_c: 100000, lastSaleDays: 90, ring: true, disputeAgainst: true, frozen: false });
        const v = riskForVoucher(f);
        expect(v.level).toBe('high');
        expect(v.reasons.map((x) => x.code)).toEqual(['over_half']);
        expect(v.reasons[0]!.values).toEqual({ owed: 90000, line: 100000, pct: 50 });
        expect(v.more).toBe(true);
        expect(riskReasonSentence(v.reasons[0]!)).toBe('They owe 900 of 1,000: more than half.');
        // A giver reason that sets the level alone: nothing more to say.
        expect(riskForVoucher(facts({ balance_c: -6000, line_c: 0, ring: true })).more).toBe(false);
        // Low from a confirmation alone: the voucher reads not known yet's reason and that more can be said.
        const low = riskForVoucher(facts({ confirmed: true }));
        expect([low.level, low.more, low.reasons.map((x) => x.code).join()]).toEqual(['low', true, 'new']);
        for (const code of ['frozen', 'ring', 'almost_all_quiet', 'dispute', 'written_off', 'below_zero_quiet', 'branch_below', 'inside_only', 'confirmed', 'established']) {
            expect(riskReasons(facts({ frozen: true, ring: true, disputeAgainst: true, writtenOff_c: 1, balance_c: -95000, line_c: 100000, usable_c: 100000, lastSaleDays: 90, branchPeople: 2, branchBelowZero: 2, completed: 3, insideOnly: true, confirmed: true }))
                .filter((r) => r.code === code).every((r) => r.mark === 'admins'), code).toBe(true);
        }
    });
    it('each level reads its words; the sentences carry their figures', () => {
        expect(riskLevelSentence('not_known')).toBe('Credit risk: not known yet');
        expect(riskLevelSentence('high')).toBe('Credit risk: high');
        expect(riskReasonSentence({ code: 'paused', level: 'high', mark: 'giver', values: { owed: 30000, usable: 20000 } }))
            .toBe('Spending paused: they owe 300, more than the 200 their Offers unlock.');
        expect(riskReasonSentence({ code: 'over_half', level: 'medium', mark: 'giver', values: { owed: 40000, line: 100000, pct: 30 } }))
            .toBe('They owe 400 of 1,000: more than 30%.');
        expect(riskReasonSentence({ code: 'branch_below', level: 'medium', mark: 'admins', values: { n: 2, m: 3 } })).toBe('2 of the 3 people they stood behind are below zero.');
        expect(riskReasonSentence({ code: 'nope' as never, level: 'low', mark: 'open', values: {} })).toBeNull();
    });
});

// ── Amendment 2 (slice C8): a gift of Beans can't wash the word ───────────────────────────────────────────────────

const gift = (beansIn: number): BalanceMove => ({ delta_c: beansIn * 100, gift: true });
const own = (beans: number): BalanceMove => ({ delta_c: beans * 100, gift: false });
/** What the word reads them as owing: what they owe now, plus what gifts paid. History oldest first, as it happened. */
const readsOwing = (balanceBeans: number, oldestFirst: BalanceMove[]) => {
    const balance = balanceBeans * 100;
    return (Math.max(0, -balance) + paidByGifts(balance, [...oldestFirst].reverse())) / 100;
};

describe('24. paidByGifts: the table of amendment 2 §2', () => {
    // Each row: the moves of the last 30 days (oldest first), the balance now, and what the word reads them as owing.
    const ROWS: Array<[string, BalanceMove[], number, number]> = [
        ['owed 900; a friend sent 900 (the director\'s case: the gift paid it)', [gift(900)], 0, 900],
        ['owed 900; sold for 900 (their own sale repaid it: forgiven at once)', [own(900)], 0, 0],
        ['owed 100; a purchase held 800; cancelled and refunded (a refund is not a gift)', [own(-800), own(800)], -100, 100],
        ['owed 900; sent 900; then bought for 900 (the debt is back, nothing counted twice)', [gift(900), own(-900)], -900, 900],
        ['owed 0; sent 100; spent 100 (a gift on a balance at or above zero is not counted)', [gift(100), own(-100)], 0, 0],
        ['owed 900; sent 900; then sold for 500 (their sale earned back 500 of it)', [gift(900), own(500)], 500, 400],
        ['owed 900; sent 1,800 (a bigger gift does not clear more)', [gift(1800)], 900, 900],
        // The gift's row is older than GIFT_DAYS, so the server walks no row at all: the 30 days are over.
        ['owed 900; sent 900 on day 0; looked at on day 31 (the 30 days are over)', [], 0, 0],
    ];
    for (const [label, moves, balance, owing] of ROWS) {
        it(`${label} → reads ${owing} (red when a gift forgives, a sale or refund stops forgiving, or "balance less gifts" or an oldest-first walk replaces it)`, () => {
            expect(readsOwing(balance, moves)).toBe(owing);
        });
    }
    it('no moves at all: 0, whatever the balance; GIFT_DAYS is 30 (red when it moves)', () => {
        expect(paidByGifts(-90000, [])).toBe(0);
        expect(paidByGifts(0, [])).toBe(0);
        expect(paidByGifts(50000, [])).toBe(0);
        expect(GIFT_DAYS).toBe(30);
    });
    it('the walk runs newest first: fed oldest first, row 4 would count 1,800 (the order is the input\'s contract)', () => {
        expect(Math.max(0, 90000) + paidByGifts(-90000, [gift(900), own(-900)])).toBe(180000);
        expect(readsOwing(-900, [gift(900), own(-900)])).toBe(900);
    });
});

/** A seeded random number in [0, 1): the same 500 histories every run (mulberry32). */
function seeded(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let x = Math.imul(a ^ (a >>> 15), 1 | a);
        x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
}

describe('25. paidByGifts over 500 seeded random histories: the two properties of amendment 2 §3', () => {
    const rnd = seeded(20261112);
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
    interface History { start: number; moves: BalanceMove[] }
    const histories: History[] = Array.from({ length: 500 }, () => {
        const moves = Array.from({ length: int(0, 14) }, (): BalanceMove => {
            const g = rnd() < 0.3;
            // A gift always arrives (+); their own trading goes either way, to the hundredth.
            return { delta_c: g ? int(1, 150000) : int(-150000, 150000), gift: g };
        });
        return { start: int(-200000, 200000), moves };
    });
    const finalOf = (h: History) => h.start + h.moves.reduce((s, m) => s + m.delta_c, 0);
    const paidOf = (h: History) => paidByGifts(finalOf(h), [...h.moves].reverse());
    const countedOf = (h: History) => Math.max(0, -finalOf(h)) + paidOf(h);
    const giftsIn = (h: History) => h.moves.filter((m) => m.gift).reduce((s, m) => s + m.delta_c, 0);

    it('0 ≤ paid ≤ the gifts in the moves, and with no gift paid is 0 (red when the cap goes or own Beans count as a gift)', () => {
        let withGift = 0;
        for (const h of histories) {
            const paid = paidOf(h);
            expect(paid).toBeGreaterThanOrEqual(0);
            expect(paid).toBeLessThanOrEqual(giftsIn(h));
            if (!h.moves.some((m) => m.gift)) expect(paid).toBe(0);
            if (paid > 0) withGift++;
        }
        // The histories reach the case they are for.
        expect(withGift).toBeGreaterThan(50);
    });

    it('adding one gift anywhere never raises owed-now plus paid, nor any level (red when a gift can worsen a word)', () => {
        let lowered = 0;
        for (const h of histories) {
            const at = int(0, h.moves.length);
            const added: History = { start: h.start, moves: [...h.moves.slice(0, at), { delta_c: int(1, 150000), gift: true }, ...h.moves.slice(at)] };
            expect(countedOf(added)).toBeLessThanOrEqual(countedOf(h));
            if (countedOf(added) < countedOf(h)) lowered++;
            // The level the word reads, on a random line, with and without that gift.
            const line_c = int(0, 4) * 50000;
            const usable_c = int(0, line_c);
            const lastSaleDays = rnd() < 0.5 ? 90 : 1;
            const levelOf = (x: History) =>
                RISK_LEVELS.indexOf(creditRisk(facts({ balance_c: finalOf(x), giftPaid_c: paidOf(x), line_c, usable_c, lastSaleDays })).level);
            expect(levelOf(added)).toBeLessThanOrEqual(levelOf(h));
        }
        expect(lowered).toBeGreaterThan(50);
    });
});

describe('26. the five rules built from what someone owes, after a gift paid it', () => {
    // Each rule tripped alone (or with only the owed rules it implies), then the same member with the balance at 0 and
    // giftPaid_c what they owed.
    const ONE: Array<[RiskCode, Partial<CreditRiskFacts>, string]> = [
        ['over', { balance_c: -6000, line_c: 0 },
            'By their own trading they would owe 60, 60 more than their credit line allows. A gift of Beans paid 60 of it in the last 30 days.'],
        ['paused', { balance_c: -30000, line_c: 100000, usable_c: 20000 },
            'By their own trading they would owe 300, more than the 200 their Offers unlock. A gift of Beans paid 300 of it in the last 30 days.'],
        ['almost_all_quiet', { balance_c: -90000, line_c: 100000, usable_c: 100000, lastSaleDays: 90 },
            'By their own trading they would owe 900 of 1,000, almost all of it, and they have made no sale for 60 days. A gift of Beans paid 900 of it in the last 30 days.'],
        ['over_half', { balance_c: -50100, line_c: 100000, usable_c: 100000 },
            'By their own trading they would owe 501 of 1,000: more than half. A gift of Beans paid 501 of it in the last 30 days.'],
        ['below_zero_quiet', { balance_c: -100, line_c: 100000, usable_c: 100000, lastSaleDays: 60 },
            'By their own trading they would be below zero (1), with no sale for 60 days. A gift of Beans paid 1 of it in the last 30 days.'],
    ];
    for (const [code, over, sentence] of ONE) {
        it(`${code}: the same code, level and mark, the gift in its figures, the second form; with no gift it is gone; the row reads Balance 0 (red when a rule reads the stored position again, a mark moves, or the row reads the counted figure)`, () => {
            const before = facts(over);
            const owed = -before.balance_c;
            const was = riskReasons(before).find((r) => r.code === code)!;
            expect(was, code).toBeTruthy();
            const washed = facts({ ...over, balance_c: 0, giftPaid_c: owed });
            const now = riskReasons(washed);
            expect(now.map((r) => r.code)).toEqual(riskReasons(before).map((r) => r.code));
            const r = now.find((x) => x.code === code)!;
            expect([r.level, r.mark]).toEqual([was.level, was.mark]);
            expect(r.values).toEqual({ ...was.values, gift: owed, giftDays: GIFT_DAYS });
            expect(creditRisk(washed).level).toBe(creditRisk(before).level);
            const said = riskReasonSentence(r)!;
            expect(said).toBe(sentence);
            expect(said).not.toContain('They owe');
            expect(said).not.toContain('Spending paused');
            // Without the gift's figure, the rule is gone: owing nothing is owing nothing.
            expect(riskReasons(facts({ ...over, balance_c: 0, giftPaid_c: 0 })).some((x) => x.code === code)).toBe(false);
            // The row itself: the stored balance, straight, and Spending paused only from it.
            const row = position(washed.balance_c, washed.line_c, washed.usable_c);
            expect(balanceSentence(row)).toBe('Balance 0');
            expect(row.paused).toBe(false);
        });
    }
    it('the owner\'s own line: more than 30%, in its second form', () => {
        expect(riskReasonSentence({ code: 'over_half', level: 'medium', mark: 'giver', values: { owed: 40000, line: 100000, pct: 30, gift: 25000, giftDays: 30 } }))
            .toBe('By their own trading they would owe 400 of 1,000: more than 30%. A gift of Beans paid 250 of it in the last 30 days.');
    });
    it('Sam (owes 900 of 1,000, no sale for 90 days) after a friend sends 900: a voucher reads what they read before, in the second form', () => {
        const sam = facts({ balance_c: -90000, line_c: 100000, usable_c: 100000, lastSaleDays: 90, completed: 4 });
        const washed = { ...sam, balance_c: 0, giftPaid_c: 90000 };
        const [v0, v1] = [riskForVoucher(sam), riskForVoucher(washed)];
        expect([v1.level, v1.more, v1.reasons.map((r) => r.code)]).toEqual([v0.level, v0.more, v0.reasons.map((r) => r.code)]);
        expect([v1.level, v1.more]).toEqual(['high', true]);
        expect(riskReasonSentence(v1.reasons[0]!)).toBe('By their own trading they would owe 900 of 1,000: more than half. A gift of Beans paid 900 of it in the last 30 days.');
        // Without C8 the gift washed it: the word fell from high to not known yet.
        expect(riskForVoucher({ ...washed, giftPaid_c: 0 }).level).toBe('not_known');
    });
    it('a gift paid part: what they would owe is what they owe now plus what the gift paid; no other reason moves', () => {
        const f = facts({ balance_c: -20000, line_c: 100000, usable_c: 100000, giftPaid_c: 70000, ring: true, confirmed: true });
        const r = riskReasons(f);
        expect(r.find((x) => x.code === 'over_half')!.values).toEqual({ owed: 90000, line: 100000, pct: 50, gift: 70000, giftDays: 30 });
        expect(r.filter((x) => !['over_half'].includes(x.code)).every((x) => !('gift' in x.values))).toBe(true);
        expect(r.map((x) => x.code)).toEqual(['ring', 'over_half', 'confirmed', 'new']);
        // An odd figure (negative, not a number) counts as no gift.
        expect(riskReasons(facts({ balance_c: 0, line_c: 100000, usable_c: 100000, giftPaid_c: -5000 })).some((x) => x.code === 'over_half')).toBe(false);
        expect(riskReasons(facts({ balance_c: 0, line_c: 100000, usable_c: 100000, giftPaid_c: Number.NaN })).some((x) => x.code === 'over_half')).toBe(false);
    });
});

describe('13. the told sentence and the reworded rule line', () => {
    const TOLD = 'People who give credit here (the owners, admins and vouchers) can see your balance and your credit line, and each look is recorded.';
    it('the sentence is the design\'s', () => {
        expect(String(CREDIT_SIGHT_WORDS.told)).toBe(TOLD);
        expect(creditSightLine(true)).toBe(TOLD);
        expect(creditSightLine(false)).toBeNull();
        expect(creditSightLine(undefined)).toBeNull();
    });
    it('"How this community works": on a Beans node, absent with Beans off (global); in a known community the list line follows it, once', () => {
        expect(communityShapeLines({ beans: true, door: 'members' })).toContain(TOLD);
        expect(communityShapeLines({ beans: false, door: 'open', openJoin: true })).not.toContain(TOLD);
        const known = communityShapeLines({ beans: true, door: 'members', knownFloor: 100000, debtLinePct: 50, quietDays: 60 });
        const rule = known.find((l) => l.startsWith(TOLD));
        expect(rule).toBe(`${TOLD} The admins also keep a list of confirmed members who owe more than half their credit line, or are in debit and haven't made a sale for 60 days.`);
        expect(known.filter((l) => l.includes(TOLD)).length).toBe(1);
    });
    it('the join screen: the floor then both sentences in a known community, the told sentence alone elsewhere with Beans, nothing from an older node', () => {
        const known = readKnownRule({ known: true, knownFloor: 100000, debtLinePct: 30, quietDays: 90, debtLineFrom: null, quietDaysFrom: null, creditSight: true });
        const lines = joinRuleLines(known);
        expect(lines).toHaveLength(2);
        expect(lines[1]).toBe(`${TOLD} The admins also keep a list of confirmed members who owe more than 30% of their credit line, or are in debit and haven't made a sale for 90 days.`);
        expect(joinRuleLines(readKnownRule({ known: false, creditSight: true }))).toEqual([TOLD]);
        expect(readKnownRule({ known: false, creditSight: false })).toBeNull();
        expect(readKnownRule({ known: false })).toBeNull();
        // A door draws knownRuleLine alone: both sentences, so its "also" never stands on its own.
        expect(knownRuleLine(known)).toBe(lines[1]);
    });
    it('"can see a confirmed member\'s balance if" is in no catalog and no source any more (red when the old line survives beside the new)', () => {
        const OLD = "can see a confirmed member's balance if";
        const dirs = ['packages/beanpool-core/words', 'apps/native/words', 'apps/pwa/words', 'apps/server/words'];
        for (const d of dirs) {
            let files: string[] = [];
            try { files = readdirSync(join(ROOT, d)).filter((f) => f.endsWith('.json')); } catch { continue; }
            for (const f of files) expect(readFileSync(join(ROOT, d, f), 'utf8').includes(OLD), `${d}/${f}`).toBe(false);
        }
        expect(Object.values(COMMUNITY_SHAPE_CARD_WORDS).some((w) => String(w).includes(OLD))).toBe(false);
        // Every core catalog carries the told sentence and both list lines.
        for (const f of readdirSync(join(ROOT, 'packages/beanpool-core/words')).filter((x) => x.endsWith('.json') && x !== 'en.sources.json')) {
            const c = JSON.parse(readFileSync(join(ROOT, 'packages/beanpool-core/words', f), 'utf8'));
            expect(typeof c[TOLD], f).toBe('string');
            expect(c[String(COMMUNITY_SHAPE_CARD_WORDS.listLinePct)], f).toContain('{pct}');
        }
    });
});

describe('15. the words', () => {
    it('no Ʀ anywhere in the module, and every sentence goes through t()/tn()', () => {
        const src = readFileSync(join(ROOT, 'packages/beanpool-core/src/credit-sight.ts'), 'utf8');
        expect(src.includes('Ʀ')).toBe(false);
        // A balance is never said without its line: each balance sentence with a minus names the line or what is over it.
        expect(balanceSentence(position(-100, 100000, 100000))).toMatch(/of 1,000$/);
    });
    it('pseudo-localised, every sentence changes (none is hard-coded English)', () => {
        setLanguage('xx');
        expect(balanceSentence(position(0, 0, 0))).not.toBe('Balance 0');
        expect(creditLineSentence({ line_c: 0, usable_c: 0, liveOffers: null })).not.toBe('No credit yet');
        expect(riskLevelSentence('low')).not.toBe('Credit risk: low');
    });
    it('pseudo-localised, the five second forms and the gift sentence change too (amendment 2, test 15)', () => {
        const values = { owed: 90000, over: 10000, usable: 30000, line: 100000, days: 60, pct: 50, gift: 90000, giftDays: GIFT_DAYS };
        const codes: RiskCode[] = ['over', 'paused', 'almost_all_quiet', 'over_half', 'below_zero_quiet'];
        const english = codes.map((code) => riskReasonSentence({ code, level: 'high', mark: 'giver', values })!);
        setLanguage('xx');
        codes.forEach((code, i) => {
            const pseudo = riskReasonSentence({ code, level: 'high', mark: 'giver', values })!;
            expect(pseudo, code).not.toBe(english[i]);
            // Both sentences go through the words layer: neither half stays English.
            expect(pseudo, code).not.toContain('By their own trading');
            expect(pseudo, code).not.toContain('A gift of Beans paid');
        });
        expect(riskReasonSentence({ code: 'over_half', level: 'medium', mark: 'giver', values: { ...values, pct: 30 } })).not.toContain('By their own trading');
    });
});

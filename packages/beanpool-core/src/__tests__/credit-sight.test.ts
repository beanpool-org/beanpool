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
    CREDIT_SIGHT_WORDS, balanceSentence, balanceSpoken, creditLineSentence, creditRisk, position, riskForVoucher, riskReasonSentence,
    riskReasons, riskLevelSentence, type CreditRiskFacts,
} from '../credit-sight.js';
import { COMMUNITY_SHAPE_CARD_WORDS, communityShapeLines, creditSightLine, joinRuleLines, knownRuleLine } from '../community-shape-card.js';
import { readKnownRule } from '../known-rule.js';
import { setLanguage } from '../words.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
afterEach(() => setLanguage('en'));

/** A member with nothing that trips a rule: no trade, here a day, no line. */
const facts = (over: Partial<CreditRiskFacts> = {}): CreditRiskFacts => ({
    completed: 0, cancelled: 0, daysHere: 1,
    balance_c: 0, line_c: 0, usable_c: 0,
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
});

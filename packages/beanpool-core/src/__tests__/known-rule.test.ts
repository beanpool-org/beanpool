/**
 * A known community's rule as the apps say it (DESIGN-balance-rule-fable.md §1 to §4): the rule line and its half variant,
 * which of Home's two cards is owed, and what the sheet may say of the node's answer. Both apps draw these.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { communityShapeLines, joinRuleLines, knownRuleLine, waitingLineSentences, yourRuleLine } from '../community-shape-card.js';
import {
    KNOWN_RULE_WORDS, RULE_NOTICE_DAYS, confirmedBody, readKnownRule, readMemberStanding, readRuleSeen, ruleCardFor, ruleChangesTitle, ruleSeenNow,
    ruleStartsLine, stepBackAnswer, steppedBackLine, type KnownRule, type MemberStanding,
} from '../known-rule.js';
import { pseudoLocalise, setLanguage } from '../words.js';

const NOW = Date.UTC(2026, 10, 10, 2);
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();

/** The rule started a week ago, nothing waiting. */
const RULE: KnownRule = { knownFloor: 1000, debtLinePct: 50, quietDays: 60, ruleFrom: iso(NOW - 7 * DAY), debtLineFrom: null, quietDaysFrom: null };
const CONFIRMED_AT = iso(NOW - 30 * DAY);
const ME: MemberStanding = { confirmed: true, confirmedAt: CONFIRMED_AT };

afterEach(() => setLanguage('en'));

describe('the rule line', () => {
    it('says "half" at 50 and the percentage otherwise, in the community\'s numbers', () => {
        expect(knownRuleLine({ debtLinePct: 50, quietDays: 60 })).toBe("The admins can see a confirmed member's balance if they owe more than half their credit line, or stay in debit for 60 days without a sale. Each look is logged.");
        expect(knownRuleLine({ debtLinePct: 30, quietDays: 90 })).toBe("The admins can see a confirmed member's balance if they owe more than 30% of their credit line, or stay in debit for 90 days without a sale. Each look is logged.");
        expect(yourRuleLine({ debtLinePct: 50, quietDays: 60 })).toBe('If you owe more than half your credit line, or stay in debit for 60 days without a sale, the admins can see your balance. Each look is logged.');
        expect(yourRuleLine({ debtLinePct: 30, quietDays: 90 })).toBe('If you owe more than 30% of your credit line, or stay in debit for 90 days without a sale, the admins can see your balance. Each look is logged.');
    });

    it('an older node, which states no lines, draws no rule line and keeps its floor line', () => {
        expect(knownRuleLine({})).toBeNull();
        expect(knownRuleLine({ debtLinePct: 50 })).toBeNull();
        expect(yourRuleLine(null)).toBeNull();
        expect(communityShapeLines({ beans: true, door: 'members', knownFloor: 1000 }).filter(l => /admins can see/.test(l))).toEqual([]);
        expect(communityShapeLines({ beans: true, door: 'members', knownFloor: 1000 }).some(l => l.includes('1,000 Beans'))).toBe(true);
    });

    it('sits right under the floor line on "How this community works", and only with the floor', () => {
        const lines = communityShapeLines({ beans: true, door: 'members', knownFloor: 1000, debtLinePct: 50, quietDays: 60 });
        const floor = lines.findIndex(l => l.includes('(the known floor)'));
        expect(lines[floor + 1]).toBe(knownRuleLine({ debtLinePct: 50, quietDays: 60 }));
        expect(communityShapeLines({ beans: true, door: 'members', debtLinePct: 50, quietDays: 60 }).filter(l => /admins can see/.test(l))).toEqual([]);
    });

    it('the join screen draws the floor and the rule together, or nothing', () => {
        expect(joinRuleLines(RULE)).toEqual(['**Confirmed members** can owe up to 1,000 Beans (the known floor)', knownRuleLine(RULE)]);
        expect(joinRuleLines(null)).toEqual([]);
        expect(joinRuleLines({ knownFloor: 1000 })).toEqual([]);
    });

    it('a tightened line carries its date on the sheet, per line, the number the owner set', () => {
        const waiting = { ...RULE, debtLinePct: 30, debtLineFrom: '2026-11-16T04:00:00.000Z', quietDaysFrom: '2026-11-20T04:00:00.000Z', quietDays: 45 };
        expect(waitingLineSentences(waiting)).toEqual(['The line of 30% applies from 16 November.', 'The line of 45 days applies from 20 November.']);
        expect(waitingLineSentences(RULE)).toEqual([]);
        const lines = communityShapeLines({ beans: true, door: 'members', knownFloor: 1000, debtLinePct: 30, quietDays: 45 }, waiting);
        expect(lines.indexOf('The line of 30% applies from 16 November.')).toBe(lines.indexOf(knownRuleLine(waiting) as string) + 1);
    });

    it('goes through the words layer: each sentence bracketed in the pseudo-locale, {days} in the language\'s plural', () => {
        setLanguage('xx');
        const days = pseudoLocalise('{n} days').replace('{n}', '60');
        expect(knownRuleLine({ debtLinePct: 50, quietDays: 60 })).toBe(pseudoLocalise(String(KNOWN_RULE_SOURCE)).replace('{days}', days));
    });
});
const KNOWN_RULE_SOURCE = "The admins can see a confirmed member's balance if they owe more than half their credit line, or stay in debit for {days} without a sale. Each look is logged.";

describe('reading the node', () => {
    it('a whole known community only: an older node, a plain community and a bad answer are null', () => {
        expect(readKnownRule({ known: true, knownFloor: 1000, debtLinePct: 50, quietDays: 60, ruleFrom: RULE.ruleFrom, debtLineFrom: null, quietDaysFrom: null })).toEqual(RULE);
        expect(readKnownRule({ known: false })).toBeNull();
        expect(readKnownRule(null)).toBeNull();
        expect(readKnownRule({ error: 'Not found' })).toBeNull();
        expect(readKnownRule({ known: true, knownFloor: '1000', debtLinePct: 50, quietDays: 60 })).toBeNull();
        expect(readKnownRule({ known: true, knownFloor: 1000, debtLinePct: 50, quietDays: 60, ruleFrom: 'soon' })?.ruleFrom).toBeNull();
    });

    it('a node older than the rule says nothing of the member, which is not "unconfirmed"', () => {
        expect(readMemberStanding({ publicKey: 'k', features: {} })).toBeNull();
        expect(readMemberStanding({ confirmed: false, confirmedAt: null })).toEqual({ confirmed: false, confirmedAt: null });
        expect(readMemberStanding({ confirmed: true, confirmedAt: CONFIRMED_AT })).toEqual(ME);
    });

    it('a kept value that is not one reads as nothing seen', () => {
        expect(readRuleSeen(null)).toBeNull();
        expect(readRuleSeen('x')).toBeNull();
        expect(readRuleSeen({ confirmedAt: 3 })).toEqual({ confirmedAt: null, ruleKey: null });
    });
});

describe('which card Home owes', () => {
    const seenOK = (me: MemberStanding, rule: KnownRule, now = NOW) => ruleSeenNow(me, rule, now);

    it('nobody unconfirmed, and nothing without both answers', () => {
        expect(ruleCardFor({ confirmed: false, confirmedAt: null }, RULE, null, NOW)).toBeNull();
        expect(ruleCardFor(null, RULE, null, NOW)).toBeNull();
        expect(ruleCardFor(ME, null, null, NOW)).toBeNull();
    });

    it('shows once on the change to confirmed: after OK it stays away', () => {
        expect(ruleCardFor(ME, RULE, null, NOW)).toEqual({ kind: 'confirmed' });
        expect(ruleCardFor(ME, RULE, seenOK(ME, RULE), NOW)).toBeNull();
    });

    it('shows again after a re-confirmation, even if this app never saw them unconfirmed', () => {
        const seen = seenOK(ME, RULE);
        expect(ruleCardFor({ confirmed: true, confirmedAt: iso(NOW - DAY) }, RULE, seen, NOW)).toEqual({ kind: 'confirmed' });
    });

    describe('the first 14 days', () => {
        const from = NOW + 6 * DAY;
        const notice: KnownRule = { ...RULE, ruleFrom: iso(from) };
        const stamp = from - RULE_NOTICE_DAYS * DAY;

        it('a member confirmed before the notice gets the date, never "the admins can see" as if it had started', () => {
            const before = { confirmed: true, confirmedAt: iso(stamp - DAY) };
            expect(ruleCardFor(before, notice, null, NOW)).toEqual({ kind: 'rule-changes', on: iso(from), first: true });
        });

        it('after OK they aren\'t told again, then or when it starts', () => {
            const before = { confirmed: true, confirmedAt: iso(stamp - DAY) };
            const seen = seenOK(before, notice);
            expect(ruleCardFor(before, notice, seen, NOW)).toBeNull();
            expect(ruleCardFor(before, notice, seen, from + DAY)).toBeNull();
        });

        it('one who never opened the app in the window is told they are confirmed, under a rule that now applies', () => {
            const before = { confirmed: true, confirmedAt: iso(stamp - DAY) };
            expect(ruleCardFor(before, notice, null, from + DAY)).toEqual({ kind: 'confirmed' });
        });

        it('a member confirmed under the rule gets the confirmed card, not a date that isn\'t theirs', () => {
            expect(ruleCardFor({ confirmed: true, confirmedAt: iso(stamp + DAY) }, notice, null, NOW)).toEqual({ kind: 'confirmed' });
        });
    });

    describe('a tightened line', () => {
        const date = iso(NOW + 9 * DAY);
        const tightened: KnownRule = { ...RULE, debtLinePct: 30, debtLineFrom: date };

        it('a member who has seen the rule is told, keyed on the date and not on any setting', () => {
            const seen = seenOK(ME, RULE);
            expect(ruleCardFor(ME, tightened, seen, NOW)).toEqual({ kind: 'rule-changes', on: date, first: false });
        });

        it('shows once, however many other settings move', () => {
            const seen = seenOK(ME, tightened);
            expect(ruleCardFor(ME, tightened, seen, NOW)).toBeNull();
            expect(ruleCardFor(ME, { ...tightened, knownFloor: 1500 }, seen, NOW)).toBeNull();
        });

        it('a loosened line waits for nothing and shows nothing', () => {
            expect(ruleCardFor(ME, { ...RULE, debtLinePct: 70 }, seenOK(ME, RULE), NOW)).toBeNull();
        });

        it('a second tightening is a new date, and shows again', () => {
            const seen = seenOK(ME, tightened);
            const again = { ...tightened, debtLinePct: 20, debtLineFrom: iso(NOW + 12 * DAY) };
            expect(ruleCardFor(ME, again, seen, NOW)).toEqual({ kind: 'rule-changes', on: again.debtLineFrom, first: false });
        });

        it('the earliest of two lines waiting: "before then" is never too late', () => {
            const both = { ...tightened, quietDaysFrom: iso(NOW + 3 * DAY) };
            expect(ruleCardFor(ME, both, seenOK(ME, RULE), NOW)).toEqual({ kind: 'rule-changes', on: both.quietDaysFrom, first: false });
        });

        it('newly confirmed while a line waits: one card, in today\'s numbers, and no second card after it', () => {
            expect(ruleCardFor(ME, tightened, null, NOW)).toEqual({ kind: 'confirmed' });
            expect(ruleCardFor(ME, tightened, seenOK(ME, tightened), NOW)).toBeNull();
        });
    });
});

describe('what the cards and panels say', () => {
    it('the confirmed card names the floor in the language\'s numbers', () => {
        expect(confirmedBody(RULE)).toBe('An admin confirmed you as a member they know. Your credit line can now go to 1,000 Beans.');
    });

    it('the changing rule\'s title carries the date', () => {
        expect(ruleChangesTitle('2026-11-16T04:00:00.000Z')).toBe("Your community's rule on what the admins can see changes on 16 November.");
    });

    it('the stay-out sentence is true for a member past their ordinary line (S1, its author notes 2)', () => {
        expect(KNOWN_RULE_WORDS.stayOut).toMatch(/until you're back within it/);
    });

    it('the panels name the start while it\'s ahead, and only then; it isn\'t "nobody", members confirmed under it are listed', () => {
        const line = ruleStartsLine({ from: '2026-11-16T04:00:00.000Z', started: false });
        expect(line).toBe('The rule starts on 16 November. Until then, only members confirmed since the notice began are listed.');
        expect(ruleStartsLine({ from: '2026-11-16T04:00:00.000Z', started: true })).toBeNull();
        expect(ruleStartsLine({ from: null, started: false })).toBeNull();
        expect(ruleStartsLine(undefined)).toBeNull();
    });
});

describe('the step-back\'s answer', () => {
    it('only the node\'s `revoked` is a success, and it carries whether they still owe past the line', async () => {
        expect(await stepBackAnswer(async () => ({ id: 'c1', status: 'revoked', owing: false }))).toEqual({ ok: true, owing: false });
        expect(await stepBackAnswer(async () => ({ id: 'c1', status: 'revoked', owing: true }))).toEqual({ ok: true, owing: true });
        for (const page of [{}, null, 'ok', { status: 'confirmed' }]) {
            expect((await stepBackAnswer(async () => page)).ok).toBe(false);
        }
    });

    it('says the node\'s own refusal, and tells "couldn\'t reach" from "try later"', async () => {
        const out = (e: unknown) => stepBackAnswer(async () => { throw e; });
        expect(await out(new Error('You are not confirmed.'))).toEqual({ ok: false, error: 'You are not confirmed.' });
        expect(await out(new TypeError('Network request failed'))).toEqual({ ok: false, error: 'Not saved: the community could not be reached.' });
        expect(await out(new Error('Request failed: 500'))).toEqual({ ok: false, error: 'Not saved. Try again later.' });
        expect(await out(new SyntaxError('Unexpected token'))).toEqual({ ok: false, error: 'Not saved. Try again later.' });
    });

    it('what the sheet says once done depends on what they owe', () => {
        expect(steppedBackLine(false)).toBe("You've stepped back. You have the ordinary credit line now.");
        expect(steppedBackLine(true)).toMatch(/can't borrow more.*until you're back within it/);
    });
});

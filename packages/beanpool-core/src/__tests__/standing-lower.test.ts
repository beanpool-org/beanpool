/**
 * A short week: lowering one period of a standing deal, the pure half (scratch/fable-design/DESIGN-getting-paid-fable.md §3,
 * §5, slice L0; Marty took every recommendation, 11 Nov 2026). The period's amount rule, the one rule for the four steps
 * (dealMoves: lower, askLower, answerLower, takeBackAsk), the card's lines with a period lowered, the payee's live Needs you
 * line for an ask (amber, counted), and every sentence of §3 in its week and month twin. The node's half is driven for real
 * in apps/server test-standing-lower.ts.
 */
import { describe, expect, it } from 'vitest';
import {
    STANDING_ASKS_PER_PERIOD,
    isStandingLowerAmount,
    standingAskNeedsLine,
    standingDueAmount,
    standingLines,
    standingLowerChoices,
    standingLowerMoves,
    standingLowerable,
    standingNeedsLines,
    standingPanel,
    standingPeriodAmount,
    standingStopConfirm,
    standingTakeUpLines,
    type StandingDealRow,
} from '../standing-deal.js';
import { dealMoves } from '../deal-step.js';
import { needsYouCounts } from '../needs-you.js';

const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const START = '2026-11-11T08:00:00.000Z';
// Room at Rob's: 200 Beans a week from 11 Nov; week 1 paid; week 2 is due on 18 Nov, its grace ends 21 Nov 20:00.
const row = (over: Partial<StandingDealRow> = {}): StandingDealRow => ({
    id: 'tx-1', postId: 'post-1', postTitle: "Room at Rob's", status: 'completed', buyerPublicKey: 'kim', buyerCallsign: 'Kim',
    sellerPublicKey: 'rob', sellerCallsign: 'Rob', createdAt: START, completedAt: START, standingId: 'sd-1', periodNo: 1, standingPhase: 'paid',
    standingBeans_c: 20000, standingUnit: 'week', standingMaxPeriods: null, standingNextDueAt: '2026-11-18T08:00:00.000Z', standingStartsAt: START,
    standingShortSince: null, standingStopped: false, amount_c: 20000, standingAsksLeft: 3, standingAsk: null, ...over,
});
const short = (over: Partial<StandingDealRow> = {}) => row({ standingPhase: 'short', standingShortSince: '2026-11-18T08:00:00.000Z', standingNextDueAt: '2026-11-18T09:00:00.000Z', ...over });
const ask = (beans_c: number, periodNo = 2) => ({ id: 'chg-1', beans_c, periodNo, askedAt: '2026-11-14T08:00:00.000Z' });

describe("the period's amount (design §5)", () => {
    it('the price, unless a change is agreed: then the smallest agreed, never above the price or below 0', () => {
        expect(standingPeriodAmount(20000)).toBe(20000);
        expect(standingPeriodAmount(20000, [{ beans_c: 10000, state: 'asked' }, { beans_c: 5000, state: 'declined' }, { beans_c: 0, state: 'withdrawn' }, { beans_c: 0, state: 'lapsed' }])).toBe(20000);
        expect(standingPeriodAmount(20000, [{ beans_c: 10000, state: 'agreed' }])).toBe(10000);
        // Lowered again: the smallest wins, whatever the order; a later, higher one never raises it back.
        expect(standingPeriodAmount(20000, [{ beans_c: 10000, state: 'agreed' }, { beans_c: 5000, state: 'agreed' }, { beans_c: 15000, state: 'agreed' }])).toBe(5000);
        expect(standingPeriodAmount(20000, [{ beans_c: 0, state: 'agreed' }])).toBe(0);
        // Nothing that isn't whole hundredths, below 0 or above the price counts.
        expect(standingPeriodAmount(20000, [{ beans_c: 25000, state: 'agreed' }, { beans_c: -100, state: 'agreed' }, { beans_c: 99.5, state: 'agreed' }, { beans_c: '50', state: 'agreed' }])).toBe(20000);
    });

    it('a new amount is whole hundredths from 0 up to just under what the period costs now', () => {
        expect([isStandingLowerAmount(0, 20000), isStandingLowerAmount(19999, 20000), isStandingLowerAmount(10000, 20000)]).toEqual([true, true, true]);
        expect([isStandingLowerAmount(20000, 20000), isStandingLowerAmount(20001, 20000), isStandingLowerAmount(-1, 20000)]).toEqual([false, false, false]);
        expect([isStandingLowerAmount(100.5, 20000), isStandingLowerAmount('100', 20000), isStandingLowerAmount(null, 20000), isStandingLowerAmount(0, 0)]).toEqual([false, false, false, false]);
    });

    it('the amount due on the row: the lowered one when it is below the price, else the price', () => {
        expect(standingDueAmount(row())).toBe(20000);
        expect(standingDueAmount(row({ standingDueBeans_c: 10000 }))).toBe(10000);
        expect(standingDueAmount(row({ standingDueBeans_c: 0 }))).toBe(0);
        expect(standingDueAmount(row({ standingDueBeans_c: 30000 }))).toBe(20000);
        expect(standingDueAmount(row({ standingDueBeans_c: -5 }))).toBe(20000);
    });

    it('the sheet offers half of what it costs now and 0; nothing below a hundredth', () => {
        expect(standingLowerChoices(20000)).toEqual([{ beans_c: 10000, label: '100 Beans (half)' }, { beans_c: 0, label: '0 Beans' }]);
        expect(standingLowerChoices(1).map(c => c.beans_c)).toEqual([0]);
        expect(standingLowerChoices(0)).toEqual([]);
    });
});

describe('the one rule for the four steps (design §3.1; dealMoves)', () => {
    const moves = (tx: StandingDealRow, me: string) => {
        const m = dealMoves(tx, me)!;
        return { lower: m.lower, askLower: m.askLower, answerLower: m.answerLower, takeBackAsk: m.takeBackAsk };
    };

    it('paid, nothing asked: the payee may lower the next week, the payer may ask; a stranger is shown nothing', () => {
        expect(moves(row(), 'rob')).toEqual({ lower: true, askLower: false, answerLower: false, takeBackAsk: false });
        expect(moves(row(), 'kim')).toEqual({ lower: false, askLower: true, answerLower: false, takeBackAsk: false });
        expect(dealMoves(row(), 'stranger')).toBeNull();
        expect(standingLowerMoves(row(), 'stranger')).toEqual({ lower: false, askLower: false, answerLower: false, takeBackAsk: false });
    });

    it('short: the same steps, for the unpaid week', () => {
        expect(moves(short(), 'rob').lower).toBe(true);
        expect(moves(short(), 'kim').askLower).toBe(true);
        expect(standingLowerable(short())).toMatchObject({ n: 2, short: true, from: '2026-11-18T08:00:00.000Z', price_c: 20000, amount_c: 20000 });
    });

    it('an ask open: the payee answers it (and may not lower alone meanwhile), the payer may take it back and not ask again', () => {
        const open = row({ standingAsk: ask(10000) });
        expect(moves(open, 'rob')).toEqual({ lower: false, askLower: false, answerLower: true, takeBackAsk: false });
        expect(moves(open, 'kim')).toEqual({ lower: false, askLower: false, answerLower: false, takeBackAsk: true });
    });

    it('an ask about another period than the one due is no open ask', () => {
        expect(standingLowerable(row({ standingAsk: ask(10000, 1) }))!.ask).toBeNull();
    });

    it('no asks left: the payer may not ask again this week; the payee may still lower it', () => {
        expect(moves(row({ standingAsksLeft: 0 }), 'kim').askLower).toBe(false);
        expect(moves(row({ standingAsksLeft: 0 }), 'rob').lower).toBe(true);
        expect(STANDING_ASKS_PER_PERIOD).toBe(3);
    });

    it('already 0: nothing left to lower or ask for', () => {
        expect(moves(row({ standingDueBeans_c: 0 }), 'rob').lower).toBe(false);
        expect(moves(row({ standingDueBeans_c: 0 }), 'kim').askLower).toBe(false);
    });

    it('never a period already paid, or one that will never come: stopped, the count reached, ended', () => {
        for (const tx of [row({ standingStopped: true }), row({ standingMaxPeriods: 1 }), row({ standingPhase: 'ended' }), row({ standingId: null, standingPhase: null })]) {
            expect(standingLowerable(tx)).toBeNull();
            expect(standingLowerMoves(tx, 'rob')).toEqual({ lower: false, askLower: false, answerLower: false, takeBackAsk: false });
            expect(standingLowerMoves(tx, 'kim')).toEqual({ lower: false, askLower: false, answerLower: false, takeBackAsk: false });
        }
        // The count not yet reached: week 2 of 2 can still be lowered before it is paid.
        expect(standingLowerable(row({ standingMaxPeriods: 2 }))!.n).toBe(2);
    });

    it('a node that takes no lowering (no standingAsksLeft on its rows) gets no button that would fail', () => {
        expect(standingLowerable(row({ standingAsksLeft: undefined }))).toBeNull();
        expect(moves(row({ standingAsksLeft: null }), 'rob').lower).toBe(false);
        expect(moves(row({ standingAsksLeft: null }), 'kim').askLower).toBe(false);
    });

    it('a keeper acts as the enterprise side they keep', () => {
        const ent = row({ sellerPublicKey: 'eggs-co', sellerCallsign: 'Eggs Co' });
        const m = dealMoves(ent, 'keeper', ['eggs-co'])!;
        expect([m.actingAs, m.lower, m.askLower]).toEqual(['eggs-co', true, false]);
    });
});

describe('the card with a period lowered (design §3.2, both apps from standingPanel)', () => {
    it('agreed, not yet due: the next half says the lowered amount, by agreement, each side', () => {
        const tx = row({ standingDueBeans_c: 10000 });
        expect(standingPanel(tx, 'kim', day)!.status).toBe("This week's 200 went to Rob on 11 Nov · next week is 100 Beans by agreement, on 18 Nov");
        expect(standingPanel(tx, 'rob', day)!.status).toBe("Kim's standing deal · 200 Beans a week · paid for this week on 11 Nov · next week is 100 Beans by agreement, on 18 Nov");
    });

    it('a lowered week paid: what went, by agreement, and the next at the price', () => {
        const tx = row({ amount_c: 10000, periodNo: 2, completedAt: '2026-11-18T08:00:00.000Z', standingNextDueAt: '2026-11-25T08:00:00.000Z' });
        expect(standingPanel(tx, 'kim', day)!.status).toBe("This week's 100 went to Rob on 18 Nov (by agreement, not 200) · the next 200 go on 25 Nov");
        expect(standingPanel(tx, 'rob', day)!.status).toBe("Kim's standing deal · 200 Beans a week · paid for this week on 18 Nov: 100 by agreement · next 200 on 25 Nov");
    });

    it('a week at 0: the same words for both sides', () => {
        const tx = row({ amount_c: 0, periodNo: 2, completedAt: '2026-11-18T08:00:00.000Z', standingNextDueAt: '2026-11-25T08:00:00.000Z' });
        expect(standingPanel(tx, 'kim', day)!.status).toBe('This week is 0 Beans by agreement · the next 200 go on 25 Nov');
        expect(standingPanel(tx, 'rob', day)!.status).toBe('This week is 0 Beans by agreement · the next 200 go on 25 Nov');
        const both = row({ amount_c: 0, standingDueBeans_c: 5000, periodNo: 2, standingNextDueAt: '2026-11-25T08:00:00.000Z' });
        expect(standingPanel(both, 'rob', day)!.status).toBe('This week is 0 Beans by agreement · next week is 50 Beans by agreement, on 25 Nov');
    });

    it('both lowered: this week and next, each side', () => {
        const tx = row({ amount_c: 10000, standingDueBeans_c: 5000, periodNo: 2, completedAt: '2026-11-18T08:00:00.000Z', standingNextDueAt: '2026-11-25T08:00:00.000Z' });
        expect(standingPanel(tx, 'kim', day)!.status).toBe("This week's 100 went to Rob on 18 Nov (by agreement, not 200) · next week is 50 Beans by agreement, on 25 Nov");
        expect(standingPanel(tx, 'rob', day)!.status).toBe("Kim's standing deal · 200 Beans a week · paid for this week on 18 Nov: 100 by agreement · next week is 50 Beans by agreement, on 25 Nov");
    });

    it("an ask open changes nothing in the status, and has its own line and button for each side", () => {
        const tx = row({ standingAsk: ask(10000) });
        const p = standingPanel(tx, 'kim', day)!;
        const q = standingPanel(tx, 'rob', day)!;
        expect(p.status).toBe("This week's 200 went to Rob on 11 Nov · the next 200 go on 18 Nov");
        expect([p.askLine, p.askAction, p.lowerLink]).toEqual(['You asked to pay 100 Beans for the week from 18 Nov · waiting for Rob', { move: 'takeBack', label: 'Take it back' }, null]);
        expect([q.askLine, q.askAction, q.lowerLink]).toEqual(['⚠️ Kim asks to pay 100 Beans for the week from 18 Nov', { move: 'answer', label: 'Answer' }, null]);
    });

    it('the quiet link: next week while paid, this week while short; month twins', () => {
        expect(standingPanel(row(), 'kim', day)!.lowerLink).toBe('Ask to pay less next week…');
        expect(standingPanel(row(), 'rob', day)!.lowerLink).toBe('Lower next week…');
        expect(standingPanel(short(), 'kim', day)!.lowerLink).toBe('Ask to pay less this week…');
        expect(standingPanel(short(), 'rob', day)!.lowerLink).toBe('Lower this week…');
        const month = row({ standingUnit: 'month', standingNextDueAt: '2026-12-11T08:00:00.000Z' });
        expect([standingPanel(month, 'kim', day)!.lowerLink, standingPanel(month, 'rob', day)!.lowerLink]).toEqual(['Ask to pay less next month…', 'Lower next month…']);
        expect(standingPanel(row({ standingStopped: true }), 'rob', day)!.lowerLink).toBeNull();
        // A row as an older node answers it: no link at all.
        expect(standingPanel(row({ standingAsksLeft: undefined }), 'rob', day)!.lowerLink).toBeNull();
    });

    it("short and lowered: the warning, the Needs you line and Stop now name the week's own amount, not the price", () => {
        const tx = short({ standingDueBeans_c: 10000 });
        expect(standingPanel(tx, 'kim', day)!.status).toBe("⚠️ This week's 100 Beans couldn't be paid · 100 needed by 21 Nov or it ends");
        const lines = standingNeedsLines([tx], 'kim', Date.parse('2026-11-19T09:00:00.000Z'), day);
        expect(lines.map(l => l.label)).toEqual(["Room at Rob's: 100 Beans 1 day overdue · until 21 Nov"]);
        expect(standingStopConfirm(tx, 'kim', day).body).toContain("This week's 100 Beans aren't paid");
        // Unlowered, as before.
        expect(standingPanel(short(), 'kim', day)!.status).toBe("⚠️ This week's 200 Beans couldn't be paid · 200 needed by 21 Nov or it ends");
    });
});

describe("the payee's live line for an ask (design §3.3)", () => {
    it('amber and counted, to the deal, in the push\'s own words; the payer gets none', () => {
        const tx = row({ standingAsk: ask(10000) });
        const line = standingAskNeedsLine(tx, 'rob', day)!;
        expect(line).toEqual({ kind: 'ask', role: 'payee', label: "Kim asks to pay 100 Beans, not 200, for the week from 18 Nov of Room at Rob's.", accent: true, standingId: 'sd-1', txId: 'tx-1', postId: 'post-1' });
        expect(needsYouCounts({ kind: 'deal', accent: line.accent })).toBe(true);
        expect(standingAskNeedsLine(tx, 'kim', day)).toBeNull();
        expect(standingAskNeedsLine(tx, 'stranger', day)).toBeNull();
        expect(standingAskNeedsLine(row(), 'rob', day)).toBeNull();
    });

    it("says what it costs now when it was lowered before ('not 150')", () => {
        const tx = row({ standingDueBeans_c: 15000, standingAsk: ask(10000) });
        expect(standingAskNeedsLine(tx, 'rob', day)!.label).toBe("Kim asks to pay 100 Beans, not 150, for the week from 18 Nov of Room at Rob's.");
    });

    it('a short deal with an ask open: the payee has both lines, the short one calm and the ask amber; one each per deal', () => {
        const tx = short({ standingAsk: ask(0) });
        const lines = standingNeedsLines([tx, tx], 'rob', Date.parse('2026-11-19T09:00:00.000Z'), day);
        expect(lines.map(l => [l.kind, l.accent])).toEqual([['short', false], ['ask', true]]);
        expect(standingNeedsLines([tx], 'kim', Date.parse('2026-11-19T09:00:00.000Z'), day).map(l => l.kind)).toEqual(['short']);
    });
});

describe('the words of §3, a week twin and a month twin each', () => {
    it('the take-up line', () => {
        const lines = standingTakeUpLines({ unit: 'week', beans: 20000, title: "Room at Rob's", payeeName: 'Rob', startsAt: Date.parse(START), periods: 4 }, day);
        expect(lines.askLower).toBe('Short one week? You can ask Rob to lower it.');
        expect(standingLines.takeUpAskLower('month', 'Rob')).toBe('Short one month? You can ask Rob to lower it.');
    });

    it("the payer's sheet: never a pronoun for the payee", () => {
        expect(standingLines.askTitle()).toBe('Ask to pay less?');
        expect(standingLines.askAbout('week', "Room at Rob's", '18 Nov', 20000)).toBe("Room at Rob's · the week from 18 Nov · 200 Beans");
        expect(standingLines.askAbout('month', "Room at Rob's", '18 Nov', 20000)).toBe("Room at Rob's · the month from 18 Nov · 200 Beans");
        expect(standingLines.askUntilYes('Rob', 20000, '18 Nov')).toBe('Rob has to say yes. Until then nothing changes: the full 200 Beans go on 18 Nov if you have them.');
        expect(standingLines.askUntilYesShort('Rob', 20000, '21 Nov')).toBe('Rob has to say yes. Until then nothing changes: we keep trying for the full 200 Beans until 21 Nov.');
        expect(standingLines.askCountsAsPaid('week', 'Rob')).toBe('If Rob says yes, that week counts as paid in full here. Anything else you two agree is between you; BeanPool keeps no record of it.');
        expect(standingLines.askCountsAsPaid('month', 'Rob')).toBe('If Rob says yes, that month counts as paid in full here. Anything else you two agree is between you; BeanPool keeps no record of it.');
        expect([standingLines.askButton('Rob'), standingLines.choiceOther()]).toEqual(['Ask Rob', 'Another amount']);
        const sheet = [standingLines.askUntilYes('Rob', 20000, '18 Nov'), standingLines.askUntilYesShort('Rob', 20000, '21 Nov'), standingLines.askCountsAsPaid('week', 'Rob')].join(' ');
        expect(sheet).not.toMatch(/\b(he|she|him|her|his)\b/i);
    });

    it('the payee answering, and lowering alone', () => {
        expect(standingLines.answerTitle('Kim')).toBe('Kim asks to pay less');
        expect(standingLines.answerAbout('week', "Room at Rob's", '18 Nov')).toBe("Room at Rob's · the week from 18 Nov");
        expect(standingLines.answerInstead(10000, 20000)).toBe('100 Beans instead of 200');
        expect(standingLines.answerCountsAsPaid('week', 20000)).toBe('If you say yes, that week counts as paid in full here: nothing more is owed through the app for it. The week after is 200 Beans again.');
        expect(standingLines.answerCountsAsPaid('month', 20000)).toBe('If you say yes, that month counts as paid in full here: nothing more is owed through the app for it. The month after is 200 Beans again.');
        expect([standingLines.answerYes(10000), standingLines.answerNo(20000)]).toEqual(['Yes, 100 Beans', 'No, keep 200']);
        expect([standingLines.lowerTitle('week', false), standingLines.lowerTitle('week', true), standingLines.lowerTitle('month', false), standingLines.lowerTitle('month', true)])
            .toEqual(['Lower next week?', 'Lower this week?', 'Lower next month?', 'Lower this month?']);
        expect(standingLines.lowerCountsAsPaid('week', 'Kim', 20000, '18 Nov', 20000))
            .toBe('Kim pays this instead of 200 Beans for the week from 18 Nov, and that week counts as paid in full here. You can lower it again, not raise it back. The week after is 200 Beans again.');
        expect(standingLines.lowerButton(10000)).toBe('Lower to 100 Beans');
    });

    it('the bell, the pushes and the record', () => {
        expect(standingLines.saidYes('week', 'Rob', '18 Nov', "Room at Rob's", 10000, 20000)).toBe("Rob said yes: the week from 18 Nov of Room at Rob's is 100 Beans, not 200. It counts as paid in full here.");
        expect(standingLines.saidNo('week', 'Rob', '18 Nov', "Room at Rob's", 20000)).toBe("Rob said no: the week from 18 Nov of Room at Rob's stays 200 Beans.");
        expect(standingLines.loweredBy('week', 'Rob', '18 Nov', "Room at Rob's", 10000)).toBe("Rob lowered the week from 18 Nov of Room at Rob's to 100 Beans. It counts as paid in full here.");
        expect(standingLines.askLapsed('week', '18 Nov')).toBe("Your ask to pay less for the week from 18 Nov wasn't answered in time.");
        expect(standingLines.memoLowered('week', "Room at Rob's", 4, 10000, 20000)).toBe("Standing deal · Room at Rob's · week 4 · 100 of 200 Beans by agreement");
        expect(standingLines.memoLowered('month', "Room at Rob's", 4, 10000, 20000)).toBe("Standing deal · Room at Rob's · month 4 · 100 of 200 Beans by agreement");
    });

    it('every new sentence has its month twin, says Beans and nothing it never says', () => {
        const pairs: Array<[string, string]> = [
            [standingLines.askLowerLink('week', false), standingLines.askLowerLink('month', false)],
            [standingLines.lowerLink('week', true), standingLines.lowerLink('month', true)],
            [standingLines.askedNotice('week', 'Kim', 10000, 20000, '18 Nov', 'Room'), standingLines.askedNotice('month', 'Kim', 10000, 20000, '18 Nov', 'Room')],
            [standingLines.saidYes('week', 'Rob', '18 Nov', 'Room', 10000, 20000), standingLines.saidYes('month', 'Rob', '18 Nov', 'Room', 10000, 20000)],
            [standingLines.saidNo('week', 'Rob', '18 Nov', 'Room', 20000), standingLines.saidNo('month', 'Rob', '18 Nov', 'Room', 20000)],
            [standingLines.loweredBy('week', 'Rob', '18 Nov', 'Room', 0), standingLines.loweredBy('month', 'Rob', '18 Nov', 'Room', 0)],
            [standingLines.askLapsed('week', '18 Nov'), standingLines.askLapsed('month', '18 Nov')],
            [standingLines.askOpenPayer('week', 10000, '18 Nov', 'Rob'), standingLines.askOpenPayer('month', 10000, '18 Nov', 'Rob')],
            [standingLines.askOpenPayee('week', 'Kim', 10000, '18 Nov'), standingLines.askOpenPayee('month', 'Kim', 10000, '18 Nov')],
            [standingLines.paidZero('week', 20000, '25 Nov'), standingLines.paidZero('month', 20000, '25 Nov')],
            [standingLines.lowerOnlyDown('week', 20000), standingLines.lowerOnlyDown('month', 20000)],
            [standingLines.lowerMoved('week'), standingLines.lowerMoved('month')],
            [standingLines.askOpen('week'), standingLines.askOpen('month')],
            [standingLines.askLimit('week'), standingLines.askLimit('month')],
        ];
        for (const [week, month] of pairs) {
            expect(week).toMatch(/week/);
            expect(month).toMatch(/month/);
            expect(month.replace(/month/g, 'week')).toBe(week);
        }
        const all = pairs.flat().join(' ');
        expect(all).not.toMatch(/subscription|resilience|survival|Ʀ|\$|dollar|cash/i);
    });

    it('no line the payee reads about an ask carries the payer\'s balance', () => {
        const payeeReads = [
            standingLines.askedNotice('week', 'Kim', 10000, 20000, '18 Nov', 'Loft'),
            standingLines.askOpenPayee('week', 'Kim', 10000, '18 Nov'),
            standingLines.answerInstead(10000, 20000),
        ].join(' ');
        expect(payeeReads).not.toMatch(/balance|you have|short|room/i);
    });
});

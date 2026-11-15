/**
 * A short week on the apps (scratch/fable-design/DESIGN-getting-paid-fable.md §3.2, §8 row L2; Marty took every pick on 11
 * Nov 2026 and on 15 Nov said build the rest): what both apps draw, from core alone, so the phone and the web say the same
 * thing at every step. One table over the deal's states (running, an ask open, a lowering agreed, an ask declined, a week at
 * 0, the grace, the grace with an ask, asks used up, stopped, ended, a node with no lowering) x (provider, payer) -> the
 * status line, the quiet link, the ask's line and its button, and which of the three sheets opens. Then each sheet's words,
 * "Another amount" as typed, the History line of a lowered week, and the change id.
 */
import { describe, expect, it } from 'vitest';
import {
    standingChangeId,
    standingLoweredHistoryLine,
    standingPanel,
    standingSheet,
    standingTypedAmount,
    type StandingDealRow,
    type StandingSheetKind,
} from '../standing-deal.js';

const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const START = '2026-11-11T08:00:00.000Z';
// Room at Rob's: 200 Beans a week from 11 Nov; week 1 paid; week 2 is due on 18 Nov, its grace ends 21 Nov 20:00.
const row = (over: Partial<StandingDealRow> = {}): StandingDealRow => ({
    id: 'tx-1', postId: 'post-1', postTitle: "Room at Rob's", status: 'completed', buyerPublicKey: 'kim', buyerCallsign: 'Kim',
    sellerPublicKey: 'rob', sellerCallsign: 'Rob', createdAt: START, completedAt: START, standingId: 'sd-1', periodNo: 1, standingPhase: 'paid',
    standingBeans_c: 20000, standingUnit: 'week', standingMaxPeriods: null, standingNextDueAt: '2026-11-18T08:00:00.000Z', standingStartsAt: START,
    standingShortSince: null, standingStopped: false, amount_c: 20000, standingAsksLeft: 3, standingAsk: null, ...over,
});
const GRACE = { standingPhase: 'short' as const, standingShortSince: '2026-11-18T08:00:00.000Z', standingNextDueAt: '2026-11-18T09:00:00.000Z' };
const ASK = { standingAsk: { id: 'chg-1', beans_c: 10000, periodNo: 2, askedAt: '2026-11-14T08:00:00.000Z' }, standingAsksLeft: 2 };

type Side = 'payer' | 'payee';
const KEY: Record<Side, string> = { payer: 'kim', payee: 'rob' };

/** [state, the row, side, status, link, ask line, ask button, the sheets that open] */
type Case = [string, Partial<StandingDealRow> | null, Side, string | null, string | null, string | null, string | null, StandingSheetKind[]];
const TABLE: Case[] = [
    ['running', {}, 'payer', "This week's 200 went to Rob on 11 Nov · the next 200 go on 18 Nov", 'Ask to pay less next week…', null, null, ['ask']],
    ['running', {}, 'payee', "Kim's standing deal · 200 Beans a week · paid for this week on 11 Nov · next on 18 Nov", 'Lower next week…', null, null, ['lower']],
    ['ask open', ASK, 'payer', "This week's 200 went to Rob on 11 Nov · the next 200 go on 18 Nov", null,
        'You asked to pay 100 Beans for the week from 18 Nov · waiting for Rob', 'Take it back', []],
    ['ask open', ASK, 'payee', "Kim's standing deal · 200 Beans a week · paid for this week on 11 Nov · next on 18 Nov", null,
        '⚠️ Kim asks to pay 100 Beans for the week from 18 Nov', 'Answer', ['answer']],
    ['lowering agreed', { standingDueBeans_c: 10000, standingAsksLeft: 2 }, 'payer',
        "This week's 200 went to Rob on 11 Nov · next week is 100 Beans by agreement, on 18 Nov", 'Ask to pay less next week…', null, null, ['ask']],
    ['lowering agreed', { standingDueBeans_c: 10000, standingAsksLeft: 2 }, 'payee',
        "Kim's standing deal · 200 Beans a week · paid for this week on 11 Nov · next week is 100 Beans by agreement, on 18 Nov", 'Lower next week…', null, null, ['lower']],
    ['ask declined', { standingAsksLeft: 2 }, 'payer', "This week's 200 went to Rob on 11 Nov · the next 200 go on 18 Nov", 'Ask to pay less next week…', null, null, ['ask']],
    ['ask declined', { standingAsksLeft: 2 }, 'payee', "Kim's standing deal · 200 Beans a week · paid for this week on 11 Nov · next on 18 Nov", 'Lower next week…', null, null, ['lower']],
    ['week at 0', { amount_c: 0, periodNo: 2, completedAt: '2026-11-18T08:00:00.000Z', standingNextDueAt: '2026-11-25T08:00:00.000Z' }, 'payer',
        'This week is 0 Beans by agreement · the next 200 go on 25 Nov', 'Ask to pay less next week…', null, null, ['ask']],
    ['week at 0', { amount_c: 0, periodNo: 2, completedAt: '2026-11-18T08:00:00.000Z', standingNextDueAt: '2026-11-25T08:00:00.000Z' }, 'payee',
        'This week is 0 Beans by agreement · the next 200 go on 25 Nov', 'Lower next week…', null, null, ['lower']],
    ['next week at 0', { standingDueBeans_c: 0 }, 'payer', "This week's 200 went to Rob on 11 Nov · next week is 0 Beans by agreement, on 18 Nov", null, null, null, []],
    ['next week at 0', { standingDueBeans_c: 0 }, 'payee',
        "Kim's standing deal · 200 Beans a week · paid for this week on 11 Nov · next week is 0 Beans by agreement, on 18 Nov", null, null, null, []],
    ['grace', GRACE, 'payer', "⚠️ This week's 200 Beans couldn't be paid · 200 needed by 21 Nov or it ends", 'Ask to pay less this week…', null, null, ['ask']],
    ['grace', GRACE, 'payee', "This week isn't paid yet · we'll keep trying until 21 Nov", 'Lower this week…', null, null, ['lower']],
    ['grace, lowered and still short', { ...GRACE, standingDueBeans_c: 5000 }, 'payer',
        "⚠️ This week's 50 Beans couldn't be paid · 50 needed by 21 Nov or it ends", 'Ask to pay less this week…', null, null, ['ask']],
    ['grace, ask open', { ...GRACE, ...ASK }, 'payer', "⚠️ This week's 200 Beans couldn't be paid · 200 needed by 21 Nov or it ends", null,
        'You asked to pay 100 Beans for the week from 18 Nov · waiting for Rob', 'Take it back', []],
    ['grace, ask open', { ...GRACE, ...ASK }, 'payee', "This week isn't paid yet · we'll keep trying until 21 Nov", null,
        '⚠️ Kim asks to pay 100 Beans for the week from 18 Nov', 'Answer', ['answer']],
    ['asks used up', { standingAsksLeft: 0 }, 'payer', "This week's 200 went to Rob on 11 Nov · the next 200 go on 18 Nov", null, null, null, []],
    ['asks used up', { standingAsksLeft: 0 }, 'payee', "Kim's standing deal · 200 Beans a week · paid for this week on 11 Nov · next on 18 Nov", 'Lower next week…', null, null, ['lower']],
    ['stopped', { standingStopped: true }, 'payer', 'Stops on 18 Nov · this week is paid', null, null, null, []],
    ['stopped', { standingStopped: true }, 'payee', 'Stops on 18 Nov · this week is paid', null, null, null, []],
    ['ended', { standingPhase: 'ended', standingEndedReason: 'stopped', standingEndedAt: '2026-11-18T08:00:00.000Z' }, 'payer', null, null, null, null, []],
    ['ended', { standingPhase: 'ended', standingEndedReason: 'stopped', standingEndedAt: '2026-11-18T08:00:00.000Z' }, 'payee', null, null, null, null, []],
    // A node with no lowering sends no standingAsksLeft: the card is as it was, and no sheet opens (old apps, old nodes).
    ['a node with no lowering', { standingAsksLeft: undefined }, 'payer', "This week's 200 went to Rob on 11 Nov · the next 200 go on 18 Nov", null, null, null, []],
    ['a node with no lowering', { standingAsksLeft: undefined }, 'payee', "Kim's standing deal · 200 Beans a week · paid for this week on 11 Nov · next on 18 Nov", null, null, null, []],
];

describe('the card for each state and side (design §3.2): status, link, ask line, button, sheets', () => {
    for (const [state, over, side, status, link, askLine, askButton, sheets] of TABLE) {
        it(`${state} · ${side}`, () => {
            const tx = row(over ?? {});
            const p = standingPanel(tx, KEY[side], day);
            if (status === null) {
                expect(p).toBeNull();
            } else {
                expect(p).not.toBeNull();
                expect(p!.status).toBe(status);
                expect(p!.lowerLink).toBe(link);
                expect(p!.askLine).toBe(askLine);
                expect(p!.askAction?.label ?? null).toBe(askButton);
            }
            const opens = (['ask', 'answer', 'lower'] as StandingSheetKind[]).filter(k => standingSheet(tx, KEY[side], k, day) !== null);
            expect(opens).toEqual(sheets);
            // The link opens exactly the sheet of this side: the payer's ask, the payee's lowering.
            if (link) expect(opens).toContain(side === 'payer' ? 'ask' : 'lower');
            // The payee's lines never carry the payer's balance or shortfall (amendment §2).
            if (side === 'payee' && p) expect(`${p.status} ${p.askLine ?? ''}`).not.toMatch(/needed|short by|you're/);
        });
    }
    it('a stranger to the deal gets no card and no sheet', () => {
        for (const over of [{}, ASK, GRACE, { ...GRACE, ...ASK }]) {
            expect(standingPanel(row(over), 'zed', day)).toBeNull();
            for (const k of ['ask', 'answer', 'lower'] as StandingSheetKind[]) expect(standingSheet(row(over), 'zed', k, day)).toBeNull();
        }
    });
});

describe('the three sheets, word for word (design §3.2)', () => {
    it("the payer's ask, before the week is due", () => {
        const s = standingSheet(row(), 'kim', 'ask', day)!;
        expect(s.title).toBe('Ask to pay less?');
        expect(s.about).toBe("Room at Rob's · the week from 18 Nov · 200 Beans");
        expect(s.choices.map(c => [c.beans_c, c.label])).toEqual([[10000, '100 Beans (half)'], [0, '0 Beans']]);
        expect(s.otherLabel).toBe('Another amount');
        expect(s.lines).toEqual([
            'Rob has to say yes. Until then nothing changes: the full 200 Beans go on 18 Nov if you have them.',
            'If Rob says yes, that week counts as paid in full here. Anything else you two agree is between you; BeanPool keeps no record of it.',
        ]);
        expect(s.go(10000)).toBe('Ask Rob');
        expect(s.cancel).toBe('Cancel');
        expect([s.standingId, s.periodNo, s.amount_c, s.unit]).toEqual(['sd-1', 2, 20000, 'week']);
    });
    it("the payer's ask in the grace: we keep trying until the grace ends", () => {
        const s = standingSheet(row(GRACE), 'kim', 'ask', day)!;
        expect(s.lines[0]).toBe('Rob has to say yes. Until then nothing changes: we keep trying for the full 200 Beans until 21 Nov.');
        expect(s.periodNo).toBe(2);
    });
    it('the payee answering: instead, counts as paid in full, Yes and No with their amounts', () => {
        const s = standingSheet(row(ASK), 'rob', 'answer', day)!;
        expect(s.title).toBe('Kim asks to pay less');
        expect(s.about).toBe("Room at Rob's · the week from 18 Nov");
        expect(s.instead).toBe('100 Beans instead of 200');
        expect(s.lines).toEqual(['If you say yes, that week counts as paid in full here: nothing more is owed through the app for it. The week after is 200 Beans again.']);
        expect(s.go(s.askBeans_c!)).toBe('Yes, 100 Beans');
        expect(s.no).toBe('No, keep 200');
        expect([s.askId, s.askBeans_c, s.choices.length]).toEqual(['chg-1', 10000, 0]);
    });
    it('the payee lowering alone, next week and this week', () => {
        const s = standingSheet(row(), 'rob', 'lower', day)!;
        expect(s.title).toBe('Lower next week?');
        expect(s.lines).toEqual(['Kim pays this instead of 200 Beans for the week from 18 Nov, and that week counts as paid in full here. You can lower it again, not raise it back. The week after is 200 Beans again.']);
        expect(s.go(10000)).toBe('Lower to 100 Beans');
        // No amount chosen yet (an empty or refused "Another amount"): no figure nobody chose (seen in the 320 px shots).
        expect(s.go(null)).toBe('Lower to … Beans');
        expect(standingSheet(row(), 'kim', 'ask', day)!.go(null)).toBe('Ask Rob');
        expect(standingSheet(row(GRACE), 'rob', 'lower', day)!.title).toBe('Lower this week?');
    });
    it('a week already lowered offers half of what it costs now, and says the price again for the week after', () => {
        const s = standingSheet(row({ standingDueBeans_c: 5000 }), 'rob', 'lower', day)!;
        expect(s.choices.map(c => c.beans_c)).toEqual([2500, 0]);
        expect(s.lines[0]).toContain('instead of 50 Beans');
        expect(s.lines[0]).toContain('The week after is 200 Beans again.');
    });
    it('a month says month in every line', () => {
        const m = row({ standingUnit: 'month', standingNextDueAt: '2026-12-11T08:00:00.000Z' });
        const all = [standingSheet(m, 'kim', 'ask', day)!, standingSheet(m, 'rob', 'lower', day)!];
        for (const s of all) expect([s.title, s.about, ...s.lines].join(' ')).not.toMatch(/\bweek\b/);
        expect(standingSheet(m, 'rob', 'lower', day)!.title).toBe('Lower next month?');
    });
});

describe('"Another amount", as typed', () => {
    it('from 0 up to just under what the week costs now, in hundredths; else why not; nothing while empty', () => {
        expect(standingTypedAmount('', 20000, 'week')).toEqual({ ok: false, line: null });
        expect(standingTypedAmount('  ', 20000, 'week')).toEqual({ ok: false, line: null });
        expect(standingTypedAmount('75', 20000, 'week')).toEqual({ ok: true, beans_c: 7500 });
        expect(standingTypedAmount('0', 20000, 'week')).toEqual({ ok: true, beans_c: 0 });
        expect(standingTypedAmount('199.99', 20000, 'week')).toEqual({ ok: true, beans_c: 19999 });
        const no = { ok: false, line: 'Choose fewer Beans than 200: a week can be lowered, never raised.' };
        expect(standingTypedAmount('200', 20000, 'week')).toEqual(no);
        expect(standingTypedAmount('250', 20000, 'week')).toEqual(no);
        expect(standingTypedAmount('1.234', 20000, 'week')).toEqual(no);
        expect(standingTypedAmount('-5', 20000, 'week')).toEqual(no);
        expect(standingTypedAmount('abc', 20000, 'week')).toEqual(no);
        expect(standingTypedAmount('300', 50000, 'month')).toEqual({ ok: true, beans_c: 30000 });
        expect((standingTypedAmount('600', 50000, 'month') as { line: string }).line).toBe('Choose fewer Beans than 500: a month can be lowered, never raised.');
    });
});

describe("Your deals' History line of a lowered week (the Ledger memo's words)", () => {
    const current = row({ periodNo: 3, amount_c: 20000, id: 'tx-3' });
    const older = (amount_c: number, periodNo = 2): StandingDealRow => ({
        id: `tx-${periodNo}`, postTitle: "Room at Rob's", status: 'completed', buyerPublicKey: 'kim', sellerPublicKey: 'rob',
        standingId: 'sd-1', periodNo, amount_c,
    });
    it('an older week paid at 100 or 0 says so, with the price from the current row; a full week says nothing', () => {
        const rows = [current, older(10000), older(0, 1)];
        expect(standingLoweredHistoryLine(older(10000), rows, 'kim')).toBe("Standing deal · Room at Rob's · week 2 · 100 of 200 Beans by agreement");
        expect(standingLoweredHistoryLine(older(0, 1), rows, 'rob')).toBe("Standing deal · Room at Rob's · week 1 · 0 of 200 Beans by agreement");
        expect(standingLoweredHistoryLine(older(20000), rows, 'kim')).toBeNull();
        expect(standingLoweredHistoryLine(current, rows, 'kim')).toBeNull();
    });
    it('the current row lowered says so itself; without the current row in the list, nothing; a stranger, nothing', () => {
        const lowered = row({ amount_c: 5000 });
        expect(standingLoweredHistoryLine(lowered, [lowered], 'kim')).toBe("Standing deal · Room at Rob's · week 1 · 50 of 200 Beans by agreement");
        expect(standingLoweredHistoryLine(older(10000), [older(10000)], 'kim')).toBeNull();
        expect(standingLoweredHistoryLine(older(10000), [current, older(10000)], 'zed')).toBeNull();
        expect(standingLoweredHistoryLine({ ...older(10000), status: 'cancelled' }, [current], 'kim')).toBeNull();
    });
});

describe('the change id', () => {
    it('a fresh UUID each time, in the form the node takes (8 to 128 of A-Z a-z 0-9 _ -)', () => {
        const a = standingChangeId();
        const b = standingChangeId();
        expect(a).not.toBe(b);
        expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(a).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
        expect(standingChangeId(() => new Uint8Array(16))).toBe('00000000-0000-4000-8000-000000000000');
    });
});

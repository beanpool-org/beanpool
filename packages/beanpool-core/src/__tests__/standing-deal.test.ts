/**
 * Standing deals, the pure half (DESIGN-standing-deals-fable.md §5 "Clock", §6; DESIGN-standing-deals-upfront-fable.md and
 * its amendment, slice U0): the calendar across month ends and leap years, the half-period grace, the authorisation text and
 * its tampering, what a standing deal's current row says to each side (dealStep, dealMoves, listingDeals, the panel, the
 * Stop confirm, the live Needs you line). The node's half is driven for real in apps/server test-standing-deals.ts.
 */
import { describe, expect, it } from 'vitest';
import {
    STANDING_AUTH_VERSION,
    isStandingAuthorisation,
    parseStandingAuthorisation,
    periodEnd,
    periodNo,
    periodStart,
    standingAuthorisationText,
    standingGraceEndsAt,
    standingGraceMs,
    standingNeedsLine,
    standingNeedsLines,
    standingPanel,
    standingPaymentPayload,
    standingStopConfirm,
    standingLines,
    standingUnitOf,
    standingWarnAheadMs,
    type StandingAuthorisation,
    type StandingDealRow,
    type StandingPeriodUnit,
} from '../standing-deal.js';
import { dealMoves, dealStateWords, dealStep, dealsNeedingMe, listingDeals, openDeals, type DealRow } from '../deal-step.js';

describe('the calendar: periodStart, periodEnd, periodNo', () => {
    // [start, unit, n, the end of period n]
    const table: Array<[string, StandingPeriodUnit, number, string]> = [
        ['2026-01-31T09:00:00.000Z', 'month', 1, '2026-02-28T09:00:00.000Z'],
        ['2026-01-31T09:00:00.000Z', 'month', 2, '2026-03-31T09:00:00.000Z'],
        ['2026-01-31T09:00:00.000Z', 'month', 3, '2026-04-30T09:00:00.000Z'],
        ['2026-01-31T09:00:00.000Z', 'month', 4, '2026-05-31T09:00:00.000Z'],
        ['2026-01-31T09:00:00.000Z', 'month', 11, '2026-12-31T09:00:00.000Z'],
        ['2026-01-31T09:00:00.000Z', 'month', 12, '2027-01-31T09:00:00.000Z'],
        // A leap year: 29 February, and back to the 31st after it.
        ['2028-01-31T00:00:00.000Z', 'month', 1, '2028-02-29T00:00:00.000Z'],
        ['2028-01-31T00:00:00.000Z', 'month', 2, '2028-03-31T00:00:00.000Z'],
        ['2028-02-29T12:00:00.000Z', 'month', 12, '2029-02-28T12:00:00.000Z'],
        ['2028-02-29T12:00:00.000Z', 'month', 48, '2032-02-29T12:00:00.000Z'],
        // 2100 is not a leap year.
        ['2100-01-30T00:00:00.000Z', 'month', 1, '2100-02-28T00:00:00.000Z'],
        ['2026-08-30T00:00:00.000Z', 'month', 6, '2027-02-28T00:00:00.000Z'],
        ['2026-11-09T08:00:00.000Z', 'month', 1, '2026-12-09T08:00:00.000Z'],
        ['2026-11-09T08:00:00.000Z', 'month', 2, '2027-01-09T08:00:00.000Z'],
        // Weeks are exact, across a month end and a year end.
        ['2026-12-28T10:30:00.000Z', 'week', 1, '2027-01-04T10:30:00.000Z'],
        ['2028-02-26T00:00:00.000Z', 'week', 1, '2028-03-04T00:00:00.000Z'],
        ['2026-11-09T08:00:00.000Z', 'week', 52, '2027-11-08T08:00:00.000Z'],
    ];
    for (const [start, unit, n, end] of table) {
        it(`${unit} ${n} from ${start} ends ${end}`, () => {
            expect(periodEnd(start, unit, n)).toBe(end);
            // The next period starts where this one ends, and never drifts from the start.
            expect(periodStart(start, unit, n + 1)).toBe(end);
            expect(periodNo(start, unit, end)).toBe(n + 1);
            expect(periodNo(start, unit, Date.parse(end) - 1)).toBe(n);
        });
    }

    it('period 1 starts at the start; before the start is period 0', () => {
        const s = '2026-01-31T09:00:00.000Z';
        expect(periodStart(s, 'month', 1)).toBe(s);
        expect(periodNo(s, 'month', s)).toBe(1);
        expect(periodNo(s, 'month', Date.parse(s) - 1)).toBe(0);
    });

    it('numbers periods from 1, and refuses a start that is not a date', () => {
        expect(() => periodEnd('2026-01-01T00:00:00.000Z', 'month', 0)).toThrow();
        expect(() => periodEnd('2026-01-01T00:00:00.000Z', 'month', 1.5)).toThrow();
        expect(() => periodEnd('not a date', 'week', 1)).toThrow();
    });

    it('periodNo agrees with periodEnd for every day over four years (months from the 29th, 30th and 31st)', () => {
        for (const start of ['2027-01-29T06:00:00.000Z', '2027-03-30T06:00:00.000Z', '2027-05-31T06:00:00.000Z']) {
            for (let d = 0; d < 4 * 366; d++) {
                const at = Date.parse(start) + d * 86_400_000;
                const n = periodNo(start, 'month', at);
                expect(Date.parse(periodStart(start, 'month', n))).toBeLessThanOrEqual(at);
                expect(Date.parse(periodEnd(start, 'month', n))).toBeGreaterThan(at);
            }
        }
    });

    it('per week or per month makes a standing deal; hourly, daily and fixed do not (decision 1)', () => {
        expect(standingUnitOf('weekly')).toBe('week');
        expect(standingUnitOf('monthly')).toBe('month');
        for (const p of ['hourly', 'daily', 'fixed', null, undefined, 'MONTHLY']) expect(standingUnitOf(p as any)).toBeNull();
        expect(standingWarnAheadMs('month')).toBe(3 * 86_400_000);
        expect(standingWarnAheadMs('week')).toBe(86_400_000);
    });
});

describe('the authorisation text (§6)', () => {
    const auth: StandingAuthorisation = {
        host: 'mullum.beanpool.org',
        standingId: '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
        listingId: 'post-123',
        payee: 'ab'.repeat(32),
        beansPerPeriod: 50,
        unit: 'month',
        maxPeriods: null,
        startsAt: '2026-11-09T08:00:00.000Z',
        nonce: 'n0nce-1234abcd',
    };

    it('is ten lines in the order §6 gives, amounts to the cent', () => {
        const text = standingAuthorisationText(auth);
        expect(text).toBe([
            STANDING_AUTH_VERSION, 'mullum.beanpool.org', auth.standingId, 'post-123', 'ab'.repeat(32), '50.00', 'month', 'open',
            '2026-11-09T08:00:00.000Z', 'n0nce-1234abcd',
        ].join('\n'));
        expect(standingAuthorisationText({ ...auth, beansPerPeriod: 12.5, unit: 'week', maxPeriods: 6 }).split('\n').slice(5, 8))
            .toEqual(['12.50', 'week', '6']);
    });

    it('round-trips: parse(text(a)) is a, and text(parse(t)) is t', () => {
        for (const a of [auth, { ...auth, maxPeriods: 6 }, { ...auth, unit: 'week' as const, beansPerPeriod: 0.01 }, { ...auth, beansPerPeriod: 999.99 }]) {
            const text = standingAuthorisationText(a);
            const back = parseStandingAuthorisation(text);
            expect(back).toEqual(a);
            expect(standingAuthorisationText(back!)).toBe(text);
        }
    });

    it('refuses a text that is not exactly one it writes', () => {
        const text = standingAuthorisationText(auth);
        const lines = text.split('\n');
        const swap = (i: number, v: string) => lines.map((l, j) => (j === i ? v : l)).join('\n');
        const tampered = [
            text + '\n',                                   // a line break at the end
            '\n' + text,
            lines.slice(0, 9).join('\n'),                  // a line missing
            [...lines, 'extra'].join('\n'),                // a line added
            text.replace(/\n/g, '\r\n'),
            swap(0, 'beanpool-standing-v2'),
            swap(1, ''),
            swap(1, 'host with space'),
            swap(1, 'Mullum.beanpool.org'),             // not lower case
            swap(1, 'mullum.beanpool.org:443'),         // a port
            swap(1, 'mullum.beanpool.org.'),            // a trailing dot
            swap(2, ''),
            swap(4, 'AB'.repeat(32)),                      // upper-case payee
            swap(4, 'ab'.repeat(31)),
            swap(5, '50'),                                 // not to the cent
            swap(5, '50.0'),
            swap(5, '050.00'),
            swap(5, '-50.00'),
            swap(5, '0.00'),                               // nothing per period
            swap(5, '1e3'),
            swap(6, 'year'),
            swap(6, 'Month'),
            swap(7, '0'),
            swap(7, '06'),
            swap(7, 'Open'),
            swap(7, '1.5'),
            swap(7, '241'),                                // past the most one may name
            swap(8, '2026-11-09T08:00:00Z'),               // the same instant, another spelling
            swap(8, '2026-11-09'),
            swap(8, 'yesterday'),
            swap(9, 'short'),
            swap(9, 'has space here'),
        ];
        for (const t of tampered) expect(parseStandingAuthorisation(t), JSON.stringify(t)).toBeNull();
        for (const t of [null, undefined, 42, {}, 'x'.repeat(3000)]) expect(parseStandingAuthorisation(t)).toBeNull();
    });

    it('a change to any field is a different text (what the payer signed is what the node holds)', () => {
        const text = standingAuthorisationText(auth);
        const changes: Partial<StandingAuthorisation>[] = [
            { host: 'byron.beanpool.org' }, { standingId: 'other-id' }, { listingId: 'post-124' }, { payee: 'cd'.repeat(32) },
            { beansPerPeriod: 50.01 }, { unit: 'week' }, { maxPeriods: 1 }, { startsAt: '2026-11-10T08:00:00.000Z' }, { nonce: 'n0nce-1234abce' },
        ];
        for (const c of changes) expect(standingAuthorisationText({ ...auth, ...c })).not.toBe(text);
    });

    it('will not write a field it could not read back', () => {
        for (const bad of [{ beansPerPeriod: 0 }, { beansPerPeriod: 12.345 }, { beansPerPeriod: NaN }, { maxPeriods: 0 }, { startsAt: '2026-11-09' }, { payee: 'x' }]) {
            expect(isStandingAuthorisation({ ...auth, ...bad } as StandingAuthorisation)).toBe(false);
            expect(() => standingAuthorisationText({ ...auth, ...bad } as StandingAuthorisation)).toThrow();
        }
        expect(standingPaymentPayload('sid', 3)).toBe('standing:sid:3');
    });
});

describe('the grace: half the period, on the calendar (amendment §2)', () => {
    it('15 days for a 30-day month, 14 for February, 15½ for a 31-day month, 3½ days for a week', () => {
        const DAY = 86_400_000;
        // Period 2 of a start on 9 Nov runs 9 Dec – 9 Jan (31 days); period 1, 9 Nov – 9 Dec (30 days).
        expect(standingGraceMs('2026-11-09T08:00:00.000Z', 'month', 1)).toBe(15 * DAY);
        expect(standingGraceMs('2026-11-09T08:00:00.000Z', 'month', 2)).toBe(15.5 * DAY);
        expect(standingGraceMs('2027-01-31T08:00:00.000Z', 'month', 1)).toBe(14 * DAY);
        expect(standingGraceMs('2026-11-09T08:00:00.000Z', 'week', 4)).toBe(3.5 * DAY);
        expect(standingGraceEndsAt('2026-11-09T08:00:00.000Z', 'month', 2)).toBe('2026-12-24T20:00:00.000Z');
        expect(standingGraceEndsAt('2026-11-09T08:00:00.000Z', 'week', 2)).toBe('2026-11-19T20:00:00.000Z');
    });
});

describe("a standing deal's current row: dealStep, dealMoves, listingDeals", () => {
    const PAYER = 'payer';
    const PAYEE = 'payee';
    const ENT = 'ent';
    const NOW = Date.parse('2026-12-01T00:00:00Z');
    // Every row of a standing deal is a finished deal: each period is paid at its start, nothing is held.
    const row = (over: Partial<DealRow>): DealRow => ({
        id: 'tx-1', postId: 'post-1', status: 'completed', buyerPublicKey: PAYER, sellerPublicKey: PAYEE, postAuthorPublicKey: PAYEE,
        postType: 'offer', createdAt: '2026-11-09T08:00:00.000Z', standingId: 'sd-1', periodNo: 1, standingPhase: 'paid', ...over,
    });

    // [phase, payer's state, payer needsMe, payee's state, payee needsMe]
    const matrix: Array<[DealRow['standingPhase'], string, boolean, string, boolean]> = [
        ['paid', 'standing', false, 'standing', false],
        ['short', 'short', true, 'short', false],
    ];
    for (const [phase, payerState, payerNeeds, payeeState, payeeNeeds] of matrix) {
        it(`${phase}: the payer ${payerNeeds ? 'is' : 'is not'} badged, the payee never`, () => {
            const tx = row({ standingPhase: phase });
            const p = dealStep(tx, PAYER, NOW);
            const q = dealStep(tx, PAYEE, NOW);
            expect([p.state, p.needsMe, p.role]).toEqual([payerState, payerNeeds, 'payer']);
            expect([q.state, q.needsMe, q.role]).toEqual([payeeState, payeeNeeds, 'payee']);
            expect(dealsNeedingMe([tx], PAYER, NOW).length).toBe(payerNeeds ? 1 : 0);
            expect(dealsNeedingMe([tx], PAYEE, NOW).length).toBe(0);
            // Still under way for both: Your deals keeps one card per standing deal.
            expect(openDeals([tx], PAYER).length).toBe(1);
            expect(typeof dealStateWords(p, 'Rob')).toBe('string');
        });
    }

    it('short is pressing at once, and says this period is not paid yet', () => {
        const p = dealStep(row({ standingPhase: 'short' }), PAYER, NOW);
        expect(p.pressing).toBe(true);
        expect(dealStateWords(p, 'Rob')).toBe("Waiting on you: this period isn't paid yet");
        expect(dealStateWords(dealStep(row({ standingPhase: 'short' }), PAYEE, NOW), 'Marty')).toBe("This period isn't paid yet");
    });

    it('an ended standing deal, or an older period (no phase on its row), is a finished deal like any other', () => {
        expect(dealStep(row({ standingPhase: 'ended', ratedByBuyer: true }), PAYER, NOW).state).toBe('done');
        expect(dealStep(row({ standingPhase: null }), PAYER, NOW).state).toBe('done-to-review');
        expect(dealStep(row({ standingPhase: null }), PAYER, NOW).needsMe).toBe(false);
        expect(openDeals([row({ standingPhase: 'ended' })], PAYER)).toEqual([]);
    });

    it('moves: Stop for either side in every live phase; never Release or Cancel on any standing row', () => {
        for (const phase of ['paid', 'short'] as const) {
            const tx = row({ standingPhase: phase });
            const pm = dealMoves(tx, PAYER, [], NOW)!;
            const qm = dealMoves(tx, PAYEE, [], NOW)!;
            expect([pm.stop, pm.release, pm.cancelHold]).toEqual([true, false, false]);
            expect([qm.stop, qm.release, qm.cancelHold]).toEqual([true, false, false]);
            expect('holdBack' in pm).toBe(false);
        }
        // Fail-first (the 10 Nov bug, design §0): a standing row a surface reads as `pending` (an older copy, a stale
        // phone row) shows no Release and no Cancel either, current or older, phase or none.
        for (const over of [{ status: 'pending' }, { status: 'pending', standingPhase: null }, { status: 'pending', standingPhase: 'ended' as const }]) {
            const m = dealMoves(row(over), PAYER, [], NOW)!;
            expect([m.release, m.cancelHold]).toEqual([false, false]);
        }
        const stopped = row({ standingStopped: true });
        expect(dealMoves(stopped, PAYER, [], NOW)!.stop).toBe(false);
        // A one-off deal held in trust keeps Release and Cancel, and has no Stop.
        const oneOff = row({ standingId: null, standingPhase: null, periodNo: null, status: 'pending' });
        expect([dealMoves(oneOff, PAYER, [], NOW)!.stop, dealMoves(oneOff, PAYER, [], NOW)!.release, dealMoves(oneOff, PAYER, [], NOW)!.cancelHold]).toEqual([false, true, true]);
    });

    it('a keeper of an enterprise payer may stop as the enterprise', () => {
        const k = dealMoves(row({ buyerPublicKey: ENT }), 'keeper', [ENT], NOW)!;
        expect([k.asKeeper, k.stop, k.release, k.cancelHold]).toEqual([true, true, false, false]);
    });

    it('listingDeals: a running standing deal is under `standing`, never a deal held; the member cannot take it up again', () => {
        const listing = { id: 'post-1', authorPublicKey: PAYEE, type: 'offer', status: 'pending' };
        for (const phase of ['paid', 'short'] as const) {
            const running = listingDeals([row({ standingPhase: phase })], listing, PAYER, [], NOW);
            expect([running.standing.length, running.held.length, running.canTakeUp, running.lastDone, running.takenByOther]).toEqual([1, 0, false, null, false]);
        }
        expect(listingDeals([row({ status: 'pending' })], listing, PAYER, [], NOW).held.length).toBe(0);
        // Its author sees it running too.
        expect(listingDeals([row({})], listing, PAYEE, [], NOW).standing.length).toBe(1);
        // Ended: the member may take it up again.
        const ended = listingDeals([row({ standingPhase: 'ended' })], { ...listing, status: 'active' }, PAYER, [], NOW);
        expect([ended.standing.length, ended.canTakeUp]).toEqual([0, true]);
    });
});

describe('the panel, the Stop confirm and the live Needs you line (design §3, amendment §1, §2)', () => {
    const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    const START = '2026-11-09T08:00:00.000Z';
    // Month 1 paid on 9 Nov; month 2 due 9 Dec; its grace ends 24 Dec 20:00 (half of 31 days).
    const tx = (over: Partial<StandingDealRow> = {}): StandingDealRow => ({
        id: 'tx-1', postId: 'post-1', postTitle: 'Vehicle Storage', status: 'completed', buyerPublicKey: 'marty', buyerCallsign: 'Marty',
        sellerPublicKey: 'rob', sellerCallsign: 'Rob', createdAt: START, completedAt: START, standingId: 'sd-1', periodNo: 1, standingPhase: 'paid',
        standingBeans: 50, standingUnit: 'month', standingMaxPeriods: 6, standingNextDueAt: '2026-12-09T08:00:00.000Z', standingStartsAt: START,
        standingShortSince: null, standingStopped: false, ...over,
    });
    const short = (over: Partial<StandingDealRow> = {}) => tx({ standingPhase: 'short', standingShortSince: '2026-12-09T08:00:00.000Z', standingNextDueAt: '2026-12-09T09:00:00.000Z', ...over });

    it('paid: each side reads when this period went and when the next goes, and Stop…', () => {
        const p = standingPanel(tx(), 'marty', day)!;
        const q = standingPanel(tx(), 'rob', day)!;
        expect([p.title, p.status, p.periodOf, p.stop, p.stopLabel, p.warning]).toEqual([
            '🔁 Standing deal since 9 Nov · 50 Beans a month', "This month's 50 went to Rob on 9 Nov · the next 50 go on 9 Dec", 'Month 1 of 6', true, 'Stop…', false]);
        expect(q.status).toBe("Marty's standing deal · 50 Beans a month · paid for this month on 9 Nov · next on 9 Dec");
        expect('holdBack' in p).toBe(false);
    });

    it('short: the payer is warned with the day the grace ends, the payee is told it is not paid yet; both get Stop now', () => {
        const p = standingPanel(short(), 'marty', day)!;
        const q = standingPanel(short(), 'rob', day)!;
        expect([p.status, p.warning, p.stopLabel, p.graceEndsAt]).toEqual(["⚠️ This month's 50 Beans couldn't be paid · 50 needed by 24 Dec or it ends", true, 'Stop now', '2026-12-24T20:00:00.000Z']);
        expect([q.status, q.warning, q.stopLabel, q.stop]).toEqual(["This month isn't paid yet · we'll keep trying until 24 Dec", false, 'Stop now', true]);
    });

    it('stopped: "Stops on 9 Dec · this month is paid", and no second Stop', () => {
        const p = standingPanel(tx({ standingStopped: true }), 'marty', day)!;
        expect([p.status, p.stop, p.lastLine]).toEqual(['Stops on 9 Dec · this month is paid', false, null]);
    });

    it('the Stop confirm: after the period paid, or in the grace at once, in each side\'s words', () => {
        expect(standingStopConfirm(tx(), 'marty', day)).toEqual({ title: 'Stop after this month?', body: "You've paid for this month; Rob keeps it; nothing more is paid.", yes: 'Stop it', no: 'Keep it' });
        expect(standingStopConfirm(tx(), 'rob', day).body).toBe('Nothing more will be paid to you after 9 Dec.');
        const p = standingStopConfirm(short(), 'marty', day);
        expect([p.title, p.body]).toEqual(['Stop it now?', "It ends now. This month's 50 Beans aren't paid and won't be; nothing is owed through the app for the days since 9 Dec. Talk to Rob about it."]);
        expect(standingStopConfirm(short(), 'rob', day).body).toBe("It ends now. This month's 50 Beans won't come; nothing is owed through the app for the days since 9 Dec.");
    });

    it('the live line counts whole days at pinned clocks: due today, 1 day, 15 days', () => {
        const at = (iso: string, me: string) => standingNeedsLine(short(), me, Date.parse(iso), day);
        expect(at('2026-12-09T08:00:00.000Z', 'marty')!.label).toBe('Vehicle Storage: 50 Beans due today · until 24 Dec');
        expect(at('2026-12-10T07:59:59.000Z', 'marty')!.label).toBe('Vehicle Storage: 50 Beans due today · until 24 Dec');
        expect(at('2026-12-10T08:00:00.000Z', 'marty')!.label).toBe('Vehicle Storage: 50 Beans 1 day overdue · until 24 Dec');
        expect(at('2026-12-24T08:00:00.000Z', 'marty')!.label).toBe('Vehicle Storage: 50 Beans 15 days overdue · until 24 Dec');
        expect(at('2026-12-12T08:00:00.000Z', 'rob')!.label).toBe("Marty's 50 Beans for Vehicle Storage: 3 days overdue · we try until 24 Dec · you can stop it now");
        expect([at('2026-12-12T08:00:00.000Z', 'marty')!.accent, at('2026-12-12T08:00:00.000Z', 'rob')!.accent]).toEqual([true, false]);
    });

    it('only for a short deal, only for its two sides', () => {
        const NOW = Date.parse('2026-12-12T08:00:00.000Z');
        expect(standingNeedsLine(tx(), 'marty', NOW, day)).toBeNull();
        expect(standingNeedsLine(tx({ standingPhase: 'ended' }), 'marty', NOW, day)).toBeNull();
        expect(standingNeedsLine(short(), 'stranger', NOW, day)).toBeNull();
        expect(standingNeedsLine(short({ standingId: null }), 'marty', NOW, day)).toBeNull();
    });

    it("no line the payee reads carries the payer's balance or shortfall", () => {
        const NOW = Date.parse('2026-12-12T08:00:00.000Z');
        const payeeWords = [
            standingNeedsLine(short(), 'rob', NOW, day)!.label,
            standingPanel(short(), 'rob', day)!.status,
            standingStopConfirm(short(), 'rob', day).body,
            standingLines.duePayee('month', 'Marty', 50, 'Vehicle Storage', '24 Dec'),
            standingLines.halfwayPayee('Marty', 50, 'Vehicle Storage', 7, '24 Dec'),
            standingLines.dayBeforePayee('month', 'Marty', 'Vehicle Storage', 50, '24 Dec'),
            standingLines.coveredPayee('month', 'Marty', 50, 'Vehicle Storage'),
            standingLines.endedShortPayee('month', 'Marty', 'Vehicle Storage', '9 Dec'),
            standingLines.paidIn('month', 50, 'Vehicle Storage', 'Marty', 3),
        ];
        for (const w of payeeWords) expect(w).not.toMatch(/short|balance|you have|\b30\b/i);
        // Only the payer's own warning ahead names how short they are.
        expect(standingLines.shortAheadNotice('Vehicle Storage', 50, 'Rob', '9 Dec', 30))
            .toBe("Vehicle Storage: 50 Beans go to Rob on 9 Dec and you're 30 short. Earn or receive Beans by then, or stop the standing deal.");
    });

    it('one entry per short standing deal, oldest due first, whatever rows of it are read', () => {
        const NOW = Date.parse('2026-12-20T08:00:00.000Z');
        const other = short({ id: 'tx-9', standingId: 'sd-2', postTitle: 'Garden Plot', standingShortSince: '2026-12-02T08:00:00.000Z' });
        const lines = standingNeedsLines([short(), short({ id: 'tx-1b' }), tx({ id: 'tx-old', standingPhase: null }), other, tx({ standingId: 'sd-3' })], 'marty', NOW, day);
        expect(lines.map(l => l.standingId)).toEqual(['sd-2', 'sd-1']);
        expect(lines[1]).toMatchObject({ role: 'payer', accent: true, txId: 'tx-1', postId: 'post-1' });
    });
});

describe('the words', () => {
    it('every line is a sentence for both periods, with its numbers in', () => {
        expect(standingLines.takeUpSummary('month', 'Vehicle Storage', 50, 'Rob')).toBe('Vehicle Storage · 50 Beans a month · from Rob');
        expect(standingLines.takeUpSummary('week', 'Vehicle Storage', 12.5, 'Rob')).toBe('Vehicle Storage · 12.5 Beans a week · from Rob');
        expect(standingLines.forPeriods('month', 1)).toBe('For 1 month');
        expect(standingLines.forPeriods('month', 6)).toBe('For 6 months');
        expect(standingLines.paidNow('month', 50, 'Rob', '9 Nov', '9 Dec'))
            .toBe('50 Beans go to Rob now for the first month (9 Nov – 9 Dec), then 50 at the start of each month, until one of you stops it.');
        expect(standingLines.agree(50)).toBe('Agree and pay 50 Beans');
        expect(standingLines.duePayer('month', 'Vehicle Storage', 50, 'Rob', '24 Dec'))
            .toBe("Vehicle Storage: this month's 50 Beans couldn't be paid to Rob today. Earn or receive Beans by 24 Dec, or it ends. Rob has been told.");
        expect(standingLines.halfwayPayer('Vehicle Storage', 50, 7, '24 Dec')).toBe('Vehicle Storage: 50 Beans 7 days overdue. Earn or receive Beans by 24 Dec, or it ends.');
        expect(standingLines.paidIn('month', 50, 'Vehicle Storage', 'Marty', 3)).toBe('50 Beans for Vehicle Storage came in from Marty · month 3');
        expect(standingLines.removeStops('month', 2)).toBe('This stops 2 standing deals after their current month.');
        expect(standingLines.memo('month', 'Vehicle Storage', 3)).toBe('Standing deal · Vehicle Storage · month 3');
        const all = Object.values(standingLines).map((f) => (f as (...a: any[]) => string)('month', 'A', 1, 'B', 'C')).join(' ');
        expect(all).not.toMatch(/subscription|resilience|survival|Ʀ|held|hold back/i);
    });
});

/**
 * Standing deals, the pure half (scratch/fable-design/DESIGN-standing-deals-fable.md §5 "Clock", §6, §7 S0): the calendar
 * across month ends and leap years, the authorisation text and its tampering, and what a standing deal's current period
 * says to each side (dealStep, dealMoves, listingDeals). The node's half is driven for real in apps/server
 * test-standing-deals.ts.
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
    standingHoldPayload,
    standingLines,
    standingUnitOf,
    standingWarnAheadMs,
    type StandingAuthorisation,
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
        expect(standingHoldPayload('sid', 3)).toBe('standing:sid:3');
    });
});

describe("a standing deal's current period: dealStep, dealMoves, listingDeals (§7 S0)", () => {
    const PAYER = 'payer';
    const PAYEE = 'payee';
    const ENT = 'ent';
    const NOW = Date.parse('2026-12-01T00:00:00Z');
    const row = (over: Partial<DealRow>): DealRow => ({
        id: 'tx-1', postId: 'post-1', status: 'pending', buyerPublicKey: PAYER, sellerPublicKey: PAYEE, postAuthorPublicKey: PAYEE,
        postType: 'offer', createdAt: '2026-11-09T08:00:00.000Z', standingId: 'sd-1', periodNo: 1, standingPhase: 'held', ...over,
    });

    // [phase, row status, payer's state, payer needsMe, payee's state, payee needsMe]
    const matrix: Array<[DealRow['standingPhase'], string, string, boolean, string, boolean]> = [
        ['held', 'pending', 'standing', false, 'standing', false],
        ['due', 'completed', 'standing', false, 'standing', false],
        ['short', 'completed', 'short', true, 'short', false],
        ['held_back', 'pending', 'held-back', true, 'held-back', false],
    ];
    for (const [phase, status, payerState, payerNeeds, payeeState, payeeNeeds] of matrix) {
        it(`${phase} (${status}): the payer ${payerNeeds ? 'is' : 'is not'} badged, the payee never`, () => {
            const tx = row({ standingPhase: phase, status });
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

    it('short is pressing at once; held back after a week, as a release is', () => {
        expect(dealStep(row({ standingPhase: 'short', status: 'completed' }), PAYER, NOW).pressing).toBe(true);
        expect(dealStep(row({ standingPhase: 'held_back', createdAt: new Date(NOW - 3 * 86_400_000).toISOString() }), PAYER, NOW).pressing).toBe(false);
        expect(dealStep(row({ standingPhase: 'held_back', createdAt: new Date(NOW - 8 * 86_400_000).toISOString() }), PAYER, NOW).pressing).toBe(true);
    });

    it('an ended standing deal, or an older period (no phase on its row), is a finished deal like any other', () => {
        expect(dealStep(row({ standingPhase: 'ended', status: 'completed', ratedByBuyer: true }), PAYER, NOW).state).toBe('done');
        expect(dealStep(row({ standingPhase: null, status: 'completed' }), PAYER, NOW).state).toBe('done-to-review');
        expect(dealStep(row({ standingPhase: null, status: 'completed' }), PAYER, NOW).needsMe).toBe(false);
        expect(openDeals([row({ standingPhase: 'ended', status: 'completed' })], PAYER)).toEqual([]);
    });

    it('moves: hold back for the payer while it runs; stop for either side; release only once held back', () => {
        const running = row({});
        const pm = dealMoves(running, PAYER, [], NOW)!;
        const qm = dealMoves(running, PAYEE, [], NOW)!;
        expect([pm.holdBack, pm.stop, pm.release, pm.cancelHold]).toEqual([true, true, false, true]);
        expect([qm.holdBack, qm.stop, qm.release, qm.cancelHold]).toEqual([false, true, false, true]);

        const back = row({ standingPhase: 'held_back' });
        expect([dealMoves(back, PAYER, [], NOW)!.release, dealMoves(back, PAYER, [], NOW)!.holdBack]).toEqual([true, false]);
        expect(dealMoves(back, PAYEE, [], NOW)!.release).toBe(false);

        const short = row({ standingPhase: 'short', status: 'completed' });
        expect([dealMoves(short, PAYER, [], NOW)!.stop, dealMoves(short, PAYER, [], NOW)!.holdBack, dealMoves(short, PAYER, [], NOW)!.release]).toEqual([true, false, false]);
        expect(dealMoves(short, PAYEE, [], NOW)!.stop).toBe(true);

        const stopped = row({ standingStopped: true });
        expect(dealMoves(stopped, PAYER, [], NOW)!.stop).toBe(false);
        expect(dealMoves(stopped, PAYER, [], NOW)!.holdBack).toBe(true);

        // A one-off deal has neither.
        const oneOff = row({ standingId: null, standingPhase: null, periodNo: null });
        expect([dealMoves(oneOff, PAYER, [], NOW)!.stop, dealMoves(oneOff, PAYER, [], NOW)!.holdBack, dealMoves(oneOff, PAYER, [], NOW)!.release]).toEqual([false, false, true]);
    });

    it("a keeper of an enterprise payer may hold back and stop as the enterprise", () => {
        const tx = row({ buyerPublicKey: ENT });
        const k = dealMoves(tx, 'keeper', [ENT], NOW)!;
        expect([k.asKeeper, k.holdBack, k.stop, k.cancelHold]).toEqual([true, true, true, false]);
    });

    it('listingDeals: a running standing deal is under `standing`, not a deal to release; the member cannot take it up again', () => {
        const listing = { id: 'post-1', authorPublicKey: PAYEE, type: 'offer', status: 'active' };
        const running = listingDeals([row({})], listing, PAYER, [], NOW);
        expect(running.standing.length).toBe(1);
        expect(running.held.length).toBe(0);
        expect(running.canTakeUp).toBe(false);
        // Between its two steps nothing is held, and it still runs.
        const due = listingDeals([row({ standingPhase: 'due', status: 'completed' })], listing, PAYER, [], NOW);
        expect([due.standing.length, due.canTakeUp, due.lastDone]).toEqual([1, false, null]);
        // Held back: a plain held deal again, under both.
        const back = listingDeals([row({ standingPhase: 'held_back' })], listing, PAYER, [], NOW);
        expect([back.standing.length, back.held.length]).toEqual([1, 1]);
        // Its author sees it running too.
        expect(listingDeals([row({})], listing, PAYEE, [], NOW).standing.length).toBe(1);
        // Ended: the member may take it up again.
        const ended = listingDeals([row({ standingPhase: 'ended', status: 'completed' })], listing, PAYER, [], NOW);
        expect([ended.standing.length, ended.canTakeUp]).toEqual([0, true]);
    });
});

describe('the words (§1–§3)', () => {
    it('every line is a sentence for both periods, with its numbers in', () => {
        expect(standingLines.takeUpSummary('month', 'Vehicle Storage', 50, 'Rob')).toBe('Vehicle Storage · 50 Beans a month · from Rob');
        expect(standingLines.takeUpSummary('week', 'Vehicle Storage', 12.5, 'Rob')).toBe('Vehicle Storage · 12.5 Beans a week · from Rob');
        expect(standingLines.forPeriods('month', 1)).toBe('For 1 month');
        expect(standingLines.forPeriods('month', 6)).toBe('For 6 months');
        expect(standingLines.holdBack('week')).toBe('Hold back this week');
        expect(standingLines.shortAheadNotice('month', 'Vehicle Storage', 50, '9 Dec', 30))
            .toBe("Vehicle Storage: 50 Beans are due on 9 Dec and you're 30 short. Earn or receive Beans by then, or stop the standing deal; the month under way is still paid.");
        expect(standingLines.removeStops('month', 2)).toBe('This stops 2 standing deals after their current month.');
        expect(standingLines.memo('month', 'Vehicle Storage', 3)).toBe('Standing deal · Vehicle Storage · month 3');
        const all = Object.values(standingLines).map((f) => (f as (...a: any[]) => string)('month', 'A', 1, 'B', 'C')).join(' ');
        expect(all).not.toMatch(/subscription|resilience|survival|Ʀ/i);
    });
});

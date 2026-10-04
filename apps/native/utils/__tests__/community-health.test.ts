import { describe, it, expect } from 'vitest';
import {
    exceptionRows, departedRows, nameFor, healthLogText, tradeLookText, readHealthTotals, totalsRows, healthLogSections, HEALTH_COPY, type HealthExceptionsBody,
} from '../community-health';

const entries = [
    { id: 'e1', text: { name: 'Ada Lovelace', note: '' } },
    { id: 'e2', text: null },
];
const BODY: HealthExceptionsBody = {
    settings: { debtLinePct: 50, quietDays: 60 },
    exceptions: [
        { memberPubkey: 'k1', entryId: 'e1', balance: -120, floor: 200, reasons: ['past_debt_line', 'quiet_in_debit'] },
        { memberPubkey: 'k2', entryId: 'e2', balance: -20, floor: 200, reasons: ['quiet_in_debit'] },
    ],
    departed: [{ id: 'd1', entryId: 'e1', amount: 80, reason: 'removed', removedAt: '2026-10-01T00:00:00Z', repaid: 30, repaying: true }],
};

describe('community health on the phone', () => {
    it('names come from the decrypted list by entry id; an entry the phone can’t open shows no name', () => {
        const rows = exceptionRows(BODY, entries);
        expect(rows[0]).toEqual({ key: 'k1', name: 'Ada Lovelace', detail: '-120 Beans of a 200 Beans floor · past 50% of their floor, and in debit with no sale for 60 days' });
        expect(rows[1].name).toBe('A name this phone can’t open');
        expect(nameFor(null, entries)).toBe('A name this phone can’t open');
        expect(nameFor('missing', entries)).toBe('A name this phone can’t open');
    });

    it('a departed member’s debt shows what is still owed', () => {
        expect(departedRows(BODY, entries)).toEqual([{ key: 'd1', name: 'Ada Lovelace', detail: 'left owing 50 Beans (30 Beans repaid) · repaying' }]);
    });

    it('the access log names who opened it', () => {
        expect(healthLogText({ id: 'l', actor: 'k', actorCallsign: 'sam', action: 'exceptions_opened', at: '2026-10-04T01:00:00Z' })).toMatch(/^@sam opened the exceptions · /);
        expect(healthLogText({ id: 'l', actor: 'k', actorCallsign: null, action: 'exceptions_opened', at: '2026-10-04T01:00:00Z' })).toMatch(/^An admin opened/);
        // A look at one member's balance while removing them: who, whose, and why.
        expect(healthLogText({ id: 'l', actor: 'k', actorCallsign: 'sam', action: 'offboard_preview', subject: 's', subjectCallsign: 'kim', at: '2026-10-04T01:00:00Z' }))
            .toMatch(/^@sam saw @kim's balance while removing them · /);
        expect(healthLogText({ id: 'l', actor: 'k', actorCallsign: 'sam', action: 'offboard_settled', subject: 's', subjectCallsign: null, at: '2026-10-04T01:00:00Z' }))
            .toMatch(/^@sam removed a member and saw the balance it settled · /);
    });
});

// The node's answers since #1608, as GET /api/names/health and GET /api/names/health/log send them.
const SUMMARY = {
    totals: { beansInCirculation: 4321.4, sumOfCredit: 3800, sumOfDebt: 1250.6, membersInDebit: 3, accounts: 12, commonsPot: 521.4, tradesThisMonth: 17, monthStart: '2026-10-01T00:00:00.000Z' },
    settings: { debtLinePct: 50, quietDays: 60 }, known: true,
};
const LOG_ANSWER = {
    log: [
        { id: 'b2', actor: 'a'.repeat(64), actorCallsign: 'Tester', action: 'exceptions_opened', subject: null, subjectCallsign: null, tradeIds: null, at: '2026-10-05T02:11:00.000Z' },
        { id: 'b1', actor: 'a'.repeat(64), actorCallsign: 'Ada', action: 'offboard_preview', subject: 'k'.repeat(64), subjectCallsign: 'Kimberly', tradeIds: null, at: '2026-10-05T02:05:00.000Z' },
    ],
    tradeLog: [
        { id: 't4', actor: 'a'.repeat(64), actorCallsign: 'Ada', action: 'alerts_read', subject: 'k'.repeat(64), subjectCallsign: 'Kimberly', tradeIds: null, at: '2026-10-05T01:40:00.000Z' },
        { id: 't3', actor: 'a'.repeat(64), actorCallsign: null, action: 'stranded_escrows_read', subject: null, subjectCallsign: null, tradeIds: ['t9'], at: '2026-10-05T01:30:00.000Z' },
        { id: 't2', actor: 'a'.repeat(64), actorCallsign: 'Ada', action: 'dispute_opened', subject: null, subjectCallsign: null, tradeIds: ['t8'], at: '2026-10-05T01:20:00.000Z' },
        { id: 't1', actor: 'a'.repeat(64), actorCallsign: 'Ada', action: 'disputes_listed', subject: null, subjectCallsign: null, tradeIds: ['t8', 't7'], at: '2026-10-05T01:10:00.000Z' },
    ],
};

describe('the Community health screen: totals and the two lists (rehearsal 5 Oct, d3)', () => {
    it('shows the community’s totals from /api/names/health, in Beans, with the manager’s labels', () => {
        const t = readHealthTotals(SUMMARY);
        expect(t).not.toBeNull();
        expect(totalsRows(t!)).toEqual([
            { label: 'Beans in circulation', value: '4,321 Beans' },
            { label: 'Credit held (all balances above 0)', value: '3,800 Beans' },
            { label: 'Debt owed (all balances below 0)', value: '1,251 Beans' },
            { label: 'Members in debit', value: '3' },
            { label: 'Commons pot', value: '521 Beans' },
            { label: 'Trades this month', value: '17' },
        ]);
        expect(totalsRows(t!).map((r) => r.value).join(' ')).not.toMatch(/Ʀ/);
    });

    it('no totals from an answer without them: the screen says so instead of showing zeros', () => {
        expect(readHealthTotals(null)).toBeNull();
        expect(readHealthTotals({})).toBeNull();
        expect(readHealthTotals({ totals: { sumOfCredit: 'x', sumOfDebt: 0, membersInDebit: 0 } })).toBeNull();
        expect(HEALTH_COPY.totalsMissing).toMatch(/couldn’t be read/);
    });

    it('two lists: the looks at a balance, and the looks at trades and alerts, each line in plain words, newest first', () => {
        const { balance, trades } = healthLogSections(LOG_ANSWER);
        expect(balance.heading).toBe('WHO LOOKED AT A MEMBER’S BALANCE');
        expect(balance.hint).toMatch(/opening of the exceptions/);
        expect(balance.hint).toMatch(/while removing them/);
        expect(balance.lines.map((l) => l.key)).toEqual(['b2', 'b1']);
        expect(balance.lines[0].text).toMatch(/^@Tester opened the exceptions · /);
        expect(balance.lines[1].text).toMatch(/^@Ada saw @Kimberly's balance while removing them · /);

        expect(trades.heading).toBe('WHO LOOKED AT TRADES AND ALERTS');
        expect(trades.lines.map((l) => l.key)).toEqual(['t4', 't3', 't2', 't1']);
        expect(trades.lines.map((l) => l.text.split(' · ')[0])).toEqual([
            '@Ada read the alerts that named @Kimberly',
            'An admin opened the escrows a member’s removal left stuck',
            '@Ada opened a dispute',
            '@Ada opened the disputes list',
        ]);
        // A look at trades never lands in the balance list, nor the other way round.
        expect(balance.lines.some((l) => /dispute|alert|escrow/.test(l.text))).toBe(false);
        expect(trades.lines.some((l) => /exceptions|balance/.test(l.text))).toBe(false);
    });

    it('empty lists say nobody has looked', () => {
        const { balance, trades } = healthLogSections({ log: [], tradeLog: [] });
        expect(balance.lines).toEqual([]);
        expect(trades.lines).toEqual([]);
        expect(balance.empty).toBe('Nobody has looked yet.');
        expect(trades.empty).toBe('Nobody has looked yet.');
    });

    it('a node from before #1608 sends no tradeLog: the screen says it isn’t logged there, never “nobody”', () => {
        const { balance, trades } = healthLogSections({ log: LOG_ANSWER.log });
        expect(balance.lines).toHaveLength(2);
        expect(trades.lines).toEqual([]);
        expect(trades.empty).toMatch(/doesn’t log these looks yet/);
    });

    it('an unreadable log answer shows both lists empty, and a malformed line is left out', () => {
        const none = healthLogSections(null);
        expect(none.balance.lines).toEqual([]);
        expect(none.trades.lines).toEqual([]);
        const some = healthLogSections({ log: [null, { id: 'x' }, LOG_ANSWER.log[0]], tradeLog: 'nope' });
        expect(some.balance.lines.map((l) => l.key)).toEqual(['b2']);
        expect(some.trades.lines).toEqual([]);
    });

    it('a look of a kind this phone doesn’t know yet still shows who and when', () => {
        expect(tradeLookText({ id: 'z', actor: 'k', actorCallsign: 'sam', action: 'something_new', at: '2026-10-04T01:00:00Z' })).toMatch(/^@sam looked at trades · /);
    });
});

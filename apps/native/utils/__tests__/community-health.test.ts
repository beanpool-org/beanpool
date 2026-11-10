import { describe, it, expect } from 'vitest';
import {
    exceptionRows, departedRows, readWaitingLines, nameFor, healthLogText, tradeLookText, readHealthTotals, totalsRows, healthLogSections, notOnThisNode, healthFailure, exceptionsFailureText, HEALTH_COPY, type HealthExceptionsBody, type HealthReason,
} from '../community-health';

const entries = [
    { id: 'e1', text: { name: 'Ada Lovelace', note: '' } },
    { id: 'e2', text: null },
];
const BODY: HealthExceptionsBody = {
    settings: { debtLinePct: 50, quietDays: 60 },
    exceptions: [
        // Whole hundredths of a Bean, as the node sends them (engine/community-health.ts): −120 of a 200 floor, −20 of 200.
        { memberPubkey: 'k1', entryId: 'e1', balance_c: -12000, floor_c: 20000, reasons: ['past_debt_line', 'quiet_in_debit'] },
        { memberPubkey: 'k2', entryId: 'e2', balance_c: -2000, floor_c: 20000, reasons: ['quiet_in_debit'] },
    ],
    // 80 owed, 30 of it repaid.
    departed: [{ id: 'd1', entryId: 'e1', amount_c: 8000, reason: 'removed', removedAt: '2026-10-01T00:00:00Z', repaid_c: 3000, repaying: true }],
};

describe('community health on the phone', () => {
    it('names come from the decrypted list by entry id; an entry the phone can’t open shows no name', () => {
        const rows = exceptionRows(BODY, entries);
        // A balance below zero is written with the true minus, as every figure is (formatHundredths).
        expect(rows[0]).toEqual({ key: 'k1', name: 'Ada Lovelace', detail: '−120 Beans of a 200 Beans floor · past 50% of their floor, and in debit with no sale for 60 days' });
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

    // #1613's actor survey: a token's look was logged under its maker's key, so a script read as a person.
    it('a look an automation token made says "by token <name>"; a person\'s says nothing more', () => {
        const token = { id: 'abcdef012345', name: 'nightly report' };
        expect(tradeLookText({ id: 'l', actor: 'k', actorCallsign: 'sam', action: 'disputes_listed', token, at: '2026-10-04T01:00:00Z' }))
            .toMatch(/^@sam by token nightly report opened the disputes list · /);
        expect(healthLogText({ id: 'l', actor: 'k', actorCallsign: 'sam', action: 'offboard_preview', subjectCallsign: 'kim', token, at: '2026-10-04T01:00:00Z' }))
            .toMatch(/^@sam by token nightly report saw @kim's balance while removing them · /);
        expect(tradeLookText({ id: 'l', actor: 'k', actorCallsign: 'sam', action: 'alerts_read', token: { id: 'abcdef012345', name: ' ' }, at: '2026-10-04T01:00:00Z' }))
            .toMatch(/^@sam by token abcdef012345 read the alerts/);
        expect(tradeLookText({ id: 'l', actor: 'k', actorCallsign: 'sam', action: 'dispute_opened', token: null, at: '2026-10-04T01:00:00Z' }))
            .toMatch(/^@sam opened a dispute · /);
    });
});

// The node's answers since #1608, as GET /api/names/health and GET /api/names/health/log send them.
const SUMMARY = {
    // Every money total whole hundredths of a Bean (`*_c`, engine/community-health.ts communityTotals).
    totals: { beansInCirculation_c: 432140, sumOfCredit_c: 380000, sumOfDebt_c: 125060, membersInDebit: 3, accounts: 12, commonsPot_c: 52140, tradesThisMonth: 17, monthStart: '2026-10-01T00:00:00.000Z' },
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
        // Exact, as the owner console shows them (apps/manager beansText): whole hundredths leave nothing to round.
        expect(totalsRows(t!)).toEqual([
            { label: 'Beans in circulation', value: '4,321.40 Beans' },
            { label: 'Credit held (all balances above 0)', value: '3,800 Beans' },
            { label: 'Debt owed (all balances below 0)', value: '1,250.60 Beans' },
            { label: 'Members in debit', value: '3' },
            { label: 'Commons pot', value: '521.40 Beans' },
            { label: 'Trades this month', value: '17' },
        ]);
        expect(totalsRows(t!).map((r) => r.value).join(' ')).not.toMatch(/Ʀ/);
    });

    it('no totals from an answer without them: the screen says so instead of showing zeros', () => {
        expect(readHealthTotals(null)).toBeNull();
        expect(readHealthTotals({})).toBeNull();
        expect(readHealthTotals({ totals: { sumOfCredit_c: 'x', sumOfDebt_c: 0, membersInDebit: 0 } })).toBeNull();
        // A money total that isn't whole hundredths is a bad answer too, never a figure.
        expect(readHealthTotals({ totals: { ...SUMMARY.totals, sumOfCredit_c: 3800.5 } })).toBeNull();
        expect(HEALTH_COPY.totalsMissing).toMatch(/couldn’t be read/);
    });

    it('a total the node couldn’t count shows “Not known just now”, never 0 Beans (review of #1610, finding 1)', () => {
        // The Commons pot's row holding no number: the server keeps NaN for the pot and for the circulation, and JSON sends null.
        const wire = JSON.parse(JSON.stringify({ ...SUMMARY, totals: { ...SUMMARY.totals, commonsPot_c: NaN, beansInCirculation_c: NaN } }));
        expect(wire.totals.commonsPot_c).toBeNull();
        const t = readHealthTotals(wire);
        expect(t).not.toBeNull();
        expect(totalsRows(t!)).toEqual([
            { label: 'Beans in circulation', value: 'Not known just now' },
            { label: 'Credit held (all balances above 0)', value: '3,800 Beans' },
            { label: 'Debt owed (all balances below 0)', value: '1,250.60 Beans' },
            { label: 'Members in debit', value: '3' },
            { label: 'Commons pot', value: 'Not known just now' },
            { label: 'Trades this month', value: '17' },
        ]);
        // Any total left unknown says so, a count as much as a sum of Beans.
        const counts = readHealthTotals({ totals: { ...SUMMARY.totals, membersInDebit: null, tradesThisMonth: null } });
        expect(totalsRows(counts!).filter((r) => r.value === 'Not known just now').map((r) => r.label)).toEqual(['Members in debit', 'Trades this month']);
        for (const zero of ['0', '0 Beans']) expect(totalsRows(counts!).map((r) => r.value)).not.toContain(zero);
        // Nothing the phone can read at all is no totals, not six unknowns.
        expect(readHealthTotals({ totals: {} })).toBeNull();
    });

    it('a node from before #1599 has no totals route: the screen says it needs an update, not “just now”', () => {
        expect(notOnThisNode({ ok: false, status: 404, code: null })).toBe(true);
        // Every 404 of a current node carries a code (the global node's feature_off); a lost connection is status 0.
        expect(notOnThisNode({ ok: false, status: 404, code: 'feature_off' })).toBe(false);
        expect(notOnThisNode({ ok: false, status: 0, code: null })).toBe(false);
        expect(notOnThisNode({ ok: true })).toBe(false);
        expect(HEALTH_COPY.totalsNotOnThisNode).toMatch(/needs an update/);
    });

    it('one split for every part: no answer, an older node, or the node answering with an error', () => {
        expect(healthFailure({ ok: false, status: 0, code: null })).toBe('unreachable');
        expect(healthFailure({ ok: false, status: 0, code: 'timed_out' })).toBe('unreachable');
        expect(healthFailure({ ok: false, status: 404, code: null })).toBe('not_on_this_node');
        for (const r of [
            { ok: false as const, status: 500, code: null }, { ok: false as const, status: 200, code: null },
            { ok: false as const, status: 404, code: 'feature_off' }, { ok: false as const, status: 409, code: 'standby' },
        ]) expect(healthFailure(r)).toBe('answered_error');
    });

    it('the exceptions card: the connection sentence only with no answer, never when the node answered (rehearsal 5 Oct b)', () => {
        const NO_ANSWER = "Couldn't reach your community. Check your connection and try again.";
        expect(exceptionsFailureText({ ok: true })).toBeNull();
        expect(exceptionsFailureText({ ok: false, status: 0, code: null, message: NO_ANSWER })).toBe(NO_ANSWER);
        // The node crashed (a plain 500) or sent a 2xx the phone couldn't read: names-list.ts gave both the connection sentence.
        expect(exceptionsFailureText({ ok: false, status: 500, code: null, message: NO_ANSWER })).toBe(HEALTH_COPY.exceptionsAnswerError);
        expect(exceptionsFailureText({ ok: false, status: 200, code: null, message: NO_ANSWER })).toBe(HEALTH_COPY.exceptionsAnswerError);
        // A refusal the node worded keeps its words; an older node needs an update.
        expect(exceptionsFailureText({ ok: false, status: 403, code: 'not_member', message: 'Not an active member of this community.' })).toBe('Not an active member of this community.');
        expect(exceptionsFailureText({ ok: false, status: 404, code: null, message: NO_ANSWER })).toBe(HEALTH_COPY.exceptionsNotOnThisNode);
        expect(HEALTH_COPY.exceptionsNotOnThisNode).toMatch(/needs an update/);
        for (const words of [HEALTH_COPY.exceptionsAnswerError, HEALTH_COPY.exceptionsNotOnThisNode]) {
            expect(words).not.toMatch(/reach|connection/i);
            // Which part failed, in the screen's own headings' words (PAST A LINE, LEFT WITH A DEBT).
            expect(words).toMatch(/past a line or left with a debt/);
        }
    });

    it('two lists: the looks at a balance, and the looks at trades and alerts, each line in plain words, newest first', () => {
        const { balance, trades } = healthLogSections(LOG_ANSWER);
        expect(balance.heading).toBe('WHO LOOKED AT A MEMBER’S BALANCE');
        expect(balance.hint).toMatch(/opening of the exceptions/);
        expect(balance.hint).toMatch(/while removing them/);
        // A vote on removing a member shows their balance to its voters, unlogged: the hint says so, so the list isn't read as complete.
        expect(balance.hint).toMatch(/A vote on removing a member also shows their balance and any debt to everyone who can vote in it, and those looks are not in this list\./);
        expect(balance.lines.map((l) => l.key)).toEqual(['b2', 'b1']);
        expect(balance.lines[0].text).toMatch(/^@Tester opened the exceptions · /);
        expect(balance.lines[1].text).toMatch(/^@Ada saw @Kimberly's balance while removing them · /);

        expect(trades.heading).toBe('WHO LOOKED AT TRADES AND ALERTS');
        expect(trades.lines.map((l) => l.key)).toEqual(['t4', 't3', 't2', 't1']);
        expect(trades.lines.map((l) => l.text.split(' · ')[0])).toEqual([
            '@Ada read the alerts that named @Kimberly',
            'An admin opened the deals a member’s removal left holding Beans in trust',
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
        // A failed read (a timeout, a standby) never says nobody looked (review of #1610, finding 2).
        expect(none.balance.empty).toBe('The log couldn’t be read just now.');
        expect(none.trades.empty).toBe('The log couldn’t be read just now.');
        const some = healthLogSections({ log: [null, { id: 'x' }, LOG_ANSWER.log[0]], tradeLog: 'nope' });
        expect(some.balance.lines.map((l) => l.key)).toEqual(['b2']);
        expect(some.trades.lines).toEqual([]);
        expect(some.trades.empty).toBe('The log couldn’t be read just now.');
        // Lines the phone couldn't read are not "nobody" either.
        const bad = healthLogSections({ log: [{ id: 'x' }], tradeLog: [null] });
        expect(bad.balance.empty).toBe('The log couldn’t be read just now.');
        expect(bad.trades.empty).toBe('The log couldn’t be read just now.');
    });

    it('a node from before #1599 has no log at all: both lists say it needs an update, never “nobody”', () => {
        const old = healthLogSections(null, 'not_on_this_node');
        expect(old.balance.lines).toEqual([]);
        expect(old.balance.empty).toMatch(/doesn’t keep this log yet: it needs an update/);
        expect(old.trades.empty).toBe(old.balance.empty);
        for (const s of [old.balance, old.trades]) expect(s.empty).not.toMatch(/Nobody/);
    });

    it('a look of a kind this phone doesn’t know yet still shows who and when', () => {
        expect(tradeLookText({ id: 'z', actor: 'k', actorCallsign: 'sam', action: 'something_new', at: '2026-10-04T01:00:00Z' })).toMatch(/^@sam looked at trades · /);
    });
});

describe('a reason this phone has no words for (the node still has S1\'s step-back reason, which no app can cause)', () => {
    // −800 of a 200 floor, whole hundredths.
    const ROW = { memberPubkey: 'k', entryId: 'e1', balance_c: -80000, floor_c: 20000, reasons: ['stepped_back_owing'] as unknown as HealthReason[] };
    const SETTINGS = { debtLinePct: 50, quietDays: 60 };

    it('shows the balance and the floor alone, never "in debit with no sale", which would be untrue', () => {
        const [row] = exceptionRows({ settings: SETTINGS, exceptions: [ROW], departed: [] }, entries);
        expect(row.name).toBe('Ada Lovelace');
        expect(row.detail).toBe('−800 Beans of a 200 Beans floor');
    });

    it('a line crossed keeps its reason, with or without the other', () => {
        const row = (reasons: unknown[]) => exceptionRows({ settings: SETTINGS, exceptions: [{ ...ROW, reasons: reasons as HealthReason[] }], departed: [] }, entries)[0];
        expect(row(['past_debt_line']).detail).toBe('−800 Beans of a 200 Beans floor · past 50% of their floor');
        expect(row(['past_debt_line', 'stepped_back_owing']).detail).toBe('−800 Beans of a 200 Beans floor · past 50% of their floor');
    });
});

describe('a tightened line on the summary', () => {
    it('reads the owner\'s numbers with their dates; an older node has none', () => {
        expect(readWaitingLines({ settings: { debtLinePct: 30, quietDays: 60 }, rule: { debtLineFrom: '2026-11-16T04:00:00.000Z', quietDaysFrom: null } }))
            .toEqual({ debtLinePct: 30, quietDays: 60, debtLineFrom: '2026-11-16T04:00:00.000Z', quietDaysFrom: null });
        expect(readWaitingLines({ settings: { debtLinePct: 30, quietDays: 60 } })).toBeNull();
        expect(readWaitingLines(null)).toBeNull();
    });
});

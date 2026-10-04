import { describe, it, expect } from 'vitest';
import { exceptionRows, departedRows, nameFor, healthLogText, type HealthExceptionsBody } from '../community-health';

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

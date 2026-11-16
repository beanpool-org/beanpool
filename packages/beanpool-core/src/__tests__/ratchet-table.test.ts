/**
 * X8 part 1, check (3): one table of message orders through src/ratchet.ts (the rows are in ratchet-harness.ts, so the
 * mutation test runs the very same rows): in order, out of order within the skip limit, exactly at it, beyond it (refused, and
 * nothing changes), replays (refused), lost messages, a late message from an earlier chain, both sides sending at once, a new
 * ratchet key on every change of direction and only then, changed and malformed messages, a pre-key message for another
 * session, a ratchet key nobody could have answered, the oldest chain and the oldest skipped key dropped at their caps.
 * Every refusal is also checked to leave the state exactly as it was. Each row runs with both MAC lengths.
 */
import { describe, expect, it } from 'vitest';
import * as ratchet from '../ratchet.js';
import { ratchetTable, runRow } from './ratchet-harness.js';

describe('src/ratchet.ts: the table of message orders', () => {
    const rows = ratchetTable(ratchet);

    it('has every row the brief names', () => {
        const names = rows.map((r) => r.name).join('\n');
        for (const want of [/in order/, /out of order within/, /beyond the limit/, /replay/, /lost/, /both sides sending at once/, /change of direction/]) {
            expect(names).toMatch(want);
        }
        expect(rows.length).toBe(18);
    });

    for (const macBytes of [8, 32] as const) {
        for (const row of rows) {
            it(`MAC ${macBytes}: ${row.name}`, () => runRow(ratchet, row, macBytes));
        }
    }
});

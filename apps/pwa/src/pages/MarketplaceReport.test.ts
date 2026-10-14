import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHILD_SAFETY_REASON, REPORT_REASONS } from '../lib/reportReasons';

/**
 * The Market's report form offers "Child safety" and sends it as picked, with the line that says what it is for (the
 * review of #1895, finding 4: removing the option, or having it send other words, failed no test). ReportModal, the
 * web's other report list, is drawn in ReportModal.test.tsx. This form is part of MarketplacePage, too large to draw
 * here, so this reads its source: each option sends the words it shows, and the shared choice comes from
 * lib/reportReasons.ts, never typed again. Since the follow-up to #1895 the whole list is the shared one: no option of
 * its own (it had "Harassment", which the server reads as other).
 */

const src = readFileSync(join(import.meta.dirname, 'MarketplacePage.tsx'), 'utf8');

/** The report form: from where it opens to the call that sends it. */
function reportForm(): string {
    const i = src.indexOf('{showReportForm && (');
    const j = src.indexOf('reportAbuse(', i);
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    return src.slice(i, j);
}

const CONSTANTS: Record<string, string> = { CHILD_SAFETY_REASON };

/** Each option's value and label, constants read as what they hold. */
function options(form: string): Array<{ value: string; label: string }> {
    const word = (quoted: string | undefined, braced: string | undefined) =>
        quoted ?? (braced && braced in CONSTANTS ? CONSTANTS[braced] : `{${braced}}`);
    return [...form.matchAll(/<option value=(?:"([^"]*)"|\{(\w+)\})>(?:\{(\w+)\}|([^<{]*))<\/option>/g)]
        .map((m) => ({ value: word(m[1], m[2]), label: word(m[4], m[3]) }));
}

describe('the Market\'s report form (MarketplacePage.tsx)', () => {
    it('reads its whole list from lib/reportReasons.ts', () => {
        expect(src).toMatch(/import \{[^}]*\bREPORT_REASONS\b[^}]*\} from '\.\.\/lib\/reportReasons'/);
        expect(reportForm()).toContain('{REPORT_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}');
        expect(REPORT_REASONS).toContain('Child safety');
    });

    it('has no option of its own: only the empty "Select a reason..." beside the shared list', () => {
        const opts = options(reportForm());
        expect(opts).toEqual([{ value: '', label: 'Select a reason...' }]);
    });

    it('says what Child safety is for', () => {
        expect(reportForm()).toContain('<span className="font-bold">{CHILD_SAFETY_REASON}:</span> {CHILD_SAFETY_HINT}');
    });
});

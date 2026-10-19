import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHILD_SAFETY_HINT, CHILD_SAFETY_REASON, REPORT_REASONS, REPORT_WORDS } from '../lib/reportReasons';

/**
 * The Market's report form offers "Child safety" and sends it as picked, with the line that says what it is for (the
 * review of #1895, finding 4: removing the option, or having it send other words, failed no test). ReportModal, the
 * web's other report list, is drawn in ReportModal.test.tsx. This form is part of MarketplacePage, too large to draw
 * here, so this reads its source: each option sends the English reason it stands for (the node reads it) and shows that
 * same reason through t() (words S3, web sweep W1), and the shared choice comes from lib/reportReasons.ts, never typed
 * again. Since the follow-up to #1895 the whole list is the shared one: no option of its own (it had "Harassment", which
 * the server reads as other). MarketplacePage.words.test.tsx draws the form in the pseudo-locale.
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

/** Each option's value and label, constants read as what they hold, and a t('…') label read as the English it shows. */
function options(form: string): Array<{ value: string; label: string }> {
    const word = (quoted: string | undefined, braced: string | undefined) =>
        quoted ?? (braced && braced in CONSTANTS ? CONSTANTS[braced] : `{${braced}}`);
    return [...form.matchAll(/<option value=(?:"([^"]*)"|\{(\w+)\})>(?:\{t\('([^']*)'\)\}|\{(\w+)\}|([^<{]*))<\/option>/g)]
        .map((m) => ({ value: word(m[1], m[2]), label: m[3] ?? word(m[5], m[4]) }));
}

describe('the Market\'s report form (MarketplacePage.tsx)', () => {
    it('reads its whole list from lib/reportReasons.ts, each option sending the English reason it shows', () => {
        expect(src).toMatch(/import \{[^}]*\bREPORT_REASONS\b[^}]*\} from '\.\.\/lib\/reportReasons'/);
        // The value is the shared reason as written (what the node reads); the label is that same entry through t().
        expect(reportForm()).toContain('{REPORT_REASONS.map((r, i) => <option key={r} value={r}>{t(REPORT_REASONS[i])}</option>)}');
        expect(REPORT_REASONS).toContain('Child safety');
    });

    it('has no option of its own: only the empty "Select a reason..." beside the shared list', () => {
        const form = reportForm();
        const opts = options(form);
        expect(opts).toEqual([{ value: '', label: 'Select a reason...' }]);
        // Two <option>s in the source: that one, and the shared list's.
        expect(form.match(/<option\b/g)).toHaveLength(2);
    });

    it('says what Child safety is for', () => {
        expect(src).toMatch(/import \{[^}]*\bREPORT_WORDS\b[^}]*\} from '\.\.\/lib\/reportReasons'/);
        expect(REPORT_WORDS.childSafety).toBe(CHILD_SAFETY_REASON);
        expect(REPORT_WORDS.childSafetyHint).toBe(CHILD_SAFETY_HINT);
        expect(reportForm()).toContain('<Sentence text={t(\'{reason}: {hint}\', { hint: t(REPORT_WORDS.childSafetyHint) })} parts={{ reason: <span className="font-bold">{t(REPORT_WORDS.childSafety)}</span> }} />');
    });
});

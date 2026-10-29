import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { formatReport, scanTree, topSkips } from '../utils/button-contrast';

/**
 * Every button and label the phone draws, light and dark (scripts/test-all.sh, `native_dark_contrast`).
 *
 * Reads apps/native/app and apps/native/components, finds each piece of words with the background its own screen sets
 * behind it, and fails below 4.5:1 (3:1 for 24px, or 18.66px bold, words), naming file:line and both colours. The method,
 * and what it leaves out, is at the top of utils/button-contrast.ts; the reviewed exceptions (none to start) are in
 * utils/button-contrast-exceptions.ts. No device, no node, no browser; a few seconds.
 *
 * BUTTON_CONTRAST_ROOT points it at another copy of apps/native (a scratch tree with a fix applied, to prove it goes green).
 */
const ROOT = process.env.BUTTON_CONTRAST_ROOT ?? join(__dirname, '..');

// The pairs measured on main when this was written were 5,439 (2,716 light, 2,723 dark); a scanner that stops reading
// styles (a renamed StyleSheet helper, a changed hook) measures far fewer and would pass for the wrong reason. About
// two thirds of that, so deleting or reworking a few screens does not trip it.
const MIN_PAIRS_MEASURED = 3600;

describe('the phone\'s buttons and labels reach 4.5:1 in light and in dark', () => {
    const report = scanTree(ROOT);
    const measured = report.stats.checked.light + report.stats.checked.dark;

    it('is reading the screens (not passing because it sees nothing)', () => {
        console.log(`${formatReport({ ...report, findings: [] })}\nmost common unresolved:\n  ${topSkips(report).join('\n  ')}`);
        expect(measured, 'the scanner measured far fewer pairs than it did on main: utils/button-contrast.ts no longer reads the screens').toBeGreaterThanOrEqual(MIN_PAIRS_MEASURED);
    });

    it('has no exception that excuses nothing, or without a reason', () => {
        expect(report.badExceptions).toEqual([]);
    });

    it('has no pair under the bar', () => {
        // The report goes to stdout once (an assertion message is printed twice by the runner).
        if (report.findings.length) console.log(`\n${formatReport(report)}\n`);
        expect(report.findings.length, `${report.findings.length} button/label pairs read under the bar: the report is printed above this`).toBe(0);
    });
});

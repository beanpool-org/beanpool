import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { formatReport, scanTree, topSkips } from '../utils/button-contrast';

/**
 * Every button and label the phone draws, light and dark (scripts/test-all.sh, `native_dark_contrast`).
 *
 * Reads apps/native/app, apps/native/components and apps/native/tools, finds each piece of words with the background its own screen sets
 * behind it, and fails below 4.5:1 (3:1 for 24px, or 18.66px bold, words), naming file:line and both colours. The method,
 * and what it leaves out, is at the top of utils/button-contrast.ts; the reviewed exceptions (none to start) are in
 * utils/button-contrast-exceptions.ts. No device, no node, no browser; a few seconds.
 *
 * BUTTON_CONTRAST_ROOT points it at another copy of apps/native (a scratch tree with a fix applied, to prove it goes green).
 */
const ROOT = process.env.BUTTON_CONTRAST_ROOT ?? join(__dirname, '..');

// The pairs measured when this was last set were 6,541 (3,265 light, 3,276 dark); a scanner that stops reading
// styles (a renamed StyleSheet helper, a changed hook) measures far fewer and would pass for the wrong reason. About
// two thirds of that, so deleting or reworking a few screens does not trip it.
const MIN_PAIRS_MEASURED = 4300;

// The other half of the same guard, on what was NOT read. A style the scanner cannot follow (a prop, a table built in
// another file, `styles` handed to a child component) adds no colours, so a screen that moves into such a shape stops being
// measured and still looks clean. As measured then: 1,720 style expressions in 90 files, and 42 files that read a style from a
// local table (`styles`, `s`, `chat`, whatever it is called) the scanner could not find (the report prints both lists).
// Either number rising is a screen going dark: teach utils/button-contrast.ts the new shape, or, if it truly cannot be read,
// raise the number here in the same change so a reviewer sees it. The style ceiling has the same margin it had before (about 60).
const MAX_UNREAD_STYLES = 1870; // 1,812 measured 31 Oct on main f9fbbfd8 (market fill, Pulse rows, tags, listing doors added 32), + the same ~60 margin
const MAX_UNREAD_TABLE_FILES = 43; // 43 on main f9fbbfd8 (31 Oct): #2604's first-account screens (FindCommunityBody, WaitingToJoin) changed since 42 was pinned

describe('the phone\'s buttons and labels reach 4.5:1 in light and in dark', () => {
    const report = scanTree(ROOT);
    const measured = report.stats.checked.light + report.stats.checked.dark;

    it('is reading the screens (not passing because it sees nothing)', () => {
        console.log(`${formatReport({ ...report, findings: [] })}\nmost common unresolved:\n  ${topSkips(report).join('\n  ')}`);
        expect(measured, 'the scanner measured far fewer pairs than it did on main: utils/button-contrast.ts no longer reads the screens').toBeGreaterThanOrEqual(MIN_PAIRS_MEASURED);
    });

    it('is not losing screens into shapes it cannot read', () => {
        expect(report.stats.opaqueStyles, `${report.stats.opaqueStyles} style expressions could not be read (ceiling ${MAX_UNREAD_STYLES}): the files with the most are printed above`).toBeLessThanOrEqual(MAX_UNREAD_STYLES);
        expect(
            report.stats.unreadTables.size,
            `${report.stats.unreadTables.size} files use a style table the scanner could not find (ceiling ${MAX_UNREAD_TABLE_FILES}): the files are printed above`,
        ).toBeLessThanOrEqual(MAX_UNREAD_TABLE_FILES);
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

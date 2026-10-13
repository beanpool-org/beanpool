/**
 * Every report list on the phone offers "Child safety", with the line that says what it is for (the review of #1895,
 * finding 4: the post screen going back to its old list of four, or the Pulse card losing the line, failed no test).
 *
 * Screens can't be drawn here (vitest.config.ts: logic, not screens), so this reads their source: each list is the
 * shared REPORT_REASONS (utils/reportReasons.ts), never one of its own, and the line sits under it. What the lists send
 * is in pulse.test.ts.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CHILD_SAFETY_REASON, REPORT_REASONS } from '../reportReasons';

const APP = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(APP, rel), 'utf8');

/** The source of a report box: from its heading to what follows the list. */
function box(src: string, from: string, to: string): string {
    const i = src.indexOf(from);
    const j = src.indexOf(to, i);
    expect(i, `"${from}" is in the screen`).toBeGreaterThan(-1);
    expect(j, `"${to}" follows it`).toBeGreaterThan(i);
    return src.slice(i, j);
}

const HINT = '{CHILD_SAFETY_REASON}:</Text> {CHILD_SAFETY_HINT}';

function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir).flatMap((name) => {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) return name === '__tests__' ? [] : sourceFiles(p);
        return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [p] : [];
    });
}

describe('the phone\'s report lists', () => {
    it('share one list, with "Child safety" in it', () => {
        expect(REPORT_REASONS).toContain(CHILD_SAFETY_REASON);
        expect(CHILD_SAFETY_REASON).toBe('Child safety');
    });

    it('the post screen (app/post/[id].tsx) lists the shared reasons and says what Child safety is for', () => {
        const src = read('app/post/[id].tsx');
        expect(src).toMatch(/import \{[^}]*\bREPORT_REASONS\b[^}]*\} from '\.\.\/\.\.\/utils\/reportReasons'/);
        const b = box(src, 'SELECT REPORT REASON', 'Optional details or comments');
        expect(b).toContain('{REPORT_REASONS.map((r) =>');
        expect(b).toContain(HINT);
        // The reason goes first, the member's words after it: where the server reads the choice.
        expect(src).toContain('const finalReason = reportDetails ? `${reportReason}: ${reportDetails}` : reportReason;');
    });

    it('the Pulse card (components/PulseFeedCard.tsx) lists the shared reasons and says what Child safety is for', () => {
        const src = read('components/PulseFeedCard.tsx');
        const b = box(src, 'Report this post — why?', '<View style={styles.reportActions}>');
        expect(b).toContain('{PULSE_REPORT_REASONS.map((r) =>');
        expect(b).toContain(HINT);
    });

    it('no screen spells out a list of its own', () => {
        const own = ['app', 'components', 'utils']
            .flatMap((d) => sourceFiles(path.join(APP, d)))
            .filter((f) => !f.endsWith(path.join('utils', 'reportReasons.ts')))
            .filter((f) => /'Misleading post'|"Misleading post"/.test(fs.readFileSync(f, 'utf8')))
            .map((f) => path.relative(APP, f));
        expect(own).toEqual([]);
    });
});

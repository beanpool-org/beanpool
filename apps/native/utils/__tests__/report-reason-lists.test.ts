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
import {
    CHILD_SAFETY_REASON, REPORT_REASONS, reportReasonWithWords, reportedAlertBody, pickedChildSafety, REPORT_SENT_TEXT,
    REPORT_WORDS_LEFT_OUT_PRIVATE_TEXT, REPORT_WORDS_LEFT_OUT_UNREAD_TEXT, REPORT_CHILD_SAFETY_ALERTED_TEXT, CHILD_IN_DANGER_TEXT,
    REPORT_CHILD_SAFETY_CLASSIFIED_TEXT, REPORT_CHILD_SAFETY_CLASSIFIED_ALERTED_TEXT,
} from '../reportReasons';

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

    // The follow-up to #1895 (director, 14 Oct): every report screen offers the list before the socialism.org launch.
    // The event screen and an enterprise or project used a fixed reason and a free-text box, so a child-safety concern
    // there hung on the server's keyword guess.
    it('the shared report box (components/ReportReasonBox.tsx) lists the shared reasons, says what Child safety is for, and sends the reason first', () => {
        const src = read('components/ReportReasonBox.tsx');
        expect(src).toMatch(/import \{[^}]*\bREPORT_REASONS\b[^}]*\} from '\.\.\/utils\/reportReasons'/);
        expect(src).toContain('{REPORT_REASONS.map((r) =>');
        expect(src).toContain(HINT);
        expect(src).toContain('placeholder="Add a few words (optional)"');
        expect(src).toContain('await onSubmit(reportReasonWithWords(reason, words));');
    });

    it('the event screen (components/EventDetail.tsx) reports through the shared box, never a fixed reason', () => {
        const src = read('components/EventDetail.tsx');
        expect(src).toMatch(/import \{[^}]*\bReportReasonBox\b[^}]*\} from '\.\/ReportReasonBox';/);
        expect(src).toMatch(/<ReportReasonBox onSubmit=\{report\}/);
        expect(src).toMatch(/reportAbuse\(identity\.publicKey, [^,]+, reason, post\.id\)/);
        expect(src).not.toContain('Event reported from the event screen');
    });

    it('an enterprise or project (app/treasury-detail.tsx) reports through the shared box, never a free-text reason', () => {
        const src = read('app/treasury-detail.tsx');
        expect(src).toMatch(/import \{[^}]*\bReportReasonBox\b[^}]*\} from '\.\.\/components\/ReportReasonBox';/);
        const b = box(src, '{showReportForm && (', 'Alert.alert(\'Reported\'');
        expect(b).toContain('<ReportReasonBox');
        expect(b).toContain('await reportAbuse(identity.publicKey, treasuryKey, reason, treasuryKey);');
        expect(b).not.toContain('TextInput');
        // A failed send rethrows after its alert, so the box keeps the choice and the words (review of #1912, finding 3;
        // the event screen's side is drawn in event-report-render.test.ts).
        expect(src).toMatch(/Alert\.alert\('Error', e\.message \|\| 'Could not submit report\.'\);\s*throw e;/);
    });

    // #1938 case 14 (adopted): every accepted report says the same thanks in the "Reported" dialog, and when the member's
    // words were left out (reportAbuse's `wordsLeftOut`), why, with the Child safety pair when that was picked. One helper
    // builds the body for all three screens. The event screen's dialog is drawn in event-report-render.test.ts; these
    // two screens can't be drawn here, so their call is read: the body from what reportAbuse answered and the reason sent.
    for (const [rel, reasonSent] of [
        ['components/EventDetail.tsx', 'reason'],
        ['app/treasury-detail.tsx', 'reason'],
        ['app/post/[id].tsx', 'finalReason'],
    ] as const) {
        it(`${rel} says the shared thanks, and why the words were left out, in its one "Reported" dialog`, () => {
            const src = read(rel);
            expect(src).toMatch(/import \{[^}]*\breportedAlertBody\b[^}]*\} from '(\.\.\/)+utils\/reportReasons';/);
            expect(src).toMatch(new RegExp(`const sent = await reportAbuse\\([^)]*\\b${reasonSent}\\b[^)]*\\);[\\s\\S]{0,480}Alert\\.alert\\('Reported', reportedAlertBody\\(sent\\?\\.wordsLeftOut, ${reasonSent}\\)\\);`));
            expect(src.match(/Alert\.alert\('Reported'/g)).toHaveLength(1);
            for (const old of ["moderators will review it", 'has been flagged for review', "Thanks. This community's moderators will take a look."]) expect(src).not.toContain(old);
        });
    }

    it('the dialog\'s words, one whole sentence each, joined with one space: the thanks; why the words were left out; Child safety still alerts', () => {
        expect(REPORT_SENT_TEXT).toBe("Thanks. This community's moderators will take a look.");
        expect(REPORT_WORDS_LEFT_OUT_PRIVATE_TEXT).toBe('Your words were not sent, because this phone knows this as a private chat.');
        expect(REPORT_WORDS_LEFT_OUT_UNREAD_TEXT).toBe("Your words were not sent, because this phone couldn't read which chats here are private.");
        expect(REPORT_CHILD_SAFETY_ALERTED_TEXT).toBe("Because you chose Child safety, the people who run this community's server are alerted even without your words.");
        expect(CHILD_IN_DANGER_TEXT).toBe('If a child is in danger right now, call your local emergency number first.');
        const both = `${REPORT_CHILD_SAFETY_ALERTED_TEXT} ${CHILD_IN_DANGER_TEXT}`;
        // Picked another reason, and the words read as child safety (15 Oct words design, D3): never "Because you chose".
        expect(REPORT_CHILD_SAFETY_CLASSIFIED_TEXT).toBe("Your words looked like a report about a child's safety, so it went as Child safety.");
        expect(REPORT_CHILD_SAFETY_CLASSIFIED_ALERTED_TEXT).toBe("The people who run this community's server are alerted even without your words.");
        const looked = `${REPORT_CHILD_SAFETY_CLASSIFIED_TEXT} ${REPORT_CHILD_SAFETY_CLASSIFIED_ALERTED_TEXT} ${CHILD_IN_DANGER_TEXT}`;
        // private / unread / words went, x Child safety or not, x words typed or not (none typed: nothing is left out).
        expect(reportedAlertBody(undefined, 'Child safety')).toBe(REPORT_SENT_TEXT);
        expect(reportedAlertBody(undefined, 'Child safety: he asked my son for photos')).toBe(REPORT_SENT_TEXT);
        expect(reportedAlertBody(undefined, 'Other: loud music')).toBe(REPORT_SENT_TEXT);
        expect(reportedAlertBody('private', 'Other: loud music')).toBe(`${REPORT_SENT_TEXT} ${REPORT_WORDS_LEFT_OUT_PRIVATE_TEXT}`);
        expect(reportedAlertBody('unread', 'Spam or scam: the code is 4821')).toBe(`${REPORT_SENT_TEXT} ${REPORT_WORDS_LEFT_OUT_UNREAD_TEXT}`);
        expect(reportedAlertBody('private', 'Child safety: he asked my son for photos')).toBe(`${REPORT_SENT_TEXT} ${REPORT_WORDS_LEFT_OUT_PRIVATE_TEXT} ${both}`);
        expect(reportedAlertBody('unread', 'Child safety: he asked my son for photos')).toBe(`${REPORT_SENT_TEXT} ${REPORT_WORDS_LEFT_OUT_UNREAD_TEXT} ${both}`);
        // As the server reads it, by the prefix: a reason that only mentions it is not Child safety.
        expect(pickedChildSafety('Child safety')).toBe(true);
        expect(pickedChildSafety('Child safety: x')).toBe(true);
        expect(pickedChildSafety('Other: Child safety')).toBe(false);
        // But the server's rule over the full reason (@beanpool/core reportKind) reads words that say child safety under any
        // reason, so with the words left out the report went as "Child safety" (db.ts reportReasonFor) and the dialog says it
        // alerts (#1938 confirmation 10, finding 1, the director's ruling (i)); ordinary words under that reason do not.
        expect(reportedAlertBody('unread', 'Other: Child safety')).toBe(`${REPORT_SENT_TEXT} ${REPORT_WORDS_LEFT_OUT_UNREAD_TEXT} ${looked}`);
        expect(reportedAlertBody('private', 'Offensive content: he is grooming a child, sexual abuse of a minor')).toBe(`${REPORT_SENT_TEXT} ${REPORT_WORDS_LEFT_OUT_PRIVATE_TEXT} ${looked}`);
        // The server's own false positive (test-alerts-reports): it went as Child safety, and "looked like" is still true.
        expect(reportedAlertBody('unread', 'Spam or scam: fake child safety gates for sale')).toBe(`${REPORT_SENT_TEXT} ${REPORT_WORDS_LEFT_OUT_UNREAD_TEXT} ${looked}`);
        for (const reason of ['Other: Child safety', 'Offensive content: he is grooming a child, sexual abuse of a minor', 'Spam or scam: fake child safety gates for sale']) {
            expect(reportedAlertBody('private', reason)).not.toContain('Because you chose');
        }
        expect(reportedAlertBody('unread', 'Offensive content: shouted at the market')).toBe(`${REPORT_SENT_TEXT} ${REPORT_WORDS_LEFT_OUT_UNREAD_TEXT}`);
        expect(reportedAlertBody(undefined, 'Offensive content: he is grooming a child, sexual abuse of a minor')).toBe(REPORT_SENT_TEXT);
        for (const said of [REPORT_SENT_TEXT, REPORT_WORDS_LEFT_OUT_PRIVATE_TEXT, REPORT_WORDS_LEFT_OUT_UNREAD_TEXT, REPORT_CHILD_SAFETY_ALERTED_TEXT, REPORT_CHILD_SAFETY_CLASSIFIED_TEXT, REPORT_CHILD_SAFETY_CLASSIFIED_ALERTED_TEXT, CHILD_IN_DANGER_TEXT]) {
            expect(said).toMatch(/^[A-Z].*\.$/);
            expect(said).not.toMatch(/fail|try again|report again/i);
        }
    });

    it('what a report sends: the picked reason first, then any words', () => {
        expect(reportReasonWithWords(CHILD_SAFETY_REASON, '')).toBe('Child safety');
        expect(reportReasonWithWords(CHILD_SAFETY_REASON, '   ')).toBe('Child safety');
        expect(reportReasonWithWords(CHILD_SAFETY_REASON, ' messages to my daughter ')).toBe('Child safety: messages to my daughter');
        expect(reportReasonWithWords('Other', 'x')).toBe('Other: x');
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

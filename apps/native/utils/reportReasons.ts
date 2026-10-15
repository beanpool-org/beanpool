/**
 * The reasons a member picks when reporting (the post screen, the Pulse card). "Child safety" is read by the server as
 * it is picked (services/alerts.ts pickedChildSafety): the owners and admins are told at once, urgent, by count only.
 * Keep its words exactly.
 */
import { t, word, reportKind } from '@beanpool/core';

export const CHILD_SAFETY_REASON = 'Child safety';
export const CHILD_SAFETY_HINT = 'A child at risk, or sexual content involving a minor.';

export const REPORT_REASONS = ['Spam or scam', 'Offensive content', 'Misleading post', CHILD_SAFETY_REASON, 'Other'] as const;

/** Why a report went with the reason picked but not the member's words (reportAbuse's `wordsLeftOut`, #1938 case 14). */
export type ReportWordsLeftOut = 'private' | 'unread';

// The "Reported" dialog's body, one whole sentence each, word() keys put through t() by reportedAlertBody and joined
// with one space. Never red, never "failed" or "try again", no next step: the report itself went.
const REPORTED_WORDS = {
    /** Every accepted report, on all three report screens (event, enterprise or project, post). */
    sent: word("Thanks. This community's moderators will take a look."),
    /** The words were left out because the id the report names is a known DM's (refuseReadableIntoDm: GroupChatKeyError). */
    private: word('Your words were not sent, because this phone knows this as a private chat.'),
    /** The words were left out because the guard couldn't tell (the DM pins or the guard list unreadable, or any other error). */
    unread: word("Your words were not sent, because this phone couldn't read which chats here are private."),
    /**
     * Either left-out case when the member picked Child safety: the server reads that reason, never the words, so it still
     * alerts. Only when picked (15 Oct words design, D3): when the words made it go as Child safety, the two below.
     */
    childSafetyAlerted: word("Because you chose Child safety, the people who run this community's server are alerted even without your words."),
    /** Either left-out case when the member picked another reason and their words read as child safety (D3). */
    childSafetyClassified: word("Your words looked like a report about a child's safety, so it went as Child safety."),
    /** With the sentence above. */
    childSafetyClassifiedAlerted: word("The people who run this community's server are alerted even without your words."),
    /** With the sentence above (the guide's own sentence). */
    childInDanger: word('If a child is in danger right now, call your local emergency number first.'),
} as const;
export const REPORT_SENT_TEXT = REPORTED_WORDS.sent;
export const REPORT_WORDS_LEFT_OUT_PRIVATE_TEXT = REPORTED_WORDS.private;
export const REPORT_WORDS_LEFT_OUT_UNREAD_TEXT = REPORTED_WORDS.unread;
export const REPORT_CHILD_SAFETY_ALERTED_TEXT = REPORTED_WORDS.childSafetyAlerted;
export const REPORT_CHILD_SAFETY_CLASSIFIED_TEXT = REPORTED_WORDS.childSafetyClassified;
export const REPORT_CHILD_SAFETY_CLASSIFIED_ALERTED_TEXT = REPORTED_WORDS.childSafetyClassifiedAlerted;
export const CHILD_IN_DANGER_TEXT = REPORTED_WORDS.childInDanger;

/** True when `reason` (as the screen sent it, words and all) was Child safety: as the server reads it, by the prefix. */
export function pickedChildSafety(reason: string): boolean {
    return reason === CHILD_SAFETY_REASON || reason.startsWith(`${CHILD_SAFETY_REASON}:`);
}

/**
 * The "Reported" dialog's body after the node took a report: the thanks; then, when the member's words were left out
 * (`wordsLeftOut`), why; then, when the report went as Child safety, that it still alerts and the emergency sentence.
 * It went as Child safety when the server's own rule (@beanpool/core reportKind) reads the full reason, words and all,
 * as child safety: picked, or written in under another reason (db.ts reportReasonFor sends "Child safety" then; #1938
 * confirmation 10, finding 1, the director's ruling (i)). "Because you chose Child safety" only when it was picked;
 * otherwise the words looked like it (15 Oct words design, D3), which is also true of the server's false positives.
 */
export function reportedAlertBody(wordsLeftOut: ReportWordsLeftOut | undefined, reason: string): string {
    const said: string[] = [t(REPORTED_WORDS.sent)];
    if (wordsLeftOut) {
        if (wordsLeftOut === 'private') said.push(t(REPORTED_WORDS.private));
        else said.push(t(REPORTED_WORDS.unread));
        if (reportKind(reason) === 'child safety') {
            said.push(...(pickedChildSafety(reason)
                ? [t(REPORTED_WORDS.childSafetyAlerted)]
                : [t(REPORTED_WORDS.childSafetyClassified), t(REPORTED_WORDS.childSafetyClassifiedAlerted)]), t(REPORTED_WORDS.childInDanger));
        }
    }
    return said.join(' ');
}

/** What a report sends: the picked reason first, where the server reads it, then the member's own words if any. */
export function reportReasonWithWords(reason: string, words: string): string {
    const w = words.trim();
    return w ? `${reason}: ${w}` : reason;
}

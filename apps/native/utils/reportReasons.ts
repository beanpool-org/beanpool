/**
 * The reasons a member picks when reporting (the post screen, the Pulse card). "Child safety" is read by the server as
 * it is picked (services/alerts.ts pickedChildSafety): the owners and admins are told at once, urgent, by count only.
 * Keep its words exactly.
 */
export const CHILD_SAFETY_REASON = 'Child safety';
export const CHILD_SAFETY_HINT = 'A child at risk, or sexual content involving a minor.';

export const REPORT_REASONS = ['Spam or scam', 'Offensive content', 'Misleading post', CHILD_SAFETY_REASON, 'Other'] as const;

/** Why a report went with the reason picked but not the member's words (reportAbuse's `wordsLeftOut`, #1938 case 14). */
export type ReportWordsLeftOut = 'private' | 'unread';

// The "Reported" dialog's body, one whole sentence each (the t() pass wraps them one for one), joined with one space by
// reportedAlertBody. Never red, never "failed" or "try again", no next step: the report itself went.
/** Every accepted report, on all three report screens (event, enterprise or project, post). */
export const REPORT_SENT_TEXT = "Thanks. This community's moderators will take a look.";
/** The words were left out because the id the report names is a known DM's (refuseReadableIntoDm: GroupChatKeyError). */
export const REPORT_WORDS_LEFT_OUT_PRIVATE_TEXT = 'Your words were not sent, because this phone knows this as a private chat.';
/** The words were left out because the guard couldn't tell (the DM pins or the guard list unreadable, or any other error). */
export const REPORT_WORDS_LEFT_OUT_UNREAD_TEXT = "Your words were not sent, because this phone couldn't read which chats here are private.";
/** Either left-out case with Child safety picked: the server reads the picked reason, never the words, so it still alerts. */
export const REPORT_CHILD_SAFETY_ALERTED_TEXT = "Because you chose Child safety, the people who run this community's server are alerted even without your words.";
/** With the sentence above (the guide's own sentence). */
export const CHILD_IN_DANGER_TEXT = 'If a child is in danger right now, call your local emergency number first.';

/** True when `reason` (as the screen sent it, words and all) was Child safety: as the server reads it, by the prefix. */
export function pickedChildSafety(reason: string): boolean {
    return reason === CHILD_SAFETY_REASON || reason.startsWith(`${CHILD_SAFETY_REASON}:`);
}

/**
 * The "Reported" dialog's body after the node took a report: the thanks; then, when the member's words were left out
 * (`wordsLeftOut`), why; then, with Child safety picked, that it still alerts and the emergency sentence.
 */
export function reportedAlertBody(wordsLeftOut: ReportWordsLeftOut | undefined, reason: string): string {
    const said: string[] = [REPORT_SENT_TEXT];
    if (wordsLeftOut) {
        said.push(wordsLeftOut === 'private' ? REPORT_WORDS_LEFT_OUT_PRIVATE_TEXT : REPORT_WORDS_LEFT_OUT_UNREAD_TEXT);
        if (pickedChildSafety(reason)) said.push(REPORT_CHILD_SAFETY_ALERTED_TEXT, CHILD_IN_DANGER_TEXT);
    }
    return said.join(' ');
}

/** What a report sends: the picked reason first, where the server reads it, then the member's own words if any. */
export function reportReasonWithWords(reason: string, words: string): string {
    const w = words.trim();
    return w ? `${reason}: ${w}` : reason;
}

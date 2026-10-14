/**
 * The reasons a member picks when reporting (the post screen, the Pulse card). "Child safety" is read by the server as
 * it is picked (services/alerts.ts pickedChildSafety): the owners and admins are told at once, urgent, by count only.
 * Keep its words exactly.
 */
export const CHILD_SAFETY_REASON = 'Child safety';
export const CHILD_SAFETY_HINT = 'A child at risk, or sexual content involving a minor.';

export const REPORT_REASONS = ['Spam or scam', 'Offensive content', 'Misleading post', CHILD_SAFETY_REASON, 'Other'] as const;

/**
 * Said under a report box after a report that went with the reason picked but not the member's own words (reportAbuse's
 * `wordsLeftOut`: the phone couldn't be sure the id the report names is not a private chat's, #1938 confirmation 9).
 * Never before a send and never as an error: the report itself went.
 */
// WORDS: Fable call pending (case 14) — the director replaces this text
export const REPORT_WORDS_LEFT_OUT = 'Your report was sent with the reason you picked. Your own words were not sent: this phone couldn\'t check it was safe to send them here.';

/** What a report sends: the picked reason first, where the server reads it, then the member's own words if any. */
export function reportReasonWithWords(reason: string, words: string): string {
    const w = words.trim();
    return w ? `${reason}: ${w}` : reason;
}

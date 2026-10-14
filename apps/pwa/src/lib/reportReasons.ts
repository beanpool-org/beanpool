import { word } from '@beanpool/core';

/**
 * The reasons a member picks when reporting. "Child safety" is read by the server as it is picked (services/alerts.ts
 * pickedChildSafety): the owners and admins are told at once, urgent, by count only. Keep its words exactly.
 */
export const CHILD_SAFETY_REASON = 'Child safety';
export const CHILD_SAFETY_HINT = 'A child at risk, or sexual content involving a minor.';

export const REPORT_REASONS = ['Spam or scam', 'Offensive content', 'Misleading post', CHILD_SAFETY_REASON, 'Other'];

/** Where the visitor's line leads: the website's safety page (who reviews reports, and how to write to us). */
export const VISITOR_REPORT_URL = 'https://beanpool.org/safety.html';

/** A report's words, shown with t(REPORT_WORDS.…) where they are read. */
export const REPORT_WORDS = {
    /**
     * Said where the report was made, once the node has taken it (rehearsal 14 Oct N3: it was a browser alert()). Never
     * before: a send that fails says why in the same place. The node's operator reviews reports (safety.html §2).
     */
    sent: word("Report sent. This community's operator will review it. Thank you for helping keep it safe."),
    /** A signed-out visitor has no report of their own (a report is a member's, signed); nothing here sends anything. */
    visitorLine: word('Something wrong here? Members report it from the listing.'),
    visitorLink: word('Without an account, tell us on our safety page.'),
} as const;

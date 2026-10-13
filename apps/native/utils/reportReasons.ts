/**
 * The reasons a member picks when reporting (the post screen, the Pulse card). "Child safety" is read by the server as
 * it is picked (services/alerts.ts pickedChildSafety): the owners and admins are told at once, urgent, by count only.
 * Keep its words exactly.
 */
export const CHILD_SAFETY_REASON = 'Child safety';
export const CHILD_SAFETY_HINT = 'A child at risk, or sexual content involving a minor.';

export const REPORT_REASONS = ['Spam or scam', 'Offensive content', 'Misleading post', CHILD_SAFETY_REASON, 'Other'] as const;

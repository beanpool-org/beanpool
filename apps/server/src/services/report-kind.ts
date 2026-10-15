/**
 * What kind a report is, read from its reason: one of the apps' fixed choices, child safety, or other. Never its words.
 * Moved out of alerts.ts (which re-exports it) so the state engine can mark and sort the Reports queue by it without an
 * import cycle. The rule itself lives in @beanpool/core (report-kind.ts), unchanged, so the phone reads child safety the
 * same way when it leaves a member's words out of a report (#1938 confirmation 10, finding 1).
 */

export { type ReportKind, CHILD_SAFETY_REASON, pickedChildSafety, reportKind } from '@beanpool/core';

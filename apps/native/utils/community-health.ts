/**
 * Community health on an admin's phone (community modes slice 6; apps/server engine/community-health.ts). The node
 * answers the exceptions by member key and names-list entry id, never a name: the name is overlaid here, from the
 * names list this phone has opened and decrypted. Every opening of the exceptions is in a log every admin can read.
 *
 * Shared with the web app (DESIGN-names-list-web-fable.md S1): @beanpool/core names-list-health.ts, moved from here
 * unchanged. The requests are the phone's names-list flows (fetchHealthExceptions, fetchHealthSummary, fetchHealthLog).
 */
export {
    nameFor, reasonText, exceptionRows, readWaitingLines, departedRows, byTokenText, healthLogText, tradeLookText, readHealthTotals,
    totalsRows, healthFailure, notOnThisNode, exceptionsFailureText, HEALTH_COPY, healthLogSections,
} from '@beanpool/core';
export type {
    HealthReason, HealthException, DepartedDebt, HealthRule, HealthExceptionsBody, HealthLogLine, HealthRow, HealthTotals, HealthFailure,
    HealthLogSection,
} from '@beanpool/core';

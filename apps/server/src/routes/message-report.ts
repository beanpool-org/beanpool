// A report of one chat message, group line or direct line alike, once its line has been checked: what the two routes share
// (routes/groups.ts, routes/messaging.ts). One report per reporter per message, repeats answered as /api/reports answers
// them: the one on file, changed only to Child safety; and Child safety on one a moderator closed is a new report, as
// /api/reports files one once nothing is pending.

import { word } from '@beanpool/core';
import { isReportRateLimited } from '../state-engine.js';
import { noteNewReport, reportKind } from '../services/alerts.js';
import { logger } from '../logger.js';
import { changeGroupLineReportReason, groupLineReportOnFile, type GroupLineReport } from '../engine/group-chat-report.js';

export function fileMessageReport(ctx: any, actor: string, messageId: string, reason: string, submit: () => GroupLineReport | null): void {
    // Every alert judges the 500 characters the queue keeps, as /api/reports does.
    const kept = reason.slice(0, 500);
    const onFile = groupLineReportOnFile(actor, messageId);
    const child = reportKind(kept) === 'child safety';
    // Child safety on a report a moderator dismissed or handled (the deciding review of #2470): filed below as a new
    // one, with what was handed over with it, and told. The closed one is never reopened or changed: an actioned report
    // counts towards a suspension (member-wizards.ts reportMaySuspend). Any other repeat of a closed one is the one
    // on file still.
    if (onFile && !(child && onFile.status !== 'pending')) {
        if (child && reportKind(onFile.reason) !== 'child safety') {
            const changed = changeGroupLineReportReason(onFile.id, kept);
            if (changed) {
                noteNewReport(kept, actor).catch((e) => logger.warn('SYS', `[Alerts] A report changed to child safety could not be told: ${e instanceof Error ? e.message : String(e)}`));
                ctx.body = { success: true, report: changed, duplicate: true };
                return;
            }
        }
        ctx.body = { success: true, report: onFile, duplicate: true };
        return;
    }
    if (isReportRateLimited(actor)) {
        ctx.status = 429;
        ctx.body = { error: 'rate_limited', message: 'You have sent a lot of reports recently. Please try again in an hour.' };
        return;
    }
    const report = submit();
    if (!report) {
        ctx.status = 400;
        ctx.body = { error: word('Failed — must be a registered member, cannot report yourself') };
        return;
    }
    // The owners and admins hear of it by kind and count, never who or what, as for any report.
    noteNewReport(kept, actor).catch((e) => logger.warn('SYS', `[Alerts] A new report could not be told: ${e instanceof Error ? e.message : String(e)}`));
    ctx.body = { success: true, report };
}

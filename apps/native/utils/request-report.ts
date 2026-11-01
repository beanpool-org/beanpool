/**
 * Report on a message request (Damo via Marty, 1 Nov 2026): one tap's worth of two things, the line's report (core
 * dm-line-report.ts) and a block of its sender. The report goes first, while the line is still there to report. Nothing is
 * said to be done that wasn't: a block that didn't happen throws ReportedNotBlockedError when the report went, so the sheet
 * stays and a second try blocks them (the node answers the report's repeat as the one on file). The block files no report of
 * its own.
 *
 * Report on a request always blocks. A line its sender deleted leaves a tombstone and the request waiting: nothing is left to
 * hand over, so it blocks with no report, and says so (`no_line`). A report the node refuses blocks too, the hourly limit
 * (429) above all: someone flooded with requests is who reaches it. Only no answer from the node at all stops it, and that
 * throws as any report does, for a second try.
 */
import { requestReportRefused, t, type RequestReportOutcome } from '@beanpool/core';
import { reportDmLine } from './db';
import { blockUser, isUserBlocked } from './blocklist';
import { isTombstone } from './chat-actions';

export class ReportedNotBlockedError extends Error {
    constructor() {
        super('Reported, not blocked');
        this.name = 'ReportedNotBlockedError';
    }
}

/**
 * The request's line in a chat's messages: the other person's newest, or null when none is left to hand over (a tombstone is
 * no line: the node takes no report of it). By `rawTimestamp`, the node's time: a row's `timestamp` is the clock face the
 * bubble shows, which doesn't sort.
 */
export function requestLineIn<T extends { senderId?: string; type?: string; rawTimestamp?: string; metadata?: any }>(messages: readonly T[], myPubkey: string | null | undefined): T | null {
    const theirs = messages.filter((m) => !!m.senderId && m.senderId !== myPubkey && m.senderId !== 'SYSTEM' && m.type !== 'system' && !isTombstone(m));
    return theirs.reduce<T | null>((newest, m) => (!newest || String(m.rawTimestamp ?? '') >= String(newest.rawTimestamp ?? '') ? m : newest), null);
}

/** What a line reads as here: never the words standing in for one that didn't open. */
export function wordsOfLine(line: { text?: string | null; unattributed?: boolean }): string {
    return line.unattributed ? '' : line.text ?? '';
}

/** Report `line` (null: none is left to hand over) and block `peer`: what became of the report, once they are blocked. */
export async function reportRequestAndBlock(conversationId: string, line: { id: string; text?: string | null; unattributed?: boolean } | null, peer: string, reason: string): Promise<RequestReportOutcome> {
    let outcome: RequestReportOutcome = 'no_line';
    if (line) {
        try {
            await reportDmLine(conversationId, String(line.id), wordsOfLine(line), reason);
            outcome = 'reported';
        } catch (e: any) {
            const refused = requestReportRefused(e);
            if (!refused) throw e;
            outcome = refused;
        }
    }
    const blocked = await blockUser(peer);
    // blockUser says false rather than throwing (no account on the phone, the list not written, or blocked already).
    if (!blocked && !(await isUserBlocked(peer))) {
        throw outcome === 'reported' ? new ReportedNotBlockedError() : new Error(t('That did not go through. Please try again.'));
    }
    return outcome;
}

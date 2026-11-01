/**
 * Report on a message request (Damo via Marty, 1 Nov 2026): one tap's worth of two things, the line's report (core
 * dm-line-report.ts) and a block of its sender. The report goes first, while the line is still there to report. Nothing is
 * said to be done that wasn't: a report the node didn't take throws as any report does, and a block that didn't happen throws
 * ReportedNotBlockedError, so the sheet stays and a second try blocks them (the node answers the report's repeat as the one
 * on file). The block files no report of its own.
 *
 * The moderators' hourly limit on reports never costs a member their block: someone flooded with requests is who reaches it.
 * A report refused for that alone (429) still blocks, and says the report didn't go (`false`).
 */
import { reportDmLine } from './db';
import { blockUser, isUserBlocked } from './blocklist';

export class ReportedNotBlockedError extends Error {
    constructor() {
        super('Reported, not blocked');
        this.name = 'ReportedNotBlockedError';
    }
}

/**
 * The request's line in a chat's messages: the other person's newest. By `rawTimestamp`, the node's time: a row's `timestamp`
 * is the clock face the bubble shows, which doesn't sort.
 */
export function requestLineIn<T extends { senderId?: string; type?: string; rawTimestamp?: string }>(messages: readonly T[], myPubkey: string | null | undefined): T | null {
    const theirs = messages.filter((m) => !!m.senderId && m.senderId !== myPubkey && m.senderId !== 'SYSTEM' && m.type !== 'system');
    return theirs.reduce<T | null>((newest, m) => (!newest || String(m.rawTimestamp ?? '') >= String(newest.rawTimestamp ?? '') ? m : newest), null);
}

/** What a line reads as here: never the words standing in for one that didn't open. */
export function wordsOfLine(line: { text?: string | null; unattributed?: boolean }): string {
    return line.unattributed ? '' : line.text ?? '';
}

/** True when both went, false when the report was over the hourly limit and only the block did. */
export async function reportRequestAndBlock(conversationId: string, line: { id: string; text?: string | null; unattributed?: boolean }, peer: string, reason: string): Promise<boolean> {
    let reported = true;
    try {
        await reportDmLine(conversationId, String(line.id), wordsOfLine(line), reason);
    } catch (e: any) {
        if (e?.status !== 429) throw e;
        reported = false;
    }
    const blocked = await blockUser(peer);
    // blockUser says false rather than throwing (no account on the phone, the list not written, or blocked already).
    if (!blocked && !(await isUserBlocked(peer))) throw new ReportedNotBlockedError();
    return reported;
}

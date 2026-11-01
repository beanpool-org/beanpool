/**
 * Reporting a direct message's line from the web (core dm-line-report.ts; the node's engine/dm-line-report.ts): the sealed
 * line as this browser holds it, its sender's signature, and what it reads as here. No key goes, and nothing else of the
 * chat. Report on a message request (Damo via Marty, 1 Nov 2026) does that and blocks its sender. The report goes first; a
 * block that doesn't go through says so and a second try blocks them (the node answers the report's repeat as the one on
 * file).
 *
 * Report on a request always blocks. A line its sender deleted leaves a tombstone and the request waiting: nothing is left to
 * hand over (`no_line`). A line the node refuses blocks too (`refused`). In both the block carries a report of the person,
 * with the member's reason, so a sender can't take the moderators out of it by deleting their line: Child safety still alerts,
 * and a report that can't be sent yet is queued (blocklist.ts). Over the hourly limit (429, `over_limit`) it blocks with no
 * report: someone flooded with requests is who reaches it. A report that went needs no second one. Only no answer from the
 * node at all stops it, and that is tried again.
 */
import { dmLineDisclosureFor, t } from '@beanpool/core';
import { getConversationMessages, reportDmLineApi, type ApiMessage, type Conversation } from './api';
import { blockUser } from './blocklist';
import { requestPreviewLines, requestReportRefused, type RequestReportOutcome } from './dm-requests';

export async function reportDmLine(conversationId: string, line: Pick<ApiMessage, 'id' | 'ciphertext' | 'nonce' | 'metadata'>, words: string, reason: string): Promise<void> {
    await reportDmLineApi(line.id, reason, dmLineDisclosureFor({ ciphertext: line.ciphertext, nonce: line.nonce, conversationId, metadata: line.metadata }, words));
}

/**
 * Report the request's line, read afresh from the node, and block its sender: what became of the report once they are
 * blocked. Throws a sentence for the card to show when no block went, or the report had no answer.
 */
export async function reportRequestAndBlock(conv: Conversation & { request: NonNullable<Conversation['request']> }, me: { publicKey: string; privateKey: string }, reason: string): Promise<RequestReportOutcome> {
    const read = await getConversationMessages(conv.id, 20);
    const messages = read.messages ?? [];
    const rows = new Map(messages.map((m) => [m.id, m]));
    // Its newest line that is still one: a tombstone stays in the thread, but the node takes no report of it.
    const line = requestPreviewLines({ ...conv, ...(read.conversation ?? {}), request: read.conversation?.request ?? conv.request }, me, messages)
        .filter((l) => rows.get(l.id)?.type !== 'removed').at(-1);
    const row = line && rows.get(line.id);
    let outcome: RequestReportOutcome = 'no_line';
    if (line && row) {
        try {
            await reportDmLine(conv.id, row, line.words, reason);
            outcome = 'reported';
        } catch (e) {
            const refused = requestReportRefused(e);
            if (!refused) throw e;
            outcome = refused;
        }
    }
    try {
        await (outcome === 'no_line' || outcome === 'refused' ? blockUser(conv.request.from, me.publicKey, reason) : blockUser(conv.request.from));
    } catch (e) {
        // The node's own refusal, the limit of 500 blocks above all, which trying again won't change: its sentence, as Block
        // shows it (a BlocklistError carries the status). No answer from the node is what a second try is for.
        if (requestReportRefused(e)) throw e;
        throw new Error(outcome === 'reported' ? t('Reported, but not blocked. Please try again.') : t('That did not go through. Please try again.'));
    }
    return outcome;
}

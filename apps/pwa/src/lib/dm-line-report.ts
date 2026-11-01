/**
 * Reporting a direct message's line from the web (core dm-line-report.ts; the node's engine/dm-line-report.ts): the sealed
 * line as this browser holds it, its sender's signature, and what it reads as here. No key goes, and nothing else of the
 * chat. Report on a message request (Damo via Marty, 1 Nov 2026) does that and blocks its sender. The report goes first; a
 * block that doesn't go through says so and a second try blocks them (the node answers the report's repeat as the one on
 * file). The block files no report of its own.
 */
import { dmLineDisclosureFor, t } from '@beanpool/core';
import { getConversationMessages, reportDmLineApi, type ApiMessage, type Conversation } from './api';
import { blockUser } from './blocklist';
import { requestPreviewLines } from './dm-requests';

export async function reportDmLine(conversationId: string, line: Pick<ApiMessage, 'id' | 'ciphertext' | 'nonce' | 'metadata'>, words: string, reason: string): Promise<void> {
    await reportDmLineApi(line.id, reason, dmLineDisclosureFor({ ciphertext: line.ciphertext, nonce: line.nonce, conversationId, metadata: line.metadata }, words));
}

/** Report the request's line, read afresh from the node, and block its sender. Throws a sentence for the card to show. */
export async function reportRequestAndBlock(conv: Conversation & { request: NonNullable<Conversation['request']> }, me: { publicKey: string; privateKey: string }, reason: string): Promise<void> {
    const read = await getConversationMessages(conv.id, 20);
    const messages = read.messages ?? [];
    const line = requestPreviewLines({ ...conv, ...(read.conversation ?? {}), request: read.conversation?.request ?? conv.request }, me, messages).at(-1);
    const row = line && messages.find((m) => m.id === line.id);
    if (!line || !row) throw new Error(t('That did not go through. Please try again.'));
    await reportDmLine(conv.id, row, line.words, reason);
    try {
        await blockUser(conv.request.from);
    } catch {
        throw new Error(t('Reported, but not blocked. Please try again.'));
    }
}

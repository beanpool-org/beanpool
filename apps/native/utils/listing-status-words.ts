/**
 * A listing's or its deal's status as Talk shows it on a pill (the conversation row, the chat's listing header): word()
 * keys, shown through t(). Written in capitals in the words themselves, never upper-cased in code; a status this build
 * doesn't know is shown as the node wrote it.
 */
import { t, word, type WordKey } from '@beanpool/core';

const STATUS_WORDS: Readonly<Record<string, WordKey>> = {
    active: word('ACTIVE', 'listing status'),
    pending: word('HELD IN TRUST'),
    completed: word('COMPLETED', 'deal status'),
    cancelled: word('CANCELLED', 'deal status'),
    requested: word('REQUESTED', 'deal status'),
    rejected: word('REJECTED', 'deal status'),
    paused: word('PAUSED', 'listing status'),
};

/** The conversation row's pill: "HELD IN TRUST" for a deal in escrow. */
export function listingStatusWords(status: string): string {
    return STATUS_WORDS[status] ? t(STATUS_WORDS[status]) : String(status).toUpperCase();
}

/** The chat's listing header: its status as the node says it ("PENDING" for a deal in escrow), or UNKNOWN. */
export function listingHeaderStatusWords(status: string | null | undefined): string {
    if (!status) return t('UNKNOWN', undefined, 'listing status');
    if (status === 'pending') return t('PENDING', undefined, 'deal status');
    return listingStatusWords(status);
}

/**
 * What a guest chat says on the phone (slice G2): a line of mine's tick, and why a closed chat is closed. Kept apart from
 * utils/guest-chat-live.ts so a screen's words never need the mailbox's modules.
 */
import { GUEST_CHAT_WORDS, t, type GuestLineState } from '@beanpool/core';

/** Why a closed chat is closed: core's one sentence for each reason the host gives, the same on the web. */
export { guestClosedWords } from '@beanpool/core';

const W = GUEST_CHAT_WORDS;

/** A line of mine, as its tick reads. */
export function guestLineStateWords(state: GuestLineState | undefined): string | null {
    switch (state) {
        case 'waiting': return t(W.waiting);
        case 'sending': return t('Sending…');
        case 'queued': return t('Waiting for their community');
        case 'sent': return t('Sent', undefined, 'a message');
        case 'failed': return t('Not delivered');
        default: return null;
    }
}

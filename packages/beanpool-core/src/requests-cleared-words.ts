/**
 * The words for "reports cleared your message requests" (engine/request-limits.ts, #2710), written by the apps in the member's
 * language. The server sends the code (403 `dm_requests_limited`, or a notice of kind `requests_cleared`) with its own English
 * sentence, which stays the fallback for an app that does not know this file. A newer app reads the date out of that sentence
 * (or from the notice's `until`) and writes the sentence itself, through the words layer, so it is one sentence in every
 * language: a rule, not a hint. A translation keeps "can't" and keeps the date.
 */
import { t } from './words.js';

/** The notice's `data.kind` (server engine/moderation-notices.ts notifyRequestsCleared). */
export const REQUESTS_CLEARED_KIND = 'requests_cleared';

/** The server's English sentence (engine/moderation-notices.ts requestsClearedBody), as the refusal and the notice carry it. */
const SERVER_SENTENCE = /^People you wrote to reported your message requests, so they were cleared and you can't send new ones until (\d{4}-\d{2}-\d{2})\. You can still answer people who wrote to you, and post\.$/;

const DAY = /^\d{4}-\d{2}-\d{2}/;

/** The sentence, in the member's language, for a limit that holds until `until` (an ISO date or time; its day shows). */
export function requestsClearedSentence(until: string): string {
    return t("People you wrote to reported your message requests, so they were cleared and you can't send new ones until {date}. You can still answer people who wrote to you, and post.", { date: until.slice(0, 10) });
}

/** The notice's title, in the member's language. */
export function requestsClearedTitle(): string {
    return t('🛡️ Your message requests were cleared');
}

/**
 * A refusal's message in the member's language when it is the server's sentence for a cleared limit; anything else (another
 * node's words, an older sentence) exactly as given.
 */
export function requestsLimitedWords(message: string): string {
    const m = SERVER_SENTENCE.exec(message);
    return m ? requestsClearedSentence(m[1]) : message;
}

/**
 * A notice's title and body in the member's language when it is the "message requests cleared" notice (its `kind` and `until`),
 * else null: the notice shows as the node wrote it.
 */
export function requestsClearedNotice(data: { kind?: unknown; until?: unknown } | null | undefined): { title: string; body: string } | null {
    if (!data || data.kind !== REQUESTS_CLEARED_KIND || typeof data.until !== 'string' || !DAY.test(data.until)) return null;
    return { title: requestsClearedTitle(), body: requestsClearedSentence(data.until) };
}

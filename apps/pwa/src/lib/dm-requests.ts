/**
 * Message requests in the web app (scratch/fable-design/DESIGN-message-a-friend-fable.md §4, slice S3; the server is
 * PR #2392, engine/dm-requests.ts). Where the community's `dmRequests` switch is on, a member's first message to someone
 * who hasn't added them, written to them or traded with them waits as a request: the person it is for reads it here and
 * accepts, ignores or blocks; the sender writes more once they accept.
 *
 * Everything here is read from what the node answers, and nothing more: the opener's view is `pending`, `expired` or
 * `accepted` whatever became of it (an ignore and a block look like a request nobody has opened), so the page can't tell
 * them apart either. Nothing here touches sealing, keys or pins: a request's lines are judged by the same thread check as
 * any DM's (core checkDmThread), with the reader's own key, and a photo in one is never fetched before Accept.
 */
import {
    t,
    type RequestMode,
    type DmRequestCore,
    REQUEST_CARDS_SHOWN,
    IGNORE_ALL_FROM,
    requestModeOf,
    requestTakesPhoto,
    requestAfterOwnLine,
    requestAfterRead,
    decisionFailureWords,
    requestPendingRefusal,
} from '@beanpool/core';
export {
    type RequestMode,
    type DmRequestCore,
    REQUEST_CARDS_SHOWN,
    IGNORE_ALL_FROM,
    requestModeOf,
    requestTakesPhoto,
    requestAfterOwnLine,
    requestAfterRead,
    decisionFailureWords,
    requestPendingRefusal,
};
import type { ApiMessage, Conversation, DmRequest } from './api';
import { checkDmThread, dmLineShownText, dmThreadInShownOrder } from './e2e-crypto';
import { dmKeyContext } from './dm-lock';

/** The time a stamp names, or NaN. */
const at = (iso: string | null | undefined) => (typeof iso === 'string' ? Date.parse(iso) : NaN);

/** One line of a request as its card shows it: the words that opened (or what stands in for them), or a closed photo. */
export interface RequestPreviewLine {
    id: string;
    /** The line's words as the thread check judged them: a photo's caption, empty for none. */
    text: string;
    /** A photo: shown as a placeholder until Accept, never fetched. */
    photo: boolean;
}

/**
 * The request's own lines, as its card shows them before the person decides: the opener's lines since it was made, each
 * judged by the thread check over the whole thread with the reader's key (bound to its author and id), so a line that
 * didn't open as theirs reads as the chat reads it, never its row's words. Oldest first.
 */
export function requestPreviewLines(
    conv: Conversation,
    me: { publicKey: string; privateKey: string },
    messages: ReadonlyArray<ApiMessage>,
): RequestPreviewLine[] {
    const r = conv.request;
    if (!r) return [];
    const shown = dmThreadInShownOrder(messages);
    const ctx = dmKeyContext(conv, me);
    const views = checkDmThread(shown.map((m) => ({
        id: m.id, authorPubkey: m.authorPubkey, ciphertext: m.ciphertext, nonce: m.nonce, type: m.type, metadata: m.metadata, timestamp: m.timestamp,
    })), ctx ? { myEdPrivHex: ctx.myEdPrivHex, peerEdPubHex: ctx.peerEdPubHex } : null, ctx?.conversationId ?? conv.id);
    const since = at(r.at);
    return shown
        .filter((m) => m.authorPubkey === r.from && m.type !== 'system' && at(m.timestamp) >= since)
        .map((m) => {
            const view = views.get(m.id);
            const photo = m.type === 'image';
            // A photo's body is its caption, usually empty: shown only when its words opened.
            const text = photo ? (view?.text ?? '') : dmLineShownText(view);
            return { id: m.id, text, photo };
        });
}



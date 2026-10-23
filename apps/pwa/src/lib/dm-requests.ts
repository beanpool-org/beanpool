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
import { t } from '@beanpool/core';
import type { ApiMessage, Conversation, DmRequest } from './api';
import { checkDmThread, dmLineShownText, dmThreadInShownOrder } from './e2e-crypto';
import { dmKeyContext } from './dm-lock';

/** The chat's request mode, for the reader. */
export type RequestMode =
    /** An ordinary chat: requests off, none on this chat, or accepted. */
    | 'none'
    /** A request waiting for the reader: they read it, then Accept, Ignore or Block; no composer until they accept. */
    | 'to-me'
    /** The reader's own request with no line of theirs in it yet (or one 30 days on): their next line is the request. */
    | 'mine-unsent'
    /** The reader's own request with their line in it: they can write more once it is accepted. */
    | 'mine-waiting'
    /** The reader's own waiting request while this chat's lines are still being read: whether their line is in it isn't
     *  known yet, so the page says neither, and offers nothing only an unsent request takes. */
    | 'mine-loading';

/** The most request cards one screen shows; the rest are counted ("and {n} more"), as the design's list. */
export const REQUEST_CARDS_SHOWN = 50;
/** Ignore all is offered when more than this many wait (design §4.5). */
export const IGNORE_ALL_FROM = 6;

/** The time a stamp names, or NaN. */
const at = (iso: string | null | undefined) => (typeof iso === 'string' ? Date.parse(iso) : NaN);

/**
 * The opener's lines in the chat since the request was made, for a node that doesn't say whether their next line is the
 * request (`nextLineIsRequest`): the node stamps the request at its line, so a line of theirs at or after `request.at` is
 * the request's (the server's OPENER_WROTE). Their own lines kept for them alone are among the lines the node gives them,
 * and count the same, as the node counts them while the block holds.
 */
function openerLinesSince(conv: Pick<Conversation, 'request'>, lines: ReadonlyArray<Pick<ApiMessage, 'authorPubkey' | 'timestamp' | 'type'>>): number {
    const r = conv.request;
    if (!r) return 0;
    const since = at(r.at);
    return lines.filter((l) => l.authorPubkey === r.from && l.type !== 'system' && Number.isFinite(at(l.timestamp)) && at(l.timestamp) >= since).length;
}

/**
 * What request mode a direct chat is in for `me`, from the node's `request` on it and the lines loaded (null until this
 * chat's have been read: no lines is not the same as none read). A request that isn't accepted is the person's to decide,
 * whatever state the node names to them. The opener's own: waiting once their line is in it, by the node's count where it
 * gives one, not known before their lines are read; `expired` (30 days) makes their next line a new request.
 */
export function requestModeOf(
    conv: Pick<Conversation, 'type' | 'request'> | null | undefined,
    me: string,
    lines: ReadonlyArray<Pick<ApiMessage, 'authorPubkey' | 'timestamp' | 'type'>> | null,
): RequestMode {
    const r = conv?.type === 'dm' ? conv.request : null;
    if (!r || r.state === 'accepted') return 'none';
    if (r.from !== me) return 'to-me';
    if (r.state === 'expired') return 'mine-unsent';
    if (!lines) return 'mine-loading';
    // The node's count, not the page's (PR #2404 review 4356625513): a line kept for the opener while they were blocked is
    // among their lines here, and once the block is lifted it is no request's line. The page can't tell it apart, and
    // mustn't, so it reads the node's word.
    if (typeof r.nextLineIsRequest === 'boolean') return r.nextLineIsRequest ? 'mine-unsent' : 'mine-waiting';
    return openerLinesSince(conv!, lines) > 0 ? 'mine-waiting' : 'mine-unsent';
}

/**
 * Whether the chat takes a photo now (📎, a paste or a drop): not while a request waits for the reader to decide, nor
 * while theirs waits for the other to accept, nor while the opener's chat is still being read.
 */
export function requestTakesPhoto(mode: RequestMode): boolean {
    return mode !== 'to-me' && mode !== 'mine-waiting' && mode !== 'mine-loading';
}

/**
 * The open chat's request once the node has taken a new line of the reader's (200): where the node said their next line
 * was the request's, that line was it, so the one after waits, whether or not the read after it comes back. The next read
 * replaces it with the node's word (requestAfterRead). Anything else is as it was.
 */
export function requestAfterOwnLine(r: DmRequest | null | undefined, me: string): DmRequest | null | undefined {
    if (!r || r.from !== me || r.state !== 'pending' || r.nextLineIsRequest !== true) return r;
    return { ...r, nextLineIsRequest: false };
}

/**
 * The open chat's request after a new read from the node: the node's, or null when the read names none (requests are off,
 * or it is an ordinary chat). One exception: an acceptance is never undone by a read of the same request that still names
 * it waiting, which was asked before the acceptance landed. The node never takes an acceptance back from either person.
 */
export function requestAfterRead(prev: DmRequest | null | undefined, read: Pick<Conversation, 'request'>): DmRequest | null {
    const next = read.request ?? null;
    if (prev?.state === 'accepted' && next && next.state !== 'accepted' && next.from === prev.from && next.at === prev.at) return prev;
    return next;
}

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

/** What a request card or the chat's request bar says when Accept or Ignore didn't go through. */
export function decisionFailureWords(e: unknown): string {
    const err = e as { status?: unknown; message?: unknown; unsaid?: unknown } | null | undefined;
    // The node answered and refused (a standby, a request that is gone): its own words. A page that wasn't the node's (a
    // proxy's), or no answer at all, is the community out of reach.
    if (err && typeof err.status === 'number' && err.status > 0 && !err.unsaid && typeof err.message === 'string' && err.message.trim()) return err.message;
    return t('Connect to your community to accept or ignore.');
}

/** The node's refusal of the opener's second line, or reaction, while their request waits (403 `dm_request_pending`). */
export function requestPendingRefusal(e: unknown): string | null {
    const err = e as { code?: unknown; message?: unknown } | null | undefined;
    return err?.code === 'dm_request_pending' && typeof err.message === 'string' && err.message.trim() ? err.message : null;
}

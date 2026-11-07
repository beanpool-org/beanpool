/**
 * "Busy right now": what both apps do when the network in front of a node says it is too busy (HTTP 429).
 *
 * Cloudflare can sit in front of a node and answer 429 before the request reaches it (a rate-limit rule on global's
 * API). That answer is NOT the node's JSON: it is an HTML page, or plain text such as `error code: 1015`, and it may carry
 * a `Retry-After`. A member must never see that page, never be told the node is offline, never be signed out or have a key
 * changed by it, and the app must not hammer the node again at once. So:
 *
 * - a busy answer is said in ONE sentence (`busyWords`), the same on the phone and the web, and carries the stable code
 *   `busy` and the status 429 (`busyError`), so a screen can tell it from a refusal;
 * - an idempotent read may be asked once more after `retryAfterMs` (never a write: no double posts, no double payments);
 * - the node's OWN 429s are not busy. The node answers 429 in JSON with a sentence of its own (`day_budget`: "You can carry
 *   on in about 6 hours"; "You're sending messages too fast"). "Try again in a moment" would be false for the first, so a
 *   body that is the node's JSON `error` is the node's answer and is said as it is (`isBusyAnswer`).
 *
 * Pure: no React, no device modules, no network.
 */
import { t } from './words.js';

/** The code a busy answer carries on the error both apps throw (`err.code`), beside `err.status === 429`. */
export const BUSY_CODE = 'busy';

/** How long to wait before the one retry of a read when the answer named no wait, and the least and most it may wait. */
export const BUSY_RETRY_DEFAULT_MS = 5_000;
export const BUSY_RETRY_MIN_MS = 1_000;
export const BUSY_RETRY_MAX_MS = 30_000;

/** The one sentence a member reads for a busy answer, in the member's language (both apps, wherever it is shown). */
export function busyWords(): string {
    return t('Busy right now. Try again in a moment.');
}

/** True for the status a busy network answers with: 429. */
export function isBusyStatus(status: unknown): boolean {
    return status === 429;
}

/**
 * Cloudflare's rate-limit answer (error 1015): its plain-text body (`error code: 1015`) or its HTML page (`Error 1015`, the
 * `cf-error-code` badge, "You are being rate limited"). Any status: the code says it, not the number.
 */
export function isCloudflareRateLimitBody(body: unknown): boolean {
    if (typeof body !== 'string' || !body) return false;
    return /\berror\s*(?:code)?:?\s*1015\b/i.test(body)
        || /cf-error-code[^>]*>\s*1015\b/i.test(body)
        || /you are being rate limited/i.test(body);
}

/**
 * A page a proxy or CDN put in a node's place: HTML, or a plain `error code: NNNN`, or Cloudflare by name. Never words for a
 * member to read: whoever shows a refusal falls back to its generic sentence.
 */
export function isProxyPage(body: unknown): boolean {
    if (typeof body !== 'string' || !body.trim()) return false;
    return /<\s*(?:!doctype|html|head|body)\b/i.test(body)
        || /\bcloudflare\b/i.test(body)
        || /^\s*error\s*code:?\s*\d{3,4}\s*$/i.test(body);
}

/** True for a parsed body that is the node's own answer: a JSON object with a sentence in `error`. */
export function isNodeAnswerBody(parsed: unknown): boolean {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const error = (parsed as { error?: unknown }).error;
    return typeof error === 'string' && error.trim() !== '';
}

/**
 * Whether an answer that is not ok is a busy network's, not the node's.
 *
 * `body`: the answer's body, as text or as the JSON already read from it; leave it out when it was not read. Busy when the
 * status is 429 or the body is Cloudflare's 1015 page, unless the body is the node's own JSON answer (a sentence in
 * `error`): that is the node's own limit, and is said in its own words.
 */
export function isBusyAnswer(status: unknown, body?: unknown): boolean {
    let parsed: unknown = body;
    if (typeof body === 'string') {
        try { parsed = JSON.parse(body); } catch { parsed = undefined; }
    }
    if (isNodeAnswerBody(parsed)) return false;
    return isBusyStatus(status) || isCloudflareRateLimitBody(body);
}

/**
 * Milliseconds to wait from a `Retry-After` header: whole seconds ("7") or an HTTP date. Never under 1 s or over 30 s (a
 * header asking for an hour does not hold a screen for an hour), and 5 s when the header is absent or unreadable.
 */
export function retryAfterMs(header: string | null | undefined, now: number = Date.now()): number {
    const clamp = (ms: number) => Math.min(BUSY_RETRY_MAX_MS, Math.max(BUSY_RETRY_MIN_MS, ms));
    const text = typeof header === 'string' ? header.trim() : '';
    if (!text) return BUSY_RETRY_DEFAULT_MS;
    if (/^\d+(?:\.\d+)?$/.test(text)) return clamp(Math.round(Number(text) * 1000));
    // An HTTP date has a day and month in letters and a four-digit year; Date.parse alone also reads "-3" and "soon 5".
    if (!/[a-z]{3}/i.test(text) || !/\d{4}/.test(text)) return BUSY_RETRY_DEFAULT_MS;
    const at = Date.parse(text);
    if (!Number.isFinite(at)) return BUSY_RETRY_DEFAULT_MS;
    return clamp(at - now);
}

/** The part of an AbortSignal the wait needs, so core takes no DOM or React Native types. */
export interface WaitSignal {
    readonly aborted: boolean;
    addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
    removeEventListener(type: 'abort', listener: () => void): void;
}

/**
 * Wait `ms` before a read's one retry, and stop waiting early if the caller gives up (`signal`): the retry's own fetch then
 * throws the abort as any fetch does. Resolves; never rejects.
 */
export function waitBeforeRetry(ms: number, signal?: WaitSignal | null): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted) { resolve(); return; }
        const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, ms);
        signal?.addEventListener('abort', done, { once: true });
    });
}

/** What both apps throw for a busy answer. */
export interface BusyError extends Error {
    status: 429;
    code: typeof BUSY_CODE;
    /** The node did not answer: the network in front of it did. */
    nodeAnswered: false;
    /** How long a read waits before its one retry (`retryAfterMs`). */
    retryAfterMs: number;
}

/** The error for a busy answer: the sentence for its message, status 429, code `busy`, and how long to wait. */
export function busyError(retryAfterHeader?: string | null, now: number = Date.now()): BusyError {
    const err = new Error(busyWords()) as BusyError;
    err.status = 429;
    err.code = BUSY_CODE;
    err.nodeAnswered = false;
    err.retryAfterMs = retryAfterMs(retryAfterHeader, now);
    return err;
}

/** True for an error `busyError` made (or one carrying its code). */
export function isBusyError(e: unknown): e is BusyError {
    return !!e && typeof e === 'object' && (e as { code?: unknown }).code === BUSY_CODE;
}

/**
 * The words for a refusal whose body was not JSON, from the text it came with: the busy sentence for a busy network's
 * answer, `fallback` for a proxy's page (never its HTML), the text itself otherwise (a node's plain-text refusal).
 */
export function refusalTextOf(status: unknown, text: string | null | undefined, fallback: string): string {
    if (isBusyAnswer(status, text ?? undefined)) return busyWords();
    if (!text || !text.trim() || isProxyPage(text)) return fallback;
    return text;
}

/**
 * One payment the member confirmed, safe to send again (the node: apps/server/src/engine/money-requests.ts; POST
 * /api/commons/pay takes a `requestId` in the signed body). The id is made once, when the member confirms, and every send of
 * that payment carries the same one: the first, and each retry after an answer that never came. The node pays it once and
 * answers a repeat with the first answer, so a lost answer never leaves the member paying twice or unsure. A new payment
 * the member confirms is a new id, even for the same amount: they meant both. A node from before this ignores the id.
 */
import * as Crypto from 'expo-crypto';

export interface ConfirmedPayment<B extends object> {
    /** The id every send of this payment carries. */
    readonly requestId: string;
    /** What to send: the payment's fields as the member confirmed them, and its id. */
    readonly body: Readonly<B & { requestId: string }>;
}

/** When the member confirms a payment: its id, made here once, and the body every send of it carries. */
export function confirmPayment<B extends object>(fields: B): ConfirmedPayment<B> {
    const requestId = Crypto.randomUUID().toLowerCase();
    return Object.freeze({ requestId, body: Object.freeze({ ...fields, requestId }) });
}

/** A send's result as the app's request helpers give it: status 0 when no answer came (offline, timed out). */
export interface SendResult {
    status?: number;
}

/**
 * No answer from the node: status 0 (offline, timed out), or a proxy's gateway status (502, 503, 504, Cloudflare's 52x)
 * when a self-hoster's nginx, Caddy or tunnel gave up waiting. The node may have paid by then, so these are a lost answer.
 */
export const isNoAnswer = (status: number | undefined): boolean =>
    status === 0 || status === 502 || status === 503 || status === 504 || (status !== undefined && status >= 520 && status <= 527);

/**
 * Send a confirmed payment, and again with the same id while no answer comes (isNoAnswer, or the send throws), up to
 * `tries` sends in all. Any answer from the node (paid, or refused in its own words) is final and returned as it is; so is
 * the last send's no-answer (thrown again when it threw). After that, the app keeps the same payment for a retry by hand:
 * a new one only after the node's answer, or when the member changes it.
 */
export async function sendConfirmedPayment<B extends object, R extends SendResult>(
    payment: ConfirmedPayment<B>,
    send: (body: ConfirmedPayment<B>['body']) => Promise<R>,
    { tries = 3, wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) }: { tries?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<R> {
    for (let n = 1; ; n++) {
        try {
            const result = await send(payment.body);
            if (!isNoAnswer(result.status) || n >= tries) return result;
        } catch (e) {
            if (n >= tries) throw e;
        }
        await wait(1000 * n);
    }
}

/**
 * A member's money write made safe to retry (POST /api/commons/pay first). The app makes one `requestId` (a UUID, in the
 * signed body) for one payment the member confirmed, and sends the same one again on every retry of it. The first time the
 * payment is made, the node records (payer key, requestId) with its answer in the payment's own transaction; a repeat with
 * the same id and the same payment gets that first answer back and pays nothing; the same id for a different payment is
 * refused (409). A refused payment moved nothing and records nothing, so its retry is judged afresh. A request with no id
 * (an app from before this) is paid as before, each time it comes.
 *
 * The ids are a plain table (engine/replication-manifest.ts money_requests), so a standby that takes over answers a retry
 * as its main server would; they go after REQUEST_ID_KEPT_DAYS (the manifest's age rule, and pruneMoneyRequests here).
 */
import crypto from 'node:crypto';
import { db } from '../db/db.js';
import { standbyWritesNothing } from '../config/node-role.js';

export const REQUEST_ID_KEPT_DAYS = 7;
/** A UUID as an app makes it, or any id of that kind: letters, digits, `-` and `_`, 8 to 128 of them. */
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;

export const REQUEST_ID_INVALID_ERROR = 'The payment’s request id is 8 to 128 letters, digits, - or _.';
export const REQUEST_ID_REUSED_ERROR = 'That request id was already used for a different payment. Nothing was paid.';
export const REQUEST_ID_REUSED_CODE = 'request_id_reused';

export interface MoneyRequest {
    payer: string;
    requestId: string;
    route: string;
    /** What the payment is (its route and money fields), so a repeat is known to be the same payment. */
    fingerprint: string;
}

/**
 * The request a member's money write carries, or undefined when it carries no id (an older app). An id that isn't one is
 * refused (400) before anything moves. `fields` are the payment's own: the same id with any of them different is
 * another payment.
 */
export function moneyRequestOf(payer: string, route: string, requestId: unknown, fields: Record<string, unknown>): MoneyRequest | undefined {
    if (requestId === undefined || requestId === null) return undefined;
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
        throw Object.assign(new Error(REQUEST_ID_INVALID_ERROR), { status: 400 });
    }
    const canonical = JSON.stringify([route, ...Object.keys(fields).sort().map((k) => [k, fields[k] ?? null])]);
    return { payer, requestId, route, fingerprint: crypto.createHash('sha256').update(canonical).digest('hex') };
}

/**
 * The first answer to this request when it was already paid, else undefined. The same id for a different payment is
 * refused (409 `request_id_reused`). A guard: call it before the payment's conservingTransaction, never inside it.
 */
export function priorAnswer<T>(req: MoneyRequest): T | undefined {
    const row = db.prepare('SELECT route, fingerprint, answer FROM money_requests WHERE payer_pubkey = ? AND request_id = ?')
        .get(req.payer, req.requestId) as { route: string; fingerprint: string; answer: string } | undefined;
    if (!row) return undefined;
    if (row.route !== req.route || row.fingerprint !== req.fingerprint) {
        throw Object.assign(new Error(REQUEST_ID_REUSED_ERROR), { status: 409, code: REQUEST_ID_REUSED_CODE });
    }
    return JSON.parse(row.answer) as T;
}

/** Inside the payment's conservingTransaction: the id and its answer are written with the payment, or not at all. */
export function recordAnswer(req: MoneyRequest, answer: unknown): void {
    db.prepare('INSERT INTO money_requests (payer_pubkey, request_id, route, fingerprint, answer, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(req.payer, req.requestId, req.route, req.fingerprint, JSON.stringify(answer), new Date().toISOString());
}

/** On a main server, once a day (connector-manager.ts): ids past REQUEST_ID_KEPT_DAYS go, with no tombstone (the age rule). */
export function pruneMoneyRequests(): number {
    if (standbyWritesNothing()) return 0;
    return db.prepare(`DELETE FROM money_requests WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`)
        .run(`-${REQUEST_ID_KEPT_DAYS} days`).changes;
}

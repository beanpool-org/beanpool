/**
 * Debts and a second chance in the app (#1597 item 4). The node: apps/server/src/engine/names-debts.ts, the routes in
 * routes/names-list.ts (an admin's: GET /api/names/debts, POST …/:id/work-off, POST …/:id/settle) and routes/commons.ts
 * (a member's: GET /api/commons/repayment, POST /api/commons/pay). The guide: operators/people/running-a-known-community.md
 * "Debts and a second chance".
 *
 * A debt record names an entry of the names list by its id, never a person: the name is this phone's, from the list it
 * opened. Every request here is signed by the member's own key (node-post), as the node's middleware requires. Amounts
 * are Beans to the cent.
 */
import {
    DEBT_UNREACHABLE, PAY_UNANSWERED, PAY_REFUSED_UNSAID, SETTLE_UNANSWERED,
    type NamesDebt, type Repayment, type DebtResult, type CommonsPayment, type PaidToCommons,
} from '@beanpool/core';
import { signedGet, signedPost } from './node-post';
import type { BeanPoolIdentity } from './identity';
import { confirmPayment, sendConfirmedPayment, isNoAnswer, type ConfirmedPayment, type SendResult } from './payment-request';

/**
 * The words and the reckoning are shared with the web app (DESIGN-names-list-web-fable.md S1): @beanpool/core
 * names-list-debts.ts. The requests below stay here: they ride on this phone's signed requests (node-post) and its payment
 * ids (payment-request).
 */
export {
    DEBT_UNREACHABLE, PAY_UNANSWERED, PAY_UNANSWERED_RETRY, PAY_REFUSED_UNSAID, SETTLE_UNANSWERED, coversLeft, beans, leftOf,
    debtsOfEntry, openDebtOf, debtLine, DEBT_COPY, sameName, openDebtForName, debtCodeOk, parseBeans, oneAtATime, REPAYMENT_COPY,
} from '@beanpool/core';
export type { NamesDebt, Repayment, DebtResult, CommonsPayment, PaidToCommons } from '@beanpool/core';

/**
 * `lost`: the words when no answer came, or one without the node's words in it (PAY_UNANSWERED for the pay write,
 * SETTLE_UNANSWERED for a settle). For a write that may have gone through (any `lost` but DEBT_UNREACHABLE), a 5xx is a
 * lost answer too, whatever words it carries: the node may have written before it failed. A 2xx without JSON (a proxy's
 * or a captive portal's page) is no answer from the node, as the web counts it: status 0, so a payment is sent again with
 * the same id and then kept for Try again. `unsaid`: the words for a refusal below 500 without the node's words (a
 * proxy's 429 page; PAY_REFUSED_UNSAID for the pay write: nothing was paid).
 */
async function answer<T>(res: Promise<Response>, pick: (body: any) => T, lost = DEBT_UNREACHABLE, unsaid = lost): Promise<DebtResult<T>> {
    let r: Response;
    try { r = await res; } catch { return { ok: false, status: 0, message: lost }; }
    const body = await r.json().catch(() => null) as any;
    if (!r.ok && r.status >= 500 && lost !== DEBT_UNREACHABLE) return { ok: false, status: r.status, message: lost };
    if (!r.ok) return { ok: false, status: r.status, message: typeof body?.error === 'string' && body.error.trim() ? body.error : isNoAnswer(r.status) ? lost : unsaid };
    if (body === null) return { ok: false, status: 0, message: lost };
    return { ok: true, value: pick(body) };
}

// ── An admin's (GET /api/names/debts and the two writes; owners and admins only, the node checks) ─────────────────────

export function fetchNamesDebts(node: string, identity: BeanPoolIdentity): Promise<DebtResult<NamesDebt[]>> {
    return answer(signedGet(node, '/api/names/debts', identity), (b) => (Array.isArray(b.debts) ? b.debts as NamesDebt[] : []));
}

/** Confirms `memberPubkey` against the debt's entry with the repayment flag (201 confirmed, or awaiting_second). */
export function workOffDebt(node: string, identity: BeanPoolIdentity, debtId: string, memberPubkey: string) {
    return answer(signedPost(node, `/api/names/debts/${encodeURIComponent(debtId)}/work-off`, { memberPubkey }, identity),
        (b) => b as { id: string; status: 'confirmed' | 'awaiting_second' });
}

/** Counts toward the debt a payment the member made without its code (`transactionId`, the reference their app showed them). */
export function settleDebt(node: string, identity: BeanPoolIdentity, debtId: string, transactionId: string, note?: string) {
    return answer(signedPost(node, `/api/names/debts/${encodeURIComponent(debtId)}/settle`, { transactionId: transactionId.trim(), ...(note?.trim() ? { note: note.trim() } : {}) }, identity),
        (b) => b as NamesDebt, SETTLE_UNANSWERED);
}

// ── A member's own (any signed member) ──────────────────────────────────────────────────────────────────────────────

/** Their repayment while they work a debt off, or null: what the banner shows. */
export function fetchMyRepayment(node: string, identity: BeanPoolIdentity): Promise<DebtResult<Repayment | null>> {
    return answer(signedGet(node, '/api/commons/repayment', identity), (b) => (b.repayment ? b.repayment as Repayment : null));
}

/** The member confirmed paying `amount`, for debt `debtId` if given: one id for every send of this payment. */
export function confirmCommonsPayment(amount: number, debtId?: string): ConfirmedPayment<CommonsPayment> {
    const code = debtId?.trim().toLowerCase();
    // Still the old body, `amount` in Beans, which a node on whole hundredths refuses (400 amount_c_required) until M2
    // (atomic Beans, the phone) sends `amount_c`. Renamed here without that, a typed 5 would pay 5 hundredths: compile-only.
    return confirmPayment<CommonsPayment>({ amount, ...(code ? { debtId: code } : {}) } as unknown as CommonsPayment);
}

/**
 * Pays the Commons from what the member holds (never into debt), for a debt when the payment names one: the node takes
 * the payment off that debt at once (and refuses one above what is left, in its own words), and the payment that leaves
 * nothing settles it. Sent again with the same id while no answer comes (utils/payment-request.ts); a lost answer, a 2xx without JSON,
 * or a 5xx, says PAY_UNANSWERED: it may have paid. `unanswered(r)` tells the screen to keep the payment for a retry by
 * hand. A refusal below 500 without the node's words (a proxy's 429 page) says PAY_REFUSED_UNSAID: nothing was paid.
 */
export function payTheCommons(
    node: string, identity: BeanPoolIdentity, payment: ConfirmedPayment<CommonsPayment>, opts?: { wait?: (ms: number) => Promise<void> },
): Promise<DebtResult<PaidToCommons>> {
    return sendConfirmedPayment<CommonsPayment, DebtResult<PaidToCommons> & SendResult>(payment, (body) => answer(signedPost(node, '/api/commons/pay', body, identity),
        (b) => b as PaidToCommons, PAY_UNANSWERED, PAY_REFUSED_UNSAID), opts);
}

/** No answer from the node (none came, a 2xx without JSON, a proxy's gateway status, or a 5xx): the payment may have gone through. */
export const unanswered = (r: DebtResult<unknown>): boolean => !r.ok && (isNoAnswer(r.status) || r.status >= 500);

/**
 * A member's side of Debts and a second chance (#1597 item 4) on the web: their own repayment while they work a debt
 * off (GET /api/commons/repayment), and paying the Commons, for a debt with the pay-back code an admin shared (POST
 * /api/commons/pay). Both through `request`, signed by the member's key as every request is. The admins' side (an
 * entry's debt history, work off, settle, forgive) is on the phone's names list: the web app has no names list.
 * Amounts are Beans to the cent.
 */
import { request } from './api';
import { confirmPayment, sendConfirmedPayment, isNoAnswer, type ConfirmedPayment } from './payment-request';

export interface Repayment { amount: number; repaid: number; left: number }

export async function getMyRepayment(): Promise<Repayment | null> {
    const r = await request<{ repayment: Repayment | null }>('GET', '/api/commons/repayment');
    return r?.repayment ?? null;
}

/** A payment to the Commons as the member confirmed it: the fields every send of it carries, with its id. */
export type CommonsPayment = { amount: number; debtId?: string };

/** The node's answer to a payment: its reference, the Beans paid, and for a debt what was left on it when paid. */
export type PaidToCommons = { transactionId: string; amount: number; left?: number };

/** The member confirmed paying `amount`, for the debt with pay-back code `debtCode` if given: one id for every send of it. */
export function confirmCommonsPayment(amount: number, debtCode?: string): ConfirmedPayment<CommonsPayment> {
    const debtId = debtCode?.trim().toLowerCase();
    return confirmPayment<CommonsPayment>({ amount, ...(debtId ? { debtId } : {}) });
}

/**
 * Never more than the member holds, nor more than is left on the debt: the node refuses those, in words this passes on as
 * the error's message. An admin settles a debt only with one payment of at least what is left (a smaller one doesn't
 * count toward it). Sent again with the same id while no answer comes (lib/payment-request.ts), so the node pays it once;
 * the last no-answer is thrown (payFailureWords: it may have paid; unansweredPayment: keep it for Try again).
 */
export async function payTheCommons(payment: ConfirmedPayment<CommonsPayment>, opts?: { wait?: (ms: number) => Promise<void> }): Promise<PaidToCommons> {
    const r = await sendConfirmedPayment<CommonsPayment, { status?: number; value?: PaidToCommons; error?: unknown }>(payment, async (body) => {
        try {
            return { status: 200, value: await request<PaidToCommons>('POST', '/api/commons/pay', body) };
        } catch (e) {
            const status = (e as { status?: unknown } | null)?.status;
            if (typeof status === 'number') return { status, error: e };
            throw e;
        }
    }, opts);
    if (r.error !== undefined) throw r.error;
    return r.value!;
}

/** Beans to the cent: 300 Beans, 12.50 Beans. */
export function beans(n: number): string {
    const cents = Math.round(n * 100);
    return `${cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2)} Beans`;
}

/** Beans typed by a member, to the cent; null if it isn't an amount above 0 with at most two decimals. */
export function parseBeans(text: string): number | null {
    const t = text.trim().replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
    const n = Math.round(Number(t) * 100) / 100;
    return n > 0 ? n : null;
}

/** A payment whose answer was lost: the node may have paid before it was lost, so never "nothing was paid". */
export const PAY_UNANSWERED = 'Your community’s server didn’t answer, so this payment may have gone through. Check your Ledger before you pay again.';

/**
 * The same, on the card while it holds the payment: a retry carries the payment's id (lib/payment-request.ts), so the
 * node pays it once and answers a repeat with the first answer.
 */
export const PAY_UNANSWERED_RETRY = 'Your community’s server didn’t answer, so this payment may have gone through. Press Try again: the '
    + 'same payment is never paid twice. If you change it or leave this page, check your Ledger before you pay again.';

/** A refusal below 500 without the node's words (a proxy's page, such as 429 Too Many Requests): nothing was paid. */
export const PAY_REFUSED_UNSAID = 'Your community’s server turned this payment away without saying why, so nothing was paid. Try again in a minute.';

/** Whether a payment's failure is a lost answer (none came, a proxy's gateway status, or a server error): it may have paid. */
export function unansweredPayment(e: unknown): boolean {
    const status = (e as { status?: unknown } | null)?.status;
    return typeof status !== 'number' || isNoAnswer(status) || status >= 500;
}

/**
 * What to say when a payment throws. The node's refusal (an answer below 500, which `request` gives a status) is in its own
 * words and paid nothing; one without its words (a proxy's page) in plain words. No answer (the browser's "Failed to
 * fetch"), a 2xx without JSON, or a server error: it may have paid.
 */
export function payFailureWords(e: unknown): string {
    if (unansweredPayment(e)) return PAY_UNANSWERED;
    const message = (e as { message?: unknown } | null)?.message;
    if ((e as { unsaid?: unknown }).unsaid === true) return PAY_REFUSED_UNSAID;
    return typeof message === 'string' && message.trim() ? message : PAY_REFUSED_UNSAID;
}

/** Whether one payment of `amount` covers what is left: the node settles a debt only with one such payment. */
export const coversLeft = (amount: number, left: number | null): boolean => left !== null && Math.round(amount * 100) >= Math.round(left * 100);

/** A pay-back code as an admin shares it: the debt record's id, 32 hexadecimal characters. */
export const debtCodeOk = (code: string): boolean => /^[0-9a-f]{32}$/.test(code.trim().toLowerCase());

export const REPAYMENT_WORDS = {
    banner: (r: Repayment) => `You’re working off a debt to the Commons: ${beans(r.left)} left of ${beans(r.amount)}. Every Bean you receive `
        + 'above 0 goes to the Commons until it is cleared. Then you keep what you receive, as everyone does.',
    payTitle: 'Pay the Commons',
    payIntro: 'Pay the Commons from the Beans you hold: never more than you hold. If you’re paying back a debt, enter the pay-back code an admin '
        + 'gave you and pay all that is left in one payment. An admin can settle a debt only with one payment of at least what is left: a '
        + 'smaller payment doesn’t count toward it.',
    /** The admin's link's amount: what was left when they shared it (a work-off may have lowered it since). */
    linkLeft: (left: number) => `What was left when the admin shared this: ${beans(left)}.`,
    /**
     * `shared`: what was left when the admin shared the link, from the link; null when the page doesn't know it. Never
     * "it covers what is left": only the node knows what is left now, and it refuses a payment above that.
     */
    payConfirm: (amount: number, forDebt: boolean, shared: number | null = null) => `Pay ${beans(amount)} to the Commons${forDebt ? ' for your debt' : ''}? ${
        !forDebt ? '' : shared !== null ? `${beans(shared)} was what was left when the admin shared this. ${coversLeft(amount, shared) ? '' : 'This payment is less, so it won’t settle your debt unless some was worked off since. '}`
            + 'An admin can settle your debt only with one payment of at least what is left now: a smaller payment doesn’t count toward it. If some was worked off since, your server refuses a payment above what is left and says how much, and nothing is paid. '
            : 'An admin can settle your debt with it only if this one payment is at least what is left (the amount in the admin’s message): a smaller payment doesn’t count toward it. '
    }This can’t be undone.`,
    /** `left`: what was left on the debt when paid, in the node's answer; null from a node that doesn't say. */
    paid: (amount: number, ref: string, forDebt: boolean, left: number | null = null) => `Paid ${beans(amount)} to the Commons.${
        !forDebt ? '' : coversLeft(amount, left) ? ` Give this reference to an admin, who settles your debt with it: ${ref}`
            : left !== null ? ` That is less than the ${beans(left)} left, so it won’t settle your debt: an admin can settle a debt only with one payment of at least what is left. Tell an admin, and give them this reference: ${ref}`
                : ` Give this reference to an admin. It settles your debt only if this one payment is at least what was left to repay: a smaller payment doesn’t count toward it. ${ref}`
    }`,
    badAmount: 'Write an amount of Beans above 0, to the cent (for example 12.50).',
    badCode: 'A pay-back code is 32 letters and digits, as the admin shared it. Leave it empty to pay without one.',
};

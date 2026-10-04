/**
 * A member's side of Debts and a second chance (#1597 item 4) on the web: their own repayment while they work a debt
 * off (GET /api/commons/repayment), and paying the Commons, for a debt with the pay-back code an admin shared (POST
 * /api/commons/pay). Both through `request`, signed by the member's key as every request is. The admins' side (an
 * entry's debt history, work off, settle, forgive) is on the phone's names list: the web app has no names list.
 * Amounts are Beans to the cent.
 */
import { request } from './api';

export interface Repayment { amount: number; repaid: number; left: number }

export async function getMyRepayment(): Promise<Repayment | null> {
    const r = await request<{ repayment: Repayment | null }>('GET', '/api/commons/repayment');
    return r?.repayment ?? null;
}

/**
 * Never more than the member holds: the node refuses that, in words this passes on as the error's message. An admin
 * settles a debt only with one payment of at least what is left (a smaller one doesn't count toward it). The node doesn't
 * de-duplicate payments: a lost answer may have paid (payFailureWords).
 */
export function payTheCommons(amount: number, debtCode?: string): Promise<{ transactionId: string; amount: number }> {
    const debtId = debtCode?.trim().toLowerCase();
    return request('POST', '/api/commons/pay', { amount, ...(debtId ? { debtId } : {}) });
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
 * What to say when a payment throws. The node's refusal (an answer below 500, which `request` gives a status) is in its own
 * words and paid nothing. No answer (the browser's "Failed to fetch"), a 2xx without JSON, or a server error: it may have paid.
 */
export function payFailureWords(e: unknown): string {
    const status = (e as { status?: unknown } | null)?.status;
    const message = (e as { message?: unknown } | null)?.message;
    return typeof status === 'number' && status < 500 && typeof message === 'string' && message.trim() ? message : PAY_UNANSWERED;
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
    /** `left`: what is left on the debt, from the admin's link; null when the page doesn't know it. */
    payConfirm: (amount: number, forDebt: boolean, left: number | null = null) => `Pay ${beans(amount)} to the Commons${forDebt ? ' for your debt' : ''}? ${
        !forDebt ? '' : coversLeft(amount, left) ? `It covers the ${beans(left!)} left, so an admin can settle your debt with it. `
            : left !== null ? `${beans(left)} are left, so this payment won’t settle your debt, and it doesn’t count toward it: an admin can settle a debt only with one payment of at least what is left. `
                : 'An admin can settle your debt with it only if this one payment is at least what is left (the amount in the admin’s message): a smaller payment doesn’t count toward it. '
    }This can’t be undone.`,
    paid: (amount: number, ref: string, forDebt: boolean, left: number | null = null) => `Paid ${beans(amount)} to the Commons.${
        !forDebt ? '' : coversLeft(amount, left) ? ` Give this reference to an admin, who settles your debt with it: ${ref}`
            : left !== null ? ` That is less than the ${beans(left)} left, so it won’t settle your debt: an admin can settle a debt only with one payment of at least what is left. Tell an admin, and give them this reference: ${ref}`
                : ` Give this reference to an admin. It settles your debt only if this one payment is at least what was left to repay: a smaller payment doesn’t count toward it. ${ref}`
    }`,
    badAmount: 'Write an amount of Beans above 0, to the cent (for example 12.50).',
    badCode: 'A pay-back code is 32 letters and digits, as the admin shared it. Leave it empty to pay without one.',
};

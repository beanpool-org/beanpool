/**
 * A member's side of Debts and a second chance (#1597 item 4) on the web: their own repayment while they work a debt
 * off (GET /api/commons/repayment), and paying the Commons, for a debt with the pay-back code an admin shared (POST
 * /api/commons/pay). Both through `request`, signed by the member's key as every request is. The admins' side (an
 * entry's debt history, work off, settle, forgive) is on the phone's names list: the web app has no names list.
 * Amounts are Beans to the cent.
 */
import { formatNumber, parseAmount, t, tn, word } from '@beanpool/core';
import { request } from './api';
import { confirmPayment, sendConfirmedPayment, isNoAnswer, type ConfirmedPayment } from './payment-request';

export interface Repayment { amount: number; repaid: number; left: number; debtId?: string }

export async function getMyRepayment(): Promise<Repayment | null> {
    const r = await request<{ repayment: Repayment | null }>('GET', '/api/commons/repayment');
    return r?.repayment ?? null;
}

/** A payment to the Commons as the member confirmed it: the fields every send of it carries, with its id. */
export type CommonsPayment = { amount: number; debtId?: string };

/** The node's answer to a payment: its reference, the Beans paid, and for a debt what was left before and after it, and whether it settled it. */
export type PaidToCommons = { transactionId: string; amount: number; left?: number; leftAfter?: number; settled?: boolean };

/** The member confirmed paying `amount`, for the debt with pay-back code `debtCode` if given: one id for every send of it. */
export function confirmCommonsPayment(amount: number, debtCode?: string): ConfirmedPayment<CommonsPayment> {
    const debtId = debtCode?.trim().toLowerCase();
    return confirmPayment<CommonsPayment>({ amount, ...(debtId ? { debtId } : {}) });
}

/**
 * Never more than the member holds, nor more than is left on the debt: the node refuses those, in words this passes on as
 * the error's message. A payment for a debt comes off it at once, and the one that leaves nothing settles it. Sent again with the same id while no answer comes (lib/payment-request.ts), so the node pays it once;
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

/**
 * Beans typed by a member, to the cent; null if it isn't an amount above 0 with at most two decimals. Read as every
 * typed amount is (core parseAmount): the language's decimal mark and digits; "1.000" or "1,000" is refused, never a guess.
 */
export function parseBeans(text: string): number | null {
    const read = parseAmount(text);
    if (!read.ok) return null;
    const n = Math.round(read.value * 100) / 100;
    return n > 0 ? n : null;
}

/**
 * A payment whose answer was lost: the node may have paid before it was lost, so never "nothing was paid". These three
 * are word() keys: PAY_WORDS, t()'d where shown (payFailureWords, components/RepaymentCard.tsx).
 */
export const PAY_UNANSWERED = word('Your community’s server didn’t answer, so this payment may have gone through. Check your Ledger before you pay again.');

/**
 * The same, on the card while it holds the payment: a retry carries the payment's id (lib/payment-request.ts), so the
 * node pays it once and answers a repeat with the first answer.
 */
export const PAY_UNANSWERED_RETRY = word('Your community’s server didn’t answer, so this payment may have gone through. Press Try again: the same payment is never paid twice. If you change it or leave this page, check your Ledger before you pay again.');

/** A refusal below 500 without the node's words (a proxy's page, such as 429 Too Many Requests): nothing was paid. */
export const PAY_REFUSED_UNSAID = word('Your community’s server turned this payment away without saying why, so nothing was paid. Try again in a minute.');

export const PAY_WORDS = { unanswered: PAY_UNANSWERED, unansweredRetry: PAY_UNANSWERED_RETRY, refusedUnsaid: PAY_REFUSED_UNSAID } as const;

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
    if (unansweredPayment(e)) return t(PAY_WORDS.unanswered);
    const message = (e as { message?: unknown } | null)?.message;
    if ((e as { unsaid?: unknown }).unsaid === true) return t(PAY_WORDS.refusedUnsaid);
    return typeof message === 'string' && message.trim() ? message : t(PAY_WORDS.refusedUnsaid);
}

/** Whether a payment of `amount` covers what is left: one that does settles the debt as it is paid. */
export const coversLeft = (amount: number, left: number | null): boolean => left !== null && Math.round(amount * 100) >= Math.round(left * 100);

/** A pay-back code as an admin shares it: the debt record's id, 32 hexadecimal characters. */
export const debtCodeOk = (code: string): boolean => /^[0-9a-f]{32}$/.test(code.trim().toLowerCase());

/** beans(n) in the member's language: "12 Beans", "12.50 Beans", to the cent, in the member's numbers (the phone's). */
function beansWords(n: number): string {
    const cents = Math.round(n * 100);
    const amount = cents % 100 === 0 ? formatNumber(cents / 100) : formatNumber(cents / 100, 2);
    // One English form for every count, as beans() writes it; a language with more forms has them.
    return tn(cents / 100, '{amount} Beans', '{amount} Beans', { amount });
}

/**
 * The card's words, in the member's language: the phone's sentences (apps/native components/repayment-lines.ts), whole
 * sentences per case. The strings are word() keys, t()'d where shown; the functions write their sentence through t().
 */
export const REPAYMENT_WORDS = {
    banner: (r: Repayment) => t('You’re working off a debt to the Commons: {left} left of {amount}. Every Bean you receive above 0 goes to the Commons until it is cleared. You can also pay some or all of it yourself under Pay the Commons, where your pay-back code is filled in: it comes off at once. Then you keep what you receive, as everyone does.',
        { left: beansWords(r.left), amount: beansWords(r.amount) }),
    payTitle: word('Pay the Commons'),
    payIntro: word('Pay the Commons from the Beans you hold: never more than you hold. If you’re paying back a debt, enter the pay-back code an admin gave you (working one off, yours is filled in): what you pay comes off the debt at once, and when nothing is left it is settled. Your server refuses a payment above what is left.'),
    /** The admin's link's amount: what was left when they shared it (a work-off may have lowered it since). */
    linkLeft: (left: number) => t('What was left when the admin shared this: {left}.', { left: beansWords(left) }),
    /**
     * `shared`: what was left when the admin shared the link, from the link; null when the page doesn't know it. Never
     * "it covers what is left": only the node knows what is left now, and it refuses a payment above that.
     * `openDebt` (payConfirm and paid): the member is working a debt off (GET /api/commons/repayment) and this payment has no
     * pay-back code, so the node takes it for the Commons and not off the debt (it never links one by itself: a member may pay
     * the Commons for other reasons). Said before and after, with what to do.
     */
    payConfirm: (amount: number, forDebt: boolean, shared: number | null = null, openDebt = false): string => {
        const values = { amount: beansWords(amount) };
        if (!forDebt) {
            return openDebt
                ? t('Pay {amount} to the Commons? This won’t come off your debt: it has no pay-back code. To pay your debt, pay with your code (Pay the Commons fills it in), or ask an admin to count this payment toward it afterwards. Until an admin counts it, your debt is still being worked off: the next time you receive Beans, what is left on it is taken from what you hold above 0. This can’t be undone.', values)
                : t('Pay {amount} to the Commons? This can’t be undone.', values);
        }
        return shared !== null
            ? t('Pay {amount} to the Commons for your debt? {shared} was what was left when the admin shared this. It comes off your debt at once. If less is left now, your server refuses it and says how much, and nothing is paid. This can’t be undone.', { ...values, shared: beansWords(shared) })
            : t('Pay {amount} to the Commons for your debt? It comes off your debt at once. If less is left now, your server refuses it and says how much, and nothing is paid. This can’t be undone.', values);
    },
    /** The node's answer for a debt: `settled` when this payment left nothing, else `leftAfter`, what is left now. */
    paid: (amount: number, ref: string, forDebt: boolean, answer: Partial<PaidToCommons> = {}, openDebt = false): string => {
        const values = { amount: beansWords(amount), ref };
        if (!forDebt) {
            return openDebt
                ? t('Paid {amount} to the Commons. This did not come off your debt: it was paid without your pay-back code. To have it count, ask an admin to count it toward your debt with this reference: {ref}. Until an admin counts it, your debt is still being worked off: the next time you receive Beans, what is left on it is taken from what you hold above 0.', values)
                : t('Paid {amount} to the Commons.', values);
        }
        if (answer.settled) return t('Paid {amount} to the Commons. Your debt is paid off and settled.', values);
        if (typeof answer.leftAfter === 'number') return t('Paid {amount} to the Commons. That came off your debt: {left} left.', { ...values, left: beansWords(answer.leftAfter) });
        return t('Paid {amount} to the Commons. Reference: {ref}', values);
    },
    badAmount: word('Write an amount of Beans above 0, to the cent (for example 12.50).'),
    badCode: word('A pay-back code is 32 letters and digits, as the admin shared it. Leave it empty to pay without one.'),
};

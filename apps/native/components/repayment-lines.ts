/**
 * Paying the Commons and working a debt off, in the member's language (words S3l): app/pay-commons.tsx and the Ledger's
 * components/RepaymentCard.tsx.
 *
 * utils/names-debts.ts signs the payments with the member's key, so it never reaches the words layer: its REPAYMENT_COPY
 * and its two fixed refusals are worded again here, whole sentences per variant, from the same inputs. The file they
 * stand for is not touched; what paying does is unchanged. utils/__tests__/rest-words-render.test.ts holds every one to
 * the English names-debts.ts writes, for every variant. A community's own words are shown as given (slice S4).
 */
import { formatNumber, t, tn, word, type WordKey } from '@beanpool/core';
import type { PaidToCommons, Repayment } from '../utils/names-debts';

/** names-debts.ts beans(n): "12 Beans", "12.50 Beans", to the cent, in the member's numbers. */
export function beansWords(n: number): string {
    const cents = Math.round(n * 100);
    const amount = cents % 100 === 0 ? formatNumber(cents / 100) : formatNumber(cents / 100, 2);
    // One English form for every count, as names-debts.ts writes it; a language with more forms has them.
    return tn(cents / 100, '{amount} Beans', '{amount} Beans', { amount });
}

/** Words the screens show as they are: word() keys, t()'d where shown. */
export const REPAYMENT_LINES = {
    payTitle: word('Pay the Commons'),
    payIntro: word('Pay the Commons from the Beans you hold: never more than you hold. If you’re paying back a debt, enter the pay-back code an admin gave you (working one off, yours is filled in): what you pay comes off the debt at once, and when nothing is left it is settled. Your server refuses a payment above what is left.'),
};

/** REPAYMENT_COPY.banner: what is left, and why incoming Beans go to the Commons. */
export function repaymentBannerWords(r: Pick<Repayment, 'left' | 'amount'>): string {
    return t('You’re working off a debt to the Commons: {left} left of {amount}. Every Bean you receive above 0 goes to the Commons until it is cleared. You can also pay some or all of it yourself under Pay the Commons, where your pay-back code is filled in: it comes off at once. Then you keep what you receive, as everyone does.',
        { left: beansWords(r.left), amount: beansWords(r.amount) });
}

/** REPAYMENT_COPY.linkLeft. */
export function linkLeftWords(left: number): string {
    return t('What was left when the admin shared this: {left}.', { left: beansWords(left) });
}

/** REPAYMENT_COPY.payConfirm, one sentence per case. */
export function payConfirmWords(amount: number, forDebt: boolean, shared: number | null = null, openDebt = false): string {
    const values = { amount: beansWords(amount) };
    if (!forDebt) {
        return openDebt
            ? t('Pay {amount} to the Commons? This won’t come off your debt: it has no pay-back code. To pay your debt, pay with your code (Pay the Commons fills it in), or ask an admin to count this payment toward it afterwards. Until an admin counts it, your debt is still being worked off: the next time you receive Beans, what is left on it is taken from what you hold above 0. This can’t be undone.', values)
            : t('Pay {amount} to the Commons? This can’t be undone.', values);
    }
    return shared !== null
        ? t('Pay {amount} to the Commons for your debt? {shared} was what was left when the admin shared this. It comes off your debt at once. If less is left now, your server refuses it and says how much, and nothing is paid. This can’t be undone.', { ...values, shared: beansWords(shared) })
        : t('Pay {amount} to the Commons for your debt? It comes off your debt at once. If less is left now, your server refuses it and says how much, and nothing is paid. This can’t be undone.', values);
}

/** REPAYMENT_COPY.paid: the node's answer for a debt (settled, or what is left), or the reference. */
export function paidWords(amount: number, ref: string, forDebt: boolean, answer: Partial<PaidToCommons> = {}, openDebt = false): string {
    const values = { amount: beansWords(amount), ref };
    if (!forDebt) {
        return openDebt
            ? t('Paid {amount} to the Commons. This did not come off your debt: it was paid without your pay-back code. To have it count, ask an admin to count it toward your debt with this reference: {ref}. Until an admin counts it, your debt is still being worked off: the next time you receive Beans, what is left on it is taken from what you hold above 0.', values)
            : t('Paid {amount} to the Commons.', values);
    }
    if (answer.settled) return t('Paid {amount} to the Commons. Your debt is paid off and settled.', values);
    if (typeof answer.leftAfter === 'number') return t('Paid {amount} to the Commons. That came off your debt: {left} left.', { ...values, left: beansWords(answer.leftAfter) });
    return t('Paid {amount} to the Commons. Reference: {ref}', values);
}

/** names-debts.ts's fixed sentences the screen shows as an error, by their exact English. */
const FIXED: Readonly<Record<string, WordKey>> = {
    // DEBT_UNREACHABLE.
    'Your community’s server didn’t answer. Nothing was changed. Try again when you have signal.': word('Your community’s server didn’t answer. Nothing was changed. Try again when you have signal.'),
    // PAY_UNANSWERED_RETRY.
    'Your community’s server didn’t answer, so this payment may have gone through. Tap Try again: the same payment is never paid twice. If you change it or leave this screen, check your Ledger before you pay again.': word('Your community’s server didn’t answer, so this payment may have gone through. Tap Try again: the same payment is never paid twice. If you change it or leave this screen, check your Ledger before you pay again.'),
    // REPAYMENT_COPY.badAmount, .badCode.
    'Write an amount of Beans above 0, to the cent (for example 12.50).': word('Write an amount of Beans above 0, to the cent (for example 12.50).'),
    'A pay-back code is 32 letters and digits, as the admin shared it. Leave it empty to pay without one.': word('A pay-back code is 32 letters and digits, as the admin shared it. Leave it empty to pay without one.'),
};

/** One of names-debts.ts's fixed sentences in the member's language; a community's own words exactly as given. */
export function repaymentLineWords(english: string): string {
    return Object.prototype.hasOwnProperty.call(FIXED, english) ? t(FIXED[english]) : english;
}

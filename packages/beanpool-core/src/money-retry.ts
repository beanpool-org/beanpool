/**
 * One rule for every money write an app keeps to send again with its retry id (a `requestId` the node remembers:
 * apps/server/src/engine/money-requests.ts). The node pays a request once and answers a repeat with the first answer, but
 * only for REQUEST_ID_KEPT_DAYS (7, pruned daily) from the moment it paid; after that it no longer knows the id, and the
 * same payment sent again would be paid a second time. So an app sends a payment whose answer was lost again for
 * MONEY_RESEND_HOURS from its FIRST sending, never after: past that it is aged, never sent again, and a new payment starts
 * afresh with a new id, so the node's answer is never last week's payment replayed and read as this one done.
 *
 * Its stores: the take-up sheet's book of unanswered sales (enterprise-take-up.ts takeUpUnansweredBook) and the payment
 * Pay the Commons holds for Try again (each app's pay screen: the phone's app/pay-commons.tsx, the web's
 * components/RepaymentCard.tsx, through HeldPayment here). The node's suite apps/server/src/test-enterprise-take-up.ts
 * reads MONEY_RESEND_HOURS against REQUEST_ID_KEPT_DAYS, and holds a class table of every door that takes a retry id.
 */
import { t, word } from './words.js';

/**
 * How long a money write whose answer was lost is sent again, counted from its first sending: a day. Plenty for "the answer
 * was lost just now", and it leaves days to spare inside the node's REQUEST_ID_KEPT_DAYS for a device clock that is out.
 */
export const MONEY_RESEND_HOURS = 24;
const RESEND_MS = MONEY_RESEND_HOURS * 3_600_000;
/** A clock set back a little since the stamp (a network time fix) still reads as just sent; set back further, the age is unknown. */
const CLOCK_SLACK_MS = 10 * 60_000;

/**
 * Whether a money write first sent at `sentAt` may still be sent again at `now` (both ms) with the same retry id: less than
 * MONEY_RESEND_HOURS old. A clock set back more than ten minutes since the stamp, or a stamp that is not a time, is an age
 * that can't be told, and is never sent again.
 */
export function moneyResendable(sentAt: number, now: number): boolean {
    const age = now - sentAt;
    return Number.isFinite(age) && age >= -CLOCK_SLACK_MS && age < RESEND_MS;
}

/**
 * A payment the member confirmed, as it went: exactly what was sent (its retry id inside) and when it was FIRST sent (ms).
 * Kept on the pay screen while its answer is lost, for Try again. Sending it again keeps the stamp, as the node's record of
 * the payment keeps its first time: the age that matters is how long the node may have known the id.
 */
export interface HeldPayment<P> {
    readonly payment: P;
    readonly sentAt: number;
}

/** A payment going for the first time, stamped `now`. */
export function firstSending<P>(payment: P, now: number): HeldPayment<P> {
    return Object.freeze({ payment, sentAt: now });
}

/** The held payment Try again sends at `now`, its first stamp kept; null when nothing is held or it has aged (heldAged). */
export function heldResend<P>(held: HeldPayment<P> | null | undefined, now: number): HeldPayment<P> | null {
    return held && moneyResendable(held.sentAt, now) ? held : null;
}

/**
 * A held payment past MONEY_RESEND_HOURS, or of an age the clock can no longer tell: never sent again. The screen stops
 * offering Try again, says where to see whether it went through (the Ledger, payAgedLine), and the next payment is a new
 * one, asked again, with a new id.
 */
export function heldAged<P>(held: HeldPayment<P> | null | undefined, now: number): HeldPayment<P> | null {
    return held && !moneyResendable(held.sentAt, now) ? held : null;
}

/**
 * How long until a held payment ages (ms, at least 1), so a screen left open draws itself again then and stops offering Try
 * again; null when nothing is held or it has aged already. Drawing again is only for the words: Try again reads the age
 * itself when it is pressed (heldResend), so a timer that is late never sends an aged payment.
 */
export function heldAgesInMs<P>(held: HeldPayment<P> | null | undefined, now: number): number | null {
    const resend = heldResend(held, now);
    return resend ? Math.max(1, resend.sentAt + RESEND_MS - now) : null;
}

/**
 * What a change to the form leaves held. A payment still sent again is dropped: the member changed it, so the next is a new
 * payment. An aged one stays (it is never sent), so its line stays up until the next payment goes.
 */
export function heldAfterChange<P>(held: HeldPayment<P> | null | undefined, now: number): HeldPayment<P> | null {
    return heldAged(held, now);
}

export const MONEY_RETRY_WORDS = {
    /**
     * Pay the Commons, over the form once the payment it held has aged: it may have gone through, the Ledger shows whether,
     * and the button makes a new payment. Never "nothing was paid" (it may have been), never "never paid twice" (it is no
     * longer sent).
     */
    payAged: word('An earlier payment from here got no answer, so it may have gone through: your Ledger shows whether it did. Pay the Commons makes a new payment.'),
} as const;

/** The pay screen's line once its held payment has aged (heldAged), in the member's language. */
export function payAgedLine(): string {
    return t(MONEY_RETRY_WORDS.payAged);
}

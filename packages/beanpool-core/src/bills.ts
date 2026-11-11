/**
 * Bills: a request to pay, never a payment (scratch/fable-design/DESIGN-getting-paid-fable.md §4, slice B0; Marty took every
 * recommendation, 11 Nov 2026). Pure and universal: imported by both apps and the server.
 *
 * THE RULE. A bill goes from a member (or an enterprise, sent by one of its keepers) to one member: more than 0 and at most
 * 2,000 Beans, what it is for in the sender's words (3 to 80 characters), and, if wanted, one of the sender's own listings or
 * the standing deal between the two as what it is about. It NEVER pays itself: the payer taps Pay or Decline, or leaves it;
 * it waits 30 days from reaching them, then expires. The sender can withdraw it until it is paid.
 *  - Pay moves the Beans at once, in one ledger row, with the community's 1.5% out of what the sender receives.
 *  - It builds no credit line and is no deal: no deal row, no review, nothing for the trust curve.
 *  - A first bill is paid with Beans held: the payer's credit line opens to a bill only from someone they have finished a
 *    deal with (either way round) or have a standing deal running with (`creditOpen`).
 *  - Decline is quiet: the sender reads "not paid" until it expires. A bill to someone who blocked its sender is taken and
 *    never shown to them.
 *  - The app never reminds anyone of a bill: one push when it arrives from someone the payer knows, then only the row.
 * An enterprise sends bills and is paid; it pays none (v1). Where Beans are off there are no bills.
 */

import { t, tn } from './words.js';
import { feeOf, formatHundredths, isHundredths, type Hundredths } from './hundredths.js';

/** Where a bill is (the node's `bills.state`). The sender reads a declined bill as `sent` until it expires. */
export type BillState = 'sent' | 'paid' | 'declined' | 'withdrawn' | 'expired';
export const BILL_STATES: readonly BillState[] = Object.freeze(['sent', 'paid', 'declined', 'withdrawn', 'expired']);

/** Every number the bill rules use (design §4.1, §4.4), for the node and both apps. */
export const BILL_RULES = Object.freeze({
    /** The most one bill asks for: 2,000 Beans, in whole hundredths. */
    maxAmount_c: 200_000,
    /** What it is for: 3 to 80 characters, after trimming. */
    whatForMin: 3,
    whatForMax: 80,
    /** It waits this long from reaching the payer, then expires. */
    waitDays: 30,
    /** Bills one sender sends in any 24 hours, and how many of them may go to people they never finished a deal with. */
    sentPerDay: 10,
    newPeoplePerDay: 3,
    /** An enterprise's day and its bills out are ten times a member's, as the money limits are. */
    enterpriseTimes: 10,
    /** Bills one sender has out to one person, not paid (declined ones included), in any 30 days. */
    unpaidToOnePer30Days: 3,
    /** Bills one sender has out, not paid and not expired, at once. */
    unpaidOut: 20,
    /** Different members whose reports on one sender's bills fall within `reportWindowDays` hold that sender's bills. */
    reportersToHold: 3,
    reportWindowDays: 7,
});

/** The listing or standing deal a bill is about. */
export interface BillAbout { postId: string | null; postTitle: string | null; standingId: string | null }

/**
 * A bill as the node answers it to one of its sides (GET /api/bills). The sender's read never tells a declined bill from one
 * still waiting: both are `sent` until it expires. `known` and `creditOpen` are on the payer's read only.
 */
export interface BillView extends BillAbout {
    id: string;
    /** `to-pay`: the reader pays it. `sent`: the reader sent it, or keeps the enterprise that did. */
    role: 'to-pay' | 'sent';
    billerPublicKey: string;
    billerName: string;
    payerPublicKey: string;
    payerName: string;
    amount_c: Hundredths;
    whatFor: string;
    state: BillState;
    sentAt: string;
    expiresAt: string;
    paidAt: string | null;
    /** The payer has added, written to or traded with the sender (the message-request rule): amber, counted, pushed. */
    known?: boolean;
    /** The payer's credit line may pay it: they have finished a deal with the sender, or have a standing deal running. */
    creditOpen?: boolean;
}

/** A figure in the words: whole hundredths (formatHundredths). */
const n2 = (c: Hundredths) => formatHundredths(c);

/** What the sender receives of a bill once it is paid: the amount less the 1.5%, truncated once, as the ledger does. */
export function billNetOf(amount_c: Hundredths): Hundredths {
    return isHundredths(amount_c) && amount_c > 0 ? amount_c - feeOf(amount_c) : 0;
}

/** Whether an amount is one a bill may ask for: whole hundredths, more than 0, at most 2,000 Beans. */
export function isBillAmount(amount_c: unknown): amount_c is Hundredths {
    return isHundredths(amount_c) && amount_c > 0 && amount_c <= BILL_RULES.maxAmount_c;
}

/** What it is for, trimmed, when it is 3 to 80 characters (each character as a person counts it), else null. */
export function billWhatForOf(text: unknown): string | null {
    if (typeof text !== 'string') return null;
    const trimmed = text.replace(/\s+/g, ' ').trim();
    const length = [...trimmed].length;
    return length >= BILL_RULES.whatForMin && length <= BILL_RULES.whatForMax ? trimmed : null;
}

/**
 * Every sentence a member reads about a bill, in both apps and the node's notices (design §4). Amounts are hundredths
 * (formatted here); names, what it is for, titles and dates come formatted. No sentence for the sender carries the payer's
 * balance, or says why a bill isn't paid.
 */
export const billLines = {
    // Sending (§4.2)
    sendEntry: () => t('Send a bill'),
    sendTitle: (name: string) => t('Send {name} a bill', { name }),
    whatForLabel: () => t('What is it for?'),
    amountLabel: () => t('How many Beans?'),
    aboutLabel: () => t('About (optional)'),
    theyChoose: (name: string) => t('{name} chooses whether to pay. Nothing is taken by itself.', { name }),
    youReceive: (amount_c: Hundredths) => t('You receive {net} of {n} Beans: 1.5% goes to the community.', { net: n2(billNetOf(amount_c)), n: n2(amount_c) }),
    sendButton: () => t('Send bill'),
    // The sender's list (§4.2): one line per bill, by where it is. "Not paid" for a declined one too.
    sentNotPaid: (name: string, whatFor: string, amount_c: Hundredths, sentOn: string) =>
        t('{name} · {whatFor} · {n} Beans · sent {date} · not paid', { name, whatFor, n: n2(amount_c), date: sentOn }),
    sentPaid: (name: string, whatFor: string, amount_c: Hundredths, paidOn: string) =>
        t('{name} · {whatFor} · {n} Beans · paid {date} · {net} Beans received', { name, whatFor, n: n2(amount_c), date: paidOn, net: n2(billNetOf(amount_c)) }),
    sentExpired: (name: string, whatFor: string, amount_c: Hundredths) =>
        t('{name} · {whatFor} · {n} Beans · expired, not paid', { name, whatFor, n: n2(amount_c) }),
    sentWithdrawn: (name: string, whatFor: string, amount_c: Hundredths) =>
        t('{name} · {whatFor} · {n} Beans · withdrawn', { name, whatFor, n: n2(amount_c) }),
    withdraw: () => t('Withdraw'),

    // Receiving and paying (§4.3)
    billFrom: (name: string) => t('🧾 Bill from {name}', { name }),
    amountBeans: (amount_c: Hundredths) => t('{n} Beans', { n: n2(amount_c) }),
    aboutListing: (title: string) => t('About: {title} ›', { title }),
    sentWaits: (sentOn: string, until: string) => t('Sent {date} · waits until {until}', { date: sentOn, until }),
    pay: (amount_c: Hundredths) => t('Pay {n} Beans', { n: n2(amount_c) }),
    decline: () => t('Decline'),
    message: (name: string) => t('Message {name}', { name }),
    payConfirmTitle: (name: string, amount_c: Hundredths) => t('Pay {name} {n} Beans?', { name, n: n2(amount_c) }),
    payConfirmBody: () => t("It goes now and can't be undone."),
    payConfirmYes: () => t('Pay'),
    declined: (name: string) => t("Declined. {name} isn't told.", { name }),
    strangerBanner: (name: string) =>
        t("⚠️ You haven't dealt with {name} before. Only pay for something you agreed to. BeanPool and this community never send bills.", { name }),
    block: () => t('Block'),
    report: () => t('Report'),
    postOffer: () => t('Post an Offer'),

    // The five money lines (§4.3): billMoneyLine picks one.
    holds: (held_c: Hundredths, after_c: Hundredths) => t('You have {held} Beans. After this: {after}.', { held: n2(held_c), after: n2(after_c) }),
    onCredit: (below_c: Hundredths, line_c: Hundredths) => t('This takes you to {below} Beans below zero. Your line goes to {line}.', { below: n2(below_c), line: n2(line_c) }),
    openLine: () => t('Post an Offer to open your credit line, then you can pay this.'),
    firstBillHeldOnly: (held_c: Hundredths, until: string) =>
        t('A first bill from someone can only be paid with Beans you hold. You hold {held}. Earn Beans by selling or helping: post an Offer. The bill waits until {date}.', { held: n2(held_c), date: until }),
    nothingToPay: (amount_c: Hundredths, until: string) =>
        t('You need {n} Beans to pay this. Earn Beans by selling or helping: post an Offer. The bill waits until {date}.', { n: n2(amount_c), date: until }),

    // Bell, notices and the Ledger (§4.4)
    noticeTitle: () => t('🧾 Bill'),
    arrived: (name: string, whatFor: string, amount_c: Hundredths) =>
        t('{name} sent you a bill: {whatFor} · {n} Beans. You choose whether to pay.', { name, whatFor, n: n2(amount_c) }),
    needsKnown: (name: string, whatFor: string, amount_c: Hundredths) =>
        t('Bill from {name}: {whatFor} · {n} Beans', { name, whatFor, n: n2(amount_c) }),
    needsStranger: (name: string, whatFor: string, amount_c: Hundredths) =>
        t("Bill from {name}, who you haven't dealt with: {whatFor} · {n} Beans", { name, whatFor, n: n2(amount_c) }),
    /** The ledger row's memo, both sides (the apps add "to" or "from" the other as every Ledger row does). */
    memo: (whatFor: string) => t('Bill · {whatFor}', { whatFor }),
    paidToSender: (name: string, whatFor: string, amount_c: Hundredths) =>
        t("{name} paid your bill: {whatFor} · {n} Beans ({net} after the community's 1.5%).", { name, whatFor, n: n2(amount_c), net: n2(billNetOf(amount_c)) }),

    // Limits and refusals (§4.1, §4.4). The per-person limit counts declined bills too, so it never gives a decline away.
    limitSent: (n: number, when: string) => tn(n, "You've sent {n} bill today. More from {time}.", "You've sent {n} bills today. More from {time}.", { time: when }),
    limitNewPeople: (n: number, when: string) => tn(n, "You've sent bills to {n} person you haven't dealt with today. More from {time}.",
        "You've sent bills to {n} people you haven't dealt with today. More from {time}.", { time: when }),
    limitToOne: (n: number, name: string, when: string) => tn(n, "You've sent {name} {n} bill in 30 days that isn't paid. More from {time}.",
        "You've sent {name} {n} bills in 30 days that aren't paid. More from {time}.", { name, time: when }),
    limitOut: (n: number) => tn(n, "You have {n} bill out that isn't paid. Withdraw it, or wait for it to be paid or to expire.",
        "You have {n} bills out that aren't paid. Withdraw one, or wait for one to be paid or to expire."),
    onHold: () => t("Your bills are on hold while this community's owners look at reports about them."),
    payOnHold: () => t("This bill is on hold while this community's owners look at reports about its sender."),
    badAmount: () => t('A bill asks for more than 0 and at most 2,000 Beans.'),
    badWhatFor: () => t('Say what the bill is for in 3 to 80 characters.'),
    notAMember: () => t('A bill goes to a member of this community.'),
    notYourself: () => t("You can't send yourself a bill."),
    noEnterprisePayer: () => t("An enterprise can't pay bills yet, so it can't be sent one."),
    notYourListing: () => t('A bill can be about one of your own listings only.'),
    notYourStanding: () => t('A bill can be about the standing deal between you two only.'),
    notWaiting: () => t("This bill isn't waiting to be paid any more."),
    notYours: () => t('This bill is not yours.'),
    idReused: () => t('That bill id was already used for a different bill. Nothing was sent.'),
    badId: () => t("A bill's id is 8 to 128 letters, digits, - or _. Nothing was sent."),
    billerGone: () => t("This bill can't be paid: its sender's account is closed or paused."),

    // The owners' notice when three members' reports hold a sender's bills (§4.4): who, how many, one action.
    heldForOwners: (name: string, reporters: number) =>
        tn(reporters, "{name}'s bills are on hold: {n} member reported them within 7 days. Look at the reports to clear the hold.",
            "{name}'s bills are on hold: {n} members reported them within 7 days. Look at the reports to clear the hold.", { name }),
};

/** The payer's balance as the node reads it for them (GET /api/ledger/balance): every figure whole hundredths. */
export interface BillBalanceRead {
    balance_c: Hundredths;
    /** The deepest they may spend now (≤ 0): what their live Offers unlock of their allowance. */
    usableFloor_c: Hundredths;
    /** Their allowance's floor (≤ 0): what enough live Offers would unlock. */
    floor_c: Hundredths;
    liveOffers: number;
}

/** Which of the five cases a payer is in (design §4.3). */
export type BillPayCase = 'holds' | 'credit' | 'open_line' | 'first_bill' | 'nothing';

export interface BillMoneyLine {
    case: BillPayCase;
    /** The one line under the bill, in the payer's own figures. */
    line: string;
    /** Pay is on only where the node pays it: never a button that fails. */
    canPay: boolean;
    /** "Post an Offer" beside the line. */
    postOffer: boolean;
}

/**
 * The one money line for a bill of `amount_c`, from the payer's balance read: the five cases of the design (§4.3), the same
 * function the node pays by (engine/bills.ts), so Pay is never on where the node refuses.
 *  - holds: they hold enough. Pay.
 *  - credit: the credit line may pay it (`creditOpen`) and has room. Pay.
 *  - open_line: the line may pay it and their allowance would cover it, but no Offer is live. Post an Offer.
 *  - first_bill: a first bill, and they hold some Beans but too few. Post an Offer.
 *  - nothing: anything else. Post an Offer.
 * `until` is the day the bill waits until, written as the app writes a date.
 */
export function billMoneyLine(amount_c: Hundredths, read: BillBalanceRead, creditOpen: boolean, until: string): BillMoneyLine {
    const balance = isHundredths(read.balance_c) ? read.balance_c : 0;
    const usable = isHundredths(read.usableFloor_c) ? Math.min(0, read.usableFloor_c) : 0;
    const allowance = isHundredths(read.floor_c) ? Math.min(0, read.floor_c) : 0;
    const after = balance - amount_c;
    if (after >= 0) return { case: 'holds', line: billLines.holds(balance, after), canPay: true, postOffer: false };
    if (creditOpen && after >= usable) return { case: 'credit', line: billLines.onCredit(-after, -usable), canPay: true, postOffer: false };
    if (creditOpen && (Number(read.liveOffers) || 0) === 0 && after >= allowance) {
        return { case: 'open_line', line: billLines.openLine(), canPay: false, postOffer: true };
    }
    if (!creditOpen && balance > 0) return { case: 'first_bill', line: billLines.firstBillHeldOnly(balance, until), canPay: false, postOffer: true };
    return { case: 'nothing', line: billLines.nothingToPay(amount_c, until), canPay: false, postOffer: true };
}

/** One "Needs you" line for a bill waiting on its payer (§4.4). */
export interface BillNeedsLine {
    billId: string;
    label: string;
    /** From someone the payer knows: amber and counted. From a stranger: listed, calm, never counted (needsYouCounts). */
    accent: boolean;
}

/** The payer's line for a bill waiting on them, or null for any other bill or reader. */
export function billNeedsLine(b: Pick<BillView, 'id' | 'role' | 'state' | 'billerName' | 'whatFor' | 'amount_c' | 'known'>): BillNeedsLine | null {
    if (b.role !== 'to-pay' || b.state !== 'sent') return null;
    const known = b.known === true;
    const name = b.billerName || t('A member');
    return {
        billId: b.id,
        label: known ? billLines.needsKnown(name, b.whatFor, b.amount_c) : billLines.needsStranger(name, b.whatFor, b.amount_c),
        accent: known,
    };
}

/** The sender's line for one of their bills (§4.2), by where it is; `day` writes a date as the app does. */
export function billSentLine(b: Pick<BillView, 'payerName' | 'whatFor' | 'amount_c' | 'state' | 'sentAt' | 'paidAt'>, day: (iso: string) => string): string {
    const name = b.payerName || t('A member');
    if (b.state === 'paid') return billLines.sentPaid(name, b.whatFor, b.amount_c, day(b.paidAt || b.sentAt));
    if (b.state === 'expired') return billLines.sentExpired(name, b.whatFor, b.amount_c);
    if (b.state === 'withdrawn') return billLines.sentWithdrawn(name, b.whatFor, b.amount_c);
    return billLines.sentNotPaid(name, b.whatFor, b.amount_c, day(b.sentAt));
}

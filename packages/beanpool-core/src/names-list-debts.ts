/**
 * Debts and a second chance (#1597 item 4): the words and the reckoning both apps share (DESIGN-names-list-web-fable.md
 * S1: moved out of the phone's utils/names-debts.ts, unchanged). The node: apps/server/src/engine/names-debts.ts, the
 * routes in routes/names-list.ts (an admin's: GET /api/names/debts, POST …/:id/work-off, POST …/:id/settle) and
 * routes/commons.ts (a member's: GET /api/commons/repayment, POST /api/commons/pay). The guide:
 * operators/people/running-a-known-community.md "Debts and a second chance".
 *
 * A debt record names an entry of the names list by its id, never a person: the name is the device's, from the list it
 * opened. The requests stay with each app (the phone's utils/names-debts.ts signs them with the member's own key).
 * Amounts are whole hundredths of a Bean (hundredths.ts), as the node sends them: `*_c` fields.
 */
import { formatHundredths, hundredthsAsDecimalText, parseHundredths, type Hundredths } from './hundredths.js';

/** A debt record as GET /api/names/debts sends it (engine/names-debts.ts DebtRecord). */
export interface NamesDebt {
    id: string;
    entry_id: string;
    amount_c: Hundredths;
    reason: 'removed' | 'account_deleted';
    removed_at: string;
    status: 'open' | 'settled' | 'forgiven';
    repaying_pubkey: string | null;
    repaid_c: Hundredths;
    settled_how: 'pay_back' | 'work_off' | 'forgiven' | null;
    settled_by: string | null;
    settled_at: string | null;
    settle_ref: string | null;
    note: string | null;
}

/** A member's own repayment, as GET /api/commons/repayment sends it: only while they work a debt off. */
export interface Repayment { amount_c: Hundredths; repaid_c: Hundredths; left_c: Hundredths; debtId?: string }

export type DebtResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

export const DEBT_UNREACHABLE = 'Your community’s server didn’t answer. Nothing was changed. Try again when you have signal.';

/**
 * A payment whose answer was lost (no answer, or one with no words in it). The node may have paid before the answer was
 * lost, so this never says nothing was changed.
 */
export const PAY_UNANSWERED = 'Your community’s server didn’t answer, so this payment may have gone through. Check your Ledger before you pay again.';

/**
 * The same, on the pay screen while it holds the payment: a retry carries the payment's id (utils/payment-request.ts), so
 * the node pays it once and answers a repeat with the first answer.
 */
export const PAY_UNANSWERED_RETRY = 'Your community’s server didn’t answer, so this payment may have gone through. Tap Try again: the '
    + 'same payment is never paid twice. If you change it or leave this screen, check your Ledger before you pay again.';

/** A refusal below 500 without the node's words (a proxy's page, such as 429 Too Many Requests): nothing was paid. */
export const PAY_REFUSED_UNSAID = 'Your community’s server turned this payment away without saying why, so nothing was paid. Try again in a minute.';

/** A settle whose answer was lost: the node may have settled it before the answer was lost. */
export const SETTLE_UNANSWERED = 'Your community’s server didn’t answer, so this debt may have been settled. Open the entry again to see before you settle it again.';

/** Whether a payment of `amount` covers what is left: one that does settles the debt as it is paid. */
export const coversLeft = (amount: Hundredths, left: Hundredths | null): boolean => left !== null && amount >= left;

/** A figure in these English words: "300 Beans", "12.50 Beans" (formatHundredths). */
export function debtBeans(c: Hundredths): string {
    return `${formatHundredths(c, 'en')} Beans`;
}

const day = (iso: string | null) => {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'an unknown day';
};

/** What is left to repay, to the cent. */
export const leftOf = (d: Pick<NamesDebt, 'amount_c' | 'repaid_c'>): Hundredths => d.amount_c - d.repaid_c;

/** An entry's records, newest first (the node sends them so): its debt history. */
export const debtsOfEntry = (debts: NamesDebt[], entryId: string): NamesDebt[] => debts.filter((d) => d.entry_id === entryId);

/** The open record on an entry: while there is one, nobody is confirmed against it. */
export const openDebtOf = (debts: NamesDebt[], entryId: string): NamesDebt | undefined => debtsOfEntry(debts, entryId).find((d) => d.status === 'open');

/** One line of an entry's debt history, in plain words. `who` turns a key into "@callsign" (or "an admin"). */
export function debtLine(d: NamesDebt, who: (pubkey: string) => string): string {
    const left = d.reason === 'removed' ? 'Removed' : 'Deleted their account';
    const head = `${left} on ${day(d.removed_at)} owing the Commons ${debtBeans(d.amount_c)}.`;
    let tail: string;
    if (d.status === 'open') {
        tail = d.repaid_c > 0 ? ` Open: ${debtBeans(d.repaid_c)} repaid, ${debtBeans(leftOf(d))} left.` : ' Open.';
        if (d.repaying_pubkey) tail += ` ${who(d.repaying_pubkey)} is working it off.`;
    } else if (d.status === 'forgiven') {
        tail = d.repaid_c > 0 ? ` Forgiven by the community on ${day(d.settled_at)}: ${debtBeans(d.repaid_c)} had been repaid, and the ${debtBeans(leftOf(d))} left was forgiven.`
            : ` Forgiven by the community on ${day(d.settled_at)}.`;
    } else {
        tail = ` Settled on ${day(d.settled_at)}: ${d.settled_how === 'work_off' ? 'worked off' : 'paid back'}${d.settled_by && d.settled_by !== 'node' && d.settled_how === 'pay_back' ? `, with a payment counted by ${who(d.settled_by)}` : ''}.`;
    }
    return head + tail + (d.note ? ` Note: ${d.note}` : '');
}

/** The words each control asks before it calls the node. */
export const DEBT_COPY = {
    workOffTitle: 'Confirm them to work it off?',
    workOff: (member: string, name: string, d: NamesDebt) => `Confirm ${member} as ${name}, to work off ${debtBeans(leftOf(d))}. `
        + 'Their known floor becomes 0, and every Bean they receive above 0 goes to the Commons until the debt is cleared. '
        + 'If you take the confirmation back, that stops, and what they repaid stays repaid.',
    workOffButton: 'Confirm to work it off',
    settleTitle: 'Count a payment made without the code?',
    settle: (d: NamesDebt) => `Only for a payment to the Commons the member made without the pay-back code. A payment made with the code `
        + `came off this debt when it was paid. Your server counts the payment once, toward this debt only, up to the ${debtBeans(leftOf(d))} left, `
        + 'and when nothing is left the debt is settled.',
    settleButton: 'Count it',
    forgiveTitle: 'Ask the community to forgive it?',
    forgive: (d: NamesDebt) => `This starts a Decision the community votes on: forgive a debt of ${debtBeans(leftOf(d))}. No Beans move: the `
        + 'Commons took the debt when they left. If it passes, the record stays, marked forgiven, and an admin can confirm them again. '
        + 'The Decision names no one.',
    forgiveButton: 'Start the Decision',
    shareCode: (d: NamesDebt) => `To pay back your debt to the Commons (${debtBeans(leftOf(d))}), pay it with this code: each payment comes off `
        + `the debt as you pay it, and when nothing is left it is settled. Open beanpool://pay-commons?code=${d.id}&amount=${hundredthsAsDecimalText(leftOf(d))} on your phone, or open BeanPool, go to Ledger, then `
        + `Wallet, tap Pay the Commons, enter this pay-back code: ${d.id} and pay ${debtBeans(leftOf(d))}.`,
    /** The matching-name warning: an admin adding a name the list holds already, with an open debt on it. */
    sameNameTitle: 'This name has an open debt',
    sameName: (name: string, d: NamesDebt) => `${name} is on the list already, and left owing the Commons ${debtBeans(leftOf(d))}, still open. `
        + 'If this is the same person, settle that debt on their entry rather than adding them again. Your community trusts its admins with this.',
    sameNameAdd: 'Add anyway',
};

/** A name as two admins might type it: case, accents and spacing set aside. */
export function sameName(a: string, b: string): boolean {
    const norm = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
    return norm(a) !== '' && norm(a) === norm(b);
}

/**
 * The client-side matching-name warning (guide, "The rule binds the entry, not the person"): an open debt on another
 * entry whose name this phone opened as `name`. `exceptId` is the entry being changed (its own debt isn't a match).
 */
export function openDebtForName(
    name: string, entries: { id: string; text: { name: string } | null }[], debts: NamesDebt[], exceptId?: string,
): { name: string; debt: NamesDebt } | null {
    for (const e of entries) {
        if (e.id === exceptId || !e.text || !sameName(e.text.name, name)) continue;
        const debt = openDebtOf(debts, e.id);
        if (debt) return { name: e.text.name, debt };
    }
    return null;
}

/** A pay-back code as an admin shares it: the debt record's id, 32 hexadecimal characters. */
export const debtCodeOk = (code: string): boolean => /^[0-9a-f]{32}$/.test(code.trim().toLowerCase());

/**
 * Beans typed by a member, to the cent; null if it isn't an amount above 0 with at most two decimals. Read as every
 * typed amount is (core parseAmount): the language's decimal mark and digits; "1.000" or "1,000" is refused, never a guess.
 */
export function parseBeans(text: string): Hundredths | null {
    const read = parseHundredths(text);
    return read.ok && read.value > 0 ? read.value : null;
}

/** A payment to the Commons as the member confirmed it: the fields every send of it carries, with its id. */
export type CommonsPayment = { amount_c: Hundredths; debtId?: string };

/** The node's answer to a payment: its reference, the Beans paid, and for a debt what was left before and after it, and whether it settled it. */
export type PaidToCommons = { transactionId: string; amount_c: Hundredths; left_c?: Hundredths; leftAfter_c?: Hundredths; settled?: boolean };

/**
 * One payment at a time: the busy flag is set before anything is awaited, and a second confirmed tap while a payment is
 * on its way does nothing (each confirm is a new payment, with an id of its own).
 */
export function oneAtATime(setBusy: (busy: boolean) => void) {
    let inFlight = false;
    return async (run: () => Promise<void>): Promise<void> => {
        if (inFlight) return;
        inFlight = true;
        setBusy(true);
        try { await run(); } finally { inFlight = false; setBusy(false); }
    };
}

/** A payment without the pay-back code while the member works a debt off: before it is confirmed. */
const NOT_OFF_DEBT_BEFORE = 'This won’t come off your debt: it has no pay-back code. To pay your debt, pay with your code (Pay the Commons '
    + 'fills it in), or ask an admin to count this payment toward it afterwards. Until an admin counts it, your debt is still being worked off: the next time you receive Beans, what is left on it is taken from what you hold above 0. ';

/** The same, once paid: it did not come off the debt, and the reference an admin counts it with. */
const notOffDebtAfter = (ref: string) => ` This did not come off your debt: it was paid without your pay-back code. To have it count, ask an `
    + `admin to count it toward your debt with this reference: ${ref}.`+ ' Until an admin counts it, your debt is still being worked off: the next time you receive Beans, what is left on it is taken from what you hold above 0.';

export const REPAYMENT_COPY = {
    banner: (r: Repayment) => `You’re working off a debt to the Commons: ${debtBeans(r.left_c)} left of ${debtBeans(r.amount_c)}. Every Bean you receive `
        + 'above 0 goes to the Commons until it is cleared. You can also pay some or all of it yourself: it comes off at once.',
    /** The banner's button (credit bar amendment §7b, slice R3): the pay form with the member's own pay-back code filled in. */
    payBackNow: 'Pay back now',
    /** The Wallet's row for everyone else, and its line. */
    payRowLine: 'Give Beans you hold to your community’s shared pot, or pay back a debt with a code from an admin.',
    payTitle: 'Pay the Commons',
    payIntro: 'Pay the Commons from the Beans you hold: never more than you hold. If you’re paying back a debt, enter the pay-back code an admin '
        + 'gave you (working one off, yours is filled in): what you pay comes off the debt at once, and when nothing is left it is settled. Your server refuses a payment above what is left.',
    /** The admin's link's amount: what was left when they shared it (a work-off may have lowered it since). */
    linkLeft: (left: Hundredths) => `What was left when the admin shared this: ${debtBeans(left)}.`,
    /**
     * `shared`: what was left when the admin shared the link, from the link; null when this phone doesn't know it. Never
     * "it covers what is left": only the node knows what is left now, and it refuses a payment above that.
     */
    payConfirm: (amount: Hundredths, forDebt: boolean, shared: Hundredths | null = null, openDebt = false) => `Pay ${debtBeans(amount)} to the Commons${forDebt ? ' for your debt' : ''}? ${
        !forDebt ? (openDebt ? NOT_OFF_DEBT_BEFORE : '') : `${shared !== null ? `${debtBeans(shared)} was what was left when the admin shared this. ` : ''}It comes off your debt at once. `
            + 'If less is left now, your server refuses it and says how much, and nothing is paid. '
    }This can’t be undone.`,
    /**
     * `openDebt` (payConfirm and paid): the member is working a debt off (GET /api/commons/repayment) and this payment has no
     * pay-back code, so the node takes it for the Commons and not off the debt (it never links one by itself: a member may pay
     * the Commons for other reasons). Said before and after, with what to do.
     */
    /** The node's answer for a debt: `settled` when this payment left nothing, else `leftAfter`, what is left now. */
    paid: (amount: Hundredths, ref: string, forDebt: boolean, answer: Partial<PaidToCommons> = {}, openDebt = false) => `Paid ${debtBeans(amount)} to the Commons.${
        !forDebt ? (openDebt ? notOffDebtAfter(ref) : '') : answer.settled ? ' Your debt is paid off and settled.'
            : typeof answer.leftAfter_c === 'number' ? ` That came off your debt: ${debtBeans(answer.leftAfter_c)} left.`
                : ` Reference: ${ref}`
    }`,
    badAmount: 'Write an amount of Beans above 0, to the cent (for example 12.50).',
    badCode: 'A pay-back code is 32 letters and digits, as the admin shared it. Leave it empty to pay without one.',
};

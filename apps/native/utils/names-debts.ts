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
import { signedGet, signedPost } from './node-post';
import type { BeanPoolIdentity } from './identity';

/** A debt record as GET /api/names/debts sends it (engine/names-debts.ts DebtRecord). */
export interface NamesDebt {
    id: string;
    entry_id: string;
    amount: number;
    reason: 'removed' | 'account_deleted';
    removed_at: string;
    status: 'open' | 'settled' | 'forgiven';
    repaying_pubkey: string | null;
    repaid: number;
    settled_how: 'pay_back' | 'work_off' | 'forgiven' | null;
    settled_by: string | null;
    settled_at: string | null;
    settle_ref: string | null;
    note: string | null;
}

/** A member's own repayment, as GET /api/commons/repayment sends it: only while they work a debt off. */
export interface Repayment { amount: number; repaid: number; left: number }

export type DebtResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

export const DEBT_UNREACHABLE = 'Your community’s server didn’t answer. Nothing was changed. Try again when you have signal.';

/**
 * A payment whose answer was lost (no answer, or one with no words in it). The node may have paid before the answer was
 * lost, and it doesn't de-duplicate POST /api/commons/pay, so this never says nothing was changed.
 */
export const PAY_UNANSWERED = 'Your community’s server didn’t answer, so this payment may have gone through. Check your Ledger before you pay again.';

/** Whether one payment of `amount` covers what is left: the node settles a debt only with one such payment. */
export const coversLeft = (amount: number, left: number | null): boolean => left !== null && Math.round(amount * 100) >= Math.round(left * 100);

/** Beans to the cent: 300 Beans, 12.50 Beans. Never anything finer than a cent. */
export function beans(n: number): string {
    const cents = Math.round(n * 100);
    return `${cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2)} Beans`;
}

const day = (iso: string | null) => {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'an unknown day';
};

/** What is left to repay, to the cent. */
export const leftOf = (d: Pick<NamesDebt, 'amount' | 'repaid'>): number => Math.round((d.amount - d.repaid) * 100) / 100;

/** An entry's records, newest first (the node sends them so): its debt history. */
export const debtsOfEntry = (debts: NamesDebt[], entryId: string): NamesDebt[] => debts.filter((d) => d.entry_id === entryId);

/** The open record on an entry: while there is one, nobody is confirmed against it. */
export const openDebtOf = (debts: NamesDebt[], entryId: string): NamesDebt | undefined => debtsOfEntry(debts, entryId).find((d) => d.status === 'open');

/** One line of an entry's debt history, in plain words. `who` turns a key into "@callsign" (or "an admin"). */
export function debtLine(d: NamesDebt, who: (pubkey: string) => string): string {
    const left = d.reason === 'removed' ? 'Removed' : 'Deleted their account';
    const head = `${left} on ${day(d.removed_at)} owing the Commons ${beans(d.amount)}.`;
    let tail: string;
    if (d.status === 'open') {
        tail = d.repaid > 0 ? ` Open: ${beans(d.repaid)} repaid, ${beans(leftOf(d))} left.` : ' Open.';
        if (d.repaying_pubkey) tail += ` ${who(d.repaying_pubkey)} is working it off.`;
    } else if (d.status === 'forgiven') {
        tail = ` Forgiven by the community on ${day(d.settled_at)}.`;
    } else {
        tail = ` Settled on ${day(d.settled_at)}: ${d.settled_how === 'work_off' ? 'worked off' : 'paid back'}${d.settled_by && d.settled_how === 'pay_back' ? `, checked by ${who(d.settled_by)}` : ''}.`;
    }
    return head + tail + (d.note ? ` Note: ${d.note}` : '');
}

/** The words each control asks before it calls the node. */
export const DEBT_COPY = {
    workOffTitle: 'Confirm them to work it off?',
    workOff: (member: string, name: string, d: NamesDebt) => `Confirm ${member} as ${name}, to work off ${beans(leftOf(d))}. `
        + 'Their known floor becomes 0, and every Bean they receive above 0 goes to the Commons until the debt is cleared. '
        + 'If you take the confirmation back, that stops, and what they repaid stays repaid.',
    workOffButton: 'Confirm to work it off',
    settleTitle: 'Settle it with their payment?',
    settle: (d: NamesDebt) => `The member paid the Commons for this debt, and gave you the payment’s reference. Your server checks that `
        + `it was made for this debt, by them, and is at least the ${beans(leftOf(d))} left. A payment settles one debt only.`,
    settleButton: 'Settle it',
    forgiveTitle: 'Ask the community to forgive it?',
    forgive: (d: NamesDebt) => `This starts a Decision the community votes on: forgive a debt of ${beans(leftOf(d))}. No Beans move: the `
        + 'Commons took the debt when they left. If it passes, the record stays, marked forgiven, and an admin can confirm them again. '
        + 'The Decision names no one.',
    forgiveButton: 'Start the Decision',
    shareCode: (d: NamesDebt) => `To pay back your debt to the Commons, pay all ${beans(leftOf(d))} in one payment: a smaller payment doesn’t `
        + `count toward it. Open beanpool://pay-commons?code=${d.id}&amount=${leftOf(d)} on your phone, or open BeanPool, go to Ledger, tap Pay `
        + `the Commons, enter this pay-back code: ${d.id} and pay ${beans(leftOf(d))}.`,
    /** The matching-name warning: an admin adding a name the list holds already, with an open debt on it. */
    sameNameTitle: 'This name has an open debt',
    sameName: (name: string, d: NamesDebt) => `${name} is on the list already, and left owing the Commons ${beans(leftOf(d))}, still open. `
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

/** `lost`: the words when no answer came, or one without the node's words in it (PAY_UNANSWERED for the pay write). */
async function answer<T>(res: Promise<Response>, pick: (body: any) => T, lost = DEBT_UNREACHABLE): Promise<DebtResult<T>> {
    let r: Response;
    try { r = await res; } catch { return { ok: false, status: 0, message: lost }; }
    const body = await r.json().catch(() => null) as any;
    if (!r.ok) return { ok: false, status: r.status, message: typeof body?.error === 'string' && body.error.trim() ? body.error : lost };
    if (body === null) return { ok: false, status: r.status, message: lost };
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

/** Settles the debt by the member's payment made for it (`transactionId`, the reference their app showed them). */
export function settleDebt(node: string, identity: BeanPoolIdentity, debtId: string, transactionId: string, note?: string) {
    return answer(signedPost(node, `/api/names/debts/${encodeURIComponent(debtId)}/settle`, { transactionId: transactionId.trim(), ...(note?.trim() ? { note: note.trim() } : {}) }, identity),
        (b) => b as NamesDebt);
}

// ── A member's own (any signed member) ──────────────────────────────────────────────────────────────────────────────

/** Their repayment while they work a debt off, or null: what the banner shows. */
export function fetchMyRepayment(node: string, identity: BeanPoolIdentity): Promise<DebtResult<Repayment | null>> {
    return answer(signedGet(node, '/api/commons/repayment', identity), (b) => (b.repayment ? b.repayment as Repayment : null));
}

/** A pay-back code as an admin shares it: the debt record's id, 32 hexadecimal characters. */
export const debtCodeOk = (code: string): boolean => /^[0-9a-f]{32}$/.test(code.trim().toLowerCase());

/** Beans typed by a member, to the cent; null if it isn't an amount above 0 with at most two decimals. */
export function parseBeans(text: string): number | null {
    const t = text.trim().replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
    const n = Math.round(Number(t) * 100) / 100;
    return n > 0 ? n : null;
}

/**
 * Pays the Commons from what the member holds (never into debt), for a debt when `debtId` is given: the node links the
 * payment to that debt, and an admin settles it with the reference this returns, if this one payment covers what is
 * left (a smaller one settles nothing and doesn't count toward it). A lost answer says PAY_UNANSWERED: it may have paid.
 */
export function payTheCommons(node: string, identity: BeanPoolIdentity, amount: number, debtId?: string) {
    const code = debtId?.trim().toLowerCase();
    return answer(signedPost(node, '/api/commons/pay', { amount, ...(code ? { debtId: code } : {}) }, identity),
        (b) => b as { transactionId: string; amount: number }, PAY_UNANSWERED);
}

/**
 * One payment at a time: the busy flag is set before anything is awaited, and a second confirmed tap while a payment is
 * on its way does nothing (the node doesn't de-duplicate payments).
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

export const REPAYMENT_COPY = {
    banner: (r: Repayment) => `You’re working off a debt to the Commons: ${beans(r.left)} left of ${beans(r.amount)}. Every Bean you receive `
        + 'above 0 goes to the Commons until it is cleared. Then you keep what you receive, as everyone does.',
    payTitle: 'Pay the Commons',
    payIntro: 'Pay the Commons from the Beans you hold: never more than you hold. If you’re paying back a debt, enter the pay-back code an admin '
        + 'gave you and pay all that is left in one payment. An admin can settle a debt only with one payment of at least what is left: a '
        + 'smaller payment doesn’t count toward it.',
    /** `left`: what is left on the debt, from the admin's link; null when this phone doesn't know it. */
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

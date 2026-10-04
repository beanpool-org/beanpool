/**
 * The Ledger's repayment card on the web (#1597 item 4): while the member works a debt off, what is left and why their
 * incoming Beans go to the Commons; and, always, Pay the Commons, where a member paying back a debt enters the pay-back
 * code an admin shared (a link's ?payback=<code>&amount=<n> fills both in; n is what was left when the admin shared it, and
 * the node refuses a payment above what is left now, in its words). A settle is promised only when the node's answer says
 * the payment covers what is left. Asked first; one payment at a time; the node's refusals in its own words. Each confirmed
 * payment has one id (lib/payment-request.ts): a lost answer keeps it here for Try again with the same id, never paid twice. The banner says nothing when the node answers nothing (an older node, no signal). Wraps at 320px and 130% text: no fixed widths, every control at least 48px tall.
 */
import { useEffect, useRef, useState } from 'react';
import { getMyRepayment, payTheCommons, confirmCommonsPayment, unansweredPayment, parseBeans, debtCodeOk, payFailureWords, PAY_UNANSWERED_RETRY, REPAYMENT_WORDS, type Repayment, type CommonsPayment } from '../lib/debts';
import type { ConfirmedPayment } from '../lib/payment-request';

/** The pay-back link's code, and what was left on that debt when the admin shared it (null when the link doesn't say). */
function linkParams(): { code: string; left: number | null } {
    try {
        const q = new URLSearchParams(window.location.search);
        const code = q.get('payback') ?? '';
        const amount = q.get('amount');
        return { code, left: code && amount ? parseBeans(amount) : null };
    } catch { return { code: '', left: null }; }
}

export function RepaymentCard({ onPaid }: { onPaid?: () => void }) {
    const [repayment, setRepayment] = useState<Repayment | null>(null);
    // A link with ?payback=<code>&amount=<n> opens the form with both in it.
    const [link] = useState(linkParams);
    const [code, setCode] = useState(link.code);
    const [open, setOpen] = useState(() => code !== '');
    const [amount, setAmount] = useState(link.left !== null ? String(link.left) : '');
    const inFlight = useRef(false);
    const [error, setError] = useState<string | null>(null);
    const [paid, setPaid] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    // The payment the member confirmed whose answer was lost: Try again sends it with the same id. Changing it drops it.
    const [held, setHeld] = useState<ConfirmedPayment<CommonsPayment> | null>(null);
    const linkFor = (debt: string) => (debt && debt.toLowerCase() === link.code.trim().toLowerCase() ? link.left : null);

    useEffect(() => {
        let live = true;
        getMyRepayment().then((r) => { if (live) setRepayment(r); }).catch(() => {});
        return () => { live = false; };
    }, [paid]);

    const pay = async () => {
        if (inFlight.current) return;
        setError(null);
        let payment = held;
        if (!payment) {
            const beans = parseBeans(amount);
            if (beans === null) { setError(REPAYMENT_WORDS.badAmount); return; }
            const debt = code.trim();
            if (debt && !debtCodeOk(debt)) { setError(REPAYMENT_WORDS.badCode); return; }
            if (!window.confirm(REPAYMENT_WORDS.payConfirm(beans, !!debt, linkFor(debt)))) return;
            payment = confirmCommonsPayment(beans, debt || undefined);
        }
        inFlight.current = true;
        setBusy(true);
        try {
            const r = await payTheCommons(payment);
            setHeld(null);
            setPaid(REPAYMENT_WORDS.paid(r.amount, r.transactionId, !!payment.body.debtId, r.left ?? null));
            setAmount('');
            onPaid?.();
        } catch (e) {
            const lost = unansweredPayment(e);
            setHeld(lost ? payment : null);
            setError(lost ? PAY_UNANSWERED_RETRY : payFailureWords(e));
        } finally {
            inFlight.current = false;
            setBusy(false);
        }
    };

    const input = 'w-full min-h-[48px] px-3 rounded-xl border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-950 text-nature-950 dark:text-white';
    return (
        <div className="mb-4 flex flex-col gap-2">
            {repayment && (
                <div role="status" className="rounded-2xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 text-sm leading-relaxed text-amber-800 dark:text-amber-200">
                    {REPAYMENT_WORDS.banner(repayment)}
                </div>
            )}
            {!open ? (
                <button type="button" onClick={() => setOpen(true)} className="self-start min-h-[48px] px-1 text-sm font-semibold text-terra-600 dark:text-terra-500">
                    {REPAYMENT_WORDS.payTitle}
                </button>
            ) : (
                <div className="rounded-2xl border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900 px-4 py-3 flex flex-col gap-2">
                    <h3 className="font-bold text-nature-950 dark:text-white">{REPAYMENT_WORDS.payTitle}</h3>
                    {paid ? (
                        <p role="status" className="text-sm leading-relaxed text-nature-800 dark:text-nature-200 break-words select-all">{paid}</p>
                    ) : (
                        <>
                            <p className="text-sm leading-relaxed text-nature-700 dark:text-nature-300">{REPAYMENT_WORDS.payIntro}</p>
                            {linkFor(code.trim()) !== null && <p className="text-sm leading-relaxed text-nature-700 dark:text-nature-300">{REPAYMENT_WORDS.linkLeft(link.left!)}</p>}
                            <label className="text-xs font-bold tracking-wide text-nature-600 dark:text-nature-400">BEANS
                                <input className={input} inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setHeld(null); }} placeholder="For example 12.50" maxLength={12} disabled={busy} />
                            </label>
                            <label className="text-xs font-bold tracking-wide text-nature-600 dark:text-nature-400">PAY-BACK CODE (IF YOU HAVE ONE)
                                <input className={input} value={code} onChange={(e) => { setCode(e.target.value); setHeld(null); }} placeholder="From an admin" autoCapitalize="none" autoCorrect="off" maxLength={64} disabled={busy} />
                            </label>
                            {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
                        </>
                    )}
                    <div className="flex flex-wrap gap-2">
                        {!paid && (
                            <button type="button" onClick={pay} disabled={busy} className="flex-1 min-h-[48px] px-4 rounded-xl bg-emerald-700 text-white font-bold disabled:opacity-50">
                                {held ? 'Try again' : REPAYMENT_WORDS.payTitle}
                            </button>
                        )}
                        <button type="button" onClick={() => { setOpen(false); setPaid(null); setError(null); setHeld(null); }} className="flex-1 min-h-[48px] px-4 rounded-xl border border-nature-300 dark:border-nature-700 text-nature-800 dark:text-nature-200 font-semibold">
                            {paid ? 'Done' : 'Cancel'}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

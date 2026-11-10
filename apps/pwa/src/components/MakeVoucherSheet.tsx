/**
 * "+ Make someone a voucher" on the web (invites-vouching I5, DESIGN-invites-vouching-review-fable.md §3 ask 1; Marty,
 * 10 Nov 2026: admins are vouchers only when an owner makes them one). The phone's sheet, as a dialog: two sections and
 * nobody else, Admins (no names-list entry needed; the node sends them to an owner only) and Confirmed on the names list
 * (by callsign: the names are sealed in the list, which only a phone opens), then the budget stepper prefilled with the
 * community's default and one Make button. Who is offered is the node's answer (GET /api/names/vouchers `candidates`).
 * A dialog as the app's others are: named by its heading, focus in on open and back on close, Escape closes it.
 */
import { useRef, useState } from 'react';
import {
    t, makeVoucherSheetTitle, makeVoucherAdminsHeading, makeVoucherConfirmedHeading, makeVoucherNobodyWords, voucherCandidateWords,
    makeVoucherBudgetWords, makeVoucherButtonWords, madeVoucherWords, VOUCH_PRESET_WORDS, VOUCHER_BUDGET_MAX, isBudgetLevel,
} from '@beanpool/core';
import { makeVoucher, type VoucherCandidate, type VouchersBlockData } from '../lib/api';
import { useDialogFocus } from './dialog-focus';

const STEP = 100;

export function MakeVoucherSheet({ candidates, defaultBudget, onClose, onMade }: {
    candidates: VouchersBlockData['candidates'];
    defaultBudget: number | null | undefined;
    onClose: () => void;
    /** A voucher was made: the caller reads the block again, so the person leaves the lists. */
    onMade: () => void;
}) {
    const dialog = useRef<HTMLDivElement | null>(null);
    useDialogFocus(dialog, onClose);
    const [picked, setPicked] = useState<VoucherCandidate | null>(null);
    const [amount, setAmount] = useState(() => (isBudgetLevel(defaultBudget) ? defaultBudget : 1000));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<string | null>(null);
    const admins = candidates?.admins ?? [];
    const confirmed = candidates?.confirmed ?? [];

    const make = async () => {
        if (!picked || busy) return;
        setBusy(true);
        setError(null);
        setDone(null);
        try {
            await makeVoucher(picked.entryId ? { entryId: picked.entryId } : { memberPubkey: picked.memberPubkey }, amount);
            setDone(madeVoucherWords(voucherCandidateWords(picked.callsign), amount));
            setPicked(null);
            onMade();
        } catch (e: any) {
            setError(e?.message || e?.error || t('Could not make them a voucher'));
        } finally {
            setBusy(false);
        }
    };

    const row = (c: VoucherCandidate, testId: string) => {
        const on = picked?.memberPubkey === c.memberPubkey;
        return (
            <button
                key={c.memberPubkey}
                type="button"
                aria-pressed={on}
                onClick={() => { setPicked(on ? null : c); setDone(null); setError(null); }}
                data-testid={testId}
                className={`w-full text-left min-h-[44px] p-3 rounded-xl border text-sm font-semibold break-words cursor-pointer transition-colors ${
                    on
                        ? 'border-bp-commit-fill bg-oat-50 dark:bg-nature-800 text-nature-950 dark:text-white'
                        : 'border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900 text-nature-900 dark:text-white hover:border-nature-400'
                }`}
            >
                {voucherCandidateWords(c.callsign)}
            </button>
        );
    };
    const heading = (text: string, testId: string) => (
        <h3 className="m-0 mt-3 mb-1 text-xs font-bold text-nature-600 dark:text-nature-300" data-testid={testId}>{text}</h3>
    );

    return (
        <div
            ref={dialog}
            className="fixed inset-0 z-[320] flex items-end sm:items-center justify-center p-4 bg-black/50"
            role="dialog"
            aria-modal="true"
            aria-labelledby="make-voucher-sheet-title"
            data-testid="make-voucher-sheet"
            onClick={onClose}
        >
            <div
                className="w-full max-w-[460px] max-h-[90vh] overflow-y-auto p-5 rounded-2xl bg-white dark:bg-nature-950 border border-nature-200 dark:border-nature-800 shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <h2 id="make-voucher-sheet-title" tabIndex={-1} className="m-0 mb-2 text-base font-extrabold text-nature-950 dark:text-white outline-none">
                    {makeVoucherSheetTitle()}
                </h2>
                {done && <p role="status" className="m-0 mb-2 p-3 rounded-xl text-sm bg-oat-50 dark:bg-nature-900 text-nature-900 dark:text-white">{done}</p>}
                {error && <p role="alert" className="m-0 mb-2 text-sm text-amber-700 dark:text-amber-400">{error}</p>}
                {admins.length === 0 && confirmed.length === 0 && (
                    <p className="m-0 mb-2 text-sm text-nature-600 dark:text-nature-300" data-testid="make-voucher-nobody">{makeVoucherNobodyWords(candidates)}</p>
                )}
                {admins.length > 0 && heading(makeVoucherAdminsHeading(), 'make-voucher-admins')}
                <div className="flex flex-col gap-2">{admins.map((c) => row(c, 'make-voucher-admin-row'))}</div>
                {confirmed.length > 0 && heading(makeVoucherConfirmedHeading(), 'make-voucher-confirmed')}
                <div className="flex flex-col gap-2">{confirmed.map((c) => row(c, 'make-voucher-confirmed-row'))}</div>
                {picked && (
                    <div className="mt-4 p-4 rounded-xl border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900" data-testid="make-voucher-budget">
                        <div className="flex items-center gap-3 mb-3">
                            <button
                                type="button"
                                onClick={() => setAmount((a) => Math.max(STEP, a - STEP))}
                                disabled={amount <= STEP || busy}
                                className="w-11 h-11 min-w-[44px] min-h-[44px] rounded-lg flex items-center justify-center font-bold text-base bg-oat-100 dark:bg-nature-800 text-nature-900 dark:text-white border-0 cursor-pointer disabled:opacity-40"
                                aria-label={t(VOUCH_PRESET_WORDS.decreaseBudget)}
                            >
                                −
                            </button>
                            <div className="flex-1 text-center font-extrabold text-base text-nature-950 dark:text-white" data-testid="make-voucher-amount">
                                {makeVoucherBudgetWords(amount)}
                            </div>
                            <button
                                type="button"
                                onClick={() => setAmount((a) => Math.min(VOUCHER_BUDGET_MAX, a + STEP))}
                                disabled={amount >= VOUCHER_BUDGET_MAX || busy}
                                className="w-11 h-11 min-w-[44px] min-h-[44px] rounded-lg flex items-center justify-center font-bold text-base bg-oat-100 dark:bg-nature-800 text-nature-900 dark:text-white border-0 cursor-pointer disabled:opacity-40"
                                aria-label={t(VOUCH_PRESET_WORDS.increaseBudget)}
                            >
                                +
                            </button>
                        </div>
                        <button
                            type="button"
                            onClick={() => { void make(); }}
                            disabled={busy}
                            data-testid="make-voucher-go"
                            className="w-full min-h-[44px] py-2 px-4 rounded-xl text-sm font-bold bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on border-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed break-words"
                        >
                            {makeVoucherButtonWords(voucherCandidateWords(picked.callsign))}
                        </button>
                    </div>
                )}
                <button
                    type="button"
                    onClick={onClose}
                    className="w-full mt-4 min-h-[44px] py-2 px-4 rounded-xl font-bold bg-oat-100 dark:bg-nature-800 text-nature-900 dark:text-white border-0 cursor-pointer"
                >
                    {t('Close')}
                </button>
            </div>
        </div>
    );
}

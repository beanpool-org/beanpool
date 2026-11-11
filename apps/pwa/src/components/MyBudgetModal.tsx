/**
 * "Your budget to vouch from" (the Ledger's budget line, opened by a voucher): what is left, vouched and held, the budget
 * history in plain words, and Ask for more. A dialog as the app's others are (VoucherCardModal, Home's AddCardDialog): named
 * by its heading, focus in on open and back to what opened it on close, Escape and the ✕ (44 × 44 px) close it.
 */
import { useRef } from 'react';
import { formatDate, formatHistoryLine, formatHundredths, t, tn, VOUCH_PRESET_WORDS } from '@beanpool/core';
import type { MyVouching } from '../lib/api';
import { useDialogFocus } from './dialog-focus';

export interface MyBudgetModalProps {
    vouching: MyVouching & { budget: NonNullable<MyVouching['budget']> };
    onClose: () => void;
}

export function MyBudgetModal({ vouching, onClose }: MyBudgetModalProps) {
    const dialog = useRef<HTMLDivElement | null>(null);
    useDialogFocus(dialog, onClose);
    const { budget, history } = vouching;

    return (
        <div
            ref={dialog}
            className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/50"
            role="dialog"
            aria-modal="true"
            aria-labelledby="my-budget-title"
            data-testid="my-budget-modal"
            onClick={onClose}
        >
            <div
                className="w-full sm:max-w-[480px] max-h-[85vh] overflow-y-auto p-5 rounded-t-2xl sm:rounded-2xl bg-oat-50 dark:bg-nature-950 border border-nature-200 dark:border-nature-800 shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between gap-2 mb-3">
                    <h2 id="my-budget-title" tabIndex={-1} className="m-0 text-base font-extrabold text-nature-950 dark:text-white outline-none">
                        {t('Your budget to vouch from')}
                    </h2>
                    <button
                        type="button"
                        onClick={onClose}
                        className="min-w-[44px] min-h-[44px] shrink-0 rounded-lg flex items-center justify-center text-base text-nature-500 hover:text-nature-900 dark:hover:text-white bg-transparent border-0 cursor-pointer"
                        aria-label={t('Close')}
                    >
                        ✕
                    </button>
                </div>
                <div className="p-3.5 mb-4 rounded-xl border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900 space-y-1 text-xs text-nature-700 dark:text-nature-300">
                    <div className="text-sm font-extrabold text-nature-950 dark:text-white">
                        {/* An owner vouches with no limit (Marty, 9 Nov): no budget figure and no held line. */}
                        {vouching.noLimit
                            ? t(VOUCH_PRESET_WORDS.noLimit)
                            : t('{left} of {total} left', { left: formatHundredths(budget.left), total: formatHundredths(budget.level) })}
                    </div>
                    <div>{t('Vouched {amount} to {people} who joined', { amount: formatHundredths(budget.vouched), people: tn(budget.peopleVouched, '{n} person', '{n} people') })}</div>
                    {!vouching.noLimit && (
                        <div>{t('Held {amount} on {invites} not used yet', { amount: formatHundredths(budget.held), invites: tn(budget.heldInvites, '{n} invite', '{n} invites') })}</div>
                    )}
                </div>

                <div className="mb-4">
                    <h3 className="m-0 mb-2 text-sm font-bold text-nature-950 dark:text-white">
                        {t('Budget history')}
                    </h3>
                    <div className="space-y-2 max-h-[35vh] overflow-y-auto pr-1">
                        {!history || history.length === 0 ? (
                            <p className="m-0 p-3 text-xs text-nature-500">{t('No budget history yet.')}</p>
                        ) : (
                            history.map((h, i) => (
                                <div key={i} className="p-2.5 rounded-lg border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900 text-xs">
                                    <div className="flex items-start justify-between gap-2 font-bold text-nature-950 dark:text-white">
                                        <span className="flex-1 break-words">{formatHistoryLine(h)}</span>
                                        <span className="text-[11px] text-nature-400 font-normal shrink-0">{h.at ? formatDate(new Date(h.at), 'day-month-year') : ''}</span>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>

                <div className="p-3.5 rounded-xl border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900">
                    <h3 className="m-0 mb-1 text-sm font-bold text-nature-950 dark:text-white">
                        {t('Ask for more')}
                    </h3>
                    <p className="m-0 text-xs text-nature-600 dark:text-nature-300 leading-relaxed">
                        {t('To get a bigger budget to vouch from, ask an owner of this community.')}
                    </p>
                </div>
            </div>
        </div>
    );
}

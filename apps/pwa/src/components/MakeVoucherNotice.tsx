/**
 * "+ Make someone a voucher", the last row of the web's Vouchers block (design amendment 2 §11). The web has no names list
 * yet, and vouchers are made on the names list (§2, §11), which is the phone app's: so this says where, in one plain
 * sentence, and nothing about screens to come. A dialog as the app's others are: named by its heading, focus in on open and
 * back to the row on close, Escape closes it.
 */
import { useRef } from 'react';
import { t, VOUCH_PRESET_WORDS } from '@beanpool/core';
import { useDialogFocus } from './dialog-focus';

export function MakeVoucherNotice({ onClose }: { onClose: () => void }) {
    const dialog = useRef<HTMLDivElement | null>(null);
    useDialogFocus(dialog, onClose);
    return (
        <div
            ref={dialog}
            className="fixed inset-0 z-[320] flex items-center justify-center p-4 bg-black/50"
            role="dialog"
            aria-modal="true"
            aria-labelledby="make-voucher-title"
            data-testid="make-voucher-notice"
            onClick={onClose}
        >
            <div
                className="w-full max-w-[420px] p-5 rounded-2xl bg-white dark:bg-nature-950 border border-nature-200 dark:border-nature-800 shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <h2 id="make-voucher-title" tabIndex={-1} className="m-0 mb-2 text-base font-extrabold text-nature-950 dark:text-white outline-none">
                    {t(VOUCH_PRESET_WORDS.makeSomeoneVoucher)}
                </h2>
                <p className="m-0 mb-4 text-sm text-nature-600 dark:text-nature-300 leading-relaxed">
                    {t(VOUCH_PRESET_WORDS.makeSomeoneVoucherHelp)}
                </p>
                <button
                    type="button"
                    onClick={onClose}
                    className="w-full min-h-[44px] py-2 px-4 rounded-xl font-bold bg-bp-commit-fill text-bp-commit-on border-0 cursor-pointer"
                >
                    {t('OK')}
                </button>
            </div>
        </div>
    );
}

import { useEffect, useRef } from 'react';
import {
    t,
    startRows,
    type StartRowKey,
    type StartNodeFeatures,
} from '@beanpool/core';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onPick: (key: StartRowKey) => void;
    features?: StartNodeFeatures | null;
    canPropose?: boolean;
    decisionsPreview?: boolean;
    enterprisesPreview?: boolean;
}

export function StartSomethingDialog({
    isOpen,
    onClose,
    onPick,
    features,
    canPropose = true,
    decisionsPreview = false,
    enterprisesPreview = false,
}: Props) {
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    const openerRef = useRef<Element | null>(null);
    const dialogRef = useRef<HTMLDivElement | null>(null);
    const pickedRef = useRef(false);

    useEffect(() => {
        if (!isOpen) return;
        openerRef.current = document.activeElement;

        // Focus dialog heading on open
        const timer = setTimeout(() => {
            dialogRef.current?.querySelector<HTMLElement>('#start-something-title')?.focus();
        }, 0);

        // Window capture-phase keydown listener for Escape and Tab focus trap
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                e.preventDefault();
                closeRef.current();
                return;
            }
            if (e.key === 'Tab') {
                const box = dialogRef.current;
                if (!box) return;
                const items = Array.from(box.querySelectorAll<HTMLElement>(
                    'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
                ));
                if (!items.length) return;
                const first = items[0];
                const last = items[items.length - 1];
                const active = document.activeElement;
                if (!box.contains(active)) {
                    e.preventDefault();
                    (e.shiftKey ? last : first).focus();
                } else if (e.shiftKey && active === first) {
                    e.preventDefault();
                    last.focus();
                } else if (!e.shiftKey && active === last) {
                    e.preventDefault();
                    first.focus();
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown, true);
        return () => {
            clearTimeout(timer);
            window.removeEventListener('keydown', handleKeyDown, true);
            if (pickedRef.current) {
                pickedRef.current = false;
                return;
            }
            const opener = openerRef.current as HTMLElement | null;
            if (opener && opener.isConnected && (!document.activeElement || document.activeElement === document.body)) {
                opener.focus?.();
            }
        };
    }, [isOpen]);

    if (!isOpen) return null;

    const rows = startRows(features, { canPropose, decisionsPreview, enterprisesPreview });
    const commonsRows = rows.filter((r) => r.section === 'commons');
    const marketRows = rows.filter((r) => r.section === 'market');

    const handlePick = (key: StartRowKey) => {
        pickedRef.current = true;
        onPick(key);
    };

    return (
        <div
            className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center p-0 sm:p-4"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-labelledby="start-something-title"
            ref={dialogRef}
        >
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div
                className="relative bg-nature-100 dark:bg-[#0d0d0d] rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[90vh] overflow-y-auto animate-in slide-in-from-bottom-4 sm:zoom-in-95 duration-200 shadow-2xl border border-nature-200 dark:border-nature-800"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="sticky top-0 bg-nature-100/90 dark:bg-[#0d0d0d]/90 backdrop-blur-md p-4 border-b border-nature-200 dark:border-nature-800 flex items-center justify-between z-10">
                    <h2
                        id="start-something-title"
                        tabIndex={-1}
                        className="text-lg font-black text-nature-950 dark:text-white flex items-center gap-2 outline-none"
                    >
                        {t('Start something')}
                    </h2>
                    <button
                        type="button"
                        onClick={onClose}
                        className="min-w-[44px] min-h-[44px] w-11 h-11 flex items-center justify-center p-1 rounded-lg text-nature-500 hover:text-nature-900 dark:hover:text-white hover:bg-nature-200 dark:hover:bg-nature-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                        aria-label={t('Close')}
                    >
                        ✕
                    </button>
                </div>

                {/* Rows list */}
                <div className="p-4 space-y-2">
                    {commonsRows.map((row) => (
                        <button
                            key={row.key}
                            type="button"
                            onClick={() => handlePick(row.key)}
                            className="w-full flex items-start gap-3 p-3 rounded-xl border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-950 hover:bg-nature-50 dark:hover:bg-nature-900 transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 min-h-[56px]"
                        >
                            <span
                                className="w-10 h-10 rounded-full bg-nature-100 dark:bg-nature-900 flex items-center justify-center text-xl shrink-0"
                                aria-hidden="true"
                            >
                                {row.emoji}
                            </span>
                            <div className="flex-1 min-w-0">
                                <div className="text-sm font-bold text-nature-950 dark:text-white leading-tight">
                                    {t(row.title)}
                                </div>
                                <div className="text-xs text-nature-600 dark:text-nature-400 mt-0.5 leading-relaxed">
                                    {t(row.line)}
                                </div>
                                {row.standingLine && (
                                    <div className="text-xs text-amber-700 dark:text-amber-400 font-semibold mt-1 flex items-center gap-1">
                                        <span aria-hidden="true">⚠️</span>
                                        <span>{t(row.standingLine)}</span>
                                    </div>
                                )}
                            </div>
                        </button>
                    ))}

                    {marketRows.length > 0 && (
                        <>
                            <div className="text-[11px] font-bold uppercase tracking-wider text-nature-500 dark:text-nature-400 pt-2 pb-1 px-1">
                                {t('In the Market')}
                            </div>
                            {marketRows.map((row) => (
                                <button
                                    key={row.key}
                                    type="button"
                                    onClick={() => handlePick(row.key)}
                                    className="w-full flex items-start gap-3 p-3 rounded-xl border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-950 hover:bg-nature-50 dark:hover:bg-nature-900 transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 min-h-[56px]"
                                >
                                    <span
                                        className="w-10 h-10 rounded-full bg-nature-100 dark:bg-nature-900 flex items-center justify-center text-xl shrink-0"
                                        aria-hidden="true"
                                    >
                                        {row.emoji}
                                    </span>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm font-bold text-nature-950 dark:text-white leading-tight">
                                            {t(row.title)}
                                        </div>
                                        <div className="text-xs text-nature-600 dark:text-nature-400 mt-0.5 leading-relaxed">
                                            {t(row.line)}
                                        </div>
                                        {row.standingLine && (
                                            <div className="text-xs text-amber-700 dark:text-amber-400 font-semibold mt-1 flex items-center gap-1">
                                                <span aria-hidden="true">⚠️</span>
                                                <span>{t(row.standingLine)}</span>
                                            </div>
                                        )}
                                    </div>
                                </button>
                            ))}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

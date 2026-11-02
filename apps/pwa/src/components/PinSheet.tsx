/**
 * Pin Sheet (scratch/fable-design/DESIGN-pinning-fable.md §0.2, §2.5, §2.12):
 * Allows an owner or admin to pin a public post for 1 day, 3 days, or 1 week.
 *
 * Keyboard: opens, works and closes from keyboard, Escape closes, focus returns to opener.
 * Central colour tokens, light/dark themes, 48px touch targets, fits 320 px at 130% text.
 */
import { useRef, useState } from 'react';
import { PIN_CHOICES, t, type PinDays } from '@beanpool/core';
import { pinMarketplacePost, type MarketplacePost } from '../lib/api';
import { useDialogFocus } from './dialog-focus';

export interface PinSheetProps {
    post: MarketplacePost;
    isOpen: boolean;
    onClose: () => void;
    onSuccess: (updated: MarketplacePost) => void;
}

export function PinSheet(props: PinSheetProps) {
    if (!props.isOpen) return null;
    return <PinSheetContent {...props} />;
}

function PinSheetContent({ post, onClose, onSuccess }: Omit<PinSheetProps, 'isOpen'>) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useDialogFocus(dialogRef, onClose);

    const handlePin = async (days: PinDays) => {
        if (submitting) return;
        setSubmitting(true);
        setError(null);
        try {
            const res = await pinMarketplacePost(post.id, days);
            const updated: MarketplacePost = {
                ...post,
                pinnedUntil: res.pinnedUntil,
                pinnedAt: res.pinnedAt,
            };
            onSuccess(updated);
            onClose();
        } catch (e: any) {
            setError(e.message || t('Three posts are pinned already. Take one off first.'));
        } finally {
            setSubmitting(false);
        }
    };

    const choiceLabels: Record<PinDays, string> = {
        1: t('For 1 day'),
        3: t('For 3 days'),
        7: t('For 1 week'),
    };

    return (
        <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-xs p-0 sm:p-4"
            onClick={(e) => {
                if (e.target === e.currentTarget && !submitting) onClose();
            }}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="pin-sheet-title"
                data-testid="pin-sheet-modal"
                className="w-full max-w-sm bg-white dark:bg-nature-950 rounded-t-3xl sm:rounded-3xl border border-nature-200 dark:border-nature-800 shadow-2xl p-5 flex flex-col gap-3 animate-in slide-in-from-bottom-4 duration-200"
            >
                <div className="flex items-center justify-between pb-1">
                    <h2
                        id="pin-sheet-title"
                        tabIndex={-1}
                        className="text-lg font-black text-nature-950 dark:text-white m-0 focus:outline-none"
                    >
                        {t('Pin to the top…')}
                    </h2>
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={submitting}
                        aria-label={t('Close')}
                        className="text-nature-400 hover:text-nature-600 dark:hover:text-nature-200 font-bold p-1 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nature-500 cursor-pointer disabled:opacity-50"
                    >
                        ✕
                    </button>
                </div>

                {error && (
                    <div
                        role="alert"
                        data-testid="pin-sheet-error"
                        className="p-3 rounded-xl bg-bp-chip-warn-tint text-bp-chip-warn-ink text-xs font-semibold break-words"
                    >
                        {error}
                    </div>
                )}

                <div className="flex flex-col gap-2">
                    {PIN_CHOICES.map((days) => (
                        <button
                            key={days}
                            type="button"
                            onClick={() => handlePin(days)}
                            disabled={submitting}
                            data-testid={`pin-choice-${days}`}
                            className="min-h-[48px] w-full px-4 py-3 rounded-xl border border-nature-200 dark:border-nature-800 bg-nature-50/50 hover:bg-nature-100 dark:bg-nature-900/40 dark:hover:bg-nature-900 text-nature-900 dark:text-white font-bold text-sm text-left transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-between focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nature-500"
                        >
                            <span>{choiceLabels[days]}</span>
                        </button>
                    ))}
                </div>

                <button
                    type="button"
                    onClick={onClose}
                    disabled={submitting}
                    className="min-h-[48px] w-full mt-1 px-4 py-3 rounded-xl border border-transparent text-nature-600 dark:text-nature-400 hover:text-nature-900 dark:hover:text-white font-bold text-sm text-center transition-colors cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nature-500"
                >
                    {t('Cancel')}
                </button>
            </div>
        </div>
    );
}

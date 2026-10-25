/**
 * Confirmation dialog for chat actions (Delete for everyone / Remove message).
 *
 * Real accessible dialog: focus inside, Escape closes, focus returns to opener button.
 */
import { useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useDialogFocus } from './dialog-focus';

interface Props {
    isOpen: boolean;
    title: string;
    message: string;
    cancelLabel: string;
    confirmLabel: string;
    destructive?: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}

export function ChatConfirmDialog({
    isOpen,
    title,
    message,
    cancelLabel,
    confirmLabel,
    destructive = true,
    onCancel,
    onConfirm,
}: Props): ReactNode {
    const dialogRef = useRef<HTMLDivElement>(null);
    useDialogFocus(dialogRef, onCancel);

    if (!isOpen) return null;

    return createPortal(
        <div
            className="fixed inset-0 z-[130] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
            onClick={onCancel}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="chat-confirm-title"
                aria-describedby="chat-confirm-desc"
                tabIndex={-1}
                onClick={(e) => e.stopPropagation()}
                className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl w-full max-w-sm p-5 sm:p-6 shadow-xl flex flex-col gap-4 outline-none"
            >
                <h2 id="chat-confirm-title" tabIndex={-1} className="text-base font-bold text-nature-950 dark:text-white outline-none m-0">
                    {title}
                </h2>
                <p id="chat-confirm-desc" className="text-sm text-nature-600 dark:text-nature-300 m-0">
                    {message}
                </p>
                <div className="flex justify-end gap-2 mt-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="px-4 py-2 rounded-xl text-sm font-semibold bg-nature-100 dark:bg-nature-800 text-nature-700 dark:text-nature-300 hover:bg-nature-200 dark:hover:bg-nature-700 dark:hover:text-nature-200 border-none cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nature-400"
                    >
                        {cancelLabel}
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        className={`px-4 py-2 rounded-xl text-sm font-semibold border-none cursor-pointer focus-visible:outline-none focus-visible:ring-2 ${
                            destructive
                                ? 'bg-bp-danger-fill hover:bg-bp-danger-hover text-bp-danger-on focus-visible:ring-red-500'
                                : 'bg-nature-900 hover:bg-nature-800 text-white dark:bg-white dark:hover:bg-nature-100 dark:text-nature-900 focus-visible:ring-nature-400'
                        }`}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
}

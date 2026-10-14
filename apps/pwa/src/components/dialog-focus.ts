/**
 * Keys and focus for Home's dialogs (components/AddCardDialog.tsx, components/EditHomeDialog.tsx): focus into the
 * dialog's heading, Tab and Shift+Tab kept inside, Escape closes it.
 *
 * - **Only the dialog in front has the keys.** A dialog drawn over another (a saved search's Settings… over Edit home) is
 *   the last `[aria-modal]` on the page: the one under it leaves Escape and Tab alone, so Escape closes only the one in
 *   front and Tab goes round its own controls (review of #1701, finding 2).
 * - **Focus on close** goes back to what opened the dialog. When that went with the same step (a menu's Settings… item,
 *   Edit home's ＋ Add a card, the picker's row behind its settings), to `fallback`, never to the page's `<body>`
 *   (finding 3). Nowhere while `keepFocus` is set: the page sends it on (after an add, to the new card).
 */
import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogFocusOptions {
    keepFocus?: RefObject<boolean>;
    /** Where focus goes on close when the opener has gone. */
    fallback?: () => HTMLElement | null | undefined;
}

export function useDialogFocus(dialog: RefObject<HTMLDivElement | null>, onClose: () => void, opts: DialogFocusOptions = {}) {
    const opener = useRef<Element | null>(typeof document !== 'undefined' ? document.activeElement : null);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    const fallbackRef = useRef(opts.fallback);
    fallbackRef.current = opts.fallback;
    const keepFocus = opts.keepFocus;
    useEffect(() => {
        const back = opener.current as HTMLElement | null;
        dialog.current?.querySelector<HTMLElement>('h2')?.focus();
        const onKeyDown = (e: KeyboardEvent) => {
            const box = dialog.current;
            // Not drawn (the picker while its card's settings are open in its place), or another dialog is in front.
            if (!box) return;
            const modals = document.querySelectorAll('[aria-modal="true"]');
            if (modals[modals.length - 1] !== box) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                closeRef.current();
                return;
            }
            if (e.key !== 'Tab') return;
            const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE));
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
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            if (keepFocus?.current) return;
            const to = back && back !== document.body && back.isConnected ? back : fallbackRef.current?.();
            to?.focus?.();
        };
    }, [dialog, keepFocus]);
}

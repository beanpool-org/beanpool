import React, { useCallback, useRef, useState } from 'react';
import { ModalBackdrop } from './ModalBackdrop';

/**
 * The confirmation for an action that removes or replaces data, keys or roles: in the page, never the browser's
 * window.confirm() (design case 18 §3.4; owner-delete S4b item 6). A browser dialog shows the page's words under the
 * site's address in the browser's own frame, can be turned off for the site with one tick, and is the one thing on
 * the page the manager cannot style for 320 px and 130 % text or for dark mode.
 *
 *     const [ask, confirmation] = useInPageConfirm();
 *     if (!(await ask({ title: 'Revoke the token "ci"?', body: 'Anything using it stops at once.', confirmLabel: 'Revoke' }))) return;
 *     ...
 *     return <>{...}{confirmation}</>;
 *
 * Escape, the backdrop and Back (ModalBackdrop) answer "no".
 */
export interface InPageConfirmAsk {
    title: string;
    body?: string;
    confirmLabel: string;
    cancelLabel?: string;
}

const BTN = 'min-h-[48px] px-4 py-2 rounded-xl text-sm font-bold transition-all';

export function useInPageConfirm(): [(ask: InPageConfirmAsk) => Promise<boolean>, React.ReactNode] {
    const [open, setOpen] = useState<InPageConfirmAsk | null>(null);
    const resolver = useRef<((yes: boolean) => void) | null>(null);

    const ask = useCallback((a: InPageConfirmAsk) => new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        setOpen(a);
    }), []);

    const answer = useCallback((yes: boolean) => {
        const r = resolver.current;
        resolver.current = null;
        setOpen(null);
        r?.(yes);
    }, []);

    const element = open ? (
        <ModalBackdrop onClose={() => answer(false)} className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
            <div role="alertdialog" aria-modal="true" aria-labelledby="in-page-confirm-title" aria-describedby={open.body ? 'in-page-confirm-body' : undefined}
                data-testid="in-page-confirm"
                className="w-full max-w-md min-w-0 p-5 rounded-2xl bg-nature-900 border border-nature-700 shadow-2xl space-y-4"
                style={{ overflowWrap: 'anywhere' }}>
                <p id="in-page-confirm-title" className="m-0 text-base font-bold text-white">{open.title}</p>
                {open.body && <p id="in-page-confirm-body" className="m-0 text-sm text-nature-200">{open.body}</p>}
                <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => answer(true)} autoFocus
                        className={`${BTN} flex-1 bg-bp-danger-fill hover:bg-bp-danger-hover text-bp-danger-on border border-bp-danger-fill`}>
                        {open.confirmLabel}
                    </button>
                    <button type="button" onClick={() => answer(false)} className={`${BTN} flex-1 bg-nature-800 hover:bg-nature-700 text-white`}>
                        {open.cancelLabel || 'Cancel'}
                    </button>
                </div>
            </div>
        </ModalBackdrop>
    ) : null;

    return [ask, element];
}

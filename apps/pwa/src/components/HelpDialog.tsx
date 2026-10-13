import { useId, useRef } from 'react';
import type { HelpSheet } from '@beanpool/core';
import { useDialogFocus } from './dialog-focus';

const row = 'w-full min-h-[44px] px-1 text-left bg-transparent border-0 border-b border-nature-200 dark:border-nature-800 text-[0.9375rem] font-bold text-emerald-800 dark:text-emerald-300 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';
const plain = 'min-w-[44px] min-h-[44px] px-4 rounded-xl border border-nature-300 dark:border-nature-700 bg-transparent text-sm font-bold text-nature-800 dark:text-nature-100 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';

/**
 * The "?"'s dialog (scratch/global-node/DESIGN-getting-started-fable.md §4): the guide page for the screen you're on (its
 * title and its `help:` line, else its summary, else its section's), then Read the guide page ›, Search the guide, and
 * Take the tour again (Pick up the tour while one runs). With no words it still has Search and the tour: never dead, never
 * "no help here". A real dialog, as Add a card's: labelled by its heading, focus kept in, Escape closes it.
 */
export function HelpDialog({ sheet, tourOpen, canTour, onReadPage, onSearch, onTour, onClose }: {
    sheet: HelpSheet;
    tourOpen: boolean;
    canTour: boolean;
    onReadPage: () => void;
    onSearch: () => void;
    onTour: () => void;
    onClose: () => void;
}) {
    const id = useId();
    const dialog = useRef<HTMLDivElement>(null);
    useDialogFocus(dialog, onClose);
    return (
        <div className="fixed inset-0 flex items-end sm:items-center justify-center" style={{ zIndex: 1100, background: 'rgba(0,0,0,0.45)' }}
            onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={id} data-testid="help-dialog"
                className="w-full sm:max-w-md max-h-[90vh] overflow-y-auto bg-white dark:bg-nature-950 rounded-t-2xl sm:rounded-2xl shadow-2xl p-4 min-w-0">
                <div className="flex items-start gap-2 mb-2">
                    <h2 id={id} tabIndex={-1} data-testid="help-title" className="m-0 flex-1 min-w-0 break-words text-lg font-extrabold text-nature-950 dark:text-white focus:outline-none">{sheet.title ?? 'Help'}</h2>
                    <button type="button" data-testid="help-close" onClick={onClose} className={plain}>Close</button>
                </div>
                {sheet.text && <p data-testid="help-text" className="m-0 mb-3 text-[0.9375rem] text-nature-900 dark:text-nature-100 break-words">{sheet.text}</p>}
                <div className="border-t border-nature-200 dark:border-nature-800">
                    {(sheet.slug || sheet.section) && <button type="button" className={row} onClick={onReadPage} data-testid="help-read-page">Read the guide page ›</button>}
                    <button type="button" className={row} onClick={onSearch} data-testid="help-search">Search the guide</button>
                    {canTour && <button type="button" className={row} onClick={onTour} data-testid="help-tour">{tourOpen ? 'Pick up the tour' : 'Take the tour again'}</button>}
                </div>
            </div>
        </div>
    );
}

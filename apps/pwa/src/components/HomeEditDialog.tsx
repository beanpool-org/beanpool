/**
 * Edit home (DESIGN-home-dashboard-fable.md §4.1, §10): a plain list of every card the member can tailor, each with a
 * switch and up/down arrows, the hidden ones greyed under "Hidden" so they come back, and Reset to defaults. Nothing
 * dragged, nothing typed.
 *
 * A real dialog: `role="dialog"`, labelled by its heading, focus moved into it and kept there (Tab and Shift+Tab go
 * round), Escape closes it, and focus goes back to what opened it. Every control is a button at least 44 px tall whose
 * label says what it does ("Move Coming up up", a switch that says whether the card is shown).
 */
import { useEffect, useRef, useState } from 'react';
import { TIPS_ALL_SEEN } from '@beanpool/core';
import { cardTitle, type HomeAnswer, type HomeCardId } from '../lib/home-cards';

interface Props {
    answer: HomeAnswer;
    shown: HomeCardId[];
    hidden: HomeCardId[];
    onToggle: (id: HomeCardId, show: boolean) => void;
    onMove: (id: HomeCardId, direction: 'up' | 'down') => void;
    onReset: () => void;
    onClose: () => void;
    /** Tips is on but every tip is seen, so the card has gone by itself: said under its name (off and on starts over). */
    tipsAllSeen?: boolean;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function HomeEditDialog({ answer, shown, hidden, onToggle, onMove, onReset, onClose, tipsAllSeen }: Props) {
    const dialog = useRef<HTMLDivElement | null>(null);
    const opener = useRef<Element | null>(typeof document !== 'undefined' ? document.activeElement : null);
    // A switch moves its row between "Shown" and "Hidden", which draws it anew: focus follows it there.
    const [refocus, setRefocus] = useState<HomeCardId | null>(null);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;

    useEffect(() => {
        const back = opener.current as HTMLElement | null;
        dialog.current?.querySelector<HTMLElement>('h2')?.focus();
        // On the document, so Escape and Tab work wherever focus is while the dialog is open.
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                closeRef.current();
                return;
            }
            if (e.key !== 'Tab' || !dialog.current) return;
            const items = Array.from(dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE));
            if (!items.length) return;
            const first = items[0];
            const last = items[items.length - 1];
            const active = document.activeElement;
            if (!dialog.current.contains(active)) {
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
            back?.focus?.();
        };
    }, []);

    useEffect(() => {
        if (!refocus) return;
        dialog.current?.querySelector<HTMLElement>(`[data-testid="home-edit-switch-${refocus}"]`)?.focus();
        setRefocus(null);
    }, [refocus, shown, hidden]);

    const btn = 'min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg border border-nature-300 dark:border-nature-700 bg-transparent text-nature-800 dark:text-nature-100 font-bold cursor-pointer disabled:opacity-40 disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';

    function row(id: HomeCardId, on: boolean, index: number, list: HomeCardId[]) {
        const title = cardTitle(id, answer);
        return (
            <li key={id} data-testid={`home-edit-row-${id}`}
                className={`flex items-center gap-2 py-1.5 border-b border-nature-100 dark:border-nature-800 last:border-b-0 min-w-0 ${on ? '' : 'opacity-70'}`}>
                <span className={`flex-1 min-w-0 break-words text-sm font-semibold ${on ? 'text-nature-900 dark:text-white' : 'text-nature-600 dark:text-nature-300'}`}>
                    {title}
                    {id === 'tips' && on && tipsAllSeen && (
                        <span data-testid="home-edit-tips-all-seen" className="block text-xs font-normal text-nature-600 dark:text-nature-300">{TIPS_ALL_SEEN}</span>
                    )}
                </span>
                {on && (
                    <>
                        <button type="button" className={btn} aria-label={`Move ${title} up`} disabled={index === 0} onClick={() => onMove(id, 'up')}>
                            <span aria-hidden="true">↑</span>
                        </button>
                        <button type="button" className={btn} aria-label={`Move ${title} down`} disabled={index === list.length - 1} onClick={() => onMove(id, 'down')}>
                            <span aria-hidden="true">↓</span>
                        </button>
                    </>
                )}
                <button type="button" role="switch" aria-checked={on} aria-label={`Show ${title}`} data-testid={`home-edit-switch-${id}`}
                    onClick={() => { onToggle(id, !on); setRefocus(id); }}
                    className={`relative shrink-0 w-[52px] min-h-[44px] flex items-center rounded-full border-0 bg-transparent cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500`}>
                    <span aria-hidden="true" className={`block w-[44px] h-[26px] mx-auto rounded-full transition-colors ${on ? 'bg-emerald-700' : 'bg-nature-300 dark:bg-nature-700'}`}>
                        <span className={`block w-[22px] h-[22px] mt-[2px] rounded-full bg-white shadow transition-transform ${on ? 'translate-x-[20px]' : 'translate-x-[2px]'}`} />
                    </span>
                </button>
            </li>
        );
    }

    return (
        // Above everything while it is open, the install banner (InstallPrompt, 1000) included: it is modal.
        <div className="fixed inset-0 flex items-end sm:items-center justify-center" style={{ zIndex: 1100, background: 'rgba(0,0,0,0.45)' }}
            onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="home-edit-title" data-testid="home-edit-dialog"
                className="w-full sm:max-w-md max-h-[90vh] overflow-y-auto bg-white dark:bg-nature-950 rounded-t-2xl sm:rounded-2xl shadow-2xl p-4 min-w-0">
                <h2 id="home-edit-title" tabIndex={-1} className="m-0 mb-1 text-lg font-extrabold text-nature-950 dark:text-white focus:outline-none">Edit home</h2>
                <p className="m-0 mb-3 text-sm text-nature-700 dark:text-nature-200">Choose which cards Home shows, and their order. Needs you and your community's card always stay.</p>
                <ul className="list-none m-0 p-0" aria-label="Shown on Home">
                    {shown.map((id, i) => row(id, true, i, shown))}
                </ul>
                {hidden.length > 0 && (
                    <>
                        <h3 className="mt-4 mb-1 text-[0.7rem] font-extrabold uppercase tracking-wider text-nature-600 dark:text-nature-300">Hidden</h3>
                        <ul className="list-none m-0 p-0" aria-label="Hidden">
                            {hidden.map((id, i) => row(id, false, i, hidden))}
                        </ul>
                    </>
                )}
                <div className="flex flex-wrap gap-2 mt-4">
                    <button type="button" data-testid="home-edit-reset" onClick={onReset}
                        className="flex-1 min-w-[140px] min-h-[44px] px-4 rounded-xl border border-nature-300 dark:border-nature-700 bg-transparent text-sm font-bold text-nature-800 dark:text-nature-100 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                        Reset to defaults
                    </button>
                    <button type="button" data-testid="home-edit-done" onClick={onClose}
                        className="flex-1 min-w-[140px] min-h-[44px] px-4 rounded-xl border-0 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400">
                        Done
                    </button>
                </div>
            </div>
        </div>
    );
}

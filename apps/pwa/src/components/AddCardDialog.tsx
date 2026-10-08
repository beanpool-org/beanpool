/**
 * Add a card (scratch/home/CARD-FRAME-DESIGN-fable.md §1.2, slice F3): the picker, opened from the community card's
 * "Add a card ›" and Edit home's first row. Three groups (For you · Around you · Getting started), each type this node
 * can show (lib/home-layout.ts `pickerGroups`), in the catalogue's order. A row is the type's name and one line of what
 * it shows, with an Add button, "On Home" for a one-of-a-kind already there, or "2 of 5 on Home" under an instance
 * type's line. Nothing is ever shown as locked: a type this node can't show is simply not listed.
 *
 * A type with settings (a saved search) opens its settings ({@link CardSettingsDialog}) on Add, whose last button is
 * "Add to Home". The same settings open from a card's "…" → Settings…, with Save.
 *
 * A real dialog, as Edit home's: `role="dialog"`, labelled by its heading, focus moved in and kept there, Escape closes
 * it, focus goes back to what opened it (or where the page sends it after an add; components/dialog-focus.ts). Every
 * control is at least 44 px.
 */
import { useRef, useState, type ReactNode } from 'react';
import { HOME_SEARCH_MAX_CHARS, readSearchSettings } from '@beanpool/core';
import { SEARCH_WAITING_LINE, type PickerGroup, type PickerRow } from '../lib/home-layout';
import { useDialogFocus } from './dialog-focus';

const primary = 'min-w-[44px] min-h-[44px] px-4 rounded-xl border-0 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400';
const plain = 'min-w-[44px] min-h-[44px] px-4 rounded-xl border border-nature-300 dark:border-nature-700 bg-transparent text-sm font-bold text-nature-800 dark:text-nature-100 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';

function Shell({ id, testId, title, children, onClose, dialog }: {
    id: string; testId: string; title: string; children: ReactNode; onClose: () => void; dialog: React.RefObject<HTMLDivElement | null>;
}) {
    return (
        // Above everything while it is open, the install banner (InstallPrompt, 1000) included: it is modal.
        <div className="fixed inset-0 flex items-end sm:items-center justify-center" style={{ zIndex: 1100, background: 'rgba(0,0,0,0.45)' }}
            onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={id} data-testid={testId}
                className="w-full sm:max-w-md max-h-[90vh] overflow-y-auto bg-white dark:bg-nature-950 rounded-t-2xl sm:rounded-2xl shadow-2xl p-4 min-w-0">
                <div className="flex items-start gap-2 mb-1">
                    <h2 id={id} tabIndex={-1} className="m-0 flex-1 min-w-0 break-words text-lg font-extrabold text-nature-950 dark:text-white focus:outline-none">{title}</h2>
                    <button type="button" data-testid={`${testId}-done`} onClick={onClose} className={plain}>Done</button>
                </div>
                {children}
            </div>
        </div>
    );
}

export const PICKER_NOTE = 'Pick a card to put on Home. You can move or remove it any time.';
export const PICKER_FULL_NOTE = 'Home is full: remove a card to add one.';

interface PickerProps {
    groups: PickerGroup[];
    full: boolean;
    /** Add this type (with its settings, for a type that has them). The page closes the picker and moves focus. */
    onAdd: (type: string, settings?: Record<string, unknown>) => void;
    onClose: () => void;
    /** Where focus goes on close when what opened the picker has gone (Edit home's ＋ Add a card). */
    returnFocus?: () => HTMLElement | null | undefined;
}

export function AddCardDialog({ groups, full, onAdd, onClose, returnFocus }: PickerProps) {
    const dialog = useRef<HTMLDivElement | null>(null);
    // An add sends focus to the new card's "…" (the page does it): closing then doesn't pull it back to the opener.
    const added = useRef(false);
    const [settingsFor, setSettingsFor] = useState<PickerRow | null>(null);
    useDialogFocus(dialog, onClose, { keepFocus: added, fallback: returnFocus });

    const add = (type: string, settings?: Record<string, unknown>) => {
        added.current = true;
        onAdd(type, settings);
    };

    if (settingsFor) {
        return (
            <CardSettingsDialog type={settingsFor.type} name={settingsFor.name} mode="add" keepFocus={added}
                onSubmit={(s) => add(settingsFor.type, s)} onClose={() => setSettingsFor(null)}
                // Back in the picker: its row's Add, else its heading.
                returnFocus={() => dialog.current?.querySelector<HTMLElement>(`[data-testid="home-add-${settingsFor.type}"]`) ?? dialog.current?.querySelector<HTMLElement>('h2')} />
        );
    }

    return (
        <Shell id="home-add-title" testId="home-add-dialog" title="Add a card" onClose={onClose} dialog={dialog}>
            <p data-testid="home-add-note" className="m-0 mb-3 text-sm text-nature-700 dark:text-nature-200">{full ? PICKER_FULL_NOTE : PICKER_NOTE}</p>
            {groups.map((g) => (
                <section key={g.id} aria-labelledby={`home-add-group-${g.id}`} className="mb-3">
                    <h3 id={`home-add-group-${g.id}`} className="m-0 mb-1 text-[0.7rem] font-extrabold uppercase tracking-wider text-nature-600 dark:text-nature-300">{g.name}</h3>
                    <ul className="list-none m-0 p-0 rounded-xl border border-nature-200 dark:border-nature-800">
                        {g.rows.map((r) => (
                            <li key={r.type} data-testid={`home-add-row-${r.type}`}
                                className="flex items-center gap-2 px-3 py-2 border-b border-nature-100 dark:border-nature-800 last:border-b-0 min-w-0">
                                <span className="flex-1 min-w-0 break-words">
                                    <span className="block text-sm font-bold text-nature-900 dark:text-white">{r.name}</span>
                                    <span className="block text-xs text-nature-700 dark:text-nature-200">{r.line}</span>
                                    {r.count && <span data-testid={`home-add-count-${r.type}`} className="block text-xs text-nature-600 dark:text-nature-300">{r.count}</span>}
                                    {r.status && <span className="block text-xs text-nature-600 dark:text-nature-300">{r.status}</span>}
                                </span>
                                {r.state === 'add' ? (
                                    <button type="button" data-testid={`home-add-${r.type}`} aria-label={`Add ${r.name} to Home`} className={`shrink-0 ${primary}`}
                                        onClick={() => (r.hasSettings ? setSettingsFor(r) : add(r.type))}>
                                        Add
                                    </button>
                                ) : r.state === 'on-home' ? (
                                    // Words, not an aria-label: a plain span's label isn't reliably read (review of #1701, 7a).
                                    <span data-testid={`home-add-on-${r.type}`} className="shrink-0 text-xs font-semibold text-nature-600 dark:text-nature-300">
                                        <span aria-hidden="true">On Home</span><span className="sr-only">{r.name} is already on Home</span>
                                    </span>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                </section>
            ))}
        </Shell>
    );
}

interface SettingsProps {
    type: string;
    /** The type's name ("A saved search"), for the heading. */
    name: string;
    /** `add`: from the picker, last button "Add to Home"; `save`: from a card's Settings…, last button "Save". */
    mode: 'add' | 'save';
    /** The card's settings now (for `save`). */
    initial?: unknown;
    onSubmit: (settings: Record<string, unknown>) => void;
    onClose: () => void;
    keepFocus?: React.RefObject<boolean>;
    /** Where focus goes on close when what opened the settings has gone (a menu's Settings… item). */
    returnFocus?: () => HTMLElement | null | undefined;
}

/**
 * A card's settings. Today only the saved search has any, and only its words here: its kind, category and distance,
 * and its listings on the card, come with slice F4 ({@link SEARCH_WAITING_LINE}).
 */
export function CardSettingsDialog({ type, name, mode, initial, onSubmit, onClose, keepFocus, returnFocus }: SettingsProps) {
    const dialog = useRef<HTMLDivElement | null>(null);
    useDialogFocus(dialog, onClose, { keepFocus, fallback: returnFocus });
    const [q, setQ] = useState(() => readSearchSettings(initial).q);
    const words = q.trim();
    if (type !== 'search') return null;
    return (
        <Shell id="home-settings-title" testId="home-settings-dialog" title={name} onClose={onClose} dialog={dialog}>
            <form onSubmit={(e) => { e.preventDefault(); if (words) onSubmit({ ...readSearchSettings(initial), q: words }); }}>
                <label htmlFor="home-settings-q" className="block mb-1 text-sm font-semibold text-nature-900 dark:text-white">Words to look for</label>
                <input id="home-settings-q" data-testid="home-settings-q" type="text" value={q} maxLength={HOME_SEARCH_MAX_CHARS}
                    onChange={(e) => setQ(e.target.value)} autoComplete="off"
                    className="w-full min-w-0 min-h-[44px] px-3 rounded-xl border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-900 text-base text-nature-900 dark:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" />
                <p className="m-0 mt-2 text-xs text-nature-700 dark:text-nature-200">{SEARCH_WAITING_LINE}</p>
                <button type="submit" data-testid="home-settings-submit" disabled={!words} className={`mt-3 w-full disabled:opacity-40 disabled:cursor-default ${primary}`}>
                    {mode === 'add' ? 'Add to Home' : 'Save'}
                </button>
            </form>
        </Shell>
    );
}

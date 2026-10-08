/**
 * Edit home on the card frame (scratch/home/CARD-FRAME-DESIGN-fable.md §1.3, slice F3): ＋ Add a card first, then the
 * cards on Home in the member's order, each `name (+ "Nothing to show now" / "All tips seen") ↑ ↓ …`, then Reset to
 * defaults. No switches and no Hidden list: the switch model is version 1's, and it cannot say "a second saved search".
 * A row's "…" has Settings… (a type that has them) and Remove. Nothing dragged, nothing typed.
 *
 * Replaces components/HomeEditDialog.tsx once pages/HomePage.tsx draws Home from the version-2 layout.
 *
 * A real dialog: `role="dialog"`, labelled by its heading, focus moved in and kept there (Tab and Shift+Tab go round),
 * Escape closes it, and focus goes back to what opened it. Every control is a button at least 44 px tall whose label
 * names the card by its screen-reader name (lib/home-layout.ts `cardLabelName`: a saved search by its words).
 */
import { useEffect, useRef, useState } from 'react';
import { NOT_ON_ACCOUNT_LINE } from '../lib/home-layout';

export interface EditHomeRow {
    /** The instance id. */
    id: string;
    /** The type's name, shown on the row (fixed words). */
    name: string;
    /** The screen reader's name for it (a saved search by its words). */
    label: string;
    /** "Nothing to show now" or "All tips seen", under its name. */
    note?: string | null;
    hasSettings: boolean;
}

interface Props {
    rows: EditHomeRow[];
    /** The node can't keep a version-2 layout yet: the cards stay in this browser ({@link NOT_ON_ACCOUNT_LINE}). */
    notOnAccount?: boolean;
    onAdd: () => void;
    onMove: (id: string, direction: 'up' | 'down') => void;
    onSettings: (id: string) => void;
    onRemove: (id: string) => void;
    onReset: () => void;
    onClose: () => void;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const EDIT_HOME_NOTE = "Needs you stays at the top, and your community's card at the bottom.";

export function EditHomeDialog({ rows, notOnAccount, onAdd, onMove, onSettings, onRemove, onReset, onClose }: Props) {
    const dialog = useRef<HTMLDivElement | null>(null);
    const opener = useRef<Element | null>(typeof document !== 'undefined' ? document.activeElement : null);
    const [menuFor, setMenuFor] = useState<string | null>(null);
    // After a move the row is drawn in its new place: focus follows its arrow there. After a Remove: the nearest row left.
    const [refocus, setRefocus] = useState<string | null>(null);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;

    useEffect(() => {
        const back = opener.current as HTMLElement | null;
        dialog.current?.querySelector<HTMLElement>('h2')?.focus();
        const onKeyDown = (e: KeyboardEvent) => {
            if (!dialog.current) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                closeRef.current();
                return;
            }
            if (e.key !== 'Tab') return;
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
        dialog.current?.querySelector<HTMLElement>(refocus)?.focus();
        setRefocus(null);
    }, [refocus, rows]);

    const btn = 'shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg border border-nature-300 dark:border-nature-700 bg-transparent text-nature-800 dark:text-nature-100 font-bold cursor-pointer disabled:opacity-40 disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';
    const item = 'w-full min-h-[44px] px-4 text-left text-sm font-semibold bg-transparent border-0 text-nature-900 dark:text-white hover:bg-nature-100 dark:hover:bg-nature-800 cursor-pointer focus-visible:outline-none focus-visible:bg-nature-100 dark:focus-visible:bg-nature-800';

    function remove(i: number) {
        const r = rows[i];
        const near = rows[i + 1] ?? rows[i - 1];
        setMenuFor(null);
        onRemove(r.id);
        setRefocus(near ? `[data-testid="home-edit-menu-${near.id}"]` : '[data-testid="home-edit-add"]');
    }

    return (
        // Above everything while it is open, the install banner (InstallPrompt, 1000) included: it is modal.
        <div className="fixed inset-0 flex items-end sm:items-center justify-center" style={{ zIndex: 1100, background: 'rgba(0,0,0,0.45)' }}
            onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="home-edit-title" data-testid="home-edit-dialog"
                className="w-full sm:max-w-md max-h-[90vh] overflow-y-auto bg-white dark:bg-nature-950 rounded-t-2xl sm:rounded-2xl shadow-2xl p-4 min-w-0">
                <h2 id="home-edit-title" tabIndex={-1} className="m-0 mb-1 text-lg font-extrabold text-nature-950 dark:text-white focus:outline-none">Edit home</h2>
                <p className="m-0 mb-3 text-sm text-nature-700 dark:text-nature-200">{EDIT_HOME_NOTE}</p>
                {notOnAccount && (
                    <p data-testid="home-edit-not-on-account" className="m-0 mb-3 text-sm text-nature-700 dark:text-nature-200">{NOT_ON_ACCOUNT_LINE}</p>
                )}
                <button type="button" data-testid="home-edit-add" onClick={onAdd}
                    className="w-full mb-3 min-h-[44px] px-4 rounded-xl border-0 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400">
                    <span aria-hidden="true">＋ </span>Add a card
                </button>
                <ul className="list-none m-0 p-0" aria-label="On Home">
                    {rows.map((r, i) => (
                        <li key={r.id} data-testid={`home-edit-row-${r.id}`}
                            className="relative flex items-center gap-1 py-1.5 border-b border-nature-100 dark:border-nature-800 last:border-b-0 min-w-0">
                            <span className="flex-1 min-w-0 break-words text-sm font-semibold text-nature-900 dark:text-white">
                                {r.name}
                                {r.note && <span className="block text-xs font-normal text-nature-600 dark:text-nature-300">{r.note}</span>}
                            </span>
                            <button type="button" className={btn} aria-label={`Move ${r.label} up`} data-testid={`home-edit-up-${r.id}`} disabled={i === 0}
                                onClick={() => { onMove(r.id, 'up'); setRefocus(`[data-testid="home-edit-up-${r.id}"]:not([disabled]), [data-testid="home-edit-down-${r.id}"]`); }}>
                                <span aria-hidden="true">↑</span>
                            </button>
                            <button type="button" className={btn} aria-label={`Move ${r.label} down`} data-testid={`home-edit-down-${r.id}`} disabled={i === rows.length - 1}
                                onClick={() => { onMove(r.id, 'down'); setRefocus(`[data-testid="home-edit-down-${r.id}"]:not([disabled]), [data-testid="home-edit-up-${r.id}"]`); }}>
                                <span aria-hidden="true">↓</span>
                            </button>
                            <button type="button" className={btn} aria-label={`Options for ${r.label}`} aria-haspopup="true" aria-expanded={menuFor === r.id}
                                data-testid={`home-edit-menu-${r.id}`} onClick={() => setMenuFor(m => (m === r.id ? null : r.id))}>
                                <span aria-hidden="true">…</span>
                            </button>
                            {menuFor === r.id && (
                                <div role="group" aria-label={`Options for ${r.label}`}
                                    className="absolute right-0 top-full z-30 w-48 max-w-[calc(100vw-2rem)] py-1 rounded-xl shadow-xl bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-700">
                                    {r.hasSettings && (
                                        <button type="button" className={item} aria-label={`Settings for ${r.label}`} data-testid={`home-edit-settings-${r.id}`}
                                            onClick={() => { setMenuFor(null); onSettings(r.id); }}>Settings…</button>
                                    )}
                                    <button type="button" className={item} aria-label={`Remove ${r.label} from Home`} data-testid={`home-edit-remove-${r.id}`}
                                        onClick={() => remove(i)}>Remove</button>
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
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

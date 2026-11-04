/**
 * The in-flow menu that Share and Add to calendar both open (scratch/fable-design/DESIGN-detail-pages-fable.md §2.5, slice DW2).
 *
 * It sits in the page's flow under its button, never floating, so the page that holds it cannot cut it off. The rules are the
 * ones the calendar menu always had: the first item takes focus when it opens; a tap or press outside, Tab or Escape closes
 * it; the arrow keys walk the items; and choosing one hands focus back to the button that opened it (unless the choice opens
 * a dialog of its own, which keeps the focus).
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

/** One choice in a menu: its name, the sentence under it, and what it does. Words arrive already through t(). */
export interface MenuChoice {
    key: string;
    testId: string;
    label: string;
    /** The sentence under the name, read before the tap that does it. */
    line?: string | null;
    lineTestId?: string;
    disabled?: boolean;
    /** The choice opens something under the row (Invite and share's panel): whether that is open now. */
    expanded?: boolean;
    onSelect: () => void;
}

/** What one way of sharing gives the Share menu: its choice, and what it shows under the row afterwards (a note, a link, a panel). */
export interface SharePart {
    choice: MenuChoice;
    after: ReactNode;
}

export function useInFlowMenu() {
    const [open, setOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const buttonRef = useRef<HTMLButtonElement | null>(null);

    const toggle = useCallback(() => setOpen(o => !o), []);
    /** Close, and by default hand focus back to the button that opened the menu. */
    const close = useCallback((returnFocus = true) => {
        setOpen(false);
        if (!returnFocus) return;
        buttonRef.current?.focus();
        requestAnimationFrame(() => buttonRef.current?.focus());
    }, []);

    useEffect(() => {
        if (!open) return;
        menuRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
        const onDown = (e: MouseEvent | TouchEvent) => {
            const target = e.target;
            if (target instanceof Node && !menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('touchstart', onDown);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('touchstart', onDown);
        };
    }, [open]);

    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            // Escape puts the menu away and nothing else: a page that closes what it shows on Escape (the Market's open
            // listing listens on window) must not see this one (review of #2872). React's root listener runs before window's.
            e.stopPropagation();
            setOpen(false);
            requestAnimationFrame(() => buttonRef.current?.focus());
            return;
        }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Tab') return;
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []);
        if (!items.length) return;
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'Tab') {
            setOpen(false);
            return;
        }
        e.preventDefault();
        const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
        items[next]?.focus();
    };

    return { open, toggle, close, menuRef, buttonRef, onKeyDown };
}

const ITEM = 'w-full min-h-[48px] px-3 py-2 text-left bg-transparent border-0 hover:bg-nature-100 dark:hover:bg-nature-800 cursor-pointer '
    + 'focus-visible:outline-none focus-visible:bg-nature-100 dark:focus-visible:bg-nature-800 rounded-lg flex flex-col justify-center '
    + 'disabled:opacity-60 disabled:cursor-not-allowed';

/** The open menu: each choice a `menuitem` with its sentence under its name. */
export function MenuChoices({ menu, label, choices }: { menu: ReturnType<typeof useInFlowMenu>; label: string; choices: MenuChoice[] }) {
    return (
        <div
            ref={menu.menuRef}
            role="menu"
            aria-label={label}
            onKeyDown={menu.onKeyDown}
            className="w-full py-1 rounded-xl shadow-xl bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800"
        >
            {choices.map(c => (
                <button
                    key={c.key}
                    type="button"
                    role="menuitem"
                    data-testid={c.testId}
                    disabled={c.disabled}
                    aria-expanded={c.expanded}
                    onClick={c.onSelect}
                    className={ITEM}
                >
                    <span className="text-sm font-semibold text-nature-900 dark:text-nature-100 break-words">{c.label}</span>
                    {c.line && <span data-testid={c.lineTestId} className="text-xs text-nature-600 dark:text-nature-300 break-words">{c.line}</span>}
                </button>
            ))}
        </div>
    );
}

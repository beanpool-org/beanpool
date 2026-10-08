/**
 * One card on Home (DESIGN-home-dashboard-fable.md §9, §10): a region with its own heading, so a screen reader jumps card
 * to card, and a small "…" with three items, Hide · Move up · Move down (§4.1). No dragging. On the card frame
 * (CARD-FRAME-DESIGN-fable.md §1.3, slice F3) the items are Settings… (a type that has them) · Move up · Move down ·
 * Remove, named by the card's screen-reader name (a saved search by its words), given `onRemove` in place of `onHide`.
 *
 * The menu is a labelled button ("Card options for Coming up") that opens a short list of buttons under it: the first
 * item takes focus, the arrow keys move between them, Escape or a tap elsewhere closes it, and focus goes back to the
 * "…" afterwards (after Hide, which takes the card and its "…" away, the page moves it to the nearest card left). Each
 * item is a full-width button at least 44 px tall.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

interface MenuProps {
    title: string;
    /** The card's screen-reader name for the menu's labels (lib/home-layout.ts `cardLabelName`); absent: its title. */
    label?: string;
    canMoveUp: boolean;
    canMoveDown: boolean;
    /** Version 1's Hide. */
    onHide?: () => void;
    /** The card frame's Remove: the card goes, with its settings (Add a card brings it back). */
    onRemove?: () => void;
    /** Settings…, on a type that has them. */
    onSettings?: () => void;
    onMove: (direction: 'up' | 'down') => void;
}

function CardMenu({ title, label, canMoveUp, canMoveDown, onHide, onRemove, onSettings, onMove }: MenuProps) {
    const said = label ?? title;
    const [open, setOpen] = useState(false);
    const button = useRef<HTMLButtonElement | null>(null);
    const list = useRef<HTMLDivElement | null>(null);
    const menuId = useId();

    function close(returnFocus: boolean) {
        setOpen(false);
        if (returnFocus) requestAnimationFrame(() => button.current?.focus());
    }

    useEffect(() => {
        if (!open) return;
        list.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
        const onDown = (e: MouseEvent | TouchEvent) => {
            const t = e.target as Node | null;
            if (t && !list.current?.contains(t) && !button.current?.contains(t)) close(false);
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('touchstart', onDown);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('touchstart', onDown);
        };
    }, [open]);

    function onKeyDown(e: React.KeyboardEvent) {
        if (e.key === 'Escape') {
            e.preventDefault();
            close(true);
            return;
        }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Tab') return;
        const items = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []);
        if (!items.length) return;
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        // Tab leaves the menu, as it would leave any list of buttons: it closes, and focus goes on from the "…".
        if (e.key === 'Tab') {
            close(false);
            return;
        }
        e.preventDefault();
        const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
        items[next].focus();
    }

    const item = 'w-full min-h-[44px] px-4 text-left text-sm font-semibold bg-transparent border-0 text-nature-900 dark:text-white hover:bg-nature-100 dark:hover:bg-nature-800 disabled:text-nature-400 dark:disabled:text-nature-500 disabled:cursor-default cursor-pointer focus-visible:outline-none focus-visible:bg-nature-100 dark:focus-visible:bg-nature-800';

    return (
        <div className="relative shrink-0">
            <button ref={button} type="button" aria-label={`Card options for ${said}`} aria-haspopup="true" aria-expanded={open}
                aria-controls={open ? menuId : undefined} data-testid="home-card-menu"
                onClick={() => setOpen(o => !o)}
                className="min-w-[44px] min-h-[44px] -mr-2 -mt-2 flex items-center justify-center rounded-full bg-transparent border-0 text-nature-500 dark:text-nature-300 hover:text-nature-800 dark:hover:text-white text-lg font-black cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                <span aria-hidden="true">…</span>
            </button>
            {open && (
                <div ref={list} id={menuId} role="group" aria-label={`Options for ${said}`} onKeyDown={onKeyDown}
                    className="absolute right-0 top-full z-30 w-48 max-w-[calc(100vw-2rem)] py-1 rounded-xl shadow-xl bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-700">
                    {/* The card goes with its "…": the page gives focus to the nearest card left (pages/HomePage.tsx). */}
                    {onSettings && <button type="button" className={item} data-testid="home-menu-settings" onClick={() => { close(false); onSettings(); }}>Settings…</button>}
                    {onHide && !onRemove && <button type="button" className={item} onClick={() => { close(false); onHide(); }}>Hide</button>}
                    <button type="button" className={item} disabled={!canMoveUp} onClick={() => { close(true); onMove('up'); }}>Move up</button>
                    <button type="button" className={item} disabled={!canMoveDown} onClick={() => { close(true); onMove('down'); }}>Move down</button>
                    {onRemove && <button type="button" className={item} data-testid="home-menu-remove" aria-label={`Remove ${said} from Home`} onClick={() => { close(false); onRemove(); }}>Remove</button>}
                </div>
            )}
        </div>
    );
}

interface CardProps {
    /** The card's id, for tests and the reveal. */
    id: string;
    title: string;
    /** Words beside the title (the Market card's "Tune"), before the "…". */
    titleAside?: ReactNode;
    /** The "…" menu, for a card the member can hide and move. */
    menu?: Omit<MenuProps, 'title'>;
    /** A card that wants the member's eye (Needs you): an amber edge, never red (§6.3). */
    accent?: boolean;
    children: ReactNode;
    style?: React.CSSProperties;
}

export function HomeCard({ id, title, titleAside, menu, accent, children, style }: CardProps) {
    const headingId = `home-card-${id}-title`;
    return (
        <section aria-labelledby={headingId} data-testid={`home-card-${id}`} style={style}
            className={`bg-white dark:bg-nature-900 rounded-2xl shadow-sm border p-4 mb-3 min-w-0 ${accent ? 'border-amber-300 dark:border-amber-700' : 'border-nature-200 dark:border-nature-800'}`}>
            <div className="flex items-start justify-between gap-2 mb-1">
                {/* Focusable from the page (never by Tab): where focus goes when the card above it is hidden. */}
                <h2 id={headingId} tabIndex={-1} className="m-0 min-w-0 break-words text-[0.7rem] font-extrabold uppercase tracking-wider text-nature-600 dark:text-nature-300">
                    {title}
                </h2>
                <div className="flex items-start gap-1 shrink-0">
                    {titleAside}
                    {menu && <CardMenu title={title} {...menu} />}
                </div>
            </div>
            {children}
        </section>
    );
}

/** One tappable line of a card: a full-width button (or a link out) with the whole thing in its label (§10). */
export function HomeLine({ children, onClick, href, label, testId, external }: {
    children: ReactNode;
    onClick?: () => void;
    href?: string;
    label?: string;
    testId?: string;
    /** A link to another community's own page: a new tab, nothing of this page passed on. */
    external?: boolean;
}) {
    const cls = 'w-full min-h-[44px] flex items-center gap-3 py-1.5 text-left text-sm text-nature-900 dark:text-nature-100 bg-transparent border-0 rounded-lg cursor-pointer no-underline hover:bg-nature-50 dark:hover:bg-nature-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 min-w-0';
    if (href) {
        return (
            <a href={href} aria-label={label} data-testid={testId} className={cls}
                {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
                {children}
            </a>
        );
    }
    return (
        <button type="button" onClick={onClick} aria-label={label} data-testid={testId} className={cls}>
            {children}
        </button>
    );
}

/** The trailing link of a card ("See all ›", "All events ›"): its own button, at the right, 44 px tall. */
export function HomeMore({ children, onClick, label, testId }: { children: ReactNode; onClick: () => void; label?: string; testId?: string }) {
    return (
        <div className="flex justify-end">
            <button type="button" onClick={onClick} aria-label={label} data-testid={testId}
                className="min-h-[44px] px-2 -mr-2 bg-transparent border-0 text-sm font-bold text-nature-700 dark:text-nature-200 hover:text-nature-900 dark:hover:text-white cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded-lg">
                {children}
            </button>
        </div>
    );
}

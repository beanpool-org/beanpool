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
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { t, type CardHue } from '@beanpool/core';

export interface CardContainerState {
    width: number;
    wide: boolean;
}

export const CardContainerContext = createContext<CardContainerState>({ width: 0, wide: false });
export const useCardContainer = () => useContext(CardContainerContext);

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
    /**
     * The cards stand side by side (a wide screen's grid): the moves say Move earlier · Move later, the same action in
     * honest words, since "up" can be "left" there (DESIGN-home-wide-and-content-fable.md §1).
     */
    across?: boolean;
    /** The card caption band's ink colour, for the "…" button. */
    ink?: string;
}

export function CardMenu({ title, label, canMoveUp, canMoveDown, onHide, onRemove, onSettings, onMove, across, ink }: MenuProps) {
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
            const target = e.target as Node | null;
            if (target && !list.current?.contains(target) && !button.current?.contains(target)) close(false);
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

    const item = 'w-full min-h-[44px] px-4 text-left text-sm font-semibold bg-transparent border-0 text-text-primary hover:bg-bg-hover disabled:text-text-muted disabled:cursor-default cursor-pointer focus-visible:outline-none focus-visible:bg-bg-hover';

    return (
        <div className="relative shrink-0">
            <button ref={button} type="button" aria-label={t('Card options for {card}', { card: said })} aria-haspopup="true" aria-expanded={open}
                aria-controls={open ? menuId : undefined} data-testid="home-card-menu"
                onClick={() => setOpen(o => !o)}
                style={ink ? { color: ink } : undefined}
                className="min-w-[44px] min-h-[44px] -mr-2 flex items-center justify-center rounded-full bg-transparent border-0 text-lg font-black cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                <span aria-hidden="true">…</span>
            </button>
            {open && (
                <div ref={list} id={menuId} role="group" aria-label={t('Options for {card}', { card: said })} onKeyDown={onKeyDown}
                    className="absolute right-0 top-full z-30 w-48 max-w-[calc(100vw-2rem)] py-1 rounded-xl shadow-xl bg-bg-card border border-border-primary">
                    {/* The card goes with its "…": the page gives focus to the nearest card left (pages/HomePage.tsx). */}
                    {onSettings && <button type="button" className={item} data-testid="home-menu-settings" onClick={() => { close(false); onSettings(); }}>{t('Settings…')}</button>}
                    {onHide && !onRemove && <button type="button" className={item} onClick={() => { close(false); onHide(); }}>{t('Hide')}</button>}
                    <button type="button" className={item} disabled={!canMoveUp} onClick={() => { close(true); onMove('up'); }}>{across ? t('Move earlier') : t('Move up')}</button>
                    <button type="button" className={item} disabled={!canMoveDown} onClick={() => { close(true); onMove('down'); }}>{across ? t('Move later') : t('Move down')}</button>
                    {onRemove && <button type="button" className={item} data-testid="home-menu-remove" aria-label={t('Remove {card} from Home', { card: said })} onClick={() => { close(false); onRemove(); }}>{t('Remove')}</button>}
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
    /** The card's hue from brand-colours (S1). */
    hue?: CardHue;
}

export function HomeCard({ id, title, titleAside, menu, accent, children, style, hue }: CardProps) {
    const cardHue: CardHue = hue ?? (accent ? 'amber' : 'sage');
    const headingId = `home-card-${id}-title`;
    const sectionRef = useRef<HTMLElement | null>(null);
    const [width, setWidth] = useState(0);

    useLayoutEffect(() => {
        const el = sectionRef.current;
        if (!el) return;
        const measure = () => setWidth(el.clientWidth);
        measure();
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', measure);
            return () => window.removeEventListener('resize', measure);
        }
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const wide = width >= 480;

    return (
        <CardContainerContext.Provider value={{ width, wide }}>
            <section
                ref={sectionRef}
                aria-labelledby={headingId}
                data-testid={`home-card-${id}`}
                data-card-wide={wide ? 'true' : 'false'}
                data-container-width={width}
                style={{ containerType: 'inline-size', ...(accent ? { borderColor: 'var(--bp-card-amber-ink)' } : {}), ...style }}
                className={`bg-bg-card rounded-2xl shadow-sm border p-4 mb-3 min-w-0 home-card-container ${accent ? '' : 'border-border-primary'}`}
            >
                <div
                    data-testid={`home-card-${id}-band`}
                    className="-mx-4 -mt-4 px-4 mb-3 py-1 rounded-t-2xl flex items-start justify-between min-h-[48px] gap-2 min-w-0"
                    style={{
                        backgroundColor: `var(--bp-card-${cardHue}-tint)`,
                        color: `var(--bp-card-${cardHue}-ink)`,
                    }}
                >
                    {/* Focusable from the page (never by Tab): where focus goes when the card above it is hidden. */}
                    <h2 id={headingId} tabIndex={-1} className="m-0 break-words text-[0.7rem] font-extrabold uppercase tracking-wider" style={{ color: `var(--bp-card-${cardHue}-ink)` }}>
                        {title}
                    </h2>
                    <div className="flex items-start justify-end gap-1 min-w-0">
                        {titleAside}
                        {menu && <CardMenu title={title} ink={`var(--bp-card-${cardHue}-ink)`} {...menu} />}
                    </div>
                </div>
                {children}
            </section>
        </CardContainerContext.Provider>
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
    const cls = 'w-full min-h-[44px] flex items-center gap-3 py-1.5 text-left text-sm text-text-primary bg-transparent border-0 rounded-lg cursor-pointer no-underline hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 min-w-0';
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
                className="min-h-[44px] px-2 -mr-2 bg-transparent border-0 text-sm font-bold text-text-secondary hover:text-text-primary cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded-lg">
                {children}
            </button>
        </div>
    );
}

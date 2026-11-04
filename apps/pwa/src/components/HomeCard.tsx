/**
 * One card on Home (DESIGN-home-dashboard-fable.md §9, §10): a region with its own heading, so a screen reader jumps card
 * to card, and a small "…": Settings… (a type that has them) · Arrange · Remove, named by the card's screen-reader name
 * (a saved search by its words), given `onRemove` in place of `onHide`. Moving a card happens in one place, Arrange
 * (DESIGN-home-arrange-in-place-fable.md §2.1): the card stays exactly as it is drawn, in the same place, and the band's
 * arrows stand in for Tune and the "…" while its body goes quiet (a little dimmer, nothing in it takes a tap) until Done.
 *
 * The menu is a labelled button ("Card options for Coming up") that opens a short list of buttons under it: the first
 * item takes focus, the arrow keys move between them, Escape or a tap elsewhere closes it, and focus goes back to the
 * "…" afterwards (after Hide, which takes the card and its "…" away, the page moves it to the nearest card left). Each
 * item is a full-width button at least 44 px tall.
 */
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode, type RefObject } from 'react';
import { ARRANGE_WORDS, t, type CardHue } from '@beanpool/core';

export interface CardContainerState {
    width: number;
    wide: boolean;
}

export const CardContainerContext = createContext<CardContainerState>({ width: 0, wide: false });
export const useCardContainer = () => useContext(CardContainerContext);

/** core's sentences, shown through t(). */
const WORDS = ARRANGE_WORDS;

interface MenuProps {
    title: string;
    /** The card's screen-reader name for the menu's labels (lib/home-layout.ts `cardLabelName`); absent: its title. */
    label?: string;
    /** Version 1's Hide. */
    onHide?: () => void;
    /** The card frame's Remove: the card goes, with its settings (Add a card brings it back). */
    onRemove?: () => void;
    /** Settings…, on a type that has them. */
    onSettings?: () => void;
    /** Arrange, from this card: the moves are there, on the band. */
    onArrange?: () => void;
    /** The card caption band's ink colour, for the "…" button. */
    ink?: string;
}

export function CardMenu({ title, label, onHide, onRemove, onSettings, onArrange, ink }: MenuProps) {
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
                className={`min-w-[44px] min-h-[44px] -mr-2 ${ink ? '-my-1' : '-mt-2 text-text-secondary hover:text-text-primary'} flex items-center justify-center rounded-full bg-transparent border-0 text-lg font-black cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500`}>
                <span aria-hidden="true">…</span>
            </button>
            {open && (
                <div ref={list} id={menuId} role="group" aria-label={t('Options for {card}', { card: said })} onKeyDown={onKeyDown}
                    className="absolute right-0 top-full z-30 w-48 max-w-[calc(100vw-2rem)] py-1 rounded-xl shadow-xl bg-bg-card border border-border-primary">
                    {/* The card goes with its "…": the page gives focus to the nearest card left (pages/HomePage.tsx). */}
                    {onSettings && <button type="button" className={item} data-testid="home-menu-settings" onClick={() => { close(false); onSettings(); }}>{t('Settings…')}</button>}
                    {onHide && !onRemove && <button type="button" className={item} onClick={() => { close(false); onHide(); }}>{t('Hide')}</button>}
                    {onArrange && <button type="button" className={item} data-testid="home-menu-arrange" onClick={() => { close(false); onArrange(); }}>{t(WORDS.name)}</button>}
                    {onRemove && <button type="button" className={item} data-testid="home-menu-remove" aria-label={t('Remove {card} from Home', { card: said })} onClick={() => { close(false); onRemove(); }}>{t('Remove')}</button>}
                </div>
            )}
        </div>
    );
}

/** A card in Arrange (DESIGN-home-layout-fable.md §3.2): its band's arrows, or "Stays here" on the fixed two and a pin. */
export interface ArrangeBand {
    /** The card's screen-reader name, for the arrows' labels. */
    label: string;
    /** It can't move: the band says so instead of offering arrows. */
    stays?: boolean;
    canUp?: boolean;
    canDown?: boolean;
    /** The cards stand side by side: earlier and later, since "up" can be "left" there. */
    across?: boolean;
    onMove?: (direction: 'up' | 'down') => void;
    /** The band can be dragged (L3): the press that lifts it. Absent on a card that stays here. */
    drag?: { onPointerDown: (e: React.PointerEvent<HTMLElement>) => void };
    /** The card is in the air: a ring in its ink, over the others. */
    lifted?: boolean;
}

/** Holding a band this long enters Arrange, on touch or with a mouse. */
export const HOLD_MS = 500;
/** A finger that travels this far is scrolling, not holding. */
const HOLD_SLOP_PX = 10;

/** A press held on the band, never one that starts on a button or a link in it. */
function useHold(onHold?: () => void) {
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const from = useRef({ x: 0, y: 0 });
    const clear = () => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
    };
    useEffect(() => clear, []);
    if (!onHold) return undefined;
    return {
        onPointerDown: (e: React.PointerEvent) => {
            if (e.button !== 0 || (e.target as Element).closest?.('button, a')) return;
            clear();
            from.current = { x: e.clientX, y: e.clientY };
            timer.current = setTimeout(() => { timer.current = null; onHold(); }, HOLD_MS);
        },
        onPointerMove: (e: React.PointerEvent) => {
            if (Math.hypot(e.clientX - from.current.x, e.clientY - from.current.y) > HOLD_SLOP_PX) clear();
        },
        onPointerUp: clear,
        onPointerCancel: clear,
        onPointerLeave: clear,
    };
}

/**
 * A card's body while Arrange is open (DESIGN-home-arrange-in-place-fable.md §2.1): 55% opacity, and nothing in it takes
 * a tap, a key or a screen reader's attention until Done, so a stray tap can't open an event or a listing half way
 * through arranging. `pointer-events: none` and `aria-hidden` do it everywhere; the `inert` attribute, where the browser
 * has it, also takes its buttons and links out of Tab. It adds no box of its own: a drawn card keeps its height.
 */
export function QuietBody({ id, children }: { id: string; children: ReactNode }) {
    return (
        <div data-testid={`card-body-${id}`} data-quiet="true" aria-hidden="true" inert style={{ opacity: 0.55, pointerEvents: 'none' }}>
            {children}
        </div>
    );
}

/**
 * The band's two arrows, or "Stays here", in the card's ink. `-my-1` keeps a band 48 px tall, as it is with the "…": the
 * arrows are 44 px targets, and a band that grew by 4 px would move the cards under it (a drawn card never changes cell).
 */
export function ArrangeControls({ id, band, ink }: { id: string; band: ArrangeBand; ink?: string }) {
    // No ink (a card with no tinted band, "Your way back in"): the page's own text colour.
    const colour = ink ? { style: { color: ink } } : {};
    const own = ink ? '' : ' text-text-primary';
    if (band.stays) return <span data-testid={`home-arrange-stays-${id}`} className={`shrink-0 text-xs font-bold${own}`} {...colour}>{t(WORDS.stays)}</span>;
    const arrow = `shrink-0 min-w-[44px] min-h-[44px] -my-1 flex items-center justify-center rounded-full bg-transparent border-0 text-lg font-black cursor-pointer disabled:opacity-40 disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500${own}`;
    return (
        <>
            <button type="button" className={arrow} {...colour} data-testid={`home-arrange-up-${id}`} disabled={!band.canUp} onClick={() => band.onMove?.('up')}
                aria-label={band.across ? t('Move {card} earlier', { card: band.label }) : t('Move {card} up', { card: band.label })}>
                <span aria-hidden="true">↑</span>
            </button>
            <button type="button" className={arrow} {...colour} data-testid={`home-arrange-down-${id}`} disabled={!band.canDown} onClick={() => band.onMove?.('down')}
                aria-label={band.across ? t('Move {card} later', { card: band.label }) : t('Move {card} down', { card: band.label })}>
                <span aria-hidden="true">↓</span>
            </button>
        </>
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
    /** Reports measured height for web grid packing (DESIGN-home-layout-fable.md §3.1, slice L1). */
    onHeight?: (height: number) => void;
    /** Holding the band enters Arrange; absent where it doesn't (a visitor's Home, Getting started). */
    onHold?: () => void;
    /** In Arrange: the band's arrows (or Stays here) stand in for Tune and the "…"; the card is otherwise as it is drawn. */
    arrange?: ArrangeBand;
    /** In Arrange: the body goes quiet (dimmer, inert, hidden from a screen reader) until Done. */
    quiet?: boolean;
}

/** A packed child's height: its border box, whatever its span (it stands `align-self: start`). */
export const packedHeight = (el: HTMLElement) => el.offsetHeight || Math.round(el.getBoundingClientRect().height);

/**
 * Tells `onHeight` an element's height before the first paint and at every change after it. No `onHeight` (one column,
 * where nothing is packed) reads nothing; no ResizeObserver keeps today's grid.
 */
export function useReportHeight(ref: RefObject<HTMLElement | null>, onHeight?: (height: number) => void) {
    const report = useRef(onHeight);
    report.current = onHeight;
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const measure = () => { if (report.current) report.current(packedHeight(el)); };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [ref]);
}

/** A packed child that isn't a HomeCard (the "One way back" frame, Home's two notes), measured as a HomeCard is. */
export function PackedBlock({ tag: Tag = 'div', onHeight, ...rest }: { tag?: 'div' | 'p'; onHeight?: (height: number) => void; 'data-testid'?: string } & HTMLAttributes<HTMLElement>) {
    const ref = useRef<HTMLElement | null>(null);
    useReportHeight(ref, onHeight);
    return <Tag ref={ref as RefObject<never>} {...rest} />;
}

export function HomeCard({ id, title, titleAside, menu, accent, children, style, hue, onHeight, onHold, arrange, quiet }: CardProps) {
    const cardHue: CardHue = hue ?? (accent ? 'amber' : 'sage');
    const headingId = `home-card-${id}-title`;
    const sectionRef = useRef<HTMLElement | null>(null);
    const [width, setWidth] = useState(0);
    useReportHeight(sectionRef, onHeight);
    const hold = useHold(arrange ? undefined : onHold);

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
                style={{
                    containerType: 'inline-size', ...(accent ? { borderColor: 'var(--bp-card-amber-ink)' } : {}), ...style,
                    ...(arrange?.lifted ? { boxShadow: `0 0 0 2px var(--bp-card-${cardHue}-ink)`, zIndex: 10 } : {}),
                }}
                data-lifted={arrange?.lifted ? 'true' : undefined}
                className={`bg-bg-card rounded-2xl shadow-sm border p-4 mb-3 min-w-0 home-card-container ${accent ? '' : 'border-border-primary'}`}
            >
                <div
                    {...hold}
                    {...(arrange?.drag ? { onPointerDown: arrange.drag.onPointerDown } : {})}
                    data-testid={`card-band-${id}`}
                    className="-mx-4 -mt-4 px-4 mb-3 py-1 rounded-t-2xl flex items-center justify-between min-h-[48px] gap-2 min-w-0"
                    style={{
                        backgroundColor: `var(--bp-card-${cardHue}-tint)`,
                        color: `var(--bp-card-${cardHue}-ink)`,
                        // The hold is the band's own: no text selected or system menu under a thumb.
                        ...(hold ? { userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' } as React.CSSProperties : {}),
                        // A band that drags is the pointer's, in Arrange only: the page can't scroll from under a finger on it.
                        ...(arrange?.drag ? { touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', cursor: arrange.lifted ? 'grabbing' : 'grab' } as React.CSSProperties : {}),
                    }}
                >
                    {/* Focusable from the page (never by Tab): where focus goes when the card above it is hidden. */}
                    <h2 id={headingId} tabIndex={-1} className="m-0 break-words text-[0.7rem] font-extrabold uppercase tracking-wider" style={{ color: `var(--bp-card-${cardHue}-ink)` }}>
                        {title}
                    </h2>
                    <div className={`flex items-center justify-end gap-1 min-w-0 ${arrange ? 'shrink-0' : ''}`}>
                        {arrange ? <ArrangeControls id={id} band={arrange} ink={`var(--bp-card-${cardHue}-ink)`} /> : (
                            <>
                                {titleAside}
                                {menu && <CardMenu title={title} ink={`var(--bp-card-${cardHue}-ink)`} {...menu} />}
                            </>
                        )}
                    </div>
                </div>
                {quiet ? <QuietBody id={id}>{children}</QuietBody> : children}
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

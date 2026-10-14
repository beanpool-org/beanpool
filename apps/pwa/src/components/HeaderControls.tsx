import { useLayoutEffect, useState, type ReactNode } from 'react';
import { openHelp } from '../lib/tour-store';

/**
 * The pill's width: profile, the "?" and Settings, a third each. Kept at 100 px when the icons grew (14 Oct 2026): three
 * 44 px wide targets would cut "Commons" at 320 px with 130% text (it had 10 px to spare), and put the map tab's "BeanPool"
 * under the pill from 360 to 412 px wide (32 px of it at 360), where it cleared the pill before. The targets grew in height.
 */
export const HEADER_PILL_PX = 100;

/**
 * The mobile header's title: the tab's name in the middle of the room the row leaves between the sync chip and the pill
 * (the row's flexible middle, so the chip's real width counts: "● Online" is 82 px at 320 px with 130% text), never drawn
 * over either. Where the name wouldn't fit beside the chip's words the chip goes to its dot (useDotOnlyChip); only where
 * even that leaves too little room is the name cut, with an ellipsis. The padding is
 * room for the words' glow (text-rainbow's shadow; the cut clips at the padding box), given back by the margins so the
 * words sit where they always did. `children`: what opens under the title (the community's status).
 */
export function HeaderTitle({ title, onClick, children }: { title: string; onClick?: () => void; children?: ReactNode }) {
    return (
        <div className="relative z-10 flex-1 min-w-0 flex justify-center items-center" style={{ padding: '0 6px' }}>
            <span
                data-testid="header-title"
                className="font-extrabold text-[1.4rem] tracking-tight text-rainbow drop-shadow-[0_2px_4px_rgba(0,0,0,0.9)] pointer-events-auto text-center cursor-pointer truncate"
                style={{ margin: '-2px -6px -10px', padding: '10px 6px' }}
                onClick={onClick}
            >
                {title}
            </span>
            {children}
        </div>
    );
}

/**
 * Whether the header row's sync chip shows its dot alone: where the tab's title, whole, wouldn't fit between the chip with
 * its words and the pill (at 320 px with 130% text, "Commons" and "The Pulse" were cut to "Com…" and "The P…"). Measured
 * in the row as laid out, again whenever the row, the chip or the title changes size: the chip at its dot alone keeps its
 * words laid out but hidden (SyncChip), so the room the title would have beside them is known either way. The words come
 * back only with a pixel to spare, so the chip can't flick between the two at the edge. `title`: null where the row has
 * no HeaderTitle (the map's). Returns the ref for the header row (a callback, so a row that mounts after the first render,
 * as App's does after loading, is measured) and whether the chip is at its dot alone.
 */
export function useDotOnlyChip(title: string | null): [(row: HTMLElement | null) => void, boolean] {
    const [el, setRow] = useState<HTMLElement | null>(null);
    const [dotOnly, setDotOnly] = useState(false);
    useLayoutEffect(() => {
        if (!el || title === null || typeof ResizeObserver === 'undefined') {
            setDotOnly(false);
            return;
        }
        const chip = el.querySelector<HTMLElement>('[data-testid="sync-chip"]');
        const words = chip?.querySelector<HTMLElement>('[data-chip-words]');
        const span = el.querySelector<HTMLElement>('[data-testid="header-title"]');
        const box = span?.parentElement;
        if (!chip || !words || !span || !box) return;
        const measure = () => {
            if (!el.getBoundingClientRect().width) return; // hidden (the md: layout)
            const now = chip.dataset.dotOnly === 'true';
            const cs = getComputedStyle(span);
            const range = document.createRange();
            range.selectNodeContents(span);
            // The words' own width (the span itself is clamped to the room) and its padding (HeaderTitle's margins give it back).
            const need = range.getBoundingClientRect().width + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
            const room = box.getBoundingClientRect().width - (now ? words.getBoundingClientRect().width + (parseFloat(getComputedStyle(chip).columnGap) || 0) : 0);
            setDotOnly(now ? need > room - 1 : need > room + 0.01);
        };
        measure();
        // A frame later, not inside the observer: the chip's own change of size would loop it.
        let frame = 0;
        const observer = new ResizeObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(measure);
        });
        for (const e of [el, chip, words, span]) observer.observe(e);
        let live = true;
        document.fonts?.ready.then(() => live && measure());
        return () => {
            live = false;
            observer.disconnect();
            cancelAnimationFrame(frame);
        };
    }, [el, title]);
    return [setRow, dotOnly];
}

/** The "?" (DESIGN-getting-started-fable.md §4–§5): help for the screen you're on, in the pill and the sidebar. */
export function HelpIcon({ className, strokeWidth = 1.5 }: { className: string; strokeWidth?: number }) {
    return (
        <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={strokeWidth} stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z" />
        </svg>
    );
}

/**
 * Each control in the pill: a 24 px icon in a target 44 px tall (it overhangs the 38 px pill by 3 px above and below, so the
 * header keeps its height) and a third of the pill wide (33 px). Gold (Marty, 14 Oct 2026: "maybe gold", over the header photo),
 * the library's gold fill, as the phone's selected Settings icon; lighter (the gold's own hover) under the pointer.
 */
const PILL_BUTTON = 'flex-1 min-w-0 h-[44px] -my-[4px] p-0 border-0 bg-transparent cursor-pointer flex items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-gold-fill';
const PILL_ICON = 'w-[24px] h-[24px] shrink-0';

/**
 * The mobile header's pill: your profile, the "?" and Settings (its own file so its fit at 320 px can be measured alone).
 * Charcoal in both themes, the gold pair's own words colour, so the gold icons on it are the library's gold pair the other
 * way round (7.5:1) whatever the photo is under it. Above the header's dimming layer (in dark it is black at 50%, and the
 * pill sat under it, dimmed with the photo), still under the map tab's logo where they meet. Settings open: a gold disc with a charcoal icon in it (the pair as the
 * library draws it), so the open state is a filled shape and not a change of colour alone.
 */
export function HeaderControls({ showSettings, setShowSettings, identityPubkey, onOpenProfile }: { showSettings: boolean, setShowSettings: (v: boolean) => void, identityPubkey?: string, onOpenProfile: (pk: string) => void }) {
    return (
        <div data-testid="header-pill" className="relative z-[5] bg-bp-gold-on" style={{
            display: 'flex',
            alignItems: 'center',
            borderRadius: '9999px',
            border: '1px solid var(--border-secondary)',
            height: '38px',
            width: `${HEADER_PILL_PX}px`,
            flexShrink: 0,
            justifyContent: 'center',
        }}>
            <button
                onClick={() => identityPubkey && onOpenProfile(identityPubkey)}
                aria-label="My profile"
                title="My profile"
                data-testid="header-profile"
                className={`${PILL_BUTTON} text-bp-gold-fill hover:text-bp-gold-hover`}
            >
                <svg className={PILL_ICON} fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17.982 18.725A7.488 7.488 0 0 0 12 15.75a7.488 7.488 0 0 0-5.982 2.975m11.963 0a9 9 0 1 0-11.963 0m11.963 0A8.966 8.966 0 0 1 12 21a8.966 8.966 0 0 1-5.982-2.275M15 9.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                </svg>
            </button>

            <button
                onClick={openHelp}
                aria-label="Help for this screen"
                title="Help for this screen"
                data-testid="header-help"
                className={`${PILL_BUTTON} text-bp-gold-fill hover:text-bp-gold-hover`}
            >
                <HelpIcon className={PILL_ICON} strokeWidth={1.75} />
            </button>

            <button
                onClick={() => setShowSettings(!showSettings)}
                aria-label="Settings"
                aria-pressed={showSettings}
                title="Settings"
                data-testid="header-settings"
                className={`${PILL_BUTTON} group ${showSettings ? 'text-bp-gold-on' : 'text-bp-gold-fill hover:text-bp-gold-hover'}`}
            >
                <span className={`w-[30px] h-[30px] rounded-full flex items-center justify-center shrink-0 ${showSettings ? 'bg-bp-gold-fill group-hover:bg-bp-gold-hover text-bp-gold-on' : ''}`}>
                    <svg className={PILL_ICON} fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
                    </svg>
                </span>
            </button>
        </div>
    );
}

/**
 * The sidebar's "?" and Settings (wide screens, beside the sync status), gold as the pill's: on the sidebar's own pale or
 * dark ground that is the library's gold for icons on a page (ink.warning: amber-800 in light, where the gold fill is only
 * 2.1:1 on the pale sidebar; amber-400 in dark). 24 px icons in 44 px targets. Settings open: the gold disc with a charcoal
 * icon, as the pill's.
 */
export function SidebarControls({ showSettings, setShowSettings }: { showSettings: boolean; setShowSettings: (v: boolean) => void }) {
    return (
        <>
            <button
                onClick={openHelp}
                aria-label="Help for this screen"
                title="Help for this screen"
                data-testid="sidebar-help"
                className="ml-auto min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg transition-colors cursor-pointer text-bp-ink-warning hover:bg-nature-200/60 dark:hover:bg-nature-800/60"
            >
                <HelpIcon className="w-6 h-6" strokeWidth={1.75} />
            </button>
            <button
                onClick={() => setShowSettings(!showSettings)}
                aria-label="Settings"
                aria-pressed={showSettings}
                title="Settings"
                data-testid="sidebar-settings"
                className={`min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg transition-colors cursor-pointer ${
                    showSettings ? 'bg-bp-gold-fill hover:bg-bp-gold-hover text-bp-gold-on' : 'text-bp-ink-warning hover:bg-nature-200/60 dark:hover:bg-nature-800/60'
                }`}
            >
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.281Z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                </svg>
            </button>
        </>
    );
}

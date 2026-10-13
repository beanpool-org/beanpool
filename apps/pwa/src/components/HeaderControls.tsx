import { useLayoutEffect, useState, type ReactNode } from 'react';
import { openHelp } from '../lib/tour-store';

/** The pill's width: profile, the "?" and Settings (72 px before the "?"). */
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
export function HelpIcon({ className }: { className: string }) {
    return (
        <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z" />
        </svg>
    );
}

/** The mobile header's pill: your profile, the "?" and Settings (its own file so its fit at 320 px can be measured alone). */
export function HeaderControls({ showSettings, setShowSettings, identityPubkey, onOpenProfile }: { showSettings: boolean, setShowSettings: (v: boolean) => void, identityPubkey?: string, onOpenProfile: (pk: string) => void }) {
    return (
        <div data-testid="header-pill" style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            padding: '0.3rem 0.6rem',
            borderRadius: '9999px',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-secondary)',
            height: '26px', // Geometric balance with SyncStatus
            width: `${HEADER_PILL_PX}px`,
            flexShrink: 0,
            justifyContent: 'center',
        }}>
            <button
                onClick={() => identityPubkey && onOpenProfile(identityPubkey)}
                aria-label="My profile"
                title="My profile"
                className="text-nature-600 dark:text-nature-400 hover:text-nature-900 dark:hover:text-nature-200 transition-colors flex items-center justify-center p-0"
            >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17.982 18.725A7.488 7.488 0 0 0 12 15.75a7.488 7.488 0 0 0-5.982 2.975m11.963 0a9 9 0 1 0-11.963 0m11.963 0A8.966 8.966 0 0 1 12 21a8.966 8.966 0 0 1-5.982-2.275M15 9.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                </svg>
            </button>

            <div className="w-[1px] h-[12px] bg-nature-200 dark:bg-nature-700 mx-[1px]" />

            <button
                onClick={openHelp}
                aria-label="Help for this screen"
                title="Help for this screen"
                data-testid="header-help"
                className="text-nature-600 dark:text-nature-400 hover:text-nature-900 dark:hover:text-nature-200 transition-colors flex items-center justify-center p-0"
            >
                <HelpIcon className="w-4 h-4" />
            </button>

            <div className="w-[1px] h-[12px] bg-nature-200 dark:bg-nature-700 mx-[1px]" />

            <button
                onClick={() => setShowSettings(!showSettings)}
                aria-label="Settings"
                aria-pressed={showSettings}
                title="Settings"
                className={`flex items-center justify-center transition-colors p-0 ${
                    showSettings 
                        ? 'text-accent dark:text-accent' 
                        : 'text-nature-600 dark:text-nature-400 hover:text-nature-900 dark:hover:text-nature-200'
                }`}
            >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
                </svg>
            </button>
        </div>
    );
}

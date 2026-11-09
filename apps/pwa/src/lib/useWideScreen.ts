import { useEffect, useState } from 'react';

/**
 * The width from which the side bar shows: Tailwind's `md:` (768 px), the query App's `hidden md:flex` side bar and its
 * `md:hidden` bottom bar answer to. Below it, a phone-sized window; at it and above, a computer's.
 */
export const WIDE_QUERY = '(min-width: 768px)';

const matches = (mql: MediaQueryList | undefined | null) => !!mql?.matches;

function readWide(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return matches(window.matchMedia(WIDE_QUERY));
}

/**
 * Whether this window is wide enough for the side bar (768 px and up), kept current as the window is resized across the
 * line. Read before the first paint, so the first frame is already the right one. Where the browser has no media query to
 * ask there is no answer but "not wide": the phone's layout, which is the one that never leaves a screen without its
 * controls.
 *
 * For what a CSS class can't be trusted with: App's mobile header says `md:hidden` and carries its own inline
 * `display: flex`, which wins, so the header (and the pill in it) drew beside the side bar for months. A control that must
 * be drawn in one place per width asks this instead, and is then absent from the page, not hidden by a rule that can lose.
 */
export function useWideScreen(): boolean {
    const [wide, setWide] = useState(readWide);
    useEffect(() => {
        if (typeof window.matchMedia !== 'function') return;
        const mql = window.matchMedia(WIDE_QUERY);
        const update = () => setWide(matches(mql));
        update();
        mql?.addEventListener?.('change', update);
        return () => mql?.removeEventListener?.('change', update);
    }, []);
    return wide;
}

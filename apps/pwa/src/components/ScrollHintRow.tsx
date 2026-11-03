import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/** How much of the row must lie past the right edge before the hint shows (a pixel or two of rounding is not "more"). */
const SLACK_PX = 4;
const FADE_PX = 32;
const FADE_MASK = `linear-gradient(to right, #000 calc(100% - ${FADE_PX}px), transparent)`;

interface ScrollHintRowProps {
    children: ReactNode;
    /** The scrolling row's own test id (and the one callers and tests measure). */
    testId: string;
    className?: string;
    role?: string;
    'aria-label'?: string;
}

/**
 * A row of chips that scrolls sideways, and says so: while chips lie past its right edge the edge fades and a › shows
 * (the phone's FilterChipBar `moreHint`, apps/native/components/FilterChipRow.tsx), so a chip clipped at the edge reads as
 * "scroll for more" and not as the end of the row. The hint goes when the row is scrolled to its end, and is never there
 * when the row fits. Every chip stays reachable by scroll, touch and keyboard (focus scrolls a chip into view): the
 * hint is drawn over the row and takes no taps.
 */
export function ScrollHintRow({ children, testId, className = '', role, 'aria-label': ariaLabel }: ScrollHintRowProps) {
    const scroller = useRef<HTMLDivElement>(null);
    const [more, setMore] = useState(false);

    const measure = () => {
        const el = scroller.current;
        if (!el) return;
        setMore(el.scrollWidth - el.scrollLeft - el.clientWidth > SLACK_PX);
    };

    // After every render (a chip appears, a label changes language), and whenever the row's own box changes (the screen
    // turns, the text is made larger). setMore with the same value does nothing.
    useLayoutEffect(measure);
    useLayoutEffect(() => {
        const el = scroller.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const watch = new ResizeObserver(measure);
        watch.observe(el);
        for (const child of Array.from(el.children)) watch.observe(child);
        return () => watch.disconnect();
    }, []);

    const fade: CSSProperties | undefined = more ? { WebkitMaskImage: FADE_MASK, maskImage: FADE_MASK } : undefined;

    return (
        <div className="relative pointer-events-auto max-w-full min-w-0">
            <div
                ref={scroller}
                data-testid={testId}
                role={role}
                aria-label={ariaLabel}
                onScroll={measure}
                className={className}
                style={{ scrollbarWidth: 'none', ...fade }}
            >
                {children}
            </div>
            {more && (
                <span
                    data-testid="map-more-hint"
                    aria-hidden="true"
                    className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full flex items-center justify-center bg-white/95 dark:bg-nature-900/95 border border-nature-200 dark:border-nature-700 shadow-md text-xl leading-none font-extrabold text-nature-700 dark:text-oat-100"
                >
                    ›
                </span>
            )}
        </div>
    );
}

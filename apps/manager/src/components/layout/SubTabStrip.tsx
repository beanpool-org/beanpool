import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/**
 * The row of sub-tab buttons under a Settings section's title.
 *
 * From `lg` up it is exactly the row it always was. Below that (phones, and a tablet without the sidebar) it is one
 * line that scrolls sideways inside itself, never the page, and the current sub-tab is scrolled into view, so a
 * hand-off link to the fourth tab (e.g. Escrow Disputes) does not land on a tab the owner cannot see.
 */
export function SubTabStrip({ wrap, children }: { wrap: boolean; children: React.ReactNode }) {
    const ref = useRef<HTMLDivElement>(null);
    const last = useRef<{ active: Element | null; width: number }>({ active: null, width: 0 });

    const align = useCallback(() => {
        const strip = ref.current;
        const active = strip?.querySelector('[aria-current="page"]') ?? null;
        if (!strip || !active) return;
        // Only when the current tab changes, or the labels change width (a count arriving): not on every render,
        // which would snap the strip back while the owner is scrolling it.
        if (active === last.current.active && strip.scrollWidth === last.current.width) return;
        last.current = { active, width: strip.scrollWidth };
        if (strip.scrollWidth <= strip.clientWidth) return;
        // Move the strip only: scrollIntoView would scroll the page too.
        const s = strip.getBoundingClientRect();
        const a = active.getBoundingClientRect();
        if (a.left < s.left || a.right > s.right) {
            strip.scrollLeft += a.left - s.left - 16;
        }
    }, []);

    useLayoutEffect(align);

    /**
     * A render is not the only thing that moves these buttons, and the effect above only sees renders.
     *
     * The strip is laid out again when the web font finally applies, when a label gains a count
     * (`Escrow Disputes (3)`), and when the phone's text size changes — none of which is a React render. Measured
     * on #1063 at 320px: a hand-off link to Proposals left the strip unscrolled because the tab genuinely fitted
     * in the fallback font; the real font then landed, widened every label, and pushed the active tab 33px past
     * the strip's right edge, where it stayed, because nothing rendered again to notice. It only ever passed
     * before by luck — the polling this PR removed happened to deliver one more render after the font had
     * settled, and the first thing to make the renders land earlier uncovered it.
     *
     * A ResizeObserver fires on the re-layout itself, which is the event that actually matters. It cannot fight
     * an owner scrolling the strip by hand: the guard above makes a fire with unchanged metrics a no-op, and
     * setting `scrollLeft` resizes nothing, so this cannot feed itself.
     */
    useEffect(() => {
        const strip = ref.current;
        if (!strip || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(() => align());
        ro.observe(strip);
        // The buttons too: the strip itself is `max-w-full`, so a font that widens every label changes the
        // children's boxes and leaves the strip's own box exactly as it was.
        for (const child of Array.from(strip.children)) ro.observe(child);
        return () => ro.disconnect();
    });

    return (
        <div
            ref={ref}
            className={`flex flex-nowrap ${wrap ? 'lg:flex-wrap' : ''} items-center gap-1.5 bg-nature-950 p-1.5 rounded-xl border border-nature-800 max-w-full overflow-x-auto lg:overflow-visible self-stretch lg:self-auto`}
        >
            {children}
        </div>
    );
}

import React, { useLayoutEffect, useRef } from 'react';

/**
 * The row of sub-tab buttons under a Settings section's title.
 *
 * From `lg` up it is exactly the row it always was. Below that (phones, and a tablet without the sidebar) it is one
 * line that scrolls sideways inside itself, never the page, and the current sub-tab is scrolled into view, so a
 * hand-off link to the fourth tab (e.g. Escrow Disputes) does not land on a tab the owner cannot see.
 */
export function SubTabStrip({ wrap, children }: { wrap: boolean; children: React.ReactNode }) {
    const ref = useRef<HTMLDivElement>(null);
    const lastActive = useRef<Element | null>(null);

    useLayoutEffect(() => {
        const strip = ref.current;
        const active = strip?.querySelector('[aria-current="page"]') ?? null;
        if (!strip || !active || active === lastActive.current) return;
        lastActive.current = active;
        if (strip.scrollWidth <= strip.clientWidth) return;
        // Move the strip only: scrollIntoView would scroll the page too.
        const s = strip.getBoundingClientRect();
        const a = active.getBoundingClientRect();
        if (a.left < s.left || a.right > s.right) {
            strip.scrollLeft += a.left - s.left - 16;
        }
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

/**
 * How far down a scroll view has to be scrolled for a box in it to end `gap` above the bottom of what is seen; 0 when it
 * already does at the top, or nothing is measured yet. A box taller than the view is shown from its top.
 */
export function offsetToShow(box: { top: number; height: number; view: number }, gap: number): number {
    const { top, height, view } = box;
    if (!(view > 0) || !(height > 0)) return 0;
    return Math.max(0, Math.min(top + height + gap - view, top));
}

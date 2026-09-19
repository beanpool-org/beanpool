/**
 * Quick return: a list's search and filter controls get out of the way while you browse down, and come
 * back on any upward scroll, wherever you are in the list. No React Native imports, so vitest can hold
 * the decisions to the design; components/QuickReturn.tsx drives the animation from them.
 *
 * The controls block (the page title, then the controls) sits over the top of the list. Its position is
 *
 *     translateY = -clamp(y, 0, T + H)  +  clamp(y - T, 0, H) × reveal
 *
 * where T is the title's height, H the controls' height and `reveal` runs 0..1 on the native driver:
 * - reveal 0: the whole block scrolls with the page, one-for-one, and is gone once the list has moved
 *   T + H — "scrolls away with the page title".
 * - reveal 1: the title scrolls away but the controls stay pinned at the top.
 * At the top of the list (y ≤ T) both give the same place, so the controls are always shown there.
 *
 * Only `revealed` is decided here, from the direction of travel. A move counts once it has gone
 * QUICK_RETURN_THRESHOLD dp the same way, so finger jitter and fling tails do not flicker the block.
 */

/** dp of travel in one direction before the controls hide (down) or come back (up). */
export const QUICK_RETURN_THRESHOLD = 10;

export interface QuickReturnState {
    /** Controls pinned at the top (reveal 1) rather than riding with the page (reveal 0). */
    revealed: boolean;
    /** Where the current run of travel in one direction began. */
    anchorY: number;
    lastY: number;
    /** 1 down, -1 up, 0 not moving yet. */
    dir: 1 | -1 | 0;
}

export const INITIAL_QUICK_RETURN: QuickReturnState = { revealed: false, anchorY: 0, lastY: 0, dir: 0 };

export interface QuickReturnInput {
    /** contentOffset.y */
    y: number;
    /** The furthest the list can scroll (content height − viewport height). iOS bounces past it. */
    maxY?: number;
    threshold?: number;
    /**
     * The controls must stay put: a screen reader is on, or the page is using them (a panel is open,
     * the search field has focus). Fixed means pinned, never hidden.
     */
    fixed?: boolean;
}

export function quickReturnStep(s: QuickReturnState, { y, maxY, threshold = QUICK_RETURN_THRESHOLD, fixed = false }: QuickReturnInput): QuickReturnState {
    // Overscroll past either end (iOS rubber-banding, the pull-to-refresh stretch) is not travel: the
    // bounce back from the bottom would otherwise read as an upward scroll.
    const cy = Math.max(0, maxY !== undefined && maxY > 0 ? Math.min(y, maxY) : y);
    if (fixed) return { revealed: true, anchorY: cy, lastY: cy, dir: 0 };
    // At the top the block is fully shown whatever `revealed` says; riding with the page from here is what
    // makes the first scroll down carry the controls away with the title.
    if (cy <= 0) return INITIAL_QUICK_RETURN;
    const dy = cy - s.lastY;
    if (dy === 0) return s;
    const dir: 1 | -1 = dy > 0 ? 1 : -1;
    const anchorY = dir === s.dir ? s.anchorY : s.lastY;
    const travel = cy - anchorY;
    let revealed = s.revealed;
    if (travel >= threshold) revealed = false;
    else if (travel <= -threshold) revealed = true;
    return { revealed, anchorY, lastY: cy, dir };
}

/**
 * Whether the controls are fully off screen — the moment a page may show its pinned "what's filtered"
 * chip instead. `blockHeight` is T + H.
 */
export function quickReturnControlsHidden(s: QuickReturnState, blockHeight: number): boolean {
    return !s.revealed && blockHeight > 0 && s.lastY >= blockHeight;
}

/** The block's offset for a scroll position and reveal amount (the formula above; the native driver runs the same). */
export function quickReturnOffset(y: number, reveal: number, titleH: number, controlsH: number): number {
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    return -clamp(y, 0, titleH + controlsH) + clamp(y - titleH, 0, controlsH) * reveal;
}

/**
 * Where the list starts. Normally the block rides OVER the list, so the list leaves `blockHeight` of
 * padding at its top and scrolls under the block. With a screen reader on the controls never hide, and
 * rows scrolled under them could take focus while out of sight — so the block is docked above the list
 * instead (in the layout, not over it) and the list needs no inset: nothing is ever under the controls.
 */
export function quickReturnListInset(blockHeight: number, docked: boolean): number {
    return docked ? 0 : blockHeight;
}

/**
 * The active-filter chip (components/QuickReturn.tsx ActiveFilterChip). Each tap target is 48dp even
 * though the pill drawn inside it is 36dp: hitSlop outside the parent's bounds never reaches the child
 * on Android, so the target itself must be the size. ✕ sits `gap` apart from the label, so a thumb
 * aimed at "show the filters" does not clear them all.
 */
export const ACTIVE_FILTER_CHIP = {
    target: 48,
    pill: 36,
    clearWidth: 48,
    gap: 8,
} as const;

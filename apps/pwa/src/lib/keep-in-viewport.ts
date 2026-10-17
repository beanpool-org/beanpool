/**
 * Where a box that hangs from an anchor's left edge (SyncStatus' sentence under the chip) goes so it stays on the screen.
 * It keeps to the anchor's left edge while it fits; near the right edge it moves left until its right side is a gutter
 * from the screen's edge, and it never goes past the left edge either. Pure (numbers in px, as getBoundingClientRect gives
 * them), so the placement is tested without a layout engine.
 */
export interface HangingBox {
    /** The anchor's left edge, from the viewport's left. */
    anchorLeft: number;
    /** The box's width. */
    width: number;
    /** The viewport's width (without a scrollbar). */
    viewportWidth: number;
    /** The room to keep from each edge of the screen when the box has to move. */
    gutter: number;
}

/** How far to move the box from the anchor's left edge: 0 when it fits there, negative to move it left. */
export function shiftIntoViewport({ anchorLeft, width, viewportWidth, gutter }: HangingBox): number {
    // Not laid out (or nothing measured): leave it where it hangs.
    if (!(viewportWidth > 0) || !(width > 0)) return 0;
    const left = Math.max(
        Math.min(anchorLeft, viewportWidth - gutter - width), // never past the right gutter...
        Math.min(anchorLeft, gutter), // ...nor further left than the left gutter (or than the anchor, if it is closer)
        0, // and never off the left edge
    );
    return left - anchorLeft;
}

/**
 * Where to scroll a sheet's ScrollView so the field being typed in is fully above the keyboard (components/
 * useScrollFieldIntoView has the story). Pure, so it is unit tested.
 *
 * All numbers are in the ScrollView's content coordinates, except `viewportHeight`, which is what the ScrollView shows
 * (its own height, after the keyboard has taken its share). Returns the new scroll offset, or null when the field is
 * already in view and nothing should move.
 */

export function scrollTargetForField(args: {
    fieldTop: number;
    fieldBottom: number;
    scrollY: number;
    viewportHeight: number;
    /** Clear space to leave between the field's edge and the edge of the view. */
    margin?: number;
    /** The content's total height, so the target never runs past the end. Unknown: not clamped at the end. */
    contentHeight?: number;
}): number | null {
    const { fieldTop, fieldBottom, scrollY, viewportHeight, margin = 16, contentHeight } = args;
    if (!(viewportHeight > 0)) return null;
    const maxY = contentHeight !== undefined ? Math.max(0, contentHeight - viewportHeight) : Infinity;
    const clamp = (y: number) => Math.round(Math.min(maxY, Math.max(0, y)));

    const fieldHeight = fieldBottom - fieldTop;
    // A field taller than the view (a long note): what is being typed is at its end, so keep the end in view.
    const tooTall = fieldHeight + 2 * margin > viewportHeight;

    let target = scrollY;
    if (tooTall) {
        target = fieldBottom + margin - viewportHeight;
    } else if (fieldBottom + margin > scrollY + viewportHeight) {
        target = fieldBottom + margin - viewportHeight;
    } else if (fieldTop - margin < scrollY) {
        target = fieldTop - margin;
    }
    const next = clamp(target);
    return Math.abs(next - scrollY) < 1 ? null : next;
}

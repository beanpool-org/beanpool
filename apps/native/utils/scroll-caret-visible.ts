/**
 * Where to scroll a form so the field being typed in (and, in a growing multiline field, the caret) is in view.
 * Pure, so it is unit tested; components/useKeepCaretVisible.ts feeds it from the screen.
 *
 * All numbers are in the scroll view's own content coordinates, so none of them depend on where the keyboard is:
 * the sheets lift themselves above the keyboard (a keyboard-controller KeyboardAvoidingView), which shrinks the
 * scroll view's viewport, and "inside the viewport" is then the same as "above the keyboard".
 */

export type CaretVisibleArgs = {
    /** The scroll view's current offset. */
    scrollY: number;
    /** The scroll view's visible height (what is left above the keyboard). */
    viewportHeight: number;
    /** The scrollable content's total height. */
    contentHeight: number;
    /** Top of the focused field, in content coordinates. */
    fieldTop: number;
    fieldHeight: number;
    /** Where the caret's line ends, measured from the top of the field. Unknown (null) on first focus. */
    caretBottomInField: number | null;
    /** The height of one line of text. */
    lineHeight: number;
    /** Air to leave between the caret and the viewport's edge. */
    gap: number;
};

/** The new offset to scroll to, or null when what the member is typing is already in view. */
export function scrollTargetForCaret(a: CaretVisibleArgs): number | null {
    if (a.viewportHeight <= 0 || a.fieldHeight <= 0) return null;
    const gap = Math.min(a.gap, a.viewportHeight / 4);

    const room = a.viewportHeight - 2 * gap;

    // A field that fits the viewport is kept whole in view (so its caret is too). One taller than that (a long
    // Description) keeps the caret's line in view, because the member is typing at the caret, not at the top; with
    // no caret known yet it shows the field's start.
    let top = a.fieldTop;
    let bottom = a.fieldTop + a.fieldHeight;
    if (a.fieldHeight > room) {
        if (a.caretBottomInField != null) {
            const caretBottom = Math.min(Math.max(a.caretBottomInField, 0), a.fieldHeight);
            bottom = a.fieldTop + caretBottom;
            top = Math.max(a.fieldTop, bottom - a.lineHeight);
        } else {
            bottom = top + Math.min(a.lineHeight, a.fieldHeight);
        }
    }

    const maxY = Math.max(0, a.contentHeight - a.viewportHeight);
    const visibleTop = a.scrollY + gap;
    const visibleBottom = a.scrollY + a.viewportHeight - gap;

    let target: number | null = null;
    if (bottom > visibleBottom) target = bottom + gap - a.viewportHeight;
    else if (top < visibleTop) target = top - gap;
    if (target == null) return null;
    target = Math.min(Math.max(target, 0), maxY);
    return Math.abs(target - a.scrollY) < 1 ? null : target;
}

/**
 * Is this the focused input of THIS scroll view, and (when an event is being judged) is the event about that input?
 *
 * The hook sees every focused input in the app, including one in a Modal that a form renders inside its own
 * ScrollView (the TagPicker's search box). measureLayout on that field answers in the modal's own coordinates, so
 * acting on it scrolls the form behind the modal. react-native-keyboard-controller's own KeyboardAwareScrollView
 * guards the same way: the input's parentScrollViewTarget must be this scroll view's native handle.
 *
 * `scrollHandle` is findNodeHandle(scrollRef.current), or -1/0 before the scroll view has been laid out (then
 * nothing is "in" it). `eventTarget` is the `target` of a caret/selection event; omit it to judge the input alone.
 * Runs inside worklets, hence the directive.
 */
export function inputIsInScroll(
    input: { target: number; parentScrollViewTarget: number } | null | undefined,
    scrollHandle: number,
    eventTarget?: number,
): boolean {
    'worklet';
    if (!input || scrollHandle <= 0) return false;
    if (input.parentScrollViewTarget !== scrollHandle) return false;
    return eventTarget === undefined || eventTarget === input.target;
}

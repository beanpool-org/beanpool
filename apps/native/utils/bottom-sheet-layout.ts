/**
 * A bottom sheet's height and its footer's padding (components/AvatarPickerSheet.tsx).
 *
 * The rehearsal of 5 Oct (d1) found "Use Selected Avatar" at the very bottom edge of a 320 dp phone at 130% text, its
 * label cut: the sheet's body was a plain View under a height cap, so taller text pushed the button past the cap and
 * over the navigation bar. The body now scrolls and the button sits in a footer outside it; these numbers keep that
 * footer above the system bars and the sheet below the status bar.
 */
export interface SheetInsets { top: number; bottom: number }

/** Never more than this share of the window, so the dimmed backdrop above still reads as "tap to close". */
export const SHEET_MAX_SHARE = 0.85;
/** Space kept between the sheet's top and the status bar. */
export const SHEET_TOP_GAP = 16;
/** Space under the footer's button, on top of the bottom inset (gesture bar or buttons). */
export const SHEET_FOOTER_GAP = 16;

export function bottomSheetLayout(windowHeight: number, insets: SheetInsets): { maxHeight: number; footerPaddingBottom: number } {
    const top = Math.max(0, insets.top || 0);
    const bottom = Math.max(0, insets.bottom || 0);
    const h = Math.max(0, windowHeight || 0);
    return {
        maxHeight: Math.max(0, Math.min(h * SHEET_MAX_SHARE, h - top - SHEET_TOP_GAP)),
        footerPaddingBottom: bottom + SHEET_FOOTER_GAP,
    };
}

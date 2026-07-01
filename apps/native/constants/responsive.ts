/**
 * Responsive layout constants.
 *
 * Beanpool targets low-end / small Android devices (down to ~320dp wide) in
 * developing markets, where users frequently run enlarged system fonts. Layouts
 * must hold up at 320dp width AND with large font scales — the combination is
 * what breaks rows (clipped buttons, wrapped tab labels, jumbled cards).
 *
 * MAX_FONT_SCALE caps how much OS-level font scaling can enlarge text. It is
 * applied globally via Text/TextInput defaultProps in app/_layout.tsx, so every
 * screen inherits it. Components in fixed-size containers (e.g. map pins) may
 * pass a tighter local maxFontSizeMultiplier to override this default.
 */

// Global ceiling on OS font scaling. 1.2 still honours accessibility intent
// (text gets noticeably larger) without letting a 1.5x+ setting shatter rows.
export const MAX_FONT_SCALE = 1.2;

// Map pins / cluster badges live in fixed-geometry containers and cannot grow,
// so they cap tighter — emoji/number stays inside its circle.
export const PIN_FONT_SCALE = 1.0;

// Consistent spacing scale, so screens stop hardcoding bare pixel values.
export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
} as const;

// Smallest logical width we design for.
export const MIN_SCREEN_WIDTH = 320;

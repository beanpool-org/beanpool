/**
 * The tool's phone screens. The host route draws the frame around each (the header, the "…" menu, the backup line) and,
 * while the document is empty, the two doors; a screen draws the rest with the host's primitives (../ui, slice T0.2)
 * and reaches the app only through `host`. Every sentence through t() from @beanpool/core.
 */
import type { ScaffoldScreenProps } from '@beanpool/core';

/** The tool's first screen. Draws nothing until the template's primitives land (T0.2). */
export function Main(_props: ScaffoldScreenProps) {
    return null;
}

export const SCREENS = { main: Main };

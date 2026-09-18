/** One chip in a single-select filter row (components/FilterChipRow) or panel (components/FilterChipPicker). */
export interface FilterChip<Id extends string = string> {
    id: Id;
    label: string;
    emoji?: string;
}

/**
 * How many tiles per row in a FilterChipPicker panel. Four at normal width; fewer when four would make a
 * tile narrower than its longest one-line label needs at the phone's text size. The base is measured on the emulator: at
 * 1.0x text the longest single-word labels (Education, Transport) need ~70dp of tile including padding,
 * and they scale with the text. "All Categories" is allowed to wrap to two lines, so it does not set the
 * width. Never below 2: the panel then wraps onto more rows, it never scrolls sideways.
 */
export const TILE_BASE_MIN_WIDTH = 72;
export const TILE_GAP = 4;

export function tilePanelColumns(panelInnerWidthDp: number, fontScale: number): number {
    const minTile = TILE_BASE_MIN_WIDTH * Math.max(1, fontScale);
    for (let cols = 4; cols > 2; cols--) {
        const tile = (panelInnerWidthDp - TILE_GAP * (cols - 1)) / cols;
        if (tile >= minTile) return cols;
    }
    return 2;
}

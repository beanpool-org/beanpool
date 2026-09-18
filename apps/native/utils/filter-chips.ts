/** One chip in a single-select filter row (components/FilterChipRow) or panel (components/FilterChipPicker). */
export interface FilterChip<Id extends string = string> {
    id: Id;
    label: string;
    emoji?: string;
}

/**
 * How many tiles per row in a FilterChipPicker panel. Four at normal width; fewer when four would make a
 * tile narrower than its longest one-word label needs at the phone's text size. Measured on the emulator:
 * Education and Transport are the widest, 54dp at 12sp and 1.0x text, so ~50dp at the tile's 11sp; with
 * the tile's 2dp side padding, 54dp, scaled by the text size. (Measured text grows a little less than the
 * scale — 64dp at 12sp and 1.3x — so this errs roomy.) "All Categories" wraps to two lines, so it does
 * not set the width. Never below 2: the panel wraps onto more rows, it never scrolls sideways.
 *
 * On a 320dp phone the panel is 304dp (8dp margins), 296dp inside: four tiles of 71dp against 70dp
 * needed at 1.3x, so the 18 categories take five rows and fit above the bottom of the map.
 */
export const TILE_BASE_MIN_WIDTH = 54;
export const TILE_GAP = 4;
export const TILE_PANEL_PADDING = 4;

export function tilePanelColumns(panelInnerWidthDp: number, fontScale: number): number {
    const minTile = TILE_BASE_MIN_WIDTH * Math.max(1, fontScale);
    for (let cols = 4; cols > 2; cols--) {
        const tile = (panelInnerWidthDp - TILE_GAP * (cols - 1)) / cols;
        if (tile >= minTile) return cols;
    }
    return 2;
}

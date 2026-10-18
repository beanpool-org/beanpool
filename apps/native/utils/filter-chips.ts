import type { WordKey } from '@beanpool/core';

/**
 * One chip in a single-select filter row (components/FilterChipRow) or panel (components/FilterChipPicker). The label is
 * a word() key: the row and the panel show it through t(), in the member's language.
 */
export interface FilterChip<Id extends string = string> {
    id: Id;
    label: WordKey;
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
 *
 * In another language a label's longest word can be longer than English's (fil "Transportasyon", the
 * pseudo-locale's "[Éđūçāţîöñ~~~~]"), and a word never breaks across the tile's two lines: `longestWord`
 * (longestWordLength of the labels as shown) widens the tile to hold it, at ~5dp a letter at 11sp and 1.0x
 * (Education's measured 64dp at 12sp and 1.3x over its 9 letters), so the panel takes fewer columns rather
 * than cut a word. English's longest, "Categories" (10 letters, narrow ones), stays inside the 54dp floor.
 */
export const TILE_BASE_MIN_WIDTH = 54;
export const TILE_GAP = 4;
export const TILE_PANEL_PADDING = 4;
/** One letter of a tile's label at 11sp and 1.0x text: 64dp for Education's 9 letters at 12sp and 1.3x, so ~5dp. */
export const TILE_LETTER_DP = 5;
const TILE_SIDE_PADDING = 2;

/** The longest word of these labels, in characters (a space or a zero-width space ends a word). */
export function longestWordLength(labels: readonly string[]): number {
    let longest = 0;
    for (const label of labels) {
        for (const w of label.split(/[\s\u200B]+/)) longest = Math.max(longest, Array.from(w).length);
    }
    return longest;
}

export function tilePanelColumns(panelInnerWidthDp: number, fontScale: number, longestWord = 0): number {
    const wordWidth = longestWord * TILE_LETTER_DP + 2 * TILE_SIDE_PADDING;
    const minTile = Math.max(TILE_BASE_MIN_WIDTH, wordWidth) * Math.max(1, fontScale);
    for (let cols = 4; cols > 2; cols--) {
        const tile = (panelInnerWidthDp - TILE_GAP * (cols - 1)) / cols;
        if (tile >= minTile) return cols;
    }
    return 2;
}

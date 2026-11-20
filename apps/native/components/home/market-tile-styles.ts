import { StyleSheet, type TextStyle } from 'react-native';
import type { ImageContentPosition } from 'expo-image';
import { MARKET_CARD_SHELL, MARKET_CARD_TYPE } from '@beanpool/core';

/**
 * The Market card's picture tiles on Home (MarketTiles.tsx, slice S8), in a file of their own so the layout check at 320dp
 * and 1.3x reads them without loading the screen (utils/__tests__/home-layout-320.test.ts). The photo and the type are the
 * Market grid tile's (core market-card-shell.ts), so Home's tile reads as the Market's does.
 */
const GRID_TYPE = MARKET_CARD_TYPE.grid;
const GRID_PHOTO = MARKET_CARD_SHELL.photo.grid;

/**
 * The photo's focus in its 4:3 frame, the grid's own (50% across, 33% down, as MarketCardPicture's MARKET_GRID_CROP), read
 * from core here so the tile needs no import of the Market's picture (and the listing store it heals through).
 */
export const MARKET_TILE_CROP: ImageContentPosition = { top: `${GRID_PHOTO.cropY}%`, left: `${GRID_PHOTO.cropX}%` };

export const marketTileStyles = StyleSheet.create({
    grid: { gap: 12, paddingTop: 4, paddingBottom: 2 },
    row: { flexDirection: 'row', gap: 10 },
    // flex 1 each, so two share the row equally at any width; the row stretches both to the taller one.
    cell: { flex: 1, minWidth: 0 },
    tile: { borderRadius: 12, paddingBottom: 4 },
    photo: { width: '100%', aspectRatio: GRID_PHOTO.aspectWidth / GRID_PHOTO.aspectHeight, borderRadius: 12, overflow: 'hidden' },
    fill: { width: '100%', height: '100%' },
    // 4 in from the photo's corner: OFFER in its longest language (Russian, 11 capitals) fits the tile at 320dp × 1.3.
    chip: { position: 'absolute', top: 4, left: 4 },
    title: { marginTop: 6, fontSize: GRID_TYPE.loud.size, lineHeight: GRID_TYPE.loud.line, fontWeight: String(GRID_TYPE.loud.weight) as TextStyle['fontWeight'] },
    facts: { marginTop: 2, fontSize: GRID_TYPE.price.size, lineHeight: 18, fontWeight: String(GRID_TYPE.price.weight) as TextStyle['fontWeight'] },
});

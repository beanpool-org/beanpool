/**
 * The Market's one style box, the numbers (DESIGN-card-style-box-fable.md §1.1 to §1.3, slice D0). Each app's module turns
 * these into styles and a test there holds its literals to them; this file holds the numbers to the design, so a value that
 * drifts from §1 fails here before a screen draws it.
 */

import { describe, expect, it } from 'vitest';
import {
    MARKET_CARD_SHELL,
    MARKET_CARD_TYPE,
    MARKET_CHIP,
    MARKET_GRID_TEXT_BLOCK,
    MARKET_GRID_TEXT_BLOCK_REM,
    gridTextBlockHeight,
} from '../market-card-shell.js';
import * as barrel from '../index.js';

describe('the shell (§1.1)', () => {
    it('is one card: corners 14, a 1 px outline, 12 of text padding', () => {
        expect(MARKET_CARD_SHELL.radius).toBe(14);
        expect(MARKET_CARD_SHELL.borderWidth).toBe(1);
        expect(MARKET_CARD_SHELL.textPadding).toBe(12);
    });

    it('puts 8 between cards in a list or compact column and 16 in the grid', () => {
        expect(MARKET_CARD_SHELL.gap).toEqual({ list: 8, compact: 8, grid: 16 });
    });

    it('has one card shadow and one floating shadow for the map pop-up', () => {
        expect(MARKET_CARD_SHELL.shadow).toEqual({ offsetY: 2, opacity: 0.05, blur: 8, elevation: 2 });
        expect(MARKET_CARD_SHELL.floatingShadow).toEqual({ offsetY: 10, opacity: 0.15, blur: 20, elevation: 20 });
    });

    it('sets the map pop-up 16 in from the screen, its ✕ 28 round and 8 in from the corner (slice M1)', () => {
        expect(MARKET_CARD_SHELL.popUp).toEqual({ margin: 16, close: { size: 28, inset: 8, type: { size: 12, weight: 800 } } });
    });

    it('gives each size its photo: 80 wide in the list, 4:3 cropped at 50% 33% in the grid, 32 with radius 8 in a compact row', () => {
        expect(MARKET_CARD_SHELL.photo.list).toEqual({ width: 80 });
        expect(MARKET_CARD_SHELL.photo.grid).toEqual({ aspectWidth: 4, aspectHeight: 3, cropX: 50, cropY: 33 });
        expect(MARKET_CARD_SHELL.photo.compact).toEqual({ size: 32, radius: 8 });
    });

    it('pads a compact row 10 down and 12 across, as the phone does today', () => {
        expect(MARKET_CARD_SHELL.compactPadding).toEqual({ vertical: 10, horizontal: 12 });
    });

    it('has two variants and no band: an Elder border of 3 and a Pulse border of 2', () => {
        expect(MARKET_CARD_SHELL.variant).toEqual({ elderBorderLeft: 3, pulseBorder: 2 });
        expect(Object.keys(MARKET_CARD_SHELL.variant)).toHaveLength(2);
    });
});

describe('the one chip (§1.2)', () => {
    it('is 10/800 with padding 6 across by 2 down and radius 6', () => {
        expect(MARKET_CHIP.type).toEqual({ size: 10, weight: 800 });
        expect(MARKET_CHIP.paddingHorizontal).toBe(6);
        expect(MARKET_CHIP.paddingVertical).toBe(2);
        expect(MARKET_CHIP.radius).toBe(6);
    });

    it('is one chip for every card size: no size of the type scale carries a chip of its own', () => {
        for (const size of ['list', 'grid', 'compact'] as const) {
            expect(Object.keys(MARKET_CARD_TYPE[size]), size).not.toContain('chip');
        }
    });
});

describe('the type scale (§1.3)', () => {
    it('list card: a 16/900 loud line on 20, a 15/700 second line on 20, a 24 avatar and 13/600 name', () => {
        const t = MARKET_CARD_TYPE.list;
        expect(t.loud).toEqual({ size: 16, weight: 900, line: 20 });
        expect(t.second).toEqual({ size: 15, weight: 700, line: 20 });
        expect(t.whoAvatar).toBe(24);
        expect(t.whoName).toEqual({ size: 13, weight: 600 });
        expect(t.place).toEqual({ size: 13, weight: 500 });
        expect(t.distance).toEqual({ size: 12, weight: 600 });
        expect(t.mark).toEqual({ size: 13, weight: 700 });
        expect(t.price).toEqual({ size: 16, weight: 800 });
        expect(t.priceUnit).toEqual({ size: 10, weight: 500 });
    });

    it('grid tile: 14/800 on 18, a 14/700 second line on 18, an 18 avatar and 12/500 name, a 14/500 place on 18, a 13/700 price pill', () => {
        const t = MARKET_CARD_TYPE.grid;
        expect(t.loud).toEqual({ size: 14, weight: 800, line: 18 });
        expect(t.second).toEqual({ size: 14, weight: 700, line: 18 });
        expect(t.whoAvatar).toBe(18);
        expect(t.whoName).toEqual({ size: 12, weight: 500 });
        expect(t.place).toEqual({ size: 14, weight: 500, line: 18 });
        expect(t.price).toEqual({ size: 13, weight: 700 });
    });

    it('compact row: a 14/800 title, 11/500 lines, a 14/900 price', () => {
        const t = MARKET_CARD_TYPE.compact;
        expect(t.title).toEqual({ size: 14, weight: 800 });
        expect(t.line).toEqual({ size: 11, weight: 500 });
        expect(t.price).toEqual({ size: 14, weight: 900 });
    });

    it('page: a 10/800 box label spaced 1.5, 18/800 terms, a 28/800 price, a 15 on 22 description, a 15/700 button 48 tall with corners 12', () => {
        const p = MARKET_CARD_TYPE.page;
        expect(p.boxLabel).toEqual({ size: 10, weight: 800 });
        expect(p.boxLabelSpacing).toBe(1.5);
        expect(p.termsValue).toEqual({ size: 18, weight: 800 });
        expect(p.pagePrice).toEqual({ size: 28, weight: 800 });
        expect([p.descriptionSize, p.descriptionLine]).toEqual([15, 22]);
        expect(p.button).toEqual({ size: 15, weight: 700 });
        expect([p.buttonHeight, p.buttonRadius]).toEqual([48, 12]);
    });

    it('every fixed line height is at least its type size, so a line never clips', () => {
        const all = [
            ...Object.values(MARKET_CARD_TYPE.list),
            ...Object.values(MARKET_CARD_TYPE.grid),
            ...Object.values(MARKET_CARD_TYPE.compact),
        ];
        for (const entry of all) {
            if (typeof entry === 'object' && 'line' in entry && entry.line !== undefined) expect(entry.line).toBeGreaterThanOrEqual(entry.size);
        }
    });
});

describe('the grid tile text block (§1.3, the grid design §2.2)', () => {
    it('is four rows of 18 with 4 between, so every tile in a row is the same height', () => {
        expect(MARKET_GRID_TEXT_BLOCK.rows).toBe(4);
        expect(MARKET_GRID_TEXT_BLOCK.rowHeight).toBe(18);
        expect(MARKET_GRID_TEXT_BLOCK.rowGap).toBe(4);
        // The rows are the grid type's own line height, not a second number.
        expect(MARKET_GRID_TEXT_BLOCK.rowHeight).toBe(MARKET_CARD_TYPE.grid.loud.line);
    });

    it('is (4 x 18 + 12) x font scale + 24 on the phone', () => {
        expect(gridTextBlockHeight(1)).toBe(108);
        expect(gridTextBlockHeight(1.3)).toBeCloseTo(24 + 84 * 1.3, 10);
        expect(gridTextBlockHeight(2)).toBe(24 + 168);
    });

    it('counts a font scale that is not a positive number as 1', () => {
        for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(gridTextBlockHeight(bad), String(bad)).toBe(108);
    });

    it('is 1.5rem + 4 x 1.203rem + 3 x 0.25rem = 7.0625rem on the web, 113 px at a 16 px root', () => {
        expect(MARKET_GRID_TEXT_BLOCK_REM).toBe(7.0625);
        expect(MARKET_GRID_TEXT_BLOCK_REM * 16).toBe(113);
        // 1.203125rem is 19.25 px: text-sm (14 px) on leading-snug (1.375).
        expect(MARKET_GRID_TEXT_BLOCK.rowHeightRem * 16).toBe(14 * 1.375);
        // Its padding and gap are the shell's: p-3 a side, gap-1.
        expect(MARKET_GRID_TEXT_BLOCK.paddingRem * 16).toBe(2 * MARKET_CARD_SHELL.textPadding);
        expect(MARKET_GRID_TEXT_BLOCK.rowGapRem * 16).toBe(MARKET_GRID_TEXT_BLOCK.rowGap);
    });
});

describe('the library', () => {
    it('is on the barrel both apps import from', () => {
        expect(barrel.MARKET_CARD_SHELL).toBe(MARKET_CARD_SHELL);
        expect(barrel.MARKET_CHIP).toBe(MARKET_CHIP);
        expect(barrel.MARKET_CARD_TYPE).toBe(MARKET_CARD_TYPE);
        expect(barrel.gridTextBlockHeight).toBe(gridTextBlockHeight);
    });
});

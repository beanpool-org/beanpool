import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MARKET_CARD_SHELL, MARKET_CARD_TYPE, MARKET_CHIP, brandColours, contrastRatio, gridTextBlockHeight } from '@beanpool/core';

/**
 * The phone's style box (components/market-card-shell.ts, slice P2 of DESIGN-card-style-box-fable.md): every number in its
 * styles is core's (market-card-shell.ts), and every chip role is a central colour pair that reads 4.5:1 or more in light and
 * in dark. The chips are drawn inside CardChip, which the whole-tree contrast scanner does not follow into, so they are held here.
 */
vi.mock('react-native', () => ({ StyleSheet: { create: (s: unknown) => s }, View: 'View', Text: 'Text' }));
vi.mock('../../app/ThemeContext', () => ({ useStyles: () => ({}) }));

import { chipTones, makeCardShell, cardType, gridTextBlock, type CardChipRole } from '../../components/market-card-shell';
import { darkColors, lightColors } from '../../constants/colors';

// The theme context hands either set as `typeof lightColors` (ThemeContextType).
const THEMES = [['light', lightColors, brandColours('light')], ['dark', darkColors as unknown as typeof lightColors, brandColours('dark')]] as const;
const ROLES: CardChipRole[] = ['offer', 'need', 'event', 'poll', 'pinned', 'quiet', 'warn', 'ok', 'danger', 'info'];

describe('the box is core\'s numbers', () => {
    const shell = makeCardShell(lightColors);

    it('the card: corners, border, gap, shadow', () => {
        expect(shell.card).toMatchObject({
            borderRadius: MARKET_CARD_SHELL.radius, borderWidth: MARKET_CARD_SHELL.borderWidth, marginBottom: MARKET_CARD_SHELL.gap.list,
            shadowOpacity: MARKET_CARD_SHELL.shadow.opacity, shadowRadius: MARKET_CARD_SHELL.shadow.blur, elevation: MARKET_CARD_SHELL.shadow.elevation,
            overflow: 'hidden',
        });
        expect(shell.card.shadowOffset).toEqual({ width: 0, height: MARKET_CARD_SHELL.shadow.offsetY });
        expect(shell.list).toEqual({ flexDirection: 'row', padding: 0 });
    });

    it('the list picture slot: 80 wide, at least 80 tall, stretched, under the left corners; never a percentage height', () => {
        const slot = { width: MARKET_CARD_SHELL.photo.list.width, minHeight: MARKET_CARD_SHELL.photo.list.width, alignSelf: 'stretch',
            borderTopLeftRadius: MARKET_CARD_SHELL.radius, borderBottomLeftRadius: MARKET_CARD_SHELL.radius };
        expect(shell.listPhoto).toEqual(slot);
        expect(shell.listPhotoBox).toEqual({ ...slot, overflow: 'hidden' });
        expect(JSON.stringify(shell)).not.toMatch(/"(height|minHeight|maxHeight)":"[0-9.]+%"/);
    });

    it('the text padding and the one chip', () => {
        expect(shell.listText).toMatchObject({ flex: 1, minWidth: 0, padding: MARKET_CARD_SHELL.textPadding });
        expect(shell.chip).toMatchObject({ paddingHorizontal: MARKET_CHIP.paddingHorizontal, paddingVertical: MARKET_CHIP.paddingVertical, borderRadius: MARKET_CHIP.radius, flexShrink: 0 });
        expect(shell.chipText).toEqual({ fontSize: MARKET_CHIP.type.size, fontWeight: String(MARKET_CHIP.type.weight) });
    });

    it('the list type scale', () => {
        expect(cardType(MARKET_CARD_TYPE.list.loud)).toEqual({ fontSize: 16, fontWeight: '900', lineHeight: 20 });
        expect(shell.loud).toMatchObject(cardType(MARKET_CARD_TYPE.list.loud));
        expect(shell.second).toMatchObject(cardType(MARKET_CARD_TYPE.list.second));
        expect(shell.place).toMatchObject(cardType(MARKET_CARD_TYPE.list.place));
        expect(shell.mark).toMatchObject({ ...cardType(MARKET_CARD_TYPE.list.mark), color: lightColors.tile.event.ink });
    });

    it('the grid (PG2): a row of two cells with the 16 gutter between and under it; the tile fills its cell; the type scale', () => {
        expect(shell.gridRow).toEqual({ flexDirection: 'row', gap: MARKET_CARD_SHELL.gap.grid, marginBottom: MARKET_CARD_SHELL.gap.grid });
        expect(MARKET_CARD_SHELL.gap.grid).toBe(16);
        expect(shell.gridCell).toEqual({ flex: 1, minWidth: 0 });
        expect(shell.gridTile).toEqual({ flex: 1, marginBottom: 0 });
        expect(cardType(MARKET_CARD_TYPE.grid.loud)).toEqual({ fontSize: 14, fontWeight: '800', lineHeight: 18 });
        expect(shell.gridTitle).toMatchObject(cardType(MARKET_CARD_TYPE.grid.loud));
        expect(shell.gridLine).toMatchObject(cardType(MARKET_CARD_TYPE.grid.place));
    });

    it.each([1, 1.3, 2])('the grid text block at %sx: four rows of 18 and three gaps of 4, scaled, in 12 of padding: core\'s height', (scale) => {
        const b = gridTextBlock(scale);
        expect(b.block).toMatchObject({ height: gridTextBlockHeight(scale), padding: MARKET_CARD_SHELL.textPadding, gap: 4 * scale, overflow: 'hidden' });
        expect(b.block.height).toBeCloseTo(24 + (4 * 18 + 3 * 4) * scale, 9);
        // The title's two rows and the gap between them; then rows 3 and 4: they fill the block exactly, gaps and all.
        expect(b.titleBox.height).toBeCloseTo((2 * 18 + 4) * scale, 9);
        expect(b.row.height).toBeCloseTo(18 * scale, 9);
        expect(b.lastRow.height).toBeCloseTo(18 * scale, 9);
        expect(2 * MARKET_CARD_SHELL.textPadding + b.titleBox.height + b.row.height + b.lastRow.height + 2 * b.block.gap).toBeCloseTo(b.block.height, 9);
        expect(b.lastRow).toMatchObject({ flexDirection: 'row', overflow: 'hidden' });
    });

    it('a font scale that is not a positive number counts as 1, as core\'s does', () => {
        for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(gridTextBlock(bad)).toEqual(gridTextBlock(1));
    });

    it('writes no number or colour of its own (the source)', () => {
        const src = readFileSync(join(__dirname, '..', '..', 'components', 'market-card-shell.ts'), 'utf8');
        expect(src.replace("shadowColor: '#000'", '')).not.toMatch(/['"`]#[0-9a-fA-F]{3,8}['"`]/);
        // A zero (`padding: 0`, the shadow's `width: 0`) is no design number; every other one is core's.
        expect(src).not.toMatch(/(borderRadius|padding\w*|width|minHeight|fontSize|marginBottom):\s*[1-9]/);
    });
});

describe.each(THEMES)('the %s chips', (theme, colors, brand) => {
    const tones = chipTones(colors);

    it.each(ROLES)('%s reads 4.5:1 or more', (role) => {
        const { fg, bg } = tones[role];
        expect(contrastRatio(fg, bg), `${theme} ${role}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    });

    it('each role is its core pair', () => {
        expect(tones.offer).toEqual({ bg: brand.chip.ok.tint, fg: brand.chip.ok.ink });
        expect(tones.ok).toEqual(tones.offer);
        expect(tones.need).toEqual({ bg: brand.chip.need.tint, fg: brand.chip.need.ink });
        expect(tones.event).toEqual({ bg: brand.tile.event.tint, fg: brand.tile.event.ink });
        expect(tones.poll).toEqual({ bg: brand.chip.poll.tint, fg: brand.chip.poll.ink });
        expect(tones.pinned).toEqual({ bg: brand.chip.accent.tint, fg: colors.accent.primary });
        expect(tones.quiet).toEqual({ bg: brand.chip.quiet.tint, fg: brand.chip.quiet.ink });
        expect(tones.info).toEqual({ bg: brand.chip.info.tint, fg: brand.chip.info.ink });
        expect(tones.warn).toEqual({ bg: colors.feedback.warning.bg, fg: colors.feedback.warning.fg });
        expect(tones.danger).toEqual({ bg: colors.feedback.danger.bg, fg: colors.feedback.danger.fg });
    });

    it('the card\'s inks read on the card ground', () => {
        const shell = makeCardShell(colors);
        for (const ink of [shell.loud.color, shell.second.color, shell.place.color, shell.mark.color, shell.gridTitle.color, shell.gridLine.color] as string[]) {
            expect(contrastRatio(ink, colors.surface.card), `${theme} ${ink} on ${colors.surface.card}`).toBeGreaterThanOrEqual(4.5);
        }
    });
});

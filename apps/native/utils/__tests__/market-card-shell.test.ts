import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MARKET_CARD_SHELL, MARKET_CARD_TYPE, MARKET_CHIP, MARKET_SCRIM_PILL, blendOver, brandColours, contrastRatio, gridTextBlockHeight } from '@beanpool/core';

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

    // The pages' boxes and buttons (DESIGN-detail-pages-fable.md §2.2, slice DP1), with the style box's one text padding (§3 row 3).
    it('the page box, its label and its button: the card\'s corners, border, ground, shadow and padding; 10/800 spaced 1.5; 48 tall, corners 12, 15/700', () => {
        expect(shell.pageBox).toMatchObject({
            borderRadius: MARKET_CARD_SHELL.radius, borderWidth: MARKET_CARD_SHELL.borderWidth, padding: MARKET_CARD_SHELL.textPadding,
            backgroundColor: lightColors.surface.card, borderColor: lightColors.border.default,
            shadowOpacity: MARKET_CARD_SHELL.shadow.opacity, shadowRadius: MARKET_CARD_SHELL.shadow.blur, elevation: MARKET_CARD_SHELL.shadow.elevation,
        });
        expect(shell.pageBox).not.toHaveProperty('margin');
        expect(shell.pageBox).not.toHaveProperty('marginBottom');
        expect(shell.boxLabel).toEqual({ ...cardType(MARKET_CARD_TYPE.page.boxLabel), letterSpacing: MARKET_CARD_TYPE.page.boxLabelSpacing, color: lightColors.text.muted });
        expect(shell.pageButton).toMatchObject({ minHeight: MARKET_CARD_TYPE.page.buttonHeight, borderRadius: MARKET_CARD_TYPE.page.buttonRadius });
        expect(shell.pageButtonText).toEqual(cardType(MARKET_CARD_TYPE.page.button));
        expect([shell.pageBox.borderRadius, shell.pageBox.padding, shell.pageButton.minHeight, shell.pageButton.borderRadius]).toEqual([14, 12, 48, 12]);
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

    it('the grid tile\'s photo (P3\'): the 4:3 frame, the photo laid over it edge to edge, the type chip\'s corner, the scrim pills: core\'s numbers', () => {
        const PILL = MARKET_SCRIM_PILL;
        expect(shell.gridImageWrapper).toEqual({ position: 'relative', width: '100%', aspectRatio: MARKET_CARD_SHELL.photo.grid.aspectWidth / MARKET_CARD_SHELL.photo.grid.aspectHeight });
        expect(shell.gridImage).toEqual({ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 });
        expect(shell.gridTypeSlot).toEqual({ position: 'absolute', top: PILL.inset, left: PILL.inset });
        expect(shell.gridBadgeRow).toEqual({ position: 'absolute', left: PILL.inset, right: PILL.inset, bottom: PILL.inset, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: PILL.gap });
        expect(shell.gridBadge).toEqual({
            backgroundColor: lightColors.overlay.scrim, borderColor: lightColors.overlay.scrimEdge, maxWidth: '100%',
            paddingHorizontal: PILL.paddingHorizontal, paddingVertical: PILL.paddingVertical, borderRadius: PILL.radius, borderWidth: PILL.borderWidth,
        });
        expect(shell.gridPriceEnd).toEqual({ marginLeft: 'auto' });
    });

    it('the grid tile\'s words (PG2, P3\'): core\'s type, written out; an event\'s date and time the loud line in the event ink, its title the second', () => {
        const GRID = MARKET_CARD_TYPE.grid;
        expect(shell.gridTitle).toEqual({ ...cardType(GRID.loud), color: lightColors.text.body });
        expect(shell.gridLine).toEqual({ ...cardType(GRID.place), color: lightColors.text.secondary });
        expect(shell.gridWhen).toEqual({ ...cardType(GRID.loud), color: lightColors.tile.event.ink });
        expect(shell.gridSecond).toEqual({ ...cardType(GRID.second), color: lightColors.text.body });
        expect(shell.gridPriceText).toEqual({ ...cardType(GRID.price), color: lightColors.text.inverse });
        expect(shell.gridPinText).toEqual({ ...cardType(MARKET_SCRIM_PILL.quiet), color: lightColors.text.inverse });
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
        for (const ink of [shell.loud.color, shell.second.color, shell.place.color, shell.mark.color, shell.gridTitle.color, shell.gridLine.color, shell.gridWhen.color, shell.gridSecond.color] as string[]) {
            expect(contrastRatio(ink, colors.surface.card), `${theme} ${ink} on ${colors.surface.card}`).toBeGreaterThanOrEqual(4.5);
        }
    });

    it('the words on a grid photo (a price, your mark, 📌 PINNED) read 4.5:1 or more on the scrim, over a white photo or a black one', () => {
        const shell = makeCardShell(colors);
        const [r, g, b, a] = colors.overlay.scrim.match(/[\d.]+/g)!.map(Number);
        const scrim = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
        for (const under of ['#ffffff', '#000000']) {
            const ground = blendOver(scrim, a, under);
            for (const ink of [shell.gridPriceText.color, shell.gridPinText.color] as string[]) {
                expect(contrastRatio(ink, ground), `${theme} ${ink} on ${ground}`).toBeGreaterThanOrEqual(4.5);
            }
        }
        // Why the mark is white, not the event's violet (DESIGN-market-grid-sizes-fable.md §2.6): on the light scrim the violet
        // reads about 1 : 1 over a white photo.
        if (theme === 'light') expect(contrastRatio(colors.tile.event.ink, blendOver(scrim, a, '#ffffff'))).toBeLessThan(4.5);
    });
});

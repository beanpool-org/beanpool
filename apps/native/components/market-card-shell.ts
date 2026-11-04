/**
 * The Market's style box on the phone (DESIGN-card-style-box-fable.md §1, slice P2; Marty, 4 Nov 2026: "make them look like
 * they came out of the same style box"). The numbers are core's (`@beanpool/core` market-card-shell.ts); this module turns
 * them into the phone's styles, with the colours from the central tokens (constants/colors.ts, light and dark). Every Market
 * card reads its shell, its picture slot and its chips from here, so an Offer, a Need and an event cannot drift apart.
 *
 *     NO SCREEN WRITES A RADIUS, A CHIP SIZE OR A CARD COLOUR OF ITS OWN.
 *
 * A list card takes its natural height from its lines (Marty, 4 Nov: "the big card doesnt need to conform to the same
 * size"): nothing here fixes it, the picture slot stretches to it.
 */
import { createElement } from 'react';
import { StyleSheet, Text, View, type TextStyle } from 'react-native';
import { MARKET_CARD_SHELL as SHELL, MARKET_CARD_TYPE, MARKET_CHIP, MARKET_GRID_TEXT_BLOCK, MARKET_SCRIM_PILL as PILL, gridTextBlockHeight, type CardType } from '@beanpool/core';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';

type Colors = ThemeContextType['colors'];

/** A piece of core's type scale as a Text style: size, weight, and the line height where the design fixes one. */
export function cardType({ size, weight, line }: CardType): TextStyle {
    const style: TextStyle = { fontSize: size, fontWeight: String(weight) as TextStyle['fontWeight'] };
    if (line !== undefined) style.lineHeight = line;
    return style;
}

/**
 * The chip set (§1.2): one chip, ten roles, each a core colour pair. OFFER / NEED are chip.ok / chip.need, EVENT and UPDATED
 * the event tile, POLL chip.poll, 📌 PINNED chip.accent, RECURRING / a category / a group's lock chip.quiet, money and
 * caution (CASH TOO, PULSE, a deal asked) chip.warn, a deal held chip.ok, CANCELLED chip.danger, 👤 YOU chip.info.
 */
export type CardChipRole = 'offer' | 'need' | 'event' | 'poll' | 'pinned' | 'quiet' | 'warn' | 'ok' | 'danger' | 'info';

export function chipTones(colors: Colors): Record<CardChipRole, { bg: string; fg: string }> {
    return {
        offer: colors.market.offer,
        need: colors.market.need,
        event: { bg: colors.tile.event.tint, fg: colors.tile.event.ink },
        poll: colors.market.poll,
        pinned: { bg: colors.accent.tint, fg: colors.accent.primary },
        quiet: colors.chip.quiet,
        warn: { bg: colors.feedback.warning.bg, fg: colors.feedback.warning.fg },
        ok: colors.market.offer,
        danger: { bg: colors.feedback.danger.bg, fg: colors.feedback.danger.fg },
        info: colors.chip.info,
    };
}

const LIST = MARKET_CARD_TYPE.list;
const GRID = MARKET_CARD_TYPE.grid;
const SLOT = SHELL.photo.list.width;
const GRID_PHOTO = SHELL.photo.grid;

/** The box's styles for one theme. `useCardShell()` is this, made once per theme. */
export function makeCardShell(colors: Colors) {
    const slot = {
        width: SLOT,
        minHeight: SLOT,
        alignSelf: 'stretch' as const,
        borderTopLeftRadius: SHELL.radius,
        borderBottomLeftRadius: SHELL.radius,
    };
    const styles = StyleSheet.create({
        /** The card: corners, the 1 dp border, the card ground, the one shadow, the gap under it. */
        card: {
            backgroundColor: colors.surface.card,
            borderRadius: SHELL.radius,
            borderWidth: SHELL.borderWidth,
            borderColor: colors.border.default,
            overflow: 'hidden',
            marginBottom: SHELL.gap.list,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: SHELL.shadow.offsetY },
            shadowOpacity: SHELL.shadow.opacity,
            shadowRadius: SHELL.shadow.blur,
            elevation: SHELL.shadow.elevation,
        },
        /** The list card: the picture slot on the left, the text column beside it, no padding round the picture. */
        list: { flexDirection: 'row', padding: 0 },
        /**
         * The list card's picture: 80 wide, flush under the card's left corners, the card's full height (stretched by the row,
         * 80 at least). Never a percentage height, which Yoga reads against the whole list (market-card-height-layout.test.ts).
         */
        listPhoto: slot,
        /** The same slot as a box, for the category tile that holds it until the photo has drawn. */
        listPhotoBox: { ...slot, overflow: 'hidden' },
        /** The text column: 12 all round. */
        listText: { flex: 1, minWidth: 0, padding: SHELL.textPadding, justifyContent: 'center' },
        /** A row of chips: they wrap, never shrink. */
        chipRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
        /** The one chip: padding 6 across, 2 down, corners 6. */
        chip: {
            flexShrink: 0,
            maxWidth: '100%',
            paddingHorizontal: MARKET_CHIP.paddingHorizontal,
            paddingVertical: MARKET_CHIP.paddingVertical,
            borderRadius: MARKET_CHIP.radius,
        },
        /** Its words: 10/800, one line. */
        chipText: cardType(MARKET_CHIP.type),
        /** The list card's lines (§1.3). */
        loud: { ...cardType(LIST.loud), color: colors.text.body },
        second: { ...cardType(LIST.second), color: colors.text.body },
        place: { ...cardType(LIST.place), color: colors.text.secondary },
        distance: { ...cardType(LIST.distance), color: colors.text.secondary },
        /** Going ✓ / Interested ✓, You're hosting this event: words, never a control, in the event's ink. */
        mark: { ...cardType(LIST.mark), color: colors.tile.event.ink },
        /**
         * The grid (DESIGN-market-grid-sizes-fable.md §2.2, §2.5, slice PG2) is a list of rows: two tiles side by side with the
         * gutter between them and under the row, or a poll on its own, the list's width. A cell is half the row less the gutter
         * and is stretched to the row's height; the tile fills its cell, so the two tiles of a row are one height.
         */
        gridRow: { flexDirection: 'row', gap: SHELL.gap.grid, marginBottom: SHELL.gap.grid },
        gridCell: { flex: 1, minWidth: 0 },
        gridTile: { flex: 1, marginBottom: 0 },
        /** Rows 1 and 2 of the four: the title, two lines at most. */
        gridTitle: { ...cardType(GRID.loud), color: colors.text.body },
        /** Row 3 on a copy (its price there, in words) and row 4's distance: one line each. */
        gridLine: { ...cardType(GRID.place), color: colors.text.secondary },
        /** An event tile's rows 1 and 2: the date, then the time, the loud line in the event's ink, one row each. */
        gridWhen: { ...cardType(GRID.loud), color: colors.tile.event.ink },
        /** An event tile's row 3: its title, one line. */
        gridSecond: { ...cardType(GRID.second), color: colors.text.body },
        /**
         * The tile's photo and what sits on it, the same for every kind (slice P3': an event and the Daily Pulse are listing
         * tiles too). The picture is 4:3 at the tile's width, flush under its top corners (the card's own overflow rounds
         * them); the photo fills that frame (no percentage height: it is laid over the frame, edge to edge).
         */
        gridImageWrapper: { position: 'relative', width: '100%', aspectRatio: GRID_PHOTO.aspectWidth / GRID_PHOTO.aspectHeight },
        gridImage: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
        /** The type chip's place, the photo's top-left corner: OFFER / NEED, EVENT, as the one chip (CardChip). */
        gridTypeSlot: { position: 'absolute', top: PILL.inset, left: PILL.inset },
        /**
         * The photo's foot: the pills at its start (a status, 📌 PINNED, a deal, an event's CANCELLED / UPDATED) and the loud
         * thing at its end (a listing's price, your mark on an event). It wraps upwards when a language needs the room.
         */
        gridBadgeRow: { position: 'absolute', left: PILL.inset, right: PILL.inset, bottom: PILL.inset, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: PILL.gap },
        /** A pill on the photo: the scrim, its light edge, white words. */
        gridBadge: {
            backgroundColor: colors.overlay.scrim,
            paddingHorizontal: PILL.paddingHorizontal,
            paddingVertical: PILL.paddingVertical,
            borderRadius: PILL.radius,
            borderWidth: PILL.borderWidth,
            borderColor: colors.overlay.scrimEdge,
            maxWidth: '100%',
        },
        gridPriceEnd: { marginLeft: 'auto' },
        /**
         * The loud pill's words: a price, or your mark ("Going ✓"). White on the scrim: the event's violet ink would read
         * 1.0 to 1.8 : 1 on the light theme's scrim (slice P3' measured it), white reads 9.1 : 1 at the least.
         */
        gridPriceText: { ...cardType(GRID.price), color: colors.text.inverse },
        /** A quiet pill's words: 📌 PINNED, an event's CANCELLED / UPDATED. */
        gridPinText: { ...cardType(PILL.quiet), color: colors.text.inverse },
    });
    return { ...styles, tones: chipTones(colors) };
}

/**
 * The grid tile's text block at the phone's font scale (§2.2): four rows of 18 with 4 between them, both scaled with the text
 * (a phone scales a line height as it does a font size), inside 12 of padding that does not scale; core's
 * `gridTextBlockHeight`. Rows 1 and 2 are the title's box (its two lines and the gap between them), rows 3 and 4 a box each,
 * so the block is the same height whatever a tile holds, and every tile in a row puts its author and its last line at the
 * same place. A scale that is not a positive number counts as 1, as core's does. No colour here: the theme's are in the table.
 * A StyleSheet table, so the phone's contrast scan (utils/button-contrast.ts) reads it where the grid tile uses it.
 */
export function gridTextBlock(fontScale: number) {
    const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
    const { rowHeight, rowGap } = MARKET_GRID_TEXT_BLOCK;
    const row = rowHeight * scale;
    return StyleSheet.create({
        block: { height: gridTextBlockHeight(scale), padding: SHELL.textPadding, gap: rowGap * scale, overflow: 'hidden' },
        titleBox: { height: 2 * row + rowGap * scale },
        /** Row 3: the author (an 18 dp avatar and a name) or a copy's line, centred in the row. */
        row: { height: row, justifyContent: 'center' },
        /** Row 4: one line that is cut, never wrapped: the distance first, then one chip at most, spaced as a chip row. */
        lastRow: { height: row, flexDirection: 'row', alignItems: 'center', gap: 6, overflow: 'hidden' },
        /** Row 4's distance and its chip: each gives way and is cut at the row's end rather than pushed past it. */
        lastRowPiece: { flexShrink: 1, minWidth: 0 },
    });
}

export type GridTextBlock = ReturnType<typeof gridTextBlock>;

export type CardShell = ReturnType<typeof makeCardShell>;

/** The box for the theme being drawn. */
export function useCardShell(): CardShell {
    return useStyles(({ colors }) => makeCardShell(colors));
}

/**
 * One chip of the set: its role's ground and ink, the one size, one line. `wrap` is for the one chip that is a sentence, the
 * group's lock ("🔒 Only {group} can see this"): it wraps inside the chip rather than lose its words beside the price.
 */
export function CardChip({ shell, role, label, testID, wrap = false }: { shell: CardShell; role: CardChipRole; label: string; testID?: string; wrap?: boolean }) {
    const tone = shell.tones[role];
    return createElement(View, { testID, style: [shell.chip, { backgroundColor: tone.bg }] },
        createElement(Text, { style: [shell.chipText, { color: tone.fg }], numberOfLines: wrap ? undefined : 1 }, label));
}

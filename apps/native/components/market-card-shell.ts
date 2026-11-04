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
import { MARKET_CARD_SHELL as SHELL, MARKET_CARD_TYPE, MARKET_CHIP, MARKET_GRID_TEXT_BLOCK, gridTextBlockHeight, type CardType } from '@beanpool/core';
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
const PAGE = MARKET_CARD_TYPE.page;
const GRID = MARKET_CARD_TYPE.grid;
const SLOT = SHELL.photo.list.width;
const POP_UP = SHELL.popUp;
const CLOSE = POP_UP.close;

/** The box's styles for one theme. `useCardShell()` is this, made once per theme. */
export function makeCardShell(colors: Colors) {
    const slot = {
        width: SLOT,
        minHeight: SLOT,
        alignSelf: 'stretch' as const,
        borderTopLeftRadius: SHELL.radius,
        borderBottomLeftRadius: SHELL.radius,
    };
    /** The one card shadow, the card's and a page box's. */
    const shadow = {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: SHELL.shadow.offsetY },
        shadowOpacity: SHELL.shadow.opacity,
        shadowRadius: SHELL.shadow.blur,
        elevation: SHELL.shadow.elevation,
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
            ...shadow,
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
        /** A listing's price at the end of its chip row: the amount (and its unit) 16/800. */
        price: { ...cardType(LIST.price), color: colors.text.body },
        /** An Elder's card: the gold left border (§1.1 variants). */
        elder: { borderLeftWidth: SHELL.variant.elderBorderLeft, borderLeftColor: colors.trust.star },
        /**
         * The map's pin card (map.tsx, MapPreviewCard; slice M1): the same card, 16 in from the screen's edges, with the floating
         * shadow in place of the card's own.
         */
        floating: {
            margin: POP_UP.margin,
            // The card's own gap under it is an edge of its own, and an edge outranks `margin`: set it too.
            marginBottom: POP_UP.margin,
            shadowOffset: { width: 0, height: SHELL.floatingShadow.offsetY },
            shadowOpacity: SHELL.floatingShadow.opacity,
            shadowRadius: SHELL.floatingShadow.blur,
            elevation: SHELL.floatingShadow.elevation,
        },
        /**
         * Its ✕: 28 round, 8 in from the card's top-right corner (the card sits 16 in), on the subtle ground. The ✕ is the
         * card's sibling, after it in the tree. Plain Android draws siblings in order of elevation, which would put the
         * floating card's 20 over it (#2879 review); React Native's ReactViewGroup keeps tree order by giving each elevated
         * child its own Z barrier (public Canvas API from 29, reflection on hidden methods before), and on the API 36
         * emulator the ✕ was already on top. So the order never rests on that: its box sits one above the card, with a zIndex
         * for iOS and for which of the two a touch meets first. The lifted box has no ground and no corners, so Android gives
         * it no outline and no shadow of its own (a 21 dp shadow round a 28 dp dot, black on API 26 whatever shadowColor says);
         * the dot is `closeDot`, inside it, with no elevation.
         */
        close: {
            position: 'absolute',
            top: POP_UP.margin + CLOSE.inset,
            right: POP_UP.margin + CLOSE.inset,
            width: CLOSE.size,
            height: CLOSE.size,
            elevation: SHELL.floatingShadow.elevation + 1,
            zIndex: 1,
        },
        /** The ✕'s dot: the box's full 28, round, on the subtle ground, the glyph in its middle. */
        closeDot: {
            flex: 1,
            borderRadius: CLOSE.size / 2,
            backgroundColor: colors.surface.subtle,
            justifyContent: 'center',
            alignItems: 'center',
        },
        closeText: { ...cardType(CLOSE.type), color: colors.text.secondary },
        /**
         * The pin card's first row (the chips, and a listing's price) stops short of the ✕: the ✕ and an inset either side of it,
         * less the text column's own padding.
         */
        clearOfClose: { marginRight: CLOSE.size + 2 * CLOSE.inset - SHELL.textPadding },
        /**
         * A page's box (DESIGN-detail-pages-fable.md §2.2, with the style box's one text padding, §3 row 3): the card's corners,
         * border, ground and shadow round an object on an item's own page (the person, the note, the reminder, the guest list).
         * The page places it: its margins are the page's rhythm, not the box's.
         */
        pageBox: {
            backgroundColor: colors.surface.card,
            borderRadius: SHELL.radius,
            borderWidth: SHELL.borderWidth,
            borderColor: colors.border.default,
            padding: SHELL.textPadding,
            ...shadow,
        },
        /** A box's label in small capitals (the capitals are the words'): 10/800, spaced 1.5, muted. */
        boxLabel: { ...cardType(PAGE.boxLabel), letterSpacing: PAGE.boxLabelSpacing, color: colors.text.muted },
        /** A page's button, filled or outlined: 48 tall, corners 12; its words 15/700. The caller gives the role's colours. */
        pageButton: { minHeight: PAGE.buttonHeight, borderRadius: PAGE.buttonRadius, alignItems: 'center', justifyContent: 'center' },
        pageButtonText: cardType(PAGE.button),
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

/**
 * The Market's one style box: the NUMBERS every card, tile and compact row is drawn from, for both apps
 * (DESIGN-card-style-box-fable.md §1.1 to §1.3; Marty, 4 Nov 2026: "make them look like they came out of the same style box").
 *
 *     CHANGE A NUMBER HERE, NEVER IN A SCREEN.
 *
 * The colours are not here: they are roles in brand-colours.ts (`chip.poll`, `chip.quiet`, `chip.info`, and the ones that
 * were already there), held by its contrast test. This file is numbers only: corners, borders, padding, gaps, photo
 * slots, the one chip, the type scale. Each app turns them into styles with one module of its own (the phone's style objects,
 * the web's Tailwind class strings, which need literal classes and so carry a test that holds every number in them to
 * these). No screen writes a radius, a chip size or a card colour of its own.
 *
 * Sizes are dp on the phone and px on the web at the root font size (16 px = 1 rem), unless a name says `Rem`. Type is
 * `{ size, weight, line? }`; a `line` is the line height in the same unit, left out where the design leaves it to the font.
 *
 * Pure: no I/O, no Node built-ins, no regular expressions (the barrel is bundled for the phone, barrel-is-universal.test.ts).
 */

/** A piece of type: size and weight, and the line height where the design fixes one. */
export interface CardType {
    readonly size: number;
    readonly weight: 400 | 500 | 600 | 700 | 800 | 900;
    readonly line?: number;
}

const type = (size: number, weight: CardType['weight'], line?: number): CardType =>
    line === undefined ? { size, weight } : { size, weight, line };

/** §1.1 The shell: what every size of card shares. */
export const MARKET_CARD_SHELL = {
    /** Corners of a card, a tile and a compact row. */
    radius: 14,
    /** The card's outline, in `border.default` (web: nature-200, dark nature-800). */
    borderWidth: 1,
    /** Text padding inside every card. */
    textPadding: 12,
    /** Between cards: a list or compact column; a grid's gutter (the web's `gap-3.5`, 14, becomes `gap-4`). */
    gap: { list: 8, compact: 8, grid: 16 },
    /** The one card shadow (the list card's today): offset down, opacity, blur, Android elevation. */
    shadow: { offsetY: 2, opacity: 0.05, blur: 8, elevation: 2 },
    /** The map pop-up's: the card plus a floating shadow. */
    floatingShadow: { offsetY: 10, opacity: 0.15, blur: 20, elevation: 20 },
    /** The photo slot of each size. */
    photo: {
        /** Beside the text, flush under the card's left corners, the card's full height. */
        list: { width: 80 },
        /** On top, flush under the card's corners, 4:3; `cropX` / `cropY` are the focus in percent (`object-position: 50% 33%`). */
        grid: { aspectWidth: 4, aspectHeight: 3, cropX: 50, cropY: 33 },
        /** A square beside the title. */
        compact: { size: 32, radius: 8 },
    },
    /** A compact row's padding: 10 above and below, 12 either side (what the phone's compact row has today). */
    compactPadding: { vertical: 10, horizontal: 12 },
    /** The two variants; no other band (the event's purple band is gone). */
    variant: {
        /** An Elder's card: a left border in `trust.star`. */
        elderBorderLeft: 3,
        /** Daily Pulse: a border in `feedback.warning.border` on the `tile.pulse.tint` ground. */
        pulseBorder: 2,
    },
} as const;

/** §1.2 The one chip: 10/800, padding 6 across by 2 down, radius 6, one line, never shrunk. */
export const MARKET_CHIP = {
    type: type(10, 800),
    paddingHorizontal: 6,
    paddingVertical: 2,
    radius: 6,
} as const;

/** §1.3 The type scale, by size of card. */
export const MARKET_CARD_TYPE = {
    list: {
        /** A listing's title; an event's when (in `tile.event.ink`, two lines at most, pieces whole). */
        loud: type(16, 900, 20),
        /** An event's title; a poll's question. Two lines. */
        second: type(15, 700, 20),
        /** The who-line: avatar 24, tier chip, name, stars. */
        whoName: type(13, 600),
        whoAvatar: 24,
        /** The place line; its distance. One line. */
        place: type(13, 500),
        distance: type(12, 600),
        /** Going / Interested, a poll's chosen answer, You're hosting (in `tile.event.ink`). */
        mark: type(13, 700),
        /** The price amount; the unit beside it; the bean sign is drawn at the amount's size. */
        price: type(16, 800),
        priceUnit: type(10, 500),
    },
    grid: {
        loud: type(14, 800, 18),
        second: type(14, 700, 18),
        whoName: type(12, 500),
        whoAvatar: 18,
        place: type(14, 500, 18),
        /** The price is a scrim pill at the photo's foot (so is the mark; its type is the grid slices' to set). */
        price: type(13, 700),
    },
    compact: {
        title: type(14, 800),
        /** `by {name}`, the place, and a short second line. */
        line: type(11, 500),
        price: type(14, 900),
    },
    /** The pages (event, Offer / Need) draw their boxes from the same shell. */
    page: {
        /** A box's label: 10/800, letter-spaced 1.5, muted. */
        boxLabel: type(10, 800),
        boxLabelSpacing: 1.5,
        /** The terms box's value; the price. */
        termsValue: type(18, 800),
        pagePrice: type(28, 800),
        /** The description: 15 on 22. */
        descriptionSize: 15,
        descriptionLine: 22,
        /** A button: 15/700, 48 tall, corners 12. */
        button: type(15, 700),
        buttonHeight: 48,
        buttonRadius: 12,
    },
} as const;

/**
 * The grid tile's text block is four rows of 18 dp at 1x font, with 4 dp between them, so every tile in a row is the same
 * height whatever it holds (DESIGN-market-grid-sizes-fable.md §2.2).
 */
export const MARKET_GRID_TEXT_BLOCK = {
    rows: 4,
    rowHeight: 18,
    rowGap: 4,
    /** The web's rows: `text-sm leading-snug` is 19.25 px, 1.203125 rem; its gap `gap-1`, 0.25 rem; `p-3`, 0.75 rem a side. */
    rowHeightRem: 1.203125,
    rowGapRem: 0.25,
    paddingRem: 1.5,
} as const;

/**
 * The phone's height of the grid tile's text block at a font scale: `(4 x 18 + 3 x 4) x fontScale + 24` (the padding does not
 * scale). A scale that is not a positive number counts as 1.
 */
export function gridTextBlockHeight(fontScale: number): number {
    const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
    const { rows, rowHeight, rowGap } = MARKET_GRID_TEXT_BLOCK;
    return (rows * rowHeight + (rows - 1) * rowGap) * scale + 2 * MARKET_CARD_SHELL.textPadding;
}

/** The web's height of the same block, in rem: `1.5rem + 4 x 1.203125rem + 3 x 0.25rem` = 7.0625 rem. */
export const MARKET_GRID_TEXT_BLOCK_REM =
    MARKET_GRID_TEXT_BLOCK.paddingRem +
    MARKET_GRID_TEXT_BLOCK.rows * MARKET_GRID_TEXT_BLOCK.rowHeightRem +
    (MARKET_GRID_TEXT_BLOCK.rows - 1) * MARKET_GRID_TEXT_BLOCK.rowGapRem;

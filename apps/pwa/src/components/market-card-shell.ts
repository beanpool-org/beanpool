/**
 * The Market's one style box on the web: the class strings every card is drawn from (DESIGN-card-style-box-fable.md §1;
 * Marty, 4 Nov 2026: "make them look like they came out of the same style box").
 *
 * The numbers are core's (`@beanpool/core` market-card-shell.ts: MARKET_CARD_SHELL, MARKET_CHIP, MARKET_CARD_TYPE) and the
 * colours are core's roles (brand-colours.ts, as `bp-*` Tailwind names). Tailwind only builds classes it can read whole
 * in the source, so the numbers cannot be computed into a class here: each string below is written out, and
 * market-card-shell.test.ts holds every number in them to core's. Change a number in core, then here; never in a card.
 *
 * Slice W2 puts the LIST card on it, for listings (MarketplaceCard) and events (EventCard): the photo flush under the
 * card's left corners and the card's full height, the text beside it, the one chip, the type scale. A list card takes the
 * height its lines need (Marty, 4 Nov 2026: "the big card doesnt need to conform to the same size"): nothing here fixes
 * or equalises a list card's height. Slice G2 puts the GRID tile on it: one height per row ("the other smaller tiles yes");
 * slice W3' puts the event's tile on the same lattice. Slice C1 puts the COMPACT row on it, for every kind (a listing, an
 * event, a poll), and the poll's card.
 */

/** §1.1 The list card's frame: corners 14, a 1 px border, the card shadow; the photo and the text sit side by side. */
const LIST_FRAME = 'relative flex flex-row w-full min-w-0 overflow-hidden rounded-[14px] border shadow-sm';

/** The outline, `border.default`. */
const BORDER = 'border-nature-200 dark:border-nature-800';

/** The one card ground: the web's own card token (white; #2a322a in dark), the ground core's contrast test proves inks on. */
const GROUND = 'bg-[var(--bg-card)]';

/**
 * Daily Pulse: a 2 px warning border (§1.1 variants), on the card's own ground. Not the Pulse tile's tint the design names:
 * the who-line's name (nature-600, #647664) measures 4.37:1 on #fef3c7, under AA, and the card ground keeps it at 4.87.
 */
const PULSE = 'border-2 border-amber-400/80 dark:border-amber-500/70 shadow-[0_4px_20px_rgba(245,158,11,0.15)]';

/**
 * An Elder's card: a 3 px gold left border (§1.1 variants), in both schemes. `dark:border-l-amber-400` is not a repeat:
 * a `dark:` class comes later in the stylesheet than a plain one of the same weight, so without it `BORDER`'s
 * `dark:border-nature-800` (every side) turns the left side green-grey in dark (#2873: measured rgb(67, 78, 67)).
 */
const ELDER = 'border-l-[3px] border-l-amber-400 dark:border-l-amber-400 shadow-[0_4px_15px_rgba(251,191,36,0.1)]';

/** The list card's outer box. A Pulse card has its own border; an Elder's adds its left border. */
export function listCard({ pulse = false, elder = false }: { pulse?: boolean; elder?: boolean } = {}): string {
    if (pulse) return `${LIST_FRAME} ${GROUND} ${PULSE}`;
    return `${LIST_FRAME} ${BORDER} ${GROUND}${elder ? ` ${ELDER}` : ''}`;
}

/**
 * The list card's picture slot: 80 wide, the card's full height (at least 80), the first thing in the card, so the card's
 * own corners round it. What it holds covers it (`LIST_PHOTO_FILL`), so a photo never leaves a band above or below.
 */
export const LIST_PHOTO = 'relative w-20 min-h-20 self-stretch shrink-0 overflow-hidden';

/** The tile or the photo inside the slot: the whole slot. */
export const LIST_PHOTO_FILL = 'absolute inset-0 w-full h-full';

/** The list card's text beside the photo: 12 of padding, rows 4 apart. */
export const LIST_TEXT = 'flex-1 min-w-0 flex flex-col gap-1 p-3';

/**
 * §1.2 The one chip: 10/800, 6 across by 2 down, corners 6, one line, never shrunk. Capitals come from the words (core's
 * upperCase() or the key itself), never from a class a language cannot follow.
 *
 * Never past its row either: a chip whose words are wider than the whole row (a long category, "📜 Mindset & Philosophy"
 * at 320 x 1.3, longer in German, Malayalam or Tamil) stays one line and ends in an ellipsis at the row's edge, instead
 * of running out under the card's edge and being cut there (#2873). A chip that fits is drawn whole.
 */
export const CHIP = 'inline-block shrink-0 max-w-full whitespace-nowrap overflow-hidden text-ellipsis px-1.5 py-0.5 rounded-md text-[10px] font-extrabold leading-normal tracking-wide';

/** The same chip for a sentence (the group lock, "🔒 Only {group} can see this"): it wraps inside the card, never past it. */
export const CHIP_SENTENCE = 'inline-block min-w-0 max-w-full whitespace-normal break-words px-1.5 py-0.5 rounded-md text-[10px] font-extrabold leading-normal tracking-wide';

/** §1.2 The chip colours, core's roles light and dark. */
export const CHIP_TONE = {
    /** OFFER. A deal held in trust. */
    offer: 'bg-bp-chip-ok-tint text-bp-chip-ok-ink',
    need: 'bg-bp-chip-need-tint text-bp-chip-need-ink',
    /** EVENT, UPDATED. */
    event: 'bg-bp-tile-event-tint text-bp-tile-event-ink',
    poll: 'bg-bp-chip-poll-tint text-bp-chip-poll-ink',
    /** 📌 PINNED in a chip row. */
    pinned: 'bg-bp-chip-accent-tint text-bp-chip-accent-ink',
    /** ↻ RECURRING, the category, 🔒 the group: chips that carry no news. */
    quiet: 'bg-bp-chip-quiet-tint text-bp-chip-quiet-ink',
    /** 💸 CASH TOO, ⏸ PAUSED, ⏳ PENDING, PULSE, a deal asked: money or caution. */
    warn: 'bg-bp-chip-warn-tint text-bp-chip-warn-ink',
    /** A deal held. */
    ok: 'bg-bp-chip-ok-tint text-bp-chip-ok-ink',
    /** CANCELLED, ENDED. */
    danger: 'bg-bp-chip-danger-tint text-bp-chip-danger-ink',
    /** 👤 YOU. */
    info: 'bg-bp-chip-info-tint text-bp-chip-info-ink',
} as const;

export type ChipTone = keyof typeof CHIP_TONE;

/** A chip of one tone; `sentence` for one that may wrap. */
export function chip(tone: ChipTone, sentence = false): string {
    return `${sentence ? CHIP_SENTENCE : CHIP} ${CHIP_TONE[tone]}`;
}

/** §1.3 The list card's type: size, weight and, where the box fixes one, line height. */
export const LIST_TYPE = {
    /** A listing's title; an event's when. 16/900 on 20. */
    loud: 'text-base font-black leading-tight',
    /** An event's title. 15/700 on 20, two lines. */
    second: 'text-[15px] font-bold leading-5',
    /** The place line. 13/500. */
    place: 'text-[13px] font-medium',
    /** A listing's distance. 12/600. */
    distance: 'text-xs font-semibold',
    /** Going ✓ / Interested ✓ / You're hosting this event; the counts. 13/700. */
    mark: 'text-[13px] font-bold',
    /** The price's amount, 16/800; its unit, 10/500. The bean sign is drawn at 14. */
    price: 'text-base font-extrabold',
    priceUnit: 'text-[10px] font-medium',
} as const;

/** The bean sign beside a list card's price, in px. */
export const LIST_BEAN_PX = 14;

/**
 * §1.1, §2 The map's pop-up (slice M1): the list card itself, lifted off the map by the floating shadow, with a ✕. This
 * goes round the card's tap target, so the shadow follows the card's own corners.
 */
export const POP_UP = 'rounded-[14px] shadow-[0_10px_20px_rgba(0,0,0,0.15)]';

/**
 * The pop-up's ✕: the card's one other control, beside its tap target (never inside it, so no control sits in another).
 * A 44 px target in the card's top end corner, the 28 px circle drawn inside it, 6 from the card's edges.
 */
export const POP_UP_CLOSE = 'absolute top-0 end-0 z-10 min-w-[44px] min-h-[44px] p-1.5 flex items-start justify-end rounded-[14px] bg-transparent border-none cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nature-500';

/** The ✕'s circle: 28 across, the quiet ground and ink. */
export const POP_UP_CLOSE_DOT = 'w-7 h-7 rounded-full bg-nature-100 dark:bg-nature-800 text-nature-600 dark:text-nature-300 flex items-center justify-center text-xs font-extrabold';

/**
 * The room a pop-up card's first row keeps for the ✕'s circle: at its end, so its chips and price stop short of it, and in
 * height, so the line under it starts below the circle at any text size (the circle grows with the text; a chip's 10 px
 * words do not). Measured at 320 x 1.3: without the height an event's date ran under the circle (map-pop-up-card-shots.mjs).
 */
export const POP_UP_CLOSE_ROOM = 'pe-8 min-h-6';

/**
 * The grid (slice G2, DESIGN-market-grid-sizes-fable.md §2.2 to §2.4): a lattice. Every tile in a row is the same height,
 * because each is the photo (4:3, following the column) over a text block of exactly four rows (in rem, following the text
 * size), and each tile fills its cell. The gutter is the box's 16 (`gap-4`, from `gap-3.5`).
 *
 * The columns: 2 to 767 px, 3 from 768, 4 from 1024, 5 from 1280 (viewport breakpoints, as before). `grid-flow-row-dense`
 * lets the tiles after a poll back-fill a cell its two columns cannot start in (#1092).
 */
export const GRID = 'grid grid-flow-row-dense grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4';

/**
 * The poll's cell (§2.3): the whole row at two and three columns, where nothing sits beside it, at its own height; from four
 * columns up a 2 x 2 square that the tiles flow round. It fills its cell, so its turnout row sits at the square's foot.
 */
export const GRID_POLL_CELL = 'h-full col-span-2 md:col-span-3 lg:col-span-2 lg:row-span-2';

/** A grid tile's outer box: the list card's corners, border, ground and shadow, the photo on top, filling its cell. */
const GRID_FRAME = 'relative flex flex-col h-full w-full min-w-0 overflow-hidden rounded-[14px] border shadow-sm';

/** The grid tile's outer box. A Pulse tile has its own border; an Elder's adds its left border. */
export function gridTile({ pulse = false, elder = false }: { pulse?: boolean; elder?: boolean } = {}): string {
    if (pulse) return `${GRID_FRAME} ${GROUND} ${PULSE}`;
    return `${GRID_FRAME} ${BORDER} ${GROUND}${elder ? ` ${ELDER}` : ''}`;
}

/** The tile's photo: 4:3, flush under the tile's top corners, never squeezed by the text block. */
export const GRID_PHOTO = 'relative w-full aspect-[4/3] overflow-hidden shrink-0';

/**
 * The text block under the photo: 12 of padding, rows 4 apart, and a FIXED height of four rows, `1.5rem + 4 x 1.203125rem +
 * 3 x 0.25rem` = 7.0625rem (core's MARKET_GRID_TEXT_BLOCK_REM; 113 px at 16 px text, 147 at 1.3x). Whatever a tile holds, its
 * block is this tall, so a tile with a row to spare is the same box with a blank line inside it, never a shorter tile.
 */
export const GRID_TEXT = 'min-w-0 flex flex-col gap-1 p-3 h-[7.0625rem] shrink-0 overflow-hidden';

/** Rows 1 and 2: the title, two lines at most, and two rows reserved however short it is. 14/800 on 1.203125rem. */
export const GRID_TITLE = 'm-0 shrink-0 text-sm font-extrabold leading-snug line-clamp-2 min-h-[2.40625rem]';

/** Rows 3 and 4: one line each, exactly a row tall; what is longer ends in an ellipsis inside the row. */
export const GRID_ROW = 'shrink-0 h-[1.203125rem] min-w-0 flex items-center gap-1.5 overflow-hidden whitespace-nowrap';

/** The one chip in a grid row: as `CHIP`, but it gives way to the distance before it and ends in an ellipsis. */
export const GRID_ROW_CHIP = 'inline-block min-w-0 max-w-full whitespace-nowrap overflow-hidden text-ellipsis px-1.5 py-0.5 rounded-md text-[10px] font-extrabold leading-normal tracking-wide';

/** A chip of one tone in a grid row. */
export function gridChip(tone: ChipTone): string {
    return `${GRID_ROW_CHIP} ${CHIP_TONE[tone]}`;
}

/**
 * A pill on the tile's photo, at its foot (📌 PINNED; the phone's `gridBadge`): the scrim, white words, 10/700, the chip's
 * padding and corners. Readable on any photo, in either scheme.
 */
export const GRID_SCRIM_PILL = 'inline-block shrink-0 whitespace-nowrap px-1.5 py-0.5 rounded-md text-[10px] font-bold leading-normal bg-nature-900/90 text-white shadow-sm';

/*
 * The event tile (slice W3', DESIGN-market-grid-sizes-fable.md §2.2; DESIGN-grid-event-rows-fable.md): the listing tile's
 * shell (gridTile, GRID_PHOTO, GRID_TEXT, GRID_ROW) with the event's own four rows, date / time / title / place.
 */

/** The grid photo's crop, core's focus a third of the way down (market-card-43): a style, since 33% has no class. */
export const GRID_PHOTO_CROP = { objectPosition: '50% 33%' } as const;

/**
 * §1.3 The grid tile's type, core's MARKET_CARD_TYPE.grid in size and weight; every one a row tall (text-sm leading-snug is
 * 1.203125rem, GRID_ROW's height): the event's date and time (in the event ink), its title, its place.
 */
export const GRID_TYPE = {
    /** The event's date row and time row. 14/800. */
    loud: 'text-sm font-extrabold leading-snug',
    /** The event's title, one line. 14/700. */
    second: 'text-sm font-bold leading-snug',
    /** The event's place · distance, one line. 14/500. */
    place: 'text-sm font-medium leading-snug',
} as const;

/**
 * The event's time row (DESIGN-grid-event-rows-fable.md call 4): one row tall, its pieces ("10:26", "–14:26", core's
 * eventTileWhen timePieces) laid side by side and wrapping; the row clips at one line, so an end piece with no room beside
 * the start wraps out of sight whole and the row reads the start alone, never a cut and never a dangling dash. No gap: the
 * dash is the end piece's own.
 */
export const GRID_TIME_ROW = 'shrink-0 h-[1.203125rem] min-w-0 flex flex-wrap content-start overflow-hidden';

/** One piece of the time row: whole, never shrunk; only a piece wider than the whole row (a long repeat rule) ends in "…". */
export const GRID_TIME_PIECE = 'shrink-0 max-w-full whitespace-nowrap overflow-hidden text-ellipsis';

/**
 * The viewer's own answer on an event tile ("Going ✓"), where a listing's price sits: the foot row's end (`ml-auto`), the
 * scrim pill's own size (10/700, as PINNED beside it). Not the price's 13/700: "Interested ✓" at 13/700 measured 124 px in
 * the 111 px foot row at 320 x 1.3 (Chromium, market-grid-shots.mjs). White words on the scrim in both schemes: the event ink
 * there would be dark violet on near black in the light scheme. One line; only a pill wider than the whole row ends in "…".
 */
export const GRID_SCRIM_MARK = 'ml-auto inline-block min-w-0 max-w-full whitespace-nowrap overflow-hidden text-ellipsis px-1.5 py-0.5 rounded-md text-[10px] font-bold leading-normal bg-nature-900/90 text-white shadow-sm';

/**
 * A label that leads a grid row, whole ("🕒 your time" before an event's place, DESIGN-grid-event-rows-fable.md): the chip's
 * type (10/800), as the listing tile's distance tag in its row 4, never shrunk for what follows it. At the row's 14/800 it
 * measured 109 px in a 101 px row at 320 x 1.3 (Chromium); at 10/800 it is whole there. Only a label wider than the whole
 * row (a long language) ends in "…".
 */
export const GRID_ROW_LABEL = 'shrink-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[10px] font-extrabold leading-normal';

/*
 * The compact row (slice C1, DESIGN-card-style-box-fable.md §1.3, §2): one row for every kind in the Market's compact view, a
 * listing (MarketplaceCard), an event (EventCard) and a poll (PollCard), so the three are one height and one look. The 32 px
 * picture (corners 8), the title on one line, one or two short lines under it, and at the end the price or the mark above the
 * one chip. The row's frame is the web's listing row as it was (the brief: "Listing compact rows unchanged except the chip"):
 * 10 above and below as core says, but 16 either side and corners 12 where core's (the phone's) row has 12 and 14, and the
 * listing's who-line at 10 px where core's line is 11. Those are the web row's own until a slice moves the listing row.
 */

/** The row: the frame, the picture and the words on the left, the end on the right. */
export const COMPACT_ROW = 'bg-white dark:bg-nature-950 border border-nature-200 dark:border-nature-800 rounded-xl px-4 py-2.5 shadow-sm cursor-pointer transition-all duration-300 hover:shadow-md flex flex-row items-center justify-between w-full relative overflow-hidden';

/** The picture and the words, side by side, 12 apart; the words give way before the end does. */
export const COMPACT_LEAD = 'flex items-center gap-3 min-w-0 flex-1';

/** §1.1 The compact picture: 32 square, corners 8; what it holds covers it. */
export const COMPACT_PICTURE = 'relative w-8 h-8 rounded-lg overflow-hidden shrink-0';

/** The words beside the picture. */
export const COMPACT_TEXT = 'flex-1 min-w-0';

/** §1.3 The title: 14/800, one line. */
export const COMPACT_TITLE = 'm-0 font-extrabold text-sm text-nature-950 dark:text-white truncate';

/**
 * §1.3 A short line under the title (an event's when, its place; a poll's status, its answer): core's compact line, 11 px, one
 * line ending in "…". `leading-snug` so a row with two of them is a listing's row and one line. The weight and the ink are the
 * use's, never two of each on one line: `font-medium` + CARD_INK.secondary for a quiet line (core's 11/500), `font-bold` +
 * CARD_INK.event for an event's when.
 */
export const COMPACT_LINE = 'block min-w-0 truncate text-[11px] leading-snug';

/**
 * Two short lines as one block (an event's row: its when, then 📌 PINNED, the state and the place): the words flow on from
 * the when and the block stops at two lines, the last ending in "…". Beside the mark (COMPACT_EVENT_BODY) the block takes
 * the room the mark leaves and never goes narrower than its widest whole piece (`min-w-min`): the date or the time, each
 * whole, wrapping to a second line rather than cut. The words between the pieces (the place, "your time") break anywhere they
 * must (`[overflow-wrap:anywhere]`), so only a whole piece sets that width; the pieces themselves never break (nowrap). At
 * 320 px x 1.3 that is the date and the time a line each, and the place on the line past them; in a wider row all of it is
 * one line. Never more than a listing's row and one line.
 */
export const COMPACT_LINES = 'flex-1 min-w-min text-[11px] leading-snug line-clamp-2 [overflow-wrap:anywhere]';

/**
 * A piece inside COMPACT_LINES that is never split (the date, the time, 📌 PINNED, the state): one line, as wide as its words.
 * The block is never narrower than it, so it is drawn whole; `max-w-full truncate` is only the floor's floor, a piece wider
 * than the whole row (none is, at 320 px x 1.3 in the six first languages: market-order-shots.mjs compact-kinds).
 */
export const COMPACT_PIECE = 'inline-block max-w-full truncate align-bottom';

/**
 * The words inside a short line that say more than it: 📌 PINNED (the accent), CANCELLED / ENDED (danger), UPDATED and the
 * viewer's mark (the event violet), at the chip's weight. Inks for words on a card (core's `ink` roles), not a chip's.
 */
export const COMPACT_WORD = {
    pinned: 'font-extrabold text-bp-ink-accent',
    danger: 'font-extrabold text-bp-ink-danger',
    event: 'font-extrabold text-bp-tile-event-ink',
} as const;

/** The viewer's mark ("Going ✓", "Better matches ✓"): the list card's mark weight, 700, in the event violet. */
export const COMPACT_MARK = 'font-bold text-bp-tile-event-ink';

/**
 * The end: the price or the mark, then the type chip, side by side while there is room and the chip under it when not; 45% of
 * the row at most (core's compactEndMaxPercent), so the title keeps its width.
 */
export const COMPACT_END = 'flex flex-wrap items-center justify-end gap-x-2 gap-y-1 ml-3 max-w-[45%]';

/*
 * An event's row (the director's rule for #2904): the when shows whole pieces, wrapping to a second line rather than cutting
 * one; the end, EVENT and the mark, is never cut; the row is a listing's row and one line at most. Beside the words, the end
 * cannot keep that rule at 320 px x 1.3: the words and the end share ~172 px there, and EVENT alone is 100 px in French and
 * 135 in German, where the date is 96 and 90, the time 86 (measured, market-order-shots.mjs compact-kinds). So the end's two
 * parts sit where each has room, both at the row's end:
 *   - COMPACT_EVENT_HEAD, the first line: the title, then EVENT. The title gives way (one line ending in "…" that asks for no
 *     width of its own, COMPACT_TITLE_GIVES); EVENT never does (CHIP's `shrink-0`). The title had the words' width before, so
 *     it keeps at least what it had.
 *   - COMPACT_EVENT_BODY, the two short lines: the when's block (COMPACT_LINES, never narrower than its widest whole piece)
 *     and, 8 apart, the mark, which takes the room the block leaves (COMPACT_EVENT_MARK): its words on up to two lines,
 *     breaking only between words, a word wider than its room ending in "…", the ✓ whole beside them (COMPACT_MARK_GIVES);
 *     12 apart left English's "Interested ✓" 1.2 px short beside "16:00–18:00" (measured). The block takes the room the mark
 *     doesn't want, and the mark gives way, never the when: a floor the flex algorithm freezes at, not a shrink ratio (the
 *     second review of #2904 measured the old ratio, the end's `shrink-[999]` against the words' 1, still taking 0.08 px
 *     from the words, enough for "16:00–18:…").
 */
export const COMPACT_EVENT_TEXT = 'flex-1 min-w-0 flex flex-col';
export const COMPACT_EVENT_HEAD = 'flex items-center gap-3 min-w-0';
export const COMPACT_TITLE_GIVES = 'm-0 flex-1 min-w-0 font-extrabold text-sm text-nature-950 dark:text-white line-clamp-1 break-all';
export const COMPACT_EVENT_BODY = 'flex items-center gap-2 min-w-0';
export const COMPACT_EVENT_MARK = 'flex-initial min-w-0 flex items-end justify-end text-end text-[11px] leading-snug';
export const COMPACT_MARK_GIVES = 'min-w-0 line-clamp-2 break-normal text-ellipsis';

/**
 * The poll's card on the box (slice C1; the table's Poll row): the list card's corners, outline, ground and shadow, a column
 * with 12 of padding (from 16), filling its cell in the grid.
 */
export const POLL_CARD = `relative flex flex-col h-full w-full min-w-0 overflow-hidden rounded-[14px] border shadow-sm hover:shadow-md transition-shadow ${BORDER} ${GROUND} p-3`;

/** The poll's 32 px tile in a compact row: no photo, the poll's own plum ground and the ballot box. */
export const COMPACT_POLL_TILE = 'w-full h-full flex items-center justify-center bg-bp-chip-poll-tint text-base leading-none';

/** The inks on the card ground, light and dark. */
export const CARD_INK = {
    /** A title, a price: the page's own text colour, on the card's own ground. */
    title: 'text-[color:var(--text-primary)]',
    /** The event violet: an event's when, its repeat line, the viewer's mark. */
    event: 'text-bp-tile-event-ink',
    /** The place, the distance, a price's unit, the counts. */
    secondary: 'text-nature-600 dark:text-nature-300',
} as const;

/*
 * The pages (DESIGN-detail-pages-fable.md §2.2, slice DW1 for the event page; the Offer / Need page joins in DW3): the same
 * box, drawn as the page's boxes and buttons. Core's MARKET_CARD_TYPE.page holds the numbers; market-card-shell.test.ts holds
 * these classes to them. The page's words are in rem, so a member's larger text setting (130% at the floor) grows them.
 */

/**
 * A box on a page (the note for people who are going, Remind me, the host's guest list, the person): the card's corners,
 * outline, ground and shadow, with the card's 12 of padding (the style box's §3 row 3: one number for every box).
 */
export const PAGE_BOX = `rounded-[14px] border ${BORDER} ${GROUND} p-3 shadow-sm`;

/**
 * A box's label, in small capitals: 10/800, letter-spaced 1.5, 8 above what it names. The web writes its labels in sentence
 * case and draws the capitals here ("Hosted by", as its "Posted by"). The muted ink is nature-600 / nature-300, not the
 * design's nature-500 / nature-400: 10 px words need 4.5:1, and nature-500 is 3.3:1 on the card ground (nature-600 is 4.9).
 */
const BOX_LABEL_TYPE = 'm-0 mb-2 text-[0.625rem] font-extrabold tracking-[1.5px] uppercase leading-normal';
export const BOX_LABEL = {
    muted: `${BOX_LABEL_TYPE} text-nature-600 dark:text-nature-300`,
    /** The note for people who are going: an event's own words, in the event ink. */
    event: `${BOX_LABEL_TYPE} text-bp-ink-event`,
} as const;

/** A page's button: 48 tall, corners 12, 15/700, a 1.5 px outline. */
const PAGE_BUTTON_TYPE = 'text-[0.9375rem] font-bold leading-tight';
const PAGE_BUTTON_FRAME = `min-h-[48px] px-3 rounded-xl border-[1.5px] ${PAGE_BUTTON_TYPE} cursor-pointer transition-colors `
    + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:opacity-60 disabled:cursor-not-allowed';

/**
 * The event's two answers, on the card (the map's preview) and on the page: chosen = the one event fill with white words in
 * both schemes (core's `event` role); not chosen = the event ink's outline and words on the card ground (`ink.event`).
 */
export const EVENT_ANSWER = {
    chosen: 'bg-bp-event-fill border-bp-event-fill text-bp-event-on hover:bg-bp-event-hover hover:border-bp-event-hover',
    open: `${GROUND} border-bp-ink-event text-bp-ink-event hover:bg-bp-tile-event-tint`,
} as const;

export const PAGE_BUTTON = {
    /** The commit on an event: Edit event, Let in ✓, Save for this event. */
    eventFill: `${PAGE_BUTTON_FRAME} ${EVENT_ANSWER.chosen} focus-visible:ring-bp-ink-event`,
    /** An event's other buttons: Let in, Let everyone in, Copy to a new date. */
    eventOutline: `${PAGE_BUTTON_FRAME} ${EVENT_ANSWER.open} focus-visible:ring-bp-ink-event`,
    /** The quiet row (the chat, Share, Add to calendar) and Remind me's Change: the neutral outline, the page's own words. */
    quiet: `${PAGE_BUTTON_FRAME} ${GROUND} border-nature-300 dark:border-nature-700 text-nature-900 dark:text-white `
        + 'hover:bg-nature-50 dark:hover:bg-nature-800 focus-visible:ring-nature-600 dark:focus-visible:ring-nature-300',
} as const;

/** Going / Interested on the page: the page button's type. The map's preview card keeps the card's own. */
export const PAGE_ANSWER_TYPE = PAGE_BUTTON_TYPE;

/** §2.3 The page's type. */
export const PAGE_TYPE = {
    /** An event's when: 18/900, in the event ink. */
    when: 'text-lg font-black leading-tight',
    /** An event's title: 20/800. */
    title: 'text-xl font-extrabold leading-snug',
    /** The place, the online line: 14/600, the page's own words. */
    place: 'text-sm font-semibold',
    /** The description: 15 on 22. */
    description: 'text-[0.9375rem] leading-[1.375rem]',
    /** A box's note, the counts, the hint lines: 13. */
    note: 'text-[0.8125rem] leading-snug',
    /** "Show on map", "Join": a link in the event ink, the whole 48 px row its target. */
    link: 'text-sm font-bold underline underline-offset-2',
    /** 🚩 Report: 13/700 in the danger ink. */
    report: 'text-[0.8125rem] font-bold',
} as const;

/** The page's inks. */
export const PAGE_INK = {
    /** The page's own words: the place, the description, a box's words. */
    body: 'text-nature-800 dark:text-nature-200',
    /** The clock notes, the counts, the hints: nature-700, because they sit on the page ground too (oat-100, where nature-600 is 4.3:1). */
    secondary: 'text-nature-700 dark:text-nature-300',
    /** The event violet as words: the when, the repeat line, "You're hosting this event", Show on map. */
    event: 'text-bp-ink-event',
    /** 🚩 Report. */
    danger: 'text-bp-ink-danger',
} as const;

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
 * slice W3' puts the event's tile on the same lattice. The compact row joins in its own slice.
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
 * The viewer's own answer on an event tile ("Going ✓"), where a listing's price sits: the foot row's end (`ml-auto`), a loud
 * scrim pill in core's grid price type (13/700). White words on the scrim in both schemes: the event ink there would be
 * dark violet on near black in the light scheme. One line; only a pill wider than the whole foot row ends in "…".
 */
export const GRID_SCRIM_MARK = 'ml-auto inline-block min-w-0 max-w-full whitespace-nowrap overflow-hidden text-ellipsis px-2 py-1 rounded-lg text-[13px] font-bold leading-normal bg-nature-900/90 text-white shadow-md';

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

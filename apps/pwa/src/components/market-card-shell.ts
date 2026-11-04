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
 * or equalises a list card's height. The grid tile and the compact row join in their own slices.
 */

/** §1.1 The list card's frame: corners 14, a 1 px border, the card shadow; the photo and the text sit side by side. */
const LIST_FRAME = 'relative flex flex-row w-full min-w-0 overflow-hidden rounded-[14px] border shadow-sm';

/** The outline, `border.default`. */
const BORDER = 'border-nature-200 dark:border-nature-800';

/** The one card ground: the web's own card token (white; #2a322a in dark), the ground core's contrast test proves inks on. */
const GROUND = 'bg-[var(--bg-card)]';

/** Daily Pulse: a 2 px warning border on the Pulse tile's ground (§1.1 variants). */
const PULSE = 'border-2 border-amber-400/80 dark:border-amber-500/70 bg-bp-tile-pulse-tint shadow-[0_4px_20px_rgba(245,158,11,0.15)]';

/** An Elder's card: a 3 px gold left border (§1.1 variants). */
const ELDER = 'border-l-[3px] border-l-amber-400 shadow-[0_4px_15px_rgba(251,191,36,0.1)]';

/** The list card's outer box. A Pulse card has its own ground and border; an Elder's adds its left border. */
export function listCard({ pulse = false, elder = false }: { pulse?: boolean; elder?: boolean } = {}): string {
    if (pulse) return `${LIST_FRAME} ${PULSE}`;
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
 */
export const CHIP = 'inline-block shrink-0 whitespace-nowrap px-1.5 py-0.5 rounded-md text-[10px] font-extrabold leading-normal tracking-wide';

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

/** The inks on the card ground, light and dark. */
export const CARD_INK = {
    /** A title, a price: the page's own text colour, on the card's own ground. */
    title: 'text-[color:var(--text-primary)]',
    /** The event violet: an event's when, its repeat line, the viewer's mark. */
    event: 'text-bp-tile-event-ink',
    /** The place, the distance, a price's unit, the counts. */
    secondary: 'text-nature-600 dark:text-nature-300',
} as const;

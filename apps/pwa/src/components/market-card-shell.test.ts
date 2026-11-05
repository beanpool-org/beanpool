/**
 * The web's style box holds core's numbers (DESIGN-card-style-box-fable.md §1, slice W2). Tailwind needs whole class names
 * in the source, so market-card-shell.ts writes its numbers out as classes; this reads every number back out of them and
 * holds it to @beanpool/core's MARKET_CARD_SHELL, MARKET_CHIP and MARKET_CARD_TYPE. A number changed in core and not here
 * (or here and not in core) fails.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import postcss, { type AcceptedPlugin } from 'postcss';
import tailwindcss from 'tailwindcss';
import { MARKET_CARD_SHELL, MARKET_CARD_TYPE, MARKET_CHIP, MARKET_GRID_TEXT_BLOCK, MARKET_GRID_TEXT_BLOCK_REM, type CardType } from '@beanpool/core';
import {
    BOX_LABEL, CARD_INK, CHIP, CHIP_SENTENCE, CHIP_TONE, COMPACT_END, COMPACT_EVENT_BODY, COMPACT_EVENT_HEAD, COMPACT_EVENT_MARK, COMPACT_EVENT_TEXT,
    COMPACT_LEAD, COMPACT_LINE, COMPACT_LINES, COMPACT_MARK, COMPACT_MARK_GIVES, COMPACT_PICTURE, COMPACT_PIECE, COMPACT_POLL_TILE, COMPACT_ROW,
    COMPACT_TEXT, COMPACT_TITLE, COMPACT_TITLE_GIVES, COMPACT_WORD, EVENT_ANSWER, GRID, GRID_PHOTO, GRID_PHOTO_CROP, GRID_POLL_CELL, GRID_ROW, GRID_ROW_CHIP,
    GRID_ROW_LABEL, GRID_SCRIM_MARK, GRID_SCRIM_PILL, GRID_TEXT, GRID_TIME_PIECE, GRID_TIME_ROW, GRID_TITLE, GRID_TYPE, LIST_BEAN_PX, LIST_PHOTO, LIST_PHOTO_FILL, LIST_TEXT, LIST_TYPE, PAGE_ANSWER_TYPE, PAGE_BOX, PAGE_BUTTON, PAGE_INK,
    PAGE_TYPE, POLL_CARD, POP_UP, POP_UP_CLOSE, POP_UP_CLOSE_DOT, POP_UP_CLOSE_ROOM, chip, gridChip, gridTile, listCard,
} from './market-card-shell';

const classes = (s: string) => s.split(/\s+/).filter(Boolean);

/**
 * The colour a class string gives a card's LEFT border in one scheme, settled the way the app's built CSS settles it: the
 * app's own tailwind.config.js builds the rules for exactly these classes, and of the rules that set the left side's colour
 * (`border-color` sets every side, `border-left-color` the left) the heaviest selector wins, then the later rule. Under
 * `darkMode: 'selector'` a `dark:` rule is `.dark\:x:where(.dark, .dark *)`, no heavier than a plain `.x`, and Tailwind
 * writes it later, so a `dark:` outline on every side beats a plain left border (#2873). `:is(.dark *)`, Tailwind's
 * form before 3.4.1, would add a class's weight: that is counted too.
 */
async function leftBorder(classString: string, scheme: 'light' | 'dark'): Promise<string | null> {
    const configUrl = pathToFileURL(path.resolve(__dirname, '../../tailwind.config.js')).href;
    const { default: config } = await import(/* @vite-ignore */ configUrl);
    const own = new Set(classes(classString));
    // Tailwind brings its own copy of postcss's types; the plugin is the same object either way.
    const plugin = tailwindcss({ ...config, content: [{ raw: `<div class="${classString}"></div>`, extension: 'html' }] }) as unknown as AcceptedPlugin;
    const { root } = await postcss([plugin])
        .process('@tailwind utilities;', { from: undefined });
    const set: { weight: number; order: number; colour: string }[] = [];
    let order = 0;
    root.walkRules((rule) => {
        order++;
        // One class per rule: `.name` (Tailwind's escapes in it), then what its variant adds.
        const m = rule.selector.match(/^\.((?:\\.|[^\\\s:.()[\]])+)(.*)$/);
        if (!m) return;
        const name = m[1].replace(/\\(.)/g, '$1');
        if (!own.has(name) || (scheme === 'light' && name.startsWith('dark:'))) return;
        const weight = 1 + (/:is\(/.test(m[2]) ? 1 : 0);
        rule.walkDecls(/^border-(left-)?color$/, (d) => {
            const rgb = d.value.match(/^rgb\((\d+) (\d+) (\d+)/);
            if (rgb) set.push({ weight, order, colour: `rgb(${rgb[1]}, ${rgb[2]}, ${rgb[3]})` });
        });
    });
    set.sort((a, b) => a.weight - b.weight || a.order - b.order);
    return set.at(-1)?.colour ?? null;
}

/** Tailwind's spacing scale: 1 unit is 4 px (`p-3` is 12, `px-1.5` is 6, `w-20` is 80). */
function spacing(s: string, prefix: string): number | undefined {
    for (const c of classes(s)) {
        const m = c.match(/^([a-z-]+)-(\d+(?:\.\d+)?)$/);
        if (m && m[1] === prefix) return Number(m[2]) * 4;
    }
    return undefined;
}

const RADIUS: Record<string, number> = { rounded: 4, 'rounded-md': 6, 'rounded-lg': 8, 'rounded-xl': 12, 'rounded-2xl': 16 };
function radius(s: string): number | undefined {
    for (const c of classes(s)) {
        if (c in RADIUS) return RADIUS[c];
        const m = c.match(/^rounded-\[(\d+)px\]$/);
        if (m) return Number(m[1]);
    }
    return undefined;
}

const SIZE: Record<string, number> = { 'text-xs': 12, 'text-sm': 14, 'text-base': 16, 'text-lg': 18 };
const WEIGHT: Record<string, CardType['weight']> = {
    'font-normal': 400, 'font-medium': 500, 'font-semibold': 600, 'font-bold': 700, 'font-extrabold': 800, 'font-black': 900,
};

/** The type a class string sets: size and weight, and the line height when it fixes one in px (`leading-normal` does not). */
function typeOf(s: string): { size?: number; weight?: number; line?: number } {
    let size: number | undefined;
    let weight: number | undefined;
    let line: number | undefined;
    let lineFactor: number | undefined;
    for (const c of classes(s)) {
        if (c in SIZE) size = SIZE[c];
        const px = c.match(/^text-\[(\d+)px\]$/);
        if (px) size = Number(px[1]);
        // The page's words are in rem (a member's larger text grows them): 1 rem is 16 px.
        const rem = c.match(/^text-\[(\d*\.?\d+)rem\]$/);
        if (rem) size = Number(rem[1]) * 16;
        if (c in WEIGHT) weight = WEIGHT[c];
        if (c === 'leading-tight') lineFactor = 1.25;
        if (c === 'leading-snug') lineFactor = 1.375;
        const fixed = c.match(/^leading-(\d+)$/);
        if (fixed) line = Number(fixed[1]) * 4;
        const fixedPx = c.match(/^leading-\[(\d+)px\]$/);
        if (fixedPx) line = Number(fixedPx[1]);
        const fixedRem = c.match(/^leading-\[(\d*\.?\d+)rem\]$/);
        if (fixedRem) line = Number(fixedRem[1]) * 16;
    }
    if (line === undefined && lineFactor !== undefined && size !== undefined) line = size * lineFactor;
    return line === undefined ? { size, weight } : { size, weight, line };
}

const asType = (t: CardType) => (t.line === undefined ? { size: t.size, weight: t.weight } : { size: t.size, weight: t.weight, line: t.line });

describe('the web style box holds core\'s numbers', () => {
    it('the list card: corners 14, a 1 px border, text padding 12', () => {
        for (const card of [listCard(), listCard({ elder: true })]) {
            expect(radius(card)).toBe(MARKET_CARD_SHELL.radius);
            // `border` alone is Tailwind's 1 px.
            expect(classes(card)).toContain('border');
            expect(MARKET_CARD_SHELL.borderWidth).toBe(1);
            expect(card).toContain('overflow-hidden');
        }
        expect(spacing(LIST_TEXT, 'p')).toBe(MARKET_CARD_SHELL.textPadding);
    });

    it('the list photo: 80 wide, the card\'s full height (at least as tall as it is wide), the slot covered', () => {
        expect(spacing(LIST_PHOTO, 'w')).toBe(MARKET_CARD_SHELL.photo.list.width);
        expect(spacing(LIST_PHOTO, 'min-h')).toBe(MARKET_CARD_SHELL.photo.list.width);
        expect(classes(LIST_PHOTO)).toEqual(expect.arrayContaining(['self-stretch', 'shrink-0', 'relative']));
        expect(classes(LIST_PHOTO_FILL)).toEqual(expect.arrayContaining(['absolute', 'inset-0', 'w-full', 'h-full']));
        // No fixed height: a list card takes the height its lines need (Marty, 4 Nov 2026), and the photo follows it.
        expect(classes(LIST_PHOTO).some(c => /^h-/.test(c))).toBe(false);
        expect(classes(listCard()).some(c => /^h-/.test(c))).toBe(false);
    });

    it('the variants: an Elder\'s left border 3, Daily Pulse\'s border 2', () => {
        const elder = classes(listCard({ elder: true })).find(c => /^border-l-\[\d+px\]$/.test(c));
        expect(Number(elder?.match(/\d+/)?.[0])).toBe(MARKET_CARD_SHELL.variant.elderBorderLeft);
        expect(classes(listCard({ pulse: true }))).toContain(`border-${MARKET_CARD_SHELL.variant.pulseBorder}`);
        // Every list card, Pulse too, is on the card ground (the who-line's nature-600 is 4.37:1 on the Pulse tint, under AA),
        // and has one ground class only; a Pulse card has one border colour only.
        for (const card of [listCard(), listCard({ elder: true }), listCard({ pulse: true })]) {
            expect(classes(card).filter(c => c.startsWith('bg-'))).toEqual(['bg-[var(--bg-card)]']);
        }
        expect(classes(listCard({ pulse: true })).filter(c => /^border-(nature|amber)-/.test(c))).toEqual(['border-amber-400/80']);
    });

    it('an Elder\'s left border is gold in light AND in dark, as the built CSS settles it (#2873)', async () => {
        const GOLD = 'rgb(251, 191, 36)'; // amber-400, trust.star
        const OUTLINE_DARK = 'rgb(67, 78, 67)'; // nature-800, the card's outline in dark
        const elder = listCard({ elder: true });
        expect(await leftBorder(elder, 'light')).toBe(GOLD);
        expect(await leftBorder(elder, 'dark')).toBe(GOLD);
        // The check can fail: without the Elder's own dark class (main's pair), the outline takes the left side in dark,
        // as #2873's review measured in Chromium. And a card that is not an Elder's keeps its outline on the left.
        expect(await leftBorder(classes(elder).filter(c => c !== 'dark:border-l-amber-400').join(' '), 'dark')).toBe(OUTLINE_DARK);
        expect(await leftBorder(listCard(), 'dark')).toBe(OUTLINE_DARK);
        expect(await leftBorder(listCard(), 'light')).toBe('rgb(220, 227, 220)'); // nature-200
    }, 30_000);

    it.each([['one-line', CHIP], ['sentence', CHIP_SENTENCE]])('the %s chip: 10/800, 6 across, 2 down, corners 6', (_, c) => {
        expect(typeOf(c)).toEqual(asType(MARKET_CHIP.type));
        expect(spacing(c, 'px')).toBe(MARKET_CHIP.paddingHorizontal);
        expect(spacing(c, 'py')).toBe(MARKET_CHIP.paddingVertical);
        expect(radius(c)).toBe(MARKET_CHIP.radius);
        // Capitals come from the words, never from a class.
        expect(classes(c)).not.toContain('uppercase');
    });

    it('the one-line chip never wraps or shrinks; the sentence chip wraps inside the card', () => {
        expect(classes(CHIP)).toEqual(expect.arrayContaining(['whitespace-nowrap', 'shrink-0']));
        // Never past its row (#2873: "📜 Mindset & Philosophy" ran under the card's edge at 320 x 1.3): no wider than the
        // row, and words longer than that end in an ellipsis inside the chip.
        expect(classes(CHIP)).toEqual(expect.arrayContaining(['max-w-full', 'overflow-hidden', 'text-ellipsis']));
        expect(classes(CHIP_SENTENCE)).toEqual(expect.arrayContaining(['whitespace-normal', 'break-words', 'max-w-full']));
    });

    it.each(Object.keys(LIST_TYPE).filter(k => k in MARKET_CARD_TYPE.list) as (keyof typeof LIST_TYPE & keyof typeof MARKET_CARD_TYPE.list)[])(
        'the list card\'s %s type is core\'s', (role) => {
            expect(typeOf(LIST_TYPE[role])).toEqual(asType(MARKET_CARD_TYPE.list[role] as CardType));
        },
    );

    it('every list type role is one core names', () => {
        for (const role of Object.keys(LIST_TYPE)) expect(MARKET_CARD_TYPE.list).toHaveProperty(role);
    });

    it('the bean sign beside a list price is 14', () => {
        expect(LIST_BEAN_PX).toBe(14);
    });

    it('the map pop-up (M1): the card\'s corners and core\'s floating shadow; a ✕ of 44 to tap, 28 to see, kept clear of the first row', () => {
        expect(radius(POP_UP)).toBe(MARKET_CARD_SHELL.radius);
        const shadow = classes(POP_UP).find(c => c.startsWith('shadow-['))?.match(/^shadow-\[0_(\d+)px_(\d+)px_rgba\(0,0,0,([\d.]+)\)\]$/);
        expect(shadow).toBeTruthy();
        const { offsetY, blur, opacity } = MARKET_CARD_SHELL.floatingShadow;
        expect([Number(shadow![1]), Number(shadow![2]), Number(shadow![3])]).toEqual([offsetY, blur, opacity]);
        expect(classes(POP_UP_CLOSE)).toEqual(expect.arrayContaining(['absolute', 'top-0', 'end-0', 'min-w-[44px]', 'min-h-[44px]', 'focus-visible:ring-2']));
        // Nothing holds the target under 44.
        expect(classes(POP_UP_CLOSE).filter(c => /^(w|h|max-w|max-h)-/.test(c))).toEqual([]);
        expect(spacing(POP_UP_CLOSE_DOT, 'w')).toBe(28);
        expect(spacing(POP_UP_CLOSE_DOT, 'h')).toBe(28);
        // The circle's near edge is its inset (p-1.5) plus 28 from the card's end; the first row stops at the text's padding
        // (12) plus the room: the room must reach past the circle.
        expect(MARKET_CARD_SHELL.textPadding + spacing(POP_UP_CLOSE_ROOM, 'pe')!).toBeGreaterThanOrEqual(spacing(POP_UP_CLOSE, 'p')! + 28);
        // And down: the circle's foot is its inset plus 28 from the card's top; the line under the first row starts at the
        // text's padding plus the row's height at least (all in rem, so it holds at 1.3x text), past the circle's foot.
        expect(MARKET_CARD_SHELL.textPadding + spacing(POP_UP_CLOSE_ROOM, 'min-h')!).toBeGreaterThan(spacing(POP_UP_CLOSE, 'p')! + 28);
    });

    it('every colour is core\'s role or the card token: no raw violet, purple, blue or nature-950', () => {
        const all = [listCard(), listCard({ elder: true }), listCard({ pulse: true }), CHIP, CHIP_SENTENCE, LIST_PHOTO, LIST_TEXT,
            POP_UP, POP_UP_CLOSE, POP_UP_CLOSE_DOT,
            ...Object.values(CHIP_TONE), ...Object.values(LIST_TYPE), ...Object.values(CARD_INK)].join(' ');
        expect(all).not.toMatch(/violet-|purple-|blue-|indigo-|nature-950/);
        for (const tone of Object.values(CHIP_TONE)) expect(tone).toMatch(/^bg-bp-[a-z-]+-tint text-bp-[a-z-]+-ink$/);
        expect(chip('event')).toBe(`${CHIP} ${CHIP_TONE.event}`);
        expect(chip('quiet', true)).toBe(`${CHIP_SENTENCE} ${CHIP_TONE.quiet}`);
    });
});

// G2 (DESIGN-market-grid-sizes-fable.md §2.2 to §2.4): the grid tile on the same box, and the lattice's numbers.
describe('the grid tile holds core\'s numbers', () => {
    /** A `[N rem]` arbitrary value of one prefix (`h-[7.0625rem]`), in rem. */
    const rem = (s: string, prefix: string): number | undefined => {
        for (const c of classes(s)) {
            const m = c.match(/^([a-z-]+)-\[(\d+(?:\.\d+)?)rem\]$/);
            if (m && m[1] === prefix) return Number(m[2]);
        }
        return undefined;
    };

    it('the text block is four rows tall, fixed: 1.5rem + 4 x 1.203125rem + 3 x 0.25rem', () => {
        expect(rem(GRID_TEXT, 'h')).toBe(MARKET_GRID_TEXT_BLOCK_REM);
        expect(MARKET_GRID_TEXT_BLOCK_REM).toBe(7.0625);
        // 12 of padding a side, rows 4 apart, never squeezed by the photo, never spilling.
        expect(spacing(GRID_TEXT, 'p')).toBe(MARKET_CARD_SHELL.textPadding);
        expect(spacing(GRID_TEXT, 'p')! * 2 / 16).toBe(MARKET_GRID_TEXT_BLOCK.paddingRem);
        expect(spacing(GRID_TEXT, 'gap')! / 16).toBe(MARKET_GRID_TEXT_BLOCK.rowGapRem);
        expect(classes(GRID_TEXT)).toEqual(expect.arrayContaining(['flex', 'flex-col', 'shrink-0', 'overflow-hidden']));
    });

    it('a row is exactly one row tall; the title is two of them, and a row of text is text-sm leading-snug', () => {
        expect(rem(GRID_ROW, 'h')).toBe(MARKET_GRID_TEXT_BLOCK.rowHeightRem);
        expect(rem(GRID_TITLE, 'min-h')).toBe(2 * MARKET_GRID_TEXT_BLOCK.rowHeightRem);
        // text-sm is 0.875rem; leading-snug 1.375 of it: 1.203125rem, the row.
        expect(0.875 * 1.375).toBe(MARKET_GRID_TEXT_BLOCK.rowHeightRem);
        expect(classes(GRID_TITLE)).toEqual(expect.arrayContaining(['text-sm', 'leading-snug', 'line-clamp-2']));
        expect(classes(GRID_ROW)).toEqual(expect.arrayContaining(['overflow-hidden', 'whitespace-nowrap', 'shrink-0']));
        // The loud line's size and weight are core's (its line is the row's, above, in rem).
        const { size, weight } = typeOf(GRID_TITLE);
        expect({ size, weight }).toEqual({ size: MARKET_CARD_TYPE.grid.loud.size, weight: MARKET_CARD_TYPE.grid.loud.weight });
    });

    it('the tile: the card\'s corners, border and ground, filling its cell; the photo 4:3 and never squeezed', () => {
        for (const tile of [gridTile(), gridTile({ elder: true }), gridTile({ pulse: true })]) {
            expect(radius(tile)).toBe(MARKET_CARD_SHELL.radius);
            expect(classes(tile)).toEqual(expect.arrayContaining(['h-full', 'flex', 'flex-col', 'overflow-hidden']));
            expect(classes(tile).filter(c => c.startsWith('bg-'))).toEqual(['bg-[var(--bg-card)]']);
        }
        expect(classes(gridTile())).toContain('border');
        expect(classes(gridTile({ elder: true }))).toEqual(expect.arrayContaining(['border-l-[3px]', 'dark:border-l-amber-400']));
        expect(classes(gridTile({ pulse: true }))).toContain(`border-${MARKET_CARD_SHELL.variant.pulseBorder}`);
        const { aspectWidth, aspectHeight } = MARKET_CARD_SHELL.photo.grid;
        expect(classes(GRID_PHOTO)).toEqual(expect.arrayContaining([`aspect-[${aspectWidth}/${aspectHeight}]`, 'shrink-0', 'w-full']));
    });

    it('the gutter is 16; the poll is the whole row at two and three columns, a 2 x 2 from four', () => {
        expect(spacing(GRID, 'gap')).toBe(MARKET_CARD_SHELL.gap.grid);
        expect(classes(GRID)).toEqual(expect.arrayContaining(['grid-flow-row-dense', 'grid-cols-2', 'md:grid-cols-3', 'lg:grid-cols-4', 'xl:grid-cols-5']));
        expect(classes(GRID_POLL_CELL)).toEqual(['h-full', 'col-span-2', 'md:col-span-3', 'lg:col-span-2', 'lg:row-span-2']);
    });

    it('the row chip and the scrim pill: the one chip\'s size, padding and corners; the row chip gives way and ends in an ellipsis', () => {
        for (const c of [GRID_ROW_CHIP, GRID_SCRIM_PILL]) {
            expect(typeOf(c).size).toBe(MARKET_CHIP.type.size);
            expect(spacing(c, 'px')).toBe(MARKET_CHIP.paddingHorizontal);
            expect(spacing(c, 'py')).toBe(MARKET_CHIP.paddingVertical);
            expect(radius(c)).toBe(MARKET_CHIP.radius);
            expect(classes(c)).not.toContain('uppercase');
        }
        expect(typeOf(GRID_ROW_CHIP).weight).toBe(MARKET_CHIP.type.weight);
        expect(classes(GRID_ROW_CHIP)).toEqual(expect.arrayContaining(['min-w-0', 'overflow-hidden', 'text-ellipsis', 'whitespace-nowrap']));
        expect(classes(GRID_ROW_CHIP)).not.toContain('shrink-0');
        expect(gridChip('quiet')).toBe(`${GRID_ROW_CHIP} ${CHIP_TONE.quiet}`);
        // The phone's scrim pill: 10/700, white words on the dark scrim.
        expect(typeOf(GRID_SCRIM_PILL).weight).toBe(700);
        expect(classes(GRID_SCRIM_PILL)).toEqual(expect.arrayContaining(['bg-nature-900/90', 'text-white']));
    });

    // W3': the event tile's own rows and pills (DESIGN-grid-event-rows-fable.md).
    it.each(Object.keys(GRID_TYPE) as (keyof typeof GRID_TYPE)[])('the grid\'s %s type is core\'s in size and weight, and one row tall', (role) => {
        const { size, weight, line } = typeOf(GRID_TYPE[role]);
        const core = MARKET_CARD_TYPE.grid[role] as CardType;
        expect({ size, weight }).toEqual({ size: core.size, weight: core.weight });
        // text-sm leading-snug: 1.203125rem, the row (core's line is the phone's 18).
        expect(line! / 16).toBe(MARKET_GRID_TEXT_BLOCK.rowHeightRem);
    });

    it('the time row is one row tall, wraps its pieces and clips them; a piece is whole and never shrinks', () => {
        expect(rem(GRID_TIME_ROW, 'h')).toBe(MARKET_GRID_TEXT_BLOCK.rowHeightRem);
        expect(classes(GRID_TIME_ROW)).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'content-start', 'overflow-hidden', 'shrink-0', 'min-w-0']));
        // No gap: the dash is the end piece's own, so the span reads "10:26–14:26" whole.
        expect(classes(GRID_TIME_ROW).some(c => /^gap-/.test(c))).toBe(false);
        expect(classes(GRID_TIME_PIECE)).toEqual(expect.arrayContaining(['shrink-0', 'whitespace-nowrap', 'max-w-full']));
        expect(classes(GRID_TIME_PIECE)).not.toContain('min-w-0');
    });

    it('the mark pill: the scrim pill\'s size, padding and corners, white on the scrim at the foot row\'s end, one line', () => {
        expect(typeOf(GRID_SCRIM_MARK)).toEqual(typeOf(GRID_SCRIM_PILL));
        expect(typeOf(GRID_SCRIM_MARK).size).toBe(MARKET_CHIP.type.size);
        expect(spacing(GRID_SCRIM_MARK, 'px')).toBe(MARKET_CHIP.paddingHorizontal);
        expect(spacing(GRID_SCRIM_MARK, 'py')).toBe(MARKET_CHIP.paddingVertical);
        expect(radius(GRID_SCRIM_MARK)).toBe(MARKET_CHIP.radius);
        expect(classes(GRID_SCRIM_MARK)).toEqual(expect.arrayContaining(['ml-auto', 'bg-nature-900/90', 'text-white', 'whitespace-nowrap', 'max-w-full', 'text-ellipsis']));
        expect(classes(GRID_SCRIM_MARK)).not.toContain('uppercase');
    });

    it('a row\'s leading label: the one chip\'s type, whole, never shrunk', () => {
        expect(typeOf(GRID_ROW_LABEL)).toEqual(asType(MARKET_CHIP.type));
        expect(classes(GRID_ROW_LABEL)).toEqual(expect.arrayContaining(['shrink-0', 'max-w-full', 'whitespace-nowrap', 'text-ellipsis']));
    });

    it('the grid photo\'s crop is core\'s focus', () => {
        const { cropX, cropY } = MARKET_CARD_SHELL.photo.grid;
        expect(GRID_PHOTO_CROP.objectPosition).toBe(`${cropX}% ${cropY}%`);
    });

    it('no raw violet, purple, blue or nature-950 in the grid\'s classes', () => {
        const all = [GRID, GRID_POLL_CELL, gridTile(), gridTile({ elder: true }), gridTile({ pulse: true }), GRID_PHOTO, GRID_TEXT,
            GRID_TITLE, GRID_ROW, GRID_ROW_CHIP, GRID_SCRIM_PILL, GRID_SCRIM_MARK, GRID_ROW_LABEL, GRID_TIME_ROW, GRID_TIME_PIECE, ...Object.values(GRID_TYPE)].join(' ');
        expect(all).not.toMatch(/violet-|purple-|blue-|indigo-|nature-950/);
    });
});

describe('the page\'s parts hold core\'s numbers too (DESIGN-detail-pages-fable.md §2.2, slice DW1)', () => {
    const page = MARKET_CARD_TYPE.page;

    it('a page box: the card\'s corners 14, its 1 px outline, its ground and shadow, its 12 of padding', () => {
        expect(radius(PAGE_BOX)).toBe(MARKET_CARD_SHELL.radius);
        expect(classes(PAGE_BOX)).toEqual(expect.arrayContaining(['border', 'border-nature-200', 'dark:border-nature-800', 'bg-[var(--bg-card)]', 'shadow-sm']));
        expect(spacing(PAGE_BOX, 'p')).toBe(MARKET_CARD_SHELL.textPadding);
    });

    it.each(Object.entries(BOX_LABEL))('the %s box label: 10/800, letter-spaced 1.5, 8 above what it names', (_, label) => {
        expect(typeOf(label)).toEqual(asType(page.boxLabel));
        expect(classes(label)).toContain(`tracking-[${page.boxLabelSpacing}px]`);
        expect(spacing(label, 'mb')).toBe(8);
    });

    it('a page button: 48 tall, corners 12, 15/700; Going / Interested on the page are the same type', () => {
        for (const b of Object.values(PAGE_BUTTON)) {
            expect(classes(b)).toContain(`min-h-[${page.buttonHeight}px]`);
            expect(radius(b)).toBe(page.buttonRadius);
            const { size, weight } = typeOf(b);
            expect({ size, weight }).toEqual({ size: page.button.size, weight: page.button.weight });
        }
        const { size, weight } = typeOf(PAGE_ANSWER_TYPE);
        expect({ size, weight }).toEqual({ size: page.button.size, weight: page.button.weight });
    });

    it('the description is 15 on 22', () => {
        expect(typeOf(PAGE_TYPE.description)).toEqual({ size: page.descriptionSize, weight: undefined, line: page.descriptionLine });
    });

    it('every page colour is core\'s role or the card\'s own ground and inks: no raw violet, purple, blue or nature-950', () => {
        const all = [PAGE_BOX, ...Object.values(BOX_LABEL), ...Object.values(PAGE_BUTTON), ...Object.values(EVENT_ANSWER),
            ...Object.values(PAGE_TYPE), ...Object.values(PAGE_INK)].join(' ');
        expect(all).not.toMatch(/violet-|purple-|blue-|indigo-|nature-950/);
        // The event's colours are core's event roles: the fill under white words, and the ink as words and outline.
        expect(classes(EVENT_ANSWER.chosen)).toEqual(expect.arrayContaining(['bg-bp-event-fill', 'text-bp-event-on', 'hover:bg-bp-event-hover']));
        expect(classes(EVENT_ANSWER.open)).toEqual(expect.arrayContaining(['border-bp-ink-event', 'text-bp-ink-event', 'bg-[var(--bg-card)]']));
        expect(PAGE_INK.event).toBe('text-bp-ink-event');
    });
});

// C1 (DESIGN-card-style-box-fable.md §1.3, §2): the compact row every kind draws (a listing, an event, a poll), and the poll's
// card. The row's 16 either side and corners 12 are the web listing row's own (kept by the brief: "Listing compact rows
// unchanged except the chip"); every other number is core's.
describe('the compact row and the poll card hold core\'s numbers (C1)', () => {
    it('the row: 10 above and below; the picture 32 square, corners 8; a listing\'s end 45% of the row at most; an event\'s end where it fits', () => {
        expect(spacing(COMPACT_ROW, 'py')).toBe(MARKET_CARD_SHELL.compactPadding.vertical);
        expect(spacing(COMPACT_PICTURE, 'w')).toBe(MARKET_CARD_SHELL.photo.compact.size);
        expect(spacing(COMPACT_PICTURE, 'h')).toBe(MARKET_CARD_SHELL.photo.compact.size);
        expect(radius(COMPACT_PICTURE)).toBe(MARKET_CARD_SHELL.photo.compact.radius);
        expect(classes(COMPACT_PICTURE)).toEqual(expect.arrayContaining(['overflow-hidden', 'shrink-0']));
        expect(classes(COMPACT_END)).toContain(`max-w-[${MARKET_CARD_SHELL.compactEndMaxPercent}%]`);
        // An event's row (the director's rule for #2904: the when's pieces whole, wrapping rather than cut; EVENT and the mark
        // never cut; a listing's row and one line at most). EVENT sits on the title's line, beside a title that gives way and
        // asks for no width (flex-1, min-w-0, break-all), never shrinking (CHIP's shrink-0); 45% would cut "VERANSTALTUNG".
        // The when's block beside the mark is never narrower than its widest whole piece (min-w-min, a floor the flex
        // algorithm freezes at, not a share of a shortfall: the second review measured `shrink-[999]` against 1 still taking
        // 0.08 px from the words, enough for "16:00–18:…"); the words between the pieces break anywhere they must, so only a
        // whole piece sets that floor. The mark takes what is left (flex-initial, min-w-0): its words on two lines, then "…".
        expect(classes(COMPACT_EVENT_HEAD)).toEqual(expect.arrayContaining(['flex', 'items-center', 'min-w-0']));
        expect(classes(COMPACT_TITLE_GIVES)).toEqual(expect.arrayContaining(['flex-1', 'min-w-0', 'line-clamp-1', 'break-all']));
        expect(classes(CHIP)).toContain('shrink-0');
        expect(classes(COMPACT_EVENT_TEXT)).toEqual(expect.arrayContaining(['flex-1', 'min-w-0', 'flex', 'flex-col']));
        expect(classes(COMPACT_EVENT_BODY)).toEqual(expect.arrayContaining(['flex', 'items-center', 'min-w-0']));
        expect(classes(COMPACT_LINES)).toEqual(expect.arrayContaining(['flex-1', 'min-w-min', '[overflow-wrap:anywhere]']));
        expect(classes(COMPACT_LINES)).not.toContain('min-w-0');
        expect(classes(COMPACT_EVENT_MARK)).toEqual(expect.arrayContaining(['flex-initial', 'min-w-0']));
        expect(classes(COMPACT_EVENT_MARK).some(c => c.startsWith('max-w-'))).toBe(false);
        expect(classes(COMPACT_MARK_GIVES)).toEqual(expect.arrayContaining(['min-w-0', 'line-clamp-2', 'break-normal', 'text-ellipsis']));
        // A whole piece is one line that never breaks; the block of short lines stops at two.
        expect(classes(COMPACT_PIECE)).toEqual(expect.arrayContaining(['inline-block', 'truncate', 'max-w-full']));
        expect(classes(COMPACT_LINES)).toContain('line-clamp-2');
        // `block` would beat line-clamp's display in the built CSS (measured: the block never stopped at two lines).
        expect(classes(COMPACT_LINES)).not.toContain('block');
        expect(typeOf(`${COMPACT_LINES} font-medium`)).toEqual(typeOf(`${COMPACT_LINE} font-medium`));
        // The words give way before the end does; the row is one line of things, side by side.
        expect(classes(COMPACT_LEAD)).toEqual(expect.arrayContaining(['min-w-0', 'flex-1']));
        expect(classes(COMPACT_TEXT)).toEqual(expect.arrayContaining(['min-w-0', 'flex-1']));
        expect(classes(COMPACT_ROW)).toEqual(expect.arrayContaining(['flex', 'flex-row', 'items-center', 'overflow-hidden', 'w-full']));
    });

    it('the type: the title 14/800 on one line; a short line 11/500 on one line', () => {
        expect(typeOf(COMPACT_TITLE)).toEqual({ size: MARKET_CARD_TYPE.compact.title.size, weight: MARKET_CARD_TYPE.compact.title.weight });
        expect(classes(COMPACT_TITLE)).toContain('truncate');
        // A short line's weight is its use's (`font-medium` for the quiet ones, `font-bold` for the when), so the base is size only.
        expect(typeOf(`${COMPACT_LINE} font-medium`).size).toBe(MARKET_CARD_TYPE.compact.line.size);
        expect(typeOf(`${COMPACT_LINE} font-medium`).weight).toBe(MARKET_CARD_TYPE.compact.line.weight);
        expect(classes(COMPACT_LINE).some(c => c in WEIGHT)).toBe(false);
        expect(classes(COMPACT_LINE)).toEqual(expect.arrayContaining(['block', 'min-w-0', 'truncate']));
        // The mark and the words in a line say more at the list card's weights: the mark 700, PINNED and the state the chip's 800.
        expect(typeOf(COMPACT_MARK).weight).toBe(MARKET_CARD_TYPE.list.mark.weight);
        for (const w of Object.values(COMPACT_WORD)) expect(typeOf(w).weight).toBe(MARKET_CHIP.type.weight);
    });

    it('the poll card: the card\'s corners 14, its 1 px outline, ground and shadow, 12 of padding (from 16)', () => {
        expect(radius(POLL_CARD)).toBe(MARKET_CARD_SHELL.radius);
        expect(classes(POLL_CARD)).toEqual(expect.arrayContaining(['border', 'bg-[var(--bg-card)]', 'shadow-sm', 'overflow-hidden']));
        expect(spacing(POLL_CARD, 'p')).toBe(MARKET_CARD_SHELL.textPadding);
        expect(classes(POLL_CARD).filter(c => c.startsWith('bg-'))).toEqual(['bg-[var(--bg-card)]']);
    });

    it('every colour on a row or the poll card is core\'s role or the card\'s: no raw violet, purple, blue or indigo', () => {
        const all = [COMPACT_ROW, COMPACT_LEAD, COMPACT_PICTURE, COMPACT_TEXT, COMPACT_TITLE, COMPACT_LINE, COMPACT_LINES, COMPACT_PIECE, COMPACT_MARK,
            COMPACT_END, COMPACT_EVENT_TEXT, COMPACT_EVENT_HEAD, COMPACT_EVENT_BODY, COMPACT_EVENT_MARK, COMPACT_TITLE_GIVES, COMPACT_MARK_GIVES,
            COMPACT_POLL_TILE, POLL_CARD, ...Object.values(COMPACT_WORD)].join(' ');
        expect(all).not.toMatch(/violet-|purple-|blue-|indigo-/);
        expect(COMPACT_POLL_TILE).toContain('bg-bp-chip-poll-tint');
        expect(COMPACT_WORD).toEqual({
            pinned: 'font-extrabold text-bp-ink-accent', danger: 'font-extrabold text-bp-ink-danger', event: 'font-extrabold text-bp-tile-event-ink',
        });
    });
});

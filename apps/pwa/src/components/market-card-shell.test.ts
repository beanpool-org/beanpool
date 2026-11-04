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
import { MARKET_CARD_SHELL, MARKET_CARD_TYPE, MARKET_CHIP, type CardType } from '@beanpool/core';
import { CARD_INK, CHIP, CHIP_SENTENCE, CHIP_TONE, LIST_BEAN_PX, LIST_PHOTO, LIST_PHOTO_FILL, LIST_TEXT, LIST_TYPE, POP_UP, POP_UP_CLOSE, POP_UP_CLOSE_DOT, POP_UP_CLOSE_ROOM, chip, listCard } from './market-card-shell';

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
        if (c in WEIGHT) weight = WEIGHT[c];
        if (c === 'leading-tight') lineFactor = 1.25;
        if (c === 'leading-snug') lineFactor = 1.375;
        const fixed = c.match(/^leading-(\d+)$/);
        if (fixed) line = Number(fixed[1]) * 4;
        const fixedPx = c.match(/^leading-\[(\d+)px\]$/);
        if (fixedPx) line = Number(fixedPx[1]);
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

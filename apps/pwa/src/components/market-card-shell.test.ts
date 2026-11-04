/**
 * The web's style box holds core's numbers (DESIGN-card-style-box-fable.md §1, slice W2). Tailwind needs whole class names
 * in the source, so market-card-shell.ts writes its numbers out as classes; this reads every number back out of them and
 * holds it to @beanpool/core's MARKET_CARD_SHELL, MARKET_CHIP and MARKET_CARD_TYPE. A number changed in core and not here
 * (or here and not in core) fails.
 */
import { describe, expect, it } from 'vitest';
import { MARKET_CARD_SHELL, MARKET_CARD_TYPE, MARKET_CHIP, type CardType } from '@beanpool/core';
import { CARD_INK, CHIP, CHIP_SENTENCE, CHIP_TONE, LIST_BEAN_PX, LIST_PHOTO, LIST_PHOTO_FILL, LIST_TEXT, LIST_TYPE, chip, listCard } from './market-card-shell';

const classes = (s: string) => s.split(/\s+/).filter(Boolean);

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
        // One ground per card: the Pulse tile's, or the card token, never both.
        expect(listCard({ pulse: true })).not.toContain('--bg-card');
        expect(listCard()).toContain('bg-[var(--bg-card)]');
    });

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

    it('every colour is core\'s role or the card token: no raw violet, purple, blue or nature-950', () => {
        const all = [listCard(), listCard({ elder: true }), listCard({ pulse: true }), CHIP, CHIP_SENTENCE, LIST_PHOTO, LIST_TEXT,
            ...Object.values(CHIP_TONE), ...Object.values(LIST_TYPE), ...Object.values(CARD_INK)].join(' ');
        expect(all).not.toMatch(/violet-|purple-|blue-|indigo-|nature-950/);
        for (const tone of Object.values(CHIP_TONE)) expect(tone).toMatch(/^bg-bp-[a-z-]+-tint text-bp-[a-z-]+-ink$/);
        expect(chip('event')).toBe(`${CHIP} ${CHIP_TONE.event}`);
        expect(chip('quiet', true)).toBe(`${CHIP_SENTENCE} ${CHIP_TONE.quiet}`);
    });
});

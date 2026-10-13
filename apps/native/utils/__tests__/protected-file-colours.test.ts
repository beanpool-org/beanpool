import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrastRatio } from '@beanpool/core';
import { darkColors, lightColors, palette } from '../../constants/colors';

/**
 * map.tsx, GlobalHeader.tsx, UnifiedMapPin.tsx and Map.web.tsx are protected: only Marty edits them. They still read
 * colour tokens, so a change in constants/colors.ts or in @beanpool/core's brand-colours.ts repaints them unseen. In
 * #1904 dark `brand.dark` went from emerald-600 to emerald-400 and the map's category chip and Reach chooser became
 * white on mint, 1.92:1, through a file nobody could open (review of #1904, finding 1).
 *
 * So every pair those files draw from a token is listed here, and fails when it reads worse than it did on main before
 * the shared colour library (1ab6a993). Every token they read must be in a pair or in GROUNDS_AND_LINES, so a new one
 * cannot slip past. A change that trips this needs Marty's look at the protected screen, or his edit to it.
 */
const NATIVE_ROOT = join(__dirname, '..', '..');
const PROTECTED = ['app/(tabs)/map.tsx', 'components/GlobalHeader.tsx', 'components/UnifiedMapPin.tsx', 'components/Map.web.tsx'];

/** Each token's [light, dark] value on main at 1ab6a993, before the library. */
const MAIN: Record<string, readonly [string, string]> = {
    'action.fab': ['#ea580c', '#f97316'],
    'feedback.info.solid': ['#3b82f6', '#3b82f6'],
    'feedback.danger.solid': ['#ef4444', '#ef4444'],
    'feedback.danger.fg': ['#b91c1c', '#f87171'],
    'feedback.danger.bg': ['#fef2f2', '#450a0a'],
    'feedback.warning.fg': ['#b45309', '#fbbf24'],
    'feedback.warning.bg': ['#fffbeb', '#451a03'],
    'feedback.warning.solid': ['#f59e0b', '#f59e0b'],
    'feedback.success.solid': ['#10b981', '#10b981'],
    'brand.primary': ['#10b981', '#10b981'],
    'brand.dark': ['#059669', '#059669'],
    'accent.primary': ['#4f46e5', '#818cf8'],
    'surface.card': ['#ffffff', '#1a1a1a'],
    'surface.app': ['#faf9f6', '#0a0a0a'],
    'surface.subtle': ['#f1efea', '#262626'],
    'text.heading': ['#1c1d1a', '#ffffff'],
    'text.body': ['#2d2f2a', '#f3f4f6'],
    'text.secondary': ['#6b6d66', '#9ca3af'],
    'text.muted': ['#a0a29a', '#6b7280'],
};

/** A pair a protected screen draws: `ink` (words, an icon, a dot, a line) on `ground`. A token path or a fixed hex. */
interface Pair {
    at: string;
    ink: string;
    ground: string;
}

const text = (token: string): Pair[] =>
    ['surface.card', 'surface.app', 'surface.subtle'].map((ground) => ({ at: `map.tsx ${token} words on ${ground}`, ink: token, ground }));

const PAIRS: Pair[] = [
    { at: 'map.tsx:348 + ADD POST, white on the floating button', ink: '#ffffff', ground: 'action.fab' },
    { at: 'map.tsx:351 the pin-drop banner, white on blue', ink: '#ffffff', ground: 'feedback.info.solid' },
    { at: 'map.tsx:376 the validation toast, white on red', ink: '#ffffff', ground: 'feedback.danger.solid' },
    { at: 'map.tsx:381 the required-field *', ink: 'feedback.danger.solid', ground: 'surface.card' },
    { at: "map.tsx:1087 a missing field's red border", ink: 'feedback.danger.solid', ground: 'surface.app' },
    { at: 'map.tsx:408/438/1371/1662 green words: category tick, pricing tip, author, (100% community owned)', ink: 'brand.primary', ground: 'surface.card' },
    { at: 'map.tsx:488/499 the Reach chooser and :1253 the category chip, white on brand.dark', ink: '#ffffff', ground: 'brand.dark' },
    { at: 'map.tsx:417/476 the price tip pill and the cash nudge', ink: 'feedback.warning.fg', ground: 'feedback.warning.bg' },
    { at: 'map.tsx:475 the cash checkbox, white tick on gold', ink: '#ffffff', ground: 'feedback.warning.solid' },
    { at: 'map.tsx:1661 Learn more ⓘ in gold', ink: 'feedback.warning.solid', ground: 'surface.card' },
    ...text('text.heading'),
    ...text('text.body'),
    ...text('text.secondary'),
    ...text('text.muted'),
    { at: 'GlobalHeader.tsx:412 the status dot, offline, in its white ring', ink: 'feedback.danger.solid', ground: '#ffffff' },
    { at: 'GlobalHeader.tsx:412 the status dot, guest, in its white ring', ink: 'feedback.warning.solid', ground: '#ffffff' },
    { at: 'GlobalHeader.tsx:412 the status dot, online, in its white ring', ink: 'feedback.success.solid', ground: '#ffffff' },
    { at: 'GlobalHeader.tsx:426-430 the no-community pill', ink: 'feedback.danger.fg', ground: 'feedback.danger.bg' },
    { at: 'GlobalHeader.tsx:427-430 the guest pill', ink: 'feedback.warning.fg', ground: 'feedback.warning.bg' },
    // Over the header photo under a 50 % black scrim (:393); judged on the scrim's black.
    { at: 'GlobalHeader.tsx:482 the Settings icon while on Settings', ink: 'accent.primary', ground: '#000000' },
];

/** Tokens a protected file reads that carry no words of their own: lines, and grounds already judged in a pair above. */
const GROUNDS_AND_LINES: Record<string, string> = {
    'border.default': 'dividers and input borders',
    'border.strong': 'the sheet handle and checkbox borders',
    'feedback.warning.border': "the tip pill's and guest pill's outline",
    'feedback.danger.border': "the no-community pill's outline",
    'surface.page': "the map tab's page ground (transparent under the doodle pattern)",
    'market.offer.bg': "the tile behind a photo-less Offer's colour emoji (map.tsx:1340); no words on it",
    'market.need.bg': "the tile behind a photo-less Need's colour emoji (map.tsx:1340); no words on it",
};

/** Palette steps a protected file reads straight: fixed Tailwind steps, the same as on main. */
const PALETTE_ON_MAIN: Record<string, string> = {
    amber700: '#b45309', // map.tsx:1496 "Contributions First" on a pale amber box
};

/**
 * Pairs that read worse than on main and wait for Marty's edit to the protected file; `floor` is what they reach now,
 * so they cannot get worse still. Both are `feedback.danger.solid` used as a line or a glyph on the dark sheet, where
 * one token cannot be both the deep fill under white words (the toast, :376) and a red that reads on near-black.
 */
const AWAITING_MARTY: Record<string, { floor: number; fix: string }> = {
    'dark map.tsx:381 the required-field *': { floor: 2.69, fix: 'map.tsx:381 requiredStar color → colors.feedback.danger.fg (9.17 on the card)' },
    "dark map.tsx:1087 a missing field's red border": { floor: 3.06, fix: 'map.tsx:1087 borderColor/shadowColor → colors.feedback.danger.fg (10.43)' },
};

const THEMES = [
    ['light', lightColors, 0],
    ['dark', darkColors, 1],
] as const;

function resolve(tree: unknown, token: string): string {
    if (token.startsWith('#')) return token;
    const value = token.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], tree);
    if (typeof value !== 'string') throw new Error(`colors.${token} is not a colour`);
    return value;
}

function onMain(token: string, theme: 0 | 1): string {
    if (token.startsWith('#')) return token;
    const pair = MAIN[token];
    if (!pair) throw new Error(`no main value recorded for ${token}`);
    return pair[theme];
}

const CASES = THEMES.flatMap(([name, tree, index]) =>
    PAIRS.map((p) => {
        const now = contrastRatio(resolve(tree, p.ink), resolve(tree, p.ground));
        const main = contrastRatio(onMain(p.ink, index), onMain(p.ground, index));
        return { key: `${name} ${p.at}`, now, main, ink: resolve(tree, p.ink), ground: resolve(tree, p.ground) };
    }),
);

describe('the protected files read every colour token at least as well as on main', () => {
    it.each(CASES.map((c) => [c.key, c] as const))('%s', (_key, c) => {
        const waiting = AWAITING_MARTY[c.key];
        const floor = waiting ? Math.min(waiting.floor, c.main) : c.main;
        expect(
            Number(c.now.toFixed(2)),
            `${c.ink} on ${c.ground} is ${c.now.toFixed(2)}:1; on main it was ${c.main.toFixed(2)}:1. This file is protected: ` +
                'give the token a value that reads no worse here, or ask Marty to point the screen at another token',
        ).toBeGreaterThanOrEqual(Number(floor.toFixed(2)));
    });

    it('lists only pairs that still wait for Marty (remove one once it reads as well as on main)', () => {
        for (const [key, { fix }] of Object.entries(AWAITING_MARTY)) {
            const c = CASES.find((x) => x.key === key);
            expect(c, `AWAITING_MARTY names no pair: ${key}`).toBeDefined();
            expect(c!.now, `${key} now reads ${c!.now.toFixed(2)} (main ${c!.main.toFixed(2)}): drop it from AWAITING_MARTY (${fix})`).toBeLessThan(c!.main);
        }
    });

    it('covers every token the protected files read', () => {
        const judged = new Set(PAIRS.flatMap((p) => [p.ink, p.ground]).filter((t) => !t.startsWith('#')));
        for (const file of PROTECTED) {
            const src = readFileSync(join(NATIVE_ROOT, file), 'utf8');
            for (const m of src.matchAll(/\b(lightColors|darkColors)\./g)) {
                throw new Error(`${file} reads ${m[1]} directly; give it a pair here that resolves through that set`);
            }
            for (const m of src.matchAll(/\bcolors\.([a-zA-Z]+(?:\.[a-zA-Z]+)+)/g)) {
                expect(judged.has(m[1]) || m[1] in GROUNDS_AND_LINES, `${file} reads colors.${m[1]}: add the pair it draws to PAIRS`).toBe(true);
            }
            for (const m of src.matchAll(/\bpalette\.([a-zA-Z0-9]+)/g)) {
                expect(PALETTE_ON_MAIN[m[1]], `${file} reads palette.${m[1]}: record main's value in PALETTE_ON_MAIN`).toBeDefined();
                expect(palette[m[1] as keyof typeof palette], `palette.${m[1]} changed under ${file}`).toBe(PALETTE_ON_MAIN[m[1]]);
            }
        }
    });
});

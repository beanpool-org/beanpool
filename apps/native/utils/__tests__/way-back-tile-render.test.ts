// @vitest-environment jsdom
/**
 * The way back's tiles drawn (components/welcome/WayBackTile.tsx, slice S4 of DESIGN-onboarding-home-landing-fable.md §3.1 E):
 * in every colour set as the onboarding screens draw it (light, Classic dark, Dark: app/ThemeContext.tsx useOnboardingColors),
 * at 320 dp with 1.3× text, in English and in the longest drafted language. The title and the line readable as words (4.5:1)
 * on the tile, the tile's edge seen against the card (3:1), › beside the words, a 48 dp target or more, one button for a
 * screen reader that reads its own words, and a tap that only calls back.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppColors } from '../../constants/colors';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { button: 'button' };
    const flat = (style: unknown): Record<string, unknown> => Object.assign({}, ...[style].flat(4).filter(Boolean));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityHint, accessibilityRole, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityHint) attrs['data-hint'] = accessibilityHint;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (testID) attrs['data-testid'] = testID;
        attrs['data-style'] = JSON.stringify(flat(props.style));
        return createElement(tag, attrs, children);
    };
    return { View: el('div'), Text: el('span'), Pressable: el('button'), StyleSheet: { create: (s: unknown) => s } };
});
vi.mock('@expo/vector-icons', () => ({
    MaterialCommunityIcons: ({ name, color, size }: { name: string; color: string; size: number }) => createElement('i', { 'data-icon': name, 'data-color': color, 'data-size': size }),
}));
const theme = vi.hoisted(() => ({ set: 'light' as string }));
vi.mock('../../app/ThemeContext', async () => {
    const { onboardingColors } = await import('../onboarding-colors');
    return { useOnboardingColors: () => onboardingColors(theme.set as never) };
});

const { WayBackTile } = await import('../../components/welcome/WayBackTile');
const { onboardingColors } = await import('../onboarding-colors');
const { BRAND_SETS } = await import('@beanpool/core');

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});
function draw(node: ReactNode) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(node as Parameters<Root['render']>[0]); });
}
const styleOf = (e: Element | null) => JSON.parse(e?.getAttribute('data-style') ?? '{}') as Record<string, any>;

function contrast(fg: string, bg: string): number {
    const lum = (hex: string) => {
        const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
            .map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [a, b] = [lum(fg), lum(bg)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const TILES = [
    { title: 'Link a sign-in', line: 'Google, Apple or Facebook' },
    { title: 'Write down 12 words', line: 'On paper, kept safe' },
];

describe('the way back\'s tiles in every colour set the onboarding screens draw', () => {
    for (const set of BRAND_SETS) {
        it(`${set}: the words readable on the tile, its edge seen on the card, › beside them, one button`, () => {
            theme.set = set;
            const colors = onboardingColors(set as never).colors as AppColors;
            for (const tile of TILES) {
                const tapped = vi.fn();
                draw(createElement(WayBackTile, { ...tile, onPress: tapped, hint: 'Shows the twelve words that can restore your account', testID: 'tile' }));
                const button = host!.querySelector('[data-testid="tile"]') as HTMLElement;
                expect(button.getAttribute('role')).toBe('button');
                // No label of its own: a screen reader reads the words drawn, in the member's language, as one button.
                expect(button.getAttribute('aria-label')).toBeNull();
                expect(button.textContent).toBe(tile.title + tile.line);
                const ground = styleOf(button).backgroundColor as string;
                expect(ground).toBe(colors.surface.subtle);
                const [title, line] = Array.from(button.querySelectorAll('span'));
                expect(contrast(styleOf(title).color, ground), `${set}: title on the tile`).toBeGreaterThanOrEqual(4.5);
                expect(contrast(styleOf(line).color, ground), `${set}: line on the tile`).toBeGreaterThanOrEqual(4.5);
                // The edge is the onboarding's strong border, as on the screen's other outlined buttons: raised to 3:1 on the
                // card in the dark sets (onboarding-colors.ts). In light it is faint (as every outline there), so the tile is
                // told apart by what is checked here too: its sunken ground, its 4.5:1 words and its 3:1 ›.
                expect(styleOf(button).borderColor).toBe(colors.border.strong);
                if (set !== 'light') expect(contrast(styleOf(button).borderColor, colors.surface.card), `${set}: the tile's edge on the card`).toBeGreaterThanOrEqual(3);
                expect(ground, `${set}: the tile's ground is not the card's`).not.toBe(colors.surface.card);
                const chevron = button.querySelector('i')!;
                expect(chevron.getAttribute('data-icon')).toBe('chevron-right');
                expect(contrast(chevron.getAttribute('data-color')!, ground), `${set}: › on the tile`).toBeGreaterThanOrEqual(3);
                expect(styleOf(button).minHeight).toBeGreaterThanOrEqual(48);
                act(() => { button.click(); });
                expect(tapped).toHaveBeenCalledTimes(1);
                act(() => root?.unmount());
                host?.remove();
                root = null;
            }
        });
    }
});

// 320 dp at 1.3×: the card's line is 320 less the screen's and the card's 24 dp a side, less the tile's own 16 dp a side and
// › (24) with its 8 dp gap. The words column wraps (flex 1, shrinks): what must fit is the widest word, at 0.62 em a letter.
describe('320 dp with 1.3× text: the words wrap beside ›, in English and in every drafted language', () => {
    const LINE = 320 - 2 * 24 - 2 * 24 - 2 * 16 - 24 - 8;
    // A line breaks at a space, and anywhere in Chinese and Japanese, which wrap between characters (no spaces there).
    const widest = (text: string) => text.split(/[\s\u3000-\u9fff\uff00-\uffef]+/).reduce((a, w) => (w.length > a.length ? w : a), '');
    const widthOf = (word: string, font: number) => Array.from(word).length * 0.62 * font * 1.3;

    it('the words column shrinks and wraps; › keeps its place', () => {
        theme.set = 'light';
        draw(createElement(WayBackTile, { ...TILES[0], onPress: () => {} }));
        const column = host!.querySelector('button > div') as HTMLElement;
        expect(styleOf(column)).toMatchObject({ flex: 1, flexShrink: 1 });
        expect(styleOf(host!.querySelector('button'))).toMatchObject({ flexDirection: 'row', alignItems: 'center' });
    });

    it('every word of the tiles fits the line, in every catalogue', () => {
        const dir = path.join(__dirname, '..', '..', 'words');
        const catalogs = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<string, unknown>);
        const keys: Array<[string, number]> = [['Link a sign-in', 16], ['Write down 12 words', 16], ['Google, Apple or Facebook', 13], ['Google or Facebook', 13], ['On paper, kept safe', 13]];
        for (const [english, font] of keys) {
            for (const text of [english, ...catalogs.map((c) => c[english]).filter((x): x is string => typeof x === 'string')]) {
                const word = widest(text);
                expect(widthOf(word, font), `"${word}" (${text}) at ${font}`).toBeLessThanOrEqual(LINE);
            }
        }
        // Every catalogue has the five (24 machine drafts, labelled).
        for (const c of catalogs) for (const [english] of keys) expect(typeof c[english], english).toBe('string');
        expect(catalogs).toHaveLength(24);
    });
});

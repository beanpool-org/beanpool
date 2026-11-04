// @vitest-environment jsdom
/**
 * Lights-out H2: the hall banner (components/HallBanner.tsx), drawn for each view with the app's real light and dark
 * colour tokens (constants/colors.ts), on a 320 dp phone at 1.3x text.
 *
 * Rendered with react-dom and React Native stood in for (as poll-vote-origins-card.test.ts does): what is checked is
 * what the banner puts on screen and the styles it gives it. The 320 dp check is a model of the layout: the lines wrap
 * (no line limit, no fixed size) and their longest word fits the width they get; the words are readable on the banner's
 * ground in both themes (4.5:1).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Props = { children?: ReactNode; style?: unknown; testID?: string; numberOfLines?: number; onPress?: () => void; disabled?: boolean };
const seen = vi.hoisted(() => new Map<string, { style: unknown; numberOfLines?: number }>());
const flat = (s: unknown): Record<string, unknown> =>
    Array.isArray(s) ? Object.assign({}, ...s.map(flat)) : s && typeof s === 'object' ? { ...(s as Record<string, unknown>) } : {};
vi.mock('react-native', () => {
    const el = (tag: string) => ({ children, style, testID, numberOfLines, onPress, disabled }: Props) => {
        if (testID) seen.set(testID, { style, numberOfLines });
        return createElement(tag, { 'data-testid': testID, onClick: onPress, disabled }, children);
    };
    return { View: el('div'), Text: el('span'), Pressable: el('button'), AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } };
});
vi.mock('../../app/ThemeContext', () => ({ useTheme: () => ({ colors: {}, theme: 'light' }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(n) }));

import { lightColors, darkColors, type AppColors } from '../../constants/colors';
import { contrastRatio } from '../readable-color';
import { HallBannerView } from '../../components/HallBanner';
import type { HallView } from '../hall';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
    seen.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

async function draw(view: HallView, colors: AppColors) {
    await act(async () => { root.render(createElement(HallBannerView, { view, colors }) as any); });
}

const VIEWS: [string, HallView][] = [
    ['in the hall, with the record\'s time', { kind: 'in-hall', recordAsOf: '2026-11-03T14:02:00.000Z' }],
    ['in the hall, no time known', { kind: 'in-hall', recordAsOf: null }],
    ['the laptop gone, home answers', { kind: 'home-answers', host: 'byron.beanpool.org' }],
    ['back home', { kind: 'back-home', host: 'byron.beanpool.org' }],
];
const THEMES: [string, AppColors][] = [['light', lightColors], ['dark', darkColors as unknown as AppColors]];

describe('the hall banner at 320 dp and 1.3x text, light and dark', () => {
    it('says the record\'s age in two lines: no internet, then the time and what is not here', async () => {
        await draw(VIEWS[0][1], lightColors);
        const title = container.querySelector('[data-testid="hall-banner-title"]')!.textContent;
        const detail = container.querySelector('[data-testid="hall-banner-detail"]')!.textContent!;
        expect(title).toBe("No internet. You're on the hall laptop.");
        expect(detail).toMatch(/^The record is as of \w{3} \d{1,2} \w{3}, \d{1,2}:\d{2}\. Trades made since then on the old server are not here\.$/);
        expect(container.textContent!.toLowerCase()).not.toMatch(/stale|out of date|resilien|surviv/);
    });

    it('with no time known, only the first line', async () => {
        await draw(VIEWS[1][1], lightColors);
        expect(container.querySelector('[data-testid="hall-banner-detail"]')).toBeNull();
    });

    it('the one card offers Go back; back home has OK', async () => {
        await draw(VIEWS[2][1], lightColors);
        expect(container.textContent).toContain('byron.beanpool.org answers again. Go back to it?');
        expect(container.querySelector('[data-testid="hall-banner-go-home"]')!.textContent).toBe('Go back');
        await draw(VIEWS[3][1], lightColors);
        expect(container.textContent).toContain("The internet is back: you're on byron.beanpool.org again.");
        expect(container.querySelector('[data-testid="hall-banner-dismiss"]')).not.toBeNull();
    });

    for (const [themeName, colors] of THEMES) {
        for (const [name, view] of VIEWS) {
            it(`${themeName}: ${name}: the lines wrap, their longest word fits, and they read on the banner`, async () => {
                await draw(view, colors);
                const SCREEN = 320, FONT_SCALE = 1.3;
                const banner = flat(seen.get('hall-banner')!.style);
                const inner = SCREEN - 2 * Number(banner.paddingHorizontal);
                const wordWidth = (w: string, size: number) => [...w].reduce((n) => n + 0.62 * size * FONT_SCALE, 0);
                for (const id of ['hall-banner-title', 'hall-banner-detail']) {
                    const got = seen.get(id);
                    if (!got) continue;
                    const s = flat(got.style);
                    expect(got.numberOfLines, `${id}: no line limit`).toBeUndefined();
                    for (const k of ['width', 'height', 'maxHeight', 'maxWidth']) expect(s[k], `${id}: no fixed ${k}`).toBeUndefined();
                    const size = Number(s.fontSize);
                    expect(size).toBeGreaterThanOrEqual(13);
                    const text = container.querySelector(`[data-testid="${id}"]`)!.textContent!;
                    expect(Math.max(...text.split(/\s+/).map((w) => wordWidth(w, size)))).toBeLessThan(inner);
                    // The banner's words and ground are the theme's own notice/info tokens, readable on each other.
                    expect(contrastRatio(String(s.color), String(banner.backgroundColor))).toBeGreaterThanOrEqual(4.5);
                }
                const tone = view.kind === 'in-hall' ? colors.feedback.warning : colors.feedback.info;
                expect(banner.backgroundColor).toBe(tone.bg);
                expect(flat(seen.get('hall-banner-title')!.style).color).toBe(tone.fg);
                for (const k of ['height', 'maxHeight']) expect(banner[k], `banner: no fixed ${k}`).toBeUndefined();
            });
        }
    }
});

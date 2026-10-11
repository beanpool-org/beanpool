// @vitest-environment jsdom
/**
 * The Market's line for a member with no area on a by-area community (components/NoAreaLine.tsx, design §3.4), rendered
 * for real at the floor's window (320 x 569 dp, text at 1.3x): react-dom in jsdom, React Native's host components as plain
 * tags carrying their accessibility props and styles, as home-screen-render.test.ts does. Nothing draws a frame: what is
 * checked is the words, the one target and its way on, and that nothing in it is fixed-width or cut to a line count, so
 * at 320 dp and 1.3x the line wraps rather than running off the screen.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(3).filter(Boolean));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, numberOfLines, style } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (onPress) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = numberOfLines;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() } }));

import { NoAreaLine } from '../../components/NoAreaLine';
import { NO_AREA_LINE } from '../nearby-area';
import { lightColors, earthColors, slateColors, darkColors, type AppColors } from '../../constants/colors';

/** WCAG 2 contrast of two #rrggbb colours, worked here (not the component's helper). */
function contrast(a: string, b: string): number {
    const lum = (hex: string) => {
        const [r, g, bl] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    };
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

describe('the Market\'s no-area line at 320 dp, text at 1.3x', () => {
    it('says what the member sees and the way on, as one link to Settings → Your area, and wraps', async () => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const pressed = vi.fn();
        await act(async () => { createRoot(host).render(createElement(NoAreaLine, { onPress: pressed }) as unknown as Parameters<Root['render']>[0]); });

        const line = host.querySelector('[data-testid="market-no-area-line"]') as HTMLElement;
        expect(line.textContent).toBe("📍 You're seeing the newest listings worldwide. Set your area to see what's near you.");
        expect(NO_AREA_LINE.seeing + ' ' + NO_AREA_LINE.action).toBe("You're seeing the newest listings worldwide. Set your area to see what's near you.");
        expect(line.getAttribute('data-role')).toBe('link');
        expect(line.getAttribute('aria-label')).toBe("You're seeing the newest listings worldwide. Set your area to see what's near you.");
        await act(async () => { line.click(); });
        expect(pressed).toHaveBeenCalledTimes(1);

        // One target, at least 44 high; nothing fixed-width or cut to a line count anywhere in it.
        expect(JSON.parse(line.getAttribute('data-style')!).minHeight).toBeGreaterThanOrEqual(44);
        for (const node of [line, ...Array.from(line.querySelectorAll('*'))]) {
            const style = JSON.parse(node.getAttribute('data-style') ?? '{}');
            expect(style.width, node.outerHTML.slice(0, 80)).toBeUndefined();
            expect(style.height).toBeUndefined();
            expect(node.getAttribute('data-lines')).toBeNull();
        }
        // No currency, and no gate: it is a line above the feed, never instead of it.
        expect(line.textContent).not.toMatch(/Ʀ|Beans/);
    });

    it('the action reads at 4.5:1 or more on its box in every theme, the text at 16.9 px bold not being large (the review of #1778, finding 9)', async () => {
        const themes: Array<[string, AppColors]> = [['light', lightColors], ['earth', earthColors as unknown as AppColors], ['slate', slateColors as unknown as AppColors], ['dark', darkColors as unknown as AppColors]];
        for (const [name, colors] of themes) {
            const host = document.createElement('div');
            document.body.appendChild(host);
            await act(async () => { createRoot(host).render(createElement(NoAreaLine, { onPress: () => {}, colors }) as unknown as Parameters<Root['render']>[0]); });
            const line = host.querySelector('[data-testid="market-no-area-line"]') as HTMLElement;
            const box = JSON.parse(line.getAttribute('data-style')!);
            const action = [...Array.from(line.querySelectorAll('span'))].find(n => n.textContent === NO_AREA_LINE.action)!;
            const fg = JSON.parse(action.getAttribute('data-style')!).color as string;
            expect(contrast(fg, box.backgroundColor), `${name}: ${fg} on ${box.backgroundColor}`).toBeGreaterThanOrEqual(4.5);
            // A theme whose tone already reads keeps it.
            if (contrast(colors.feedback.info.fg, colors.feedback.info.bg) >= 4.5) expect(fg, name).toBe(colors.feedback.info.fg);
            host.remove();
        }
    });
});

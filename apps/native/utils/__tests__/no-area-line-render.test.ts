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
import { createRoot } from 'react-dom/client';

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

describe('the Market\'s no-area line at 320 dp, text at 1.3x', () => {
    it('says what the member sees and the way on, as one link to Settings → Your area, and wraps', async () => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const pressed = vi.fn();
        await act(async () => { createRoot(host).render(createElement(NoAreaLine, { onPress: pressed })); });

        const line = host.querySelector('[data-testid="market-no-area-line"]') as HTMLElement;
        expect(line.textContent).toBe("📍 You're seeing the newest listings worldwide. Set your area to see what's near you.");
        expect(NO_AREA_LINE.seeing + ' ' + NO_AREA_LINE.action).toBe("You're seeing the newest listings worldwide. Set your area to see what's near you.");
        expect(line.getAttribute('data-role')).toBe('link');
        expect(line.getAttribute('aria-label')).toBe("You're seeing the newest listings worldwide. Set your area to see what's near you.");
        await act(async () => { line.click(); });
        expect(pressed).toHaveBeenCalledTimes(1);

        // One target, at least 44 high; nothing fixed-width or cut to a line count anywhere in it.
        expect(JSON.parse(line.getAttribute('data-style')!).minHeight).toBeGreaterThanOrEqual(44);
        for (const node of [line, ...line.querySelectorAll('*')]) {
            const style = JSON.parse(node.getAttribute('data-style') ?? '{}');
            expect(style.width, node.outerHTML.slice(0, 80)).toBeUndefined();
            expect(style.height).toBeUndefined();
            expect(node.getAttribute('data-lines')).toBeNull();
        }
        // No currency, and no gate: it is a line above the feed, never instead of it.
        expect(line.textContent).not.toMatch(/Ʀ|Beans/);
    });
});

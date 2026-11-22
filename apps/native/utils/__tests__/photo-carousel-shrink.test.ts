// @vitest-environment jsdom
/**
 * PhotoCarousel when its list gets shorter while it stays drawn (#3355 review at 18de63f1: 3 pictures, swiped to the third,
 * Edit takes the third off, Save: "3 / 2" with no dot lit, and on Android an empty frame because the horizontal scroll view
 * keeps its offset). The place comes back inside the list: the counter, the lit dot and the scroll offset.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const rn = vi.hoisted(() => ({ onLayout: null as null | ((e: unknown) => void), onEnd: null as null | ((e: unknown) => void), scrollTo: [] as Array<{ x: number; animated?: boolean }> }));
vi.mock('react-native', async () => {
    const React = await import('react');
    const h = React.createElement;
    const strip = ({ style, children, onLayout, pointerEvents, importantForAccessibility, accessibilityElementsHidden, accessibilityRole, accessibilityLabel, ...rest }: any) => ({ rest, style, children, onLayout });
    const View = (p: any) => { const { style, children, onLayout } = strip(p); if (onLayout) rn.onLayout = onLayout; const flat = [style].flat(4).reduce((a: any, s: any) => ({ ...a, ...(s || {}) }), {}); return h('div', { 'data-active': flat.width === 18 ? 'true' : undefined }, children); };
    const ScrollView = React.forwardRef((p: any, ref: any) => {
        React.useImperativeHandle(ref, () => ({ scrollTo: (o: { x: number }) => { rn.scrollTo.push(o); } }));
        rn.onEnd = p.onMomentumScrollEnd;
        return h('div', null, p.children);
    });
    return {
        View, ScrollView, Text: (p: any) => h('span', null, p.children), Pressable: (p: any) => h('button', null, p.children),
        StyleSheet: { create: (s: unknown) => s },
    };
});
vi.mock('../../app/ThemeContext', async () => { const { lightColors } = await import('../../constants/colors'); return { useTheme: () => ({ theme: 'light', colors: lightColors }) }; });
vi.mock('expo-image', async () => { const React = await import('react'); return { Image: (p: any) => React.createElement('img', { src: p.source?.uri }) }; });

import { PhotoCarousel } from '../../components/PhotoCarousel';

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; rn.scrollTo.length = 0; });

const counter = () => Array.from(host!.querySelectorAll('span')).map((s) => s.textContent).find((t) => /\d+ \/ \d+/.test(t ?? '')) ?? null;
const litDots = () => host!.querySelectorAll('[data-active="true"]').length;

async function draw(photos: string[]) {
    await act(async () => { root!.render(createElement(PhotoCarousel, { photos, height: 220 }) as unknown as Parameters<Root['render']>[0]); });
}

describe('the carousel keeps its place inside a shorter list', () => {
    it('3 pictures, swiped to the third, the third taken off: "2 / 2", one dot lit, the scroll back to the second', async () => {
        host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
        await draw(['/a.jpg', '/b.jpg', '/c.jpg']);
        await act(async () => { rn.onLayout!({ nativeEvent: { layout: { width: 300 } } }); });
        await act(async () => { rn.onEnd!({ nativeEvent: { contentOffset: { x: 600 } } }); });
        expect(counter()).toBe('3 / 3');
        await draw(['/a.jpg', '/b.jpg']);
        expect(counter()).toBe('2 / 2');
        expect(litDots()).toBe(1);
        expect(rn.scrollTo).toEqual([{ x: 300, animated: false }]);
    });

    it('a shorter list that still holds the place moves nothing', async () => {
        host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
        await draw(['/a.jpg', '/b.jpg', '/c.jpg']);
        await act(async () => { rn.onLayout!({ nativeEvent: { layout: { width: 300 } } }); });
        await draw(['/a.jpg', '/b.jpg']);
        expect(counter()).toBe('1 / 2');
        expect(rn.scrollTo).toEqual([]);
    });
});

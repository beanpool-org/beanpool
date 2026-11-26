// @vitest-environment jsdom
/**
 * A post's photos swipe in the full-size view (Marty, 26 Nov 2026: "once she clicked on the larger photo view she was unable to
 * scroll through the photos at this level - she had to drop back to the card, scroll to the next photo and then click on it").
 * components/chat/ChatPhoto.tsx ChatPhotoViewer with `photos` and `index`: opens at the tapped photo, swipes (paged) through
 * all of the post's photos and stops at the first and the last, shows a small "2 / 3" count clear of Close at 320 dp and 1.3x
 * text, and every page still closes on a tap. One photo, or a chat's photo (no `photos`), is the view it always was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
    theme: 'light' as 'light' | 'dark',
    scrollTos: [] as Array<{ x?: number; y?: number; animated?: boolean }>,
    scrollEnd: null as null | ((e: { nativeEvent: { contentOffset: { x: number; y: number } } }) => void),
}));

vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => createElement('i') }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('../../components/LightBarModal', () => ({
    LightBarModal: ({ visible, children }: { visible?: boolean; children?: ReactNode }) => (visible === false ? null : createElement('div', { 'data-testid': 'modal' }, children)),
}));
vi.mock('react-native', async () => {
    const { createElement: el, forwardRef, useImperativeHandle } = await import('react');
    const flat = (s: unknown): Record<string, any> => Object.assign({}, ...[s].flat(4).filter((x) => x && typeof x === 'object'));
    const host = (tag: string) => forwardRef(function Host(props: Record<string, any>, ref: any) {
        useImperativeHandle(ref, () => ({ scrollTo: (opts: any) => { h.scrollTos.push(opts); } }));
        const { children, onPress, onMomentumScrollEnd, accessibilityLabel, accessibilityRole, accessibilityLiveRegion, testID, horizontal, pagingEnabled, contentOffset } = props;
        if (onMomentumScrollEnd) h.scrollEnd = onMomentumScrollEnd;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(props.style)) };
        if (onPress) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole === 'button') attrs.role = 'button';
        if (accessibilityLiveRegion) attrs['aria-live'] = accessibilityLiveRegion;
        if (testID) attrs['data-testid'] = testID;
        if (horizontal) attrs['data-horizontal'] = 'true';
        if (pagingEnabled) attrs['data-paging'] = 'true';
        if (contentOffset) attrs['data-offset-x'] = String(contentOffset.x);
        return el(tag, attrs, children);
    });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        useWindowDimensions: () => ({ width: 320, height: 569, fontScale: 1.3, scale: 2 }),
        View: host('div'),
        Text: host('span'),
        Pressable: host('button'),
        ScrollView: host('div'),
        Image: ({ source, accessibilityLabel }: any) => el('img', { 'data-src': source?.uri ?? '', 'aria-label': accessibilityLabel }),
        ActivityIndicator: ({ accessibilityLabel }: any) => el('span', { 'data-testid': 'spinner', 'aria-label': accessibilityLabel }),
        StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => flat(s), hairlineWidth: 1, absoluteFill: {} },
    };
});
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    return { useTheme: () => ({ theme: h.theme, colors: h.theme === 'dark' ? darkColors : lightColors }) };
});

import { ChatPhotoViewer, viewerStart } from '../../components/chat/ChatPhoto';
import { lightColors, darkColors } from '../../constants/colors';

const A = 'https://riverside.example/api/marketplace/posts/p1/photos/0?v=1';
const B = 'https://riverside.example/api/marketplace/posts/p1/photos/1?v=1';
const C = 'https://riverside.example/api/marketplace/posts/p1/photos/2?v=1';

let host: HTMLElement;
let root: Root;
beforeEach(() => {
    h.theme = 'light';
    h.scrollTos.length = 0;
    h.scrollEnd = null;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const show = async (node: ReactNode) => { await act(async () => { root.render(node as any); }); };
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const count = () => q('photo-viewer-count');
const settleAt = async (x: number) => { await act(async () => { h.scrollEnd?.({ nativeEvent: { contentOffset: { x, y: 0 } } }); }); };
const styleOf = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') ?? '{}');

describe('a post with several photos', () => {
    it('opens at the tapped photo: its page placed, "2 / 3" read as "Photo 2 of 3"', async () => {
        await show(createElement(ChatPhotoViewer, { uri: B, photos: [A, B, C], index: 1, onClose: vi.fn() }));
        const pager = q('photo-viewer-pager');
        expect(pager?.getAttribute('data-horizontal')).toBe('true');
        expect(pager?.getAttribute('data-paging')).toBe('true');
        expect(pager?.getAttribute('data-offset-x')).toBe('320');
        expect(h.scrollTos).toContainEqual({ x: 320, animated: false });
        expect(count()?.textContent).toBe('2 / 3');
        expect(count()?.getAttribute('aria-label')).toBe('Photo 2 of 3');
        expect(count()?.getAttribute('aria-live')).toBe('polite');
        // Every photo of the post, in order, one page each.
        expect(Array.from(host.querySelectorAll('img[aria-label="Full-size photo"]')).map((i) => i.getAttribute('data-src'))).toEqual([A, B, C]);
        expect([0, 1, 2].map((i) => styleOf(q(`photo-viewer-page-${i}`)).width)).toEqual([320, 320, 320]);
    });

    it('a swipe to the next and back again moves the count: 1 -> 2 -> 3 -> 2 -> 1', async () => {
        await show(createElement(ChatPhotoViewer, { uri: A, photos: [A, B, C], index: 0, onClose: vi.fn() }));
        expect(count()?.textContent).toBe('1 / 3');
        const seen: string[] = [];
        for (const x of [320, 640, 320, 0]) {
            await settleAt(x);
            seen.push(count()?.textContent ?? '');
        }
        expect(seen).toEqual(['2 / 3', '3 / 3', '2 / 3', '1 / 3']);
    });

    it('stops at the ends: past the last stays on the last, before the first on the first', async () => {
        await show(createElement(ChatPhotoViewer, { uri: C, photos: [A, B, C], index: 2, onClose: vi.fn() }));
        expect(count()?.textContent).toBe('3 / 3');
        await settleAt(1200);
        expect(count()?.textContent).toBe('3 / 3');
        await settleAt(-90);
        expect(count()?.textContent).toBe('1 / 3');
    });

    it('opens at the tapped place when the post carries the same photo twice', async () => {
        await show(createElement(ChatPhotoViewer, { uri: A, photos: [A, B, A], index: 2, onClose: vi.fn() }));
        expect(count()?.textContent).toBe('3 / 3');
        expect(viewerStart([A, B, A], A, 2)).toBe(2);
        expect(viewerStart([A, B, A], A)).toBe(0);
        expect(viewerStart([A, B, A], A, 1)).toBe(0);
        expect(viewerStart([A, B], C, 0)).toBe(-1);
    });

    it('closes as before: a tap on any page, or Close', async () => {
        const onClose = vi.fn();
        await show(createElement(ChatPhotoViewer, { uri: A, photos: [A, B, C], index: 0, onClose }));
        const dismiss = host.querySelectorAll<HTMLElement>('button[aria-label="Dismiss full-size photo"]');
        expect(dismiss).toHaveLength(3);
        await act(async () => { dismiss[2].click(); });
        expect(onClose).toHaveBeenCalledTimes(1);
        await act(async () => { host.querySelector<HTMLElement>('button[aria-label="Close photo"]')!.click(); });
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('the count sits at the top left, clear of Close at the top right, at 320 dp and 1.3x text', async () => {
        await show(createElement(ChatPhotoViewer, { uri: A, photos: [A, B, C, A, B], index: 0, onClose: vi.fn() }));
        const counter = styleOf(count());
        const close = styleOf(host.querySelector('button[aria-label="Close photo"]'));
        expect(counter.position).toBe('absolute');
        expect(counter.right).toBeUndefined();
        expect(counter.top).toBe(close.top);
        // "5 / 5" at 14 sp x 1.3, about 0.6 em a character, plus its padding: well short of where Close starts.
        const counterRight = counter.left + 2 * counter.paddingHorizontal + '5 / 5'.length * 14 * 1.3 * 0.6;
        const closeLeft = 320 - close.right - close.width;
        expect(counterRight).toBeLessThan(closeLeft - 8);
        expect(counter.minHeight).toBeGreaterThanOrEqual(48);
    });

    it('reads in both colour sets: white on the viewer\'s own near-black', async () => {
        for (const theme of ['light', 'dark'] as const) {
            h.theme = theme;
            const colors = theme === 'dark' ? darkColors : lightColors;
            await show(createElement(ChatPhotoViewer, { uri: A, photos: [A, B], index: 0, onClose: vi.fn() }));
            expect(styleOf(count()).backgroundColor).toBe(colors.overlay.imageViewerBg);
            expect(styleOf(count()?.querySelector('span') ?? null).color).toBe(colors.text.inverse);
            expect(colors.text.inverse.toLowerCase()).toMatch(/^#fff(fff)?$/);
            await act(async () => { root.render(null as any); });
        }
    });
});

describe('one photo, and a chat\'s photo', () => {
    it('a one-photo post is exactly the view it always was: no pager, no count', async () => {
        await show(createElement(ChatPhotoViewer, { uri: A, onClose: vi.fn() }));
        const before = host.innerHTML;
        await act(async () => { root.render(null as any); });
        await show(createElement(ChatPhotoViewer, { uri: A, photos: [A], index: 0, onClose: vi.fn() }));
        expect(host.innerHTML).toBe(before);
        expect(q('photo-viewer-pager')).toBeNull();
        expect(count()).toBeNull();
        expect(host.querySelectorAll('button[aria-label="Dismiss full-size photo"]')).toHaveLength(1);
    });

    it('a photo that is not among the photos given opens alone', async () => {
        await show(createElement(ChatPhotoViewer, { uri: C, photos: [A, B], index: 0, onClose: vi.fn() }));
        expect(q('photo-viewer-pager')).toBeNull();
        expect(host.querySelector('img[aria-label="Full-size photo"]')?.getAttribute('data-src')).toBe(C);
    });

    it('nothing when no photo is open', async () => {
        await show(createElement(ChatPhotoViewer, { uri: null, photos: [A, B], index: 0, onClose: vi.fn() }));
        expect(host.innerHTML).toBe('');
    });
});

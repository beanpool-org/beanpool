// @vitest-environment jsdom
/**
 * Learn page "Where:" and photo / full-screen viewer rendering (lane learn-card-map, slot 1540):
 * A Learn page stores only a plain text place name (`knowledge.place`, never coordinates, never a map); what sits directly
 * under "Where:" is PhotoCarousel (220 dp) and on tap ChatPhotoViewer. When a photo fails to load, PhotoCarousel must drop it
 * (collapsing to nothing when none load — never an empty light/dark box or a tappable blank slot), and ChatPhotoViewer uses
 * expo-image with memory-disk caching plus a loading indicator and a themed Retry fallback so tapping a photo never yields a
 * blank full-screen overlay. Measured in light and dark at 320 dp × 1.3x font.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
    theme: 'light' as 'light' | 'dark',
    /** Which URIs fail when expo-image loads them. */
    failUris: new Set<string>(),
    /** Whether expo-image fires onLoad/onError automatically on mount (true) or waits for manual triggers. */
    autoSettle: true,
    /** Every expo-image render's props & callbacks for assertions. */
    images: [] as Array<{ uri: string; cachePolicy?: string; transition?: number; contentFit?: string; onLoad?: () => void; onError?: () => void }>,
}));

const router = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn(), navigate: vi.fn(), canGoBack: vi.fn(() => true) }));

vi.mock('expo-router', () => ({ useRouter: () => router, router }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => createElement('i') }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('expo-image', async () => {
    const { createElement: el, useEffect: effect } = await import('react');
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(4).filter((x) => x && typeof x === 'object'));
    return {
        Image: ({ source, style, accessibilityLabel, contentFit, cachePolicy, transition, onLoad, onError }: any) => {
            const uri: string = source?.uri ?? '';
            effect(() => {
                const entry = { uri, cachePolicy, transition, contentFit, onLoad, onError };
                h.images.push(entry);
                if (!h.autoSettle || !uri) return;
                if (h.failUris.has(uri)) onError?.();
                else onLoad?.();
            }, [uri]);
            return el('img', {
                'data-src': uri,
                'data-cache': cachePolicy ?? '',
                'data-transition': String(transition ?? ''),
                'data-fit': contentFit ?? '',
                'aria-label': accessibilityLabel,
                'data-style': JSON.stringify(flat(style)),
            });
        },
    };
});
vi.mock('react-native', async () => {
    const { createElement: el, useEffect: effect, forwardRef, useImperativeHandle } = await import('react');
    const flat = (s: unknown): Record<string, any> => Object.assign({}, ...[s].flat(4).filter((x) => x && typeof x === 'object'));
    const roles: Record<string, string> = { button: 'button', link: 'link', header: 'heading', alert: 'alert' };
    const host = (tag: string) => forwardRef(function Host(props: Record<string, any>, ref: any) {
        useImperativeHandle(ref, () => ({ scrollTo: () => {} }));
        const { children, onPress, onLayout, accessibilityLabel, accessibilityRole, testID, disabled } = props;
        effect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 220 } } }); }, []);
        const attrs: Record<string, unknown> = {
            'data-style': JSON.stringify(flat(typeof props.style === 'function' ? props.style({ pressed: false }) : props.style)),
        };
        if (tag === 'div' && props.contentContainerStyle) attrs['data-style'] = JSON.stringify(flat(props.contentContainerStyle));
        if (onPress && !disabled) {
            attrs.onClick = (e: MouseEvent) => {
                onPress({ stopPropagation: () => e.stopPropagation() });
            };
        }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (testID) attrs['data-testid'] = testID;
        return el(tag, attrs, children);
    });
    return {
        Platform: { OS: 'android', Version: 26, select: (o: Record<string, unknown>) => o.android ?? o.default },
        useWindowDimensions: () => ({ width: 320, height: 569, fontScale: 1.3, scale: 2 }),
        View: host('div'),
        Text: host('span'),
        Pressable: host('button'),
        ScrollView: host('div'),
        Image: host('img'),
        ActivityIndicator: ({ accessibilityLabel }: any) => el('span', { 'data-testid': 'spinner', 'aria-label': accessibilityLabel }, '…'),
        Modal: ({ visible, children }: any) => (visible ? el('div', { 'data-testid': 'modal' }, children) : null),
        StatusBar: { pushStackEntry: () => ({}), popStackEntry: () => {} },
        TextInput: ({ value, onChangeText, testID }: any) => el('input', { value, 'data-testid': testID, onChange: (e: any) => onChangeText(e.target.value) }),
        StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => flat(s), hairlineWidth: 1, absoluteFill: {} },
        DeviceEventEmitter: { addListener: () => ({ remove: () => {} }) },
        Linking: { openURL: vi.fn(async () => {}) },
        Alert: { alert: vi.fn() },
        Keyboard: { dismiss: vi.fn() },
    };
});
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const look = () => ({ theme: h.theme, colors: h.theme === 'dark' ? darkColors : lightColors });
    return { useTheme: () => look(), useStyles: (make: any) => make(look()) };
});
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: 'me'.padEnd(64, '0') } }) }));
vi.mock('../use-learn-mode', () => ({ useLearnMode: () => 'live' }));
vi.mock('../../components/learn/useLearnWriter', () => ({ useLearnWriter: () => ({ checks: false, waiting: 0 }) }));
vi.mock('../db', () => ({
    reportAbuse: vi.fn(async () => ({})),
    signedGet: vi.fn(async () => ({ ok: false })),
    signedRequestWithMethod: vi.fn(async () => ({})),
}));
vi.mock('../node-post', () => ({ anchorUrl: vi.fn(async () => 'https://valley.example.org') }));
vi.mock('../../components/AuthorCard', () => ({ AuthorCard: () => null, useMemberRating: () => ({ average: null, count: 0 }) }));
vi.mock('../../components/PostTagChips', () => ({ PostTagChips: () => null }));
vi.mock('../../components/ReportReasonBox', () => ({ ReportReasonBox: () => null }));
vi.mock('../../components/forum/ForumLinks', () => ({ ForumLinkedTopics: () => null }));
vi.mock('../../components/signed-request-lines', () => ({ signedRequestWords: (m: string) => m }));
vi.mock('expo-modules-core', () => ({ requireNativeModule: vi.fn(() => ({})), requireOptionalNativeModule: vi.fn(() => null), EventEmitter: vi.fn(() => ({})), NativeModulesProxy: {} }));

import { KnowledgeDetail } from '../../components/learn/KnowledgeDetail';
import { PhotoCarousel } from '../../components/PhotoCarousel';
import { ChatPhotoViewer } from '../../components/chat/ChatPhoto';
import type { KnowledgePage } from '../../utils/learn-copy';
import { layOut } from './yoga-dom-layout';

const WHERE = 'Northern Rivers NSW: Byron Bay, Mullumbimby, Lismore, surrounds';
const PHOTO_A = 'https://valley.example.org/api/marketplace/posts/nr/photos/0?v=1&k=AAA';
const PHOTO_B = 'https://valley.example.org/api/marketplace/posts/nr/photos/1?v=1&k=BBB';
const PHOTO_A_V2 = 'https://valley.example.org/api/marketplace/posts/nr/photos/0?v=2&k=AAA2';

function makePage(photos: string[] = []): KnowledgePage {
    return {
        id: 'nr',
        title: 'Flood watch in the Northern Rivers',
        description: 'Check the SES warnings and road closures before driving.',
        category: 'emergencies',
        photos,
        authorPublicKey: 'b'.repeat(64),
        authorCallsign: 'Damo',
        status: 'active',
        active: 1,
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-02T00:00:00.000Z',
        knowledge: {
            sources: [],
            place: WHERE,
            lang: 'en',
            checkedAt: '2026-11-03T00:00:00.000Z',
            outdatedAt: null,
            outdatedNote: null,
            helped: 3,
            gathered: false,
        },
    };
}

let root: Root;
let host: HTMLElement;
beforeEach(() => {
    h.theme = 'light';
    h.failUris.clear();
    h.autoSettle = true;
    h.images.length = 0;
    vi.clearAllMocks();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setImmediate(r)); }); };
const show = async (el: ReactNode) => { act(() => root.render(el as any)); await settle(); };
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe.each(['light', 'dark'] as const)('Learn page Where: + photos (%s, 320 dp × 1.3x)', (theme) => {
    beforeEach(() => { h.theme = theme; });

    it('with only a place name and no photos: shows the Where: line and no empty box or map', async () => {
        await show(createElement(KnowledgeDetail, { page: makePage([]) }));
        expect(host.textContent).toContain(`Where: ${WHERE}`);
        expect(host.querySelectorAll('img')).toHaveLength(0);
        expect(host.querySelector('button[aria-label^="Photo "]')).toBeNull();
        expect(q('modal')).toBeNull();
    });

    it('with a working photo: draws it at 288 × 220 with transition 0, and tapping opens ChatPhotoViewer on expo-image memory-disk', async () => {
        await show(createElement(KnowledgeDetail, { page: makePage([PHOTO_A]) }));
        expect(host.textContent).toContain(`Where: ${WHERE}`);
        const img = host.querySelector('img')!;
        expect(img).toBeTruthy();
        expect(img.getAttribute('data-src')).toBe(PHOTO_A);
        expect(img.getAttribute('data-transition')).toBe('0');
        expect(img.getAttribute('data-cache')).toBe('memory-disk');
        const layout = layOut(host.firstElementChild!, { width: 320, height: 4000 }, { fontScale: 1.3 });
        expect([layout.width(img), layout.height(img)]).toEqual([288, 220]);

        const btn = host.querySelector('button[aria-label="Photo 1 of 1"]') as HTMLElement;
        expect(btn).toBeTruthy();
        await act(async () => { btn.click(); });
        await settle();

        const modal = q('modal')!;
        expect(modal).toBeTruthy();
        const fullImg = modal.querySelector('img[aria-label="Full-size photo"]')!;
        expect(fullImg).toBeTruthy();
        expect(fullImg.getAttribute('data-src')).toBe(PHOTO_A);
        expect(fullImg.getAttribute('data-cache')).toBe('memory-disk');
        expect(fullImg.getAttribute('data-fit')).toBe('contain');
        expect(q('photo-viewer-error')).toBeNull();
        expect(q('photo-viewer-loading')).toBeNull();
    });

    it('when the photo fails to load: collapses PhotoCarousel so no empty light/dark box remains under Where: and nothing is tappable', async () => {
        h.failUris.add(PHOTO_A);
        await show(createElement(KnowledgeDetail, { page: makePage([PHOTO_A]) }));
        expect(host.textContent).toContain(`Where: ${WHERE}`);
        expect(host.querySelectorAll('img')).toHaveLength(0);
        expect(host.querySelector('button[aria-label^="Photo "]')).toBeNull();
        // No 220 dp empty frame left anywhere in the rendered page.
        const empty220 = Array.from(host.querySelectorAll('div')).filter((d) => {
            const s = JSON.parse(d.getAttribute('data-style') || '{}');
            return s.height === 220;
        });
        expect(empty220).toHaveLength(0);
    });

    it('when 1 of 2 photos fails: keeps only the working photo, clears the counter, and tapping opens the working photo', async () => {
        h.failUris.add(PHOTO_A);
        await show(createElement(KnowledgeDetail, { page: makePage([PHOTO_A, PHOTO_B]) }));
        const imgs = Array.from(host.querySelectorAll('img'));
        expect(imgs.map((i) => i.getAttribute('data-src'))).toEqual([PHOTO_B]);
        expect(host.textContent).not.toContain('1 / 2');
        const btn = host.querySelector('button[aria-label="Photo 1 of 1"]') as HTMLElement;
        expect(btn).toBeTruthy();
        await act(async () => { btn.click(); });
        await settle();
        expect(q('modal')?.querySelector('img')?.getAttribute('data-src')).toBe(PHOTO_B);
    });

    it('ChatPhotoViewer on load failure: never a blank screen — shows Image Failed + ≥48 dp Try again that fits 320 dp × 1.3x and retries', async () => {
        h.failUris.add(PHOTO_A);
        const onClose = vi.fn();
        await show(createElement(ChatPhotoViewer, { uri: PHOTO_A, onClose }));
        const errBox = q('photo-viewer-error')!;
        expect(errBox).toBeTruthy();
        expect(errBox.getAttribute('role')).toBe('alert');
        expect(errBox.textContent).toContain('Image Failed');
        const retry = q('photo-viewer-retry')!;
        expect(retry).toBeTruthy();
        expect(retry.textContent).toContain('Try again');
        const layout = layOut(q('modal')!, { width: 320, height: 569 }, { fontScale: 1.3 });
        expect(layout.height(retry)).toBeGreaterThanOrEqual(48);
        expect(layout.box(errBox).left + layout.box(errBox).width).toBeLessThanOrEqual(320);

        // Now the network recovers: tapping Try again retries without dismissing the modal.
        h.failUris.delete(PHOTO_A);
        await act(async () => { retry.click(); });
        await settle();
        expect(onClose).not.toHaveBeenCalled();
        expect(q('photo-viewer-error')).toBeNull();
        expect(q('modal')?.querySelector('img[aria-label="Full-size photo"]')?.getAttribute('data-src')).toBe(PHOTO_A);
    });
});

describe('PhotoCarousel recovery when a newer URL arrives', () => {
    it('tries again cleanly when a sync brings a fresh versioned URL after an earlier URL failed', async () => {
        h.failUris.add(PHOTO_A);
        await show(createElement(PhotoCarousel, { photos: [PHOTO_A], height: 220 }));
        expect(host.querySelectorAll('img')).toHaveLength(0);
        await show(createElement(PhotoCarousel, { photos: [PHOTO_A_V2], height: 220 }));
        expect(Array.from(host.querySelectorAll('img')).map((i) => i.getAttribute('data-src'))).toEqual([PHOTO_A_V2]);
    });
});

// @vitest-environment jsdom
/**
 * Choosing the part of a picture that shows, on the phone (Marty, 25 Oct 2026: "we want both the pwa and phone and both
 * avatar and banner to be able to select the part of the image we want"). What the member crops is exactly what is shown:
 *
 * - Every picture drawn in a fixed shape goes through one crop step (components/PictureCrop.tsx) before it is kept: a
 *   member's avatar and an enterprise's or project's logo (components/AvatarPickerSheet.tsx, from the camera or the
 *   gallery) a square in a circle, 512 px; a shop's banner (utils/banner-photo.ts, from Manage and Your shop) 3:1, 800 px.
 * - The picker never crops itself (`allowsEditing` crops a square on iOS whatever aspect is asked).
 * - A known move and zoom give the rectangle the image tools are asked to cut, to the pixel; Cancel keeps nothing.
 * - The banner is drawn 3:1 wherever it shows, so the part chosen is the part seen.
 *
 * Drawn with the screens' own code over a stand-in for React Native (as the other render tests here): the gestures are the
 * crop view's own PanResponder handlers, called as a finger would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
vi.hoisted(() => {
    const Loader = (process as any).getBuiltinModule('node:module');
    Loader._extensions['.jpg'] = (m: { exports: unknown }) => { m.exports = 1; };
});
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** The crop screen's stage as a 320 dp phone lays it out. */
const STAGE = { width: 320, height: 400 };

/** Each drawn part's props by its testID, and the PanResponder configs the screen made. */
const hosts = vi.hoisted(() => ({ byId: new Map<string, Record<string, any>>() }));

vi.mock('expo', () => ({ requireNativeModule: vi.fn(() => ({})), requireOptionalNativeModule: vi.fn(() => null) }));
vi.mock('expo-modules-core', () => ({
    requireNativeModule: vi.fn(() => ({})),
    requireOptionalNativeModule: vi.fn(() => null),
    EventEmitter: vi.fn(() => ({ addListener: vi.fn(), removeListener: vi.fn() })),
    NativeModulesProxy: {},
    ProxyNativeModule: {},
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid', getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));

const alerts = vi.hoisted(() => ({ said: [] as string[] }));
vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', adjustable: 'slider', image: 'img' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, testID, onLayout, disabled } = props;
        if (testID) hosts.byId.set(testID, props);
        useEffect(() => {
            const size = testID === 'picture-crop-stage' ? STAGE : { width: 288, height: 40 };
            onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, ...size } } });
        }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessibilityState?.disabled || disabled) attrs['aria-disabled'] = 'true';
        if (tag === 'img' && props.source?.uri) attrs.src = props.source.uri;
        attrs['data-style'] = JSON.stringify(flat(typeof props.style === 'function' ? props.style({ pressed: false }) : props.style));
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        View: el('div'), Text: el('span'), Pressable: el('div'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('div'), SafeAreaView: el('div'), ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        PanResponder: { create: (config: Record<string, unknown>) => ({ panHandlers: { panConfig: config } }) },
        Alert: { alert: (title: string, body?: string) => { alerts.said.push(title); if (body) alerts.said.push(body); } },
        AccessibilityInfo: { announceForAccessibility: vi.fn() },
        Keyboard: { dismiss: vi.fn() },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('expo-router', () => ({ router: { push: vi.fn(), navigate: vi.fn(), replace: vi.fn(), back: vi.fn() }, ErrorBoundary: () => null }));
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: ({ children }: any) => createElement('div', null, children),
    KeyboardController: { dismiss: vi.fn() },
    useKeyboardState: (cb: any) => cb({ isVisible: false }),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-image', () => ({
    Image: ({ source, accessibilityLabel, style }: any) => createElement('img', { src: source?.uri || 'bundled-src', 'aria-label': accessibilityLabel, 'data-style': JSON.stringify(Object.assign({}, ...[style].flat(4).filter(Boolean))) }),
}));
vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: ({ children }: any) => createElement('div', null, children),
    useSafeAreaInsets: () => ({ top: 24, bottom: 16, left: 0, right: 0 }),
}));

// The picker hands back the photo as taken (4000 × 3000); the image tools make it the working copy (1600 × 1200), then cut.
const picker = vi.hoisted(() => ({ result: null as any, library: [] as any[], camera: [] as any[] }));
vi.mock('expo-image-picker', () => ({
    requestCameraPermissionsAsync: vi.fn(async () => ({ granted: true })),
    launchCameraAsync: vi.fn(async (opts: unknown) => { picker.camera.push(opts); return picker.result ?? { canceled: true }; }),
    launchImageLibraryAsync: vi.fn(async (opts: unknown) => { picker.library.push(opts); return picker.result ?? { canceled: true }; }),
}));
const tools = vi.hoisted(() => ({ calls: [] as Array<{ uri: string; actions: any[]; save: any }> }));
vi.mock('expo-image-manipulator', () => ({
    manipulateAsync: vi.fn(async (uri: string, actions: any[], save: any) => {
        tools.calls.push({ uri, actions, save });
        const crop = actions.find((a) => a.crop);
        if (!crop) return { uri: 'file:///working.jpg', width: 1600, height: 1200 };
        const out = actions.find((a) => a.resize)?.resize ?? crop.crop;
        return { uri: 'file:///cut.jpg', width: out.width, height: out.height, base64: 'Q1VU' };
    }),
    SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { colors: lightColors, theme: 'light' };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx) };
});
vi.mock('../../utils/db', () => ({ createEnterpriseApi: vi.fn(async () => ({ success: true })) }));
vi.mock('../../utils/shop', async (importOriginal) => ({
    ...(await importOriginal<any>()),
    changeEnterpriseFace: vi.fn(async () => ({ success: true })),
    changeEnterpriseShop: vi.fn(async () => ({ success: true })),
}));
vi.mock('../node-post', () => ({ anchorUrl: async () => 'https://mullum.example', getCachedAnchorUrl: () => 'https://mullum.example' }));

import { AvatarPickerSheet } from '../../components/AvatarPickerSheet';
import { ManageFace } from '../../components/shopfront/Manage';
import { ShopfrontHeader } from '../../components/shopfront/Shopfront';
import * as shop from '../../utils/shop';

const PHOTO = { uri: 'file:///DCIM/IMG_0001.jpg', width: 4000, height: 3000 };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    hosts.byId.clear();
    alerts.said = [];
    picker.result = { canceled: false, assets: [PHOTO] };
    picker.library = [];
    picker.camera = [];
    tools.calls = [];
    vi.mocked(shop.changeEnterpriseShop).mockClear();
});
afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
});

const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const styleOf = (id: string) => JSON.parse(byId(id)?.getAttribute('data-style') ?? '{}');
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function tap(el: Element | null, name: string) {
    expect(el, `nothing to tap: ${name}`).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle();
}
const byLabel = (label: string) => host.querySelector(`[aria-label="${label}"]`);

/** The frame drawn over the photo: its size on screen. */
function frame() {
    const s = styleOf('picture-crop-frame');
    return { width: s.width as number, height: s.height as number, borderRadius: s.borderRadius as number | undefined };
}

/** A finger on the photo, moved by (dx, dy) dp, and lifted. */
async function drag(dx: number, dy: number) {
    const pan = hosts.byId.get('picture-crop-stage')?.panConfig;
    expect(pan, 'the photo takes a finger').toBeTruthy();
    const touch = (x: number, y: number) => ({ nativeEvent: { touches: [{ pageX: x, pageY: y }] } });
    await act(async () => {
        pan.onPanResponderGrant?.(touch(100, 100), { dx: 0, dy: 0 });
        pan.onPanResponderMove(touch(100 + dx, 100 + dy), { dx, dy });
        pan.onPanResponderRelease?.(touch(100 + dx, 100 + dy), { dx, dy });
    });
}

/** Two fingers on the photo, spread from `from` dp apart to `to`. */
async function pinch(from: number, to: number) {
    const pan = hosts.byId.get('picture-crop-stage')?.panConfig;
    const two = (gap: number) => ({ nativeEvent: { touches: [{ pageX: 100, pageY: 100 }, { pageX: 100 + gap, pageY: 100 }] } });
    await act(async () => {
        pan.onPanResponderGrant?.(two(from), { dx: 0, dy: 0 });
        pan.onPanResponderMove(two(from), { dx: 0, dy: 0 });
        pan.onPanResponderMove(two(to), { dx: 0, dy: 0 });
        pan.onPanResponderRelease?.(two(to), { dx: 0, dy: 0 });
    });
}

/** A screen reader's action on the frame ("Zoom in", "Move the picture left", …). */
async function action(name: string) {
    const props = hosts.byId.get('picture-crop-frame');
    expect(props?.accessibilityActions?.map((a: { name: string }) => a.name)).toContain(name);
    await act(async () => { props!.onAccessibilityAction({ nativeEvent: { actionName: name } }); });
}

/** The last cut the image tools were asked for: its rectangle, its size out, and how it is saved. */
function lastCut() {
    const call = [...tools.calls].reverse().find((c) => c.actions.some((a) => a.crop));
    return call && { uri: call.uri, crop: call.actions.find((a) => a.crop).crop, resize: call.actions.find((a) => a.resize)?.resize, save: call.save };
}

function renderSheet() {
    const picked: string[] = [];
    const closed = vi.fn();
    root.render(createElement(AvatarPickerSheet, { visible: true, onClose: closed, onSelectImage: (uri: string) => { picked.push(uri); } }) as any);
    return { picked, closed };
}

describe('an avatar or a logo from a photo: a square, shown in a circle', () => {
    it('the gallery never crops by itself; its photo opens the crop step, square in a circle', async () => {
        await act(async () => { renderSheet(); });
        await tap(byLabel('Choose photo from gallery'), 'Gallery');
        expect(picker.library).toHaveLength(1);
        expect(picker.library[0].allowsEditing).toBeFalsy();
        expect(picker.library[0].aspect).toBeUndefined();
        expect(byId('picture-crop')).not.toBeNull();
        // The photo is first made the working copy, its longest side 1600 px (an old phone's memory; enough for 512 at 3×).
        expect(tools.calls[0]).toMatchObject({ uri: PHOTO.uri, actions: [{ resize: { width: 1600 } }] });
        const f = frame();
        expect(f.width).toBeGreaterThan(200);
        expect(f.width).toBe(f.height);
        expect(f.borderRadius).toBe(f.width / 2);
        expect(byId('picture-crop')?.textContent).toContain('Choose the part that shows');
    });

    it('what is kept is the part chosen: zoomed in once and moved, cut to the pixel and made 512 px', async () => {
        const { picked, closed } = await (async () => { let r!: ReturnType<typeof renderSheet>; await act(async () => { r = renderSheet(); }); return r; })();
        await tap(byLabel('Choose photo from gallery'), 'Gallery');
        await tap(byLabel('Zoom in'), 'Zoom in');
        // The photo dragged left by a fifth of the frame: the part shown is further right.
        await drag(-frame().width * 0.2, 0);
        await tap(byId('picture-crop-done'), 'Done');
        expect(lastCut()).toEqual({
            uri: 'file:///working.jpg',
            crop: { originX: 512, originY: 120, width: 960, height: 960 },
            resize: { width: 512, height: 512 },
            save: { compress: 0.7, format: 'jpeg', base64: true },
        });
        expect(picked).toEqual(['data:image/jpeg;base64,Q1VU']);
        expect(closed).toHaveBeenCalled();
    });

    it("the camera's photo goes through the same crop step", async () => {
        const r = await (async () => { let x!: ReturnType<typeof renderSheet>; await act(async () => { x = renderSheet(); }); return x; })();
        await tap(byLabel('Take photo with camera'), 'Camera');
        expect(picker.camera).toHaveLength(1);
        expect(picker.camera[0].allowsEditing).toBeFalsy();
        expect(byId('picture-crop')).not.toBeNull();
        await tap(byId('picture-crop-done'), 'Done');
        expect(lastCut()?.crop).toEqual({ originX: 200, originY: 0, width: 1200, height: 1200 });
        expect(r.picked).toEqual(['data:image/jpeg;base64,Q1VU']);
    });

    it('two fingers spread zoom in; a screen reader moves and zooms with its actions', async () => {
        await act(async () => { renderSheet(); });
        await tap(byLabel('Choose photo from gallery'), 'Gallery');
        await pinch(100, 125);
        await action('moveLeft');
        await action('moveLeft');
        await action('increment');
        await action('decrement');
        await tap(byId('picture-crop-done'), 'Done');
        expect(lastCut()?.crop).toEqual({ originX: 512, originY: 120, width: 960, height: 960 });
    });

    it('Cancel keeps nothing and goes back to the choices', async () => {
        const r = await (async () => { let x!: ReturnType<typeof renderSheet>; await act(async () => { x = renderSheet(); }); return x; })();
        await tap(byLabel('Choose photo from gallery'), 'Gallery');
        await tap(byLabel('Zoom in'), 'Zoom in');
        await tap(byId('picture-crop-cancel'), 'Cancel');
        expect(byId('picture-crop')).toBeNull();
        expect(lastCut()).toBeUndefined();
        expect(r.picked).toEqual([]);
        expect(r.closed).not.toHaveBeenCalled();
        expect(byLabel('Choose photo from gallery')).not.toBeNull();
    });

    it('a ready-made picture skips the crop step', async () => {
        const r = await (async () => { let x!: ReturnType<typeof renderSheet>; await act(async () => { x = renderSheet(); }); return x; })();
        await tap(byLabel('Select Leaf avatar'), 'Leaf');
        await tap(Array.from(host.querySelectorAll('[role="button"]')).find((b) => b.textContent?.trim() === 'Use Selected Avatar') ?? null, 'Use');
        expect(byId('picture-crop')).toBeNull();
        expect(r.picked).toEqual(['bundled://leaf']);
    });
});

describe("a shop's banner: 3:1, chosen and drawn the same", () => {
    const renderFace = () => root.render(createElement(ManageFace, {
        treasury: 'ent-key-1',
        detail: { name: 'Hill Bakery', purpose: 'Bread', about: 'Baking', shop: { id: 'shop-1' } } as any,
        lead: true, keeper: true, project: false, logoUrl: null, onSaved: () => {},
    }) as any);

    it("Manage's banner photo opens the crop step at 3:1, not round; the strip chosen is the one sent, 800 px", async () => {
        await act(async () => { renderFace(); });
        await tap(byId('manage-face-banner'), 'Choose a banner photo');
        expect(picker.library).toHaveLength(1);
        expect(picker.library[0].allowsEditing).toBeFalsy();
        expect(picker.library[0].aspect).toBeUndefined();
        const f = frame();
        expect(f.width / f.height).toBeCloseTo(3, 5);
        expect(f.borderRadius ?? 0).toBeLessThan(f.height / 2);
        await action('moveUp');
        await action('moveUp');
        await tap(byId('picture-crop-done'), 'Done');
        expect(lastCut()).toEqual({
            uri: 'file:///working.jpg',
            crop: { originX: 0, originY: 440, width: 1600, height: 533 },
            resize: { width: 800, height: 267 },
            save: { compress: 0.7, format: 'jpeg', base64: true },
        });
        expect(byId('manage-face-banner-image')?.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,Q1VU');
        await tap(byId('manage-face-save'), 'Save');
        expect(vi.mocked(shop.changeEnterpriseShop)).toHaveBeenCalledWith('ent-key-1', { photo: 'data:image/jpeg;base64,Q1VU' });
    });

    it('Cancel keeps the banner as it was', async () => {
        await act(async () => { renderFace(); });
        await tap(byId('manage-face-banner'), 'Choose a banner photo');
        await tap(byId('picture-crop-cancel'), 'Cancel');
        expect(byId('picture-crop')).toBeNull();
        expect(byId('manage-face-banner-image')).toBeNull();
        expect(lastCut()).toBeUndefined();
        expect(byId('manage-face-banner')?.textContent).toBe('Choose a banner photo');
    });

    it("the shopfront draws its banner 3:1 across the page, and Manage's preview the same", async () => {
        await act(async () => {
            root.render(createElement('div', null,
                createElement(ShopfrontHeader, { name: 'Hill Bakery', ownerKey: 'k', logoUrl: null, kind: null, fallbackEmoji: '🏛️', bannerPhoto: 'data:image/jpeg;base64,QQ==', lines: [] }),
            ) as any);
        });
        const banner = styleOf('shopfront-banner');
        expect(banner.aspectRatio).toBe(3);
        expect(banner.height).toBeUndefined();
        await act(async () => { renderFace(); });
        await tap(byId('manage-face-banner'), 'Choose a banner photo');
        await tap(byId('picture-crop-done'), 'Done');
        const preview = styleOf('manage-face-banner-image');
        expect(preview.aspectRatio).toBe(3);
        expect(preview.height).toBeUndefined();
    });
});

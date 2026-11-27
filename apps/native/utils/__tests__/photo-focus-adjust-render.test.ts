// @vitest-environment jsdom
/**
 * The Adjust screen (components/PhotoFocusAdjust.tsx): the whole photo with the card's frame over it at the real card's shape,
 * a tap that moves the frame, the card preview cropped exactly as the Market crops (the same contentPosition), Done handing
 * back the focus and Reset the card's own crop. Drawn at 320 dp and 1.3x text, and every colour is a theme token, so it reads
 * in Light and Dark alike.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** The photo's size as Image.getSize reports it: an upright 3:4 photo, as a phone takes one. */
const size = vi.hoisted(() => ({ w: 600, h: 800 }));
/** Each Image's props, by testID, as last drawn. */
const images = vi.hoisted(() => ({ byId: new Map<string, Record<string, unknown>>() }));
/** The stage's responder handlers, as last drawn. */
const stage = vi.hoisted(() => ({ props: null as Record<string, any> | null }));
/** The platform the hook reads (Android by default; iOS waits for the picker to close). */
const platform = vi.hoisted(() => ({ OS: 'android' as string }));

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, testID, style } = props;
        if (testID === 'photo-focus-stage') stage.props = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (style) attrs['data-style'] = JSON.stringify(style);
        return createElement(tag, attrs, children);
    };
    return {
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s },
        Image: { getSize: (_uri: string, ok: (w: number, h: number) => void) => ok(size.w, size.h) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
        Platform: platform,
    };
});
vi.mock('expo-image', async () => {
    const { createElement: h } = await import('react');
    return { Image: (props: Record<string, unknown>) => { if (props.testID) images.byId.set(String(props.testID), props); return h('img', { 'data-testid': props.testID ?? 'photo' }); } };
});
// The status bar's light entry is LightBarModal's own (status-bar-every-screen.test.ts drives the real one); here it draws its
// children while visible, as the Modal mock does.
vi.mock('../../components/LightBarModal', async () => {
    const { createElement: h } = await import('react');
    return { LightBarModal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? h('div', { 'data-modal': 'light-bar' }, children as any) : null) };
});
const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { colors, darkColors } = await import('../../constants/colors');
    return { useStyles: (make: (t: { colors: unknown; theme: unknown }) => unknown) => make({ colors: theme.dark ? darkColors : colors, theme: {} }) };
});

import { PhotoFocusAdjust } from '../../components/PhotoFocusAdjust';
import type { PhotoFocus } from '@beanpool/core';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); images.byId.clear(); stage.props = null; });
afterEach(() => { act(() => root.unmount()); host.remove(); });

function draw(focus: PhotoFocus | null, onDone = vi.fn(), onCancel = vi.fn(), more: { step?: { n: number; count: number; more: boolean } | null; onSkip?: ReturnType<typeof vi.fn>; uri?: string } = {}) {
    act(() => { root.render(createElement(PhotoFocusAdjust, { visible: true, uri: more.uri ?? 'file:///photo.jpg', focus, onDone, onCancel, step: more.step, onSkip: more.onSkip }) as any); });
    return { onDone, onCancel };
}
const labels = () => Array.from(host.querySelectorAll('button')).map((b) => b.textContent);
const press = (label: string) => {
    const button = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label);
    if (!button) throw new Error(`no button ${label}`);
    act(() => { button.click(); });
};
const frameStyle = () => JSON.parse(host.querySelector('[data-testid="photo-focus-frame"]')!.getAttribute('data-style')!) as Array<Record<string, unknown>>;

describe('PhotoFocusAdjust', () => {
    it('draws the card frame at the card\'s shape over the whole photo, where today\'s crop is with no focus', () => {
        draw(null);
        const box = frameStyle()[1];
        // An upright 3:4 photo in the 4:3 card: the frame is the full width and 9/16 of the height, 33% of the way down the rest.
        expect(box.width).toBe('100%');
        expect(box.height).toBe(`${(9 / 16) * 100}%`);
        expect(parseFloat(String(box.top))).toBeCloseTo(0.33 * (7 / 16) * 100, 6);
        // The card preview crops as the Market's grid card does with no focus: 50% across, 33% down.
        expect(images.byId.get('photo-focus-card')!.contentPosition).toEqual({ left: '50%', top: '33%' });
    });

    it('a tap moves the frame to the part tapped, and Done hands back that focus', () => {
        const { onDone } = draw(null);
        act(() => { stage.props!.onLayout({ nativeEvent: { layout: { width: 210, height: 280 } } }); });
        // A tap near the bottom of the photo: the frame goes as low as it can.
        act(() => { stage.props!.onResponderGrant({ nativeEvent: { locationX: 105, locationY: 279 } }); });
        expect(images.byId.get('photo-focus-card')!.contentPosition).toEqual({ left: '50%', top: '100%' });
        expect(parseFloat(String(frameStyle()[1].top)) + parseFloat(String(frameStyle()[1].height))).toBeCloseTo(100, 6);
        press('Done');
        expect(onDone).toHaveBeenCalledWith({ x: 0.5, y: 1 });
    });

    it('opens on the photo\'s own focus; Reset gives the card its own crop back (no focus)', () => {
        const { onDone } = draw({ x: 0.5, y: 0 });
        expect(images.byId.get('photo-focus-card')!.contentPosition).toEqual({ left: '50%', top: '0%' });
        press('Reset');
        press('Done');
        expect(onDone).toHaveBeenCalledWith(null);
    });

    it('opens on `visible` alone, as a LightBarModal: closed it draws nothing even with a photo named', () => {
        act(() => { root.render(createElement(PhotoFocusAdjust, { visible: false, uri: 'file:///photo.jpg', focus: null, onDone: vi.fn(), onCancel: vi.fn() }) as any); });
        expect(host.querySelector('[data-modal]')).toBeNull();
        draw(null);
        expect(host.querySelector('[data-modal]')!.getAttribute('data-modal')).toBe('light-bar');
    });

    it('Cancel keeps nothing', () => {
        const { onDone, onCancel } = draw({ x: 0.5, y: 0.2 });
        press('Cancel');
        expect(onCancel).toHaveBeenCalled();
        expect(onDone).not.toHaveBeenCalled();
    });

    it('fits 320 dp at 1.3x: an upright photo is held to a fixed height, the buttons wrap and are 48 dp tall', () => {
        draw(null);
        const stageStyle = JSON.parse(host.querySelector('[data-testid="photo-focus-stage"]')!.getAttribute('data-style')!) as Array<Record<string, unknown>>;
        expect(stageStyle[1]).toEqual({ height: 280, aspectRatio: 0.75 });
        const done = JSON.parse(host.querySelector('[data-testid="photo-focus-done"]')!.getAttribute('data-style')!) as Array<Record<string, unknown>>;
        expect(done[0].minHeight).toBe(48);
    });

    it('a wide photo takes the full width instead', () => {
        size.w = 1200; size.h = 600;
        try {
            draw(null);
            const stageStyle = JSON.parse(host.querySelector('[data-testid="photo-focus-stage"]')!.getAttribute('data-style')!) as Array<Record<string, unknown>>;
            expect(stageStyle[1]).toEqual({ width: '100%', aspectRatio: 2 });
            expect(frameStyle()[1].height).toBe('100%');
        } finally { size.w = 600; size.h = 800; }
    });

    it('opened by itself on several new photos: the button reads Next (n of count) and Skip is offered while more are to come', () => {
        const onSkip = vi.fn();
        const { onDone } = draw(null, vi.fn(), vi.fn(), { step: { n: 1, count: 3, more: true }, onSkip });
        expect(labels()).toEqual(['Reset', 'Cancel', 'Skip', 'Next (1 of 3)']);
        act(() => { stage.props!.onLayout({ nativeEvent: { layout: { width: 210, height: 280 } } }); });
        act(() => { stage.props!.onResponderGrant({ nativeEvent: { locationX: 105, locationY: 0 } }); });
        press('Next (1 of 3)');
        expect(onDone).toHaveBeenCalledWith({ x: 0.5, y: 0 });
        // Skip hands back what is chosen for the photo on screen, as Next does; the hook leaves the rest at none.
        press('Skip');
        expect(onSkip).toHaveBeenCalledWith({ x: 0.5, y: 0 });
    });

    it('the last photo of a walk, one new photo, and a tap: Done, and no Skip', () => {
        const onSkip = vi.fn();
        draw(null, vi.fn(), vi.fn(), { step: { n: 3, count: 3, more: false }, onSkip });
        expect(labels()).toEqual(['Reset', 'Cancel', 'Done']);
        draw(null, vi.fn(), vi.fn(), { step: null, onSkip });
        expect(labels()).toEqual(['Reset', 'Cancel', 'Done']);
        draw(null);
        expect(labels()).toEqual(['Reset', 'Cancel', 'Done']);
    });

    it('the next photo of a walk opens on its own focus (none for a new photo), never the last one\'s choice', () => {
        draw(null, vi.fn(), vi.fn(), { step: { n: 1, count: 2, more: true }, onSkip: vi.fn(), uri: 'file:///one.jpg' });
        act(() => { stage.props!.onLayout({ nativeEvent: { layout: { width: 210, height: 280 } } }); });
        act(() => { stage.props!.onResponderGrant({ nativeEvent: { locationX: 105, locationY: 279 } }); });
        expect(images.byId.get('photo-focus-card')!.contentPosition).toEqual({ left: '50%', top: '100%' });
        draw(null, vi.fn(), vi.fn(), { step: { n: 2, count: 2, more: false }, onSkip: vi.fn(), uri: 'file:///two.jpg' });
        expect(images.byId.get('photo-focus-card')!.contentPosition).toEqual({ left: '50%', top: '33%' });
    });

    it('at 320 dp and 1.3x the four buttons wrap onto rows, each held to the row\'s width with its words centred', () => {
        draw(null, vi.fn(), vi.fn(), { step: { n: 1, count: 3, more: true }, onSkip: vi.fn() });
        const skip = JSON.parse(host.querySelector('[data-testid="photo-focus-skip"]')!.getAttribute('data-style')!) as Record<string, unknown>;
        expect(skip.minHeight).toBe(48);
        expect(skip.maxWidth).toBe('100%');
        const row = JSON.parse(host.querySelector('[data-testid="photo-focus-skip"]')!.parentElement!.getAttribute('data-style')!) as Record<string, unknown>;
        expect(row).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' });
    });

    it('draws in Dark from the theme\'s tokens: no colour of its own', () => {
        theme.dark = true;
        try {
            draw(null);
            expect(host.querySelector('[data-testid="photo-focus-stage"]')).not.toBeNull();
        } finally { theme.dark = false; }
        const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../components/PhotoFocusAdjust.tsx'), 'utf8');
        expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    });
});

describe('usePhotoFocusList: an edit sends the focus only when the member changed it', () => {
    it('untouched: nothing sent, so the node keeps each photo\'s focus (this phone\'s copy may be behind); touched: the list', async () => {
        const { usePhotoFocusList } = await import('../use-photo-focus-list');
        let hook: ReturnType<typeof usePhotoFocusList> | null = null;
        const Probe = () => { hook = usePhotoFocusList(); return null; };
        act(() => { root.render(createElement(Probe) as any); });
        act(() => { hook!.resetFrom(['p0', 'p1'], { photo_focus: '[{"x":0.2,"y":0.8}]' }); });
        expect(hook!.touched).toBe(false);
        expect(hook!.forEdit(['p0', 'p1'])).toBeUndefined();
        expect(hook!.at('p0')).toEqual({ x: 0.2, y: 0.8 });
        act(() => { hook!.setAt('p1', { x: 0.5, y: 0 }); });
        expect(hook!.forEdit(['p0', 'p1'])).toEqual([{ x: 0.2, y: 0.8 }, { x: 0.5, y: 0 }]);
        act(() => { hook!.resetFrom([], null); });
        expect(hook!.forEdit(['p0', 'p1'])).toBeUndefined();
        act(() => { hook!.resetFrom(['q0', 'q1'], { photoFocus: [null, { x: 1, y: 1 }] }); });
        act(() => { hook!.removed(); });
        expect(hook!.forEdit(['q1'])).toEqual([{ x: 1, y: 1 }]);
        act(() => { hook!.setAt('q1', null); });
        expect(hook!.forEdit(['q1'])).toBeNull();
    });

    it('every way a form changes its photos keeps each photo\'s own focus (the table both apps run, core photo-focus-vectors)', async () => {
        const { usePhotoFocusList } = await import('../use-photo-focus-list');
        const { checkPhotoFocusVectors } = await import('@beanpool/core/photo-focus-vectors');
        const wrong = checkPhotoFocusVectors(() => {
            let hook: ReturnType<typeof usePhotoFocusList> | null = null;
            let photos: string[] = [];
            const Probe = () => { hook = usePhotoFocusList(); return null; };
            act(() => { root.render(createElement(Probe, { key: Math.random() }) as any); });
            return {
                setPhotos: (next) => { photos = next; },
                removed: () => act(() => { hook!.removed(); }),
                adjust: (photo, f) => act(() => { hook!.open(photo); hook!.setAt(photo, f); hook!.close(); }),
                putWhole: (next, focus) => { photos = next; act(() => { hook!.resetFrom(next, { photoFocus: Array.isArray(focus) ? focus : undefined, photo_focus: focus }); }); },
                sent: () => hook!.forPhotos(photos),
            };
        });
        expect(wrong).toEqual([]);
    });

    it('no phone form keeps focus points in a list beside its photos, or opens Adjust on a photo\'s place', () => {
        for (const form of ['../../app/new-listing.tsx', '../../app/post/[id].tsx']) {
            const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), form), 'utf8');
            expect(src, form).toContain('usePhotoFocusList()');
            expect(src, form).not.toMatch(/useState<Array<PhotoFocus \| null>>/);
            // Adjust opens on the photo itself (`.open(uri)`), never a number, and a removal moves no focus by its place.
            expect(src, form).not.toMatch(/Focus\.open\(\s*i\s*\)/);
            expect(src, form).not.toMatch(/removeAt\(/);
        }
    });
});

describe('usePhotoFocusList: Adjust opens by itself on the photos a pick adds, and walks through them (Marty, 28 Nov 2026)', () => {
    /** The hook in a probe, driven as core's walk table drives it (the web's usePhotoFocusByPhoto runs the same table). */
    async function hookDriver() {
        const { usePhotoFocusList } = await import('../use-photo-focus-list');
        return () => {
            let hook: ReturnType<typeof usePhotoFocusList> | null = null;
            let photos: string[] = [];
            const Probe = () => { hook = usePhotoFocusList(); return null; };
            act(() => { root.render(createElement(Probe, { key: Math.random() }) as any); });
            return {
                setPhotos: (next: string[]) => { photos = next; },
                added: (added: string[]) => act(() => { hook!.added(added); }),
                open: (photo: string) => act(() => { hook!.open(photo); }),
                done: (f: PhotoFocus | null) => act(() => { hook!.done(f); }),
                skip: (f: PhotoFocus | null) => act(() => { hook!.skip(f); }),
                cancel: () => act(() => { hook!.close(); }),
                putWhole: (next: string[], focus: unknown) => { photos = next; act(() => { hook!.resetFrom(next, { photoFocus: Array.isArray(focus) ? focus : undefined, photo_focus: focus }); }); },
                showing: () => ({ photo: hook!.adjusting, step: hook!.step }),
                sent: () => hook!.forPhotos(photos),
            };
        };
    }

    it('an edit: Done or Skip with nothing moved marks nothing, so nothing is sent; a real change marks it touched', async () => {
        const { usePhotoFocusList } = await import('../use-photo-focus-list');
        let hook: ReturnType<typeof usePhotoFocusList> | null = null;
        const Probe = () => { hook = usePhotoFocusList(); return null; };
        act(() => { root.render(createElement(Probe) as any); });
        act(() => { hook!.resetFrom(['u1'], { photoFocus: [{ x: 0.2, y: 0.8 }] }); });
        act(() => { hook!.added(['n1', 'n2']); });
        act(() => { hook!.done(null); });
        act(() => { hook!.skip(null); });
        act(() => { hook!.open('u1'); });
        act(() => { hook!.done({ x: 0.2, y: 0.8 }); });
        expect(hook!.touched).toBe(false);
        expect(hook!.forEdit(['u1', 'n1', 'n2'])).toBeUndefined();
        act(() => { hook!.added(['n3']); });
        act(() => { hook!.done({ x: 0.5, y: 0 }); });
        expect(hook!.touched).toBe(true);
        expect(hook!.forEdit(['u1', 'n1', 'n2', 'n3'])).toEqual([{ x: 0.2, y: 0.8 }, null, null, { x: 0.5, y: 0 }]);
    });

    it('holds every walk in core\'s table on Android, where it opens at once', async () => {
        const { checkPhotoFocusRunVectors } = await import('@beanpool/core/photo-focus-vectors');
        expect(checkPhotoFocusRunVectors(await hookDriver())).toEqual([]);
    });

    it('iOS: waits for the picker to finish closing, then opens; a tap or a list put in whole in the meantime wins', async () => {
        const { ADJUST_AFTER_PICKER_MS } = await import('../use-photo-focus-list');
        platform.OS = 'ios';
        vi.useFakeTimers();
        try {
            const form = (await hookDriver())();
            form.setPhotos(['A', 'B']);
            form.added(['A', 'B']);
            expect(form.showing().photo).toBeNull();
            act(() => { vi.advanceTimersByTime(ADJUST_AFTER_PICKER_MS - 1); });
            expect(form.showing().photo).toBeNull();
            act(() => { vi.advanceTimersByTime(1); });
            expect(form.showing()).toEqual({ photo: 'A', step: { n: 1, count: 2, more: true } });
            form.cancel();
            // A tap while a walk waits: the photo tapped, alone; the walk never comes.
            form.added(['A', 'B']);
            form.open('B');
            act(() => { vi.advanceTimersByTime(ADJUST_AFTER_PICKER_MS * 2); });
            expect(form.showing()).toEqual({ photo: 'B', step: null });
            form.cancel();
            // The list put in whole (a post made, another post's edit) while a walk waits: nothing opens.
            form.added(['A', 'B']);
            form.putWhole([], undefined);
            act(() => { vi.advanceTimersByTime(ADJUST_AFTER_PICKER_MS * 2); });
            expect(form.showing().photo).toBeNull();
            // Leaving the form while a walk waits: nothing is set after it has gone.
            form.added(['A']);
            act(() => root.unmount());
            act(() => { vi.advanceTimersByTime(ADJUST_AFTER_PICKER_MS * 2); });
            root = createRoot(host);
        } finally {
            vi.useRealTimers();
            platform.OS = 'android';
        }
    });

    it('each phone form opens the walk only from a pick (askForPostPhotos\'s `picked`), never as an edit opens, and hands Adjust its step and Skip', () => {
        for (const [form, hook] of [['../../app/new-listing.tsx', 'photoFocus'], ['../../app/post/[id].tsx', 'editFocus']] as const) {
            const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), form), 'utf8');
            // `added` is named once: as the pick's listener.
            expect(src.split(`${hook}.added`).length - 1, form).toBe(1);
            expect(src, form).toMatch(new RegExp(`askForPostPhotos\\([\\s\\S]*?, undefined, ${hook}\\.added\\);`));
            expect(src, form).toContain(`step={${hook}.step}`);
            expect(src, form).toContain(`onDone={${hook}.done}`);
            expect(src, form).toContain(`onSkip={${hook}.skip}`);
            expect(src, form).toContain(`onCancel={${hook}.close}`);
        }
    });
});

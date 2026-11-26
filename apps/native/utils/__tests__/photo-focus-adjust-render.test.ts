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
    };
});
vi.mock('expo-image', async () => {
    const { createElement: h } = await import('react');
    return { Image: (props: Record<string, unknown>) => { if (props.testID) images.byId.set(String(props.testID), props); return h('img', { 'data-testid': props.testID ?? 'photo' }); } };
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

function draw(focus: PhotoFocus | null, onDone = vi.fn(), onCancel = vi.fn()) {
    act(() => { root.render(createElement(PhotoFocusAdjust, { uri: 'file:///photo.jpg', focus, onDone, onCancel })); });
    return { onDone, onCancel };
}
const press = (label: string) => {
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
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

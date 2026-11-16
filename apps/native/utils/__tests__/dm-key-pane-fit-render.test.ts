// @vitest-environment jsdom
/**
 * The verified key-changed card on a small phone (walk of 17 Nov, scratch/walks shots 13, 27 and 29): at 320 dp with
 * 1.3× text the card had 219 dp, its title and part of its body, with the code, the tick and "Continue with the new
 * key" in a scroll inside the card, cut at its edge with no hint; with the keyboard up it had only its title.
 *
 * One table over (light, dark) × (phone, text size) × (deals bar or not) × (keyboard down, up): the real card
 * (components/chat/DmKeyChangedPane.tsx around DmKeyChangedBanner) rendered into jsdom with React Native's host
 * components as tags, laid out by Yoga (yoga-dom-layout.ts) in the DM screen's column as the walk measured it (the
 * column under the header, the deals bar, the thread, the paused box), with the height dmKeyBannerMaxHeight gives it.
 * In every row: the box is never cut; a card taller than its room fills the room down to the box (the thread gives
 * way), so it scrolls as the page, with its scroll bar always shown and its bottom edge fading; a keyboard up is put
 * away. (Where the code lands in pixels is the phone's to show: Yoga's words are an estimate, so the owed walk checks it.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, forwardRef, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { randomBytes } from 'node:crypto';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createElement: h } = await import('react');
    const flat = (style: unknown): Record<string, unknown> => (Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : (style as Record<string, unknown>) ?? {});
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, disabled, testID, style } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        return h(tag, attrs, children);
    };
    // A ScrollView: its frame, and inside it the content at its own height (Yoga's overflow scroll leaves the scroll
    // axis open). What the member is shown about scrolling is written out for the table to read.
    const ScrollView = forwardRef((props: Record<string, any>, ref) => {
        useImperativeHandle(ref, () => ({ flashScrollIndicators: () => scroll.flashed++ }));
        scroll.onSize = props.onContentSizeChange;
        return h('div', {
            'data-testid': props.testID, 'data-style': JSON.stringify({ ...flat(props.style), overflow: 'scroll' }),
            'data-persistent-scrollbar': String(!!props.persistentScrollbar),
            'data-fade': String(props.fadingEdgeLength ?? 0),
        }, h('div', { 'data-testid': 'pane-content', 'data-style': '{}' }, props.children));
    });
    return { View: el('div'), Text: el('span'), Pressable: el('div'), ScrollView, StyleSheet: { create: (s: unknown) => s } };
});
const scroll = vi.hoisted(() => ({ flashed: 0, onSize: undefined as undefined | ((w: number, h: number) => void) }));
const keyboard = vi.hoisted(() => ({ isVisible: false, height: 0, dismiss: vi.fn(async () => {}) }));
vi.mock('react-native-keyboard-controller', () => ({
    useKeyboardState: (pick: (s: { isVisible: boolean; height: number }) => unknown) => pick({ isVisible: keyboard.isVisible, height: keyboard.height }),
    KeyboardController: { dismiss: keyboard.dismiss },
}));
const theme = vi.hoisted(() => ({ colors: null as any }));
vi.mock('../../app/ThemeContext', () => ({
    useTheme: () => ({ colors: theme.colors }),
    useStyles: (make: (c: { colors: unknown }) => unknown) => make({ colors: theme.colors }),
}));
vi.mock('../db', () => ({}));

import { lightColors, darkColors } from '../../constants/colors';
import { DmKeyChangedPane } from '../../components/chat/DmKeyChangedPane';
import { dmKeyBannerMaxHeight } from '../dm-key-change';
import { layOut } from './yoga-dom-layout';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); scroll.flashed = 0; keyboard.dismiss.mockClear(); });
afterEach(() => { act(() => root.unmount()); host.remove(); keyboard.isVisible = false; keyboard.height = 0; });

/**
 * The DM screen's column under the header, as measured: the walk's phone from its dump (480 × 854 px at 1.5: the column
 * 96 → 521 dp, the paused box with its line 109 dp at 1.3×), and 320 × 533 with a 48-dp nav bar (column 533 − 48 − 24 −
 * 64), the box as #1873's geometry has it at each text size.
 */
const PHONES = [
    { name: 'the walk\'s 320 × 569', column: { 1: 425, 1.3: 425 }, box: { 1: 101, 1.3: 109 } },
    { name: '320 × 533, 48-dp nav bar', column: { 1: 397, 1.3: 397 }, box: { 1: 101, 1.3: 109 } },
] as const;
/** The walk's keyboard (shot 27: 405 → 782 px at 1.5). With a deals bar too a 320-dp phone has no room for the box over it at all. */
const KEYBOARD = 250;

/** The column with the card, the deals bar, the thread and the box, as [id].tsx stacks them, laid out at 320 dp. */
function renderColumn(p: (typeof PHONES)[number], fontScale: 1 | 1.3, deals: number, keyboardUp: boolean) {
    const column = p.column[fontScale], box = p.box[fontScale];
    keyboard.isVisible = keyboardUp;
    keyboard.height = keyboardUp ? KEYBOARD : 0;
    const kb = keyboardUp ? KEYBOARD : 0;
    const maxHeight = dmKeyBannerMaxHeight({ column, composer: box, deals, windowHeight: column + 88, keyboard: kb });
    const pane = createElement(DmKeyChangedPane, {
        maxHeight, peerName: 'Ben', change: { offeredPeer: randomBytes(32).toString('hex'), firstSight: false, verified: true },
        onContinue: vi.fn(), onNotNow: vi.fn(),
    });
    const tree = createElement('div', { 'data-testid': 'column', 'data-style': JSON.stringify({ height: column, flexDirection: 'column' }) },
        pane,
        deals ? createElement('div', { 'data-testid': 'deals', 'data-style': JSON.stringify({ height: deals }) }) : null,
        // The keyboard view: the thread (flex 1), the box, and the keyboard's padding under it.
        createElement('div', { 'data-style': JSON.stringify({ flex: 1, paddingBottom: kb }) },
            createElement('div', { 'data-testid': 'thread', 'data-style': JSON.stringify({ flex: 1 }) }),
            createElement('div', { 'data-testid': 'box', 'data-style': JSON.stringify({ height: box }) })));
    act(() => root.render(tree as Parameters<Root['render']>[0]));
    const q = (id: string) => host.querySelector(`[data-testid="${id}"]`)!;
    const layout = layOut(q('column'), { width: 320, height: column }, { fontScale });
    const top = (el: Element) => { let y = 0; for (let e: Element | null = el; e && e !== q('column'); e = e.parentElement) y += layout.box(e).top; return y; };
    // The phone reports the content's size once laid out (twice here: a second report never flashes again).
    act(() => { scroll.onSize?.(320, layout.height(q('pane-content'))); scroll.onSize?.(320, layout.height(q('pane-content'))); });
    return {
        column, box, kb, maxHeight,
        pane: { top: top(q('dm-key-pane')), height: layout.height(q('dm-key-pane')), content: layout.height(q('pane-content')), el: q('dm-key-pane') },
        thread: layout.height(q('thread')),
        boxTop: top(q('box')), boxBottom: top(q('box')) + layout.height(q('box')),
    };
}

describe.each([['light', lightColors], ['dark', darkColors]] as const)('the verified key card on a small phone, %s', (_name, colors) => {
    beforeEach(() => { theme.colors = colors; });
    for (const p of PHONES) for (const fontScale of [1, 1.3] as const) for (const [deals, keyboardUp] of [[0, false], [72, false], [0, true]] as const) {
        it(`${p.name} at ${fontScale}×, ${deals ? 'a deals bar' : 'no deals bar'}, keyboard ${keyboardUp ? 'up' : 'down'}: the box is never cut, the card scrolls as the page, its scroll is shown`, () => {
            const r = renderColumn(p, fontScale, deals, keyboardUp);
            // The box sits above the keyboard, whole.
            expect(r.boxBottom + r.kb).toBeLessThanOrEqual(r.column);
            expect(r.pane.top + r.pane.height + deals).toBeLessThanOrEqual(r.boxTop);
            // At 320 dp the card (title, body, code, tick, Continue, Not now) is taller than any of these rooms: it fills the
            // room down to the box, with no strip of thread under a cut card, and scrolls as the page.
            expect(r.pane.content).toBeGreaterThan(r.pane.height);
            expect(r.thread).toBe(0);
            expect(r.pane.top + r.pane.height + deals).toBe(r.boxTop);
            // Its scroll is never hidden: the bar stays shown (Android), it flashes once on opening (iOS), the edge fades.
            expect(r.pane.el.getAttribute('data-persistent-scrollbar')).toBe('true');
            expect(Number(r.pane.el.getAttribute('data-fade'))).toBeGreaterThan(0);
            expect(scroll.flashed).toBe(1);
            // A keyboard up is put away: nothing can be typed while the card is up.
            expect(keyboard.dismiss).toHaveBeenCalledTimes(keyboardUp ? 1 : 0);
        });
    }
});

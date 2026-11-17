// @vitest-environment jsdom
/**
 * The composer in a room (components/chat/ChatComposer maxHeight; utils/chat-column-fit chatFieldCap). On a 320-dp phone at
 * 1.3× with the keyboard up, the DM's Editing or Replying to banner and a two- or three-line draft don't both fit, and the
 * banner folded away with its ✕ (deciding review of #3283 at f4bbcfa4, finding 1). The banner now stays whole and the field
 * gives way: it grows only as far as the room less the composer's own frame, scrolls within itself past that, never goes
 * under its line, and grows back without a keystroke when the room returns. Without a room it grows as it always has.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, forwardRef, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const seen = vi.hoisted(() => ({
    field: undefined as undefined | number,
    onSize: undefined as undefined | ((e: { nativeEvent: { contentSize: { height: number } } }) => void),
    onFrame: undefined as undefined | ((e: { nativeEvent: { layout: { height: number } } }) => void),
}));

vi.mock('react-native', async () => {
    const { createElement: h } = await import('react');
    const flat = (style: unknown): Record<string, unknown> => (Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : (style as Record<string, unknown>) ?? {});
    // The composer's outer View is the one with no style: what it measures round the field is the frame.
    const View = (props: Record<string, any>) => {
        if (props.style === undefined) seen.onFrame = props.onLayout;
        return h('div', null, props.children);
    };
    const TextInput = forwardRef((props: Record<string, any>, ref) => {
        seen.field = flat(props.style).height as number;
        seen.onSize = props.onContentSizeChange;
        useImperativeHandle(ref, () => ({ clear: () => { }, setNativeProps: () => { }, focus: () => { } }));
        return h('textarea', { 'aria-label': props.accessibilityLabel });
    });
    return {
        View, Text: (p: Record<string, any>) => h('span', null, p.children), TextInput,
        Pressable: (p: Record<string, any>) => h('button', null, p.children),
        ActivityIndicator: () => null,
        StyleSheet: { create: (s: unknown) => s },
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
    };
});
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return { useTheme: () => ({ theme: 'light', colors: lightColors }) };
});

import { ChatComposer } from '../../components/chat/ChatComposer';
import { CHAT_INPUT_MAX_HEIGHT, CHAT_INPUT_MIN_HEIGHT, CHAT_INPUT_V_PADDING } from '../../components/chat/styles';

const anyStyles = new Proxy({}, { get: () => ({}) }) as any;
/** A draft of n lines at 1.3× text: 16 sp × 1.25 × 1.3 a line. */
const lines = (n: number) => n * 16 * 1.25 * 1.3;
/** The composer's frame with the keyboard up: 8 over the field, 8 under it, a 1-dp border. */
const FRAME = 17;

describe('ChatComposer in a room: the field gives way, never under its line', () => {
    let root: Root;
    let host: HTMLDivElement;
    const render = (maxHeight?: number) => act(() => {
        root.render(createElement(ChatComposer, { styles: anyStyles, onSend: async () => { }, placeholder: 'Message', accessibilityLabel: 'Message', bottomPadding: 8, maxHeight }) as any);
    });
    const draft = (n: number) => act(() => { seen.onSize!({ nativeEvent: { contentSize: { height: lines(n) } } }); });
    /** The phone lays the composer out: its frame round the field as shown. */
    const layOutComposer = () => act(() => { seen.onFrame!({ nativeEvent: { layout: { height: FRAME + seen.field! } } }); });

    beforeEach(() => {
        host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
        seen.field = undefined; seen.onSize = undefined; seen.onFrame = undefined;
    });
    afterEach(() => { act(() => root.unmount()); host.remove(); });

    it('without a room the field grows with the draft to its cap, and nothing is measured round it', () => {
        render();
        expect(seen.onFrame).toBeUndefined();
        draft(3);
        expect(seen.field).toBe(Math.ceil(lines(3)) + CHAT_INPUT_V_PADDING);
        draft(6);
        expect(seen.field).toBe(CHAT_INPUT_MAX_HEIGHT);
    });
    it('in 81 dp (320 × 533 at 1.3×, keyboard up, less a 66-dp banner) three lines show in 64 dp and scroll in the field', () => {
        render(81);
        draft(3);
        // Before the frame is known the field is held to the room itself, then to the room less the frame.
        expect(seen.field).toBe(81);
        layOutComposer();
        expect(seen.field).toBe(81 - FRAME);
        // Laid out again at that height, it stays: the frame doesn't move with the field.
        layOutComposer();
        expect(seen.field).toBe(81 - FRAME);
    });
    it('a draft that fits the room keeps its own height', () => {
        render(81);
        draft(1);
        layOutComposer();
        expect(seen.field).toBe(Math.ceil(lines(1)) + CHAT_INPUT_V_PADDING);
    });
    it('the room comes back (the banner closed, the keyboard down): the field grows back without a keystroke', () => {
        render(81);
        draft(3);
        layOutComposer();
        expect(seen.field).toBe(64);
        render(300);
        expect(seen.field).toBe(Math.ceil(lines(3)) + CHAT_INPUT_V_PADDING);
        render(undefined);
        expect(seen.field).toBe(Math.ceil(lines(3)) + CHAT_INPUT_V_PADDING);
    });
    it('a room too small for even a line: the field keeps its line', () => {
        render(30);
        draft(3);
        layOutComposer();
        expect(seen.field).toBe(CHAT_INPUT_MIN_HEIGHT);
    });
});

// @vitest-environment jsdom
/**
 * The voice bubble's waveform (components/chat/VoiceBubble.tsx; DESIGN-cross-chat-voice-fable.md §5.5): a tap moves the sound
 * to where it lands on the WHOLE waveform (PR #3112 review). React Native measures `locationX` from the view the finger
 * landed on, and the 48 bars are views of their own: a tap that hit a bar measured 0 to 2 dp from that bar, so it moved the
 * sound to the start.
 *
 * The bubble is drawn as DOM with the touch delivered the way React Native delivers it (`touch` below): the deepest view
 * under the finger that may take touches is the target, a parent with pointerEvents "box-only" (or a child with "none")
 * keeps the touch on the parent, and locationX is measured from the target. The bars are laid out as the wave's
 * `justifyContent: 'space-between'` lays them out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, Children, isValidElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const wave: { props?: Record<string, any> } = {};
const seek = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        if (props.testID === 'voice-wave') wave.props = props;
        const attrs: Record<string, unknown> = {};
        if (props.testID) attrs['data-testid'] = props.testID;
        return createElement(tag, attrs, props.children);
    };
    return {
        View: el('div'), Text: el('span'), Pressable: el('button'),
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
vi.mock('../../components/chat/VoicePlayback', () => ({
    useVoicePlayback: () => ({
        currentId: null, playing: false, position: 0, duration: 0, speed: 1,
        toggle: vi.fn(), seek, cycleSpeed: vi.fn(), register: vi.fn(),
    }),
}));

import { VOICE_BARS } from '@beanpool/core';
import { VoiceBubble } from '../../components/chat/VoiceBubble';

const WAVE_W = 150;
let root: Root;
let host: HTMLDivElement;

/** The bars' left edges, as `justifyContent: 'space-between'` lays them out in a WAVE_W dp waveform. */
function barLefts(bars: ReactElement<any>[]): { left: number; width: number; el: ReactElement<any> }[] {
    const widths = bars.map((b) => Number(b.props.style?.width) || 0);
    const gap = (WAVE_W - widths.reduce((a, w) => a + w, 0)) / (bars.length - 1);
    let x = 0;
    return bars.map((el, i) => { const left = x; x += widths[i] + gap; return { left, width: widths[i], el }; });
}

/** A finger down and up `x` dp from the waveform's left edge, delivered as React Native delivers it. */
async function touch(x: number) {
    const p = wave.props!;
    const bars = Children.toArray(p.children).filter(isValidElement) as ReactElement<any>[];
    const hit = p.pointerEvents === 'box-only' || p.pointerEvents === 'none'
        ? undefined
        : barLefts(bars).find((b) => b.el.props.pointerEvents !== 'none' && x >= b.left && x < b.left + b.width);
    const locationX = hit ? x - hit.left : x;
    await act(async () => { p.onResponderRelease({ nativeEvent: { locationX, pageX: 40 + x, pageY: 300 } }); });
}

beforeEach(async () => {
    seek.mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const load = async () => ({ kind: 'ok' as const, voice: { uri: 'file:///v.m4a', durationMs: 20_000, bars: new Array(VOICE_BARS).fill(200) } });
    await act(async () => { root.render(createElement(VoiceBubble, { messageId: 'm1', load, isMe: false }) as any); });
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
    await act(async () => { wave.props!.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: WAVE_W, height: 28 } } }); });
});
afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
});

describe('VoiceBubble: a tap on the waveform moves the sound to where it lands', () => {
    it('on a bar, mid-way along: half way, not the start', async () => {
        const bars = Children.toArray(wave.props!.children).filter(isValidElement) as ReactElement<any>[];
        expect(bars).toHaveLength(VOICE_BARS);
        const mid = barLefts(bars)[24];
        const x = mid.left + mid.width / 2;   // on bar 24, the middle of the waveform
        await touch(x);
        expect(seek).toHaveBeenCalledTimes(1);
        const [id, uri, share] = seek.mock.calls[0];
        expect([id, uri]).toEqual(['m1', 'file:///v.m4a']);
        expect(share).toBeCloseTo(x / WAVE_W, 5);
        expect(share).toBeGreaterThan(0.45);
    });

    it('near the end, on the last bar: the end', async () => {
        await touch(WAVE_W - 1);
        expect(seek.mock.calls[0][2]).toBeCloseTo((WAVE_W - 1) / WAVE_W, 5);
    });
});

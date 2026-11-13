// @vitest-environment jsdom
/**
 * The composer's microphone (components/chat/ChatComposer.tsx with components/chat/VoiceRecorder.tsx; slice V3, DESIGN-cross-
 * chat-voice-fable.md §5.3), the real components drawn as DOM at 320 dp with 1.3× text, in light and dark, with expo-audio's
 * stand-in (utils/__tests__/expo-audio-stub.ts) and the hold driven through the touch responder the microphone's View has:
 *   - with the box empty the microphone is in Send's place; typed words bring Send back; no onVoice, no microphone;
 *   - the first hold only asks for the microphone: nothing is recorded, and the next hold records;
 *   - let go under one second: nothing is sent, and "Hold to record" shows;
 *   - slide left: thrown away, nothing sent;
 *   - let go after two seconds: sent, with its length, 48 bars and the file's bytes;
 *   - slide up and let go: still recording; Stop keeps it; Send sends it;
 *   - every colour the recorder draws is one of the library's roles, and its words read at 4.5:1 on the composer.
 * The 320 dp layout itself (nothing past the edge, 44 dp targets) is measured in Chromium by e2e/voice-320.mjs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, forwardRef, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const box: { onChangeText?: (t: string) => void } = {};
/** The microphone's touch responder, as the View was handed it: the test's finger. */
const pan: { config?: Record<string, (...a: any[]) => any> } = {};
const theme = vi.hoisted(() => ({ scheme: 'light' as 'light' | 'dark' }));

vi.mock('react-native', () => {
    const flat = (style: any): Record<string, any> => (Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : style || {});
    const el = (tag: string) => (props: Record<string, any>) => {
        const s = flat(props.style);
        const attrs: Record<string, unknown> = {};
        if (props.testID) attrs['data-testid'] = props.testID;
        if (props.accessibilityLabel) attrs['aria-label'] = props.accessibilityLabel;
        if (props.accessibilityRole) attrs['data-role'] = props.accessibilityRole;
        if (s.color) attrs['data-color'] = String(s.color);
        if (s.backgroundColor) attrs['data-bg'] = String(s.backgroundColor);
        if (s.display === 'none') attrs['data-hidden'] = '1';
        if (s.width) attrs['data-w'] = String(s.width);
        if (s.height) attrs['data-h'] = String(s.height);
        if (props.onPress) attrs.onClick = () => { if (!props.disabled) props.onPress(); };
        if (props.testID === 'voice-mic' && props.onResponderGrant) pan.config = props;
        return createElement(tag, attrs, props.children);
    };
    const TextInput = forwardRef((props: Record<string, any>, ref) => {
        box.onChangeText = props.onChangeText;
        useImperativeHandle(ref, () => ({ clear: () => { }, setNativeProps: () => { }, focus: () => { } }));
        return createElement('input', { 'aria-label': props.accessibilityLabel, 'data-hidden': flat(props.style).display === 'none' ? '1' : undefined });
    });
    return {
        View: el('div'), Text: el('span'), Pressable: el('button'), TextInput,
        ActivityIndicator: () => null,
        StyleSheet: { create: (s: unknown) => s, flatten: flat },
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        AccessibilityInfo: { isScreenReaderEnabled: async () => false, addEventListener: () => ({ remove() { } }) },
        AppState: { addEventListener: () => ({ remove() { } }) },
        Alert: { alert: vi.fn() },
        Linking: { openSettings: vi.fn(async () => { }) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('expo-file-system/legacy', () => ({
    EncodingType: { Base64: 'base64' },
    // An .m4a's head (ftyp M4A) and four bytes more.
    readAsStringAsync: vi.fn(async () => 'AAAAFGZ0eXBNNEEgAAAAAE00QSAAAAAA'),
    deleteAsync: vi.fn(async () => { }),
}));
vi.mock('../crypto', () => ({
    decodeBase64: (b64: string) => Uint8Array.from(Buffer.from(b64, 'base64')),
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    return { useTheme: () => ({ theme: theme.scheme, colors: theme.scheme === 'dark' ? darkColors : lightColors }) };
});

import { contrastRatio, VOICE_BARS } from '@beanpool/core';
import { expoAudioStub } from './expo-audio-stub';
import { ChatComposer } from '../../components/chat/ChatComposer';
import { makeChatStyles } from '../../components/chat/styles';
import { lightColors, darkColors } from '../../constants/colors';

let root: Root;
let host: HTMLDivElement;
const sent: any[] = [];

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const flush = async () => { await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); }); };
const at = (x: number, y: number) => ({ nativeEvent: { pageX: 300 + x, pageY: 500 + y } });
const hold = async () => { await act(async () => { pan.config!.onResponderGrant(at(0, 0)); }); await flush(); };
const move = async (dx: number, dy: number) => { await act(async () => { pan.config!.onResponderMove(at(dx, dy)); }); await flush(); };
const release = async () => { await act(async () => { pan.config!.onResponderRelease(at(0, 0)); }); await flush(); };
/** The recorder's clock reaching `ms`: the stand-in's state, and a render so the tick is read. */
const clock = async (ms: number) => {
    expoAudioStub.recorderState.durationMillis = ms;
    expoAudioStub.recorderState.isRecording = expoAudioStub.recorder.isRecording;
    expoAudioStub.recorderState.metering = -10;
    await act(async () => { render(); });
    await flush();
};

function render(withVoice = true) {
    const colors = theme.scheme === 'dark' ? darkColors : lightColors;
    root.render(createElement(ChatComposer, {
        styles: makeChatStyles({ theme: theme.scheme, colors } as any), onSend: async () => { }, placeholder: 'Message', accessibilityLabel: 'Message',
        bottomPadding: 12, onVoice: withVoice ? async (v: any) => { sent.push(v); } : undefined,
    }) as any);
}

beforeEach(async () => {
    expoAudioStub.reset();
    expoAudioStub.permission = { granted: true, canAskAgain: true, status: 'granted' };
    sent.length = 0;
    theme.scheme = 'light';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { render(); });
    await flush();
});
afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
});

describe('ChatComposer: the microphone in Send\'s place', () => {
    it('shows with the box empty; typed words bring Send back; a chat without voice has none', async () => {
        expect(q('voice-mic')).not.toBeNull();
        expect(host.querySelector('[aria-label="Send message"]')).toBeNull();
        await act(async () => { box.onChangeText!('hello'); });
        expect(q('voice-mic')).toBeNull();
        expect(host.querySelector('[aria-label="Send message"]')).not.toBeNull();
        await act(async () => { box.onChangeText!(''); });
        expect(q('voice-mic')).not.toBeNull();
        await act(async () => { render(false); });
        expect(q('voice-mic')).toBeNull();
    });

    it('the first hold only asks for the microphone; the next hold records', async () => {
        expoAudioStub.permission = { granted: false, canAskAgain: true, status: 'undetermined' };
        await act(async () => { root.unmount(); });
        root = createRoot(host);
        await act(async () => { render(); });
        await flush();
        expect(expoAudioStub.asked).toBe(0);   // nothing asked when the chat opened
        await hold();
        expect(expoAudioStub.asked).toBe(1);
        expect(expoAudioStub.recorder.prepared).toBe(0);
        expect(expoAudioStub.recorder.isRecording).toBe(false);
        await release();
        expect(sent).toEqual([]);
        await hold();
        expect(expoAudioStub.asked).toBe(1);
        expect(expoAudioStub.recorder.isRecording).toBe(true);
        expect(q('voice-bar')).not.toBeNull();
    });

    it('let go under one second: nothing sent, "Hold to record" shows', async () => {
        await hold();
        expect(expoAudioStub.recorder.isRecording).toBe(true);
        await clock(600);
        await release();
        expect(sent).toEqual([]);
        expect(expoAudioStub.recorder.isRecording).toBe(false);
        expect(q('voice-hint')?.textContent).toBe('Hold to record');
        expect(q('voice-bar')).toBeNull();
    });

    it('slide left: thrown away, nothing sent', async () => {
        await hold();
        await clock(4000);
        expect(q('voice-slide')?.textContent).toContain('Slide to cancel');
        await move(-120, 0);
        await release();
        expect(sent).toEqual([]);
        expect(q('voice-bar')).toBeNull();
    });

    it('let go after two seconds: sent with its length, 48 bars and the file\'s bytes', async () => {
        await hold();
        await clock(2300);
        expect(q('voice-clock')?.textContent).toBe('0:02');
        await release();
        expect(sent).toHaveLength(1);
        expect(sent[0].durationMs).toBe(2300);
        expect(sent[0].bars).toHaveLength(VOICE_BARS);
        expect(Array.from(sent[0].sound.slice(4, 8))).toEqual([0x66, 0x74, 0x79, 0x70]);
    });

    it('slide up and let go: still recording; Stop keeps it; Send sends it', async () => {
        await hold();
        await clock(1500);
        await move(0, -100);
        await release();
        expect(sent).toEqual([]);
        expect(expoAudioStub.recorder.isRecording).toBe(true);
        expect(q('voice-stop')).not.toBeNull();
        expect(q('voice-bin')).not.toBeNull();
        await clock(5000);
        await act(async () => { q('voice-stop')!.click(); });
        await flush();
        expect(expoAudioStub.recorder.isRecording).toBe(false);
        expect(q('voice-preview')).not.toBeNull();
        expect(sent).toEqual([]);
        await act(async () => { q('voice-send')!.click(); });
        await flush();
        expect(sent).toHaveLength(1);
        expect(sent[0].durationMs).toBe(5000);
    });

    it('the bin on a kept recording sends nothing', async () => {
        await hold();
        await clock(3000);
        await move(0, -100);
        await release();
        await act(async () => { q('voice-stop')!.click(); });
        await flush();
        await act(async () => { q('voice-bin')!.click(); });
        await flush();
        expect(sent).toEqual([]);
        expect(q('voice-mic')).not.toBeNull();
    });
});

describe('ChatComposer\'s recorder at 320 dp with 1.3× text: colours from the library, words that read', () => {
    it.each([['light'], ['dark']] as const)('%s', async (scheme) => {
        theme.scheme = scheme;
        const colors = scheme === 'dark' ? darkColors : lightColors;
        await act(async () => { render(); });
        await hold();
        await clock(42_000);
        // The recording's line: the clock in body ink, "Slide to cancel" in muted, both on the composer's card.
        const clockEl = q('voice-clock')!;
        const slide = q('voice-slide')!;
        expect(clockEl.getAttribute('data-color')).toBe(colors.text.body);
        expect(slide.getAttribute('data-color')).toBe(colors.text.muted);
        expect(contrastRatio(colors.text.body, colors.surface.card)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(colors.text.muted, colors.surface.card)).toBeGreaterThanOrEqual(4.5);
        // The held microphone: 48 dp, the danger fill.
        const mic = q('voice-mic')!;
        expect(mic.getAttribute('data-w')).toBe('48');
        expect(mic.getAttribute('data-h')).toBe('48');
        expect(mic.querySelector(`[data-bg="${colors.feedback.danger.solid}"]`)).not.toBeNull();
        // The box stays mounted (nothing typed is lost) but out of sight.
        expect(host.querySelector('input')?.getAttribute('data-hidden')).toBe('1');
        // Locked: bin, Stop and Send, each 48 dp.
        await move(0, -100);
        await release();
        for (const id of ['voice-bin', 'voice-stop', 'voice-send']) {
            expect(q(id)?.getAttribute('data-w')).toBe('48');
            expect(q(id)?.getAttribute('data-h')).toBe('48');
        }
    });
});

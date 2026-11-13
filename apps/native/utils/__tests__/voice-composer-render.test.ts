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
 * And PR #3112's review:
 *   - the box isn't remounted when the microphone first arrives (a DM's first render has none), so its words stay;
 *   - a recording pauses the chat's player, and nothing plays, moves on or flips the audio mode until it is sent;
 *   - a send that didn't go keeps the recording, back for play, bin and Send, and nothing new records while one is going;
 *   - the microphone turned on in Settings reaches the open chat when the app comes back to the front.
 * And its round 2:
 *   - a refusal the screen shows above the box (VoiceNotSentError) keeps the recording, back for review, with no second word;
 *   - one line id per recording, the same on every try of it, a new one for the next recording;
 *   - a recording waiting in one chat holds only that chat's player, and another chat's send never lets go of it.
 * The 320 dp layout itself (nothing past the edge, 44 dp targets) is measured in Chromium by e2e/voice-320.mjs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, forwardRef, useEffect, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const box: { onChangeText?: (t: string) => void; mounts: number } = { mounts: 0 };
/** The microphone's touch responder, as the View was handed it: the test's finger. */
const pan: { config?: Record<string, (...a: any[]) => any> } = {};
const theme = vi.hoisted(() => ({ scheme: 'light' as 'light' | 'dark' }));
/** The app's AppState listeners: the test brings the app back to the front. */
const appState = vi.hoisted(() => ({ listeners: new Set<(s: string) => void>() }));

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
        // Counted once per mount: the box is uncontrolled, so a remount drops its words on a phone.
        useEffect(() => { box.mounts += 1; }, []);
        useImperativeHandle(ref, () => ({ clear: () => { }, setNativeProps: () => { }, focus: () => { } }));
        return createElement('input', { 'aria-label': props.accessibilityLabel, 'data-hidden': flat(props.style).display === 'none' ? '1' : undefined });
    });
    return {
        View: el('div'), Text: el('span'), Pressable: el('button'), TextInput,
        ActivityIndicator: () => null,
        StyleSheet: { create: (s: unknown) => s, flatten: flat },
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        AccessibilityInfo: { isScreenReaderEnabled: async () => false, addEventListener: () => ({ remove() { } }) },
        AppState: {
            addEventListener: (_: string, fn: (s: string) => void) => { appState.listeners.add(fn); return { remove() { appState.listeners.delete(fn); } }; },
        },
        Alert: { alert: vi.fn() },
        Linking: { openSettings: vi.fn(async () => { }) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => { }) } }));
vi.mock('expo-file-system/legacy', () => ({
    EncodingType: { Base64: 'base64' },
    // An .m4a's head (ftyp M4A) and four bytes more.
    readAsStringAsync: vi.fn(async () => 'AAAAFGZ0eXBNNEEgAAAAAE00QSAAAAAA'),
    deleteAsync: vi.fn(async () => { }),
}));
vi.mock('../crypto', () => ({
    decodeBase64: (b64: string) => Uint8Array.from(Buffer.from(b64, 'base64')),
}));
// A recording's line id, made at its first send.
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    return { useTheme: () => ({ theme: theme.scheme, colors: theme.scheme === 'dark' ? darkColors : lightColors }) };
});

import { contrastRatio, VOICE_BARS } from '@beanpool/core';
import { Alert } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { expoAudioStub } from './expo-audio-stub';
import { ChatComposer, type ChatComposerHandle } from '../../components/chat/ChatComposer';
import { VoicePlaybackProvider, useVoicePlayback, type VoicePlaybackApi } from '../../components/chat/VoicePlayback';
import { holdAudioForReview, releaseAudio, voiceAudioHold } from '../voice-audio';
import { VoiceNotSentError } from '../voice-recorder';
import { makeChatStyles } from '../../components/chat/styles';
import { lightColors, darkColors } from '../../constants/colors';

let root: Root;
let host: HTMLDivElement;
const sent: any[] = [];
/** Every try's line id, sent or not: the recording's own, the same on every try of it. */
const tries: string[] = [];
/** The screen's onVoice refuses the next send with these words (as `sendVoice` does while a text is still going). */
let refuseNext: string | null = null;
/** The screen's onVoice refuses the next send as one it shows above the box (refusedSendNotice, GroupChatKeyError). */
let shownNext: string | null = null;
/** This chat screen's owner of its audio holds: its composer's and its player's. */
const OWNER = 'chat-under-test';
/** A send held open until the test lets it go. */
let holdSend: Promise<void> | null = null;

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
    await act(async () => { expoAudioStub.emit(); });
    await flush();
};

const composerRef: { current: ChatComposerHandle | null } = { current: null };
function composer(withVoice = true) {
    const colors = theme.scheme === 'dark' ? darkColors : lightColors;
    return createElement(ChatComposer, {
        ref: composerRef as any,
        styles: makeChatStyles({ theme: theme.scheme, colors } as any), onSend: async () => { }, placeholder: 'Message', accessibilityLabel: 'Message',
        bottomPadding: 12,
        voiceOwner: OWNER,
        onVoice: withVoice ? async (v: any, lineId: string) => {
            tries.push(lineId);
            if (holdSend) await holdSend;
            if (refuseNext) { const why = refuseNext; refuseNext = null; throw new Error(why); }
            if (shownNext) { const why = shownNext; shownNext = null; throw new VoiceNotSentError(why); }
            sent.push(v);
        } : undefined,
    }) as any;
}
function render(withVoice = true) {
    root.render(composer(withVoice));
}
/** A fresh composer, as a chat opening. */
async function reopen(withVoice = true) {
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await act(async () => { render(withVoice); });
    await flush();
}

beforeEach(async () => {
    expoAudioStub.reset();
    expoAudioStub.permission = { granted: true, canAskAgain: true, status: 'granted' };
    sent.length = 0;
    tries.length = 0;
    refuseNext = null;
    shownNext = null;
    holdSend = null;
    vi.mocked(Alert.alert).mockClear();
    vi.mocked(FileSystem.deleteAsync).mockClear();
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
    await releaseAudio('chat-underneath');
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

    it('the box is never remounted when the microphone comes and goes (Edit, a photo waiting): its words stay', async () => {
        const before = box.mounts;
        await act(async () => { render(false); });
        await act(async () => { render(true); });
        await act(async () => { render(false); });
        expect(box.mounts).toBe(before);
    });

    it('the box is never remounted when the microphone first arrives (a DM opens without it): a prefilled nudge stays', async () => {
        // A DM's first render has no onVoice ('mine-loading'); the screen's prefill writes the nudge into the first box.
        await reopen(false);
        const before = box.mounts;
        await act(async () => { composerRef.current!.setText('Go test your quiz'); });
        // The conversation row arrives: the microphone comes.
        await act(async () => { render(true); });
        await flush();
        expect(box.mounts).toBe(before);
        expect(composerRef.current!.currentText()).toBe('Go test your quiz');
        // The microphone did arrive: with the box empty it is in Send's place.
        await act(async () => { box.onChangeText!(''); });
        expect(q('voice-mic')).not.toBeNull();
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

describe('ChatComposer: a send that didn\'t go keeps the recording (PR #3112 review)', () => {
    it('refused ("Wait for the last message to go."): kept, back for play, bin and Send; Send then sends it', async () => {
        refuseNext = 'Wait for the last message to go.';
        await hold();
        await clock(2300);
        await release();
        expect(sent).toEqual([]);
        expect(Alert.alert).toHaveBeenCalledWith('Voice message not sent', 'Wait for the last message to go.');
        // Not deleted: the file is still there to send.
        expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('file:///rec/voice.m4a', expect.anything());
        expect(q('voice-preview')).not.toBeNull();
        expect(q('voice-bin')).not.toBeNull();
        expect(q('voice-clock')?.textContent).toBe('0:02');
        await act(async () => { q('voice-send')!.click(); });
        await flush();
        expect(sent).toHaveLength(1);
        expect(sent[0].durationMs).toBe(2300);
        expect(sent[0].bars).toHaveLength(VOICE_BARS);
        // Sent: now it goes.
        expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///rec/voice.m4a', expect.anything());
        expect(q('voice-bar')).toBeNull();
    });

    it('the chat left while it was going, and then it failed: the file goes, and the audio session is let go', async () => {
        let go!: () => void;
        holdSend = new Promise<void>((r) => { go = r; });
        refuseNext = 'The voice message could not be sent.';
        await hold();
        await clock(2000);
        await release();
        await act(async () => { root.unmount(); });
        holdSend = null;
        await act(async () => { go(); });
        for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
        expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///rec/voice.m4a', expect.anything());
        // Nothing left holding the session: every other chat's voice messages still play.
        expect(voiceAudioHold(OWNER)).toBeNull();
        root = createRoot(host);   // for afterEach
    });

    it('nothing new records while a voice message is going', async () => {
        let go!: () => void;
        holdSend = new Promise<void>((r) => { go = r; });
        await hold();
        await clock(2000);
        await release();
        expect(q('voice-mic')?.getAttribute('aria-label')).toBe('Sending…');
        expect(pan.config!.onStartShouldSetResponder()).toBe(false);
        holdSend = null;
        await act(async () => { go(); });
        await flush();
        expect(sent).toHaveLength(1);
        expect(q('voice-mic')?.getAttribute('aria-label')).toBe('Hold to record a voice message');
    });
});

describe('ChatComposer: the microphone turned on in Settings (PR #3112 review)', () => {
    it('reaches the open chat when the app comes back to the front', async () => {
        expoAudioStub.permission = { granted: false, canAskAgain: false, status: 'denied' };
        await reopen();
        await hold();
        expect(Alert.alert).toHaveBeenCalledWith('The microphone is off for BeanPool', expect.any(String), expect.any(Array));
        expect(expoAudioStub.recorder.isRecording).toBe(false);
        await release();
        // Open Settings, the microphone on, back to BeanPool: the chat was never closed.
        expoAudioStub.permission = { granted: true, canAskAgain: true, status: 'granted' };
        await act(async () => { for (const fn of appState.listeners) fn('active'); });
        await flush();
        vi.mocked(Alert.alert).mockClear();
        await hold();
        expect(Alert.alert).not.toHaveBeenCalled();
        expect(expoAudioStub.recorder.isRecording).toBe(true);
        expect(expoAudioStub.asked).toBe(0);
    });
});

describe('ChatComposer with the chat\'s player: one owner of the audio mode (PR #3112 review)', () => {
    it('a recording pauses what plays; nothing plays, moves on or flips the mode until it is sent', async () => {
        const api: { current: VoicePlaybackApi | null } = { current: null };
        const Probe = () => { api.current = useVoicePlayback(); return null; };
        const voices = [{ id: 'a', mine: false }, { id: 'b', mine: false }];
        await act(async () => { root.render(createElement(VoicePlaybackProvider as any, { owner: OWNER, voices }, createElement(Probe), composer()) as any); });
        await flush();
        // A voice message plays.
        await act(async () => { api.current!.toggle('a', 'file:///a.m4a'); });
        await flush();
        expect(expoAudioStub.player.played).toBe(1);
        expoAudioStub.playerStatus.playing = true;
        await act(async () => { expoAudioStub.emit(); });
        // A hold: it stops before the microphone opens.
        const pausedBefore = expoAudioStub.player.paused;
        await hold();
        expect(expoAudioStub.recorder.isRecording).toBe(true);
        expect(expoAudioStub.player.paused).toBeGreaterThan(pausedBefore);
        expoAudioStub.playerStatus.playing = false;
        await move(0, -100);   // locked: the finger is free to tap a bubble
        await release();
        const { played, replaced } = { played: expoAudioStub.player.played, replaced: expoAudioStub.player.replaced.length };
        // A tap on another bubble's play, a tap on the paused one, and the one that played ending (next plays): nothing.
        await act(async () => { api.current!.toggle('b', 'file:///b.m4a'); });
        await flush();
        await act(async () => { api.current!.toggle('a', 'file:///a.m4a'); });
        await flush();
        expoAudioStub.playerStatus.didJustFinish = true;
        await act(async () => { expoAudioStub.emit(); });
        await flush();
        expoAudioStub.playerStatus.didJustFinish = false;
        expect(expoAudioStub.player.played).toBe(played);
        expect(expoAudioStub.player.replaced.length).toBe(replaced);
        // The recording was never cut off (iOS stops it on a playback mode), and no playback mode was asked while it ran.
        expect(expoAudioStub.recorder.isRecording).toBe(true);
        expect(expoAudioStub.modes.filter((m) => m.whileRecording && m.mode.allowsRecording === false)).toEqual([]);
        // Stopped and waiting for review: still nothing plays.
        await clock(4000);
        await act(async () => { q('voice-stop')!.click(); });
        await flush();
        await act(async () => { api.current!.toggle('b', 'file:///b.m4a'); });
        await flush();
        expect(expoAudioStub.player.played).toBe(played);
        // Sent: the chat plays again.
        await act(async () => { q('voice-send')!.click(); });
        await flush();
        expect(sent).toHaveLength(1);
        expect(sent[0].durationMs).toBe(4000);
        await act(async () => { api.current!.toggle('b', 'file:///b.m4a'); });
        await flush();
        expect(expoAudioStub.player.played).toBe(played + 1);
    });
});

describe('ChatComposer: a refusal the screen shows above the box keeps the recording (PR #3112 review, round 2: [id].tsx:886, GroupChatView.tsx:576)', () => {
    it('VoiceNotSentError: not deleted, back for play, bin and Send, and no second word; Send then sends it', async () => {
        shownNext = 'Nothing was sent; try again in a moment.';
        await hold();
        await clock(2300);
        await release();
        expect(sent).toEqual([]);
        // The screen already said why above the box: the recorder adds no alert.
        expect(Alert.alert).not.toHaveBeenCalled();
        expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('file:///rec/voice.m4a', expect.anything());
        expect(q('voice-preview')).not.toBeNull();
        expect(q('voice-bin')).not.toBeNull();
        expect(q('voice-clock')?.textContent).toBe('0:02');
        // Still this chat's: its player stays quiet while the recording waits.
        expect(voiceAudioHold(OWNER)).toBe('review');
        await act(async () => { q('voice-send')!.click(); });
        await flush();
        expect(sent).toHaveLength(1);
        expect(sent[0].durationMs).toBe(2300);
        expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///rec/voice.m4a', expect.anything());
        expect(q('voice-bar')).toBeNull();
        expect(voiceAudioHold(OWNER)).toBeNull();
    });
});

describe('ChatComposer: one line id per recording (PR #3112 review, round 2: db.ts:7448)', () => {
    it('every try of one recording is the same line; the next recording is a new one', async () => {
        refuseNext = 'Sending the voice message is taking too long — please try again.';
        await hold();
        await clock(2300);
        await release();
        expect(q('voice-send')).not.toBeNull();
        refuseNext = 'The node could not be reached.';
        await act(async () => { q('voice-send')!.click(); });
        await flush();
        await act(async () => { q('voice-send')!.click(); });
        await flush();
        expect(sent).toHaveLength(1);
        expect(tries).toHaveLength(3);
        expect(tries[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(new Set(tries).size).toBe(1);
        // A new recording, sent at once: its own id.
        await hold();
        await clock(1800);
        await release();
        expect(sent).toHaveLength(2);
        expect(tries).toHaveLength(4);
        expect(tries[3]).not.toBe(tries[0]);
    });

    it('a recording binned after a failed try, and a new one: a new id', async () => {
        refuseNext = 'The node could not be reached.';
        await hold();
        await clock(2300);
        await release();
        await act(async () => { q('voice-bin')!.click(); });
        await flush();
        await hold();
        await clock(2000);
        await release();
        expect(tries).toHaveLength(2);
        expect(tries[1]).not.toBe(tries[0]);
    });
});

describe('ChatComposer: a hold reaches its own chat only (PR #3112 review, round 2: voice-audio.ts:65)', () => {
    it('a recording waiting in this chat never stops the player of a chat opened on top', async () => {
        const api: { current: VoicePlaybackApi | null } = { current: null };
        const Probe = () => { api.current = useVoicePlayback(); return null; };
        const voices = [{ id: 'a', mine: false }];
        // The chat on top's player (another screen's owner) beside this chat's composer.
        await act(async () => { root.render(createElement(VoicePlaybackProvider as any, { owner: 'chat-on-top', voices }, createElement(Probe), composer()) as any); });
        await flush();
        await hold();
        await clock(3000);
        await move(0, -100);
        await release();
        await act(async () => { q('voice-stop')!.click(); });
        await flush();
        expect(voiceAudioHold(OWNER)).toBe('review');
        const played = expoAudioStub.player.played;
        await act(async () => { api.current!.toggle('a', 'file:///a.m4a'); });
        await flush();
        expect(expoAudioStub.player.played).toBe(played + 1);
        await act(async () => { q('voice-bin')!.click(); });
        await flush();
    });

    it('this chat sends its recording: a recording waiting in the chat underneath stays held', async () => {
        await holdAudioForReview('chat-underneath');
        await hold();
        await clock(2300);
        await release();
        expect(sent).toHaveLength(1);
        expect(voiceAudioHold(OWNER)).toBeNull();
        expect(voiceAudioHold('chat-underneath')).toBe('review');
        // And the bin, the same.
        await hold();
        await clock(2300);
        await move(0, -100);
        await release();
        await act(async () => { q('voice-bin')!.click(); });
        await flush();
        expect(voiceAudioHold('chat-underneath')).toBe('review');
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

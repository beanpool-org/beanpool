/**
 * The composer's microphone (DESIGN-cross-chat-voice-fable.md §5.3; slice V3), WhatsApp's feel: hold to record, slide left
 * to cancel, slide up to lock and let go; a locked recording has Stop, then play, bin and send; let go to send. The rules
 * are utils/voice-recorder.ts's reducer; this file carries out what each step answers, with expo-audio.
 *
 * The microphone is asked for at the first hold, never before (memory permissions-only-when-asked): reading whether it was
 * granted asks nothing, so that is read when the chat opens, and the hold itself asks. That first hold only asks. Refused
 * for good: one sheet, with a way to Settings.
 *
 * With a screen reader on, or text at 1.5× or more, a tap starts a locked recording and its buttons stop, bin and send it.
 *
 * `bar` is drawn by ChatComposer in the box's place while a recording runs or waits; `mic` is drawn in Send's place.
 */
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, AppState, Linking, PanResponder, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import {
    getRecordingPermissionsAsync, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus,
    useAudioRecorder, useAudioRecorderState, type RecordingOptions,
} from 'expo-audio';
import { t, word, VOICE_MAX_MS, type VoiceInput } from '@beanpool/core';
import { useTheme } from '../../app/ThemeContext';
import {
    voiceBarsFromLevels, voiceClock, voiceRecorderStep, VOICE_IDLE, VOICE_LOCK_DY, VOICE_RECORDING_OPTIONS, VOICE_TAP_MODE_FONT_SCALE,
    type VoicePermission, type VoiceRecorderEffect, type VoiceRecorderEvent, type VoiceRecorderState,
} from '../../utils/voice-recorder';
import type { ChatStyles } from './styles';

export const VOICE_RECORDER_WORDS = {
    hold: word('Hold to record'),
    slide: word('Slide to cancel'),
    micOffTitle: word('The microphone is off for BeanPool'),
    micOffText: word('To record a voice message, turn on the microphone for BeanPool in Settings.'),
    micFailed: word("The microphone couldn't start. Try again."),
    notSent: word('Voice message not sent'),
};

/** The recording's file, read or taken off: loaded when first used, so a chat test needs no file system. */
async function deleteRecording(uri: string): Promise<void> {
    const FileSystem = await import('expo-file-system/legacy');
    await FileSystem.deleteAsync(uri, { idempotent: true });
}
async function readRecording(uri: string): Promise<Uint8Array> {
    const [FileSystem, { decodeBase64 }] = await Promise.all([import('expo-file-system/legacy'), import('../../utils/crypto')]);
    return decodeBase64(await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 }));
}

function reducer(s: { state: VoiceRecorderState; effect: VoiceRecorderEffect; n: number }, e: VoiceRecorderEvent) {
    const next = voiceRecorderStep(s.state, e);
    // Every effect is a new number, so the same effect twice in a row still runs twice.
    return next.state === s.state && !next.effect ? s : { ...next, n: s.n + 1 };
}

export interface VoiceRecorderParts {
    /** What ChatComposer draws in the box's place, or null when nothing is recording or waiting. */
    bar: React.ReactNode;
    /** What ChatComposer draws in Send's place. */
    mic: React.ReactNode;
    /** A line above the box: "Hold to record" after a hold too short. */
    hint: string | null;
}

export function useVoiceRecorder({ styles, onSend, disabled }: { styles: ChatStyles; onSend: (voice: VoiceInput) => Promise<void>; disabled?: boolean }): VoiceRecorderParts {
    const { colors } = useTheme();
    const { fontScale } = useWindowDimensions();
    const recorder = useAudioRecorder(VOICE_RECORDING_OPTIONS as unknown as RecordingOptions);
    const live = useAudioRecorderState(recorder, 100);
    const preview = useAudioPlayer(null);
    const previewStatus = useAudioPlayerStatus(preview);
    const [{ state, effect, n }, dispatch] = useReducer(reducer, { state: VOICE_IDLE, effect: null, n: 0 });
    const [screenReader, setScreenReader] = useState(false);
    const permission = useRef<VoicePermission>('ask');
    const levels = useRef<number[]>([]);
    const kept = useRef<{ uri: string; ms: number } | null>(null);
    const work = useRef<Promise<void>>(Promise.resolve());
    const stateRef = useRef(state);
    stateRef.current = state;

    const tapMode = screenReader || fontScale >= VOICE_TAP_MODE_FONT_SCALE;

    useEffect(() => {
        // Reading asks nothing: the ask is the first hold's.
        getRecordingPermissionsAsync().then((p) => {
            permission.current = p.granted ? 'granted' : p.canAskAgain === false ? 'refused' : 'ask';
        }).catch(() => {});
        AccessibilityInfo.isScreenReaderEnabled().then(setScreenReader).catch(() => {});
        const sub = AccessibilityInfo.addEventListener('screenReaderChanged', setScreenReader);
        return () => sub.remove();
    }, []);

    // The recorder's clock and level, while it records.
    useEffect(() => {
        if (state.phase !== 'recording' || !live.isRecording) return;
        if (typeof live.metering === 'number') levels.current.push(live.metering);
        dispatch({ type: 'tick', ms: live.durationMillis });
    }, [live.durationMillis, live.metering, live.isRecording, state.phase]);

    // Leaving the chat, or the app going to the background, never sends: a recording is kept for review, or thrown away.
    useEffect(() => {
        const sub = AppState.addEventListener('change', (s) => {
            if (s === 'active' || stateRef.current.phase !== 'recording') return;
            dispatch({ type: 'move', dx: 0, dy: -VOICE_LOCK_DY });
            dispatch({ type: 'stop' });
        });
        return () => {
            sub.remove();
            if (recorder.isRecording) recorder.stop().catch(() => {});
            const uri = recorder.uri;
            if (uri) deleteRecording(uri).catch(() => {});
        };
    }, [recorder]);

    const stopRecorder = useCallback(async (): Promise<string | null> => {
        if (recorder.isRecording) await recorder.stop();
        return recorder.uri ?? null;
    }, [recorder]);

    const sendFile = useCallback(async (uri: string | null, ms: number) => {
        if (!uri) return;
        try {
            const sound = await readRecording(uri);
            await onSend({ durationMs: Math.min(VOICE_MAX_MS, Math.max(1, Math.round(ms))), bars: voiceBarsFromLevels(levels.current), sound });
        } catch (e: any) {
            Alert.alert(t(VOICE_RECORDER_WORDS.notSent), typeof e?.message === 'string' && e.message ? e.message : undefined);
        } finally {
            deleteRecording(uri).catch(() => {});
        }
    }, [onSend]);

    // Carry out each step's effect, one after another, so a quick tap can't stop a recorder that hasn't started yet.
    useEffect(() => {
        if (!effect) return;
        const ms = state.phase === 'recording' || state.phase === 'review' ? state.ms : 0;
        const run = async () => {
            switch (effect) {
                case 'ask': {
                    const p = await requestRecordingPermissionsAsync().catch(() => null);
                    permission.current = p?.granted ? 'granted' : p?.canAskAgain === false ? 'refused' : 'ask';
                    dispatch({ type: 'permission', granted: !!p?.granted });
                    return;
                }
                case 'settings':
                    Alert.alert(t(VOICE_RECORDER_WORDS.micOffTitle), t(VOICE_RECORDER_WORDS.micOffText), [
                        { text: t('Not now'), style: 'cancel' },
                        { text: t('Open Settings'), onPress: () => { Linking.openSettings().catch(() => {}); } },
                    ]);
                    return;
                case 'start':
                    levels.current = [];
                    kept.current = null;
                    try {
                        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldPlayInBackground: false });
                        await recorder.prepareToRecordAsync();
                        recorder.record();
                    } catch {
                        dispatch({ type: 'failed' });
                        Alert.alert(t(VOICE_RECORDER_WORDS.micFailed));
                    }
                    return;
                case 'keep':
                    kept.current = { uri: (await stopRecorder().catch(() => null)) ?? '', ms };
                    if (kept.current.uri) preview.replace({ uri: kept.current.uri });
                    return;
                case 'send': {
                    const uri = kept.current?.uri || (await stopRecorder().catch(() => null));
                    kept.current = null;
                    preview.pause();
                    await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
                    await sendFile(uri, ms);
                    return;
                }
                case 'discard': {
                    const uri = kept.current?.uri || (await stopRecorder().catch(() => null));
                    kept.current = null;
                    preview.pause();
                    await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
                    if (uri) await deleteRecording(uri).catch(() => {});
                    return;
                }
            }
        };
        work.current = work.current.then(run, run);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [n]);

    // "Hold to record" goes after a moment.
    useEffect(() => {
        if (state.phase !== 'idle' || state.hint !== 'hold') return;
        const timer = setTimeout(() => dispatch({ type: 'dismiss' }), 2500);
        return () => clearTimeout(timer);
    }, [state]);

    const pan = useMemo(() => PanResponder.create({
        onStartShouldSetPanResponder: () => !tapMode && !disabled,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => dispatch({ type: 'hold', permission: permission.current }),
        onPanResponderMove: (_e, g) => dispatch({ type: 'move', dx: g.dx, dy: g.dy }),
        onPanResponderRelease: () => dispatch({ type: 'release' }),
        onPanResponderTerminate: () => dispatch({ type: 'release' }),
    }), [tapMode, disabled]);

    const ink = colors.text.body;
    const iconBtn = { width: 48, height: 48, justifyContent: 'center' as const, alignItems: 'center' as const, flexShrink: 0 };
    const recording = state.phase === 'recording';
    const review = state.phase === 'review';
    const locked = (recording && state.locked) || review;

    const mic = locked ? (
        <Pressable
            testID="voice-send"
            accessibilityRole="button"
            accessibilityLabel={t('Send voice message')}
            onPress={() => dispatch({ type: 'send' })}
            hitSlop={4}
            style={[styles.sendBtn, styles.sendBtnActive]}
        >
            <MaterialCommunityIcons name="send" size={20} color={colors.text.onAccent} />
        </Pressable>
    ) : tapMode ? (
        // A screen reader or the largest text: a tap starts a locked recording (§5.3).
        <Pressable
            testID="voice-mic"
            accessibilityRole="button"
            accessibilityLabel={t('Record a voice message')}
            accessibilityState={{ disabled: !!disabled }}
            disabled={!!disabled}
            onPress={() => dispatch({ type: 'hold', permission: permission.current, tap: true })}
            hitSlop={4}
            style={[styles.sendBtn, styles.sendBtnActive]}
        >
            <MaterialCommunityIcons name="microphone" size={22} color={colors.text.onAccent} />
        </Pressable>
    ) : (
        <View
            testID="voice-mic"
            accessible
            accessibilityRole="button"
            accessibilityLabel={t('Hold to record a voice message')}
            accessibilityState={{ disabled: !!disabled }}
            hitSlop={4}
            style={[styles.sendBtn, recording ? { backgroundColor: colors.feedback.danger.solid } : styles.sendBtnActive]}
            {...pan.panHandlers}
        >
            <MaterialCommunityIcons name="microphone" size={22} color={recording ? colors.text.onDanger : colors.text.onAccent} />
            {recording && !state.locked ? (
                // Slide up to lock: shown above the held microphone.
                <View pointerEvents="none" style={{ position: 'absolute', bottom: 52, alignItems: 'center', padding: 6, borderRadius: 16, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default }}>
                    <MaterialCommunityIcons name="lock-outline" size={18} color={ink} />
                    <MaterialCommunityIcons name="chevron-up" size={18} color={ink} />
                </View>
            ) : null}
        </View>
    );

    const clock = (ms: number) => (
        <View style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 0, gap: 6 }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colors.feedback.danger.fg }} />
            <Text testID="voice-clock" accessibilityLabel={t('Recording, {length}', { length: voiceClock(ms) })} style={{ color: ink, fontSize: 16, fontVariant: ['tabular-nums'] }}>{voiceClock(ms)}</Text>
        </View>
    );

    let bar: React.ReactNode = null;
    if (recording && !state.locked) {
        bar = (
            <View testID="voice-bar" style={{ flex: 1, minWidth: 0, minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                {clock(state.ms)}
                <Text testID="voice-slide" numberOfLines={2} style={{ flex: 1, minWidth: 0, color: colors.text.muted, fontSize: 14, textAlign: 'right' }}>
                    {'‹ '}{t(VOICE_RECORDER_WORDS.slide)}
                </Text>
            </View>
        );
    } else if (locked) {
        const ms = state.ms;
        const previewing = review && !!previewStatus.playing;
        bar = (
            <View testID="voice-bar" style={{ flex: 1, minWidth: 0, minHeight: 48, flexDirection: 'row', alignItems: 'center' }}>
                <Pressable testID="voice-bin" accessibilityRole="button" accessibilityLabel={t('Delete recording')} onPress={() => dispatch({ type: 'cancel' })} style={[iconBtn, { marginLeft: -8 }]}>
                    <MaterialCommunityIcons name="delete-outline" size={24} color={colors.feedback.danger.fg} />
                </Pressable>
                <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>{clock(ms)}</View>
                {review ? (
                    <Pressable
                        testID="voice-preview"
                        accessibilityRole="button"
                        accessibilityLabel={previewing ? t('Pause recording') : t('Play recording')}
                        onPress={() => {
                            if (previewing) { preview.pause(); return; }
                            setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
                            if (previewStatus.duration > 0 && previewStatus.currentTime >= previewStatus.duration - 0.05) preview.seekTo(0).catch(() => {});
                            preview.play();
                        }}
                        style={iconBtn}
                    >
                        <MaterialCommunityIcons name={previewing ? 'pause' : 'play'} size={26} color={ink} />
                    </Pressable>
                ) : (
                    <Pressable testID="voice-stop" accessibilityRole="button" accessibilityLabel={t('Stop recording')} onPress={() => dispatch({ type: 'stop' })} style={iconBtn}>
                        <MaterialCommunityIcons name="stop-circle-outline" size={28} color={colors.feedback.danger.fg} />
                    </Pressable>
                )}
            </View>
        );
    }

    const hint = state.phase === 'idle' && state.hint === 'hold' ? t(VOICE_RECORDER_WORDS.hold) : null;
    return { bar, mic, hint };
}

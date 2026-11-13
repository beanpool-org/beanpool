/**
 * A voice message in a chat bubble (DESIGN-cross-chat-voice-fable.md §5.5; slice V3): play, the waveform the sender drew
 * (drag along it to move), the length, and the speed. Opened when the bubble is drawn, as a photo is: the phone's own copy,
 * else the node's, opened on this phone (utils/db.ts getDecryptedVoice, getDecryptedGroupVoice). Plays through the chat's
 * one player (VoicePlayback.tsx). Fits 320 dp at 1.3× text, light and dark, from the central colour roles.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { t, word, VOICE_BARS } from '@beanpool/core';
import { useTheme } from '../../app/ThemeContext';
import { useVoicePlayback } from './VoicePlayback';
import { voiceClock } from '../../utils/voice-recorder';
import { voiceSeekShare, voiceSpeedLabel } from '../../utils/voice-playback';

/** What opening a voice line answered (utils/db.ts VoiceOpenResult). */
export type VoiceBubbleLoad = () => Promise<
    { kind: 'ok'; voice: { uri: string; durationMs: number; bars: number[] } } | { kind: 'gone' } | { kind: 'refused' } | { kind: 'unavailable' }
>;

export const VOICE_WORDS = {
    gone: word('This voice message is no longer on the server.'),
    refused: word("This voice message can't be played."),
    unavailable: word('Voice message unavailable. Tap to try again.'),
};

const FLAT = Array.from({ length: VOICE_BARS }, () => 0);
const BAR_MAX_H = 24;

interface Props {
    messageId: string;
    load: VoiceBubbleLoad;
    isMe: boolean;
}

export function VoiceBubble({ messageId, load, isMe }: Props) {
    const { colors } = useTheme();
    const playback = useVoicePlayback();
    const [state, setState] = useState<'loading' | 'ok' | 'gone' | 'refused' | 'unavailable'>('loading');
    const [voice, setVoice] = useState<{ uri: string; durationMs: number; bars: number[] } | null>(null);
    const [waveWidth, setWaveWidth] = useState(0);
    const alive = useRef(true);
    useEffect(() => () => { alive.current = false; }, []);
    // The screen hands a new loader each render: opened once per message, not once per render.
    const loadRef = useRef(load);
    loadRef.current = load;
    const registerRef = useRef(playback?.register);
    registerRef.current = playback?.register;

    const open = useCallback(() => {
        setState('loading');
        loadRef.current().then((r) => {
            if (!alive.current) return;
            if (r.kind === 'ok') {
                setVoice(r.voice);
                setState('ok');
                registerRef.current?.(messageId, r.voice.uri);
            } else setState(r.kind);
        }).catch(() => { if (alive.current) setState('unavailable'); });
    }, [messageId]);
    useEffect(() => { open(); }, [open]);

    const ink = isMe ? colors.chat.messageTextMe : colors.chat.messageTextOther;
    const current = !!voice && playback?.currentId === messageId;
    const playing = current && !!playback?.playing;
    const lengthS = voice ? voice.durationMs / 1000 : 0;
    const progress = current && playback && playback.duration > 0 ? Math.min(1, playback.position / playback.duration) : 0;
    const shownMs = current && playback && playback.position > 0 ? playback.position * 1000 : voice?.durationMs ?? 0;
    const bars = voice?.bars ?? FLAT;

    if (state === 'gone' || state === 'refused' || state === 'unavailable') {
        const words = t(VOICE_WORDS[state]);
        const body = (
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 6 }}>
                <MaterialCommunityIcons name="microphone-off" size={20} color={ink} />
                <Text style={{ color: ink, fontStyle: 'italic', flexShrink: 1, fontSize: 14 }}>{words}</Text>
            </View>
        );
        return state === 'unavailable'
            ? <Pressable testID="voice-retry" accessibilityRole="button" accessibilityLabel={words} onPress={open} style={{ minHeight: 48, justifyContent: 'center' }}>{body}</Pressable>
            : <View testID={`voice-${state}`}>{body}</View>;
    }

    // locationX is measured from the view the finger landed on. The bars are views of their own, so the wave takes every touch
    // itself (pointerEvents box-only, below): the place is then always measured from the whole waveform's own left edge, as
    // waveWidth is. Without it, a tap on a bar measured 0 to 2 dp from that bar and moved the sound to the start.
    const onWave = (e: GestureResponderEvent) => {
        if (!voice || !playback) return;
        playback.seek(messageId, voice.uri, voiceSeekShare(e.nativeEvent.locationX, waveWidth));
    };

    return (
        <View testID="voice-bubble" style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 4, minWidth: 200 }}>
            <Pressable
                testID="voice-play"
                accessibilityRole="button"
                accessibilityLabel={playing ? t('Pause voice message') : t('Play voice message, {length}', { length: voiceClock(voice?.durationMs ?? 0) })}
                accessibilityState={{ disabled: state !== 'ok', busy: state === 'loading' }}
                disabled={state !== 'ok' || !playback}
                onPress={() => voice && playback?.toggle(messageId, voice.uri)}
                style={{ width: 48, height: 48, justifyContent: 'center', alignItems: 'center', marginLeft: -8 }}
            >
                {state === 'loading'
                    ? <ActivityIndicator size="small" color={ink} />
                    : <MaterialCommunityIcons name={playing ? 'pause' : 'play'} size={30} color={ink} />}
            </Pressable>
            <View style={{ flex: 1, minWidth: 0 }}>
                <View
                    testID="voice-wave"
                    accessible={false}
                    pointerEvents="box-only"
                    onLayout={(e: LayoutChangeEvent) => setWaveWidth(e.nativeEvent.layout.width)}
                    onStartShouldSetResponder={() => state === 'ok'}
                    onResponderRelease={onWave}
                    style={{ height: BAR_MAX_H + 4, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
                >
                    {bars.map((b, i) => (
                        <View
                            key={i}
                            style={{
                                width: 2, borderRadius: 1, height: Math.max(3, Math.round((b / 255) * BAR_MAX_H)),
                                backgroundColor: ink, opacity: (i + 0.5) / VOICE_BARS <= progress ? 1 : 0.4,
                            }}
                        />
                    ))}
                </View>
                <Text testID="voice-time" style={{ color: ink, fontSize: 12, fontVariant: ['tabular-nums'], marginTop: 2 }}>{voiceClock(shownMs || lengthS * 1000)}</Text>
            </View>
            {/* The speed, in a 48 dp slot of its own: shown while this one is the player's; a microphone otherwise. */}
            {current && playback ? (
                <Pressable
                    testID="voice-speed"
                    accessibilityRole="button"
                    accessibilityLabel={t('Playback speed {speed}', { speed: voiceSpeedLabel(playback.speed) })}
                    onPress={playback.cycleSpeed}
                    style={{ width: 48, height: 48, marginRight: -6, justifyContent: 'center', alignItems: 'center' }}
                >
                    <View style={{ minWidth: 38, paddingHorizontal: 4, paddingVertical: 2, borderRadius: 10, borderWidth: 1, borderColor: ink, alignItems: 'center' }}>
                        <Text style={{ color: ink, fontSize: 12, fontWeight: '700' }}>{voiceSpeedLabel(playback.speed)}</Text>
                    </View>
                </Pressable>
            ) : (
                <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ width: 48, height: 48, marginRight: -6, justifyContent: 'center', alignItems: 'center' }}>
                    <MaterialCommunityIcons name="microphone" size={20} color={ink} />
                </View>
            )}
        </View>
    );
}

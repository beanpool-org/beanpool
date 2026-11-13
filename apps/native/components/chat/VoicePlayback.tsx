/**
 * One player for a chat's voice messages (DESIGN-cross-chat-voice-fable.md §5.5; slice V3). Every VoiceBubble in the chat
 * plays through it, so only one sound plays at a time. Tap to play; drag the waveform to move; 1× → 1.5× → 2×, remembered
 * on this phone; when one ends, the next voice message after it plays by itself if it isn't mine and this phone hasn't
 * played it (utils/voice-playback.ts nextVoiceToPlay). Sound from the speaker; it stops when the chat closes or the app
 * goes to the background. Nothing about playing is sent anywhere: no "played" tick.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { nextVoiceSpeed, nextVoiceToPlay, voiceSpeedOf, type VoiceInChat, type VoiceSpeed } from '../../utils/voice-playback';

const SPEED_KEY = 'beanpool_voice_speed';
const PLAYED_KEY = 'beanpool_voice_played';
/** The played ids this phone remembers for next-plays: the newest this many. */
const PLAYED_MAX = 1000;

export interface VoicePlaybackApi {
    /** The voice message playing or paused in the player, or null. */
    currentId: string | null;
    playing: boolean;
    /** Seconds into the current one, and its length (0 until loaded). */
    position: number;
    duration: number;
    speed: VoiceSpeed;
    /** Play `id` from `uri`, or pause/resume it if it is the current one. */
    toggle: (id: string, uri: string) => void;
    /** Move the current one (or start `id`) to a share 0 to 1 of its length. */
    seek: (id: string, uri: string, share: number) => void;
    cycleSpeed: () => void;
    /** A bubble's sound, once opened: what next-plays can start without the bubble on screen. */
    register: (id: string, uri: string) => void;
}

const VoicePlaybackContext = createContext<VoicePlaybackApi | null>(null);

/** The chat's player, for a VoiceBubble. Null outside a VoicePlaybackProvider: the bubble then plays nothing. */
export function useVoicePlayback(): VoicePlaybackApi | null {
    return useContext(VoicePlaybackContext);
}

export function VoicePlaybackProvider({ voices, children }: { voices: readonly VoiceInChat[]; children: React.ReactNode }) {
    const player = useAudioPlayer(null, { updateInterval: 100 });
    const status = useAudioPlayerStatus(player);
    const [currentId, setCurrentId] = useState<string | null>(null);
    const [speed, setSpeed] = useState<VoiceSpeed>(1);
    const uris = useRef(new Map<string, string>());
    const played = useRef(new Set<string>());
    const voicesRef = useRef(voices);
    voicesRef.current = voices;

    useEffect(() => {
        AsyncStorage.getItem(SPEED_KEY).then((s) => setSpeed(voiceSpeedOf(s))).catch(() => {});
        AsyncStorage.getItem(PLAYED_KEY).then((s) => {
            const ids = JSON.parse(s || '[]');
            if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') played.current.add(id);
        }).catch(() => {});
    }, []);

    const notePlayed = useCallback((id: string) => {
        played.current.delete(id);
        played.current.add(id);
        const ids = [...played.current].slice(-PLAYED_MAX);
        AsyncStorage.setItem(PLAYED_KEY, JSON.stringify(ids)).catch(() => {});
        // Kept longest: loaded when first played, so a chat test needs no file system.
        import('../../utils/voice-cache').then(({ touchVoice }) => touchVoice(id)).catch(() => {});
    }, []);

    const start = useCallback(async (id: string, uri: string, at = 0) => {
        // Out of the speaker, even with the phone on silent, and never the recorder's earpiece route.
        await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false, shouldPlayInBackground: false }).catch(() => {});
        player.replace({ uri });
        player.setPlaybackRate(speed, 'high');
        if (at > 0) await player.seekTo(at).catch(() => {});
        player.play();
        setCurrentId(id);
        notePlayed(id);
    }, [player, speed, notePlayed]);

    const toggle = useCallback((id: string, uri: string) => {
        uris.current.set(id, uri);
        if (id !== currentId) { start(id, uri).catch(() => {}); return; }
        if (status.playing) { player.pause(); return; }
        if (status.duration > 0 && status.currentTime >= status.duration - 0.05) player.seekTo(0).catch(() => {});
        player.play();
    }, [currentId, status.playing, status.duration, status.currentTime, player, start]);

    const seek = useCallback((id: string, uri: string, share: number) => {
        uris.current.set(id, uri);
        if (id !== currentId || !(status.duration > 0)) { start(id, uri).catch(() => {}); return; }
        player.seekTo(share * status.duration).catch(() => {});
    }, [currentId, status.duration, player, start]);

    const cycleSpeed = useCallback(() => {
        const next = nextVoiceSpeed(speed);
        setSpeed(next);
        player.setPlaybackRate(next, 'high');
        AsyncStorage.setItem(SPEED_KEY, String(next)).catch(() => {});
    }, [speed, player]);

    const register = useCallback((id: string, uri: string) => { uris.current.set(id, uri); }, []);

    // One ended: the next unplayed one that isn't mine follows on.
    useEffect(() => {
        if (!status.didJustFinish || !currentId) return;
        const next = nextVoiceToPlay(voicesRef.current, currentId, played.current);
        const uri = next ? uris.current.get(next) : undefined;
        if (next && uri) start(next, uri).catch(() => {});
    }, [status.didJustFinish, currentId, start]);

    // The app to the background: the sound stops (no background playback, app.json's expo-audio plugin).
    useEffect(() => {
        const sub = AppState.addEventListener('change', (s) => { if (s !== 'active') player.pause(); });
        return () => sub.remove();
    }, [player]);

    const api = useMemo<VoicePlaybackApi>(() => ({
        currentId, playing: !!status.playing, position: status.currentTime || 0, duration: status.duration || 0, speed,
        toggle, seek, cycleSpeed, register,
    }), [currentId, status.playing, status.currentTime, status.duration, speed, toggle, seek, cycleSpeed, register]);

    return <VoicePlaybackContext.Provider value={api}>{children}</VoicePlaybackContext.Provider>;
}

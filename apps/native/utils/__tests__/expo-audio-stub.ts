/**
 * expo-audio outside a device (vitest.config.ts alias): the composer's microphone and the voice bubble's player import it,
 * and every test that renders a chat renders them. A fake recorder and player whose state a test can read and drive through
 * `expoAudioStub`; nothing records or plays.
 *
 * As on a phone, the state hooks re-render whoever reads them when the state changes: a test changes `recorderState` or
 * `playerStatus` and calls `expoAudioStub.emit()`. And as iOS does (expo-audio 55.0.18 ios/AudioModule.swift), an audio mode
 * with `allowsRecording: false` stops a recorder that is recording, without telling it: `modes` keeps every mode asked for,
 * with whether the recorder was recording at that moment.
 */
import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let version = 0;
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const snapshot = () => version;

export const expoAudioStub = {
    permission: { granted: false, canAskAgain: true, status: 'undetermined' },
    /** What requestRecordingPermissionsAsync answers. */
    answer: { granted: true, canAskAgain: true, status: 'granted' },
    asked: 0,
    /** Every setAudioModeAsync, in order, with whether the recorder was recording when it was asked. */
    modes: [] as { mode: Record<string, unknown>; whileRecording: boolean }[],
    recorder: {
        isRecording: false,
        uri: null as string | null,
        prepared: 0,
        async prepareToRecordAsync() { this.prepared += 1; },
        record() { this.isRecording = true; this.uri = 'file:///rec/voice.m4a'; },
        async stop() { this.isRecording = false; },
    },
    recorderState: { canRecord: true, isRecording: false, durationMillis: 0, mediaServicesDidReset: false, metering: -20, url: null as string | null },
    player: {
        replaced: [] as unknown[], played: 0, paused: 0, rate: 1,
        replace(src: unknown) { this.replaced.push(src); },
        play() { this.played += 1; },
        pause() { this.paused += 1; },
        async seekTo() { /* nothing to move */ },
        setPlaybackRate(r: number) { this.rate = r; },
    },
    playerStatus: { playing: false, currentTime: 0, duration: 0, didJustFinish: false },
    /** The recorder's or the player's state changed: whoever reads it draws again. */
    emit() {
        version += 1;
        for (const fn of [...listeners]) fn();
    },
    reset() {
        this.permission = { granted: false, canAskAgain: true, status: 'undetermined' };
        this.answer = { granted: true, canAskAgain: true, status: 'granted' };
        this.asked = 0;
        this.modes = [];
        Object.assign(this.recorder, { isRecording: false, uri: null, prepared: 0 });
        Object.assign(this.recorderState, { isRecording: false, durationMillis: 0, metering: -20 });
        Object.assign(this.player, { replaced: [], played: 0, paused: 0, rate: 1 });
        Object.assign(this.playerStatus, { playing: false, currentTime: 0, duration: 0, didJustFinish: false });
    },
};

export const useAudioRecorder = () => expoAudioStub.recorder;
export const useAudioRecorderState = () => {
    useSyncExternalStore(subscribe, snapshot, snapshot);
    return expoAudioStub.recorderState;
};
export const useAudioPlayer = () => expoAudioStub.player;
export const useAudioPlayerStatus = () => {
    useSyncExternalStore(subscribe, snapshot, snapshot);
    return expoAudioStub.playerStatus;
};
export const setAudioModeAsync = async (mode: Record<string, unknown>) => {
    const whileRecording = expoAudioStub.recorder.isRecording;
    expoAudioStub.modes.push({ mode, whileRecording });
    // iOS: the playback mode stops a running recording, and the recorder isn't told.
    if (mode.allowsRecording === false && whileRecording) expoAudioStub.recorder.isRecording = false;
};
export const getRecordingPermissionsAsync = async () => ({ ...expoAudioStub.permission });
export const requestRecordingPermissionsAsync = async () => {
    expoAudioStub.asked += 1;
    expoAudioStub.permission = { ...expoAudioStub.answer };
    return { ...expoAudioStub.answer };
};

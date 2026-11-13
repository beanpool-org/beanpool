/**
 * expo-audio outside a device (vitest.config.ts alias): the composer's microphone and the voice bubble's player import it,
 * and every test that renders a chat renders them. A fake recorder and player whose state a test can read and drive through
 * `expoAudioStub`; nothing records or plays.
 */
export const expoAudioStub = {
    permission: { granted: false, canAskAgain: true, status: 'undetermined' },
    /** What requestRecordingPermissionsAsync answers. */
    answer: { granted: true, canAskAgain: true, status: 'granted' },
    asked: 0,
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
    reset() {
        this.permission = { granted: false, canAskAgain: true, status: 'undetermined' };
        this.answer = { granted: true, canAskAgain: true, status: 'granted' };
        this.asked = 0;
        Object.assign(this.recorder, { isRecording: false, uri: null, prepared: 0 });
        Object.assign(this.recorderState, { isRecording: false, durationMillis: 0, metering: -20 });
        Object.assign(this.player, { replaced: [], played: 0, paused: 0, rate: 1 });
        Object.assign(this.playerStatus, { playing: false, currentTime: 0, duration: 0, didJustFinish: false });
    },
};

export const useAudioRecorder = () => expoAudioStub.recorder;
export const useAudioRecorderState = () => expoAudioStub.recorderState;
export const useAudioPlayer = () => expoAudioStub.player;
export const useAudioPlayerStatus = () => expoAudioStub.playerStatus;
export const setAudioModeAsync = async () => { /* no audio session */ };
export const getRecordingPermissionsAsync = async () => ({ ...expoAudioStub.permission });
export const requestRecordingPermissionsAsync = async () => {
    expoAudioStub.asked += 1;
    expoAudioStub.permission = { ...expoAudioStub.answer };
    return { ...expoAudioStub.answer };
};

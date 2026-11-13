/**
 * The voice recorder's rules, with nothing of the device in them (DESIGN-cross-chat-voice-fable.md §5.2, §5.3; slice V3):
 * WhatsApp's feel. With the box empty, Send is a microphone. Hold to record, slide left to cancel, slide up to lock and let
 * go; a locked recording ends with Stop and then shows play, bin and send. Let go to send. Under one second sends nothing
 * and says "Hold to record". At 3:00 it stops by itself and stays ready to send. The microphone is asked for at the first
 * hold, never before (memory permissions-only-when-asked), and that first hold only asks. With a screen reader or the
 * largest text, a tap starts and a tap stops (the locked mode), because a held gesture is hard there.
 *
 * components/chat/VoiceRecorder.tsx feeds the events in and carries out the `effect` each step answers; the tests drive
 * this reducer alone (utils/__tests__/voice-recorder.test.ts).
 */
import { VOICE_BARS, VOICE_MAX_MS } from '@beanpool/core';

/** Shorter than this, let go or sent, is nothing: "Hold to record". */
export const VOICE_MIN_MS = 1000;
/** A slide this far left (dp) while holding throws the recording away. */
export const VOICE_CANCEL_DX = 96;
/** A slide this far up (dp) while holding locks the recording, so the finger can let go. */
export const VOICE_LOCK_DY = 72;
/** Text this large or larger on the phone (or a screen reader) records by tap, not by hold. */
export const VOICE_TAP_MODE_FONT_SCALE = 1.5;

/**
 * The sound, as both phones record it (§5.2): AAC in an .m4a file, mono, 24 kHz, 32 kbps. One format that every phone and
 * browser plays. Metering on, for the waveform.
 */
export const VOICE_RECORDING_OPTIONS = {
    extension: '.m4a',
    sampleRate: 24_000,
    numberOfChannels: 1,
    bitRate: 32_000,
    isMeteringEnabled: true,
    android: { extension: '.m4a', outputFormat: 'mpeg4', audioEncoder: 'aac', sampleRate: 24_000 },
    // 'aac ' as iOS's four-character code (kAudioFormatMPEG4AAC); 64 = AudioQuality.MEDIUM, the encoder's own choice at the bit rate.
    ios: { extension: '.m4a', outputFormat: 'aac ', audioQuality: 64, sampleRate: 24_000 },
    web: { mimeType: 'audio/mp4', bitsPerSecond: 32_000 },
} as const;

/**
 * What an .m4a adds around the sound: the `ftyp` and `moov` boxes with the sample table, about 6 bytes for each of the
 * ~23 AAC frames a second at 24 kHz, and an encoder running a little over its rate. Measured 13 Nov 2026: Apple's encoder
 * at these settings (afconvert, the one iOS records with) made 60 s of speech in 251,787 bytes: 243,595 of sound (32.4
 * kbps) and 8,192 of container.
 */
export const VOICE_CONTAINER_ALLOWANCE_BYTES = 16_000;

/** The most a recording of `ms` may weigh at VOICE_RECORDING_OPTIONS: the bit rate's share and the container. */
export function voiceBytesBudget(ms: number): number {
    return Math.ceil((VOICE_RECORDING_OPTIONS.bitRate / 8) * (ms / 1000)) + VOICE_CONTAINER_ALLOWANCE_BYTES;
}

export type VoiceHint = 'hold' | 'denied' | null;

export type VoiceRecorderState =
    /** Nothing recording. `hint`: "Hold to record" after a hold too short, or the refused microphone's sheet. */
    | { phase: 'idle'; hint: VoiceHint }
    /** The first hold: the microphone is being asked for. Nothing is recorded. */
    | { phase: 'asking' }
    /** Recording. `locked`: slid up (or started by tap), so letting go doesn't send. */
    | { phase: 'recording'; ms: number; locked: boolean }
    /** Stopped and kept: play, bin or send. `limit`: it stopped itself at 3:00. */
    | { phase: 'review'; ms: number; limit: boolean };

export type VoicePermission = 'granted' | 'ask' | 'refused';

export type VoiceRecorderEvent =
    /** The finger went down on the microphone (or a tap in tap mode, with `tap`). */
    | { type: 'hold'; permission: VoicePermission; tap?: boolean }
    /** The system's answer to the first hold's ask. */
    | { type: 'permission'; granted: boolean }
    /** The recorder's clock. */
    | { type: 'tick'; ms: number }
    /** The finger moved while holding, from where it went down (dp; left and up are negative). */
    | { type: 'move'; dx: number; dy: number }
    /** The finger came up. */
    | { type: 'release' }
    /** Stop, on a locked recording: keep it for play, bin or send. */
    | { type: 'stop' }
    /** The bin. */
    | { type: 'cancel' }
    /** Send, on a locked recording or one kept. */
    | { type: 'send' }
    /** The recorder failed to start or stopped on its own (a call came in, the system took the microphone). */
    | { type: 'failed' }
    /** The hint has been shown long enough. */
    | { type: 'dismiss' };

/**
 * What the component must do after a step:
 *   'ask'     ask for the microphone (the first hold only asks);
 *   'start'   start recording;
 *   'send'    stop if still recording, then send what was recorded;
 *   'keep'    stop and keep the file for play, bin or send;
 *   'discard' stop if still recording, and throw the file away;
 *   'settings' show the refused microphone's sheet, with a way to Settings.
 */
export type VoiceRecorderEffect = 'ask' | 'start' | 'send' | 'keep' | 'discard' | 'settings' | null;

export const VOICE_IDLE: VoiceRecorderState = { phase: 'idle', hint: null };

/**
 * One step: the state after it, what the component must do, and for 'send' and 'keep' the recording's length in ms, which
 * the state after a send (idle) no longer holds.
 */
export interface VoiceRecorderStep {
    state: VoiceRecorderState;
    effect: VoiceRecorderEffect;
    ms?: number;
}

/** One step of the recorder. Pure: the same state and event always answer the same. */
export function voiceRecorderStep(state: VoiceRecorderState, event: VoiceRecorderEvent): VoiceRecorderStep {
    const same = { state, effect: null };
    switch (event.type) {
        case 'hold':
            if (state.phase !== 'idle') return same;
            if (event.permission === 'ask') return { state: { phase: 'asking' }, effect: 'ask' };
            if (event.permission === 'refused') return { state: { phase: 'idle', hint: 'denied' }, effect: 'settings' };
            return { state: { phase: 'recording', ms: 0, locked: !!event.tap }, effect: 'start' };
        case 'permission':
            // That first hold only asks: granted, the next hold records.
            if (state.phase !== 'asking') return same;
            return event.granted ? { state: { phase: 'idle', hint: 'hold' }, effect: null } : { state: { phase: 'idle', hint: 'denied' }, effect: 'settings' };
        case 'tick': {
            if (state.phase !== 'recording') return same;
            const ms = Math.max(state.ms, Math.floor(event.ms));
            if (ms >= VOICE_MAX_MS) return { state: { phase: 'review', ms: VOICE_MAX_MS, limit: true }, effect: 'keep', ms: VOICE_MAX_MS };
            return { state: { ...state, ms }, effect: null };
        }
        case 'move':
            if (state.phase !== 'recording' || state.locked) return same;
            if (event.dx <= -VOICE_CANCEL_DX) return { state: VOICE_IDLE, effect: 'discard' };
            if (event.dy <= -VOICE_LOCK_DY) return { state: { ...state, locked: true }, effect: null };
            return same;
        case 'release':
            if (state.phase !== 'recording' || state.locked) return same;
            return finish(state.ms);
        case 'stop':
            if (state.phase !== 'recording' || !state.locked) return same;
            return { state: { phase: 'review', ms: state.ms, limit: false }, effect: 'keep', ms: state.ms };
        case 'cancel':
            if (state.phase !== 'recording' && state.phase !== 'review') return same;
            return { state: VOICE_IDLE, effect: 'discard' };
        case 'send':
            if (state.phase === 'review' || (state.phase === 'recording' && state.locked)) return finish(state.ms);
            return same;
        case 'failed':
            if (state.phase !== 'recording') return same;
            return { state: VOICE_IDLE, effect: 'discard' };
        case 'dismiss':
            return state.phase === 'idle' && state.hint ? { state: VOICE_IDLE, effect: null } : same;
    }
}

/** Let go or Send: under a second is nothing, and says "Hold to record"; else it goes. */
function finish(ms: number): VoiceRecorderStep {
    if (ms < VOICE_MIN_MS) return { state: { phase: 'idle', hint: 'hold' }, effect: 'discard' };
    return { state: VOICE_IDLE, effect: 'send', ms };
}

/** The quietest level drawn as more than nothing, in dBFS (expo-audio's metering: -160 to 0). */
const FLOOR_DB = -50;

/**
 * The waveform the sender draws while recording (§5.4): VOICE_BARS whole numbers, 0 to 255, from the levels the recorder
 * reported (dBFS, one every tick). Each bar is the loudest level in its share of the recording. None reported: a flat line.
 */
export function voiceBarsFromLevels(levels: readonly number[]): number[] {
    const bars: number[] = [];
    for (let i = 0; i < VOICE_BARS; i++) {
        const from = Math.floor((i * levels.length) / VOICE_BARS);
        const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / VOICE_BARS));
        let loudest = -Infinity;
        for (let j = from; j < to && j < levels.length; j++) if (Number.isFinite(levels[j]) && levels[j] > loudest) loudest = levels[j];
        const share = loudest === -Infinity ? 0 : Math.min(1, Math.max(0, (loudest - FLOOR_DB) / -FLOOR_DB));
        bars.push(Math.round(share * 255));
    }
    return bars;
}

/** A length as the bubble and the recorder show it: 0:07, 1:42, 3:00. */
export function voiceClock(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

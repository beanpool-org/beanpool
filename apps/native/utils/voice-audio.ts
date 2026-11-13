/**
 * The phone's one audio session and its one owner (DESIGN-cross-chat-voice-fable.md §5.3, §5.5; slice V3). The composer's
 * recorder (components/chat/VoiceRecorder.tsx) and a chat's player (components/chat/VoicePlayback.tsx) sit in different parts
 * of the screen, so they meet here, and nowhere else sets expo-audio's audio mode.
 *
 * The rules (PR #3112 review):
 *   - Nothing plays while a recording runs or waits for review: when the recorder takes the session, every chat player is
 *     paused, and none starts, resumes or moves on to the next message until the recorder lets go (sent, binned, left).
 *     A sound playing into the speaker would otherwise go into the new message.
 *   - Playing never changes the mode while the recorder holds the session. On iOS, `allowsRecording: false` stops every
 *     recorder that is recording (expo-audio 55.0.18 ios/AudioModule.swift), without the recorder knowing: the bar kept
 *     showing ● and Send sent the cut-off file.
 */
import { setAudioModeAsync } from 'expo-audio';

/** Out of the speaker, even with the phone on silent, never in the background (app.json's expo-audio plugin). */
const PLAYBACK = { playsInSilentMode: true, allowsRecording: false, shouldPlayInBackground: false } as const;
const RECORDING = { playsInSilentMode: true, allowsRecording: true, shouldPlayInBackground: false } as const;

/** What the recorder holds the session for: the microphone live, or a stopped recording waiting for play, bin or send. */
export type VoiceAudioHold = 'recording' | 'review' | null;

let hold: VoiceAudioHold = null;
const players = new Set<() => void>();

function pausePlayers(): void {
    for (const pause of players) {
        try { pause(); } catch { /* a player already released */ }
    }
}

/** What the recorder holds the session for now, or null. */
export function voiceAudioHold(): VoiceAudioHold {
    return hold;
}

/** The recorder is about to record: every chat player paused, then the microphone's mode. */
export async function holdAudioForRecording(): Promise<void> {
    hold = 'recording';
    pausePlayers();
    await setAudioModeAsync(RECORDING);
}

/**
 * The recorder has stopped and keeps its file for play, bin or send (or a send failed and it is back for another try). The
 * chat's players stay paused; the playback mode is safe now that nothing records, so the recording's own preview plays.
 */
export async function holdAudioForReview(): Promise<void> {
    hold = 'review';
    pausePlayers();
    await setAudioModeAsync(PLAYBACK);
}

/** The recorder lets go: its recording was sent, binned or left behind. Call only after the recorder has stopped. */
export async function releaseAudio(): Promise<void> {
    hold = null;
    await setAudioModeAsync(PLAYBACK);
}

/**
 * A chat player asks to start or resume: false while the recorder holds the session, and the mode is then left alone. Asked
 * again after the mode is set, because a hold may begin while it was being set.
 */
export async function audioForPlaying(): Promise<boolean> {
    if (hold) return false;
    await setAudioModeAsync(PLAYBACK).catch(() => {});
    return !hold;
}

/** A chat player's pause, called whenever the recorder takes the session. Answers the unsubscribe. */
export function onAudioHeld(pause: () => void): () => void {
    players.add(pause);
    return () => { players.delete(pause); };
}

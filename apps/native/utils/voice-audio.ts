/**
 * The phone's one audio session and who holds it (DESIGN-cross-chat-voice-fable.md §5.3, §5.5; slice V3). The composer's
 * recorder (components/chat/VoiceRecorder.tsx) and a chat's player (components/chat/VoicePlayback.tsx) sit in different parts
 * of the screen, so they meet here, and nowhere else sets expo-audio's audio mode.
 *
 * Every hold has an OWNER: one open chat screen (newVoiceAudioOwner, made once per screen and handed to both its player and
 * its recorder). A chat can stay open under another one (header → profile → Message pushes a chat on top), so a hold
 * reaches only as far as it must (PR #3112 review, round 2):
 *   - A live microphone holds every player on the phone: when a recorder starts, every chat player is paused, and none
 *     starts, resumes or moves on to the next message until it stops. A sound playing into the speaker would otherwise go
 *     into the new message, and on iOS `allowsRecording: false` stops every recorder that is recording (expo-audio 55.0.18
 *     ios/AudioModule.swift) without the recorder knowing: the bar kept showing ● and Send sent the cut-off file.
 *   - A stopped recording waiting for play, bin or send holds only its own chat's player: that chat stays quiet until it is
 *     sent, binned or left, and a chat opened on top of it plays as any chat does.
 *   - Only the owner lets go of its hold: a chat on top sending or binning its own recording leaves the one underneath
 *     waiting, still held.
 */
import { setAudioModeAsync } from 'expo-audio';

/** Out of the speaker, even with the phone on silent, never in the background (app.json's expo-audio plugin). */
const PLAYBACK = { playsInSilentMode: true, allowsRecording: false, shouldPlayInBackground: false } as const;
const RECORDING = { playsInSilentMode: true, allowsRecording: true, shouldPlayInBackground: false } as const;

/** What a recorder holds the session for: the microphone live, or a stopped recording waiting for play, bin or send. */
export type VoiceAudioHold = 'recording' | 'review' | null;

const holds = new Map<string, Exclude<VoiceAudioHold, null>>();
const players = new Set<{ owner: string; pause: () => void }>();
let owners = 0;

/** One chat screen's owner of its holds: its player and its recorder are both given it. Never the same twice. */
export function newVoiceAudioOwner(chatId = 'chat'): string {
    owners += 1;
    return `${chatId}#${owners}`;
}

function someoneRecords(): boolean {
    for (const kind of holds.values()) if (kind === 'recording') return true;
    return false;
}

/** Pause the players `owner` names, or every player on the phone. */
function pausePlayers(owner?: string): void {
    for (const p of players) {
        if (owner !== undefined && p.owner !== owner) continue;
        try { p.pause(); } catch { /* a player already released */ }
    }
}

/**
 * What holds `owner`'s player now: its own chat's recorder (recording or review), else a live microphone anywhere, else null.
 */
export function voiceAudioHold(owner: string): VoiceAudioHold {
    return holds.get(owner) ?? (someoneRecords() ? 'recording' : null);
}

/** `owner`'s recorder is about to record: every chat player on the phone paused, then the microphone's mode. */
export async function holdAudioForRecording(owner: string): Promise<void> {
    holds.set(owner, 'recording');
    pausePlayers();
    await setAudioModeAsync(RECORDING);
}

/**
 * `owner`'s recorder has stopped and keeps its file for play, bin or send (or a send failed and it is back for another try).
 * Its own chat's player stays paused; the playback mode is safe now that it records nothing, so the recording's own preview
 * plays. Left alone while another chat's microphone is live (that mode would cut it).
 */
export async function holdAudioForReview(owner: string): Promise<void> {
    holds.set(owner, 'review');
    pausePlayers(owner);
    if (!someoneRecords()) await setAudioModeAsync(PLAYBACK);
}

/**
 * `owner`'s recorder lets go: its recording was sent, binned or left behind. Call only after the recorder has stopped. Only
 * the owner's hold goes; another chat's recording waiting underneath stays held, and a live microphone elsewhere keeps its
 * mode.
 */
export async function releaseAudio(owner: string): Promise<void> {
    if (!holds.delete(owner)) return;
    if (!someoneRecords()) await setAudioModeAsync(PLAYBACK);
}

/**
 * `owner`'s player asks to start or resume: false while its chat's recorder holds the session or a microphone is live, and
 * the mode is then left alone. Asked again after the mode is set, because a hold may begin while it was being set.
 */
export async function audioForPlaying(owner: string): Promise<boolean> {
    if (voiceAudioHold(owner)) return false;
    await setAudioModeAsync(PLAYBACK).catch(() => {});
    return !voiceAudioHold(owner);
}

/** `owner`'s player's pause, called whenever a hold that reaches it begins. Answers the unsubscribe. */
export function onAudioHeld(owner: string, pause: () => void): () => void {
    const p = { owner, pause };
    players.add(p);
    return () => { players.delete(p); };
}

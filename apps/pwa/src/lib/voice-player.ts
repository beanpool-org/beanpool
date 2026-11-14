/**
 * The open chat's voice player (voice messages V4, DESIGN-cross-chat-voice-fable.md §5.5): one sound at a time, for the page.
 * The phone's twins are apps/native components/chat/VoicePlayback.tsx and utils/voice-audio.ts (#3112).
 *
 * - One <audio> plays, from the opened sound in this page's memory (a blob URL let go when the next plays or the chat
 *   closes). The web keeps no copy of a sound anywhere.
 * - Speeds 1×, 1.5×, 2×: the step is remembered in this browser (a convenience; it reads 1× when storage can't be read).
 * - The next voice message plays on by itself: only the very next one in the chat, only when it isn't mine and hasn't been
 *   played in this chat yet.
 * - Nothing plays while a recording is going or waits for Send (holdVoicePlayers): the recorder holds the player, which
 *   pauses and refuses to start until the recorder lets go. A web page has one open chat, so the hold is the page's.
 * - Leaving the chat stops it (stopVoicePlayer); no "played" tick goes anywhere.
 */
import { useSyncExternalStore } from 'react';
import { type VoicePart, VOICE_MIME } from '@beanpool/core';
import { nextVoiceSpeed, VOICE_SPEEDS } from './voice';

export interface VoicePlayerState {
    /** The line playing or paused mid-way; null when nothing is. */
    currentId: string | null;
    playing: boolean;
    positionMs: number;
    speed: number;
    /** A recording holds the player: nothing plays. */
    held: boolean;
}

const SPEED_KEY = 'beanpool-voice-speed';

function readSpeed(): number {
    try {
        const n = Number(localStorage.getItem(SPEED_KEY));
        return (VOICE_SPEEDS as readonly number[]).includes(n) ? n : 1;
    } catch {
        return 1;
    }
}

let state: VoicePlayerState = { currentId: null, playing: false, positionMs: 0, speed: 1, held: false };
let speedRead = false;
const listeners = new Set<() => void>();
let audio: HTMLAudioElement | null = null;
let url: string | null = null;
let order: { id: string; mine: boolean }[] = [];
const played = new Set<string>();
const loaders = new Map<string, () => Promise<VoicePart | null>>();

function set(next: Partial<VoicePlayerState>) {
    state = { ...state, ...next };
    for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

function snapshot(): VoicePlayerState {
    if (!speedRead) { speedRead = true; state = { ...state, speed: readSpeed() }; }
    return state;
}

/** The player as a bubble draws it. */
export function useVoicePlayer(): VoicePlayerState {
    return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function voicePlayerState(): VoicePlayerState {
    return snapshot();
}

function letGoOfUrl() {
    if (url) { try { URL.revokeObjectURL(url); } catch { /* nothing to let go */ } }
    url = null;
}

function element(): HTMLAudioElement {
    if (audio) return audio;
    const a = new Audio();
    a.preload = 'auto';
    a.addEventListener('timeupdate', () => { if (audio === a) set({ positionMs: Math.round(a.currentTime * 1000) }); });
    a.addEventListener('pause', () => { if (audio === a) set({ playing: false }); });
    a.addEventListener('play', () => { if (audio === a) set({ playing: true }); });
    a.addEventListener('ended', () => { if (audio === a) void playNext(); });
    audio = a;
    return a;
}

/** The chat's voice lines in the order the chat draws them, each marked mine or not: what plays on after what. */
export function setVoiceOrder(next: readonly { id: string; mine: boolean }[]) {
    order = next.map((v) => ({ id: v.id, mine: v.mine }));
}

/** A bubble's opened sound, so the line before it can play on into it. */
export function registerVoice(id: string, load: () => Promise<VoicePart | null>): () => void {
    loaders.set(id, load);
    return () => { if (loaders.get(id) === load) loaders.delete(id); };
}

/** Play `id` from `fromMs` (or where it was paused), at the remembered speed. Refused while a recording holds the player. */
export async function playVoice(id: string, part: VoicePart, fromMs?: number): Promise<boolean> {
    if (state.held) return false;
    const a = element();
    if (state.currentId !== id || !url) {
        a.pause();
        letGoOfUrl();
        url = URL.createObjectURL(new Blob([part.sound as BlobPart], { type: VOICE_MIME }));
        a.src = url;
        set({ currentId: id, positionMs: 0, playing: false });
    }
    if (typeof fromMs === 'number') {
        try { a.currentTime = Math.max(0, fromMs) / 1000; } catch { /* not seekable yet: it starts from the top */ }
        set({ positionMs: Math.max(0, Math.round(fromMs)) });
    }
    a.playbackRate = snapshot().speed;
    played.add(id);
    try {
        await a.play();
        return true;
    } catch {
        set({ playing: false });
        return false;
    }
}

export function pauseVoice() {
    audio?.pause();
}

/** Move the line playing (or the one tapped) to `share` (0 to 1) of its length; plays on if it was playing. */
export async function seekVoice(id: string, part: VoicePart, share: number): Promise<void> {
    const ms = Math.round(Math.min(1, Math.max(0, share)) * part.durationMs);
    if (state.currentId === id && audio) {
        try { audio.currentTime = ms / 1000; } catch { /* not seekable yet */ }
        set({ positionMs: ms });
        return;
    }
    await playVoice(id, part, ms);
}

export function cycleVoiceSpeed() {
    const speed = nextVoiceSpeed(snapshot().speed);
    try { localStorage.setItem(SPEED_KEY, String(speed)); } catch { /* remembered for this page only */ }
    if (audio) audio.playbackRate = speed;
    set({ speed });
}

/** The very next voice line plays on, when it isn't mine and hasn't played here. */
async function playNext() {
    const at = order.findIndex((v) => v.id === state.currentId);
    set({ playing: false, positionMs: 0 });
    const next = at >= 0 ? order[at + 1] : undefined;
    if (!next || next.mine || played.has(next.id) || state.held) return;
    const part = await loaders.get(next.id)?.().catch(() => null);
    if (part && !state.held) await playVoice(next.id, part, 0);
}

/** A recording holds the player (true) or lets it go (false). Holding pauses whatever plays. */
export function holdVoicePlayers(on: boolean) {
    if (on) audio?.pause();
    if (state.held !== on) set({ held: on, ...(on ? { playing: false } : {}) });
}

/** The chat closed: nothing plays, nothing is kept. */
export function stopVoicePlayer() {
    audio?.pause();
    if (audio) { try { audio.removeAttribute('src'); audio.load(); } catch { /* jsdom */ } }
    letGoOfUrl();
    played.clear();
    order = [];
    set({ currentId: null, playing: false, positionMs: 0 });
}

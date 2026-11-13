/**
 * Playing voice messages, with nothing of the device in it (DESIGN-cross-chat-voice-fable.md §5.4, §5.5; slice V3).
 *
 * Tap to play; drag along the waveform to move; one button steps 1× → 1.5× → 2× and is remembered; the next unplayed voice
 * message in the chat follows on by itself. No "played" tick goes to anyone: what this phone played is its own.
 *
 * The phone's own copy: the sound a phone has sent or played is kept in the app's own files, up to 200 MB, oldest out. The
 * community's server keeps it for 30 days; after that only the phones that have it can play it.
 */

/** The speeds, in the order the button steps through them. */
export const VOICE_SPEEDS = [1, 1.5, 2] as const;
export type VoiceSpeed = (typeof VOICE_SPEEDS)[number];

/** The speed after `now`; anything unknown starts again at 1×. */
export function nextVoiceSpeed(now: number): VoiceSpeed {
    const i = VOICE_SPEEDS.indexOf(now as VoiceSpeed);
    return VOICE_SPEEDS[(i + 1) % VOICE_SPEEDS.length];
}

/** A stored speed, read back: one of VOICE_SPEEDS or 1×. */
export function voiceSpeedOf(stored: unknown): VoiceSpeed {
    const n = typeof stored === 'string' ? Number(stored) : stored;
    return VOICE_SPEEDS.includes(n as VoiceSpeed) ? (n as VoiceSpeed) : 1;
}

/** The button's words: 1×, 1.5×, 2×. */
export function voiceSpeedLabel(speed: VoiceSpeed): string {
    return `${speed}×`;
}

/** A voice line as the chat lists it, oldest first. */
export interface VoiceInChat {
    id: string;
    /** Sent by this phone's member: never played on by itself. */
    mine: boolean;
}

/**
 * What plays when `finishedId` ends (§5.5): the next voice message after it in the chat, if it isn't mine and this phone
 * hasn't played it. Only the very next voice line: an own one, or one played before, ends the run, as a reply would.
 */
export function nextVoiceToPlay(chat: readonly VoiceInChat[], finishedId: string, played: ReadonlySet<string>): string | null {
    const at = chat.findIndex((v) => v.id === finishedId);
    if (at < 0) return null;
    const next = chat[at + 1];
    if (!next || next.mine || played.has(next.id)) return null;
    return next.id;
}

/** The phone's own copy of voice messages: at most this much, oldest out. */
export const VOICE_CACHE_MAX_BYTES = 200 * 1024 * 1024;

/** A kept voice message's files, as the folder lists them. */
export interface VoiceCacheEntry {
    id: string;
    bytes: number;
    /** When it was kept or last played, ms since 1970. */
    at: number;
}

/** The ids to delete so what stays is at most `max` bytes: the oldest first, never one in `keep` (those just kept). */
export function voiceCacheToEvict(entries: readonly VoiceCacheEntry[], max: number = VOICE_CACHE_MAX_BYTES, keep?: string | ReadonlySet<string>): string[] {
    let total = entries.reduce((sum, e) => sum + Math.max(0, e.bytes), 0);
    if (total <= max) return [];
    const kept = typeof keep === 'string' ? new Set([keep]) : keep ?? new Set<string>();
    const out: string[] = [];
    for (const e of [...entries].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))) {
        if (total <= max) break;
        if (kept.has(e.id)) continue;
        out.push(e.id);
        total -= Math.max(0, e.bytes);
    }
    return out;
}

/** The share of a waveform `x` dp along a `width` dp line, 0 to 1: where a drag moves the sound to. */
export function voiceSeekShare(x: number, width: number): number {
    if (!(width > 0) || !Number.isFinite(x)) return 0;
    return Math.min(1, Math.max(0, x / width));
}

/** A message id as a file name: lower-case UUID characters only, or nothing (never a path). */
export function voiceFileId(messageId: string): string | null {
    const id = String(messageId ?? '').toLowerCase();
    return /^[0-9a-f-]{8,64}$/.test(id) ? id : null;
}

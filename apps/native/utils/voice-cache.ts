/**
 * voice-cache — the phone's own copy of the voice messages it sent or played (DESIGN-cross-chat-voice-fable.md §5.4):
 * in the app's own files, not the OS cache folder, because after 30 days the community's server deletes the sound and
 * this copy is then the only one. Up to 200 MB, oldest out (utils/voice-playback.ts voiceCacheToEvict). Opened at rest,
 * as photos are: the seal keeps the sound from the node, and the phone's owner already hears it.
 *
 * Each kept message is two files under its message id: `<id>.m4a`, the sound the player opens, and `<id>.json`, its length
 * and waveform and when it was kept or last played. A message id becomes a file name only when it is a plain id.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { encodeBase64 } from './crypto';
import { VOICE_BARS, VOICE_MAX_MS } from '@beanpool/core';
import { voiceCacheToEvict, voiceFileId, type VoiceCacheEntry } from './voice-playback';

const VOICE_DIR = `${FileSystem.documentDirectory}voice/`;

/** A voice message the player can open: its file, its length and its waveform. */
export interface KeptVoice {
    uri: string;
    durationMs: number;
    bars: number[];
}

const soundOf = (id: string) => `${VOICE_DIR}${id}.m4a`;
const factsOf = (id: string) => `${VOICE_DIR}${id}.json`;

function factsFrom(raw: string): { durationMs: number; bars: number[]; at: number } | null {
    try {
        const j = JSON.parse(raw);
        const ok = Number.isSafeInteger(j?.durationMs) && j.durationMs >= 1 && j.durationMs <= VOICE_MAX_MS
            && Array.isArray(j.bars) && j.bars.length === VOICE_BARS && j.bars.every((b: unknown) => Number.isInteger(b) && (b as number) >= 0 && (b as number) <= 255);
        return ok ? { durationMs: j.durationMs, bars: j.bars, at: Number(j.at) || 0 } : null;
    } catch {
        return null;
    }
}

/** A voice message this phone kept before, or null. */
export async function keptVoice(messageId: string): Promise<KeptVoice | null> {
    const id = voiceFileId(messageId);
    if (!id) return null;
    try {
        if (!(await FileSystem.getInfoAsync(soundOf(id))).exists) return null;
        const facts = factsFrom(await FileSystem.readAsStringAsync(factsOf(id)));
        return facts ? { uri: soundOf(id), durationMs: facts.durationMs, bars: facts.bars } : null;
    } catch {
        return null;
    }
}

/**
 * Keep an opened (or just sent) voice message, then take the oldest off past 200 MB. Answers what the player opens, or
 * null when it couldn't be kept (a full disk): nothing half-written stays under its name.
 */
export async function keepVoice(messageId: string, voice: { durationMs: number; bars: ArrayLike<number>; sound: Uint8Array }): Promise<KeptVoice | null> {
    const id = voiceFileId(messageId);
    if (!id) return null;
    try {
        await FileSystem.makeDirectoryAsync(VOICE_DIR, { intermediates: true }).catch(() => {});
        await FileSystem.writeAsStringAsync(soundOf(id), encodeBase64(voice.sound), { encoding: FileSystem.EncodingType.Base64 });
        await FileSystem.writeAsStringAsync(factsOf(id), JSON.stringify({ durationMs: voice.durationMs, bars: Array.from(voice.bars), at: Date.now() }));
    } catch {
        await forgetVoice(id);
        return null;
    }
    await trimVoiceCache(id).catch(() => { /* tried again at the next keep */ });
    return { uri: soundOf(id), durationMs: voice.durationMs, bars: Array.from(voice.bars) };
}

/** Mark a kept voice message as just played, so it is the last to go. */
export async function touchVoice(messageId: string): Promise<void> {
    const id = voiceFileId(messageId);
    if (!id) return;
    try {
        const facts = factsFrom(await FileSystem.readAsStringAsync(factsOf(id)));
        if (facts) await FileSystem.writeAsStringAsync(factsOf(id), JSON.stringify({ ...facts, at: Date.now() }));
    } catch { /* not kept */ }
}

/** Take one voice message off this phone (a line deleted for everyone, a file that failed to write). */
export async function forgetVoice(messageId: string): Promise<void> {
    const id = voiceFileId(messageId);
    if (!id) return;
    await FileSystem.deleteAsync(soundOf(id), { idempotent: true }).catch(() => {});
    await FileSystem.deleteAsync(factsOf(id), { idempotent: true }).catch(() => {});
}

async function trimVoiceCache(keep: string): Promise<void> {
    const names = await FileSystem.readDirectoryAsync(VOICE_DIR);
    const entries: VoiceCacheEntry[] = [];
    for (const name of names) {
        const m = name.match(/^(.+)\.m4a$/);
        const id = m ? voiceFileId(m[1]) : null;
        if (!id) continue;
        const info = await FileSystem.getInfoAsync(soundOf(id));
        const facts = await FileSystem.readAsStringAsync(factsOf(id)).then(factsFrom).catch(() => null);
        entries.push({ id, bytes: info.exists ? (info as { size?: number }).size ?? 0 : 0, at: facts?.at ?? 0 });
    }
    for (const id of voiceCacheToEvict(entries, undefined, keep)) await forgetVoice(id);
}

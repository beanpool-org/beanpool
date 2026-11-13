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
import { voiceCacheToEvict, voiceFileId, VOICE_CACHE_MAX_BYTES, type VoiceCacheEntry } from './voice-playback';

/** Read when used, never at import: a test's stand-in file system need not have it. */
const voiceDir = () => `${FileSystem.documentDirectory}voice/`;

/** A voice message the player can open: its file, its length and its waveform. */
export interface KeptVoice {
    uri: string;
    durationMs: number;
    bars: number[];
}

const soundOf = (id: string) => `${voiceDir()}${id}.m4a`;
const factsOf = (id: string) => `${voiceDir()}${id}.json`;

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
 * Keep an opened (or just sent) voice message. Answers what the player opens, or null when it couldn't be kept (a full disk):
 * nothing half-written stays under its name. Taking the oldest off past 200 MB comes after, and is never waited on: the
 * bubble plays as soon as its file is written (PR #3112 review: a full scan on the playing path was seconds of spinner on
 * the API 26 phones).
 */
export async function keepVoice(messageId: string, voice: { durationMs: number; bars: ArrayLike<number>; sound: Uint8Array }): Promise<KeptVoice | null> {
    const id = voiceFileId(messageId);
    if (!id) return null;
    try {
        await FileSystem.makeDirectoryAsync(voiceDir(), { intermediates: true }).catch(() => {});
        await FileSystem.writeAsStringAsync(soundOf(id), encodeBase64(voice.sound), { encoding: FileSystem.EncodingType.Base64 });
        await FileSystem.writeAsStringAsync(factsOf(id), JSON.stringify({ durationMs: voice.durationMs, bars: Array.from(voice.bars), at: Date.now() }));
    } catch {
        await forgetVoice(id);
        return null;
    }
    tidyAfterKeep(id, voice.sound.length);
    return { uri: soundOf(id), durationMs: voice.durationMs, bars: Array.from(voice.bars) };
}

/**
 * The tidy: one at a time, never on the playing path. `knownBytes` is the folder's size as the last scan left it plus every
 * sound kept since (an over-count when one is kept again or taken off, which only brings the next scan sooner), so while it
 * is under 200 MB nothing is read at all. The ids kept since the tidy last ran are never the ones it takes off.
 */
let knownBytes: number | null = null;
/** Sound kept while a scan runs, which the scan may not have seen: added to what it found. */
let keptWhileScanning = 0;
let tidying: Promise<void> | null = null;
let tidyAgain = false;
const justKept = new Set<string>();

function tidyAfterKeep(id: string, bytes: number): void {
    justKept.add(id);
    if (knownBytes !== null) knownBytes += bytes;
    keptWhileScanning += bytes;
    if (tidying) { tidyAgain = true; return; }
    tidying = (async () => {
        do {
            tidyAgain = false;
            const keep = new Set(justKept);
            justKept.clear();
            if (knownBytes !== null && knownBytes <= VOICE_CACHE_MAX_BYTES) continue;
            keptWhileScanning = 0;
            try {
                knownBytes = (await trimVoiceCache(keep)) + keptWhileScanning;
            } catch {
                knownBytes = null; /* scanned again at the next keep */
            }
        } while (tidyAgain);
    })().finally(() => { tidying = null; });
}

/** The tidy running now, for a test to wait on; resolved when none is. */
export function voiceTidyForTest(): Promise<void> {
    return tidying ?? Promise.resolve();
}

/** Forget what the tidy knows (a test starting from an empty folder). */
export function resetVoiceTidyForTest(): void {
    knownBytes = null;
    tidyAgain = false;
    justKept.clear();
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

/** Take one voice message off this phone (a line deleted for everyone, a file that failed to write). Never throws. */
export async function forgetVoice(messageId: string): Promise<void> {
    const id = voiceFileId(messageId);
    if (!id) return;
    try { await FileSystem.deleteAsync(soundOf(id), { idempotent: true }); } catch { /* the message is gone either way */ }
    try { await FileSystem.deleteAsync(factsOf(id), { idempotent: true }); } catch { /* as above */ }
}

/** The removed lines this session already took the sound of: each is asked once, not on every poll. */
const removedVoices = new Set<string>();

/**
 * A line the node now serves as removed (deleted by its author, removed by a convenor) takes its kept sound with it, as a
 * group photo does (utils/group-photo-cache.ts forgetRemovedGroupPhotos). Not waited on.
 */
export function forgetRemovedVoices(messages: unknown): void {
    if (!Array.isArray(messages)) return;
    for (const m of messages) {
        if (m?.type !== 'removed') continue;
        const id = voiceFileId(String(m.id));
        if (!id || removedVoices.has(id)) continue;
        if (removedVoices.size >= 5000) removedVoices.clear();
        removedVoices.add(id);
        forgetVoice(id).catch(() => { removedVoices.delete(id); });
    }
}

/** Scan the folder and take the oldest off past 200 MB, never one in `keep`. Answers the size that stays. */
async function trimVoiceCache(keep: ReadonlySet<string>): Promise<number> {
    const names = await FileSystem.readDirectoryAsync(voiceDir());
    const entries: VoiceCacheEntry[] = [];
    for (const name of names) {
        const m = name.match(/^(.+)\.m4a$/);
        const id = m ? voiceFileId(m[1]) : null;
        if (!id) continue;
        const info = await FileSystem.getInfoAsync(soundOf(id));
        const facts = await FileSystem.readAsStringAsync(factsOf(id)).then(factsFrom).catch(() => null);
        entries.push({ id, bytes: info.exists ? (info as { size?: number }).size ?? 0 : 0, at: facts?.at ?? 0 });
    }
    const out = new Set(voiceCacheToEvict(entries, undefined, keep));
    for (const id of out) await forgetVoice(id);
    return entries.reduce((sum, e) => sum + (out.has(e.id) ? 0 : Math.max(0, e.bytes)), 0);
}

/**
 * Voice messages: the part a recorded message is sealed as, in direct and group chats (scratch/fable-design/
 * DESIGN-cross-chat-voice-fable.md §5.2, §5.4; slice V1). The constants below are the one place the node and both apps
 * read the length cap, the bar count, the size cap and the sound's type from.
 *
 * The part. A voice message is its own part of its message, named VOICE_PART ('voice'), sealed under the same keys a
 * photo is: a direct chat's key (dm-crypto.ts sealDmVoice), or the group line's own per-message key (group-crypto.ts
 * sealGroupVoice). The part name is bound into the seal and the signature, so a voice part never opens as a photo or as
 * words, and a photo or words never open as a voice part.
 *
 * Sealed as bytes, not as text: a photo is turned into a data URI before it is sealed, which costs a third more and then
 * a third again when the sealed bytes go as base64. Inside the line's own frame ([format][length of after][after], the
 * same frame as the line's words) the part is:
 *
 *   [version]        1 byte, VOICE_PART_VERSION
 *   [length]         4 bytes, unsigned big-endian: the length in milliseconds, 1 to VOICE_MAX_MS
 *   [bar count]      1 byte, VOICE_BARS
 *   [bars]           VOICE_BARS bytes, 0 to 255 each: the waveform the sender drew while recording
 *   [the sound]      an .m4a file (AAC in ISO-BMFF, type VOICE_MIME): it starts with an `ftyp` box
 *
 * The header (length, bar count and bars) is inside the seal: the node learns the size, which tells roughly the length,
 * and nothing else.
 *
 * Opening checks, in order: the sealed size as sent (VOICE_SEALED_MAX_BYTES, before anything is opened), the seal and its
 * sender's signature under the part name `voice`, the version, the header's shape, the length, the `ftyp` box. Anything
 * else is refused with a VoiceRefusedError whose `reason` the apps turn into "This voice message can't be played". The
 * sealing functions refuse the same things before anything is sent.
 *
 * What is not checked here: that the sound decodes, or that its own length matches the header's. A crafted file still
 * reaches the system's decoder, as in every messenger (§5.6); these checks narrow it, and it only ever comes from someone
 * whose chat you accepted.
 */

/** The part name a voice message is sealed as: bound into the seal and the signature. */
export const VOICE_PART = 'voice' as const;
/** The sound's type, as the node stores it beside the sealed part (DESIGN §5.2: AAC in .m4a). */
export const VOICE_MIME = 'audio/mp4';
/** The longest voice message, in milliseconds: 3:00. The recorder stops by itself there (DESIGN §5.3). */
export const VOICE_MAX_MS = 180_000;
/** Waveform bars in a voice part's header, each 0 to 255. */
export const VOICE_BARS = 48;
/**
 * The largest sealed voice part, in characters of its base64 `data` as sent (what the node counts, as GROUP_PHOTO_MAX_BYTES
 * counts a group photo): 1.15 MB. 3:00 at 32 kbps is 720,000 bytes of sound, 960,000 characters sealed; this leaves room
 * for the container and an encoder that runs a little over its rate (about 862,000 bytes of sound).
 */
export const VOICE_SEALED_MAX_BYTES = 1_150_000;
/** The first byte of a voice part, inside the seal. */
export const VOICE_PART_VERSION = 1;
/**
 * Days the community's server keeps a voice message's sealed part (DESIGN §5.4). Then the server deletes it there and keeps
 * the line, so the chat still shows the bubble; a phone that has the sound keeps playing it, and the node answers the part's
 * read with 410 and code VOICE_EXPIRED_CODE, which the apps show as "no longer on the server".
 */
export const VOICE_SERVER_KEEP_DAYS = 30;
/** The code a voice part's read answers with once the server no longer keeps it (VOICE_SERVER_KEEP_DAYS). */
export const VOICE_EXPIRED_CODE = 'voice_expired';

/** Bytes before the sound: version, length, bar count, bars. */
const VOICE_HEADER_BYTES = 1 + 4 + 1 + VOICE_BARS;
/**
 * The fewest bytes a seal adds around a voice part: a group line's (its format, the signature, the after's length, the
 * AEAD tag: 1 + 64 + 1 + 16). A direct line's adds more (its format, the signature, the time, the frame, the tag: 107).
 */
const VOICE_SEAL_MIN_OVERHEAD = 1 + 64 + 1 + 16;

/** Characters of base64 that `bytes` bytes become. */
function base64Length(bytes: number): number {
    return Math.ceil(bytes / 3) * 4;
}

/**
 * The most sound one voice part may carry, in bytes of .m4a: the most that could still come to VOICE_SEALED_MAX_BYTES of
 * base64 once sealed, in the smallest seal (a group line's, with no after). 862,364 bytes. A recorder stopping at 3:00 at
 * 32 kbps writes about 720,000.
 */
export const VOICE_SOUND_MAX_BYTES = Math.floor(VOICE_SEALED_MAX_BYTES / 4) * 3 - VOICE_SEAL_MIN_OVERHEAD - VOICE_HEADER_BYTES;
/** The smallest `ftyp` box: its size and type, a major brand and a minor version. */
const FTYP_MIN_BYTES = 16;

/**
 * Why a voice part was refused. Every one is "This voice message can't be played" to a member; the reason is for the
 * apps' logs and tests.
 *   'too-big':      over VOICE_SEALED_MAX_BYTES as sent; not opened.
 *   'not-verified': it didn't open as a voice part under these keys, this message and this sender, or its sender didn't
 *                   sign it (a photo, words, another message's part, another epoch's or group's key, a changed byte).
 *   'version':      a version this code doesn't read.
 *   'header':       the header isn't VOICE_BARS bars of 0 to 255 and a length of at least 1 ms.
 *   'too-long':     longer than VOICE_MAX_MS.
 *   'not-m4a':      the sound doesn't start with an ISO-BMFF `ftyp` box.
 */
export type VoiceRefusal = 'too-big' | 'not-verified' | 'version' | 'header' | 'too-long' | 'not-m4a';

/** Thrown when a voice part is refused, opening it or sealing it. */
export class VoiceRefusedError extends Error {
    readonly reason: VoiceRefusal;
    constructor(reason: VoiceRefusal) {
        super(`Voice part refused: ${reason}`);
        this.name = 'VoiceRefusedError';
        this.reason = reason;
    }
}

/** A voice message as the recorder gives it, to be sealed. */
export interface VoiceInput {
    /** Its length in milliseconds, 1 to VOICE_MAX_MS. */
    durationMs: number;
    /** The waveform: exactly VOICE_BARS whole numbers, 0 to 255 each. */
    bars: ArrayLike<number>;
    /** The .m4a file's bytes. */
    sound: Uint8Array;
}

/** A voice part that opened and passed every check. */
export interface VoicePart {
    durationMs: number;
    /** VOICE_BARS whole numbers, 0 to 255 each. */
    bars: number[];
    /** The .m4a file's bytes. */
    sound: Uint8Array;
}

/**
 * True when `sound` starts with an ISO-BMFF `ftyp` box (the head of an .m4a file): a 32-bit size of at least 16 and a
 * whole number of 4-byte brands, the type `ftyp`, and more of the file after it.
 */
export function looksLikeM4a(sound: unknown): boolean {
    if (!(sound instanceof Uint8Array) || sound.length < FTYP_MIN_BYTES) return false;
    const size = ((sound[0] << 24) >>> 0) + (sound[1] << 16) + (sound[2] << 8) + sound[3];
    if (size < FTYP_MIN_BYTES || size % 4 !== 0 || size >= sound.length) return false;
    return sound[4] === 0x66 && sound[5] === 0x74 && sound[6] === 0x79 && sound[7] === 0x70; // 'ftyp'
}

function checkLength(durationMs: unknown): number {
    if (typeof durationMs !== 'number' || !Number.isSafeInteger(durationMs) || durationMs < 1) throw new VoiceRefusedError('header');
    if (durationMs > VOICE_MAX_MS) throw new VoiceRefusedError('too-long');
    return durationMs;
}

/**
 * A voice part's bytes, [version][length][bar count][bars][sound], from what the recorder gives. Refuses (VoiceRefusedError)
 * a length outside 1 to VOICE_MAX_MS, anything but VOICE_BARS whole bars of 0 to 255, a sound that isn't an .m4a, and a
 * part that could never fit under VOICE_SEALED_MAX_BYTES of base64 once sealed (over VOICE_SOUND_MAX_BYTES of sound).
 */
export function voicePartBytes(voice: VoiceInput): Uint8Array {
    if (!voice || typeof voice !== 'object') throw new VoiceRefusedError('header');
    const durationMs = checkLength(voice.durationMs);
    const bars = voice.bars;
    if (!bars || typeof bars.length !== 'number' || bars.length !== VOICE_BARS) throw new VoiceRefusedError('header');
    for (let i = 0; i < VOICE_BARS; i++) {
        const b = bars[i];
        if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255) throw new VoiceRefusedError('header');
    }
    if (!looksLikeM4a(voice.sound)) throw new VoiceRefusedError('not-m4a');
    // The cap counts characters of base64 as sent: a part whose smallest seal would come to more is refused here, before
    // anything is sealed. The sealing functions check the sealed part itself, which a direct line's longer seal or a long
    // `after` can still take over the cap by a few hundred characters.
    if (base64Length(VOICE_HEADER_BYTES + voice.sound.length + VOICE_SEAL_MIN_OVERHEAD) > VOICE_SEALED_MAX_BYTES) {
        throw new VoiceRefusedError('too-big');
    }
    const out = new Uint8Array(VOICE_HEADER_BYTES + voice.sound.length);
    out[0] = VOICE_PART_VERSION;
    out[1] = (durationMs >>> 24) & 0xff;
    out[2] = (durationMs >>> 16) & 0xff;
    out[3] = (durationMs >>> 8) & 0xff;
    out[4] = durationMs & 0xff;
    out[5] = VOICE_BARS;
    for (let i = 0; i < VOICE_BARS; i++) out[6 + i] = bars[i];
    out.set(voice.sound, VOICE_HEADER_BYTES);
    return out;
}

/**
 * Read a voice part's bytes, as they came out of the seal, and check them: the version, the header's shape, the length,
 * the `ftyp` box. Throws VoiceRefusedError with the first reason that applies.
 */
export function readVoicePart(bytes: Uint8Array): VoicePart {
    if (!(bytes instanceof Uint8Array) || bytes.length < 1) throw new VoiceRefusedError('header');
    if (bytes[0] !== VOICE_PART_VERSION) throw new VoiceRefusedError('version');
    if (bytes.length < VOICE_HEADER_BYTES || bytes[5] !== VOICE_BARS) throw new VoiceRefusedError('header');
    const durationMs = checkLength(((bytes[1] << 24) >>> 0) + (bytes[2] << 16) + (bytes[3] << 8) + bytes[4]);
    const sound = bytes.slice(VOICE_HEADER_BYTES);
    if (!looksLikeM4a(sound)) throw new VoiceRefusedError('not-m4a');
    return { durationMs, bars: Array.from(bytes.subarray(6, VOICE_HEADER_BYTES)), sound };
}

/**
 * True when a sealed voice part, as sent (the base64 `data` of its attachment), is over VOICE_SEALED_MAX_BYTES: refused
 * before anything is opened, by the apps here and by the node.
 */
export function voiceSealedTooBig(ciphertext: string): boolean {
    return ciphertext.length > VOICE_SEALED_MAX_BYTES;
}

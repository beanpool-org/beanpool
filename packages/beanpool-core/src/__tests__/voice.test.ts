import { describe, it, expect } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import * as dm from '../dm-crypto.js';
import {
    newDmMessageId, openDmLine, openDmVoice, sealDmLine, sealDmVoice, dmLineSigVerifies, DmLineNotVerifiedError,
} from '../dm-crypto.js';
import {
    groupLineAad, groupMessageKey, openGroupLine, openGroupLineWithMessageKey, openGroupVoice, openGroupVoiceWithMessageKey,
    sealGroupLine, sealGroupVoice, GroupLineNotVerifiedError, GROUP_NONCE_PREFIX,
} from '../group-crypto.js';
import {
    looksLikeM4a, readVoicePart, voicePartBytes, voiceSealedTooBig, VoiceRefusedError,
    VOICE_BARS, VOICE_MAX_MS, VOICE_MIME, VOICE_PART, VOICE_PART_VERSION, VOICE_SEALED_MAX_BYTES, VOICE_SERVER_KEEP_DAYS,
    VOICE_SOUND_MAX_BYTES, type VoiceRefusal,
} from '../voice.js';
import * as barrel from '../index.js';
import { checkVoiceVectors, VOICE_VECTOR_SOUND, VOICE_DM_VECTOR, VOICE_GROUP_VECTOR } from '../voice-vectors.js';

// Voice messages, slice V1 (scratch/fable-design/DESIGN-cross-chat-voice-fable.md §5.4, §11 V1): a part named `voice`, sealed
// as bytes under the keys a photo uses, its header (length, 48 bars) inside the seal, and the checks a reader makes before
// anything reaches a player.

function person(name: string) {
    const seed = sha256(utf8ToBytes(`voice.test ${name}`));
    return { seedHex: bytesToHex(seed), publicKey: bytesToHex(ed25519.getPublicKey(seed)) };
}
type Person = ReturnType<typeof person>;
const ana = person('Ana');
const ben = person('Ben');
const cat = person('Cat');
const CONV = 'c0ffee00-1111-4222-8333-444455556666';
const ctxOf = (me: Person, peer: Person, conversationId = CONV) => ({ myEdPrivHex: me.seedHex, peerEdPubHex: peer.publicKey, conversationId });
const keysOf = (me: Person, peer: Person) => ({ myEdPrivHex: me.seedHex, peerEdPubHex: peer.publicKey });
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** An ISO-BMFF box: [size, 4 bytes big-endian][type][body]. */
function box(type: string, body: Uint8Array): Uint8Array {
    const size = 8 + body.length;
    return concatBytes(new Uint8Array([size >>> 24, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff]), utf8ToBytes(type), body);
}
/** The head of an .m4a as an iPhone writes it: `ftyp` M4A, then an `mdat` box. Not playable: core checks the head only. */
function m4a(soundBytes = 64): Uint8Array {
    return concatBytes(box('ftyp', concatBytes(utf8ToBytes('M4A '), new Uint8Array(4), utf8ToBytes('M4A mp42isom'))), box('mdat', new Uint8Array(soundBytes).fill(0x5a)));
}
const BARS = Array.from({ length: VOICE_BARS }, (_, i) => (i * 37) % 256);
const VOICE = { durationMs: 42_000, bars: BARS, sound: m4a() };

/** A voice part's bytes written by hand, so a sender who skips the checks can be played: each field can be set wrong. */
function rawPart(o: { version?: number; ms?: number; count?: number; bars?: number[]; sound?: Uint8Array } = {}): Uint8Array {
    const ms = o.ms ?? 42_000;
    const bars = o.bars ?? BARS;
    return concatBytes(
        new Uint8Array([o.version ?? 1, ms >>> 24, (ms >>> 16) & 0xff, (ms >>> 8) & 0xff, ms & 0xff, o.count ?? bars.length]),
        new Uint8Array(bars), o.sound ?? m4a(),
    );
}

function refusedFor(fn: () => unknown): VoiceRefusal | 'opened' | 'other' {
    try { fn(); } catch (e) { return e instanceof VoiceRefusedError ? e.reason : 'other'; }
    return 'opened';
}

/**
 * A direct chat's part sealed and signed by `from` from the primitives, as dm-crypto.ts would, with any bytes in it: what a
 * sender whose app skips the checks would send. With `signer` it is signed by another key than the one it names.
 */
function dmSealRaw(from: Person, to: Person, content: Uint8Array, id: string, part: dm.DmPart = 'voice', signer: Person = from): dm.DmPayload {
    const nonce = randomBytes(24);
    const nonceColumn = dm.DM_NONCE_PREFIX + b64(nonce);
    const at = '2026-11-13T09:00:00.000Z';
    const sealed = xchacha20poly1305(dm.deriveDmKey(ctxOf(signer, from === signer ? to : from)), nonce, dm.dmLineAad(CONV, { senderPubHex: from.publicKey, messageId: id, part }))
        .encrypt(concatBytes(new Uint8Array([4, 0]), content));
    const digest = dm.dmLineSigDigest(nonceColumn, sealed, { conversationId: CONV, senderPubHex: from.publicKey, recipientPubHex: to.publicKey, messageId: id, part, at });
    const sig = ed25519.sign(digest, hexToBytes(signer.seedHex));
    return { ciphertext: b64(concatBytes(new Uint8Array([4]), sig, utf8ToBytes(at), sealed)), nonce: nonceColumn };
}

const GROUP = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const groupKey = sha256(utf8ToBytes('voice.test group key epoch 3'));
const otherEpochKey = sha256(utf8ToBytes('voice.test group key epoch 2'));

/** A group line's voice part sealed and signed by `from` from the primitives, with any bytes in it. */
function groupSealRaw(from: Person, content: Uint8Array, id: string, key = groupKey, part: 'voice' | 'attachment' = 'voice') {
    const aad = groupLineAad({ groupId: GROUP, epoch: 3, senderPubHex: from.publicKey, messageId: id, part });
    const nonce = randomBytes(24);
    const unsigned = concatBytes(new Uint8Array([1, 0]), content);
    const sig = ed25519.sign(sha256(concatBytes(aad, nonce, unsigned)), hexToBytes(from.seedHex));
    const frame = concatBytes(new Uint8Array([1]), sig, unsigned.subarray(1));
    return { ciphertext: b64(xchacha20poly1305(groupMessageKey(key, id), nonce, aad).encrypt(frame)), nonce: GROUP_NONCE_PREFIX + b64(nonce) };
}
const gRef = (from: Person, messageId: string) => ({ groupId: GROUP, epoch: 3, senderPubHex: from.publicKey, messageId });
const gSeal = (from: Person, messageId: string, voice = VOICE) => sealGroupVoice(voice, { myEdPrivHex: from.seedHex, groupKey, groupId: GROUP, epoch: 3, messageId });

/** The payload with one byte of its ciphertext changed at `at`. */
function withByteChanged<T extends { ciphertext: string; nonce: string }>(p: T, at: number): T {
    const b = Buffer.from(p.ciphertext, 'base64');
    b[at] ^= 0x01;
    return { ...p, ciphertext: b.toString('base64') };
}
/** Where a DM part's sealed bytes start in its column: [4][signature 64][time 24]; then [4][after length 0] in the seal. */
const DM_SEALED_AT = 1 + 64 + 24;
const DM_PART_AT = DM_SEALED_AT + 2;
/** Where a group part's bytes start in its sealed frame: [1][signature 64][after length 0]. */
const GROUP_PART_AT = 1 + 64 + 1;

describe('the constants, in one place for the node and both apps', () => {
    it('cap 3:00, 48 bars, 1.15 MB sealed, audio/mp4, part `voice`, version 1, all from the core barrel', () => {
        expect(VOICE_MAX_MS).toBe(3 * 60 * 1000);
        expect(VOICE_BARS).toBe(48);
        expect(VOICE_SEALED_MAX_BYTES).toBe(1_150_000);
        expect(VOICE_MIME).toBe('audio/mp4');
        expect(VOICE_PART).toBe('voice');
        expect(VOICE_PART_VERSION).toBe(1);
        for (const name of [
            'VOICE_MAX_MS', 'VOICE_BARS', 'VOICE_SEALED_MAX_BYTES', 'VOICE_MIME', 'VOICE_PART', 'VOICE_PART_VERSION', 'VoiceRefusedError',
            'sealDmVoice', 'openDmVoice', 'sealGroupVoice', 'openGroupVoice', 'openGroupVoiceWithMessageKey', 'looksLikeM4a', 'voiceSealedTooBig',
        ]) expect(barrel, name).toHaveProperty(name);
    });
});

describe('the voice part itself', () => {
    it('is [version][length, 4 bytes big-endian][bar count][48 bars][the sound], and reads back as written', () => {
        const bytes = voicePartBytes(VOICE);
        expect(bytesToHex(bytes.subarray(0, 6))).toBe('01' + '0000a410' + '30');
        expect(Array.from(bytes.subarray(6, 54))).toEqual(BARS);
        expect(bytesToHex(bytes.subarray(54))).toBe(bytesToHex(VOICE.sound));
        expect(bytesToHex(rawPart())).toBe(bytesToHex(bytes));
        const back = readVoicePart(bytes);
        expect(back).toEqual({ durationMs: 42_000, bars: BARS, sound: VOICE.sound });
    });

    it('an .m4a is a sound that starts with an ISO-BMFF `ftyp` box and has more after it', () => {
        expect(looksLikeM4a(m4a())).toBe(true);
        expect(looksLikeM4a(utf8ToBytes('OggS\0\x02 an Ogg page, not an m4a'))).toBe(false);
        expect(looksLikeM4a(utf8ToBytes('ID3\x04 an mp3 with a tag'))).toBe(false);
        expect(looksLikeM4a(utf8ToBytes('data:audio/mp4;base64,AAAAHGZ0eXBNNEEg'))).toBe(false);
        const ftypOnly = box('ftyp', concatBytes(utf8ToBytes('M4A '), new Uint8Array(4)));
        expect(looksLikeM4a(ftypOnly)).toBe(false);
        const badSize = m4a();
        badSize[3] = 0x1d; // not a whole number of brands
        expect(looksLikeM4a(badSize)).toBe(false);
        const tiny = m4a();
        tiny.set([0, 0, 0, 8], 0); // a box too small to hold a brand
        expect(looksLikeM4a(tiny)).toBe(false);
        expect(looksLikeM4a(new Uint8Array(0))).toBe(false);
    });

    it('a sender\'s app refuses to seal a length over 3:00 or under 1 ms, bars that aren\'t 48 bytes, or a sound that isn\'t an .m4a', () => {
        expect(refusedFor(() => voicePartBytes({ ...VOICE, durationMs: VOICE_MAX_MS }))).toBe('opened');
        expect(refusedFor(() => voicePartBytes({ ...VOICE, durationMs: VOICE_MAX_MS + 1 }))).toBe('too-long');
        expect(refusedFor(() => voicePartBytes({ ...VOICE, durationMs: 0 }))).toBe('header');
        expect(refusedFor(() => voicePartBytes({ ...VOICE, durationMs: 1.5 }))).toBe('header');
        expect(refusedFor(() => voicePartBytes({ ...VOICE, durationMs: Number.NaN }))).toBe('header');
        expect(refusedFor(() => voicePartBytes({ ...VOICE, bars: BARS.slice(1) }))).toBe('header');
        expect(refusedFor(() => voicePartBytes({ ...VOICE, bars: [...BARS, 0] }))).toBe('header');
        expect(refusedFor(() => voicePartBytes({ ...VOICE, bars: [...BARS.slice(1), 256] }))).toBe('header');
        expect(refusedFor(() => voicePartBytes({ ...VOICE, bars: [...BARS.slice(1), -1] }))).toBe('header');
        expect(refusedFor(() => voicePartBytes({ ...VOICE, bars: [...BARS.slice(1), 0.5] }))).toBe('header');
        expect(refusedFor(() => voicePartBytes({ ...VOICE, bars: new Uint8Array(BARS) }))).toBe('opened');
        expect(refusedFor(() => voicePartBytes({ ...VOICE, sound: utf8ToBytes('OggS not an m4a, padded out to length') }))).toBe('not-m4a');
    });

    it('a reader refuses a version it doesn\'t read, a header of the wrong shape, over 3:00, and a sound that isn\'t an .m4a', () => {
        expect(refusedFor(() => readVoicePart(rawPart()))).toBe('opened');
        expect(refusedFor(() => readVoicePart(rawPart({ version: 2 })))).toBe('version');
        expect(refusedFor(() => readVoicePart(rawPart({ version: 0 })))).toBe('version');
        expect(refusedFor(() => readVoicePart(rawPart({ ms: VOICE_MAX_MS + 1 })))).toBe('too-long');
        expect(refusedFor(() => readVoicePart(rawPart({ ms: 0xffffffff })))).toBe('too-long');
        expect(refusedFor(() => readVoicePart(rawPart({ ms: 0 })))).toBe('header');
        expect(refusedFor(() => readVoicePart(rawPart({ bars: BARS.slice(1) })))).toBe('header');
        expect(refusedFor(() => readVoicePart(rawPart({ bars: [...BARS, 7] })))).toBe('header');
        // The bar count says 48 but 47 bars came: the sound starts a byte early and isn't an .m4a.
        expect(refusedFor(() => readVoicePart(rawPart({ bars: BARS.slice(1), count: 48 })))).toBe('not-m4a');
        expect(refusedFor(() => readVoicePart(rawPart({ sound: utf8ToBytes('OggS not an m4a, padded out to length') })))).toBe('not-m4a');
        expect(refusedFor(() => readVoicePart(rawPart().subarray(0, 30)))).toBe('header');
        expect(refusedFor(() => readVoicePart(new Uint8Array(0)))).toBe('header');
    });
});

describe('a direct chat\'s voice message', () => {
    it('round trip: Ana seals it under the chat\'s key; she and Ben open it, length, bars and sound as recorded', () => {
        const id = newDmMessageId();
        const sealed = sealDmVoice(VOICE, ctxOf(ana, ben), { senderPubHex: ana.publicKey, messageId: id });
        for (const [me, peer] of [[ana, ben], [ben, ana]] as const) {
            const opened = openDmVoice(sealed, keysOf(me, peer), { conversationId: CONV, senderPubHex: ana.publicKey, messageId: id });
            expect(opened.durationMs).toBe(42_000);
            expect(opened.bars).toEqual(BARS);
            expect(bytesToHex(opened.sound)).toBe(bytesToHex(VOICE.sound));
            expect(opened).toMatchObject({ format: 4, after: null, conversationId: CONV, moved: false });
        }
        // The node checks who signed it without a key, as for every part (V2's refusal of a readable or unsigned one).
        expect(dmLineSigVerifies(sealed, { conversationId: CONV, senderPubHex: ana.publicKey, recipientPubHex: ben.publicKey, messageId: id, part: 'voice' })).toBe(true);
        expect(dmLineSigVerifies(sealed, { conversationId: CONV, senderPubHex: ana.publicKey, recipientPubHex: ben.publicKey, messageId: id, part: 'attachment' })).toBe(false);
    });

    it('is sealed as bytes: the node sees no header and no sound, and it goes a quarter smaller than the sound as a photo\'s data URI would', () => {
        const id = newDmMessageId();
        const sound = m4a(30_000);
        const sealed = sealDmVoice({ ...VOICE, sound }, ctxOf(ana, ben), { senderPubHex: ana.publicKey, messageId: id });
        const column = Buffer.from(sealed.ciphertext, 'base64');
        expect(column.length).toBe(DM_PART_AT + 54 + sound.length + 16);
        expect(column.includes(Buffer.from('ftyp'))).toBe(false);
        expect(column.includes(Buffer.from(BARS))).toBe(false);
        const asDataUri = sealDmLine(`data:${VOICE_MIME};base64,${b64(sound)}`, ctxOf(ana, ben), { senderPubHex: ana.publicKey, messageId: id, part: 'attachment' });
        expect(sealed.ciphertext.length).toBeLessThan(asDataUri.ciphertext.length * 0.76);
    });

    it('a voice part never opens as a photo or as words', () => {
        const id = newDmMessageId();
        const sealed = sealDmVoice(VOICE, ctxOf(ana, ben), { senderPubHex: ana.publicKey, messageId: id });
        for (const part of ['attachment', 'body', 'about', 'voice'] as const) {
            expect(() => openDmLine(sealed, keysOf(ben, ana), { conversationId: CONV, senderPubHex: ana.publicKey, messageId: id, part }), part)
                .toThrow(DmLineNotVerifiedError);
        }
    });

    it('a photo, or words, never open as a voice part, even when the bytes inside are a voice part', () => {
        const id = newDmMessageId();
        const ref = { conversationId: CONV, senderPubHex: ana.publicKey, messageId: id };
        const photo = sealDmLine('data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==', ctxOf(ana, ben), { senderPubHex: ana.publicKey, messageId: id, part: 'attachment' });
        const words = sealDmLine('hello', ctxOf(ana, ben), { senderPubHex: ana.publicKey, messageId: id });
        expect(refusedFor(() => openDmVoice(photo, keysOf(ben, ana), ref))).toBe('not-verified');
        expect(refusedFor(() => openDmVoice(words, keysOf(ben, ana), ref))).toBe('not-verified');
        // A sender's own photo part carrying a perfect voice part's bytes: sealed as the attachment, so it isn't a voice part.
        const asPhoto = dmSealRaw(ana, ben, rawPart(), id, 'attachment');
        expect(openDmLine(asPhoto, keysOf(ben, ana), { ...ref, part: 'attachment' }).text.length).toBeGreaterThan(0);
        expect(refusedFor(() => openDmVoice(asPhoto, keysOf(ben, ana), ref))).toBe('not-verified');
        // And the control: the same bytes sealed as the voice part open.
        expect(refusedFor(() => openDmVoice(dmSealRaw(ana, ben, rawPart(), id), keysOf(ben, ana), ref))).toBe('opened');
    });

    it('words can\'t be sealed as the voice part: the voice part is sealed by sealDmVoice only', () => {
        expect(() => sealDmLine('hello', ctxOf(ana, ben), { senderPubHex: ana.publicKey, messageId: newDmMessageId(), part: 'voice' })).toThrow();
    });

    it('bound to its sender, message, conversation and pair; a changed header byte or signature refuses', () => {
        const id = newDmMessageId();
        const sealed = sealDmVoice(VOICE, ctxOf(ana, ben), { senderPubHex: ana.publicKey, messageId: id });
        const ref = { conversationId: CONV, senderPubHex: ana.publicKey, messageId: id };
        expect(refusedFor(() => openDmVoice(sealed, keysOf(ben, ana), { ...ref, senderPubHex: ben.publicKey }))).toBe('not-verified');
        expect(refusedFor(() => openDmVoice(sealed, keysOf(ben, ana), { ...ref, messageId: newDmMessageId() }))).toBe('not-verified');
        expect(refusedFor(() => openDmVoice(sealed, keysOf(ben, ana), { ...ref, conversationId: '00000000-0000-4000-8000-000000000000' }))).toBe('not-verified');
        expect(refusedFor(() => openDmVoice(sealed, keysOf(cat, ana), ref))).toBe('not-verified');
        // Inside the seal: the version, a length byte, the bar count, a bar, the first byte of the sound.
        for (const at of [0, 1, 4, 5, 6 + 20, 54]) {
            expect(refusedFor(() => openDmVoice(withByteChanged(sealed, DM_PART_AT + at), keysOf(ben, ana), ref)), `byte ${at}`).toBe('not-verified');
        }
        expect(refusedFor(() => openDmVoice(withByteChanged(sealed, 1), keysOf(ben, ana), ref))).toBe('not-verified');
        expect(refusedFor(() => openDmVoice(withByteChanged(sealed, 1 + 64 + 22), keysOf(ben, ana), ref))).toBe('not-verified');
        // Ben holds the chat's key too: a voice part he seals in Ana's name and signs himself is not hers.
        expect(refusedFor(() => openDmVoice(dmSealRaw(ana, ben, rawPart(), id, 'voice', ben), keysOf(ben, ana), ref))).toBe('not-verified');
        expect(refusedFor(() => openDmVoice(dmSealRaw(ana, ben, rawPart(), id, 'voice', ben), keysOf(ana, ben), ref))).toBe('not-verified');
    });

    it('a sender who skips the checks: a changed version, bar count or length, or a sound that isn\'t an .m4a, refuses', () => {
        const id = newDmMessageId();
        const ref = { conversationId: CONV, senderPubHex: ana.publicKey, messageId: id };
        const open = (content: Uint8Array) => refusedFor(() => openDmVoice(dmSealRaw(ana, ben, content, id), keysOf(ben, ana), ref));
        expect(open(rawPart())).toBe('opened');
        expect(open(rawPart({ version: 2 }))).toBe('version');
        expect(open(rawPart({ bars: BARS.slice(1) }))).toBe('header');
        expect(open(rawPart({ bars: [...BARS, 9] }))).toBe('header');
        expect(open(rawPart({ ms: VOICE_MAX_MS + 1 }))).toBe('too-long');
        expect(open(rawPart({ ms: VOICE_MAX_MS }))).toBe('opened');
        expect(open(rawPart({ sound: utf8ToBytes('OggS\0\x02 an Ogg Opus file, which the iPhone does not play') }))).toBe('not-m4a');
        expect(open(new Uint8Array(0))).toBe('header');
    });

    it('over 1.15 MB sealed is refused before it is opened, and an app won\'t seal one', () => {
        const id = newDmMessageId();
        const ref = { conversationId: CONV, senderPubHex: ana.publicKey, messageId: id };
        // The most sound that fits: 1,150,000 characters of base64 carry 862,500 bytes; less the column, the frame and the header.
        const fits = VOICE_SEALED_MAX_BYTES / 4 * 3 - DM_PART_AT - 54 - 16;
        const atCap = sealDmVoice({ ...VOICE, sound: m4a(fits - m4a(0).length) }, ctxOf(ana, ben), { senderPubHex: ana.publicKey, messageId: id });
        expect(atCap.ciphertext.length).toBe(VOICE_SEALED_MAX_BYTES);
        expect(voiceSealedTooBig(atCap.ciphertext)).toBe(false);
        expect(refusedFor(() => openDmVoice(atCap, keysOf(ben, ana), ref))).toBe('opened');
        expect(refusedFor(() => sealDmVoice({ ...VOICE, sound: m4a(fits - m4a(0).length + 1) }, ctxOf(ana, ben), { senderPubHex: ana.publicKey, messageId: id }))).toBe('too-big');
        expect(refusedFor(() => sealDmVoice({ ...VOICE, sound: m4a(2_000_000) }, ctxOf(ana, ben), { senderPubHex: ana.publicKey, messageId: id }))).toBe('too-big');
        // A sender who skips the check: one byte more of sound, sealed and signed, is refused unopened.
        const over = dmSealRaw(ana, ben, rawPart({ sound: m4a(fits - m4a(0).length + 1) }), id);
        expect(voiceSealedTooBig(over.ciphertext)).toBe(true);
        expect(refusedFor(() => openDmVoice(over, keysOf(ben, ana), ref))).toBe('too-big');
        expect(refusedFor(() => openDmVoice({ ...over, ciphertext: over.ciphertext + 'AAAA' }, keysOf(ben, ana), ref))).toBe('too-big');
    });

    it('the check before sealing counts the cap in base64 as sent, not in bytes of sound (the #3103 review, V2)', () => {
        // 1,150,000 characters carry 862,500 bytes; the smallest seal (a group line's, no after) adds 82 and the header 54.
        expect(VOICE_SOUND_MAX_BYTES).toBe(862_364);
        expect(VOICE_SERVER_KEEP_DAYS).toBe(30);
        const soundOf = (total: number) => m4a(total - m4a(0).length);
        expect(voicePartBytes({ ...VOICE, sound: soundOf(VOICE_SOUND_MAX_BYTES) }).length).toBe(54 + VOICE_SOUND_MAX_BYTES);
        expect(refusedFor(() => voicePartBytes({ ...VOICE, sound: soundOf(VOICE_SOUND_MAX_BYTES + 1) }))).toBe('too-big');
        // Between the most that fits and the cap read as bytes: once sealed before it was refused, now refused unsealed.
        expect(refusedFor(() => voicePartBytes({ ...VOICE, sound: soundOf(1_000_000) }))).toBe('too-big');
        expect(refusedFor(() => voicePartBytes({ ...VOICE, sound: soundOf(VOICE_SEALED_MAX_BYTES - 54) }))).toBe('too-big');
        // The most that fits, sealed as a group line with no after, is exactly at the cap.
        expect(gSeal(ana, newDmMessageId(), { ...VOICE, sound: soundOf(VOICE_SOUND_MAX_BYTES) }).ciphertext.length).toBe(VOICE_SEALED_MAX_BYTES);
    });

    it('an app refuses to seal what a reader would refuse', () => {
        const line = { senderPubHex: ana.publicKey, messageId: newDmMessageId() };
        expect(refusedFor(() => sealDmVoice({ ...VOICE, durationMs: VOICE_MAX_MS + 1 }, ctxOf(ana, ben), line))).toBe('too-long');
        expect(refusedFor(() => sealDmVoice({ ...VOICE, bars: BARS.slice(2) }, ctxOf(ana, ben), line))).toBe('header');
        expect(refusedFor(() => sealDmVoice({ ...VOICE, sound: utf8ToBytes('RIFF....WAVEfmt a wav file') }, ctxOf(ana, ben), line))).toBe('not-m4a');
        expect(() => sealDmVoice(VOICE, ctxOf(ana, ben), { ...line, senderPubHex: ben.publicKey })).toThrow();
    });

    it('a reply and a line written after another are bound as a photo\'s are', () => {
        const id = newDmMessageId();
        const answered = newDmMessageId();
        const sealed = sealDmVoice(VOICE, ctxOf(ana, ben), { senderPubHex: ana.publicKey, messageId: id, replyToId: answered, after: answered });
        const ref = { conversationId: CONV, senderPubHex: ana.publicKey, messageId: id, metadata: JSON.stringify({ replyToId: answered }) };
        expect(openDmVoice(sealed, keysOf(ben, ana), ref).after).toBe(answered);
        expect(refusedFor(() => openDmVoice(sealed, keysOf(ben, ana), { ...ref, metadata: null }))).toBe('not-verified');
        expect(refusedFor(() => openDmVoice(sealed, keysOf(ben, ana), { ...ref, metadata: JSON.stringify({ replyToId: newDmMessageId() }) }))).toBe('not-verified');
    });
});

describe('a group line\'s voice message', () => {
    it('round trip: sealed under its message\'s own key, opened by another member with the epoch key or that message key', () => {
        const id = newDmMessageId();
        const sealed = gSeal(ana, id);
        for (const opened of [
            openGroupVoice(sealed, gRef(ana, id), groupKey),
            openGroupVoiceWithMessageKey(sealed, gRef(ana, id), groupMessageKey(groupKey, id)),
        ]) {
            expect(opened.durationMs).toBe(42_000);
            expect(opened.bars).toEqual(BARS);
            expect(bytesToHex(opened.sound)).toBe(bytesToHex(VOICE.sound));
            expect(opened.after).toBeNull();
        }
    });

    it('opens only under its own message key: not another message\'s, not the epoch key itself, not another epoch\'s', () => {
        const id = newDmMessageId();
        const sealed = gSeal(ana, id);
        expect(refusedFor(() => openGroupVoiceWithMessageKey(sealed, gRef(ana, id), groupMessageKey(groupKey, newDmMessageId())))).toBe('not-verified');
        expect(refusedFor(() => openGroupVoiceWithMessageKey(sealed, gRef(ana, id), groupKey))).toBe('not-verified');
        expect(refusedFor(() => openGroupVoice(sealed, gRef(ana, id), otherEpochKey))).toBe('not-verified');
        expect(refusedFor(() => openGroupVoice(sealed, { ...gRef(ana, id), epoch: 2 }, groupKey))).toBe('not-verified');
        expect(refusedFor(() => openGroupVoice(sealed, { ...gRef(ana, id), groupId: '00000000-0000-4000-8000-000000000000' }, groupKey))).toBe('not-verified');
        expect(refusedFor(() => openGroupVoice(sealed, { ...gRef(ana, id), messageId: newDmMessageId() }, groupKey))).toBe('not-verified');
        expect(refusedFor(() => openGroupVoice(sealed, gRef(ben, id), groupKey))).toBe('not-verified');
    });

    it('a voice part never opens as a photo or as words; a photo or words never open as a voice part', () => {
        const id = newDmMessageId();
        const sealed = gSeal(ana, id);
        for (const part of ['attachment', 'body', 'edit', 'voice'] as const) {
            expect(() => openGroupLine(sealed, { ...gRef(ana, id), part }, groupKey), part).toThrow(GroupLineNotVerifiedError);
            // Nor with the one message key a reporter hands a moderator (the node's report check opens with it).
            expect(() => openGroupLineWithMessageKey(sealed, { ...gRef(ana, id), part }, groupMessageKey(groupKey, id)), part).toThrow(GroupLineNotVerifiedError);
        }
        const bind ={ myEdPrivHex: ana.seedHex, groupKey, groupId: GROUP, epoch: 3, messageId: id };
        const photo = sealGroupLine('data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==', { ...bind, part: 'attachment' });
        const words = sealGroupLine('hello', bind);
        expect(refusedFor(() => openGroupVoice(photo, gRef(ana, id), groupKey))).toBe('not-verified');
        expect(refusedFor(() => openGroupVoice(words, gRef(ana, id), groupKey))).toBe('not-verified');
        const asPhoto = groupSealRaw(ana, rawPart(), id, groupKey, 'attachment');
        expect(openGroupLine(asPhoto, { ...gRef(ana, id), part: 'attachment' }, groupKey).text.length).toBeGreaterThan(0);
        expect(refusedFor(() => openGroupVoice(asPhoto, gRef(ana, id), groupKey))).toBe('not-verified');
        expect(refusedFor(() => openGroupVoice(groupSealRaw(ana, rawPart(), id), gRef(ana, id), groupKey))).toBe('opened');
        expect(() => sealGroupLine('hello', { ...bind, part: 'voice' })).toThrow();
    });

    it('a changed header byte or signature refuses; so does a member who seals in another\'s name', () => {
        const id = newDmMessageId();
        const sealed = gSeal(ana, id);
        for (const at of [0, 1, 4, 5, 6 + 20, 54]) {
            expect(refusedFor(() => openGroupVoice(withByteChanged(sealed, GROUP_PART_AT + at), gRef(ana, id), groupKey)), `byte ${at}`).toBe('not-verified');
        }
        expect(refusedFor(() => openGroupVoice(withByteChanged(sealed, 1), gRef(ana, id), groupKey))).toBe('not-verified');
        // Every member holds the epoch key: Ben seals a voice part naming Ana, signed with his own key.
        const aad = groupLineAad({ ...gRef(ana, id), part: 'voice' });
        const nonce = randomBytes(24);
        const unsigned = concatBytes(new Uint8Array([1, 0]), rawPart());
        const sig = ed25519.sign(sha256(concatBytes(aad, nonce, unsigned)), hexToBytes(ben.seedHex));
        const forged = {
            ciphertext: b64(xchacha20poly1305(groupMessageKey(groupKey, id), nonce, aad).encrypt(concatBytes(new Uint8Array([1]), sig, unsigned.subarray(1)))),
            nonce: GROUP_NONCE_PREFIX + b64(nonce),
        };
        expect(refusedFor(() => openGroupVoice(forged, gRef(ana, id), groupKey))).toBe('not-verified');
    });

    it('a sender who skips the checks: a changed version, bar count or length, or a sound that isn\'t an .m4a, refuses', () => {
        const id = newDmMessageId();
        const open = (content: Uint8Array) => refusedFor(() => openGroupVoice(groupSealRaw(ana, content, id), gRef(ana, id), groupKey));
        expect(open(rawPart())).toBe('opened');
        expect(open(rawPart({ version: 2 }))).toBe('version');
        expect(open(rawPart({ bars: BARS.slice(1) }))).toBe('header');
        expect(open(rawPart({ ms: VOICE_MAX_MS + 1 }))).toBe('too-long');
        expect(open(rawPart({ sound: utf8ToBytes('OggS\0\x02 an Ogg Opus file, which the iPhone does not play') }))).toBe('not-m4a');
    });

    it('over 1.15 MB sealed is refused before it is opened, and an app won\'t seal one', () => {
        const id = newDmMessageId();
        // A group line's sealed bytes: [1][signature 64][after length], the part, the AEAD tag.
        const fits = VOICE_SEALED_MAX_BYTES / 4 * 3 - GROUP_PART_AT - 54 - 16;
        const atCap = gSeal(ana, id, { ...VOICE, sound: m4a(fits - m4a(0).length) });
        expect(atCap.ciphertext.length).toBe(VOICE_SEALED_MAX_BYTES);
        expect(refusedFor(() => openGroupVoice(atCap, gRef(ana, id), groupKey))).toBe('opened');
        expect(refusedFor(() => gSeal(ana, id, { ...VOICE, sound: m4a(fits - m4a(0).length + 1) }))).toBe('too-big');
        const over = groupSealRaw(ana, rawPart({ sound: m4a(fits - m4a(0).length + 1) }), id);
        expect(refusedFor(() => openGroupVoice(over, gRef(ana, id), groupKey))).toBe('too-big');
    });

    it('an app refuses to seal what a reader would refuse', () => {
        const id = newDmMessageId();
        expect(refusedFor(() => gSeal(ana, id, { ...VOICE, durationMs: VOICE_MAX_MS + 1 }))).toBe('too-long');
        expect(refusedFor(() => gSeal(ana, id, { ...VOICE, bars: [...BARS, 1] }))).toBe('header');
        expect(refusedFor(() => gSeal(ana, id, { ...VOICE, sound: new Uint8Array(100) }))).toBe('not-m4a');
    });
});

describe('the frozen voice vectors', () => {
    it('seal and open the same bytes, and refuse every changed binding and the other parts', () => {
        expect(() => checkVoiceVectors({
            sealDmVoice, openDmVoice, openDmLine, sealGroupVoice, openGroupVoice, openGroupVoiceWithMessageKey, openGroupLine, groupMessageKey,
        })).not.toThrow();
    });

    it('the direct vector is what voice.ts says it is, re-derived from the primitives without voice.ts or dm-crypto.ts', () => {
        const v = VOICE_DM_VECTOR;
        const p = (name: string) => sha256(utf8ToBytes(`beanpool dm-line vector: ${name}`));
        const anaSeed = p('Ana');
        const benPub = ed25519.getPublicKey(p('Ben'));
        const anaPub = bytesToHex(ed25519.getPublicKey(anaSeed));
        const column = Buffer.from(v.payload.ciphertext, 'base64');
        const nonce = new Uint8Array(Buffer.from(v.payload.nonce.slice('x25519-xc20p-v2:'.length), 'base64'));
        expect(column[0]).toBe(4);
        expect(column.subarray(65, 89).toString('utf8')).toBe(v.at);
        const sealed = new Uint8Array(column.subarray(89));
        // The key: X25519 of the two identities, HKDF-SHA256 salted with the conversation, info 'beanpool-dm-v2'.
        const shared = x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(anaSeed), ed25519.utils.toMontgomery(benPub));
        const key = hkdf(sha256, shared, utf8ToBytes(v.conversationId), utf8ToBytes('beanpool-dm-v2'), 32);
        const aad = utf8ToBytes(JSON.stringify(['beanpool-dm-line/4', v.conversationId, anaPub, v.messageId, 'voice']));
        const pt = xchacha20poly1305(key, nonce, aad).decrypt(sealed);
        expect(Array.from(pt.subarray(0, 2))).toEqual([4, 0]);
        expect(pt[2]).toBe(1);
        expect(new DataView(pt.buffer, pt.byteOffset + 3, 4).getUint32(0)).toBe(v.durationMs);
        expect(pt[7]).toBe(48);
        expect(Array.from(pt.subarray(8, 56))).toEqual(v.bars);
        expect(bytesToHex(pt.subarray(56))).toBe(bytesToHex(VOICE_VECTOR_SOUND));
        const digest = sha256(utf8ToBytes(JSON.stringify([
            'beanpool-dm-line-sig/2', v.conversationId, anaPub, bytesToHex(benPub), v.messageId, 'voice', v.at, v.payload.nonce, bytesToHex(sha256(sealed)),
        ])));
        expect(ed25519.verify(new Uint8Array(column.subarray(1, 65)), digest, hexToBytes(anaPub), { zip215: false })).toBe(true);
    });

    it('the group vector is what voice.ts says it is, re-derived from the primitives without voice.ts or group-crypto.ts', () => {
        const v = VOICE_GROUP_VECTOR;
        const seed = sha256(utf8ToBytes('beanpool group-line vector: Ana'));
        const pub = bytesToHex(ed25519.getPublicKey(seed));
        const mk = hkdfMessageKey(v.groupKey, v.messageId);
        const aad = utf8ToBytes(JSON.stringify(['beanpool-group-line/1', v.groupId, String(v.epoch), pub, v.messageId, 'voice']));
        const nonce = new Uint8Array(Buffer.from(v.payload.nonce.slice('group-xc20p-v1:'.length), 'base64'));
        const frame = xchacha20poly1305(mk, nonce, aad).decrypt(new Uint8Array(Buffer.from(v.payload.ciphertext, 'base64')));
        expect(frame[0]).toBe(1);
        const sig = frame.subarray(1, 65);
        const unsigned = concatBytes(frame.subarray(0, 1), frame.subarray(65));
        expect(unsigned[1]).toBe(0);
        expect(ed25519.verify(sig, sha256(concatBytes(aad, nonce, unsigned)), hexToBytes(pub), { zip215: false })).toBe(true);
        const part = unsigned.subarray(2);
        expect(part[0]).toBe(1);
        expect(new DataView(part.buffer, part.byteOffset + 1, 4).getUint32(0)).toBe(v.durationMs);
        expect(part[5]).toBe(48);
        expect(Array.from(part.subarray(6, 54))).toEqual(v.bars);
        expect(bytesToHex(part.subarray(54))).toBe(bytesToHex(VOICE_VECTOR_SOUND));
    });
});

/** HKDF-SHA256(epoch key, salt = message id, info 'beanpool-group-line/1'), from the primitive. */
function hkdfMessageKey(groupKey: Uint8Array, messageId: string): Uint8Array {
    return hkdf(sha256, groupKey, utf8ToBytes(messageId), utf8ToBytes('beanpool-group-line/1'), 32);
}

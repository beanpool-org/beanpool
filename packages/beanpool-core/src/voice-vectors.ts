/**
 * Fixed voice-message vectors (DESIGN-cross-chat-voice-fable.md §11 V1), and the checks that run them: for core's vitest
 * suite now, and for the native app's runner and the PWA's when V3 and V4 wire them in, each handing in ITS OWN crypto
 * module, so all three prove the same voice part seals and opens the same way.
 *
 * Frozen from the first release that sends a voice message (none yet). Until then, a design change regenerates these in
 * the PR that makes it, and says so here. Once a release sends voice messages, a change that stops either of them matching
 * or opening has broken every voice message already sent: fix the change.
 *
 * Kept out of the main index (import `@beanpool/core/voice-vectors`) so no app bundle carries it. The checks throw a plain
 * Error and depend on no test framework.
 *
 * How they were made: the direct one by Ana to Ben with the direct-message vectors' people and conversation
 * (dm-line-vectors.ts), its nonce the first 24 bytes of SHA-256("beanpool voice vector: nonce 1"); the group one by the
 * group-line vectors' Ana (group-line-vectors.ts) in their group, epoch 3, under the epoch key SHA-256("beanpool voice
 * vector: group key"), its nonce from that file's fixed stream 'voice 1'. The sound is the head of an .m4a as an iPhone
 * writes one (an `ftyp` box, brand M4A) and a short `mdat` box: not playable, as core checks the head only. Both are
 * re-derived from the primitives, independently of voice.ts, dm-crypto.ts and group-crypto.ts, in core's voice.test.ts.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';
import { DM_VECTOR_CONVERSATION, DM_VECTOR_PEOPLE } from './dm-line-vectors.js';
import { GROUP_VECTOR_GROUP, GROUP_VECTOR_PEOPLE, groupVectorRandom } from './group-line-vectors.js';
import type { DmKeyContext, DmKeys, DmLineRef, DmPayload, OpenedDmLine, OpenedDmVoice, SealDmVoiceLine } from './dm-crypto.js';
import type {
    GroupCryptoRandom, GroupLineBinding, GroupLinePayload, GroupLineVerifyMemo, GroupVoiceBinding, OpenedGroupLine, OpenedGroupVoice, SealGroupVoiceInput,
} from './group-crypto.js';
import type { VoiceInput, VoiceRefusal } from './voice.js';

/** The sound both vectors carry: an `ftyp` box (M4A, minor 0, brands M4A mp42 isom) and an `mdat` box of 40 bytes. */
export const VOICE_VECTOR_SOUND: Uint8Array = new Uint8Array(Buffer.from(
    '0000001c667479704d344120000000004d3441206d70343269736f6d' + '000000306d646174' + '00112233445566778899aabbccddeeff'.repeat(2) + '0123456789abcdef',
    'hex',
));

const BARS = Array.from({ length: 48 }, (_, i) => (i * 53 + 11) % 256);

export interface VoiceDmVector {
    label: string;
    from: 'ana';
    conversationId: string;
    messageId: string;
    durationMs: number;
    bars: number[];
    nonce: Uint8Array;
    at: string;
    payload: DmPayload;
}

export const VOICE_DM_VECTOR: VoiceDmVector = {
    label: 'Ana\'s voice message to Ben, 0:42',
    from: 'ana', conversationId: DM_VECTOR_CONVERSATION, messageId: '4e3d2c1b-0a9f-4e8d-b7c6-a5b4c3d2e1f0',
    durationMs: 42_350, bars: BARS,
    nonce: sha256(utf8ToBytes('beanpool voice vector: nonce 1')).slice(0, 24), at: '2026-11-13T09:00:00.000Z',
    payload: {
        ciphertext: 'BJCXrZb2ha9JJP0eOXsbgUC8QYIMARmOzt7mNOj5SC2iaDGL3tuKnqIlvxAzuRbta/rbtoarv/TpRKcnLJEIawcyMDI2LTExLTEzVDA5OjAwOjAwLjAwMFpCQ9evJoCmhL6R1U2yvl7qXbMHEhkl5jZOgeMMSglva7d1HQ4kaZjLCHaboAKsmNExthbjP3cdmgFlqUGCDDcwumXPKj4HSlNEpdxl0RoiU+eBvB0pRLNloAx6+jkUmDndnA8JmYVtCS72Lwe8funivdiNlrmm675siwBN5jxYsR975fX9a7rowkKOMCbx4BUGjmcL',
        nonce: 'x25519-xc20p-v2:i5QwCoYXUMtqPrbjr3aHyifM+tYBz4Rr',
    },
};

export interface VoiceGroupVector {
    label: string;
    from: 'ana';
    groupId: string;
    epoch: number;
    groupKey: Uint8Array;
    messageId: string;
    durationMs: number;
    bars: number[];
    /** The fixed stream (group-line-vectors.ts groupVectorRandom) its nonce comes from. */
    stream: string;
    payload: GroupLinePayload;
}

export const VOICE_GROUP_VECTOR: VoiceGroupVector = {
    label: 'Ana\'s voice message to the group, 2:59.9',
    from: 'ana', groupId: GROUP_VECTOR_GROUP, epoch: 3, groupKey: sha256(utf8ToBytes('beanpool voice vector: group key')),
    messageId: '6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d', durationMs: 179_900, bars: BARS.slice().reverse(), stream: 'voice 1',
    payload: {
        ciphertext: '2aNLHhoSgnf91AF2jGNGyzS7CaI+c/i3GFu28tdjUQyfW5UarVZ9+P0WnXvkCAaIcn0z6aDK/qf6b89iN/zwXniBgAOF8APqvmJjNwfv39w2HZc7vjrE796Eev3pzWyvFHqiEzfsj7zk8eXomiFl9VhEdvpMGhZ3O2+N6aI/N0HRS1uei6GAYe7sSsL4mjaeoT1a9KDoz7VnnAZ0M+mUP4eW7bEf5MqCf9rTJKkrqynS8Cdu/nYokmMqOMtevwazuJWHjnBRTITjaeIkyNwKjMQE8+4=',
        nonce: 'group-xc20p-v1:JJjDQFyArW7gxfASJBLn65m4aZCUbnFK',
    },
};

/** The parts of an app's crypto module the vectors exercise. */
export interface VoiceVectorApi {
    sealDmVoice(voice: VoiceInput, ctx: DmKeyContext, line: SealDmVoiceLine, nonceForVectors?: Uint8Array): DmPayload;
    openDmVoice(payload: DmPayload, keys: DmKeys, line: Omit<DmLineRef, 'part'>): OpenedDmVoice;
    openDmLine(payload: DmPayload, keys: DmKeys, line: DmLineRef): OpenedDmLine;
    sealGroupVoice(voice: VoiceInput, input: SealGroupVoiceInput, opts?: GroupCryptoRandom): GroupLinePayload;
    openGroupVoice(payload: GroupLinePayload, ref: GroupVoiceBinding, groupKey: Uint8Array, memo?: GroupLineVerifyMemo): OpenedGroupVoice;
    openGroupVoiceWithMessageKey(payload: GroupLinePayload, ref: GroupVoiceBinding, messageKey: Uint8Array, memo?: GroupLineVerifyMemo): OpenedGroupVoice;
    openGroupLine(payload: GroupLinePayload, ref: GroupLineBinding, groupKey: Uint8Array, memo?: GroupLineVerifyMemo): OpenedGroupLine;
    groupMessageKey(groupKey: Uint8Array, messageId: string): Uint8Array;
}

function fail(msg: string): never {
    throw new Error(`voice vectors: ${msg}`);
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

function sameVoice(label: string, got: { durationMs: number; bars: number[]; sound: Uint8Array; after: string | null }, durationMs: number, bars: number[]): void {
    if (got.durationMs !== durationMs || got.bars.length !== bars.length || got.bars.some((b, i) => b !== bars[i])
        || hex(got.sound) !== hex(VOICE_VECTOR_SOUND) || got.after !== null) {
        fail(`${label}: opened as ${JSON.stringify({ durationMs: got.durationMs, bars: got.bars, sound: hex(got.sound), after: got.after })}`);
    }
}

/** `open` must refuse, with `reason` when it is a voice opener, with any error when it is a words or photo opener. */
function refused(label: string, what: string, open: () => unknown, reason?: VoiceRefusal): void {
    try {
        open();
    } catch (e) {
        if (reason && (e as { reason?: unknown })?.reason !== reason) fail(`${label}: ${what} was refused, but not as '${reason}' (${String(e)})`);
        return;
    }
    fail(`${label}: ${what} opened`);
}

/** One byte of a payload's ciphertext changed, at `at`. */
function withByteChanged<T extends { ciphertext: string; nonce: string }>(p: T, at: number): T {
    const b = Buffer.from(p.ciphertext, 'base64');
    b[at] ^= 0x01;
    return { ...p, ciphertext: b.toString('base64') };
}

/**
 * Seal each vector with its fixed randomness (the direct one with both key spellings) and compare; open it as each reader;
 * refuse it as a photo, as words, under another binding or key, and with a byte of its header or signature changed.
 */
export function checkVoiceVectors(api: VoiceVectorApi): void {
    // ── Direct ──
    const d = VOICE_DM_VECTOR;
    const ana = DM_VECTOR_PEOPLE.ana;
    const ben = DM_VECTOR_PEOPLE.ben;
    const voiceOf = (v: { durationMs: number; bars: number[] }): VoiceInput => ({ durationMs: v.durationMs, bars: v.bars, sound: VOICE_VECTOR_SOUND });
    for (const key of [ana.seedHex, ana.pkcs8Hex]) {
        const sealed = api.sealDmVoice(voiceOf(d), { myEdPrivHex: key, peerEdPubHex: ben.publicKey, conversationId: d.conversationId },
            { senderPubHex: ana.publicKey, messageId: d.messageId, at: d.at }, d.nonce);
        if (sealed.ciphertext !== d.payload.ciphertext || sealed.nonce !== d.payload.nonce) fail(`${d.label}: sealed, the bytes differ from the frozen part`);
    }
    const ref = { conversationId: d.conversationId, senderPubHex: ana.publicKey, messageId: d.messageId };
    const benKeys: DmKeys = { myEdPrivHex: ben.seedHex, peerEdPubHex: ana.publicKey };
    for (const keys of [benKeys, { myEdPrivHex: ana.seedHex, peerEdPubHex: ben.publicKey }]) {
        const opened = api.openDmVoice(d.payload, keys, ref);
        if (opened.format !== 4 || opened.moved || opened.conversationId !== d.conversationId) fail(`${d.label}: opened ${JSON.stringify(opened)}`);
        sameVoice(d.label, opened, d.durationMs, d.bars);
    }
    for (const part of ['attachment', 'body', 'about', 'voice'] as const) {
        refused(d.label, `opened as the ${part} part's words`, () => api.openDmLine(d.payload, benKeys, { ...ref, part }));
    }
    refused(d.label, 'named as Ben\'s', () => api.openDmVoice(d.payload, benKeys, { ...ref, senderPubHex: ben.publicKey }), 'not-verified');
    refused(d.label, 'under another message id', () => api.openDmVoice(d.payload, benKeys, { ...ref, messageId: '11111111-2222-4333-8444-555555555555' }), 'not-verified');
    refused(d.label, 'in another conversation', () => api.openDmVoice(d.payload, benKeys, { ...ref, conversationId: '00000000-0000-4000-8000-000000000000' }), 'not-verified');
    refused(d.label, 'with its signature changed', () => api.openDmVoice(withByteChanged(d.payload, 1), benKeys, ref), 'not-verified');
    // [4][signature][time][4][after length], then the part: its length's last byte, the bar count.
    refused(d.label, 'with its length changed', () => api.openDmVoice(withByteChanged(d.payload, 1 + 64 + 24 + 2 + 4), benKeys, ref), 'not-verified');
    refused(d.label, 'with its bar count changed', () => api.openDmVoice(withByteChanged(d.payload, 1 + 64 + 24 + 2 + 5), benKeys, ref), 'not-verified');

    // ── Group ──
    const g = VOICE_GROUP_VECTOR;
    const gAna = GROUP_VECTOR_PEOPLE.ana;
    for (const key of [gAna.seedHex, gAna.pkcs8Hex]) {
        const sealed = api.sealGroupVoice(voiceOf(g), { myEdPrivHex: key, groupKey: g.groupKey, groupId: g.groupId, epoch: g.epoch, messageId: g.messageId },
            { randomBytesForVectors: groupVectorRandom(g.stream) });
        if (sealed.ciphertext !== g.payload.ciphertext || sealed.nonce !== g.payload.nonce) fail(`${g.label}: sealed, the bytes differ from the frozen part`);
    }
    const gRef: GroupVoiceBinding = { groupId: g.groupId, epoch: g.epoch, senderPubHex: gAna.publicKey, messageId: g.messageId };
    sameVoice(g.label, api.openGroupVoice(g.payload, gRef, g.groupKey), g.durationMs, g.bars);
    sameVoice(g.label, api.openGroupVoiceWithMessageKey(g.payload, gRef, api.groupMessageKey(g.groupKey, g.messageId)), g.durationMs, g.bars);
    for (const part of ['attachment', 'body', 'edit', 'voice'] as const) {
        refused(g.label, `opened as the ${part} part's words`, () => api.openGroupLine(g.payload, { ...gRef, part }, g.groupKey));
    }
    refused(g.label, 'under another message\'s key', () => api.openGroupVoiceWithMessageKey(g.payload, gRef, api.groupMessageKey(g.groupKey, '11111111-2222-4333-8444-555555555555')), 'not-verified');
    refused(g.label, 'under the epoch key itself', () => api.openGroupVoiceWithMessageKey(g.payload, gRef, g.groupKey), 'not-verified');
    refused(g.label, 'named as Ben\'s', () => api.openGroupVoice(g.payload, { ...gRef, senderPubHex: GROUP_VECTOR_PEOPLE.ben.publicKey }, g.groupKey), 'not-verified');
    refused(g.label, 'in another epoch', () => api.openGroupVoice(g.payload, { ...gRef, epoch: g.epoch + 1 }, g.groupKey), 'not-verified');
    // [1][signature][after length], then the part: its length's last byte, the bar count.
    refused(g.label, 'with its length changed', () => api.openGroupVoice(withByteChanged(g.payload, 1 + 64 + 1 + 4), gRef, g.groupKey), 'not-verified');
    refused(g.label, 'with its bar count changed', () => api.openGroupVoice(withByteChanged(g.payload, 1 + 64 + 1 + 5), gRef, g.groupKey), 'not-verified');
}

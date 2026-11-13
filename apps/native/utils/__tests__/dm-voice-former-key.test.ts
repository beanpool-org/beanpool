/**
 * A DM voice message sealed before "Continue with the new key" still plays (utils/dm-voice.ts openDmVoiceWithFormer; #3103's
 * review, finding b: core's openDmVoice takes one key pair). Tried under the pinned key, then each former key, by the rules a
 * line's words follow (db.ts openDmPartWithFormer): a former key only for a line the row names as mine, the pinned key's
 * or that former key's own; and a third person's key never opens it.
 */
import { describe, expect, it } from 'vitest';
import { dmPublicKeyOf, sealDmVoice, VOICE_BARS, VoiceRefusedError, type VoiceInput } from '@beanpool/core';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { openDmVoiceWithFormer } from '../dm-voice';

const priv = () => bytesToHex(randomBytes(32));
const me = priv();
const mePub = dmPublicKeyOf(me);
const oldPeer = priv();
const oldPeerPub = dmPublicKeyOf(oldPeer);
const newPeer = priv();
const newPeerPub = dmPublicKeyOf(newPeer);
const stranger = priv();
const conversationId = 'conv-1';
const messageId = '1b4e28ba-2fa1-4d3b-9c5a-0e2f3a4b5c6d';

const m4a = (n: number) => {
    const s = new Uint8Array(n);
    s.set([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0, 0, 0, 0, 0x4d, 0x34, 0x41, 0x20]);
    return s;
};
const voice: VoiceInput = { durationMs: 4200, bars: Array.from({ length: VOICE_BARS }, (_, i) => i * 5), sound: m4a(400) };

/** A voice line `from` sealed to `to` in this conversation. */
const sealedBy = (from: string, toPub: string) => sealDmVoice(voice, { myEdPrivHex: from, peerEdPubHex: toPub, conversationId }, { senderPubHex: dmPublicKeyOf(from), messageId });

const keysNow = { myEdPrivHex: me, myPubHex: mePub, peerEdPubHex: newPeerPub, formerPeers: [oldPeerPub] };
const refOf = (senderPubHex: string) => ({ conversationId, senderPubHex, messageId, metadata: null });

describe('a DM voice message across a key change', () => {
    it('the old key\'s voice message, from before the change, opens under the former key it was sealed to', () => {
        const opened = openDmVoiceWithFormer(sealedBy(oldPeer, mePub), keysNow, refOf(oldPeerPub));
        expect(opened.peerEdPubHex).toBe(oldPeerPub);
        expect(opened.senderPubHex).toBe(oldPeerPub);
        expect(opened.voice.durationMs).toBe(4200);
        expect(Array.from(opened.voice.sound)).toEqual(Array.from(voice.sound));
    });

    it('the row moved to the new key after the re-key (the node re-attributes): still opens, as the former key\'s', () => {
        const opened = openDmVoiceWithFormer(sealedBy(oldPeer, mePub), keysNow, refOf(newPeerPub));
        expect(opened.senderPubHex).toBe(oldPeerPub);
    });

    it('my own voice message sealed to the old key opens under it, as mine', () => {
        const opened = openDmVoiceWithFormer(sealedBy(me, oldPeerPub), keysNow, refOf(mePub));
        expect(opened.peerEdPubHex).toBe(oldPeerPub);
        expect(opened.senderPubHex).toBe(mePub);
    });

    it('one after the change opens under the pinned key first', () => {
        expect(openDmVoiceWithFormer(sealedBy(newPeer, mePub), keysNow, refOf(newPeerPub)).peerEdPubHex).toBe(newPeerPub);
    });

    it('without the former key kept, the old one is refused, as core alone refuses it', () => {
        expect(() => openDmVoiceWithFormer(sealedBy(oldPeer, mePub), { ...keysNow, formerPeers: [] }, refOf(oldPeerPub))).toThrow(VoiceRefusedError);
    });

    it('a stranger\'s voice message, named as theirs, opens under no key', () => {
        const strangerPub = dmPublicKeyOf(stranger);
        const err = (() => { try { openDmVoiceWithFormer(sealedBy(stranger, mePub), keysNow, refOf(strangerPub)); } catch (e) { return e; } })();
        expect(err).toBeInstanceOf(VoiceRefusedError);
        expect((err as VoiceRefusedError).reason).toBe('not-verified');
    });

    it('the old key\'s voice message named as a stranger\'s is not tried under the former key', () => {
        expect(() => openDmVoiceWithFormer(sealedBy(oldPeer, mePub), keysNow, refOf(dmPublicKeyOf(stranger)))).toThrow(VoiceRefusedError);
    });

    it('a too-big part is refused once, unopened, not tried under every key', () => {
        const big = { ciphertext: 'A'.repeat(1_150_001), nonce: 'x25519-xc20p-v2:AAAA' };
        const err = (() => { try { openDmVoiceWithFormer(big, keysNow, refOf(oldPeerPub)); } catch (e) { return e; } })();
        expect((err as VoiceRefusedError).reason).toBe('too-big');
    });
});

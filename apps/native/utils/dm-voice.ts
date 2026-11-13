/**
 * A direct chat's voice message, opened on the phone (DESIGN-cross-chat-voice-fable.md §5.4; slice V3).
 *
 * Core's openDmVoice opens under one key pair. A voice line sealed before "Continue with the new key" was sealed to the key
 * pinned then, which the phone keeps as a former key (pick 3), so the voice part is tried under the pinned key and then
 * under each former one, by the same rules as a line's words and photo (db.ts openDmPartWithFormer; #3103's review,
 * finding b): a former key is tried only for a line the row names as mine, the pinned key's, or that former key's own.
 */
import { openDmVoice, VoiceRefusedError, type DmPayload, type OpenedDmVoice } from '@beanpool/core';

/** The keys a DM opens under: the pinned peer and the ones pinned before it. */
export interface DmVoiceKeys {
    myEdPrivHex: string;
    /** My public key, as the rows name my lines. */
    myPubHex: string;
    peerEdPubHex: string;
    formerPeers: readonly string[];
}

/** What a voice line is bound to, as the phone holds it. */
export interface DmVoiceRef {
    conversationId: string;
    senderPubHex: string;
    messageId: string;
    metadata: unknown;
}

/** A voice part that opened, with the peer key and sender it opened under. */
export interface DmVoiceOpened {
    voice: OpenedDmVoice;
    peerEdPubHex: string;
    senderPubHex: string;
}

/**
 * Open a DM voice part under the pinned key, then each former key. Throws the pinned key's VoiceRefusedError when none
 * opens: 'too-big' and the content checks ('version', 'header', 'too-long', 'not-m4a') are the same under every key, so
 * only 'not-verified' tries the next.
 */
export function openDmVoiceWithFormer(payload: DmPayload, keys: DmVoiceKeys, ref: DmVoiceRef): DmVoiceOpened {
    let first: unknown;
    try {
        return { voice: openDmVoice(payload, keys, ref), peerEdPubHex: keys.peerEdPubHex, senderPubHex: ref.senderPubHex };
    } catch (e) {
        if (!(e instanceof VoiceRefusedError) || e.reason !== 'not-verified') throw e;
        first = e;
    }
    const mine = !!keys.myPubHex && ref.senderPubHex === keys.myPubHex;
    for (const peer of keys.formerPeers) {
        if (!peer || peer === keys.peerEdPubHex) continue;
        if (!mine && ref.senderPubHex !== keys.peerEdPubHex && ref.senderPubHex !== peer) continue;
        const senderPubHex = mine ? ref.senderPubHex : peer;
        try {
            return { voice: openDmVoice(payload, { myEdPrivHex: keys.myEdPrivHex, peerEdPubHex: peer }, { ...ref, senderPubHex }), peerEdPubHex: peer, senderPubHex };
        } catch { /* the next former key */ }
    }
    throw first;
}

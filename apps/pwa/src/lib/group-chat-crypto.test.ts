/**
 * The web's group-chat crypto door (group-chat-crypto.ts) against core's frozen vectors: the same bytes the phone and the
 * node use (packages/beanpool-core/src/group-line-vectors.ts), with both key spellings (the web's PKCS8, the phone's seed).
 */
import { describe, it, expect } from 'vitest';
import {
    checkGroupCryptoVectors, checkGroupPhotoVector, GROUP_LINE_VECTORS, GROUP_PHOTO_VECTOR, GROUP_VECTOR_GROUP, GROUP_VECTOR_KEY_HEX, GROUP_VECTOR_PEOPLE,
    GROUP_VECTOR_RECORD, type GroupLineVector,
} from '@beanpool/core/group-line-vectors';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
    groupCryptoForVectors, openLine, isGroupEncryptedNonce, groupMessageKey, openGroupLineWithMessageKey, GroupLineNotVerifiedError, type GroupLinePart,
} from './group-chat-crypto';
import { isEncryptedNonce } from './e2e-crypto';

describe('group chat crypto in the web app', () => {
    it('re-makes and opens every frozen vector through the web door', () => {
        expect(() => checkGroupCryptoVectors(groupCryptoForVectors)).not.toThrow();
    });

    it('the photo pair (caption and photo under one message key) re-makes, opens and refuses through the web door', () => {
        expect(() => checkGroupPhotoVector(groupCryptoForVectors)).not.toThrow();
    });

    it("the web's own openLine opens a group photo's caption and photo, refuses the photo as words; one message key opens both", () => {
        const { caption, photo } = GROUP_PHOTO_VECTOR;
        const key = hexToBytes(GROUP_VECTOR_KEY_HEX);
        const ref = (v: GroupLineVector, part: GroupLinePart = v.part) => ({
            groupId: GROUP_VECTOR_GROUP, epoch: GROUP_VECTOR_RECORD.epoch, senderPubHex: GROUP_VECTOR_PEOPLE[v.from].publicKey,
            messageId: v.messageId, part, replyToId: v.replyToId ?? null,
        });
        expect(openLine(caption.payload, ref(caption), key)).toEqual({ text: caption.text, after: caption.after });
        expect(openLine(photo.payload, ref(photo), key)).toEqual({ text: photo.text, after: null });
        expect(() => openLine(photo.payload, ref(photo, 'body'), key)).toThrow(GroupLineNotVerifiedError);
        const mk = groupMessageKey(key, photo.messageId);
        expect([caption, photo].map((v) => openGroupLineWithMessageKey(v.payload, ref(v), mk).text)).toEqual([caption.text, photo.text]);
    });

    it("opens the phone's frozen lines and names the signer the vector names", () => {
        const key = hexToBytes(GROUP_VECTOR_KEY_HEX);
        const body = GROUP_LINE_VECTORS.filter((v) => v.part === 'body');
        expect(body.length).toBeGreaterThan(0);
        for (const v of body) {
            const opened = openLine(v.payload, {
                groupId: GROUP_VECTOR_GROUP, epoch: GROUP_VECTOR_RECORD.epoch, senderPubHex: GROUP_VECTOR_PEOPLE[v.from].publicKey,
                messageId: v.messageId, part: v.part, replyToId: v.replyToId ?? null,
            }, key);
            expect(opened.text).toBe(v.text);
        }
    });

    it('a group line is never mistaken for a DM line (the DM guard keys on its own prefix)', () => {
        for (const v of [...GROUP_LINE_VECTORS, GROUP_PHOTO_VECTOR.caption, GROUP_PHOTO_VECTOR.photo]) {
            expect(isGroupEncryptedNonce(v.payload.nonce)).toBe(true);
            expect(isEncryptedNonce(v.payload.nonce)).toBe(false);
        }
    });
});

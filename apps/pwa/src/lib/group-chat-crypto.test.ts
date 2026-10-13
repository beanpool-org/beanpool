/**
 * The web's group-chat crypto door (group-chat-crypto.ts) against core's frozen vectors: the same bytes the phone and the
 * node use (packages/beanpool-core/src/group-line-vectors.ts), with both key spellings (the web's PKCS8, the phone's seed).
 */
import { describe, it, expect } from 'vitest';
import { checkGroupCryptoVectors, GROUP_LINE_VECTORS, GROUP_VECTOR_GROUP, GROUP_VECTOR_KEY_HEX, GROUP_VECTOR_PEOPLE, GROUP_VECTOR_RECORD } from '@beanpool/core/group-line-vectors';
import { hexToBytes } from '@noble/hashes/utils.js';
import { groupCryptoForVectors, openLine, isGroupEncryptedNonce } from './group-chat-crypto';
import { isEncryptedNonce } from './e2e-crypto';

describe('group chat crypto in the web app', () => {
    it('re-makes and opens every frozen vector through the web door', () => {
        expect(() => checkGroupCryptoVectors(groupCryptoForVectors)).not.toThrow();
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
        for (const v of GROUP_LINE_VECTORS) {
            expect(isGroupEncryptedNonce(v.payload.nonce)).toBe(true);
            expect(isEncryptedNonce(v.payload.nonce)).toBe(false);
        }
    });
});

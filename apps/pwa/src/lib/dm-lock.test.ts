/**
 * A direct message leaves the web app encrypted or not at all (lib/dm-lock.ts). Real crypto, no mocks: what the peer
 * opens here is what the phone opens (both e2e-crypto files re-export @beanpool/core's dm-crypto). A line is sealed to
 * its sender and its message id (format 3), so the peer opens it as the node stores it: from me, under that id.
 *
 * The node now refuses a readable DM, so a browser that could send before must still be able to lock: every shape of
 * private key the browser can hold — its own PKCS8, a phone's bare seed carried over by a transfer code — locks, and
 * any key the request signer accepts, the lock accepts too.
 */
import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { ed25519Signer, toEd25519Pkcs8 } from '@beanpool/core';
import { openDmLine, isEncryptedNonce, newDmMessageId } from './e2e-crypto';
import {
    DmNotLockedError, dmKeyContext, dmNotLockedLine, isDmNotLocked, isNodeReadableChat, lockForDm, payloadForChat,
} from './dm-lock';

function person() {
    const seed = ed25519.utils.randomSecretKey();
    return { seed, publicKey: bytesToHex(ed25519.getPublicKey(seed)) };
}
const me = person();
const peer = person();
const dm = { id: 'conv-1', type: 'dm', participants: [me.publicKey, peer.publicKey] };
/** The browser's own key: 48-byte PKCS8, as identity.ts stores it. */
const myBrowserKey = { publicKey: me.publicKey, privateKey: bytesToHex(toEd25519Pkcs8(me.seed)) };
/** A new line's own id, as the page picks it before sealing. */
const aLine = () => ({ messageId: newDmMessageId() });
const peerReads = (sent: { ciphertext: string; nonce: string }, line: { messageId: string }, conversationId = dm.id) =>
    openDmLine(sent, { myEdPrivHex: bytesToHex(peer.seed), peerEdPubHex: me.publicKey },
        { conversationId, senderPubHex: me.publicKey, messageId: line.messageId }).text;

describe('a line in a DM', () => {
    it('is locked, and only the other person reads it', () => {
        const line = aLine();
        const sent = payloadForChat('meet at the gate at 6', dm, myBrowserKey, line);
        expect(isEncryptedNonce(sent.nonce)).toBe(true);
        expect(sent.nonce).not.toBe('plaintext-v1');
        expect(atob(sent.ciphertext)).not.toContain('meet at the gate');
        expect(peerReads(sent, line)).toBe('meet at the gate at 6');
        // Bound to who sent it and which message it is: as anyone else's, or under another id, it doesn't open.
        const peerKeys = { myEdPrivHex: bytesToHex(peer.seed), peerEdPubHex: me.publicKey };
        expect(() => openDmLine(sent, peerKeys, { conversationId: dm.id, senderPubHex: peer.publicKey, messageId: line.messageId })).toThrow();
        expect(() => openDmLine(sent, peerKeys, { conversationId: dm.id, senderPubHex: me.publicKey, messageId: newDmMessageId() })).toThrow();
    });

    it('a DM tied to a listing is a DM like any other', () => {
        const line = aLine();
        const sent = payloadForChat('is the ladder free?', { ...dm, id: 'conv-listing', postId: 'post-1' } as any, myBrowserKey, line);
        expect(peerReads(sent, line, 'conv-listing')).toBe('is the ladder free?');
    });
});

describe('every key shape the browser can hold locks', () => {
    const shapes: Array<[string, string]> = [
        ['the browser\'s own 48-byte PKCS8', bytesToHex(toEd25519Pkcs8(me.seed))],
        ['a phone\'s 32-byte seed, carried over by a transfer code', bytesToHex(me.seed)],
        ['PKCS8 in capitals', bytesToHex(toEd25519Pkcs8(me.seed)).toUpperCase()],
        ['a seed in capitals', bytesToHex(me.seed).toUpperCase()],
    ];
    for (const [what, privateKey] of shapes) {
        it(`${what}: signs and locks, and the peer reads it`, () => {
            expect(() => ed25519Signer(hexToBytes(privateKey))(new Uint8Array([1, 2, 3]))).not.toThrow();
            const line = aLine();
            const sent = lockForDm('hello', dm, { publicKey: me.publicKey, privateKey }, line);
            expect(peerReads(sent, line)).toBe('hello');
        });
    }

    it('a key the request signer refuses is refused here too, as not locked — never sent readable', () => {
        const broken = { publicKey: me.publicKey, privateKey: 'ab'.repeat(40) };   // 40 bytes: neither shape
        expect(() => ed25519Signer(hexToBytes(broken.privateKey))).toThrow();
        expect(() => payloadForChat('hello', dm, broken, aLine())).toThrow(DmNotLockedError);
    });
});

describe('a DM that cannot be locked is not sent', () => {
    it('when the other person is not known yet', () => {
        for (const participants of [[me.publicKey], [], null, [me.publicKey, me.publicKey]]) {
            expect(() => payloadForChat('hello', { ...dm, participants } as any, myBrowserKey, aLine())).toThrow(DmNotLockedError);
        }
    });

    it('when the encryption throws (a peer key that is not a key)', () => {
        for (const bad of ['system', 'SYSTEM', 'zz'.repeat(32), '00'.repeat(32)]) {
            let thrown: unknown;
            try { payloadForChat('hello', { ...dm, participants: [me.publicKey, bad] }, myBrowserKey, aLine()); } catch (e) { thrown = e; }
            expect(isDmNotLocked(thrown)).toBe(true);
        }
    });

    it('when it is not a chat the node reads and not a DM either — no readable fallback for a kind it does not know', () => {
        for (const type of ['direct', 'group', undefined, null, '']) {
            expect(() => payloadForChat('hello', { ...dm, type } as any, myBrowserKey, aLine())).toThrow(DmNotLockedError);
        }
    });

    it('when it would be sealed as someone else, or to an id the node would store differently', () => {
        expect(() => lockForDm('hello', dm, { publicKey: peer.publicKey, privateKey: myBrowserKey.privateKey }, aLine())).toThrow(DmNotLockedError);
        expect(() => lockForDm('hello', dm, myBrowserKey, { messageId: newDmMessageId().toUpperCase() })).toThrow(DmNotLockedError);
        expect(() => lockForDm('hello', dm, myBrowserKey, { messageId: 'msg-1' })).toThrow(DmNotLockedError);
    });

    it('says so in one plain line, naming the other person when it can', () => {
        expect(dmNotLockedLine('Bob')).toBe("This message couldn't be locked for Bob yet, so it wasn't sent. Try again in a moment.");
        expect(dmNotLockedLine(null)).toBe("This message couldn't be locked for the other person yet, so it wasn't sent. Try again in a moment.");
        expect(dmNotLockedLine('  ')).toContain('the other person');
    });

    it('a key context is only ever for exactly two people', () => {
        expect(dmKeyContext(dm, myBrowserKey)).toEqual({ myEdPrivHex: myBrowserKey.privateKey, peerEdPubHex: peer.publicKey, conversationId: 'conv-1' });
        expect(dmKeyContext({ ...dm, participants: [me.publicKey, peer.publicKey, person().publicKey] }, myBrowserKey)).toBeNull();
        expect(dmKeyContext({ ...dm, type: 'group_thread' }, myBrowserKey)).toBeNull();
    });
});

describe('a chat the node reads stays readable, as designed', () => {
    for (const type of ['group_thread', 'event_thread', 'enterprise_thread']) {
        it(`${type}: plaintext-v1`, () => {
            expect(isNodeReadableChat({ type })).toBe(true);
            const sent = payloadForChat('swap day on Saturday', { id: 'g1', type, participants: [] }, myBrowserKey, aLine());
            expect(sent.nonce).toBe('plaintext-v1');
        });
    }
    it('a DM is not one', () => {
        expect(isNodeReadableChat(dm)).toBe(false);
        expect(isNodeReadableChat(null)).toBe(false);
    });
});

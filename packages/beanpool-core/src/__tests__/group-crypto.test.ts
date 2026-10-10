import { describe, it, expect } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import * as gc from '../group-crypto.js';
import {
    detectMentions, groupEpochCanonical, groupMessageKey, isGroupEncryptedNonce, isGroupEncryptedPayload, makeGroupEpochRecord,
    makeGroupTopUp, openGroupEpochRecord, openGroupKeyWrap, openGroupLine, openGroupLineWithMessageKey, openGroupTopUp, sealGroupLine,
    verifyGroupEpochRecord, verifyGroupTopUp, wrapGroupKey, GroupKeyNotVerifiedError, GroupLineNotVerifiedError, GROUP_NONCE_PREFIX,
    type GroupEpochRecord, type GroupLineBinding, type GroupLinePayload,
} from '../group-crypto.js';
import { DM_NONCE_PREFIX, dmPublicKeyOf, identityX25519Secret, isDmEncryptedNonce } from '../dm-crypto.js';
import { toEd25519Pkcs8 } from '../ed25519-key.js';
import * as core from '../index.js';
import {
    checkGroupCryptoVectors, groupVectorRandom, GROUP_LINE_VECTORS, GROUP_VECTOR_GROUP, GROUP_VECTOR_KEY_HEX, GROUP_VECTOR_PEOPLE,
    GROUP_VECTOR_RECORD, GROUP_VECTOR_TOP_UP,
} from '../group-line-vectors.js';

// Group chats become unreadable to the node (design: DESIGN-group-chat-encryption-fable.md §2, §7; Marty's picks of
// 10 Oct 2026). This is slice 1: the shared locks, nothing switched on. Every opening below that should fail is proved
// to fail, and the bytes both apps must agree on are frozen.

function person(name: string) {
    const seed = sha256(utf8ToBytes(`group-crypto.test ${name}`));
    return { seedHex: bytesToHex(seed), pkcs8Hex: bytesToHex(toEd25519Pkcs8(seed)), publicKey: bytesToHex(ed25519.getPublicKey(seed)) };
}
const ana = person('Ana');
const ben = person('Ben');
const cat = person('Cat');
const dov = person('Dov');
const GROUP = 'b1b2b3b4-c5c6-4d7d-8e8e-f9f9f9f9f9f9';
const AT = '2026-10-10T10:00:00.000Z';
const MSG = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const OTHER_MSG = '9f8e7d6c-5b4a-4938-a716-151413121110';

/** Epoch 2 of GROUP: Cat joined; Ana, Ben and Cat hold it. */
function epoch2() {
    return makeGroupEpochRecord({
        myEdPrivHex: cat.seedHex, groupId: GROUP, epoch: 2, reason: 'join', subject: cat.publicKey, createdAt: AT,
        recipients: [ana.publicKey, ben.publicKey, cat.publicKey],
    });
}

/** Sign any record as `signer`, bypassing makeGroupEpochRecord's own refusal: what a modified app could send. */
function forgeRecord(unsigned: Omit<GroupEpochRecord, 'sig'>, signer: { seedHex: string }): GroupEpochRecord {
    const sig = ed25519.sign(sha256(utf8ToBytes(groupEpochCanonical(unsigned))), hexToBytes(signer.seedHex));
    return { ...unsigned, sig: Buffer.from(sig).toString('base64') };
}

/** A record whose wraps are real, for any maker, reason and recipients (signed by `signer`, default the maker). */
function recordBy(maker: typeof ana, reason: GroupEpochRecord['reason'], subject: string | null, recipients: string[], epoch = 2, signer = maker): GroupEpochRecord {
    const key = new Uint8Array(32).fill(7);
    const wraps = [...recipients].sort().map((r) => wrapGroupKey(key, { groupId: GROUP, epoch, recipientPubHex: r, wrapperPubHex: maker.publicKey }));
    return forgeRecord({ groupId: GROUP, epoch, reason, subject, createdBy: maker.publicKey, createdAt: AT, wraps }, signer);
}

const refOf = (sender: typeof ana, over: Partial<GroupLineBinding> = {}): GroupLineBinding =>
    ({ groupId: GROUP, epoch: 2, senderPubHex: sender.publicKey, messageId: MSG, part: 'body', replyToId: null, ...over });

const flip = (b64: string, at = 0): string => {
    const b = Buffer.from(b64, 'base64');
    b[at] ^= 0x01;
    return b.toString('base64');
};

/** Open a line's frame directly (as any member can: they hold the epoch key), for building tampered lines. */
function frameOf(payload: GroupLinePayload, binding: GroupLineBinding, groupKey: Uint8Array): Uint8Array {
    const nonce = new Uint8Array(Buffer.from(payload.nonce.slice(GROUP_NONCE_PREFIX.length), 'base64'));
    return xchacha20poly1305(groupMessageKey(groupKey, binding.messageId), nonce, gc.groupLineAad(binding)).decrypt(new Uint8Array(Buffer.from(payload.ciphertext, 'base64')));
}
function resealFrame(frame: Uint8Array, binding: GroupLineBinding, groupKey: Uint8Array, nonce = new Uint8Array(24).fill(9)): GroupLinePayload {
    const ct = xchacha20poly1305(groupMessageKey(groupKey, binding.messageId), nonce, gc.groupLineAad(binding)).encrypt(frame);
    return { ciphertext: Buffer.from(ct).toString('base64'), nonce: GROUP_NONCE_PREFIX + Buffer.from(nonce).toString('base64') };
}

describe('the frozen vectors', () => {
    it('re-make, open and refuse exactly as frozen, with bare-seed and PKCS8 keys', () => {
        checkGroupCryptoVectors(gc);
    });

    it('an epoch record wrap is what the design says, opened from the primitives without group-crypto.ts', () => {
        const a = GROUP_VECTOR_PEOPLE.ana;
        const w = GROUP_VECTOR_RECORD.wraps.find((x) => x.recipient === a.publicKey)!;
        const ephPub = new Uint8Array(Buffer.from(w.ephPub, 'base64'));
        const shared = x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(hexToBytes(a.seedHex)), ephPub);
        const k = hkdf(sha256, shared, ephPub, utf8ToBytes('beanpool-group-key/1'), 32);
        const aad = utf8ToBytes(`["beanpool-group-key/1","${GROUP_VECTOR_GROUP}","3","${a.publicKey}","${GROUP_VECTOR_PEOPLE.cat.publicKey}"]`);
        const key = xchacha20poly1305(k, new Uint8Array(Buffer.from(w.nonce, 'base64')), aad).decrypt(new Uint8Array(Buffer.from(w.wrapped, 'base64')));
        expect(bytesToHex(key)).toBe(GROUP_VECTOR_KEY_HEX);
        // The key is the first 32 bytes of the record's fixed stream: made fresh, not derived from anything.
        expect(bytesToHex(groupVectorRandom('epoch 3')(32))).toBe(GROUP_VECTOR_KEY_HEX);
    });

    it("the record's signature is over the canonical array the design spells out", () => {
        const r = GROUP_VECTOR_RECORD;
        const wraps = [...r.wraps].sort((x, y) => (x.recipient < y.recipient ? -1 : 1)).map((w) => [w.recipient, w.ephPub, w.nonce, w.wrapped]);
        const canonical = JSON.stringify(['beanpool-group-epoch/1', r.groupId, '3', 'join', r.subject, r.createdBy, r.createdAt, wraps]);
        expect(groupEpochCanonical(r)).toBe(canonical);
        expect(ed25519.verify(Buffer.from(r.sig, 'base64'), sha256(utf8ToBytes(canonical)), hexToBytes(r.createdBy), { zip215: false })).toBe(true);
    });

    it('a line is what the design says: message key, associated data, [1][sig][len][after][words], signature over aad ‖ nonce ‖ frame', () => {
        const v = GROUP_LINE_VECTORS.find((x) => x.replyToId)!;
        const sender = GROUP_VECTOR_PEOPLE[v.from].publicKey;
        const mk = hkdf(sha256, hexToBytes(GROUP_VECTOR_KEY_HEX), utf8ToBytes(v.messageId), utf8ToBytes('beanpool-group-line/1'), 32);
        expect(bytesToHex(mk)).toBe(v.messageKeyHex);
        const aad = utf8ToBytes(`["beanpool-group-line/1","${GROUP_VECTOR_GROUP}","3","${sender}","${v.messageId}","body","${v.replyToId}"]`);
        expect(v.payload.nonce.startsWith('group-xc20p-v1:')).toBe(true);
        const nonce = new Uint8Array(Buffer.from(v.payload.nonce.slice('group-xc20p-v1:'.length), 'base64'));
        expect(bytesToHex(nonce)).toBe(bytesToHex(groupVectorRandom(v.rng)(24)));
        const frame = xchacha20poly1305(mk, nonce, aad).decrypt(new Uint8Array(Buffer.from(v.payload.ciphertext, 'base64')));
        expect(frame[0]).toBe(1);
        const sig = frame.subarray(1, 65);
        const unsigned = concatBytes(frame.subarray(0, 1), frame.subarray(65));
        const after = utf8ToBytes(v.after!);
        expect(bytesToHex(unsigned)).toBe(bytesToHex(new Uint8Array([1, after.length, ...after, ...utf8ToBytes(v.text)])));
        expect(ed25519.verify(sig, sha256(concatBytes(aad, nonce, unsigned)), hexToBytes(sender), { zip215: false })).toBe(true);
    });

    it('the top-up is signed by its wrapper over its canonical array', () => {
        const t = GROUP_VECTOR_TOP_UP;
        const canonical = JSON.stringify(['beanpool-group-wrap/1', GROUP_VECTOR_GROUP, '3', t.recipient, t.wrapper, t.ephPub, t.nonce, t.wrapped]);
        expect(ed25519.verify(Buffer.from(t.sig, 'base64'), sha256(utf8ToBytes(canonical)), hexToBytes(t.wrapper), { zip215: false })).toBe(true);
    });
});

describe('identity keys in either spelling', () => {
    it('PKCS8 and the bare seed make the same public key and the same X25519 secret (one derivation, shared with DMs)', () => {
        expect(dmPublicKeyOf(ana.pkcs8Hex)).toBe(ana.publicKey);
        expect(bytesToHex(identityX25519Secret(ana.pkcs8Hex))).toBe(bytesToHex(identityX25519Secret(ana.seedHex)));
    });

    it('a record made with PKCS8 opens with the seed, and the other way round; a line likewise', () => {
        const a = makeGroupEpochRecord({ myEdPrivHex: ana.pkcs8Hex, groupId: GROUP, epoch: 1, reason: 'start', createdAt: AT, recipients: [ana.publicKey] });
        expect(a.record.createdBy).toBe(ana.publicKey);
        expect(bytesToHex(openGroupEpochRecord(a.record, ana.seedHex, { groupId: GROUP }))).toBe(bytesToHex(a.groupKey));
        const { record, groupKey } = epoch2();
        expect(bytesToHex(openGroupEpochRecord(record, ben.pkcs8Hex, { groupId: GROUP }))).toBe(bytesToHex(groupKey));
        const line = sealGroupLine('hello', { myEdPrivHex: ben.pkcs8Hex, groupKey, groupId: GROUP, epoch: 2, messageId: MSG });
        expect(openGroupLine(line, refOf(ben), groupKey).text).toBe('hello');
        const line2 = sealGroupLine('hello', { myEdPrivHex: ben.seedHex, groupKey, groupId: GROUP, epoch: 2, messageId: MSG }, { randomBytes: () => new Uint8Array(24).fill(1) });
        const line3 = sealGroupLine('hello', { myEdPrivHex: ben.pkcs8Hex, groupKey, groupId: GROUP, epoch: 2, messageId: MSG }, { randomBytes: () => new Uint8Array(24).fill(1) });
        expect(line3).toEqual(line2);
    });

    it('refuses a key that is neither spelling', () => {
        expect(() => sealGroupLine('x', { myEdPrivHex: 'ab'.repeat(40), groupKey: new Uint8Array(32), groupId: GROUP, epoch: 1, messageId: MSG })).toThrow();
        expect(() => openGroupEpochRecord(epoch2().record, 'ab'.repeat(40), { groupId: GROUP })).toThrow(GroupKeyNotVerifiedError);
    });
});

describe('wraps', () => {
    const { record, groupKey } = epoch2();
    const anaWrap = record.wraps.find((w) => w.recipient === ana.publicKey)!;
    const at = { groupId: GROUP, epoch: 2, wrapperPubHex: cat.publicKey };

    it('every recipient opens the same key; a non-recipient opens nothing', () => {
        for (const p of [ana, ben, cat]) expect(bytesToHex(openGroupEpochRecord(record, p.seedHex, { groupId: GROUP }))).toBe(bytesToHex(groupKey));
        expect(() => openGroupEpochRecord(record, dov.seedHex, { groupId: GROUP })).toThrow(GroupKeyNotVerifiedError);
    });

    it('a wrap moved to another member does not open for them', () => {
        // Relabelled as Ben's: the X25519 agreement and the associated data both name Ana.
        expect(() => openGroupKeyWrap({ ...anaWrap, recipient: ben.publicKey }, at, ben.seedHex)).toThrow(GroupKeyNotVerifiedError);
        // Left as Ana's and tried with Ben's key: not his.
        expect(() => openGroupKeyWrap(anaWrap, at, ben.seedHex)).toThrow(GroupKeyNotVerifiedError);
        expect(bytesToHex(openGroupKeyWrap(anaWrap, at, ana.seedHex))).toBe(bytesToHex(groupKey));
    });

    it('a wrap does not open in another group, another epoch, or claimed by another wrapper', () => {
        expect(() => openGroupKeyWrap(anaWrap, { ...at, groupId: 'another-group' }, ana.seedHex)).toThrow(GroupKeyNotVerifiedError);
        expect(() => openGroupKeyWrap(anaWrap, { ...at, epoch: 3 }, ana.seedHex)).toThrow(GroupKeyNotVerifiedError);
        expect(() => openGroupKeyWrap(anaWrap, { ...at, wrapperPubHex: ben.publicKey }, ana.seedHex)).toThrow(GroupKeyNotVerifiedError);
    });

    it('a changed wrap does not open', () => {
        expect(() => openGroupKeyWrap({ ...anaWrap, wrapped: flip(anaWrap.wrapped) }, at, ana.seedHex)).toThrow(GroupKeyNotVerifiedError);
        expect(() => openGroupKeyWrap({ ...anaWrap, nonce: flip(anaWrap.nonce) }, at, ana.seedHex)).toThrow(GroupKeyNotVerifiedError);
        expect(() => openGroupKeyWrap({ ...anaWrap, ephPub: flip(anaWrap.ephPub) }, at, ana.seedHex)).toThrow(GroupKeyNotVerifiedError);
        expect(() => openGroupKeyWrap({ ...anaWrap, ephPub: Buffer.alloc(32).toString('base64') }, at, ana.seedHex)).toThrow(GroupKeyNotVerifiedError);
    });

    it('each wrap uses its own ephemeral key', () => {
        expect(new Set(record.wraps.map((w) => w.ephPub)).size).toBe(3);
    });
});

describe('epoch records', () => {
    it('verify, and refuse another group or another expected epoch', () => {
        const { record } = epoch2();
        expect(() => verifyGroupEpochRecord(record, { groupId: GROUP, epoch: 2, activeMembers: [ana.publicKey, ben.publicKey, cat.publicKey] })).not.toThrow();
        expect(() => verifyGroupEpochRecord(record, { groupId: 'another-group' })).toThrow(/another group/);
        expect(() => verifyGroupEpochRecord(record, { groupId: GROUP, epoch: 3 })).toThrow(/another epoch/);
    });

    it('refuse a changed recipient list, wrap, reason, subject, time or epoch: the signature covers them', () => {
        const { record } = epoch2();
        const check = { groupId: GROUP };
        const extra = wrapGroupKey(new Uint8Array(32), { groupId: GROUP, epoch: 2, recipientPubHex: dov.publicKey, wrapperPubHex: cat.publicKey });
        expect(() => verifyGroupEpochRecord({ ...record, wraps: [...record.wraps, extra] }, check)).toThrow(/signature/);
        expect(() => verifyGroupEpochRecord({ ...record, wraps: record.wraps.filter((w) => w.recipient !== ben.publicKey) }, check)).toThrow(/signature/);
        expect(() => verifyGroupEpochRecord({ ...record, wraps: record.wraps.map((w, i) => (i === 0 ? { ...w, wrapped: flip(w.wrapped) } : w)) }, check)).toThrow(/signature/);
        expect(() => verifyGroupEpochRecord({ ...record, createdAt: '2026-10-10T10:00:01.000Z' }, check)).toThrow(/signature/);
        expect(() => verifyGroupEpochRecord({ ...record, epoch: 3 }, check)).toThrow(/signature/);
        expect(() => verifyGroupEpochRecord({ ...record, reason: 'invite' }, check)).toThrow(/signature/);
        // The node's own storage order of the wraps is not part of it.
        expect(() => verifyGroupEpochRecord({ ...record, wraps: [...record.wraps].reverse() }, check)).not.toThrow();
    });

    it('refuse a signature by anyone but the named maker, and a non-canonical or cut one', () => {
        const forged = recordBy(cat, 'join', cat.publicKey, [ana.publicKey, ben.publicKey, cat.publicKey], 2, ben);
        expect(() => verifyGroupEpochRecord(forged, { groupId: GROUP })).toThrow(/signature/);
        const { record } = epoch2();
        expect(() => verifyGroupEpochRecord({ ...record, sig: record.sig.replace(/=+$/, '') }, { groupId: GROUP })).toThrow(/signature/);
        expect(() => verifyGroupEpochRecord({ ...record, sig: Buffer.from(record.sig, 'base64').subarray(0, 63).toString('base64') }, { groupId: GROUP })).toThrow(/signature/);
    });

    describe('refuse a maker §2.3 does not allow, even with a good signature', () => {
        const all = [ana.publicKey, ben.publicKey, cat.publicKey];
        const refused = (r: GroupEpochRecord, why: RegExp) => expect(() => verifyGroupEpochRecord(r, { groupId: GROUP })).toThrow(why);

        it('a member who left (no wrap for them) making the next epoch', () => {
            refused(recordBy(dov, 'rotate', null, all), /not a member after the change/);
            refused(recordBy(dov, 'leave', dov.publicKey, all), /not a member after the change/);
        });
        it('a join made by anyone but the member who joined', () => {
            refused(recordBy(ana, 'join', cat.publicKey, all), /only the member who joined/);
            refused(recordBy(ana, 'invite', cat.publicKey, all), /only the member who joined/);
        });
        it('a removal that keeps the removed member, or made by them', () => {
            refused(recordBy(ana, 'remove', cat.publicKey, all), /gets no wrap/);
            refused(recordBy(cat, 'remove', cat.publicKey, [ana.publicKey, ben.publicKey, cat.publicKey]), /gets no wrap/);
            expect(() => verifyGroupEpochRecord(recordBy(ana, 'remove', cat.publicKey, [ana.publicKey, ben.publicKey]), { groupId: GROUP })).not.toThrow();
        });
        it('an approval of a member who gets no wrap, or of oneself', () => {
            refused(recordBy(ana, 'approve', dov.publicKey, all), /approval/);
            refused(recordBy(ana, 'approve', ana.publicKey, all), /approval/);
        });
        it("'start' after epoch 1, or a subject where none belongs", () => {
            refused(recordBy(ana, 'start', null, [ana.publicKey], 2), /epoch 1 only/);
            refused(recordBy(ana, 'rotate', ben.publicKey, all), /names no subject/);
        });
        it('a maker who is not an active member per the roster the app holds (§7.3)', () => {
            const r = recordBy(ana, 'rotate', null, all);
            expect(() => verifyGroupEpochRecord(r, { groupId: GROUP, activeMembers: [ben.publicKey, cat.publicKey] })).toThrow(/not an active member/);
            expect(() => verifyGroupEpochRecord(r, { groupId: GROUP, activeMembers: all })).not.toThrow();
        });
        it('makeGroupEpochRecord refuses to make any of them', () => {
            expect(() => makeGroupEpochRecord({ myEdPrivHex: dov.seedHex, groupId: GROUP, epoch: 2, reason: 'rotate', createdAt: AT, recipients: all })).toThrow(/not a member after the change/);
            expect(() => makeGroupEpochRecord({ myEdPrivHex: ana.seedHex, groupId: GROUP, epoch: 2, reason: 'join', subject: cat.publicKey, createdAt: AT, recipients: all })).toThrow();
            expect(() => makeGroupEpochRecord({ myEdPrivHex: ana.seedHex, groupId: GROUP, epoch: 2, reason: 'rotate', createdAt: AT, recipients: [...all, ana.publicKey] })).toThrow(/two wraps/);
            expect(() => makeGroupEpochRecord({ myEdPrivHex: ana.seedHex, groupId: GROUP, epoch: 0, reason: 'rotate', createdAt: AT, recipients: all })).toThrow();
        });
    });
});

describe('top-ups', () => {
    const { groupKey } = epoch2();
    const topUp = makeGroupTopUp(groupKey, { myEdPrivHex: ana.seedHex, groupId: GROUP, epoch: 2, recipientPubHex: dov.publicKey });

    it('the recipient opens the epoch key; nobody else does', () => {
        expect(bytesToHex(openGroupTopUp(GROUP, topUp, dov.pkcs8Hex))).toBe(bytesToHex(groupKey));
        expect(() => openGroupTopUp(GROUP, topUp, ben.seedHex)).toThrow(GroupKeyNotVerifiedError);
    });

    it('refuses one moved to another member, group or epoch, or claimed by another wrapper', () => {
        expect(() => verifyGroupTopUp(GROUP, { ...topUp, recipient: ben.publicKey })).toThrow(/signature/);
        expect(() => verifyGroupTopUp('another-group', topUp)).toThrow(/signature/);
        expect(() => verifyGroupTopUp(GROUP, { ...topUp, epoch: 3 })).toThrow(/signature/);
        expect(() => verifyGroupTopUp(GROUP, { ...topUp, wrapper: ben.publicKey })).toThrow(/signature/);
        expect(() => verifyGroupTopUp(GROUP, { ...topUp, wrapped: flip(topUp.wrapped) })).toThrow(/signature/);
    });
});

describe('lines', () => {
    const { groupKey } = epoch2();
    const seal = (text: string, over: Partial<Parameters<typeof sealGroupLine>[1]> = {}) =>
        sealGroupLine(text, { myEdPrivHex: ben.seedHex, groupKey, groupId: GROUP, epoch: 2, messageId: MSG, ...over });

    it('opens with the right binding and refuses every changed one', () => {
        const line = seal('see you at the hall', { after: OTHER_MSG });
        expect(openGroupLine(line, refOf(ben), groupKey)).toEqual({ text: 'see you at the hall', after: OTHER_MSG });
        const fails = (over: Partial<GroupLineBinding>) => expect(() => openGroupLine(line, refOf(ben, over), groupKey)).toThrow(GroupLineNotVerifiedError);
        fails({ groupId: 'another-group' });
        fails({ epoch: 3 });
        fails({ senderPubHex: ana.publicKey });
        fails({ messageId: OTHER_MSG });
        fails({ part: 'attachment' });
        fails({ part: 'edit' });
        fails({ replyToId: OTHER_MSG });
    });

    it('a reply opens only as an answer to the message it answers', () => {
        const line = seal('yes', { replyToId: OTHER_MSG });
        expect(openGroupLine(line, refOf(ben, { replyToId: OTHER_MSG }), groupKey).text).toBe('yes');
        expect(() => openGroupLine(line, refOf(ben, { replyToId: null }), groupKey)).toThrow(GroupLineNotVerifiedError);
        expect(() => openGroupLine(line, refOf(ben, { replyToId: MSG }), groupKey)).toThrow(GroupLineNotVerifiedError);
    });

    it('refuses a changed nonce or ciphertext, and a line under another epoch\'s key', () => {
        const line = seal('hi');
        const n = line.nonce.slice(GROUP_NONCE_PREFIX.length);
        expect(() => openGroupLine({ ...line, nonce: GROUP_NONCE_PREFIX + flip(n) }, refOf(ben), groupKey)).toThrow(GroupLineNotVerifiedError);
        expect(() => openGroupLine({ ...line, ciphertext: flip(line.ciphertext, 5) }, refOf(ben), groupKey)).toThrow(GroupLineNotVerifiedError);
        expect(() => openGroupLine({ ...line, nonce: DM_NONCE_PREFIX + n }, refOf(ben), groupKey)).toThrow(GroupLineNotVerifiedError);
        expect(() => openGroupLine(line, refOf(ben), new Uint8Array(32).fill(3))).toThrow(GroupLineNotVerifiedError);
    });

    it('refuses a line whose signature was cut out or swapped for another line\'s, though it was sealed under the right key', () => {
        const line = seal('original words');
        const frame = frameOf(line, refOf(ben), groupKey);
        // Cut: the frame without its 64 signature bytes, re-sealed by a member who holds the epoch key.
        const cut = concatBytes(frame.subarray(0, 1), frame.subarray(65));
        expect(() => openGroupLine(resealFrame(cut, refOf(ben), groupKey), refOf(ben), groupKey)).toThrow(GroupLineNotVerifiedError);
        // Zeroed signature.
        const zeroed = frame.slice();
        zeroed.fill(0, 1, 65);
        expect(() => openGroupLine(resealFrame(zeroed, refOf(ben), groupKey), refOf(ben), groupKey)).toThrow(GroupLineNotVerifiedError);
        // Swapped: Ben's genuine signature from another of his lines glued onto these words.
        const other = seal('other words', { messageId: OTHER_MSG });
        const otherFrame = frameOf(other, refOf(ben, { messageId: OTHER_MSG }), groupKey);
        const swapped = concatBytes(frame.subarray(0, 1), otherFrame.subarray(1, 65), frame.subarray(65));
        expect(() => openGroupLine(resealFrame(swapped, refOf(ben), groupKey), refOf(ben), groupKey)).toThrow(GroupLineNotVerifiedError);
        // Ben's own signed frame, re-sealed under a new nonce: the signature covers the nonce too.
        expect(() => openGroupLine(resealFrame(frame, refOf(ben), groupKey), refOf(ben), groupKey)).toThrow(GroupLineNotVerifiedError);
    });

    it('a member cannot frame another (§18 item 7): Ana seals a line naming Ben as sender, under the key they all hold', () => {
        // Ana holds the epoch key, so the AEAD opens; she can only sign as herself.
        const binding = refOf(ben, { messageId: OTHER_MSG });
        const nonce = new Uint8Array(24).fill(4);
        const aad = gc.groupLineAad(binding);
        const words = utf8ToBytes('I quit the group, it is rubbish');
        const unsigned = new Uint8Array([1, 0, ...words]);
        const anaSig = ed25519.sign(sha256(concatBytes(aad, nonce, unsigned)), hexToBytes(ana.seedHex));
        const framed = resealFrame(concatBytes(unsigned.subarray(0, 1), anaSig, unsigned.subarray(1)), binding, groupKey, nonce);
        expect(() => openGroupLine(framed, binding, groupKey)).toThrow(GroupLineNotVerifiedError);
        // …and shown as hers, it doesn't open either: the associated data names Ben.
        expect(() => openGroupLine(framed, { ...binding, senderPubHex: ana.publicKey }, groupKey)).toThrow(GroupLineNotVerifiedError);
        // Re-sealing Ben's real words under another id or group, with his real signature, fails too.
        const real = seal('real words');
        const realFrame = frameOf(real, refOf(ben), groupKey);
        expect(() => openGroupLine(resealFrame(realFrame, binding, groupKey), binding, groupKey)).toThrow(GroupLineNotVerifiedError);
        // And sealGroupLine will not write a line as anyone but the key that signs it.
        const asAna = sealGroupLine('x', { myEdPrivHex: ana.seedHex, groupKey, groupId: GROUP, epoch: 2, messageId: OTHER_MSG });
        expect(() => openGroupLine(asAna, binding, groupKey)).toThrow(GroupLineNotVerifiedError);
    });

    it("one line's message key opens that line and nothing else (§7.1: what a report discloses)", () => {
        const one = seal('reported words');
        const two = seal('private words', { messageId: OTHER_MSG });
        const mk = groupMessageKey(groupKey, MSG);
        expect(openGroupLineWithMessageKey(one, refOf(ben), mk).text).toBe('reported words');
        expect(() => openGroupLineWithMessageKey(two, refOf(ben, { messageId: OTHER_MSG }), mk)).toThrow(GroupLineNotVerifiedError);
        expect(bytesToHex(mk)).not.toBe(bytesToHex(groupMessageKey(groupKey, OTHER_MSG)));
    });

    it('a photo and an edit are separate parts of the same message', () => {
        const photo = seal('data:image/jpeg;base64,AAAA', { part: 'attachment' });
        expect(openGroupLine(photo, refOf(ben, { part: 'attachment' }), groupKey).text).toBe('data:image/jpeg;base64,AAAA');
        expect(() => openGroupLine(photo, refOf(ben), groupKey)).toThrow(GroupLineNotVerifiedError);
        // An edit under a later epoch (§7.4): opens with that epoch's key only.
        const later = makeGroupEpochRecord({ myEdPrivHex: ana.seedHex, groupId: GROUP, epoch: 3, reason: 'rotate', createdAt: AT, recipients: [ana.publicKey, ben.publicKey] });
        const edit = sealGroupLine('edited', { myEdPrivHex: ben.seedHex, groupKey: later.groupKey, groupId: GROUP, epoch: 3, messageId: MSG, part: 'edit', after: MSG });
        expect(openGroupLine(edit, refOf(ben, { epoch: 3, part: 'edit' }), later.groupKey)).toEqual({ text: 'edited', after: MSG });
        expect(() => openGroupLine(edit, refOf(ben, { epoch: 3, part: 'edit' }), groupKey)).toThrow(GroupLineNotVerifiedError);
    });

    it('words of every size, empty included, and non-Latin text round-trip', () => {
        for (const text of ['', 'ok', '🌱 ਸਤ ਸ੍ਰੀ ਅਕਾਲ — مرحبا', 'x'.repeat(2000)]) {
            expect(openGroupLine(seal(text), refOf(ben), groupKey).text).toBe(text);
        }
    });

    it('refuses to seal under an id the node would store differently', () => {
        expect(() => seal('x', { messageId: MSG.toUpperCase() })).toThrow(/UUID v4/);
        expect(() => seal('x', { messageId: 'not-a-uuid' })).toThrow(/UUID v4/);
        expect(() => seal('x', { groupKey: new Uint8Array(16) })).toThrow();
        expect(() => seal('x', { part: 'reaction' as unknown as 'body' })).toThrow();
    });
});

describe('the wire form', () => {
    const { groupKey } = epoch2();
    const line = sealGroupLine('hi', { myEdPrivHex: ben.seedHex, groupKey, groupId: GROUP, epoch: 2, messageId: MSG });

    it('is not the DM prefix, so neither app\'s DM guard takes a group for a DM', () => {
        expect(GROUP_NONCE_PREFIX).toBe('group-xc20p-v1:');
        expect(line.nonce.startsWith(GROUP_NONCE_PREFIX)).toBe(true);
        expect(isDmEncryptedNonce(line.nonce)).toBe(false);
        expect(isGroupEncryptedNonce(line.nonce)).toBe(true);
        expect(isGroupEncryptedNonce(DM_NONCE_PREFIX + 'AAAA')).toBe(false);
    });

    it("the node's keyless shape check accepts a sealed line and refuses the rest", () => {
        expect(isGroupEncryptedPayload(line)).toBe(true);
        expect(isGroupEncryptedPayload({ ...line, nonce: DM_NONCE_PREFIX + line.nonce.slice(GROUP_NONCE_PREFIX.length) })).toBe(false);
        expect(isGroupEncryptedPayload({ ...line, nonce: GROUP_NONCE_PREFIX + Buffer.alloc(23).toString('base64') })).toBe(false);
        expect(isGroupEncryptedPayload({ ...line, ciphertext: Buffer.alloc(81).toString('base64') })).toBe(false);
        expect(isGroupEncryptedPayload({ ...line, ciphertext: Buffer.from('hello').toString('base64') })).toBe(false);
        expect(isGroupEncryptedPayload({ ciphertext: line.ciphertext, nonce: 'plaintext-v1' })).toBe(false);
        expect(isGroupEncryptedPayload(null)).toBe(false);
    });
});

describe('mentions, moved from the node', () => {
    const alice = 'a'.repeat(64);
    const bob = 'b'.repeat(64);
    it('finds "@callsign" at a word boundary, in any case, with spaces in callsigns', () => {
        expect(detectMentions('hey @Alice, lunch?', [{ pubkey: alice, callsign: 'alice' }, { pubkey: bob, callsign: 'Bob' }])).toEqual([alice]);
        expect(detectMentions('email@alice.com', [{ pubkey: alice, callsign: 'alice' }])).toEqual([]);
        expect(detectMentions('hi @Alicette', [{ pubkey: alice, callsign: 'Alice' }])).toEqual([]);
        expect(detectMentions('ping @Mary Jane!', [{ pubkey: bob, callsign: 'Mary Jane' }])).toEqual([bob]);
        expect(detectMentions('@a hi', [{ pubkey: alice, callsign: 'a' }])).toEqual([]);
        expect(detectMentions('@ALICE @alice', [{ pubkey: alice, callsign: 'Alice' }])).toEqual([alice]);
    });
});

describe('the core barrel', () => {
    it('exports the group locks for both apps', () => {
        for (const name of ['sealGroupLine', 'openGroupLine', 'makeGroupEpochRecord', 'openGroupEpochRecord', 'verifyGroupEpochRecord',
            'makeGroupTopUp', 'openGroupTopUp', 'groupMessageKey', 'detectMentions', 'isGroupEncryptedPayload', 'identityX25519Secret']) {
            expect(typeof (core as Record<string, unknown>)[name]).toBe('function');
        }
        expect(core.GROUP_NONCE_PREFIX).toBe('group-xc20p-v1:');
    });
});

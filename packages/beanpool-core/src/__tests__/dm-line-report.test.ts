/**
 * The sender's signature over a sealed direct-message line, and what a reporter hands over (dm-line-report.ts). The digest
 * is re-derived here from the primitives, and one signature is frozen: a change that stops it verifying has broken every
 * line already signed, and a report of any of them. Fix the change, never the vector.
 */
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
    DM_LINE_SIG_TAG, DM_REPORT_WORDS_MAX, dmLineDisclosureFor, dmLineDisclosureOf, dmLineSigDigest, dmLineSigInMetadata, dmLineSigVerifies,
    dmLineSignedBy, signDmLine, type DmLineSigBinding,
} from '../dm-line-report.js';
import { toEd25519Pkcs8 } from '../ed25519-key.js';

const seed = (name: string) => sha256(utf8ToBytes(`beanpool dm-line vector: ${name}`));
const pub = (s: Uint8Array) => bytesToHex(ed25519.getPublicKey(s));
const ana = { seed: seed('Ana'), seedHex: bytesToHex(seed('Ana')), pkcs8Hex: bytesToHex(toEd25519Pkcs8(seed('Ana'))), pub: pub(seed('Ana')) };
const ben = { seedHex: bytesToHex(seed('Ben')), pub: pub(seed('Ben')) };
const cat = { seedHex: bytesToHex(seed('Cat')), pub: pub(seed('Cat')) };

const line = { ciphertext: 'c2VhbGVkIGJ5dGVz', nonce: 'x25519-xc20p-v2:bm9uY2Ugbm9uY2Ugbm9uY2Ugbm9uY2U=' };
const binding: DmLineSigBinding = {
    conversationId: '6f1d3c2a-9b8e-4c7d-a6f5-e4d3c2b1a090', senderPubHex: ana.pub, recipientPubHex: ben.pub,
    messageId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', at: '2026-11-01T00:00:00.000Z',
};
const FROZEN_SIG = 'z8iytajFvCE9k8QL7mSTBrGlBjD5HYElIHwOCydrHPdMAjmWyFPwIGt4yO5nPdeRwSjN/nHYUnYo10q9scB/DQ==';

describe('the sender\'s signature', () => {
    it('signs the digest the design names, re-derived from the primitives', () => {
        const sealed = bytesToHex(sha256(utf8ToBytes(line.ciphertext)));
        const expected = sha256(utf8ToBytes(JSON.stringify([
            DM_LINE_SIG_TAG, binding.conversationId, ana.pub, ben.pub, binding.messageId, binding.at, line.nonce, sealed,
        ])));
        expect(bytesToHex(dmLineSigDigest(line, binding))).toBe(bytesToHex(expected));
        const { sig } = signDmLine(line, ana.seedHex, binding);
        expect(ed25519.verify(Uint8Array.from(Buffer.from(sig, 'base64')), expected, ed25519.getPublicKey(ana.seed), { zip215: false })).toBe(true);
    });

    it('a signature made once still verifies (frozen)', () => {
        expect(signDmLine(line, ana.seedHex, binding).sig).toBe(FROZEN_SIG);
        expect(dmLineSigVerifies(line, { sig: FROZEN_SIG, at: binding.at }, binding)).toBe(true);
    });

    it('the phone\'s seed and the web app\'s PKCS8 key sign alike', () => {
        expect(signDmLine(line, ana.pkcs8Hex, binding)).toEqual(signDmLine(line, ana.seedHex, binding));
    });

    it('refuses to sign as anyone else', () => {
        expect(() => signDmLine(line, ben.seedHex, binding)).toThrow(/only as its sender/);
    });

    it('verifies for nothing but this line, this sender, this recipient, this id and this time', () => {
        const s = signDmLine(line, ana.seedHex, binding);
        expect(dmLineSigVerifies(line, s, binding)).toBe(true);
        expect(dmLineSigVerifies({ ...line, ciphertext: 'b3RoZXI=' }, s, binding)).toBe(false);
        expect(dmLineSigVerifies({ ...line, nonce: 'x25519-xc20p-v2:b3RoZXI=' }, s, binding)).toBe(false);
        expect(dmLineSigVerifies(line, s, { ...binding, senderPubHex: ben.pub })).toBe(false);
        expect(dmLineSigVerifies(line, s, { ...binding, recipientPubHex: cat.pub })).toBe(false);
        expect(dmLineSigVerifies(line, s, { ...binding, messageId: '1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' })).toBe(false);
        expect(dmLineSigVerifies(line, s, { ...binding, conversationId: 'another' })).toBe(false);
        expect(dmLineSigVerifies(line, { ...s, at: '2026-11-02T00:00:00.000Z' }, binding)).toBe(false);
    });

    it('never throws on a signature of the wrong shape, and takes no second spelling of one', () => {
        const s = signDmLine(line, ana.seedHex, binding);
        for (const sig of ['', 'not base64!', 'AAAA', `${s.sig}A`, s.sig.replace(/=+$/, '')]) {
            expect(dmLineSigVerifies(line, { ...s, sig }, binding)).toBe(false);
        }
    });
});

describe('who signed it', () => {
    const s = signDmLine(line, ana.seedHex, binding);
    const to = { conversationId: binding.conversationId, recipients: [ben.pub], messageId: binding.messageId };

    it('finds the signer among the keys it is given, and only there', () => {
        expect(dmLineSignedBy(line, s, to, [cat.pub, ana.pub])).toEqual({ conversationId: binding.conversationId, signer: ana.pub });
        expect(dmLineSignedBy(line, s, to, [cat.pub])).toBeNull();
        expect(dmLineSignedBy(line, null, to, [ana.pub])).toBeNull();
    });

    it('takes a key a member had before a re-key, on either side', () => {
        expect(dmLineSignedBy(line, s, { ...to, recipients: ['aa'.repeat(32), ben.pub] }, [cat.pub, ana.pub])?.signer).toBe(ana.pub);
    });

    it('takes an older conversation id the line\'s metadata names, as sealing does', () => {
        const moved = { ...to, conversationId: 'the-one-it-moved-to', metadata: JSON.stringify({ originalConversationId: binding.conversationId }) };
        expect(dmLineSignedBy(line, s, moved, [ana.pub])).toEqual({ conversationId: binding.conversationId, signer: ana.pub });
    });
});

describe('what a reporter hands over', () => {
    const lineSig = signDmLine(line, ana.seedHex, binding);
    const held = { ...line, conversationId: binding.conversationId, metadata: JSON.stringify({ lineSig, replyToId: 'x' }) };

    it('is the sealed line, its signature and the words: no key, no other field', () => {
        expect(dmLineDisclosureFor(held, 'what it said')).toEqual({ v: 1, ...line, conversationId: binding.conversationId, lineSig, words: 'what it said' });
    });

    it('a line from an older app hands over no signature', () => {
        expect(dmLineDisclosureFor({ ...held, metadata: null }, 'x').lineSig).toBeNull();
    });

    it('cuts long words to the limit, so a long line can still be reported', () => {
        expect(dmLineDisclosureFor(held, 'y'.repeat(DM_REPORT_WORDS_MAX + 5)).words).toHaveLength(DM_REPORT_WORDS_MAX);
    });

    it('reads a signature from metadata as stored, a string or parsed, and nothing else as one', () => {
        expect(dmLineSigInMetadata(held.metadata)).toEqual(lineSig);
        expect(dmLineSigInMetadata({ lineSig })).toEqual(lineSig);
        for (const m of [null, undefined, '', 'not json', '{}', { lineSig: 'x' }, { lineSig: { sig: 1, at: 'x' } }]) expect(dmLineSigInMetadata(m)).toBeNull();
    });

    it('the node takes only the shape it knows', () => {
        const good = dmLineDisclosureFor(held, 'w');
        expect(dmLineDisclosureOf(good)).toEqual(good);
        expect(dmLineDisclosureOf({ ...good, mk: 'a key nobody asked for' })).toEqual(good);
        for (const bad of [null, [], {}, { ...good, v: 2 }, { ...good, nonce: 'plaintext-v1' }, { ...good, ciphertext: '' }, { ...good, conversationId: 1 },
            { ...good, words: 1 }, { ...good, words: 'z'.repeat(DM_REPORT_WORDS_MAX + 1) }, { ...good, lineSig: 'x' }]) {
            expect(dmLineDisclosureOf(bad)).toBeNull();
        }
    });
});

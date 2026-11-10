/**
 * The sender's signature beside a sealed direct-message line (dm-crypto.ts format 4), and what a reporter hands over
 * (dm-line-report.ts). The digest is re-derived here from the primitives, and the frozen lines of dm-line-vectors.ts carry
 * signatures made once: a change that stops them verifying has broken every line already signed, and a report of any of
 * them. Fix the change, never the vector.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { DM_LINE_SIG_TAG, dmLineSigDigest, dmLineSigOf, dmLineSigVerifies, newDmMessageId, sealDmLine } from '../dm-crypto.js';
import { DM_LINE_SIG_IDS_MAX, DM_REPORT_WORDS_MAX, dmLineDisclosureFor, dmLineDisclosureOf, dmLineSignedBy } from '../dm-line-report.js';
import { DM_LINE_VECTORS, DM_VECTOR_CONVERSATION, DM_VECTOR_PEOPLE } from '../dm-line-vectors.js';
import { requestReportNotSentWords, requestReportRefused } from '../dm-requests.js';
import { busyError, isBusyError } from '../busy-answer.js';

// ed25519 is frozen, so the verifies are counted here: every other use of it passes through unchanged.
const verifies = vi.hoisted(() => ({ n: 0 }));
vi.mock('@noble/curves/ed25519.js', async (actual) => {
    const real = await actual<typeof import('@noble/curves/ed25519.js')>();
    return {
        ...real,
        ed25519: { ...real.ed25519, verify: (...args: Parameters<typeof real.ed25519.verify>) => { verifies.n++; return real.ed25519.verify(...args); } },
    };
});

const seed = (name: string) => sha256(utf8ToBytes(`beanpool dm-line vector: ${name}`));
const pub = (s: Uint8Array) => bytesToHex(ed25519.getPublicKey(s));
const ana = { seedHex: bytesToHex(seed('Ana')), pub: pub(seed('Ana')) };
const ben = { seedHex: bytesToHex(seed('Ben')), pub: pub(seed('Ben')) };
const cat = { seedHex: bytesToHex(seed('Cat')), pub: pub(seed('Cat')) };
const CONV = '6f1d3c2a-9b8e-4c7d-a6f5-e4d3c2b1a090';

/** A fresh line of Ana's to Ben, sealed and signed as her app does: never seen by the verify memo before. */
function anasLine(conversationId = CONV) {
    const messageId = newDmMessageId();
    const sealed = sealDmLine('Meet at the gate', { myEdPrivHex: ana.seedHex, peerEdPubHex: ben.pub, conversationId }, { senderPubHex: ana.pub, messageId });
    return { ...sealed, messageId };
}

describe('the sender\'s signature', () => {
    it('signs the digest the design names, re-derived from the primitives', () => {
        const sealed = utf8ToBytes('sealed bytes');
        const nonce = 'x25519-xc20p-v2:bm9uY2Ugbm9uY2Ugbm9uY2Ugbm9uY2U=';
        const b = { conversationId: CONV, senderPubHex: ana.pub, recipientPubHex: ben.pub, messageId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', part: 'body' as const, at: '2026-11-01T00:00:00.000Z' };
        const expected = sha256(utf8ToBytes(JSON.stringify([
            DM_LINE_SIG_TAG, b.conversationId, ana.pub, ben.pub, b.messageId, 'body', b.at, nonce, bytesToHex(sha256(sealed)),
        ])));
        expect(DM_LINE_SIG_TAG).toBe('beanpool-dm-line-sig/2');
        expect(bytesToHex(dmLineSigDigest(nonce, sealed, b))).toBe(bytesToHex(expected));
    });

    it('the signatures frozen in the vectors still verify, as their sender\'s, to the other person', () => {
        for (const v of DM_LINE_VECTORS) {
            const from = DM_VECTOR_PEOPLE[v.from];
            const to = DM_VECTOR_PEOPLE[v.from === 'ana' ? 'ben' : 'ana'];
            expect(dmLineSigVerifies(v.payload, { conversationId: DM_VECTOR_CONVERSATION, senderPubHex: from.publicKey, recipientPubHex: to.publicKey, messageId: v.messageId, part: v.part })).toBe(true);
            expect(dmLineSigOf(v.payload.ciphertext)?.at).toBe(v.at);
        }
    });

    it('verifies for nothing but this line, this sender, this recipient, this id, this part and this conversation', () => {
        const l = anasLine();
        const b = { conversationId: CONV, senderPubHex: ana.pub, recipientPubHex: ben.pub, messageId: l.messageId, part: 'body' as const };
        expect(dmLineSigVerifies(l, b)).toBe(true);
        expect(dmLineSigVerifies({ ...l, nonce: 'x25519-xc20p-v2:b3RoZXIgb3RoZXIgb3RoZXIgb3RoZXI=' }, b)).toBe(false);
        expect(dmLineSigVerifies(l, { ...b, senderPubHex: ben.pub })).toBe(false);
        expect(dmLineSigVerifies(l, { ...b, recipientPubHex: cat.pub })).toBe(false);
        expect(dmLineSigVerifies(l, { ...b, messageId: newDmMessageId() })).toBe(false);
        expect(dmLineSigVerifies(l, { ...b, part: 'attachment' })).toBe(false);
        expect(dmLineSigVerifies(l, { ...b, conversationId: 'another' })).toBe(false);
    });

    it('never throws on a column of the wrong shape, and takes no second spelling of one', () => {
        const l = anasLine();
        const b = { conversationId: CONV, senderPubHex: ana.pub, recipientPubHex: ben.pub, messageId: l.messageId, part: 'body' as const };
        for (const ciphertext of ['', 'not base64!', 'AAAA', `${l.ciphertext}A`, l.ciphertext.replace(/=+$/, ''), Buffer.from('sealed bytes').toString('base64')]) {
            if (ciphertext === l.ciphertext) continue;
            expect(dmLineSigVerifies({ ...l, ciphertext }, b)).toBe(false);
        }
        expect(dmLineSigVerifies({ ...l, ciphertext: undefined as unknown as string }, b)).toBe(false);
    });
});

describe('who signed it', () => {
    const l = anasLine();
    const to = { conversationId: CONV, recipients: [ben.pub], messageId: l.messageId };

    it('finds the signer among the keys it is given, and only there', () => {
        expect(dmLineSignedBy(l, to, [cat.pub, ana.pub])).toEqual({ conversationId: CONV, signer: ana.pub });
        expect(dmLineSignedBy(l, to, [cat.pub])).toBeNull();
        // A line of an older format carries no signature in its column.
        expect(dmLineSignedBy({ ...l, ciphertext: Buffer.from('sealed bytes, format 3').toString('base64') }, to, [ana.pub])).toBeNull();
    });

    it('takes a key a member had before a re-key, on either side', () => {
        expect(dmLineSignedBy(l, { ...to, recipients: ['aa'.repeat(32), ben.pub] }, [cat.pub, ana.pub])?.signer).toBe(ana.pub);
    });

    it('takes an older conversation id the line\'s metadata names, as sealing does', () => {
        const moved = { ...to, conversationId: 'the-one-it-moved-to', metadata: JSON.stringify({ originalConversationId: CONV }) };
        expect(dmLineSignedBy(l, moved, [ana.pub])).toEqual({ conversationId: CONV, signer: ana.pub });
    });

    // The deciding review of #2705: the sender writes this list, and each id is a verify on the node's main thread.
    describe('a line that names too many conversation ids', () => {
        const listing = (...ids: string[]) => JSON.stringify({ originalConversationIds: ids });
        const many = Array.from({ length: 11_000 }, (_, i) => `id-${i}`);
        // A line the verify memo has never seen, so every verify is counted.
        let fresh = anasLine();
        beforeEach(() => { fresh = anasLine(); verifies.n = 0; });
        const toFresh = () => ({ conversationId: CONV, recipients: [ben.pub], messageId: fresh.messageId });

        it('costs the cap\'s verifies however many it lists, for each signer and recipient', () => {
            const nowhere = { ...toFresh(), conversationId: 'stored-here', metadata: listing(...many) };
            expect(dmLineSignedBy(fresh, nowhere, [ana.pub])).toBeNull();
            expect(verifies.n).toBe(DM_LINE_SIG_IDS_MAX);
            verifies.n = 0;
            expect(dmLineSignedBy(fresh, { ...nowhere, recipients: [ben.pub, cat.pub] }, [ana.pub, cat.pub])).toBeNull();
            expect(verifies.n).toBe(DM_LINE_SIG_IDS_MAX * 2 * 2);
        });

        it('still verifies under the line\'s own id, the repair\'s list beside it: one verify', () => {
            expect(dmLineSignedBy(fresh, { ...toFresh(), metadata: listing(...many) }, [ana.pub])?.signer).toBe(ana.pub);
            expect(verifies.n).toBe(1);
            // Remembered once verified: the moderator opening the report a second later verifies nothing again.
            expect(dmLineSignedBy(fresh, { ...toFresh(), metadata: listing(...many) }, [ana.pub])?.signer).toBe(ana.pub);
            expect(verifies.n).toBe(1);
        });

        it('takes the one id a fold names, and an id only past the cap reads as not verified', () => {
            const atThe = (ids: string[]) => dmLineSignedBy(fresh, { ...toFresh(), conversationId: 'stored-here', metadata: listing(...ids) }, [ana.pub]);
            expect(atThe([CONV, 'x'])?.conversationId).toBe(CONV);
            expect(atThe(['x', CONV])).toBeNull();
        });
    });
});

describe('what a reporter hands over', () => {
    const l = anasLine();
    const held = { ciphertext: l.ciphertext, nonce: l.nonce, conversationId: CONV };

    it('is the line as the node carries it, its signature in it, and the words: no key, no other field', () => {
        expect(dmLineDisclosureFor(held, 'what it said')).toEqual({ v: 1, ...held, words: 'what it said' });
        expect(dmLineSigOf(dmLineDisclosureFor(held, 'x').ciphertext)).not.toBeNull();
    });

    it('cuts long words to the limit, so a long line can still be reported', () => {
        expect(dmLineDisclosureFor(held, 'y'.repeat(DM_REPORT_WORDS_MAX + 5)).words).toHaveLength(DM_REPORT_WORDS_MAX);
    });

    it('the node takes only the shape it knows', () => {
        const good = dmLineDisclosureFor(held, 'w');
        expect(dmLineDisclosureOf(good)).toEqual(good);
        expect(dmLineDisclosureOf({ ...good, mk: 'a key nobody asked for' })).toEqual(good);
        // A signature handed beside the line, as 1.3.x apps did, is no part of a disclosure: dropped, never read.
        expect(dmLineDisclosureOf({ ...good, lineSig: { sig: 'x', at: 'y' } })).toEqual(good);
        for (const bad of [null, [], {}, { ...good, v: 2 }, { ...good, nonce: 'plaintext-v1' }, { ...good, ciphertext: '' }, { ...good, conversationId: 1 },
            { ...good, words: 1 }, { ...good, words: 'z'.repeat(DM_REPORT_WORDS_MAX + 1) }]) {
            expect(dmLineDisclosureOf(bad)).toBeNull();
        }
    });
});

describe('Report on a request, when no report went', () => {
    it('reads a refusal by the node as one the block goes on from, and no answer as one to try again', () => {
        expect(requestReportRefused({ status: 429 })).toBe('over_limit');
        for (const status of [400, 401, 403, 404]) expect(requestReportRefused({ status })).toBe('refused');
        for (const e of [new Error('Network request failed'), { status: 500 }, { status: 502 }, { status: 0 }, { status: '404' }, null, undefined]) {
            expect(requestReportRefused(e)).toBeNull();
        }
    });

    // Deciding review of #2960 (round 2): a busy network's 429 (Cloudflare in front of the node) was read as the moderators'
    // hourly limit, so Report on a request blocked the sender with NO report (Child safety included) and said "You have sent a
    // lot of reports recently". It is no answer from the node: it throws, the card stays, and a second try sends the report.
    it('a busy network is no answer from the node: no over_limit, no block without the report', () => {
        expect(requestReportRefused(busyError(null))).toBeNull();
        expect(requestReportRefused(busyError('7'))).toBeNull();
        // The code says busy, whatever else the error carries.
        expect(requestReportRefused(Object.assign(new Error('x'), { code: 'busy', status: 429, nodeAnswered: false }))).toBeNull();
    });

    it("the node's own report limit (its JSON 429) is no busy error and stays over_limit", () => {
        const own = Object.assign(new Error('You have sent a lot of reports recently.'), { status: 429, code: 'rate_limited', nodeAnswered: true });
        expect(isBusyError(own)).toBe(false);
        expect(requestReportRefused(own)).toBe('over_limit');
        expect(requestReportRefused({ status: 429, code: 'rate_limited' })).toBe('over_limit');
    });

    it('says why in a sentence of its own for each, and that they are blocked', () => {
        const words = (['over_limit', 'refused', 'no_line'] as const).map(requestReportNotSentWords);
        expect(new Set(words).size).toBe(3);
        for (const w of words) expect(w).toMatch(/They are blocked\.$/);
    });

    // The deciding review of #2705: with no line left, or one the node refuses, the block reports the person. Over the hourly
    // limit nothing goes, and only that sentence may say so.
    it('says a report of the person goes when one does, and that none did only over the limit', () => {
        expect(requestReportNotSentWords('no_line')).toBe('That message was deleted, so your report of them goes without its words. They are blocked.');
        expect(requestReportNotSentWords('refused')).toBe('Your community did not take that message, so your report of them goes without its words. They are blocked.');
        expect(requestReportNotSentWords('over_limit')).toBe('You have sent a lot of reports recently, so this one did not go. They are blocked.');
    });
});

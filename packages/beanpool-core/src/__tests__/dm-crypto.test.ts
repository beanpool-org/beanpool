import { describe, it, expect } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import * as dm from '../dm-crypto.js';
import {
    checkDmThread, dmAfterReference, dmConversationIdsToTry, dmLineMarkText, encryptDmFormat2, newDmMessageId, openDmLine, sealDmLine,
    DM_LINE_NOT_VERIFIED_TEXT, type DmThreadLine,
} from '../dm-crypto.js';
import { toEd25519Pkcs8 } from '../ed25519-key.js';
import { checkDmLineVectors, DM_LINE_VECTORS, DM_VECTOR_CONVERSATION, DM_VECTOR_PEOPLE } from '../dm-line-vectors.js';

// A direct message is bound to who sent it, which message it is and where (crypto review M F2, 2026-10-02). Until now its
// associated data was the conversation id alone, under one key both ways, so the node could show Ana's line as Ben's,
// store it again as a new message, or reorder it, and the other phone showed every one as genuine.

function person(name: string) {
    const seed = sha256(utf8ToBytes(`dm-crypto.test ${name}`));
    return { seedHex: bytesToHex(seed), publicKey: bytesToHex(ed25519.getPublicKey(seed)) };
}
const ana = person('Ana');
const ben = person('Ben');
const cat = person('Cat');
const CONV = 'c0ffee00-1111-4222-8333-444455556666';
const ctxOf = (me: { seedHex: string }, peer: { publicKey: string }, conversationId = CONV) =>
    ({ myEdPrivHex: me.seedHex, peerEdPubHex: peer.publicKey, conversationId });
const keysOf = (me: { seedHex: string }, peer: { publicKey: string }) => ({ myEdPrivHex: me.seedHex, peerEdPubHex: peer.publicKey });

/** A line as the sender's app writes it and the node stores it. */
function line(from: typeof ana, to: typeof ana, text: string, after: string | null = null, conversationId = CONV): DmThreadLine {
    const id = newDmMessageId();
    const sealed = sealDmLine(text, ctxOf(from, to, conversationId), { senderPubHex: from.publicKey, messageId: id, after });
    return { id, authorPubkey: from.publicKey, ...sealed };
}
/** A line written before this change, in format 2. */
function oldLine(from: typeof ana, to: typeof ana, text: string, id = newDmMessageId()): DmThreadLine {
    return { id, authorPubkey: from.publicKey, ...encryptDmFormat2(text, ctxOf(from, to)) };
}
const benReads = (lines: DmThreadLine[]) => checkDmThread(lines, keysOf(ben, ana), CONV);

describe('the frozen vectors', () => {
    it('seal and open the same bytes, and refuse every changed binding', () => {
        checkDmLineVectors(dm);
    });

    it('format 3 is what the comment says it is, re-derived from the primitives without dm-crypto.ts', () => {
        const v = DM_LINE_VECTORS[0];
        const a = DM_VECTOR_PEOPLE.ana;
        const b = DM_VECTOR_PEOPLE.ben;
        const shared = x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(hexToBytes(a.seedHex)), ed25519.utils.toMontgomery(hexToBytes(b.publicKey)));
        const key = hkdf(sha256, shared, utf8ToBytes(DM_VECTOR_CONVERSATION), utf8ToBytes('beanpool-dm-v2'), 32);
        const aad = utf8ToBytes(`["beanpool-dm-line/3","${DM_VECTOR_CONVERSATION}","${a.publicKey}","${v.messageId}","body"]`);
        const after = utf8ToBytes(v.after!);
        const words = utf8ToBytes(v.text);
        const plain = new Uint8Array([3, after.length, ...after, ...words]);
        const ct = xchacha20poly1305(key, v.nonce, aad).encrypt(plain);
        expect(Buffer.from(ct).toString('base64')).toBe(v.payload.ciphertext);
        expect(v.payload.nonce).toBe('x25519-xc20p-v2:' + Buffer.from(v.nonce).toString('base64'));
    });
});

describe('sealing', () => {
    it('only as myself, and only under a lower-case UUID v4 (the id the node will store)', () => {
        const id = newDmMessageId();
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(() => sealDmLine('hi', ctxOf(ana, ben), { senderPubHex: ben.publicKey, messageId: id })).toThrow(/only as its sender/);
        expect(() => sealDmLine('hi', ctxOf(ana, ben), { senderPubHex: ana.publicKey, messageId: id.toUpperCase() })).toThrow(/UUID v4/);
        expect(() => sealDmLine('hi', ctxOf(ana, ben), { senderPubHex: ana.publicKey, messageId: 'msg-1' })).toThrow(/UUID v4/);
    });

    it('a web app key (PKCS8) seals what the phone\'s bare seed seals: the same bytes', () => {
        const id = newDmMessageId();
        const nonce = new Uint8Array(24).fill(7);
        const pkcs8 = bytesToHex(toEd25519Pkcs8(hexToBytes(ana.seedHex)));
        const fromSeed = sealDmLine('hi', ctxOf(ana, ben), { senderPubHex: ana.publicKey, messageId: id }, nonce);
        const fromPkcs8 = sealDmLine('hi', { ...ctxOf(ana, ben), myEdPrivHex: pkcs8 }, { senderPubHex: ana.publicKey, messageId: id }, nonce);
        expect(fromPkcs8).toEqual(fromSeed);
    });

    it('the node sees nothing of the words, and the nonce column keeps the form every node accepts', () => {
        const l = line(ana, ben, 'the gate code is 4471', null);
        expect(l.nonce).toMatch(/^x25519-xc20p-v2:[A-Za-z0-9+/]{32}$/);
        expect(Buffer.from(l.ciphertext, 'base64').toString('latin1')).not.toContain('4471');
    });
});

describe('what the node can do to a line now', () => {
    it('re-attribute Ana\'s line as Ben\'s: it doesn\'t open, and is never shown as his words', () => {
        const l = line(ana, ben, 'I will pay you 50 Beans');
        const asBens = { ...l, authorPubkey: ben.publicKey };
        expect(benReads([asBens]).get(l.id)).toEqual({ text: null, format: null, after: null, mark: null });
        // Ana's own phone refuses it too: it would show it as the other person's words.
        expect(checkDmThread([asBens], keysOf(ana, ben), CONV).get(l.id)?.text).toBeNull();
        // And as a third person's: no line of this pair names anyone else.
        expect(benReads([{ ...l, authorPubkey: cat.publicKey }]).get(l.id)?.text).toBeNull();
        // The line as it was opens, for both of them.
        expect(benReads([l]).get(l.id)).toMatchObject({ text: 'I will pay you 50 Beans', format: 3, mark: null });
        expect(checkDmThread([l], keysOf(ana, ben), CONV).get(l.id)?.text).toBe('I will pay you 50 Beans');
    });

    it('replay it as a new message: under any other id it doesn\'t open', () => {
        const l = line(ana, ben, 'yes');
        const replayed = { ...l, id: newDmMessageId() };
        const views = benReads([l, replayed]);
        expect(views.get(l.id)?.text).toBe('yes');
        expect(views.get(replayed.id)?.text).toBeNull();
    });

    it('replay it into another conversation: another pair\'s doesn\'t open; the same pair\'s other one, only as "moved"', () => {
        const l = line(ana, ben, 'yes');
        // Into Cat's conversation with Ana: a different key altogether.
        expect(checkDmThread([l], keysOf(cat, ana), CONV).get(l.id)?.text).toBeNull();
        // Into another conversation of theirs under a fresh id, with the metadata pointing back at the first: refused.
        const OTHER = 'ffffffff-1111-4222-8333-444455556666';
        const fresh = { ...l, id: newDmMessageId(), metadata: JSON.stringify({ originalConversationId: CONV }) };
        expect(checkDmThread([fresh], keysOf(ben, ana), OTHER).get(fresh.id)?.text).toBeNull();
        // Without the pointer it doesn't open at all.
        expect(checkDmThread([l], keysOf(ben, ana), OTHER).get(l.id)?.text).toBeNull();
        // With its own id and the pointer (what the node does, legitimately, when it folds one conversation into another)
        // it opens, and is marked as moved.
        const moved = { ...l, metadata: JSON.stringify({ originalConversationId: CONV }) };
        expect(checkDmThread([moved], keysOf(ben, ana), OTHER).get(l.id)).toMatchObject({ text: 'yes', mark: 'moved' });
    });

    it('reorder Ben\'s answer before Ana\'s question: the answer is marked', () => {
        const q = line(ana, ben, 'Shall I cancel the order?');
        const a = line(ben, ana, 'No', q.id);
        expect(benReads([q, a]).get(a.id)?.mark).toBeNull();
        const swapped = benReads([a, q]);
        expect(swapped.get(a.id)).toMatchObject({ text: 'No', mark: 'out-of-order' });
        expect(swapped.get(q.id)?.mark).toBeNull();
    });

    it('swap two of Ana\'s lines: the later one is marked', () => {
        const one = line(ana, ben, 'Yes to the first');
        const two = line(ana, ben, 'No to the second', one.id);
        expect(benReads([two, one]).get(two.id)?.mark).toBe('out-of-order');
        // Two lines written at the same moment (neither after the other) may come in either order unmarked.
        const x = line(ana, ben, 'crossing', null);
        const y = line(ben, ana, 'crossing too', null);
        expect([...benReads([y, x]).values()].map(v => v.mark)).toEqual([null, null]);
    });

    it('swap a caption and its photo: neither opens as the other', () => {
        const id = newDmMessageId();
        const ctx = ctxOf(ana, ben);
        const photo = sealDmLine('data:image/jpeg;base64,AAAA', ctx, { senderPubHex: ana.publicKey, messageId: id, part: 'attachment' });
        const ref = { conversationId: CONV, senderPubHex: ana.publicKey, messageId: id };
        expect(() => openDmLine(photo, keysOf(ben, ana), { ...ref, part: 'body' })).toThrow(dm.DmLineNotVerifiedError);
        expect(openDmLine(photo, keysOf(ben, ana), { ...ref, part: 'attachment' }).text).toBe('data:image/jpeg;base64,AAAA');
        // A photo opens only in its message's format: an old format-2 picture is not a new line's photo.
        const oldPhoto = encryptDmFormat2('data:image/jpeg;base64,BBBB', ctx);
        expect(() => openDmLine(oldPhoto, keysOf(ben, ana), { ...ref, part: 'attachment' }, [3])).toThrow(dm.DmLineNotVerifiedError);
    });
});

describe('old lines (format 2)', () => {
    it('still open and show as before: nobody loses their history, folded threads included', () => {
        const h1 = oldLine(ana, ben, 'hello from before');
        const h2 = oldLine(ben, ana, 'hi!');
        const views = benReads([h1, h2]);
        expect(views.get(h1.id)).toEqual({ text: 'hello from before', format: 2, after: null, mark: null });
        expect(views.get(h2.id)).toEqual({ text: 'hi!', format: 2, after: null, mark: null });
        // A line folded in from an old per-listing thread opens under the id its metadata names, unmarked, as before.
        const OLD = 'post-thread-1';
        const folded = {
            id: newDmMessageId(), authorPubkey: ana.publicKey, metadata: JSON.stringify({ originalConversationIds: ['x', OLD] }),
            ...encryptDmFormat2('about the bike', ctxOf(ana, ben, OLD)),
        };
        expect(benReads([folded]).get(folded.id)).toMatchObject({ text: 'about the bike', format: 2, mark: null });
    });

    it('arriving after the sender\'s app moved on: shown, and marked (it may be a replay or a re-attribution)', () => {
        const before = oldLine(ana, ben, 'see you at 6');
        const now = line(ana, ben, 'I\'m here', before.id);
        const replayed = oldLine(ana, ben, 'see you at 6');   // the node storing an old line of hers again
        const fromBen = oldLine(ben, ana, 'still on an old app');
        const views = benReads([before, now, replayed, fromBen]);
        expect(views.get(before.id)?.mark).toBeNull();
        expect(views.get(now.id)?.mark).toBeNull();
        expect(views.get(replayed.id)).toMatchObject({ text: 'see you at 6', mark: 'old-app' });
        // Ben hasn't sent a new line yet: his old app's lines are as they always were.
        expect(views.get(fromBen.id)?.mark).toBeNull();
    });
});

describe('the rest of the thread', () => {
    it('passes over what isn\'t an encrypted line: the node\'s own notices and tombstones', () => {
        const views = benReads([
            { id: 'sys-1', authorPubkey: 'SYSTEM', ciphertext: 'Payment sent', nonce: '00000' },
            { id: 'gone-1', authorPubkey: ana.publicKey, ciphertext: 'cmVtb3ZlZA==', nonce: 'plaintext-v1' },
        ]);
        expect(views.size).toBe(0);
    });

    it('a line that doesn\'t open has one text in both apps, and each mark one line', () => {
        expect(DM_LINE_NOT_VERIFIED_TEXT).toMatch(/couldn't be verified/);
        expect(dmLineMarkText('old-app')).toMatch(/older version of the app/);
        expect(dmLineMarkText('out-of-order')).toMatch(/out of the order/);
        expect(dmLineMarkText('moved')).toMatch(/another conversation/);
        expect(dmLineMarkText(null)).toBeNull();
    });

    it('a new line is written after the newest line the node has confirmed, never one still sending', () => {
        expect(dmAfterReference([
            { id: 'a', nonce: 'x25519-xc20p-v2:AAAA' },
            { id: 'b', nonce: '00000' },
            { id: 'c', nonce: 'x25519-xc20p-v2:BBBB', pending: true },
        ])).toBe('a');
        expect(dmAfterReference([])).toBeNull();
    });

    it('reads older conversation ids from metadata as a string or an object, once each', () => {
        expect(dmConversationIdsToTry('c', '{"originalConversationId":"a","originalConversationIds":["a","b",7]}')).toEqual(['c', 'a', 'b']);
        expect(dmConversationIdsToTry('c', { originalConversationIds: ['c'] })).toEqual(['c']);
        expect(dmConversationIdsToTry('c', 'not json')).toEqual(['c']);
    });
});

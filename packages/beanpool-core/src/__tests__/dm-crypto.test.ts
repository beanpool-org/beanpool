import { describe, it, expect } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import * as dm from '../dm-crypto.js';
import {
    checkDmThread, dmAfterReference, dmConversationIdsToTry, dmLineMarkText, newDmMessageId, openDmLine, sealDmLine,
    dmLineKind, dmLineShownText, dmLineIsUnattributed, dmThreadInShownOrder, dmReplyToOf, dmQuoteFrom, dmQuoteLabel,
    isDmLineForm, dmLineSigOf, dmLineSigVerifies,
    DM_CONVERSATION_IDS_MAX, DM_LINE_NOT_VERIFIED_TEXT, DM_LINE_NOT_ENCRYPTED_TEXT, DM_LINE_DELETED_TEXT, DM_FROM_ADMINS_KEY, type DmThreadLine,
} from '../dm-crypto.js';
import { toEd25519Pkcs8 } from '../ed25519-key.js';
import { checkDmLineVectors, DM_LINE_VECTORS, DM_REFUSED_LINES, DM_VECTOR_CONVERSATION, DM_VECTOR_PEOPLE } from '../dm-line-vectors.js';

// A direct message is bound to who sent it, which message it is and where (crypto review M F2, 2026-10-02), and since
// format 4 (the 1.4.0 cutover) signed by its sender beside the seal: the two people share one key, so either could seal a
// line naming the other, and only the sender's signature says which of them wrote it.

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

/** A thread's line that has an encrypted line's nonce, so it is also a payload openDmLine takes. */
type SealedLine = DmThreadLine & { nonce: string };

/** A line as the sender's app writes it and the node stores it; a reply carries what it answers in its metadata. */
function line(from: typeof ana, to: typeof ana, text: string, after: string | null = null, conversationId = CONV, replyToId?: string): SealedLine {
    const id = newDmMessageId();
    const sealed = sealDmLine(text, ctxOf(from, to, conversationId), { senderPubHex: from.publicKey, messageId: id, after, replyToId });
    return { id, authorPubkey: from.publicKey, ...sealed, ...(replyToId ? { metadata: JSON.stringify({ replyToId }) } : {}) };
}
const b64 = (t: string) => Buffer.from(t, 'utf8').toString('base64');
const b64b = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const benReads = (lines: DmThreadLine[]) => checkDmThread(lines, keysOf(ben, ana), CONV);

/**
 * A line `sealer` seals in `named`'s name, built from the primitives as dm-crypto.ts would (sealDmLine refuses it): both of
 * them hold the conversation's key, so the seal opens for both. It carries a signature by `signer`'s key, over the digest as
 * `named` would sign it. With `signer` = `named` it is that person's genuine line, which is how the tests show that only the
 * signature makes the difference.
 */
function sealedInNameOf(sealer: typeof ana, named: typeof ana, text: string, signer: typeof ana = sealer): SealedLine {
    const id = newDmMessageId();
    const nonce = randomBytes(24);
    const nonceColumn = dm.DM_NONCE_PREFIX + b64b(nonce);
    const at = '2026-11-10T09:00:00.000Z';
    const sealed = xchacha20poly1305(dm.deriveDmKey(ctxOf(sealer, named)), nonce, dm.dmLineAad(CONV, { senderPubHex: named.publicKey, messageId: id }))
        .encrypt(new Uint8Array([4, 0, ...utf8ToBytes(text)]));
    const digest = dm.dmLineSigDigest(nonceColumn, sealed, { conversationId: CONV, senderPubHex: named.publicKey, recipientPubHex: sealer.publicKey, messageId: id, part: 'body', at });
    const sig = ed25519.sign(digest, hexToBytes(signer.seedHex));
    return { id, authorPubkey: named.publicKey, nonce: nonceColumn, ciphertext: b64b(new Uint8Array([4, ...sig, ...utf8ToBytes(at), ...sealed])) };
}

/** A line as an app before 1.4.0 sealed it: format 3 (associated data '/3', no signature in the column), or format 2. */
function olderFormatLine(format: 2 | 3, from: typeof ana, to: typeof ana, text: string): SealedLine {
    const id = newDmMessageId();
    const nonce = randomBytes(24);
    const aad = format === 3 ? utf8ToBytes(JSON.stringify(['beanpool-dm-line/3', CONV, from.publicKey, id, 'body'])) : utf8ToBytes(CONV);
    const plain = format === 3 ? new Uint8Array([3, 0, ...utf8ToBytes(text)]) : utf8ToBytes(text);
    const ct = xchacha20poly1305(dm.deriveDmKey(ctxOf(from, to)), nonce, aad).encrypt(plain);
    return { id, authorPubkey: from.publicKey, nonce: dm.DM_NONCE_PREFIX + b64b(nonce), ciphertext: b64b(ct) };
}

describe('the frozen vectors', () => {
    it('seal and open the same bytes, and refuse every changed binding', () => {
        checkDmLineVectors(dm);
    });

    it('format 4 is what the comment says it is, re-derived from the primitives without dm-crypto.ts', () => {
        const v = DM_LINE_VECTORS[0];
        const a = DM_VECTOR_PEOPLE.ana;
        const b = DM_VECTOR_PEOPLE.ben;
        const shared = x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(hexToBytes(a.seedHex)), ed25519.utils.toMontgomery(hexToBytes(b.publicKey)));
        const key = hkdf(sha256, shared, utf8ToBytes(DM_VECTOR_CONVERSATION), utf8ToBytes('beanpool-dm-v2'), 32);
        const aad = utf8ToBytes(`["beanpool-dm-line/4","${DM_VECTOR_CONVERSATION}","${a.publicKey}","${v.messageId}","body"]`);
        const after = utf8ToBytes(v.after!);
        const words = utf8ToBytes(v.text);
        const plain = new Uint8Array([4, after.length, ...after, ...words]);
        const sealed = xchacha20poly1305(key, v.nonce, aad).encrypt(plain);
        const nonceColumn = 'x25519-xc20p-v2:' + Buffer.from(v.nonce).toString('base64');
        // Ana's signature, beside the seal: [tag, conversation, sender, recipient, id, part, when, nonce, sha256 of the sealed bytes].
        const digest = sha256(utf8ToBytes(JSON.stringify([
            'beanpool-dm-line-sig/2', DM_VECTOR_CONVERSATION, a.publicKey, b.publicKey, v.messageId, 'body', v.at, nonceColumn, bytesToHex(sha256(sealed)),
        ])));
        const sig = ed25519.sign(digest, hexToBytes(a.seedHex));
        expect(b64b(new Uint8Array([4, ...sig, ...utf8ToBytes(v.at), ...sealed]))).toBe(v.payload.ciphertext);
        expect(v.payload.nonce).toBe(nonceColumn);
        // What the node and a moderator read off the column without opening it.
        expect(dmLineSigOf(v.payload.ciphertext)).toEqual({ sig: b64b(sig), at: v.at });
        expect(isDmLineForm(v.payload.ciphertext, v.payload.nonce)).toBe(true);
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
        // The signing time is in the bytes, so both are sealed at the same one.
        const at = '2026-11-10T09:00:00.000Z';
        const fromSeed = sealDmLine('hi', ctxOf(ana, ben), { senderPubHex: ana.publicKey, messageId: id, at }, nonce);
        const fromPkcs8 = sealDmLine('hi', { ...ctxOf(ana, ben), myEdPrivHex: pkcs8 }, { senderPubHex: ana.publicKey, messageId: id, at }, nonce);
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
        expect(benReads([asBens]).get(l.id)).toEqual({ text: null, format: null, after: null, mark: 'not-verified' });
        // Ana's own phone refuses it too: it would show it as the other person's words.
        expect(checkDmThread([asBens], keysOf(ana, ben), CONV).get(l.id)?.text).toBeNull();
        // And as a third person's: no line of this pair names anyone else.
        expect(benReads([{ ...l, authorPubkey: cat.publicKey }]).get(l.id)?.text).toBeNull();
        // The line as it was opens, for both of them.
        expect(benReads([l]).get(l.id)).toMatchObject({ text: 'I will pay you 50 Beans', format: 4, mark: null });
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
    });
});

describe('the sender\'s signature (format 4)', () => {
    const NOT_SHOWN = { text: null, format: null, after: null, mark: 'not-verified' };

    it('a forged sender, a valid seal with a signature not theirs, is never shown as theirs, on either phone', () => {
        // Ana seals a line in Ben's name: she holds the key, so the seal opens for both of them; she can only sign it herself.
        const forged = sealedInNameOf(ana, ben, 'I owe Ana 500 Beans');
        expect(benReads([forged]).get(forged.id)).toEqual(NOT_SHOWN);
        // On Ana's own phone too: it would show her own words as Ben's.
        expect(checkDmThread([forged], keysOf(ana, ben), CONV).get(forged.id)).toEqual(NOT_SHOWN);
        // Shown as nobody's, in the neutral line, and none of its words.
        const view = benReads([forged]).get(forged.id);
        expect(dmLineIsUnattributed(view)).toBe(true);
        expect(dmLineShownText(view)).toBe(DM_LINE_NOT_VERIFIED_TEXT);
        expect(() => openDmLine(forged, keysOf(ben, ana), { conversationId: CONV, senderPubHex: ben.publicKey, messageId: forged.id })).toThrow(dm.DmLineNotVerifiedError);
        // The same construction with Ben's own signature is his genuine line, and opens: only the signature differs.
        const genuine = sealedInNameOf(ana, ben, 'I owe Ana 500 Beans', ben);
        expect(benReads([genuine]).get(genuine.id)).toMatchObject({ text: 'I owe Ana 500 Beans', format: 4, mark: null });
        // A third person's signature is no better than Ana's.
        expect(benReads([sealedInNameOf(ana, ben, 'hi', cat)]).values().next().value).toEqual(NOT_SHOWN);
    });

    it('a line of an older format, format 3 or 2, doesn\'t open: format 4 is the only one read', () => {
        const three = olderFormatLine(3, ana, ben, 'from a 1.3 app');
        const two = olderFormatLine(2, ana, ben, 'from before October');
        const views = benReads([three, two]);
        expect(views.get(three.id)).toEqual(NOT_SHOWN);
        expect(views.get(two.id)).toEqual(NOT_SHOWN);
        expect(isDmLineForm(three.ciphertext, three.nonce)).toBe(false);
        expect(isDmLineForm(two.ciphertext, two.nonce)).toBe(false);
        // The frozen format-3 line, with the signature a 1.3.x app sent beside it, as both people.
        const old = DM_REFUSED_LINES[0];
        const row = { id: old.messageId, authorPubkey: DM_VECTOR_PEOPLE.ana.publicKey, ...old.payload, metadata: old.metadata };
        const p = DM_VECTOR_PEOPLE;
        expect(checkDmThread([row], { myEdPrivHex: p.ben.seedHex, peerEdPubHex: p.ana.publicKey }, DM_VECTOR_CONVERSATION).get(row.id)).toEqual(NOT_SHOWN);
        expect(checkDmThread([row], { myEdPrivHex: p.ana.seedHex, peerEdPubHex: p.ben.publicKey }, DM_VECTOR_CONVERSATION).get(row.id)).toEqual(NOT_SHOWN);
        expect(isDmLineForm(old.payload.ciphertext, old.payload.nonce)).toBe(false);
    });

    it('a signature moved from one of the sender\'s lines to another doesn\'t carry over', () => {
        const one = line(ana, ben, 'Yes, take the ladder');
        const two = line(ana, ben, 'No, keep away from my shed');
        const column = (l: DmThreadLine) => Buffer.from(l.ciphertext, 'base64');
        const swapped = Buffer.concat([column(one).subarray(0, 1 + 64 + 24), column(two).subarray(1 + 64 + 24)]);
        const moved = { ...two, ciphertext: swapped.toString('base64') };
        expect(benReads([moved]).get(two.id)).toEqual(NOT_SHOWN);
        expect(benReads([two]).get(two.id)?.text).toBe('No, keep away from my shed');
    });

    it('every part is signed: a photo or a listing sealed in the sender\'s name by the other person doesn\'t open', () => {
        const id = newDmMessageId();
        const ref = { conversationId: CONV, senderPubHex: ana.publicKey, messageId: id };
        const photo = sealDmLine('data:image/jpeg;base64,AAAA', ctxOf(ana, ben), { senderPubHex: ana.publicKey, messageId: id, part: 'attachment' });
        expect(openDmLine(photo, keysOf(ben, ana), { ...ref, part: 'attachment' }).text).toBe('data:image/jpeg;base64,AAAA');
        // Ben puts his own picture on Ana's message: the seal names her and opens, but the signature is his.
        const nonce = randomBytes(24);
        const nonceColumn = dm.DM_NONCE_PREFIX + b64b(nonce);
        const at = '2026-11-10T09:00:00.000Z';
        const sealed = xchacha20poly1305(dm.deriveDmKey(ctxOf(ben, ana)), nonce, dm.dmLineAad(CONV, { senderPubHex: ana.publicKey, messageId: id, part: 'attachment' }))
            .encrypt(new Uint8Array([4, 0, ...utf8ToBytes('data:image/jpeg;base64,BBBB')]));
        const sig = ed25519.sign(dm.dmLineSigDigest(nonceColumn, sealed, { conversationId: CONV, senderPubHex: ana.publicKey, recipientPubHex: ben.publicKey, messageId: id, part: 'attachment', at }), hexToBytes(ben.seedHex));
        const swapped = { ciphertext: b64b(new Uint8Array([4, ...sig, ...utf8ToBytes(at), ...sealed])), nonce: nonceColumn };
        expect(() => openDmLine(swapped, keysOf(ana, ben), { ...ref, part: 'attachment' })).toThrow(dm.DmLineNotVerifiedError);
        expect(() => openDmLine(swapped, keysOf(ben, ana), { ...ref, part: 'attachment' })).toThrow(dm.DmLineNotVerifiedError);
        // A signature names its part: the words' signature never stands for the photo's.
        expect(dmLineSigVerifies(photo, { conversationId: CONV, senderPubHex: ana.publicKey, recipientPubHex: ben.publicKey, messageId: id, part: 'attachment' })).toBe(true);
        expect(dmLineSigVerifies(photo, { conversationId: CONV, senderPubHex: ana.publicKey, recipientPubHex: ben.publicKey, messageId: id, part: 'body' })).toBe(false);
    });

    it('the node can check the form without a key; only the binding checks who signed it', () => {
        const l = line(ana, ben, 'hi');
        expect(isDmLineForm(l.ciphertext, l.nonce)).toBe(true);
        const at = dmLineSigOf(l.ciphertext)!.at;
        expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        // Who it was to is part of what is signed: to Cat it isn't Ana's signature.
        expect(dmLineSigVerifies(l, { conversationId: CONV, senderPubHex: ana.publicKey, recipientPubHex: ben.publicKey, messageId: l.id, part: 'body' })).toBe(true);
        expect(dmLineSigVerifies(l, { conversationId: CONV, senderPubHex: ana.publicKey, recipientPubHex: cat.publicKey, messageId: l.id, part: 'body' })).toBe(false);
        // A column cut short, an unpadded or second spelling of its base64, a bad time, or the wrong nonce length: not the form.
        const bytes = Buffer.from(l.ciphertext, 'base64');
        expect(isDmLineForm(bytes.subarray(0, 1 + 64 + 24 + 15).toString('base64'), l.nonce)).toBe(false);
        // 'hi' with nothing before it seals to 1 + 64 + 24 + 20 = 109 bytes, so its base64 always ends in padding.
        expect(l.ciphertext.endsWith('==')).toBe(true);
        expect(isDmLineForm(l.ciphertext.replace(/=+$/, ''), l.nonce)).toBe(false);
        const badTime = Buffer.from(bytes); badTime[1 + 64 + 4] = 0x2f;   // '2026/11…'
        expect(isDmLineForm(badTime.toString('base64'), l.nonce)).toBe(false);
        expect(isDmLineForm(l.ciphertext, 'x25519-xc20p-v2:' + b64b(randomBytes(23)))).toBe(false);
        expect(isDmLineForm(l.ciphertext, 'plaintext-v1')).toBe(false);
        expect(() => sealDmLine('hi', ctxOf(ana, ben), { senderPubHex: ana.publicKey, messageId: newDmMessageId(), at: '2026-11-10' })).toThrow(/toISOString/);
    });
});

describe('a row that isn\'t an encrypted line', () => {
    it('in a member\'s name is never their words: plaintext-v1, 00000 as text, any other nonce', () => {
        const mine = line(ben, ana, 'my own line');
        const plain = { id: 'p-1', authorPubkey: ana.publicKey, ciphertext: b64('Change of plan: send the 500 Beans to Cat'), nonce: 'plaintext-v1', type: 'text' };
        const zeros = { id: 'z-1', authorPubkey: ana.publicKey, ciphertext: 'Deal is off', nonce: '00000', type: 'text' };
        const other = { id: 'o-1', authorPubkey: ana.publicKey, ciphertext: 'Send the Beans to Cat instead', nonce: 'zz', type: 'text' };
        const missing = { id: 'n-1', authorPubkey: ben.publicKey, ciphertext: 'hello', nonce: null };
        const views = benReads([mine, plain, zeros, other, missing]);
        for (const l of [plain, zeros, other, missing]) {
            expect(views.get(l.id)).toEqual({ text: null, format: null, after: null, mark: 'not-encrypted' });
            expect(dmLineShownText(views.get(l.id))).toBe(DM_LINE_NOT_ENCRYPTED_TEXT);
            expect(dmLineIsUnattributed(views.get(l.id))).toBe(true);
        }
        expect(DM_LINE_NOT_ENCRYPTED_TEXT).toMatch(/wasn't encrypted, so BeanPool can't confirm who wrote it/);
        expect(views.get(mine.id)?.mark).toBeNull();
        // Nothing the app shows for them holds the row's words.
        expect(JSON.stringify([...views.values()].map(dmLineShownText))).not.toMatch(/500 Beans|Deal is off|to Cat instead|hello/);
    });

    it('the admin page\'s message: its words, marked as the community admins\', never as a private line', () => {
        const admin = { id: 'a-1', authorPubkey: ana.publicKey, ciphertext: b64('Welcome to the community'), nonce: 'plaintext-v1', type: 'text',
            metadata: JSON.stringify({ [DM_FROM_ADMINS_KEY]: true }) };
        const view = benReads([admin]).get(admin.id)!;
        expect(view).toEqual({ text: 'Welcome to the community', format: null, after: null, mark: 'from-admins' });
        expect(dmLineIsUnattributed(view)).toBe(true);
        expect(dmLineMarkText('from-admins')).toMatch(/community's admins.*server can read it/);
        // The key on an encrypted line changes nothing; on a non-plaintext row it is still not encrypted.
        expect(benReads([{ ...admin, nonce: 'zz' }]).get(admin.id)?.mark).toBe('not-encrypted');
    });

    it('the node\'s own notices are passed over (shown as notices); a tombstone shows fixed text, never its row\'s words', () => {
        const views = benReads([
            { id: 'sys-1', authorPubkey: 'SYSTEM', ciphertext: 'Payment sent', nonce: '00000', type: 'system' },
            { id: 'sys-2', authorPubkey: ana.publicKey, ciphertext: 'Escrow funded', nonce: '00000', type: 'system' },
            { id: 'gone-1', authorPubkey: ana.publicKey, ciphertext: b64('Send me your 12 words'), nonce: 'plaintext-v1', type: 'removed' },
        ]);
        expect(views.has('sys-1') || views.has('sys-2')).toBe(false);
        expect(views.get('gone-1')).toEqual({ text: DM_LINE_DELETED_TEXT, format: null, after: null, mark: null });
        expect(dmLineKind({ authorPubkey: 'SYSTEM', nonce: '00000' })).toBe('node-notice');
        expect(dmLineKind({ authorPubkey: ana.publicKey, nonce: '00000', type: 'text' })).toBe('not-encrypted');
    });

    it('with no key for the other person yet, an encrypted line is not verified, and a plain one still not encrypted', () => {
        const l = line(ana, ben, 'hi');
        const plain = { id: 'p-2', authorPubkey: ana.publicKey, ciphertext: b64('hi'), nonce: 'plaintext-v1' };
        const views = checkDmThread([l, plain], null, CONV);
        expect(views.get(l.id)?.mark).toBe('not-verified');
        expect(views.get(plain.id)?.mark).toBe('not-encrypted');
    });
});

describe('what a reply answers', () => {
    it('is bound: re-pointed, dropped or added by the node, the line doesn\'t open', () => {
        const q = line(ana, ben, 'Can I borrow the ladder?');
        const other = line(ana, ben, 'Can I keep the 200 Beans you sent by mistake?', q.id);
        const yes = line(ben, ana, 'Yes', other.id, CONV, q.id);
        const anaReads = (lines: DmThreadLine[]) => checkDmThread(lines, keysOf(ana, ben), CONV);
        expect(anaReads([q, other, yes]).get(yes.id)).toMatchObject({ text: 'Yes', format: 4, mark: null });
        const repointed = { ...yes, metadata: JSON.stringify({ replyToId: other.id }) };
        expect(anaReads([q, other, repointed]).get(yes.id)?.mark).toBe('not-verified');
        expect(anaReads([q, other, { ...yes, metadata: null }]).get(yes.id)?.mark).toBe('not-verified');
        expect(anaReads([q, other, { ...yes, metadata: JSON.stringify({ replyToId: 7 }) }]).get(yes.id)?.mark).toBe('not-verified');
        const plainLine = line(ana, ben, 'Not a reply');
        expect(benReads([{ ...plainLine, metadata: JSON.stringify({ replyToId: q.id }) }]).get(plainLine.id)?.mark).toBe('not-verified');
        // Reactions and a fold's pointer beside it change nothing.
        const reacted = { ...yes, metadata: JSON.stringify({ replyToId: q.id, reactions: { '👍': [ana.publicKey] } }) };
        expect(anaReads([q, other, reacted]).get(yes.id)?.text).toBe('Yes');
        expect(dmReplyToOf('{"replyToId":""}')).toBeUndefined();
        expect(dmReplyToOf(null)).toBeNull();
    });
});

describe('a reply\'s quote of the message it answers', () => {
    it('follows that message\'s own check: its author only if it opened; a notice, the admins, or nobody otherwise', () => {
        const q = line(ana, ben, 'Can I borrow the ladder?');
        const forged = sealedInNameOf(ben, ana, 'Can I keep the 200 Beans?');
        const notice = { id: 'n-1', authorPubkey: ana.publicKey, ciphertext: 'Send the 500 Beans to Cat instead', nonce: '00000', type: 'system' };
        const admin = { id: 'a-2', authorPubkey: ana.publicKey, ciphertext: b64('Hi'), nonce: 'plaintext-v1', metadata: JSON.stringify({ [DM_FROM_ADMINS_KEY]: true }) };
        const plain = { id: 'p-3', authorPubkey: ana.publicKey, ciphertext: b64('Hi'), nonce: 'plaintext-v1' };
        const other = { ...line(ana, ben, 'not this one'), id: q.id };
        const views = benReads([q, forged, notice, admin, plain]);
        expect(dmQuoteFrom(q, views.get(q.id))).toBe('author');
        // A line in Ana's name that she didn't sign is quoted as nobody's, never hers.
        expect(dmQuoteFrom(forged, views.get(forged.id))).toBe('nobody');
        expect(dmQuoteFrom(notice, views.get(notice.id))).toBe('notice');
        expect(dmQuoteFrom(admin, views.get(admin.id))).toBe('admins');
        expect(dmQuoteFrom(plain, views.get(plain.id))).toBe('nobody');
        expect(dmQuoteFrom(other, benReads([other]).get(other.id))).toBe('nobody');
        expect(dmQuoteFrom(null, null)).toBe('nobody');
        expect([dmQuoteLabel('notice'), dmQuoteLabel('admins'), dmQuoteLabel('nobody')]).toEqual(['Notice', "Your community's admins", 'Not confirmed']);
    });
});

describe('the order a thread is shown and judged in', () => {
    it('is the node\'s timestamps, then the order given: a standby\'s last-changed row order marks nothing', () => {
        const q = { ...line(ana, ben, 'Can you take the bike on Saturday?'), timestamp: '2026-10-02T09:00:00.000Z' };
        const a = { ...line(ben, ana, 'Yes, I can', q.id), timestamp: '2026-10-02T09:01:00.000Z' };
        const rowOrder = [a, q];   // the question got a reaction after the answer, so a delta copy wrote it last
        expect(benReads(rowOrder).get(a.id)?.mark).toBe('out-of-order');
        const shown = dmThreadInShownOrder(rowOrder);
        expect(shown.map(l => l.id)).toEqual([q.id, a.id]);
        expect(benReads(shown).get(a.id)?.mark).toBeNull();
        // Equal times keep the order given; a missing time sorts last.
        const t = '2026-10-02T10:00:00.000Z';
        expect(dmThreadInShownOrder([{ id: 'x', timestamp: t }, { id: 'y', timestamp: null }, { id: 'z', timestamp: t }]).map(l => l.id)).toEqual(['x', 'z', 'y']);
    });
});

describe('the rest of the thread', () => {
    it('a line that doesn\'t open has one text in both apps, and each mark one line', () => {
        expect(DM_LINE_NOT_VERIFIED_TEXT).toMatch(/couldn't be verified/);
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

    // The deciding review of #2705: a sender writes this list, and each id costs the reader a key derivation.
    it('tries a line under at most the cap, its own id and the fold\'s first, however many its sender lists', () => {
        const listed = Array.from({ length: 11_000 }, (_, i) => `id-${i}`);
        const ids = dmConversationIdsToTry('c', { originalConversationId: 'a', originalConversationIds: listed });
        expect(ids).toHaveLength(DM_CONVERSATION_IDS_MAX);
        expect(ids.slice(0, 3)).toEqual(['c', 'a', 'id-0']);
    });

    it('opens a line sealed under the last id the cap reaches, and reads one past it as a line that didn\'t open', () => {
        const fill = Array.from({ length: DM_CONVERSATION_IDS_MAX }, (_, i) => `filler-${i}`);
        const folded = (position: number) => {
            const ids = [...fill];
            ids[position] = 'the-thread-it-was-sealed-in';
            return { ...line(ana, ben, 'about the bike', null, 'the-thread-it-was-sealed-in'), metadata: JSON.stringify({ originalConversationIds: ids }) };
        };
        // The line's own id takes the first place, so a list's last within the cap is at MAX - 2.
        const within = folded(DM_CONVERSATION_IDS_MAX - 2);
        const past = folded(DM_CONVERSATION_IDS_MAX - 1);
        expect(benReads([within]).get(within.id)).toMatchObject({ text: 'about the bike', format: 4, mark: 'moved' });
        expect(benReads([past]).get(past.id)).toMatchObject({ text: null, mark: 'not-verified' });
    });
});

describe('a thread whose other person moved to a new key (DM peer key pin, pick 3)', () => {
    // Ana continued past a key change: her phone now seals to Ben's new key, and keeps his old one as former. The node, on
    // an honest re-key, names his old lines as the new key's (engine/key-move.ts). They still read on her phone; a line
    // the node names as anyone else's still doesn't.
    const benNew = person('Ben, new phone');
    const texts = (views: Map<string, { text: string | null }>, lines: DmThreadLine[]) => lines.map((l) => views.get(l.id)?.text ?? null);

    it('Ben\'s old lines, named as his new key\'s or his old one\'s, and Ana\'s own old lines open under the former key', () => {
        const q = line(ana, ben, 'Shall I cancel the order?');
        const a = line(ben, ana, 'No', q.id);
        const moved = { ...a, authorPubkey: benNew.publicKey };
        const fresh = line(ana, benNew, 'Welcome back', a.id);
        const withFormer = checkDmThread([q, moved, fresh], keysOf(ana, benNew), CONV, [ben.publicKey]);
        expect(texts(withFormer, [q, moved, fresh])).toEqual(['Shall I cancel the order?', 'No', 'Welcome back']);
        expect(texts(checkDmThread([q, a], keysOf(ana, benNew), CONV, [ben.publicKey]), [q, a])).toEqual(['Shall I cancel the order?', 'No']);
        // without the former key, only the new line opens
        expect(texts(checkDmThread([q, moved, fresh], keysOf(ana, benNew), CONV), [q, moved, fresh])).toEqual([null, null, 'Welcome back']);
    });

    it('a line the node names as a third person\'s never opens under a former key, though it was sealed to it', () => {
        const a = line(ben, ana, 'No');
        const asCat = { ...a, authorPubkey: cat.publicKey };
        expect(checkDmThread([asCat], keysOf(ana, benNew), CONV, [ben.publicKey]).get(a.id)).toMatchObject({ text: null, mark: 'not-verified' });
    });
});

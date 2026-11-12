// Old chat, read-only (conversion code, log row OLDCHAT, remove after 12 Dec 2026; Marty, 12 Nov 2026): a direct message from before
// 1.4.0 opens again as it did then, read-only, under one label; anything newer without a valid signature stays hidden.
import { describe, it, expect } from 'vitest';
import { Buffer } from 'buffer';
import {
    checkDmThread, dmLineIsOld, dmLineIsUnattributed, dmLineHasOldShape, dmLineSentBeforeCutover, dmLineShownText, dmOldLineRunStarts,
    dmQuoteFrom, openDmLine, openDmOldLine, sealDmLine, isDmLineForm,
    DM_LINE_NOT_ENCRYPTED_TEXT, DM_LINE_NOT_VERIFIED_TEXT, DM_OLD_LINE_CUTOFF, DM_OLD_LINES_WORDS, type DmThreadLine, type DmKeys,
    openDmOldLinePart, openDmOldPhoto, DmLineNotVerifiedError, dmPublicKeyOf, type DmPayload,
} from '../dm-crypto.js';
import { chatAboutOfLine, chatAboutOfOldLine } from '../chat-about.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { DM_OLD_LINES, DM_OLD_LINE_TIMES, DM_REFUSED_LINES, DM_VECTOR_CONVERSATION as CONV, DM_VECTOR_PEOPLE as P } from '../dm-line-vectors.js';
import { t } from '../words.js';

const anaKeys: DmKeys = { myEdPrivHex: P.ana.seedHex, peerEdPubHex: P.ben.publicKey };
/** Ben as the web app holds his key (PKCS8): the same line opens for both spellings. */
const benKeys: DmKeys = { myEdPrivHex: P.ben.pkcs8Hex, peerEdPubHex: P.ana.publicKey };
const BEFORE = DM_OLD_LINE_TIMES.before;
const AFTER = DM_OLD_LINE_TIMES.after;

type Fixture = (typeof DM_OLD_LINES)[keyof typeof DM_OLD_LINES];
const row = (f: Fixture, timestamp: string | null, over: Partial<DmThreadLine> = {}): DmThreadLine => ({
    id: f.messageId, authorPubkey: P[f.from].publicKey, ciphertext: f.payload.ciphertext, nonce: f.payload.nonce, type: 'text',
    metadata: f.metadata, timestamp, ...over,
});
/** The 1.3.x line every app refuses as format 4 (DM_REFUSED_LINES[0]): old, as a 1.3.x app sent it. */
const frozen13 = DM_REFUSED_LINES[0];
const frozen13Row = (timestamp: string | null): DmThreadLine => ({
    id: frozen13.messageId, authorPubkey: P.ana.publicKey, ciphertext: frozen13.payload.ciphertext, nonce: frozen13.payload.nonce,
    type: 'text', metadata: frozen13.metadata, timestamp,
});
const viewOf = (lines: DmThreadLine[], keys: DmKeys | null = anaKeys, id = lines[0].id) => checkDmThread(lines, keys, CONV).get(id);

describe('an old line opens as it did before 1.4.0 (the 1.2.36 sealer, frozen)', () => {
    const cases: Array<[string, DmThreadLine, string]> = [
        ['format 3', row(DM_OLD_LINES.anaFormat3, BEFORE), DM_OLD_LINES.anaFormat3.text],
        ['format 3, a reply', row(DM_OLD_LINES.benFormat3Reply, BEFORE), DM_OLD_LINES.benFormat3Reply.text],
        ['format 2', row(DM_OLD_LINES.benFormat2, BEFORE), DM_OLD_LINES.benFormat2.text],
        ['format 3 as a 1.3.x app sent it, its signature beside it', frozen13Row(BEFORE), 'Meet at the gate at 6 — bring the seedlings 🌱'],
    ];
    for (const [label, l, text] of cases) {
        it(`${label}: for both people, in either key spelling, as an old sealed line in its author's bubble`, () => {
            for (const keys of [anaKeys, benKeys]) {
                const v = viewOf([l], keys);
                expect(v).toEqual(expect.objectContaining({ text, format: null, old: true }));
                expect(dmLineIsOld(v)).toBe(true);
                expect(dmLineIsUnattributed(v)).toBe(false);
                expect(dmLineShownText(v)).toBe(text);
                expect(dmQuoteFrom(l, v)).toBe('author');
            }
        });
        it(`${label}: still refused by the format-4 opener (openDmLine stays format 4 only)`, () => {
            expect(() => openDmLine({ ciphertext: l.ciphertext, nonce: l.nonce as string }, anaKeys,
                { conversationId: CONV, senderPubHex: l.authorPubkey, messageId: l.id, part: 'body', metadata: l.metadata })).toThrow();
        });
    }

    it('a reply keeps its sealed after; a thread of old lines is all old', () => {
        const lines = [row(DM_OLD_LINES.benFormat2, '2026-09-20T10:00:00.000Z'), row(DM_OLD_LINES.anaFormat3, BEFORE), row(DM_OLD_LINES.benFormat3Reply, '2026-11-05T09:01:00.000Z')];
        const views = checkDmThread(lines, benKeys, CONV);
        expect([...views.values()].map(dmLineIsOld)).toEqual([true, true, true]);
        expect(views.get(DM_OLD_LINES.benFormat3Reply.messageId)).toEqual(expect.objectContaining({ after: DM_OLD_LINES.anaFormat3.messageId, mark: null }));
    });

    it('the photo of an old message opens through openDmOldLine, only with the old shape', () => {
        const f = DM_OLD_LINES.anaPhotoFormat3;
        const ref = { conversationId: CONV, senderPubHex: P.ana.publicKey, messageId: f.messageId, part: 'attachment' as const, metadata: null };
        expect(openDmOldLine(f.payload, benKeys, { ...ref, timestamp: BEFORE }).text).toBe(f.text);
        expect(() => openDmOldLine(f.payload, benKeys, { ...ref, timestamp: AFTER })).toThrow();
        expect(() => openDmOldLine(f.payload, benKeys, { ...ref, part: 'body', timestamp: BEFORE })).toThrow();
    });
});

describe('anything newer without a valid signature stays hidden exactly as today', () => {
    it('an old-format line dated at the cutover or after it, or with no readable time, is not verified', () => {
        for (const ts of [AFTER, '2026-11-12T08:00:00.000Z', null, '', 'yesterday', '2026-02-31T00:00:00.000Z', '2026-11-05']) {
            for (const l of [row(DM_OLD_LINES.anaFormat3, ts), row(DM_OLD_LINES.benFormat2, ts), frozen13Row(ts)]) {
                const v = viewOf([l]);
                expect(v).toEqual({ text: null, format: null, after: null, mark: 'not-verified' });
                expect(dmLineShownText(v)).toBe(DM_LINE_NOT_VERIFIED_TEXT);
                expect(dmLineIsOld(v)).toBe(false);
            }
        }
    });

    it('forged time: a format-4 line its named sender did not sign, dated before the cutover, is never old', () => {
        // Ana sealed it in Ben's name and signed it herself (DM_REFUSED_LINES[1]); the node dates it in October.
        const forged = DM_REFUSED_LINES[1];
        const l: DmThreadLine = { id: forged.messageId, authorPubkey: P.ben.publicKey, ciphertext: forged.payload.ciphertext, nonce: forged.payload.nonce, type: 'text', metadata: null, timestamp: '2026-10-01T09:00:00.000Z' };
        expect(isDmLineForm(l.ciphertext, l.nonce)).toBe(true);
        expect(dmLineHasOldShape(l)).toBe(false);
        for (const keys of [anaKeys, benKeys]) expect(viewOf([l], keys)).toEqual({ text: null, format: null, after: null, mark: 'not-verified' });
    });

    it('forged time: a signed format-4 line with one byte of its signature changed, dated before the cutover, is never old', () => {
        const id = 'f4000000-0000-4000-8000-0000000000f4';
        const sealed = sealDmLine('new words', { ...anaKeys, conversationId: CONV }, { senderPubHex: P.ana.publicKey, messageId: id });
        const b = Buffer.from(sealed.ciphertext, 'base64');
        b[1] ^= 0x01;
        const l: DmThreadLine = { id, authorPubkey: P.ana.publicKey, ciphertext: b.toString('base64'), nonce: sealed.nonce, type: 'text', metadata: null, timestamp: BEFORE };
        expect(viewOf([l], benKeys)).toEqual({ text: null, format: null, after: null, mark: 'not-verified' });
    });

    it('forged time: an old-format line sealed after a line from after the cutover is hidden, however the node dates it', () => {
        const newer = sealDmLine('after the cutover', { ...anaKeys, conversationId: CONV }, { senderPubHex: P.ana.publicKey, messageId: 'c4000000-0000-4000-8000-0000000000c4' });
        const newLine: DmThreadLine = { id: 'c4000000-0000-4000-8000-0000000000c4', authorPubkey: P.ana.publicKey, ...newer, type: 'text', metadata: null, timestamp: '2026-11-12T10:00:00.000Z' };
        const forged = row(DM_OLD_LINES.benFormat3AfterNew, BEFORE);
        const views = checkDmThread([forged, newLine], anaKeys, CONV);
        expect(views.get(forged.id)).toEqual({ text: null, format: null, after: null, mark: 'not-verified' });
        expect(views.get(newLine.id)).toEqual(expect.objectContaining({ text: 'after the cutover', format: 4 }));
        // Without the newer line in the thread there is nothing to tell it by: it reads as old (format 3's own hole, the label's).
        expect(checkDmThread([forged], anaKeys, CONV).get(forged.id)?.old).toBe(true);
        // And a newer line the node re-dates before the cutover is still format 4's: never old, so the forgery stays hidden.
        const redated = { ...newLine, timestamp: '2026-11-01T10:00:00.000Z' };
        expect(dmLineHasOldShape(redated)).toBe(false);
        expect(checkDmThread([forged, redated], anaKeys, CONV).get(forged.id)?.mark).toBe('not-verified');
    });

    it('an old line named as the other person\'s, or as a stranger\'s, does not open', () => {
        const l = row(DM_OLD_LINES.anaFormat3, BEFORE, { authorPubkey: P.ben.publicKey });
        expect(viewOf([l], anaKeys)?.mark).toBe('not-verified');
        const stranger = row(DM_OLD_LINES.anaFormat3, BEFORE, { authorPubkey: 'ab'.repeat(32) });
        expect(viewOf([stranger], anaKeys)?.mark).toBe('not-verified');
    });

    it('an old line under another message id, or with its reply pointed elsewhere, does not open (format 3 binds them)', () => {
        expect(viewOf([row(DM_OLD_LINES.anaFormat3, BEFORE, { id: 'a9000000-0000-4000-8000-0000000000a9' })])?.mark).toBe('not-verified');
        expect(viewOf([row(DM_OLD_LINES.benFormat3Reply, BEFORE, { metadata: JSON.stringify({ replyToId: 'a9000000-0000-4000-8000-0000000000a9' }) })])?.mark).toBe('not-verified');
    });

    it('forged copy: a format-2 line the node stores again under another id is hidden; only the first one shows', () => {
        // Format 2 binds no message id, so a copy opens; it is a line the node wrote, dated before the cutover. The same
        // 24-byte nonce is what shows it is one sealing: only the line shown first holds the words.
        const original = row(DM_OLD_LINES.benFormat2, '2026-09-20T10:00:00.000Z');
        const copy = row(DM_OLD_LINES.benFormat2, BEFORE, { id: 'b9000000-0000-4000-8000-0000000000b9' });
        const views = checkDmThread([original, copy], anaKeys, CONV);
        expect(views.get(original.id)).toEqual(expect.objectContaining({ text: DM_OLD_LINES.benFormat2.text, old: true }));
        expect(views.get(copy.id)).toEqual({ text: null, format: null, after: null, mark: 'not-verified' });
        // Placed before the original, the copy is the one shown and the original is hidden: the words show once, as a line
        // the node moved would.
        const earlier = checkDmThread([{ ...copy, timestamp: '2026-09-01T10:00:00.000Z' }, original], anaKeys, CONV);
        expect([earlier.get(copy.id)?.old, earlier.get(original.id)?.mark]).toEqual([true, 'not-verified']);
        // Alone in a thread it opens, as in 1.2.36: the run's label says no old line was signed.
        expect(viewOf([copy])?.old).toBe(true);
    });

    it('no keys (the other person not known yet): nothing opens, old or new', () => {
        expect(viewOf([row(DM_OLD_LINES.anaFormat3, BEFORE)], null)?.mark).toBe('not-verified');
    });
});

describe('a readable row (plaintext-v1, 00000) stays hidden, however the node dates it', () => {
    // The node holds no key but can write a readable row in anyone's name and date it whenever it likes: nothing can show one
    // is old, so one written today and dated last month would pass as old. It stays the hidden line it is today.
    const plain = (text: string, timestamp: string | null, nonce = 'plaintext-v1'): DmThreadLine => ({
        id: 'p1000000-0000-4000-8000-0000000000e1', authorPubkey: P.ben.publicKey,
        ciphertext: nonce === 'plaintext-v1' ? Buffer.from(text).toString('base64') : text, nonce, type: 'text', metadata: null, timestamp,
    });
    it('dated before the cutover, after it, or not at all', () => {
        for (const ts of ['2026-06-21T10:00:00.000Z', '2026-06-20 10:00:00', BEFORE, AFTER, null]) {
            for (const l of [plain('Send me your 12 words', ts), plain('A first-release line', ts, '00000'), plain('x', ts, 'some-other-nonce')]) {
                const v = viewOf([l]);
                expect(v).toEqual({ text: null, format: null, after: null, mark: 'not-encrypted' });
                expect(dmLineShownText(v)).toBe(DM_LINE_NOT_ENCRYPTED_TEXT);
                expect(dmLineIsOld(v)).toBe(false);
                expect(dmLineIsUnattributed(v)).toBe(true);
                expect(dmQuoteFrom(l, v)).toBe('nobody');
            }
        }
    });
});

describe('the cutover time, read the same on every engine', () => {
    it('is the 1.4.0 deploy, and only a time strictly before it is old', () => {
        expect(DM_OLD_LINE_CUTOFF).toBe('2026-11-11T19:16:00.000Z');
        expect(dmLineSentBeforeCutover('2026-11-11T19:15:59.999Z')).toBe(true);
        expect(dmLineSentBeforeCutover('2026-11-11T19:16:00.000Z')).toBe(false);
        expect(dmLineSentBeforeCutover('2026-11-11T19:16:00Z')).toBe(false);
        // SQLite's own form, UTC.
        expect(dmLineSentBeforeCutover('2026-11-11 19:15:00')).toBe(true);
        expect(dmLineSentBeforeCutover('2026-11-11 19:16:00')).toBe(false);
        // An offset is honoured: 06:15 at +11:00 is 19:15 UTC the day before.
        expect(dmLineSentBeforeCutover('2026-11-12T06:15:00+11:00')).toBe(true);
        expect(dmLineSentBeforeCutover('2026-11-12T06:16:00+11:00')).toBe(false);
        expect(dmLineSentBeforeCutover('2026-11-11T14:15:00-05:00')).toBe(true);
        for (const bad of [null, undefined, 0, 1731000000000, '', ' 2026-11-01T00:00:00Z', '2026-11-01', '2026-13-01T00:00:00Z', '2026-02-29T00:00:00Z', 'Tue Nov 10 2026']) {
            expect(dmLineSentBeforeCutover(bad)).toBe(false);
        }
    });
});

describe('the label and its runs', () => {
    it('is one sentence of the words layer, in English as Marty wrote it', () => {
        expect(t(DM_OLD_LINES_WORDS.label)).toBe('Older messages from before 12 November 2026. They were sent before BeanPool signed every message.');
    });
    it('goes above each run of old lines once; a passed-over line neither starts nor ends a run', () => {
        expect(dmOldLineRunStarts([])).toEqual([]);
        expect(dmOldLineRunStarts([true, true, false, true])).toEqual([true, false, false, true]);
        expect(dmOldLineRunStarts([null, true, null, true, false])).toEqual([false, true, false, false, false]);
        expect(dmOldLineRunStarts([false, false])).toEqual([false, false]);
    });
});

// Old chat's photos and listing cards (conversion code, log row OLDCHAT, remove after 12 Dec 2026; Marty, 13 Nov 2026: "if they
// are there why not view them?"): an old line's photo and card open as part of its words, as 1.2.36 opened a photo, or not at all.
describe('an old line\'s photo and listing card open as part of its words (the 1.2.36 and format-3 sealers, frozen)', () => {
    const L = DM_OLD_LINES;
    const words = (f: Fixture): DmPayload => f.payload;
    const lineOf = (f: Fixture, timestamp: string | null = BEFORE, over: Record<string, unknown> = {}) => ({
        conversationId: CONV, senderPubHex: P[f.from].publicKey, messageId: f.messageId, metadata: f.metadata, timestamp, ...over,
    });
    const catSeed = sha256(utf8ToBytes('beanpool old-chat test: Cat'));
    const cat = { seedHex: bytesToHex(catSeed), publicKey: bytesToHex(ed25519.getPublicKey(catSeed)) };

    it('a frozen 1.2.36 photo (format 3) opens for both people, in either key spelling, under a line shown old', () => {
        const photoLine = row(L.anaFormat3, BEFORE, { type: 'image' });
        for (const keys of [anaKeys, benKeys, { myEdPrivHex: P.ana.pkcs8Hex, peerEdPubHex: P.ben.publicKey }, { myEdPrivHex: P.ben.seedHex, peerEdPubHex: P.ana.publicKey }]) {
            expect(dmLineIsOld(checkDmThread([photoLine], keys, CONV).get(photoLine.id))).toBe(true);
            expect(openDmOldPhoto(words(L.anaFormat3), L.anaPhotoFormat3.payload, keys, lineOf(L.anaFormat3))).toBe(L.anaPhotoFormat3.text);
        }
    });

    it('a frozen format-2 photo (an app before 2 October 2026) opens under its format-2 words', () => {
        for (const keys of [anaKeys, benKeys]) {
            expect(openDmOldPhoto(words(L.benFormat2), L.benPhotoFormat2.payload, keys, lineOf(L.benFormat2))).toBe(L.benPhotoFormat2.text);
        }
    });

    it('a stranger\'s key opens neither the words nor the photo', () => {
        for (const keys of [{ myEdPrivHex: cat.seedHex, peerEdPubHex: P.ana.publicKey }, { myEdPrivHex: cat.seedHex, peerEdPubHex: P.ben.publicKey }]) {
            expect(() => openDmOldPhoto(words(L.anaFormat3), L.anaPhotoFormat3.payload, keys, lineOf(L.anaFormat3))).toThrow(DmLineNotVerifiedError);
            expect(() => openDmOldPhoto(words(L.benFormat2), L.benPhotoFormat2.payload, keys, lineOf(L.benFormat2))).toThrow(DmLineNotVerifiedError);
            // Named as the stranger's own line, still nothing: the key isn't theirs with either of the two.
            expect(() => openDmOldPhoto(words(L.anaFormat3), L.anaPhotoFormat3.payload, keys, lineOf(L.anaFormat3, BEFORE, { senderPubHex: cat.publicKey }))).toThrow(DmLineNotVerifiedError);
        }
    });

    it('the time decides as for the words: dated from the cutover on, or with no time, the photo stays locked', () => {
        for (const ts of [AFTER, '2026-11-12T08:00:00.000Z', null, 'yesterday']) {
            expect(() => openDmOldPhoto(words(L.anaFormat3), L.anaPhotoFormat3.payload, anaKeys, lineOf(L.anaFormat3, ts))).toThrow(DmLineNotVerifiedError);
        }
    });

    it('no other line\'s photo stands in: another message\'s, another format\'s, the words\' own bytes, or a format-4 sealing', () => {
        // Format 3 binds the message id: Ana's photo under Ben's reply does not open.
        expect(() => openDmOldPhoto(words(L.benFormat3Reply), L.anaPhotoFormat3.payload, anaKeys, lineOf(L.benFormat3Reply))).toThrow(DmLineNotVerifiedError);
        // A photo opens only in its words' format: a format-2 photo under format-3 words, and a format-3 photo under format-2 words.
        expect(() => openDmOldPhoto(words(L.anaFormat3), L.benPhotoFormat2.payload, anaKeys, lineOf(L.anaFormat3))).toThrow(DmLineNotVerifiedError);
        expect(() => openDmOldPhoto(words(L.benFormat2), L.anaPhotoFormat3.payload, anaKeys, lineOf(L.benFormat2))).toThrow(DmLineNotVerifiedError);
        // The words' own sealing served as their photo: one sealing is one part.
        expect(() => openDmOldLinePart(words(L.benFormat2), L.benFormat2.payload, anaKeys, lineOf(L.benFormat2), 'attachment')).toThrow(DmLineNotVerifiedError);
        // A photo in format 4's form (sealed and signed today) is no old line's photo; nor do format-4 words open an old photo.
        const fresh = sealDmLine('data:image/jpeg;base64,QUFBQQ==', { ...anaKeys, conversationId: CONV }, { senderPubHex: P.ana.publicKey, messageId: L.anaFormat3.messageId, part: 'attachment' });
        expect(() => openDmOldPhoto(words(L.anaFormat3), fresh, benKeys, lineOf(L.anaFormat3))).toThrow(DmLineNotVerifiedError);
        const freshWords = sealDmLine('hello', { ...anaKeys, conversationId: CONV }, { senderPubHex: P.ana.publicKey, messageId: L.anaFormat3.messageId });
        expect(() => openDmOldPhoto(freshWords, L.anaPhotoFormat3.payload, benKeys, lineOf(L.anaFormat3))).toThrow(DmLineNotVerifiedError);
        // Named as the other person's, the words don't open, so neither does the photo.
        expect(() => openDmOldPhoto(words(L.anaFormat3), L.anaPhotoFormat3.payload, benKeys, lineOf(L.anaFormat3, BEFORE, { senderPubHex: P.ben.publicKey }))).toThrow(DmLineNotVerifiedError);
    });

    it('format 2\'s own hole: other format-2 words served as the photo open, but are no picture, so the photo stays locked', () => {
        expect(openDmOldLinePart(words(L.benFormat2), L.benNotPhotoFormat2.payload, anaKeys, lineOf(L.benFormat2), 'attachment').text).toBe(L.benNotPhotoFormat2.text);
        expect(() => openDmOldPhoto(words(L.benFormat2), L.benNotPhotoFormat2.payload, anaKeys, lineOf(L.benFormat2))).toThrow(DmLineNotVerifiedError);
    });

    it('under a key pinned before the current one (Continue with the new key), as its words open', () => {
        const newBenSeed = sha256(utf8ToBytes('beanpool old-chat test: Ben again'));
        const newBen = bytesToHex(ed25519.getPublicKey(newBenSeed));
        const afterRekey: DmKeys = { myEdPrivHex: P.ana.seedHex, peerEdPubHex: newBen };
        // The row may name Ben's former key, or his new one (a re-key moves the old lines' author): both open under the former.
        for (const sender of [P.ben.publicKey, newBen]) {
            const line = lineOf(L.benFormat2, BEFORE, { senderPubHex: sender });
            expect(() => openDmOldPhoto(words(L.benFormat2), L.benPhotoFormat2.payload, afterRekey, line)).toThrow(DmLineNotVerifiedError);
            expect(openDmOldPhoto(words(L.benFormat2), L.benPhotoFormat2.payload, afterRekey, line, [P.ben.publicKey])).toBe(L.benPhotoFormat2.text);
        }
        // Ana's own old photo, from her side, under Ben's former key.
        expect(openDmOldPhoto(words(L.anaFormat3), L.anaPhotoFormat3.payload, afterRekey, lineOf(L.anaFormat3), [P.ben.publicKey])).toBe(L.anaPhotoFormat3.text);
        expect(dmPublicKeyOf(afterRekey.myEdPrivHex)).toBe(P.ana.publicKey);
    });

    it('the listing card of a format-3 line opens, for both people; the format-4 reader still finds none', () => {
        const metadata = JSON.stringify({ about: L.anaAboutFormat3.payload });
        const line = { ...lineOf(L.anaFormat3), metadata };
        for (const keys of [anaKeys, benKeys]) {
            expect(chatAboutOfOldLine(keys, line, words(L.anaFormat3))).toEqual({ postId: 'old-eggs-1', title: 'Fresh eggs', kind: 'offer' });
            expect(chatAboutOfLine(keys, line)).toBeNull();
        }
    });

    it('a card stays shut where the words decide against it: another message, a format-2 line, after the cutover, a stranger', () => {
        const about = JSON.stringify({ about: L.anaAboutFormat3.payload });
        // Under Ben's reply (another message id, and the reply's metadata kept) it does not open.
        const reply = { ...lineOf(L.benFormat3Reply), metadata: JSON.stringify({ replyToId: L.anaFormat3.messageId, about: L.anaAboutFormat3.payload }) };
        expect(chatAboutOfOldLine(anaKeys, reply, words(L.benFormat3Reply))).toBeNull();
        // Format 2 never sealed a listing.
        expect(chatAboutOfOldLine(anaKeys, { ...lineOf(L.benFormat2), metadata: about }, words(L.benFormat2))).toBeNull();
        expect(chatAboutOfOldLine(anaKeys, { ...lineOf(L.anaFormat3, AFTER), metadata: about }, words(L.anaFormat3))).toBeNull();
        expect(chatAboutOfOldLine({ myEdPrivHex: cat.seedHex, peerEdPubHex: P.ana.publicKey }, { ...lineOf(L.anaFormat3), metadata: about }, words(L.anaFormat3))).toBeNull();
        expect(chatAboutOfOldLine(null, { ...lineOf(L.anaFormat3), metadata: about }, words(L.anaFormat3))).toBeNull();
        // No card in the metadata: none.
        expect(chatAboutOfOldLine(anaKeys, lineOf(L.anaFormat3), words(L.anaFormat3))).toBeNull();
    });
});

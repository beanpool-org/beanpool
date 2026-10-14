import { describe, it, expect } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import * as dm from '../dm-crypto.js';
import {
    checkDmThread, dmAfterReference, dmConversationIdsToTry, dmLineMarkText, encryptDmFormat2, newDmMessageId, openDmLine, sealDmLine,
    dmLineKind, dmLineShownText, dmLineIsUnattributed, dmThreadInShownOrder, dmReplyToOf, dmQuoteFrom, dmQuoteLabel,
    DM_LINE_NOT_VERIFIED_TEXT, DM_LINE_NOT_ENCRYPTED_TEXT, DM_LINE_DELETED_TEXT, DM_FROM_ADMINS_KEY, type DmThreadLine,
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

/** A line as the sender's app writes it and the node stores it; a reply carries what it answers in its metadata. */
function line(from: typeof ana, to: typeof ana, text: string, after: string | null = null, conversationId = CONV, replyToId?: string): DmThreadLine {
    const id = newDmMessageId();
    const sealed = sealDmLine(text, ctxOf(from, to, conversationId), { senderPubHex: from.publicKey, messageId: id, after, replyToId });
    return { id, authorPubkey: from.publicKey, ...sealed, ...(replyToId ? { metadata: JSON.stringify({ replyToId }) } : {}) };
}
const b64 = (t: string) => Buffer.from(t, 'utf8').toString('base64');
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
        expect(benReads([asBens]).get(l.id)).toEqual({ text: null, format: null, after: null, mark: 'not-verified' });
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
    it('still open, so nobody loses their history, folded threads included; each one marked, as nothing in it proves who wrote it', () => {
        const h1 = oldLine(ana, ben, 'hello from before');
        const h2 = oldLine(ben, ana, 'hi!');
        const views = benReads([h1, h2]);
        expect(views.get(h1.id)).toEqual({ text: 'hello from before', format: 2, after: null, mark: 'old-app' });
        expect(views.get(h2.id)).toEqual({ text: 'hi!', format: 2, after: null, mark: 'old-app' });
        // A line folded in from an old per-listing thread opens under the id its metadata names, marked the same way.
        const OLD = 'post-thread-1';
        const folded = {
            id: newDmMessageId(), authorPubkey: ana.publicKey, metadata: JSON.stringify({ originalConversationIds: ['x', OLD] }),
            ...encryptDmFormat2('about the bike', ctxOf(ana, ben, OLD)),
        };
        expect(benReads([folded]).get(folded.id)).toMatchObject({ text: 'about the bike', format: 2, mark: 'old-app' });
        expect(dmLineMarkText('old-app')).toBe("Sent from an older version of the app: BeanPool can't confirm who wrote it.");
    });

    it('marked wherever it sits and whoever it names: before or after any new line, as either person, past any window', () => {
        const before = oldLine(ana, ben, 'see you at 6');
        const now = line(ana, ben, 'I\'m here', before.id);
        const replayed = oldLine(ana, ben, 'see you at 6');   // the node storing an old line of hers again
        // Ana's old line shown as Ben's newest (format 2 can't prove its sender, so this is the same line re-attributed).
        const asBens = { ...oldLine(ana, ben, 'I will pay you 50 Beans'), authorPubkey: ben.publicKey };
        const views = benReads([before, now, replayed, asBens]);
        expect(views.get(before.id)?.mark).toBe('old-app');
        expect(views.get(now.id)?.mark).toBeNull();
        expect(views.get(replayed.id)).toMatchObject({ text: 'see you at 6', mark: 'old-app' });
        expect(views.get(asBens.id)).toMatchObject({ text: 'I will pay you 50 Beans', mark: 'old-app' });
        // The window the apps pass in holds no new line of anyone's: still marked.
        const window = [replayed, ...Array.from({ length: 50 }, (_, i) => line(ben, ana, `line ${i}`))];
        expect(benReads(window.slice(-50).concat(asBens)).get(asBens.id)?.mark).toBe('old-app');
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
        expect(anaReads([q, other, yes]).get(yes.id)).toMatchObject({ text: 'Yes', format: 3, mark: null });
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
        const old = oldLine(ana, ben, 'Can I keep the 200 Beans?');
        const notice = { id: 'n-1', authorPubkey: ana.publicKey, ciphertext: 'Send the 500 Beans to Cat instead', nonce: '00000', type: 'system' };
        const admin = { id: 'a-2', authorPubkey: ana.publicKey, ciphertext: b64('Hi'), nonce: 'plaintext-v1', metadata: JSON.stringify({ [DM_FROM_ADMINS_KEY]: true }) };
        const plain = { id: 'p-3', authorPubkey: ana.publicKey, ciphertext: b64('Hi'), nonce: 'plaintext-v1' };
        const other = { ...line(ana, ben, 'not this one'), id: q.id };
        const views = benReads([q, old, notice, admin, plain]);
        expect(dmQuoteFrom(q, views.get(q.id))).toBe('author');
        expect(dmQuoteFrom(old, views.get(old.id))).toBe('author');
        expect(dmLineMarkText(views.get(old.id)?.mark)).toMatch(/older version/);
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

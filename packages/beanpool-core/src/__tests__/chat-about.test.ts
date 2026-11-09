import { describe, it, expect, beforeEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { checkDmThread, newDmMessageId, sealDmLine, openDmLine } from '../dm-crypto.js';
import {
    aboutOfPost, chatAboutCard, chatAboutChipWords, chatAboutDrafts, chatAboutOfLine, DM_ABOUT_KEY, hasChatAbout,
    metadataWithAbout, parseChatAbout, sealChatAbout, CHAT_ABOUT_TITLE_MAX,
} from '../chat-about.js';

function person(name: string) {
    const seed = sha256(utf8ToBytes(`chat-about.test ${name}`));
    return { seedHex: bytesToHex(seed), publicKey: bytesToHex(ed25519.getPublicKey(seed)) };
}
const rob = person('Rob');
const ana = person('Ana');
const cat = person('Cat');
const CONV = 'c0ffee00-1111-4222-8333-444455556666';
const ctxOf = (me: typeof rob, peer: typeof rob, conversationId = CONV) => ({ myEdPrivHex: me.seedHex, peerEdPubHex: peer.publicKey, conversationId });
const keysOf = (me: typeof rob, peer: typeof rob) => ({ myEdPrivHex: me.seedHex, peerEdPubHex: peer.publicKey });

const EGGS = { id: 'post-eggs-1', type: 'offer', title: 'Fresh eggs', credits: 6, priceType: 'fixed' };

/** A line as the sender's app writes it: the words sealed, the listing sealed beside it in the metadata. */
function lineAbout(from: typeof rob, to: typeof rob, text: string, post: any, replyToId?: string) {
    const id = newDmMessageId();
    const chip = aboutOfPost(post)!;
    const words = sealDmLine(text, ctxOf(from, to), { senderPubHex: from.publicKey, messageId: id, replyToId });
    const sealed = sealChatAbout(chip, ctxOf(from, to), { senderPubHex: from.publicKey, messageId: id, replyToId });
    const metadata = metadataWithAbout(replyToId ? JSON.stringify({ replyToId }) : undefined, sealed);
    return { id, authorPubkey: from.publicKey, ...words, metadata };
}

describe('the chip for a listing', () => {
    it('reads "About: title · price" for a priced Offer and a Need, in Beans', () => {
        expect(chatAboutChipWords(aboutOfPost(EGGS)!)).toBe('About: Fresh eggs · 6 Beans');
        expect(chatAboutChipWords(aboutOfPost({ id: 'n1', type: 'need', title: 'A lift to town', credits: 0 })!)).toBe('About: A lift to town · Free');
        expect(chatAboutChipWords(aboutOfPost({ id: 'o2', type: 'offer', title: 'Garden help', credits: 25, price_type: 'hourly' })!)).toBe('About: Garden help · 25 Beans an hour');
    });

    it('has no price for an event, or a listing the node sent no price for', () => {
        expect(chatAboutChipWords(aboutOfPost({ id: 'e1', type: 'event', title: 'Seed swap', credits: 0 })!)).toBe('About: Seed swap');
        expect(chatAboutChipWords(aboutOfPost({ id: 'o3', type: 'offer', title: 'Honey' })!)).toBe('About: Honey');
    });

    it('is none for a poll, or a post with no id or no title', () => {
        expect(aboutOfPost({ id: 'p1', type: 'poll', title: 'Pick a day' })).toBeNull();
        expect(aboutOfPost({ type: 'offer', title: 'No id' })).toBeNull();
        expect(aboutOfPost({ id: 'o4', type: 'offer', title: '   ' })).toBeNull();
        expect(aboutOfPost(null)).toBeNull();
    });

    it('keeps a very long title short', () => {
        expect(aboutOfPost({ id: 'o5', type: 'offer', title: 'x'.repeat(500), credits: 1 })!.title.length).toBe(CHAT_ABOUT_TITLE_MAX);
    });
});

describe('the reference, sealed', () => {
    it('opens for the other person, and for the sender, to the id, title and kind and nothing else', () => {
        const l = lineAbout(rob, ana, 'Is this still available?', EGGS);
        const asAna = chatAboutOfLine(keysOf(ana, rob), { conversationId: CONV, senderPubHex: rob.publicKey, messageId: l.id, metadata: l.metadata });
        expect(asAna).toEqual({ postId: 'post-eggs-1', title: 'Fresh eggs', kind: 'offer' });
        const asRob = chatAboutOfLine(keysOf(rob, ana), { conversationId: CONV, senderPubHex: rob.publicKey, messageId: l.id, metadata: l.metadata });
        expect(asRob).toEqual(asAna);
    });

    it('leaves nothing readable on the node: no listing id, title or kind in the stored row', () => {
        const l = lineAbout(rob, ana, 'Is this still available?', EGGS);
        const row = JSON.stringify(l);
        for (const readable of ['post-eggs-1', 'Fresh eggs', 'offer', 'eggs', 'available']) expect(row).not.toContain(readable);
        expect(Object.keys(JSON.parse(l.metadata))).toEqual([DM_ABOUT_KEY]);
    });

    it('does not change the words: the thread opens the line as the words alone', () => {
        const l = lineAbout(rob, ana, 'Is this still available?', EGGS);
        const views = checkDmThread([l], keysOf(ana, rob), CONV);
        expect(views.get(l.id)).toMatchObject({ text: 'Is this still available?', mark: null });
    });

    it('does not open as the words, nor the words as the reference', () => {
        const l = lineAbout(rob, ana, 'hello', EGGS);
        const raw = JSON.parse(l.metadata)[DM_ABOUT_KEY];
        expect(() => openDmLine(raw, keysOf(ana, rob), { conversationId: CONV, senderPubHex: rob.publicKey, messageId: l.id, part: 'body', metadata: l.metadata })).toThrow();
        const swapped = { ...l, metadata: JSON.stringify({ [DM_ABOUT_KEY]: { ciphertext: l.ciphertext, nonce: l.nonce } }) };
        expect(chatAboutOfLine(keysOf(ana, rob), { conversationId: CONV, senderPubHex: rob.publicKey, messageId: l.id, metadata: swapped.metadata })).toBeNull();
    });

    it('is bound to its message: the same bytes on another message, in another chat, or as another sender show nothing', () => {
        const l = lineAbout(rob, ana, 'hello', EGGS);
        const base = { conversationId: CONV, senderPubHex: rob.publicKey, messageId: l.id, metadata: l.metadata };
        expect(chatAboutOfLine(keysOf(ana, rob), base)).not.toBeNull();
        expect(chatAboutOfLine(keysOf(ana, rob), { ...base, messageId: newDmMessageId() })).toBeNull();
        expect(chatAboutOfLine(keysOf(ana, rob), { ...base, conversationId: 'c0ffee00-1111-4222-8333-444455556667' })).toBeNull();
        expect(chatAboutOfLine(keysOf(rob, ana), { ...base, senderPubHex: ana.publicKey })).toBeNull();
        expect(chatAboutOfLine(keysOf(cat, rob), base)).toBeNull();
    });

    it('is bound to the reply a line answers, as the words are', () => {
        const replyTo = newDmMessageId();
        const l = lineAbout(rob, ana, 'yes', EGGS, replyTo);
        const base = { conversationId: CONV, senderPubHex: rob.publicKey, messageId: l.id };
        expect(chatAboutOfLine(keysOf(ana, rob), { ...base, metadata: l.metadata })).not.toBeNull();
        const meta = JSON.parse(l.metadata);
        expect(meta.replyToId).toBe(replyTo);
        meta.replyToId = newDmMessageId();
        expect(chatAboutOfLine(keysOf(ana, rob), { ...base, metadata: JSON.stringify(meta) })).toBeNull();
    });

    it('a line from before this change has none, and nothing about it changes', () => {
        const id = newDmMessageId();
        const old = { id, authorPubkey: rob.publicKey, ...sealDmLine('hello', ctxOf(rob, ana), { senderPubHex: rob.publicKey, messageId: id }) };
        expect(hasChatAbout(undefined)).toBe(false);
        expect(chatAboutOfLine(keysOf(ana, rob), { conversationId: CONV, senderPubHex: rob.publicKey, messageId: id, metadata: undefined })).toBeNull();
        expect(chatAboutOfLine(keysOf(ana, rob), { conversationId: CONV, senderPubHex: rob.publicKey, messageId: id, metadata: JSON.stringify({ lineSig: 'x' }) })).toBeNull();
        expect(checkDmThread([old], keysOf(ana, rob), CONV).get(id)).toMatchObject({ text: 'hello', mark: null });
    });

    it('never throws on a damaged or hostile reference', () => {
        const id = newDmMessageId();
        const base = { conversationId: CONV, senderPubHex: rob.publicKey, messageId: id };
        for (const metadata of ['{', 'null', '[]', JSON.stringify({ about: 'x' }), JSON.stringify({ about: { ciphertext: 1, nonce: 2 } }), JSON.stringify({ about: { ciphertext: 'AAAA', nonce: 'x25519-xc20p-v2:AAAA' } })]) {
            expect(chatAboutOfLine(keysOf(ana, rob), { ...base, metadata })).toBeNull();
        }
        expect(chatAboutOfLine(null, { ...base, metadata: '{}' })).toBeNull();
    });

    it('keeps a line\'s other metadata (its reply, its signature) when the reference is added', () => {
        const sealed = { ciphertext: 'abc', nonce: 'x25519-xc20p-v2:def' };
        const out = JSON.parse(metadataWithAbout(JSON.stringify({ replyToId: 'r1', lineSig: { s: 1 } }), sealed));
        expect(out).toEqual({ replyToId: 'r1', lineSig: { s: 1 }, about: sealed });
        expect(JSON.parse(metadataWithAbout(undefined, sealed))).toEqual({ about: sealed });
    });

    it('opens nothing that is not exactly a reference', () => {
        expect(parseChatAbout('{"v":1,"post":"p1","title":"T","kind":"offer"}')).toEqual({ postId: 'p1', title: 'T', kind: 'offer' });
        for (const bad of ['', 'hello', '{"v":2,"post":"p1","title":"T","kind":"offer"}', '{"v":1,"post":"p 1","title":"T","kind":"offer"}', '{"v":1,"post":"p1","title":"","kind":"offer"}', '{"v":1,"post":"p1","title":"T","kind":"poll"}', null, 3]) {
            expect(parseChatAbout(bad as any)).toBeNull();
        }
    });
});

describe('the card in a bubble', () => {
    const about = { postId: 'post-eggs-1', title: 'Fresh eggs (as the sender saw it)', kind: 'offer' as const };

    it('shows the listing\'s own title, kind and price once it is found, not what the sender claimed', () => {
        const card = chatAboutCard(about, { ...EGGS, title: 'Fresh eggs, a dozen', credits: 8 });
        expect(card).toMatchObject({ gone: false, title: 'Fresh eggs, a dozen', kindWords: 'Offer', price: '8 Beans', postId: 'post-eggs-1' });
    });

    it('shows the sender\'s title and kind, with no price, while the lookup is still going', () => {
        expect(chatAboutCard(about, undefined)).toMatchObject({ gone: false, title: 'Fresh eggs (as the sender saw it)', kindWords: 'Offer', price: null });
    });

    it('says the listing is no longer up when this reader can\'t see it or it is gone, and shows no title', () => {
        const card = chatAboutCard(about, null);
        expect(card).toMatchObject({ gone: true, title: '', goneWords: 'This listing is no longer up.' });
        expect(chatAboutCard(about, { ...EGGS, status: 'removed' }).gone).toBe(true);
    });

    it('names a Need and an event as such', () => {
        expect(chatAboutCard({ postId: 'n1', title: 't', kind: 'need' }, undefined).kindWords).toBe('Need');
        expect(chatAboutCard({ postId: 'e1', title: 't', kind: 'event' }, undefined).kindWords).toBe('Event');
    });
});

describe('the chip waiting to be sent', () => {
    beforeEach(() => chatAboutDrafts.clear());

    it('is kept per conversation until it is sent or dropped, and a new one replaces it', () => {
        const eggs = aboutOfPost(EGGS)!;
        const honey = aboutOfPost({ id: 'h1', type: 'offer', title: 'Honey', credits: 9 })!;
        chatAboutDrafts.set('c1', eggs);
        chatAboutDrafts.set('c2', honey);
        expect(chatAboutDrafts.get('c1')).toBe(eggs);
        expect(chatAboutDrafts.get('c1')).toBe(chatAboutDrafts.get('c1'));
        chatAboutDrafts.set('c1', honey);
        expect(chatAboutDrafts.get('c1')).toBe(honey);
        chatAboutDrafts.drop('c1');
        expect(chatAboutDrafts.get('c1')).toBeNull();
        expect(chatAboutDrafts.get('c2')).toBe(honey);
        expect(chatAboutDrafts.get(null)).toBeNull();
    });

    it('tells a subscriber when it changes, and not after they leave', () => {
        let n = 0;
        const off = chatAboutDrafts.subscribe(() => { n++; });
        chatAboutDrafts.set('c1', aboutOfPost(EGGS));
        chatAboutDrafts.drop('c1');
        chatAboutDrafts.drop('c1');
        expect(n).toBe(2);
        off();
        chatAboutDrafts.set('c1', aboutOfPost(EGGS));
        expect(n).toBe(2);
    });
});

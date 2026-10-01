import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from '@noble/hashes/utils.js';
import {
    ENTRY_PAD,
    NAMES_LIMITS,
    NamesListCryptoError,
    isNamesEntryCiphertext,
    isNamesEntryId,
    isWrappedNamesKey,
    newNamesEntryId,
    newNamesListKey,
    normaliseNamesEntryText,
    openNamesEntry,
    sealNamesEntry,
    unwrapNamesListKey,
    wrapNamesListKey,
} from '../names-list-crypto.js';
import { openShareAsMember, openWithMemberKey, sealShareToMember, sealToMemberKey } from '../keeper-crypto.js';

/** An Ed25519 identity, in the hex form the apps hold keys in. */
function identity(): { priv: string; pub: string } {
    const priv = randomBytes(32);
    return { priv: Buffer.from(priv).toString('hex'), pub: Buffer.from(ed25519.getPublicKey(priv)).toString('hex') };
}

/** The same seed as PKCS8, the shape the web app stores a key in. */
function pkcs8(seedHex: string): string {
    return '302e020100300506032b657004220420' + seedHex;
}

describe('the list key, wrapped to each admin (the keeper ECDH scheme, its own labels)', () => {
    it('opens for the admin it was wrapped to, from a raw seed or PKCS8', () => {
        const admin = identity();
        const key = newNamesListKey();
        const wrap = wrapNamesListKey(key, admin.pub, 3);
        expect(isWrappedNamesKey(wrap)).toBe(true);
        expect(unwrapNamesListKey(wrap, admin.priv, admin.pub, 3)).toEqual(key);
        expect(unwrapNamesListKey(wrap, pkcs8(admin.priv), admin.pub, 3)).toEqual(key);
    });

    it("doesn't open for anyone else, or as another generation, or as another admin's", () => {
        const alice = identity();
        const bob = identity();
        const wrap = wrapNamesListKey(newNamesListKey(), alice.pub, 2);
        expect(() => unwrapNamesListKey(wrap, bob.priv, bob.pub, 2)).toThrow(NamesListCryptoError);
        // A node serving generation 1's wrap as generation 2 (so new entries go under a key a removed admin still has).
        expect(() => unwrapNamesListKey(wrap, alice.priv, alice.pub, 3)).toThrow(NamesListCryptoError);
        expect(() => unwrapNamesListKey(wrap, alice.priv, alice.pub, 1)).toThrow(NamesListCryptoError);
        // Alice's wrap claimed to be Bob's: the holder is in the associated data, so it doesn't open for Alice either.
        expect(() => unwrapNamesListKey(wrap, alice.priv, bob.pub, 2)).toThrow(NamesListCryptoError);
    });

    it("is kept apart from a recovery fragment: neither opens as the other", () => {
        const admin = identity();
        const secret = randomBytes(32);
        const fragment = sealShareToMember(secret, admin.pub);
        const asWrap = { wrappedKey: fragment.encryptedShare, wrapIv: fragment.shareIv, wrapTag: fragment.shareTag, ephemeralPubkey: fragment.ephemeralPubkey!, kdfParams: JSON.stringify({ alg: 'x25519-xc20p-names-key-v1' }) };
        expect(() => unwrapNamesListKey(asWrap, admin.priv, admin.pub, 1)).toThrow(NamesListCryptoError);
        const wrap = wrapNamesListKey(secret, admin.pub, 1);
        const asFragment = { encryptedShare: wrap.wrappedKey, shareIv: wrap.wrapIv, shareTag: wrap.wrapTag, ephemeralPubkey: wrap.ephemeralPubkey, kdfParams: JSON.stringify({ alg: 'x25519-xc20p-v1' }) };
        expect(() => openShareAsMember(asFragment, admin.priv)).toThrow();
    });

    it('the generic member-key box round-trips under one domain and not another', () => {
        const m = identity();
        const domain = { alg: 'test-alg-v1', info: 'test-info', aad: 'test-aad' };
        const box = sealToMemberKey(new Uint8Array([1, 2, 3]), m.pub, domain);
        expect(openWithMemberKey(box, m.priv, domain)).toEqual(new Uint8Array([1, 2, 3]));
        expect(() => openWithMemberKey(box, m.priv, { ...domain, aad: 'other' })).toThrow();
        expect(() => openWithMemberKey(box, m.priv, { ...domain, info: 'other' })).toThrow();
    });

    it('refuses a bad generation, holder or key length before sealing', () => {
        const admin = identity();
        expect(() => wrapNamesListKey(newNamesListKey(), admin.pub, 0)).toThrow(NamesListCryptoError);
        expect(() => wrapNamesListKey(newNamesListKey(), 'not-a-key', 1)).toThrow(NamesListCryptoError);
        expect(() => wrapNamesListKey(new Uint8Array(16), admin.pub, 1)).toThrow(NamesListCryptoError);
    });
});

describe('an entry, sealed under the list key', () => {
    it('round-trips a name and a note, in any script', () => {
        const key = newNamesListKey();
        const id = newNamesEntryId();
        expect(isNamesEntryId(id)).toBe(true);
        const text = { name: 'Ngozi Adébáyọ̀ 王小明', note: 'Damo’s neighbour, Left Bank Rd.\nMet at the Saturday market.' };
        const sealed = sealNamesEntry(key, id, 1, text);
        expect(isNamesEntryCiphertext(sealed)).toBe(true);
        expect(openNamesEntry(key, id, 1, sealed)).toEqual(text);
        expect(sealed).not.toContain('Ngozi');
        expect(sealed).not.toContain(Buffer.from('Ngozi').toString('base64').slice(0, 6));
    });

    it("doesn't open under another id, generation or key, nor once altered", () => {
        const key = newNamesListKey();
        const id = newNamesEntryId();
        const sealed = sealNamesEntry(key, id, 4, { name: 'Bob Smith', note: '' });
        expect(() => openNamesEntry(key, newNamesEntryId(), 4, sealed)).toThrow(NamesListCryptoError);
        expect(() => openNamesEntry(key, id, 5, sealed)).toThrow(NamesListCryptoError);
        expect(() => openNamesEntry(newNamesListKey(), id, 4, sealed)).toThrow(NamesListCryptoError);
        const parsed = JSON.parse(sealed);
        const bytes = Buffer.from(parsed.c, 'base64');
        bytes[0] ^= 1;
        expect(() => openNamesEntry(key, id, 4, JSON.stringify({ ...parsed, c: bytes.toString('base64') }))).toThrow(NamesListCryptoError);
    });

    it('pads, so the sealed length says little about the name', () => {
        const key = newNamesListKey();
        const id = newNamesEntryId();
        const a = JSON.parse(sealNamesEntry(key, id, 1, { name: 'Al', note: '' }));
        const b = JSON.parse(sealNamesEntry(key, id, 1, { name: 'Alexandra Montgomery', note: '' }));
        expect(Buffer.from(a.c, 'base64').length).toBe(ENTRY_PAD + 16);
        expect(Buffer.from(b.c, 'base64').length).toBe(ENTRY_PAD + 16);
    });

    it('the longest name and note, in four-byte characters and quotes, fit the stored limit', () => {
        const key = newNamesListKey();
        const sealed = sealNamesEntry(key, newNamesEntryId(), 1, { name: '𝔅'.repeat(NAMES_LIMITS.nameChars), note: '"𝔅'.repeat(NAMES_LIMITS.noteChars / 2) });
        expect(sealed.length).toBeLessThanOrEqual(NAMES_LIMITS.ciphertextChars);
        expect(isNamesEntryCiphertext(sealed)).toBe(true);
    });

    it('the node takes only the sealed shape: never a name in the clear', () => {
        for (const bad of ['Bob Smith', '{"name":"Bob Smith"}', JSON.stringify({ v: 1, n: 'Qm9i', c: 'U21pdGg=' }),
            JSON.stringify({ v: 2, n: Buffer.alloc(24).toString('base64'), c: Buffer.alloc(80).toString('base64') }),
            JSON.stringify({ v: 1, n: Buffer.alloc(24).toString('base64'), c: Buffer.alloc(80).toString('base64'), name: 'Bob' }),
            '', 'x'.repeat(NAMES_LIMITS.ciphertextChars + 1), 42, null]) {
            expect(isNamesEntryCiphertext(bad)).toBe(false);
        }
    });

    it('a name is required; control characters go; the limits hold', () => {
        expect(normaliseNamesEntryText({ name: '  ', note: 'x' }).ok).toBe(false);
        expect(normaliseNamesEntryText({ name: 'a'.repeat(NAMES_LIMITS.nameChars + 1) }).ok).toBe(false);
        expect(normaliseNamesEntryText({ name: 'A', note: 'n'.repeat(NAMES_LIMITS.noteChars + 1) }).ok).toBe(false);
        const ok = normaliseNamesEntryText({ name: ' Bob\u0007\n Smith ', note: ' line one\nline two\u0000 ' });
        expect(ok).toEqual({ ok: true, value: { name: 'Bob Smith', note: 'line one\nline two' } });
        expect(() => sealNamesEntry(newNamesListKey(), newNamesEntryId(), 1, { name: '', note: '' })).toThrow(NamesListCryptoError);
    });
});

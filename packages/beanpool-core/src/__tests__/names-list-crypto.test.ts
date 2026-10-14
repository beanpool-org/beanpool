import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from '@noble/hashes/utils.js';
import {
    ENTRY_PAD,
    NAMES_LIMITS,
    NAMES_RING_ALG,
    NamesListCryptoError,
    isNamesEntryCiphertext,
    isNamesEntryId,
    isNamesRingBox,
    namesBoxDigest,
    newNamesEntryId,
    newNamesListKey,
    normaliseNamesEntryText,
    openNamesEntry,
    openNamesPinBlob,
    openNamesRing,
    sealNamesEntry,
    sealNamesPinBlob,
    sealNamesRing,
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

const hex64 = () => Buffer.from(randomBytes(32)).toString('hex');
/** Two generation ids: an entry is sealed under the key of one. */
const K1 = hex64();
const K2 = hex64();

describe('the ring box: every key a phone holds, sealed to one admin (the keeper ECDH scheme, its own labels)', () => {
    const ctx = (from: string, to: string, headId: string) => ({ communityId: 'a1b2c3d4e5f60718', from, to, headId });

    it('opens for the admin it was sealed to, from a raw seed or PKCS8, with every key in it', () => {
        const [giver, admin] = [identity(), identity()];
        const head = hex64();
        const ring = { [K1]: newNamesListKey(), [K2]: newNamesListKey() };
        const box = sealNamesRing(ring, ctx(giver.pub, admin.pub, head));
        expect(isNamesRingBox(box)).toBe(true);
        expect(JSON.parse(box.kdfParams).alg).toBe(NAMES_RING_ALG);
        expect(openNamesRing(box, admin.priv, ctx(giver.pub, admin.pub, head))).toEqual(ring);
        expect(openNamesRing(box, pkcs8(admin.priv), ctx(giver.pub, admin.pub, head))).toEqual(ring);
    });

    it("doesn't open for anyone else, or as another giver's, or under another head or community", () => {
        const [giver, alice, bob] = [identity(), identity(), identity()];
        const head = hex64();
        const box = sealNamesRing({ [K1]: newNamesListKey() }, ctx(giver.pub, alice.pub, head));
        expect(() => openNamesRing(box, bob.priv, ctx(giver.pub, bob.pub, head))).toThrow(NamesListCryptoError);
        expect(() => openNamesRing(box, alice.priv, ctx(bob.pub, alice.pub, head))).toThrow(NamesListCryptoError);
        expect(() => openNamesRing(box, alice.priv, ctx(giver.pub, alice.pub, hex64()))).toThrow(NamesListCryptoError);
        expect(() => openNamesRing(box, alice.priv, { ...ctx(giver.pub, alice.pub, head), communityId: 'ffffffffffffffff' })).toThrow(NamesListCryptoError);
    });

    it('its digest names its five fields: any change to the box is a different digest', () => {
        const [giver, admin] = [identity(), identity()];
        const box = sealNamesRing({ [K1]: newNamesListKey() }, ctx(giver.pub, admin.pub, hex64()));
        const d = namesBoxDigest(box);
        expect(d).toMatch(/^[0-9a-f]{64}$/);
        for (const f of ['sealedRing', 'ringIv', 'ringTag', 'ephemeralPubkey', 'kdfParams'] as const) {
            expect(namesBoxDigest({ ...box, [f]: box[f] + 'A' })).not.toBe(d);
        }
    });

    it('is kept apart from a recovery fragment: neither opens as the other', () => {
        const admin = identity();
        const secret = randomBytes(32);
        const fragment = sealShareToMember(secret, admin.pub);
        const asBox = {
            sealedRing: fragment.encryptedShare, ringIv: fragment.shareIv, ringTag: fragment.shareTag, ephemeralPubkey: fragment.ephemeralPubkey!,
            kdfParams: JSON.stringify({ alg: NAMES_RING_ALG }),
        };
        expect(() => openNamesRing(asBox, admin.priv, ctx(admin.pub, admin.pub, hex64()))).toThrow(NamesListCryptoError);
        const box = sealNamesRing({ [K1]: secret }, ctx(admin.pub, admin.pub, hex64()));
        const asFragment = { encryptedShare: box.sealedRing, shareIv: box.ringIv, shareTag: box.ringTag, ephemeralPubkey: box.ephemeralPubkey, kdfParams: JSON.stringify({ alg: 'x25519-xc20p-v1' }) };
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

    it('refuses an empty ring, a bad id, a bad recipient or a key of the wrong length before sealing', () => {
        const admin = identity();
        const c = ctx(admin.pub, admin.pub, hex64());
        expect(() => sealNamesRing({}, c)).toThrow(NamesListCryptoError);
        expect(() => sealNamesRing({ 'not-an-id': newNamesListKey() }, c)).toThrow(NamesListCryptoError);
        expect(() => sealNamesRing({ [K1]: newNamesListKey() }, { ...c, to: 'not-a-key' })).toThrow(NamesListCryptoError);
        expect(() => sealNamesRing({ [K1]: new Uint8Array(16) }, c)).toThrow(NamesListCryptoError);
    });
});

describe('the pin at rest: sealed under a key in the secure store', () => {
    it('opens with its key and label only, and holds nothing readable', () => {
        const key = newNamesListKey();
        const blob = sealNamesPinBlob('{"v":3,"ring":{"x":"y"}}', key, 'beanpool:names-trust:x:y');
        expect(blob).not.toContain('ring');
        expect(openNamesPinBlob(blob, key, 'beanpool:names-trust:x:y')).toBe('{"v":3,"ring":{"x":"y"}}');
        expect(openNamesPinBlob(blob, newNamesListKey(), 'beanpool:names-trust:x:y')).toBeNull();
        expect(openNamesPinBlob(blob, key, 'beanpool:names-trust:x:z')).toBeNull();
        expect(openNamesPinBlob('not json', key, 'beanpool:names-trust:x:y')).toBeNull();
    });
});

describe('an entry, sealed under one generation’s key', () => {
    it('round-trips a name and a note, in any script', () => {
        const key = newNamesListKey();
        const id = newNamesEntryId();
        expect(isNamesEntryId(id)).toBe(true);
        const text = { name: 'Ngozi Adébáyọ̀ 王小明', note: 'Damo’s neighbour, Left Bank Rd.\nMet at the Saturday market.' };
        const sealed = sealNamesEntry(key, id, K1, text);
        expect(isNamesEntryCiphertext(sealed)).toBe(true);
        expect(openNamesEntry(key, id, K1, sealed)).toEqual(text);
        expect(sealed).not.toContain('Ngozi');
        expect(sealed).not.toContain(Buffer.from('Ngozi').toString('base64').slice(0, 6));
    });

    it("F4 AAD binds id and keyId: doesn't open under another entry id, key id or key, swapped, or once altered", () => {
        const key = newNamesListKey();
        const [id, other] = [newNamesEntryId(), newNamesEntryId()];
        const sealed = sealNamesEntry(key, id, K1, { name: 'Bob Smith', note: '' });
        const sealedOther = sealNamesEntry(key, other, K1, { name: 'Ann Jones', note: '' });
        expect(JSON.parse(sealed).v).toBe(2);
        expect(() => openNamesEntry(key, newNamesEntryId(), K1, sealed)).toThrow(NamesListCryptoError);
        // Relabelled: the server says it was sealed under another generation's key.
        expect(() => openNamesEntry(key, id, K2, sealed)).toThrow(NamesListCryptoError);
        expect(() => openNamesEntry(newNamesListKey(), id, K1, sealed)).toThrow(NamesListCryptoError);
        // Two entries' ciphertexts swapped.
        expect(() => openNamesEntry(key, id, K1, sealedOther)).toThrow(NamesListCryptoError);
        expect(() => openNamesEntry(key, other, K1, sealed)).toThrow(NamesListCryptoError);
        const parsed = JSON.parse(sealed);
        const bytes = Buffer.from(parsed.c, 'base64');
        bytes[0] ^= 1;
        expect(() => openNamesEntry(key, id, K1, JSON.stringify({ ...parsed, c: bytes.toString('base64') }))).toThrow(NamesListCryptoError);
    });

    it('pads, so the sealed length says little about the name', () => {
        const key = newNamesListKey();
        const id = newNamesEntryId();
        const a = JSON.parse(sealNamesEntry(key, id, K1, { name: 'Al', note: '' }));
        const b = JSON.parse(sealNamesEntry(key, id, K1, { name: 'Alexandra Montgomery', note: '' }));
        expect(Buffer.from(a.c, 'base64').length).toBe(ENTRY_PAD + 16);
        expect(Buffer.from(b.c, 'base64').length).toBe(ENTRY_PAD + 16);
    });

    it('the longest name and note, in four-byte characters and quotes, fit the stored limit', () => {
        const key = newNamesListKey();
        const sealed = sealNamesEntry(key, newNamesEntryId(), K1, { name: '𝔅'.repeat(NAMES_LIMITS.nameChars), note: '"𝔅'.repeat(NAMES_LIMITS.noteChars / 2) });
        expect(sealed.length).toBeLessThanOrEqual(NAMES_LIMITS.ciphertextChars);
        expect(isNamesEntryCiphertext(sealed)).toBe(true);
    });

    it('the node takes only the sealed shape: never a name in the clear, nor the first version’s', () => {
        for (const bad of ['Bob Smith', '{"name":"Bob Smith"}', JSON.stringify({ v: 2, n: 'Qm9i', c: 'U21pdGg=' }),
            JSON.stringify({ v: 1, n: Buffer.alloc(24).toString('base64'), c: Buffer.alloc(80).toString('base64') }),
            JSON.stringify({ v: 2, n: Buffer.alloc(24).toString('base64'), c: Buffer.alloc(80).toString('base64'), name: 'Bob' }),
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
        expect(() => sealNamesEntry(newNamesListKey(), newNamesEntryId(), K1, { name: '', note: '' })).toThrow(NamesListCryptoError);
    });
});

import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
    ED25519_PKCS8_HEADER,
    ED25519_PKCS8_LENGTH,
    ED25519_SEED_LENGTH,
    getEd25519Pkcs8Header,
    toEd25519Pkcs8,
    toEd25519Seed,
} from '../ed25519-key.js';

/** A seed with every byte distinct enough to catch an off-by-one in the header slice. */
const seed = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
const pkcs8 = (() => {
    const out = new Uint8Array(ED25519_PKCS8_LENGTH);
    out.set(ED25519_PKCS8_HEADER);
    out.set(seed, ED25519_PKCS8_HEADER.length);
    return out;
})();

describe('Ed25519 private-key formats', () => {
    it('accepts either form and returns the same seed', () => {
        // The point of the whole module: a native-stored key and a PWA-stored key of the
        // same identity must reduce to identical secret bytes, or a key that crosses
        // platforms signs with the wrong ones.
        expect(toEd25519Seed(seed)).toEqual(seed);
        expect(toEd25519Seed(pkcs8)).toEqual(seed);
    });

    it('accepts either form and returns the same PKCS8', () => {
        expect(toEd25519Pkcs8(pkcs8)).toEqual(pkcs8);
        expect(toEd25519Pkcs8(seed)).toEqual(pkcs8);
    });

    it('round-trips in both directions', () => {
        expect(toEd25519Seed(toEd25519Pkcs8(seed))).toEqual(seed);
        expect(toEd25519Pkcs8(toEd25519Seed(pkcs8))).toEqual(pkcs8);
    });

    it('puts the seed after the header, not over it', () => {
        // Guards the off-by-one that would silently shift the secret: a wrapped key must
        // carry the header verbatim and the seed immediately after it.
        const wrapped = toEd25519Pkcs8(seed);
        expect(wrapped.slice(0, ED25519_PKCS8_HEADER.length)).toEqual(new Uint8Array(ED25519_PKCS8_HEADER));
        expect(wrapped.slice(ED25519_PKCS8_HEADER.length)).toEqual(seed);
        expect(wrapped.length).toBe(ED25519_PKCS8_LENGTH);
    });

    it('does not alias the caller’s bytes when unwrapping', () => {
        // slice() copies; if it ever became subarray() a caller zeroing its buffer would
        // wipe a key still in use elsewhere.
        const unwrapped = toEd25519Seed(pkcs8);
        unwrapped[0] ^= 0xff;
        expect(pkcs8[ED25519_PKCS8_HEADER.length]).toBe(seed[0]);
    });

    it('refuses anything that is neither form', () => {
        // Loudly, rather than passing bytes through to be signed over. A wrong-length key
        // that slips past produces a signature that verifies nowhere and a server 401 that
        // looks exactly like a wrong password.
        for (const bad of [0, 16, 31, 33, 47, 49, 64]) {
            expect(() => toEd25519Seed(new Uint8Array(bad))).toThrow(/Unrecognised Ed25519 private key/);
            expect(() => toEd25519Pkcs8(new Uint8Array(bad))).toThrow(/Unrecognised Ed25519 private key/);
        }
    });

    it('refuses 48-byte keys with corrupted ASN.1 PKCS8 headers', () => {
        const corrupt = new Uint8Array(pkcs8);
        corrupt[0] ^= 0xff;
        expect(() => toEd25519Seed(corrupt)).toThrow(/Invalid PKCS8 header/);
        expect(() => toEd25519Pkcs8(corrupt)).toThrow(/Invalid PKCS8 header/);
    });

    it('returns a fresh copy of header via getEd25519Pkcs8Header', () => {
        const h1 = getEd25519Pkcs8Header();
        const h2 = getEd25519Pkcs8Header();
        expect(h1).toEqual(ED25519_PKCS8_HEADER);
        expect(h1).not.toBe(h2);
    });

    it('states the two lengths consistently', () => {
        expect(ED25519_SEED_LENGTH).toBe(32);
        expect(ED25519_PKCS8_HEADER.length).toBe(16);
        expect(ED25519_PKCS8_LENGTH).toBe(48);
    });
});

/**
 * The tests above check our bytes against our own constants, which cannot catch a header
 * that is wrong in the same way twice. WebCrypto is an independent ASN.1 implementation —
 * the same one the PWA signs with — so putting a key through it proves the envelope is
 * genuinely well-formed rather than merely self-consistent.
 */
describe('Ed25519 key formats, checked against WebCrypto', () => {
    const subtle = webcrypto.subtle;
    const message = new TextEncoder().encode('beanpool cross-platform signing check');
    const alg = { name: 'Ed25519' };

    /** BufferSource vs Uint8Array<ArrayBufferLike>; identical at runtime. See api.ts. */
    const buf = (b: Uint8Array) => b as unknown as BufferSource;

    it('wraps a raw seed into an envelope WebCrypto accepts', async () => {
        // The failure this guards: a malformed header is not rejected by our own length
        // checks, but importKey refuses it — or worse, imports a different key. Both
        // surface as a signature the node answers 401 to.
        await expect(
            subtle.importKey('pkcs8', buf(toEd25519Pkcs8(seed)), alg, false, ['sign']),
        ).resolves.toBeDefined();
    });

    it('signs identically whichever form the key was stored in', async () => {
        // The actual claim of the issue: one identity, two storage formats, and the
        // signature must come out the same. Ed25519 is deterministic, so equality here is
        // exact rather than probabilistic.
        const fromSeed = await subtle.importKey('pkcs8', buf(toEd25519Pkcs8(seed)), alg, false, ['sign']);
        const fromPkcs8 = await subtle.importKey('pkcs8', buf(toEd25519Pkcs8(pkcs8)), alg, false, ['sign']);

        const a = new Uint8Array(await subtle.sign(alg, fromSeed, buf(message)));
        const b = new Uint8Array(await subtle.sign(alg, fromPkcs8, buf(message)));
        expect(a).toEqual(b);
    });

    it('survives a WebCrypto-generated key being unwrapped and rewrapped', async () => {
        // Round-trips a key we did not construct, through the seed form the recovery split
        // will operate on, and back. If toEd25519Seed took the wrong 32 bytes, the
        // rewrapped key would verify against a different public key than the original.
        const pair = (await subtle.generateKey(alg, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
        const exported = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
        expect(exported.length).toBe(ED25519_PKCS8_LENGTH);

        const rewrapped = toEd25519Pkcs8(toEd25519Seed(exported));
        const reimported = await subtle.importKey('pkcs8', buf(rewrapped), alg, false, ['sign']);

        const signature = await subtle.sign(alg, reimported, buf(message));
        expect(await subtle.verify(alg, pair.publicKey, signature, buf(message))).toBe(true);
    });
});

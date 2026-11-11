import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';
import * as contacts from '../index.js';
import {
    CONTACTS_COPY_MAX_BYTES, CONTACTS_PAD_STEP, contactsCopyWire, contactsPaddedSize, isContactsPaddedSize, makeContactsCopy, openContactsBox,
    openContactsCopy, readContactsCopy, sealContactsBox, ContactsCryptoError,
} from '../contacts-crypto.js';
import { emptyContactsList, writeContactsList, type Contact } from '../contacts-list.js';
import { toEd25519Pkcs8 } from '../ed25519-key.js';
import {
    checkContactsVectors, contactsVectorNonce, CONTACTS_VECTOR_COPY, CONTACTS_VECTOR_JSON, CONTACTS_VECTOR_KEY_HEX, CONTACTS_VECTOR_PEOPLE,
} from '../contacts-vectors.js';

// The lock of a member's private contacts list (DESIGN-private-contacts-fable.md §4.2, §11 "Core (C0)").

function person(name: string) {
    const seed = sha256(utf8ToBytes(`contacts-crypto.test ${name}`));
    return { seedHex: bytesToHex(seed), pkcs8Hex: bytesToHex(toEd25519Pkcs8(seed)), publicKey: bytesToHex(ed25519.getPublicKey(seed)) };
}
const ana = person('Ana');
const ben = person('Ben');
const me = (p: ReturnType<typeof person>, pkcs8 = false) => ({ publicKey: p.publicKey, privateKey: pkcs8 ? p.pkcs8Hex : p.seedHex });

/** `n` contacts, each with a name and a number of fixed widths. */
function listOf(n: number): string {
    const cs: Contact[] = [];
    for (let i = 0; i < n; i++) {
        cs.push({ id: i.toString(16).padStart(32, '0'), name: `Contact ${String(i).padStart(4, '0')}`, phones: [`0400 000 ${String(i).padStart(3, '0')}`], emails: [], note: '', links: [], invite: null, clock: 0 });
    }
    return writeContactsList({ ...emptyContactsList(), contacts: cs });
}

describe('the shared vectors (phone and web run the same list through their own module)', () => {
    it('core locks and opens the frozen copy byte for byte, with both key spellings, and refuses every changed binding', () => {
        checkContactsVectors(contacts);
    });

    it('the frozen key and locked bytes come from the primitives alone (HKDF of the seed, XChaCha20-Poly1305, the AAD)', () => {
        const seed = hexToBytes(CONTACTS_VECTOR_PEOPLE.ana.seedHex);
        const key = hkdf(sha256, seed, utf8ToBytes('beanpool-contacts'), utf8ToBytes('beanpool-contacts-key/1'), 32);
        expect(bytesToHex(key)).toBe(CONTACTS_VECTOR_KEY_HEX);
        const body = utf8ToBytes(CONTACTS_VECTOR_JSON);
        const padded = new Uint8Array(16384).fill(0x20);
        padded.set(body);
        const nonce = contactsVectorNonce(1);
        const aad = utf8ToBytes(`beanpool-contacts/1|${CONTACTS_VECTOR_PEOPLE.ana.publicKey}|7`);
        const sealed = xchacha20poly1305(key, nonce, aad).encrypt(padded);
        expect(bytesToHex(sha256(concatBytes(nonce, sealed)))).toBe(CONTACTS_VECTOR_COPY.digest);
        const header = ['beanpool-contacts-copy/1', CONTACTS_VECTOR_PEOPLE.ana.publicKey, '7', '16384', CONTACTS_VECTOR_COPY.digest, CONTACTS_VECTOR_COPY.savedAt].join('\n');
        expect(header).toBe(CONTACTS_VECTOR_COPY.header);
        expect(bytesToHex(ed25519.sign(utf8ToBytes(header), seed))).toBe(CONTACTS_VECTOR_COPY.signature);
    });

    it('a key fed in PKCS8 without the normaliser makes another key (the mutation the vectors catch)', () => {
        const raw48 = hexToBytes(CONTACTS_VECTOR_PEOPLE.ana.pkcs8Hex);
        const wrong = hkdf(sha256, raw48, utf8ToBytes('beanpool-contacts'), utf8ToBytes('beanpool-contacts-key/1'), 32);
        expect(bytesToHex(wrong)).not.toBe(CONTACTS_VECTOR_KEY_HEX);
        expect(bytesToHex(contacts.contactsKey(raw48))).toBe(CONTACTS_VECTOR_KEY_HEX);
    });
});

describe('padding: a server sees one of 32 sizes, never a count', () => {
    it('1, 149 and 150 contacts each lock to a whole 16 KiB step: the size moves only when the JSON passes a step', () => {
        const sizes: Record<number, number> = {};
        for (const n of [1, 149, 150]) {
            const json = listOf(n);
            const box = sealContactsBox(json, ana.seedHex, { owner: ana.publicKey, seq: 1 });
            const sealedLen = Buffer.from(box.sealed, 'base64').length;
            expect(box.paddedSize % CONTACTS_PAD_STEP).toBe(0);
            expect(sealedLen).toBe(box.paddedSize + 16);
            expect(box.paddedSize).toBe(Math.ceil(Buffer.byteLength(json) / CONTACTS_PAD_STEP) * CONTACTS_PAD_STEP);
            sizes[n] = box.paddedSize;
        }
        // These contacts are 147 bytes of JSON each (a name, a number, the empty fields): one is 16 KiB; 149 and 150 are both past the first step.
        expect(sizes).toEqual({ 1: 16384, 149: 32768, 150: 32768 });
        // The step itself: the most of these contacts 16 KiB holds, and one more.
        let fit = 1;
        while (Buffer.byteLength(listOf(fit + 1)) <= CONTACTS_PAD_STEP) fit++;
        expect(sealContactsBox(listOf(fit), ana.seedHex, { owner: ana.publicKey, seq: 1 }).paddedSize).toBe(16384);
        expect(sealContactsBox(listOf(fit + 1), ana.seedHex, { owner: ana.publicKey, seq: 1 }).paddedSize).toBe(32768);
    });

    it('the padded text opens to the list as it was, and a list past 512 KiB is refused, not cut', () => {
        const json = listOf(3);
        const box = sealContactsBox(json, ana.seedHex, { owner: ana.publicKey, seq: 2 });
        expect(openContactsBox(box, ana.pkcs8Hex, { owner: ana.publicKey, seq: 2 })).toBe(json);
        expect(contactsPaddedSize(CONTACTS_COPY_MAX_BYTES)).toBe(CONTACTS_COPY_MAX_BYTES);
        expect(() => sealContactsBox(' '.repeat(CONTACTS_COPY_MAX_BYTES + 1), ana.seedHex, { owner: ana.publicKey, seq: 1 })).toThrow(ContactsCryptoError);
        expect([0, 1, 16383, 16385, 16384 * 33].map(isContactsPaddedSize)).toEqual([false, false, false, false, false]);
        expect([16384, 16384 * 32].map(isContactsPaddedSize)).toEqual([true, true]);
    });
});

describe('a copy: the box under its signed header', () => {
    const json = listOf(2);

    it('a server takes a copy only as its owner signed it, and a device opens only its own', () => {
        const copy = makeContactsCopy({ json, me: me(ana), seq: 3 });
        const read = readContactsCopy(contactsCopyWire(copy));
        expect(read.ok && read.copy.owner).toBe(ana.publicKey);
        expect(read.ok && read.copy.seq).toBe(3);
        const opened = openContactsCopy(contactsCopyWire(copy), me(ana, true));
        expect(opened.ok && opened.json).toBe(json);
        expect(openContactsCopy(contactsCopyWire(copy), me(ben))).toEqual({ ok: false, reason: 'not_mine' });
    });

    it('refuses a header changed after signing, a signature by another key, and a box swapped under the header', () => {
        const copy = contactsCopyWire(makeContactsCopy({ json, me: me(ana), seq: 3 }));
        expect(readContactsCopy({ ...copy, header: copy.header.replace('\n3\n', '\n4\n') })).toEqual({ ok: false, reason: 'signature' });
        const bens = makeContactsCopy({ json, me: me(ben), seq: 3 });
        expect(readContactsCopy({ ...copy, signature: bens.signature })).toEqual({ ok: false, reason: 'signature' });
        const other = contactsCopyWire(makeContactsCopy({ json, me: me(ana), seq: 3 }));
        expect(readContactsCopy({ ...copy, nonce: other.nonce, sealed: other.sealed })).toEqual({ ok: false, reason: 'digest' });
        expect(readContactsCopy({ ...copy, header: undefined })).toEqual({ ok: false, reason: 'shape' });
        expect(readContactsCopy(null)).toEqual({ ok: false, reason: 'shape' });
    });

    it('says a wrong size step apart from one over the cap, each signed by the owner (the server answers 400 and 413)', () => {
        const seed = hexToBytes(ana.seedHex);
        const signed = (paddedSize: number, sealedBytes: number) => {
            const nonce = Buffer.alloc(24, 7).toString('base64');
            const sealed = Buffer.alloc(sealedBytes, 1).toString('base64');
            const digest = bytesToHex(sha256(concatBytes(Buffer.alloc(24, 7), Buffer.alloc(sealedBytes, 1))));
            const header = ['beanpool-contacts-copy/1', ana.publicKey, '1', String(paddedSize), digest, '2026-11-11T10:00:00Z'].join('\n');
            return { header, signature: bytesToHex(ed25519.sign(utf8ToBytes(header), seed)), nonce, sealed };
        };
        expect(readContactsCopy(signed(16384 + 100, 16384 + 116))).toEqual({ ok: false, reason: 'size_step' });
        expect(readContactsCopy(signed(16384, 32768 + 16))).toEqual({ ok: false, reason: 'size_step' });
        expect(readContactsCopy(signed(CONTACTS_COPY_MAX_BYTES + CONTACTS_PAD_STEP, CONTACTS_COPY_MAX_BYTES + CONTACTS_PAD_STEP + 16))).toEqual({ ok: false, reason: 'too_big' });
        expect(readContactsCopy(signed(16384, 16384 + 16)).ok).toBe(true);
    });

    it('a copy is never signed for another account than the one whose key locks it', () => {
        expect(() => makeContactsCopy({ json, me: { publicKey: ben.publicKey, privateKey: ana.seedHex }, seq: 1 })).toThrow(ContactsCryptoError);
        expect(() => makeContactsCopy({ json, me: me(ana), seq: 0 })).toThrow(ContactsCryptoError);
    });

    it('every save takes a fresh nonce: the same list saved twice is two different sets of bytes', () => {
        const a = makeContactsCopy({ json, me: me(ana), seq: 5, savedAt: '2026-11-11T10:00:00Z' });
        const b = makeContactsCopy({ json, me: me(ana), seq: 5, savedAt: '2026-11-11T10:00:00Z' });
        expect(a.nonce).not.toBe(b.nonce);
        expect(a.sealed).not.toBe(b.sealed);
    });
});

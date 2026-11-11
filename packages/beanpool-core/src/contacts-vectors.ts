/**
 * Fixed private-contacts vectors, and the check that runs them (scratch/fable-design/DESIGN-private-contacts-fable.md
 * §4.2, §11): shared by core's vitest suite, the phone's runner and the web app's, each handing in ITS OWN contacts module
 * (today core's functions, re-exported), so all three prove the same list locks to the same bytes and opens the same way.
 * Both apps read and write the same locked bytes, so these are the contract between them.
 *
 * The copy below was made once and is frozen. If a change to contacts-crypto.ts or contacts-list.ts stops it matching,
 * that change has made every list already kept unreadable: fix the change, never regenerate the vectors.
 *
 * Kept out of the main index (import `@beanpool/core/contacts-vectors`) so no app bundle carries it. The check throws a
 * plain Error and depends on no test framework.
 *
 * How it was made: Ana's and Ben's seeds are SHA-256("beanpool contacts vector: <name>"), the nonce the first 24 bytes of
 * SHA-256("beanpool contacts vector: nonce 1"), the time fixed. The key and the locked bytes are re-derived from the
 * primitives, independently of contacts-crypto.ts, in core's contacts-crypto.test.ts.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';
import { toEd25519Pkcs8 } from './ed25519-key.js';
import type { ContactsCopy, ContactsCopyOpenRefusal, ContactsCopyRefusal, ContactsCopyWire, ContactsSigner } from './contacts-crypto.js';
import type { ContactsList } from './contacts-list.js';

const seedOf = (name: string) => sha256(utf8ToBytes(`beanpool contacts vector: ${name}`));
export const contactsVectorNonce = (n: number): Uint8Array => sha256(utf8ToBytes(`beanpool contacts vector: nonce ${n}`)).slice(0, 24);

const anaSeed = seedOf('Ana');
const benSeed = seedOf('Ben');
export const CONTACTS_VECTOR_PEOPLE = {
    ana: { seedHex: bytesToHex(anaSeed), pkcs8Hex: bytesToHex(toEd25519Pkcs8(anaSeed)), publicKey: bytesToHex(ed25519.getPublicKey(anaSeed)) },
    ben: { seedHex: bytesToHex(benSeed), pkcs8Hex: bytesToHex(toEd25519Pkcs8(benSeed)), publicKey: bytesToHex(ed25519.getPublicKey(benSeed)) },
};

/** Ana's list: two contacts (one with a link and an invite, names in three scripts) and one removal's marker. */
export const CONTACTS_VECTOR_LIST: ContactsList = {
    v: 1,
    contacts: [
        { id: '0a1b2c3d4e5f60718293a4b5c6d7e8f9', name: 'Dee Walker', phones: ['0412 345 678'], emails: ['dee@example.org'], note: 'Seedlings, Saturdays', links: [], invite: null, clock: 3 },
        {
            id: '1f2e3d4c5b6a79880796a5b4c3d2e1f0', name: 'سامي · சாமி · 山姆', phones: ['+61 400 000 001', '(02) 6600 0000'], emails: [], note: '',
            links: [{ key: 'caeefb18f1fa2bb20453de2522cc259c01d5c3a2ead7c07e4ad9d3fb7e057c2e', community: 'https://byron.beanpool.org', callsign: 'sam_j', how: 'profile', at: '2026-11-01T09:30:00.000Z' }],
            invite: { code: 'K7Q2M9XR', community: 'https://byron.beanpool.org', at: '2026-11-02T08:00:00.000Z' }, clock: 1,
        },
    ],
    removed: [{ id: '2b3c4d5e6f708192a3b4c5d6e7f80910', clock: 5, at: '2026-11-03T12:00:00.000Z' }],
};

/** The list's JSON as both apps write it: keys in their one order, contacts and markers by id. */
export const CONTACTS_VECTOR_JSON = '{"v":1,"contacts":[{"id":"0a1b2c3d4e5f60718293a4b5c6d7e8f9","name":"Dee Walker","phones":["0412 345 678"],"emails":["dee@example.org"],"note":"Seedlings, Saturdays","links":[],"invite":null,"clock":3},{"id":"1f2e3d4c5b6a79880796a5b4c3d2e1f0","name":"سامي · சாமி · 山姆","phones":["+61 400 000 001","(02) 6600 0000"],"emails":[],"note":"","links":[{"key":"caeefb18f1fa2bb20453de2522cc259c01d5c3a2ead7c07e4ad9d3fb7e057c2e","community":"https://byron.beanpool.org","callsign":"sam_j","how":"profile","at":"2026-11-01T09:30:00.000Z"}],"invite":{"code":"K7Q2M9XR","community":"https://byron.beanpool.org","at":"2026-11-02T08:00:00.000Z"},"clock":1}],"removed":[{"id":"2b3c4d5e6f708192a3b4c5d6e7f80910","clock":5,"at":"2026-11-03T12:00:00.000Z"}]}';

/** Ana's contacts key: HKDF-SHA256(her seed, salt "beanpool-contacts", info "beanpool-contacts-key/1"). */
export const CONTACTS_VECTOR_KEY_HEX = 'f46dfa06128e038f50fa7490077908ff0cb7576f470d1ec90af6ef4a78c07ede';

/** The frozen copy: Ana's list as copy 7, locked with nonce 1 and signed at a fixed time. */
export const CONTACTS_VECTOR_COPY = {
    seq: 7,
    savedAt: '2026-11-11T10:00:00Z',
    header: 'beanpool-contacts-copy/1\n21509283fa761e36c7ff7a5fcb6d964a92ff4a38c5abf0ead7a9d2b70ca3d55a\n7\n16384\nc95777b4f93ee076438a2f13459d15b0e31973aca2a264e3586d9bda8b70e6b0\n2026-11-11T10:00:00Z',
    signature: 'bea7edde7e7039453eae2f9eb9b1859476567ba3225499f4f891b043bcfe10820c73fd53174811b6fc8f2d2f89728c83621ba7a36b168d5be046c48da66ba604',
    nonce: 'dMI9p3YrzGEVcKONBEevjq7SuHI5RRXC',
    /** SHA-256 over the nonce's bytes and the locked bytes (16 KiB of padded JSON and the tag): pins every locked byte. */
    digest: 'c95777b4f93ee076438a2f13459d15b0e31973aca2a264e3586d9bda8b70e6b0',
    paddedSize: 16384,
} as const;

/** The parts of an app's contacts module the vectors exercise. */
export interface ContactsVectorApi {
    contactsKey(privateKey: string | Uint8Array): Uint8Array;
    writeContactsList(list: ContactsList): string;
    makeContactsCopy(opts: { json: string; me: ContactsSigner; seq: number; savedAt?: string | Date; nonceForVectors?: Uint8Array }): ContactsCopy;
    readContactsCopy(raw: unknown): { ok: true; copy: ContactsCopy } | ContactsCopyRefusal;
    openContactsCopy(raw: unknown, me: ContactsSigner): { ok: true; json: string; copy: ContactsCopy } | ContactsCopyOpenRefusal;
    sealContactsBox(json: string, privateKey: string | Uint8Array, ctx: { owner: string; seq: number }, nonceForVectors?: Uint8Array): { nonce: string; sealed: string };
    openContactsBox(box: { nonce: string; sealed: string }, privateKey: string | Uint8Array, ctx: { owner: string; seq: number }): string | null;
}

function fail(msg: string): never {
    throw new Error(`contacts vectors: ${msg}`);
}

function signer(who: 'ana' | 'ben', pkcs8: boolean): ContactsSigner {
    const p = CONTACTS_VECTOR_PEOPLE[who];
    return { publicKey: p.publicKey, privateKey: pkcs8 ? p.pkcs8Hex : p.seedHex };
}

function withSealedByteChanged(c: ContactsCopyWire, at: number): ContactsCopyWire {
    const b = Buffer.from(c.sealed, 'base64');
    b[at] ^= 0x01;
    return { ...c, sealed: b.toString('base64') };
}

/**
 * Lock Ana's list with the phone's key spelling and the web app's, compare every byte with the frozen copy; open it with
 * the other spelling; refuse a changed byte, another owner, another number, and a box made from her public key alone.
 */
export function checkContactsVectors(api: ContactsVectorApi): void {
    const json = api.writeContactsList(CONTACTS_VECTOR_LIST);
    if (json !== CONTACTS_VECTOR_JSON) fail('the list is written in another form than the frozen one');
    const ana = CONTACTS_VECTOR_PEOPLE.ana;
    for (const pkcs8 of [false, true]) {
        if (bytesToHex(api.contactsKey(pkcs8 ? ana.pkcs8Hex : ana.seedHex)) !== CONTACTS_VECTOR_KEY_HEX) fail(`the key from ${pkcs8 ? 'a PKCS8' : 'a bare-seed'} identity differs from the frozen one`);
        const copy = api.makeContactsCopy({ json, me: signer('ana', pkcs8), seq: CONTACTS_VECTOR_COPY.seq, savedAt: CONTACTS_VECTOR_COPY.savedAt, nonceForVectors: contactsVectorNonce(1) });
        if (copy.header !== CONTACTS_VECTOR_COPY.header || copy.signature !== CONTACTS_VECTOR_COPY.signature || copy.nonce !== CONTACTS_VECTOR_COPY.nonce
            || copy.digest !== CONTACTS_VECTOR_COPY.digest || copy.paddedSize !== CONTACTS_VECTOR_COPY.paddedSize) {
            fail(`locked with ${pkcs8 ? 'a PKCS8' : 'a bare-seed'} key, the copy differs from the frozen one`);
        }
        // Locked with one spelling, opened with the other: the phone's list on the web, and back.
        const opened = api.openContactsCopy(copy, signer('ana', !pkcs8));
        if (!opened.ok || opened.json !== json) fail(`a copy locked with ${pkcs8 ? 'a PKCS8' : 'a bare-seed'} key did not open with the other spelling`);

        const wire: ContactsCopyWire = { header: copy.header, signature: copy.signature, nonce: copy.nonce, sealed: copy.sealed };
        const read = api.readContactsCopy(wire);
        if (!read.ok) fail(`a server refuses the frozen copy (${read.reason})`);
        // One byte of the locked bytes changed: the server refuses it by its digest, and the box doesn't open either.
        const changed = withSealedByteChanged(wire, 100);
        const r1 = api.readContactsCopy(changed);
        if (r1.ok || r1.reason !== 'digest') fail('a copy with one locked byte changed was taken');
        if (api.openContactsBox(changed, ana.seedHex, { owner: ana.publicKey, seq: CONTACTS_VECTOR_COPY.seq }) !== null) fail('a box with one byte changed opened');
        // Another owner: Ben is refused it, and her box doesn't open as his.
        const ben = CONTACTS_VECTOR_PEOPLE.ben;
        const asBen = api.openContactsCopy(wire, signer('ben', pkcs8));
        if (asBen.ok || asBen.reason !== 'not_mine') fail('another member opened the copy');
        if (api.openContactsBox(wire, ben.seedHex, { owner: ben.publicKey, seq: CONTACTS_VECTOR_COPY.seq }) !== null) fail('the box opened with another member’s key');
        if (api.openContactsBox(wire, ana.seedHex, { owner: ben.publicKey, seq: CONTACTS_VECTOR_COPY.seq }) !== null) fail('the box opened as another member’s');
        // Another number: the box is bound to its own.
        if (api.openContactsBox(wire, ana.seedHex, { owner: ana.publicKey, seq: CONTACTS_VECTOR_COPY.seq + 1 }) !== null) fail('the box opened under another number');
        // The header re-signed by someone else names them, not Ana: refused as not hers.
        const forged = api.makeContactsCopy({ json, me: signer('ben', false), seq: CONTACTS_VECTOR_COPY.seq, savedAt: CONTACTS_VECTOR_COPY.savedAt });
        const asAna = api.openContactsCopy(forged, signer('ana', pkcs8));
        if (asAna.ok || asAna.reason !== 'not_mine') fail('a copy made by another member opened as Ana’s');
    }
    // A box made for Ana, under her key and a number, by someone who knows only her public key (used as if it were the
    // secret): it doesn't open as hers. Her own box under the same owner and number does, so the refusal is the key's.
    const fromPublic = api.sealContactsBox(json, ana.publicKey, { owner: ana.publicKey, seq: 8 });
    if (api.openContactsBox(fromPublic, ana.seedHex, { owner: ana.publicKey, seq: 8 }) !== null) fail('a box made from the public key alone opened');
    if (api.openContactsBox(api.sealContactsBox(json, ana.seedHex, { owner: ana.publicKey, seq: 8 }), ana.seedHex, { owner: ana.publicKey, seq: 8 }) !== json) fail('Ana’s own box did not open');
}

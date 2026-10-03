/**
 * The names list's locked copy on the node (scratch/global-node/DESIGN-names-locked-copy-opus.md §2, §3, §8 items 1–8):
 * an admin's pin, sealed to its own member key and signed by it, kept by the node as a blob it can neither open nor
 * change. Each case below is named by its §8 item.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import {
    NAMES_COPY_STATEMENT, checkNamesCopyAgainst, emptyNamesPin, makeNamesCopy, makeNamesGeneration, makeNamesShare, namesCopyHeader,
    namesPinForNextCopy, readNamesCopy, restoreNamesCopy, namesRingKeys,
    type NamesCopy, type NamesGeneration, type NamesPin, type NamesServerState, type NamesShare, type NamesSigner,
} from '../names-list-trust.js';
import {
    NAMES_COPY_ALG, NAMES_COPY_MAX_BYTES, NAMES_LIMITS, isNamesCopyBox, namesBoxDigest, namesCopyBoxDigest, newNamesListKey, openNamesCopy,
    openNamesRing, sealNamesCopy, sealNamesRing,
} from '../names-list-crypto.js';

const CID = 'a1b2c3d4e5f60718';
const ADDR = 'https://riverside.example.org';

afterEach(() => new Promise<void>((r) => setTimeout(r, 0)));

interface Admin extends NamesSigner { publicKey: string; privateKey: string }
function admin(): Admin {
    const seed = randomBytes(32);
    return { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed) };
}
const pkcs8 = (seedHex: string) => '302e020100300506032b657004220420' + seedHex;
const flip = (s: string) => s.replace(/^./, (c) => (c === '0' ? '1' : c === 'A' ? 'B' : c === '1' ? '0' : 'A'));
const wireGen = (g: NamesGeneration) => ({ statement: g.statement, signature: g.signature, id: g.id, n: g.n });
const wireShare = (s: NamesShare) => ({ header: s.header, signature: s.signature, from: s.from, to: s.to });
const wireCopy = (c: NamesCopy) => ({ header: c.header, signature: c.signature, box: c.box });

/** An admin's pin with a two-statement chain, the keys of both, another admin trusted and a third dropped. */
function scene() {
    const [me, bo, cy] = [admin(), admin(), admin()];
    const g1 = makeNamesGeneration({ communityId: CID, n: 1, parentId: null, drops: [] }, me);
    const g2 = makeNamesGeneration({ communityId: CID, n: 2, parentId: g1.id, drops: [cy.publicKey] }, me);
    const pin: NamesPin = {
        ...emptyNamesPin(CID, me.publicKey),
        trusted: [me.publicKey, bo.publicKey].sort(),
        dropped: { [cy.publicKey]: g2.id },
        chain: [g1, g2].map((g) => ({ statement: g.statement, signature: g.signature, id: g.id, n: g.n })),
        ring: { [g1.id]: bytesToHex(newNamesListKey()), [g2.id]: bytesToHex(newNamesListKey()) },
        seen: ['0'.repeat(32)],
    };
    const saved = namesPinForNextCopy(pin);
    const share = makeNamesShare({ communityId: CID, from: me, to: bo.publicKey, headId: g2.id, ring: namesRingKeys(saved), trusts: saved.trusted });
    const copy = makeNamesCopy({ pin: saved, address: ADDR, me, savedAt: '2026-10-03T14:02:00Z' });
    const state: NamesServerState = {
        communityId: CID, current: { id: g2.id, n: 2 }, generations: [wireGen(g1), wireGen(g2)], shares: [wireShare(share)],
        admins: [{ pubkey: me.publicKey }, { pubkey: bo.publicKey }],
    };
    return { me, bo, cy, g1, g2, pin: saved, share, copy, state };
}

describe('§8.1 round trip', () => {
    it('makeNamesCopy → readNamesCopy → restoreNamesCopy gives back the pin less `seen`, from a raw seed and from PKCS8', () => {
        const { me, pin, copy } = scene();
        expect(pin.copy.seq).toBe(1);
        const read = readNamesCopy(wireCopy(copy));
        expect(read).toMatchObject({ ok: true });
        expect(copy.header.split('\n')[0]).toBe(NAMES_COPY_STATEMENT);
        for (const key of [me.privateKey, pkcs8(me.privateKey)]) {
            const r = restoreNamesCopy(wireCopy(copy), { me: { publicKey: me.publicKey, privateKey: key }, communityId: CID, address: ADDR });
            expect(r).toEqual({ ok: true, pin: { ...pin, seen: [] }, copy: expect.objectContaining({ seq: 1, savedAt: '2026-10-03T14:02:00Z' }) });
        }
    });

    it('the header is the nine lines of §2, in order', () => {
        const { me, g2, copy } = scene();
        const lines = copy.header.split('\n');
        expect(lines).toEqual([NAMES_COPY_STATEMENT, CID, ADDR, me.publicKey, '1', '2', g2.id, '2026-10-03T14:02:00Z', namesCopyBoxDigest(copy.box)]);
        expect(namesCopyHeader(copy)).toBe(copy.header);
    });

    it('an empty chain says 0 and "-"', () => {
        const me = admin();
        const c = makeNamesCopy({ pin: namesPinForNextCopy(emptyNamesPin(CID, me.publicKey)), address: ADDR, me, savedAt: '2026-10-03T14:02:00Z' });
        expect(c.header.split('\n').slice(5, 7)).toEqual(['0', '-']);
        expect(restoreNamesCopy(wireCopy(c), { me, communityId: CID, address: ADDR })).toMatchObject({ ok: true });
    });
});

describe('§8.2 every single-field change refuses', () => {
    const open = (raw: unknown, me: Admin, address = ADDR, communityId = CID) => restoreNamesCopy(raw, { me, communityId, address });

    it('each header line', () => {
        const { me, copy } = scene();
        const lines = copy.header.split('\n');
        const other = admin();
        const changes: string[][] = [
            ['beanpool-names-copy-v2'], [CID, 'ffffffffffffffff'], [ADDR, ADDR + '/x'], [me.publicKey, other.publicKey], ['1', '2'], ['2', '3'],
            [lines[6], 'e'.repeat(64)], ['2026-10-03T14:02:00Z', '2026-10-03T14:02:01Z'], [lines[8], 'd'.repeat(64)],
        ];
        changes.forEach((change, i) => {
            const changed = [...lines];
            changed[i] = change.length === 1 ? change[0] : change[1];
            expect(open({ ...wireCopy(copy), header: changed.join('\n') }, me)).toMatchObject({ ok: false, reason: 'bad_copy' });
        });
        // Even re-signed by the owner, a header that disagrees with its box or its pin is refused.
        for (const [i, v] of [[4, '2'], [5, '3'], [6, 'e'.repeat(64)]] as const) {
            const changed = [...lines];
            changed[i] = v;
            const header = changed.join('\n');
            const signature = bytesToHex(ed25519.sign(utf8ToBytes(header), hexToBytes(me.privateKey)));
            expect(open({ header, signature, box: copy.box }, me)).toMatchObject({ ok: false, reason: 'bad_copy' });
        }
    });

    it('the signature, and each of the five box fields', () => {
        const { me, copy } = scene();
        expect(open({ ...wireCopy(copy), signature: flip(copy.signature) }, me)).toMatchObject({ ok: false, reason: 'bad_copy', detail: 'signature' });
        for (const f of ['sealedCopy', 'copyIv', 'copyTag', 'ephemeralPubkey', 'kdfParams'] as const) {
            const box = { ...copy.box, [f]: f === 'kdfParams' ? JSON.stringify({ alg: NAMES_COPY_ALG, x: 1 }) : flip(copy.box[f]) };
            expect(open({ ...wireCopy(copy), box }, me), f).toMatchObject({ ok: false, reason: 'bad_copy' });
        }
    });

    /** A copy whose payload the owner sealed and signed honestly, but with one thing in it changed. */
    function forgedPayload(me: Admin, pin: NamesPin, payload: unknown, seq = pin.copy.seq, headN = 2, headId = pin.chain[1]?.id ?? '-') {
        const box = sealNamesCopy(JSON.stringify(payload), { communityId: CID, address: ADDR, owner: me.publicKey, seq });
        const header = [NAMES_COPY_STATEMENT, CID, ADDR, me.publicKey, String(seq), String(headN), headId, '2026-10-03T14:02:00Z', namesCopyBoxDigest(box)].join('\n');
        return { header, signature: bytesToHex(ed25519.sign(utf8ToBytes(header), hexToBytes(me.privateKey))), box };
    }

    it("the payload's v, the pin's me, communityId, head n, head id, and copy.seq not matching the header", () => {
        const { me, pin, g1 } = scene();
        const kept: Partial<NamesPin> = { ...pin };
        delete kept.seen;
        expect(open(forgedPayload(me, pin, { v: 1, pin: kept }), me)).toMatchObject({ ok: true });
        expect(open(forgedPayload(me, pin, { v: 2, pin: kept }), me)).toMatchObject({ ok: false, reason: 'bad_copy', detail: 'version' });
        expect(open(forgedPayload(me, pin, { v: 1, pin: { ...kept, me: admin().publicKey } }), me)).toMatchObject({ ok: false, reason: 'bad_copy', detail: 'pin' });
        expect(open(forgedPayload(me, pin, { v: 1, pin: { ...kept, communityId: 'ffffffffffffffff' } }), me)).toMatchObject({ ok: false, reason: 'bad_copy' });
        expect(open(forgedPayload(me, pin, { v: 1, pin: kept }, 1, 1), me)).toMatchObject({ ok: false, reason: 'bad_copy', detail: 'head' });
        expect(open(forgedPayload(me, pin, { v: 1, pin: kept }, 1, 2, g1.id), me)).toMatchObject({ ok: false, reason: 'bad_copy', detail: 'head' });
        expect(open(forgedPayload(me, pin, { v: 1, pin: { ...kept, copy: { seq: 2 } } }), me)).toMatchObject({ ok: false, reason: 'bad_copy', detail: 'seq' });
    });

    it('another account, another community, another address', () => {
        const { me, copy } = scene();
        expect(open(wireCopy(copy), admin())).toMatchObject({ ok: false, reason: 'bad_copy', detail: 'not_mine' });
        expect(open(wireCopy(copy), me, ADDR, 'ffffffffffffffff')).toMatchObject({ ok: false, reason: 'bad_copy', detail: 'other_community' });
        expect(open(wireCopy(copy), me, 'https://elsewhere.example.org')).toEqual({ ok: false, reason: 'other_address', detail: 'other_address', address: ADDR });
    });
});

describe('§8.3 forgery: the signature is load-bearing', () => {
    it('a box sealed to the admin by someone else, unsigned or signed by another key, is refused', () => {
        const { me, pin } = scene();
        const kept: Partial<NamesPin> = { ...pin };
        delete kept.seen;
        const box = sealNamesCopy(JSON.stringify({ v: 1, pin: kept }), { communityId: CID, address: ADDR, owner: me.publicKey, seq: 1 });
        // The box opens for the admin: sealing alone authenticates nothing.
        expect(openNamesCopy(box, me.privateKey, { communityId: CID, address: ADDR, owner: me.publicKey, seq: 1 })).toContain('"v":1');
        const header = [NAMES_COPY_STATEMENT, CID, ADDR, me.publicKey, '1', '2', pin.chain[1].id, '2026-10-03T14:02:00Z', namesCopyBoxDigest(box)].join('\n');
        const mallory = admin();
        const ctx = { me, communityId: CID, address: ADDR };
        expect(restoreNamesCopy({ header, signature: '', box }, ctx)).toMatchObject({ ok: false, reason: 'bad_copy', detail: 'signature' });
        expect(restoreNamesCopy({ header, signature: bytesToHex(ed25519.sign(utf8ToBytes(header), hexToBytes(mallory.privateKey))), box }, ctx))
            .toMatchObject({ ok: false, reason: 'bad_copy', detail: 'signature' });
        expect(readNamesCopy({ header, signature: '', box })).toMatchObject({ ok: false, detail: 'signature' });
    });
});

describe('§8.4 domain separation', () => {
    it("a ring box doesn't open as a copy, nor a copy as a ring box; share and statement texts don't read as a copy header, nor the other way", () => {
        const { me, bo, g2, pin, share, copy } = scene();
        const ring = sealNamesRing(namesRingKeys(pin), { communityId: CID, from: me.publicKey, to: me.publicKey, headId: g2.id });
        const asCopy = { sealedCopy: ring.sealedRing, copyIv: ring.ringIv, copyTag: ring.ringTag, ephemeralPubkey: ring.ephemeralPubkey, kdfParams: ring.kdfParams };
        expect(isNamesCopyBox(asCopy)).toBe(false);
        expect(() => openNamesCopy(asCopy, me.privateKey, { communityId: CID, address: ADDR, owner: me.publicKey, seq: 1 })).toThrow();
        // Even with the copy's alg written in, the HKDF info and AAD differ.
        expect(() => openNamesCopy({ ...asCopy, kdfParams: JSON.stringify({ alg: NAMES_COPY_ALG }) }, me.privateKey, { communityId: CID, address: ADDR, owner: me.publicKey, seq: 1 })).toThrow();
        const asRing = { sealedRing: copy.box.sealedCopy, ringIv: copy.box.copyIv, ringTag: copy.box.copyTag, ephemeralPubkey: copy.box.ephemeralPubkey, kdfParams: copy.box.kdfParams };
        expect(() => openNamesRing(asRing, me.privateKey, { communityId: CID, from: me.publicKey, to: me.publicKey, headId: g2.id })).toThrow();
        expect(() => openNamesRing({ ...asRing, kdfParams: ring.kdfParams }, me.privateKey, { communityId: CID, from: me.publicKey, to: me.publicKey, headId: g2.id })).toThrow();
        expect(namesCopyBoxDigest(copy.box)).toBe(namesBoxDigest(asRing));
        expect(readNamesCopy({ header: share.header, signature: share.signature, box: copy.box })).toMatchObject({ ok: false, detail: 'shape' });
        expect(readNamesCopy({ header: g2.statement, signature: g2.signature, box: copy.box })).toMatchObject({ ok: false, detail: 'shape' });
        void bo;
    });
});

describe('§8.5 cross-checks for a wiped phone (§3)', () => {
    const restored = (s: ReturnType<typeof scene>) => {
        const r = restoreNamesCopy(wireCopy(s.copy), { me: s.me, communityId: CID, address: ADDR });
        if (!r.ok) throw new Error(r.detail);
        return r;
    };

    it('the honest newest copy passes every one', () => {
        const s = scene();
        const r = restored(s);
        expect(checkNamesCopyAgainst(r.pin, r.copy, s.state, { seq: 1 })).toEqual({ ok: true });
    });

    it('a copy missing a statement this key made is stale', () => {
        const s = scene();
        const r = restored(s);
        const g3 = makeNamesGeneration({ communityId: CID, n: 3, parentId: s.g2.id, drops: [] }, s.me);
        const state = { ...s.state, generations: [...s.state.generations, wireGen(g3)], current: { id: g3.id, n: 3 } };
        expect(checkNamesCopyAgainst(r.pin, r.copy, state, { seq: 1 })).toEqual({ ok: false, reason: 'stale_copy', detail: 'own_statement' });
        // The same statement as the copy's pending one passes: it was saved before it was posted.
        const withPending = { ...r.pin, pending: { statement: g3.statement, signature: g3.signature, id: g3.id, n: 3, key: bytesToHex(newNamesListKey()) } };
        expect(checkNamesCopyAgainst(withPending, r.copy, state, { seq: 1 })).toEqual({ ok: true });
        // A statement another admin made is not this key's to account for.
        const theirs = makeNamesGeneration({ communityId: CID, n: 3, parentId: s.g2.id, drops: [] }, s.bo);
        expect(checkNamesCopyAgainst(r.pin, r.copy, { ...s.state, generations: [...s.state.generations, wireGen(theirs)] }, { seq: 1 })).toEqual({ ok: true });
    });

    it('a copy missing a key one of its headers named is stale', () => {
        const s = scene();
        const r = restored(s);
        const pin = { ...r.pin, ring: { [s.g1.id]: r.pin.ring[s.g1.id] } };
        expect(checkNamesCopyAgainst(pin, r.copy, s.state, { seq: 1 })).toEqual({ ok: false, reason: 'stale_copy', detail: 'own_share_key' });
    });

    it("a header's headId not on the copy's chain is stale", () => {
        const s = scene();
        const r = restored(s);
        const g3 = makeNamesGeneration({ communityId: CID, n: 3, parentId: s.g2.id, drops: [] }, s.bo);
        const later = makeNamesShare({ communityId: CID, from: s.me, to: s.bo.publicKey, headId: g3.id, ring: { [s.g1.id]: newNamesListKey() }, trusts: [s.bo.publicKey] });
        expect(checkNamesCopyAgainst(r.pin, r.copy, { ...s.state, shares: [...s.state.shares, wireShare(later)] }, { seq: 1 }))
            .toEqual({ ok: false, reason: 'stale_copy', detail: 'own_share_head' });
    });

    it("a header's trusts key in neither trusted nor dropped is stale", () => {
        const s = scene();
        const r = restored(s);
        const dee = admin();
        const later = makeNamesShare({ communityId: CID, from: s.me, to: s.bo.publicKey, headId: s.g2.id, ring: namesRingKeys(r.pin), trusts: [...r.pin.trusted, dee.publicKey] });
        expect(checkNamesCopyAgainst(r.pin, r.copy, { ...s.state, shares: [wireShare(later)] }, { seq: 1 }))
            .toEqual({ ok: false, reason: 'stale_copy', detail: 'own_share_trust' });
        // A key the copy dropped is accounted for (the header came before the drop).
        const before = makeNamesShare({ communityId: CID, from: s.me, to: s.bo.publicKey, headId: s.g1.id, ring: { [s.g1.id]: newNamesListKey() }, trusts: [s.cy.publicKey] });
        expect(checkNamesCopyAgainst(r.pin, r.copy, { ...s.state, shares: [wireShare(before)] }, { seq: 1 })).toEqual({ ok: true });
    });

    it("myCopy.seq disagreeing with the copy, or missing, is stale", () => {
        const s = scene();
        const r = restored(s);
        expect(checkNamesCopyAgainst(r.pin, r.copy, s.state, { seq: 2 })).toEqual({ ok: false, reason: 'stale_copy', detail: 'node_seq' });
        expect(checkNamesCopyAgainst(r.pin, r.copy, s.state, null)).toEqual({ ok: false, reason: 'stale_copy', detail: 'node_seq' });
    });

    it("another key's headers and unsigned junk on the node don't count against the copy", () => {
        const s = scene();
        const r = restored(s);
        const theirs = makeNamesShare({ communityId: CID, from: s.bo, to: s.me.publicKey, headId: 'f'.repeat(64), ring: { ['f'.repeat(64)]: newNamesListKey() }, trusts: [admin().publicKey] });
        const junk = { header: 'x', signature: 'y' };
        const forged = { ...wireShare(theirs), header: theirs.header.replace(s.bo.publicKey, s.me.publicKey) };
        expect(checkNamesCopyAgainst(r.pin, r.copy, { ...s.state, shares: [...s.state.shares, wireShare(theirs), junk, forged] }, { seq: 1 })).toEqual({ ok: true });
    });
});

describe('§8.6 the consistent past (the §3 residual, documented)', () => {
    it('a full old snapshot (old history, old copy, old headers, nothing newer) passes every check: what a wiped phone cannot see', () => {
        const s = scene();
        // The real present: the admin went on to make key 3 and save copy 2. The node serves only the moment of copy 1.
        const r = restoreNamesCopy(wireCopy(s.copy), { me: s.me, communityId: CID, address: ADDR });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(checkNamesCopyAgainst(r.pin, r.copy, s.state, { seq: 1 })).toEqual({ ok: true });
        // The two signals the phone shows instead (§3): when it was saved and which key.
        expect(r.copy.savedAt).toBe('2026-10-03T14:02:00Z');
        expect(r.copy.headN).toBe(2);
    });
});

describe('§8.7 size', () => {
    it('a pin with 1,000 generations and 1,000 ring keys seals under the 1 MiB cap', () => {
        const me = admin();
        const drop = admin().publicKey;
        const chain: NamesPin['chain'] = [];
        const ring: Record<string, string> = {};
        let parent: string | null = null;
        for (let n = 1; n <= NAMES_LIMITS.ringKeys; n++) {
            const g = makeNamesGeneration({ communityId: CID, n, parentId: parent, drops: n > 1 ? [drop] : [] }, me);
            chain.push({ statement: g.statement, signature: g.signature, id: g.id, n });
            ring[g.id] = bytesToHex(newNamesListKey());
            parent = g.id;
        }
        const pin = namesPinForNextCopy({ ...emptyNamesPin(CID, me.publicKey), chain, ring, dropped: { [drop]: chain[1].id }, trusted: [me.publicKey, admin().publicKey].sort() });
        const copy = makeNamesCopy({ pin, address: ADDR, me });
        const bytes = Buffer.from(copy.box.sealedCopy, 'base64').length;
        expect(bytes).toBeLessThan(NAMES_COPY_MAX_BYTES);
        expect(isNamesCopyBox(copy.box)).toBe(true);
        const r = restoreNamesCopy(wireCopy(copy), { me, communityId: CID, address: ADDR });
        expect(r.ok && Object.keys(r.pin.ring).length).toBe(NAMES_LIMITS.ringKeys);
    }, 60_000);

    it('a payload over the cap is refused when sealing, by name', () => {
        const me = admin();
        expect(() => sealNamesCopy('x'.repeat(NAMES_COPY_MAX_BYTES + 1), { communityId: CID, address: ADDR, owner: me.publicKey, seq: 1 })).toThrow(/too big/);
    });
});

describe('§8.8 strict signature (zip215: false)', () => {
    const ED_L = 2n ** 252n + 27742317777372353535851937790883648493n;
    const leToBig = (b: Uint8Array) => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n; };
    const bigToLe32 = (v: bigint) => { const out = new Uint8Array(32); let n = v; for (let i = 0; i < 32; i++) { out[i] = Number(n & 0xffn); n >>= 8n; } return out; };
    function zip215OnlySignature(message: Uint8Array, seed: Uint8Array): Uint8Array {
        const { scalar, pointBytes } = ed25519.utils.getExtendedPublicKey(seed);
        const canonicalIdentity = new Uint8Array(32); canonicalIdentity[0] = 1;
        const nonCanonicalIdentity = new Uint8Array(32).fill(0xff); nonCanonicalIdentity[0] = 0xee; nonCanonicalIdentity[31] = 0x7f;
        const k = leToBig(sha512(new Uint8Array([...canonicalIdentity, ...pointBytes, ...message]))) % ED_L;
        return new Uint8Array([...nonCanonicalIdentity, ...bigToLe32((k * scalar) % ED_L)]);
    }

    it('a copy header signature only ZIP-215 takes is refused', () => {
        const { me, copy } = scene();
        const lax = bytesToHex(zip215OnlySignature(utf8ToBytes(copy.header), hexToBytes(me.privateKey)));
        expect(ed25519.verify(hexToBytes(lax), utf8ToBytes(copy.header), hexToBytes(me.publicKey))).toBe(true);
        expect(readNamesCopy({ ...wireCopy(copy), signature: lax })).toMatchObject({ ok: false, detail: 'signature' });
        expect(restoreNamesCopy({ ...wireCopy(copy), signature: lax }, { me, communityId: CID, address: ADDR })).toMatchObject({ ok: false, detail: 'signature' });
    });
});

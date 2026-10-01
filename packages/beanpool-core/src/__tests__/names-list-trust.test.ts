/**
 * Who a phone takes the names list's key from (names-list-trust.ts; PR #1411's deciding review). The walk is pure: every
 * case here hands it what a server could list, honest or not, and checks which keys the phone would use.
 */
import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { newNamesListKey, wrapNamesListKey } from '../names-list-crypto.js';
import {
    namesWrapDigest, signNamesWrap, verifyNamesWrap, signedNamesWrap, traceNamesTrust, readNamesTrustPin, normaliseNamesDrops,
    type NamesKeyRecord, type NamesOwnWrap, type NamesTrustPin,
} from '../names-list-trust.js';

interface Admin { publicKey: string; privateKey: string }
function admin(): Admin {
    const seed = randomBytes(32);
    return { privateKey: Buffer.from(seed).toString('hex'), publicKey: Buffer.from(ed25519.getPublicKey(seed)).toString('hex') };
}

const COMMUNITY = 'a1b2c3d4e5f60718';

/** What a server lists: every header, and each admin's own wraps. */
class FakeServer {
    rows: (NamesKeyRecord & { wrap: ReturnType<typeof wrapNamesListKey> })[] = [];
    /** An admin's phone signs and sends a wrap. */
    wrapBy(signer: Admin, key: Uint8Array, holder: string, generation: number, drops: string[] = []): void {
        const wrap = wrapNamesListKey(key, holder, generation);
        const s = signedNamesWrap(wrap, { communityId: COMMUNITY, generation, holder, signer, drops });
        this.put({ communityId: COMMUNITY, generation, holder, wrappedBy: signer.publicKey, wrapDigest: namesWrapDigest(wrap), drops: s.drops, signature: s.signature, wrap });
    }
    /** Whoever runs the server writes a row: any key, any signature. */
    put(row: NamesKeyRecord & { wrap: ReturnType<typeof wrapNamesListKey> }): void {
        this.rows = this.rows.filter((r) => !(r.holder === row.holder && r.generation === row.generation));
        this.rows.push(row);
    }
    records(): NamesKeyRecord[] {
        return this.rows.map(({ wrap: _w, ...r }) => r);
    }
    myKeys(holder: string): NamesOwnWrap[] {
        return this.rows.filter((r) => r.holder === holder).map((r) => ({ ...r.wrap, generation: r.generation, wrappedBy: r.wrappedBy, signature: r.signature, drops: r.drops }));
    }
    current(): number {
        return Math.max(0, ...this.rows.map((r) => r.generation));
    }
}

function trace(server: FakeServer, me: Admin, pin: NamesTrustPin | null, generation = server.current()) {
    return traceNamesTrust({ communityId: COMMUNITY, me, pin, records: server.records(), myKeys: server.myKeys(me.publicKey), generation });
}
const pinOf = (...keys: Admin[]): NamesTrustPin => ({ v: 1, communityId: COMMUNITY, trusted: keys.map((k) => k.publicKey) });

describe('a signed wrap', () => {
    it('verifies for its signer over the community, generation, holder, wrap and drops, and for nothing changed', () => {
        const [owen, ada] = [admin(), admin()];
        const wrap = wrapNamesListKey(newNamesListKey(), ada.publicKey, 2);
        const claim = { communityId: COMMUNITY, generation: 2, holder: ada.publicKey, wrappedBy: owen.publicKey, wrapDigest: namesWrapDigest(wrap), drops: [] };
        const sig = signNamesWrap(claim, owen.privateKey);
        expect(verifyNamesWrap(claim, sig)).toBe(true);
        expect(verifyNamesWrap({ ...claim, communityId: 'other' }, sig)).toBe(false);
        expect(verifyNamesWrap({ ...claim, generation: 3 }, sig)).toBe(false);
        expect(verifyNamesWrap({ ...claim, holder: owen.publicKey }, sig)).toBe(false);
        expect(verifyNamesWrap({ ...claim, wrappedBy: ada.publicKey }, sig)).toBe(false);
        expect(verifyNamesWrap({ ...claim, wrapDigest: namesWrapDigest({ ...wrap, wrapIv: wrap.wrapTag + 'AAAAAAAAAAA=' }) }, sig)).toBe(false);
        expect(verifyNamesWrap({ ...claim, drops: [ada.publicKey] }, sig)).toBe(false);
        expect(verifyNamesWrap(claim, 'not a signature')).toBe(false);
        // From PKCS8 too (a key imported from the web app), and never in another key's name.
        expect(signNamesWrap(claim, '302e020100300506032b657004220420' + owen.privateKey)).toBe(sig);
        expect(() => signNamesWrap(claim, ada.privateKey)).toThrow();
    });

    it('drops are a set of keys: case, order and repeats make no difference', () => {
        const [a, b] = [admin(), admin()];
        expect(normaliseNamesDrops([b.publicKey.toUpperCase(), a.publicKey, b.publicKey])).toEqual([a.publicKey, b.publicKey].sort());
        expect(() => normaliseNamesDrops(['nope'])).toThrow();
    });
});

describe('the walk', () => {
    it('the maker of the first key trusts itself; an admin it shares with trusts it on first use and opens the key', () => {
        const [owen, ada] = [admin(), admin()];
        const s = new FakeServer();
        const k1 = newNamesListKey();
        s.wrapBy(owen, k1, owen.publicKey, 1);
        s.wrapBy(owen, k1, ada.publicKey, 1);
        const o = trace(s, owen, null);
        expect(o.keys.get(1)).toEqual(k1);
        expect(o.firstTrust).toBeNull();
        expect(o.pin?.trusted).toEqual([owen.publicKey, ada.publicKey].sort());
        const a = trace(s, ada, null);
        expect(a.keys.get(1)).toEqual(k1);
        expect(a.firstTrust).toBe(owen.publicKey);
        expect(a.currentTraced).toBe(true);
        expect(a.pin?.trusted).toEqual([owen.publicKey, ada.publicKey].sort());
    });

    it("THE REVIEW'S ATTACK: a next-generation wrap written into the server's database is refused, whoever it names as signer", () => {
        const [owen, ada] = [admin(), admin()];
        const s = new FakeServer();
        const k1 = newNamesListKey();
        s.wrapBy(owen, k1, owen.publicKey, 1);
        s.wrapBy(owen, k1, ada.publicKey, 1);
        const adaPin = trace(s, ada, null).pin!;
        // Whoever runs the server: a key of its own, wrapped to Ada as generation 2, named as Owen's, with no real signature.
        const planted = newNamesListKey();
        const wrap = wrapNamesListKey(planted, ada.publicKey, 2);
        s.put({ communityId: COMMUNITY, generation: 2, holder: ada.publicKey, wrappedBy: owen.publicKey, wrapDigest: namesWrapDigest(wrap), drops: [], signature: '00'.repeat(64), wrap });
        const t = trace(s, ada, adaPin);
        expect(t.keys.has(2)).toBe(false);
        expect(t.keys.get(1)).toEqual(k1);
        expect(t.currentTraced).toBe(false);
        expect(t.refused).toEqual([{ generation: 2, wrappedBy: owen.publicKey, reason: 'unsigned' }]);
        // Signed by a key of its own instead: a valid signature, by nobody the phone trusts.
        const operator = admin();
        s.put({ ...s.rows.find((r) => r.generation === 2)!, wrappedBy: operator.publicKey,
            signature: signNamesWrap({ communityId: COMMUNITY, generation: 2, holder: ada.publicKey, wrappedBy: operator.publicKey, wrapDigest: namesWrapDigest(wrap), drops: [] }, operator.privateKey) });
        const t2 = trace(s, ada, adaPin);
        expect(t2.keys.has(2)).toBe(false);
        expect(t2.refused).toEqual([{ generation: 2, wrappedBy: operator.publicKey, reason: 'untrusted' }]);
        expect(t2.pin?.trusted).not.toContain(operator.publicKey);
        // A wrap whose header the server altered (its digest swapped for another wrap's) doesn't verify either.
        const alien = wrapNamesListKey(newNamesListKey(), ada.publicKey, 1);
        const real1 = s.rows.find((r) => r.generation === 1 && r.holder === ada.publicKey)!;
        s.put({ ...real1, wrap: alien });
        expect(trace(s, ada, adaPin).keys.has(1)).toBe(false);
    });

    it('a key the server made an admin, with no trusted signature adding it: none of its wraps or the admins it adds are accepted', () => {
        const [owen, ada, op, friend] = [admin(), admin(), admin(), admin()];
        const s = new FakeServer();
        const k1 = newNamesListKey();
        s.wrapBy(owen, k1, owen.publicKey, 1);
        s.wrapBy(owen, k1, ada.publicKey, 1);
        const adaPin = trace(s, ada, null).pin!;
        const k2 = newNamesListKey();
        s.wrapBy(op, k2, op.publicKey, 2);
        s.wrapBy(op, k2, friend.publicKey, 2);
        s.wrapBy(op, k2, ada.publicKey, 2);
        const t = trace(s, ada, adaPin);
        expect(t.keys.has(2)).toBe(false);
        expect(t.trusted.has(op.publicKey) || t.trusted.has(friend.publicKey)).toBe(false);
        expect(t.currentTraced).toBe(false);
        expect(t.refused[0]).toMatchObject({ generation: 2, reason: 'untrusted' });
    });

    it('an admin added by a trusted admin is trusted, and so is a new key they make later', () => {
        const [owen, ada, cy, dee] = [admin(), admin(), admin(), admin()];
        const s = new FakeServer();
        const k1 = newNamesListKey();
        s.wrapBy(owen, k1, owen.publicKey, 1);
        s.wrapBy(owen, k1, ada.publicKey, 1);
        const adaPin = trace(s, ada, null).pin!;
        // Owen shares with Cy while Ada is away; Cy later makes generation 2 (Dee dropped) and shares it with Ada.
        s.wrapBy(owen, k1, cy.publicKey, 1);
        s.wrapBy(cy, k1, dee.publicKey, 1);
        const k2 = newNamesListKey();
        s.wrapBy(cy, k2, cy.publicKey, 2, [dee.publicKey]);
        s.wrapBy(cy, k2, ada.publicKey, 2);
        const t = trace(s, ada, adaPin);
        expect(t.keys.get(2)).toEqual(k2);
        expect(t.currentTraced).toBe(true);
        expect(t.trusted.has(cy.publicKey)).toBe(true);
        expect(t.trusted.has(dee.publicKey)).toBe(false);
    });

    it('a removed admin, dropped by a trusted admin, can sign nothing after: even with the signature real', () => {
        const [owen, ada, abe] = [admin(), admin(), admin()];
        const s = new FakeServer();
        const k1 = newNamesListKey();
        for (const h of [owen, ada, abe]) s.wrapBy(owen, k1, h.publicKey, 1);
        const owenPin = trace(s, owen, null).pin!;
        expect(owenPin.trusted).toContain(abe.publicKey);
        const k2 = newNamesListKey();
        s.wrapBy(ada, k2, ada.publicKey, 2, [abe.publicKey]);
        s.wrapBy(ada, k2, owen.publicKey, 2);
        const t = trace(s, owen, owenPin);
        expect(t.keys.get(2)).toEqual(k2);
        expect(t.trusted.has(abe.publicKey)).toBe(false);
        // Abe, working with whoever runs the server, makes generation 3 for Owen: refused.
        const k3 = newNamesListKey();
        s.wrapBy(abe, k3, abe.publicKey, 3);
        s.wrapBy(abe, k3, owen.publicKey, 3);
        const t3 = trace(s, owen, t.pin);
        expect(t3.keys.has(3)).toBe(false);
        expect(t3.refused[0]).toMatchObject({ generation: 3, wrappedBy: abe.publicKey, reason: 'untrusted' });
        // A phone that pinned Abe before the drop and opens only now learns the drop from Ada's signed generation 2.
        expect(trace(s, owen, owenPin).trusted.has(abe.publicKey)).toBe(false);
    });

    it("another community's pin: nothing is used, and the pin isn't overwritten", () => {
        const owen = admin();
        const s = new FakeServer();
        s.wrapBy(owen, newNamesListKey(), owen.publicKey, 1);
        const t = trace(s, owen, { v: 1, communityId: 'ffff', trusted: [owen.publicKey] });
        expect(t.otherCommunity).toBe(true);
        expect(t.keys.size).toBe(0);
        expect(t.pin).toBeNull();
    });

    it('nothing accepted with no pin: nothing is pinned (the next open is a first use again)', () => {
        const ada = admin();
        const s = new FakeServer();
        const wrap = wrapNamesListKey(newNamesListKey(), ada.publicKey, 1);
        s.put({ communityId: COMMUNITY, generation: 1, holder: ada.publicKey, wrappedBy: admin().publicKey, wrapDigest: namesWrapDigest(wrap), drops: [], signature: 'ab'.repeat(64), wrap });
        const t = trace(s, ada, null);
        expect(t.keys.size).toBe(0);
        expect(t.pin).toBeNull();
        expect(t.firstTrust).toBeNull();
    });

    it('reads back a stored pin, and nothing else', () => {
        const a = admin();
        expect(readNamesTrustPin({ v: 1, communityId: COMMUNITY, trusted: [a.publicKey, 'junk'] })).toEqual({ v: 1, communityId: COMMUNITY, trusted: [a.publicKey] });
        expect(readNamesTrustPin({ v: 2, communityId: COMMUNITY, trusted: [] })).toBeNull();
        expect(readNamesTrustPin(null)).toBeNull();
    });
});

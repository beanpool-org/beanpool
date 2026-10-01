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
    emptyNamesTrustPin, namesKeyChanges, pinKeyChanges, pinCallsigns, namesKeyQr, namesKeyCode, readNamesKeyCheck, namesKeyCheckMatches,
    pinCheckedKey, namesShareCheck,
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
        const t = trace(s, owen, { ...emptyNamesTrustPin('ffff', owen.publicKey) });
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

    it('reads back a stored pin (and the first version’s, which knew only whom it trusted), and nothing else', () => {
        const a = admin();
        expect(readNamesTrustPin({ v: 1, communityId: COMMUNITY, trusted: [a.publicKey, 'junk'] }))
            .toEqual({ v: 2, communityId: COMMUNITY, trusted: [a.publicKey], names: {}, newest: 0, dropped: {}, replaced: {} });
        const kept = { v: 2, communityId: COMMUNITY, trusted: [a.publicKey], names: { [a.publicKey]: 'Ada', junk: 'x' }, newest: 3, dropped: { [a.publicKey]: 2, bad: 1 }, replaced: { [a.publicKey]: { callsign: 'Ada', at: 3 }, [admin().publicKey]: 'old form' } };
        expect(readNamesTrustPin(kept)).toEqual({ v: 2, communityId: COMMUNITY, trusted: [a.publicKey], names: { [a.publicKey]: 'Ada' }, newest: 3, dropped: { [a.publicKey]: 2 }, replaced: { [a.publicKey]: { callsign: 'Ada', at: 3 } } });
        expect(readNamesTrustPin({ v: 3, communityId: COMMUNITY, trusted: [] })).toBeNull();
        expect(readNamesTrustPin(null)).toBeNull();
    });
});

describe('what the pin remembers (PR #1411, second deciding review)', () => {
    /** Owen made generation 1 for Owen, Ada and Abe; Abe is removed; Ada's phone made 2 (dropping Abe), then Owen made 3. */
    function history() {
        const [owen, ada, abe] = [admin(), admin(), admin()];
        const s = new FakeServer();
        const [k1, k2, k3] = [newNamesListKey(), newNamesListKey(), newNamesListKey()];
        for (const h of [owen, ada, abe]) s.wrapBy(owen, k1, h.publicKey, 1);
        s.wrapBy(ada, k2, ada.publicKey, 2, [abe.publicKey]);
        s.wrapBy(ada, k2, owen.publicKey, 2);
        s.wrapBy(owen, k3, owen.publicKey, 3);
        s.wrapBy(owen, k3, ada.publicKey, 3);
        return { owen, ada, abe, s, k1, k2, k3 };
    }

    it('THE ROLLBACK: a server put back to generation 1 (whose key Abe kept) is refused by a phone that took 2 and 3', () => {
        const { ada, abe, s } = history();
        const seen = trace(s, ada, null);
        expect(seen.keys.has(3) && seen.pin!.newest).toBe(3);
        expect(seen.pin!.dropped).toEqual({ [abe.publicKey]: 2 });
        // Whoever runs the server deletes generations 2 and 3, and puts generation 1 back as it was.
        s.rows = s.rows.filter((r) => r.generation === 1);
        const back = trace(s, ada, seen.pin);
        expect(back.rolledBack).toBe(true);
        // Abe stays out: his generation-1 wrap is older than his drop, so it doesn't bring him back.
        expect(back.trusted.has(abe.publicKey)).toBe(false);
        expect(back.pin!.newest).toBe(3);
        expect(back.pin!.dropped).toEqual({ [abe.publicKey]: 2 });
        // A phone that never saw 2 or 3 has nothing to know it by: the documented first-use limit.
        expect(trace(s, ada, { ...seen.pin!, newest: 0, dropped: {} }).rolledBack).toBe(false);
    });

    it('a dropped admin comes back only by a trusted admin’s wrap made at or after the drop', () => {
        const { owen, ada, abe, s, k3 } = history();
        const pin = trace(s, ada, null).pin!;
        // Abe is made an admin again, and Owen's phone shares generation 3 with him: Ada's phone trusts him again.
        s.wrapBy(owen, k3, abe.publicKey, 3);
        const again = trace(s, ada, pin);
        expect(again.trusted.has(abe.publicKey)).toBe(true);
        expect(again.pin!.dropped).toEqual({});
        void owen;
    });

    it('a maker naming itself as dropped drops nobody: it signed the key it holds', () => {
        const [owen, ada] = [admin(), admin()];
        const s = new FakeServer();
        const [k1, k2] = [newNamesListKey(), newNamesListKey()];
        s.wrapBy(owen, k1, owen.publicKey, 1);
        s.wrapBy(owen, k1, ada.publicKey, 1);
        const pin = trace(s, ada, null).pin!;
        s.wrapBy(owen, k2, owen.publicKey, 2, [owen.publicKey]);
        s.wrapBy(owen, k2, ada.publicKey, 2);
        const t = trace(s, ada, pin);
        expect(t.trusted.has(owen.publicKey) && t.keys.has(2) && t.currentTraced).toBe(true);
    });

    it('A KEY CHANGED UNDER AN ADMIN’S NAME: the old key is dropped for good; the new one is trusted only once checked in person', () => {
        const [owen, ada, op] = [admin(), admin(), admin()];
        // Owen's phone had taken generation 2 (Ada made it) when it noticed.
        let pin = pinCallsigns({ ...emptyNamesTrustPin(COMMUNITY, owen.publicKey), trusted: [owen.publicKey, ada.publicKey].sort(), newest: 2 },
            [{ pubkey: owen.publicKey, callsign: 'Owen' }, { pubkey: ada.publicKey, callsign: 'Ada' }]);
        expect(pin.names[ada.publicKey]).toBe('Ada');
        // The server moved Ada's account to a key of its own.
        const admins = [{ pubkey: owen.publicKey, callsign: 'Owen' }, { pubkey: op.publicKey, callsign: 'ada' }];
        const changes = namesKeyChanges(pin, admins);
        expect(changes).toEqual([{ callsign: 'ada', was: ada.publicKey, now: op.publicKey }]);
        pin = pinKeyChanges(pin, changes);
        expect(pin.trusted).not.toContain(ada.publicKey);
        expect(pin.replaced).toEqual({ [ada.publicKey]: { callsign: 'ada', at: 2 } });
        expect(namesShareCheck(pin, admins[1])).toBe('changed');
        // The old key never comes back from an old wrap: a share Owen made to it before is ignored. What it signed up to
        // generation 2 (the key Owen's phone holds came from Ada) still counts; what it signs for 3 doesn't.
        const s = new FakeServer();
        const [k1, k2, k3] = [newNamesListKey(), newNamesListKey(), newNamesListKey()];
        s.wrapBy(owen, k1, owen.publicKey, 1);
        s.wrapBy(owen, k1, ada.publicKey, 1);
        s.wrapBy(ada, k2, ada.publicKey, 2);
        s.wrapBy(ada, k2, owen.publicKey, 2);
        const t2 = trace(s, owen, pin);
        expect(t2.trusted.has(ada.publicKey)).toBe(false);
        expect(t2.keys.has(2) && t2.currentTraced).toBe(true);
        s.wrapBy(ada, k3, ada.publicKey, 3);
        s.wrapBy(ada, k3, owen.publicKey, 3);
        expect(trace(s, owen, pin).refused[0]).toMatchObject({ generation: 3, reason: 'untrusted' });
        // A look-alike name in another script is not the same name: nothing is flagged, and that key is still unchecked.
        expect(namesKeyChanges({ ...pin, trusted: [...pin.trusted, ada.publicKey], names: { ...pin.names, [ada.publicKey]: 'Ada' } },
            [{ pubkey: op.publicKey, callsign: '\u0410da' }])).toEqual([]);
        expect(namesShareCheck(emptyNamesTrustPin(COMMUNITY, owen.publicKey), { pubkey: op.publicKey, callsign: '\u0410da' })).toBe('check');
        // Checked in person: Ada's real phone shows her key, not the server's, so the operator's never matches.
        expect(namesKeyCheckMatches(namesKeyQr(ada.publicKey), op.publicKey)).toBe(false);
        expect(namesKeyCheckMatches(namesKeyCode(ada.publicKey), op.publicKey)).toBe(false);
        // Ada's new phone, re-keyed for real, does match, and only then is trusted.
        const adaNew = admin();
        expect(namesKeyCheckMatches(namesKeyQr(adaNew.publicKey), adaNew.publicKey)).toBe(true);
        pin = pinCheckedKey(pin, adaNew.publicKey, 'Ada');
        expect(namesShareCheck(pin, { pubkey: adaNew.publicKey, callsign: 'Ada' })).toBe('trusted');
    });

    it('THE THIRD REVIEW’S REPLACED KEY: after this phone dropped it, the old key vouches for no new key, whatever generation it signs', () => {
        // Owen and Ada hold generations 1 and 2; Ada made 2. Owen's phone took both.
        const [owen, ada, x] = [admin(), admin(), admin()];
        const s = new FakeServer();
        const [k1, k2, k3, k4] = [newNamesListKey(), newNamesListKey(), newNamesListKey(), newNamesListKey()];
        s.wrapBy(owen, k1, owen.publicKey, 1);
        s.wrapBy(owen, k1, ada.publicKey, 1);
        s.wrapBy(ada, k2, ada.publicKey, 2);
        s.wrapBy(ada, k2, owen.publicKey, 2);
        let pin = pinCallsigns(trace(s, owen, null).pin!, [{ pubkey: owen.publicKey, callsign: 'Owen' }, { pubkey: ada.publicKey, callsign: 'Ada' }]);
        expect(pin.newest).toBe(2);
        // Ada's account moves to a new key. Owen's phone notices (the old key counts up to 2, what it took), and its
        // generation 3 names her old key as dropped, as installKeyFor does.
        pin = { ...pin, trusted: pin.trusted.filter((k) => k !== ada.publicKey), replaced: { [ada.publicKey]: { callsign: 'Ada', at: 2 } } };
        s.wrapBy(owen, k3, owen.publicKey, 3, [ada.publicKey]);
        const t3 = trace(s, owen, pin);
        expect(t3.keys.has(3) && t3.keys.has(2) && t3.currentTraced).toBe(true);
        pin = t3.pin!;
        expect(pin.dropped).toEqual({ [ada.publicKey]: 3 });
        // Whoever holds Ada's old phone, with whoever runs the server: a wrap of generation 1 (and one of 2), signed with
        // the old key after Owen's phone dropped it, for a fresh key X.
        s.wrapBy(ada, k1, x.publicKey, 1);
        s.wrapBy(ada, k2, x.publicKey, 2);
        expect(trace(s, owen, pin).trusted.has(x.publicKey)).toBe(false);
        // X makes generation 4, for itself and Owen, dropping the old key: refused, and nothing is used under it.
        s.wrapBy(x, k4, x.publicKey, 4, [ada.publicKey]);
        s.wrapBy(x, k4, owen.publicKey, 4);
        const t4 = trace(s, owen, pin);
        expect(t4.trusted.has(x.publicKey)).toBe(false);
        expect(t4.keys.has(4) || t4.currentTraced).toBe(false);
        expect(t4.refused[0]).toMatchObject({ generation: 4, wrappedBy: x.publicKey, reason: 'untrusted' });
        // What the old key signed for this phone itself, up to what it took, still opens: the key Owen's phone holds came from her.
        expect([...t4.keys.keys()].sort()).toEqual([1, 2, 3]);
    });

    it('a replaced key counts only up to the newest generation this phone took, never up to the number the server gives', () => {
        // Owen's phone took only generation 1 when it noticed Ada's key change; the server said the current one was 50.
        const [owen, ada, adaNew] = [admin(), admin(), admin()];
        const s = new FakeServer();
        const k1 = newNamesListKey();
        s.wrapBy(owen, k1, owen.publicKey, 1);
        s.wrapBy(owen, k1, ada.publicKey, 1);
        const seen = pinCallsigns(trace(s, owen, null).pin!, [{ pubkey: owen.publicKey, callsign: 'Owen' }, { pubkey: ada.publicKey, callsign: 'Ada' }]);
        expect(seen.newest).toBe(1);
        // A pin kept with the server's number (as PR #1411's head 5e20acb5 kept it) is held to what the phone took, too.
        const kept = { ...seen, trusted: [owen.publicKey], replaced: { [ada.publicKey]: { callsign: 'Ada', at: 50 } } };
        // With the old key, a generation-40 wrap for Owen: refused, whatever the server calls current.
        const k40 = newNamesListKey();
        s.wrapBy(ada, k40, owen.publicKey, 40);
        for (const generation of [40, 50]) {
            const t = trace(s, owen, kept, generation);
            expect(t.keys.has(40) || t.currentTraced).toBe(false);
            expect(t.refused[0]).toMatchObject({ generation: 40, reason: 'untrusted' });
            expect(t.pin!.replaced[ada.publicKey].at).toBe(1);
        }
        // And a change noticed now is kept at what this phone took (1), not at anything the server says.
        const changes = namesKeyChanges(seen, [{ pubkey: owen.publicKey, callsign: 'Owen' }, { pubkey: adaNew.publicKey, callsign: 'Ada' }]);
        expect(pinKeyChanges(seen, changes).replaced).toEqual({ [ada.publicKey]: { callsign: 'Ada', at: 1 } });
    });

    it('a key’s code: 20 digits in five groups, the same typed any way, and different for another key', () => {
        const [a, b] = [admin(), admin()];
        const code = namesKeyCode(a.publicKey);
        expect(code).toMatch(/^\d{4}( \d{4}){4}$/);
        expect(namesKeyCode(a.publicKey.toUpperCase())).toBe(code);
        expect(namesKeyCode(b.publicKey)).not.toBe(code);
        expect(namesKeyCheckMatches(code.replace(/ /g, '-'), a.publicKey)).toBe(true);
        expect(namesKeyCheckMatches(code.replace(/ /g, ''), a.publicKey)).toBe(true);
        expect(namesKeyCheckMatches(code.slice(0, -1), a.publicKey)).toBe(false);
        expect(readNamesKeyCheck('https://evil.example/' + a.publicKey)).toBeNull();
        expect(readNamesKeyCheck(namesKeyQr(a.publicKey))).toEqual({ kind: 'key', pubkey: a.publicKey });
        expect(readNamesKeyCheck(`${namesKeyQr(a.publicKey)}x`)).toBeNull();
        expect(namesShareCheck(null, { pubkey: a.publicKey, callsign: 'A' })).toBe('check');
    });
});

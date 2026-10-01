/**
 * The names list's trust model, as pure functions over fixtures (scratch/global-node/DESIGN-names-list-trust-fable.md
 * §3, §4, §10). A small in-memory server (`World`) keeps statements and shares the way apps/server engine/names-list.ts
 * does (a statement lands only off the current one, the newest share per pair), and can show each phone something
 * different, as a hostile server would. Each phone runs syncNames, makes what its plan says, and auto-shares: the same
 * steps the app runs (apps/native utils/names-list.ts openNamesList), without the network.
 *
 * Every case is named by its id in §10's matrix.
 */
import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
    NAMES_REFUSAL_REASONS, checkNamesKeyInPerson, emptyNamesPin, makeNamesGeneration, makeNamesGenerationFor, makeNamesShare,
    namesKeyCheckMatches, namesKeyCode, namesKeyQr, namesReplay, namesSharesToSend, readNamesGeneration, readNamesPin, readNamesShare,
    removeNamesKey, syncNames, takeNamesHistory, namesRingKeys, namesShareHeader, namesStatementId, readNamesKeyCheck,
    type NamesGeneration, type NamesPin, type NamesServerState, type NamesShare, type NamesSyncResult, type NamesSigner,
} from '../names-list-trust.js';
import { namesBoxDigest, newNamesListKey, sealNamesRing, openNamesEntry, sealNamesEntry, newNamesEntryId } from '../names-list-crypto.js';

const CID = 'a1b2c3d4e5f60718';

interface Admin extends NamesSigner { publicKey: string; privateKey: string; name: string }
function admin(name: string): Admin {
    const seed = randomBytes(32);
    return { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed), name };
}

const wire = (g: NamesGeneration) => ({ statement: g.statement, signature: g.signature, id: g.id, n: g.n, parentId: g.parentId, maker: g.maker, drops: g.drops });
const wireShare = (s: NamesShare, withBox: boolean) => ({ header: s.header, signature: s.signature, from: s.from, to: s.to, headId: s.headId, keyIds: s.keyIds, trusts: s.trusts, ...(withBox && s.box ? { box: s.box } : {}) });

/** The server: statements by id (a statement lands only off the current one), shares by (from, to), the admins. */
class World {
    gens = new Map<string, NamesGeneration>();
    current: string | null = null;
    shares = new Map<string, NamesShare>();
    admins: Admin[] = [];
    entries: { id: string; keyId: string; ciphertext: string }[] = [];
    /** What the route does: the parent is the current one, the number the next. */
    post(g: NamesGeneration): 201 | 200 | 409 {
        if (this.gens.has(g.id)) return 200;
        const cur = this.current ? this.gens.get(this.current)! : null;
        if ((g.parentId ?? null) !== (cur?.id ?? null) || g.n !== (cur ? cur.n + 1 : 1)) return 409;
        this.gens.set(g.id, g);
        this.current = g.id;
        return 201;
    }
    /** Written straight into the tables, as whoever runs the server can. */
    plant(g: NamesGeneration, current = false): void {
        this.gens.set(g.id, g);
        if (current) this.current = g.id;
    }
    putShare(s: NamesShare): void {
        this.shares.set(`${s.from}|${s.to}`, s);
    }
    keyIdsOf(pubkey: string): string[] {
        const ids = new Set<string>();
        for (const g of this.gens.values()) if (g.maker === pubkey) ids.add(g.id);
        for (const s of this.shares.values()) if (s.to === pubkey || s.from === pubkey) for (const id of s.keyIds) ids.add(id);
        return [...ids];
    }
    holdersOf(id: string): string[] {
        return this.admins.map((a) => a.publicKey).filter((k) => this.keyIdsOf(k).includes(id));
    }
    stateFor(me: string, view: Partial<{ admins: Admin[]; hide: string[]; current: string | null; extraShares: NamesShare[]; communityId: string }> = {}): NamesServerState {
        const admins = view.admins ?? this.admins;
        const current = view.current !== undefined ? view.current : this.current;
        const gens = [...this.gens.values()].filter((g) => !(view.hide ?? []).includes(g.id));
        const cur = current ? this.gens.get(current) ?? null : null;
        const shares = [...this.shares.values(), ...(view.extraShares ?? [])];
        const holders = current ? admins.filter((a) => this.keyIdsOf(a.publicKey).includes(current)) : [];
        return {
            communityId: view.communityId ?? CID,
            current: cur ? { id: cur.id, n: cur.n } : current ? { id: current, n: 99 } : null,
            generations: gens.map(wire),
            shares: shares.map((s) => wireShare(s, s.to === me)),
            admins: admins.map((a) => ({ pubkey: a.publicKey, callsign: a.name, keyIds: this.keyIdsOf(a.publicKey) })),
            nobodyHoldsKey: !!current && holders.length === 0,
            newKeyNeeded: false,
        };
    }
}

/** A phone: its admin's keys and its pin. */
class Phone {
    pin: NamesPin | null = null;
    constructor(readonly who: Admin) {}
    get pk() { return this.who.publicKey; }
    sync(state: NamesServerState): NamesSyncResult {
        const r = syncNames({ pin: this.pin, state, me: this.who });
        if (!(r.plan.kind === 'refused' && r.plan.reason === 'other_community')) this.pin = r.pin;
        return r;
    }
    /** An open as the app runs it: sync; make what the plan says (once); auto-share on ready. */
    open(world: World, view: Parameters<World['stateFor']>[1] = {}): NamesSyncResult {
        let r = this.sync(world.stateFor(this.pk, view));
        if (r.plan.kind === 'make_first' || r.plan.kind === 'make_new') {
            const made = makeNamesGenerationFor(this.pin!, world.stateFor(this.pk, view), this.who, r.plan.kind === 'make_new' ? r.plan.drops : []);
            this.pin = made.pin;
            world.post(made.generation);
            r = this.sync(world.stateFor(this.pk, view));
        }
        if (r.plan.kind === 'ready') for (const s of namesSharesToSend(this.pin!, world.stateFor(this.pk, view), this.who)) world.putShare(s);
        return r;
    }
    meet(other: Phone): void {
        this.pin = checkNamesKeyInPerson(this.pin ?? emptyNamesPin(CID, this.pk), other.pk);
        other.pin = checkNamesKeyInPerson(other.pin ?? emptyNamesPin(CID, other.pk), this.pk);
    }
    ringIds(): string[] { return Object.keys(this.pin?.ring ?? {}); }
    head(): string | undefined { return this.pin?.chain[this.pin.chain.length - 1]?.id; }
    trusts(k: Phone | Admin | string): boolean { return !!this.pin?.trusted.includes(typeof k === 'string' ? k : 'pk' in k ? k.pk : k.publicKey); }
}

/** Owen makes the list's first key; Owen and Ada meet; both phones open: both hold key 1. */
function community(names = ['Owen', 'Ada']): { world: World; phones: Phone[] } {
    const world = new World();
    const admins = names.map(admin);
    world.admins = admins;
    const phones = admins.map((a) => new Phone(a));
    expect(phones[0].open(world).plan.kind).toBe('ready');
    for (const p of phones.slice(1)) phones[0].meet(p);
    for (let i = 0; i < 2; i++) for (const p of phones) p.open(world);
    for (const p of phones) expect(p.open(world).plan.kind).toBe('ready');
    return { world, phones };
}

const curN = (w: World) => w.gens.get(w.current!)!.n;

describe('statements and shares: signed bytes, ids computed here', () => {
    it('a generation reads back only in its one form, signed by its maker; its id is the hash of its bytes', () => {
        const a = admin('Ada');
        const g = makeNamesGeneration({ communityId: CID, n: 1, parentId: null, drops: [] }, a);
        expect(readNamesGeneration(wire(g), CID)).toEqual(g);
        expect(g.id).toBe(namesStatementId(g.statement));
        expect(g.statement.split('\n')[0]).toBe('beanpool-names-gen-v2');
        expect(readNamesGeneration({ ...wire(g), signature: g.signature.replace(/^./, (c) => (c === '0' ? '1' : '0')) }, CID)).toBeNull();
        expect(readNamesGeneration({ ...wire(g), statement: g.statement + '\n' }, CID)).toBeNull();
        expect(readNamesGeneration(wire(g), 'ffffffffffffffff')).toBeNull();
        // Domain separation: a share header signed by the same key never reads as a generation, nor the other way.
        const s = makeNamesShare({ communityId: CID, from: a, to: admin('Bo').publicKey, headId: g.id, ring: { [g.id]: newNamesListKey() }, trusts: [] });
        expect(readNamesGeneration({ statement: s.header, signature: s.signature }, CID)).toBeNull();
        expect(readNamesShare({ header: g.statement, signature: g.signature }, CID)).toBeNull();
    });

    it("A7 the server's id for a statement is never used: the phone computes its own and the chain still links", () => {
        const { world, phones: [owen, ada] } = community();
        const state = world.stateFor(ada.pk);
        state.generations = (state.generations as any[]).map((g) => ({ ...g, id: 'f'.repeat(64), n: 77, maker: owen.pk, parentId: 'e'.repeat(64) }));
        const r = ada.sync(state);
        expect(r.plan.kind).toBe('ready');
        expect(ada.pin!.chain.map((l) => l.id)).toEqual([world.current]);
    });

    it('a share keeps its box only where the box is the one its signed header names', () => {
        const [a, b] = [admin('Ada'), admin('Bo')];
        const g = makeNamesGeneration({ communityId: CID, n: 1, parentId: null, drops: [] }, a);
        const s = makeNamesShare({ communityId: CID, from: a, to: b.publicKey, headId: g.id, ring: { [g.id]: newNamesListKey() }, trusts: [b.publicKey] });
        expect(readNamesShare(wireShare(s, true), CID)?.box).toEqual(s.box);
        const other = sealNamesRing({ [g.id]: newNamesListKey() }, { communityId: CID, from: a.publicKey, to: b.publicKey, headId: g.id });
        const swapped = readNamesShare({ ...wireShare(s, true), box: other }, CID);
        expect(swapped?.box).toBeNull();
        expect(swapped?.trusts).toEqual([a.publicKey, b.publicKey].sort());
    });
});

describe('A. Rows the server writes or alters', () => {
    it('A1 a planted box "to Ada" and a statement n=2 with no valid signature: ignored; plan unchanged; ring unchanged', () => {
        const { world, phones: [owen, ada] } = community();
        const ringBefore = { ...ada.pin!.ring };
        const forged = makeNamesGeneration({ communityId: CID, n: 2, parentId: world.current, drops: [ada.pk] }, owen.who);
        const bad = { ...forged, signature: '0'.repeat(128) };
        world.plant(bad);
        const fakeKey = newNamesListKey();
        const box = sealNamesRing({ [bad.id]: fakeKey }, { communityId: CID, from: owen.pk, to: ada.pk, headId: bad.id });
        const header = namesShareHeader({ communityId: CID, from: owen.pk, to: ada.pk, headId: bad.id, keyIds: [bad.id], trusts: [owen.pk], boxDigest: namesBoxDigest(box) });
        const plantedShare = { header, signature: '1'.repeat(128), box };
        const state = world.stateFor(ada.pk);
        state.shares = [...state.shares, plantedShare];
        const r = ada.sync(state);
        expect(r.plan.kind).toBe('ready');
        expect(r.generations.has(bad.id)).toBe(false);
        expect(ada.pin!.ring).toEqual(ringBefore);
        expect(ada.pin!.chain.length).toBe(1);
        // Named as the current one by the server: refused, nothing taken.
        const named = world.stateFor(ada.pk, { current: bad.id });
        named.current = { id: bad.id, n: 2 };
        const r2 = ada.sync(named);
        expect(r2.plan).toEqual({ kind: 'refused', reason: 'missing_record' });
        expect(ada.pin!.ring).toEqual(ringBefore);
    });

    it('A2 an operator-made admin Z signs a real statement off the current parent: every phone refuses it; nothing shared to Z', () => {
        const { world, phones: [owen, ada] } = community();
        const z = admin('Zed');
        world.admins.push(z);
        world.plant(makeNamesGeneration({ communityId: CID, n: 2, parentId: world.current, drops: [owen.pk, ada.pk] }, z), true);
        for (const p of [owen, ada]) {
            const r = p.sync(world.stateFor(p.pk));
            expect(r.plan).toMatchObject({ kind: 'refused', reason: 'untrusted_maker', maker: z.publicKey, n: 2, canCheck: true });
            expect(p.trusts(z)).toBe(false);
            expect(p.pin!.chain.length).toBe(1);
            expect(namesSharesToSend(p.pin!, world.stateFor(p.pk), p.who).map((s) => s.to)).not.toContain(z.publicKey);
        }
    });

    it("A3 the owner password re-keys Ada to the operator's key O: Owen makes a new key dropping Ada's old one; nothing to O; the real Ada's new key mismatches O; after a real re-key and a mutual scan, the share reaches her new key", () => {
        const { world, phones: [owen, ada] } = community();
        const o = admin('Ada');
        world.admins = [owen.who, o];
        expect(syncNames({ pin: owen.pin, state: world.stateFor(owen.pk), me: owen.who }).plan).toEqual({ kind: 'make_new', drops: [ada.pk] });
        owen.open(world);
        expect(curN(world)).toBe(2);
        expect(world.gens.get(world.current!)!.drops).toEqual([ada.pk]);
        expect(owen.trusts(ada)).toBe(false);
        expect([...world.shares.values()].some((s) => s.to === o.publicKey)).toBe(false);
        // The real Ada's new phone: its QR is not O's.
        const adaNew = new Phone(admin('Ada'));
        expect(namesKeyCheckMatches(namesKeyQr(adaNew.pk), o.publicKey)).toBe(false);
        expect(namesKeyCheckMatches(namesKeyCode(adaNew.pk), o.publicKey)).toBe(false);
        expect(owen.trusts(o.publicKey)).toBe(false);
        // The owner re-keys to her real new key; they meet; Owen's open shares to it.
        world.admins = [owen.who, adaNew.who];
        owen.meet(adaNew);
        owen.open(world);
        expect([...world.shares.values()].some((s) => s.to === adaNew.pk && s.from === owen.pk)).toBe(true);
        expect(adaNew.open(world).plan.kind).toBe('ready');
        expect(adaNew.ringIds()).toContain(world.current);
    });

    it('A4 a look-alike callsign on the operator\'s key: no share to any untrusted key; a scan pins only the scanned key', () => {
        const { world, phones: [owen, ada] } = community();
        const z = admin('Аda'); // Cyrillic А
        world.admins = [owen.who, z];
        owen.open(world);
        expect([...world.shares.values()].some((s) => s.to === z.publicKey)).toBe(false);
        const scanned = owen.pin!;
        owen.pin = checkNamesKeyInPerson(scanned, ada.pk);
        expect(owen.trusts(z)).toBe(false);
        expect(owen.trusts(ada)).toBe(true);
        expect(readNamesKeyCheck(namesKeyQr(ada.pk))).toEqual({ kind: 'key', pubkey: ada.pk });
    });

    it('A5 the server swaps the box in a share to Owen for one from a dropped key, same ids: ignored; ring unchanged; ready', () => {
        const { world, phones: [owen, ada, abe] } = community(['Owen', 'Ada', 'Abe']);
        world.admins = [owen.who, ada.who];
        ada.open(world); // Ada drops Abe: generation 2, shared with Owen.
        owen.open(world);
        expect(owen.trusts(abe)).toBe(false);
        const ringBefore = { ...owen.pin!.ring };
        const real = world.shares.get(`${ada.pk}|${owen.pk}`)!;
        const fake = sealNamesRing({ [world.current!]: newNamesListKey() }, { communityId: CID, from: ada.pk, to: owen.pk, headId: real.headId });
        world.putShare({ ...real, box: fake });
        // And a share from Abe, the dropped key, with the same ids.
        world.putShare(makeNamesShare({ communityId: CID, from: abe.who, to: owen.pk, headId: real.headId, ring: { [world.current!]: newNamesListKey() }, trusts: [abe.pk] }));
        const r = owen.sync(world.stateFor(owen.pk));
        expect(r.plan.kind).toBe('ready');
        expect(owen.pin!.ring).toEqual(ringBefore);
    });

    it('A6 a box that fails its AEAD is skipped; a second trusted sharer sending a different key for the same id: first kept, said', () => {
        const { world, phones: [owen, ada, bea] } = community(['Owen', 'Ada', 'Bea']);
        const id = world.current!;
        const kept = ada.pin!.ring[id];
        // Sealed to someone else, under Bea's own valid header: it doesn't open on Ada's phone.
        const notHers = makeNamesShare({ communityId: CID, from: bea.who, to: owen.pk, headId: id, ring: { [id]: newNamesListKey() }, trusts: [bea.pk] });
        world.putShare({ ...notHers, to: ada.pk });
        let r = ada.sync(world.stateFor(ada.pk));
        expect(ada.pin!.ring[id]).toBe(kept);
        expect(r.notices.filter((n) => n.kind === 'different_keys')).toEqual([]);
        // Bea really signs a different key for key 1.
        world.putShare(makeNamesShare({ communityId: CID, from: bea.who, to: ada.pk, headId: id, ring: { [id]: newNamesListKey() }, trusts: [bea.pk, ada.pk, owen.pk] }));
        r = ada.sync(world.stateFor(ada.pk));
        expect(ada.pin!.ring[id]).toBe(kept);
        expect(r.notices).toContainEqual({ kind: 'different_keys', id, n: 1, from: bea.pk });
    });

    it('A8 the server says another community: refused, the pin unchanged, and no key made even with no history', () => {
        const { world, phones: [owen] } = community();
        const before = owen.pin;
        const state = world.stateFor(owen.pk, { communityId: 'ffffffffffffffff' });
        state.current = null;
        state.generations = [];
        const r = syncNames({ pin: before, state, me: owen.who });
        expect(r.plan).toEqual({ kind: 'refused', reason: 'other_community' });
        expect(r.pin).toBe(before);
    });
});

describe('B. Shares and vouches', () => {
    it('B1 never to a callsign alone: Cy listed but unchecked gets nothing; after a scan, the next open shares', () => {
        const { world, phones: [owen] } = community();
        const cy = new Phone(admin('Cy'));
        world.admins.push(cy.who);
        owen.open(world);
        expect([...world.shares.values()].some((s) => s.to === cy.pk)).toBe(false);
        owen.meet(cy);
        owen.open(world);
        expect([...world.shares.values()].some((s) => s.to === cy.pk && s.from === owen.pk)).toBe(true);
    });

    it('B2 the mutual scan replaces trust on first use: a valid share "from O" to a fresh phone is ignored until it scans Owen', () => {
        const { world, phones: [owen] } = community();
        const [o, cy] = [admin('Op'), new Phone(admin('Cy'))];
        world.admins.push(o, cy.who);
        world.putShare(makeNamesShare({ communityId: CID, from: o, to: cy.pk, headId: world.current!, ring: { [world.current!]: newNamesListKey() }, trusts: [o.publicKey, owen.pk] }));
        let r = cy.open(world);
        expect(r.plan).toMatchObject({ kind: 'refused', reason: 'untrusted_maker', maker: owen.pk, canCheck: true });
        expect(cy.ringIds()).toEqual([]);
        expect(cy.trusts(o)).toBe(false);
        expect(cy.trusts(owen)).toBe(false);
        owen.meet(cy);
        owen.open(world);
        r = cy.open(world);
        expect(r.plan.kind).toBe('ready');
        expect(cy.pin!.ring[world.current!]).toBe(owen.pin!.ring[world.current!]);
        expect(cy.trusts(o)).toBe(false);
    });

    it("B3 a vouch carries: Owen checks Cy; Ada never met Cy but takes Cy from Owen's header, shares to Cy, and Cy takes Ada's later key", () => {
        const { world, phones: [owen, ada] } = community();
        const cy = new Phone(admin('Cy'));
        world.admins.push(cy.who);
        owen.meet(cy);
        owen.open(world);
        cy.open(world);
        expect(cy.trusts(ada)).toBe(true);
        ada.open(world);
        expect(ada.trusts(cy)).toBe(true);
        // Owen leaves; Ada makes the next key; Cy takes it from Ada's share.
        world.admins = [ada.who, cy.who];
        ada.open(world);
        expect(world.gens.get(world.current!)!.maker).toBe(ada.pk);
        const r = cy.open(world);
        expect(r.plan.kind).toBe('ready');
        expect(cy.head()).toBe(world.current);
        expect(cy.ringIds()).toContain(world.current);
    });

    it('B4 a vouch first served after the voucher was dropped: Z stays untrusted', () => {
        const { world, phones: [owen, ada] } = community();
        const z = admin('Zed');
        const oldHeader = makeNamesShare({ communityId: CID, from: owen.who, to: ada.pk, headId: world.current!, ring: namesRingKeys(owen.pin!), trusts: [...owen.pin!.trusted, z.publicKey] });
        world.admins = [ada.who];
        ada.open(world); // drops Owen
        expect(ada.trusts(owen)).toBe(false);
        world.putShare(oldHeader);
        ada.sync(world.stateFor(ada.pk));
        expect(ada.trusts(z)).toBe(false);
    });

    it('B5 re-admission needs a head at or after the drop: Bea in the dark (head 1) vouching Abe re-admits nobody on Owen\'s phone', () => {
        const { world, phones: [owen, abe, bea] } = community(['Owen', 'Abe', 'Bea']);
        const dee = admin('Dee');
        const one = world.current!;
        world.admins = [owen.who, bea.who, dee];
        owen.open(world); // generation 2 drops Abe
        expect(owen.pin!.dropped[abe.pk]).toBe(2);
        world.putShare(makeNamesShare({ communityId: CID, from: bea.who, to: owen.pk, headId: one, ring: namesRingKeys(bea.pin!), trusts: [bea.pk, owen.pk, abe.pk, dee.publicKey] }));
        owen.sync(world.stateFor(owen.pk));
        expect(owen.trusts(abe)).toBe(false);
        expect(owen.pin!.dropped[abe.pk]).toBe(2);
        expect(owen.trusts(dee.publicKey)).toBe(true);
        expect(namesSharesToSend(owen.pin!, world.stateFor(owen.pk), owen.who).map((s) => s.to)).not.toContain(abe.pk);
    });

    it('B6 a real re-admission: Ada (head 3) scans Abe again and her header vouches him; Owen re-admits Abe and shares to him', () => {
        const { world, phones: [owen, ada, abe] } = community(['Owen', 'Ada', 'Abe']);
        world.admins = [owen.who, ada.who];
        owen.open(world); // 2 drops Abe
        ada.open(world);
        world.admins = [owen.who, ada.who, abe.who];
        ada.meet(abe);
        expect(curN(world)).toBe(2);
        ada.open(world);
        expect([...world.shares.values()].some((s) => s.from === ada.pk && s.to === abe.pk)).toBe(true);
        const r = owen.open(world);
        expect(r.plan.kind).toBe('ready');
        expect(owen.trusts(abe)).toBe(true);
        expect(owen.pin!.dropped[abe.pk]).toBeUndefined();
        expect([...world.shares.values()].some((s) => s.from === owen.pk && s.to === abe.pk)).toBe(true);
    });

    it("B7 a share replayed after Ada moved on changes nothing", () => {
        const { world, phones: [owen, ada, abe] } = community(['Owen', 'Ada', 'Abe']);
        const old = world.shares.get(`${owen.pk}|${ada.pk}`)!;
        world.admins = [owen.who, ada.who];
        owen.open(world);
        ada.open(world);
        const before = JSON.stringify(ada.pin);
        world.putShare(old);
        ada.sync(world.stateFor(ada.pk));
        expect(JSON.stringify(ada.pin)).toBe(before);
        expect(ada.trusts(abe)).toBe(false);
    });

    it("B8 a trusted sharer's box with a key for a statement this phone didn't accept: not taken, never passed on", () => {
        const { world, phones: [owen, ada] } = community();
        const q = makeNamesGeneration({ communityId: CID, n: 2, parentId: world.current, drops: [] }, admin('Q'));
        world.plant(q);
        world.putShare(makeNamesShare({ communityId: CID, from: owen.who, to: ada.pk, headId: world.current!, ring: { ...namesRingKeys(owen.pin!), [q.id]: newNamesListKey() }, trusts: owen.pin!.trusted }));
        ada.sync(world.stateFor(ada.pk));
        expect(ada.ringIds()).not.toContain(q.id);
        for (const s of namesSharesToSend(ada.pin!, world.stateFor(ada.pk), ada.who, owen.pk)) expect(s.keyIds).not.toContain(q.id);
    });
});

describe('C. Drops and removal', () => {
    /** C1/C2: Owen dropped `gone` at 2. Bea, shown the old world, takes `gone`'s 2′ and shares her ring to Owen. */
    function inTheDark(goneName: string) {
        const { world, phones: [owen, gone, bea] } = community(['Owen', goneName, 'Bea']);
        const one = world.current!;
        world.admins = [owen.who, bea.who];
        owen.open(world); // 2 drops `gone`
        const two = world.current!;
        expect(owen.pin!.dropped[gone.pk]).toBe(2);
        // The server's other story, for Bea: generation 1 current, `gone` still an admin, and `gone`'s own 2′ off 1.
        const dark = new World();
        dark.admins = [owen.who, gone.who, bea.who];
        dark.gens.set(one, world.gens.get(one)!);
        dark.current = one;
        for (const s of world.shares.values()) if (s.headId === one) dark.putShare(s);
        gone.sync(dark.stateFor(gone.pk));
        const made = makeNamesGenerationFor(gone.pin!, dark.stateFor(gone.pk), gone.who, []);
        gone.pin = made.pin;
        expect(dark.post(made.generation)).toBe(201);
        gone.open(dark);
        const twoPrime = dark.current!;
        // `gone`'s own share to Owen would tell the server Owen holds 2′; without it, Bea's phone sends her ring.
        dark.shares.delete(`${gone.pk}|${owen.pk}`);
        const rb = bea.open(dark);
        expect(rb.plan.kind).toBe('ready');
        expect(bea.head()).toBe(twoPrime);
        expect(bea.ringIds()).toContain(twoPrime);
        // Bea's share to Owen (her ring: 1 and 2′, trusting `gone`) reaches the real server.
        const toOwen = dark.shares.get(`${bea.pk}|${owen.pk}`)!;
        expect(toOwen.headId).toBe(twoPrime);
        expect(toOwen.trusts).toContain(gone.pk);
        world.putShare(toOwen);
        world.plant(dark.gens.get(twoPrime)!);
        world.putShare(dark.shares.get(`${gone.pk}|${bea.pk}`)!);
        return { world, dark, owen, gone, bea, one, two, twoPrime };
    }

    for (const [id, who] of [['C1', 'Abe'], ['C2', 'Ada']] as const) {
        it(`${id} a removed key's generation delivered through an honest in-the-dark share: never taken, its key never imported, its vouch re-admits nobody; Owen is told; Bea takes Owen's history after meeting him`, () => {
            const { world, owen, gone, bea, two, twoPrime } = inTheDark(who);
            const r = owen.sync(world.stateFor(owen.pk));
            expect(r.plan.kind).toBe('ready');
            expect(owen.head()).toBe(two);
            expect(owen.ringIds()).not.toContain(twoPrime);
            expect(owen.trusts(gone)).toBe(false);
            expect(owen.pin!.dropped[gone.pk]).toBe(2);
            expect(r.notices).toContainEqual({ kind: 'other_history', who: bea.pk });
            // Owen's own share to Bea carries key 2, but Bea, on 2′, doesn't take it: she never holds K2 there.
            owen.open(world);
            const b1 = bea.sync(world.stateFor(bea.pk));
            expect(b1.plan).toEqual({ kind: 'refused', reason: 'different_history' });
            expect(bea.ringIds()).not.toContain(two);
            // They meet; Bea takes Owen's history: 2 accepted, `gone` dropped, K2 arrives; 2′ stays as an abandoned key.
            bea.meet(owen);
            bea.pin = takeNamesHistory(bea.pin!, world.stateFor(bea.pk));
            const b2 = bea.open(world);
            expect(b2.plan.kind).toBe('ready');
            expect(bea.head()).toBe(two);
            expect(bea.trusts(gone)).toBe(false);
            expect(bea.ringIds()).toEqual(expect.arrayContaining([two, twoPrime]));
            expect(bea.pin!.abandoned).toEqual([twoPrime]);
        });
    }

    it("C3 drops made before a phone was lost are kept: Ada's 2 drops Abe; Owen never opened; Ada lost and re-keyed; Owen takes 2 then makes 3 dropping Ada's old key", () => {
        const { world, phones: [owen, ada, abe] } = community(['Owen', 'Ada', 'Abe']);
        world.admins = [owen.who, ada.who];
        ada.open(world); // 2 drops Abe, shared with Owen
        const adaNew = admin('Ada');
        world.admins = [owen.who, adaNew];
        const r = owen.open(world);
        expect(owen.pin!.dropped[abe.pk]).toBe(2);
        expect(curN(world)).toBe(3);
        expect(world.gens.get(world.current!)!.drops).toEqual([ada.pk]);
        expect(r.plan.kind).toBe('ready');
        expect(owen.trusts(abe)).toBe(false);
        const abes = makeNamesGeneration({ communityId: CID, n: 4, parentId: world.current, drops: [] }, abe.who);
        world.plant(abes, true);
        expect(owen.sync(world.stateFor(owen.pk)).plan).toMatchObject({ kind: 'refused', reason: 'untrusted_maker', maker: abe.pk });
    });

    it('C4 the server hides a removal from Bea: she holds no key newer than 1, so she has nothing new to pass to Abe', () => {
        const { world, phones: [owen, abe, bea] } = community(['Owen', 'Abe', 'Bea']);
        const one = world.current!;
        const all = [...world.admins];
        world.admins = [owen.who, bea.who];
        owen.open(world);
        const r = bea.sync(world.stateFor(bea.pk, { admins: all, hide: [world.current!], current: one }));
        expect(r.plan.kind).toBe('ready');
        expect(bea.trusts(abe)).toBe(true);
        expect(bea.ringIds()).toEqual([one]);
        for (const s of namesSharesToSend(bea.pin!, world.stateFor(bea.pk, { admins: all, hide: [world.current!], current: one }), bea.who, abe.pk)) expect(s.keyIds).toEqual([one]);
    });

    it("C5 the server omits Cy from Owen's admin list: Owen drops Cy; Cy waits; after a scan the keys come back", () => {
        const { world, phones: [owen, cy] } = community(['Owen', 'Cy']);
        owen.open(world, { admins: [owen.who] });
        expect(owen.trusts(cy)).toBe(false);
        const r = cy.open(world);
        expect(r.notices).toContainEqual({ kind: 'dropped_me', maker: owen.pk, n: 2 });
        expect(r.plan).toMatchObject({ kind: 'wait', holders: [owen.pk] });
        owen.meet(cy);
        owen.open(world);
        expect(cy.open(world).plan.kind).toBe('ready');
    });

    it('C6 a maker dropping itself, and a phone named as dropped: both ignored', () => {
        const { world, phones: [owen, ada] } = community();
        const g = makeNamesGeneration({ communityId: CID, n: 2, parentId: world.current, drops: [ada.pk, owen.pk] }, ada.who);
        world.post(g);
        const r = owen.sync(world.stateFor(owen.pk));
        expect(owen.head()).toBe(g.id);
        expect(owen.trusts(ada)).toBe(true);
        expect(owen.trusts(owen)).toBe(true);
        expect(r.notices).toContainEqual({ kind: 'dropped_me', maker: ada.pk, n: 2 });
        ada.sync(world.stateFor(ada.pk));
        expect(ada.trusts(ada)).toBe(true);
    });

    it('C6 the only holder, out and made an admin again (the server says nobody holds the key, a new key is needed): makes n+1 dropping nobody', () => {
        const { world, phones: [owen] } = community(['Owen']);
        const st = world.stateFor(owen.pk);
        st.nobodyHoldsKey = true;
        st.newKeyNeeded = true;
        const r = owen.sync(st);
        expect(r.plan).toEqual({ kind: 'make_new', drops: [] });
        const made = makeNamesGenerationFor(owen.pin!, st, owen.who, []);
        expect(made.generation.drops).toEqual([]);
        expect(made.generation.n).toBe(2);
    });

    it('C7 a trusted admin drops everyone else: taken (governance, not crypto), the self-drop ignored, Bea dropped; Owen waits on Ada and is told', () => {
        const { world, phones: [owen, ada, bea] } = community(['Owen', 'Ada', 'Bea']);
        const made = makeNamesGenerationFor(ada.pin!, world.stateFor(ada.pk), ada.who, [owen.pk, bea.pk]);
        ada.pin = made.pin;
        world.post(made.generation);
        ada.open(world);
        const r = owen.sync(world.stateFor(owen.pk));
        expect(owen.head()).toBe(made.generation.id);
        expect(owen.trusts(bea)).toBe(false);
        expect(r.notices).toContainEqual({ kind: 'dropped_me', maker: ada.pk, n: 2 });
        expect(r.plan).toMatchObject({ kind: 'wait', holders: [ada.pk] });
        expect(owen.ringIds()).not.toContain(made.generation.id);
    });

    it("C8 remove a key by hand while the server still lists it: a new key without it; Ada's old key holds nothing after; her new phone needs a scan", () => {
        const { world, phones: [owen, ada] } = community();
        owen.pin = removeNamesKey(owen.pin!, ada.pk);
        const r = owen.sync(world.stateFor(owen.pk));
        expect(r.plan).toEqual({ kind: 'make_new', drops: [ada.pk] });
        owen.open(world);
        expect(world.gens.get(world.current!)!.drops).toEqual([ada.pk]);
        expect(owen.trusts(ada)).toBe(false);
        expect(owen.pin!.manualDrops).toEqual([]);
        expect([...world.shares.values()].filter((s) => s.to === ada.pk && s.keyIds.includes(world.current!))).toEqual([]);
        const adaNew = new Phone(admin('Ada'));
        world.admins = [owen.who, adaNew.who];
        expect(adaNew.open(world).plan).toMatchObject({ kind: 'refused', reason: 'untrusted_maker' });
    });

    it("C9 a drop is due but this phone lacks the current key: it waits for Ada, makes nothing, and its own removals ride into the next key it makes", () => {
        const { world, phones: [owen, ada, cy, abe] } = community(['Owen', 'Ada', 'Cy', 'Abe']);
        // Ada makes 2 (dropping nobody); Cy takes it but Ada's box hasn't arrived.
        const made = makeNamesGenerationFor(ada.pin!, world.stateFor(ada.pk), ada.who, []);
        ada.pin = made.pin;
        world.post(made.generation);
        ada.sync(world.stateFor(ada.pk));
        world.admins = [owen.who, ada.who, cy.who];
        cy.pin = removeNamesKey(cy.pin!, owen.pk);
        const r = cy.sync(world.stateFor(cy.pk));
        expect(r.plan).toMatchObject({ kind: 'wait', newKeyNeeded: true, holders: [ada.pk], drops: [abe.pk, owen.pk].sort() });
        expect(world.current).toBe(made.generation.id);
        // Ada's next open makes 3 without Abe and sends it; Cy then holds it, and her own removal of Owen makes 4.
        ada.open(world);
        const r2 = cy.open(world);
        expect(world.gens.get(world.current!)!.maker).toBe(cy.pk);
        expect(world.gens.get(world.current!)!.drops).toEqual([owen.pk]);
        expect(r2.plan.kind).toBe('ready');
    });
});

describe('D. Lost phones, re-keys, dead ends', () => {
    it('D1 the POST lands but the phone dies before saving: the pending key was saved first and moves into the ring', () => {
        const { world, phones: [owen] } = community(['Owen']);
        const made = makeNamesGenerationFor(owen.pin!, world.stateFor(owen.pk), owen.who, []);
        const saved = made.pin; // written before the request
        expect(world.post(made.generation)).toBe(201);
        owen.pin = readNamesPin(JSON.parse(JSON.stringify(saved)), owen.pk);
        expect(owen.pin!.pending?.id).toBe(made.generation.id);
        const r = owen.sync(world.stateFor(owen.pk));
        expect(owen.pin!.pending).toBeNull();
        expect(owen.pin!.ring[made.generation.id]).toBe(bytesToHex(made.key));
        expect(r.plan.kind).toBe('ready');
        // No state where the server has a statement by this phone whose key it lacks.
        for (const g of world.gens.values()) if (g.maker === owen.pk) expect(owen.pin!.ring[g.id]).toBeDefined();
    });

    it('D2 the POST never lands: kept while the parent still matches; dropped when the server moved on (the winner taken)', () => {
        const { world, phones: [owen, ada] } = community();
        const made = makeNamesGenerationFor(owen.pin!, world.stateFor(owen.pk), owen.who, []);
        owen.pin = made.pin;
        owen.sync(world.stateFor(owen.pk));
        expect(owen.pin!.pending?.id).toBe(made.generation.id);
        // Ada's key lands first.
        const theirs = makeNamesGenerationFor(ada.pin!, world.stateFor(ada.pk), ada.who, []);
        ada.pin = theirs.pin;
        world.post(theirs.generation);
        const r = owen.sync(world.stateFor(owen.pk));
        expect(owen.pin!.pending).toBeNull();
        expect(owen.head()).toBe(theirs.generation.id);
        expect(r.plan).toMatchObject({ kind: 'wait', holders: [ada.pk] });
    });

    it('D3 two makers at once: one lands, the other is refused, takes the winner\'s statement and gets its key on the winner\'s next open', () => {
        const { world, phones: [owen, bea] } = community(['Owen', 'Bea']);
        const a = makeNamesGenerationFor(owen.pin!, world.stateFor(owen.pk), owen.who, []);
        const b = makeNamesGenerationFor(bea.pin!, world.stateFor(bea.pk), bea.who, []);
        owen.pin = a.pin;
        bea.pin = b.pin;
        expect(world.post(a.generation)).toBe(201);
        expect(world.post(b.generation)).toBe(409);
        expect(bea.sync(world.stateFor(bea.pk)).plan).toMatchObject({ kind: 'wait', holders: [owen.pk] });
        owen.open(world);
        expect(bea.open(world).plan.kind).toBe('ready');
        const id = newNamesEntryId();
        const sealed = sealNamesEntry(namesRingKeys(owen.pin!)[world.current!], id, world.current!, { name: 'Zeb', note: '' });
        expect(openNamesEntry(namesRingKeys(bea.pin!)[world.current!], id, world.current!, sealed).name).toBe('Zeb');
    });

    it('D4 the only holder of the newest key is lost before sharing: Owen is offered a new key; its names stay locked; older ones open; Ada\'s new phone gets the ring without it', () => {
        const { world, phones: [owen, ada] } = community();
        const one = world.current!;
        const made = makeNamesGenerationFor(ada.pin!, world.stateFor(ada.pk), ada.who, []);
        ada.pin = made.pin;
        world.post(made.generation);
        ada.sync(world.stateFor(ada.pk)); // never shared: Owen's phone was off
        const adaNew = new Phone(admin('Ada'));
        world.admins = [owen.who, adaNew.who];
        const st = world.stateFor(owen.pk);
        const r = owen.sync(st);
        expect(r.plan).toMatchObject({ kind: 'wait', keyId: made.generation.id, n: 2, holders: [], canMakeNew: true, newKeyNeeded: true });
        const again = makeNamesGenerationFor(owen.pin!, st, owen.who, (r.plan as any).drops);
        owen.pin = again.pin;
        expect(world.post(again.generation)).toBe(201);
        expect(owen.open(world).plan.kind).toBe('ready');
        expect(owen.ringIds().sort()).toEqual([one, again.generation.id].sort());
        owen.meet(adaNew);
        owen.open(world);
        adaNew.open(world);
        expect(adaNew.ringIds().sort()).toEqual([one, again.generation.id].sort());
    });

    it('D5 the lost phone shared its last key first: Owen makes 3 dropping the old key, every entry opens, Ada\'s new phone gets every key after a scan', () => {
        const { world, phones: [owen, ada] } = community();
        const made = makeNamesGenerationFor(ada.pin!, world.stateFor(ada.pk), ada.who, []);
        ada.pin = made.pin;
        world.post(made.generation);
        ada.open(world);
        owen.open(world);
        expect(owen.ringIds()).toContain(made.generation.id);
        const adaNew = new Phone(admin('Ada'));
        world.admins = [owen.who, adaNew.who];
        owen.open(world);
        expect(curN(world)).toBe(3);
        expect(world.gens.get(world.current!)!.drops).toEqual([ada.pk]);
        owen.meet(adaNew);
        owen.open(world);
        adaNew.open(world);
        expect(adaNew.ringIds().length).toBe(3);
    });

    it('D6 the only admin loses their phone: the new phone may start again (asked), chained onto the server\'s current; a later admin it checks joins (the history a trusted admin vouches for)', () => {
        const { world, phones: [owen] } = community(['Owen']);
        const cur = world.gens.get(world.current!)!;
        const owenNew = new Phone(admin('Owen'));
        world.admins = [owenNew.who];
        const st = world.stateFor(owenNew.pk);
        const r = owenNew.sync(st);
        expect(r.plan).toEqual({ kind: 'refused', reason: 'untrusted_maker', maker: owen.pk, n: 1, canCheck: false, canStartAgain: true });
        const made = makeNamesGenerationFor(owenNew.pin!, st, owenNew.who, [], { startAgain: true });
        expect(made.generation.n).toBe(cur.n + 1);
        expect(made.generation.parentId).toBe(cur.id);
        owenNew.pin = made.pin;
        expect(world.post(made.generation)).toBe(201);
        expect(owenNew.open(world).plan.kind).toBe('ready');
        expect(owenNew.ringIds()).toEqual([made.generation.id]);
        // A new admin: Cy meets Owen's new phone.
        const cy = new Phone(admin('Cy'));
        world.admins.push(cy.who);
        owenNew.meet(cy);
        owenNew.open(world);
        const rc = cy.open(world);
        expect(rc.plan.kind).toBe('ready');
        expect(cy.trusts(owen)).toBe(false);
        expect(cy.ringIds()).toEqual([made.generation.id]);
    });

    it("D7 a reinstall, same key: an empty pin refuses until it meets one admin; then that admin's box opens and the rest follows", () => {
        const { world, phones: [owen, ada, bea] } = community(['Owen', 'Ada', 'Bea']);
        world.admins = [owen.who, ada.who, bea.who];
        // Ada makes 2 so the history has a maker other than Owen.
        const made = makeNamesGenerationFor(ada.pin!, world.stateFor(ada.pk), ada.who, []);
        ada.pin = made.pin;
        world.post(made.generation);
        ada.open(world);
        owen.open(world);
        bea.open(world);
        owen.pin = null;
        const r = owen.sync(world.stateFor(owen.pk));
        expect(r.plan).toMatchObject({ kind: 'refused', reason: 'untrusted_maker', maker: ada.pk, n: 2, canCheck: true });
        expect(owen.ringIds()).toEqual([]);
        owen.pin = checkNamesKeyInPerson(owen.pin!, ada.pk);
        const r2 = owen.open(world);
        expect(r2.plan.kind).toBe('ready');
        expect(owen.trusts(bea)).toBe(true);
        expect(owen.ringIds().length).toBe(2);
    });

    it('D8 the refusal reasons are exactly five; no old-key state exists', () => {
        expect([...NAMES_REFUSAL_REASONS]).toEqual(['other_community', 'untrusted_maker', 'missing_record', 'different_history', 'rolled_back']);
    });

    it('a new admin joins a community whose first key\'s maker has left (the history a trusted admin vouches for): taken through the admin they checked', () => {
        const { world, phones: [ann, bob] } = community(['Ann', 'Bob']);
        world.admins = [bob.who];
        bob.open(world); // 2 drops Ann
        const cy = new Phone(admin('Cy'));
        world.admins.push(cy.who);
        bob.meet(cy);
        bob.open(world);
        const r = cy.open(world);
        expect(r.plan.kind).toBe('ready');
        expect(cy.trusts(ann)).toBe(false);
        expect(cy.pin!.dropped[ann.pk]).toBe(2);
        // A vouched history is never one off another parent: a statement Ann makes after her drop is still refused.
        world.plant(makeNamesGeneration({ communityId: CID, n: 3, parentId: world.current, drops: [] }, ann.who), true);
        expect(cy.sync(world.stateFor(cy.pk)).plan).toMatchObject({ kind: 'refused', reason: 'untrusted_maker', maker: ann.pk });
    });
});

describe('E. Rollback, forks', () => {
    it('E1 a rollback to generation 1: phones at 3 refuse; replay puts 2 and 3 back; a name written then is under 3, which Abe\'s key 1 doesn\'t open', () => {
        const { world, phones: [owen, ada, abe] } = community(['Owen', 'Ada', 'Abe']);
        const one = world.current!;
        world.admins = [owen.who, ada.who];
        owen.open(world); // 2 drops Abe
        ada.open(world);
        const m = makeNamesGenerationFor(owen.pin!, world.stateFor(owen.pk), owen.who, []);
        owen.pin = m.pin;
        world.post(m.generation);
        owen.open(world);
        ada.open(world);
        const three = world.current!;
        const kept = new Map(world.gens);
        world.gens = new Map([[one, kept.get(one)!]]);
        world.current = one;
        const r = ada.sync(world.stateFor(ada.pk));
        expect(r.plan).toEqual({ kind: 'refused', reason: 'rolled_back', offered: { id: one, n: 1 }, newest: { id: three, n: 3 } });
        const replay = namesReplay(ada.pin!, world.stateFor(ada.pk));
        expect(replay.map((l) => l.n)).toEqual([2, 3]);
        for (const l of replay) expect(world.post(readNamesGeneration(l, CID)!)).toBe(201);
        expect(ada.open(world).plan.kind).toBe('ready');
        const id = newNamesEntryId();
        const sealed = sealNamesEntry(namesRingKeys(ada.pin!)[three], id, three, { name: 'Zeb', note: '' });
        expect(() => openNamesEntry(namesRingKeys(abe.pin!)[one], id, three, sealed)).toThrow();
        expect(() => openNamesEntry(namesRingKeys(abe.pin!)[one], id, one, sealed)).toThrow();
    });

    it("E3 a fork, two statements numbered 2: Bea refuses; after meeting Owen and taking his history she is on root→a→3, b kept as an abandoned key", () => {
        const { world, phones: [owen, ada, bea] } = community(['Owen', 'Ada', 'Bea']);
        const one = world.current!;
        // The server's story for Bea: Owen's b, numbered 2, and Owen's share of its key to her.
        const shown = new World();
        shown.admins = world.admins;
        shown.gens = new Map(world.gens);
        shown.current = one;
        shown.shares = new Map(world.shares);
        const owenThere = new Phone(owen.who);
        owenThere.pin = JSON.parse(JSON.stringify(owen.pin));
        const mb = makeNamesGenerationFor(owenThere.pin!, shown.stateFor(owen.pk), owen.who, []);
        owenThere.pin = mb.pin;
        shown.post(mb.generation);
        owenThere.open(shown);
        const b = mb.generation;
        expect(bea.open(shown).plan.kind).toBe('ready');
        expect(bea.head()).toBe(b.id);
        // Everyone else's: Ada's a, numbered 2, then her 3; Owen's phone takes both and their keys.
        for (const n of [2, 3]) {
            const m = makeNamesGenerationFor(ada.pin!, world.stateFor(ada.pk), ada.who, []);
            ada.pin = m.pin;
            expect(world.post(m.generation)).toBe(201);
            expect(m.generation.n).toBe(n);
            ada.open(world);
        }
        const three = world.current!;
        const a = world.gens.get(three)!.parentId!;
        owen.open(world);
        world.plant(b);
        const r = bea.sync(world.stateFor(bea.pk));
        expect(r.plan).toEqual({ kind: 'refused', reason: 'different_history' });
        bea.meet(owen);
        bea.pin = takeNamesHistory(bea.pin!, world.stateFor(bea.pk));
        expect(bea.pin.abandoned).toEqual([b.id]);
        owen.open(world);
        const r2 = bea.open(world);
        expect(r2.plan.kind).toBe('ready');
        expect(bea.pin!.chain.map((l) => l.id)).toEqual([one, a, three]);
        expect(bea.pin!.ring[b.id]).toBe(bytesToHex(mb.key));
        expect(bea.pin!.ring[three]).toBe(owen.pin!.ring[three]);
        // Rule 3: a key is taken only for a statement accepted here. Owen never accepted b.
        expect(owen.pin!.ring[b.id]).toBeUndefined();
    });

    it('E4 the server hides a statement in the middle: a missing record; nothing taken past it', () => {
        const { world, phones: [owen, ada] } = community();
        const two = makeNamesGeneration({ communityId: CID, n: 2, parentId: world.current, drops: [] }, owen.who);
        world.post(two);
        const three = makeNamesGeneration({ communityId: CID, n: 3, parentId: two.id, drops: [] }, owen.who);
        world.post(three);
        const r = ada.sync(world.stateFor(ada.pk, { hide: [two.id] }));
        expect(r.plan).toEqual({ kind: 'refused', reason: 'missing_record' });
        expect(ada.pin!.chain.length).toBe(1);
    });
});

describe('F. Writes', () => {
    it("F1 seal only under head == current: the server's current not this phone's head is never ready", () => {
        const { world, phones: [owen, ada] } = community();
        const two = makeNamesGeneration({ communityId: CID, n: 2, parentId: world.current, drops: [] }, admin('X'));
        world.plant(two, true);
        for (const p of [owen, ada]) expect(p.sync(world.stateFor(p.pk)).plan.kind).not.toBe('ready');
    });

    it('the pin round-trips, and a damaged or foreign one reads as none', () => {
        const { phones: [owen, ada] } = community();
        expect(readNamesPin(JSON.parse(JSON.stringify(owen.pin)), owen.pk)).toEqual(owen.pin);
        expect(readNamesPin(JSON.parse(JSON.stringify(owen.pin)), ada.pk)).toBeNull();
        const broken = JSON.parse(JSON.stringify(owen.pin));
        broken.chain[0].statement += 'x';
        expect(readNamesPin(broken, owen.pk)).toBeNull();
        expect(readNamesPin({ ...JSON.parse(JSON.stringify(owen.pin)), v: 2 }, owen.pk)).toBeNull();
    });
});

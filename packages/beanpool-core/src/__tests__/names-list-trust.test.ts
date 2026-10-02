/**
 * The names list's trust model, as pure functions over fixtures (scratch/global-node/DESIGN-names-list-trust-fable.md
 * §3, §4, §10). A small in-memory server (`World`) keeps statements and shares the way apps/server engine/names-list.ts
 * does (a statement lands only off the current one, the newest share per pair), and can show each phone something
 * different, as a hostile server would. Each phone runs syncNames, makes what its plan says, and auto-shares: the same
 * steps the app runs (apps/native utils/names-list.ts openNamesList), without the network.
 *
 * Every case is named by its id in §10's matrix.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
    NAMES_REFUSAL_REASONS, checkNamesKeyInPerson, emptyNamesPin, makeNamesGeneration, makeNamesGenerationFor, makeNamesShare,
    namesKeyCheckMatches, namesKeyCode, namesKeyQr, namesReplay, namesSharesToSend, readNamesGeneration, readNamesPin, readNamesShare,
    removeNamesKey, followNamesServer, namesSeenAfterRead, syncNames, namesRingKeys, namesShareHeader, namesStatementId, readNamesKeyCheck,
    type NamesGeneration, type NamesPin, type NamesServerState, type NamesShare, type NamesSyncResult, type NamesSigner,
} from '../names-list-trust.js';
import { namesBoxDigest, newNamesListKey, sealNamesRing, openNamesEntry, sealNamesEntry, newNamesEntryId } from '../names-list-crypto.js';

const CID = 'a1b2c3d4e5f60718';

// Vitest doesn't yield between synchronous tests: on a slow CI runner this file's run holds the worker long enough to miss
// its own RPC deadline ("Timeout calling onTaskUpdate"). A macrotask between tests lets it report (round 9).
afterEach(() => new Promise<void>((r) => setTimeout(r, 0)));

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
    /** Entry ids an admin deleted (the log's `delete` lines). */
    deleted: string[] = [];
    /** When set, the route's `ask_for_share` too: while an admin holds the current key on its own word, only such a holder makes the next. */
    strictAsk = false;
    lastRefusal: string | null = null;
    /** When set, the next retry after a claim is lost (a dropped connection). */
    loseNextRetry = false;
    /** What the route does: the parent is the current one, the number the next. */
    post(g: NamesGeneration): 201 | 200 | 409 {
        this.lastRefusal = null;
        if (this.gens.has(g.id)) return 200;
        const cur = this.current ? this.gens.get(this.current)! : null;
        if ((g.parentId ?? null) !== (cur?.id ?? null) || g.n !== (cur ? cur.n + 1 : 1)) return 409;
        if (this.strictAsk && cur) {
            const holders = this.admins.map((a) => a.publicKey).filter((k) => this.keyIdsOf(k).includes(cur.id));
            if (holders.length && !holders.includes(g.maker)) { this.lastRefusal = 'ask_for_share'; return 409; }
        }
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
        // On their own word (design Addendum 4): made, or listed in their own share header; a box addressed to them isn't.
        for (const s of this.shares.values()) if (s.from === pubkey) for (const id of s.keyIds) ids.add(id);
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
            const drops = r.plan.kind === 'make_new' ? r.plan.drops : [];
            const made = makeNamesGenerationFor(this.pin!, this.who, drops);
            this.pin = made.pin;
            if (world.post(made.generation) === 409 && world.lastRefusal === 'ask_for_share') {
                claimsMade++;
                if (this.pin!.manualDrops.length) claimsWithRemoval++;
                // As the app does: say in a signed header that this phone holds the key (never vouching or sending to a key
                // its statement drops), then send the statement once more (unless that is lost).
                const st = world.stateFor(this.pk, view);
                for (const a of st.admins) for (const sh of namesSharesToSend(this.pin!, st, this.who, a.pubkey, drops)) world.putShare(sh);
                if (world.loseNextRetry) world.loseNextRetry = false;
                else world.post(made.generation);
            }
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

// ── A signature only ZIP-215 takes (as test-storm-smalls makes it, #1457): strict Ed25519 must refuse it ─────────────────
// R is the identity point encoded with y = p + 1 (non-canonical); with R = O, [8][S]B = [8]R + [8][k]A holds for S = k·a.
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


/**
 * "Start again" as the app runs it (design addendum (c)): offered on an empty chain when nobody holds the current key;
 * the server's whole path goes onto the chain for its drops and place, then the ordinary new key off it, written ahead.
 */
function startAgain(phone: Phone, world: World): ReturnType<typeof makeNamesGenerationFor> {
    const st = world.stateFor(phone.pk);
    expect(phone.sync(st).plan).toMatchObject({ kind: 'refused', reason: 'untrusted_maker', canStartAgain: true });
    phone.pin = followNamesServer(phone.pin!, st).pin;
    const r = phone.sync(st);
    expect(r.plan).toMatchObject({ kind: 'wait', canMakeNew: true });
    const made = makeNamesGenerationFor(phone.pin!, phone.who, (r.plan as { drops: string[] }).drops);
    phone.pin = made.pin;
    expect(world.post(made.generation)).toBe(201);
    return made;
}

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

describe('strict Ed25519 (#1457): a signature only ZIP-215 takes is refused', () => {
    it('on a statement and on a share header, read alone and in the walk', () => {
        const { world, phones: [owen, ada] } = community();
        const seed = hexToBytes(owen.who.privateKey);
        const g = makeNamesGeneration({ communityId: CID, n: 2, parentId: world.current, drops: [] }, owen.who);
        const lax = bytesToHex(zip215OnlySignature(utf8ToBytes(g.statement), seed));
        // The control: noble's default (ZIP-215) check takes it, the strict one doesn't.
        expect(ed25519.verify(hexToBytes(lax), utf8ToBytes(g.statement), hexToBytes(owen.pk))).toBe(true);
        expect(ed25519.verify(hexToBytes(lax), utf8ToBytes(g.statement), hexToBytes(owen.pk), { zip215: false })).toBe(false);
        expect(readNamesGeneration({ statement: g.statement, signature: lax }, CID)).toBeNull();
        const share = makeNamesShare({ communityId: CID, from: owen.who, to: ada.pk, headId: world.current!, ring: namesRingKeys(owen.pin!), trusts: owen.pin!.trusted });
        const laxShare = bytesToHex(zip215OnlySignature(utf8ToBytes(share.header), seed));
        expect(readNamesShare({ header: share.header, signature: laxShare, box: share.box }, CID)).toBeNull();
        // In the walk: the statement planted as current with that signature is never taken, though Owen is trusted.
        world.plant({ ...g, signature: lax }, true);
        expect(ada.sync(world.stateFor(ada.pk)).plan).toEqual({ kind: 'refused', reason: 'missing_record' });
        expect(ada.pin!.chain.map((l) => l.id)).not.toContain(g.id);
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
        expect(owen.pin!.dropped[abe.pk]).toBe(owen.pin!.chain[1].id); // the statement that dropped it, by id (Addendum 2)
        world.putShare(makeNamesShare({ communityId: CID, from: bea.who, to: owen.pk, headId: one, ring: namesRingKeys(bea.pin!), trusts: [bea.pk, owen.pk, abe.pk, dee.publicKey] }));
        owen.sync(world.stateFor(owen.pk));
        expect(owen.trusts(abe)).toBe(false);
        expect(owen.pin!.dropped[abe.pk]).toBe(owen.pin!.chain[1].id); // the statement that dropped it, by id (Addendum 2)
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
        expect(owen.pin!.dropped[gone.pk]).toBe(owen.pin!.chain[1].id); // the statement that dropped it, by id (Addendum 2)
        // The server's other story, for Bea: generation 1 current, `gone` still an admin, and `gone`'s own 2′ off 1.
        const dark = new World();
        dark.admins = [owen.who, gone.who, bea.who];
        dark.gens.set(one, world.gens.get(one)!);
        dark.current = one;
        for (const s of world.shares.values()) if (s.headId === one) dark.putShare(s);
        gone.sync(dark.stateFor(gone.pk));
        const made = makeNamesGenerationFor(gone.pin!, gone.who, []);
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
            expect(owen.pin!.dropped[gone.pk]).toBe(owen.pin!.chain[1].id); // the statement that dropped it, by id (Addendum 2)
            expect(r.notices).toContainEqual({ kind: 'other_history', who: bea.pk });
            // Owen's own share to Bea carries key 2, but Bea, on 2′, doesn't take it: she never holds K2 there.
            owen.open(world);
            const b1 = bea.sync(world.stateFor(bea.pk));
            expect(b1.plan).toEqual({ kind: 'refused', reason: 'different_history', canFollow: true });
            expect(bea.ringIds()).not.toContain(two);
            // They meet; Bea takes Owen's history: 2 accepted, `gone` dropped, K2 arrives; 2′ stays as an abandoned key.
            bea.pin = followNamesServer(bea.pin!, world.stateFor(bea.pk)).pin;
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
        expect(owen.pin!.dropped[abe.pk]).toBe(owen.pin!.chain[1].id); // the statement that dropped it, by id (Addendum 2)
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
        const made = makeNamesGenerationFor(owen.pin!, owen.who, []);
        expect(made.generation.drops).toEqual([]);
        expect(made.generation.n).toBe(2);
    });

    it('C7 a trusted admin drops everyone else: taken (governance, not crypto), the self-drop ignored, Bea dropped; Owen waits on Ada and is told', () => {
        const { world, phones: [owen, ada, bea] } = community(['Owen', 'Ada', 'Bea']);
        const made = makeNamesGenerationFor(ada.pin!, ada.who, [owen.pk, bea.pk]);
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
        const made = makeNamesGenerationFor(ada.pin!, ada.who, []);
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
        const made = makeNamesGenerationFor(owen.pin!, owen.who, []);
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
        const made = makeNamesGenerationFor(owen.pin!, owen.who, []);
        owen.pin = made.pin;
        owen.sync(world.stateFor(owen.pk));
        expect(owen.pin!.pending?.id).toBe(made.generation.id);
        // Ada's key lands first.
        const theirs = makeNamesGenerationFor(ada.pin!, ada.who, []);
        ada.pin = theirs.pin;
        world.post(theirs.generation);
        const r = owen.sync(world.stateFor(owen.pk));
        expect(owen.pin!.pending).toBeNull();
        expect(owen.head()).toBe(theirs.generation.id);
        expect(r.plan).toMatchObject({ kind: 'wait', holders: [ada.pk] });
    });

    it('D3 two makers at once: one lands, the other is refused, takes the winner\'s statement and gets its key on the winner\'s next open', () => {
        const { world, phones: [owen, bea] } = community(['Owen', 'Bea']);
        const a = makeNamesGenerationFor(owen.pin!, owen.who, []);
        const b = makeNamesGenerationFor(bea.pin!, bea.who, []);
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
        const made = makeNamesGenerationFor(ada.pin!, ada.who, []);
        ada.pin = made.pin;
        world.post(made.generation);
        ada.sync(world.stateFor(ada.pk)); // never shared: Owen's phone was off
        const adaNew = new Phone(admin('Ada'));
        world.admins = [owen.who, adaNew.who];
        const st = world.stateFor(owen.pk);
        const r = owen.sync(st);
        expect(r.plan).toMatchObject({ kind: 'wait', keyId: made.generation.id, n: 2, holders: [], canMakeNew: true, newKeyNeeded: true });
        const again = makeNamesGenerationFor(owen.pin!, owen.who, (r.plan as any).drops);
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
        const made = makeNamesGenerationFor(ada.pin!, ada.who, []);
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

    it('D6 the only admin loses their phone: the new phone may start again (asked): it takes the server\'s path for its drops and place, then a new key off the current one; a later admin it checks joins (the history a trusted admin vouches for)', () => {
        const { world, phones: [owen] } = community(['Owen']);
        const cur = world.gens.get(world.current!)!;
        const owenNew = new Phone(admin('Owen'));
        world.admins = [owenNew.who];
        const st = world.stateFor(owenNew.pk);
        expect(owenNew.sync(st).plan).toEqual({ kind: 'refused', reason: 'untrusted_maker', maker: owen.pk, n: 1, canCheck: false, canStartAgain: true });
        const made = startAgain(owenNew, world);
        expect(made.generation.n).toBe(cur.n + 1);
        expect(made.generation.parentId).toBe(cur.id);
        expect(owenNew.open(world).plan.kind).toBe('ready');
        expect(owenNew.ringIds()).toEqual([made.generation.id]);
        expect(owenNew.pin!.chain.map((l) => l.id)).toEqual([cur.id, made.generation.id]);
        expect(owenNew.trusts(owen)).toBe(false);
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
        const made = makeNamesGenerationFor(ada.pin!, ada.who, []);
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

    it('G1 a new admin joins a community whose first key\'s maker has left (the history a trusted admin vouches for): taken through the admin they checked', () => {
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
        expect(cy.pin!.dropped[ann.pk]).toBe(cy.pin!.chain[1].id); // the statement that dropped it, by id (Addendum 2)
        // A vouched history is never one off another parent: a statement Ann makes after her drop is still refused.
        world.plant(makeNamesGeneration({ communityId: CID, n: 3, parentId: world.current, drops: [] }, ann.who), true);
        expect(cy.sync(world.stateFor(cy.pk)).plan).toMatchObject({ kind: 'refused', reason: 'untrusted_maker', maker: ann.pk });
    });
});

describe('G. The vouched history and starting again (design addendum, 2026-10-02)', () => {
    it("G2 after a start again, an admin who still holds key 1 meets the new phone: its share opens the old entries (§4.3.1's promise); no prefix key comes from a box an untrusted key signed", () => {
        const { world, phones: [owen] } = community(['Owen']);
        const one = world.current!;
        const id = newNamesEntryId();
        const sealed = sealNamesEntry(namesRingKeys(owen.pin!)[one], id, one, { name: 'Zeb', note: '' });
        const owenNew = new Phone(admin('Owen'));
        world.admins = [owenNew.who];
        const made = startAgain(owenNew, world);
        expect(owenNew.open(world).plan.kind).toBe('ready');
        expect(owenNew.pin!.chain.map((l) => l.id)).toEqual([one, made.generation.id]);
        // An operator's key sends the new phone a box with a key for the old statement: not from a trusted key, so not taken.
        const z = admin('Zed');
        world.putShare(makeNamesShare({ communityId: CID, from: z, to: owenNew.pk, headId: made.generation.id, ring: { [one]: newNamesListKey() }, trusts: [z.publicKey] }));
        owenNew.open(world);
        expect(owenNew.pin!.ring[one]).toBeUndefined();
        // The old phone is found: the owner makes its key an admin again, and the two phones check each other.
        world.admins.push(owen.who);
        owenNew.meet(owen);
        owenNew.open(world);
        owen.open(world);
        owen.open(world);
        owenNew.open(world);
        expect([...owenNew.pin!.trusted].sort()).toEqual([owenNew.pk, owen.pk].sort());
        expect(owenNew.pin!.ring[one]).toBe(owen.pin!.ring[one]);
        expect(openNamesEntry(namesRingKeys(owenNew.pin!)[one], id, one, sealed).name).toBe('Zeb');
    });

    it('G3 a planted prefix (the operator\'s root and a 2 that drops V): V starts again on top; P meets V and takes the prefix for its drops, stalls at V\'s key with V dropped, never holds a prefix key and is never ready under 2; a rescan of V reaches V\'s key and only it', () => {
        const world = new World();
        const o = admin('Op');
        const [v, p] = [new Phone(admin('Vi')), new Phone(admin('Pat'))];
        const root = makeNamesGeneration({ communityId: CID, n: 1, parentId: null, drops: [] }, o);
        world.plant(root);
        const two = makeNamesGeneration({ communityId: CID, n: 2, parentId: root.id, drops: [v.pk] }, o);
        world.plant(two, true);
        world.admins = [v.who, p.who];
        expect(world.stateFor(v.pk).nobodyHoldsKey).toBe(true);
        const made = startAgain(v, world);
        expect(made.generation.n).toBe(3);
        expect(v.open(world).plan.kind).toBe('ready');
        v.meet(p);
        v.open(world);
        const r = p.open(world);
        expect(p.pin!.chain.map((l) => l.id)).toEqual([root.id, two.id]);
        expect(p.trusts(v)).toBe(false);
        expect(p.pin!.dropped[v.pk]).toBe(p.pin!.chain[1].id); // the statement that dropped it, by id (Addendum 2)
        expect(r.plan).toMatchObject({ kind: 'refused', reason: 'untrusted_maker', maker: v.pk, canCheck: true });
        expect(p.ringIds()).toEqual([]);
        // A rescan of V: the next open takes V's key, and only it.
        p.pin = checkNamesKeyInPerson(p.pin!, v.pk);
        v.open(world);
        expect(p.open(world).plan.kind).toBe('ready');
        expect(p.ringIds()).toEqual([made.generation.id]);
    });

    it('G4 the whole path is needed: the server hides a statement between V\'s start again and V\'s head; nothing under it is vouched, and P reads nothing', () => {
        const world = new World();
        const o = admin('Op');
        const [v, p] = [new Phone(admin('Vi')), new Phone(admin('Pat'))];
        world.plant(makeNamesGeneration({ communityId: CID, n: 1, parentId: null, drops: [] }, o), true);
        world.admins = [v.who, p.who];
        const s1 = startAgain(v, world);
        v.open(world);
        for (let i = 0; i < 2; i++) {
            const m = makeNamesGenerationFor(v.pin!, v.who, []);
            v.pin = m.pin;
            expect(world.post(m.generation)).toBe(201);
            v.open(world);
        }
        const gap = world.gens.get(world.gens.get(world.current!)!.parentId!)!;
        expect(gap.parentId).toBe(s1.generation.id);
        v.meet(p);
        v.open(world);
        const r = p.open(world, { hide: [gap.id] });
        expect(r.plan.kind).toBe('refused');
        expect(p.pin!.chain).toEqual([]);
        expect(p.ringIds()).toEqual([]);
    });

    for (const copy of ['the old history without the start again', 'only the first statement', 'no key history at all'] as const) {
        it(`G5 (the review's :702) a start again, then a take-over from a copy with ${copy}: rolled back, and the replay puts the whole history back in order, then this phone's key; ready (one admin)`, () => {
            const { world, phones: [owen] } = community(['Owen']);
            const root = world.current!;
            const second = makeNamesGenerationFor(owen.pin!, owen.who, []);
            owen.pin = second.pin;
            expect(world.post(second.generation)).toBe(201);
            owen.open(world);
            const old = new Map(world.gens);
            const owenNew = new Phone(admin('Owen'));
            world.admins = [owenNew.who];
            const made = startAgain(owenNew, world);
            expect(owenNew.open(world).plan.kind).toBe('ready');
            expect(readNamesPin(JSON.parse(JSON.stringify(owenNew.pin)), owenNew.pk)).toEqual(owenNew.pin);
            // The standby's copy.
            if (copy === 'the old history without the start again') {
                world.gens = new Map(old);
                world.current = second.generation.id;
            } else if (copy === 'only the first statement') {
                world.gens = new Map([[root, old.get(root)!]]);
                world.current = root;
            } else {
                world.gens = new Map();
                world.current = null;
            }
            world.shares.clear();
            const r = owenNew.sync(world.stateFor(owenNew.pk));
            expect(r.plan).toMatchObject({ kind: 'refused', reason: 'rolled_back', newest: { id: made.generation.id, n: 3 } });
            const replay = namesReplay(owenNew.pin!, world.stateFor(owenNew.pk));
            expect(replay.map((l) => l.n)).toEqual(copy === 'no key history at all' ? [1, 2, 3] : copy === 'only the first statement' ? [2, 3] : [3]);
            for (const l of replay) expect(world.post(readNamesGeneration(l, CID)!)).toBe(201);
            expect(world.current).toBe(made.generation.id);
            expect(owenNew.open(world).plan.kind).toBe('ready');
            expect(owenNew.ringIds()).toEqual([made.generation.id]);
            // Nothing from the history it took is trusted: the old key's maker stays untrusted, its keys untaken.
            expect(owenNew.trusts(owen)).toBe(false);
        });
    }

    it("G6 a stale header to a phone that started again: Abe dropped at 2 on the old history; the server replays W's header from before the drop, vouching Abe; Abe stays dropped, and gets nothing though the server lists him", () => {
        const { world, phones: [owen, abe, w] } = community(['Owen', 'Abe', 'W']);
        const one = world.current!;
        const stale = [...world.shares.values()].find((x) => x.from === w.pk && x.trusts.includes(abe.pk) && x.headId === one)!;
        expect(stale).toBeDefined();
        world.admins = [owen.who, w.who];
        owen.open(world); // 2 drops Abe
        expect(world.gens.get(world.current!)!.drops).toEqual([abe.pk]);
        // Every phone lost; the operator lists Abe again; Q, the new admin, starts again.
        const q = new Phone(admin('Quin'));
        world.admins = [q.who, abe.who];
        world.shares.clear();
        startAgain(q, world);
        expect(q.pin!.dropped[abe.pk]).toBe(q.pin!.chain[1].id); // the statement that dropped it, by id (Addendum 2)
        q.open(world);
        // Q checks W (same key, a person Q trusts); the server replays W's header from before the drop.
        q.pin = checkNamesKeyInPerson(q.pin!, w.pk);
        world.putShare(stale);
        const r = q.open(world);
        expect(r.plan.kind).toBe('ready');
        expect(q.trusts(abe)).toBe(false);
        expect(q.pin!.dropped[abe.pk]).toBe(q.pin!.chain[1].id); // the statement that dropped it, by id (Addendum 2)
        expect(namesSharesToSend(q.pin!, world.stateFor(q.pk), q.who).map((x) => x.to)).not.toContain(abe.pk);
    });

    it("G7 A2 stands: Z's planted statement, with Z's own header naming it, is refused on every phone (no trusted admin's head descends from it)", () => {
        const { world, phones } = community(['Owen', 'Ada']);
        const z = admin('Zed');
        world.admins.push(z);
        const zs = makeNamesGeneration({ communityId: CID, n: 2, parentId: world.current, drops: [] }, z);
        world.plant(zs, true);
        for (const p of phones) world.putShare(makeNamesShare({ communityId: CID, from: z, to: p.pk, headId: zs.id, ring: { [zs.id]: newNamesListKey() }, trusts: [z.publicKey, ...phones.map((x) => x.pk)] }));
        for (const p of phones) {
            const r = p.sync(world.stateFor(p.pk));
            expect(r.plan).toMatchObject({ kind: 'refused', reason: 'untrusted_maker', maker: z.publicKey });
            expect(p.ringIds()).not.toContain(zs.id);
            expect(p.trusts(z.publicKey)).toBe(false);
        }
    });

    it('a pin whose chain does not start at a first statement reads as none (every chain is a path from the root)', () => {
        const { world, phones: [owen] } = community(['Owen']);
        const m = makeNamesGenerationFor(owen.pin!, owen.who, []);
        owen.pin = m.pin;
        world.post(m.generation);
        owen.open(world);
        const cut = JSON.parse(JSON.stringify(owen.pin));
        cut.chain = cut.chain.slice(1);
        expect(readNamesPin(cut, owen.pk)).toBeNull();
    });
});

/**
 * The re-review's `:628` sequence (design Addendum 2, H1): a fork the node makes through an honest admin it keeps in the
 * dark. Abe is removed and Owen's phone makes 2 without him (Bea and Zed take 2; Zed never gets its key). The node keeps
 * Cy's phone at 1 with Abe listed and Owen left off: Cy's phone makes 2″ off 1 by itself, and the node makes it current.
 */
function forkWorld() {
    const { world, phones: [owen, bea, cy, abe, zed] } = community(['Owen', 'Bea', 'Cy', 'Abe', 'Zed']);
    const one = world.current!;
    world.admins = [owen.who, bea.who, cy.who, zed.who];
    owen.open(world); // 2 drops Abe
    const two = world.current!;
    expect(world.gens.get(two)!.drops).toEqual([abe.pk]);
    bea.open(world);
    expect(bea.ringIds()).toContain(two);
    // Zed never gets key 2: no box to it carries 2 (a box addressed isn't a key held, so Bea's phone sends one too).
    for (const k of [...world.shares.keys()]) if (k.endsWith(`|${zed.pk}`) && world.shares.get(k)!.keyIds.includes(two)) world.shares.delete(k);
    expect(zed.open(world).plan.kind).toBe('wait'); // took 2, never its key
    const entryId = newNamesEntryId();
    const sealed = sealNamesEntry(namesRingKeys(owen.pin!)[two], entryId, two, { name: 'Written after Abe was removed', note: '' });
    const view = { admins: [bea.who, cy.who, abe.who, zed.who] };
    const r = cy.sync(world.stateFor(cy.pk, { ...view, current: one, hide: [two] }));
    expect(r.plan).toEqual({ kind: 'make_new', drops: [owen.pk] });
    const m = makeNamesGenerationFor(cy.pin!, cy.who, [owen.pk]);
    cy.pin = m.pin;
    world.plant(m.generation, true); // stored beside 2; the node's current is Cy's from now on
    const twoPP = m.generation.id;
    expect(cy.open(world, view).plan.kind).toBe('ready');
    const cyOldHeader = world.shares.get(`${cy.pk}|${bea.pk}`)!;
    expect(cyOldHeader.trusts).toContain(abe.pk);
    return { world, owen, bea, cy, abe, zed, one, two, twoPP, view, entryId, sealed, cyOldHeader };
}

/** Every share the node holds to `to`, by `from` (any when omitted). */
const sharesTo = (world: World, to: string, from?: string) => [...world.shares.values()].filter((x) => x.to === to && (!from || x.from === from));

describe('H. Re-admission by id, abandoned keys, the removal check (design Addendum 2, 2026-10-02)', () => {
    it("H1 (the re-review's :628) Follow the server's history onto Cy's branch: Cy's header re-admits nobody; the phone makes a key without Abe before it writes; nothing ever goes to Abe from it; Cy takes that key and sends Abe nothing more", () => {
        const { world, bea, cy, abe, one, two, twoPP, view } = forkWorld();
        expect(bea.sync(world.stateFor(bea.pk, view)).plan).toEqual({ kind: 'refused', reason: 'different_history', canFollow: true });
        // Bea's last box to Abe is from before the removal (key 1 only): it must stay the last.
        const beaToAbe = world.shares.get(`${bea.pk}|${abe.pk}`)!;
        expect(beaToAbe.keyIds).toEqual([one]);
        bea.pin = followNamesServer(bea.pin!, world.stateFor(bea.pk, view)).pin;
        expect(bea.pin.abandoned).toEqual([two]);
        const r = bea.sync(world.stateFor(bea.pk, view));
        expect(bea.trusts(abe)).toBe(false);
        expect(bea.pin!.dropped[abe.pk]).toBe(two);
        expect(r.toDrop).toEqual([abe.pk]);
        expect(r.plan).toEqual({ kind: 'make_new', drops: [abe.pk] });
        bea.open(world, view);
        const threePP = world.current!;
        expect(world.gens.get(threePP)).toMatchObject({ maker: bea.pk, parentId: twoPP, drops: [abe.pk] });
        expect(bea.pin!.chain.map((l) => l.id)).toEqual([one, twoPP, threePP]);
        expect(bea.pin!.dropped[abe.pk]).toBe(threePP);
        expect(bea.ringIds().sort()).toEqual([one, two, twoPP, threePP].sort());
        expect(sharesTo(world, abe.pk, bea.pk)).toEqual([beaToAbe]);
        expect(namesSharesToSend(bea.pin!, world.stateFor(bea.pk, view), bea.who, abe.pk)).toEqual([]);
        // Cy's phone takes Bea's key (she is trusted there), drops Abe, and sends him nothing more.
        const cyToAbe = world.shares.get(`${cy.pk}|${abe.pk}`);
        expect(cy.open(world, view).plan.kind).toBe('ready');
        expect(cy.trusts(abe)).toBe(false);
        cy.open(world, view);
        expect(world.shares.get(`${cy.pk}|${abe.pk}`)).toBe(cyToAbe);
        // Owen's name under key 2 reaches Abe only through keys he already had: no box to him ever carried 2 or 3″.
        for (const x of sharesTo(world, abe.pk)) expect(x.keyIds.filter((id) => id === two || id === threePP)).toEqual([]);
    });

    it('H2 re-admission needs the dropping statement on this chain, by id: a header on the dark branch lifts nothing; after a scan, Bea sends Abe every key, and Cy (Abe dropped at 3″) re-admits him from her header', () => {
        const { world, bea, cy, abe, two, twoPP, view, cyOldHeader } = forkWorld();
        bea.pin = followNamesServer(bea.pin!, world.stateFor(bea.pk, view)).pin;
        // A phone whose only drop of Abe is abandoned: no header lifts it (Cy's header names 2″, on the chain).
        const snapshot = new Phone(bea.who);
        snapshot.pin = JSON.parse(JSON.stringify(bea.pin));
        snapshot.sync(world.stateFor(bea.pk, { ...view, extraShares: [cyOldHeader] }));
        expect(snapshot.trusts(abe)).toBe(false);
        bea.open(world, view);
        const threePP = world.current!;
        cy.open(world, view);
        expect(cy.pin!.dropped[abe.pk]).toBe(threePP);
        // The owner makes Abe an admin again; Bea checks him in person.
        bea.pin = checkNamesKeyInPerson(bea.pin!, abe.pk);
        bea.open(world, view);
        const toAbe = world.shares.get(`${bea.pk}|${abe.pk}`)!;
        expect(toAbe.keyIds.sort()).toEqual([world.gens.get(twoPP)!.parentId!, two, twoPP, threePP].sort());
        // Cy re-admits Abe from Bea's header: its head (3″) is at the statement that dropped him on Cy's chain.
        cy.open(world, view);
        expect(cy.trusts(abe)).toBe(true);
        expect(cy.pin!.dropped[abe.pk]).toBeUndefined();
        expect(namesSharesToSend(cy.pin!, world.stateFor(cy.pk, view), cy.who, abe.pk).map((x) => [x.to, x.headId])).toEqual([[abe.pk, threePP]]);
    });

    it("H3 abandoned keys travel only to phones that accepted their statements: Bea's box to Cy carries 2, Cy never takes or passes it; Zed (who took 2 without its key) crosses and gets it from Bea, and its entry opens", () => {
        const { world, bea, cy, zed, two, view, entryId, sealed } = forkWorld();
        bea.pin = followNamesServer(bea.pin!, world.stateFor(bea.pk, view)).pin;
        bea.open(world, view);
        expect(world.shares.get(`${bea.pk}|${cy.pk}`)!.keyIds).toContain(two);
        cy.open(world, view);
        cy.open(world, view);
        expect(cy.ringIds()).not.toContain(two);
        for (const x of [...world.shares.values()].filter((y) => y.from === cy.pk)) expect(x.keyIds).not.toContain(two);
        // Zed crosses the same way.
        expect(zed.sync(world.stateFor(zed.pk, view)).plan).toEqual({ kind: 'refused', reason: 'different_history', canFollow: true });
        zed.pin = followNamesServer(zed.pin!, world.stateFor(zed.pk, view)).pin;
        expect(zed.pin.abandoned).toEqual([two]);
        zed.open(world, view);
        bea.open(world, view);
        expect(zed.open(world, view).plan.kind).toBe('ready');
        expect(zed.ringIds()).toContain(two);
        expect(openNamesEntry(namesRingKeys(zed.pin!)[two], entryId, two, sealed).name).toBe('Written after Abe was removed');
    });

    it('H5 Remove by hand for a key this phone never trusted: the next key leaves it out; until then nothing is written; after, the removal is done and recorded by id', () => {
        const { world, phones: [owen, bea] } = community(['Owen', 'Bea']);
        const abe = admin('Abe');
        world.admins.push(abe);
        expect(bea.trusts(abe.publicKey)).toBe(false);
        bea.pin = removeNamesKey(bea.pin!, abe.publicKey);
        expect(bea.pin.manualDrops).toEqual([abe.publicKey]);
        const r = bea.sync(world.stateFor(bea.pk));
        expect(r.plan).toEqual({ kind: 'make_new', drops: [abe.publicKey] });
        bea.open(world);
        expect(world.gens.get(world.current!)).toMatchObject({ maker: bea.pk, drops: [abe.publicKey] });
        expect(bea.pin!.manualDrops).toEqual([]);
        expect(bea.pin!.dropped[abe.publicKey]).toBe(world.current);
        expect(owen.open(world).plan.kind).toBe('ready');
        expect(removeNamesKey(bea.pin!, bea.pk)).toBe(bea.pin);
    });

    /** Ann's 1; her 2 drops Owen; the owner makes Owen an admin again and Ann checks him again; Owen's phone makes 3. */
    function readmitted() {
        const { world, phones: [ann, owen] } = community(['Ann', 'Owen']);
        const one = world.current!;
        world.admins = [ann.who];
        ann.open(world);
        const two = world.current!;
        world.admins = [ann.who, owen.who];
        ann.meet(owen);
        ann.open(world);
        expect(owen.open(world).plan.kind).toBe('ready');
        const m = makeNamesGenerationFor(owen.pin!, owen.who, []);
        owen.pin = m.pin;
        expect(world.post(m.generation)).toBe(201);
        owen.open(world);
        ann.open(world);
        return { world, ann, owen, one, two, three: m.generation.id };
    }

    it("H6 (the re-review's :587) a fresh walk drops an admin this phone checked: it says so and asks for a check again; a second check gets through, and nothing goes to Owen before it", () => {
        const { world, ann, owen, two, three } = readmitted();
        const pat = new Phone(admin('Pat'));
        world.admins.push(pat.who);
        pat.meet(owen);
        owen.open(world);
        const r = pat.open(world);
        expect(pat.pin!.dropped[owen.pk]).toBe(two);
        expect(r.notices).toContainEqual({ kind: 'check_again', who: owen.pk, n: 2 });
        expect(r.plan.kind).not.toBe('ready');
        expect(sharesTo(world, owen.pk, pat.pk)).toEqual([]);
        pat.pin = checkNamesKeyInPerson(pat.pin!, owen.pk);
        const r2 = pat.open(world);
        expect(r2.plan.kind).toBe('ready');
        expect(pat.head()).toBe(three);
        expect(pat.trusts(ann)).toBe(true);
        void ann;
    });

    it("H7 (the re-review's :587, the dead end) the re-admitted admin has left: a new admin's walk and a reinstalled phone's walk take Owen's key 3 (rule 1b at an ancestor drop) and reach Ann's 4; nothing to Owen", () => {
        const { world, ann, owen, two, three } = readmitted();
        world.admins = [ann.who];
        ann.open(world); // 4 drops Owen
        // No leftover header names Owen (the review's dead end): nobody sends to a key it dropped.
        for (const k of [...world.shares.keys()]) if (k.includes(owen.pk)) world.shares.delete(k);
        const four = world.current!;
        expect(world.gens.get(four)!.drops).toEqual([owen.pk]);
        const pat = new Phone(admin('Pat'));
        world.admins.push(pat.who);
        pat.meet(ann);
        ann.open(world);
        const r = pat.open(world);
        expect(pat.pin!.chain.map((l) => l.id).slice(1)).toEqual([two, three, four]);
        expect(pat.pin!.dropped[owen.pk]).toBe(four);
        expect(r.plan.kind).toBe('ready');
        // Ann reinstalls with the same key, and checks Pat.
        ann.pin = checkNamesKeyInPerson(emptyNamesPin(CID, ann.pk), pat.pk);
        pat.open(world);
        expect(ann.open(world).plan.kind).toBe('ready');
        expect(ann.head()).toBe(four);
        expect(sharesTo(world, owen.pk, pat.pk)).toEqual([]);
    });

    it('H8 C1 and C2 stand under rule 1b: a statement off another parent, and one no trusted header vouches (Addendum 4: (c) reads as K5)', () => {
        // (a) Abe's 2′ off 1 while this phone's head is 2: refused (its parent isn't the head).
        const { world, phones: [owen, bea, abe] } = community(['Owen', 'Bea', 'Abe']);
        const one = world.current!;
        world.admins = [owen.who, bea.who];
        owen.open(world);
        bea.open(world);
        const two = world.current!;
        const twoP = makeNamesGeneration({ communityId: CID, n: 2, parentId: one, drops: [] }, abe.who);
        world.plant(twoP);
        world.putShare(makeNamesShare({ communityId: CID, from: abe.who, to: bea.pk, headId: twoP.id, ring: { [twoP.id]: newNamesListKey() }, trusts: [abe.pk, owen.pk, bea.pk] }));
        bea.sync(world.stateFor(bea.pk));
        expect(bea.pin!.chain.map((l) => l.id)).toEqual([one, two]);
        // (b) Abe, dropped at 2, signs 3 off 2 and the node stores it as current; no trusted header descends from it.
        const threeA = makeNamesGeneration({ communityId: CID, n: 3, parentId: two, drops: [] }, abe.who);
        world.plant(threeA, true);
        expect(bea.sync(world.stateFor(bea.pk)).plan).toMatchObject({ kind: 'refused', reason: 'untrusted_maker', maker: abe.pk });
    });
});

/** A copy of the server's rows, as a standby holds them (statements, current, shares). */
type Copy = { gens: Map<string, NamesGeneration>; current: string | null; shares: Map<string, NamesShare>; entries: World['entries']; deleted: string[] };
const copyOf = (w: World): Copy => ({ gens: new Map(w.gens), current: w.current, shares: new Map(w.shares), entries: [...w.entries], deleted: [...w.deleted] });
const restore = (w: World, c: Copy) => {
    w.gens = new Map(c.gens); w.current = c.current; w.shares = new Map(c.shares); w.entries = [...c.entries]; w.deleted = [...c.deleted];
};

/**
 * The re-review's :639 sequence (round 7), all honest: a standby copies key 1; Abe is removed and Owen's phone makes 2;
 * the standby takes over from its older copy and Cy's phone, still at 1, makes 2″ without Abe by itself; Owen and Bea
 * follow the server's history (Addendum 3: asked, no scan); then whoever runs the server puts the main copy back.
 */
function backAndForth() {
    const { world, phones: [owen, bea, cy, abe] } = community(['Owen', 'Bea', 'Cy', 'Abe']);
    const one = world.current!;
    const standby = copyOf(world);
    world.admins = [owen.who, bea.who, cy.who];
    owen.open(world); // 2 drops Abe
    const two = world.current!;
    bea.open(world);
    const main = copyOf(world);
    restore(world, standby); // the take-over from the older copy
    expect(cy.open(world).plan.kind).toBe('ready'); // 2″ without Abe, made by itself
    const twoPP = world.current!;
    expect(world.gens.get(twoPP)).toMatchObject({ maker: cy.pk, parentId: one, drops: [abe.pk] });
    for (const p of [owen, bea]) {
        // J7: a different history, not a rolled-back one: the phone offers to follow it.
        expect(p.sync(world.stateFor(p.pk)).plan).toEqual({ kind: 'refused', reason: 'different_history', canFollow: true });
        p.pin = followNamesServer(p.pin!, world.stateFor(p.pk)).pin;
    }
    settle(world, [owen, bea, cy]);
    restore(world, main); // the main copy is back: current 2
    return { world, owen, bea, cy, abe, one, two, twoPP };
}

/** Opens every phone until each is ready on the server's current, or a few rounds pass. */
function settle(world: World, phones: Phone[], view: Parameters<World['stateFor']>[1] = {}): void {
    for (let i = 0; i < 6; i++) {
        const plans = phones.map((p) => p.open(world, view).plan.kind);
        if (plans.every((k) => k === 'ready') && phones.every((p) => p.head() === world.current)) return;
    }
}

describe('I. Following the server back to a history this phone left (round 7, under Addendum 3\'s Follow)', () => {
    it('after a follow, the main copy comes back: each phone follows again (asked, no scan), makes its own key where it stands by a drop the path lacks, and all three end ready on one head; Abe never trusted', () => {
        const { world, owen, bea, cy, abe, one, two } = backAndForth();
        for (const p of [owen, bea, cy]) {
            expect(p.sync(world.stateFor(p.pk)).plan).toEqual({ kind: 'refused', reason: 'different_history', canFollow: true });
            p.pin = followNamesServer(p.pin!, world.stateFor(p.pk)).pin;
            expect(p.pin!.chain.map((l) => l.id).slice(0, 2)).toEqual([one, two]);
        }
        settle(world, [owen, bea, cy]);
        for (const p of [owen, bea, cy]) {
            expect(p.open(world).plan.kind).toBe('ready');
            expect(p.head()).toBe(world.current);
            expect(p.trusts(abe)).toBe(false);
            expect(p.pin!.chain.map((l) => l.id)).toContain(p.pin!.dropped[abe.pk]);
        }
        expect(sharesTo(world, abe.pk).filter((x) => x.keyIds.includes(world.current!))).toEqual([]);
    });

    it("then Cy's phone is lost and the owner moves Cy to a new key: a key without Cy's old key, and after a check every phone is ready on one head", () => {
        const { world, owen, bea, cy } = backAndForth();
        for (const p of [owen, bea, cy]) p.pin = followNamesServer(p.pin!, world.stateFor(p.pk)).pin;
        settle(world, [owen, bea, cy]);
        const cyNew = new Phone(admin('Cy'));
        world.admins = [owen.who, bea.who, cyNew.who];
        owen.open(world);
        expect(world.gens.get(world.current!)!.drops).toContain(cy.pk);
        owen.meet(cyNew);
        settle(world, [owen, bea, cyNew]);
        for (const p of [owen, bea, cyNew]) {
            expect(p.open(world).plan.kind).toBe('ready');
            expect(p.head()).toBe(world.current);
        }
    });
});

/**
 * A seeded property check of the module header's promises (round 7's, split so each `it` stays well under a minute on
 * CI, with Addendum 3's removal by hand and re-admission before a loss in the world). Abe is removed, then made an admin
 * again and checked in person by Owen; at a random step Abe's phone is lost and an honest phone taps Remove @Abe's old
 * key (later, others may too). Meanwhile the operator copies, takes over from older copies and puts them back, shows
 * some opens stale roles (Owen left off, Abe listed), and the phones follow when they're shown a different history.
 * After a phone's tap: it never sends Abe anything, and when ready it neither trusts Abe nor writes under any key Abe
 * holds or was sent. Always: every ring id is on the chain or abandoned, and a ready phone has no standing drop.
 */
let claimsSeen = 0;
let claimsMade = 0;
let claimsWithRemoval = 0;
function propertyRun(seed: number): { readies: number; follows: number; taps: number; made: number; losses: number } {
    let x = seed * 2654435761 >>> 0;
    const rnd = () => { x = (x + 0x6d2b79f5) >>> 0; let t = x; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
    const { world, phones: [owen, bea, cy, abe, mia] } = community(['Owen', 'Bea', 'Cy', 'Abe', 'Mia']);
    const honest = [owen, bea, cy];
    world.admins = [owen.who, bea.who, cy.who, mia.who];
    owen.open(world); // Abe removed
    bea.open(world);
    world.admins = [owen.who, bea.who, cy.who, mia.who, abe.who]; // made an admin again; Owen checks him in person
    owen.meet(abe);
    settle(world, honest);
    const toAbe: NamesShare[] = [];
    const allShares: NamesShare[] = [];
    const put = world.putShare.bind(world);
    world.putShare = (sh: NamesShare) => { allShares.push(sh); if (sh.to === abe.pk) toAbe.push(sh); put(sh); };
    // The node's ask_for_share, and the claim a phone then sends (round 11): a removal by hand can be in flight with it.
    world.strictAsk = true;
    const tappedAll = new Map<string, number>(); // phone → index into allShares when it tapped
    const lossAt = 3 + Math.floor(rnd() * 10);
    // Addendum 4's K1 shape: Mia makes a key whose boxes never land, then her phone is lost and her role removed. Nobody
    // trusted ever vouches her statement: the phones follow, or make a new key when nobody holds hers.
    const miaLostAt = 2 + Math.floor(rnd() * 12);
    let made = 0; let losses = 0;
    let abeKeys = new Set<string>();
    const tappedAt = new Map<string, number>(); // phone → index into toAbe when it tapped
    const copies: Copy[] = [copyOf(world)];
    let readies = 0; let follows = 0;
    for (let step = 0; step < 32; step++) {
        if (step === miaLostAt) {
            const st = mia.sync(world.stateFor(mia.pk));
            if (st.plan.kind === 'ready' || st.plan.kind === 'make_new') {
                const m = makeNamesGenerationFor(mia.pin!, mia.who, st.plan.kind === 'make_new' ? st.plan.drops : []);
                if (world.post(m.generation) === 201) made++;
            }
            world.admins = world.admins.filter((a) => a.publicKey !== mia.pk);
            continue;
        }
        if (step === lossAt) {
            // Abe's phone is lost: everything it holds, and every box sent to it from now on, is the operator's.
            abeKeys = new Set([...abe.ringIds(), ...toAbe.flatMap((sh) => sh.keyIds)]);
            const p = pick(honest);
            p.pin = removeNamesKey(p.pin!, abe.pk);
            tappedAt.set(p.pk, toAbe.length);
            tappedAll.set(p.pk, allShares.length);
            continue;
        }
        if (step > lossAt && rnd() < 0.08) {
            const p = pick(honest);
            if (!tappedAt.has(p.pk)) { p.pin = removeNamesKey(p.pin!, abe.pk); tappedAt.set(p.pk, toAbe.length); tappedAll.set(p.pk, allShares.length); }
            continue;
        }
        if (rnd() < 0.15) world.loseNextRetry = true;
        const r = rnd();
        if (r < 0.1) { copies.push(copyOf(world)); continue; }
        if (r < 0.2) { const c = pick(copies); copies.push(copyOf(world)); restore(world, c); continue; }
        if (r < 0.26 && world.entries.length) { // an honest delete
            const e = pick(world.entries);
            world.entries = world.entries.filter((x) => x !== e);
            world.deleted.push(e.id);
            continue;
        }
        const p = pick(honest);
        const view = rnd() < 0.25 ? { admins: [bea.who, cy.who, abe.who] } : {};
        let res = p.open(world, view);
        // The asked ways forward, as the screen offers them: Follow (on a different history, or a stop at a maker nobody
        // trusted vouches for) and Make a new key (nobody who is an admin holds the current one).
        if (res.plan.kind === 'refused' && (res.plan.reason === 'different_history' || res.plan.reason === 'untrusted_maker')
            && res.plan.canFollow && p.pin!.chain.length > 0 && rnd() < 0.8) {
            p.pin = followNamesServer(p.pin!, world.stateFor(p.pk, view)).pin;
            follows++;
            res = p.open(world, view);
        }
        if (res.plan.kind === 'wait' && res.plan.canMakeNew && rnd() < 0.8) {
            const m = makeNamesGenerationFor(p.pin!, p.who, res.plan.drops);
            p.pin = m.pin;
            if (world.post(m.generation) === 201) made++;
            res = p.open(world, view);
        }
        if (step > lossAt) for (const sh of toAbe) for (const id of sh.keyIds) abeKeys.add(id);
        const pin = p.pin!;
        const chainIds = new Set(pin.chain.map((l) => l.id));
        for (const id of Object.keys(pin.ring)) expect(chainIds.has(id) || pin.abandoned.includes(id)).toBe(true);
        const tap = tappedAt.get(p.pk);
        if (tap !== undefined) expect(toAbe.slice(tap).filter((sh) => sh.from === p.pk)).toEqual([]);
        // Round 11: no header this phone signs after its tap vouches for the key it removed (a claim in flight included).
        const tapAll = tappedAll.get(p.pk);
        if (tapAll !== undefined) for (const sh of allShares.slice(tapAll)) if (sh.from === p.pk) expect(sh.trusts).not.toContain(abe.pk);
        if (res.plan.kind === 'ready') {
            readies++;
            expect(Object.entries(pin.dropped).filter(([, id]) => !chainIds.has(id))).toEqual([]);
            if (tap !== undefined) {
                expect(pin.trusted).not.toContain(abe.pk);
                expect(abeKeys.has(p.head()!)).toBe(false);
            }
            // The read (Addendum 4): what was seen and is neither here nor deleted is a loss; K13: the count moves no
            // trust, drop, key, pending statement or removal by hand.
            const read = namesSeenAfterRead(pin, world.entries.map((e) => e.id), world.deleted);
            const keyParts = (q: NamesPin) => JSON.stringify([q.trusted, q.dropped, q.ring, q.pending, q.manualDrops, q.chain, q.abandoned]);
            expect(keyParts(read.pin)).toBe(keyParts(pin));
            for (const id of read.gone) {
                expect(pin.seen).toContain(id);
                expect(world.deleted).not.toContain(id);
            }
            expect(read.pin.seen.length).toBeLessThanOrEqual(2000);
            losses += read.gone.length;
            p.pin = read.pin;
            if (rnd() < 0.3) world.entries.push({ id: newNamesEntryId(), keyId: p.head()!, ciphertext: 'sealed' }); // a name added
        }
    }
    claimsSeen += allShares.length;
    return { readies, follows, taps: tappedAt.size, made, losses };
}

describe('the property check, in parts (each well under a minute on CI)', () => {
    const totals = { readies: 0, follows: 0, taps: 0, made: 0, losses: 0 };
    for (let part = 0; part < 12; part++) {
        it(`seeds ${part * 2 + 1}–${part * 2 + 2}: no phone that tapped Remove @Abe sends him anything, trusts him or writes under a key he holds; rings stay on the chain or abandoned; no standing drop when ready`, () => {
            for (let seed = part * 2 + 1; seed <= part * 2 + 2; seed++) {
                const r = propertyRun(seed);
                totals.readies += r.readies; totals.follows += r.follows; totals.taps += r.taps; totals.made += r.made; totals.losses += r.losses;
            }
        }, 60_000);
    }
    it('the parts exercised what they check: ready opens, follows, taps, new keys and losses counted', () => {
        // Round 11: the node's ask_for_share was met, and some claims went out with a removal by hand in flight.
        expect(claimsMade).toBeGreaterThan(0);
        expect(claimsWithRemoval).toBeGreaterThan(0);
        expect(totals.readies).toBeGreaterThan(100);
        expect(totals.follows).toBeGreaterThan(0);
        expect(totals.taps).toBeGreaterThanOrEqual(24);
    });
});

/**
 * J1's world (the re-review's :598): Owen, Bea, Dan, Abe and Zed on 1, a standby copies; on main Abe is removed (Owen's
 * 2), made an admin again and checked by Owen, and Bea re-admits him from Owen's header; the standby takes over, Zed is
 * removed there and Dan's phone makes 2″ without him; Bea follows.
 */
function overwriteWorld() {
    const { world, phones: [owen, bea, dan, abe, zed] } = community(['Owen', 'Bea', 'Dan', 'Abe', 'Zed']);
    const one = world.current!;
    const standby = copyOf(world);
    world.admins = [owen.who, bea.who, dan.who, zed.who];
    owen.open(world);
    const two = world.current!;
    bea.open(world);
    world.admins = [owen.who, bea.who, dan.who, zed.who, abe.who];
    owen.meet(abe);
    owen.open(world);
    bea.open(world);
    expect(bea.trusts(abe)).toBe(true);
    const main = copyOf(world);
    restore(world, standby);
    world.admins = [owen.who, bea.who, dan.who, abe.who];
    expect(dan.open(world).plan.kind).toBe('ready');
    const twoPP = world.current!;
    expect(world.gens.get(twoPP)!.drops).toEqual([zed.pk]);
    expect(bea.sync(world.stateFor(bea.pk)).plan).toEqual({ kind: 'refused', reason: 'different_history', canFollow: true });
    bea.pin = followNamesServer(bea.pin!, world.stateFor(bea.pk)).pin;
    return { world, owen, bea, dan, abe, zed, one, two, twoPP, main };
}

describe('J. Addendum 3: drops this phone stands by, removal by hand, and Follow (round 8)', () => {
    it("J1 (the re-review's :598) after Remove @Abe, following the server back to main keeps Abe removed: Bea's own 3 drops Abe and Zed; Owen's header at head 2 lifts nothing; nothing goes to Abe after the tap", () => {
        const { world, owen, bea, dan, abe, zed, one, two, twoPP, main } = overwriteWorld();
        expect(bea.pin!.chain.map((l) => l.id)).toEqual([one, twoPP]);
        expect(bea.pin!.abandoned).toEqual([two]);
        expect(bea.trusts(abe)).toBe(true);
        expect(bea.open(world).plan.kind).toBe('ready');
        // Abe's phone is lost: Bea taps Remove @Abe's old key.
        bea.pin = removeNamesKey(bea.pin!, abe.pk);
        const tapped = sharesTo(world, abe.pk, bea.pk);
        expect(bea.sync(world.stateFor(bea.pk)).plan).toEqual({ kind: 'make_new', drops: [abe.pk] });
        bea.open(world);
        const threePP = world.current!;
        expect(world.gens.get(threePP)).toMatchObject({ maker: bea.pk, drops: [abe.pk] });
        expect(bea.pin!.dropped[abe.pk]).toBe(threePP);
        expect(bea.pin!.manualDrops).toEqual([]);
        // The main copy is back; Bea follows again.
        restore(world, main);
        world.admins = [owen.who, bea.who, dan.who, zed.who, abe.who];
        expect(bea.sync(world.stateFor(bea.pk)).plan).toEqual({ kind: 'refused', reason: 'different_history', canFollow: true });
        bea.pin = followNamesServer(bea.pin!, world.stateFor(bea.pk)).pin;
        expect(bea.pin.chain.map((l) => l.id)).toEqual([one, two]);
        expect(bea.pin.abandoned.sort()).toEqual([twoPP, threePP].sort());
        expect(bea.pin.dropped[abe.pk]).toBe(threePP); // (a): kept, abandoned
        const r = bea.sync(world.stateFor(bea.pk));
        expect(r.toDrop).toEqual([abe.pk, zed.pk].sort());
        expect(r.plan).toEqual({ kind: 'make_new', drops: [abe.pk, zed.pk].sort() });
        bea.open(world);
        const three = world.current!;
        expect(world.gens.get(three)).toMatchObject({ maker: bea.pk, parentId: two, drops: [abe.pk, zed.pk].sort() });
        expect(bea.trusts(abe)).toBe(false);
        expect(bea.pin!.dropped[abe.pk]).toBe(three);
        // Nothing to Abe after the tap; no box to him carries 3″ or 3.
        // Bea's box to Abe is the one the restored main copy holds (from before the loss); none made after the tap.
        void tapped;
        expect(sharesTo(world, abe.pk, bea.pk)).toEqual([...main.shares.values()].filter((x) => x.from === bea.pk && x.to === abe.pk));
        for (const sh of sharesTo(world, abe.pk)) expect(sh.keyIds.filter((id) => id === threePP || id === three)).toEqual([]);
        // Owen takes Bea's 3 and drops Abe and Zed.
        owen.open(world);
        expect(owen.trusts(abe)).toBe(false);
        expect(owen.pin!.chain.map((l) => l.id)).toContain(three);
    });

    it("J2 (the re-review's :707) Remove @Abe after he was made an admin again, with Owen's new headers withheld from Bea: a key without Abe before she writes; the header, shown later, lifts nothing; variants: the header arrives after the tap, and Owen's own key lands first (409)", () => {
        for (const variant of ['withheld', 'after the tap', '409'] as const) {
            const { world, phones: [owen, bea, abe] } = community(['Owen', 'Bea', 'Abe']);
            world.admins = [owen.who, bea.who];
            owen.open(world);
            const two = world.current!;
            bea.open(world);
            const before = world.shares.get(`${owen.pk}|${bea.pk}`)!;
            world.admins = [owen.who, bea.who, abe.who];
            owen.meet(abe);
            owen.open(world);
            const header = world.shares.get(`${owen.pk}|${bea.pk}`)!;
            expect(header.trusts).toContain(abe.pk);
            const toAbe = world.shares.get(`${owen.pk}|${abe.pk}`)!;
            world.shares.set(`${owen.pk}|${bea.pk}`, before); // Owen's new headers withheld from Bea: hers and the one to Abe
            world.shares.delete(`${owen.pk}|${abe.pk}`);
            expect(bea.pin!.dropped[abe.pk]).toBe(two);
            // Abe's phone is lost; Bea taps Remove @Abe's old key.
            bea.pin = removeNamesKey(bea.pin!, abe.pk);
            if (variant === 'after the tap') { world.shares.set(`${owen.pk}|${bea.pk}`, header); world.shares.set(`${owen.pk}|${abe.pk}`, toAbe); }
            if (variant === '409') {
                owen.pin = removeNamesKey(owen.pin!, abe.pk);
                owen.open(world); // Owen's 3 drops Abe and lands first
            }
            const r = bea.sync(world.stateFor(bea.pk));
            expect(bea.pin!.manualDrops).toEqual([abe.pk]);
            expect(r.plan.kind).not.toBe('ready');
            settle(world, [bea]);
            const mine = world.gens.get(world.current!)!;
            expect(mine).toMatchObject({ maker: bea.pk, drops: [abe.pk] });
            expect(mine.n).toBe(variant === '409' ? 4 : 3);
            expect(bea.pin!.dropped[abe.pk]).toBe(mine.id);
            expect(bea.pin!.manualDrops).toEqual([]);
            world.shares.set(`${owen.pk}|${bea.pk}`, header); // shown now
            world.shares.set(`${owen.pk}|${abe.pk}`, toAbe);
            expect(bea.open(world).plan.kind).toBe('ready');
            expect(bea.trusts(abe)).toBe(false);
            expect(sharesTo(world, abe.pk, bea.pk).filter((sh) => sh.keyIds.includes(mine.id))).toEqual([]);
            owen.open(world);
            expect(owen.trusts(abe)).toBe(false);
        }
    });

    /** Owen, Bea, Cy (and Abe) on 1; a standby copies; main: Abe removed, Owen's 2, Bea takes it. */
    function standbyWorld() {
        const { world, phones: [owen, bea, cy, abe] } = community(['Owen', 'Bea', 'Cy', 'Abe']);
        const one = world.current!;
        const standby = copyOf(world);
        world.admins = [owen.who, bea.who, cy.who];
        owen.open(world);
        const two = world.current!;
        bea.open(world);
        return { world, owen, bea, cy, abe, one, two, standby, main: copyOf(world) };
    }

    it("J3 (the re-review's :749, W1) Cy's 2″ dropped Owen (the standby's stale roles); Bea followed; main back: different_history with canFollow and no admin named; Follow: Bea's own 3 drops Owen; one scan restores him", () => {
        const { world, owen, bea, cy, abe, one, two, standby, main } = standbyWorld();
        restore(world, standby);
        world.admins = [bea.who, cy.who, abe.who];
        cy.open(world);
        const twoPP = world.current!;
        expect(world.gens.get(twoPP)!.drops).toEqual([owen.pk]);
        bea.pin = followNamesServer(bea.pin!, world.stateFor(bea.pk)).pin;
        settle(world, [bea, cy]);
        restore(world, main);
        world.admins = [owen.who, bea.who, cy.who];
        const r = bea.sync(world.stateFor(bea.pk));
        expect(r.plan).toEqual({ kind: 'refused', reason: 'different_history', canFollow: true });
        const f = followNamesServer(bea.pin!, world.stateFor(bea.pk));
        bea.pin = f.pin;
        expect(bea.pin.chain.map((l) => l.id)).toEqual([one, two]);
        expect(bea.pin.dropped[owen.pk]).toBe(twoPP); // standing
        const r2 = bea.sync(world.stateFor(bea.pk));
        expect(r2.plan).toMatchObject({ kind: 'make_new' });
        expect((r2.plan as { drops: string[] }).drops).toContain(owen.pk);
        bea.open(world);
        const three = world.current!;
        expect(world.gens.get(three)).toMatchObject({ maker: bea.pk, parentId: two });
        // One scan restores Owen, and Bea's phone sends him the keys.
        bea.meet(owen);
        settle(world, [bea, owen]);
        expect(owen.open(world).plan.kind).toBe('ready');
        expect(owen.head()).toBe(three);
    });

    it("J4 (the re-review's :749, D1) the maker of the restored branch's key has lost their phone: every phone follows, each makes its own key without Owen's old key where it stands by that drop, and all are ready; nothing to the old key", () => {
        const { world, owen, bea, cy, abe, one, two, standby, main } = standbyWorld();
        restore(world, standby);
        world.admins = [owen.who, bea.who, cy.who, abe.who];
        cy.pin = removeNamesKey(cy.pin!, owen.pk); // Owen's phone lost
        cy.open(world);
        const twoPP = world.current!;
        expect(world.gens.get(twoPP)).toMatchObject({ maker: cy.pk, drops: [owen.pk] });
        const owenNew = new Phone(admin('Owen'));
        world.admins = [owenNew.who, bea.who, cy.who, abe.who];
        cy.meet(owenNew);
        bea.pin = followNamesServer(bea.pin!, world.stateFor(bea.pk)).pin;
        settle(world, [cy, owenNew, bea]);
        const toOld = sharesTo(world, owen.pk).length;
        restore(world, main);
        world.admins = [owenNew.who, bea.who, cy.who];
        for (const p of [bea, cy, owenNew]) {
            const r = p.sync(world.stateFor(p.pk));
            if (r.plan.kind === 'refused' && r.plan.reason === 'different_history') {
                expect(r.plan.canFollow).toBe(true);
                p.pin = followNamesServer(p.pin!, world.stateFor(p.pk)).pin;
            }
        }
        for (let i = 0; i < 4; i++) {
            settle(world, [bea, cy, owenNew]);
            for (const p of [bea, cy, owenNew]) {
                const r = p.sync(world.stateFor(p.pk));
                if (r.plan.kind === 'refused' && r.plan.reason === 'different_history' && r.plan.canFollow) p.pin = followNamesServer(p.pin!, world.stateFor(p.pk)).pin;
            }
        }
        for (const p of [bea, cy, owenNew]) {
            expect(p.open(world).plan.kind).toBe('ready');
            expect(p.head()).toBe(world.current);
            expect(p.pin!.chain[0].id).toBe(one);
            expect(p.pin!.chain.map((l) => l.id)).toContain(two);
            expect(p.trusts(owen)).toBe(false);
        }
        expect(sharesTo(world, owen.pk).length).toBe(toOld);
    });

    it("J5 no automatic crossing: the server alternates its current between 2 and 2″; nothing moves without a tap; a phone at the fork point takes the server's child; abandoned holds at most the other branch", () => {
        const { world, phones: [owen, bea, cy, dee] } = community(['Owen', 'Bea', 'Cy', 'Dee']);
        const one = world.current!;
        const freshAtOne = JSON.parse(JSON.stringify(dee.pin));
        owen.open(world);
        const m = makeNamesGenerationFor(owen.pin!, owen.who, []);
        owen.pin = m.pin;
        world.post(m.generation);
        const two = world.current!;
        settle(world, [owen, bea]);
        const c = makeNamesGenerationFor(cy.pin!, cy.who, []);
        cy.pin = c.pin;
        world.plant(c.generation, true);
        const twoPP = world.current!;
        for (let flip = 0; flip < 4; flip++) {
            world.current = flip % 2 === 0 ? twoPP : two;
            const before = JSON.stringify(bea.pin!.chain);
            const r = bea.sync(world.stateFor(bea.pk));
            if (world.current === twoPP) expect(r.plan).toEqual({ kind: 'refused', reason: 'different_history', canFollow: true });
            expect(JSON.stringify(bea.pin!.chain)).toBe(before);
            // A phone whose head is the fork point takes the child on the server's path.
            const atOne = new Phone(dee.who);
            atOne.pin = readNamesPin(freshAtOne, dee.pk);
            atOne.sync(world.stateFor(dee.pk));
            expect(atOne.pin!.chain.map((l) => l.id)).toEqual([one, world.current!]);
        }
        world.current = twoPP;
        bea.pin = followNamesServer(bea.pin!, world.stateFor(bea.pk)).pin;
        expect(bea.pin.abandoned).toEqual([two]);
        world.current = two;
        expect(bea.sync(world.stateFor(bea.pk)).plan).toEqual({ kind: 'refused', reason: 'different_history', canFollow: true });
        bea.pin = followNamesServer(bea.pin!, world.stateFor(bea.pk)).pin;
        expect(bea.pin.abandoned).toEqual([twoPP]);
        expect(bea.pin.chain.map((l) => l.id)).toEqual([one, two]);
    });

    it("J6 (the re-review's :547) Bea's abandoned 2 served back as current with a garbage signature: refused (only chain ids skip the check), missing_record, canFollow absent; the pin never holds it", () => {
        const { world, bea, two } = standbyWorld();
        const main = copyOf(world);
        // Bea follows a fork (a 2″ off 1) so that 2 is abandoned on her phone.
        world.current = world.gens.get(two)!.parentId;
        const twoPP = makeNamesGeneration({ communityId: CID, n: 2, parentId: world.current, drops: [] }, bea.who);
        world.plant(twoPP, true);
        bea.pin = followNamesServer(bea.pin!, world.stateFor(bea.pk)).pin;
        expect(bea.pin.abandoned).toEqual([two]);
        restore(world, main);
        const bad = { ...world.gens.get(two)!, signature: '00'.repeat(64) };
        world.gens.set(two, bad);
        const r = bea.sync(world.stateFor(bea.pk));
        expect(r.plan).toEqual({ kind: 'refused', reason: 'missing_record' });
        expect(followNamesServer(bea.pin!, world.stateFor(bea.pk)).pin).toBe(bea.pin);
        expect(bea.pin!.chain.map((l) => l.id)).not.toContain(two);
        expect(namesReplay(bea.pin!, world.stateFor(bea.pk)).map((l) => l.id)).not.toContain(two);
    });

    it('J8 X3 stands: Abe dropped at 2, re-admitted, dropped at 5 on one chain: a header from head 3 trusting him lifts nothing; one at 5 from an admin who checked him again does', () => {
        const { world, phones: [owen, bea, abe] } = community(['Owen', 'Bea', 'Abe']);
        world.admins = [owen.who, bea.who];
        owen.open(world); // 2
        world.admins = [owen.who, bea.who, abe.who];
        owen.meet(abe);
        owen.open(world);
        for (let i = 0; i < 2; i++) {
            const m = makeNamesGenerationFor(owen.pin!, owen.who, []);
            owen.pin = m.pin;
            world.post(m.generation);
            owen.open(world);
        }
        const four = world.current!;
        const three = world.gens.get(four)!.parentId!;
        const stale = makeNamesShare({ communityId: CID, from: owen.who, to: bea.pk, headId: three, ring: namesRingKeys(owen.pin!), trusts: [...owen.pin!.trusted] });
        world.admins = [owen.who, bea.who];
        owen.open(world); // 5 drops Abe
        const five = world.current!;
        world.shares.delete(`${owen.pk}|${bea.pk}`);
        bea.open(world, { extraShares: [stale] });
        expect(bea.pin!.dropped[abe.pk]).toBe(five);
        expect(bea.trusts(abe)).toBe(false);
        // Owen checks Abe again; his header at 5 trusts Abe; Bea re-admits him.
        world.admins = [owen.who, bea.who, abe.who];
        owen.meet(abe);
        owen.open(world);
        bea.open(world);
        expect(bea.trusts(abe)).toBe(true);
    });

    it('J9 start again is a follow on an empty chain: the whole path for drops and place, ids in `dropped`, no trust, no key', () => {
        const { world, phones: [owen, abe] } = community(['Owen', 'Abe']);
        world.admins = [owen.who];
        owen.open(world); // 2 drops Abe
        const two = world.current!;
        const q = new Phone(admin('Quin'));
        world.admins = [q.who];
        q.sync(world.stateFor(q.pk));
        const f = followNamesServer(q.pin!, world.stateFor(q.pk));
        expect(f.pin.chain.map((l) => l.id)).toEqual([world.gens.get(two)!.parentId, two]);
        expect(f.pin.dropped[abe.pk]).toBe(two);
        expect(f.pin.trusted).toEqual([q.pk]);
        expect(f.pin.ring).toEqual({});
        void owen;
    });

    it('J10 a fork-cross with nothing standing: Follow, then the key from a trusted holder, ready under 2″, no extra key', () => {
        const { world, phones: [owen, bea, cy] } = community(['Owen', 'Bea', 'Cy']);
        const one = world.current!;
        const m = makeNamesGenerationFor(owen.pin!, owen.who, []);
        owen.pin = m.pin;
        world.post(m.generation);
        settle(world, [owen, bea]);
        const c = makeNamesGenerationFor(cy.pin!, cy.who, []);
        cy.pin = c.pin;
        world.plant(c.generation, true);
        const twoPP = world.current!;
        cy.open(world);
        bea.pin = followNamesServer(bea.pin!, world.stateFor(bea.pk)).pin;
        expect(bea.sync(world.stateFor(bea.pk)).toDrop).toEqual([]);
        settle(world, [cy, bea]);
        expect(bea.open(world).plan.kind).toBe('ready');
        expect(bea.pin!.chain.map((l) => l.id)).toEqual([one, twoPP]);
        expect([...world.gens.values()].filter((g) => g.maker === bea.pk)).toEqual([]);
    });

    it('J11 a planted branch followed: the operator plants 2ᵒ by O dropping Owen and says O holds it; Follow drops Owen (said), no key arrives, nothing read or written; one scan restores Owen', () => {
        const { world, phones: [owen, bea] } = community(['Owen', 'Bea']);
        const one = world.current!;
        const m = makeNamesGenerationFor(owen.pin!, owen.who, []);
        owen.pin = m.pin;
        world.post(m.generation);
        settle(world, [owen, bea]);
        const o = admin('Op');
        world.admins.push(o);
        const planted = makeNamesGeneration({ communityId: CID, n: 2, parentId: one, drops: [owen.pk] }, o);
        world.plant(planted, true);
        expect(bea.sync(world.stateFor(bea.pk)).plan).toEqual({ kind: 'refused', reason: 'different_history', canFollow: true });
        const f = followNamesServer(bea.pin!, world.stateFor(bea.pk));
        expect(f.dropped).toEqual([{ key: owen.pk, maker: o.publicKey, n: 2 }]);
        bea.pin = f.pin;
        const r = bea.sync(world.stateFor(bea.pk));
        expect(r.plan).toMatchObject({ kind: 'wait', holders: [], canMakeNew: false });
        expect(bea.ringIds()).not.toContain(planted.id);
        bea.meet(owen);
        expect(bea.trusts(owen)).toBe(true);
        expect(bea.sync(world.stateFor(bea.pk)).plan.kind).toBe('wait');
    });
});

/**
 * K1's world (the re-review's :774 dead end): Owen, Bea, Dan, Mia, Zed on 1; a standby copies with Mia listed. Main:
 * Mia removed, Owen's 2 drops her, Bea and Dan take it. The standby takes over; Owen's phone lost, his role removed;
 * Mia's 2″ off 1 drops Owen and its boxes never land; Bea and Dan follow; Zed removed; Mia's 3″ drops Zed and its boxes
 * land; then (unless `miaListed`) Mia's phone is lost and her role removed.
 */
function lostMakerWorld(miaListed = false) {
    const { world, phones: [owen, bea, dan, mia, zed] } = community(['Owen', 'Bea', 'Dan', 'Mia', 'Zed']);
    const one = world.current!;
    const standby = copyOf(world);
    world.admins = [owen.who, bea.who, dan.who, zed.who];
    owen.open(world); // 2 drops Mia
    const two = world.current!;
    bea.open(world);
    dan.open(world);
    restore(world, standby);
    world.admins = [bea.who, dan.who, mia.who, zed.who];
    const r = mia.sync(world.stateFor(mia.pk));
    expect(r.plan).toEqual({ kind: 'make_new', drops: [owen.pk] });
    const m2 = makeNamesGenerationFor(mia.pin!, mia.who, [owen.pk]);
    mia.pin = m2.pin;
    expect(world.post(m2.generation)).toBe(201);
    mia.sync(world.stateFor(mia.pk)); // its boxes never land
    const twoPP = m2.generation.id;
    for (const p of [bea, dan]) {
        expect(p.sync(world.stateFor(p.pk)).plan).toMatchObject({ kind: 'refused', reason: 'different_history', canFollow: true });
        p.pin = followNamesServer(p.pin!, world.stateFor(p.pk)).pin;
        expect(p.pin.dropped[mia.pk]).toBe(two); // standing
    }
    world.admins = [bea.who, dan.who, mia.who];
    mia.open(world); // 3″ drops Zed; its boxes land
    const threePP = world.current!;
    expect(world.gens.get(threePP)).toMatchObject({ maker: mia.pk, parentId: twoPP, drops: [zed.pk] });
    if (!miaListed) world.admins = [bea.who, dan.who];
    return { world, owen, bea, dan, mia, zed, one, two, twoPP, threePP };
}

describe('K. Addendum 4: rule 1b carries a standing drop, Follow from a stop, holders on their own word (round 10)', () => {
    it("K1 (the re-review's :774) the maker's phone is lost and nobody trusted vouches her key: Bea follows from the stop and makes a key without Mia; Dan takes it (rule 1b carries his standing drop) and makes his own; nothing to Mia", () => {
        const { world, bea, dan, mia, one, two, twoPP, threePP } = lostMakerWorld();
        const r = bea.sync(world.stateFor(bea.pk));
        expect(r.plan).toEqual({ kind: 'refused', reason: 'untrusted_maker', maker: mia.pk, n: 3, canCheck: false, standing: true, canFollow: true });
        const before = JSON.stringify(bea.pin!.chain);
        expect(bea.sync(world.stateFor(bea.pk)).plan.kind).toBe('refused');
        expect(JSON.stringify(bea.pin!.chain)).toBe(before); // nothing moves without a tap
        bea.pin = followNamesServer(bea.pin!, world.stateFor(bea.pk)).pin;
        expect(bea.pin.chain.map((l) => l.id)).toEqual([one, twoPP, threePP]);
        expect(bea.pin.abandoned).toEqual([two]);
        expect(bea.pin.dropped[mia.pk]).toBe(two);
        const st = world.stateFor(bea.pk);
        // K3: a box addressed isn't a key held: nobody holds 3″ on their own word.
        expect(st.admins.find((a) => a.pubkey === bea.pk)!.keyIds).not.toContain(threePP);
        expect(st.admins.find((a) => a.pubkey === dan.pk)!.keyIds).not.toContain(threePP);
        expect(st.nobodyHoldsKey).toBe(true);
        const w = bea.sync(st);
        expect(w.plan).toMatchObject({ kind: 'wait', keyId: threePP, holders: [], canMakeNew: true, drops: [mia.pk] });
        const made = makeNamesGenerationFor(bea.pin!, bea.who, (w.plan as { drops: string[] }).drops);
        bea.pin = made.pin;
        expect(world.post(made.generation)).toBe(201);
        expect(bea.open(world).plan.kind).toBe('ready');
        const fourPP = world.current!;
        expect(world.gens.get(fourPP)).toMatchObject({ maker: bea.pk, parentId: threePP, drops: [mia.pk] });
        // Dan: follows the stop too (or a header vouches it), then takes Bea's key and makes his own without Mia.
        const rd = dan.sync(world.stateFor(dan.pk));
        expect(dan.pin!.chain.map((l) => l.id)).toEqual([one, twoPP, threePP, fourPP]); // 3″ by rule 1b, 4″ by rule 1
        expect(rd.toDrop).toEqual([mia.pk]);
        settle(world, [dan, bea]);
        expect(dan.open(world).plan.kind).toBe('ready');
        expect(world.gens.get(dan.head()!)).toMatchObject({ maker: dan.pk, drops: [mia.pk] });
        expect(bea.open(world).plan.kind).toBe('ready');
        for (const p of [bea, dan]) {
            expect(p.ringIds()).toEqual(expect.arrayContaining([one, two]));
            expect(p.ringIds()).not.toContain(twoPP);
            expect(p.ringIds()).not.toContain(threePP);
        }
        expect(sharesTo(world, mia.pk).filter((x) => x.from === bea.pk || x.from === dan.pk).filter((x) => x.keyIds.includes(fourPP))).toEqual([]);
    });

    it("K2 the words with Cy: Cy's phone (on the standby, trusting Mia) made 2″ and took Mia's 3″; Bea, on 2″ with Mia standing, checks Cy: 3″ is taken by rule 1b, and Bea's own 4″ drops Mia", () => {
        const { world, phones: [owen, bea, cy, mia, zed] } = community(['Owen', 'Bea', 'Cy', 'Mia', 'Zed']);
        const standby = copyOf(world);
        world.admins = [owen.who, bea.who, cy.who, zed.who];
        owen.open(world);
        bea.open(world);
        restore(world, standby);
        world.admins = [bea.who, cy.who, mia.who, zed.who]; // Owen's phone lost
        cy.open(world); // 2″ drops Owen
        settle(world, [cy, mia]);
        bea.pin = followNamesServer(bea.pin!, world.stateFor(bea.pk)).pin;
        world.admins = [bea.who, cy.who, mia.who];
        mia.open(world); // 3″ drops Zed
        const threePP = world.current!;
        expect(world.gens.get(threePP)!.maker).toBe(mia.pk);
        cy.open(world);
        expect(cy.head()).toBe(threePP);
        bea.meet(cy);
        cy.open(world);
        const r = bea.sync(world.stateFor(bea.pk));
        expect(bea.head()).toBe(threePP); // taken by rule 1b, Mia standing
        expect(r.toDrop).toContain(mia.pk);
        settle(world, [cy, bea]);
        expect(bea.open(world).plan.kind).toBe('ready');
        expect(world.gens.get(bea.head()!)).toMatchObject({ maker: bea.pk, parentId: threePP });
        expect(world.gens.get(bea.head()!)!.drops).toContain(mia.pk);
    });

    it("K5 rule 1b with a standing drop: Abe's 3″ off 2″ lands first and Cy (in the dark, trusting Abe, holding its key) vouches it; Bea takes it, keeps Abe standing, makes 4″ without him, and only then writes", () => {
        const { world, bea, cy, abe, twoPP, view } = forkWorld();
        bea.pin = followNamesServer(bea.pin!, world.stateFor(bea.pk, view)).pin;
        const threeAbe = makeNamesGeneration({ communityId: CID, n: 3, parentId: twoPP, drops: [] }, abe.who);
        world.plant(threeAbe, true);
        const k3 = newNamesListKey();
        world.putShare(makeNamesShare({ communityId: CID, from: cy.who, to: bea.pk, headId: threeAbe.id, ring: { ...namesRingKeys(cy.pin!), [threeAbe.id]: k3 }, trusts: cy.pin!.trusted }));
        const r = bea.sync(world.stateFor(bea.pk, view));
        expect(bea.head()).toBe(threeAbe.id);
        expect(bea.pin!.dropped[abe.pk]).not.toBe(threeAbe.id);
        expect(bea.pin!.ring[threeAbe.id]).toBe(bytesToHex(k3));
        expect(r.plan).toEqual({ kind: 'make_new', drops: [abe.pk] });
        bea.open(world, view);
        const four = world.gens.get(world.current!)!;
        expect(four).toMatchObject({ maker: bea.pk, parentId: threeAbe.id, drops: [abe.pk] });
        expect(bea.open(world, view).plan.kind).toBe('ready');
        expect(bea.head()).toBe(four.id);
        expect(sharesTo(world, abe.pk, bea.pk).filter((x) => x.keyIds.includes(four.id))).toEqual([]);
        cy.open(world, view);
        expect(cy.trusts(abe)).toBe(false);
    });

    it('K6 a planted statement on the head: every phone stops at O with Follow offered; (a) O unlisted: after Follow, a new key off it, nothing under 3ᵒ; (b) O listed and holding it: the phone waits, and an owner must remove O', () => {
        for (const variant of ['a', 'b'] as const) {
            const { world, phones: [owen, bea] } = community(['Owen', 'Bea']);
            const m = makeNamesGenerationFor(owen.pin!, owen.who, []);
            owen.pin = m.pin;
            world.post(m.generation);
            settle(world, [owen, bea]);
            const o = admin('Op');
            const planted = makeNamesGeneration({ communityId: CID, n: 3, parentId: world.current, drops: [owen.pk] }, o);
            world.plant(planted, true);
            if (variant === 'b') {
                world.admins.push(o);
                world.putShare(makeNamesShare({ communityId: CID, from: o, to: bea.pk, headId: planted.id, ring: { [planted.id]: newNamesListKey() }, trusts: [o.publicKey] }));
            }
            for (const p of [owen, bea]) {
                expect(p.sync(world.stateFor(p.pk)).plan).toMatchObject({ kind: 'refused', reason: 'untrusted_maker', maker: o.publicKey, standing: false, canFollow: true });
            }
            const f = followNamesServer(bea.pin!, world.stateFor(bea.pk));
            expect(f.dropped.map((d) => d.key)).toEqual([owen.pk]);
            bea.pin = f.pin;
            const r = bea.sync(world.stateFor(bea.pk));
            expect(bea.ringIds()).not.toContain(planted.id);
            if (variant === 'a') {
                expect(r.plan).toMatchObject({ kind: 'wait', canMakeNew: true });
                const n = makeNamesGenerationFor(bea.pin!, bea.who, (r.plan as { drops: string[] }).drops);
                bea.pin = n.pin;
                expect(world.post(n.generation)).toBe(201);
                expect(bea.open(world).plan.kind).toBe('ready');
                expect(bea.head()).toBe(n.generation.id);
            } else {
                expect(r.plan).toMatchObject({ kind: 'wait', holders: [], canMakeNew: false });
                bea.pin = removeNamesKey(bea.pin!, o.publicKey);
                expect(bea.sync(world.stateFor(bea.pk)).plan).toMatchObject({ kind: 'wait', canMakeNew: false });
            }
            expect(bea.ringIds()).not.toContain(planted.id);
        }
    });

    it('K7 the lost maker still listed (a quiet owner): Bea waits with nobody to make a new key; once an owner removes Mia, K1', () => {
        const { world, bea, mia } = lostMakerWorld(true);
        bea.pin = followNamesServer(bea.pin!, world.stateFor(bea.pk)).pin;
        expect(bea.sync(world.stateFor(bea.pk)).plan).toMatchObject({ kind: 'wait', holders: [], canMakeNew: false });
        world.admins = world.admins.filter((a) => a.publicKey !== mia.pk);
        expect(bea.sync(world.stateFor(bea.pk)).plan).toMatchObject({ kind: 'wait', canMakeNew: true });
    });
});

describe('E. Rollback, forks', () => {
    it('E1 a rollback to generation 1: phones at 3 refuse; replay puts 2 and 3 back; a name written then is under 3, which Abe\'s key 1 doesn\'t open', () => {
        const { world, phones: [owen, ada, abe] } = community(['Owen', 'Ada', 'Abe']);
        const one = world.current!;
        world.admins = [owen.who, ada.who];
        owen.open(world); // 2 drops Abe
        ada.open(world);
        const m = makeNamesGenerationFor(owen.pin!, owen.who, []);
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
        const mb = makeNamesGenerationFor(owenThere.pin!, owen.who, []);
        owenThere.pin = mb.pin;
        shown.post(mb.generation);
        owenThere.open(shown);
        const b = mb.generation;
        expect(bea.open(shown).plan.kind).toBe('ready');
        expect(bea.head()).toBe(b.id);
        // Everyone else's: Ada's a, numbered 2, then her 3; Owen's phone takes both and their keys.
        for (const n of [2, 3]) {
            const m = makeNamesGenerationFor(ada.pin!, ada.who, []);
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
        expect(r.plan).toEqual({ kind: 'refused', reason: 'different_history', canFollow: true });
        bea.pin = followNamesServer(bea.pin!, world.stateFor(bea.pk)).pin;
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

/**
 * The names list on an admin's phone (utils/names-list.ts, app/names-list.tsx; the server is apps/server/src/routes/
 * names-list.ts, tested over HTTPS by test-names-list.ts and test-standby-names-list.ts).
 *
 * Nothing here contacts a node. The `fetch` stub plays the admin's community: it records every request, and each is
 * checked as the node's middleware checks it (signed by the admin's own key, for that host). What the phone sends is
 * checked for the planted names: nothing readable leaves the phone. The keys and boxes are real (@beanpool/core).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))),
}));
const mem = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.delete(key); }),
    },
}));

import { getPublicKey } from '@noble/ed25519';
import {
    newNamesListKey, wrapNamesListKey, unwrapNamesListKey, sealNamesEntry, openNamesEntry, newNamesEntryId, NAMES_LIMITS, toEd25519Pkcs8,
    signedNamesWrap, namesWrapDigest, verifyNamesWrap, type WrappedNamesKey,
} from '@beanpool/core';
import { bytesToHex } from '../crypto';
import { boundSignatureValid } from './server-signature-check';
import { lightColors, darkColors } from '../../constants/colors';
import {
    offersNamesList, keyPlan, traceFor, waitingAdmins, shareKeyWith, openEntries, filterEntries, sealedFor,
    addNamesEntry, editNamesEntry, reEncryptBatches, sendReEncrypted, confirmableMembers, confirmationActions, confirmationLine,
    logLineText, namesListHtml, fetchNamesState, fetchNamesList, confirmMember, deleteNamesEntry, openNamesList, readNamesTrust,
    namesTrustStoreKey, checkAdminInPerson, myKeyCheck, inPersonResult, installKeyFor, NAMES_COPY,
    type NamesState, type NamesListBody, type ConfirmationRow, type NamesAdminRow, type SealedEntryRow,
} from '../names-list';
import { NAMES_TEXT_ON, NAMES_TOUCH_TARGETS, namesListStyleSpec } from '../names-list-style';
import type { BeanPoolIdentity } from '../identity';

const COMMUNITY = 'https://mullum.beanpool.org';
const PLANTED = ['Zebedee Quillfeather', 'Lives by the old cannery'];

async function admin(callsign: string, pkcs8 = false): Promise<BeanPoolIdentity> {
    const seed = new Uint8Array(randomBytes(32));
    const pub = bytesToHex(await getPublicKey(seed));
    return { publicKey: pub, privateKey: bytesToHex(pkcs8 ? toEd25519Pkcs8(seed) : seed), callsign } as BeanPoolIdentity;
}

interface Sent { url: string; method: string; headers: Record<string, string>; body: string }
let sent: Sent[] = [];
let answer: (req: Sent) => { status: number; body?: unknown } = () => ({ status: 500 });

beforeEach(() => {
    mem.clear();
    sent = [];
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
        const req = { url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body ?? '' };
        sent.push(req);
        const a = answer(req);
        return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => { if (a.body === undefined) throw new Error('no body'); return a.body; } };
    });
});

const nothingReadable = (s: Sent) => PLANTED.every((p) => !s.body.toLowerCase().includes(p.toLowerCase()));

describe('who is offered the names list', () => {
    it('an owner or admin on a local community; never a moderator, a member, or anyone on the global node', () => {
        expect(offersNamesList('owner', 'local')).toBe(true);
        expect(offersNamesList('admin', null)).toBe(true);
        expect(offersNamesList('moderator', 'local')).toBe(false);
        expect(offersNamesList(null, 'local')).toBe(false);
        expect(offersNamesList('owner', 'global')).toBe(false);
        const entry = fs.readFileSync(path.join(__dirname, '../../components/NodeAdminEntry.tsx'), 'utf8');
        expect(entry).toMatch(/offersNamesList\(role, profile\?\.profile\) \? \(/);
        expect(entry).toContain("pathname: '/names-list'");
    });
});

/**
 * A community's node as the phone sees it: the wraps (each signed, or written in by whoever runs it), the entries, the
 * admins. Answers the routes the phone calls, by the signed request's key; records what it was sent.
 */
class FakeNode {
    rows: { holder: string; generation: number; wrap: WrappedNamesKey; wrappedBy: string; signature: string; drops: string[]; live: boolean }[] = [];
    entries: SealedEntryRow[] = [];
    admins: NamesAdminRow[] = [];
    droppedHolders: string[] = [];
    newKeyNeeded = false;
    /** An admin's phone signs and sends a wrap. */
    wrapBy(signer: BeanPoolIdentity, key: Uint8Array, holder: string, generation: number, drops: string[] = []): void {
        const w = signedNamesWrap(wrapNamesListKey(key, holder, generation), { communityId: CID, generation, holder, signer, drops });
        const { holder: _h, signature, drops: d, ...wrap } = w;
        void _h;
        this.put({ holder, generation, wrap, wrappedBy: signer.publicKey, signature, drops: d, live: true });
    }
    /** Whoever runs the server writes a row: a key of its own, any signer named, any signature. */
    plant(holder: string, generation: number, key: Uint8Array, wrappedBy: string, signature: string): void {
        this.put({ holder, generation, wrap: wrapNamesListKey(key, holder, generation), wrappedBy, signature, drops: [], live: true });
    }
    put(row: FakeNode['rows'][number]): void {
        this.rows = this.rows.filter((r) => !(r.holder === row.holder && r.generation === row.generation));
        this.rows.push(row);
    }
    add(key: Uint8Array, generation: number, name: string): string {
        const id = newNamesEntryId();
        this.entries.push({ id, ciphertext: sealNamesEntry(key, id, generation, { name, note: '' }), keyGeneration: generation, createdBy: 'x', createdAt: '2026-10-01', updatedBy: null, updatedAt: '' });
        return id;
    }
    generation(): number {
        return Math.max(0, ...this.rows.map((r) => r.generation), ...this.entries.map((e) => e.keyGeneration));
    }
    stateFor(me: string): NamesState {
        const generation = this.generation();
        const holders = new Set(this.rows.filter((r) => r.generation === generation && r.live).map((r) => r.holder));
        const meRow = this.admins.find((a) => a.pubkey === me);
        return {
            communityId: CID, generation, newKeyNeeded: this.newKeyNeeded, droppedHolders: this.droppedHolders, nobodyHoldsKey: generation > 0 && holders.size === 0,
            myKeys: this.rows.filter((r) => r.holder === me && r.live).map((r) => ({ ...r.wrap, generation: r.generation, wrappedBy: r.wrappedBy, signature: r.signature, drops: r.drops })),
            records: this.rows.map((r) => ({ communityId: CID, generation: r.generation, holder: r.holder, wrappedBy: r.wrappedBy, wrapDigest: namesWrapDigest(r.wrap), drops: r.drops, signature: r.signature })),
            admins: this.admins.map((a) => ({ ...a, holdsKey: holders.has(a.pubkey) })),
            settings: { twoAdminsToConfirm: false, namesShownToMembers: false },
            counts: { entries: this.entries.length, olderKey: 0, locked: 0, confirmed: 0, awaitingSecond: 0 },
            me: { pubkey: me, role: meRow?.role ?? null, owner: meRow?.role === 'owner' },
        };
    }
    /** The fetch stub's answer. */
    answer(req: Sent): { status: number; body?: unknown } {
        const who = req.headers['X-Public-Key'];
        const { pathname } = new URL(req.url);
        const body = req.body ? JSON.parse(req.body) : {};
        if (req.method === 'GET' && pathname === '/api/names/state') return { status: 200, body: this.stateFor(who) };
        if (req.method === 'GET' && pathname === '/api/names/entries') return { status: 200, body: { generation: this.generation(), entries: this.entries, confirmations: [] } };
        if (req.method === 'POST' && pathname === '/api/names/entries/re-encrypt') {
            for (const e of body.entries) {
                const row = this.entries.find((x) => x.id === e.id)!;
                row.ciphertext = e.ciphertext;
                row.keyGeneration = body.generation;
            }
            return { status: 200, body: { done: body.entries.length, left: 0 } };
        }
        if (req.method === 'POST' && (pathname === '/api/names/key' || pathname === '/api/names/key/share')) {
            for (const w of body.wraps) {
                const { holder, signature, drops, ...wrap } = w;
                this.put({ holder, generation: body.generation, wrap, wrappedBy: who, signature, drops, live: true });
            }
            if (pathname === '/api/names/key') { this.newKeyNeeded = false; this.droppedHolders = []; }
            return { status: pathname === '/api/names/key' ? 201 : 200, body: pathname === '/api/names/key' ? { generation: body.generation } : { shared: body.wraps.map((w: any) => w.holder) } };
        }
        return { status: 404, body: { error: 'no such route', code: 'not_found' } };
    }
}

const CID = 'a1b2c3d4e5f60718';
const STORE = { getItem: async (k: string) => mem.get(k) ?? null, setItem: async (k: string, v: string) => { mem.set(k, v); } };
const pinOf = (me: BeanPoolIdentity) => readNamesTrust(STORE, me.publicKey, COMMUNITY);
const sentAs = (method: string, path: string) => sent.filter((s) => s.method === method && new URL(s.url).pathname === path);

/** Owen made generation 1 and shared it with Ada; both phones opened the list once. */
async function community(): Promise<{ node: FakeNode; owen: BeanPoolIdentity; ada: BeanPoolIdentity; k1: Uint8Array; ids: string[] }> {
    const [owen, ada] = [await admin('Owen'), await admin('Ada')];
    const node = new FakeNode();
    node.admins = [{ pubkey: owen.publicKey, callsign: 'Owen', role: 'owner', holdsKey: false }, { pubkey: ada.publicKey, callsign: 'Ada', role: 'admin', holdsKey: false }];
    const k1 = newNamesListKey();
    node.wrapBy(owen, k1, owen.publicKey, 1);
    node.wrapBy(owen, k1, ada.publicKey, 1);
    const ids = PLANTED.map((n) => node.add(k1, 1, n));
    answer = (req) => node.answer(req);
    for (const who of [owen, ada]) expect((await openNamesList(COMMUNITY, who, STORE)).ok).toBe(true);
    sent = [];
    return { node, owen, ada, k1, ids };
}

describe('the key: made, opened, and passed on only by a tap', () => {
    it('the first admin makes the key, for themselves alone, signed with their own key; it opens with their key only', async () => {
        const owen = await admin('Owen');
        const node = new FakeNode();
        node.admins = [{ pubkey: owen.publicKey, callsign: 'Owen', role: 'owner', holdsKey: false }];
        answer = (req) => node.answer(req);
        const opened = await openNamesList(COMMUNITY, owen, STORE);
        expect(opened.ok && opened.value.plan.kind).toBe('ready');
        const keyReq = sentAs('POST', '/api/names/key')[0];
        expect(boundSignatureValid(keyReq, owen.publicKey)).toBe(true);
        const body = JSON.parse(keyReq.body);
        expect(body.generation).toBe(1);
        expect(body.wraps.map((w: any) => w.holder)).toEqual([owen.publicKey]);
        const w = body.wraps[0];
        expect(verifyNamesWrap({ communityId: CID, generation: 1, holder: owen.publicKey, wrappedBy: owen.publicKey, wrapDigest: namesWrapDigest(w), drops: [] }, w.signature)).toBe(true);
        const key = unwrapNamesListKey(w, owen.privateKey, owen.publicKey, 1);
        expect(opened.ok && Buffer.from(opened.value.keys.get(1)!).equals(Buffer.from(key))).toBe(true);
        expect((await pinOf(owen))?.trusted).toEqual([owen.publicKey]);
    });

    it('an admin shared with opens it on first use, trusts the admin who signed it, and is told so', async () => {
        const { node, ada, k1 } = await community();
        mem.clear();
        const opened = await openNamesList(COMMUNITY, ada, STORE);
        expect(opened.ok && opened.value.plan.kind).toBe('ready');
        expect(opened.ok && Buffer.from(opened.value.keys.get(1)!).equals(Buffer.from(k1))).toBe(true);
        expect(opened.ok && opened.value.notice).toMatch(/^This phone now trusts @Owen for the names list/);
        expect((await pinOf(ada))?.trusted.sort()).toEqual([node.admins[0].pubkey, ada.publicKey].sort());
    });

    it("THE REVIEW'S ATTACK: a next-generation wrap written into the node's database: nothing re-sealed, nothing read, the admin told", async () => {
        const { node, owen, ada, k1, ids } = await community();
        const planted = newNamesListKey();
        node.plant(ada.publicKey, 2, planted, owen.publicKey, '00'.repeat(64));
        const before = JSON.stringify(node.entries);
        const pinBefore = await pinOf(ada);
        const opened = await openNamesList(COMMUNITY, ada, STORE);
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        expect(opened.value.plan).toEqual({ kind: 'refused', refusal: { reason: 'unsigned', maker: owen.publicKey, makerCallsign: 'Owen', canTrust: false } });
        expect(opened.value.keys.has(2)).toBe(false);
        // The phone asked for the state and nothing else: no list read, nothing sealed or sent.
        expect(sent.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual(['GET /api/names/state']);
        expect(JSON.stringify(node.entries)).toBe(before);
        for (const id of ids) {
            const e = node.entries.find((x) => x.id === id)!;
            expect(e.keyGeneration).toBe(1);
            expect(openNamesEntry(k1, id, 1, e.ciphertext).name).toBeTruthy();
            expect(() => openNamesEntry(planted, id, 2, e.ciphertext)).toThrow();
        }
        // The real wraps stay (the phone changed nothing), and the phone still trusts whom it trusted.
        expect(node.rows.filter((r) => r.generation === 1).length).toBe(2);
        expect(await pinOf(ada)).toEqual(pinBefore);
        const said = NAMES_COPY.refused(opened.value.plan.kind === 'refused' ? opened.value.plan.refusal : (null as never), ['Owen']);
        expect(said).toMatch(/isn’t signed by them/);
        expect(said).toMatch(/no name was sealed under it/);
        // And a name written now has no key to be sealed under: the screen offers no Add.
        const screen = fs.readFileSync(path.join(__dirname, '../../app/names-list.tsx'), 'utf8');
        expect(screen).toContain("plan?.kind === 'refused'");
        expect(screen.indexOf("plan?.kind === 'refused'")).toBeLessThan(screen.indexOf("plan?.kind === 'ready' && state"));
    });

    it('a key the node made an admin, signing its own key: refused; trusted only after an in-person check, and asked first', async () => {
        const { node, owen, ada } = await community();
        const oscar = await admin('Oscar');
        node.admins.push({ pubkey: oscar.publicKey, callsign: 'Oscar', role: 'admin', holdsKey: false });
        const k2 = newNamesListKey();
        node.wrapBy(oscar, k2, oscar.publicKey, 2);
        node.wrapBy(oscar, k2, ada.publicKey, 2);
        const opened = await openNamesList(COMMUNITY, ada, STORE);
        expect(opened.ok && opened.value.plan).toEqual({ kind: 'refused', refusal: { reason: 'untrusted', maker: oscar.publicKey, makerCallsign: 'Oscar', canTrust: true } });
        expect(sent.filter((s) => s.method !== 'GET')).toEqual([]);
        expect((await pinOf(ada))?.trusted).not.toContain(oscar.publicKey);
        const screen = fs.readFileSync(path.join(__dirname, '../../app/names-list.tsx'), 'utf8');
        // The screen offers a check in person, never "trust" on the server's word; a match is asked about before it is kept.
        expect(screen).not.toContain('trustAdminKey');
        const check = screen.slice(screen.indexOf('const finishCheck'), screen.indexOf('const onScanned'));
        expect(check.indexOf("inPersonResult(text, admin.pubkey)")).toBeGreaterThan(-1);
        expect(check.indexOf('Alert.alert(COPY.trustTitle')).toBeGreaterThan(check.indexOf("if (purpose === 'share')"));
        expect(check.slice(check.indexOf('const keep'), check.indexOf("if (purpose === 'share')"))).toContain('checkAdminInPerson(');
        expect(check.indexOf('void keep()', check.indexOf('Alert.alert(COPY.trustTitle'))).toBeGreaterThan(check.indexOf('Alert.alert(COPY.trustTitle'));
        if (!opened.ok) return;
        // The code on someone else's phone (the operator's, say) doesn't match: nothing is kept.
        expect(await checkAdminInPerson(STORE, ada, COMMUNITY, opened.value.state, { pubkey: oscar.publicKey, callsign: 'Oscar' }, myKeyCheck(owen).qr))
            .toEqual({ ok: false, reason: 'mismatch' });
        expect(await checkAdminInPerson(STORE, ada, COMMUNITY, opened.value.state, { pubkey: oscar.publicKey, callsign: 'Oscar' }, 'hello'))
            .toEqual({ ok: false, reason: 'unreadable' });
        expect((await pinOf(ada))?.trusted).not.toContain(oscar.publicKey);
        // Oscar's own phone, checked in person (the code typed): then the phone takes his key.
        expect(await checkAdminInPerson(STORE, ada, COMMUNITY, opened.value.state, { pubkey: oscar.publicKey, callsign: 'Oscar' }, myKeyCheck(oscar).code))
            .toEqual({ ok: true });
        const again = await openNamesList(COMMUNITY, ada, STORE);
        expect(again.ok && again.value.keys.has(2)).toBe(true);
    });

    it('an admin added by a trusted admin’s signed share is trusted: their new key is taken, and the entries sealed again under it', async () => {
        const { node, owen, ada, k1, ids } = await community();
        const cy = await admin('Cy');
        node.admins.push({ pubkey: cy.publicKey, callsign: 'Cy', role: 'admin', holdsKey: false });
        node.wrapBy(owen, k1, cy.publicKey, 1); // Owen's phone shared with Cy; Ada's never saw it
        const k2 = newNamesListKey();
        node.wrapBy(cy, k2, cy.publicKey, 2, [owen.publicKey]);
        node.wrapBy(cy, k2, ada.publicKey, 2);
        const opened = await openNamesList(COMMUNITY, ada, STORE);
        expect(opened.ok && opened.value.plan.kind).toBe('ready');
        const reenc = sentAs('POST', '/api/names/entries/re-encrypt');
        expect(reenc).toHaveLength(1);
        for (const id of ids) expect(openNamesEntry(k2, id, 2, node.entries.find((e) => e.id === id)!.ciphertext).name).toBeTruthy();
        void k1;
        // Cy dropped Owen, signed: Ada's phone stops trusting Owen.
        expect((await pinOf(ada))?.trusted).not.toContain(owen.publicKey);
    });

    it('a removed admin, dropped by a trusted admin’s signed new key, signs nothing this phone takes', async () => {
        const { node, owen, ada, k1 } = await community();
        const abe = await admin('Abe');
        node.admins.push({ pubkey: abe.publicKey, callsign: 'Abe', role: 'admin', holdsKey: false });
        node.wrapBy(owen, k1, abe.publicKey, 1);
        expect((await openNamesList(COMMUNITY, owen, STORE)).ok).toBe(true);
        expect((await pinOf(owen))?.trusted).toContain(abe.publicKey);
        // Abe is removed; Ada's phone makes generation 2, naming him, and shares it with Owen.
        node.admins = node.admins.filter((a) => a.pubkey !== abe.publicKey);
        node.rows = node.rows.map((r) => (r.holder === abe.publicKey ? { ...r, live: false } : r));
        node.newKeyNeeded = true;
        node.droppedHolders = [abe.publicKey];
        sent = [];
        const adaOpens = await openNamesList(COMMUNITY, ada, STORE);
        expect(adaOpens.ok && adaOpens.value.plan.kind).toBe('ready');
        const made = JSON.parse(sentAs('POST', '/api/names/key')[0].body);
        expect(made.generation).toBe(2);
        expect(made.wraps[0].drops).toEqual([abe.publicKey]);
        const k2 = adaOpens.ok ? adaOpens.value.keys.get(2)! : new Uint8Array();
        node.wrapBy(ada, k2, owen.publicKey, 2);
        expect((await openNamesList(COMMUNITY, owen, STORE)).ok).toBe(true);
        expect((await pinOf(owen))?.trusted).not.toContain(abe.publicKey);
        // Abe, working with whoever runs the server, makes generation 3 for Owen: refused, nothing sent.
        const k3 = newNamesListKey();
        node.wrapBy(abe, k3, abe.publicKey, 3);
        node.wrapBy(abe, k3, owen.publicKey, 3);
        sent = [];
        const owenOpens = await openNamesList(COMMUNITY, owen, STORE);
        expect(owenOpens.ok && owenOpens.value.plan).toMatchObject({ kind: 'refused', refusal: { reason: 'untrusted', maker: abe.publicKey } });
        expect(sent.filter((s) => s.method !== 'GET')).toEqual([]);
    });

    it('a pin for another community: nothing is used, and nothing is changed', async () => {
        const { ada } = await community();
        mem.set(namesTrustStoreKey(ada.publicKey, COMMUNITY), JSON.stringify({ v: 1, communityId: 'ffffffffffffffff', trusted: [ada.publicKey] }));
        const opened = await openNamesList(COMMUNITY, ada, STORE);
        expect(opened.ok && opened.value.plan).toMatchObject({ kind: 'refused', refusal: { reason: 'other_community' } });
        expect(sent.map((s) => s.method)).toEqual(['GET']);
        expect((await pinOf(ada))?.communityId).toBe('ffffffffffffffff');
    });

    it('after an admin goes, the holder makes a new key for itself alone; every other admin waits for a Share tap', async () => {
        const [owen, ada, cy] = [await admin('Owen'), await admin('Ada'), await admin('Cy')];
        const node = new FakeNode();
        node.admins = [
            { pubkey: owen.publicKey, callsign: 'Owen', role: 'owner', holdsKey: false },
            // The node says Ada held the old key. It may be lying (its own key, named an admin): the phone wraps nothing to her.
            { pubkey: ada.publicKey, callsign: 'Ada', role: 'admin', holdsKey: false },
            { pubkey: cy.publicKey, callsign: 'Cy', role: 'admin', holdsKey: false },
        ];
        const k1 = newNamesListKey();
        node.wrapBy(owen, k1, owen.publicKey, 1);
        node.wrapBy(owen, k1, ada.publicKey, 1);
        node.newKeyNeeded = true;
        answer = (req) => node.answer(req);
        const opened = await openNamesList(COMMUNITY, owen, STORE);
        const body = JSON.parse(sentAs('POST', '/api/names/key')[0].body);
        expect(body.generation).toBe(2);
        expect(body.wraps.map((w: any) => w.holder)).toEqual([owen.publicKey]);
        expect(opened.ok && opened.value.notice).toBe(NAMES_COPY.newKeyMade);
        // Once the new key is in, Ada and Cy are both waiting. Ada's key this phone signed a share to before: Share. Cy's it
        // never checked: check in person first.
        expect(opened.ok && waitingAdmins(opened.value.state, owen.publicKey, opened.value.pin).map((a) => `${a.callsign}:${a.check}`)).toEqual(['Ada:trusted', 'Cy:check']);
        // Ada, who doesn't hold the current key, waits and is told who can make it.
        const adaPlan = keyPlan({ ...node.stateFor(ada.publicKey), newKeyNeeded: true }, ada.publicKey, traceFor(node.stateFor(ada.publicKey), ada, null), false);
        expect(adaPlan).toMatchObject({ kind: 'wait' });
        // Nothing in the module wraps the key to anyone the node names, but by a share.
        const src = fs.readFileSync(path.join(__dirname, '../names-list.ts'), 'utf8');
        expect(src.match(/wrapsFor\(/g)?.length).toBe(3);
        expect(src).toContain('wrapsFor(key, generation, [identity.publicKey], identity, state.communityId, drops)');
        expect(src).toContain('wrapsFor(key, state.generation, [admin.pubkey], identity, state.communityId)');
    });

    it('nobody holding the key: start again (the screen asks first); an admin who waits is told who to ask', async () => {
        const owen = await admin('Owen');
        const ada = await admin('Ada');
        const node = new FakeNode();
        node.admins = [{ pubkey: ada.publicKey, callsign: 'Ada', role: 'admin', holdsKey: false }, { pubkey: owen.publicKey, callsign: 'Owen', role: 'owner', holdsKey: false }];
        node.wrapBy(ada, newNamesListKey(), ada.publicKey, 3);
        node.rows[0].live = false;
        const st = node.stateFor(owen.publicKey);
        expect(keyPlan(st, owen.publicKey, traceFor(st, owen, null), false)).toEqual({ kind: 'start_again' });
        node.rows[0].live = true;
        const st2 = node.stateFor(owen.publicKey);
        const plan = keyPlan(st2, owen.publicKey, traceFor(st2, owen, null), false);
        expect(plan.kind === 'wait' && plan.holders.map((h) => h.callsign)).toEqual(['Ada']);
        const screen = fs.readFileSync(path.join(__dirname, '../../app/names-list.tsx'), 'utf8');
        // Start again is never done without the admin's yes.
        expect(screen.indexOf('Alert.alert(COPY.startAgainTitle')).toBeGreaterThan(-1);
        expect(screen.indexOf('Alert.alert(COPY.startAgainTitle')).toBeLessThan(screen.indexOf('installKeyFor(anchor, identity, state, plan, AsyncStorage)'));
    });

    it('SHARE NEVER TO A CALLSIGN ALONE: only to a key this phone checked in person; the wrap is signed and opens for that admin only', async () => {
        const [owen, cy] = [await admin('Owen'), await admin('Cy')];
        const node = new FakeNode();
        node.admins = [{ pubkey: owen.publicKey, callsign: 'Owen', role: 'owner', holdsKey: false }, { pubkey: cy.publicKey, callsign: 'Cy', role: 'admin', holdsKey: false }];
        const key = newNamesListKey();
        node.wrapBy(owen, key, owen.publicKey, 1);
        answer = (req) => node.answer(req);
        const opened = await openNamesList(COMMUNITY, owen, STORE);
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        const st = opened.value.state;
        const waiting = waitingAdmins(st, owen.publicKey, opened.value.pin);
        expect(waiting.map((a) => `${a.callsign}:${a.check}`)).toEqual(['Cy:check']);
        // The server names Cy by callsign: that alone shares nothing, and sends nothing.
        sent = [];
        const refused = await shareKeyWith(COMMUNITY, owen, st, key, waiting[0], STORE);
        expect(refused).toMatchObject({ ok: false, code: 'check_in_person' });
        expect(sent).toEqual([]);
        expect(node.rows.filter((r) => r.holder === cy.publicKey)).toEqual([]);
        // Owen scans the QR code on Cy's phone: it is the key the server lists for Cy, so this phone trusts it, and shares.
        expect(inPersonResult(myKeyCheck(cy).qr, cy.publicKey)).toBe('match');
        expect(await checkAdminInPerson(STORE, owen, COMMUNITY, st, waiting[0], myKeyCheck(cy).qr)).toEqual({ ok: true });
        expect(waitingAdmins(st, owen.publicKey, await pinOf(owen)).map((a) => a.check)).toEqual(['trusted']);
        await shareKeyWith(COMMUNITY, owen, st, key, waiting[0], STORE);
        expect(sent[0].url).toBe(`${COMMUNITY}/api/names/key/share`);
        expect(boundSignatureValid(sent[0], owen.publicKey)).toBe(true);
        const wrap = JSON.parse(sent[0].body).wraps[0];
        expect(wrap.holder).toBe(cy.publicKey);
        expect(verifyNamesWrap({ communityId: CID, generation: 1, holder: cy.publicKey, wrappedBy: owen.publicKey, wrapDigest: namesWrapDigest(wrap), drops: [] }, wrap.signature)).toBe(true);
        expect(Buffer.from(unwrapNamesListKey(wrap, cy.privateKey, cy.publicKey, 1)).equals(Buffer.from(key))).toBe(true);
        expect(() => unwrapNamesListKey(wrap, owen.privateKey, owen.publicKey, 1)).toThrow();
        // Owen's phone checked Cy: it trusts Cy from now on.
        expect((await pinOf(owen))?.trusted).toContain(cy.publicKey);
        const screen = fs.readFileSync(path.join(__dirname, '../../app/names-list.tsx'), 'utf8');
        const share = screen.slice(screen.indexOf('const share = '), screen.indexOf('const startCheck'));
        // The screen sends anyone it hasn't checked to the in-person check, and asks before sharing with the rest.
        expect(share.indexOf("if (admin.check !== 'trusted') { startCheck(admin, 'share'); return; }")).toBeGreaterThan(-1);
        expect(share.indexOf("startCheck(admin, 'share')")).toBeLessThan(share.indexOf('Alert.alert(COPY.shareTitle'));
        expect(share.indexOf('Alert.alert(COPY.shareTitle')).toBeLessThan(share.indexOf('shareKeyWith('));
        // A waiting row offers Share only for a key this phone trusts; any other gets "Check @X in person".
        expect(screen).toContain("{a.check === 'trusted'\n                                ? btn(`Share with @${a.callsign}`, () => share(a), 'small')\n                                : btn(COPY.checkButton(a.callsign), () => startCheck(a, 'share'), 'small')}");
        expect(NAMES_COPY.share('Cy')).toMatch(/This phone has checked @Cy’s key, in person/);
    });

    it("THE SECOND REVIEW'S RE-KEY: the owner password moves Ada's account to the operator's key; Owen's phone offers no Share until the real Ada is checked in person", async () => {
        const { node, owen, ada, ids } = await community();
        // Whoever runs the server re-keys Ada's account (the lost-phone routes) to a key it holds. The node drops Ada's
        // old key from the list (it is no admin now), and the list needs a new key.
        const op = await admin('Ada');
        node.admins = node.admins.map((a) => (a.pubkey === ada.publicKey ? { ...a, pubkey: op.publicKey } : a));
        node.rows = node.rows.map((r) => (r.holder === ada.publicKey ? { ...r, live: false } : r));
        node.newKeyNeeded = true;
        node.droppedHolders = [ada.publicKey];
        const opened = await openNamesList(COMMUNITY, owen, STORE);
        expect(opened.ok && opened.value.plan.kind).toBe('ready');
        if (!opened.ok) return;
        // Owen's phone made generation 2 for itself, naming Ada's old key as dropped, and says her key changed.
        const made = JSON.parse(sentAs('POST', '/api/names/key')[0].body);
        expect(made.generation).toBe(2);
        expect(made.wraps.map((w: any) => w.holder)).toEqual([owen.publicKey]);
        expect(made.wraps[0].drops).toEqual([ada.publicKey]);
        expect(opened.value.keyChanged).toEqual(['Ada']);
        expect(opened.value.notice).toContain(NAMES_COPY.keyChanged('Ada'));
        expect(NAMES_COPY.keyChanged('Ada')).toMatch(/^@Ada’s phone key changed: check it with @Ada in person before sharing/);
        // Her old key is dropped from Owen's pin for good, and the operator's key under her name is not trusted: no Share.
        const pin = await pinOf(owen);
        expect(pin?.trusted).not.toContain(ada.publicKey);
        expect(pin?.trusted).not.toContain(op.publicKey);
        const waiting = waitingAdmins(opened.value.state, owen.publicKey, opened.value.pin);
        expect(waiting.map((a) => `${a.callsign}:${a.check}`)).toEqual(['Ada:changed']);
        // The tap the review made: Share with "@Ada". It sends nothing; the operator gets no wrap and opens no name.
        sent = [];
        const tapped = await shareKeyWith(COMMUNITY, owen, opened.value.state, opened.value.keys.get(2)!, waiting[0], STORE);
        expect(tapped).toMatchObject({ ok: false, code: 'check_in_person' });
        expect(sent).toEqual([]);
        expect(node.rows.filter((r) => r.holder === op.publicKey)).toEqual([]);
        // Owen meets the real Ada and scans her phone: it shows her own key, not the one the server put her name on.
        expect(await checkAdminInPerson(STORE, owen, COMMUNITY, opened.value.state, waiting[0], myKeyCheck(ada).qr)).toEqual({ ok: false, reason: 'mismatch' });
        expect(NAMES_COPY.mismatch('Ada')).toMatch(/isn’t the key the server has for @Ada/);
        expect((await pinOf(owen))?.trusted).not.toContain(op.publicKey);
        // The owner puts her account on her real new phone. Owen checks that phone in person: then, and only then, Share.
        const adaNew = await admin('Ada');
        node.admins = node.admins.map((a) => (a.pubkey === op.publicKey ? { ...a, pubkey: adaNew.publicKey } : a));
        const again = await openNamesList(COMMUNITY, owen, STORE);
        if (!again.ok) throw new Error(again.message);
        const row = waitingAdmins(again.value.state, owen.publicKey, again.value.pin)[0];
        expect(`${row.callsign}:${row.check}`).toBe('Ada:changed');
        expect(await checkAdminInPerson(STORE, owen, COMMUNITY, again.value.state, row, myKeyCheck(adaNew).code)).toEqual({ ok: true });
        const checked = waitingAdmins(again.value.state, owen.publicKey, await pinOf(owen))[0];
        expect(checked.check).toBe('trusted');
        expect((await shareKeyWith(COMMUNITY, owen, again.value.state, again.value.keys.get(2)!, checked, STORE)).ok).toBe(true);
        // Ada's new phone opens the list, sealed again under generation 2, and is shown Owen's code to compare.
        const adaOpens = await openNamesList(COMMUNITY, adaNew, STORE);
        expect(adaOpens.ok && adaOpens.value.plan.kind).toBe('ready');
        expect(adaOpens.ok && adaOpens.value.notice).toContain(myKeyCheck(owen).code);
        expect(adaOpens.ok && openEntries(adaOpens.value.list!, adaOpens.value.keys).filter((e) => e.text).length).toBe(ids.length);
    });

    it("THE THIRD REVIEW'S REPLACED KEY: Ada's old key, after Owen's phone dropped it, vouches for a key of its own at an old generation; that key's new generation is refused and nothing is sealed under it", async () => {
        const { node, owen, ada, k1, ids } = await community();
        // Ada's phone makes generation 2 and shares it with Owen; the entries go under it; Owen's phone takes it.
        const k2 = newNamesListKey();
        node.wrapBy(ada, k2, ada.publicKey, 2);
        node.wrapBy(ada, k2, owen.publicKey, 2);
        for (const e of node.entries) { e.ciphertext = sealNamesEntry(k2, e.id, 2, openNamesEntry(k1, e.id, 1, e.ciphertext)); e.keyGeneration = 2; }
        expect((await openNamesList(COMMUNITY, owen, STORE)).ok).toBe(true);
        expect((await pinOf(owen))?.newest).toBe(2);
        // Ada loses her phone; the owner moves her account to her new one. Owen's phone makes generation 3, dropping the old key.
        const adaNew = await admin('Ada');
        node.admins = node.admins.map((a) => (a.pubkey === ada.publicKey ? { ...a, pubkey: adaNew.publicKey } : a));
        node.rows = node.rows.map((r) => (r.holder === ada.publicKey ? { ...r, live: false } : r));
        node.newKeyNeeded = true;
        node.droppedHolders = [ada.publicKey];
        const three = await openNamesList(COMMUNITY, owen, STORE);
        expect(three.ok && three.value.plan.kind).toBe('ready');
        expect(three.ok && three.value.keyChanged).toEqual(['Ada']);
        expect(node.entries.every((e) => e.keyGeneration === 3)).toBe(true);
        const pin3 = await pinOf(owen);
        expect(pin3?.replaced[ada.publicKey]?.at).toBe(2);
        expect(pin3?.dropped[ada.publicKey]).toBe(3);
        // Whoever holds the lost phone, with whoever runs the server: a share of generation 1, signed with the old key, to a
        // key of their own (made an admin), and then a generation 4 made by that key, for itself and Owen.
        const xan = await admin('Xan');
        node.admins.push({ pubkey: xan.publicKey, callsign: 'Xan', role: 'admin', holdsKey: false });
        node.wrapBy(ada, k1, xan.publicKey, 1);
        const k4 = newNamesListKey();
        node.wrapBy(xan, k4, xan.publicKey, 4, [ada.publicKey]);
        node.wrapBy(xan, k4, owen.publicKey, 4);
        sent = [];
        const four = await openNamesList(COMMUNITY, owen, STORE);
        expect(four.ok && four.value.plan).toMatchObject({ kind: 'refused', refusal: { reason: 'untrusted', maker: xan.publicKey } });
        // Nothing read, nothing sealed: only the state was asked for. Every entry stays under generation 3.
        expect(sent.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual(['GET /api/names/state']);
        expect(four.ok && four.value.keys.has(4)).toBe(false);
        for (const id of ids) {
            const e = node.entries.find((x) => x.id === id)!;
            expect(e.keyGeneration).toBe(3);
            expect(() => openNamesEntry(k4, id, 3, e.ciphertext)).toThrow();
        }
        expect((await pinOf(owen))?.trusted).not.toContain(xan.publicKey);
    });

    it("a replaced key counts only up to the newest generation this phone took, never the server's number: a generation 40 made with Ada's old key is refused", async () => {
        const { node, owen, ada, ids } = await community();
        expect((await pinOf(owen))?.newest).toBe(1);
        // Ada's account moves to a new key; at the same time, with her old key, whoever runs the server offers generation
        // 40, made by the old key and wrapped to Owen, as current.
        const adaNew = await admin('Ada');
        node.admins = node.admins.map((a) => (a.pubkey === ada.publicKey ? { ...a, pubkey: adaNew.publicKey } : a));
        node.rows = node.rows.map((r) => (r.holder === ada.publicKey ? { ...r, live: false } : r));
        const k40 = newNamesListKey();
        node.wrapBy(ada, k40, owen.publicKey, 40);
        sent = [];
        const opened = await openNamesList(COMMUNITY, owen, STORE);
        expect(opened.ok && opened.value.keyChanged).toEqual(['Ada']);
        for (const id of ids) expect(node.entries.find((x) => x.id === id)!.keyGeneration).toBe(1);
        expect(opened.ok && opened.value.plan).toMatchObject({ kind: 'refused', refusal: { reason: 'untrusted', maker: ada.publicKey } });
        expect(sent.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual(['GET /api/names/state']);
        expect((await pinOf(owen))?.replaced[ada.publicKey]?.at).toBe(1);
    });

    it('THE ROLLBACK: a server put back to generation 1 (whose key a removed admin kept) is refused; a new key on this phone is numbered past it', async () => {
        const { node, owen, ada, k1, ids } = await community();
        const abe = await admin('Abe');
        node.admins.push({ pubkey: abe.publicKey, callsign: 'Abe', role: 'admin', holdsKey: false });
        node.wrapBy(owen, k1, abe.publicKey, 1);
        // Abe is removed: Ada's phone makes generation 2, dropping him, and Owen's phone later makes 3.
        node.admins = node.admins.filter((a) => a.pubkey !== abe.publicKey);
        node.rows = node.rows.map((r) => (r.holder === abe.publicKey ? { ...r, live: false } : r));
        node.newKeyNeeded = true;
        node.droppedHolders = [abe.publicKey];
        const two = await openNamesList(COMMUNITY, ada, STORE);
        expect(two.ok && two.value.state.generation).toBe(2);
        const k2 = two.ok ? two.value.keys.get(2)! : new Uint8Array();
        node.wrapBy(ada, k2, owen.publicKey, 2);
        const k3 = newNamesListKey();
        node.wrapBy(owen, k3, owen.publicKey, 3);
        node.wrapBy(owen, k3, ada.publicKey, 3);
        for (const e of node.entries) { e.ciphertext = sealNamesEntry(k3, e.id, 3, openNamesEntry(k2, e.id, 2, e.ciphertext)); e.keyGeneration = 3; }
        expect((await openNamesList(COMMUNITY, ada, STORE)).ok).toBe(true);
        expect((await pinOf(ada))?.newest).toBe(3);
        // Whoever runs the server, with Abe, puts generation 1 back as it was: Abe's wrap live, the entries under key 1.
        node.rows = node.rows.filter((r) => r.generation === 1).map((r) => ({ ...r, live: true }));
        node.admins.push({ pubkey: abe.publicKey, callsign: 'Abe', role: 'admin', holdsKey: true });
        node.newKeyNeeded = false;
        node.droppedHolders = [];
        for (const e of node.entries) { e.ciphertext = sealNamesEntry(k1, e.id, 1, openNamesEntry(k3, e.id, 3, e.ciphertext)); e.keyGeneration = 1; }
        sent = [];
        const back = await openNamesList(COMMUNITY, ada, STORE);
        expect(back.ok && back.value.plan).toMatchObject({ kind: 'refused', refusal: { reason: 'rolled_back', offered: 1, newest: 3, canMakeNew: true } });
        expect(sent.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual(['GET /api/names/state']);
        expect(back.ok && NAMES_COPY.refused(back.value.plan.kind === 'refused' ? back.value.plan.refusal : (null as never), [])).toMatch(/older key of the list \(number 1\) than this phone already took \(number 3\)/);
        // Abe stays out, and nothing would be shared with him.
        expect((await pinOf(ada))?.trusted).not.toContain(abe.publicKey);
        // Ada chooses a new key on this phone (the screen asks first): number 4, past what she took, naming Abe as dropped.
        if (!back.ok || back.value.plan.kind !== 'refused') return;
        const made = await installKeyFor(COMMUNITY, ada, back.value.state, back.value.plan, STORE);
        expect(made.ok && made.value.generation).toBe(4);
        expect(JSON.parse(sentAs('POST', '/api/names/key')[0].body).wraps[0].drops).toEqual([abe.publicKey]);
        const after = await openNamesList(COMMUNITY, ada, STORE);
        expect(after.ok && after.value.plan.kind).toBe('ready');
        for (const id of ids) {
            const e = node.entries.find((x) => x.id === id)!;
            expect(e.keyGeneration).toBe(4);
            expect(() => openNamesEntry(k1, id, 4, e.ciphertext)).toThrow();
        }
        const screen = fs.readFileSync(path.join(__dirname, '../../app/names-list.tsx'), 'utf8');
        const make = screen.slice(screen.indexOf('const makeNewKey'), screen.indexOf('const openForm'));
        expect(make.indexOf('Alert.alert(COPY.makeNewTitle')).toBeLessThan(make.indexOf('installKeyFor('));
    });

    it('the only key-holder, out and made an admin again, starts a new key without naming itself as dropped', async () => {
        const ada = await admin('Ada');
        const node = new FakeNode();
        node.admins = [{ pubkey: ada.publicKey, callsign: 'Ada', role: 'admin', holdsKey: false }];
        answer = (req) => node.answer(req);
        expect((await openNamesList(COMMUNITY, ada, STORE)).ok).toBe(true);
        // Moved to moderator and back: the node cleared her wrap, so nobody holds the key, and it lists her as dropped.
        node.rows = node.rows.map((r) => ({ ...r, live: false }));
        node.droppedHolders = [ada.publicKey];
        const opened = await openNamesList(COMMUNITY, ada, STORE);
        expect(opened.ok && opened.value.plan).toEqual({ kind: 'start_again' });
        if (!opened.ok) return;
        sent = [];
        const made = await installKeyFor(COMMUNITY, ada, opened.value.state, opened.value.plan, STORE);
        expect(made.ok && made.value.generation).toBe(2);
        expect(JSON.parse(sentAs('POST', '/api/names/key')[0].body).wraps[0].drops).toEqual([]);
    });
});

describe('entries: sealed before they leave the phone', () => {
    it('add and edit send sealed text only, signed, under the current generation', async () => {
        const owen = await admin('Owen');
        const key = newNamesListKey();
        const sealed = sealedFor(key, 4, { name: `  ${PLANTED[0]} `, note: PLANTED[1] });
        expect(sealed.ok).toBe(true);
        if (!sealed.ok) return;
        answer = () => ({ status: 201, body: { id: sealed.id } });
        await addNamesEntry(COMMUNITY, owen, 4, sealed);
        answer = () => ({ status: 200, body: { id: sealed.id } });
        await editNamesEntry(COMMUNITY, owen, 4, sealed);
        expect(sent.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual(['POST /api/names/entries', `PUT /api/names/entries/${sealed.id}`]);
        for (const s of sent) {
            expect(boundSignatureValid(s, owen.publicKey)).toBe(true);
            expect(nothingReadable(s)).toBe(true);
            expect(JSON.parse(s.body).keyGeneration).toBe(4);
        }
        expect(openNamesEntry(key, sealed.id, 4, JSON.parse(sent[0].body).ciphertext)).toEqual({ name: PLANTED[0], note: PLANTED[1] });
        expect(sealedFor(key, 4, { name: ' ', note: '' })).toEqual({ ok: false, error: 'Write the person’s name.' });
    });

    it('opens each entry with its own generation’s key; one it can’t is locked, never guessed', () => {
        const k1 = newNamesListKey();
        const k2 = newNamesListKey();
        const [a, b, c, d] = [newNamesEntryId(), newNamesEntryId(), newNamesEntryId(), newNamesEntryId()];
        const list: NamesListBody = {
            generation: 2,
            entries: [
                { id: a, ciphertext: sealNamesEntry(k2, a, 2, { name: 'Zoe', note: '' }), keyGeneration: 2, createdBy: 'x', createdAt: '2026-10-01', updatedBy: null, updatedAt: '' },
                { id: b, ciphertext: sealNamesEntry(k1, b, 1, { name: 'Abe', note: 'n' }), keyGeneration: 1, createdBy: 'x', createdAt: '2026-10-01', updatedBy: null, updatedAt: '' },
                { id: c, ciphertext: sealNamesEntry(newNamesListKey(), c, 2, { name: 'Tampered', note: '' }), keyGeneration: 2, createdBy: 'x', createdAt: '2026-10-01', updatedBy: null, updatedAt: '' },
                { id: d, ciphertext: sealNamesEntry(newNamesListKey(), d, 7, { name: 'Unknown', note: '' }), keyGeneration: 7, createdBy: 'x', createdAt: '2026-10-02', updatedBy: null, updatedAt: '' },
            ],
            confirmations: [{ id: 'c1', memberPubkey: 'm', callsign: 'Mel', entryId: b, confirmedBy: 'x', confirmedAt: '', needsSecond: false, secondedBy: null, secondedAt: null, revokedBy: null, revokedAt: null, revokeReason: null, status: 'confirmed' }],
        };
        const opened = openEntries(list, new Map([[1, k1], [2, k2]]));
        expect(opened.map((e) => e.text?.name ?? e.locked)).toEqual(['Abe', 'Zoe', 'did_not_open', 'no_key']);
        expect(opened[0].confirmation?.callsign).toBe('Mel');
        expect(filterEntries(opened, 'zo').map((e) => e.text?.name)).toEqual(['Zoe']);
        expect(filterEntries(opened, '  ')).toHaveLength(4);
    });

    it('after a new key, the older entries it can open go back sealed under it, a batch at a time', async () => {
        const owen = await admin('Owen');
        const k1 = newNamesListKey();
        const k2 = newNamesListKey();
        const n = NAMES_LIMITS.batch + 3;
        const entries = Array.from({ length: n }, (_, i) => {
            const id = newNamesEntryId();
            return { id, ciphertext: sealNamesEntry(k1, id, 1, { name: `${PLANTED[0]} ${i}`, note: '' }), keyGeneration: 1, createdBy: 'x', createdAt: '', updatedBy: null, updatedAt: '' };
        });
        const batches = reEncryptBatches({ generation: 2, entries, confirmations: [] }, new Map([[1, k1], [2, k2]]), 2);
        expect(batches.map((b) => b.length)).toEqual([NAMES_LIMITS.batch, 3]);
        expect(openNamesEntry(k2, batches[0][0].id, 2, batches[0][0].ciphertext).name).toBe(`${PLANTED[0]} 0`);
        expect(reEncryptBatches({ generation: 2, entries, confirmations: [] }, new Map([[2, k2]]), 2)).toEqual([]);
        answer = (req) => ({ status: 200, body: { done: JSON.parse(req.body).entries.length, left: 0 } });
        const done = await sendReEncrypted(COMMUNITY, owen, 2, batches);
        expect(done).toEqual({ ok: true, value: { done: n } });
        expect(sent.every((s) => boundSignatureValid(s, owen.publicKey) && nothingReadable(s))).toBe(true);
    });
});

describe('reads and refusals', () => {
    it('the export is fetched as an export (the node logs it), and the PDF is made from that fetch', async () => {
        const owen = await admin('Owen');
        answer = () => ({ status: 200, body: { generation: 1, entries: [], confirmations: [] } });
        await fetchNamesList(COMMUNITY, owen, true);
        expect(sent[0].url).toBe(`${COMMUNITY}/api/names/entries?for=export`);
        expect(boundSignatureValid(sent[0], owen.publicKey)).toBe(true);
        const screen = fs.readFileSync(path.join(__dirname, '../../app/names-list.tsx'), 'utf8');
        const exp = screen.slice(screen.indexOf('const exportPdf'), screen.indexOf('const setTwoAdmins'));
        expect(exp.indexOf('Alert.alert(COPY.exportTitle')).toBeLessThan(exp.indexOf('fetchNamesList(anchor, identity, true)'));
        expect(exp.indexOf('fetchNamesList(anchor, identity, true)')).toBeLessThan(exp.indexOf('printToFileAsync'));
        expect(exp).toContain('openEntries(fresh.value, keys)');
        expect(exp).toContain('deleteAsync(uri');
    });

    it("a refusal comes back in the node's words with its code; no answer is said plainly", async () => {
        const mel = await admin('Mel');
        answer = () => ({ status: 403, body: { error: 'Only the community’s owners and admins can open the names list.', code: 'admins_only' } });
        expect(await fetchNamesState(COMMUNITY, mel)).toEqual({ ok: false, status: 403, code: 'admins_only', message: 'Only the community’s owners and admins can open the names list.' });
        (globalThis as any).fetch = vi.fn(async () => { throw new Error('offline'); });
        const r = await confirmMember(COMMUNITY, mel, 'a'.repeat(64), newNamesEntryId());
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.message).toMatch(/Couldn't reach your community/);
    });

    it('a delete is a signed DELETE with no body', async () => {
        const owen = await admin('Owen');
        const id = newNamesEntryId();
        answer = () => ({ status: 200, body: { id } });
        await deleteNamesEntry(COMMUNITY, owen, id);
        expect(sent[0].method).toBe('DELETE');
        expect(sent[0].body).toBe('');
        expect(boundSignatureValid(sent[0], owen.publicKey)).toBe(true);
    });
});

describe('confirming, in words', () => {
    const row = (over: Partial<ConfirmationRow>): ConfirmationRow => ({
        id: 'c', memberPubkey: 'c'.repeat(64), callsign: 'Mel', entryId: 'e', confirmedBy: 'a'.repeat(64), confirmedAt: '2026-10-01T00:00:00Z',
        needsSecond: false, secondedBy: null, secondedAt: null, revokedBy: null, revokedAt: null, revokeReason: null, status: 'confirmed', ...over,
    });

    it('who can be confirmed: members without a live confirmation; yourself only as the only admin', () => {
        const me = 'a'.repeat(64);
        const members = [{ publicKey: me, callsign: 'Ada' }, { publicKey: 'b'.repeat(64), callsign: 'bo' }, { publicKey: 'c'.repeat(64), callsign: 'Mel' }, { publicKey: 'not-a-key', callsign: 'X' }];
        const list: NamesListBody = { generation: 1, entries: [], confirmations: [row({})] };
        expect(confirmableMembers(members, list, me, 2).map((m) => m.callsign)).toEqual(['bo']);
        expect(confirmableMembers(members, list, me, 1).map((m) => m.callsign)).toEqual(['Ada', 'bo']);
        expect(confirmableMembers(members, { ...list, confirmations: [row({ status: 'revoked', revokedAt: 'x' })] }, me, 2).map((m) => m.callsign)).toEqual(['bo', 'Mel']);
    });

    it('a second admin, not the first, seconds; any admin revokes a live one; a revoked one does nothing', () => {
        const first = 'a'.repeat(64);
        const waiting = row({ needsSecond: true, status: 'awaiting_second', confirmedBy: first });
        expect(confirmationActions(waiting, first)).toEqual({ second: false, revoke: true });
        expect(confirmationActions(waiting, 'b'.repeat(64))).toEqual({ second: true, revoke: true });
        expect(confirmationActions(waiting, waiting.memberPubkey)).toEqual({ second: false, revoke: true });
        expect(confirmationActions(row({ status: 'revoked', revokedAt: 'x' }), first)).toEqual({ second: false, revoke: false });
        const nameOf = (pk: string) => (pk === first ? '@Ada' : '@Bo');
        expect(confirmationLine(waiting, nameOf)).toMatch(/^@Mel: confirmed by @Ada .*waiting for a second admin$/);
        expect(confirmationLine(row({ secondedBy: 'b'.repeat(64), secondedAt: 'x' }), nameOf)).toMatch(/^@Mel: confirmed by @Ada and @Bo/);
        expect(confirmationLine(waiting, nameOf)).not.toMatch(/Newcomer|Resident|Steward|Elder|tier/i);
    });

    it('the access log says who did what', () => {
        const nameOf = () => 'an admin';
        expect(logLineText({ id: '1', actor: 'x', actorCallsign: 'Owen', action: 'export', entryId: null, subject: null, subjectCallsign: null, at: '2026-10-01T00:00:00Z' }, nameOf))
            .toMatch(/^@Owen exported the list · /);
        expect(logLineText({ id: '2', actor: 'node', actorCallsign: null, action: 'holder_dropped', entryId: null, subject: 'y', subjectCallsign: 'Abe', at: '2026-10-01T00:00:00Z' }, nameOf))
            .toMatch(/^@Abe no longer holds the key/);
        expect(logLineText({ id: '3', actor: 'x', actorCallsign: 'Ada', action: 'confirm', entryId: 'e', subject: 'm', subjectCallsign: 'Mel', at: '' }, nameOf))
            .toBe('@Ada confirmed @Mel · ');
    });
});

describe('the PDF page', () => {
    it('escapes every value, counts the locked entries, and never shows one', () => {
        const html = namesListHtml({
            communityName: 'Mullum <LETS>', exportedBy: '@Owen', at: new Date('2026-10-01T00:00:00Z'),
            entries: [
                { id: 'a', generation: 1, createdAt: '', updatedAt: '', text: { name: '<script>alert(1)</script>Bob', note: 'line one\nline "two"' }, locked: null, confirmation: null },
                { id: 'b', generation: 1, createdAt: '', updatedAt: '', text: null, locked: 'no_key', confirmation: null },
            ],
        });
        expect(html).not.toContain('<script>alert');
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;Bob');
        expect(html).toContain('line one<br>line &quot;two&quot;');
        expect(html).toContain('Mullum &lt;LETS&gt;: names list');
        expect(html).toContain('1 entry, and 1 this phone couldn’t open');
        expect(html).toMatch(/Keep this page as safe as a paper list/);
    });
});

// ── Small screens and both themes: the rules the styles are held to (no device renderer in this runner) ──

function luminance(hex: string): number {
    const m = hex.replace('#', '');
    const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m.slice(0, 6);
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
}

describe.each([['light', lightColors], ['dark', darkColors]] as const)('the names list styles in %s', (_name, colors) => {
    const spec = namesListStyleSpec(colors as typeof lightColors) as Record<string, Record<string, unknown>>;

    it('every touch target is at least 48dp tall', () => {
        for (const k of NAMES_TOUCH_TARGETS) expect(Number(spec[k].minHeight), k).toBeGreaterThanOrEqual(48);
    });
    it('nothing has a fixed width or height, so text wraps and boxes grow at 320dp and 1.3× text', () => {
        for (const [k, v] of Object.entries(spec)) {
            expect(v.width, `${k}.width`).toBeUndefined();
            expect(v.height, `${k}.height`).toBeUndefined();
            expect(v.maxHeight, `${k}.maxHeight`).toBeUndefined();
        }
    });
    it('rows of buttons wrap rather than squeeze: two fit side by side at 320dp less the padding, and stack when they grow', () => {
        expect(spec.buttonRow.flexWrap).toBe('wrap');
        expect(Number(spec.primaryBtn.flexBasis) * 2 + Number(spec.buttonRow.gap)).toBeLessThanOrEqual(320 - 2 * Number(spec.scroll.padding));
        for (const k of ['primaryBtn', 'secondaryBtn', 'dangerBtn', 'smallBtn']) expect(spec[k].flexGrow, k).toBe(1);
    });
    it('this phone’s QR code fits its card at 320dp, on white in both themes; the camera is square with no fixed size', () => {
        const screen = fs.readFileSync(path.join(__dirname, '../../app/names-list.tsx'), 'utf8');
        const qr = screen.match(/<QRCode value=\{mine\.qr\} size=\{(\d+)\} quietZone=\{(\d+)\}/);
        expect(qr).not.toBeNull();
        const drawn = Number(qr![1]) + 2 * Number(qr![2]) + 2 * Number(spec.qrBox.padding);
        const room = 320 - 2 * Number(spec.scroll.padding) - 2 * Number(spec.keyCard.padding) - 2 * Number(spec.keyCard.borderWidth);
        expect(drawn).toBeLessThanOrEqual(room);
        expect(spec.qrBox.backgroundColor).toBe('#ffffff');
        expect(spec.camera.aspectRatio).toBe(1);
    });
    it('text is readable on its background (WCAG AA, 4.5:1)', () => {
        for (const [text, bg] of Object.entries(NAMES_TEXT_ON)) {
            const fg = String(spec[text].color);
            const back = String(spec[bg].backgroundColor);
            expect(fg.startsWith('#') && back.startsWith('#'), `${text} on ${bg}: ${fg} / ${back}`).toBe(true);
            expect(contrast(fg, back), `${text} (${fg}) on ${bg} (${back})`).toBeGreaterThanOrEqual(4.5);
        }
    });
});

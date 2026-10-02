/**
 * The names list on an admin's phone (utils/names-list.ts, app/names-list.tsx; the server is apps/server/src/routes/
 * names-list.ts, tested over HTTPS by test-names-list.ts and test-standby-names-list.ts; the trust model is
 * scratch/global-node/DESIGN-names-list-trust-fable.md, whose §10 matrix names each case here).
 *
 * Nothing here contacts a node. The `fetch` stub plays the admins' community (FakeNode): it keeps the key history, the
 * shares and the entries by the same rules the server's routes do, checks every request as the node's middleware does
 * (signed by the admin's own key, for that host), and can show each phone something different, as a hostile server
 * would. Each phone runs the app's real functions end to end: openNamesList and the asked actions. What the phone sends
 * is recorded and checked for the planted names: nothing readable leaves the phone. The keys and boxes are real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))),
}));
const mem = vi.hoisted(() => new Map<string, string>());
const secrets = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.delete(key); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(async (key: string) => secrets.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { secrets.set(key, value); }),
}));

import { getPublicKey } from '@noble/ed25519';
import {
    newNamesListKey, sealNamesEntry, openNamesEntry, newNamesEntryId, makeNamesGeneration, makeNamesShare, readNamesGeneration,
    readNamesShare, namesKeyQr, namesKeyCode, namesListKeyCode, namesBoxDigest, namesShareHeader, sealNamesRing, NAMES_REFUSAL_REASONS, toEd25519Pkcs8,
    type NamesGeneration, type NamesShare,
} from '@beanpool/core';
import { bytesToHex } from '../crypto';
import { boundSignatureValid } from './server-signature-check';
import { lightColors, darkColors } from '../../constants/colors';
import {
    writeNamesPinTo, offersNamesList, openNamesList, checkEachOther, removeOldKey, putHistoryBack, makeKeyOnThisPhone, takeHistoryOf, sendKeysAgain,
    readNamesPinFrom, namesTrustStoreKey, namesPinSecretName, openEntries, filterEntries, saveNamesEntry, fetchNamesList, fetchNamesState,
    confirmMember, deleteNamesEntry, confirmableMembers, confirmationActions, confirmationLine, logLineText, namesListHtml, myKeyCheck,
    planWords, newEntryId, listKeyOf, NAMES_COPY, DEVICE_NAMES_STORE,
    type NamesState, type NamesListBody, type ConfirmationRow, type SealedEntryRow, type NamesPinStore, type NamesOpened, type OpenedEntry,
} from '../names-list';
import { NAMES_TEXT_ON, NAMES_TOUCH_TARGETS, namesListStyleSpec } from '../names-list-style';
import type { BeanPoolIdentity } from '../identity';

const COMMUNITY = 'https://mullum.beanpool.org';
const CID = 'a1b2c3d4e5f60718';
const PLANTED = ['Zebedee Quillfeather', 'Lives by the old cannery', 'Ottoline Brackenbury'];

async function admin(callsign: string, pkcs8 = false): Promise<BeanPoolIdentity> {
    const seed = new Uint8Array(randomBytes(32));
    const pub = bytesToHex(await getPublicKey(seed));
    return { publicKey: pub, privateKey: bytesToHex(pkcs8 ? toEd25519Pkcs8(seed) : seed), callsign } as BeanPoolIdentity;
}

interface Sent { url: string; method: string; headers: Record<string, string>; body: string }
let sent: Sent[] = [];
let answer: (req: Sent) => { status: number; body?: unknown } = () => ({ status: 500 });
/** Set to make the next matching request fail as a dropped connection, before (`lost: false`) or after the node acts. */
let drop: ((req: Sent) => 'before' | 'after' | null) | null = null;

const STORE: NamesPinStore = {
    getItem: async (k) => mem.get(k) ?? null, setItem: async (k, v) => { mem.set(k, v); },
    getSecret: async (k) => secrets.get(k) ?? null, setSecret: async (k, v) => { secrets.set(k, v); },
};

beforeEach(() => {
    mem.clear();
    secrets.clear();
    sent = [];
    drop = null;
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
        const req = { url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body ?? '' };
        sent.push(req);
        const when = drop?.(req) ?? null;
        if (when === 'before') throw new Error('offline');
        const a = answer(req);
        if (when === 'after') throw new Error('the answer was lost');
        return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => { if (a.body === undefined) throw new Error('no body'); return a.body; } };
    });
});

const nothingReadable = (s: Sent) => PLANTED.every((p) => !s.body.toLowerCase().includes(p.toLowerCase()));
const sentAs = (method: string, p: string) => sent.filter((s) => s.method === method && new URL(s.url).pathname === p);
/** "Nothing read or written": the only request was the state, and no request carried a sealed entry. */
const onlyStateRead = () => sent.every((s) => s.method === 'GET' && new URL(s.url).pathname === '/api/names/state');

type Admin = { pubkey: string; callsign: string; role: 'owner' | 'admin' };
/** What the node shows one phone instead; `quiet` hides that a holder of the current key was marked as no admin. */
type View = Partial<{ admins: Admin[]; hide: string[]; current: string | null; communityId: string; extraShares: NamesShare[]; quiet: boolean }>;

/**
 * A community's node as the phones see it: the key history, the shares, the entries, the admins, by the same rules as
 * apps/server engine/names-list.ts. `views` shows a phone something else.
 */
class FakeNode {
    gens = new Map<string, NamesGeneration>();
    shares = new Map<string, NamesShare>();
    entries: SealedEntryRow[] = [];
    admins: Admin[] = [];
    marks = new Set<string>();
    log: { actor: string; action: string; subject: string | null }[] = [];
    views = new Map<string, View>();
    /** The names keys went by before a re-key (the server follows rekey_audit_log to the member's callsign). */
    former: Record<string, string> = {};
    /** Called before each request is answered: lets a test make something land first. */
    onRequest: ((req: Sent) => void) | null = null;
    /** Set when the node makes one branch of a fork its current (then each statement it takes moves it on). */
    head: string | null = null;
    current(): NamesGeneration | null {
        if (this.head) return this.gens.get(this.head) ?? null;
        return [...this.gens.values()].sort((a, b) => b.n - a.n)[0] ?? null;
    }
    holdersOf(id: string): Set<string> {
        const out = new Set<string>();
        const g = this.gens.get(id);
        if (g) out.add(g.maker);
        for (const s of this.shares.values()) if (s.keyIds.includes(id)) { out.add(s.from); out.add(s.to); }
        for (const m of this.marks) if (m.endsWith(`|${id}`)) out.delete(m.split('|')[0]);
        return out;
    }
    keyIdsOf(pk: string): string[] {
        return [...this.gens.keys()].filter((id) => this.holdersOf(id).has(pk)).sort();
    }
    reconcile(): void {
        const cur = this.current();
        if (!cur) return;
        const admins = new Set(this.admins.map((a) => a.pubkey));
        for (const h of this.holdersOf(cur.id)) {
            if (!admins.has(h) && !this.marks.has(`${h}|${cur.id}`)) {
                this.marks.add(`${h}|${cur.id}`);
                this.log.push({ actor: 'node', action: 'holder_dropped', subject: h });
            }
        }
    }
    isAdmin(pk: string) { return this.admins.some((a) => a.pubkey === pk); }
    stateFor(me: string): NamesState {
        const v = this.views.get(me) ?? {};
        const admins = v.admins ?? this.admins;
        const gens = [...this.gens.values()].filter((g) => !(v.hide ?? []).includes(g.id)).sort((a, b) => a.n - b.n);
        const cur = v.current !== undefined ? (v.current ? this.gens.get(v.current) ?? null : null) : this.current();
        const holders = cur ? this.holdersOf(cur.id) : new Set<string>();
        const holdersOfCurrent = admins.map((a) => a.pubkey).filter((k) => holders.has(k));
        const byKey: Record<string, number> = {};
        for (const e of this.entries) byKey[e.keyId] = (byKey[e.keyId] ?? 0) + 1;
        const meRow = admins.find((a) => a.pubkey === me);
        return {
            communityId: v.communityId ?? CID,
            current: cur ? { id: cur.id, n: cur.n } : null,
            generations: gens.map((g) => ({ statement: g.statement, signature: g.signature, id: g.id, n: g.n, parentId: g.parentId, maker: g.maker, drops: g.drops })),
            shares: [...this.shares.values(), ...(v.extraShares ?? [])].map((s) => ({ header: s.header, signature: s.signature, from: s.from, to: s.to, headId: s.headId, keyIds: s.keyIds, trusts: s.trusts, ...(s.to === me && s.box ? { box: s.box } : {}) })),
            admins: admins.map((a) => ({ ...a, keyIds: this.keyIdsOf(a.pubkey), holdsCurrent: holders.has(a.pubkey) })),
            holdersOfCurrent,
            droppedHolders: cur && !v.quiet ? [...this.marks].filter((m) => m.endsWith(`|${cur.id}`)).map((m) => m.split('|')[0]) : [],
            nobodyHoldsKey: !!cur && holdersOfCurrent.length === 0,
            newKeyNeeded: !!cur && !v.quiet && [...this.marks].some((m) => m.endsWith(`|${cur.id}`)),
            callsigns: { ...this.former, ...Object.fromEntries(this.admins.map((a) => [a.pubkey, a.callsign])) },
            settings: { twoAdminsToConfirm: false, namesShownToMembers: false },
            counts: { entries: this.entries.length, confirmed: 0, awaitingSecond: 0, byKey, locked: 0 },
            me: { pubkey: me, role: meRow?.role ?? null, owner: meRow?.role === 'owner' },
        };
    }
    put(g: NamesGeneration): void { this.gens.set(g.id, g); }
    add(key: Uint8Array, keyId: string, name: string, by = 'x'): string {
        const id = newNamesEntryId();
        this.entries.push({ id, ciphertext: sealNamesEntry(key, id, keyId, { name, note: '' }), keyId, createdBy: by, createdAt: '2026-10-01', updatedBy: null, updatedAt: '' });
        return id;
    }
    answer(req: Sent): { status: number; body?: unknown } {
        const who = req.headers['X-Public-Key'];
        if (!who || !boundSignatureValid(req, who)) return { status: 401, body: { error: 'unsigned', code: 'unsigned' } };
        if (!this.isAdmin(who)) return { status: 403, body: { error: 'Only the community’s owners and admins can open the names list.', code: 'admins_only' } };
        this.onRequest?.(req);
        this.reconcile();
        const { pathname } = new URL(req.url);
        const body = req.body ? JSON.parse(req.body) : {};
        const err = (status: number, code: string) => ({ status, body: { error: code, code } });
        if (req.method === 'GET' && pathname === '/api/names/state') return { status: 200, body: this.stateFor(who) };
        if (req.method === 'GET' && pathname === '/api/names/entries') return { status: 200, body: { current: this.current()?.id ?? null, entries: this.entries, confirmations: [] } };
        if (req.method === 'GET' && pathname === '/api/names/log') return { status: 200, body: { log: [], total: 0 } };
        if (req.method === 'POST' && pathname === '/api/names/generations') {
            const g = readNamesGeneration(body, CID);
            if (!g) return err(400, 'bad_signature');
            if (this.gens.has(g.id)) return { status: 200, body: { id: g.id, n: g.n, code: 'exists' } };
            const cur = this.current();
            if ((g.parentId ?? null) !== (cur?.id ?? null) || g.n !== (cur ? cur.n + 1 : 1)) return err(409, 'stale');
            if (g.maker === who && body.replay !== true && cur) {
                const holders = [...this.holdersOf(cur.id)].filter((k) => this.isAdmin(k));
                if (holders.length && !holders.includes(who)) return err(409, 'ask_for_share');
            }
            this.gens.set(g.id, g);
            if (this.head) this.head = g.id;
            this.log.push({ actor: who, action: cur ? 'key_changed' : 'key_made', subject: null });
            return { status: 201, body: { id: g.id, n: g.n } };
        }
        if (req.method === 'POST' && pathname === '/api/names/shares') {
            const s = readNamesShare(body, CID);
            if (!s || s.from !== who) return err(400, 'bad_signature');
            if (!s.box) return err(400, 'bad_box');
            if (!this.isAdmin(s.to)) return err(400, 'not_admin');
            if (!this.gens.has(s.headId) || s.keyIds.some((id) => !this.gens.has(id))) return err(400, 'unknown_key');
            this.shares.set(`${s.from}|${s.to}`, s);
            this.log.push({ actor: who, action: 'key_shared', subject: s.to });
            return { status: 200, body: { to: s.to } };
        }
        if ((req.method === 'POST' && pathname === '/api/names/entries') || (req.method === 'PUT' && pathname.startsWith('/api/names/entries/'))) {
            const cur = this.current();
            if (!cur) return err(409, 'no_list_key');
            if ([...this.marks].some((m) => m.endsWith(`|${cur.id}`))) return err(409, 'new_key_first');
            if (body.keyId !== cur.id) return err(409, 'stale_key');
            if (!this.holdersOf(cur.id).has(who)) return err(403, 'no_key');
            const id = req.method === 'POST' ? body.id : pathname.split('/').pop()!;
            const row = this.entries.find((e) => e.id === id);
            if (req.method === 'POST') {
                if (row) return err(409, 'entry_exists');
                this.entries.push({ id, ciphertext: body.ciphertext, keyId: body.keyId, createdBy: who, createdAt: new Date().toISOString(), updatedBy: who, updatedAt: '' });
                return { status: 201, body: { id } };
            }
            if (!row) return err(404, 'no_entry');
            row.ciphertext = body.ciphertext;
            row.keyId = body.keyId;
            return { status: 200, body: { id } };
        }
        return err(404, 'not_found');
    }
}

/** What a phone holds, read back from its sealed pin. */
const pinOf = (me: BeanPoolIdentity) => readNamesPinFrom(STORE, me.publicKey, COMMUNITY);
const open = async (me: BeanPoolIdentity): Promise<NamesOpened> => {
    const r = await openNamesList(COMMUNITY, me, STORE);
    if (!r.ok) throw new Error(`${me.callsign}'s open: ${r.status} ${r.code} ${r.message}`);
    return r.value;
};
const meet = async (node: FakeNode, a: BeanPoolIdentity, b: BeanPoolIdentity) => {
    for (const [x, y] of [[a, b], [b, a]] as const) {
        const r = await checkEachOther(STORE, x, COMMUNITY, node.stateFor(x.publicKey), namesKeyQr(y.publicKey));
        expect(r.ok).toBe(true);
    }
};
const keyOf = async (me: BeanPoolIdentity, id: string) => Uint8Array.from(Buffer.from((await pinOf(me))!.ring[id], 'hex'));
const role = (who: BeanPoolIdentity, r: 'owner' | 'admin' = 'admin'): Admin => ({ pubkey: who.publicKey, callsign: who.callsign, role: r });
/** The owner moves `from`'s account to a new key: its old key is no admin now, and goes by the same name. */
async function rekey(node: FakeNode, from: BeanPoolIdentity): Promise<BeanPoolIdentity> {
    const to = await admin(from.callsign);
    node.former[from.publicKey] = from.callsign;
    node.admins = node.admins.map((a) => (a.pubkey === from.publicKey ? { ...a, pubkey: to.publicKey } : a));
    return to;
}

/** Owen makes the list's first key; he and Ada meet; both phones open; both hold key 1 and read two planted names. */
async function community(names = ['Owen', 'Ada']): Promise<{ node: FakeNode; phones: BeanPoolIdentity[]; k1: string }> {
    const phones = await Promise.all(names.map((n) => admin(n)));
    const node = new FakeNode();
    node.admins = phones.map((p, i) => role(p, i === 0 ? 'owner' : 'admin'));
    answer = (req) => node.answer(req);
    expect((await open(phones[0])).plan.kind).toBe('ready');
    for (const p of phones.slice(1)) await meet(node, phones[0], p);
    for (let i = 0; i < 2; i++) for (const p of phones) await openNamesList(COMMUNITY, p, STORE);
    for (const p of phones) expect((await open(p)).plan.kind).toBe('ready');
    const k1 = node.current()!.id;
    const key = await keyOf(phones[0], k1);
    node.add(key, k1, PLANTED[0]);
    node.add(key, k1, PLANTED[1]);
    sent = [];
    return { node, phones, k1 };
}

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

describe('the first key, the pin at rest, and the open', () => {
    it('the first admin makes the first generation without asking, signed by their key, written ahead; it lands; the key is theirs alone', async () => {
        const owen = await admin('Owen');
        const node = new FakeNode();
        node.admins = [role(owen, 'owner')];
        answer = (req) => node.answer(req);
        const o = await open(owen);
        expect(o.plan.kind).toBe('ready');
        const gen = sentAs('POST', '/api/names/generations')[0];
        expect(boundSignatureValid(gen, owen.publicKey)).toBe(true);
        const g = readNamesGeneration(JSON.parse(gen.body), CID)!;
        expect(g).toMatchObject({ n: 1, parentId: null, maker: owen.publicKey, drops: [] });
        const pin = (await pinOf(owen))!;
        expect(pin.chain.map((l) => l.id)).toEqual([g.id]);
        expect(pin.ring[g.id]).toMatch(/^[0-9a-f]{64}$/);
        expect(pin.pending).toBeNull();
        expect(pin.trusted).toEqual([owen.publicKey]);
        // At rest: the blob in app storage holds no key and no history; its key is in the secure store.
        const label = namesTrustStoreKey(owen.publicKey, COMMUNITY);
        expect(mem.get(label)).not.toContain(pin.ring[g.id]);
        expect(mem.get(label)).not.toContain('beanpool-names-gen-v2');
        expect(secrets.get(namesPinSecretName(label))).toMatch(/^[0-9a-f]{64}$/);
        expect(namesPinSecretName(label)).toMatch(/^[A-Za-z0-9._-]+$/);
        // Without the secure store's key, nothing opens: the phone starts from an empty pin.
        secrets.clear();
        expect(await pinOf(owen)).toBeNull();
    });

    it('a PKCS8 key (the web app\'s form) signs and opens the same way', async () => {
        const owen = await admin('Owen', true);
        const node = new FakeNode();
        node.admins = [role(owen, 'owner')];
        answer = (req) => node.answer(req);
        expect((await open(owen)).plan.kind).toBe('ready');
    });
});

describe('A. Rows the server writes or alters', () => {
    it('A1 a planted box "to Ada" and a statement n=2 with no valid signature: plan unchanged, only the state read, entries untouched, ring unchanged', async () => {
        const { node, phones: [owen, ada], k1 } = await community();
        const ringBefore = { ...(await pinOf(ada))!.ring };
        const entriesBefore = JSON.stringify(node.entries);
        const forged = makeNamesGeneration({ communityId: CID, n: 2, parentId: k1, drops: [ada.publicKey] }, owen);
        const bad = { ...forged, signature: '0'.repeat(128) };
        const box = sealNamesRing({ [bad.id]: newNamesListKey() }, { communityId: CID, from: owen.publicKey, to: ada.publicKey, headId: bad.id });
        const header = namesShareHeader({ communityId: CID, from: owen.publicKey, to: ada.publicKey, headId: bad.id, keyIds: [bad.id], trusts: [owen.publicKey], boxDigest: namesBoxDigest(box) });
        // Written into the tables: the server's current stays the real one (the planted row isn't a real statement).
        node.views.set(ada.publicKey, { current: k1, extraShares: [{ header, signature: '1'.repeat(128), box } as unknown as NamesShare] });
        node.gens.set(bad.id, bad);
        const before = (await pinOf(ada))!;
        const o = await open(ada);
        expect(o.plan.kind).toBe('ready');
        expect(o.pin.chain).toEqual(before.chain);
        expect(o.pin.ring).toEqual(ringBefore);
        expect(JSON.stringify(node.entries)).toBe(entriesBefore);
        expect(sentAs('POST', '/api/names/generations')).toEqual([]);
        // Named as current by the server: refused; only the state read.
        node.views.set(ada.publicKey, { current: bad.id });
        sent = [];
        const r = await open(ada);
        expect(r.plan).toEqual({ kind: 'refused', reason: 'missing_record' });
        expect(onlyStateRead()).toBe(true);
        expect((await pinOf(ada))!.ring).toEqual(ringBefore);
    });

    it('A2 a key the owner password made an admin signs a real statement off the current one: every phone refuses it, reads and writes nothing, sends Z nothing', async () => {
        const { node, phones: [owen, ada], k1 } = await community();
        const z = await admin('Zed');
        node.admins.push(role(z));
        node.put(makeNamesGeneration({ communityId: CID, n: 2, parentId: k1, drops: [owen.publicKey, ada.publicKey] }, z));
        for (const p of [owen, ada]) {
            sent = [];
            const o = await open(p);
            expect(o.plan).toMatchObject({ kind: 'refused', reason: 'untrusted_maker', maker: z.publicKey, n: 2, canCheck: true });
            expect(onlyStateRead()).toBe(true);
            expect(planWords(o)).toBe(NAMES_COPY.refusedUntrusted(2, 'Zed'));
        }
        expect([...node.shares.values()].some((s) => s.to === z.publicKey)).toBe(false);
    });

    it("A3 the owner password moves Ada's account to the operator's key O: Owen's phone makes a new key without Ada's old one, sends O nothing; the real Ada's QR mismatches O (said, O untrusted); after a real re-key and a mutual scan, her new phone gets the keys and reads", async () => {
        const { node, phones: [owen, ada] } = await community();
        const o = await admin('Ada');
        node.former[ada.publicKey] = 'Ada';
        node.admins = [role(owen, 'owner'), role(o)];
        const r = await open(owen);
        const made = readNamesGeneration(JSON.parse(sentAs('POST', '/api/names/generations')[0].body), CID)!;
        expect(made.drops).toEqual([ada.publicKey]);
        expect(r.made).toEqual([ada.publicKey]);
        expect(r.notices[0]).toBe(NAMES_COPY.newKeyMade(['Ada']));
        expect(sentAs('POST', '/api/names/shares').map((s) => JSON.parse(s.body).header.split('\n')[3])).not.toContain(o.publicKey);
        expect(r.toCheck.map((a) => a.pubkey)).toEqual([o.publicKey]);
        // The real Ada, on a new phone, in front of Owen: her QR is not the key the server lists for "Ada".
        const adaNew = await admin('Ada');
        const scan = await checkEachOther(STORE, owen, COMMUNITY, r.state, namesKeyQr(adaNew.publicKey), { pubkey: o.publicKey });
        expect(scan).toEqual({ ok: true, pinned: adaNew.publicKey, mismatch: true });
        expect((await pinOf(owen))!.trusted).not.toContain(o.publicKey);
        sent = [];
        await open(owen);
        expect(sentAs('POST', '/api/names/shares')).toEqual([]);
        // The owner re-keys Ada to her real new key; they check each other; the keys go to it.
        node.admins = [role(owen, 'owner'), role(adaNew)];
        await meet(node, owen, adaNew);
        await open(owen);
        const toNew = sentAs('POST', '/api/names/shares').map((s) => readNamesShare(JSON.parse(s.body), CID)!);
        expect(toNew.map((s) => s.to)).toContain(adaNew.publicKey);
        const a = await open(adaNew);
        expect(a.plan.kind).toBe('ready');
        expect(openEntries(a.list!, a).filter((e) => e.text).map((e) => e.text!.name).sort()).toEqual([PLANTED[0], PLANTED[1]].sort());
    });

    it("A4 a look-alike callsign (Cyrillic А) on the operator's key: no share to it; typed digits of the real Ada's phone don't match it, and pin nothing", async () => {
        const { node, phones: [owen, ada] } = await community();
        const z = await admin('Аda');
        node.admins = [role(owen, 'owner'), role(z)];
        const r = await open(owen);
        expect(sentAs('POST', '/api/names/shares').some((s) => JSON.parse(s.body).header.includes(z.publicKey))).toBe(false);
        const typed = await checkEachOther(STORE, owen, COMMUNITY, r.state, namesKeyCode(ada.publicKey), { pubkey: z.publicKey });
        expect(typed).toEqual({ ok: false, reason: 'mismatch' });
        expect((await pinOf(owen))!.trusted).not.toContain(z.publicKey);
        expect(NAMES_COPY.codeMismatch('Аda')).toMatch(/Nothing was trusted/);
    });

    it('A5 the server swaps the box in a share to Owen for one a dropped key made, same ids: ignored; ring unchanged; ready', async () => {
        const { node, phones: [owen, ada, abe] } = await community(['Owen', 'Ada', 'Abe']);
        node.admins = [role(owen, 'owner'), role(ada)];
        await open(ada); // a new key without Abe, sent to Owen
        await open(owen);
        const ringBefore = (await pinOf(owen))!.ring;
        const real = node.shares.get(`${ada.publicKey}|${owen.publicKey}`)!;
        const fake = sealNamesRing({ [real.headId]: newNamesListKey() }, { communityId: CID, from: ada.publicKey, to: owen.publicKey, headId: real.headId });
        node.shares.set(`${ada.publicKey}|${owen.publicKey}`, { ...real, box: fake });
        node.views.set(owen.publicKey, { extraShares: [makeNamesShare({ communityId: CID, from: abe, to: owen.publicKey, headId: real.headId, ring: { [real.headId]: newNamesListKey() }, trusts: [abe.publicKey] })] });
        const o = await open(owen);
        expect(o.plan.kind).toBe('ready');
        expect(o.pin.ring).toEqual(ringBefore);
    });

    it('A6 two trusted admins send different keys for the same key: the first is kept, and the screen says so', async () => {
        const { node, phones: [owen, ada, bea], k1 } = await community(['Owen', 'Ada', 'Bea']);
        const kept = (await pinOf(ada))!.ring[k1];
        node.shares.set(`${bea.publicKey}|${ada.publicKey}`, makeNamesShare({ communityId: CID, from: bea, to: ada.publicKey, headId: k1, ring: { [k1]: newNamesListKey() }, trusts: [bea.publicKey, owen.publicKey, ada.publicKey] }));
        const o = await open(ada);
        expect(o.pin.ring[k1]).toBe(kept);
        expect(o.notices).toContain(NAMES_COPY.differentKeys(1));
    });

    it('A8 the server says another community: refused, the pin unchanged, nothing made even with no history on the server', async () => {
        const { node, phones: [owen] } = await community();
        const blob = mem.get(namesTrustStoreKey(owen.publicKey, COMMUNITY));
        node.views.set(owen.publicKey, { communityId: 'ffffffffffffffff', current: null, hide: [...node.gens.keys()] });
        const o = await open(owen);
        expect(o.plan).toEqual({ kind: 'refused', reason: 'other_community' });
        expect(onlyStateRead()).toBe(true);
        expect(mem.get(namesTrustStoreKey(owen.publicKey, COMMUNITY))).toBe(blob);
        expect(planWords(o)).toBe(NAMES_COPY.otherCommunity);
    });
});

describe('B. Shares and vouches', () => {
    it('B1 never to a callsign alone: an admin the server lists but this phone never checked gets nothing, and a "Check in person" row; after the check, the next open sends, signed, a box only they open', async () => {
        const { node, phones: [owen] } = await community();
        const cy = await admin('Cy');
        node.admins.push(role(cy));
        const r = await open(owen);
        expect(sentAs('POST', '/api/names/shares')).toEqual([]);
        expect(r.toCheck.map((a) => a.callsign)).toEqual(['Cy']);
        await meet(node, owen, cy);
        await open(owen);
        const share = sentAs('POST', '/api/names/shares').find((s) => readNamesShare(JSON.parse(s.body), CID)?.to === cy.publicKey)!;
        expect(boundSignatureValid(share, owen.publicKey)).toBe(true);
        expect(nothingReadable(share)).toBe(true);
        const c = await open(cy);
        expect(c.plan.kind).toBe('ready');
        expect(openEntries(c.list!, c).filter((e) => e.text).length).toBe(2);
    });

    it('B2 the mutual scan replaces trust on first use: a valid share "from O" to a fresh phone opens nothing, and it is told whom to meet; after scanning Owen it reads', async () => {
        const { node, phones: [owen], k1 } = await community();
        const [o, cy] = [await admin('Op'), await admin('Cy')];
        node.admins.push(role(o), role(cy));
        node.shares.set(`${o.publicKey}|${cy.publicKey}`, makeNamesShare({ communityId: CID, from: o, to: cy.publicKey, headId: k1, ring: { [k1]: newNamesListKey() }, trusts: [o.publicKey, owen.publicKey] }));
        const c = await open(cy);
        expect(c.plan).toMatchObject({ kind: 'refused', reason: 'untrusted_maker', maker: owen.publicKey, canCheck: true });
        expect(onlyStateRead()).toBe(true);
        expect(c.pin.ring).toEqual({});
        expect(planWords(c)).toBe(NAMES_COPY.refusedUntrusted(1, 'Owen'));
        await meet(node, owen, cy);
        await open(owen);
        const c2 = await open(cy);
        expect(c2.plan.kind).toBe('ready');
        expect(c2.pin.trusted).not.toContain(o.publicKey);
    });

    it("B3 a vouch carries: Owen checks Cy; Ada, who never met Cy, trusts Cy from Owen's header and sends Cy the keys; Cy takes Ada's later key", async () => {
        const { node, phones: [owen, ada] } = await community();
        const cy = await admin('Cy');
        node.admins.push(role(cy));
        await meet(node, owen, cy);
        await open(owen);
        await open(cy);
        await open(ada);
        expect((await pinOf(ada))!.trusted).toContain(cy.publicKey);
        node.admins = [role(ada), role(cy)];
        await open(ada); // a new key without Owen
        const c = await open(cy);
        expect(c.plan.kind).toBe('ready');
        expect(c.pin.chain[c.pin.chain.length - 1].id).toBe(node.current()!.id);
    });

    it('B5 a phone in the dark vouching a dropped key re-admits nobody: Abe stays dropped on Owen\'s phone and gets nothing', async () => {
        const { node, phones: [owen, abe, bea], k1 } = await community(['Owen', 'Abe', 'Bea']);
        node.admins = [role(owen, 'owner'), role(bea), role(abe)];
        await removeOldKey(STORE, owen, COMMUNITY, abe.publicKey);
        await open(owen);
        expect((await pinOf(owen))!.dropped[abe.publicKey]).toBe(node.current()!.id); // by the dropping statement's id (Addendum 2)
        node.shares.set(`${bea.publicKey}|${owen.publicKey}`, makeNamesShare({ communityId: CID, from: bea, to: owen.publicKey, headId: k1, ring: { [k1]: await keyOf(bea, k1) }, trusts: [bea.publicKey, owen.publicKey, abe.publicKey] }));
        sent = [];
        const o = await open(owen);
        expect(o.pin.trusted).not.toContain(abe.publicKey);
        expect(sentAs('POST', '/api/names/shares').some((s) => readNamesShare(JSON.parse(s.body), CID)?.to === abe.publicKey)).toBe(false);
        expect(o.toCheck.map((a) => a.callsign)).toEqual(['Abe']);
    });
});

describe('C. Drops and removal', () => {
    it("C1 a removed admin's key, delivered through an honest phone in the dark: Owen's phone never takes it or its key, is told, and Owen's later names never reach Abe; Bea takes Owen's history after meeting him", async () => {
        const { node, phones: [owen, abe, bea], k1 } = await community(['Owen', 'Abe', 'Bea']);
        node.admins = [role(owen, 'owner'), role(bea)];
        await open(owen); // 2 drops Abe
        const two = node.current()!.id;
        // The server's other story for Bea: key 1 current, Abe still an admin, Abe's own 2′ off 1, and his share to her.
        const twoPrime = makeNamesGeneration({ communityId: CID, n: 2, parentId: k1, drops: [] }, abe);
        node.put(twoPrime);
        const k2p = newNamesListKey();
        node.shares.set(`${abe.publicKey}|${bea.publicKey}`, makeNamesShare({ communityId: CID, from: abe, to: bea.publicKey, headId: twoPrime.id, ring: { [k1]: await keyOf(abe, k1), [twoPrime.id]: k2p }, trusts: [abe.publicKey, owen.publicKey, bea.publicKey] }));
        node.views.set(bea.publicKey, { current: twoPrime.id, hide: [two], admins: [role(owen, 'owner'), role(abe), role(bea)] });
        const b = await open(bea);
        expect(b.plan.kind).toBe('ready');
        expect(b.pin.ring[twoPrime.id]).toBe(bytesToHex(k2p));
        // Bea's phone sends her ring (with 2′, trusting Abe) to Owen.
        const toOwen = node.shares.get(`${bea.publicKey}|${owen.publicKey}`)!;
        expect(toOwen.headId).toBe(twoPrime.id);
        expect(toOwen.trusts).toContain(abe.publicKey);
        sent = [];
        const o = await open(owen);
        expect(o.plan.kind).toBe('ready');
        expect(o.pin.chain.map((l) => l.id)).toEqual([k1, two]);
        expect(o.pin.ring[twoPrime.id]).toBeUndefined();
        expect(o.pin.trusted).not.toContain(abe.publicKey);
        expect(o.notices).toContain(NAMES_COPY.otherHistory('Bea'));
        // Owen writes a name under 2; Bea's phone, on 2′, never takes key 2 even from Owen's own box.
        const saved = await saveNamesEntry(COMMUNITY, owen, STORE, o, { name: PLANTED[2], note: '' });
        expect(saved.ok && saved.value.keyId).toBe(two);
        const b2 = await open(bea);
        expect(b2.pin.ring[two]).toBeUndefined();
        for (const k of [await keyOf(abe, k1), k2p]) {
            const e = node.entries.find((x) => x.keyId === two)!;
            expect(() => openNamesEntry(k, e.id, two, e.ciphertext)).toThrow();
        }
        // The server stops hiding; Bea is on a different history. She meets Owen and takes his.
        node.views.delete(bea.publicKey);
        const b3 = await open(bea);
        expect(b3.plan).toEqual({ kind: 'refused', reason: 'different_history' });
        expect(planWords(b3)).toBe(NAMES_COPY.refusedDifferent);
        await meet(node, bea, owen);
        const t = await takeHistoryOf(COMMUNITY, bea, STORE, owen.publicKey);
        expect(t.ok && t.value.plan.kind).toBe('ready');
        const after = (await pinOf(bea))!;
        expect(after.chain.map((l) => l.id)).toEqual([k1, two]);
        expect(after.abandoned).toEqual([twoPrime.id]);
        expect(after.trusted).not.toContain(abe.publicKey);
        expect(after.ring[two]).toBeDefined();
    });

    it("C3 drops made before a phone was lost are kept: Ada's key 2 dropped Abe; Owen hadn't opened; Ada is re-keyed; Owen takes 2, then makes 3 without her old key", async () => {
        const { node, phones: [owen, ada, abe] } = await community(['Owen', 'Ada', 'Abe']);
        node.admins = [role(owen, 'owner'), role(ada)];
        await open(ada);
        const adaNew = await admin('Ada');
        node.admins = [role(owen, 'owner'), role(adaNew)];
        const o = await open(owen);
        expect(o.pin.dropped[abe.publicKey]).toBe(o.pin.chain[1].id); // by the dropping statement's id (Addendum 2)
        expect(node.current()!.n).toBe(3);
        expect(node.current()!.drops).toEqual([ada.publicKey]);
        expect(o.toCheck.map((a) => a.pubkey)).toEqual([adaNew.publicKey]);
        node.put(makeNamesGeneration({ communityId: CID, n: 4, parentId: node.current()!.id, drops: [] }, abe));
        sent = [];
        expect((await open(owen)).plan).toMatchObject({ kind: 'refused', reason: 'untrusted_maker', maker: abe.publicKey });
        expect(onlyStateRead()).toBe(true);
    });

    it("C4 the server hides a removal from Bea: her phone stays ready at key 1, which Abe holds (the stated limit); the list key the two phones show differs, so meeting in person shows it; once shown, both match", async () => {
        const { node, phones: [owen, abe, bea], k1 } = await community(['Owen', 'Abe', 'Bea']);
        node.admins = [role(owen, 'owner'), role(bea)];
        const o = await open(owen); // 2 drops Abe
        const two = node.current()!.id;
        expect(o.plan.kind).toBe('ready');
        node.views.set(bea.publicKey, { current: k1, hide: [two], admins: [role(owen, 'owner'), role(abe), role(bea)], quiet: true });
        const b = await open(bea);
        expect(b.plan.kind).toBe('ready');
        expect(Object.keys(b.pin.ring)).toEqual([k1]);
        // What Bea's phone writes now is under key 1, which Abe holds: the limit the words now state.
        expect(NAMES_COPY.who).toMatch(/an admin’s phone that the server keeps from learning of a removal/);
        expect(listKeyOf(o)).toEqual({ n: 2, code: namesListKeyCode(two) });
        expect(listKeyOf(b)).toEqual({ n: 1, code: namesListKeyCode(k1) });
        expect(listKeyOf(b)!.code).not.toBe(listKeyOf(o)!.code);
        // Shown the removal, Bea's phone takes key 2, and the two lines match.
        node.views.delete(bea.publicKey);
        await open(owen);
        const b2 = await open(bea);
        expect(b2.plan.kind).toBe('ready');
        expect(listKeyOf(b2)).toEqual(listKeyOf(await open(owen)));
        // Only a phone that can write shows a list key.
        expect(listKeyOf({ plan: { kind: 'wait', keyId: two, n: 2, holders: [], newKeyNeeded: false, canMakeNew: false, drops: [] }, pin: b2.pin })).toBeNull();
        // The screen shows it on this phone's key card, where two admins checking each other see both.
        const screen = fs.readFileSync(path.join(__dirname, '../../app/names-list.tsx'), 'utf8');
        expect(screen).toMatch(/COPY\.listKey\(/);
        expect(screen).toMatch(/COPY\.compareListKey/);
    });

    it('C5 the server leaves Cy off Owen\'s admin list: Owen drops Cy; Cy waits on Owen and is told; after a check the keys come back', async () => {
        const { node, phones: [owen, cy] } = await community(['Owen', 'Cy']);
        node.views.set(owen.publicKey, { admins: [role(owen, 'owner')] });
        await open(owen);
        node.views.delete(owen.publicKey);
        const c = await open(cy);
        expect(c.plan).toMatchObject({ kind: 'wait', holders: [owen.publicKey] });
        expect(c.notices).toContain(NAMES_COPY.droppedMe('Owen'));
        expect(planWords(c)).toBe(NAMES_COPY.wait(['Owen']));
        await meet(node, owen, cy);
        await open(owen);
        expect((await open(cy)).plan.kind).toBe('ready');
    });

    it('C7 a trusted admin drops everyone else: taken; Bea dropped; Owen waits on Ada and is told "@Ada made a key without this phone"', async () => {
        const { phones: [owen, ada, bea] } = await community(['Owen', 'Ada', 'Bea']);
        await removeOldKey(STORE, ada, COMMUNITY, owen.publicKey);
        await removeOldKey(STORE, ada, COMMUNITY, bea.publicKey);
        await open(ada);
        const o = await open(owen);
        expect(o.pin.trusted).not.toContain(bea.publicKey);
        expect(o.plan).toMatchObject({ kind: 'wait', holders: [ada.publicKey] });
        expect(o.notices).toContain(NAMES_COPY.droppedMe('Ada'));
        expect(o.list).toBeNull();
    });

    it('C8 "Remove @Ada\'s old key" while the server still lists it: no write until the new key lands; the new key leaves her out; her new phone needs a check', async () => {
        const { node, phones: [owen, ada] } = await community();
        expect(NAMES_COPY.removeKey('Ada')).toBe("Remove @Ada’s old key? The list gets a new key that @Ada’s old phone can’t read. If @Ada gets a new phone, check it in person and this phone will send the keys.");
        const adaOld = await keyOf(ada, node.current()!.id);
        await removeOldKey(STORE, owen, COMMUNITY, ada.publicKey);
        // The open makes the new key before anything else is sent.
        const o = await open(owen);
        expect(sent.map((s) => `${s.method} ${new URL(s.url).pathname}`).slice(0, 3)).toEqual(['GET /api/names/state', 'POST /api/names/generations', 'GET /api/names/state']);
        expect(node.current()!.drops).toEqual([ada.publicKey]);
        expect(o.pin.trusted).not.toContain(ada.publicKey);
        const saved = await saveNamesEntry(COMMUNITY, owen, STORE, o, { name: 'After', note: '' });
        expect(saved.ok).toBe(true);
        // Ada's old phone holds only key 1: it opens nothing written under the new key, and was sent nothing new.
        const e = node.entries.find((x) => x.keyId === node.current()!.id)!;
        expect(() => openNamesEntry(adaOld, e.id, e.keyId, e.ciphertext)).toThrow();
        const adaIds = Object.keys((await pinOf(ada))!.ring);
        expect(() => openNamesEntry(adaOld, e.id, adaIds[0], e.ciphertext)).toThrow();
        expect((await open(ada)).pin.ring[node.current()!.id]).toBeUndefined();
    });

    it('the new-key notice: a key removed by hand gets the Remove words, never "no longer an admin"; "has sent" names only the admins the key reached, and the rest are told it will come on the next open', async () => {
        const { node, phones: [owen, ada, bea, abe] } = await community(['Owen', 'Ada', 'Bea', 'Abe']);
        await removeOldKey(STORE, owen, COMMUNITY, ada.publicKey);
        const o = await open(owen);
        expect(o.made).toEqual([ada.publicKey]);
        expect(node.admins.map((a) => a.pubkey)).toContain(ada.publicKey);
        expect(o.notices.join('\n')).not.toMatch(/no longer an admin/);
        expect(o.notices[0]).toBe(NAMES_COPY.newKeyRemoved(['Ada']));
        expect(o.sentTo.sort()).toEqual([bea.publicKey, abe.publicKey].sort());
        expect(o.notices[1]).toBe(NAMES_COPY.newKeySent(['Bea', 'Abe'], []));
        // The server stops listing Abe, and the shares never reach the node: nothing is said to have been sent.
        node.admins = node.admins.filter((a) => a.pubkey !== abe.publicKey);
        node.former[abe.publicKey] = 'Abe'; // the node names every key its history and shares name (a member's callsign)
        drop = (req) => (new URL(req.url).pathname === '/api/names/shares' ? 'before' : null);
        const o2 = await open(owen);
        drop = null;
        expect(o2.made).toEqual([abe.publicKey]);
        expect(o2.sentTo).toEqual([]);
        expect(o2.notices[0]).toBe(NAMES_COPY.newKeyMade(['Abe']));
        expect(o2.notices[1]).toBe(NAMES_COPY.newKeySent([], ['Bea']));
        expect(o2.notices.join('\n')).not.toMatch(/has sent/);
        // And it does, on the next open.
        sent = [];
        await open(owen);
        expect(sentAs('POST', '/api/names/shares').map((s) => readNamesShare(JSON.parse(s.body), CID)!.to)).toEqual([bea.publicKey]);
    });

    it("C9 a drop is due but this phone lacks the current key: it waits on the holder, makes nothing, and its own removals ride into the next key it makes", async () => {
        const { node, phones: [owen, ada, cy, abe] } = await community(['Owen', 'Ada', 'Cy', 'Abe']);
        // Ada makes key 2 (removing nobody) but her answer to Cy hasn't come yet.
        await removeOldKey(STORE, ada, COMMUNITY, abe.publicKey);
        const adaPin = (await pinOf(ada))!;
        await (async () => {
            const { writeNamesPinTo } = await import('../names-list');
            await writeNamesPinTo(STORE, ada.publicKey, COMMUNITY, { ...adaPin, manualDrops: [] });
        })();
        node.admins = [role(owen, 'owner'), role(ada), role(cy)];
        drop = (req) => (new URL(req.url).pathname === '/api/names/shares' ? 'before' : null);
        await openNamesList(COMMUNITY, ada, STORE);
        drop = null;
        await removeOldKey(STORE, cy, COMMUNITY, owen.publicKey);
        sent = [];
        const c = await open(cy);
        expect(c.plan).toMatchObject({ kind: 'wait', newKeyNeeded: true, holders: [ada.publicKey] });
        expect(sentAs('POST', '/api/names/generations')).toEqual([]);
        // Cy's own removal of Owen is due: Ada sends the key, and Cy's phone makes the new key without Owen (round 7).
        expect(planWords(c)).toBe(NAMES_COPY.waitOwnKey(['Ada'], ['Owen']));
        await open(ada);
        const c2 = await open(cy);
        expect(node.current()!.maker).toBe(cy.publicKey);
        expect(node.current()!.drops).toEqual([owen.publicKey]);
        expect(c2.plan.kind).toBe('ready');
    });
});

describe('D. Lost phones, re-keys, dead ends', () => {
    it('D1 the generation lands but the answer is lost: the key was kept first; the next open takes it from the node; never a statement of ours whose key we lack', async () => {
        const { node, phones: [owen, ada] } = await community();
        await removeOldKey(STORE, owen, COMMUNITY, ada.publicKey);
        drop = (req) => (new URL(req.url).pathname === '/api/names/generations' ? 'after' : null);
        const r = await openNamesList(COMMUNITY, owen, STORE);
        expect(r.ok).toBe(false);
        drop = null;
        const landed = node.current()!;
        expect(landed.maker).toBe(owen.publicKey);
        expect((await pinOf(owen))!.pending?.id).toBe(landed.id);
        const o = await open(owen);
        expect(o.pin.pending).toBeNull();
        expect(o.pin.ring[landed.id]).toBeDefined();
        for (const g of node.gens.values()) if (g.maker === owen.publicKey) expect(o.pin.ring[g.id]).toBeDefined();
        expect(sentAs('POST', '/api/names/generations').length).toBe(1);
    });

    it('D1 the node stores the generation but a proxy answers 502: the key written ahead is kept, and the same open takes the statement with it; a 502 before it was stored sends the same statement and key again; only a refusal that says it never landed drops it', async () => {
        const { node, phones: [owen, ada] } = await community();
        await removeOldKey(STORE, owen, COMMUNITY, ada.publicKey);
        const isGen = (req: Sent) => req.method === 'POST' && new URL(req.url).pathname === '/api/names/generations';
        answer = (req) => {
            const a = node.answer(req);
            return isGen(req) && a.status === 201 ? { status: 502 } : a;
        };
        const o = await open(owen);
        answer = (req) => node.answer(req);
        const landed = node.current()!;
        expect(landed.maker).toBe(owen.publicKey);
        expect(o.pin.ring[landed.id]).toBeDefined();
        expect(o.pin.pending).toBeNull();
        expect(o.plan.kind).toBe('ready');
        for (const g of node.gens.values()) if (g.maker === owen.publicKey) expect(o.pin.ring[g.id]).toBeDefined();
        // A 502 from the proxy before the node stored it: kept, and the next open sends the same statement with the same key.
        const { phones: [bo, cy] } = await community(['Bo', 'Cy']);
        await removeOldKey(STORE, bo, COMMUNITY, cy.publicKey);
        const before = answer;
        answer = (req) => (isGen(req) ? { status: 502 } : before(req));
        await openNamesList(COMMUNITY, bo, STORE);
        answer = before;
        const kept = (await pinOf(bo))!.pending!;
        expect(kept).not.toBeNull();
        const b = await open(bo);
        expect(b.plan.kind).toBe('ready');
        expect(b.pin.ring[kept.id]).toBe(kept.key);
        // A refusal that says it never landed (asked to wait for a holder): dropped.
        const { phones: [di, ed] } = await community(['Di', 'Ed']);
        await removeOldKey(STORE, di, COMMUNITY, ed.publicKey);
        const before2 = answer;
        answer = (req) => (isGen(req) ? { status: 409, body: { error: 'Ask an admin who holds the key.', code: 'ask_for_share' } } : before2(req));
        await openNamesList(COMMUNITY, di, STORE);
        answer = before2;
        expect((await pinOf(di))!.pending).toBeNull();
    });

    it("D2 the generation never lands: the same statement is sent again while the node is where it was; dropped once another lands, whose maker's key is then taken", async () => {
        const { node, phones: [owen, ada] } = await community();
        await removeOldKey(STORE, owen, COMMUNITY, ada.publicKey);
        drop = (req) => (new URL(req.url).pathname === '/api/names/generations' ? 'before' : null);
        expect((await openNamesList(COMMUNITY, owen, STORE)).ok).toBe(false);
        drop = null;
        const pending = (await pinOf(owen))!.pending!;
        await open(owen);
        expect(node.current()!.id).toBe(pending.id);
        // Again, but Ada's key lands first.
        const { phones: [bo, cy] } = await community(['Bo', 'Cy']);
        await removeOldKey(STORE, bo, COMMUNITY, cy.publicKey);
        drop = (req) => (new URL(req.url).pathname === '/api/names/generations' ? 'before' : null);
        await openNamesList(COMMUNITY, bo, STORE);
        drop = null;
        await removeOldKey(STORE, cy, COMMUNITY, bo.publicKey);
        await open(cy);
        const b = await open(bo);
        expect(b.pin.pending).toBeNull();
        expect(b.plan).toMatchObject({ kind: 'wait' });
    });

    it('D3 two holders make a key at once: one 201, the other 409; the loser takes the winner\'s statement, waits, and gets its key on the winner\'s next open; both read every entry', async () => {
        const { node, phones: [owen, bea, abe] } = await community(['Owen', 'Bea', 'Abe']);
        node.admins = [role(owen, 'owner'), role(bea)];
        // Bea's phone made its key a moment before Owen's request arrives.
        const beaMade = makeNamesGeneration({ communityId: CID, n: 2, parentId: node.current()!.id, drops: [abe.publicKey] }, bea);
        const beaKey = newNamesListKey();
        await writeNamesPinTo(STORE, bea.publicKey, COMMUNITY, { ...(await pinOf(bea))!, pending: { statement: beaMade.statement, signature: beaMade.signature, id: beaMade.id, n: 2, key: bytesToHex(beaKey) } });
        node.onRequest = (req) => {
            if (req.method === 'POST' && new URL(req.url).pathname === '/api/names/generations' && req.headers['X-Public-Key'] === owen.publicKey && !node.gens.has(beaMade.id)) node.put(beaMade);
        };
        const o = await open(owen);
        node.onRequest = null;
        const answers = sentAs('POST', '/api/names/generations');
        expect(answers.length).toBe(1);
        expect(node.current()!.id).toBe(beaMade.id);
        expect(o.pin.pending).toBeNull();
        expect(o.pin.chain[o.pin.chain.length - 1].id).toBe(beaMade.id);
        expect(o.plan).toMatchObject({ kind: 'wait', holders: [bea.publicKey] });
        expect((await open(bea)).plan.kind).toBe('ready');
        const o2 = await open(owen);
        expect(o2.plan.kind).toBe('ready');
        const saved = await saveNamesEntry(COMMUNITY, owen, STORE, o2, { name: 'After the race', note: '' });
        expect(saved.ok).toBe(true);
        for (const p of [owen, bea]) {
            const x = await open(p);
            expect(openEntries(x.list!, x).every((e) => e.text)).toBe(true);
        }
    });

    it("D4 the only holder of the newest key is lost before sharing it: Owen is offered a new key (asked); its names stay locked, said with the key's number and maker; the older ones open; Ada's new phone gets every key but that one", async () => {
        const { node, phones: [owen, ada, abe], k1 } = await community(['Owen', 'Ada', 'Abe']);
        node.admins = [role(owen, 'owner'), role(ada)];
        // Ada's phone makes key 2 without Abe, but Owen's phone is off: nothing reaches it. She writes three names.
        drop = (req) => (new URL(req.url).pathname === '/api/names/shares' ? 'before' : null);
        const a = await open(ada);
        drop = null;
        const two = node.current()!.id;
        for (const n of ['A', 'B', 'C']) expect((await saveNamesEntry(COMMUNITY, ada, STORE, a, { name: n, note: '' })).ok).toBe(true);
        void abe;
        const adaNew = await rekey(node, ada);
        const o = await open(owen);
        expect(o.plan).toMatchObject({ kind: 'wait', keyId: two, n: 2, holders: [], canMakeNew: true });
        expect(planWords(o)).toBe(NAMES_COPY.nobodyHoldsKey(2, 3, 'Ada'));
        const m = await makeKeyOnThisPhone(COMMUNITY, owen, STORE);
        expect(m.ok && m.value.plan.kind).toBe('ready');
        const made = m.ok ? m.value : null;
        expect(node.current()!).toMatchObject({ n: 3, parentId: two, drops: [ada.publicKey] });
        const es = openEntries(made!.list!, made!);
        expect(es.filter((e) => e.text).map((e) => e.text!.name).sort()).toEqual([PLANTED[0], PLANTED[1]].sort());
        const locked = es.filter((e) => !e.text);
        expect(locked.length).toBe(3);
        expect(locked[0].key).toEqual({ n: 2, maker: ada.publicKey });
        expect(NAMES_COPY.lockedEntry(locked[0].key!.n, 'Ada', locked[0].holders)).toBe('Sealed with key 2 (made by @Ada). This phone doesn’t hold it. Nobody who is an admin now holds it: type it again from your paper copy, or delete it.');
        await meet(node, owen, adaNew);
        await open(owen);
        const an = await open(adaNew);
        expect(Object.keys(an.pin.ring).sort()).toEqual([k1, node.current()!.id].sort());
    });

    it('D4 the only admin reinstalls with the same key: the phone takes its own history back but holds no key, and is offered a new one', async () => {
        const { node, phones: [owen] } = await community(['Owen']);
        mem.delete(namesTrustStoreKey(owen.publicKey, COMMUNITY));
        const o = await open(owen);
        expect(o.plan).toMatchObject({ kind: 'wait', holders: [], canMakeNew: true });
        const m = await makeKeyOnThisPhone(COMMUNITY, owen, STORE);
        expect(m.ok && m.value.plan.kind).toBe('ready');
        expect(node.current()!.n).toBe(2);
    });

    it('D5 the lost phone shared its last key first: Owen makes 3 without its old key; every entry opens; after a check Ada\'s new phone gets every key', async () => {
        const { node, phones: [owen, ada] } = await community(['Owen', 'Ada', 'Abe']);
        node.admins = node.admins.slice(0, 2);
        const a = await open(ada); // key 2 without Abe, sent to Owen
        expect((await saveNamesEntry(COMMUNITY, ada, STORE, a, { name: 'Under two', note: '' })).ok).toBe(true);
        const adaNew = await rekey(node, ada);
        const o = await open(owen);
        expect(o.plan.kind).toBe('ready');
        expect(node.current()!).toMatchObject({ n: 3, drops: [ada.publicKey] });
        expect(openEntries(o.list!, o).every((e) => e.text)).toBe(true);
        await meet(node, owen, adaNew);
        await open(owen);
        const an = await open(adaNew);
        expect(an.plan.kind).toBe('ready');
        expect(Object.keys(an.pin.ring).length).toBe(3);
    });

    it('D6 the only admin loses their phone: the new phone may start again (asked, with the count), chained onto the server\'s history; everything before stays locked', async () => {
        const { node, phones: [owen] } = await community(['Owen']);
        const cur = node.current()!;
        const owenNew = await admin('Owen');
        node.admins = [role(owenNew, 'owner')];
        const o = await open(owenNew);
        expect(o.plan).toEqual({ kind: 'refused', reason: 'untrusted_maker', maker: owen.publicKey, n: 1, canCheck: false, canStartAgain: true });
        expect(planWords(o)).toContain(NAMES_COPY.startAgain(2));
        expect(NAMES_COPY.startAgain(2)).toBe('Nobody who is an admin now holds the list’s keys. You can start a new key; the 2 entries written before stay locked until an admin who held a key comes back, or they are typed again from your paper copy.');
        const m = await makeKeyOnThisPhone(COMMUNITY, owenNew, STORE);
        expect(m.ok && m.value.plan.kind).toBe('ready');
        expect(node.current()!).toMatchObject({ n: cur.n + 1, parentId: cur.id, maker: owenNew.publicKey });
        expect(openEntries(m.ok ? m.value.list! : { current: null, entries: [], confirmations: [] }, m.ok ? m.value : ({} as NamesOpened)).every((e) => !e.text)).toBe(true);
    });

    for (const copy of ['the old history without the start again', 'no key history at all'] as const) {
        it(`G5 (the review's :702) a start again, then a standby takes over from a copy with ${copy}: rolled back; "Put the key history back" sends the history the start again chained onto, then its own key; it reads again (one admin)`, async () => {
            const { node, phones: [owen] } = await community(['Owen']);
            const owenNew = await rekey(node, owen);
            await open(owenNew);
            expect((await makeKeyOnThisPhone(COMMUNITY, owenNew, STORE)).ok).toBe(true);
            const started = node.current()!;
            const all = new Map(node.gens);
            node.gens = copy === 'no key history at all' ? new Map() : new Map([...all].filter(([id]) => id !== started.id));
            node.shares.clear();
            sent = [];
            const r = await open(owenNew);
            expect(r.plan).toMatchObject({ kind: 'refused', reason: 'rolled_back', newest: { id: started.id, n: started.n } });
            expect(onlyStateRead()).toBe(true);
            expect(planWords(r)).toBe(NAMES_COPY.refusedRolledBack(copy === 'no key history at all' ? 0 : started.n - 1, started.n));
            const p = await putHistoryBack(COMMUNITY, owenNew, STORE);
            expect(p.ok && p.value.plan.kind).toBe('ready');
            expect(node.current()!.id).toBe(started.id);
            expect([...node.gens.keys()].sort()).toEqual([...all.keys()].sort());
            expect(sentAs('POST', '/api/names/generations').map((s) => JSON.parse(s.body).replay)).toEqual([...all.keys()].filter((id) => copy === 'no key history at all' || id === started.id).map(() => true));
            // Nothing from the history it chained onto is trusted or taken.
            const pin = (await pinOf(owenNew))!;
            expect(pin.trusted).toEqual([owenNew.publicKey]);
            expect(Object.keys(pin.ring)).toEqual([started.id]);
        });
    }

    it('D7 a reinstall, same key: an empty pin opens nothing other admins sent until it meets one; then that admin\'s box opens and the rest follows', async () => {
        const { node, phones: [owen, ada, bea] } = await community(['Owen', 'Ada', 'Bea']);
        await removeOldKey(STORE, ada, COMMUNITY, bea.publicKey);
        const { writeNamesPinTo } = await import('../names-list');
        await writeNamesPinTo(STORE, ada.publicKey, COMMUNITY, { ...(await pinOf(ada))!, manualDrops: [] });
        node.views.set(ada.publicKey, { admins: [role(owen, 'owner'), role(ada)] });
        await open(ada); // key 2 by Ada (dropping Bea in her view), shared with Owen
        node.views.delete(ada.publicKey);
        await open(owen);
        mem.delete(namesTrustStoreKey(owen.publicKey, COMMUNITY));
        sent = [];
        const o = await open(owen);
        expect(o.plan).toMatchObject({ kind: 'refused', reason: 'untrusted_maker', maker: ada.publicKey, canCheck: true });
        expect(onlyStateRead()).toBe(true);
        expect(o.pin.ring).toEqual({});
        await meet(node, owen, ada);
        const o2 = await open(owen);
        expect(o2.plan.kind).toBe('ready');
        expect(Object.keys(o2.pin.ring).length).toBe(2);
    });

    it('D8 the refusals are exactly five; no "old key" state is left in the app', () => {
        expect([...NAMES_REFUSAL_REASONS]).toEqual(['other_community', 'untrusted_maker', 'missing_record', 'different_history', 'rolled_back']);
        const src = fs.readFileSync(path.join(__dirname, '../names-list.ts'), 'utf8') + fs.readFileSync(path.join(__dirname, '../../app/names-list.tsx'), 'utf8');
        for (const gone of ['old_key', 'firstTrust', 'keyChanged', 'salvage', 'reEncrypt', 'makeNewKeyOnThisPhone', 're-encrypt', 'waitingAdmins']) expect(src).not.toContain(gone);
    });
});

describe('H. Re-admission by id, abandoned keys, the removal check (design Addendum 2)', () => {
    /** The requests `from` sent that shared keys to `to`. */
    const sharesSent = (from: BeanPoolIdentity, to: BeanPoolIdentity) => sentAs('POST', '/api/names/shares')
        .filter((x) => x.headers['X-Public-Key'] === from.publicKey && readNamesShare(JSON.parse(x.body), CID)?.to === to.publicKey);

    it("H1 (the re-review's :628) a fork through an admin kept in the dark, then Take @Cy's history: Cy's header re-admits nobody; Bea's phone makes a key without Abe before it writes, and says so; it never sends Abe anything, and Abe never gets the key Owen's name is under", async () => {
        const { node, phones: [owen, bea, cy, abe], k1 } = await community(['Owen', 'Bea', 'Cy', 'Abe']);
        node.admins = [role(owen, 'owner'), role(bea), role(cy)];
        await open(owen); // 2 drops Abe
        const two = node.current()!.id;
        const o = await open(owen);
        expect((await saveNamesEntry(COMMUNITY, owen, STORE, o, { name: 'Written after Abe was removed', note: '' })).ok).toBe(true);
        expect(Object.keys((await open(bea)).pin.ring)).toContain(two);
        // The node lists Abe again and keeps Cy's phone in the dark: key 1 current, 2 hidden, Owen left off.
        node.admins = [role(owen, 'owner'), role(bea), role(cy), role(abe)];
        const shown = [role(bea), role(cy), role(abe)];
        node.views.set(cy.publicKey, { current: k1, hide: [two], admins: shown, quiet: true });
        node.onRequest = (req) => {
            if (req.method !== 'POST' || new URL(req.url).pathname !== '/api/names/generations' || req.headers['X-Public-Key'] !== cy.publicKey) return;
            const g = readNamesGeneration(JSON.parse(req.body), CID)!;
            node.put(g); // stored beside 2, and made current
            node.head = g.id;
            node.views.set(cy.publicKey, { admins: shown, quiet: true });
        };
        expect((await open(cy)).plan.kind).toBe('ready');
        node.onRequest = null;
        const twoPP = node.current()!.id;
        expect(node.current()!).toMatchObject({ maker: cy.publicKey, parentId: k1, drops: [owen.publicKey] });
        // The node shows Bea Cy's branch. She meets Cy, checks, and takes Cy's history.
        node.views.set(bea.publicKey, { admins: shown, quiet: true });
        const b = await open(bea);
        expect(b.plan).toEqual({ kind: 'refused', reason: 'different_history' });
        await meet(node, bea, cy);
        // W1 (round 7): Cy's box to Bea hasn't come yet when she takes his history. Cy's phone only sends the key; Bea's
        // phone makes the key without Abe, and the words say so.
        node.shares.delete(`${cy.publicKey}|${bea.publicKey}`);
        sent = [];
        const t = await takeHistoryOf(COMMUNITY, bea, STORE, cy.publicKey);
        expect(t.ok && t.value.plan).toMatchObject({ kind: 'wait', newKeyNeeded: true, holders: [cy.publicKey], drops: [abe.publicKey] });
        expect(t.ok && planWords(t.value)).toBe(NAMES_COPY.waitOwnKey(['Cy'], ['Abe']));
        expect(sentAs('POST', '/api/names/generations')).toEqual([]);
        expect(sentAs('POST', '/api/names/entries')).toEqual([]);
        await open(cy);
        expect(node.current()!.id).toBe(twoPP); // Cy's phone made nothing
        sent = [];
        const after = await open(bea);
        expect(after.plan.kind).toBe('ready');
        const threePP = node.current()!;
        expect(threePP).toMatchObject({ maker: bea.publicKey, parentId: twoPP, drops: [abe.publicKey] });
        expect(after.pin.trusted).not.toContain(abe.publicKey);
        expect(after.pin.dropped[abe.publicKey]).toBe(threePP.id);
        expect(after.notices[0]).toBe(NAMES_COPY.newKeyCarried(['Abe']));
        // The new key landed before anything else was sent, and nothing went to Abe.
        const gens = sentAs('POST', '/api/names/generations');
        expect(gens.length).toBe(1);
        expect(sent.indexOf(gens[0])).toBeLessThan(Math.min(...sentAs('POST', '/api/names/shares').map((x) => sent.indexOf(x))));
        expect(sharesSent(bea, abe)).toEqual([]);
        for (const x of node.shares.values()) if (x.to === abe.publicKey) expect(x.keyIds).not.toContain(two);
        // Abe's own phone, shown everything, has no key for Owen's name.
        const e = node.entries.find((x) => x.keyId === two)!;
        const abeRing = (await pinOf(abe))!.ring;
        expect(abeRing[two]).toBeUndefined();
        expect(() => openNamesEntry(Uint8Array.from(Buffer.from(abeRing[k1], 'hex')), e.id, two, e.ciphertext)).toThrow();
    });

    it('H4/H5 the comparison proves nothing, Remove by hand does: two phones kept from a removal show the same list key; Remove makes a key without the admin or writes nothing; it works for an admin this phone never checked', async () => {
        // Run 1: the node keeps Bea and Cy at key 1 with Abe listed; Owen's phone made 2.
        const { node, phones: [owen, bea, cy, abe], k1 } = await community(['Owen', 'Bea', 'Cy', 'Abe']);
        node.admins = [role(owen, 'owner'), role(bea), role(cy)];
        await open(owen);
        const two = node.current()!.id;
        const all = [role(owen, 'owner'), role(bea), role(cy), role(abe)];
        for (const p of [bea, cy]) node.views.set(p.publicKey, { current: k1, hide: [two], admins: all, quiet: true });
        const b = await open(bea);
        const c = await open(cy);
        expect(listKeyOf(b)).toEqual(listKeyOf(c));
        expect(listKeyOf(b)!.n).toBe(1);
        // The words give the check that works.
        expect(NAMES_COPY.who).toMatch(/if it still shows them, tap Remove @X’s old key/);
        // Bea taps Remove @Abe's old key: the node refuses the key (it is at 2), so her phone writes nothing.
        await removeOldKey(STORE, bea, COMMUNITY, abe.publicKey);
        sent = [];
        const r = await open(bea);
        expect(r.plan).toEqual({ kind: 'make_new', drops: [abe.publicKey] });
        expect((await saveNamesEntry(COMMUNITY, bea, STORE, r, { name: 'X', note: '' })).ok).toBe(false);
        // And when a proxy answers 502 to the key.
        answer = (req) => (req.method === 'POST' && new URL(req.url).pathname === '/api/names/generations' ? { status: 502 } : node.answer(req));
        expect((await open(bea)).plan.kind).toBe('make_new');
        answer = (req) => node.answer(req);
        expect(sentAs('POST', '/api/names/entries')).toEqual([]);
        expect(sentAs('POST', '/api/names/shares').filter((x) => readNamesShare(JSON.parse(x.body), CID)?.to === abe.publicKey)).toEqual([]);

        // Run 2: the node keeps the removal from every phone (Abe still listed). Bea removes him by hand, and also Dee,
        // an admin her phone never checked.
        const w = await community(['Owen', 'Bea', 'Abe']);
        const dee = await admin('Dee');
        w.node.admins.push(role(dee));
        const [o2, b2, a2] = w.phones;
        expect((await pinOf(b2))!.trusted).not.toContain(dee.publicKey);
        await removeOldKey(STORE, b2, COMMUNITY, a2.publicKey);
        await removeOldKey(STORE, b2, COMMUNITY, dee.publicKey);
        expect((await pinOf(b2))!.manualDrops.sort()).toEqual([a2.publicKey, dee.publicKey].sort());
        sent = [];
        const r2 = await open(b2);
        expect(r2.plan.kind).toBe('ready');
        const made = w.node.current()!;
        expect(made).toMatchObject({ maker: b2.publicKey, drops: [a2.publicKey, dee.publicKey].sort() });
        expect(r2.pin.manualDrops).toEqual([]);
        expect(r2.pin.dropped[dee.publicKey]).toBe(made.id);
        const o2r = await open(o2);
        expect(o2r.pin.trusted).not.toContain(a2.publicKey);
        expect(o2r.pin.ring[made.id]).toBeDefined();
        expect(sentAs('POST', '/api/names/shares').filter((x) => [a2.publicKey, dee.publicKey].includes(readNamesShare(JSON.parse(x.body), CID)!.to))).toEqual([]);
        // The screen offers Remove on an admin this phone hasn't checked, too.
        const screen = fs.readFileSync(path.join(__dirname, '../../app/names-list.tsx'), 'utf8');
        expect(screen).toMatch(/checkButton\(a\.callsign\)[\s\S]{0,200}removeKeyButton\(a\.callsign\), \(\) => removeKey\(a\)/);
    });

    it("I1 (the re-review's :639, end to end) a standby takes over from an older copy, Cy's phone makes 2″ by itself, Bea takes Cy's history; the main copy comes back: Cy and then Bea take Owen's history, and Bea's phone re-takes the 2 it left and is ready on it; nothing goes to Abe", async () => {
        const { node, phones: [owen, bea, cy, abe] } = await community(['Owen', 'Bea', 'Cy', 'Abe']);
        const copy = () => ({ gens: new Map(node.gens), shares: new Map(node.shares) });
        const put = (c: ReturnType<typeof copy>) => { node.gens = new Map(c.gens); node.shares = new Map(c.shares); };
        const standby = copy();
        node.admins = [role(owen, 'owner'), role(bea), role(cy)];
        await open(owen); // 2 drops Abe
        const two = node.current()!.id;
        await open(bea);
        const main = copy();
        put(standby); // the take-over from the older copy
        expect((await open(cy)).plan.kind).toBe('ready');
        const twoPP = node.current()!.id;
        expect(node.current()!).toMatchObject({ maker: cy.publicKey, drops: [abe.publicKey] });
        expect((await open(bea)).plan).toEqual({ kind: 'refused', reason: 'different_history' });
        await meet(node, bea, cy);
        const t1 = await takeHistoryOf(COMMUNITY, bea, STORE, cy.publicKey);
        expect(t1.ok && t1.value.plan.kind).toBe('ready');
        put(main); // whoever runs the server puts the main copy back
        expect((await open(owen)).plan.kind).toBe('ready');
        expect((await open(cy)).plan).toEqual({ kind: 'refused', reason: 'different_history' });
        await meet(node, cy, owen);
        const tc = await takeHistoryOf(COMMUNITY, cy, STORE, owen.publicKey);
        expect(tc.ok && tc.value.plan.kind).toBe('ready');
        sent = [];
        expect((await open(bea)).plan).toEqual({ kind: 'refused', reason: 'different_history' });
        await meet(node, bea, owen);
        const t2 = await takeHistoryOf(COMMUNITY, bea, STORE, owen.publicKey);
        expect(t2.ok).toBe(true);
        const b = t2.ok ? t2.value : null!;
        expect(b.plan.kind).toBe('ready');
        expect(b.pin.chain.map((l) => l.id).slice(1)).toEqual([two]);
        expect(b.pin.abandoned).toEqual([twoPP]);
        expect(b.pin.trusted).not.toContain(abe.publicKey);
        expect(openEntries(b.list!, b).every((e) => e.text)).toBe(true);
        expect(sentAs('POST', '/api/names/shares').filter((x) => readNamesShare(JSON.parse(x.body), CID)?.to === abe.publicKey)).toEqual([]);
    });

    it('H6 a fresh walk that drops an admin this phone checked says so: check each other again', async () => {
        const { node, phones: [ann, owen] } = await community(['Ann', 'Owen']);
        node.admins = [role(ann, 'owner')];
        await open(ann); // 2 drops Owen
        node.admins = [role(ann, 'owner'), role(owen)];
        await meet(node, ann, owen);
        await open(ann);
        await open(owen);
        const pat = await admin('Pat');
        node.admins.push(role(pat));
        await meet(node, pat, owen);
        await open(owen);
        const p = await open(pat);
        expect(p.notices).toContain(NAMES_COPY.checkAgain('Owen', 2));
        expect(p.plan.kind).not.toBe('ready');
        await meet(node, pat, owen);
        await open(owen);
        expect((await open(pat)).plan.kind).toBe('ready');
    });
});

describe('E. Rollback, forks', () => {
    for (const [id, what] of [['E1', 'a server put back to key 1'], ['E2', 'a standby that took over from an older copy']] as const) {
        it(`${id} ${what}: phones ahead refuse and read nothing; "Put the key history back" replays it; the lost entries are counted`, async () => {
            const { node, phones: [owen, ada], k1 } = await community();
            await removeOldKey(STORE, owen, COMMUNITY, ada.publicKey);
            await open(owen); // 2
            const o2 = await open(owen);
            await saveNamesEntry(COMMUNITY, owen, STORE, o2, { name: 'Written after', note: '' });
            await open(owen); // lastCount 3
            const head = node.current()!;
            node.gens = new Map([[k1, node.gens.get(k1)!]]);
            node.entries = node.entries.filter((e) => e.keyId === k1);
            node.shares.clear();
            sent = [];
            const r = await open(owen);
            expect(r.plan).toEqual({ kind: 'refused', reason: 'rolled_back', offered: { id: k1, n: 1 }, newest: { id: head.id, n: 2 } });
            expect(onlyStateRead()).toBe(true);
            expect(planWords(r)).toBe(NAMES_COPY.refusedRolledBack(1, 2));
            expect(r.lost).toBe(1);
            expect(r.notices).toContain(NAMES_COPY.lostSinceCopy(1));
            const p = await putHistoryBack(COMMUNITY, owen, STORE);
            expect(p.ok && p.value.plan.kind).toBe('ready');
            expect(node.current()!.id).toBe(head.id);
            const replayed = sentAs('POST', '/api/names/generations').map((s) => JSON.parse(s.body));
            expect(replayed.every((b) => b.replay === true)).toBe(true);
        });
    }

    it('E4 the server hides a statement in the middle: a missing record; nothing read', async () => {
        const { node, phones: [owen, ada] } = await community();
        await removeOldKey(STORE, owen, COMMUNITY, ada.publicKey);
        await open(owen);
        const two = node.current()!;
        const three = makeNamesGeneration({ communityId: CID, n: 3, parentId: two.id, drops: [] }, owen);
        node.put(three);
        const cy = await admin('Cy');
        node.admins.push(role(cy));
        await meet(node, owen, cy);
        node.views.set(cy.publicKey, { hide: [two.id] });
        sent = [];
        const c = await open(cy);
        expect(c.plan).toEqual({ kind: 'refused', reason: 'missing_record' });
        expect(onlyStateRead()).toBe(true);
        expect(planWords(c)).toBe(NAMES_COPY.missingRecord);
    });
});

describe('F. Writes, reads, words', () => {
    it("F1 a write only under the head's key when the server's current is the head: a stale key is answered 409, the list opened again, and the entry sealed under the new head and sent once more", async () => {
        const { node, phones: [owen, ada] } = await community(['Owen', 'Ada', 'Abe']);
        const o = await open(owen);
        node.admins = node.admins.slice(0, 2);
        await open(ada); // key 2 without Abe, sent to Owen; Owen's screen still holds the old open
        sent = [];
        const saved = await saveNamesEntry(COMMUNITY, owen, STORE, o, { name: PLANTED[2], note: '' });
        expect(saved.ok && saved.value.keyId).toBe(node.current()!.id);
        const posts = sentAs('POST', '/api/names/entries').map((s) => JSON.parse(s.body));
        expect(posts.map((b) => b.keyId)).toEqual([o.pin.chain[0].id, node.current()!.id]);
        expect(posts[0].id).toBe(posts[1].id);
        for (const s of sent) expect(nothingReadable(s)).toBe(true);
    });

    it('F2 the write freeze: a holder removed, another admin writing before any holder opens: 409 new_key_first; the next holder\'s open makes the key', async () => {
        const { node, phones: [owen, ada, abe] } = await community(['Owen', 'Ada', 'Abe']);
        const o = await open(owen);
        node.admins = [role(owen, 'owner'), role(ada)];
        // Ada's phone hasn't opened since: its old open writes, and the node refuses.
        const r = await saveNamesEntry(COMMUNITY, ada, STORE, { plan: { kind: 'ready' }, pin: (await pinOf(ada))!, ring: o.ring }, { name: 'X', note: '' });
        expect(r.ok === false && r.code).toBe('new_key_first');
        await open(owen);
        expect(node.current()!.drops).toEqual([abe.publicKey]);
        expect((await open(ada)).plan.kind).toBe('ready');
    });

    it("F5 / G2 a locked entry names its key, its maker and who holds it; once that admin opens, it opens (the start-again's old keys, a holder found), on the phone that started again too", async () => {
        const { node, phones: [owen] } = await community(['Owen']);
        const one = node.current()!.id;
        // Owen's phone lost; the new phone starts again; Cy, checked by the new phone, joins.
        const owenNew = await rekey(node, owen);
        const s = await open(owenNew);
        expect(s.plan).toMatchObject({ kind: 'refused', reason: 'untrusted_maker', canStartAgain: true });
        expect((await makeKeyOnThisPhone(COMMUNITY, owenNew, STORE)).ok).toBe(true);
        const cy = await admin('Cy');
        node.admins.push(role(cy));
        await meet(node, owenNew, cy);
        await open(owenNew);
        const c = await open(cy);
        expect(c.plan.kind).toBe('ready');
        let locked = openEntries(c.list!, c).filter((e) => !e.text);
        expect(locked.length).toBe(2);
        expect(locked[0].key).toEqual({ n: 1, maker: owen.publicKey });
        expect(locked[0].holders).toEqual([]);
        // The old phone is found: the owner makes its key an admin again, and the new phone checks it in person.
        node.admins.push(role(owen));
        await meet(node, owenNew, owen);
        await open(owenNew);
        await open(owen);
        await open(owen);
        const c2 = await open(cy);
        locked = openEntries(c2.list!, c2).filter((e) => !e.text);
        // Its box to Cy carries key 1: the old entries open.
        expect(locked).toEqual([]);
        expect(c2.pin.ring[one]).toBeDefined();
        // G2: the phone that started again took the old history onto its chain, so the old phone's box opens them there too.
        const on = await open(owenNew);
        expect(on.pin.chain[0].id).toBe(one);
        expect(on.pin.ring[one]).toBeDefined();
        expect(openEntries(on.list!, on).every((e) => e.text)).toBe(true);
        expect(NAMES_COPY.lockedEntry(1, 'Owen', ['Owen'])).toBe('Sealed with key 1 (made by @Owen). This phone doesn’t hold it. @Owen holds it and will send it on their next open.');
    });

    it('add and edit send sealed text only, signed, under the head key; an add keeps the id chosen when its form opened, so a lost answer and Save again is one entry (entry_exists = done)', async () => {
        const { node, phones: [owen] } = await community();
        const o = await open(owen);
        const before = node.entries.length;
        // The screen chooses the id when the Add form opens and keeps it until the add is confirmed.
        const addId = newEntryId();
        sent = [];
        drop = (req) => (req.method === 'POST' && new URL(req.url).pathname === '/api/names/entries' ? 'after' : null);
        const first = await saveNamesEntry(COMMUNITY, owen, STORE, o, { name: PLANTED[2], note: PLANTED[1] }, undefined, addId);
        expect(first.ok).toBe(false);
        drop = null;
        for (const s of sent) { expect(nothingReadable(s)).toBe(true); expect(boundSignatureValid(s, owen.publicKey)).toBe(true); }
        // Save again, from the same form: the node already has it, and that is done. One entry, never two.
        const again = await saveNamesEntry(COMMUNITY, owen, STORE, o, { name: PLANTED[2], note: PLANTED[1] }, undefined, addId);
        expect(again.ok && again.value.id).toBe(addId);
        expect(node.entries.length).toBe(before + 1);
        expect(sentAs('POST', '/api/names/entries').map((s) => JSON.parse(s.body).id)).toEqual([addId, addId]);
        // A second Add form is a second entry.
        expect(newEntryId()).not.toBe(addId);
        const edit = await saveNamesEntry(COMMUNITY, owen, STORE, o, { name: PLANTED[2], note: 'changed' }, addId);
        expect(edit.ok).toBe(true);
        const e = node.entries.find((x) => x.id === addId)!;
        expect(openNamesEntry(await keyOf(owen, e.keyId), addId, e.keyId, e.ciphertext).note).toBe('changed');
        // The screen: the id is chosen when the Add form opens, kept in the form, and sent with every Save of it.
        const screen = fs.readFileSync(path.join(__dirname, '../../app/names-list.tsx'), 'utf8');
        expect(screen).toMatch(/kind: 'edit', entry, addId: entry \? undefined : newEntryId\(\)/);
        expect(screen).toMatch(/saveNamesEntry\(anchor, identity, STORE, opened, \{ name, note \}, mode\.entry\?\.id, mode\.addId\)/);
    });

    it('opens each entry with its own key; one it can\'t is locked, never guessed; search covers the open ones', async () => {
        const { phones: [owen] } = await community();
        const o = await open(owen);
        const es = openEntries(o.list!, o);
        expect(es.map((e) => e.text?.name).sort()).toEqual([PLANTED[0], PLANTED[1]].sort());
        expect(filterEntries(es, 'nobody by this name').length).toBe(0);
        expect(filterEntries(es, 'zebedee').length).toBe(1);
        const bad = { ...o.list!, entries: [...o.list!.entries, { ...o.list!.entries[0], id: newNamesEntryId() }] };
        expect(openEntries(bad, o).find((e) => e.locked === 'did_not_open')).toBeDefined();
    });

    it("F9 every send is a line in the node's log: a new key with two trusted admins sends two", async () => {
        const { node, phones: [owen, ada, bea, abe] } = await community(['Owen', 'Ada', 'Bea', 'Abe']);
        node.log = [];
        node.admins = node.admins.filter((a) => a.pubkey !== abe.publicKey);
        await open(owen);
        expect(node.log.map((l) => l.action)).toEqual(['holder_dropped', 'key_changed', 'key_shared', 'key_shared']);
        expect(node.log.filter((l) => l.action === 'key_shared').map((l) => l.subject).sort()).toEqual([ada.publicKey, bea.publicKey].sort());
    });

    it('"Send the keys to @X again" sends only to a key this phone trusts', async () => {
        const { node, phones: [owen, ada] } = await community();
        const cy = await admin('Cy');
        node.admins.push(role(cy));
        const r = await sendKeysAgain(COMMUNITY, owen, STORE, cy.publicKey);
        expect(r.ok === false && r.code).toBe('check_in_person');
        const r2 = await sendKeysAgain(COMMUNITY, owen, STORE, ada.publicKey);
        expect(r2.ok).toBe(true);
    });
});

describe('F6 the words are the design\'s (§9), and the old ones are gone', () => {
    const plain = (s: string) => s.replace(/’/g, "'");
    it('each sentence exactly', () => {
        // The design addendum's (e), exact, then what an admin can do about it (the fifth deciding review's BLOCKING finding, 52e1a759).
        // Addendum 2 (§3): the removal check is Remove by hand; the comparison only says two phones are shown different things.
        expect(plain(NAMES_COPY.who)).toBe("Only this community's owners and admins can read these names, on their own phones. The server keeps them scrambled: a backup, a copy or a stolen database holds nothing readable. This phone gives the list's keys only to admins whose phones were checked in person, by you or by an admin you trust, and takes a new key only from them. What it can't protect: a check made with the wrong person, a phone someone else gets into, a lost phone until an admin removes its key, and an admin's phone that the server keeps from learning of a removal: what that phone writes until it learns, the removed admin's keys can read. Each admin's phone learns of a removal when it opens the list, unless the server hides it. After an admin is removed, look at this phone's admins: if it still shows them, tap Remove @X's old key. Whatever the server says, this phone then makes a key without them or writes nothing.");
        expect(plain(NAMES_COPY.takeHistory('X'))).toBe("This phone follows the key history @X's phone has, from the last key both share. It keeps the other history's keys for reading and passes them on with the rest, but never writes under them again unless the server's history comes back to them. An admin this phone had removed stays removed: before it writes, it makes a key without them.");
        // Round 7: when the new key is this phone's own drop, the holder only sends the key; this phone makes the new one.
        expect(plain(NAMES_COPY.waitOwnKey(['A'], ['X']))).toBe("The list needs a new key without @X before anything more is written. This phone makes it once it holds the list's current key: @A will send that the next time they open the names list.");
        expect(plain(NAMES_COPY.newKeyCarried(['X']))).toBe("The list has a new key without @X: this phone had removed their key, and the history it took hadn't.");
        expect(plain(NAMES_COPY.checkAgain('X', 4))).toBe("Key 4 removed @X's key. If @X is an admin again, check each other's phones again: a check made before this phone took key 4 doesn't count past it.");
        expect(plain(`${NAMES_COPY.newKeyMade(['X'])} ${NAMES_COPY.newKeySent(['A'], [])}`)).toBe('The list has a new key because @X is no longer an admin. Nothing this phone writes from now on can be read with the keys @X had. This phone has sent the new key to the admins it trusts.');
        expect(plain(NAMES_COPY.newKeyRemoved(['X']))).toBe("The list has a new key that @X's old phone can't read. If @X gets a new phone, check it in person and this phone will send the keys.");
        expect(plain(NAMES_COPY.newKeySent([], ['C']))).toBe('This phone will send the new key to @C the next time the list opens on it.');
        expect(plain(NAMES_COPY.newKeySent(['A'], ['C', 'D']))).toBe('This phone has sent the new key to @A. It will send it to @C and @D the next time the list opens on it.');
        expect(NAMES_COPY.newKeySent([], [])).toBe('');
        expect(plain(NAMES_COPY.listKey(3, '1234 5678 9012 3456 7890'))).toBe('This phone adds names under list key 3, code 1234 5678 9012 3456 7890.');
        expect(plain(NAMES_COPY.compareListKey)).toBe('When you check each other, compare this line too. If it differs, open the list again on both phones. If it still differs, the server is showing your phones different things: add no names until it matches, and tell your admins.');
        expect(plain(NAMES_COPY.removeKey('X'))).toBe("Remove @X's old key? The list gets a new key that @X's old phone can't read. If @X gets a new phone, check it in person and this phone will send the keys.");
        expect(plain(NAMES_COPY.checkIntro('X'))).toBe("Meet @X. Open the names list on both phones, and scan each other's code (or compare and type the 20 digits). Only do this with @X in front of you: your phone will trust this key, send it the names, and take new keys it makes.");
        expect(plain(NAMES_COPY.mismatch('X'))).toBe("The key you scanned isn't the one the server lists for @X. Your phone trusts the key you scanned and nothing is sent to the server's key. Either the server has put @X's name on another key, or this isn't @X's phone. Tell your other admins.");
        // The design addendum's (e): the vouched history gives a way forward through any admin whose phone opens the list.
        expect(plain(NAMES_COPY.refusedUntrusted(4, 'X'))).toBe("The list's key number 4 was made by @X, and no admin this phone trusts has checked them. Nothing was read or written. Meet @X, or an admin whose phone already opens the list, and check each other's phones.");
        expect(plain(NAMES_COPY.refusedRolledBack(2, 5))).toBe('The server offers an older key history (up to key 2) than this phone has (key 5). A server put back to an older copy does that. Nothing was read or written. You can put the key history back from this phone; entries written since the copy are gone and must be typed again from your paper copy.');
        expect(plain(NAMES_COPY.refusedDifferent)).toBe("The server shows a key history this phone didn't take. Whoever runs the server changed it. Nothing was read or written. Ask your admins; an admin whose phone has the server's history can check yours and send the keys.");
        expect(plain(NAMES_COPY.wait(['A', 'B']))).toBe("You don't hold the list's keys yet. @A or @B will send them the next time they open the names list.");
        expect(plain(NAMES_COPY.wait([]))).toBe("Nobody this phone trusts holds the list's keys. Meet an admin who does and check each other's phones.");
        expect(plain(NAMES_COPY.lockedEntry(3, 'X', ['A']))).toBe("Sealed with key 3 (made by @X). This phone doesn't hold it. @A holds it and will send it on their next open.");
        expect(plain(NAMES_COPY.lockedEntry(3, 'X', []))).toBe("Sealed with key 3 (made by @X). This phone doesn't hold it. Nobody who is an admin now holds it: type it again from your paper copy, or delete it.");
        expect(plain(NAMES_COPY.startAgain(7))).toBe("Nobody who is an admin now holds the list's keys. You can start a new key; the 7 entries written before stay locked until an admin who held a key comes back, or they are typed again from your paper copy.");
    });

    it('none of the old promises are said', () => {
        const said = (v: unknown): string => {
            if (typeof v !== 'function') return String(v);
            for (const args of [['X'], [['X']], [2, 'X', ['X']], [2, 3, 'X'], [2, 5]]) {
                try { return (v as (...a: unknown[]) => string)(...args); } catch { /* the next shape */ }
            }
            return '';
        };
        const all = Object.values(NAMES_COPY).map(said).join('\n') + fs.readFileSync(path.join(__dirname, '../../app/names-list.tsx'), 'utf8');
        for (const gone of [/To be sure, meet another admin and compare the list key/i, /they should show the same one/i,
            /Admins check for that by meeting and comparing their phones/i, /for reading only/i, /remembers it/i, /first use/i, /whoever (first )?shares/i, /carried over/i, /sealed again/i, /seals? (them|every entry) again/i, /any admin can start a new key/i, /working with (whoever runs|the operator)/i]) {
            expect(all).not.toMatch(gone);
        }
    });
});

describe('reads and refusals', () => {
    it('the export is fetched as an export (the node logs it), and the PDF is made from that fetch', async () => {
        const owen = await admin('Owen');
        answer = () => ({ status: 200, body: { current: null, entries: [], confirmations: [] } });
        await fetchNamesList(COMMUNITY, owen, true);
        expect(sent[0].url).toBe(`${COMMUNITY}/api/names/entries?for=export`);
        expect(boundSignatureValid(sent[0], owen.publicKey)).toBe(true);
        const screen = fs.readFileSync(path.join(__dirname, '../../app/names-list.tsx'), 'utf8');
        const exp = screen.slice(screen.indexOf('const exportPdf'), screen.indexOf('const setTwoAdmins'));
        expect(exp.indexOf('Alert.alert(COPY.exportTitle')).toBeLessThan(exp.indexOf('fetchNamesList(anchor, identity, true)'));
        expect(exp.indexOf('fetchNamesList(anchor, identity, true)')).toBeLessThan(exp.indexOf('printToFileAsync'));
        expect(exp).toContain('openEntries(fresh.value, opened)');
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

    it('the device store keeps the blob in app storage and its key in the secure store', async () => {
        await DEVICE_NAMES_STORE.setItem('k', 'v');
        await DEVICE_NAMES_STORE.setSecret('s', 'x');
        expect(mem.get('k')).toBe('v');
        expect(secrets.get('s')).toBe('x');
        expect(myKeyCheck({ publicKey: 'a'.repeat(64) }).qr).toBe(`beanpool-admin-key:v1:${'a'.repeat(64)}`);
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
        const list: NamesListBody = { current: null, entries: [], confirmations: [row({})] };
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
        expect(logLineText({ id: '3', actor: 'x', actorCallsign: 'Ada', action: 'key_shared', entryId: null, subject: 'm', subjectCallsign: 'Mel', at: '' }, nameOf))
            .toBe('@Ada sent the list’s keys to @Mel · ');
    });
});

describe('the PDF page', () => {
    it('escapes every value, counts the locked entries, and never shows one', () => {
        const base = { keyId: 'k', createdAt: '', updatedAt: '', key: null, holders: [] as string[], confirmation: null };
        const html = namesListHtml({
            communityName: 'Mullum <LETS>', exportedBy: '@Owen', at: new Date('2026-10-01T00:00:00Z'),
            entries: [
                { ...base, id: 'a', text: { name: '<script>alert(1)</script>Bob', note: 'line one\nline "two"' }, locked: null } as OpenedEntry,
                { ...base, id: 'b', text: null, locked: 'no_key' } as OpenedEntry,
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

describe.each([['light', lightColors], ['dark', darkColors]] as const)('F8 the names list styles in %s (320dp at 1.3× text)', (_name, colors) => {
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
    it('the Check-each-other card: this phone\'s QR code (232dp drawn) fits at 320dp, on white in both themes; the scanner is a full-screen view of its own with a square camera and no text field', () => {
        const screen = fs.readFileSync(path.join(__dirname, '../../app/names-list.tsx'), 'utf8');
        const qr = screen.match(/<QRCode value=\{mine\.qr\} size=\{(\d+)\} quietZone=\{(\d+)\}/);
        expect(qr).not.toBeNull();
        const drawn = Number(qr![1]) + 2 * Number(qr![2]) + 2 * Number(spec.qrBox.padding);
        expect(drawn).toBe(232);
        const room = 320 - 2 * Number(spec.scroll.padding) - 2 * Number(spec.keyCard.padding) - 2 * Number(spec.keyCard.borderWidth);
        expect(drawn).toBeLessThanOrEqual(room);
        expect(spec.qrBox.backgroundColor).toBe('#ffffff');
        expect(spec.camera.aspectRatio).toBe(1);
        const modal = screen.slice(screen.indexOf('<Modal'), screen.indexOf('</Modal>'));
        expect(modal).toContain('<CameraView');
        expect(modal).not.toMatch(/TextInput|KeyboardAwareScrollView|KeyboardProvider/);
        expect(spec.scanner.flex).toBe(1);
    });
    it('the locked-entry rows wrap: their words sit in a growing row, never clipped', () => {
        expect(spec.lockedText.numberOfLines).toBeUndefined();
        expect(spec.entry.height).toBeUndefined();
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

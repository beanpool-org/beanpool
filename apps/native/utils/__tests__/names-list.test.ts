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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => secrets.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { secrets.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { secrets.delete(key); }),
}));
// For identity.ts (the Sign Out wipe and the 12 words, end to end below).
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

import { getPublicKey } from '@noble/ed25519';
import {
    newNamesListKey, sealNamesEntry, openNamesEntry, newNamesEntryId, makeNamesGeneration, makeNamesShare, readNamesGeneration,
    readNamesShare, namesKeyQr, namesKeyCode, namesListKeyCode, namesBoxDigest, emptyNamesPin, namesShareHeader, sealNamesRing, NAMES_REFUSAL_REASONS, toEd25519Pkcs8,
    readNamesCopy,
    type NamesGeneration, type NamesShare,
} from '@beanpool/core';
import { bytesToHex } from '../crypto';
import { boundSignatureValid } from './server-signature-check';
import { lightColors, darkColors } from '../../constants/colors';
import {
    writeNamesPinTo, offersNamesList, openNamesList, checkEachOther, removeOldKey, removeOldKeyAndOpen, unkeptRemovalsOf, putHistoryBack, makeKeyOnThisPhone, followServerHistory, sendKeysAgain,
    readNamesPinFrom, namesTrustStoreKey, namesPinSecretName, openEntries, filterEntries, saveNamesEntry, fetchNamesList, fetchNamesState,
    confirmMember, deleteNamesEntry, confirmableMembers, confirmationActions, confirmationLine, logLineText, namesListHtml, myKeyCheck,
    planWords, newEntryId, listKeyOf, startAfreshOnThisPhone, saveNamesCopiesBeforeLeaving, mergeNamesPins, namesSignOutWords, namesPinAddresses, NAMES_SIGN_OUT_REQUEST_MS, NAMES_SIGN_OUT_TOTAL_MS, COPY_REFUSED_CODES, NAMES_COPY, DEVICE_NAMES_STORE, setNamesRequestTimeout, NAMES_REQUEST_TIMEOUT_MS, NAMES_TIMED_OUT, followRemovesAny,
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
/** Set to hold a request's answer (already computed by the node) until the returned promise settles: a slow connection. */
let hold: ((req: Sent) => Promise<void> | null) | null = null;

const STORE: NamesPinStore = {
    getItem: async (k) => mem.get(k) ?? null, setItem: async (k, v) => { mem.set(k, v); },
    getSecret: async (k) => secrets.get(k) ?? null, setSecret: async (k, v) => { secrets.set(k, v); },
};

// The stubs below resolve at once, so a test never gives the event loop a turn: on a slow CI runner this file's run holds
// the vitest worker past its RPC deadline ("Timeout calling onTaskUpdate"). A macrotask between tests lets it report.
afterEach(() => new Promise<void>((r) => setTimeout(r, 0)));

beforeEach(() => {
    mem.clear();
    secrets.clear();
    sent = [];
    drop = null;
    hold = null;
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
        const req = { url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body ?? '' };
        sent.push(req);
        const when = drop?.(req) ?? null;
        if (when === 'before') throw new Error('offline');
        const live = answer(req);
        // The answer as it goes over the wire: made now, not read later from the node's live rows.
        const a = { status: live.status, body: live.body === undefined ? undefined : JSON.parse(JSON.stringify(live.body)) };
        const held = hold?.(req) ?? null;
        if (held) await held;
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
    /** The locked copies (design §4), by owner; null: a node from before them (no `myCopy`, no route). */
    copies: Map<string, { header: string; signature: string; box: unknown; seq: number; headN: number; headId: string | null; savedAt: string; digest: string }> | null = null;
    /** Called before each request is answered: lets a test make something land first. */
    onRequest: ((req: Sent) => void) | null = null;
    /** Set when the node makes one branch of a fork its current (then each statement it takes moves it on). */
    head: string | null = null;
    current(): NamesGeneration | null {
        if (this.head) return this.gens.get(this.head) ?? null;
        return [...this.gens.values()].sort((a, b) => b.n - a.n)[0] ?? null;
    }
    /** `mayHold` (design Addendum 4): maker, and both ends of every share naming the id; for the freeze and `no_key`. */
    holdersOf(id: string): Set<string> {
        const out = new Set<string>();
        const g = this.gens.get(id);
        if (g) out.add(g.maker);
        for (const s of this.shares.values()) if (s.keyIds.includes(id)) { out.add(s.from); out.add(s.to); }
        for (const m of this.marks) if (m.endsWith(`|${id}`)) out.delete(m.split('|')[0]);
        return out;
    }
    /** `holds`: on the holder's own word (maker, or its own share header lists the id); for keyIds, holders and ask_for_share. */
    holds(id: string): Set<string> {
        const out = new Set<string>();
        const g = this.gens.get(id);
        if (g) out.add(g.maker);
        for (const s of this.shares.values()) if (s.keyIds.includes(id)) out.add(s.from);
        for (const m of this.marks) if (m.endsWith(`|${id}`)) out.delete(m.split('|')[0]);
        return out;
    }
    keyIdsOf(pk: string): string[] {
        return [...this.gens.keys()].filter((id) => this.holds(id).has(pk)).sort();
    }
    /** Ids an admin deleted, newest last (the log's `delete` lines). */
    deleted: string[] = [];
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
        const holders = cur ? this.holds(cur.id) : new Set<string>();
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
            ...(this.copies ? { myCopy: ((c) => (c ? { seq: c.seq, headN: c.headN, headId: c.headId, savedAt: c.savedAt, digest: c.digest } : null))(this.copies.get(me)) } : {}),
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
        if (req.method === 'GET' && pathname === '/api/names/entries') return { status: 200, body: { current: this.current()?.id ?? null, entries: this.entries, confirmations: [], deleted: [...this.deleted].reverse() } };
        if (req.method === 'DELETE' && pathname.startsWith('/api/names/entries/')) {
            const id = pathname.split('/').pop()!;
            if (!this.entries.some((e) => e.id === id)) return err(404, 'no_entry');
            this.entries = this.entries.filter((e) => e.id !== id);
            this.deleted.push(id);
            this.log.push({ actor: who, action: 'delete', subject: null });
            return { status: 200, body: { id } };
        }
        if (req.method === 'GET' && pathname === '/api/names/log') return { status: 200, body: { log: [], total: 0 } };
        if (req.method === 'POST' && pathname === '/api/names/generations') {
            const g = readNamesGeneration(body, CID);
            if (!g) return err(400, 'bad_signature');
            if (this.gens.has(g.id)) return { status: 200, body: { id: g.id, n: g.n, code: 'exists' } };
            const cur = this.current();
            if ((g.parentId ?? null) !== (cur?.id ?? null) || g.n !== (cur ? cur.n + 1 : 1)) return err(409, 'stale');
            if (g.maker === who && body.replay !== true && cur) {
                const holders = [...this.holds(cur.id)].filter((k) => this.isAdmin(k));
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
        if (this.copies && req.method === 'PUT' && pathname === '/api/names/copy') {
            // As apps/server engine/names-list.ts saveNamesCopy: read, owner, exists, stale, upsert; no log line.
            const r = readNamesCopy(body);
            if (!r.ok) return err(400, 'bad_copy');
            const c = r.copy;
            if (c.owner !== who) return err(403, 'not_yours');
            const old = this.copies.get(who);
            if (old && old.header === c.header) return { status: 200, body: { seq: c.seq, code: 'exists' } };
            if (old && c.seq <= old.seq) return { status: 409, body: { error: 'stale_copy', code: 'stale_copy', seq: old.seq } };
            this.copies.set(who, { header: c.header, signature: c.signature, box: c.box, seq: c.seq, headN: c.headN, headId: c.headId, savedAt: c.savedAt, digest: c.boxDigest });
            return { status: 200, body: { seq: c.seq } };
        }
        if (this.copies && req.method === 'GET' && pathname === '/api/names/copy') {
            const c = this.copies.get(who);
            if (!c) return err(404, 'no_copy');
            this.log.push({ actor: who, action: 'copy_restored', subject: null });
            return { status: 200, body: { header: c.header, signature: c.signature, box: c.box } };
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
async function community(names = ['Owen', 'Ada'], copies = false): Promise<{ node: FakeNode; phones: BeanPoolIdentity[]; k1: string }> {
    const phones = await Promise.all(names.map((n) => admin(n)));
    const node = new FakeNode();
    if (copies) node.copies = new Map();
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
            // Addendum 4: on a non-empty chain the stop also offers Follow, said after the refusal.
            expect(planWords(o)).toBe(`${NAMES_COPY.refusedUntrusted(2, 'Zed')}\n\n${NAMES_COPY.followFromHere(2, false)}`); // nothing stands: no new key (J10)
            expect(o.plan).toMatchObject({ standing: false, canFollow: true });
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
        // The server stops hiding; Bea is on a different history. She follows the server's (asked; no check needed).
        node.views.delete(bea.publicKey);
        const b3 = await open(bea);
        expect(b3.plan).toEqual({ kind: 'refused', reason: 'different_history', canFollow: true });
        expect(planWords(b3)).toBe(NAMES_COPY.refusedDifferentNone); // Bea stands by no removal: no new key follows (J10)
        const t = await followServerHistory(COMMUNITY, bea, STORE);
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
        // Owen's phone dropped Cy: it sends nothing until they check each other, and the words say so (round 9).
        expect(planWords(c)).toBe(NAMES_COPY.holdersNoTrust(['Owen']));
        await meet(node, owen, cy);
        await open(owen);
        expect((await open(cy)).plan.kind).toBe('ready');
    });

    it("W2 (round 9) a holder whose phone no longer trusts this one is never said to send: Zed's role removed and given back; Owen's and Bea's phones (holders on their own word) dropped him, so Zed's phone says to meet one of them; after a check, the keys come", async () => {
        const { node, phones: [owen, bea, zed] } = await community(['Owen', 'Bea', 'Zed']);
        node.admins = [role(owen, 'owner'), role(bea)];
        await open(owen); // 2 drops Zed
        await open(bea);
        node.admins.push(role(zed)); // the role given back
        for (let i = 0; i < 3; i++) for (const p of [owen, bea]) await open(p);
        sent = [];
        const z = await open(zed);
        // Bea took key 2 from Owen's box and said so in her own header (round 11): both are holders on their own word.
        expect(z.plan).toMatchObject({ kind: 'wait', holders: [owen.publicKey, bea.publicKey] });
        expect(planWords(z)).toBe(NAMES_COPY.holdersNoTrust(['Owen', 'Bea']));
        expect(planWords(z)).not.toMatch(/will send/);
        // A locked entry under that key says the same.
        const k2 = node.current()!.id;
        const e = openEntries({ current: k2, entries: [{ ...node.entries[0], keyId: k2 }], confirmations: [] }, z)[0];
        expect(e.holders).toEqual([]);
        expect(e.notTrusting).toEqual(['Owen', 'Bea']);
        expect(NAMES_COPY.lockedEntry(2, 'Owen', e.holders, e.notTrusting)).toBe('Sealed with key 2 (made by @Owen). This phone doesn’t hold it. @Owen or @Bea hold it, but their phones don’t trust this one yet: check codes with one of them, on a call or in person.');
        expect(NAMES_COPY.lockedEntry(2, 'Owen', [], ['Owen'])).toBe('Sealed with key 2 (made by @Owen). This phone doesn’t hold it. @Owen holds it, but their phone doesn’t trust this one yet: check codes with @Owen, on a call or in person.');
        await meet(node, owen, zed);
        await open(owen);
        expect((await open(zed)).plan.kind).toBe('ready');
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
        expect(NAMES_COPY.removeKey('Ada')).toBe("Remove @Ada’s old key? The list gets a new key that @Ada’s old phone can’t read. If @Ada gets a new phone, check its code and this phone will send the keys.");
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

    it("H1 (the re-review's :628) a fork through an admin kept in the dark, then Follow the server's history: Cy's header re-admits nobody; Bea's phone makes a key without Abe before it writes, and says so; it never sends Abe anything, and Abe never gets the key Owen's name is under", async () => {
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
        // The node shows Bea Cy's branch. She follows the server's history (asked; no check in person needed).
        node.views.set(bea.publicKey, { admins: shown, quiet: true });
        const b = await open(bea);
        expect(b.plan).toEqual({ kind: 'refused', reason: 'different_history', canFollow: true });
        // W1 (round 7): Cy's box to Bea hasn't come yet when she takes his history. Cy's phone only sends the key; Bea's
        // phone makes the key without Abe, and the words say so.
        node.shares.delete(`${cy.publicKey}|${bea.publicKey}`);
        sent = [];
        const t = await followServerHistory(COMMUNITY, bea, STORE);
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
        // The node counts a holder on its own word (Addendum 4): Bea's first statement is refused (ask_for_share) until her
        // signed header to Cy (trusted, not dropped) says she holds the key; then it lands. Nothing went to Abe.
        const gens = sentAs('POST', '/api/names/generations');
        expect(gens.length).toBe(2);
        const claims = sentAs('POST', '/api/names/shares').filter((x) => sent.indexOf(x) > sent.indexOf(gens[0]) && sent.indexOf(x) < sent.indexOf(gens[1]));
        expect(claims.map((x) => readNamesShare(JSON.parse(x.body), CID)!.to)).toEqual([cy.publicKey]);
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

    it("I1 (the re-review's :639, end to end) a standby takes over from an older copy, Cy's phone makes 2″ by itself, Bea follows it; the main copy comes back: Cy and Bea follow it again, make their own keys where they stand by a drop, and are ready on one head with key 2 in their history; nothing goes to Abe", async () => {
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
        expect((await open(bea)).plan).toEqual({ kind: 'refused', reason: 'different_history', canFollow: true });
        const t1 = await followServerHistory(COMMUNITY, bea, STORE); // asked; no check needed (Addendum 3)
        expect(t1.ok && t1.value.plan.kind).toBe('ready');
        put(main); // whoever runs the server puts the main copy back
        expect((await open(owen)).plan.kind).toBe('ready');
        sent = [];
        for (const p of [cy, bea]) {
            expect((await open(p)).plan).toEqual({ kind: 'refused', reason: 'different_history', canFollow: true });
            expect((await followServerHistory(COMMUNITY, p, STORE)).ok).toBe(true);
        }
        // Each phone that stands by a drop the followed path lacks makes its own key; then all are ready on one head.
        for (let i = 0; i < 4; i++) for (const p of [owen, cy, bea]) await openNamesList(COMMUNITY, p, STORE);
        for (const p of [owen, cy, bea]) {
            const o = await open(p);
            expect(o.plan.kind).toBe('ready');
            expect(o.pin.chain[o.pin.chain.length - 1].id).toBe(node.current()!.id);
            expect(o.pin.chain.map((l) => l.id)).toContain(two);
            expect(o.pin.trusted).not.toContain(abe.publicKey);
            expect(openEntries(o.list!, o).every((e) => e.text)).toBe(true);
        }
        void twoPP;
        expect(sentAs('POST', '/api/names/shares').filter((x) => readNamesShare(JSON.parse(x.body), CID)?.to === abe.publicKey)).toEqual([]);
    });

    it("J1 (the re-review's :598, end to end) after Remove @Abe, following the server back to main keeps him removed: Bea's phone makes its own key without Abe and Zed, says so, and never sends Abe anything; Abe's lost phone gets neither key", async () => {
        const { node, phones: [owen, bea, dan, abe, zed] } = await community(['Owen', 'Bea', 'Dan', 'Abe', 'Zed']);
        const copy = () => ({ gens: new Map(node.gens), shares: new Map(node.shares) });
        const put = (c: ReturnType<typeof copy>) => { node.gens = new Map(c.gens); node.shares = new Map(c.shares); };
        const standby = copy();
        node.admins = [role(owen, 'owner'), role(bea), role(dan), role(zed)];
        await open(owen); // 2 drops Abe
        await open(bea);
        node.admins.push(role(abe)); // made an admin again; Owen checks him in person
        await meet(node, owen, abe);
        await open(owen);
        expect((await open(bea)).pin.trusted).toContain(abe.publicKey);
        const main = copy();
        put(standby); // the take-over; Zed removed there
        node.admins = [role(owen, 'owner'), role(bea), role(dan), role(abe)];
        expect((await open(dan)).plan.kind).toBe('ready');
        const twoPP = node.current()!.id;
        expect((await open(bea)).plan).toEqual({ kind: 'refused', reason: 'different_history', canFollow: true });
        expect((await followServerHistory(COMMUNITY, bea, STORE)).ok).toBe(true);
        // Abe's phone is lost: Bea taps Remove @Abe's old key.
        await removeOldKey(STORE, bea, COMMUNITY, abe.publicKey);
        const tap = sent.length;
        const r = await open(bea);
        const threePP = node.current()!.id;
        expect(node.current()!).toMatchObject({ maker: bea.publicKey, parentId: twoPP, drops: [abe.publicKey] });
        expect(r.notices[0]).toBe(NAMES_COPY.newKeyRemoved(['Abe']));
        expect((await saveNamesEntry(COMMUNITY, bea, STORE, r, { name: PLANTED[2], note: '' })).ok).toBe(true);
        // The main copy is back; Bea follows again.
        put(main);
        node.admins = [role(owen, 'owner'), role(bea), role(dan), role(zed), role(abe)];
        expect((await open(bea)).plan).toEqual({ kind: 'refused', reason: 'different_history', canFollow: true });
        const f = await followServerHistory(COMMUNITY, bea, STORE);
        expect(f.ok && f.value.plan.kind).toBe('ready');
        const three = node.current()!;
        expect(three).toMatchObject({ maker: bea.publicKey, drops: [abe.publicKey, zed.publicKey].sort() });
        expect(f.ok && f.value.notices.some((w) => w.startsWith('The list has a new key without') && w.includes('@Abe') && w.includes('@Zed') && w.includes('on a key history it has since left'))).toBe(true);
        expect(f.ok && f.value.pin.trusted).not.toContain(abe.publicKey);
        // Nothing from Bea to Abe after the tap; his lost phone holds neither key.
        expect(sent.slice(tap).filter((x) => x.method === 'POST' && new URL(x.url).pathname === '/api/names/shares'
            && x.headers['X-Public-Key'] === bea.publicKey && readNamesShare(JSON.parse(x.body), CID)?.to === abe.publicKey)).toEqual([]);
        const a = await open(abe);
        expect(a.pin.ring[threePP]).toBeUndefined();
        expect(a.pin.ring[three.id]).toBeUndefined();
        // Owen's phone takes Bea's key and drops Abe and Zed.
        const o = await open(owen);
        expect(o.pin.trusted).not.toContain(abe.publicKey);
    });

    it("J2 (the re-review's :707, end to end) Remove @Abe after he was made an admin again, with Owen's new header withheld from Bea: her phone makes a key without Abe before it writes; the header, shown later, lifts nothing", async () => {
        const { node, phones: [owen, bea, abe] } = await community(['Owen', 'Bea', 'Abe']);
        node.admins = [role(owen, 'owner'), role(bea)];
        await open(owen);
        await open(bea);
        const before = node.shares.get(`${owen.publicKey}|${bea.publicKey}`)!;
        node.admins.push(role(abe));
        await meet(node, owen, abe);
        await open(owen);
        const header = node.shares.get(`${owen.publicKey}|${bea.publicKey}`)!;
        const toAbe = node.shares.get(`${owen.publicKey}|${abe.publicKey}`)!;
        // Owen's new headers are withheld from Bea: hers, and the one to Abe that names him.
        node.shares.set(`${owen.publicKey}|${bea.publicKey}`, before);
        node.shares.delete(`${owen.publicKey}|${abe.publicKey}`);
        await removeOldKey(STORE, bea, COMMUNITY, abe.publicKey);
        sent = [];
        const r = await open(bea);
        // Bea said she holds key 2 in her own header when she took it (round 11's due rule): it lands at once.
        expect(sentAs('POST', '/api/names/generations').length).toBe(1);
        expect(sentAs('POST', '/api/names/shares').map((x) => readNamesShare(JSON.parse(x.body), CID)!.to)).not.toContain(abe.publicKey);
        expect(node.current()!).toMatchObject({ maker: bea.publicKey, n: 3, drops: [abe.publicKey] });
        expect(r.notices[0]).toBe(NAMES_COPY.newKeyRemoved(['Abe']));
        node.shares.set(`${owen.publicKey}|${bea.publicKey}`, header);
        node.shares.set(`${owen.publicKey}|${abe.publicKey}`, toAbe);
        const r2 = await open(bea);
        expect(r2.plan.kind).toBe('ready');
        expect(r2.pin.trusted).not.toContain(abe.publicKey);
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

describe('K. Addendum 4: Follow from a stop, holders on their own word, and names lost without a word (round 10)', () => {
    /** A copy of the node's rows a standby holds: statements, shares, entries and the delete lines. */
    const snapshot = (node: FakeNode) => ({
        gens: new Map(node.gens), shares: new Map(node.shares), entries: node.entries.map((e) => ({ ...e })), deleted: [...node.deleted], marks: new Set(node.marks),
    });
    const putBack = (node: FakeNode, c: ReturnType<typeof snapshot>) => {
        node.gens = new Map(c.gens); node.shares = new Map(c.shares); node.entries = c.entries.map((e) => ({ ...e })); node.deleted = [...c.deleted];
        node.marks = new Set(c.marks);
    };
    const toKey = (from: BeanPoolIdentity, to: BeanPoolIdentity) => sentAs('POST', '/api/names/shares')
        .filter((x) => x.headers['X-Public-Key'] === from.publicKey && readNamesShare(JSON.parse(x.body), CID)?.to === to.publicKey);

    it("K1/K3/K7 (the re-review's :774) Mia's key, which nobody trusted vouches, after her phone is lost: the card says why and offers Follow; while Mia is listed only an owner can unblock it; once she isn't, nobody holds her key on their own word and Bea makes a key without her; nothing to Mia", async () => {
        const { node, phones: [owen, bea, dan, mia, zed] } = await community(['Owen', 'Bea', 'Dan', 'Mia', 'Zed']);
        const standby = snapshot(node);
        node.admins = [role(owen, 'owner'), role(bea), role(dan), role(zed)];
        await open(owen); // 2 drops Mia
        await open(bea);
        await open(dan);
        putBack(node, standby);
        node.admins = [role(bea, 'owner'), role(dan), role(mia), role(zed)]; // Owen's phone lost
        await open(mia); // 2″ drops Owen
        for (const k of [...node.shares.keys()]) if (k.startsWith(`${mia.publicKey}|`)) node.shares.delete(k); // its boxes never land
        for (const p of [bea, dan]) {
            expect((await open(p)).plan).toMatchObject({ kind: 'refused', reason: 'different_history', canFollow: true });
            expect((await followServerHistory(COMMUNITY, p, STORE)).ok).toBe(true);
        }
        node.admins = [role(bea, 'owner'), role(dan), role(mia)]; // Zed removed
        await open(mia); // 3″ drops Zed; its boxes land
        const threePP = node.current()!.id;
        expect(node.current()!.maker).toBe(mia.publicKey);
        // K7: Mia's phone is lost but she is still listed: only an owner can unblock it.
        const k7 = await open(bea);
        expect(k7.plan).toMatchObject({ kind: 'refused', reason: 'untrusted_maker', maker: mia.publicKey, standing: true, canCheck: true, canFollow: true });
        expect(planWords(k7)).toBe(NAMES_COPY.refusedRemoved(3, 'Mia'));
        // Bea follows; Mia holds 3″ on her own word (she made it) and is listed.
        const f7 = await followServerHistory(COMMUNITY, bea, STORE);
        expect(f7.ok && f7.value.plan).toMatchObject({ kind: 'wait', holders: [], canMakeNew: false });
        expect(f7.ok && planWords(f7.value)).toBe(NAMES_COPY.waitRemovedHolder(['Mia'], 3));
        // A stale screen (Mia not listed in what it was shown) sends anyway: 409 ask_for_share, said.
        node.views.set(bea.publicKey, { admins: [role(bea, 'owner'), role(dan)] });
        const stale = await makeKeyOnThisPhone(COMMUNITY, bea, STORE);
        expect(stale.ok === false && stale.code).toBe('ask_for_share');
        expect(stale.ok === false && stale.message).toBe(NAMES_COPY.askForShare('Mia'));
        node.views.delete(bea.publicKey);
        // An owner removes Mia (K1): her key is held by nobody on their own word (K3), so Bea may make a new one.
        node.admins = [role(bea, 'owner'), role(dan)];
        node.former[mia.publicKey] = 'Mia'; // the node names every key its history names (a member's callsign)
        sent = [];
        const st = (await fetchNamesState(COMMUNITY, bea));
        expect(st.ok && st.value.holdersOfCurrent).toEqual([]);
        expect(st.ok && st.value.nobodyHoldsKey).toBe(true);
        expect(st.ok && st.value.admins.every((a) => !a.keyIds.includes(threePP))).toBe(true);
        const w = await open(bea);
        expect(w.plan).toMatchObject({ kind: 'wait', canMakeNew: true });
        expect(planWords(w)).toBe(NAMES_COPY.nobodyHoldsKey(3, 0, 'Mia'));
        const m = await makeKeyOnThisPhone(COMMUNITY, bea, STORE);
        expect(m.ok && m.value.plan.kind).toBe('ready');
        expect(node.current()!).toMatchObject({ maker: bea.publicKey, parentId: threePP, drops: [mia.publicKey] });
        // Dan follows from his own stop (or a header vouches 3″), then makes his own key without Mia.
        for (let i = 0; i < 4; i++) {
            const d = await open(dan);
            if (d.plan.kind === 'refused' && d.plan.canFollow) await followServerHistory(COMMUNITY, dan, STORE);
            await openNamesList(COMMUNITY, bea, STORE);
        }
        expect((await open(dan)).plan.kind).toBe('ready');
        expect(toKey(bea, mia)).toEqual([]);
        expect(toKey(dan, mia)).toEqual([]);
    });

    it("K8 (P1, the re-review's :472) names written on a followed branch, then the main copy put back: the ready read counts 3 seen and gone, no admin deleted them, and says so; copied back, they open with no notice", async () => {
        const { node, phones: [owen, bea, cy, abe] } = await community(['Owen', 'Bea', 'Cy', 'Abe']);
        const standby = snapshot(node);
        node.admins = [role(owen, 'owner'), role(bea), role(cy)];
        await open(owen);
        await open(bea);
        const main = snapshot(node);
        putBack(node, standby);
        await open(cy); // 2″ without Abe
        await open(bea);
        expect((await followServerHistory(COMMUNITY, bea, STORE)).ok).toBe(true);
        for (let i = 0; i < 3; i++) for (const p of [cy, bea]) await openNamesList(COMMUNITY, p, STORE);
        const b = await open(bea);
        expect(b.plan.kind).toBe('ready');
        for (const n of ['One', 'Two', 'Three']) expect((await saveNamesEntry(COMMUNITY, bea, STORE, b, { name: n, note: '' }, undefined, newEntryId())).ok).toBe(true);
        expect((await open(bea)).pin.seen.length).toBe(5);
        const written = node.entries.filter((e) => !main.entries.some((x) => x.id === e.id)).map((e) => ({ ...e }));
        putBack(node, main);
        expect((await open(bea)).plan).toMatchObject({ kind: 'refused', reason: 'different_history', canFollow: true });
        let f = await followServerHistory(COMMUNITY, bea, STORE);
        for (let i = 0; i < 3 && !(f.ok && f.value.plan.kind === 'ready'); i++) { await openNamesList(COMMUNITY, owen, STORE); f = await openNamesList(COMMUNITY, bea, STORE); }
        expect(f.ok && f.value.plan.kind).toBe('ready');
        expect(f.ok && f.value.notices).toContain(NAMES_COPY.lostEntries(3));
        expect(f.ok && f.value.lost).toBe(3);
        expect(f.ok && f.value.pin.seen.length).toBe(2);
        // Whoever runs the servers copies the three rows back: they open under the keys the phone kept.
        node.entries.push(...written);
        const back = await open(bea);
        expect(back.notices.some((w) => w.includes('aren’t on the server now') || w.includes('isn’t on the server now'))).toBe(false);
        expect(openEntries(back.list!, back).filter((e) => written.some((w) => w.id === e.id)).every((e) => e.text)).toBe(true);
        void abe;
    });

    it('K9/K10/K14 a take-over from a copy made before two names: with no key change the ready read says 2 lost; with a key changed the card estimates, and after Put the key history back the read says it exactly; a reinstalled phone says nothing, another phone does', async () => {
        for (const keyChange of [false, true]) {
            const { node, phones: [owen, bea, cy] } = await community(['Owen', 'Bea', 'Cy']);
            const copy = snapshot(node);
            if (keyChange) { await removeOldKey(STORE, owen, COMMUNITY, cy.publicKey); await open(owen); await meet(node, owen, cy); for (const p of [owen, cy, bea]) await open(p); }
            const b = await open(bea);
            // Only the screen's own calls: the adds, and no read after them (round 11: an add is seen when it lands).
            for (const n of ['One', 'Two']) expect((await saveNamesEntry(COMMUNITY, bea, STORE, b, { name: n, note: '' }, undefined, newEntryId())).ok).toBe(true);
            await open(cy);
            putBack(node, copy);
            let r = await open(bea);
            if (keyChange) {
                expect(r.plan).toMatchObject({ kind: 'refused', reason: 'rolled_back' });
                expect(r.notices).toContain(NAMES_COPY.lostSinceCopy(2));
                const p = await putHistoryBack(COMMUNITY, bea, STORE);
                expect(p.ok).toBe(true);
                r = p.ok ? p.value : r;
            }
            expect(r.plan.kind).toBe('ready');
            expect(r.notices).toContain(NAMES_COPY.lostEntries(2));
            expect(r.lost).toBe(2);
            if (!keyChange) {
                // K14: Bea reinstalls (an empty pin): her phone says nothing about the loss; Cy's does.
                mem.delete(namesTrustStoreKey(bea.publicKey, COMMUNITY));
                const re = await open(bea);
                expect(re.notices.some((w) => w.includes('on the server now'))).toBe(false);
                const c = await open(cy);
                expect(c.notices).toContain(NAMES_COPY.lostEntries(2));
            }
        }
    });

    it('K11/K12 honest deletes say nothing; a hidden entry is said, and a faked delete line hides it (the stated limit)', async () => {
        const { node, phones: [owen, bea, cy] } = await community(['Owen', 'Bea', 'Cy']);
        const b = await open(bea);
        for (const n of ['One', 'Two', 'Three']) await saveNamesEntry(COMMUNITY, bea, STORE, b, { name: n, note: '' }, undefined, newEntryId());
        await open(bea);
        const ids = node.entries.map((e) => e.id);
        // (a) Cy deletes an entry Bea saw.
        expect((await deleteNamesEntry(COMMUNITY, cy, ids[2], STORE)).ok).toBe(true);
        expect((await open(bea)).notices.some((w) => w.includes('on the server now'))).toBe(false);
        // (b) Bea deletes one herself: off `seen` at once.
        expect((await deleteNamesEntry(COMMUNITY, bea, ids[3], STORE)).ok).toBe(true);
        expect((await pinOf(bea))!.seen).not.toContain(ids[3]);
        expect((await open(bea)).notices.some((w) => w.includes('on the server now'))).toBe(false);
        // (c) a copy from before a delete, put back: the entry comes back; not a loss, nothing said.
        const before = snapshot(node);
        await deleteNamesEntry(COMMUNITY, cy, ids[4], STORE);
        await open(bea);
        putBack(node, before);
        expect((await open(bea)).notices.some((w) => w.includes('on the server now'))).toBe(false);
        // K12 (a) the server hides an entry Bea saw: said.
        const hidden = node.entries.find((e) => e.id === ids[0])!;
        node.entries = node.entries.filter((e) => e !== hidden);
        expect((await open(bea)).notices).toContain(NAMES_COPY.lostEntries(1));
        // (b) hidden again with a faked delete line: nothing said (availability; the log shows the line).
        node.entries.push(hidden);
        await open(bea);
        node.entries = node.entries.filter((e) => e.id !== hidden.id);
        node.deleted.push(hidden.id);
        expect((await open(bea)).notices.some((w) => w.includes('on the server now'))).toBe(false);
        void owen;
    });
});

describe('R. Round 11: the claim never vouches for a key being removed; adds are seen; holders say so; a fresh check', () => {
    const headersBy = (who: BeanPoolIdentity, from = 0) => sent.slice(from)
        .filter((x) => x.method === 'POST' && new URL(x.url).pathname === '/api/names/shares' && x.headers['X-Public-Key'] === who.publicKey)
        .map((x) => readNamesShare(JSON.parse(x.body), CID)!);

    it("R1 (the re-review's :432) Owen taps Remove @Xia; his next statement is refused (ask_for_share) and his claim goes out, then the second POST is lost: the claim vouches for nobody he is removing, Bea never trusts Xia, and no box ever reaches her", async () => {
        const { node, phones: [owen, bea, zed] } = await community(['Owen', 'Bea', 'Zed']);
        node.admins = [role(owen, 'owner'), role(bea)]; // Zed removed
        drop = (req) => (new URL(req.url).pathname === '/api/names/shares' && req.headers['X-Public-Key'] === bea.publicKey ? 'before' : null);
        await openNamesList(COMMUNITY, bea, STORE); // 2 without Zed; her box to Owen doesn't land
        drop = null;
        expect(node.current()!.maker).toBe(bea.publicKey);
        expect((await open(owen)).plan.kind).toBe('wait');
        const xia = await admin('Xia');
        node.admins.push(role(xia));
        await meet(node, owen, xia);
        expect((await open(owen)).plan.kind).toBe('wait'); // still waiting: it sends nothing
        expect((await pinOf(bea))!.trusted).not.toContain(xia.publicKey);
        // Xia's phone is stolen that day; Owen taps Remove @Xia's old key (her role isn't removed yet).
        await removeOldKey(STORE, owen, COMMUNITY, xia.publicKey);
        sent = [];
        await open(bea); // her box with key 2 reaches Owen
        let posts = 0;
        drop = (req) => {
            if (req.method !== 'POST' || new URL(req.url).pathname !== '/api/names/generations' || req.headers['X-Public-Key'] !== owen.publicKey) return null;
            posts++;
            return posts === 2 ? 'before' : null; // the retry after the claim is lost
        };
        await openNamesList(COMMUNITY, owen, STORE);
        drop = null;
        const claims = headersBy(owen);
        expect(claims.length).toBeGreaterThan(0);
        for (const h of claims) expect(h.trusts).not.toContain(xia.publicKey);
        await open(bea);
        expect((await pinOf(bea))!.trusted).not.toContain(xia.publicKey);
        await open(bea);
        expect([...node.shares.values()].filter((x) => x.to === xia.publicKey)).toEqual([]);
        // Owen's next open lands the key without Xia; still nothing to her.
        await open(owen);
        expect(node.current()!).toMatchObject({ maker: owen.publicKey, drops: [xia.publicKey] });
        for (const h of headersBy(owen)) expect(h.trusts).not.toContain(xia.publicKey);
        expect([...node.shares.values()].filter((x) => x.to === xia.publicKey)).toEqual([]);
    });

    it("R4a (the re-review's :889, words) a phone that took a key from a box says so in its own header: Dan, new, is told Ann holds the keys and sends them once her phone trusts his, not that nobody holds key 2; after Ann opens, the name under 2 opens", async () => {
        const { node, phones: [ann, owen, zed] } = await community(['Ann', 'Owen', 'Zed']);
        node.admins = [role(ann, 'owner'), role(owen)];
        const o = await open(owen); // 2 without Zed
        const two = node.current()!.id;
        expect((await saveNamesEntry(COMMUNITY, owen, STORE, o, { name: PLANTED[2], note: '' }, undefined, newEntryId())).ok).toBe(true);
        await open(ann); // takes 2 from Owen's box, and says so in a header
        node.admins = [role(ann, 'owner')]; // Owen leaves
        const dan = await admin('Dan');
        node.admins.push(role(dan));
        await meet(node, dan, ann);
        const d = await open(dan);
        expect(d.state.nobodyHoldsKey).toBe(false);
        expect(d.plan).toMatchObject({ kind: 'wait', canMakeNew: false });
        expect(planWords(d)).not.toMatch(/Nobody who is an admin now holds/);
        // Ann holds key 2 on her own word; Dan just checked her, and her phone hasn't said yet whether it trusts his (round 12).
        expect(planWords(d)).toBe(NAMES_COPY.holdersJustChecked(['Ann']));
        for (let i = 0; i < 2; i++) { await open(ann); await open(dan); }
        const d2 = await open(dan);
        expect(d2.plan.kind).toBe('ready');
        expect(openEntries(d2.list!, d2).find((e) => e.keyId === two)?.text?.name).toBe(PLANTED[2]);
        void zed;
    });

    it("R4b (the re-review's :889, two admins) Owen made the current key and his phone is lost; Bea taps Remove @Owen: her key without him lands at once, no owner needed", async () => {
        const { node, phones: [owen, bea, zed] } = await community(['Owen', 'Bea', 'Zed']);
        node.admins = [role(owen, 'owner'), role(bea)];
        await open(owen); // 2 without Zed
        await open(bea); // takes 2 from Owen's box, and says so in a header
        await removeOldKey(STORE, bea, COMMUNITY, owen.publicKey);
        sent = [];
        const b = await open(bea);
        expect(sentAs('POST', '/api/names/generations').length).toBe(1);
        expect(node.current()!).toMatchObject({ maker: bea.publicKey, drops: [owen.publicKey] });
        expect(b.plan.kind).toBe('ready');
        void zed;
    });

    it("R5 (the re-reviews' :642 and :696) right after Cy checks Owen, Cy's phone says only what it knows: Owen's phone sends the keys once it trusts this one, the next time it opens if they checked each other, else they meet; one way, the same words stay true; a re-admitted Cy is told to meet", async () => {
        // Both ways.
        {
            const { node, phones: [owen, ada] } = await community(['Owen', 'Ada']);
            const cy = await admin('Cy');
            node.admins.push(role(cy));
            await meet(node, cy, owen);
            const c = await open(cy);
            expect(c.plan).toMatchObject({ kind: 'wait' });
            expect(planWords(c)!.startsWith(NAMES_COPY.holdersJustChecked(['Owen']))).toBe(true);
            expect(planWords(c)).not.toMatch(/@Owen will send/);
            await open(owen);
            expect((await open(cy)).plan.kind).toBe('ready');
            void ada;
        }
        // One way: Cy scans Owen's code, Owen doesn't scan Cy's. Owen's phone never sends; Cy's words never say it will.
        {
            const { node, phones: [owen, ada] } = await community(['Owen', 'Ada']);
            const cy = await admin('Cy');
            node.admins.push(role(cy));
            expect((await checkEachOther(STORE, cy, COMMUNITY, node.stateFor(cy.publicKey), namesKeyQr(owen.publicKey))).ok).toBe(true);
            for (let i = 0; i < 4; i++) { await open(owen); await open(ada); }
            const c = await open(cy);
            expect(c.plan.kind).toBe('wait');
            expect(planWords(c)!.startsWith(NAMES_COPY.holdersJustChecked(['Owen']))).toBe(true);
            expect(planWords(c)).not.toMatch(/will send/);
        }
        // A re-admitted admin: Owen's key 2 dropped Cy; Cy's role is given back. One way, then both ways: the both-ways
        // sentence is true in each (round 13: a check both ways makes Owen's phone trust Cy again).
        for (const both of [false, true]) {
            const { node, phones: [owen, ada, cy] } = await community(['Owen', 'Ada', 'Cy']);
            node.admins = [role(owen, 'owner'), role(ada)];
            await open(owen); // 2 drops Cy
            await open(ada);
            node.admins.push(role(cy));
            await open(cy);
            if (both) await meet(node, cy, owen);
            else expect((await checkEachOther(STORE, cy, COMMUNITY, node.stateFor(cy.publicKey), namesKeyQr(owen.publicKey))).ok).toBe(true);
            const c = await open(cy);
            expect(c.plan.kind).toBe('wait');
            expect(planWords(c)!.startsWith(NAMES_COPY.holdersJustChecked(['Owen']))).toBe(true);
            expect(planWords(c)).not.toMatch(/will send/);
            if (both) {
                await open(owen);
                expect((await open(cy)).plan.kind).toBe('ready');
            }
        }
    });
});

describe('P. Round 12: one pin, one operation at a time; a claim to oneself', () => {
    /** Holds the next list read (GET /api/names/entries) by `who`, its answer already made: a reload on a slow connection. */
    const holdListRead = (who: BeanPoolIdentity) => {
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        let used = false;
        hold = (req) => {
            if (used || req.method !== 'GET' || new URL(req.url).pathname !== '/api/names/entries' || req.headers['X-Public-Key'] !== who.publicKey) return null;
            used = true;
            return gate;
        };
        return () => { hold = null; release(); };
    };
    const ticks = async (n = 60) => { for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0)); };

    it("P1 (the re-review's :533) Remove @Abe's old key tapped while the list reloads and its read is slow: the Remove still makes a key without Abe, and it stays in the ring", async () => {
        const { node, phones: [owen, ada, abe] } = await community(['Owen', 'Ada', 'Abe']);
        const k1 = node.current()!.id;
        const release = holdListRead(owen);
        const reload = openNamesList(COMMUNITY, owen, STORE); // the screen's load(), its read held back
        await ticks();
        // Abe's phone is stolen: Owen taps Remove and confirms; the screen's removeKey runs removeOldKey, then an open.
        const remove = (async () => { await removeOldKey(STORE, owen, COMMUNITY, abe.publicKey); return openNamesList(COMMUNITY, owen, STORE); })();
        await ticks();
        release();
        const [r1, r2] = await Promise.all([reload, remove]);
        expect(r1.ok && r2.ok).toBe(true);
        const cur = node.current()!;
        expect(cur.id).not.toBe(k1);
        expect(cur).toMatchObject({ maker: owen.publicKey, drops: [abe.publicKey] });
        const pin = (await pinOf(owen))!;
        expect(pin.manualDrops).toEqual([]);
        expect(pin.dropped[abe.publicKey]).toBe(cur.id);
        expect(pin.ring[cur.id]).toBeDefined();
        expect(pin.trusted).not.toContain(abe.publicKey);
        void ada;
    });

    it('P2 a check in person made while the list reloads stays in the pin', async () => {
        const { node, phones: [owen] } = await community(['Owen', 'Ada']);
        const cy = await admin('Cy');
        node.admins.push(role(cy));
        const release = holdListRead(owen);
        const reload = openNamesList(COMMUNITY, owen, STORE);
        await ticks();
        const check = checkEachOther(STORE, owen, COMMUNITY, node.stateFor(owen.publicKey), namesKeyQr(cy.publicKey));
        await ticks();
        release();
        const [, c] = await Promise.all([reload, check]);
        expect(c.ok).toBe(true);
        expect((await pinOf(owen))!.trusted).toContain(cy.publicKey);
    });

    it("P3 a name added while the list reloads stays in `seen`, so a take-over that loses it is said", async () => {
        const { node, phones: [owen] } = await community(['Owen', 'Ada']);
        const copy = { gens: new Map(node.gens), shares: new Map(node.shares), entries: node.entries.map((e) => ({ ...e })) };
        const o = await open(owen);
        const release = holdListRead(owen);
        const reload = openNamesList(COMMUNITY, owen, STORE);
        await ticks();
        const addId = newEntryId();
        const add = saveNamesEntry(COMMUNITY, owen, STORE, o, { name: PLANTED[2], note: '' }, undefined, addId);
        await ticks();
        release();
        const [, a] = await Promise.all([reload, add]);
        expect(a.ok).toBe(true);
        expect((await pinOf(owen))!.seen).toContain(addId);
        node.gens = copy.gens; node.shares = copy.shares; node.entries = copy.entries; // a take-over from an older copy
        expect((await open(owen)).notices).toContain(NAMES_COPY.lostEntries(1));
    });

    it('P5 the screen starts no action while the list loads, runs no load while an action runs, and keeps its buttons off during a reload', () => {
        const screen = fs.readFileSync(path.join(__dirname, '../../app/names-list.tsx'), 'utf8');
        expect(screen).toMatch(/const load = useCallback\(async \(\) => \{\n\s+if \(loadingRef\.current \|\| busyRef\.current \|\| !identity\) return;/);
        expect(screen).toMatch(/if \(loadingRef\.current \|\| busyRef\.current\) return false;/);
        expect(screen).toMatch(/const off = busy \|\| loading;/);
        expect(screen).toMatch(/disabled=\{off\}/);
        expect(screen).not.toMatch(/disabled=\{busy\}/);
        expect(screen).not.toMatch(/setBusy\(true\);\n(?![\s\S]{0,40}return true)/);
    });

    it("P4 (the re-review's :467, Addendum 5) two admins, Remove on a screen opened before Owen's last key: Bea's only claim is a header to herself, and her key without Owen lands on the first open", async () => {
        const { node, phones: [owen, bea, zed] } = await community(['Owen', 'Bea', 'Zed']);
        await open(bea); // Bea's names list is open (and stays on screen)
        node.admins = [role(owen, 'owner'), role(bea)]; // Zed's role removed
        await open(owen); // 2 without Zed; its box to Bea lands
        const two = node.current()!.id;
        // Owen's phone is lost; he is the only owner. Bea taps Remove on the screen she had open: no reload in between.
        await removeOldKey(STORE, bea, COMMUNITY, owen.publicKey);
        sent = [];
        const b = await open(bea);
        const self = sentAs('POST', '/api/names/shares').map((x) => readNamesShare(JSON.parse(x.body), CID)!).filter((x) => x.to === bea.publicKey);
        expect(self.length).toBe(1);
        expect(self[0]).toMatchObject({ from: bea.publicKey, to: bea.publicKey });
        expect(self[0].keyIds).toContain(two);
        expect(self[0].trusts).not.toContain(owen.publicKey);
        expect(sentAs('POST', '/api/names/shares').map((x) => readNamesShare(JSON.parse(x.body), CID)!.to)).not.toContain(owen.publicKey);
        expect(node.current()!).toMatchObject({ maker: bea.publicKey, parentId: two, drops: [owen.publicKey] });
        expect(b.plan.kind).toBe('ready');
        void zed;
    });
});

describe('J10. Round 13: the card promises a new key only when a removal will stand after the follow', () => {
    it("J10 (the re-review's :1194) Bea removed nobody of her own; Abe's drop is on the shared history: the card doesn't promise a new key, and none is made", async () => {
        const { node, phones: [owen, ada, abe, bea] } = await community(['Owen', 'Ada', 'Abe', 'Bea']);
        node.admins = [role(owen, 'owner'), role(ada), role(bea)];
        await open(owen); // 2 drops Abe
        const two = node.current()!.id;
        for (const p of [ada, bea, owen]) await open(p);
        // Owen's key 3 (Bea takes it), then the server's current becomes Ada's 3″ off 2.
        const m3 = makeNamesGeneration({ communityId: CID, n: 3, parentId: two, drops: [] }, owen);
        node.put(m3);
        node.head = m3.id;
        const k3 = newNamesListKey();
        await writeNamesPinTo(STORE, owen.publicKey, COMMUNITY, { ...(await pinOf(owen))!, pending: { statement: m3.statement, signature: m3.signature, id: m3.id, n: 3, key: bytesToHex(k3) } });
        await open(owen);
        await open(bea);
        const m3pp = makeNamesGeneration({ communityId: CID, n: 3, parentId: two, drops: [] }, ada);
        node.put(m3pp);
        node.head = m3pp.id;
        const k3pp = newNamesListKey();
        await writeNamesPinTo(STORE, ada.publicKey, COMMUNITY, { ...(await pinOf(ada))!, pending: { statement: m3pp.statement, signature: m3pp.signature, id: m3pp.id, n: 3, key: bytesToHex(k3pp) } });
        await open(ada);
        const b = await open(bea);
        expect(b.plan).toMatchObject({ kind: 'refused', reason: 'different_history', canFollow: true });
        expect(planWords(b)).toBe(NAMES_COPY.refusedDifferentNone);
        expect(followRemovesAny(b)).toBe(false); // the Follow question's condition, the same as the card's
        await followServerHistory(COMMUNITY, bea, STORE);
        await open(ada);
        expect((await open(bea)).plan.kind).toBe('ready');
        expect([...node.gens.values()].filter((g) => g.maker === bea.publicKey)).toEqual([]);
    });
});

describe('Q. Round 13: no request waits for good; a write decides from the pin', () => {
    const never = () => new Promise<void>(() => { /* a request that never answers */ });
    afterEach(() => setNamesRequestTimeout(NAMES_REQUEST_TIMEOUT_MS));

    it("Q1 (the re-review's :236) a reload whose state request never answers: after the time limit it fails as no connection, and a Remove and a new open run and make a key without Abe", async () => {
        const { node, phones: [owen, ada, abe] } = await community(['Owen', 'Ada', 'Abe']);
        const k1 = node.current()!.id;
        setNamesRequestTimeout(150);
        let stuck = false;
        hold = (req) => {
            if (stuck || req.method !== 'GET' || new URL(req.url).pathname !== '/api/names/state' || req.headers['X-Public-Key'] !== owen.publicKey) return null;
            stuck = true;
            return never();
        };
        const reload = await openNamesList(COMMUNITY, owen, STORE); // the screen's load(): settles, so `loading` clears
        expect(reload.ok === false && reload.status).toBe(0);
        hold = null;
        expect(await removeOldKey(STORE, owen, COMMUNITY, abe.publicKey)).toBe(true);
        const o = await open(owen);
        expect(o.plan.kind).toBe('ready');
        expect(node.current()!).toMatchObject({ maker: owen.publicKey, parentId: k1, drops: [abe.publicKey] });
        void ada;
    });

    it('Q2 a name added while a reload is stuck: the add settles and its id reaches `seen`', async () => {
        const { node, phones: [owen] } = await community(['Owen', 'Ada']);
        const o = await open(owen);
        setNamesRequestTimeout(150);
        let stuck = false;
        hold = (req) => {
            if (stuck || req.method !== 'GET' || new URL(req.url).pathname !== '/api/names/entries') return null;
            stuck = true;
            return never();
        };
        const reload = openNamesList(COMMUNITY, owen, STORE);
        const addId = newEntryId();
        const added = await saveNamesEntry(COMMUNITY, owen, STORE, o, { name: PLANTED[2], note: '' }, undefined, addId);
        await reload;
        hold = null;
        expect(added.ok).toBe(true);
        expect(node.entries.some((e) => e.id === addId)).toBe(true);
        expect((await pinOf(owen))!.seen).toContain(addId);
    });

    for (const how of ['no connection', 'a 502 from a proxy', "the new key's POST lost"] as const) {
        it(`Q3 (the re-review's :859) Remove @Abe, its re-open fails (${how}), then a name added from the list still on screen: nothing is sealed under key 1; the words say why; once the list opens, the name goes under a key without Abe`, async () => {
            const { node, phones: [owen, ada, abe] } = await community(['Owen', 'Ada', 'Abe']);
            const k1 = node.current()!.id;
            const onScreen = await open(owen); // ready under key 1
            await removeOldKey(STORE, owen, COMMUNITY, abe.publicKey);
            if (how === 'no connection') drop = (req) => (new URL(req.url).pathname === '/api/names/state' ? 'before' : null);
            if (how === 'a 502 from a proxy') answer = (req) => (new URL(req.url).pathname === '/api/names/state' ? { status: 502 } : node.answer(req));
            if (how === "the new key's POST lost") drop = (req) => (new URL(req.url).pathname === '/api/names/generations' ? 'before' : null);
            const reopen = await openNamesList(COMMUNITY, owen, STORE);
            expect(reopen.ok).toBe(false);
            drop = null;
            answer = (req) => node.answer(req);
            expect(node.current()!.id).toBe(k1);
            sent = [];
            const r = await saveNamesEntry(COMMUNITY, owen, STORE, onScreen, { name: PLANTED[2], note: '' }, undefined, newEntryId());
            expect(r.ok).toBe(false);
            expect(r.ok === false && r.message).toBe(NAMES_COPY.stillRemoving(['Abe']));
            expect(sentAs('POST', '/api/names/entries')).toEqual([]);
            expect(node.entries.filter((e) => e.keyId === k1).length).toBe(2); // only the two planted before
            // The connection is back: the list opens, makes the key without Abe, and the name goes under it.
            const o = await open(owen);
            expect(node.current()!).toMatchObject({ drops: [abe.publicKey] });
            const r2 = await saveNamesEntry(COMMUNITY, owen, STORE, o, { name: PLANTED[2], note: '' }, undefined, newEntryId());
            expect(r2.ok && r2.value.keyId).toBe(node.current()!.id);
            void ada;
        });
    }

    it('Q4 the screen shows the state the pin is in after an action fails: a stale ready list is not offered, and its add/change buttons go', () => {
        const screen = fs.readFileSync(path.join(__dirname, '../../app/names-list.tsx'), 'utf8');
        expect(screen).toMatch(/pendingRemovals\(/);
        expect(screen).toMatch(/plan\?\.kind === 'ready' && state && opened && !stale/);
        expect(screen).toMatch(/COPY\.reloading/);
        // sendAgain and save always clear busy.
        expect(screen).toMatch(/const sendAgain = async[\s\S]{0,400}finally \{\s*finish\(\);/);
        expect(screen).toMatch(/const save = async[\s\S]{0,500}finally \{\s*finish\(\);/);
    });

    it('Q5 no link waits on anything but a bounded request: the device store asks for no authentication', () => {
        const src = fs.readFileSync(path.join(__dirname, '../names-list.ts'), 'utf8');
        expect(src).not.toMatch(/requireAuthentication/);
        expect(NAMES_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    });
});

describe('S. Round 14: one check per statement and header per state', () => {
    it("S1 (the re-review's :812; round 15: counted, not timed) drawing 1,000 locked entries in a community of 8 admins and 30 keys checks each statement and header once per state, however many entries are drawn", async () => {
        const admins = await Promise.all(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((n) => admin(n)));
        const gens: NamesGeneration[] = [];
        const ring: Record<string, Uint8Array> = {};
        for (let n = 1; n <= 30; n++) {
            const g = makeNamesGeneration({ communityId: CID, n, parentId: n === 1 ? null : gens[n - 2].id, drops: [] }, admins[n % 8]);
            gens.push(g);
            ring[g.id] = newNamesListKey();
        }
        const head = gens[gens.length - 1];
        const shares: NamesShare[] = [];
        for (const from of admins) for (const to of admins) {
            if (from === to) continue;
            shares.push(makeNamesShare({ communityId: CID, from, to: to.publicKey, headId: head.id, ring, trusts: admins.map((a) => a.publicKey) }));
        }
        const me = admins[0];
        /**
         * A fresh state as an open receives it, counting what the draw reads (round 15: a count holds at any load, a
         * stopwatch doesn't): each record's signature is read once per check of that record (readNamesGeneration and
         * readNamesShare each read it once), and the state's two lists once per pass over them.
         */
        const counted = () => {
            const reads = { generations: 0, shares: 0, checks: new Map<string, number>() };
            const tally = <T extends { signature: string }>(r: T, key: string): T => Object.defineProperty({ ...r }, 'signature', {
                enumerable: true, get: () => { reads.checks.set(key, (reads.checks.get(key) ?? 0) + 1); return r.signature; },
            });
            const generations = gens.map((g) => tally({ statement: g.statement, signature: g.signature, id: g.id, n: g.n, parentId: g.parentId, maker: g.maker, drops: g.drops }, `gen:${g.id}`));
            const shareRows = shares.map((x) => tally({ header: x.header, signature: x.signature, from: x.from, to: x.to, headId: x.headId, keyIds: x.keyIds, trusts: x.trusts }, `share:${x.from}|${x.to}`));
            const state = {
                communityId: CID, current: { id: head.id, n: head.n },
                get generations() { reads.generations++; return generations; },
                get shares() { reads.shares++; return shareRows; },
                admins: admins.map((a) => ({ pubkey: a.publicKey, callsign: a.callsign, role: 'admin' as const, keyIds: gens.map((g) => g.id), holdsCurrent: true })),
                holdersOfCurrent: admins.map((a) => a.publicKey), droppedHolders: [], nobodyHoldsKey: false, newKeyNeeded: false, callsigns: {},
                settings: { twoAdminsToConfirm: false, namesShownToMembers: false },
                counts: { entries: 1000, confirmed: 0, awaitingSecond: 0, byKey: {}, locked: 0 },
                me: { pubkey: me.publicKey, role: 'admin' as const, owner: false },
            } as unknown as NamesState;
            const total = () => ({ generations: reads.generations, shares: reads.shares, checks: [...reads.checks.values()].reduce((a, b) => a + b, 0) });
            return { state, reads, total };
        };
        const pin = { ...emptyNamesPin(CID, me.publicKey), trusted: admins.map((a) => a.publicKey).sort() };
        const entries: SealedEntryRow[] = Array.from({ length: 1000 }, (_, i) => ({
            id: newNamesEntryId(), ciphertext: 'sealed', keyId: gens[i % 30].id, createdBy: me.publicKey, createdAt: '2026-10-02', updatedBy: null, updatedAt: '',
        }));
        const draw = (state: NamesState, n: number) => openEntries({ current: head.id, entries: entries.slice(0, n), confirmations: [] }, { ring: {}, pin, generations: new Map(), state, justChecked: [] });
        // One draw of one entry: every statement and every header checked exactly once.
        const one = counted();
        expect(draw(one.state, 1)[0].holders.length).toBe(7);
        expect(one.reads.checks.size).toBe(gens.length + shares.length); // 30 statements and 56 headers
        expect([...one.reads.checks.values()].every((c) => c === 1)).toBe(true);
        // 10 entries, then 1,000, each on a fresh state: the same count, not one per entry (a49088a3: one per entry).
        const ten = counted();
        draw(ten.state, 10);
        expect(ten.total()).toEqual(one.total());
        const all = counted();
        const drawn = draw(all.state, 1000);
        expect(drawn.length).toBe(1000);
        expect(drawn.every((e) => e.locked === 'no_key' && e.holders.length === 7)).toBe(true);
        expect(all.total()).toEqual(one.total());
        // The same state drawn again, and the refusal card's words: nothing is read or checked again.
        draw(all.state, 1000);
        planWords({ plan: { kind: 'wait', keyId: head.id, n: 30, holders: admins.slice(1).map((a) => a.publicKey), newKeyNeeded: false, canMakeNew: false, drops: [] }, state: all.state, pin, justChecked: [] });
        expect(all.total()).toEqual(one.total());
        expect([...all.reads.checks.values()].every((c) => c === 1)).toBe(true);
    }, 30_000);
});

describe('T. Round 14: limits that fit the request, one limit per open, notices kept, a true Follow question', () => {
    const never = () => new Promise<void>(() => { /* never answers */ });
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    /** True once `ok()` holds, checked every 5 ms; false after 5 s (a bound for a failure to read as one, never a measure). */
    const until = async (ok: () => boolean): Promise<boolean> => {
        for (let i = 0; i < 1000; i++) { if (ok()) return true; await sleep(5); }
        return ok();
    };
    afterEach(() => setNamesRequestTimeout(NAMES_REQUEST_TIMEOUT_MS));

    it("T1 (the re-review's :147) a list read slower than a small request's limit but still arriving completes; and a Remove tapped during it isn't held up", async () => {
        const { node, phones: [owen, ada, abe] } = await community(['Owen', 'Ada', 'Abe']);
        // Limits far from what an answered request takes on a busy runner (round 15): 1 s for a small request, and the
        // list's 1 s + 1.5 s per entry (2 entries: 4 s). The read is held 1.25 s: past the small limit, inside its own.
        setNamesRequestTimeout(1000, { listPerEntryMs: 1500 });
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        let used = false;
        hold = (req) => {
            if (used || req.method !== 'GET' || new URL(req.url).pathname !== '/api/names/entries') return null;
            used = true;
            return gate;
        };
        const opening = openNamesList(COMMUNITY, owen, STORE);
        expect(await until(() => used)).toBe(true); // the list read is out, and held
        // The slow read holds no pin operation: the Remove settles while the read is still held (round 15: an order, not
        // a stopwatch; were the read on the pin's chain, the Remove would wait for the release, and the 5 s bound is only
        // there so that failure reads as one).
        const removing = removeOldKey(STORE, owen, COMMUNITY, abe.publicKey);
        expect(await Promise.race([removing, sleep(5000).then(() => 'still held')])).toBe(true);
        await sleep(1250); // slower than the 1 s small-request limit
        release();
        const o = await opening;
        expect(o.ok && o.value.plan.kind).toBe('ready');
        expect(o.ok && o.value.list?.entries.length).toBe(2);
        expect((await pinOf(owen))!.manualDrops).toEqual([abe.publicKey]); // the Remove survives the read's save
        void node; void ada;
    }, 30_000);

    it("T2 (the re-review's :584; round 15: counted, not timed) the connection stops answering partway through an open that owes three shares: the open lets go one request (the first share) and reads no list, so a Remove tapped during it waits one limit, not four", async () => {
        const { node, phones: [owen, ada, bea, cy, zed] } = await community(['Owen', 'Ada', 'Bea', 'Cy', 'Zed']);
        node.admins = node.admins.filter((a) => a.pubkey !== zed.publicKey); // Owen's open makes key 2 and owes 3 shares
        // 2 s limits (round 15): far above what an answered request takes on a busy runner, so only the requests the
        // connection never answers are let go, and those are counted.
        setNamesRequestTimeout(2000, { stateMs: 2000, listPerEntryMs: 0 });
        let stateReads = 0;
        /** Owen's requests the connection never answered, each let go at its limit. */
        const letGo: string[] = [];
        const stop = (req: Sent) => { letGo.push(`${req.method} ${new URL(req.url).pathname}`); return never(); };
        hold = (req) => {
            if (req.headers['X-Public-Key'] !== owen.publicKey) return null;
            if (req.method === 'GET' && new URL(req.url).pathname === '/api/names/state') { stateReads++; return stateReads > 2 ? stop(req) : null; }
            return stateReads >= 2 && new URL(req.url).pathname !== '/api/names/generations' ? stop(req) : null;
        };
        const opening = openNamesList(COMMUNITY, owen, STORE);
        await sleep(20);
        expect(await removeOldKey(STORE, owen, COMMUNITY, ada.publicKey)).toBe(true); // queued behind the open's link
        const o = await opening;
        hold = null;
        expect(o.ok === false && o.status).toBe(0);
        expect(letGo).toEqual(['POST /api/names/shares']); // a49088a3: three shares, then GET /api/names/entries
        expect(o.ok === false && o.code).toBe(NAMES_TIMED_OUT);
        expect(node.current()!).toMatchObject({ maker: owen.publicKey, drops: [zed.publicKey] }); // key 2 landed first
        expect((await pinOf(owen))!.manualDrops).toEqual([ada.publicKey]);
        void bea; void cy;
    }, 30_000);

    it("T3 (the re-review's :890, C7 with a save first) the walk's notices aren't lost when a save is the first to see a new key: the next open says them", async () => {
        const { phones: [owen, ada, bea] } = await community(['Owen', 'Ada', 'Bea']);
        const b = await open(bea); // Bea's list is open
        await removeOldKey(STORE, ada, COMMUNITY, owen.publicKey);
        await removeOldKey(STORE, ada, COMMUNITY, bea.publicKey);
        await open(ada); // Ada's key 2 drops Owen and Bea
        const r = await saveNamesEntry(COMMUNITY, bea, STORE, b, { name: PLANTED[2], note: '' }, undefined, newEntryId());
        expect(r.ok).toBe(false);
        const next = await open(bea);
        expect(next.notices).toContain(NAMES_COPY.droppedMe('Ada'));
        expect(next.notices).toContain(NAMES_COPY.newKeyBy('Ada', ['Owen']));
        // Said once: the open after it doesn't say them again.
        expect((await open(bea)).notices).not.toContain(NAMES_COPY.droppedMe('Ada'));
    });

    it("T4 (the re-review's :1204) the Follow question promises a key of its own only when a removal will still stand", () => {
        const screen = fs.readFileSync(path.join(__dirname, '../../app/names-list.tsx'), 'utf8');
        expect(screen).toMatch(/followRemovesAny\(opened\) \? COPY\.follow : COPY\.followNone/);
        expect(NAMES_COPY.followNone.replace(/’/g, "'")).toBe("This phone follows the key history the server shows, from the last key both share. It keeps the keys it holds, reads with them and passes them on to the admins it trusts, but never writes under them again unless the server's history comes back to them.");
    });
});

describe('U. Round 15: notices kept until said, one limit for a claim, a pin read that fails never saves or wipes', () => {
    const never = () => new Promise<void>(() => { /* never answers */ });
    afterEach(() => setNamesRequestTimeout(NAMES_REQUEST_TIMEOUT_MS));
    const times = (said: string[], w: string) => said.filter((x) => x === w).length;

    for (const how of ['the open works (control)', 'its list read answers 502', 'its list read runs out of time', 'its share to Owen runs out of time'] as const) {
        it(`U1 (the re-review's :598) notices a save kept are said once, on the first open that works: ${how}`, async () => {
            const { node, phones: [owen, ada, cy] } = await community(['Owen', 'Ada', 'Cy']);
            const onScreen = await open(ada); // Ada's list is open, under key 1
            node.admins = node.admins.filter((a) => a.pubkey !== cy.publicKey);
            await open(owen); // key 2 drops Cy and goes to Ada
            node.admins = [...node.admins, role(cy)]; // Cy's role comes back
            const saved = await saveNamesEntry(COMMUNITY, ada, STORE, onScreen, { name: PLANTED[2], note: '' }, undefined, newEntryId());
            expect(saved.ok && saved.value.keyId).toBe(node.current()!.id); // under key 2; the save's look kept the walk's words
            const words = [NAMES_COPY.newKeyBy('Owen', ['Cy']), NAMES_COPY.checkAgain('Cy', 2)];
            setNamesRequestTimeout(1000, { stateMs: 1000, listPerEntryMs: 0 });
            let failing = how !== 'the open works (control)';
            /** The requests made to fail, as each case means them to. */
            const hit: string[] = [];
            const mine = (req: Sent, method: string, p: string) => {
                const is = failing && req.headers['X-Public-Key'] === ada.publicKey && req.method === method && new URL(req.url).pathname === p;
                if (is) hit.push(`${method} ${p}${method === 'POST' ? ` to ${JSON.parse(req.body).header.split('\n')[3] === owen.publicKey ? 'Owen' : '?'}` : ''}`);
                return is;
            };
            answer = (req) => (how === 'its list read answers 502' && mine(req, 'GET', '/api/names/entries') ? { status: 502 } : node.answer(req));
            hold = (req) => ((how === 'its list read runs out of time' && mine(req, 'GET', '/api/names/entries'))
                // Ada's next open owes Owen a header: she took key 2 from his box and has sent none since.
                || (how === 'its share to Owen runs out of time' && mine(req, 'POST', '/api/names/shares')) ? never() : null);
            const first = await openNamesList(COMMUNITY, ada, STORE);
            expect(hit).toEqual(({
                'the open works (control)': [], 'its list read answers 502': ['GET /api/names/entries'],
                'its list read runs out of time': ['GET /api/names/entries'], 'its share to Owen runs out of time': ['POST /api/names/shares to Owen'],
            } as const)[how]);
            failing = false;
            answer = (req) => node.answer(req);
            hold = null;
            if (how === 'the open works (control)') {
                expect(first.ok).toBe(true);
                for (const w of words) expect(first.ok && times(first.value.notices, w)).toBe(1);
            } else {
                expect(first.ok).toBe(false); // nothing said: f8d11de4 lost them here, said 0 times on this open and the next
                const next = await open(ada);
                for (const w of words) expect(times(next.notices, w)).toBe(1);
            }
            // Said once: the open after that doesn't say them again.
            const after = await open(ada);
            for (const w of words) expect(times(after.notices, w)).toBe(0);
        }, 30_000);
    }

    for (const how of ['its list read answers 502', "its new key's POST is lost"] as const) {
        it(`U2 (the re-review's :598, the Follow's own words) a Follow whose open then fails (${how}): what the Follow dropped is said on the next open, once`, async () => {
            const { node, phones: [owen, bea, zed, cy] } = await community(['Owen', 'Bea', 'Zed', 'Cy']);
            const standby = { gens: new Map(node.gens), shares: new Map(node.shares) };
            node.admins = [role(owen, 'owner'), role(bea), role(zed)];
            await open(owen); // main: 2 drops Cy
            expect((await open(bea)).plan.kind).toBe('ready');
            // The standby takes over from a copy made before that, with Owen gone there: Zed's 2′ drops Owen.
            node.gens = new Map(standby.gens); node.shares = new Map(standby.shares); node.marks = new Set();
            node.admins = [role(bea, 'owner'), role(zed), role(cy)];
            node.former[owen.publicKey] = 'Owen';
            expect((await open(zed)).plan.kind).toBe('ready');
            expect(node.current()!).toMatchObject({ maker: zed.publicKey, drops: [owen.publicKey] });
            expect((await open(bea)).plan).toEqual({ kind: 'refused', reason: 'different_history', canFollow: true });
            const word = NAMES_COPY.newKeyBy('Zed', ['Owen']);
            let failing = true;
            if (how === 'its list read answers 502') {
                answer = (req) => (failing && new URL(req.url).pathname === '/api/names/entries' ? { status: 502 } : node.answer(req));
            } else {
                drop = (req) => (failing && req.method === 'POST' && new URL(req.url).pathname === '/api/names/generations' ? 'before' : null);
            }
            // The Follow is saved; then Bea's phone makes its own key without Cy (a removal on the history it left).
            const f = await followServerHistory(COMMUNITY, bea, STORE);
            expect(f.ok).toBe(false); // nothing was said
            failing = false;
            const next = await open(bea);
            expect(times(next.notices, word)).toBe(1); // f8d11de4: 0
            // Said once. (A lost POST's statement is sent again, refused `ask_for_share`, and made afresh with a claim on
            // the open after: the key lands there.)
            const later = [await open(bea), await open(bea)];
            for (const o of later) expect(times(o.notices, word)).toBe(0);
            expect(later[1].plan.kind).toBe('ready');
            expect(node.current()!).toMatchObject({ maker: bea.publicKey, drops: [cy.publicKey] });
        }, 30_000);
    }

    for (const to of ['Ada (a trusted admin)', 'herself (Addendum 5)'] as const) {
        it(`U3 (the re-review's :574) a claim to ${to} that runs out of time stops the open: one request let go, no second state read; the next open makes the key`, async () => {
            const names = to === 'herself (Addendum 5)' ? ['Owen', 'Bea', 'Zed'] : ['Owen', 'Ada', 'Bea', 'Zed'];
            const { node, phones } = await community(names);
            const [owen, bea, zed] = [phones[0], phones[names.indexOf('Bea')], phones[names.indexOf('Zed')]];
            const ada = to === 'herself (Addendum 5)' ? null : phones[1];
            if (to === 'herself (Addendum 5)') await open(bea); // P4: the screen Bea taps Remove on was opened before key 2
            node.admins = node.admins.filter((a) => a.pubkey !== zed.publicKey);
            await open(ada ?? owen); // key 2 drops Zed and goes to the others
            const two = node.current()!.id;
            await removeOldKey(STORE, bea, COMMUNITY, owen.publicKey); // Bea's open makes key 3 without Owen
            setNamesRequestTimeout(2000, { stateMs: 2000, listPerEntryMs: 0 });
            /** Bea's statement, refused `ask_for_share` (she holds key 2 only on a box Ada sent): after it, nothing answers. */
            let refused: Sent | null = null;
            const letGo: string[] = [];
            answer = (req) => {
                const a = node.answer(req);
                if (req.headers['X-Public-Key'] === bea.publicKey && req.method === 'POST' && new URL(req.url).pathname === '/api/names/generations' && a.status === 409) refused = req;
                return a;
            };
            hold = (req) => {
                if (!refused || req === refused || req.headers['X-Public-Key'] !== bea.publicKey) return null;
                letGo.push(`${req.method} ${new URL(req.url).pathname}${req.method === 'POST' ? ` to ${readNamesShare(JSON.parse(req.body), CID)?.to === bea.publicKey ? 'Bea' : 'Ada'}` : ''}`);
                return new Promise<void>(() => { /* never answers */ });
            };
            const o = await openNamesList(COMMUNITY, bea, STORE);
            expect(refused).not.toBeNull();
            expect(letGo).toEqual([`POST /api/names/shares to ${ada ? 'Ada' : 'Bea'}`]); // f8d11de4: then GET /api/names/state
            expect(o.ok === false && o.code).toBe(NAMES_TIMED_OUT);
            expect(node.current()!.id).toBe(two);
            expect((await pinOf(bea))!.pending).toBeNull(); // the 409 said the node didn't store it
            // The connection is back: the next open claims and makes the key without Owen.
            answer = (req) => node.answer(req);
            hold = null;
            const b = await open(bea);
            expect(b.plan.kind).toBe('ready');
            expect(node.current()!).toMatchObject({ maker: bea.publicKey, parentId: two, drops: [owen.publicKey] });
        }, 30_000);
    }

    /** The phone's stores, where the next `failPinReads` reads of a pin throw (a SecureStore or AsyncStorage error). */
    let failPinReads = 0;
    const FLAKY: NamesPinStore = {
        ...STORE,
        getItem: async (k) => {
            if (failPinReads > 0 && k.startsWith('beanpool:names-trust:')) { failPinReads--; throw new Error('storage busy'); }
            return mem.get(k) ?? null;
        },
    };
    afterEach(() => { failPinReads = 0; });

    for (const how of ['the pin reads (control)', 'the pin read fails once', 'the pin was wiped during the read'] as const) {
        it(`U4 (the re-review's :690) a Remove tapped during the list read stands after it: ${how}; nothing is sealed under key 1`, async () => {
            const { node, phones: [owen, ada, abe] } = await community(['Owen', 'Ada', 'Abe']);
            const k1 = node.current()!.id;
            const label = namesTrustStoreKey(owen.publicKey, COMMUNITY);
            let release!: () => void;
            const gate = new Promise<void>((r) => { release = r; });
            let out = false;
            hold = (req) => {
                if (out || req.method !== 'GET' || new URL(req.url).pathname !== '/api/names/entries') return null;
                out = true;
                return gate;
            };
            const opening = openNamesList(COMMUNITY, owen, FLAKY);
            for (let i = 0; i < 1000 && !out; i++) await new Promise((r) => setTimeout(r, 5));
            expect(out).toBe(true); // Owen's list read is held
            expect(await removeOldKey(STORE, owen, COMMUNITY, abe.publicKey)).toBe(true);
            expect((await pinOf(owen))!.manualDrops).toEqual([abe.publicKey]);
            if (how === 'the pin read fails once') failPinReads = 1; // the read's own fresh read of the pin
            if (how === 'the pin was wiped during the read') mem.delete(label);
            release();
            const o = await opening;
            expect(o.ok && o.value.list?.entries.length).toBe(2); // the list is shown either way
            expect(failPinReads).toBe(0);
            if (how === 'the pin was wiped during the read') {
                expect(mem.has(label)).toBe(false); // f8d11de4: the open's copy came back, its ring included
                return;
            }
            expect((await pinOf(owen))!.manualDrops).toEqual([abe.publicKey]); // f8d11de4: [] after a failed read
            sent = [];
            const r = await saveNamesEntry(COMMUNITY, owen, STORE, o.ok ? o.value : null as never, { name: PLANTED[2], note: '' }, undefined, newEntryId());
            expect(r.ok === false && r.code).toBe('still_removing');
            expect(sentAs('POST', '/api/names/entries')).toEqual([]);
            expect(node.entries.filter((e) => e.keyId === k1).length).toBe(2);
            void ada;
        }, 30_000);
    }

    const summary = (p: Awaited<ReturnType<typeof pinOf>>) => p && { chain: p.chain.length, ring: Object.keys(p.ring).length, trusted: p.trusted.length, removals: p.manualDrops.length };

    it("U5 (the re-review's :380) a check whose pin read fails once fails with its own words and changes nothing; tried again, it works and keeps everything", async () => {
        const { node, phones: [owen, ada, abe] } = await community(['Owen', 'Ada', 'Abe']);
        const cy = await admin('Cy');
        node.admins.push(role(cy));
        await removeOldKey(STORE, owen, COMMUNITY, abe.publicKey);
        const before = summary(await pinOf(owen));
        expect(before).toEqual({ chain: 1, ring: 1, trusted: 3, removals: 1 });
        failPinReads = 1;
        const r = await checkEachOther(FLAKY, owen, COMMUNITY, node.stateFor(owen.publicKey), namesKeyQr(cy.publicKey));
        expect(summary(await pinOf(owen))).toEqual(before); // f8d11de4: chain 0, ring 0, trusted 2, removals 0
        expect(r).toEqual({ ok: false, reason: 'not_kept' }); // f8d11de4: ok, over an empty pin
        const screen = fs.readFileSync(path.join(__dirname, '../../app/names-list.tsx'), 'utf8');
        expect(screen).toMatch(/r\.reason === 'not_kept' \? COPY\.checkNotKept/);
        // Tried again with the store working: Cy is trusted, and nothing else moved.
        expect(await checkEachOther(FLAKY, owen, COMMUNITY, node.stateFor(owen.publicKey), namesKeyQr(cy.publicKey))).toEqual({ ok: true, pinned: cy.publicKey, mismatch: false });
        const after = (await pinOf(owen))!;
        expect(summary(after)).toEqual({ ...before, trusted: 4 });
        expect(after.trusted).toContain(ada.publicKey);
        expect(after.manualDrops).toEqual([abe.publicKey]);
    });

    it('U5 (the same cause, in the open) an open whose pin read fails once syncs nothing from an empty pin and saves nothing; the next open is as before', async () => {
        const { node, phones: [owen, ada, abe] } = await community(['Owen', 'Ada', 'Abe']);
        await removeOldKey(STORE, owen, COMMUNITY, abe.publicKey);
        const before = summary(await pinOf(owen));
        failPinReads = 1;
        sent = [];
        const r = await openNamesList(COMMUNITY, owen, FLAKY);
        expect(summary(await pinOf(owen))).toEqual(before); // f8d11de4: an open from an empty pin, saved
        expect(r.ok === false && r.code).toBe('not_read');
        expect(onlyStateRead()).toBe(true);
        const o = await openNamesList(COMMUNITY, owen, FLAKY);
        expect(o.ok && o.value.plan.kind).toBe('ready'); // and its key without Abe made
        expect(node.current()!).toMatchObject({ maker: owen.publicKey, drops: [abe.publicKey] });
        void ada;
    });

    it('U5 a pin that will never open (its key gone from the secure store) still gives way to a fresh one, as the design says: the check and the open go on', async () => {
        const { node, phones: [owen, ada] } = await community(['Owen', 'Ada']);
        const cy = await admin('Cy');
        node.admins.push(role(cy));
        secrets.delete(namesPinSecretName(namesTrustStoreKey(owen.publicKey, COMMUNITY)));
        expect(await checkEachOther(STORE, owen, COMMUNITY, node.stateFor(owen.publicKey), namesKeyQr(cy.publicKey))).toEqual({ ok: true, pinned: cy.publicKey, mismatch: false });
        expect(summary(await pinOf(owen))).toEqual({ chain: 0, ring: 0, trusted: 2, removals: 0 });
        expect((await openNamesList(COMMUNITY, owen, STORE)).ok).toBe(true);
        void ada;
    });
});

describe('V. Round 16: a Remove that isn\'t kept stops; a new key\'s words said where it lands', () => {
    /** The phone's stores, where the next `failPinReads` reads, or `failPinWrites` saves, of a pin throw. */
    let failPinReads = 0;
    let failPinWrites = 0;
    const FLAKY: NamesPinStore = {
        ...STORE,
        getItem: async (k) => {
            if (failPinReads > 0 && k.startsWith('beanpool:names-trust:')) { failPinReads--; throw new Error('storage busy'); }
            return mem.get(k) ?? null;
        },
        setItem: async (k, v) => {
            if (failPinWrites > 0 && k.startsWith('beanpool:names-trust:')) { failPinWrites--; throw new Error('storage full'); }
            mem.set(k, v);
        },
    };
    afterEach(() => { failPinReads = 0; failPinWrites = 0; });

    for (const how of ['the pin read fails once', 'the pin write fails once'] as const) {
        it(`V1 (the re-review's :186) a Remove whose ${how.replace('the pin ', 'pin ')} stops with its words, opens nothing, and nothing is sealed under key 1 until a Remove is tried again and kept`, async () => {
            const { node, phones: [owen, ada, abe], k1 } = await community(['Owen', 'Ada', 'Abe']);
            const onScreen = await open(owen); // the list Owen taps Remove on
            sent = [];
            if (how === 'the pin read fails once') failPinReads = 1;
            else failPinWrites = 1;
            // The screen's Remove: the removal kept, then the list opened again.
            const r = await removeOldKeyAndOpen(COMMUNITY, owen, FLAKY, { pubkey: abe.publicKey, callsign: 'Abe' });
            expect(failPinReads + failPinWrites).toBe(0);
            // bb0755ec: the false was dropped and the list opened, ready, with notices [].
            expect(r).toEqual({ ok: false, status: 0, code: 'remove_not_kept', message: NAMES_COPY.removeNotKept(['Abe']) });
            expect(sent).toEqual([]); // nothing opened, nothing sent
            expect((await pinOf(owen))!.manualDrops).toEqual([]);
            expect(unkeptRemovalsOf(owen, COMMUNITY)).toEqual([abe.publicKey]);
            // The screen shows the Remove's words and offers it again, in place of the list.
            const screen = fs.readFileSync(path.join(__dirname, '../../app/names-list.tsx'), 'utf8');
            expect(screen).toMatch(/run\(\(url\) => removeOldKeyAndOpen\(url, identity, STORE, admin\)\)/);
            expect(screen).toMatch(/if \(result\.code === 'remove_not_kept'\) return;/);
            expect(screen).toMatch(/plan\?\.kind === 'ready' && opened && unkept\.length\) \{[\s\S]{0,400}COPY\.removeNotKept\([\s\S]{0,300}removeKey\(a\)/);
            // Nothing is written under key 1, which Abe's lost phone holds: not from the screen's list, nor after an open.
            for (const o of [onScreen, await open(owen)]) {
                expect(o.plan.kind).toBe('ready'); // the pin stands by no removal: the open alone can't tell
                sent = [];
                const w = await saveNamesEntry(COMMUNITY, owen, STORE, o, { name: PLANTED[2], note: '' }, undefined, newEntryId());
                expect(w.ok === false && w.code).toBe('remove_not_kept');
                expect(w.ok === false && w.message).toBe(NAMES_COPY.removeNotKept(['Abe']));
                expect(sentAs('POST', '/api/names/entries')).toEqual([]);
            }
            expect(node.entries.filter((e) => e.keyId === k1).length).toBe(2);
            expect(node.current()!.id).toBe(k1);
            // Tried again with the store working: kept, and the open makes key 2 without Abe; the next name goes under it.
            const again = await removeOldKeyAndOpen(COMMUNITY, owen, FLAKY, { pubkey: abe.publicKey, callsign: 'Abe' });
            expect(again.ok && again.value.plan.kind).toBe('ready');
            expect(unkeptRemovalsOf(owen, COMMUNITY)).toEqual([]);
            const two = node.current()!;
            expect(two).toMatchObject({ maker: owen.publicKey, parentId: k1, drops: [abe.publicKey] });
            const w = await saveNamesEntry(COMMUNITY, owen, STORE, again.ok ? again.value : onScreen, { name: PLANTED[2], note: '' }, undefined, newEntryId());
            expect(w.ok && w.value.keyId).toBe(two.id);
            void ada;
        });
    }

    it('V1 (control) a Remove kept opens the list, makes key 2 without Abe, and records nothing to try again', async () => {
        const { node, phones: [owen, , abe], k1 } = await community(['Owen', 'Ada', 'Abe']);
        const r = await removeOldKeyAndOpen(COMMUNITY, owen, FLAKY, { pubkey: abe.publicKey, callsign: 'Abe' });
        expect(r.ok && r.value.plan.kind).toBe('ready');
        expect(unkeptRemovalsOf(owen, COMMUNITY)).toEqual([]);
        expect(node.current()!).toMatchObject({ maker: owen.publicKey, parentId: k1, drops: [abe.publicKey] });
    });

    it('V1 a Remove not kept is let go when its key is checked (the admin changing their mind), as a kept one is', async () => {
        const { node, phones: [owen, ada, abe] } = await community(['Owen', 'Ada', 'Abe']);
        failPinWrites = 1;
        expect((await removeOldKeyAndOpen(COMMUNITY, owen, FLAKY, { pubkey: abe.publicKey, callsign: 'Abe' })).ok).toBe(false);
        expect(unkeptRemovalsOf(owen, COMMUNITY)).toEqual([abe.publicKey]);
        expect(await checkEachOther(STORE, owen, COMMUNITY, node.stateFor(owen.publicKey), namesKeyQr(abe.publicKey))).toMatchObject({ ok: true });
        expect(unkeptRemovalsOf(owen, COMMUNITY)).toEqual([]);
        const o = await open(owen);
        const w = await saveNamesEntry(COMMUNITY, owen, STORE, o, { name: PLANTED[2], note: '' }, undefined, newEntryId());
        expect(w.ok && w.value.keyId).toBe(node.current()!.id);
        void ada;
    });

    const never = () => new Promise<void>(() => { /* never answers */ });
    const times = (said: string[], w: string) => said.filter((x) => x === w).length;
    for (const how of ['answered (control)', 'lost before the node', 'stored, answer lost', 'stored, no answer (time-out)', 'stored, answer lost; a Save takes it'] as const) {
        it(`V2 (the re-review's :690) Bea's new key without Owen, its POST ${how}: the key lands and its words are said once, where it lands`, async () => {
            const { node, phones: [owen, bea, ada], k1 } = await community(['Owen', 'Bea', 'Ada']);
            const onScreen = await open(bea);
            expect(await removeOldKey(STORE, bea, COMMUNITY, owen.publicKey)).toBe(true); // Owen is still listed: the Remove words
            const word = NAMES_COPY.newKeyRemoved(['Owen']);
            let failing = how !== 'answered (control)';
            const isMine = (req: Sent) => failing && req.headers['X-Public-Key'] === bea.publicKey && req.method === 'POST' && new URL(req.url).pathname === '/api/names/generations';
            if (how === 'lost before the node') drop = (req) => (isMine(req) ? 'before' : null);
            if (how.startsWith('stored, answer lost')) drop = (req) => (isMine(req) ? 'after' : null);
            if (how === 'stored, no answer (time-out)') {
                setNamesRequestTimeout(1000, { stateMs: 1000, listPerEntryMs: 0 });
                hold = (req) => (isMine(req) ? never() : null);
            }
            const said: string[] = [];
            const first = await openNamesList(COMMUNITY, bea, STORE);
            if (first.ok) said.push(...first.value.notices);
            expect(first.ok).toBe(how === 'answered (control)');
            // The node has the statement, or not, as the case means it.
            expect(node.current()!.id === k1).toBe(how === 'lost before the node');
            failing = false;
            drop = null;
            hold = null;
            setNamesRequestTimeout(NAMES_REQUEST_TIMEOUT_MS);
            if (how === 'stored, answer lost; a Save takes it') {
                // The screen still shows the list as it was; the Save's own look takes the key (said on the next open).
                const w = await saveNamesEntry(COMMUNITY, bea, STORE, onScreen, { name: PLANTED[2], note: '' }, undefined, newEntryId());
                expect(w.ok && w.value.keyId).toBe(node.current()!.id);
            }
            // Bea's opens run until one is ready; then two more.
            let landedOn = first.ok ? 0 : -1;
            let made = first.ok ? first.value.made : null;
            for (let i = 1; i <= 4 && landedOn < 0; i++) {
                const o = await open(bea);
                said.push(...o.notices);
                if (o.plan.kind === 'ready') { landedOn = i; made = o.made; }
            }
            expect(landedOn).toBe(how === 'answered (control)' ? 0 : 1);
            expect(node.current()!).toMatchObject({ maker: bea.publicKey, parentId: k1, drops: [owen.publicKey] });
            expect(times(said, word)).toBe(1); // bb0755ec: 0 in every row but the control
            // The open where it landed says whom the key was made without (a Save that took it keeps its words instead).
            expect(made).toEqual(how === 'stored, answer lost; a Save takes it' ? null : [owen.publicKey]);
            for (const o of [await open(bea), await open(bea)]) expect(times(o.notices, word)).toBe(0);
            void ada;
        }, 30_000);
    }

    it("V3 (the re-review's guide :40) the operators' guide names the check buttons the screen has, not the check screen's title", () => {
        const guide = fs.readFileSync(path.join(__dirname, '../../../../packages/beanpool-guide/operators/people/running-a-known-community.md'), 'utf8');
        const plain = (w: string) => `**${w.replace(/’/g, "'")}**`;
        expect(guide).toContain(`tap ${plain(NAMES_COPY.checkSomeone)} (or ${plain(NAMES_COPY.checkButton('name'))})`);
        expect(guide).not.toContain(plain(NAMES_COPY.checkEachOtherTitle)); // bb0755ec: "tap **Check each other**"
        const screen = fs.readFileSync(path.join(__dirname, '../../app/names-list.tsx'), 'utf8');
        expect(screen).toMatch(/const checkSomeone = btn\(COPY\.checkSomeone,/);
        expect(screen).not.toMatch(/btn\(COPY\.checkEachOtherTitle/); // the title only
    });

    it('V2 a new key whose POST the node refused (it never stored it) says nothing: no key landed', async () => {
        const { node, phones: [owen, bea], k1 } = await community(['Owen', 'Bea', 'Ada']);
        expect(await removeOldKey(STORE, bea, COMMUNITY, owen.publicKey)).toBe(true);
        let refusing = true;
        answer = (req) => (refusing && req.method === 'POST' && new URL(req.url).pathname === '/api/names/generations'
            ? { status: 403, body: { error: 'admins_only', code: 'admins_only' } } : node.answer(req));
        const first = await openNamesList(COMMUNITY, bea, STORE);
        expect(first.ok && first.value.made).toBeNull();
        expect(first.ok && times(first.value.notices, NAMES_COPY.newKeyRemoved(['Owen']))).toBe(0);
        expect(node.current()!.id).toBe(k1);
        expect((await pinOf(bea))!.pending).toBeNull(); // the refusal says it was never stored
        refusing = false;
        answer = (req) => node.answer(req);
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
    it("F1 a write only under the head's key when the server's current is the head: from a screen opened before a new key, the write looks first and seals under the new head", async () => {
        const { node, phones: [owen, ada] } = await community(['Owen', 'Ada', 'Abe']);
        const o = await open(owen);
        node.admins = node.admins.slice(0, 2);
        await open(ada); // key 2 without Abe, sent to Owen; Owen's screen still holds the old open
        sent = [];
        const saved = await saveNamesEntry(COMMUNITY, owen, STORE, o, { name: PLANTED[2], note: '' });
        expect(saved.ok && saved.value.keyId).toBe(node.current()!.id);
        // Round 13: the write decides from a fresh look on the pin's chain, not the screen's old open: one POST, under the
        // new head; nothing under the old key.
        const posts = sentAs('POST', '/api/names/entries').map((s) => JSON.parse(s.body));
        expect(posts.map((b) => b.keyId)).toEqual([node.current()!.id]);
        void o;
        for (const s of sent) expect(nothingReadable(s)).toBe(true);
    });

    it('F2 the write freeze: a holder removed, another admin writing before any holder opens: nothing is written (a new key is due); the next holder\'s open makes the key', async () => {
        const { node, phones: [owen, ada, abe] } = await community(['Owen', 'Ada', 'Abe']);
        const o = await open(owen);
        node.admins = [role(owen, 'owner'), role(ada)];
        // Ada's phone hasn't opened since: its old open writes, and the node refuses.
        // Round 13: the write looks first: a new key is due, so nothing is written (the node would refuse it anyway).
        sent = [];
        const r = await saveNamesEntry(COMMUNITY, ada, STORE, { plan: { kind: 'ready' }, pin: (await pinOf(ada))!, ring: o.ring }, { name: 'X', note: '' });
        expect(r.ok === false && r.code).toBe('not_ready');
        expect(sentAs('POST', '/api/names/entries')).toEqual([]);
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
        expect(plain(NAMES_COPY.who)).toBe("Only this community's owners and admins can read these names, on their own phones. The server keeps them scrambled: a backup, a copy or a stolen database holds nothing readable. This phone gives the list's keys only to admins whose phones were checked, on a call or in person, by you or by an admin you trust, and takes a new key only from them. What it can't protect: a check made with the wrong person, a phone someone else gets into, a lost phone until an admin removes its key, and an admin's phone that the server keeps from learning of a removal: what that phone writes until it learns, the removed admin's keys can read. Each admin's phone learns of a removal when it opens the list, unless the server hides it. After an admin is removed, look at this phone's admins: if it still shows them, tap Remove @X's old key. Whatever the server says, this phone then makes a key without them or writes nothing.");
        // Design Addendum 3 (§5), exact.
        expect(plain(NAMES_COPY.follow)).toBe("This phone follows the key history the server shows, from the last key both share. It keeps the keys it holds, reads with them and passes them on to the admins it trusts, but never writes under them again unless the server's history comes back to them. An admin this phone had removed stays removed: before it writes, it makes a key without them.");
        expect(plain(NAMES_COPY.followButton)).toBe("Follow the server's history");
        expect(plain(NAMES_COPY.followTitle)).toBe("Follow the server's history?");
        // Round 7: when the new key is this phone's own drop, the holder only sends the key; this phone makes the new one.
        expect(plain(NAMES_COPY.waitOwnKey(['A'], ['X']))).toBe("The list needs a new key without @X before anything more is written. This phone makes it once it holds the list's current key: @A will send that the next time they open the names list.");
        // Round 14 (the re-review's :1078): true when the followed history removed them too, in another statement.
        expect(plain(NAMES_COPY.newKeyCarried(['X']))).toBe("The list has a new key without @X: this phone had removed their key on a key history it has since left.");
        expect(plain(NAMES_COPY.checkAgain('X', 4))).toBe("Key 4 removed @X's key. If @X is an admin again, check each other's phones again: a check made before this phone took key 4 doesn't count past it.");
        expect(plain(`${NAMES_COPY.newKeyMade(['X'])} ${NAMES_COPY.newKeySent(['A'], [])}`)).toBe('The list has a new key because @X is no longer an admin. Nothing this phone writes from now on can be read with the keys @X had. This phone has sent the new key to the admins it trusts.');
        expect(plain(NAMES_COPY.newKeyRemoved(['X']))).toBe("The list has a new key that @X's old phone can't read. If @X gets a new phone, check its code and this phone will send the keys.");
        expect(plain(NAMES_COPY.newKeySent([], ['C']))).toBe('This phone will send the new key to @C the next time the list opens on it.');
        expect(plain(NAMES_COPY.newKeySent(['A'], ['C', 'D']))).toBe('This phone has sent the new key to @A. It will send it to @C and @D the next time the list opens on it.');
        expect(NAMES_COPY.newKeySent([], [])).toBe('');
        expect(plain(NAMES_COPY.listKey(3, '1234 5678 9012 3456 7890'))).toBe('This phone adds names under list key 3, code 1234 5678 9012 3456 7890.');
        expect(plain(NAMES_COPY.compareListKey)).toBe('When you check each other, compare this line too. If it differs, open the list again on both phones. If it still differs, the server is showing your phones different things: add no names until it matches, and tell your admins.');
        expect(plain(NAMES_COPY.removeKey('X'))).toBe("Remove @X's old key? The list gets a new key that @X's old phone can't read. If @X gets a new phone, check its code and this phone will send the keys.");
        expect(plain(NAMES_COPY.checkIntro('X'))).toBe("Check @X's code. Open the names list on both phones, and check each other's code: read the 20 digits out on a call and type them in, or scan the QR code if you're together. Only do this when you know it's @X you're talking to: your phone will trust this key, send it the names, and take new keys it makes.");
        expect(plain(NAMES_COPY.mismatch('X'))).toBe("The key you scanned isn't the one the server lists for @X. Your phone trusts the key you scanned and nothing is sent to the server's key. Either the server has put @X's name on another key, or this isn't @X's phone. Tell your other admins.");
        // The design addendum's (e): the vouched history gives a way forward through any admin whose phone opens the list.
        expect(plain(NAMES_COPY.refusedUntrusted(4, 'X'))).toBe("The list's key number 4 was made by @X, and no admin this phone trusts has checked them. Nothing was read or written. Check codes with @X, or with an admin whose phone already opens the list, on a call or in person.");
        expect(plain(NAMES_COPY.refusedRolledBack(2, 5))).toBe('The server offers an older key history (up to key 2) than this phone has (key 5). A server put back to an older copy does that. Nothing was read or written. You can put the key history back from this phone; entries written since the copy are gone and must be typed again from your paper copy.');
        expect(plain(NAMES_COPY.refusedDifferentNone)).toBe("The server shows a key history this phone didn't take. A standby that took over from an older copy, where an admin's phone then made a new key, does that; so does whoever runs the server changing the history. Nothing was read or written. Ask your admins what happened. You can follow the server's history: this phone keeps the keys it holds.");
        expect(plain(NAMES_COPY.followFromHere(3, false))).toBe("If none of them can be reached, follow the server's history: this phone takes key 3 for its place only, with no new trust and no new key.");
        expect(plain(NAMES_COPY.waitRemovedHolder(['X', 'Y'], 3))).toBe("The server says @X and @Y hold key 3, and this phone had removed their keys. Nobody else can make a new key until an owner removes them or moves their accounts to new keys.");
        expect(plain(NAMES_COPY.nobodyHoldsKey(3, 1, 'X'))).toBe("Nobody who is an admin now holds key 3. You can make a new key; the 1 name sealed under it stays locked unless @X's phone is found.");
        expect(plain(NAMES_COPY.refusedDifferent)).toBe("The server shows a key history this phone didn't take. A standby that took over from an older copy, where an admin's phone then made a new key, does that; so does whoever runs the server changing the history. Nothing was read or written. Ask your admins what happened. You can follow the server's history: this phone keeps the keys it holds, and before it writes again it makes a new key without any admin it had removed.");
        expect(plain(NAMES_COPY.wait(['A', 'B']))).toBe("You don't hold the list's keys yet. @A or @B will send them the next time they open the names list.");
        // Design Addendum 4 (§4), exact.
        expect(plain(NAMES_COPY.followFromHere(3))).toBe("If none of them can be reached, follow the server's history: this phone takes key 3 for its place only, with no new trust and no new key, and before it writes it makes a new key without any admin it had removed.");
        expect(plain(NAMES_COPY.refusedRemoved(3, 'X'))).toBe("The list's key number 3 was made by @X, and this phone had removed @X's key; the server's history hasn't. Nothing was read or written. Check @X's code only if @X is an admin again: this phone then trusts them again. Or check an admin whose phone already opens the list: this phone then takes key 3 for its place only and makes a new key without @X before it writes. If none of them can be reached, follow the server's history: the same, without a check.");
        expect(plain(NAMES_COPY.refusedRemovedGone(3, 'X'))).toBe("The list's key number 3 was made by @X, who is no longer an admin, and this phone had removed @X's key. Nothing was read or written. Check an admin whose phone already opens the list, or follow the server's history: either way this phone takes key 3 for its place only and makes a new key without @X before it writes.");
        expect(plain(NAMES_COPY.waitRemovedHolder(['X'], 3))).toBe("The server says @X holds key 3, and this phone had removed @X's key. Nobody else can make a new key until an owner removes @X or moves their account to a new key.");
        expect(plain(NAMES_COPY.askForShare('X'))).toBe("The server says @X holds the current key, so only their phone can make the next one. Ask @X to open the names list; if their phone is lost, have an owner remove them.");
        expect(plain(NAMES_COPY.lostEntries(3))).toBe("3 entries this phone saw aren't on the server now, and no admin deleted them. A server put back to an older copy does that. Whoever runs the server may still have them on the other copy and can put them back; the phones still hold their keys. Otherwise type them again from your paper copy.");
        expect(plain(NAMES_COPY.holdersJustChecked(['A']))).toBe("@A holds the list's keys. Their phone sends them once it trusts this one: if you have just checked each other, that is the next time it opens the names list; if not, check codes with them, on a call or in person.");
        expect(plain(NAMES_COPY.holdersNoTrust(['A']))).toBe("@A holds the list's keys, but their phone doesn't trust this one yet: check codes with @A, on a call or in person.");
        expect(plain(NAMES_COPY.holdersNoTrust(['A', 'B']))).toBe("@A or @B hold the list's keys, but their phones don't trust this one yet: check codes with one of them, on a call or in person.");
        expect(plain(NAMES_COPY.wait([]))).toBe("Nobody this phone trusts holds the list's keys. Check codes with an admin who does, on a call or in person.");
        expect(plain(NAMES_COPY.lockedEntry(3, 'X', ['A']))).toBe("Sealed with key 3 (made by @X). This phone doesn't hold it. @A holds it and will send it on their next open.");
        expect(plain(NAMES_COPY.lockedEntry(3, 'X', []))).toBe("Sealed with key 3 (made by @X). This phone doesn't hold it. Nobody who is an admin now holds it: type it again from your paper copy, or delete it.");
        expect(plain(NAMES_COPY.startAgain(7))).toBe("Nobody who is an admin now holds the list's keys. You can start a new key; the 7 entries written before stay locked until an admin who held a key comes back, or they are typed again from your paper copy.");
        // Round 15: checks at a distance (Marty, 2026-10-03): the code is read out on a call, or scanned when together.
        expect(plain(NAMES_COPY.myKey)).toBe("On a call, read these 20 digits out for the other admin to type in. If you're together, they can scan the QR code instead.");
        expect(plain(NAMES_COPY.checkButton('X'))).toBe("Check @X's code");
        expect(plain(NAMES_COPY.checkSomeone)).toBe("Check an admin's code");
        expect(plain(NAMES_COPY.checkFirst('X'))).toBe("Check @X's code first, on a call or in person: the server's word that a key is @X's isn't enough.");
        expect(plain(NAMES_COPY.toCheck('X'))).toBe("@X is an admin, and this phone hasn't checked their phone. Check codes with them, on a call or in person: then this phone sends them the keys.");
        expect(plain(NAMES_COPY.otherHistory('X'))).toBe("@X's phone is on a different key history: check codes with @X, on a call or in person.");
        expect(plain(NAMES_COPY.waitNewKey([]))).toBe("The list needs a new key before anything more is written, and nobody this phone trusts holds the current one. Check codes with an admin who does, on a call or in person.");
        expect(plain(NAMES_COPY.codeMismatch('X'))).toBe("Those digits aren't @X's key as the server lists it. Nothing was trusted. Scan their QR code instead, on a video call or together, and tell your other admins.");
        expect(plain(NAMES_COPY.noMatch)).toBe("Those digits aren't the key of any admin the server lists. Scan their QR code instead, on a video call or together.");
        expect(plain(NAMES_COPY.checkNotKept)).toBe("This phone couldn't read or save its names list keys just now, so nothing was checked and nothing was changed. Try again.");
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
        // Round 15: no sentence the app says asks admins to meet; a check is on a call or in person.
        const copy = Object.values(NAMES_COPY).map(said).join('\n');
        for (const gone of [/\bmeet/i, /meeting/i, /(?<!on a call or )in person/i, /in front of you/i, /someone you.re with/i]) expect(copy).not.toMatch(gone);
        for (const gone of [/Take @/, /take their history/i, /an admin whose phone has the server.s history can check yours/i, /only at a meeting/i,
            /To be sure, meet another admin and compare the list key/i, /they should show the same one/i,
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

describe('§8 16-20. The locked copy on the node (design §3, §5)', () => {
    /** Sign Out, as far as the names list goes: every `beanpool:names-` key of this phone's member key is gone. */
    const wipe = (me: BeanPoolIdentity) => { for (const k of [...mem.keys()]) if (k.startsWith('beanpool:names-') && k.includes(me.publicKey.toLowerCase())) mem.delete(k); };
    const route = (x: Sent) => `${x.method} ${new URL(x.url).pathname}`;
    const named = (o: NamesOpened) => openEntries(o.list!, o).map((e) => e.text?.name).filter(Boolean).sort();

    it('16 Sign Out then open, with another admin: today the phone needs a check; with the copy it is READY and the ring is back', async () => {
        const { node, phones: [, ada], k1 } = await community(['Owen', 'Ada'], true);
        wipe(ada);
        const back = await open(ada);
        expect(back.plan.kind).toBe('ready');
        expect(Object.keys(back.ring)).toContain(k1);
        expect(named(back)).toEqual([PLANTED[0], PLANTED[1]].sort());
        expect(sentAs('GET', '/api/names/copy').length).toBe(1);
        expect(node.log.filter((l) => l.action === 'copy_restored').map((l) => l.actor)).toEqual([ada.publicKey]);
        // Today (a node with no copies): the same Sign Out leaves Ada to check codes again.
        const old = await community(['Owen', 'Ada']);
        wipe(old.phones[1]);
        const today = await open(old.phones[1]);
        expect(today.plan.kind).not.toBe('ready');
    });

    it('17 the sole admin: Sign Out then open reads every entry', async () => {
        const { phones: [owen] } = await community(['Owen'], true);
        wipe(owen);
        const back = await open(owen);
        expect(back.plan.kind).toBe('ready');
        expect(named(back)).toEqual([PLANTED[0], PLANTED[1]].sort());
        expect(sentAs('POST', '/api/names/generations')).toEqual([]);
    });

    it('18 order: a copy is saved before the generation and before the shares; a failed copy sends neither', async () => {
        // A fresh community, every request recorded from the first open on.
        const owen = await admin('Owen');
        const ada = await admin('Ada');
        const n2 = new FakeNode();
        n2.copies = new Map();
        n2.admins = [role(owen, 'owner'), role(ada)];
        answer = (req) => n2.answer(req);
        sent = [];
        await open(owen);
        await meet(n2, owen, ada);
        for (let i = 0; i < 2; i++) for (const p of [owen, ada]) await openNamesList(COMMUNITY, p, STORE);
        const order = sent.map(route);
        const firstGen = order.indexOf('POST /api/names/generations');
        expect(firstGen).toBeGreaterThan(-1);
        expect(order.slice(0, firstGen)).toContain('PUT /api/names/copy');
        // Every share follows a copy of its sender's that the node confirmed, saved after the sender's last sync.
        sent.forEach((x, i) => {
            if (route(x) !== 'POST /api/names/shares') return;
            const by = x.headers['X-Public-Key'];
            const before = sent.slice(0, i).filter((y) => y.headers['X-Public-Key'] === by);
            expect(before.map(route).lastIndexOf('PUT /api/names/copy')).toBeGreaterThan(before.map(route).lastIndexOf('GET /api/names/state'));
        });
        // A copy that fails: no statement, no share, and the key stays pending on the phone for the next open.
        const bea = await admin('Bea');
        const n3 = new FakeNode();
        n3.copies = new Map();
        n3.admins = [role(bea, 'owner')];
        answer = (req) => (req.method === 'PUT' && new URL(req.url).pathname === '/api/names/copy' ? { status: 502 } : n3.answer(req));
        sent = [];
        await openNamesList(COMMUNITY, bea, STORE);
        expect(sentAs('PUT', '/api/names/copy').length).toBeGreaterThan(0);
        expect(sentAs('POST', '/api/names/generations')).toEqual([]);
        expect(sentAs('POST', '/api/names/shares')).toEqual([]);
        expect((await readNamesPinFrom(STORE, bea.publicKey, COMMUNITY))!.pending).not.toBeNull();
        answer = (req) => n3.answer(req);
        expect((await open(bea)).plan.kind).toBe('ready');
        expect(n3.copies.get(bea.publicKey)!.seq).toBeGreaterThan(0);
    });

    it('19 the fresh-pin rule: no pin and the node down, or a bad copy, uploads nothing until Start afresh', async () => {
        const { node, phones: [owen, ada] } = await community(['Owen', 'Ada'], true);
        const held = node.copies!.get(ada.publicKey)!;
        wipe(ada);
        drop = (req) => (new URL(req.url).pathname === '/api/names/copy' ? 'before' : null);
        sent = [];
        const down = await openNamesList(COMMUNITY, ada, STORE);
        expect(down.ok).toBe(false);
        expect(sentAs('PUT', '/api/names/copy')).toEqual([]);
        expect(sentAs('POST', '/api/names/shares')).toEqual([]);
        expect(sentAs('POST', '/api/names/generations')).toEqual([]);
        expect(await readNamesPinFrom(STORE, ada.publicKey, COMMUNITY)).toBeNull();
        expect(node.copies!.get(ada.publicKey)).toBe(held);
        // A copy changed on the node (its box's tag): refused, nothing kept or uploaded; Start afresh is offered.
        drop = null;
        const tag = (held.box as { copyTag: string }).copyTag;
        node.copies!.set(ada.publicKey, { ...held, box: { ...(held.box as object), copyTag: (tag[0] === 'A' ? 'B' : 'A') + tag.slice(1) } });
        sent = [];
        const bad = await openNamesList(COMMUNITY, ada, STORE);
        expect(bad.ok).toBe(false);
        expect(COPY_REFUSED_CODES).toContain(!bad.ok && bad.code);
        expect(sentAs('PUT', '/api/names/copy')).toEqual([]);
        expect(sentAs('POST', '/api/names/shares')).toEqual([]);
        expect(await readNamesPinFrom(STORE, ada.publicKey, COMMUNITY)).toBeNull();
        // Start afresh: the fresh record's copy replaces the node's, numbered past it.
        const afresh = await startAfreshOnThisPhone(COMMUNITY, ada, STORE);
        expect(afresh.ok).toBe(true);
        expect(node.copies!.get(ada.publicKey)!.seq).toBeGreaterThan(held.seq);
        void owen;
    });

    it('20 a node that lost the copy, or holds an older one, gets a new one on the next open', async () => {
        const { node, phones: [owen] } = await community(['Owen', 'Ada'], true);
        const first = node.copies!.get(owen.publicKey)!;
        node.copies!.delete(owen.publicKey);
        sent = [];
        await open(owen);
        expect(sentAs('PUT', '/api/names/copy').length).toBe(1);
        const now = node.copies!.get(owen.publicKey)!;
        expect(now.seq).toBeGreaterThan(first.seq);
        // An older copy put back (a standby that took over from an older copy): saved again, past it.
        const older = { ...first, seq: Math.max(0, now.seq - 1) };
        node.copies!.set(owen.publicKey, older);
        sent = [];
        await open(owen);
        expect(sentAs('PUT', '/api/names/copy').length).toBe(1);
        expect(node.copies!.get(owen.publicKey)!.seq).toBeGreaterThan(now.seq);
        // The same copy as the pin's: nothing sent.
        sent = [];
        await open(owen);
        expect(sentAs('PUT', '/api/names/copy')).toEqual([]);
    });
});

describe('§8 23. Sign Out saves the copy first; what it says when the node didn\'t confirm it (design §5)', () => {
    const putCopyFails = (node: FakeNode) => { answer = (req) => (req.method === 'PUT' && new URL(req.url).pathname === '/api/names/copy' ? { status: 502 } : node.answer(req)); };
    const anchorsOf = (me: BeanPoolIdentity) => namesPinAddresses([...mem.keys()], me.publicKey);

    it('the pin labels give the addresses to save, for this key only', async () => {
        const { phones: [owen, ada] } = await community(['Owen', 'Ada'], true);
        expect(anchorsOf(owen)).toEqual([COMMUNITY]);
        expect(anchorsOf(ada)).toEqual([COMMUNITY]);
        expect(namesPinAddresses([...mem.keys()], 'ef'.repeat(32))).toEqual([]);
    });

    it('a copy the node already confirmed: no words, nothing sent but the state', async () => {
        const { phones: [owen] } = await community(['Owen', 'Ada'], true);
        const out = await saveNamesCopiesBeforeLeaving(owen, anchorsOf(owen), STORE);
        expect(out).toEqual([]);
        expect(namesSignOutWords(out)).toBeNull();
        expect(sentAs('PUT', '/api/names/copy')).toEqual([]);
    });

    it('a copy the node lost is saved again and confirmed: no words', async () => {
        const { node, phones: [owen] } = await community(['Owen', 'Ada'], true);
        node.copies!.delete(owen.publicKey);
        const out = await saveNamesCopiesBeforeLeaving(owen, anchorsOf(owen), STORE);
        expect(out).toEqual([]);
        expect(sentAs('PUT', '/api/names/copy').length).toBe(1);
        expect(node.copies!.get(owen.publicKey)).toBeDefined();
    });

    it('the only holder of the key, its copy not confirmed: the three-button words with the key\'s number', async () => {
        const { node, phones: [owen] } = await community(['Owen'], true);
        node.copies!.delete(owen.publicKey);
        putCopyFails(node);
        const out = await saveNamesCopiesBeforeLeaving(owen, anchorsOf(owen), STORE);
        expect(out).toEqual([{ anchor: COMMUNITY, onlyKey: 1 }]);
        expect(namesSignOutWords(out)).toEqual({ text: NAMES_COPY.signOutOnlyCopy(1), pdf: true });
        expect(NAMES_COPY.signOutOnlyCopy(1)).toContain('the only copy of the names list’s key 1');
        // Nothing is wiped or blocked here: the pin is still on the phone, for "Try again".
        expect(await pinOf(owen)).not.toBeNull();
    });

    it('another admin holds the key too: the two-button words (check codes after signing in)', async () => {
        const { node, phones: [, ada] } = await community(['Owen', 'Ada'], true);
        node.copies!.delete(ada.publicKey);
        putCopyFails(node);
        const out = await saveNamesCopiesBeforeLeaving(ada, anchorsOf(ada), STORE);
        expect(out).toEqual([{ anchor: COMMUNITY, onlyKey: null }]);
        expect(namesSignOutWords(out)).toEqual({ text: NAMES_COPY.signOutNotConfirmed, pdf: false });
    });

    it('the state can\'t be read: not confirmed, with the general words, and no copy is sent', async () => {
        const { node, phones: [owen] } = await community(['Owen'], true);
        answer = (req) => (new URL(req.url).pathname === '/api/names/state' ? { status: 503 } : node.answer(req));
        const out = await saveNamesCopiesBeforeLeaving(owen, anchorsOf(owen), STORE);
        expect(out).toEqual([{ anchor: COMMUNITY, onlyKey: null }]);
        expect(namesSignOutWords(out)!.pdf).toBe(false);
        expect(sentAs('PUT', '/api/names/copy')).toEqual([]);
    });

    it('a node from before the copies (no myCopy): not confirmed, and nothing is sent to a route it lacks', async () => {
        const { node, phones: [owen] } = await community(['Owen'], true);
        node.copies = null;
        const out = await saveNamesCopiesBeforeLeaving(owen, anchorsOf(owen), STORE);
        expect(out).toEqual([{ anchor: COMMUNITY, onlyKey: 1 }]);
        expect(sentAs('PUT', '/api/names/copy')).toEqual([]);
    });

    it('Settings asks, and never blocks: "Sign out anyway" signs out with the copies already tried', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../app/(tabs)/settings.tsx'), 'utf8');
        const after = src.slice(src.indexOf('async function signOutAfterNamesCopies'));
        expect(after).toContain('namesSignOutWords(await namesCopiesBeforeSignOut(identity))');
        expect(after).toMatch(/if \(!words\) return signOutNow\(\);/);
        expect(after).toMatch(/text: NAMES_COPY\.signOutAnyway, style: 'destructive' as const, onPress: \(\) => void signOutNow\(\)/);
        expect(after).toMatch(/text: NAMES_COPY\.tryAgain, onPress: \(\) => void signOutAfterNamesCopies\(\)/);
        expect(after).toMatch(/words\.pdf \? \[\{ text: NAMES_COPY\.savePdf/);
        expect(src).toContain('await signOutOfThisPhone(identity, { namesCopiesSaved: true });');
    });
});

describe('§5 the restored line, and Sign Out then sign in with the same 12 words (design-locked-copy §5)', () => {
    const wipe = (me: BeanPoolIdentity) => { for (const k of [...mem.keys()]) if (k.startsWith('beanpool:names-') && k.includes(me.publicKey.toLowerCase())) mem.delete(k); };
    const restoredIn = (words: readonly string[]) => words.filter((w) => w.startsWith('Restored your names-list record from the server')).length;
    const named = (o: NamesOpened) => openEntries(o.list!, o).map((e) => e.text?.name).filter(Boolean).sort();

    it('said once, on the open that restored, with the saved date and the key\'s number and code; not on the next', async () => {
        const { node, phones: [, ada], k1 } = await community(['Owen', 'Ada'], true);
        const held = node.copies!.get(ada.publicKey)!;
        wipe(ada);
        const first = await open(ada);
        expect(restoredIn(first.notices)).toBe(1);
        expect(first.notices).toContain(NAMES_COPY.copyRestored(held.savedAt, 1, namesListKeyCode(k1)));
        expect(restoredIn((await open(ada)).notices)).toBe(0);
        expect(restoredIn((await open(ada)).notices)).toBe(0);
    });

    it('an open whose list read fails keeps it: said once after an app restart (the kept words are on the phone)', async () => {
        const { phones: [, ada] } = await community(['Owen', 'Ada'], true);
        wipe(ada);
        drop = (req) => (new URL(req.url).pathname === '/api/names/entries' ? 'before' : null);
        const cut = await openNamesList(COMMUNITY, ada, STORE);
        expect(cut.ok).toBe(false);
        drop = null;
        // The app restarts: the module's memory is gone, the phone's storage stays.
        vi.resetModules();
        const fresh = await import('../names-list');
        const again = await fresh.openNamesList(COMMUNITY, ada, STORE);
        expect(again.ok && restoredIn(again.value.notices)).toBe(1);
        const third = await fresh.openNamesList(COMMUNITY, ada, STORE);
        expect(third.ok && restoredIn(third.value.notices)).toBe(0);
    });

    it('not said for a node with no copy (404), nor after Start afresh', async () => {
        const { node, phones: [, ada] } = await community(['Owen', 'Ada'], true);
        const held = node.copies!.get(ada.publicKey)!;
        node.copies!.delete(ada.publicKey);
        wipe(ada);
        const none = await openNamesList(COMMUNITY, ada, STORE);
        expect(none.ok && restoredIn(none.value.notices)).toBe(0);
        // A refused copy, then Start afresh: nothing was restored, so nothing says so.
        wipe(ada);
        const tag = (held.box as { copyTag: string }).copyTag;
        node.copies!.set(ada.publicKey, { ...held, seq: held.seq + 5, box: { ...(held.box as object), copyTag: (tag[0] === 'A' ? 'B' : 'A') + tag.slice(1) } });
        const bad = await openNamesList(COMMUNITY, ada, STORE);
        expect(bad.ok).toBe(false);
        const afresh = await startAfreshOnThisPhone(COMMUNITY, ada, STORE);
        expect(afresh.ok && restoredIn(afresh.value.notices)).toBe(0);
        const after = await openNamesList(COMMUNITY, ada, STORE);
        expect(after.ok && restoredIn(after.value.notices)).toBe(0);
    });

    it('end to end: Ada signs out (copies saved, the real wipe), signs in with the same 12 words, and her list is back with no code check', async () => {
        const { createIdentityFromMnemonic, wipeIdentityScopedStorage } = await import('../identity');
        const { generateMnemonic } = await import('../crypto');
        const words = generateMnemonic();
        const owen = await admin('Owen');
        const ada = await createIdentityFromMnemonic(words, 'Ada');
        const node = new FakeNode();
        node.copies = new Map();
        node.admins = [role(owen, 'owner'), role(ada)];
        answer = (req) => node.answer(req);
        await open(owen);
        await meet(node, owen, ada);
        for (let i = 0; i < 2; i++) for (const p of [owen, ada]) await openNamesList(COMMUNITY, p, STORE);
        expect((await open(ada)).plan.kind).toBe('ready');
        const k1 = node.current()!.id;
        const key = await keyOf(owen, k1);
        node.add(key, k1, PLANTED[0]);
        node.add(key, k1, PLANTED[2]);
        const label = namesTrustStoreKey(ada.publicKey, COMMUNITY);
        expect(secrets.has(namesPinSecretName(label))).toBe(true);

        // Sign Out: the copies first (confirmed: no words), then the wipe as identity.ts does it.
        expect(namesSignOutWords(await saveNamesCopiesBeforeLeaving(ada, namesPinAddresses([...mem.keys()], ada.publicKey), STORE))).toBeNull();
        const storage = {
            getAllKeys: async () => [...mem.keys()],
            multiRemove: async (keys: string[]) => { keys.forEach((k) => mem.delete(k)); },
            removeItem: async (k: string) => { mem.delete(k); },
        };
        await wipeIdentityScopedStorage(storage, { deleteSecret: async (n) => { secrets.delete(n); } });
        expect([...mem.keys()].filter((k) => k.startsWith('beanpool:names-') && k.includes(ada.publicKey.toLowerCase()))).toEqual([]);
        expect(secrets.has(namesPinSecretName(label))).toBe(false);
        expect(await pinOf(ada)).toBeNull();

        // Signed in again with the same words: the same key, and the list opens with nobody checking codes.
        const back = await createIdentityFromMnemonic(words, 'Ada');
        expect(back.publicKey).toBe(ada.publicKey);
        sent = [];
        const opened = await open(back);
        expect(opened.plan.kind).toBe('ready');
        expect(named(opened)).toEqual([PLANTED[0], PLANTED[2]].sort());
        expect(restoredIn(opened.notices)).toBe(1);
        expect(sentAs('GET', '/api/names/copy').length).toBe(1);
        expect(sentAs('POST', '/api/names/shares')).toEqual([]);
        expect(sent.every(nothingReadable)).toBe(true);
    });
});

describe('§5 Sign Out never waits long on a node (10 s a request, 30 s in all)', () => {
    afterEach(() => { vi.useRealTimers(); });
    const never = () => new Promise<void>(() => {});
    /** Starts the save under fake timers and says when it settled, in fake ms. */
    function timed<T>(p: Promise<T>) {
        const t0 = Date.now();
        const r: { at: number | null; value: T | null } = { at: null, value: null };
        p.then((v) => { r.at = Date.now() - t0; r.value = v; });
        return r;
    }

    it('a node that never answers the state: not confirmed at 10 s (not 120 s), with the general words', async () => {
        const { phones: [owen] } = await community(['Owen'], true);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        hold = (req) => (new URL(req.url).pathname === '/api/names/state' ? never() : null);
        const r = timed(saveNamesCopiesBeforeLeaving(owen, [COMMUNITY], STORE));
        await vi.advanceTimersByTimeAsync(NAMES_SIGN_OUT_REQUEST_MS - 1);
        expect(r.at).toBeNull();
        await vi.advanceTimersByTimeAsync(1);
        expect(r.at).toBe(NAMES_SIGN_OUT_REQUEST_MS);
        expect(r.value).toEqual([{ anchor: COMMUNITY, onlyKey: null }]);
        expect(namesSignOutWords(r.value!)).toEqual({ text: NAMES_COPY.signOutNotConfirmed, pdf: false });
    });

    it('the state comes, the copy\'s PUT never answers: not confirmed 10 s later, with the only-holder words', async () => {
        const { node, phones: [owen] } = await community(['Owen'], true);
        node.copies!.delete(owen.publicKey);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        hold = (req) => (req.method === 'PUT' && new URL(req.url).pathname === '/api/names/copy' ? never() : null);
        const r = timed(saveNamesCopiesBeforeLeaving(owen, [COMMUNITY], STORE));
        await vi.advanceTimersByTimeAsync(NAMES_SIGN_OUT_REQUEST_MS);
        expect(r.at).toBe(NAMES_SIGN_OUT_REQUEST_MS);
        expect(sentAs('PUT', '/api/names/copy').length).toBe(1);
        expect(namesSignOutWords(r.value!)).toEqual({ text: NAMES_COPY.signOutOnlyCopy(1), pdf: true });
    });

    it('the pin held by an open still waiting on its 120 s state: let go at 30 s; when the open ends, the let-go save sends and writes nothing', async () => {
        const { phones: [owen] } = await community(['Owen'], true);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        hold = (req) => (new URL(req.url).pathname === '/api/names/state' ? never() : null);
        void openNamesList(COMMUNITY, owen, STORE); // takes the pin's chain and waits on the state
        await vi.advanceTimersByTimeAsync(0);
        const r = timed(saveNamesCopiesBeforeLeaving(owen, [COMMUNITY], STORE));
        await vi.advanceTimersByTimeAsync(NAMES_SIGN_OUT_TOTAL_MS);
        expect(r.at).toBe(NAMES_SIGN_OUT_TOTAL_MS);
        expect(r.value).toEqual([{ anchor: COMMUNITY, onlyKey: null }]);
        // Sign Out wipes the pin; the open's state then fails at its own limit, and the let-go link runs: nothing.
        for (const k of [...mem.keys()]) if (k.startsWith('beanpool:names-')) mem.delete(k);
        hold = null;
        sent = [];
        await vi.advanceTimersByTimeAsync(120_000);
        expect(sentAs('PUT', '/api/names/copy')).toEqual([]);
        expect(sentAs('GET', '/api/names/state')).toEqual([]);
        expect([...mem.keys()].filter((k) => k.startsWith('beanpool:names-trust:'))).toEqual([]);
    });
});

describe('§8 21. Two phones, one key: the higher-seq copy is merged, never rolled back (design §3, §5 "Merging")', () => {
    /** One phone's names storage for this key: its AsyncStorage keys and its pin's sealing secret. */
    const takePhone = (me: BeanPoolIdentity) => ({
        mem: new Map([...mem].filter(([k]) => k.startsWith('beanpool:names-') && k.includes(me.publicKey.toLowerCase()))),
        secret: secrets.get(namesPinSecretName(namesTrustStoreKey(me.publicKey, COMMUNITY))),
    });
    const putPhone = (me: BeanPoolIdentity, p: ReturnType<typeof takePhone>) => {
        for (const k of [...mem.keys()]) if (k.startsWith('beanpool:names-') && k.includes(me.publicKey.toLowerCase())) mem.delete(k);
        for (const [k, v] of p.mem) mem.set(k, v);
        const s = namesPinSecretName(namesTrustStoreKey(me.publicKey, COMMUNITY));
        if (p.secret === undefined) secrets.delete(s); else secrets.set(s, p.secret);
    };
    const nodeCopy = (node: FakeNode, me: BeanPoolIdentity) => node.copies!.get(me.publicKey) ?? node.copies!.get(me.publicKey.toLowerCase());

    it('21 phone A, back after phone B saved a newer copy with a key A lacks: A takes it, keeps both keys, saves past both, says it once', async () => {
        const { node, phones: [owen, ada, bea], k1 } = await community(['Owen', 'Ada', 'Bea'], true);
        const phoneA = takePhone(ada);
        const was = (await pinOf(ada))!;
        // Phone B: the same 12 words on a new phone (no pin): restored from the copy.
        putPhone(ada, { mem: new Map(), secret: undefined });
        expect((await open(ada)).plan.kind).toBe('ready');
        // Owen removes Bea: a new key reaches phone B only, and B saves a newer copy.
        node.admins = [role(owen, 'owner'), role(ada)];
        await removeOldKey(STORE, owen, COMMUNITY, bea.publicKey);
        for (let i = 0; i < 2; i++) { await open(owen); await open(ada); }
        const k2 = node.current()!.id;
        expect(k2).not.toBe(k1);
        const phoneB = (await pinOf(ada))!;
        expect(Object.keys(phoneB.ring)).toContain(k2);
        const newer = nodeCopy(node, ada)!.seq;
        expect(newer).toBeGreaterThan(was.copy.seq);
        // Phone A opens again.
        putPhone(ada, phoneA);
        sent = [];
        const a = await open(ada);
        const after = (await pinOf(ada))!;
        expect(after.copy.seq).toBe(newer + 1);
        expect(nodeCopy(node, ada)!.seq).toBe(after.copy.seq);
        expect(after.chain.map((l) => l.id)).toEqual(phoneB.chain.map((l) => l.id));
        expect(Object.keys(after.ring)).toEqual(expect.arrayContaining([k1, k2]));
        expect(sentAs('GET', '/api/names/copy').length).toBe(1);
        expect(a.notices).toContain(NAMES_COPY.copyNewer);
        expect((await open(ada)).notices).not.toContain(NAMES_COPY.copyNewer);
        // The merge itself: the further chain kept whichever side holds it, never a lower number, no key of either lost.
        const ab = mergeNamesPins(was, phoneB);
        const ba = mergeNamesPins(phoneB, was);
        for (const m of [ab, ba]) {
            expect(m.chain.map((l) => l.id)).toEqual(phoneB.chain.map((l) => l.id));
            expect(m.copy.seq).toBe(Math.max(was.copy.seq, phoneB.copy.seq));
            expect(Object.keys(m.ring).sort()).toEqual([...new Set([...Object.keys(was.ring), ...Object.keys(phoneB.ring)])].sort());
        }
    });
});

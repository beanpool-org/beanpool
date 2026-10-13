/**
 * Group chats: a member's history from before they changed phones comes back only with their old 12 words or a fellow
 * member's in-person confirmation (scratch/global-node/DESIGN-group-history-after-rekey-fable.md §3, §4, §8 S2 + S3;
 * Marty's picks of 13 Oct 2026), against a REAL node on this machine (apps/server/src/phone-door-test-harness.ts),
 * started from the packages' sources and killed by its PID. Each phone is its own identity and key store and runs the
 * phone's own code (group-history-unlock.ts, group-chat-keys.ts, name-key-memory.ts, key-succession.ts).
 *
 *   Path A: wrong words → the sentence, nothing fetched; the node's chain naming another key → the owner sentence,
 *   nothing posted; a withheld group stays locked while the rest unlock; a re-run resumes; every line readable under the
 *   member's name; the words and the old seed in no request, store write or phone storage; a later restore reads all.
 *   Path B: Ben hands exactly {e : old ∈ rec(e), new ∉ rec(e)} across the groups they share, nothing in a group she is
 *   not in, whatever the node does to members, chain and missing between the scan and the post; the puppet's code, no
 *   memory and chain ≠ memory are refused; the human limit measured once (an impostor's code Ben confirms in person).
 *   No automatic path: a puppet claiming her old key, listed in missing, is handed 0 by every phone. The #1826
 *   reviewer's R1, R2, J, V and A3w stay 0-cases in group-chat-key-succession.test.ts, unchanged.
 *
 * Nothing else is contacted: the phones' fetch is held to this node's address.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { unpackRecoveryWords } from '@beanpool/core';

(globalThis as any).__DEV__ = false;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
}));
vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))),
    randomUUID: vi.fn(() => randomUUID()),
    digest: vi.fn(async (_algorithm: string, data: Uint8Array) => {
        const out = createHash('sha256').update(data).digest();
        return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    }),
}));
const mem = vi.hoisted(() => ({ async: new Map<string, string>(), secure: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.async.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => mem.secure.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { mem.secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { mem.secure.delete(key); }),
}));

import { signedGet, signedPost } from '../node-post';
import { groupKeyring, memoryGroupKeyStore, forgetGroupKeys, joinGroupWithEpoch, type GroupKeyStore } from '../group-chat-keys';
import {
    unlockWithOldWords, oldKeyFromWords, newPhoneQrPayload, parseNewPhoneQr, checkNewPhone, confirmNewPhone, newPhoneConfirmText, NEW_PHONE_QR_TAG,
} from '../group-history-unlock';
import { rememberRosterNames } from '../name-key-memory';
import { sendSealedGroupLine, openGroupThread, chatIsLocked } from '../group-chat-lines';
import { type DisplayRosterRow } from '../group-line-display';
import { attestJustCompletedRekey, oldKeySignedHere } from '../key-succession';
import { makeKeySuccession } from '../group-chat-crypto';
import type { BeanPoolIdentity } from '../identity';

const SERVER_DIR = fileURLToPath(new URL('../../../server/', import.meta.url).href);
const START_MS = 120_000;

let node: ChildProcessWithoutNullStreams;
let dataDir: string;
let URL_BASE = '';
const replies = new Map<number, (r: { result?: any; error?: string }) => void>();
let nextId = 1;
const realFetch = globalThis.fetch;
const sent: { method: string; path: string; status: number }[] = [];
const elsewhere: string[] = [];
/** The node made dishonest in the fetch layer: a hook answers instead of the node (the phone can't tell the difference). */
type Hook = (r: { method: string; path: string; input: any; init: any }) => Promise<Response | undefined> | Response | undefined;
const hooks: Hook[] = [];

function control<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        replies.set(id, (r) => (r.error ? reject(new Error(r.error)) : resolve(r.result as T)));
        node.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
}

interface Phone { name: string; identity: BeanPoolIdentity; store: GroupKeyStore }
function phone(name: string, seed = randomBytes(32)): Phone {
    const identity: BeanPoolIdentity = {
        publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed), callsign: name, createdAt: new Date().toISOString(),
    };
    return { name, identity, store: memoryGroupKeyStore() };
}

async function json(res: Response): Promise<any> {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`${res.status} ${body?.error ?? ''}`), { status: res.status, body });
    return body;
}
const getChat = async (p: Phone, g: string) => json(await signedGet(URL_BASE, `/api/groups/${g}/chat?limit=100`, p.identity));
const roster = async (p: Phone, g: string): Promise<DisplayRosterRow[]> =>
    (await json(await signedGet(URL_BASE, `/api/groups/${g}/members`, p.identity))).map((m: any) => ({ memberPubkey: m.memberPubkey, callsign: m.callsign, formerKeys: m.formerKeys }));
const ring = (p: Phone, g: string) => groupKeyring(URL_BASE, p.identity, g, p.store);
const say = (p: Phone, g: string, text: string, extra: Record<string, unknown> = {}) =>
    sendSealedGroupLine(URL_BASE, p.identity, p.store, { groupId: g, text, clientId: randomUUID(), ...extra });

/** What a phone shows of a group's chat: each sealed line as the display rule names it, in order. */
async function shown(p: Phone, g: string, rosterOverride?: DisplayRosterRow[], nodeNameOf?: (pk: string) => string | null) {
    const answer = await getChat(p, g);
    expect(chatIsLocked(answer)).toBe(true);
    const opened = await openGroupThread(ring(p, g), answer, rosterOverride ?? await roster(p, g), nodeNameOf);
    const lines = (answer.messages as any[]).filter((m) => opened.views.has(m.id)).map((m) => ({ id: m.id as string, ...opened.views.get(m.id)! }));
    return { answer, opened, lines, visible: lines.filter((l) => !l.hidden) };
}

beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'group-history-after-rekey-'));
    node = spawn(process.execPath, ['--import', 'tsx', 'src/phone-door-test-harness.ts'], {
        cwd: SERVER_DIR,
        env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, PHONE_DOOR_PROFILE: 'community', TSX_TSCONFIG_PATH: 'tsconfig.phone-door-test-harness.json' },
        stdio: 'pipe',
    });
    let out = '';
    let log = '';
    const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the test node did not start in time:\n${log.slice(-3000)}`)), START_MS - 5_000);
        node.stdout.on('data', (chunk: Buffer) => {
            out += chunk.toString();
            log += chunk.toString();
            let nl: number;
            while ((nl = out.indexOf('\n')) >= 0) {
                const line = out.slice(0, nl);
                out = out.slice(nl + 1);
                const started = /^PHONE-DOOR-NODE-PORT (\d+)$/.exec(line);
                if (started) { clearTimeout(timer); resolve(Number(started[1])); }
                const reply = /^PHONE-DOOR-NODE-REPLY (.*)$/.exec(line);
                if (reply) {
                    const r = JSON.parse(reply[1]) as { id: number; result?: unknown; error?: string };
                    replies.get(r.id)?.(r);
                    replies.delete(r.id);
                }
            }
        });
        node.stderr.on('data', (chunk: Buffer) => { log += chunk.toString(); });
        node.on('exit', (code) => reject(new Error(`the test node exited (${code}):\n${log.slice(-3000)}`)));
    });
    URL_BASE = `https://127.0.0.1:${port}`;
    globalThis.fetch = (async (input: any, init?: any) => {
        const href = String(input instanceof Request ? input.url : input);
        if (!href.startsWith(`${URL_BASE}/`)) {
            elsewhere.push(href);
            throw new TypeError(`Network request failed: the phone contacted ${href}`);
        }
        const u = new URL(href);
        for (const h of [...hooks]) {
            const r = await h({ method: String(init?.method ?? 'GET'), path: u.pathname, input, init });
            if (r) return r;
        }
        const res = await realFetch(input, init);
        sent.push({ method: String(init?.method ?? 'GET'), path: new URL(href).pathname, status: res.status });
        return res;
    }) as typeof fetch;
}, START_MS);

afterAll(async () => {
    globalThis.fetch = realFetch;
    if (node && node.exitCode === null) {
        node.stdin.write(`${JSON.stringify({ id: 0, cmd: 'quit' })}\n`);
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => { node.kill('SIGKILL'); resolve(); }, 5_000);
            node.on('exit', () => { clearTimeout(timer); resolve(); });
        });
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    expect(elsewhere).toEqual([]);
}, START_MS);
const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function newGroup(owner: Phone, name: string): Promise<string> {
    return (await json(await signedPost(URL_BASE, '/api/groups', { name, joinPolicy: 'open' }, owner.identity))).id;
}
const join_ = (p: Phone, g: string) => joinGroupWithEpoch(URL_BASE, p.identity, p.store, { id: g, joinPolicy: 'open' });
/** The admin's re-key on the node (the harness's `rekey`: issueRekeyCode + completeRekey); the new phone starts empty. */
async function rekeyed(old: Phone, name: string): Promise<Phone> {
    const next = phone(name);
    await control('rekey', { oldKey: old.identity.publicKey, newKey: next.identity.publicKey });
    return next;
}
const reads = async (p: Phone, g: string) => (await shown(p, g)).visible.filter((l) => !l.waitingKey && !l.unverified).map((l) => `${l.name}: ${l.text}`);
/** One line from `p`, after its phone has read the roster the screen shows (so a stale record rotates first, rule 2). */
async function writes(p: Phone, g: string, text: string) {
    forgetGroupKeys();
    ring(p, g).noteShownRoster((await roster(p, g)).map((r) => r.memberPubkey));
    await say(p, g, text);
}

/** A statement `by` signs that `oldPub` was its key before it: a claim, which proves only that `by` makes it. */
const claim = (by: Phone, oldPub: string, at = '2026-10-03T04:00:00.000Z') => {
    const s = makeKeySuccession({ newEdPrivHex: by.identity.privateKey, oldPubHex: oldPub, at });
    return { pubkey: s.pubkey, at: s.at, sig: s.sig };
};

/** Every request a phone sent, with its body: the words path must send neither the words nor the old seed anywhere. */
const bodies: { method: string; path: string; body: string }[] = [];
hooks.push(async (r) => {
    bodies.push({ method: r.method, path: r.path, body: typeof r.init?.body === 'string' ? r.init.body : '' });
    return undefined;
});
/** A store that records every write: the old seed must be in none. */
function recordingStore(): { store: GroupKeyStore; writes: string[] } {
    const inner = memoryGroupKeyStore();
    const writes: string[] = [];
    const rec = (name: string, f: (...a: any[]) => Promise<any>) => async (...a: any[]) => { writes.push(`${name} ${JSON.stringify(a)}`); return f(...a); };
    return {
        writes,
        store: {
            ...inner,
            putEpochs: rec('putEpochs', inner.putEpochs), setCursor: rec('setCursor', inner.setCursor), raiseHighest: rec('raiseHighest', inner.raiseHighest),
            dropWrap: rec('dropWrap', inner.dropWrap), addVerdict: rec('addVerdict', inner.addVerdict), putSigner: rec('putSigner', inner.putSigner),
        },
    };
}
/** A phone whose key is made from 12 words, as a restore makes it. */
function wordsPhone(name: string): Phone & { words: string[] } {
    let words: string[] = [];
    do {
        const packed = new Uint8Array(randomBytes(17));
        packed[16] &= 0xf0;
        words = unpackRecoveryWords(packed);
    } while (!oldKeyFromWords(words));
    const k = oldKeyFromWords(words)!;
    const p = phone(name, Buffer.from(k.seed));
    return { ...p, words };
}
const pk = (p: Phone) => p.identity.publicKey;
const sql = (s: string, params: unknown[] = []) => control<any[]>('sql', { sql: s, params, all: true });
/** The epochs of `g` whose record's own wraps name `key` (the signed recipients, kept since the re-key). */
const recordNames = async (g: string, key: string) => (await sql('SELECT epoch FROM group_key_wraps WHERE group_id = ? AND recipient_pubkey = ? AND sig IS NULL ORDER BY epoch', [g, key])).map((r) => r.epoch as number);
/** The (group, epoch) top-ups `wrapper` made to `recipient`. */
const topUps = async (wrapper: string, recipient: string) =>
    (await sql('SELECT group_id, epoch FROM group_key_wraps WHERE wrapper_pubkey = ? AND recipient_pubkey = ? AND sig IS NOT NULL ORDER BY group_id, epoch', [wrapper, recipient])).map((r) => `${r.group_id}#${r.epoch}`);
const posts = (from: number, path: RegExp) => bodies.slice(from).filter((b) => b.method === 'POST' && path.test(b.path));
const fetchedAny = (from: number) => bodies.slice(from).length;

/** Three groups Ben, Cat and Dov share, a line from each under an old epoch; one group without Cat. */
async function sharedGroups(cat: Phone, ben: Phone, dov: Phone, tag: string) {
    const groups: { id: string; name: string }[] = [];
    for (const name of [`Gardeners ${tag}`, `Repair Café ${tag}`, `Convenors ${tag}`]) {
        const g = await newGroup(ben, name);
        await say(ben, g, `Ben in ${name}`);
        await join_(cat, g);
        await writes(cat, g, `Cat in ${name}`);
        await join_(dov, g);
        await writes(dov, g, `Dov in ${name}`);
        groups.push({ id: g, name });
    }
    const without = await newGroup(ben, `Ben and Dov ${tag}`);
    await join_(dov, without);
    await writes(dov, without, 'no Cat here');
    return { groups, without };
}

describe('path A: the old 12 words bring the history back to the new phone (design §3, S2)', () => {
    it('setup: node members', async () => {
        await control('limiters');
    });

    it('wrong words, the owner sentence, a withheld group, the unlock, a later restore, and the words sent nowhere', async () => {
        await control('limiters');
        forgetGroupKeys();
        const cat = wordsPhone('Cat');
        const ben = phone('Ben');
        const dov = phone('Dov');
        await control('members', { members: [cat, ben, dov].map((p) => ({ key: pk(p), callsign: p.name })) });
        const { groups } = await sharedGroups(cat, ben, dov, 'A');
        const [g1, g2, g3] = groups;
        // Cat loses her phone and words; the admin re-keys her; her new phone confirms the re-key at once.
        const rec = recordingStore();
        const cat2: Phone = { ...(await rekeyed(cat, 'Cat')), store: rec.store };
        expect(await attestJustCompletedRekey(URL_BASE, cat2.identity)).toBe(1);
        expect(await oldKeySignedHere(URL_BASE, cat2.identity)).toBe(pk(cat));
        for (const g of groups) await writes(ben, g.id, `Ben after the change in ${g.name}`);
        forgetGroupKeys();
        expect(await reads(cat2, g1.id)).toEqual([`Ben: Ben after the change in ${g1.name}`]);
        const lockedBefore = (await shown(cat2, g1.id)).visible.filter((l) => l.waitingKey).length;
        expect(lockedBefore).toBeGreaterThanOrEqual(2);

        const ctx = { nodeUrl: URL_BASE, identity: cat2.identity, store: cat2.store, groups: groups.map((g) => ({ ...g, locked: 3 })) };
        // Wrong words: the sentence, nothing fetched.
        let mark = bodies.length;
        const wrong = await unlockWithOldWords({ ...ctx, typed: wordsPhone('x').words, signedHere: pk(cat) });
        expect(wrong.outcome).toBe('not_the_key');
        expect(fetchedAny(mark)).toBe(0);
        // Her new key's own words: the same.
        expect((await unlockWithOldWords({ ...ctx, typed: 'not twelve words', signedHere: null })).outcome).toBe('not_the_key');
        expect(fetchedAny(mark)).toBe(0);

        // The node's chain says Zed, not her old key: the owner sentence, nothing posted.
        const zed = phone('Zed');
        const zedChain: Hook = async (r) => {
            if (r.method !== 'GET' || !/\/keys\/former$/.test(r.path)) return undefined;
            const a = await (await realFetch(r.input, r.init)).json();
            return jsonResponse(200, { ...a, formerKeys: [pk(zed)] });
        };
        hooks.push(zedChain);
        mark = bodies.length;
        const owner = await unlockWithOldWords({ ...ctx, typed: cat.words, signedHere: null });
        hooks.splice(hooks.indexOf(zedChain), 1);
        expect(owner.outcome).toBe('owner');
        expect(posts(mark, /\/keys\/wrap$/)).toEqual([]);

        // The node withholds Convenors: that group's row stays, the rest unlock.
        const withhold: Hook = (r) => (r.method === 'GET' && r.path === `/api/groups/${g3.id}/keys/former` ? jsonResponse(200, { formerKeys: [pk(cat)], epochs: [], wraps: [], more: false }) : undefined);
        hooks.push(withhold);
        mark = bodies.length;
        const progress: string[] = [];
        const done = await unlockWithOldWords({ ...ctx, typed: cat.words, signedHere: pk(cat), onProgress: (d, t) => progress.push(`${d}/${t}`) });
        hooks.splice(hooks.indexOf(withhold), 1);
        expect(done.outcome).toBe('done');
        expect(done.withheld.map((g) => g.id)).toEqual([g3.id]);
        expect(Object.keys(done.unlocked).sort()).toEqual([g1.id, g2.id].sort());
        expect(progress.at(-1)).toBe('3/3');
        // Each self-wrap is to her new key, made by it, one per old epoch her old key held.
        const selfPosts = posts(mark, /\/keys\/wrap$/).map((b) => JSON.parse(b.body));
        expect(selfPosts.every((b) => b.recipient === pk(cat2))).toBe(true);
        console.log(`MEASURED path A: ${selfPosts.length} self-wraps posted for 2 groups; withheld ${done.withheld.length}; refused ${done.refused}`);
        expect(selfPosts.length).toBeGreaterThan(0);
        expect(selfPosts.length).toBe((await recordNames(g1.id, pk(cat))).length + (await recordNames(g2.id, pk(cat))).length);
        forgetGroupKeys();
        expect(await reads(cat2, g1.id)).toEqual(expect.arrayContaining([`Cat: Cat in ${g1.name}`, `Dov: Dov in ${g1.name}`]));
        expect((await shown(cat2, g1.id)).visible.filter((l) => l.waitingKey).length).toBe(0);
        expect((await shown(cat2, g3.id)).visible.filter((l) => l.waitingKey).length).toBeGreaterThanOrEqual(2);

        // Run again once the node hands Convenors over: it resumes with only that group's epochs.
        mark = bodies.length;
        const resumed = await unlockWithOldWords({ ...ctx, typed: cat.words, signedHere: pk(cat) });
        expect(Object.keys(resumed.unlocked)).toEqual([g3.id]);
        expect(new Set(posts(mark, /\/keys\/wrap$/).map((b) => b.path))).toEqual(new Set([`/api/groups/${g3.id}/keys/wrap`]));
        forgetGroupKeys();
        expect(await reads(cat2, g3.id)).toEqual(expect.arrayContaining([`Cat: Cat in ${g3.name}`]));

        // The words and the old seed: in no request, no key store write, no phone storage.
        const seedHex = Buffer.from(oldKeyFromWords(cat.words)!.seed).toString('hex');
        const phrase = cat.words.join(' ');
        const leaks = (s: string) => s.includes(seedHex) || s.includes(phrase) || cat.words.filter((w) => w.length > 4 && new RegExp(`\\b${w}\\b`).test(s)).length >= 6;
        expect(bodies.filter((b) => leaks(b.body) || leaks(b.path))).toEqual([]);
        expect(rec.writes.filter(leaks)).toEqual([]);
        expect([...mem.async.values(), ...mem.secure.values()].filter(leaks)).toEqual([]);

        // A later 12-word restore of her NEW key, on yet another phone: the self-wraps are on the node.
        forgetGroupKeys();
        const cat3: Phone = { ...cat2, store: memoryGroupKeyStore() };
        for (const g of groups) expect(await reads(cat3, g.id)).toEqual(expect.arrayContaining([`Cat: Cat in ${g.name}`, `Dov: Dov in ${g.name}`]));
        expect(elsewhere).toEqual([]);
    });
});

describe('path B: a member confirms the new phone in person (design §4, S3)', () => {
    /** Ben's phone opens each group's members list (the screen remembers names, name-key-memory.ts). */
    const benSees = async (ben: Phone, gs: readonly { id: string }[]) => { for (const g of gs) await rememberRosterNames(URL_BASE, await roster(ben, g.id)); };

    it('Ben hands exactly the epochs whose record names her old key; a doctoring node changes nothing; every refusal; the human limit', async () => {
        await control('limiters');
        forgetGroupKeys();
        const cat = phone('Cata');
        const ben = phone('Benn');
        const dov = phone('Dove');
        const pip = phone('Pipp');
        await control('members', { members: [cat, ben, dov, pip].map((p) => ({ key: pk(p), callsign: p.name })) });
        const { groups, without } = await sharedGroups(cat, ben, dov, 'B');
        const all = [...groups, { id: without, name: 'Ben and Dov B' }];
        await benSees(ben, all);
        const cat2 = await rekeyed(cat, 'Cata');
        expect(await attestJustCompletedRekey(URL_BASE, cat2.identity)).toBe(1);
        for (const g of groups) await writes(ben, g.id, `Ben after in ${g.name}`);
        await benSees(ben, all);

        // The code her new phone shows, and the checks on Ben's phone.
        const code = newPhoneQrPayload(cat2.identity, (await oldKeySignedHere(URL_BASE, cat2.identity))!);
        expect(parseNewPhoneQr(code)).toEqual({ newKey: pk(cat2), oldKey: pk(cat), callsign: 'Cata' });
        const ctx = { nodeUrl: URL_BASE, identity: ben.identity, groups: all };
        expect((await checkNewPhone({ ...ctx, scanned: 'hello' })).ok).toBe(false);
        // The code carries the puppet's key: not the phone the community lists for Cata.
        const pipCode = JSON.stringify([NEW_PHONE_QR_TAG, pk(pip), pk(cat), 'Cata']);
        expect(await checkNewPhone({ ...ctx, scanned: pipCode })).toMatchObject({ ok: false, reason: 'not_listed' });
        // No memory: Dov's own phone never opened a members list, so it never knew Cata's old key. (The memory is the
        // phone's, per community; these phones share one test storage, so Dov's phone is one with that entry empty.)
        const memKey = `beanpool_name_keys:${URL_BASE}`;
        const bens = mem.async.get(memKey);
        mem.async.delete(memKey);
        expect(await checkNewPhone({ ...ctx, identity: dov.identity, scanned: code })).toMatchObject({ ok: false, reason: 'no_memory' });
        if (bens !== undefined) mem.async.set(memKey, bens);
        // Chain ≠ memory: a code naming another old key than the one Ben's phone saw under her name.
        const zedCode = JSON.stringify([NEW_PHONE_QR_TAG, pk(cat2), pk(phone('Zed')), 'Cata']);
        expect(await checkNewPhone({ ...ctx, scanned: zedCode })).toMatchObject({ ok: false, reason: 'mismatch' });

        const check = await checkNewPhone({ ...ctx, scanned: code });
        expect(check.ok).toBe(true);
        if (!check.ok) return;
        expect(check.groups.map((g) => g.id).sort()).toEqual(groups.map((g) => g.id).sort());
        expect(newPhoneConfirmText(check.name, check.groups.map((g) => g.name))).toContain("Only confirm if this phone is in Cata's hands");

        // Between the scan and the post the node doctors the members answer (Cata dropped from one group, added to Ben and
        // Dov's), her chain, and `missing` (listing her new key for every epoch of every group): the set is the same.
        const doctor: Hook = async (r) => {
            if (r.method !== 'GET') return undefined;
            if (/\/members$/.test(r.path)) {
                const rows = await (await realFetch(r.input, r.init)).json();
                const out = r.path.includes(groups[1].id) ? rows.filter((m: any) => m.memberPubkey !== pk(cat2))
                    : r.path.includes(without) ? [...rows, { memberPubkey: pk(cat2), callsign: 'Cata', status: 'active', formerKeys: [] }] : rows;
                return jsonResponse(200, out.map((m: any) => (m.memberPubkey === pk(cat2) ? { ...m, formerKeys: [claim(pip, pk(cat))] } : m)));
            }
            if (/\/keys\/missing$/.test(r.path)) return jsonResponse(200, { epoch: 99, missing: [{ pubkey: pk(cat2), fromEpoch: 1, epochs: [1, 2, 3, 4, 5, 6] }] });
            return undefined;
        };
        hooks.push(doctor);
        const mark = bodies.length;
        const counted = { opens: 0 };
        const done = await confirmNewPhone({ nodeUrl: URL_BASE, identity: ben.identity, store: ben.store, check, onProgress: () => { counted.opens++; } });
        hooks.splice(hooks.indexOf(doctor), 1);
        expect(done.stopped).toBe(false);
        // Expected, from the node's rows: {e : Cata's old key ∈ rec(e), her new key ∉ rec(e)} in the shared groups (Ben holds
        // every epoch of each, as a member from its start).
        const expected: string[] = [];
        for (const g of groups) {
            const names = await recordNames(g.id, pk(cat));
            const newNamed = new Set(await recordNames(g.id, pk(cat2)));
            for (const e of names) if (!newNamed.has(e)) expected.push(`${g.id}#${e}`);
        }
        expect(expected.length).toBeGreaterThan(0);
        expect((await topUps(pk(ben), pk(cat2))).sort()).toEqual(expected.sort());
        expect(done.total).toBe(expected.length);
        expect(posts(mark, /\/keys\/wrap$/).length).toBe(expected.length);
        expect(posts(mark, /\/keys\/wrap$/).every((b) => JSON.parse(b.body).recipient === pk(cat2))).toBe(true);
        expect((await topUps(pk(ben), pk(cat2))).filter((x) => x.startsWith(without))).toEqual([]);
        // At most one wraps read per epoch Ben holds.
        const wrapsReads = bodies.slice(mark).filter((b) => /\/keys\/\d+\/wraps$/.test(b.path)).length;
        const benEpochs = (await sql('SELECT COUNT(*) AS n FROM group_key_wraps WHERE recipient_pubkey = ? AND group_id IN (?, ?, ?)', [pk(ben), ...groups.map((g) => g.id)]))[0].n;
        expect(wrapsReads).toBeLessThanOrEqual(benEpochs);
        console.log(`MEASURED path B: handed ${done.total} = expected ${expected.length} across ${groups.length} shared groups under doctoring; wraps reads ${wrapsReads} ≤ Ben's epochs ${benEpochs}`);
        // Her new phone reads them, under the names.
        forgetGroupKeys();
        for (const g of groups) expect(await reads(cat2, g.id)).toEqual(expect.arrayContaining([`Cata: Cat in ${g.name}`, `Dove: Dov in ${g.name}`]));

        // The human limit, measured once: the node lists an impostor as Cata's current key with a chain to her old key (the
        // impostor signs a claim), and Ben, in person, confirms the impostor's code. He hands exactly the same kind of set:
        // the epochs whose record names her old key and not the impostor; nothing else.
        const imp = phone('Impo');
        const g0 = groups[0].id;
        await control('members', { members: [{ key: pk(imp), callsign: 'Impo' }] });
        await control('groupRows', { groupId: g0, keys: [pk(imp)] });
        await control('sql', { sql: 'UPDATE group_members SET from_epoch = 1 WHERE group_id = ? AND member_pubkey = ?', params: [g0, pk(imp)] });
        const lie: Hook = async (r) => {
            if (r.method !== 'GET' || r.path !== `/api/groups/${g0}/members`) return undefined;
            const rows = await (await realFetch(r.input, r.init)).json();
            return jsonResponse(200, rows.filter((m: any) => m.memberPubkey !== pk(cat2)).map((m: any) => (m.memberPubkey === pk(imp) ? { ...m, callsign: 'Cata', formerKeys: [claim(imp, pk(cat))] } : m)));
        };
        hooks.push(lie);
        const impCheck = await checkNewPhone({ ...ctx, groups: [groups[0]], scanned: JSON.stringify([NEW_PHONE_QR_TAG, pk(imp), pk(cat), 'Cata']) });
        expect(impCheck.ok).toBe(true);
        if (impCheck.ok) await confirmNewPhone({ nodeUrl: URL_BASE, identity: ben.identity, store: ben.store, check: impCheck });
        hooks.splice(hooks.indexOf(lie), 1);
        const impExpected = (await recordNames(g0, pk(cat))).map((e) => `${g0}#${e}`);
        expect((await topUps(pk(ben), pk(imp))).sort()).toEqual(impExpected.sort());
        expect(impExpected.length).toBeGreaterThan(0);
        console.log(`MEASURED human limit: the impostor Ben confirmed got ${impExpected.length} epochs, exactly those whose record names her old key in that group`);
        expect(elsewhere).toEqual([]);
    });

    it('a puppet with a claim over her old key, listed in missing, is handed 0 by every phone (no automatic path)', async () => {
        await control('limiters');
        forgetGroupKeys();
        const cat = phone('Catb');
        const ben = phone('Benb');
        const dov = phone('Dovb');
        const pup = phone('Pupb');
        await control('members', { members: [cat, ben, dov, pup].map((p) => ({ key: pk(p), callsign: p.name })) });
        const { groups } = await sharedGroups(cat, ben, dov, 'C');
        const g = groups[0].id;
        await rekeyed(cat, 'Catb');
        await control('groupRows', { groupId: g, keys: [pk(pup)] });
        await control('sql', { sql: 'UPDATE group_members SET from_epoch = 1 WHERE group_id = ? AND member_pubkey = ?', params: [g, pk(pup)] });
        const claimHook: Hook = async (r) => {
            if (r.method !== 'GET' || r.path !== `/api/groups/${g}/members`) return undefined;
            const rows = await (await realFetch(r.input, r.init)).json();
            return jsonResponse(200, rows.map((m: any) => (m.memberPubkey === pk(pup) ? { ...m, formerKeys: [claim(pup, pk(cat))] } : m)));
        };
        hooks.push(claimHook);
        forgetGroupKeys();
        let handed = 0;
        for (const p of [ben, dov]) handed += await groupKeyring(URL_BASE, p.identity, g, p.store).serveMissing(100);
        hooks.splice(hooks.indexOf(claimHook), 1);
        expect(handed).toBe(0);
        expect(await topUps(pk(ben), pk(pup))).toEqual([]);
        expect(await topUps(pk(dov), pk(pup))).toEqual([]);
    });
});

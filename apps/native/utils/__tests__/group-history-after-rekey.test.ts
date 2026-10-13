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
 *   Review of #1844: MP (a misled new phone, one relabelled roster in a side group, then a roster leaving Zed out: refused
 *   each time, the §4 amendment), S1 (a name added to an epoch's wraps list: the digest refuses it), a chain dropped while
 *   the memory knows the old key (refused); H1/H2 (each end screen says what landed); the old phone's note cleared by the
 *   next signed success and kept for a key really replaced.
 *
 * Nothing else is contacted: the phones' fetch is held to this node's address.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    handOversHeld, noteConfirmations, confirmedNotes, newPhoneProgressText,
    newPhoneEnd, newPhoneDoneText, newPhoneRefusedRestText, newPhoneSaidHeldText, oldWordsEnd, oldWordsNothingText, OLD_WORDS_DONE, OLD_WORDS_NOTHING_LISTED,
    lockedHistoryCounts, noteLockedHistoryCount, newPhoneKeyWasOtherText, newPhoneMismatchText,
} from '../group-history-unlock';
import { rememberRosterNames } from '../name-key-memory';
import { sendSealedGroupLine, openGroupThread, chatIsLocked } from '../group-chat-lines';
import { type DisplayRosterRow } from '../group-line-display';
import { attestJustCompletedRekey, oldKeySignedHere } from '../key-succession';
import { isKeyReplacedAnswer, keyReplacedHere, watchForReplacedKey, onKeyReplaced, KEY_MOVED_OWN_ONLY, KEY_MOVED_SHOW } from '../key-replaced';
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
        // Her old phone, if found: the node answers its key's signed requests with the replaced-key code, which that phone
        // keeps so it can offer its old words to the new one (utils/key-replaced.ts, components/KeyMovedCard.tsx).
        const oldAsk = await signedGet(URL_BASE, `/api/groups/${g1.id}/members`, cat.identity);
        expect(isKeyReplacedAnswer(oldAsk.status, await oldAsk.clone().json())).toBe(true);
        expect(await keyReplacedHere(URL_BASE, pk(cat))).toBe(false);
        watchForReplacedKey(URL_BASE, pk(cat), oldAsk);
        await vi.waitFor(async () => expect(await keyReplacedHere(URL_BASE, pk(cat))).toBe(true));
        const newAsk = await signedGet(URL_BASE, `/api/groups/${g1.id}/members`, cat2.identity);
        expect(isKeyReplacedAnswer(newAsk.status, await newAsk.clone().json().catch(() => null))).toBe(false);
        expect(await keyReplacedHere(URL_BASE, pk(cat2))).toBe(false);
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

        // What her new phone holds from other members while its code is on screen (new-phone-code.tsx): nothing yet.
        const catBefore = await handOversHeld(URL_BASE, cat2.identity, cat2.store, groups);
        expect(catBefore.size).toBe(0);

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
        const progress: [number, number][] = [];
        const done = await confirmNewPhone({ nodeUrl: URL_BASE, identity: ben.identity, store: ben.store, check, onProgress: (n, m) => { progress.push([n, m]); } });
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
        // "N of M": the whole list is made before the first wrap, so M is known from the start and N reaches it.
        expect(done.planned).toBe(expected.length);
        expect(progress[0]).toEqual([0, expected.length]);
        expect(progress[progress.length - 1]).toEqual([expected.length, expected.length]);
        expect(new Set(progress.map(([, m]) => m))).toEqual(new Set([expected.length]));
        expect(newPhoneProgressText(42, 120)).toBe('Unlocking 42 of 120…');
        expect(posts(mark, /\/keys\/wrap$/).length).toBe(expected.length);
        expect(posts(mark, /\/keys\/wrap$/).every((b) => JSON.parse(b.body).recipient === pk(cat2))).toBe(true);
        expect((await topUps(pk(ben), pk(cat2))).filter((x) => x.startsWith(without))).toEqual([]);
        // At most one wraps read per epoch Ben holds.
        const wrapsReads = bodies.slice(mark).filter((b) => /\/keys\/\d+\/wraps$/.test(b.path)).length;
        const benEpochs = (await sql('SELECT COUNT(*) AS n FROM group_key_wraps WHERE recipient_pubkey = ? AND group_id IN (?, ?, ?)', [pk(ben), ...groups.map((g) => g.id)]))[0].n;
        expect(wrapsReads).toBeLessThanOrEqual(benEpochs);
        console.log(`MEASURED path B: handed ${done.total} = expected ${expected.length} across ${groups.length} shared groups under doctoring; wraps reads ${wrapsReads} ≤ Ben's epochs ${benEpochs}`);
        // Her new phone keeps its own note of who confirmed it: Ben, by the name the members list gives the key that
        // wrapped keys which open on her phone. Nothing about it is posted (the only posts are Ben's wraps, counted above).
        const notesMark = bodies.length;
        const notes = await noteConfirmations({ nodeUrl: URL_BASE, identity: cat2.identity, store: cat2.store, groups, before: catBefore });
        expect(notes.map((n) => n.name)).toEqual(['Benn']);
        expect((await confirmedNotes(URL_BASE, pk(cat2))).map((n) => n.name)).toEqual(['Benn']);
        expect(bodies.slice(notesMark).filter((b) => b.method !== 'GET')).toEqual([]);
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

// ─── Review of #1844 (finding 1, the §4 amendment; finding 3, the tests; finding 4, the end screens; finding 5, the card) ──
describe('review of #1844: path B against a node that rewrites names, wraps lists and chains; honest end screens; the old phone\'s card', () => {
    const benSees = async (ben: Phone, gs: readonly { id: string }[]) => { for (const g of gs) await rememberRosterNames(URL_BASE, await roster(ben, g.id)); };
    const memoryOf = (name: string) => JSON.parse(mem.async.get(`beanpool_name_keys:${URL_BASE}`) ?? '{}')[name.toLowerCase()];
    // A case that fails part way leaves no hook of its own behind for the next one.
    let hooksBefore: Hook[] = [];
    beforeEach(() => { hooksBefore = [...hooks]; });
    afterEach(() => { hooks.splice(0, hooks.length, ...hooksBefore); });

    it('MP: a misled Cat₂ never collects Zed\'s history through Ben\'s honest scan — refused at once, after one relabelled roster in a side group, and after a roster that leaves Zed out', async () => {
        await control('limiters');
        forgetGroupKeys();
        const ben = phone('Benp');
        const zed = phone('Zedp');
        const cat = phone('Catp');
        await control('members', { members: [ben, zed, cat].map((p) => ({ key: pk(p), callsign: p.name })) });
        // G: Ben starts (epoch 1), Zed joins (2) and writes a line Cat never saw, Cat joins (3) and writes, Ben writes.
        const g = await newGroup(ben, 'Poison G');
        await say(ben, g, 'Ben alone');
        await join_(zed, g);
        await writes(zed, g, 'Zed before Cat');
        await join_(cat, g);
        await writes(cat, g, 'Cat here');
        await writes(ben, g, 'Ben with both');
        // H: Ben and Zed only. The relabel comes through this group's roster: the shared group's is never touched.
        const h = await newGroup(ben, 'Side H');
        await join_(zed, h);
        await writes(zed, h, 'side line');
        await benSees(ben, [{ id: g }, { id: h }]);
        expect(memoryOf('Catp')).toEqual({ key: pk(cat) });
        expect(memoryOf('Zedp')).toEqual({ key: pk(zed) });

        // Cat loses her phone; the admin re-keys her. The node misleads her new phone once: the one re-key it lists for her
        // is over Zed's key, so her phone signs that (NB5: exactly one listed). Served as her chain from here on, and her new
        // key is let hold keys from epoch 1 (as the puppet set-ups above do).
        const cat2 = await rekeyed(cat, 'Catp');
        const misled = claim(cat2, pk(zed));
        const chainHook: Hook = async (r) => {
            if (r.method !== 'GET' || !/\/members$/.test(r.path)) return undefined;
            const rows = await (await realFetch(r.input, r.init)).json();
            return jsonResponse(200, rows.map((m: any) => (m.memberPubkey === pk(cat2) ? { ...m, formerKeys: [misled] } : m)));
        };
        hooks.push(chainHook);
        await control('sql', { sql: 'UPDATE group_members SET from_epoch = 1 WHERE group_id = ? AND member_pubkey = ?', params: [g, pk(cat2)] });
        await benSees(ben, [{ id: g }]);
        // Her honest code names the key her phone signed for: Zed's.
        const code = JSON.stringify([NEW_PHONE_QR_TAG, pk(cat2), pk(zed), 'Catp']);
        const ctx = { nodeUrl: URL_BASE, identity: ben.identity, groups: [{ id: g, name: 'Poison G' }, { id: h, name: 'Side H' }] };

        // CONTROL: her chain names Zed (the node's word); Ben's phone saw "Catp" only on Cat₁. The anchor alone refuses.
        expect(memoryOf('Catp')).toEqual({ key: pk(cat2), changedFrom: pk(cat) });
        expect(await checkNewPhone({ ...ctx, scanned: code })).toMatchObject({ ok: false, reason: 'mismatch' });

        // ATTACK: one roster of H served to Ben's phone with Zed's row labelled "Catp". Ben opens H once. The name moved to
        // Zed's key with no statement: a taint, so Zed's key never counts as one "Catp" had.
        const relabel: Hook = async (r) => {
            if (r.method !== 'GET' || r.path !== `/api/groups/${h}/members`) return undefined;
            const rows = await (await realFetch(r.input, r.init)).json();
            return jsonResponse(200, rows.map((m: any) => (m.memberPubkey === pk(zed) ? { ...m, callsign: 'Catp' } : m)));
        };
        hooks.unshift(relabel);
        await benSees(ben, [{ id: h }]);
        hooks.splice(hooks.indexOf(relabel), 1);
        expect(memoryOf('Catp')).toEqual({ key: pk(zed), changedFrom: pk(cat) });
        const attacked = await checkNewPhone({ ...ctx, scanned: code });
        expect(attacked).toMatchObject({ ok: false, reason: 'mismatch' });

        // THE MARK: one more roster of G, Zed left out, Cat₂ with her misled chain (it reaches Zed's key only). It confirms
        // nothing: the "(key changed)" mark stays, changedFrom stays Cat₁, Zed's key never enters `was`, and the check refuses.
        const clear: Hook = async (r) => {
            if (r.method !== 'GET' || r.path !== `/api/groups/${g}/members`) return undefined;
            const rows = await (await realFetch(r.input, r.init)).json();
            return jsonResponse(200, rows.filter((m: any) => m.memberPubkey !== pk(zed)).map((m: any) => (m.memberPubkey === pk(cat2) ? { ...m, formerKeys: [misled] } : m)));
        };
        hooks.unshift(clear);
        const marked = await rememberRosterNames(URL_BASE, await roster(ben, g));
        hooks.splice(hooks.indexOf(clear), 1);
        expect([...marked]).toContain(pk(cat2));
        expect(memoryOf('Catp')).toEqual({ key: pk(cat2), changedFrom: pk(cat) });
        expect(await checkNewPhone({ ...ctx, scanned: code })).toMatchObject({ ok: false, reason: 'mismatch' });
        hooks.splice(hooks.indexOf(chainHook), 1);

        // Nothing went to her new key, and she reads nothing of Zed's era.
        expect(await topUps(pk(ben), pk(cat2))).toEqual([]);
        forgetGroupKeys();
        const read = await reads(cat2, g);
        expect(read).not.toContain('Zedp: Zed before Cat');
        console.log(`MEASURED MP: control, attack and mark all refused (mismatch); Ben's top-ups to Cat₂ 0; Cat₂ reads ${JSON.stringify(read)}`);
        expect(elsewhere).toEqual([]);
    });

    it('S1: a name the node adds to an epoch\'s wraps list is refused by the signed digest: Ben hands nothing for that epoch (pins signedRecipientsWith)', async () => {
        await control('limiters');
        forgetGroupKeys();
        const ben = phone('Bens');
        const cat = phone('Cats');
        const dov = phone('Dovs');
        await control('members', { members: [ben, cat, dov].map((p) => ({ key: pk(p), callsign: p.name })) });
        const g = await newGroup(ben, 'Digest G');
        await say(ben, g, 'Ben alone first');
        await join_(cat, g);
        await writes(cat, g, 'Cat here');
        await join_(dov, g);
        await writes(dov, g, 'Dov here');
        await benSees(ben, [{ id: g }]);
        const cat2 = await rekeyed(cat, 'Cats');
        expect(await attestJustCompletedRekey(URL_BASE, cat2.identity)).toBe(1);
        await control('sql', { sql: 'UPDATE group_members SET from_epoch = 1 WHERE group_id = ? AND member_pubkey = ?', params: [g, pk(cat2)] });
        await benSees(ben, [{ id: g }]);
        const check = await checkNewPhone({ nodeUrl: URL_BASE, identity: ben.identity, groups: [{ id: g, name: 'Digest G' }], scanned: newPhoneQrPayload(cat2.identity, pk(cat)) });
        expect(check.ok).toBe(true);
        if (!check.ok) return;
        // The node adds Cat₁ to epoch 1's own wraps (a row shaped like the maker's), where the signed record names Ben alone.
        const addName: Hook = async (r) => {
            if (r.method !== 'GET' || r.path !== `/api/groups/${g}/keys/1/wraps`) return undefined;
            const a = await (await realFetch(r.input, r.init)).json();
            const own = a.wraps.find((w: any) => w.sig === null);
            return jsonResponse(200, { ...a, wraps: [...a.wraps, { ...own, recipient: pk(cat) }] });
        };
        hooks.push(addName);
        const done = await confirmNewPhone({ nodeUrl: URL_BASE, identity: ben.identity, store: ben.store, check });
        hooks.splice(hooks.indexOf(addName), 1);
        const handed = await topUps(pk(ben), pk(cat2));
        console.log(`MEASURED S1: handed ${done.total}: ${JSON.stringify(handed.map((x) => x.split('#')[1]))}; epoch 1 handed: ${handed.includes(`${g}#1`)}`);
        expect(handed.includes(`${g}#1`)).toBe(false);
        expect(handed).toEqual([`${g}#2`, `${g}#3`]);
    });

    it('chain dropped: Ben\'s phone knew Cat on her old key, but the node serves her row without its chain — refused, nothing handed (pins the chain check)', async () => {
        await control('limiters');
        forgetGroupKeys();
        const ben = phone('Benx');
        const cat = phone('Catx');
        const dov = phone('Dovx');
        await control('members', { members: [ben, cat, dov].map((p) => ({ key: pk(p), callsign: p.name })) });
        const g = await newGroup(ben, 'Chain G');
        await say(ben, g, 'Ben first');
        await join_(cat, g);
        await writes(cat, g, 'Cat line');
        await join_(dov, g);
        await writes(dov, g, 'Dov line');
        await benSees(ben, [{ id: g }]);
        const cat2 = await rekeyed(cat, 'Catx');
        expect(await attestJustCompletedRekey(URL_BASE, cat2.identity)).toBe(1);
        await benSees(ben, [{ id: g }]);
        expect(memoryOf('Catx')).toEqual({ key: pk(cat2), was: [pk(cat)] });
        const code = newPhoneQrPayload(cat2.identity, pk(cat));
        const ctx = { nodeUrl: URL_BASE, identity: ben.identity, groups: [{ id: g, name: 'Chain G' }] };
        // Control: with her chain served, the same code passes.
        expect((await checkNewPhone({ ...ctx, scanned: code })).ok).toBe(true);
        const drop: Hook = async (r) => {
            if (r.method !== 'GET' || r.path !== `/api/groups/${g}/members`) return undefined;
            const rows = await (await realFetch(r.input, r.init)).json();
            return jsonResponse(200, rows.map((m: any) => (m.memberPubkey === pk(cat2) ? { ...m, formerKeys: [] } : m)));
        };
        hooks.unshift(drop);
        const dropped = await checkNewPhone({ ...ctx, scanned: code });
        hooks.splice(hooks.indexOf(drop), 1);
        expect(dropped).toMatchObject({ ok: false, reason: 'mismatch' });
        expect(await topUps(pk(ben), pk(cat2))).toEqual([]);
    });

    it('H1 (finding 4): the confirming phone says what landed — "Handed 0 of N" when the node refuses every wrap, "Done" once they land, the community\'s word on a second scan', async () => {
        await control('limiters');
        forgetGroupKeys();
        const ben = phone('Benh');
        const cat = phone('Cath');
        await control('members', { members: [ben, cat].map((p) => ({ key: pk(p), callsign: p.name })) });
        const g = await newGroup(ben, 'Refuse G');
        await say(ben, g, 'one');
        await join_(cat, g);
        await writes(cat, g, 'two');
        await benSees(ben, [{ id: g }]);
        const cat2 = await rekeyed(cat, 'Cath');
        expect(await attestJustCompletedRekey(URL_BASE, cat2.identity)).toBe(1);
        await benSees(ben, [{ id: g }]);
        const check = await checkNewPhone({ nodeUrl: URL_BASE, identity: ben.identity, groups: [{ id: g, name: 'Refuse G' }], scanned: newPhoneQrPayload(cat2.identity, pk(cat)) });
        expect(check.ok).toBe(true);
        if (!check.ok) return;
        const refuse: Hook = (r) => (r.method === 'POST' && /\/keys\/wrap$/.test(r.path) ? jsonResponse(403, { error: 'no', code: 'wrap_refused' }) : undefined);
        hooks.push(refuse);
        const refused = await confirmNewPhone({ nodeUrl: URL_BASE, identity: ben.identity, store: ben.store, check });
        hooks.splice(hooks.indexOf(refuse), 1);
        expect(refused.planned).toBeGreaterThan(0);
        expect(refused).toMatchObject({ total: 0, already: 0, stopped: false });
        const end = newPhoneEnd(check.name, refused);
        expect(end).toEqual({ text: `Handed 0 of ${refused.planned}. The community refused the rest: try again, or tell an owner.`, ok: false });
        // The node takes them: "Done".
        const honest = await confirmNewPhone({ nodeUrl: URL_BASE, identity: ben.identity, store: ben.store, check });
        expect(honest.total).toBe(honest.planned);
        expect(honest.planned).toBe(refused.planned);
        expect(newPhoneEnd(check.name, honest)).toEqual({ text: newPhoneDoneText('Cath'), ok: true });
        // Scanned again: the node lists a live wrap to her new key for every one of them, so nothing is planned and nothing
        // is posted; the screen says that is the community's word (confirmation 1 of #1844, finding 4).
        const mark = bodies.length;
        const again = await confirmNewPhone({ nodeUrl: URL_BASE, identity: ben.identity, store: ben.store, check });
        expect(again).toMatchObject({ planned: 0, total: 0, already: 0, listedHeld: honest.planned, stopped: false });
        expect(posts(mark, /\/keys\/wrap$/)).toEqual([]);
        expect(newPhoneEnd(check.name, again)).toEqual({ text: newPhoneSaidHeldText('Cath', 0, honest.planned), ok: true });
        expect(newPhoneSaidHeldText('Cath', 0, 2)).toBe("Nothing handed: the community says Cath's new phone already holds the 2 earlier keys this phone has. If it can't read those messages, tell an owner.");
        // Nothing this phone holds names her old key: nothing to unlock, said as what this phone found.
        expect(newPhoneEnd('Cath', { total: 0, already: 0, listedHeld: 0, planned: 0, stopped: false })).toEqual({ text: "Nothing to unlock: this phone found no earlier key of Cath's to hand over.", ok: true });
        // Some handed here, and the node says another member got in first (409 wrap_exists): its word, never "Done".
        expect(newPhoneEnd('Cath', { total: 1, already: 1, planned: 2, stopped: false })).toEqual({ text: "Handed 1. The community says Cath's new phone already holds the other 1. If it can't read those messages, tell an owner.", ok: true });
        expect(newPhoneEnd('Cath', { total: 1, already: 0, planned: 2, stopped: false })).toEqual({ text: newPhoneRefusedRestText(1, 2), ok: false });
        expect(newPhoneEnd('Cath', { total: 1, planned: 3, stopped: true }).text).toBe('Unlocking 1 of 3… The community asked this phone to slow down: scan again in a minute to carry on.');
        console.log(`MEASURED H1: refused ${JSON.stringify(refused)} → "${end.text}"; honest ${honest.total}/${honest.planned} → Done; again planned ${again.planned}, listed held ${again.listedHeld} → the community's word`);
    });

    it('H2 (finding 4): the old-words screen never says "Done" when nothing landed — an empty answer for a group the chat shows locked is named withheld, junk is withheld too, "Done" once keys land', async () => {
        await control('limiters');
        forgetGroupKeys();
        const cat = wordsPhone('Catw');
        const ben = phone('Benw');
        await control('members', { members: [cat, ben].map((p) => ({ key: pk(p), callsign: p.name })) });
        const g = await newGroup(ben, 'Empty G');
        await say(ben, g, 'one');
        await join_(cat, g);
        await writes(cat, g, 'two');
        const cat2 = await rekeyed(cat, 'Catw');
        expect(await attestJustCompletedRekey(URL_BASE, cat2.identity)).toBe(1);
        await writes(ben, g, 'after');
        forgetGroupKeys();
        const waiting = (await shown(cat2, g)).visible.filter((l) => l.waitingKey).length;
        expect(waiting).toBeGreaterThanOrEqual(1);
        // The chat kept its row's count (GroupChatView → noteLockedHistoryRow), under the id lower-cased whatever its spelling;
        // the old-words screen passes it as `locked`.
        await noteLockedHistoryCount(URL_BASE, pk(cat2), g.toUpperCase(), waiting);
        const counts = await lockedHistoryCounts(URL_BASE, pk(cat2));
        expect(counts).toEqual({ [g.toLowerCase()]: waiting });
        const groups = [{ id: g, name: 'Empty G', locked: counts[g.toLowerCase()] ?? 0 }];
        const words = { nodeUrl: URL_BASE, identity: cat2.identity, store: cat2.store, typed: cat.words, signedHere: pk(cat) };

        const empty: Hook = (r) => (r.method === 'GET' && /\/keys\/former$/.test(r.path) ? jsonResponse(200, { formerKeys: [pk(cat)], epochs: [], wraps: [], more: false }) : undefined);
        hooks.unshift(empty);
        const r = await unlockWithOldWords({ ...words, groups });
        hooks.splice(hooks.indexOf(empty), 1);
        expect(r).toMatchObject({ outcome: 'done', unlocked: {}, refused: 0 });
        expect(r.withheld.map((x) => x.id)).toEqual([g]);
        expect(oldWordsEnd(r)).toEqual({ text: 'Nothing was handed over for Empty G. Try again later, or tell an owner.', lines: [], ok: false });
        // With no count at all (a group whose chat wasn't opened since the change): still never "Done".
        hooks.unshift(empty);
        const r0 = await unlockWithOldWords({ ...words, groups: [{ id: g, name: 'Empty G' }] });
        hooks.splice(hooks.indexOf(empty), 1);
        expect(r0).toMatchObject({ outcome: 'done', unlocked: {}, withheld: [] });
        expect(oldWordsEnd(r0)).toEqual({ text: OLD_WORDS_NOTHING_LISTED, lines: [], ok: true });
        expect(oldWordsEnd(r0).text).not.toBe(OLD_WORDS_DONE);
        // Junk: her old key's wraps served with their bytes spoiled. Nothing opens; withheld even with no count.
        const junk: Hook = async (r) => {
            if (r.method !== 'GET' || !/\/keys\/former$/.test(r.path)) return undefined;
            const a = await (await realFetch(r.input, r.init)).json();
            return jsonResponse(200, { ...a, wraps: a.wraps.map((w: any) => ({ ...w, wrapped: `${w.wrapped.slice(0, -8)}${w.wrapped.slice(-8) === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA'}` })) });
        };
        hooks.unshift(junk);
        const rj = await unlockWithOldWords({ ...words, groups: [{ id: g, name: 'Empty G' }] });
        hooks.splice(hooks.indexOf(junk), 1);
        expect(rj.refused).toBeGreaterThan(0);
        expect(rj.withheld.map((x) => x.id)).toEqual([g]);
        expect(oldWordsEnd(rj).text).toBe(oldWordsNothingText(['Empty G']));
        // Honest: the keys land, "Done".
        const ok = await unlockWithOldWords({ ...words, groups });
        expect(Object.keys(ok.unlocked)).toEqual([g]);
        expect(ok.withheld).toEqual([]);
        expect(oldWordsEnd(ok)).toEqual({ text: OLD_WORDS_DONE, lines: [], ok: true });
        // A forgotten count is gone from the list the screen reads.
        await noteLockedHistoryCount(URL_BASE, pk(cat2), g, 0);
        expect(await lockedHistoryCounts(URL_BASE, pk(cat2))).toEqual({});
        console.log(`MEASURED H2: empty+count → withheld ${JSON.stringify(r.withheld.map((x) => x.name))}; empty, no count → "${oldWordsEnd(r0).text}"; junk refused ${rj.refused} → withheld; honest unlocked ${ok.unlocked[g]}`);
    });

    it('finding 5: the old phone\'s note lasts only while the node refuses its key — one lie is cleared by the next signed success, a replaced key stays noted, an unsigned answer clears nothing; the card says whose words they are', async () => {
        await control('limiters');
        forgetGroupKeys();
        const ben = phone('Benk');
        const dov = phone('Dovk');
        const cat = phone('Catk');
        await control('members', { members: [ben, dov, cat].map((p) => ({ key: pk(p), callsign: p.name })) });
        const g = await newGroup(ben, 'Moved G');
        await join_(dov, g);
        await join_(cat, g);
        let told = 0;
        const off = onKeyReplaced(() => { told++; });
        // The node answers one signed read from Dov's phone, whose key is current, with the replaced-key code.
        const lie: Hook = (r) => (r.method === 'GET' && r.path === `/api/groups/${g}/members` ? jsonResponse(403, { error: 'replaced', code: 'key_invalidated' }) : undefined);
        hooks.unshift(lie);
        const lied = await signedGet(URL_BASE, `/api/groups/${g}/members`, dov.identity);
        hooks.splice(hooks.indexOf(lie), 1);
        watchForReplacedKey(URL_BASE, pk(dov), lied);
        await vi.waitFor(async () => expect(await keyReplacedHere(URL_BASE, pk(dov))).toBe(true));
        expect(told).toBe(1);
        // A success to a request that went out unsigned says nothing about the key: the note stays.
        watchForReplacedKey(URL_BASE, pk(dov), jsonResponse(200, {}), false);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(await keyReplacedHere(URL_BASE, pk(dov))).toBe(true);
        // The next signed read the node answers: the key is current here, so the note goes, and the card hears it.
        const next = await signedGet(URL_BASE, `/api/groups/${g}/members`, dov.identity);
        expect(next.ok).toBe(true);
        watchForReplacedKey(URL_BASE, pk(dov), next);
        await vi.waitFor(async () => expect(await keyReplacedHere(URL_BASE, pk(dov))).toBe(false));
        expect(told).toBe(2);
        // A key a re-key really replaced: every signed request is refused, so nothing clears its note.
        await rekeyed(cat, 'Catk');
        for (let i = 0; i < 2; i++) {
            const res = await signedGet(URL_BASE, `/api/groups/${g}/members`, cat.identity);
            expect(res.status).toBe(403);
            watchForReplacedKey(URL_BASE, pk(cat), res);
        }
        await vi.waitFor(async () => expect(await keyReplacedHere(URL_BASE, pk(cat))).toBe(true));
        off();
        // The card shows only while the note is kept, and says the words are this account's and belong in no other phone.
        const card = readFileSync(fileURLToPath(new URL('../../components/KeyMovedCard.tsx', import.meta.url).href), 'utf8');
        expect(card).toContain('{KEY_MOVED_OWN_ONLY}');
        expect(card).toMatch(/const yes = await keyReplacedHere\(url, identity\.publicKey\);/);
        expect(card).toMatch(/if \(!moved\) return null;/);
        expect(KEY_MOVED_OWN_ONLY).toBe("These are this account's own words. Type them only into your own new phone, never into a phone someone else holds out.");
        expect(KEY_MOVED_SHOW).toBe('Show my old 12 words, so my new phone can unlock earlier messages');
        // db.ts: every signed GET tells the watch whether it was signed; a signed write the node took clears the note.
        const db = readFileSync(fileURLToPath(new URL('../db.ts', import.meta.url).href), 'utf8');
        expect(db).toMatch(/watchForReplacedKey\(anchorUrl, identity\.publicKey, res, signed\);/);
        expect(db).toMatch(/headers = \{ \.\.\.headers, \.\.\.signedHeaders \};\n\s+signed = true;/);
        expect(db).toMatch(/void noteKeyAnswered\(anchorUrl, identity\.publicKey\);\n\s+return await res\.json\(\);/);
    });
});

// ─── Confirmation 1 of #1844 (§4 amendment 2): the chain's order, the name the node gives the new phone, first sight ───
describe('confirmation 1 of #1844: a chain in the wrong order, a lookalike name, and the first-sight residual', () => {
    const memKey = () => `beanpool_name_keys:${URL_BASE}`;
    const byKeyKey = () => `beanpool_names_by_key:${URL_BASE}`;
    const memoryOf = (name: string) => JSON.parse(mem.async.get(memKey()) ?? '{}')[name.trim().replace(/[A-Z]/g, (c) => c.toLowerCase())];
    const benSees = async (ben: Phone, gs: readonly string[]) => { for (const g of gs) await rememberRosterNames(URL_BASE, await roster(ben, g)); };
    const fromEpoch1 = (g: string, key: string) => control('sql', { sql: 'UPDATE group_members SET from_epoch = 1 WHERE group_id = ? AND member_pubkey = ?', params: [g, key] });
    /** Every members answer with `rows` rewritten. */
    const rowsHook = (path: RegExp | string, rewrite: (rows: any[]) => any[]): Hook => async (r) => {
        if (r.method !== 'GET' || (typeof path === 'string' ? r.path !== path : !path.test(r.path))) return undefined;
        return jsonResponse(200, rewrite(await (await realFetch(r.input, r.init)).json()));
    };
    const withHook = async <T,>(hook: Hook, run: () => Promise<T>): Promise<T> => {
        hooks.unshift(hook);
        try { return await run(); } finally { hooks.splice(hooks.indexOf(hook), 1); }
    };
    let hooksBefore: Hook[] = [];
    beforeEach(() => { hooksBefore = [...hooks]; });
    afterEach(() => { hooks.splice(0, hooks.length, ...hooksBefore); });

    /** G: Ben starts (1), Zed joins (2) and writes a line Cat never saw, Cat joins (3) and writes, Ben writes. H: Ben and Zed. */
    async function poisonSetup(tag: string) {
        await control('limiters');
        forgetGroupKeys();
        mem.async.delete(memKey());
        mem.async.delete(byKeyKey());
        const ben = phone(`Ben${tag}`);
        const zed = phone(`Zed${tag}`);
        const cat = phone(`Cat${tag}`);
        await control('members', { members: [ben, zed, cat].map((p) => ({ key: pk(p), callsign: p.name })) });
        const g = await newGroup(ben, `Poison G ${tag}`);
        await say(ben, g, 'Ben alone');
        await join_(zed, g);
        await writes(zed, g, 'Zed before Cat');
        await join_(cat, g);
        await writes(cat, g, 'Cat here');
        await writes(ben, g, 'Ben with both');
        const h = await newGroup(ben, `Side H ${tag}`);
        await join_(zed, h);
        await writes(zed, h, 'side line');
        return { ben, zed, cat, g, h, ctx: { nodeUrl: URL_BASE, identity: ben.identity, groups: [{ id: g, name: 'G' }, { id: h, name: 'H' }] } };
    }

    it('MP-CHAIN (finding 1): a puppet\'s claim over her key, one relabel to Zed\'s, then her one misled statement over the puppet with the puppet\'s claim over Zed: the chain places Zed\'s key older than the puppet\'s, so it never counts; refused, nothing handed', async () => {
        const { ben, zed, cat, g, h, ctx } = await poisonSetup('c');
        await benSees(ben, [g, h]);
        expect(memoryOf(cat.name)).toEqual({ key: pk(cat) });
        const pup = phone('Pupc');
        await control('members', { members: [{ key: pk(pup), callsign: pup.name }] });
        // Roster 1 of H: a row for the puppet under her name, with its claim over her honest key: taken as a move, unmarked.
        await withHook(rowsHook(`/api/groups/${h}/members`, (rows) => [...rows, { memberPubkey: pk(pup), callsign: cat.name, status: 'active', formerKeys: [claim(pup, pk(cat))] }]),
            () => benSees(ben, [h]));
        expect(memoryOf(cat.name)).toEqual({ key: pk(pup), was: [pk(cat)] });
        // Roster 2 of H: Zed's row under her name: the taint, with the puppet as the key the move left.
        await withHook(rowsHook(`/api/groups/${h}/members`, (rows) => rows.map((m) => (m.memberPubkey === pk(zed) ? { ...m, callsign: cat.name } : m))), () => benSees(ben, [h]));
        expect(memoryOf(cat.name)).toEqual({ key: pk(zed), changedFrom: pk(pup), was: [pk(cat)] });
        // Her re-key: the node lists the puppet as her old key and her new phone signs that once; the puppet's claim over
        // Zed's key completes the chain C2 → P → Z, which says Zed's key came BEFORE the puppet's. This phone saw the reverse.
        const cat2 = await rekeyed(cat, cat.name);
        const chain = [claim(cat2, pk(pup)), claim(pup, pk(zed))];
        const herRow = (m: any) => (m.memberPubkey === pk(cat2) ? { ...m, formerKeys: chain } : m);
        hooks.push(rowsHook(/\/members$/, (rows) => rows.map(herRow)));
        await fromEpoch1(g, pk(cat2));
        // Roster 3, of G, Zed left out: the chain reaches the puppet (the taint clears) and Zed's key, which stays out.
        const m3 = await withHook(rowsHook(`/api/groups/${g}/members`, (rows) => rows.filter((m) => m.memberPubkey !== pk(zed)).map(herRow)),
            async () => rememberRosterNames(URL_BASE, await roster(ben, g)));
        expect(m3.size).toBe(0);
        expect(memoryOf(cat.name)).toEqual({ key: pk(cat2), was: [pk(pup), pk(cat)] });
        await benSees(ben, [g]);
        // Her code names the key her phone signed for (the puppet's would plan nothing the puppet didn't hold); the node's
        // story says Zed's: both are refused or empty, and Zed's key is never handed anything.
        const check = await checkNewPhone({ ...ctx, scanned: JSON.stringify([NEW_PHONE_QR_TAG, pk(cat2), pk(zed), cat.name]) });
        expect(check).toMatchObject({ ok: false, reason: 'mismatch' });
        expect(await topUps(pk(ben), pk(cat2))).toEqual([]);
        forgetGroupKeys();
        const read = await reads(cat2, g);
        expect(read).not.toContain(`${zed.name}: Zed before Cat`);
        console.log(`MEASURED MP-CHAIN: memory {key: C2, was: [P, C1]}; check ${JSON.stringify(check)}; Cat₂ reads ${JSON.stringify(read)}`);
        expect(elsewhere).toEqual([]);
    });

    it('MP-HIDDEN: the node never shows Ben\'s phone Zed under his own name, so only the name memory can refuse: "Catm" was on her key before the move to Zed\'s, and the misled code is refused', async () => {
        const { ben, zed, cat, g, h, ctx } = await poisonSetup('m');
        const noZed = (rows: any[]) => rows.filter((m) => m.memberPubkey !== pk(zed));
        // Every roster of G this phone loads leaves Zed out; H shows his row under her name, once.
        await withHook(rowsHook(`/api/groups/${g}/members`, noZed), () => benSees(ben, [g]));
        expect(memoryOf(cat.name)).toEqual({ key: pk(cat) });
        await withHook(rowsHook(`/api/groups/${h}/members`, (rows) => rows.map((m) => (m.memberPubkey === pk(zed) ? { ...m, callsign: cat.name } : m))), () => benSees(ben, [h]));
        expect(memoryOf(cat.name)).toEqual({ key: pk(zed), changedFrom: pk(cat) });
        expect(JSON.parse(mem.async.get(byKeyKey()) ?? '{}')[pk(zed)]).toEqual([cat.name]);
        const cat2 = await rekeyed(cat, cat.name);
        const misled = claim(cat2, pk(zed));
        const herRow = (m: any) => (m.memberPubkey === pk(cat2) ? { ...m, formerKeys: [misled] } : m);
        hooks.push(rowsHook(/\/members$/, (rows) => rows.map(herRow)));
        await fromEpoch1(g, pk(cat2));
        const code = JSON.stringify([NEW_PHONE_QR_TAG, pk(cat2), pk(zed), cat.name]);
        // Scanned before this phone sees her new row: the move to Zed's key is unconfirmed, so his key never counts.
        expect(await checkNewPhone({ ...ctx, scanned: code })).toEqual({ ok: false, reason: 'mismatch', text: newPhoneMismatchText(cat.name) });
        await withHook(rowsHook(`/api/groups/${g}/members`, (rows) => noZed(rows).map(herRow)), () => benSees(ben, [g]));
        expect(memoryOf(cat.name)).toEqual({ key: pk(cat2), changedFrom: pk(cat) });
        // The key's names say nothing against it (it was only ever "Catm" here): the memory refuses.
        const check = await withHook(rowsHook(`/api/groups/${g}/members`, (rows) => noZed(rows).map(herRow)),
            () => checkNewPhone({ ...ctx, scanned: code }));
        expect(check).toEqual({ ok: false, reason: 'mismatch', text: newPhoneMismatchText(cat.name) });
        expect(await topUps(pk(ben), pk(cat2))).toEqual([]);
        expect(elsewhere).toEqual([]);
    });

    it('LN (finding 2): the node names the re-keyed phone "Cаtl" (Cyrillic а): Zed\'s key was "Zedl" on this phone, so it never counts as the lookalike\'s old key; refused in every group, nothing handed', async () => {
        const { ben, zed, cat, g, h, ctx } = await poisonSetup('l');
        await benSees(ben, [g, h]);
        expect(memoryOf(cat.name)).toEqual({ key: pk(cat) });
        expect(memoryOf(zed.name)).toEqual({ key: pk(zed) });
        const look = 'Cаtl'; // "Catl" with a Cyrillic а: rekey-redeem.ts makes the new identity with the node's `bound` callsign
        expect(look).not.toBe(cat.name);
        const cat2 = await rekeyed(cat, look);
        const misled = claim(cat2, pk(zed));
        const herRow = (m: any) => (m.memberPubkey === pk(cat2) ? { ...m, formerKeys: [misled], callsign: look } : m);
        hooks.push(rowsHook(/\/members$/, (rows) => rows.map(herRow)));
        await join_(cat2, h);
        await fromEpoch1(g, pk(cat2));
        await fromEpoch1(h, pk(cat2));
        // One roster of H: Zed's row under the lookalike, hers left out (a first sight of that name); then G's, Zed left out.
        await withHook(rowsHook(`/api/groups/${h}/members`, (rows) => rows.filter((m) => m.memberPubkey !== pk(cat2)).map((m) => (m.memberPubkey === pk(zed) ? { ...m, callsign: look } : m))),
            () => benSees(ben, [h]));
        expect(memoryOf(look)).toEqual({ key: pk(zed) });
        const marked = await withHook(rowsHook(`/api/groups/${g}/members`, (rows) => rows.filter((m) => m.memberPubkey !== pk(zed)).map(herRow)),
            async () => rememberRosterNames(URL_BASE, await roster(ben, g)));
        expect(marked.size).toBe(0);
        expect(memoryOf(look)).toEqual({ key: pk(cat2), was: [pk(zed)] });
        // The name memory alone would pass it: the names this phone saw Zed's key under refuse it.
        const check = await checkNewPhone({ ...ctx, scanned: newPhoneQrPayload(cat2.identity, pk(zed)) });
        expect(check).toEqual({ ok: false, reason: 'mismatch', text: newPhoneKeyWasOtherText(look, zed.name) });
        expect(await topUps(pk(ben), pk(cat2))).toEqual([]);
        forgetGroupKeys();
        const readG = await reads(cat2, g);
        expect(readG).not.toContain(`${zed.name}: Zed before Cat`);
        console.log(`MEASURED LN: check ${JSON.stringify(check)}; top-ups 0; Cat₂ reads G ${JSON.stringify(readG)}`);
        expect(elsewhere).toEqual([]);
    });

    it('FS (the first-sight residual, §4 amendment 2): a phone with no memory of her name is refused only while it has seen Zed\'s key under his own name; one that never has takes the node\'s first word', async () => {
        const { ben, zed, cat, g, h, ctx } = await poisonSetup('f');
        await benSees(ben, [g, h]);
        // Ben restores his phone from his 12 words: his key and his wraps on the node are the same; his memory is empty.
        mem.async.delete(memKey());
        mem.async.delete(byKeyKey());
        const cat2 = await rekeyed(cat, cat.name);
        const misled = claim(cat2, pk(zed));
        const herRow = (m: any) => (m.memberPubkey === pk(cat2) ? { ...m, formerKeys: [misled] } : m);
        hooks.push(rowsHook(/\/members$/, (rows) => rows.map(herRow)));
        await fromEpoch1(g, pk(cat2));
        const code = JSON.stringify([NEW_PHONE_QR_TAG, pk(cat2), pk(zed), cat.name]);
        // (a) The first roster with her name shows Zed's key under it (H); the shared group's roster is honest but for her
        // chain, and shows Zed under his own name. The name memory "knew" Zed's key as hers; the key's own names refuse it.
        await withHook(rowsHook(`/api/groups/${h}/members`, (rows) => rows.map((m) => (m.memberPubkey === pk(zed) ? { ...m, callsign: cat.name } : m))), () => benSees(ben, [h]));
        expect(memoryOf(cat.name)).toEqual({ key: pk(zed) });
        await benSees(ben, [g]);
        expect(memoryOf(cat.name)).toEqual({ key: pk(cat2), changedFrom: pk(zed) });
        expect(await checkNewPhone({ ...ctx, scanned: code })).toEqual({ ok: false, reason: 'mismatch', text: newPhoneKeyWasOtherText(cat.name, zed.name) });
        expect(await topUps(pk(ben), pk(cat2))).toEqual([]);
        // (b) The residual: restored again, and the node hides Zed from every roster this phone loads until the scan. Nothing
        // on this phone tells a first lie from a first truth: the check passes (documented in §4 amendment 2 and the guide:
        // confirm only someone you've chatted with in that group before).
        mem.async.delete(memKey());
        mem.async.delete(byKeyKey());
        await withHook(rowsHook(`/api/groups/${h}/members`, (rows) => rows.map((m) => (m.memberPubkey === pk(zed) ? { ...m, callsign: cat.name } : m))), () => benSees(ben, [h]));
        await withHook(rowsHook(`/api/groups/${g}/members`, (rows) => rows.filter((m) => m.memberPubkey !== pk(zed)).map(herRow)), () => benSees(ben, [g]));
        expect(memoryOf(cat.name)).toEqual({ key: pk(cat2), was: [pk(zed)] });
        const residual = await checkNewPhone({ ...ctx, scanned: code });
        expect(residual.ok).toBe(true);
        console.log(`MEASURED FS: seen as Zedf → refused; never seen under his name → check ${residual.ok ? 'passes (the documented residual)' : JSON.stringify(residual)}`);
        expect(elsewhere).toEqual([]);
    });

    it('ALREADY (finding 4): a junk live wrap the node shows in the new phone\'s slot empties the plan; the screen says that is the community\'s word, never "Nothing to unlock", and a later scan without it hands them', async () => {
        await control('limiters');
        forgetGroupKeys();
        mem.async.delete(memKey());
        mem.async.delete(byKeyKey());
        const ben = phone('Benj');
        const cat = phone('Catj');
        await control('members', { members: [ben, cat].map((p) => ({ key: pk(p), callsign: p.name })) });
        const g = await newGroup(ben, 'Junk G');
        await say(ben, g, 'one');
        await join_(cat, g);
        await writes(cat, g, 'two');
        await benSees(ben, [g]);
        const cat2 = await rekeyed(cat, 'Catj');
        expect(await attestJustCompletedRekey(URL_BASE, cat2.identity)).toBe(1);
        await benSees(ben, [g]);
        const check = await checkNewPhone({ nodeUrl: URL_BASE, identity: ben.identity, groups: [{ id: g, name: 'Junk G' }], scanned: newPhoneQrPayload(cat2.identity, pk(cat)) });
        expect(check.ok).toBe(true);
        if (!check.ok) return;
        const junk: Hook = async (r) => {
            if (r.method !== 'GET' || !/\/keys\/\d+\/wraps$/.test(r.path)) return undefined;
            const a = await (await realFetch(r.input, r.init)).json();
            const own = a.wraps.find((w: any) => w.sig === null);
            return jsonResponse(200, { ...a, wraps: [...a.wraps, { ...own, recipient: pk(cat2), wrapper: pk(ben), sig: 'x'.repeat(88), rejectedAt: null }] });
        };
        const done = await withHook(junk, () => confirmNewPhone({ nodeUrl: URL_BASE, identity: ben.identity, store: ben.store, check }));
        expect(done).toMatchObject({ planned: 0, total: 0, already: 0, stopped: false });
        expect(done.listedHeld).toBeGreaterThan(0);
        expect(await topUps(pk(ben), pk(cat2))).toEqual([]);
        const end = newPhoneEnd('Catj', done);
        expect(end).toEqual({ text: newPhoneSaidHeldText('Catj', 0, done.listedHeld), ok: true });
        expect(end.text).not.toMatch(/Nothing to unlock|Done/);
        const again = await confirmNewPhone({ nodeUrl: URL_BASE, identity: ben.identity, store: ben.store, check });
        expect(again.total).toBe(again.planned);
        expect(again.total).toBeGreaterThan(0);
        console.log(`MEASURED ALREADY: junk slot shown → "${end.text}", 0 posted; without it, handed ${again.total} of ${again.planned}`);
        expect(elsewhere).toEqual([]);
    });
});

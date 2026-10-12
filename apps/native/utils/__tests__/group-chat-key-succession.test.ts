/**
 * Group chats: a member who changes phones keeps their name on their old lines (DESIGN-group-chat-line-display-fable.md
 * §4, §5, §7; review of #1788, NB2 and "Owed when §5 lands"), against a REAL node on this machine
 * (apps/server/src/phone-door-test-harness.ts: the real HTTPS server, signature middleware, group, key and re-key routes),
 * started from the packages' sources and killed by its PID. Each phone is its own identity and key store and runs the
 * phone's own code (group-chat-keys.ts, group-chat-lines.ts, group-line-display.ts, key-succession.ts):
 *
 *   a re-keyed member's old lines read "A former member" until their new key's statement is served, then their name, with
 *   the earlier-key details; a chain signed by anyone but the member's current key (the old key, the node, another member)
 *   is refused, and so is a node serving a member's row with someone else's old key; the two-hop chain; and NB2: once a
 *   member of an epoch re-keys, another member tops up a spoiled slot again, and the re-keyed member's new key is handed
 *   the epochs their old key held, only once their chain is served.
 *
 * Nothing else is contacted: the phones' fetch is held to this node's address, and the node's own fetch refuses every
 * host but this machine.
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
import { wrapGroupKey, keySuccessionCanonical } from '@beanpool/core';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

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
import { sendSealedGroupLine, openGroupThread, chatIsLocked } from '../group-chat-lines';
import { GROUP_LINE_FORMER_MEMBER, earlierKeyDetails, type DisplayRosterRow } from '../group-line-display';
import { attestOwnRekeys, postKeySuccession, unattestedRekeys, keySuccessionPromptText, KEY_SUCCESSION_PROMPT_YES, KEY_SUCCESSION_PROMPT_NO } from '../key-succession';
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
    dataDir = mkdtempSync(join(tmpdir(), 'group-chat-succession-'));
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
const ana = phone('Ana');
const ben = phone('Ben');
const cat = phone('Cat');
const mal = phone('Mal');

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
const nameOf = (v: Awaited<ReturnType<typeof shown>>, text: string) => v.visible.find((l) => l.text === text)?.name;

describe('a member who changes phones keeps their name on their old lines', () => {
    it('setup: node members', async () => {
        await control('limiters');
        await control('members', { members: [ana, ben, cat, mal].map((p) => ({ key: p.identity.publicKey, callsign: p.name })) });
    });

    it('NB2 + §7 4: before the statement, a re-keyed member\'s old line is "A former member" and nobody tops up their slot; after it, their name and their keys', async () => {
        await control('limiters');
        forgetGroupKeys();
        const g = await newGroup(ana, 'Changed phones');
        await say(ana, g, 'first');
        await join_(ben, g);
        await join_(cat, g);
        await say(cat, g, 'Cat on her old phone');
        // The node spoils Ben's wrap for epoch 3 (Cat's join); Ben's phone refuses it, as in #1788's repair case.
        const [ep] = await control<any[]>('sql', { sql: 'SELECT created_by FROM group_key_epochs WHERE group_id = ? AND epoch = 3', params: [g], all: true });
        const junk = wrapGroupKey(new Uint8Array(randomBytes(32)), { groupId: g, epoch: 3, recipientPubHex: ben.identity.publicKey, wrapperPubHex: ep.created_by });
        await control('sql', { sql: 'UPDATE group_key_wraps SET eph_pub = ?, nonce = ?, wrapped = ? WHERE group_id = ? AND epoch = 3 AND recipient_pubkey = ? AND sig IS NULL', params: [junk.ephPub, junk.nonce, junk.wrapped, g, ben.identity.publicKey] });
        const benFresh: Phone = { ...ben, store: memoryGroupKeyStore() };
        expect(nameOf(await shown(benFresh, g), 'Cat on her old phone')).toBeUndefined();

        const cat2 = await rekeyed(cat, 'Cat');
        forgetGroupKeys();
        // Before Cat₂ signs: her old line names nobody, and decision (a) holds: no top-up to Ben (the record's wraps lack
        // Cat₁ now) or to Cat₂ (in no record).
        expect(nameOf(await shown(ana, g), 'Cat on her old phone')).toBe(GROUP_LINE_FORMER_MEMBER);
        expect(await ring(ana, g).serveMissing()).toBe(0);
        expect(await control<any[]>('sql', { sql: 'SELECT epoch FROM group_key_wraps WHERE group_id = ? AND recipient_pubkey = ?', params: [g, cat2.identity.publicKey], all: true })).toEqual([]);

        // Cat₂ confirms, as her new phone does right after its own re-key.
        expect(await attestOwnRekeys(URL_BASE, cat2.identity)).toBe(1);
        forgetGroupKeys();
        const v = await shown(ana, g);
        const line = v.visible.find((l) => l.text === 'Cat on her old phone');
        expect(line?.name).toBe('Cat');
        const [inv] = await control<any[]>('sql', { sql: 'SELECT succession_at FROM invalidated_keys WHERE public_key = ?', params: [cat.identity.publicKey], all: true });
        expect(line?.details).toBe(earlierKeyDetails('Cat', inv.succession_at));
        // NB2: Ana now tops up Ben's spoiled slot and Cat₂'s epochs, which Cat₁ held by the records' signatures.
        const handed = await ring(ana, g).serveMissing();
        expect(handed).toBeGreaterThanOrEqual(2);
        const cat2Wraps = await control<any[]>('sql', { sql: 'SELECT epoch FROM group_key_wraps WHERE group_id = ? AND recipient_pubkey = ? ORDER BY epoch', params: [g, cat2.identity.publicKey], all: true });
        expect(cat2Wraps.map((w) => w.epoch)).toEqual([3]);
        forgetGroupKeys();
        expect(nameOf(await shown(benFresh, g), 'Cat on her old phone')).toBe('Cat');
        const cat2Sees = await shown(cat2, g);
        expect(nameOf(cat2Sees, 'Cat on her old phone')).toBe('Cat');
        // Never an epoch from before Cat₁: epochs 1 and 2 were not hers.
        expect(cat2Wraps.some((w) => w.epoch < 3)).toBe(false);
    });

    it('§7 5: the pin attack — a node serving someone else\'s old key on a member\'s row is refused, however it is signed', async () => {
        await control('limiters');
        forgetGroupKeys();
        const g = await newGroup(ana, 'Pin attack');
        await join_(mal, g);
        await say(mal, g, 'Mal says this');
        const mal2 = await rekeyed(mal, 'Mal');
        // Mal is a node member under his new key, but has left this group: his old line is his, not anyone's in the roster.
        await control('sql', { sql: "UPDATE group_members SET status = 'removed' WHERE group_id = ? AND member_pubkey = ?", params: [g, mal2.identity.publicKey] });
        await control('groupRows', { groupId: g, keys: [] });
        const at = '2026-10-03T04:00:00.000Z';
        const sign = (seedHex: string, newPub: string) => Buffer.from(ed25519.sign(sha256(utf8ToBytes(keySuccessionCanonical(mal.identity.publicKey, newPub, at))), Buffer.from(seedHex, 'hex'))).toString('base64');
        const forged = [
            sign(mal.identity.privateKey, ana.identity.publicKey),   // (i) signed by that old key itself
            sign(randomBytes(32).toString('hex'), ana.identity.publicKey), // (ii) by a key of the node owner's
            Buffer.from(ed25519.sign(sha256(utf8ToBytes(keySuccessionCanonical(ben.identity.publicKey, ana.identity.publicKey, at))), Buffer.from(ana.identity.privateKey, 'hex'))).toString('base64'), // (iii) Ana over another old key
        ];
        for (const sig of forged) {
            hooks.push(async (r) => {
                if (r.method !== 'GET' || r.path !== `/api/groups/${g}/members`) return undefined;
                const rows = await (await realFetch(r.input, r.init)).json();
                return jsonResponse(200, rows.map((m: any) => (m.memberPubkey === ana.identity.publicKey ? { ...m, formerKeys: [{ pubkey: mal.identity.publicKey, at, sig }] } : m)));
            });
            forgetGroupKeys();
            const name = nameOf(await shown(ana, g), 'Mal says this');
            hooks.pop();
            expect(name).not.toBe('Ana');
            expect(name).toBe(GROUP_LINE_FORMER_MEMBER);
        }
    });

    it('§7 6: two re-keys, Ana₁ → Ana₂ → Ana₃: her first line is hers once both are confirmed; the middle one missing breaks it', async () => {
        await control('limiters');
        forgetGroupKeys();
        const ana1 = phone('Ana');
        await control('members', { members: [{ key: ana1.identity.publicKey, callsign: 'Anaa' }] });
        const g = await newGroup(ben, 'Two re-keys');
        await join_(ana1, g);
        await say(ana1, g, 'from her first phone');
        const ana2 = await rekeyed(ana1, 'Anaa');
        expect(await attestOwnRekeys(URL_BASE, ana2.identity)).toBe(1);
        const ana3 = await rekeyed(ana2, 'Anaa');
        forgetGroupKeys();
        expect(nameOf(await shown(ben, g), 'from her first phone')).toBe(GROUP_LINE_FORMER_MEMBER);
        expect(await attestOwnRekeys(URL_BASE, ana3.identity)).toBe(1);
        forgetGroupKeys();
        expect(nameOf(await shown(ben, g), 'from her first phone')).toBe('Anaa');
        // A node that drops the middle statement: the chain is broken, and the line names nobody.
        hooks.push(async (r) => {
            if (r.method !== 'GET' || r.path !== `/api/groups/${g}/members`) return undefined;
            const rows = await (await realFetch(r.input, r.init)).json();
            return jsonResponse(200, rows.map((m: any) => (m.memberPubkey === ana3.identity.publicKey ? { ...m, formerKeys: m.formerKeys.slice(1) } : m)));
        });
        forgetGroupKeys();
        const broken = nameOf(await shown(ben, g), 'from her first phone');
        hooks.pop();
        expect(broken).toBe(GROUP_LINE_FORMER_MEMBER);
    });

    it('§7 7: an admin-path re-key reads "A former member" until the phone confirms at sign-in; "Not me" signs nothing', async () => {
        await control('limiters');
        forgetGroupKeys();
        const dee = phone('Dee');
        await control('members', { members: [{ key: dee.identity.publicKey, callsign: 'Dee' }] });
        const g = await newGroup(ben, 'Admin path');
        await join_(dee, g);
        await say(dee, g, 'Dee before the re-key');
        const dee2 = await rekeyed(dee, 'Dee');
        const pending = await unattestedRekeys(URL_BASE, dee2.identity);
        expect(pending.map((r) => r.pubkey)).toEqual([dee.identity.publicKey]);
        expect(keySuccessionPromptText(pending[0].at)).toMatch(/^This account was re-keyed on \d{1,2} [A-Z][a-z]{2} \d{4}\. Confirm it was you, and the messages you sent before then will show under your name again\.$/);
        expect([KEY_SUCCESSION_PROMPT_YES, KEY_SUCCESSION_PROMPT_NO]).toEqual(['Yes, that was me', 'Not me']);
        // "Not me": nothing is sent, and the line still names nobody.
        forgetGroupKeys();
        expect(nameOf(await shown(ben, g), 'Dee before the re-key')).toBe(GROUP_LINE_FORMER_MEMBER);
        // "Yes, that was me".
        expect(await attestOwnRekeys(URL_BASE, dee2.identity, pending)).toBe(1);
        expect(await unattestedRekeys(URL_BASE, dee2.identity)).toEqual([]);
        forgetGroupKeys();
        expect(nameOf(await shown(ben, g), 'Dee before the re-key')).toBe('Dee');
        // Asked again (a second sign-in): the node keeps the first; nothing changes.
        expect(await postKeySuccession(URL_BASE, dee2.identity, dee.identity.publicKey, '2026-10-05T00:00:00.000Z')).toBe('already');
    });
});

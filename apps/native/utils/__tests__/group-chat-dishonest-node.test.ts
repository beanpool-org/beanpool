/**
 * Group chats on the phone against a DISHONEST node (fix round 1 of #1788; the deciding review's drivers, scratch/reviews/
 * opus-1788.md, with each assertion turned into the refusal the fix makes). The node is the real one on this machine
 * (apps/server/src/phone-door-test-harness.ts, killed by its PID); it is made dishonest in the phones' fetch layer, where
 * a phone can't tell a node's answer from a dishonest node's. Every case is something only the node says: who is
 * "missing" a key, who is in the keys roster, what a 409 says, which lines a locked chat holds, whether a chat is locked.
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
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
    openGroupTopUp, openGroupLine, openGroupEpochRecord, makeGroupEpochRecord, toEd25519Pkcs8, groupLineVerdictKey,
} from '@beanpool/core';

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

import { signedGet, signedPost, signedDelete } from '../node-post';
import {
    groupKeyring, memoryGroupKeyStore, forgetGroupKeys, joinGroupWithEpoch, _resetGroupKeySessionForTests,
    GROUP_KEY_ROLLBACK_TEXT, type GroupKeyStore,
} from '../group-chat-keys';
import { sendSealedGroupLine, openGroupThread, chatIsLocked } from '../group-chat-lines';
import { isSealedGroupLine, type DisplayRosterRow } from '../group-line-display';
import { normaliseThreadMessage } from '../chat-actions';
import { decodeEventChatText } from '../events';
import type { BeanPoolIdentity } from '../identity';

vi.setConfig({ testTimeout: 240_000 });

const SERVER_DIR = fileURLToPath(new URL('../../../server/', import.meta.url).href);
const START_MS = 180_000;

let node: ChildProcessWithoutNullStreams;
let dataDir: string;
let URL_BASE = '';
const replies = new Map<number, (r: { result?: any; error?: string }) => void>();
let nextId = 1;
const realFetch = globalThis.fetch;
const elsewhere: string[] = [];

/** The node turned dishonest: a hook answers instead of the node, or rewrites the node's answer. */
type Req = { method: string; path: string; search: string; body: any; input: any; init: any };
type Hook = (r: Req) => Promise<Response | undefined> | Response | undefined;
const hooks: Hook[] = [];
/** Every request any phone sent, with its body as the node receives it. */
const wire: { method: string; path: string; search: string; body: any }[] = [];
const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function nodeAnswer(r: Req): Promise<{ status: number; body: any }> {
    const res = await realFetch(r.input, r.init);
    return { status: res.status, body: await res.json().catch(() => ({})) };
}

function control<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        replies.set(id, (r) => (r.error ? reject(new Error(r.error)) : resolve(r.result as T)));
        node.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
}
const sql = <T = any>(s: string, params: unknown[] = []) => control<T[]>('sql', { sql: s, params, all: true });
const exec = (s: string, params: unknown[] = []) => control<number>('sql', { sql: s, params });

interface Phone { name: string; identity: BeanPoolIdentity; store: GroupKeyStore; seedHex: string }
function phone(name: string, seed = randomBytes(32), pkcs8 = false): Phone {
    const seedHex = bytesToHex(seed);
    const identity: BeanPoolIdentity = {
        publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: pkcs8 ? bytesToHex(toEd25519Pkcs8(hexToBytes(seedHex))) : seedHex,
        callsign: name, createdAt: new Date().toISOString(),
    };
    return { name, identity, store: memoryGroupKeyStore(), seedHex };
}

async function json(res: Response): Promise<any> {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`${res.status} ${body?.error ?? ''}`), { status: res.status, body });
    return body;
}
const getChat = async (p: Phone, g: string) => json(await signedGet(URL_BASE, `/api/groups/${g}/chat?limit=100`, p.identity));
const roster = async (p: Phone, g: string): Promise<DisplayRosterRow[]> =>
    (await json(await signedGet(URL_BASE, `/api/groups/${g}/members`, p.identity))).filter((m: any) => m.status === 'active')
        .map((m: any) => ({ memberPubkey: m.memberPubkey, callsign: m.callsign, formerKeys: m.formerKeys }));
const ring = (p: Phone, g: string) => groupKeyring(URL_BASE, p.identity, g, p.store);
const say = (p: Phone, g: string, text: string, extra: Record<string, unknown> = {}) =>
    sendSealedGroupLine(URL_BASE, p.identity, p.store, { groupId: g, text, clientId: randomUUID(), ...extra });

async function shown(p: Phone, g: string) {
    const answer = await getChat(p, g);
    const opened = await openGroupThread(ring(p, g), answer, await roster(p, g));
    const lines = (answer.messages as any[]).filter((m) => opened.views.has(m.id)).map((m) => ({ id: m.id as string, ...opened.views.get(m.id)! }));
    return { answer, opened, lines, visible: lines.filter((l) => !l.hidden) };
}

beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'group-chat-dishonest-'));
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
        const method = String(init?.method ?? 'GET');
        let body: any;
        try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = String(init?.body); }
        wire.push({ method, path: u.pathname, search: u.search, body });
        for (const h of [...hooks]) {
            const r = await h({ method, path: u.pathname, search: u.search, body, input, init });
            if (r) return r;
        }
        return realFetch(input, init);
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

const ana = phone('Ana');
const ben = phone('Ben');
const cat = phone('Cat');
const dov = phone('Dov');
const eve = phone('Eve'); // a key the node holds; never a member of this node or of any group
const pia = phone('Pia', randomBytes(32), true); // a phone holding a web-app (PKCS8) key

async function newGroup(owner: Phone, name: string, joinPolicy = 'open'): Promise<string> {
    await exec("UPDATE groups SET created_at = '2000-01-01T00:00:00.000Z' WHERE created_by = ?", [owner.identity.publicKey]);
    return (await json(await signedPost(URL_BASE, '/api/groups', { name, joinPolicy }, owner.identity))).id;
}
const join_ = (p: Phone, g: string) => joinGroupWithEpoch(URL_BASE, p.identity, p.store, { id: g, joinPolicy: 'open' });
/** Every sealed line the node stores for a group, opened with `key` for `epoch` (what a holder of that key reads). */
async function readAllUnder(g: string, epoch: number, key: Uint8Array): Promise<string[]> {
    const rows = await sql("SELECT id, ciphertext, nonce, author_pubkey, metadata, edited_at FROM messages WHERE conversation_id = ? AND type = 'text'", [g]);
    const out: string[] = [];
    for (const m of rows) {
        const meta = JSON.parse(m.metadata || '{}');
        if (meta.epoch !== epoch) continue;
        out.push(openGroupLine({ ciphertext: m.ciphertext, nonce: m.nonce }, {
            groupId: g, epoch, senderPubHex: meta.sender ?? m.author_pubkey, messageId: m.id, part: m.edited_at ? 'edit' : 'body', replyToId: meta.replyToId ?? null,
        }, key).text);
    }
    return out;
}

describe('group chats on the phone against a dishonest node', () => {
    it('setup: node members', async () => {
        await control('limiters');
        await control('members', { members: [ana, ben, cat, dov, pia].map((p) => ({ key: p.identity.publicKey, callsign: p.name })) });
    });

    it('top-ups (finding 1): a key the node lists in keys/missing that is in no roster and no record is handed nothing', async () => {
        await control('limiters');
        const g = await newGroup(ana, 'Leak by top-up');
        await say(ana, g, 'E1: only Ana is here, before anyone joined');
        await join_(ben, g);
        await say(ben, g, 'E2: Ben whispers to Ana');
        const grabbed: any[] = [];
        hooks.push((r) => {
            if (r.method === 'GET' && r.path === `/api/groups/${g}/keys/missing`) return jsonResponse(200, { epoch: 2, missing: [{ pubkey: eve.identity.publicKey, fromEpoch: 1, epochs: [1, 2] }] });
            if (r.method === 'POST' && r.path === `/api/groups/${g}/keys/wrap`) { grabbed.push(r.body); return jsonResponse(201, { success: true }); }
            return undefined;
        });
        await shown(ana, g);
        const handed = await ring(ana, g).serveMissing();
        hooks.pop();
        expect(handed).toBe(0);
        expect(grabbed).toEqual([]);
    });

    it('top-ups (finding 1): a newcomer the node lists as missing epochs from before her is handed none of them', async () => {
        await control('limiters');
        const g = await newGroup(ana, 'Newcomer history');
        await say(ana, g, 'H1: before Cat');
        await join_(ben, g);
        await say(ben, g, 'H2: still before Cat');
        await join_(cat, g);
        const [catRow] = await sql('SELECT from_epoch FROM group_members WHERE group_id = ? AND member_pubkey = ?', [g, cat.identity.publicKey]);
        expect(catRow.from_epoch).toBe(3);
        const grabbed: any[] = [];
        hooks.push((r) => {
            if (r.method === 'GET' && r.path === `/api/groups/${g}/keys/missing`) return jsonResponse(200, { epoch: 3, missing: [{ pubkey: cat.identity.publicKey, fromEpoch: 1, epochs: [1, 2] }] });
            if (r.method === 'POST' && r.path === `/api/groups/${g}/keys/wrap`) { grabbed.push(r.body); return jsonResponse(201, { success: true }); }
            return undefined;
        });
        await shown(ana, g);
        const handed = await ring(ana, g).serveMissing();
        hooks.pop();
        expect(handed).toBe(0);
        expect(grabbed).toEqual([]);
        // Cat holds epoch 3 from her own join: nothing older reached her.
        expect(await sql('SELECT epoch FROM group_key_wraps WHERE group_id = ? AND recipient_pubkey = ? ORDER BY epoch', [g, cat.identity.publicKey])).toEqual([{ epoch: 3 }]);
    });

    it('every request stayed on this machine', () => {
        expect(elsewhere).toEqual([]);
    });
});

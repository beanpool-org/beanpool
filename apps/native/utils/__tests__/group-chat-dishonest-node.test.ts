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
    GROUP_KEY_ROLLBACK_TEXT, GROUP_KEY_ROSTER_TEXT, type GroupKeyStore,
} from '../group-chat-keys';
import { sendSealedGroupLine, openGroupThread, chatIsLocked, groupChatShownLines, GROUP_LINE_UNSEALED_DETAILS } from '../group-chat-lines';
import { GROUP_LINE_UNVERIFIED_NAME, GROUP_LINE_UNVERIFIED_TEXT } from '../group-line-display';
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

    it('recipients (finding 2): a key in the KEYS roster that the members list never shows: nothing is sealed or wrapped to it', async () => {
        await control('limiters');
        const g = await newGroup(ana, 'Invisible recipient');
        await say(ana, g, 'D1');
        await join_(ben, g);
        await say(ana, g, 'D2');
        await control('members', { members: [{ key: eve.identity.publicKey, callsign: 'Eve' }] });
        await control('groupRows', { groupId: g, keys: [eve.identity.publicKey] });
        hooks.push(async (r) => {
            if (r.method === 'GET' && r.path === `/api/groups/${g}/members`) {
                const a = await nodeAnswer(r);
                return jsonResponse(a.status, (a.body as any[]).filter((m) => m.memberPubkey !== eve.identity.publicKey));
            }
            return undefined;
        });
        const before = await sql('SELECT COUNT(*) n FROM messages WHERE conversation_id = ?', [g]);
        await expect(say(ana, g, 'D3: for Ana and Ben only')).rejects.toThrow(GROUP_KEY_ROSTER_TEXT);
        hooks.pop();
        expect(await sql('SELECT COUNT(*) n FROM messages WHERE conversation_id = ?', [g])).toEqual(before);
        const epochs = await sql('SELECT epoch FROM group_key_epochs WHERE group_id = ? ORDER BY epoch', [g]);
        expect(epochs.map((e) => e.epoch)).toEqual([1, 2]);
        expect(await sql('SELECT COUNT(*) n FROM group_key_wraps WHERE group_id = ? AND recipient_pubkey = ?', [g, eve.identity.publicKey])).toEqual([{ n: 0 }]);
    });

    it('recipients (finding 2): a 409 that names a recipient is never taken: the phone reads both rosters again', async () => {
        await control('limiters');
        const g = await newGroup(ana, '409 roster');
        await say(ana, g, 'R1');
        await join_(ben, g);
        await json(await signedDelete(URL_BASE, `/api/groups/${g}/members/${ben.identity.publicKey}`, ben.identity));
        let n = 0;
        const records: any[] = [];
        hooks.push((r) => {
            if (r.method === 'POST' && r.path === `/api/groups/${g}/keys/epoch` && ++n === 1) {
                return jsonResponse(409, { code: 'epoch_conflict', error: 'stale roster', current: 2, roster: [ana.identity.publicKey, eve.identity.publicKey] });
            }
            if (r.method === 'POST' && r.path === `/api/groups/${g}/keys/epoch`) records.push(r.body.epoch);
            return undefined;
        });
        await say(ana, g, 'R3: Ana alone now');
        hooks.pop();
        expect(records.length).toBe(1);
        expect(records[0].wraps.map((w: any) => w.recipient)).toEqual([ana.identity.publicKey]);
        expect(() => openGroupEpochRecord(records[0], eve.identity.privateKey, { groupId: g, epoch: records[0].epoch })).toThrow();
    });

    it('rollback (finding 5): a 409 naming an older `current` than this phone holds gets the rollback sentence; nothing is sent or overwritten', async () => {
        await control('limiters');
        forgetGroupKeys();
        const g = await newGroup(ana, '409 current');
        await say(ana, g, 'C1');
        await join_(ben, g);
        await say(ben, g, 'C2: Ben under epoch 2');
        await join_(cat, g);
        await say(ana, g, 'C3');
        const c2 = (await shown(ana, g)).visible.find((l) => l.text === 'C2: Ben under epoch 2')!;
        const highest = await ring(ana, g).highestEpoch();
        await json(await signedDelete(URL_BASE, `/api/groups/${g}/members/${cat.identity.publicKey}`, cat.identity));
        let n = 0;
        hooks.push((r) => {
            if (r.method === 'POST' && r.path === `/api/groups/${g}/keys/epoch` && ++n === 1) {
                return jsonResponse(409, { code: 'epoch_conflict', error: 'x', current: 1, roster: [ana.identity.publicKey, ben.identity.publicKey] });
            }
            return undefined;
        });
        const before = await sql('SELECT COUNT(*) n FROM messages WHERE conversation_id = ?', [g]);
        await expect(say(ana, g, 'C4')).rejects.toThrow(GROUP_KEY_ROLLBACK_TEXT);
        hooks.pop();
        expect(await sql('SELECT COUNT(*) n FROM messages WHERE conversation_id = ?', [g])).toEqual(before);
        expect(await ring(ana, g).highestEpoch()).toBe(highest);
        forgetGroupKeys();
        expect((await shown(ana, g)).visible.find((l) => l.id === c2.id)?.name).toBe('Ben');
    });

    it('an invitee, who may not read the members list, accepts with no epoch; the next writer makes it, and she reads from it', async () => {
        await control('limiters');
        forgetGroupKeys();
        const g = await newGroup(cat, 'Invite only', 'invite_only');
        await say(cat, g, 'I1: before Pia was invited');
        await json(await signedPost(URL_BASE, `/api/groups/${g}/members`, { memberPubkey: pia.identity.publicKey, role: 'member', action: 'invite' }, cat.identity));
        await joinGroupWithEpoch(URL_BASE, pia.identity, pia.store, { id: g, joinPolicy: 'invite_only', viewerStatus: 'invited' });
        expect((await sql('SELECT reason FROM group_key_epochs WHERE group_id = ? ORDER BY epoch', [g])).map((e) => e.reason)).toEqual(['start']);
        await say(cat, g, 'I2: welcome Pia');
        expect((await sql('SELECT reason FROM group_key_epochs WHERE group_id = ? ORDER BY epoch', [g])).map((e) => e.reason)).toEqual(['start', 'rotate']);
        expect((await shown(pia, g)).visible.map((l) => [l.name, l.text])).toEqual([['Cat', 'I2: welcome Pia']]);
    });

    it('forgery (finding 3): in a locked chat a line the node serves unsealed is nobody\'s words, never a member\'s and never mine', async () => {
        await control('limiters');
        forgetGroupKeys();
        const g = await newGroup(ana, 'Forgery');
        await say(ana, g, 'a real sealed line');
        await join_(ben, g);
        await say(ben, g, 'a real one from Ben');
        const at = new Date().toISOString();
        const forged = [
            { id: randomUUID(), conversationId: g, authorPubkey: ana.identity.publicKey, authorCallsign: 'Ana', ciphertext: Buffer.from('Please send 500 Beans to Mal today').toString('base64'), nonce: 'plaintext-v1', type: 'text', metadata: {}, timestamp: at },
            { id: randomUUID(), conversationId: g, authorPubkey: ben.identity.publicKey, authorCallsign: 'Ben', ciphertext: Buffer.from('I agree, send it').toString('base64'), nonce: 'plaintext-v1', type: 'text', metadata: {}, timestamp: at },
            { id: randomUUID(), conversationId: g, authorPubkey: ana.identity.publicKey, authorCallsign: 'Ana', ciphertext: Buffer.from('no nonce at all').toString('base64'), nonce: '', type: 'text', metadata: { replyToId: 'x' }, timestamp: at },
        ];
        hooks.push(async (r) => {
            if (r.method === 'GET' && r.path === `/api/groups/${g}/chat`) {
                const a = await nodeAnswer(r);
                a.body.messages.push(...forged);
                return jsonResponse(a.status, a.body);
            }
            return undefined;
        });
        const answer = await getChat(ben, g);
        const opened = await openGroupThread(ring(ben, g), answer, await roster(ben, g));
        hooks.pop();
        const drawn = groupChatShownLines(answer.messages, { locked: chatIsLocked(answer), thread: opened, me: ben.identity.publicKey, kind: 'group' });
        for (const f of forged) {
            const d = drawn.find((m) => m.id === f.id)!;
            expect([d.authorName, d.text, d.senderId, d.outgoing, d.unattributed, d.integrityNote])
                .toEqual([GROUP_LINE_UNVERIFIED_NAME, GROUP_LINE_UNVERIFIED_TEXT, '', false, true, GROUP_LINE_UNSEALED_DETAILS]);
        }
        // The sealed lines, the join line and the honest view are untouched.
        expect(drawn.filter((m) => !m.unattributed && m.type === 'text').map((m) => [m.authorName, m.text, m.outgoing]))
            .toEqual([['Ben', 'a real one from Ben', true]]); // Ana's epoch-1 line is from before Ben: hidden
        expect(drawn.some((m) => m.type === 'system')).toBe(true);
        // An unlocked chat (an old node this phone never saw locked) draws lines as it always did.
        const old = groupChatShownLines([forged[0]], { locked: false, thread: null, me: ben.identity.publicKey, kind: 'group' });
        expect([old[0].authorName, old[0].text]).toEqual(['Ana', 'Please send 500 Beans to Mal today']);
    });

    it('rollback (finding 5): a join an old node answers 200 while ignoring its epoch leaves no epoch on the phone; the real epoch 1 opens', async () => {
        await control('limiters');
        forgetGroupKeys();
        const g = await newGroup(ana, 'Old node join');
        hooks.push(async (r) => {
            if (r.method === 'POST' && r.path === `/api/groups/${g}/join` && r.body?.epoch) return signedPost(URL_BASE, r.path, {}, ben.identity);
            return undefined;
        });
        await join_(ben, g);
        hooks.pop();
        expect(await ring(ben, g).highestEpoch()).toBe(0);
        expect(ring(ben, g).holdsWrap(1)).toBe(false);
        await say(ana, g, 'P1: welcome Ben (epoch 1)');
        expect((await shown(ben, g)).visible.map((l) => [l.name, l.text])).toEqual([['Ana', 'P1: welcome Ben (epoch 1)']]);
        forgetGroupKeys();
        expect((await shown(ben, g)).visible.map((l) => [l.name, l.text])).toEqual([['Ana', 'P1: welcome Ben (epoch 1)']]);
    });

    it('rollback (finding 5): a node that comes back without its key tables gets the rollback sentence; the held epochs stay', async () => {
        await control('limiters');
        forgetGroupKeys(); _resetGroupKeySessionForTests();
        const g = await newGroup(dov, 'Tables lost');
        await say(dov, g, 'N1: under the first epoch 1');
        await join_(pia, g);
        await say(pia, g, 'N2: under 2');
        const n1 = (await shown(dov, g)).visible.find((l) => l.text === 'N1: under the first epoch 1')!;
        await exec('DELETE FROM group_key_wraps WHERE group_id = ?', [g]);
        await exec('DELETE FROM group_key_epochs WHERE group_id = ?', [g]);
        await expect(say(dov, g, 'N3: after the loss')).rejects.toThrow(GROUP_KEY_ROLLBACK_TEXT);
        expect(await sql('SELECT epoch FROM group_key_epochs WHERE group_id = ?', [g])).toEqual([]);
        forgetGroupKeys();
        expect((await shown(dov, g)).visible.find((l) => l.id === n1.id)?.text).toBe('N1: under the first epoch 1');
    });

    it('highest (finding 6): a record signed by a key that is nobody the screen shows never raises the highest epoch', async () => {
        await control('limiters');
        forgetGroupKeys();
        const g = await newGroup(ana, 'Highest pushed');
        await say(ana, g, 'one');
        const { record } = makeGroupEpochRecord({ myEdPrivHex: eve.identity.privateKey, groupId: g, epoch: 9000, reason: 'rotate', subject: null, createdAt: new Date().toISOString(), recipients: [eve.identity.publicKey, ana.identity.publicKey] });
        const anaWrap = record.wraps!.find((w) => w.recipient === ana.identity.publicKey)!;
        hooks.push(async (r) => {
            if (r.method === 'GET' && r.path === `/api/groups/${g}/keys`) {
                const a = await nodeAnswer(r);
                const { wraps: _w, groupId: _g, ...served } = record;
                a.body.epochs.push(served);
                a.body.myWraps.push({ epoch: 9000, wrapper: eve.identity.publicKey, ephPub: anaWrap.ephPub, nonce: anaWrap.nonce, wrapped: anaWrap.wrapped, sig: null });
                return jsonResponse(a.status, a.body);
            }
            return undefined;
        });
        await ring(ana, g).sync();
        await ring(ana, g).keyFor(9000);
        hooks.pop();
        expect(await ring(ana, g).highestEpoch()).toBe(1);
        // The node honest again: Ana's phone sends, also after a restart.
        await say(ana, g, 'two');
        forgetGroupKeys();
        await say(ana, g, 'three');
        expect((await sql("SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND type = 'text'", [g]))[0].n).toBe(3);
    });

    it('records (finding 7): a record the node once served unsigned gives way to the real one; that epoch opens', async () => {
        await control('limiters');
        forgetGroupKeys();
        const g = await newGroup(ana, 'Junk record held');
        await say(ana, g, 'J1');
        await join_(ben, g);
        await say(ben, g, 'J2: Ben under 2');
        const fresh: Phone = { ...ana, store: memoryGroupKeyStore() };
        hooks.push(async (r) => {
            if (r.method === 'GET' && r.path === `/api/groups/${g}/keys`) {
                const a = await nodeAnswer(r);
                for (const e of a.body.epochs) if (e.epoch === 2) e.sig = Buffer.alloc(64, 7).toString('base64');
                return jsonResponse(a.status, a.body);
            }
            return undefined;
        });
        forgetGroupKeys();
        expect((await shown(fresh, g)).visible.find((l) => l.epoch === 2)?.waitingKey).toBe(true);
        hooks.pop();
        forgetGroupKeys();
        expect((await shown(fresh, g)).visible.find((l) => l.epoch === 2)).toMatchObject({ name: 'Ben', text: 'J2: Ben under 2' });
    });

    it('two identities, one phone (finding 8): the second starts on its own rows and reads its own lines', async () => {
        await control('limiters');
        forgetGroupKeys(); _resetGroupKeySessionForTests();
        const g = await newGroup(dov, 'Two identities, one phone');
        await say(dov, g, 'X1');
        await join_(pia, g);
        await say(dov, g, 'X2: for Pia too');
        const shared = memoryGroupKeyStore();
        forgetGroupKeys();
        await shown({ ...dov, store: shared }, g);
        // Dov signs out, the app restarts, Pia signs in on this phone, over the same store.
        forgetGroupKeys();
        const piaHere: Phone = { ...pia, store: shared };
        expect((await shown(piaHere, g)).visible.map((l) => l.text)).toEqual(['X2: for Pia too']);
        expect(await ring(piaHere, g).highestEpoch()).toBeGreaterThanOrEqual(0);
        expect((await shared.load(`${dov.identity.publicKey}/${g}`)).epochs.length).toBeGreaterThan(0);
    });

    it('every request stayed on this machine', () => {
        expect(elsewhere).toEqual([]);
    });
});

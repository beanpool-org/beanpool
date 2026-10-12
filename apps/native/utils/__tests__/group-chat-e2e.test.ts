/**
 * Group chats on the phone, end to end, against a REAL node on this machine (group chats slice 3, §17 row 3's proof):
 * apps/server/src/phone-door-test-harness.ts (a community's node: the real HTTPS server, signature middleware, group and
 * key routes), started from the packages' sources and killed by its PID. Several phones, each its own identity and its
 * own key store, drive the phone's own code (utils/group-chat-keys.ts, group-chat-lines.ts, group-line-display.ts):
 *
 *   join / send / read; a newcomer can't read older lines (and never holds their key); a convenor's removal is the
 *   rotation; a leave makes the next writer rotate; restore from the 12 words brings history back from the joining epoch
 *   on; a forged line shows "Unverified"; the line-display rule against a node that moves the author column; a node that
 *   rolls the epoch back is refused; a junk wrap is refused and topped up by another member; "waiting for the group's
 *   next key"; a 200-member rotation, timed.
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
import { wrapGroupKey } from '@beanpool/core';

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
    groupKeyring, memoryGroupKeyStore, forgetGroupKeys, joinGroupWithEpoch, removeWithEpoch, approveWithEpoch, GroupChatKeyError,
    GROUP_KEY_ROLLBACK_TEXT, type GroupKeyStore,
} from '../group-chat-keys';
import { sendSealedGroupLine, editSealedGroupLine, openGroupThread, chatIsLocked } from '../group-chat-lines';
import { GROUP_LINE_UNVERIFIED_NAME, GROUP_LINE_UNVERIFIED_TEXT, type DisplayRosterRow } from '../group-line-display';
import type { BeanPoolIdentity } from '../identity';
import { buildSignedHeaders } from '../crypto';

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
    dataDir = mkdtempSync(join(tmpdir(), 'group-chat-e2e-'));
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

const anaSeed = randomBytes(32);
const ana = phone('Ana', anaSeed);
const ben = phone('Ben');
const cat = phone('Cat');
const dov = phone('Dov');
const mal = phone('Mal');
let G = '';

async function newGroup(owner: Phone, name: string, joinPolicy = 'open'): Promise<string> {
    return (await json(await signedPost(URL_BASE, '/api/groups', { name, joinPolicy }, owner.identity))).id;
}

describe('group chats on the phone, end to end against a real node', () => {
    it('two phones: the first line starts epoch 1, a joiner makes their own epoch, and each reads what the other sealed', async () => {
        await control('limiters');
        await control('members', { members: [ana, ben, cat, dov, mal].map((p) => ({ key: p.identity.publicKey, callsign: p.name })) });
        G = await newGroup(ana, 'Garden Crew');

        await say(ana, G, 'before Ben came');
        const k1 = await control<any[]>('sql', { sql: 'SELECT epoch, reason, created_by FROM group_key_epochs WHERE group_id = ? ORDER BY epoch', params: [G], all: true });
        expect(k1).toEqual([{ epoch: 1, reason: 'start', created_by: ana.identity.publicKey }]);

        await joinGroupWithEpoch(URL_BASE, ben.identity, ben.store, { id: G, joinPolicy: 'open' });
        const k2 = await control<any[]>('sql', { sql: 'SELECT epoch, reason, created_by, subject_pubkey FROM group_key_epochs WHERE group_id = ? ORDER BY epoch', params: [G], all: true });
        expect(k2[1]).toEqual({ epoch: 2, reason: 'join', created_by: ben.identity.publicKey, subject_pubkey: ben.identity.publicKey });
        expect((await control<any[]>('sql', { sql: 'SELECT from_epoch FROM group_members WHERE group_id = ? AND member_pubkey = ?', params: [G, ben.identity.publicKey], all: true }))[0].from_epoch).toBe(2);

        await say(ana, G, 'hello Ben, from Ana');
        await say(ben, G, 'hi @Ana', { mentionCandidates: [{ pubkey: ana.identity.publicKey, callsign: 'Ana' }] });

        const forBen = await shown(ben, G);
        expect(forBen.visible.map((l) => [l.name, l.text])).toEqual([['Ana', 'hello Ben, from Ana'], ['Ben', 'hi @Ana']]);
        const forAna = await shown(ana, G);
        expect(forAna.visible.map((l) => [l.name, l.text])).toEqual([['Ana', 'before Ben came'], ['Ana', 'hello Ben, from Ana'], ['Ben', 'hi @Ana']]);
        // The mention was found on Ben's phone and declared; the node kept it (it can no longer read the words).
        const benLine = forAna.answer.messages.find((m: any) => m.id === forAna.visible[2].id);
        const benMeta = typeof benLine.metadata === 'string' ? JSON.parse(benLine.metadata) : benLine.metadata;
        expect(benMeta.mentions).toEqual([ana.identity.publicKey]);
        // Nothing the node stores is readable.
        const rows = await control<any[]>('sql', { sql: "SELECT ciphertext, nonce FROM messages WHERE conversation_id = ? AND type = 'text'", params: [G], all: true });
        expect(rows.length).toBe(3);
        for (const r of rows) {
            expect(r.nonce.startsWith('group-xc20p-v1:')).toBe(true);
            expect(Buffer.from(r.ciphertext, 'base64').toString('utf8')).not.toMatch(/Ben|Ana|hello/);
        }
    }, 60_000);

    it('a newcomer can\'t read older lines: the node serves none, and Ben\'s phone never holds epoch 1\'s key', async () => {
        const r = ring(ben, G);
        expect(await r.keyFor(1)).toBeNull();
        const keys = await json(await signedGet(URL_BASE, `/api/groups/${G}/keys?epochs=1,2`, ben.identity));
        expect(keys.epochs.map((e: any) => e.epoch)).toEqual([2]);
        expect(keys.myWraps.map((w: any) => w.epoch)).toEqual([2]);
        const forBen = await shown(ben, G);
        expect(forBen.visible.some((l) => l.text === 'before Ben came')).toBe(false);
    }, 30_000);

    it('a convenor\'s removal is the rotation: Cat joins, Ana removes her, the next line is under a key Cat never held', async () => {
        await control('limiters');
        await joinGroupWithEpoch(URL_BASE, cat.identity, cat.store, { id: G, joinPolicy: 'open' });
        await say(cat, G, 'Cat was here');
        await removeWithEpoch(URL_BASE, ana.identity, ana.store, G, cat.identity.publicKey, async (body) => {
            const path = `/api/groups/${G}/members/${cat.identity.publicKey}`;
            const bodyString = JSON.stringify(body);
            const headers = await buildSignedHeaders('DELETE', `${URL_BASE}${path}`, bodyString, ana.identity.privateKey, ana.identity.publicKey);
            return fetch(`${URL_BASE}${path}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', ...headers }, body: bodyString });
        });
        const ep = await control<any[]>('sql', { sql: 'SELECT epoch, reason, subject_pubkey FROM group_key_epochs WHERE group_id = ? ORDER BY epoch DESC LIMIT 1', params: [G], all: true });
        expect(ep[0]).toEqual({ epoch: 4, reason: 'remove', subject_pubkey: cat.identity.publicKey });
        const wraps = await control<any[]>('sql', { sql: 'SELECT recipient_pubkey FROM group_key_wraps WHERE group_id = ? AND epoch = 4', params: [G], all: true });
        expect(wraps.map((w) => w.recipient_pubkey).sort()).toEqual([ana.identity.publicKey, ben.identity.publicKey].sort());
        await say(ana, G, 'after Cat left');
        const line = await control<any[]>('sql', { sql: "SELECT json_extract(metadata, '$.epoch') e FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT 1", params: [G], all: true });
        expect(line[0].e).toBe(4);
        await expect(getChat(cat, G)).rejects.toMatchObject({ status: 403 });
        const forBen = await shown(ben, G);
        expect(forBen.visible.map((l) => l.text)).toContain('after Cat left');
        // Cat's line, sealed under 3 while she was a member, reads as hers, "no longer in this group" (a node member still).
        const catLine = forBen.visible.find((l) => l.text === 'Cat was here')!;
        expect([catLine.name, catLine.nameHint]).toEqual(['Cat', 'no longer in this group']);
    }, 60_000);

    it('a leave makes the next writer rotate first: Ben leaves, Ana\'s next line is under a new epoch for Ana alone', async () => {
        await control('limiters');
        await json(await signedDelete(URL_BASE, `/api/groups/${G}/members/${ben.identity.publicKey}`, ben.identity));
        const stale = await control<any[]>('sql', { sql: 'SELECT epoch, stale_since FROM group_key_epochs WHERE group_id = ? AND epoch = 4', params: [G], all: true });
        expect(stale[0].stale_since).not.toBeNull();
        await say(ana, G, 'just me now');
        const ep = await control<any[]>('sql', { sql: 'SELECT epoch, reason FROM group_key_epochs WHERE group_id = ? ORDER BY epoch DESC LIMIT 1', params: [G], all: true });
        expect(ep[0]).toEqual({ epoch: 5, reason: 'rotate' });
        const wraps = await control<any[]>('sql', { sql: 'SELECT recipient_pubkey FROM group_key_wraps WHERE group_id = ? AND epoch = 5', params: [G], all: true });
        expect(wraps.map((w) => w.recipient_pubkey)).toEqual([ana.identity.publicKey]);
    }, 60_000);

    it('restore from the 12 words: a new phone with Dov\'s seed reads from his joining epoch on, nothing earlier', async () => {
        await control('limiters');
        await joinGroupWithEpoch(URL_BASE, dov.identity, dov.store, { id: G, joinPolicy: 'open' });
        await say(ana, G, 'welcome Dov');
        await say(dov, G, 'thanks Ana');
        // The phone is lost: a new one, the same 12 words (the same seed), an empty store, nothing in memory.
        forgetGroupKeys();
        const restored: Phone = { name: 'Dov', identity: { ...dov.identity }, store: memoryGroupKeyStore() };
        const view = await shown(restored, G);
        expect(view.visible.map((l) => [l.name, l.text])).toEqual([['Ana', 'welcome Dov'], ['Dov', 'thanks Ana']]);
        expect(view.answer.encryption.fromEpoch).toBe(6);
        expect(await ring(restored, G).keyFor(5)).toBeNull();
    }, 60_000);

    it('a forged line shows "Unverified": Mal, holding the key, seals words under Ana\'s name; the node stores what he sent', async () => {
        await control('limiters');
        await joinGroupWithEpoch(URL_BASE, mal.identity, mal.store, { id: G, joinPolicy: 'open' });
        // Mal sends a real line, then the node (dishonest) moves its author column and sender tag to Ana.
        await say(mal, G, 'send the hall money to my account');
        const [row] = await control<any[]>('sql', { sql: 'SELECT id FROM messages WHERE conversation_id = ? AND author_pubkey = ? ORDER BY timestamp DESC LIMIT 1', params: [G, mal.identity.publicKey], all: true });
        await control('sql', { sql: "UPDATE messages SET author_pubkey = ?, metadata = json_set(metadata, '$.sender', ?) WHERE id = ?", params: [ana.identity.publicKey, ana.identity.publicKey, row.id] });
        const forDov = await shown(dov, G);
        const forged = forDov.visible.find((l) => l.id === row.id)!;
        expect([forged.name, forged.text, forged.unverified]).toEqual([GROUP_LINE_UNVERIFIED_NAME, GROUP_LINE_UNVERIFIED_TEXT, true]);
    }, 60_000);

    it('line display (design §7 cases 1–3) against the node: the key that opens the line names it, never the author column', async () => {
        await control('limiters');
        await say(mal, G, 'Mal says hi');
        await say(ana, G, 'Ana says hi');
        const ids = await control<any[]>('sql', { sql: "SELECT id, author_pubkey FROM messages WHERE conversation_id = ? AND type = 'text' ORDER BY timestamp DESC LIMIT 2", params: [G], all: true });
        const malId = ids.find((r) => r.author_pubkey === mal.identity.publicKey)!.id;
        const anaId = ids.find((r) => r.author_pubkey === ana.identity.publicKey)!.id;
        // 1. author column = Ana, sender = Mal, bytes by Mal → "Mal".
        await control('sql', { sql: 'UPDATE messages SET author_pubkey = ? WHERE id = ?', params: [ana.identity.publicKey, malId] });
        // 2. The flip: author column = Mal, sender = Ana, bytes by Ana → "Ana".
        await control('sql', { sql: 'UPDATE messages SET author_pubkey = ? WHERE id = ?', params: [mal.identity.publicKey, anaId] });
        let v = await shown(dov, G);
        expect(v.visible.find((l) => l.id === malId)!.name).toBe('Mal');
        expect(v.visible.find((l) => l.id === anaId)!.name).toBe('Ana');
        // 3. sender wrong, author column right → opens by the fallback, shown as its signer.
        await control('sql', { sql: "UPDATE messages SET author_pubkey = ?, metadata = json_set(metadata, '$.sender', ?) WHERE id = ?", params: [ana.identity.publicKey, mal.identity.publicKey, anaId] });
        v = await shown(dov, G);
        expect([v.visible.find((l) => l.id === anaId)!.name, v.visible.find((l) => l.id === anaId)!.text]).toEqual(['Ana', 'Ana says hi']);
        //    Both wrong → "Unverified", no words.
        await control('sql', { sql: "UPDATE messages SET author_pubkey = ?, metadata = json_set(metadata, '$.sender', ?) WHERE id = ?", params: [dov.identity.publicKey, mal.identity.publicKey, anaId] });
        v = await shown(dov, G);
        expect([v.visible.find((l) => l.id === anaId)!.name, v.visible.find((l) => l.id === anaId)!.text]).toEqual([GROUP_LINE_UNVERIFIED_NAME, GROUP_LINE_UNVERIFIED_TEXT]);
    }, 60_000);

    it('an edit is sealed under its line\'s own epoch, and a newcomer since never holds it', async () => {
        await control('limiters');
        await say(dov, G, 'meet at 9');
        const [row] = await control<any[]>('sql', { sql: "SELECT id, metadata FROM messages WHERE conversation_id = ? AND author_pubkey = ? AND type = 'text' ORDER BY timestamp DESC LIMIT 1", params: [G, dov.identity.publicKey], all: true });
        const epoch = JSON.parse(row.metadata).epoch;
        await joinGroupWithEpoch(URL_BASE, ben.identity, ben.store, { id: G, joinPolicy: 'open' });
        await editSealedGroupLine(URL_BASE, dov.identity, dov.store, { groupId: G, messageId: row.id, metadata: JSON.parse(row.metadata), text: 'meet at 10' });
        const [after] = await control<any[]>('sql', { sql: 'SELECT metadata, edited_at FROM messages WHERE id = ?', params: [row.id], all: true });
        expect(JSON.parse(after.metadata).epoch).toBe(epoch);
        expect(after.edited_at).not.toBeNull();
        const forAna = await shown(ana, G);
        expect(forAna.visible.find((l) => l.id === row.id)!.text).toBe('meet at 10');
        const forBen = await shown(ben, G);
        expect(forBen.lines.find((l) => l.id === row.id)).toBeUndefined();
    }, 60_000);

    it('a node that rolls the epoch back is refused: nothing is sent, and the sentence says why', async () => {
        await control('limiters');
        const g2 = await newGroup(ana, 'Rollback Test');
        await say(ana, g2, 'one');
        await say(ana, g2, 'two');
        await control('groupRows', { groupId: g2, keys: [ben.identity.publicKey] });
        await say(ana, g2, 'three'); // the roster grew without a rotation: Ana's phone rotates to epoch 2 first
        expect(await ring(ana, g2).highestEpoch()).toBe(2);
        await control('sql', { sql: 'DELETE FROM group_key_wraps WHERE group_id = ? AND epoch = 2', params: [g2] });
        await control('sql', { sql: 'DELETE FROM group_key_epochs WHERE group_id = ? AND epoch = 2', params: [g2] });
        const before = (await control<any[]>('sql', { sql: 'SELECT COUNT(*) n FROM messages WHERE conversation_id = ?', params: [g2], all: true }))[0].n;
        await expect(say(ana, g2, 'four')).rejects.toThrow(GROUP_KEY_ROLLBACK_TEXT);
        await expect(say(ana, g2, 'four')).rejects.toBeInstanceOf(GroupChatKeyError);
        expect((await control<any[]>('sql', { sql: 'SELECT COUNT(*) n FROM messages WHERE conversation_id = ?', params: [g2], all: true }))[0].n).toBe(before);
    }, 60_000);

    it('a junk wrap is refused at once (commitment) and another member tops the slot up', async () => {
        await control('limiters');
        const g3 = await newGroup(ana, 'Top-up Test');
        await say(ana, g3, 'first');
        await joinGroupWithEpoch(URL_BASE, ben.identity, ben.store, { id: g3, joinPolicy: 'open' });
        await joinGroupWithEpoch(URL_BASE, cat.identity, cat.store, { id: g3, joinPolicy: 'open' });
        await say(ana, g3, 'under three');
        // The node replaces Cat's wrap for epoch 3 with a box holding another key, labelled from its maker.
        const [ep] = await control<any[]>('sql', { sql: 'SELECT created_by FROM group_key_epochs WHERE group_id = ? AND epoch = 3', params: [g3], all: true });
        const junk = wrapGroupKey(new Uint8Array(randomBytes(32)), { groupId: g3, epoch: 3, recipientPubHex: cat.identity.publicKey, wrapperPubHex: ep.created_by });
        await control('sql', { sql: 'UPDATE group_key_wraps SET eph_pub = ?, nonce = ?, wrapped = ? WHERE group_id = ? AND epoch = 3 AND recipient_pubkey = ?', params: [junk.ephPub, junk.nonce, junk.wrapped, g3, cat.identity.publicKey] });
        forgetGroupKeys();
        const catFresh: Phone = { ...cat, store: memoryGroupKeyStore() };
        let v = await shown(catFresh, g3);
        expect(v.visible.find((l) => l.text === 'under three')).toBeUndefined();
        const rejected = await control<any[]>('sql', { sql: 'SELECT rejected_at FROM group_key_wraps WHERE group_id = ? AND epoch = 3 AND recipient_pubkey = ?', params: [g3, cat.identity.publicKey], all: true });
        expect(rejected[0].rejected_at).not.toBeNull();
        // Ben's phone opens the chat, sees Cat missing, and hands her the key.
        expect(await ring(ben, g3).serveMissing()).toBeGreaterThanOrEqual(1);
        v = await shown(catFresh, g3);
        expect(v.visible.find((l) => l.text === 'under three')?.name).toBe('Ana');
    }, 60_000);

    it('"waiting for the group\'s next key": a member let in without an epoch, until the next writer rotates', async () => {
        await control('limiters');
        const g4 = await newGroup(ana, 'Old App Join');
        await say(ana, g4, 'hello');
        // An old app's join: no epoch. The node marks the current epoch stale and Dov's keys begin at the next.
        await json(await signedPost(URL_BASE, `/api/groups/${g4}/join`, {}, dov.identity));
        const v = await shown(dov, g4);
        expect(v.opened.waitingForNextKey).toBe(true);
        await say(dov, g4, 'my first line');
        const after = await shown(dov, g4);
        expect(after.opened.waitingForNextKey).toBe(false);
        expect(after.visible.map((l) => [l.name, l.text])).toEqual([['Dov', 'my first line']]);
    }, 60_000);

    it('approval: the convenor\'s phone makes the approved member\'s first epoch', async () => {
        await control('limiters');
        const g5 = await newGroup(ana, 'Ask First', 'request_to_join');
        await say(ana, g5, 'before');
        await joinGroupWithEpoch(URL_BASE, ben.identity, ben.store, { id: g5, joinPolicy: 'request_to_join' });
        await approveWithEpoch(URL_BASE, ana.identity, ana.store, g5, ben.identity.publicKey, { memberPubkey: ben.identity.publicKey, action: 'approve' });
        const [ep] = await control<any[]>('sql', { sql: 'SELECT epoch, reason, subject_pubkey FROM group_key_epochs WHERE group_id = ? ORDER BY epoch DESC LIMIT 1', params: [g5], all: true });
        expect(ep).toEqual({ epoch: 2, reason: 'approve', subject_pubkey: ben.identity.publicKey });
        await say(ben, g5, 'thanks for letting me in');
        expect((await shown(ana, g5)).visible.map((l) => l.text)).toEqual(['before', 'thanks for letting me in']);
    }, 60_000);

    it('a 200-member rotation, timed on this machine (Node, V8): one request, every wrap checked by the node', async () => {
        await control('limiters');
        // Mal starts it (a member may start 5 groups a day, and Ana has started hers).
        const g6 = await newGroup(mal, 'Big Group');
        await say(mal, g6, 'small for now');
        const crowd = Array.from({ length: 199 }, (_, i) => phone(`P${i}`));
        await control('members', { members: crowd.map((p) => ({ key: p.identity.publicKey, callsign: p.name })) });
        await control('groupRows', { groupId: g6, keys: crowd.map((p) => p.identity.publicKey) });
        const progress: [number, number][] = [];
        const t0 = performance.now();
        await say(mal, g6, 'hello everyone', { progress: { onProgress: (d: number, t: number) => progress.push([d, t]) } });
        const ms = performance.now() - t0;
        const wraps = await control<any[]>('sql', { sql: 'SELECT COUNT(*) n FROM group_key_wraps WHERE group_id = ? AND epoch = 2', params: [g6], all: true });
        expect(wraps[0].n).toBe(200);
        expect(progress[progress.length - 1]).toEqual([200, 200]);
        expect(progress.length).toBeGreaterThanOrEqual(20);
        console.log(`GROUP-ROTATION-200 ${Math.round(ms)} ms (sync + 200 wraps + digests + signature + POST + seal + POST, Node ${process.version})`);
        // One crowd member reads the line from a cold phone.
        const p0: Phone = crowd[0];
        await control('sql', { sql: 'UPDATE group_members SET from_epoch = 2 WHERE group_id = ? AND member_pubkey = ?', params: [g6, p0.identity.publicKey] });
        expect((await shown(p0, g6)).visible.map((l) => [l.name, l.text])).toEqual([['Mal', 'hello everyone']]);
    }, 120_000);

    it('every request stayed on this machine, and none was a readable group line', () => {
        expect(elsewhere).toEqual([]);
        expect(sent.filter((s) => s.path.endsWith('/chat/message') && s.status === 400)).toEqual([]);
    });
});

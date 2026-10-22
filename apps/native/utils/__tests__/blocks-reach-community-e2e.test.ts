/**
 * The phone's Block against a REAL community node on this machine (design message-a-friend §7 S4):
 * apps/server/src/phone-door-test-harness.ts with PHONE_DOOR_PROFILE=community, the real HTTPS server, signature
 * middleware and block routes (routes/blocks.ts), started from the packages' sources and killed by its PID. The phone is
 * its own code: utils/blocklist.ts, signing with the key on the phone.
 *
 *   1. Ana's phone held blocks from before this build (Hal, and Sol, whom this community has no row for): the first sync
 *      puts both on the list the community keeps for her, and a second sync sends nothing.
 *   2. She blocks Dee on the phone: the community has it at once, and Dee's new chat with her never appears in her chats,
 *      while Cy's does. Delivery is withheld by the node, not hidden by the phone.
 *   3. She unblocks Hal on the phone: the community's list no longer has him.
 *
 * Nothing else is contacted: the phone's fetch is held to this node's address, and the node's own fetch refuses every
 * host but this machine.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
        getAllKeys: vi.fn(async () => [...mem.async.keys()]),
        multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((k) => mem.async.delete(k)); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => mem.secure.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { mem.secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { mem.secure.delete(key); }),
}));

import { draftIdentity, type BeanPoolIdentity } from '../identity';
import { signedGet, signedPost } from '../node-post';

const SERVER_DIR = fileURLToPath(new URL('../../../server/', import.meta.url).href);
const START_MS = 120_000;
const ANCHOR = 'beanpool_anchor_url';
const IDENTITY_KEY = 'sovereign-identity';

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

beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'blocks-reach-community-e2e-'));
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

/** The keys on `owner`'s block list, as the node keeps it. */
async function blockedAtNode(owner: string): Promise<string[]> {
    const rows = await control<{ blocked_pubkey: string }[]>('sql', {
        sql: 'SELECT blocked_pubkey FROM member_blocks WHERE owner_pubkey = ? ORDER BY blocked_pubkey', params: [owner], all: true,
    });
    return rows.map((r) => r.blocked_pubkey);
}

/** `from` opens a direct chat with `to`, as the phone's chat button does; answers the conversation's id. */
async function openChat(from: BeanPoolIdentity, to: BeanPoolIdentity): Promise<string> {
    const res = await signedPost(URL_BASE, '/api/messages/conversation', { type: 'dm', participants: [from.publicKey, to.publicKey], createdBy: from.publicKey }, from);
    expect(res.status).toBe(200);
    const body = await res.json();
    return String(body.id ?? body.conversation?.id ?? body.conversationId);
}

/** The ids of the chats in `who`'s own list, read signed by them. */
async function chatsOf(who: BeanPoolIdentity): Promise<string[]> {
    const res = await signedGet(URL_BASE, `/api/messages/conversations/${who.publicKey}`, who);
    expect(res.status).toBe(200);
    return ((await res.json()).conversations as { id: string }[]).map((c) => c.id);
}

describe('a Block made on the phone, against a real community node', () => {
    it('reaches the community: the blocks from before this build go once, a new block withholds their chat, an unblock lifts it there', async () => {
        await control('limiters');
        const [ana, hal, dee, cy] = await Promise.all(['Ana', 'Hal', 'Dee', 'Cy'].map((n) => draftIdentity(n)));
        /** Never a member here: an author from a connected community's board. */
        const sol = randomBytes(32).toString('hex');
        await control('members', { members: [ana, hal, dee, cy].map((m) => ({ key: m.publicKey, callsign: m.callsign })) });

        // Ana's phone, on this community, with the blocks a build before this one kept only on the phone.
        mem.async.set(ANCHOR, URL_BASE);
        mem.secure.set(IDENTITY_KEY, JSON.stringify(ana));
        mem.async.set(`beanpool_blocked_users:${ana.publicKey}`, JSON.stringify([hal.publicKey, sol]));
        const { syncBlocks, blockUser, unblockUser, blockSyncsEndedForTests } = await import('../blocklist');

        // 1. The first sync: both reach the community, Sol on his own; a second sync sends nothing.
        await syncBlocks();
        expect(await blockedAtNode(ana.publicKey)).toEqual([hal.publicKey, sol].sort());
        expect(sent.map((r) => `${r.method} ${r.path} ${r.status}`)).toEqual(['POST /api/blocks 200', 'POST /api/blocks 200']);
        sent.length = 0;
        await syncBlocks();
        expect(sent).toEqual([]);

        // 2. She blocks Dee from his profile: the community has it, and his new chat with her never reaches her list.
        expect(await blockUser(dee.publicKey, ana.publicKey, 'Abusive user reported via Trust Profile')).toBe(true);
        // Block doesn't wait for the community's answer: this waits for it, to read what reached the node.
        await blockSyncsEndedForTests();
        expect(await blockedAtNode(ana.publicKey)).toEqual([hal.publicKey, dee.publicKey, sol].sort());
        expect(sent.map((r) => `${r.method} ${r.path} ${r.status}`).sort()).toEqual(['POST /api/blocks 200', 'POST /api/reports 200']);
        const fromDee = await openChat(dee, ana);
        const fromCy = await openChat(cy, ana);
        const hers = await chatsOf(ana);
        expect(hers).toContain(fromCy);
        expect(hers).not.toContain(fromDee);

        // 3. She unblocks Hal on the phone: the community's list no longer has him.
        sent.length = 0;
        expect(await unblockUser(hal.publicKey)).toBe(true);
        await blockSyncsEndedForTests();
        expect(sent.map((r) => `${r.method} ${r.path} ${r.status}`)).toEqual(['POST /api/blocks/remove 200']);
        expect(await blockedAtNode(ana.publicKey)).toEqual([dee.publicKey, sol].sort());
    }, START_MS);
});

/** A fresh app run: `who` on the phone, set to this community, holding `blocks` from before this build. */
async function phoneWith(who: BeanPoolIdentity, blocks: string[]) {
    mem.async.clear();
    mem.secure.clear();
    mem.async.set(ANCHOR, URL_BASE);
    mem.secure.set(IDENTITY_KEY, JSON.stringify(who));
    mem.async.set(`beanpool_blocked_users:${who.publicKey}`, JSON.stringify(blocks));
    vi.resetModules();
    return { ...(await import('../blocklist')), nodes: await import('../nodes') };
}

const asSent = () => sent.map((r) => `${r.method} ${r.path} ${r.status}`);

describe('a member who is not yet a member there, against a real community node', () => {
    it('the node\'s 403 not_a_member holds nothing back: once she joins, the next sync puts her blocks on its list', async () => {
        await control('limiters');
        const [kim, hal] = await Promise.all(['Kim', 'Hal'].map((n) => draftIdentity(n)));
        await control('members', { members: [{ key: hal.publicKey, callsign: hal.callsign }] });
        // Not marked a guest visit (markGuestNode never fails the visit, and writes nothing when storage fails).
        const phone = await phoneWith(kim, [hal.publicKey]);
        sent.length = 0;
        await phone.syncBlocks();
        expect(asSent()).toEqual(['POST /api/blocks 403']);
        expect(await blockedAtNode(kim.publicKey)).toEqual([]);

        // She joins, as the same account; the next sync (the 5-minute tick, a return to the app), the same day.
        await control('members', { members: [{ key: kim.publicKey, callsign: kim.callsign }] });
        sent.length = 0;
        await phone.syncBlocks();
        expect(asSent()).toEqual(['POST /api/blocks 200']);
        expect(await blockedAtNode(kim.publicKey)).toEqual([hal.publicKey]);
    }, START_MS);

    it('a guest visit ("Guest view first") sends the node nothing of her list; once she joins, the next sync sends it', async () => {
        await control('limiters');
        const [lou, hal] = await Promise.all(['Lou', 'Hal'].map((n) => draftIdentity(n)));
        await control('members', { members: [{ key: hal.publicKey, callsign: hal.callsign }] });
        const phone = await phoneWith(lou, [hal.publicKey]);
        await phone.nodes.markGuestNode(URL_BASE);
        sent.length = 0;
        await phone.syncBlocks();
        expect(sent).toEqual([]);

        // She joins: registering clears the mark (nodes.ts clearGuestNode).
        await control('members', { members: [{ key: lou.publicKey, callsign: lou.callsign }] });
        await phone.nodes.clearGuestNode(URL_BASE);
        await phone.syncBlocks();
        expect(asSent()).toEqual(['POST /api/blocks 200']);
        expect(await blockedAtNode(lou.publicKey)).toEqual([hal.publicKey]);
    }, START_MS);
});

describe('a first sync with many keys the node has no row for, against a real community node', () => {
    it('takes at most 30 of the member\'s 120 requests a minute: none is answered 429, and her own next read is answered', async () => {
        await control('limiters');
        const mo = await draftIdentity('Mo');
        await control('members', { members: [{ key: mo.publicKey, callsign: mo.callsign }] });
        // 150 authors from connected communities' boards: the list goes first, then each on its own.
        const strangers = Array.from({ length: 150 }, () => randomBytes(32).toString('hex'));
        const phone = await phoneWith(mo, strangers);
        sent.length = 0;
        await phone.syncBlocks();
        expect(sent.filter((r) => r.status === 429)).toEqual([]);
        expect(sent).toHaveLength(30);
        expect(await blockedAtNode(mo.publicKey)).toHaveLength(29);
        // chatsOf reads them signed by her, and expects a 200.
        expect(await chatsOf(mo)).toEqual([]);
    }, START_MS);
});

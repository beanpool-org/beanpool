/**
 * Messages across communities, end to end (slice X3): two REAL community nodes on this machine
 * (apps/server/src/phone-door-test-harness.ts, PHONE_DOOR_PROFILE=community), a.example and b.example, each with its own names,
 * its own node key and its real mailbox (X2: routes/relay.ts, engine/relay-mail.ts, relay-outbox.ts), reaching each other
 * through the server suites' hooks (each other's key document and /api/relay/mail on this machine). The phones are their own
 * code: utils/outside-mail.ts and utils/outside-chat-store.ts, on real SQL, signing with the keys on the phones.
 *
 *   1  Ben (b.example) shows his card; Ana (a.example) reads it and writes him: her server takes it and forwards it (sent)
 *   2  Ben's phone fetches: the line waits behind his requests row, written before it is confirmed; his server holds nothing
 *      after; his receipt crosses back
 *   3  Ana's phone reads Delivered
 *   4  Ben accepts and answers; Ana's phone takes it straight into her chat (she wrote first); Ben's reads Delivered
 *   5  Ana restores her account from 12 words onto a new phone: the chat with Ben comes back empty, marked restored
 *   6  Ben closes his door: a stranger's line from a.example is dropped on his phone, and nothing waits at his server
 *
 * Nothing else is contacted: the phones reach only their own node, and the nodes refuse every host but this machine.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

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

import { addressCardFromText, addressCardLink, relayConversationId } from '@beanpool/core';
import { draftIdentity, type BeanPoolIdentity } from '../identity';
import { OUTSIDE_CHAT_TABLES_SQL, outsideChatStore } from '../outside-chat-store';
import { myAddressCard, sendOutsideLine, setDoor, syncOutsideMail, type OutsideMailContext } from '../outside-mail';

const SERVER_DIR = fileURLToPath(new URL('../../../server/', import.meta.url).href);
const START_MS = 120_000;
const realFetch = globalThis.fetch;
const elsewhere: string[] = [];

interface Node {
    proc: ChildProcessWithoutNullStreams;
    dataDir: string;
    url: string;
    port: number;
    replies: Map<number, (r: { result?: any; error?: string }) => void>;
    nextId: number;
}
const nodes: Record<'a' | 'b', Node> = {} as any;

function control<T = any>(n: Node, cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = n.nextId++;
    return new Promise((resolve, reject) => {
        n.replies.set(id, (r) => (r.error ? reject(new Error(r.error)) : resolve(r.result as T)));
        n.proc.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
}

async function start(name: string, home: string): Promise<Node> {
    const dataDir = mkdtempSync(join(tmpdir(), `outside-chat-e2e-${name}-`));
    const proc = spawn(process.execPath, ['--import', 'tsx', 'src/phone-door-test-harness.ts'], {
        cwd: SERVER_DIR,
        env: {
            ...process.env, BEANPOOL_DATA_DIR: dataDir, PHONE_DOOR_PROFILE: 'community', PHONE_DOOR_NODE_KEY: '1',
            // Its name, and localhost, where its members' phones reach it here (as a node behind an SSH tunnel lists it).
            BEANPOOL_ADDRESSES: `${home},localhost`,
            BEANPOOL_SSRF_TEST_HOOK: '1', TSX_TSCONFIG_PATH: 'tsconfig.phone-door-test-harness.json',
        },
        stdio: 'pipe',
    });
    const n: Node = { proc, dataDir, url: '', port: 0, replies: new Map(), nextId: 1 };
    let out = '';
    let log = '';
    n.port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${home} did not start in time:\n${log.slice(-3000)}`)), START_MS - 5_000);
        proc.stdout.on('data', (chunk: Buffer) => {
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
                    n.replies.get(r.id)?.(r);
                    n.replies.delete(r.id);
                }
            }
        });
        proc.stderr.on('data', (chunk: Buffer) => { log += chunk.toString(); });
        proc.on('exit', (code) => reject(new Error(`${home} exited (${code}):\n${log.slice(-3000)}`)));
    });
    n.url = `https://localhost:${n.port}`;
    return n;
}

beforeAll(async () => {
    [nodes.a, nodes.b] = await Promise.all([start('a', 'a.example'), start('b', 'b.example')]);
    await control(nodes.a, 'peer', { home: 'b.example', port: nodes.b.port });
    await control(nodes.b, 'peer', { home: 'a.example', port: nodes.a.port });
    // The phones reach only their own community's node.
    globalThis.fetch = (async (input: any, init?: any) => {
        const href = String(input instanceof Request ? input.url : input);
        if (!href.startsWith(`${nodes.a.url}/`) && !href.startsWith(`${nodes.b.url}/`)) {
            elsewhere.push(href);
            throw new TypeError(`Network request failed: the phone contacted ${href}`);
        }
        return realFetch(input, init);
    }) as typeof fetch;
}, START_MS);

afterAll(async () => {
    globalThis.fetch = realFetch;
    for (const n of Object.values(nodes)) {
        if (n?.proc && n.proc.exitCode === null) {
            n.proc.stdin.write(`${JSON.stringify({ id: 0, cmd: 'quit' })}\n`);
            await new Promise<void>((resolve) => {
                const timer = setTimeout(() => { n.proc.kill('SIGKILL'); resolve(); }, 5_000);
                n.proc.on('exit', () => { clearTimeout(timer); resolve(); });
            });
        }
        if (n?.dataDir) rmSync(n.dataDir, { recursive: true, force: true });
    }
    expect(elsewhere).toEqual([]);
}, START_MS);

/** A phone: its own SQL (the tables as utils/db.ts makes them), its account, its community's node. */
function phone(identity: BeanPoolIdentity, node: Node) {
    const sql = new DatabaseSync(':memory:');
    sql.exec(OUTSIDE_CHAT_TABLES_SQL);
    const db = {
        getAllAsync: async (q: string, p: any[] = []) => sql.prepare(q).all(...p) as any[],
        getFirstAsync: async (q: string, p: any[] = []) => (sql.prepare(q).get(...p) as any) ?? null,
        runAsync: async (q: string, p: any[] = []) => sql.prepare(q).run(...p),
    };
    const ctx: OutsideMailContext = { nodeUrl: node.url, identity, store: outsideChatStore(async () => db as any), isBlocked: async () => false };
    const lines = () => sql.prepare('SELECT author, text, state FROM outside_lines ORDER BY at, id').all() as any[];
    const chat = (peer: string) => sql.prepare('SELECT state, restored, peer_home, peer_name FROM outside_chats WHERE peer_key = ?').get(peer) as any;
    return { ctx, sql, lines, chat };
}

const heldAt = async (n: Node) => (await control<any[]>(n, 'sql', { sql: 'SELECT item_id, kind, recipient FROM relay_mail', all: true }));

describe('a chat between two communities, phone to phone through two real nodes', () => {
    it('card, request, write then confirm, Delivered both ways, a restore that explains the empty chat, a closed door', async () => {
        const [ana, ben, sol] = await Promise.all([draftIdentity('Ana'), draftIdentity('Ben'), draftIdentity('Sol')]);
        await control(nodes.a, 'join', { key: ana.publicKey, callsign: 'Ana' });
        await control(nodes.a, 'join', { key: sol.publicKey, callsign: 'Sol' });
        await control(nodes.b, 'join', { key: ben.publicKey, callsign: 'Ben' });
        const anaPhone = phone(ana, nodes.a);
        const benPhone = phone(ben, nodes.b);

        // 1. Ben shows his card (his door opens); Ana's phone reads it from its link and writes him.
        const card = await myAddressCard(benPhone.ctx);
        expect(card).toMatchObject({ key: ben.publicKey, home: 'b.example', name: 'Ben' });
        await setDoor(benPhone.ctx.store, true);
        const read = addressCardFromText(addressCardLink(card!));
        expect(read).toEqual(card);
        const chatId = relayConversationId(ana.publicKey, ben.publicKey);
        await anaPhone.ctx.store.openChat(ana.publicKey, chatId, { key: read!.key, home: read!.home, name: read!.name });
        expect(await sendOutsideLine(anaPhone.ctx, chatId, 'Hello Ben, are the bikes still there?')).toBe('sent');
        expect(anaPhone.lines()).toEqual([{ author: ana.publicKey, text: 'Hello Ben, are the bikes still there?', state: 'sent' }]);
        expect((await heldAt(nodes.b)).map((r) => [r.kind, r.recipient])).toEqual([['dm-line', ben.publicKey]]);

        // 2. Ben's phone: a request, written, then confirmed (his server holds nothing), and receipted.
        const benRound = await syncOutsideMail(benPhone.ctx);
        expect(benRound).toMatchObject({ requests: 1, written: 0, confirmed: 1 });
        expect(benPhone.chat(ana.publicKey)).toMatchObject({ state: 'request', restored: 0, peer_home: 'a.example', peer_name: 'Ana' });
        expect(benPhone.lines()).toEqual([{ author: ana.publicKey, text: 'Hello Ben, are the bikes still there?', state: null }]);
        expect(await heldAt(nodes.b)).toEqual([]);

        // 3. Ana's phone reads Delivered (Ben's receipt crossed to her server, which set her outbox row).
        await syncOutsideMail(anaPhone.ctx);
        expect(anaPhone.lines()[0].state).toBe('delivered');

        // 4. Ben accepts and answers; it goes straight into Ana's chat; Ben's phone reads Delivered.
        await benPhone.ctx.store.decide(ben.publicKey, chatId, 'open');
        expect(await sendOutsideLine(benPhone.ctx, chatId, 'Yes, two of them.')).toBe('sent');
        expect(await syncOutsideMail(anaPhone.ctx)).toMatchObject({ written: 1, requests: 0 });
        expect(anaPhone.lines().map((l) => l.text)).toEqual(['Hello Ben, are the bikes still there?', 'Yes, two of them.']);
        await syncOutsideMail(benPhone.ctx);
        expect(benPhone.lines().map((l) => [l.text, l.state])).toEqual([['Hello Ben, are the bikes still there?', null], ['Yes, two of them.', 'delivered']]);

        // 5. Ana's new phone, restored from her 12 words: no line of the chat is anywhere to bring back, and it says so.
        const restored = phone(ana, nodes.a);
        await syncOutsideMail(restored.ctx);
        expect(restored.chat(ben.publicKey)).toMatchObject({ state: 'open', restored: 1, peer_home: 'b.example' });
        expect(restored.lines()).toEqual([]);

        // 6. Ben closes his door: Sol, a stranger from a.example, is dropped at Ben's phone, and nothing waits at his server.
        await setDoor(benPhone.ctx.store, false);
        const solPhone = phone(sol, nodes.a);
        const solChat = relayConversationId(sol.publicKey, ben.publicKey);
        await solPhone.ctx.store.openChat(sol.publicKey, solChat, { key: ben.publicKey, home: 'b.example', name: 'Ben' });
        expect(await sendOutsideLine(solPhone.ctx, solChat, 'Hi, you don\'t know me')).toBe('sent');
        expect(await syncOutsideMail(benPhone.ctx)).toMatchObject({ requests: 0, written: 0, dropped: 1, confirmed: 1 });
        expect(benPhone.chat(sol.publicKey)).toBeUndefined();
        expect(await heldAt(nodes.b)).toEqual([]);
    }, START_MS);
});

/**
 * Messages across communities on the web, end to end (slice X4): two REAL community nodes on this machine
 * (apps/server/src/phone-door-test-harness.ts, PHONE_DOOR_PROFILE=community, as the phone's X3 test runs them), a.example and
 * b.example, each with its own names, its own node key and its real mailbox (X2), reaching each other through the server
 * suites' hooks. The browsers are this app's own code: lib/outside-mail.ts and lib/outside-chat-store.ts on the in-memory
 * IndexedDB, signing through lib/api.ts with the keys in the browser.
 *
 *   1  Ben (b.example) shows his card; Ana (a.example) reads it and writes him: her server takes it and forwards it (sent)
 *   2  Ben's browser fetches: the line waits behind his requests row, written before it is confirmed; his server holds nothing
 *   3  Ana's browser reads Delivered (Ben's receipt crossed back)
 *   4  Ben accepts and answers; Ana's browser takes it straight into her chat; Ben's reads Delivered
 *   5  Ben closes his door: a stranger's line from a.example is dropped in his browser, and nothing waits at his server
 *   6  Ana signs in on a new browser: the chat with Ben comes back empty, marked restored
 *
 * Nothing else is contacted: the browsers reach only their own node, and the nodes refuse every host but this machine.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { addressCardFromText, addressCardLink, relayConversationId } from '@beanpool/core';
import { memoryIndexedDB } from './memory-indexeddb';
import { hearNodeVersionForTests } from './node-version-gate';
import { clearOutsideChats, outsideChatStore } from './outside-chat-store';
import { myAddressCard, sendOutsideLine, setDoor, syncOutsideMail, type OutsideMailContext } from './outside-mail';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const SERVER_DIR = join(import.meta.dirname, '../../../server');
const START_MS = 120_000;
const realFetch = globalThis.fetch;
const elsewhere: string[] = [];

interface Node { proc: ChildProcessWithoutNullStreams; dataDir: string; url: string; port: number; replies: Map<number, (r: { result?: any; error?: string }) => void>; nextId: number }
const nodes: Record<'a' | 'b', Node> = {} as any;

function control<T = any>(n: Node, cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = n.nextId++;
    return new Promise((resolve, reject) => {
        n.replies.set(id, (r) => (r.error ? reject(new Error(r.error)) : resolve(r.result as T)));
        n.proc.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
}

async function start(name: string, home: string): Promise<Node> {
    const dataDir = mkdtempSync(join(tmpdir(), `outside-web-e2e-${name}-`));
    const proc = spawn(process.execPath, ['--import', 'tsx', 'src/phone-door-test-harness.ts'], {
        cwd: SERVER_DIR,
        env: {
            ...process.env, BEANPOOL_DATA_DIR: dataDir, PHONE_DOOR_PROFILE: 'community', PHONE_DOOR_NODE_KEY: '1',
            BEANPOOL_ADDRESSES: `${home},localhost`, BEANPOOL_SSRF_TEST_HOOK: '1', TSX_TSCONFIG_PATH: 'tsconfig.phone-door-test-harness.json',
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
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    await clearOutsideChats();
    [nodes.a, nodes.b] = await Promise.all([start('a', 'a.example'), start('b', 'b.example')]);
    await control(nodes.a, 'peer', { home: 'b.example', port: nodes.b.port });
    await control(nodes.b, 'peer', { home: 'a.example', port: nodes.a.port });
    for (const n of Object.values(nodes)) hearNodeVersionForTests(n.url);
    // The browsers reach only their own community's node.
    globalThis.fetch = (async (input: any, init?: any) => {
        const href = String(input instanceof Request ? input.url : input);
        if (!href.startsWith(`${nodes.a.url}/`) && !href.startsWith(`${nodes.b.url}/`)) {
            elsewhere.push(href);
            throw new TypeError(`Failed to fetch: the browser contacted ${href}`);
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
    vi.unstubAllGlobals();
    expect(elsewhere).toEqual([]);
}, START_MS);

const member = (callsign: string) => { const seed = ed25519.utils.randomSecretKey(); return { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed), callsign }; };

/** A browser on `node`: this app's store (documents per account) and its account. */
function browser(identity: ReturnType<typeof member>, node: Node) {
    const ctx: OutsideMailContext = { nodeUrl: node.url, identity, store: outsideChatStore(), isBlocked: async () => false };
    const lines = async (peer: string) => (await ctx.store.lines(identity.publicKey, relayConversationId(identity.publicKey, peer)))
        .map((l) => ({ author: l.author, text: l.text, state: l.state }));
    const chat = (peer: string) => ctx.store.chat(identity.publicKey, relayConversationId(identity.publicKey, peer));
    return { ctx, lines, chat };
}

const heldAt = (n: Node) => control<any[]>(n, 'sql', { sql: 'SELECT item_id, kind, recipient FROM relay_mail', all: true });

describe('a chat between two communities, browser to browser through two real nodes', () => {
    it('card, request, write then confirm, Delivered both ways, a closed door, a new browser that explains the empty chat', async () => {
        const [ana, ben, sol] = [member('Ana'), member('Ben'), member('Sol')];
        await control(nodes.a, 'join', { key: ana.publicKey, callsign: 'Ana' });
        await control(nodes.a, 'join', { key: sol.publicKey, callsign: 'Sol' });
        await control(nodes.b, 'join', { key: ben.publicKey, callsign: 'Ben' });
        const anaWeb = browser(ana, nodes.a);
        const benWeb = browser(ben, nodes.b);

        // 1. Ben shows his card (his door opens); Ana reads it from its link and writes him.
        const card = await myAddressCard(benWeb.ctx);
        expect(card).toMatchObject({ key: ben.publicKey, home: 'b.example', name: 'Ben' });
        await setDoor(benWeb.ctx, true);
        const read = addressCardFromText(addressCardLink(card!));
        expect(read).toEqual(card);
        const chatId = relayConversationId(ana.publicKey, ben.publicKey);
        await anaWeb.ctx.store.openChat(ana.publicKey, chatId, { key: read!.key, home: read!.home, name: read!.name });
        expect(await sendOutsideLine(anaWeb.ctx, chatId, 'Hello Ben, is the ladder still free?')).toBe('sent');
        expect(await anaWeb.lines(ben.publicKey)).toEqual([{ author: ana.publicKey, text: 'Hello Ben, is the ladder still free?', state: 'sent' }]);
        expect((await heldAt(nodes.b)).map((r) => [r.kind, r.recipient])).toEqual([['dm-line', ben.publicKey]]);

        // 2. Ben's browser: a request, written, then confirmed (his server holds nothing), and receipted.
        expect(await syncOutsideMail(benWeb.ctx)).toMatchObject({ requests: 1, written: 0, confirmed: 1 });
        expect(await benWeb.chat(ana.publicKey)).toMatchObject({ state: 'request', restored: false, peerHome: 'a.example', peerName: 'Ana' });
        expect(await benWeb.lines(ana.publicKey)).toEqual([{ author: ana.publicKey, text: 'Hello Ben, is the ladder still free?', state: null }]);
        expect(await heldAt(nodes.b)).toEqual([]);
        expect(await benWeb.ctx.store.owedReceipts(ben.publicKey, 10)).toEqual([]);

        // 3. Ana's browser reads Delivered.
        await syncOutsideMail(anaWeb.ctx);
        expect((await anaWeb.lines(ben.publicKey))[0].state).toBe('delivered');

        // 4. Ben accepts and answers; it goes straight into Ana's chat; Ben's browser reads Delivered.
        await benWeb.ctx.store.decide(ben.publicKey, chatId, 'open');
        expect(await sendOutsideLine(benWeb.ctx, chatId, 'Yes, come by on Saturday.')).toBe('sent');
        expect(await syncOutsideMail(anaWeb.ctx)).toMatchObject({ written: 1, requests: 0 });
        expect((await anaWeb.lines(ben.publicKey)).map((l) => l.text)).toEqual(['Hello Ben, is the ladder still free?', 'Yes, come by on Saturday.']);
        await syncOutsideMail(benWeb.ctx);
        expect((await benWeb.lines(ana.publicKey)).map((l) => [l.text, l.state])).toEqual([['Hello Ben, is the ladder still free?', null], ['Yes, come by on Saturday.', 'delivered']]);

        // 5. Ben closes his door: Sol, a stranger from a.example, is dropped in Ben's browser, and nothing waits at his server.
        await setDoor(benWeb.ctx, false);
        const solWeb = browser(sol, nodes.a);
        const solChat = relayConversationId(sol.publicKey, ben.publicKey);
        await solWeb.ctx.store.openChat(sol.publicKey, solChat, { key: ben.publicKey, home: 'b.example', name: 'Ben' });
        expect(await sendOutsideLine(solWeb.ctx, solChat, 'Hi, you don\'t know me')).toBe('sent');
        expect(await syncOutsideMail(benWeb.ctx)).toMatchObject({ requests: 0, written: 0, dropped: 1, confirmed: 1 });
        expect(await benWeb.chat(sol.publicKey)).toBeNull();
        expect(await heldAt(nodes.b)).toEqual([]);

        // 6. Ana signs in on a new browser (nothing of this one's store): the chat with Ben comes back empty, and says why.
        vi.stubGlobal('indexedDB', memoryIndexedDB());
        await clearOutsideChats();
        const anaNew = browser(ana, nodes.a);
        await syncOutsideMail(anaNew.ctx);
        expect(await anaNew.chat(ben.publicKey)).toMatchObject({ state: 'open', restored: true, peerHome: 'b.example' });
        expect(await anaNew.lines(ben.publicKey)).toEqual([]);
    }, START_MS);
});

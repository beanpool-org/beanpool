/**
 * The phone's own repayment code against a REAL node on this machine (#1611 confirmation 4): the member working a debt
 * off pays it from the Ledger's banner, and it comes off the debt. apps/server/src/phone-door-test-harness.ts, the real
 * HTTPS server and signature middleware, started from the packages' sources and killed by its PID; the work-off is
 * fixture rows (its `workingOff` command), as test-names-debts-http's are.
 *
 *   Working off 200 and holding 510: the phone reads its repayment (GET /api/commons/repayment), whose debtId is the
 *   code Pay the Commons fills in; pays 200 with it (POST /api/commons/pay, as the screen confirms it). It comes off the
 *   debt at once and settles it; the next 10 received is the member's own, never swept: 200 paid once (510 → 320).
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
    // A payment's own id (utils/payment-request.ts).
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

import { draftIdentity } from '../identity';
import { fetchMyRepayment, confirmCommonsPayment, payTheCommons, REPAYMENT_COPY } from '../names-debts';

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

beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'debts-repayment-e2e-'));
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

describe('working a debt off, paying it from the banner (the phone against a real node)', () => {
    it('the repayment carries the code Pay the Commons fills in; 200 paid with it comes off the debt, and the next receipt is never swept', async () => {
        await control('limiters');
        const me = await draftIdentity('Pe');
        const debtId = await control<string>('workingOff', { key: me.publicKey, beans: 510, owed: 200 });
        const why = await fetchMyRepayment(URL_BASE, me);
        expect(why).toEqual({ ok: true, value: { debtId, amount: 200, repaid: 0, left: 200 } });
        // What the screen sends once the member confirms 200 with the code it filled in.
        const code = why.ok ? why.value?.debtId : undefined;
        const paid = await payTheCommons(URL_BASE, me, confirmCommonsPayment(200, code));
        expect(paid.ok && paid.value).toMatchObject({ amount: 200, left: 200, leftAfter: 0, settled: true });
        expect(REPAYMENT_COPY.paid(200, paid.ok ? paid.value.transactionId : '', !!code, paid.ok ? paid.value : {})).toBe('Paid 200 Beans to the Commons. Your debt is paid off and settled.');
        await control('receive', { key: me.publicKey, beans: 10 });
        expect(await control('debt', { key: me.publicKey, debtId })).toEqual({
            balance: 320, record: { amount: 200, repaid: 200, status: 'settled', settled_how: 'pay_back' }, links: 1,
        });
        expect(await fetchMyRepayment(URL_BASE, me)).toEqual({ ok: true, value: null });
        expect(sent.map((r) => `${r.method} ${r.path} ${r.status}`)).toEqual([
            'GET /api/commons/repayment 200', 'POST /api/commons/pay 200', 'GET /api/commons/repayment 200',
        ]);
    }, START_MS);
});

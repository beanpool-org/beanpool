/**
 * The claim makes the account, end to end (DESIGN-account-without-global-fable.md §5, S1 row): a phone with no BeanPool
 * account claims a brand-new self-hosted community at its own address and becomes its owner, with nothing of ours in the
 * path. apps/server/src/phone-door-test-harness.ts with PHONE_DOOR_PROFILE=community and PHONE_DOOR_CLAIM_CODE=1: a
 * community's own node (the real HTTPS server, signature middleware and claim route), its data folder new (as `data/`
 * wiped), its one-time claim code made at boot as index.ts makes it, reached at `https://localhost:<port>`, never at
 * global.beanpool.org, started from the packages' sources and killed by its PID, as open-door-e2e.test.ts does.
 *
 *   1. The phone holds nothing. It reads the claim (GET /api/local/claim); its operator reads the code from claim-code.txt.
 *      The claim's key rule (utils/claim-key.ts) makes a key in memory, signs the claim with it, and writes it to the
 *      phone with the wizard's record before the POST. The answer is lost on its way back (the node took the claim): the
 *      phone asks the node, signed by the new key (GET /api/node-admin/me), and is told it is the owner. Then the
 *      wizard's record moves on and the anchor is the community. On the node: that key is a member, node_roles says owner,
 *      the code is burned (claim-code.txt gone, K and the salt gone).
 *   2. The same claim again, with the same key: answered as the claim was (`again`), and nothing new on the node.
 *   3. A second phone with no account claims too: 409, the owner check says it is no member there (403 `not_a_member`),
 *      and the key it made comes off it with its record. The node still has one owner.
 *   4. The first phone back at its claim with the answer lost (a restart before the finish), and its owner check delivered
 *      twice by the network: the phone reads the second answer, the node's refusal of a nonce already spent (403), which
 *      says nothing of who owns it. The owner's key and its record stay; asked again, the node says owner (#2433 review).
 * Nothing else is contacted: the phone's fetch is held to this node's address, the global community and the key vault
 * included.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

(globalThis as any).__DEV__ = false;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) }));
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

import { loadIdentity } from '../identity';
import { ownerCheckViaRole, readClaimStatus } from '../node-claim';
import { checkOwnClaim, claimKeyForThisPhone, claimWithKey, finishClaim } from '../claim-key';
import { getPendingOnboarding } from '../onboarding-state';
import { GLOBAL_NODE_URL } from '../global-node-url';

const SERVER_DIR = fileURLToPath(new URL('../../../server/', import.meta.url).href);
const START_MS = 120_000;
const STEP_MS = 120_000;
const ANCHOR = 'beanpool_anchor_url';

let node: ChildProcessWithoutNullStreams;
let dataDir: string;
let URL_BASE = '';
const replies = new Map<number, (r: { result?: any; error?: string }) => void>();
let nextId = 1;
const realFetch = globalThis.fetch;
const sent: { method: string; path: string; status: number }[] = [];
const elsewhere: string[] = [];
/** The node takes the next claim, and its answer never reaches the phone (a dropped connection on the way back). */
let loseNextClaimAnswer = false;
/** The next owner check reaches the node twice, the same signed request, and the phone reads the second answer. */
let resendNextOwnerCheck = false;
/** What the node answered each owner check (GET /api/node-admin/me) the phone read. */
const ownerCheckAnswers: unknown[] = [];

function control<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        replies.set(id, (r) => (r.error ? reject(new Error(r.error)) : resolve(r.result as T)));
        node.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
}
const sql = <T = any>(q: string, params: unknown[] = []) => control<T[]>('sql', { sql: q, params, all: true });

beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'claim-account-e2e-'));
    node = spawn(process.execPath, ['--import', 'tsx', 'src/phone-door-test-harness.ts'], {
        cwd: SERVER_DIR,
        env: {
            ...process.env, BEANPOOL_DATA_DIR: dataDir, TSX_TSCONFIG_PATH: 'tsconfig.phone-door-test-harness.json',
            PHONE_DOOR_PROFILE: 'community', PHONE_DOOR_CLAIM_CODE: '1',
        },
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
    // The community's own address, as a self-hoster's would be: not ours.
    URL_BASE = `https://localhost:${port}`;

    // The phone reaches this node and nothing else: not global.beanpool.org, not the key vault, not anything.
    globalThis.fetch = (async (input: any, init?: any) => {
        const href = String(input instanceof Request ? input.url : input);
        if (!href.startsWith(`${URL_BASE}/`)) {
            elsewhere.push(href);
            throw new TypeError(`Network request failed: the phone contacted ${href}`);
        }
        const { signal: _signal, ...rest } = init ?? {};
        let res = await realFetch(input, rest);
        const path = new URL(href).pathname;
        sent.push({ method: String(init?.method ?? 'GET'), path, status: res.status });
        if (loseNextClaimAnswer && path === '/api/local/claim' && init?.method === 'POST') {
            loseNextClaimAnswer = false;
            await res.text();
            throw new TypeError('Network request failed');
        }
        if (path === '/api/node-admin/me') {
            if (resendNextOwnerCheck) {
                // A network that sends a GET again after a reset connection: the same headers, so the same nonce.
                resendNextOwnerCheck = false;
                await res.text();
                res = await realFetch(input, rest);
                sent.push({ method: 'GET', path, status: res.status });
            }
            ownerCheckAnswers.push(await res.clone().json().catch(() => null));
        }
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

/** A phone with nothing on it: no key, no record, no community. */
function newPhone() {
    mem.async.clear();
    mem.secure.clear();
}

let owner = '';
let codeId = '';
/** What the first phone read and typed: the code, and the salt its status gave. */
let code = '';
let salt = '';
/** The first phone as the claim left it before the finish: the owner's key, and the claim's record still out. */
let claimOutPhone: { async: Map<string, string>; secure: Map<string, string> } | null = null;

describe('a self-hosted community\'s first owner, on a phone with no account, needs nothing of ours', () => {
    it('1. the claim makes the account: the key on the phone before the POST, the answer lost, the node asked, owner; the code burned', async () => {
        newPhone();
        await control('limiters');
        expect(await loadIdentity()).toBeNull();
        expect(existsSync(join(dataDir, 'claim-code.txt'))).toBe(true);

        const status = await readClaimStatus(URL_BASE);
        expect(status.kind).toBe('unclaimed');
        if (status.kind !== 'unclaimed') throw new Error('expected an unclaimed node');
        codeId = status.codeId;
        salt = status.salt;
        // The operator reads the code on the server (beanpool claim shows it; the QR carries it).
        code = readFileSync(join(dataDir, 'claim-code.txt'), 'utf8').trim();

        const key = await claimKeyForThisPhone(URL_BASE);
        expect(key.createdHere).toBe(true);
        expect(await loadIdentity()).toBeNull();

        loseNextClaimAnswer = true;
        const before = sent.length;
        const out = await claimWithKey({
            origin: URL_BASE, key, code, codeId, salt: status.salt, callsign: 'Olive', isOwner: ownerCheckViaRole,
        });
        expect(out).toMatchObject({ outcome: { kind: 'owner' }, madeHere: true, released: false });
        // The POST (whose answer was lost), then the node asked: its claim status, and the owner check signed by the new key.
        expect(sent.slice(before).map(s => `${s.method} ${s.path} ${s.status}`)).toEqual([
            'POST /api/local/claim 200', 'GET /api/local/claim 200', 'GET /api/node-admin/me 200',
        ]);
        owner = key.identity.publicKey;

        // The phone: the key it made, under the name typed, with its 12 words; the record still the claim's until the finish.
        const stored = await loadIdentity();
        expect(stored).toMatchObject({ publicKey: owner, callsign: 'Olive' });
        expect(stored?.mnemonic).toHaveLength(12);
        expect(await getPendingOnboarding()).toMatchObject({ step: 'claim', flow: 'claim', anchorUrl: URL_BASE, freshKey: owner, joinsOut: 1, claimCodeId: codeId });
        claimOutPhone = { async: new Map(mem.async), secure: new Map(mem.secure) };

        const kept = await finishClaim(URL_BASE, out.identity, status.communityName, null);
        expect(kept.publicKey).toBe(owner);
        expect(mem.async.get(ANCHOR)).toBe(URL_BASE);
        expect(await getPendingOnboarding()).toMatchObject({ step: 'profileSetup', flow: 'claim', anchorUrl: URL_BASE, redeemed: true, newKey: owner, joinDoor: 'words' });

        // The node: a member under that key, made by the claim, and its owner.
        expect(await sql('SELECT callsign, invite_code, invited_by FROM members WHERE public_key = ?', [owner])).toEqual([
            { callsign: 'Olive', invite_code: `claim:${codeId}`, invited_by: null },
        ]);
        expect(await sql('SELECT role, granted_by FROM node_roles WHERE member_pubkey = ?', [owner])).toEqual([{ role: 'owner', granted_by: `claim:${codeId}` }]);
        // The code burned: the file gone, K and the salt gone, who claimed it kept.
        expect(existsSync(join(dataDir, 'claim-code.txt'))).toBe(false);
        const local = JSON.parse(readFileSync(join(dataDir, 'local-config.json'), 'utf8'));
        expect(local.claim).toMatchObject({ id: codeId, claimedBy: owner });
        expect(local.claim.key).toBeUndefined();
        expect(local.claim.salt).toBeUndefined();
        expect(await readClaimStatus(URL_BASE)).toEqual({ kind: 'claimed' });
        // And the owner check the claim screen and Check again use answers the new owner from this host.
        expect(await ownerCheckViaRole(URL_BASE, kept)).toBe('owner');
    }, STEP_MS);

    it('2. the same claim again, by the same key: answered as the claim was, and nothing new on the node', async () => {
        await control('limiters');
        const stored = (await loadIdentity())!;
        const record = await getPendingOnboarding();
        const members = await sql('SELECT COUNT(*) AS n FROM members');
        // A retry after the lost answer, signed by the same key for the burned code's id (DESIGN §3.5: idempotent once it
        // lands). As the phone's own account now: the wizard's record is not the claim's any more.
        const before = sent.length;
        const out = await claimWithKey({
            origin: URL_BASE, key: { identity: stored, createdHere: false }, code, codeId, salt, callsign: '', isOwner: ownerCheckViaRole,
        });
        expect(out.outcome).toEqual({ kind: 'owner', callsign: 'Olive' });
        expect(sent.slice(before).map(s => `${s.method} ${s.path} ${s.status}`)).toEqual(['POST /api/local/claim 200']);
        expect(await sql('SELECT COUNT(*) AS n FROM node_roles WHERE role = ?', ['owner'])).toEqual([{ n: 1 }]);
        expect(await sql('SELECT COUNT(*) AS n FROM members')).toEqual(members);
        expect((await loadIdentity())?.publicKey).toBe(owner);
        expect(await getPendingOnboarding()).toEqual(record);
    }, STEP_MS);

    it('3. a second phone with no account claims too: refused, asked who owns it, and the key it made comes off it', async () => {
        const firstPhone = { async: new Map(mem.async), secure: new Map(mem.secure) };
        newPhone();
        await control('limiters');
        const key = await claimKeyForThisPhone(URL_BASE);
        expect(key.createdHere).toBe(true);
        const before = sent.length;
        // The screen claims only while the node says unclaimed; a phone whose status was read just before the first claim
        // landed (the race, DESIGN §3.3) sends its claim with that status's code id and salt.
        const local = JSON.parse(readFileSync(join(dataDir, 'local-config.json'), 'utf8'));
        const out = await claimWithKey({
            origin: URL_BASE, key, code: 'claim-0000-0000-0000-0000', codeId: local.claim.id, salt: '00'.repeat(32),
            callsign: 'Pip', isOwner: ownerCheckViaRole,
        });
        expect(out).toMatchObject({ outcome: { kind: 'already-claimed' }, madeHere: true, released: true });
        expect(sent.slice(before).map(s => `${s.method} ${s.path} ${s.status}`)).toEqual(['POST /api/local/claim 409', 'GET /api/node-admin/me 403']);
        // The node's own refusal of a key that is no member there, the one 403 the owner check reads as another owner's.
        expect(ownerCheckAnswers.at(-1)).toMatchObject({ code: 'not_a_member' });
        // This phone is as it was before the scan.
        expect(await loadIdentity()).toBeNull();
        expect(await getPendingOnboarding()).toBeNull();
        expect(mem.async.get(ANCHOR)).toBeUndefined();
        // The node: one owner, the first phone's; the second key is no member.
        expect(await sql('SELECT member_pubkey FROM node_roles WHERE role = ?', ['owner'])).toEqual([{ member_pubkey: owner }]);
        expect(await sql('SELECT COUNT(*) AS n FROM members WHERE public_key = ?', [key.identity.publicKey])).toEqual([{ n: 0 }]);
        mem.async = firstPhone.async;
        mem.secure = firstPhone.secure;
    }, STEP_MS);

    it('4. the owner\'s check delivered twice: the second answer is a spent nonce\'s, no answer, and the owner\'s key stays', async () => {
        const firstPhone = { async: new Map(mem.async), secure: new Map(mem.secure) };
        // The first phone as the claim left it, its answer lost: the app restarted before the finish.
        expect(claimOutPhone).not.toBeNull();
        mem.async = new Map(claimOutPhone!.async);
        mem.secure = new Map(claimOutPhone!.secure);
        await control('limiters');
        const key = { identity: (await loadIdentity())!, createdHere: true };
        expect(key.identity.publicKey).toBe(owner);
        const record = await getPendingOnboarding();
        expect(record).toMatchObject({ step: 'claim', flow: 'claim', freshKey: owner, joinsOut: 1 });

        resendNextOwnerCheck = true;
        const before = sent.length;
        expect(await checkOwnClaim(URL_BASE, key, ownerCheckViaRole)).toEqual({ outcome: { kind: 'check-again' }, released: false });
        expect(sent.slice(before).map(s => `${s.method} ${s.path} ${s.status}`)).toEqual([
            'GET /api/local/claim 200', 'GET /api/node-admin/me 200', 'GET /api/node-admin/me 403',
        ]);
        // The phone read the node's refusal of the spent nonce: not its refusal of a non-member.
        expect(ownerCheckAnswers.at(-1)).toMatchObject({ error: 'Replay detected: nonce already used' });
        expect(ownerCheckAnswers.at(-1)).not.toHaveProperty('code');
        // The owner's key is still on the phone, with the claim's record: nothing came off.
        expect((await loadIdentity())?.publicKey).toBe(owner);
        expect(await getPendingOnboarding()).toEqual(record);

        // Asked again (Check again): the node says owner.
        expect(await checkOwnClaim(URL_BASE, key, ownerCheckViaRole)).toEqual({ outcome: { kind: 'owner', callsign: null }, released: false });
        expect((await loadIdentity())?.publicKey).toBe(owner);
        mem.async = firstPhone.async;
        mem.secure = firstPhone.secure;
    }, STEP_MS);

    it('nothing else was contacted: never the global community, never the key vault', () => {
        expect(elsewhere).toEqual([]);
        expect(sent.every(s => !s.path.startsWith('/api/join') && !s.path.startsWith('/api/vault'))).toBe(true);
        expect(URL_BASE.startsWith(GLOBAL_NODE_URL)).toBe(false);
    });
});

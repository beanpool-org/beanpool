/**
 * Test Suite: no mothership. A local community does everything its members do with every address of ours unreachable
 * (scratch/global-node/DESIGN-global-mothership-fable.md §2.1–§2.4, slice A4).
 *
 * WHY THIS EXISTS. "No route on a local community calls global; no feature of a local community is switched by global"
 * (§2.1) was a guardrail in every brief, checked by reading. This suite is what a reviewer runs instead: a call to one of
 * our domains from a local node's member path fails it, at every CI run.
 *
 * THE NODES are the REAL entry point (index.ts), each its own process with its own data dir, booted as a self-hoster's
 * container boots one: the local profile, no PUBLIC_ADDRESS_*, no CF_*, no DISABLE_UPDATE_CHECK, no URL of ours pointed
 * anywhere else, every background service index.ts starts. Each process runs outside-calls-test-harness.ts before a module
 * of the node loads: our domains (and every other name) do not resolve, no fetch and no socket leaves this machine, and
 * every try is written down with the line that made it. A node that exits is started again on the same data dir and ports,
 * as Docker's restart policy does (a restore, a standby's swap of a whole copy, a take-over each end in an exit 0).
 *   A   a local community: Olive claims it; Ann and Bo join. Backed up, off the box and restored.
 *   B   a second local community: Cy claims it, and knocks on A.
 *   S   B's standby (NODE_ROLE=backup), paired as `beanpool pair` pairs; it copies B and takes over by code.
 * THE PHONES are this process, signing as the apps sign (format 2, @beanpool/core buildBoundRequestHeaders), each key
 * made from its 12 words as the app makes it. This process runs the trap too.
 *
 * THE WALK (§2.4), each step a check of its own, and after each the calls any process tried during it:
 *   1. genesis and claim: each owner claims their node with its claim code and names the community
 *   2. an invite join (Ann, Bo), each phone registering its push token as the app does
 *   3. a listing, a deal to completion, a rating each way
 *   4. a DM and a group line
 *   5. a knock from node B's member to node A, its answer, and the join it lets in
 *   6. a 12-words restore: Ann's new phone, from her words alone, is back in with her chats and Beans
 *   7. a sealed backup, an off-box upload to a loopback S3 stub, a restore from that copy
 *   8. a standby copy and a take-over by code (B's main server dead, S becomes it). A standby holds no owner of its own,
 *      so Cy first makes himself S's owner from its shell (`beanpool recover --key`), as the other take-over suites mint
 *      one inside the standby's process
 *   9. an update check that gets no answer
 *  10. A's own timers: index.ts's first timed calls run 30 s after a start, after the walk, so it waits for them
 * Then the count: no call to any of our domains, and no call to a host outside ALLOWED. Each allowed host is one §2.2
 * lists, and the suite shows the step that asked it still passed.
 *
 * Fail-first (the PR says the numbers): a `fetch('https://global.beanpool.org')` planted in a scratch copy of a member
 * path fails the count, naming its file and line and the step that made it; awaited, it fails that step too.
 *
 * Run (from apps/server): mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-no-mothership" node ../../scripts/run-server-suites.mjs
 * (in a checkout whose path is too long for tsx's IPC pipe under .th: BEANPOOL_DATA_DIR=<a new folder> node --import tsx
 * src/test-no-mothership.ts).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    installOutsideCallTrap, readOutsideCalls, checkOutsideCalls, describeOutsideCalls, WATCHED_DOMAINS,
    type AllowedHost, type OutsideCall,
} from './outside-calls-test-harness.js';

const SCRIPT = fileURLToPath(import.meta.url);
/** The real entry point beside this file, run as this suite runs (src/index.ts under the loader, or dist/index.js). */
const ENTRY = SCRIPT.replace(/test-no-mothership\.(m?[tj]s)$/, 'index.$1');
/** The `beanpool` command in the node's container (bin/beanpool), beside it. */
const BEANPOOL_CLI = SCRIPT.replace(/test-no-mothership\.(m?[tj]s)$/, 'recover-cli.$1');
const READY_LINE = 'BeanPool Node is live';

// ── A node's process, or its `beanpool` command's: the trap first, then the real code ─────────

if (process.argv.includes('--child')) {
    installOutsideCallTrap({ file: process.env.OUTSIDE_CALLS_FILE });
    void import(ENTRY);
} else if (process.argv[2] === '--beanpool') {
    installOutsideCallTrap({ file: process.env.OUTSIDE_CALLS_FILE });
    // The command reads its arguments as it loads.
    process.argv = [process.argv[0], BEANPOOL_CLI, ...process.argv.slice(3)];
    void import(BEANPOOL_CLI);
} else {
    void main();
}

/**
 * The hosts a local node of ours may ask for, each one §2.2 lists, and what happens when it gets no answer (each step
 * that asks one still passes). Any other host fails the count; any of our domains (beanpool.org, global) always does.
 */
const ALLOWED: AllowedHost[] = [
    { host: 'supabase.co', why: 'the directory publisher (services/directory-publisher.ts): a local community is listed by default, pushed when it is named; the push fails and is tried again later' },
    { host: 'api.github.com', why: 'the update check (node-release-check.ts): no update notice, and Settings says it could not check' },
    { host: 'itunes.apple.com', why: 'the app-store version lookup (app-store-versions.ts), 30 s after boot: no update banner for the apps' },
    { host: 'play.google.com', why: 'the app-store version lookup (app-store-versions.ts), 30 s after boot: no update banner for the apps' },
    { host: 'exp.host', why: "Expo's push service (state-engine.ts): a member with a push token gets no notification; the app polls" },
];

// ── Checks ─────────────────────────────────────────────────────────────────────────────────

let run = 0;
let passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}
function need(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`cannot go on: ${msg}`);
}

/** Until `cond` holds, read every 50 ms; false after `ms`. */
async function until(what: string, cond: () => Promise<boolean> | boolean, ms = 20_000): Promise<boolean> {
    const end = Date.now() + ms;
    for (;;) {
        if (await cond()) return true;
        if (Date.now() >= end) break;
        await new Promise((r) => setTimeout(r, 50));
    }
    console.error(`  (waited ${ms} ms for ${what})`);
    return false;
}

// ── Nodes ──────────────────────────────────────────────────────────────────────────────────

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const port = (s.address() as net.AddressInfo).port;
            s.close(() => resolve(port));
        });
    });
}
function canListen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.once('error', () => resolve(false));
        s.listen(port, '0.0.0.0', () => s.close(() => resolve(true)));
    });
}
/** Every port handed to a node: the nodes start side by side, and a port free a moment ago is free for each of them. */
const handedOut = new Set<number>();
async function unusedPort(): Promise<number> {
    for (;;) {
        const p = await freePort();
        if (!handedOut.has(p)) return p;
    }
}
/** index.ts listens on PORT_HTTP, PORT_HTTPS, PORT_P2P and PORT_P2P + 1: four free ports, none fixed (test-clean-stop's). */
let picking: Promise<unknown> = Promise.resolve();
function freePorts(): Promise<{ http: number; https: number; p2p: number }> {
    // One node's four at a time, so two nodes starting together never pick the same one.
    const next = picking.then(pickPorts);
    picking = next.catch(() => {});
    return next;
}
async function pickPorts(): Promise<{ http: number; https: number; p2p: number }> {
    const http = await unusedPort();
    let https = await unusedPort();
    while (https === http) https = await unusedPort();
    // macOS hands out a listener's port 0 in order through 49152-65535, so near the top every try is above any bound short
    // of the last port: only p2p + 1 must exist.
    for (let tries = 0; tries < 200; tries++) {
        const p2p = await unusedPort();
        if (p2p < 65_535 && ![http, https].includes(p2p) && ![http, https].includes(p2p + 1) && !handedOut.has(p2p + 1) && await canListen(p2p + 1)) {
            for (const p of [http, https, p2p, p2p + 1]) handedOut.add(p);
            return { http, https, p2p };
        }
    }
    throw new Error('no free pair of ports for libp2p');
}

/**
 * Everything a self-hoster's .env would not have, or that would point one of our hosts somewhere else: removed, so the
 * node's defaults are the ones in play. The runner's suite flags go too (DISABLE_UPDATE_CHECK, the env password).
 */
const NOT_A_SELF_HOSTERS = /^(CF_|CLOUDFLARE_|PUBLIC_ADDRESS_|DIRECTORY_|REGISTRAR_|BACKUP_|IMAGE_|S3_|ACME_|ALERTS_|NODE_PROFILE$|NODE_ROLE$|PRIVATE_PREVIEW$|ENABLE_|DISABLE_|BEANPOOL_SUITE_|BEANPOOL_TEST_|BEANPOOL_ADDRESSES$|ADMIN_|MIN_APP_VERSION|EXPO_|GOOGLE_|APPLE_|FACEBOOK_|TIKTOK_|INSTAGRAM_|FEEDBACK_|PULSE_|ENFORCE_|TRUSTED_PROXIES$)|_URL$/;

interface Node {
    name: string;
    dir: string;
    base: string;
    callsFile: string;
    /** Exit codes of the starts that were live and ended by themselves, in order. */
    exits: number[];
    /** Why each start that ended before it was live ended (each started again, on new ports when one was taken). */
    bootFailures: string[];
    /** Whether the start running now is live (its output says so). */
    isUp: () => boolean;
    /** When the start running now went live (ms), if it has. */
    liveSince: () => number | null;
    /** Until it is; false after `ms`. */
    up: (ms?: number) => Promise<boolean>;
    output: () => string;
    /** The `beanpool` command on the server's shell, beside the running node (`docker compose exec`), trapped as it is. */
    beanpool: (args: string[]) => Promise<{ status: number | null; output: string }>;
    /** Stopped for good: SIGKILL (a dead server) or SIGTERM (the suite's end). No restart. */
    stop: (signal: NodeJS.Signals) => Promise<void>;
}

/** A node on `dir`, started now and again whenever it exits, as Docker's restart policy does, until stopped. */
async function startNode(root: string, name: string, extraEnv: Record<string, string> = {}): Promise<Node> {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    const callsFile = path.join(root, `${name}.outside-calls.jsonl`);
    let ports = await freePorts();
    const base = { url: `https://127.0.0.1:${ports.https}` };
    let out = '';
    let child: ChildProcess | null = null;
    let stopped = false;
    /** One per start: when it was live, and how it ended. */
    const runs: { live: boolean; liveAt: number | null; exit: number | null }[] = [];
    const exits: number[] = [];
    const bootFailures: string[] = [];
    let failedBeforeLive = 0;
    /** Three starts in a row ended before they were live: not started again. */
    let gaveUp = false;
    const env = (): NodeJS.ProcessEnv => {
        const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !NOT_A_SELF_HOSTERS.test(k)));
        return {
            ...base,
            BEANPOOL_DATA_DIR: dir,
            PORT_HTTP: String(ports.http), PORT_HTTPS: String(ports.https), PORT_P2P: String(ports.p2p),
            OUTSIDE_CALLS_FILE: callsFile,
            // The nodes' own self-signed certificates: a standby copies its main server over HTTPS on loopback.
            NODE_TLS_REJECT_UNAUTHORIZED: '0',
            ...extraEnv,
        };
    };
    const launch = () => {
        const run = { live: false, liveAt: null as number | null, exit: null as number | null };
        runs.push(run);
        out += `\n──── ${name}, start ${runs.length} ────\n`;
        let mine = '';
        const proc = spawn(process.execPath, [...process.execArgv, SCRIPT, '--child'], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
        child = proc;
        const take = (d: Buffer) => {
            const s = d.toString();
            out += s;
            mine += s;
            if (!run.live && mine.includes(READY_LINE)) {
                run.live = true;
                run.liveAt = Date.now();
            }
        };
        proc.stdout!.on('data', take);
        proc.stderr!.on('data', take);
        proc.on('exit', (code, signal) => {
            run.exit = code ?? (signal ? -1 : 0);
            if (stopped) return;
            if (!run.live) {
                // The four ports were free a moment ago and another process took one (a listener's EADDRINUSE; the DNS
                // shim's own on :53 is not fatal): new ones, as test-clean-stop does. Anything else is a failure to start.
                const portTaken = /UnsupportedListenAddressesError|listen EADDRINUSE/.test(mine);
                bootFailures.push(portTaken ? 'a port was taken' : `exit ${run.exit}`);
                if (++failedBeforeLive >= 3) gaveUp = true;
                else if (portTaken) void freePorts().then((p) => { ports = p; base.url = `https://127.0.0.1:${p.https}`; launch(); });
                else launch();
                return;
            }
            exits.push(run.exit);
            failedBeforeLive = 0;
            launch();
        });
    };
    launch();
    const isUp = () => { const r = runs.at(-1); return !!r && r.live && r.exit === null; };
    const node: Node = {
        name, dir, callsFile, exits, bootFailures, isUp,
        liveSince: () => (isUp() ? runs.at(-1)!.liveAt : null),
        get base() { return base.url; },
        up: async (ms = 60_000) => (await until(`${name} to be live`, () => isUp() || gaveUp, ms)) && isUp(),
        output: () => out,
        // Not spawnSync: this process's own loop keeps running, so its kept-alive sockets to the nodes are not reset under it.
        beanpool: (args) => new Promise((resolve) => {
            const p = spawn(process.execPath, [...process.execArgv, SCRIPT, '--beanpool', ...args], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
            let said = '';
            p.stdout!.on('data', (d) => { said += d.toString(); });
            p.stderr!.on('data', (d) => { said += d.toString(); });
            const late = setTimeout(() => p.kill('SIGKILL'), 60_000);
            p.on('exit', (code) => { clearTimeout(late); resolve({ status: code, output: said }); });
        }),
        stop: async (signal) => {
            stopped = true;
            const c = child;
            if (!c || c.exitCode !== null || c.signalCode !== null) return;
            const gone = new Promise<void>((r) => c.once('exit', () => r()));
            c.kill(signal);
            const late = setTimeout(() => c.kill('SIGKILL'), 10_000);
            await gone;
            clearTimeout(late);
        },
    } as Node;
    return node;
}

// ── Phones ─────────────────────────────────────────────────────────────────────────────────

type Core = typeof import('@beanpool/core');
let core!: Core;

interface Answer { status: number; body: any; headers: Headers; bytes?: Buffer }

/** A member's phone: a key made from 12 words as the app makes it, signing every request as the app signs it. */
class Phone {
    readonly seedHex: string;
    readonly pk: string;
    private readonly sign: (b: Uint8Array) => Uint8Array | Promise<Uint8Array>;
    constructor(readonly name: string, readonly words: string[], public home: string) {
        // apps/native/utils/crypto.ts mnemonicToKeypair: the seed is SHA-256(SHA-256(the words, one space between)).
        const seed = crypto.createHash('sha256').update(crypto.createHash('sha256').update(words.join(' ')).digest()).digest();
        this.seedHex = seed.toString('hex');
        const pub = crypto.createPublicKey(crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' }));
        this.pk = (pub.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
        this.sign = core.ed25519Signer(new Uint8Array(seed));
    }
    static fresh(name: string, home: string): Phone {
        return new Phone(name, core.recoveryWordsFromEntropy(new Uint8Array(crypto.randomBytes(core.RECOVERY_ENTROPY_LEN))), home);
    }
    /** `unsigned`: as the app sends what it sends before it has a key there (the claim, whose body carries its own signature). */
    async call(method: 'GET' | 'POST', route: string, body?: unknown, opts: { at?: string; headers?: Record<string, string>; raw?: Buffer; bytes?: boolean; unsigned?: boolean } = {}): Promise<Answer> {
        const url = `${opts.at ?? this.home}${route}`;
        const text = opts.raw ? '' : method === 'GET' ? '' : JSON.stringify(body ?? {});
        const signed = opts.raw || opts.unsigned ? {} : await core.buildBoundRequestHeaders({ method, url, body: text, publicKeyHex: this.pk, sign: this.sign });
        const headers: Record<string, string> = { ...signed, ...opts.headers };
        if (method !== 'GET' && !opts.raw) headers['Content-Type'] = 'application/json';
        const res = await fetch(url, { method, headers, body: opts.raw ? new Uint8Array(opts.raw) : method === 'GET' ? undefined : text });
        if (opts.bytes) return { status: res.status, body: null, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
        const got = await res.text();
        let parsed: any = got;
        try { parsed = JSON.parse(got); } catch { /* not JSON */ }
        return { status: res.status, body: parsed, headers: res.headers };
    }
    get(route: string, at?: string) { return this.call('GET', route, undefined, { at }); }
    post(route: string, body: unknown = {}, at?: string) { return this.call('POST', route, body, { at }); }

    /** The app's "Manage" hand-off: a key session on `at` (the node's sign-in challenge, signed for its host). */
    async adminSession(at = this.home): Promise<Record<string, string>> {
        const ch = await this.call('POST', '/api/local/admin/auth/challenge', {}, { at });
        const signature = await core.signAdminSignin(at, ch.body?.challengeId, this.sign);
        const solved = await this.call('POST', '/api/local/admin/auth/verify-challenge',
            { challengeId: ch.body?.challengeId, memberPubkey: this.pk, signature, signedFor: core.audienceOf(at) }, { at });
        const exchanged = await fetch(`${at}/api/local/admin/auth/exchange`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: solved.body?.handshakeToken }),
        });
        const cookie = (exchanged.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('admin_session='));
        const session = cookie?.split(';')[0].split('=')[1];
        if (!session) throw new Error(`${this.name} could not sign in to Settings at ${at} (${ch.status}/${solved.status} ${JSON.stringify(solved.body)}/${exchanged.status})`);
        return { 'X-Admin-Session': session };
    }
    async admin(route: string, body: unknown, session: Record<string, string>, at = this.home): Promise<Answer> {
        return this.call('POST', route, body, { at, headers: session });
    }
}
const brief = (a: Answer) => `${a.status} ${JSON.stringify(a.body)?.slice(0, 200)}`;
const ok = (a: Answer) => a.status >= 200 && a.status < 300;
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';

/**
 * A new server claimed from a phone (routes/node-claim.ts), as the app does it: the code read from the server's folder, the
 * proof and the signature sent, never the code.
 */
async function claim(node: Node, owner: Phone): Promise<void> {
    const code = fs.readFileSync(path.join(node.dir, 'claim-code.txt'), 'utf-8').trim();
    const info = await owner.call('GET', '/api/local/claim', undefined, { at: node.base, unsigned: true });
    need(info.status === 200 && info.body?.unclaimed === true, `${node.name} has no owner yet (${brief(info)})`);
    const host = core.audienceOf(node.base)!;
    const proof = core.claimProof(core.claimKeyFromCode(code, info.body.salt), host, info.body.codeId, owner.pk);
    const signature = Buffer.from(await core.ed25519Signer(Buffer.from(owner.seedHex, 'hex'))(core.signedRequestBytes(core.claimText(host, info.body.codeId, owner.pk, proof)))).toString('base64');
    const claimed = await owner.call('POST', '/api/local/claim', { publicKey: owner.pk, callsign: owner.name, codeId: info.body.codeId, signedFor: host, proof, signature }, { at: node.base, unsigned: true });
    need(claimed.status === 200 && claimed.body?.role === 'owner', `${owner.name} claims ${node.name} with its claim code and is its owner (${brief(claimed)})`);
}

// ── The walk ───────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    fs.mkdirSync(root, { recursive: true });
    const started = Date.now();
    // The phones' process: the same trap, before anything below can call out.
    const phonesFile = path.join(root, 'phones.outside-calls.jsonl');
    installOutsideCallTrap({ file: phonesFile });
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    core = await import('@beanpool/core');
    const { startFakeS3 } = await import('./fake-s3-test-harness.js');
    const { lockedDm } = await import('./dm-test-payload.js');
    // The `beanpool pair` command's half (it opens no database).
    const { writePairRequestFile } = await import('./services/standby-main.js');
    /** Where a standby keeps the take-over keys it holds: services/standby-envelopes.ts, whose logger opens a database. */
    const HELD_ENVELOPES_DIR = 'held-takeover-envelopes';

    const nodes: Node[] = [];
    const s3 = await startFakeS3({ bucket: 'olive-backups' });
    const steps: { title: string; from: number; to: number }[] = [];
    let countFrom = Number.POSITIVE_INFINITY;
    const allCalls = (): OutsideCall[] => [phonesFile, ...nodes.map((n) => n.callsFile)].flatMap(readOutsideCalls).sort((a, b) => a.at - b.at);
    const step = async (title: string, fn: () => Promise<void>) => {
        console.log(`\n— ${title} —`);
        const from = Date.now();
        try { await fn(); } catch (e: any) { assert(false, `${title}: ${e?.message || e}`); }
        const to = Date.now();
        steps.push({ title, from, to });
        const during = allCalls().filter((c) => c.at >= from && c.at <= to);
        console.log(`  (${((to - from) / 1000).toFixed(1)} s; calls past this machine: ${during.length === 0 ? 'none' : describeOutsideCalls(during).join('; ')})`);
    };

    try {
        // ── 0. The trap itself: every way out of this process is refused and counted ──
        await step('0. our domains do not resolve here', async () => {
            const dns = (await import('node:dns')).default;
            const tls = (await import('node:tls')).default;
            const before = allCalls().length;
            const fetched = await fetch('https://global.beanpool.org/api/community/info').then(() => 'answered', (e) => e?.cause?.code);
            const looked = await dns.promises.lookup('beanpool.org').then(() => 'resolved', (e) => e?.code);
            const socket = await new Promise<string>((r) => { const s = tls.connect({ host: 'registrar.beanpool.org', port: 443 }); s.once('error', (e: any) => r(e.code)); s.once('secureConnect', () => r('connected')); });
            const seen = allCalls().slice(before);
            assert(fetched === 'ENOTFOUND' && looked === 'ENOTFOUND' && socket === 'ENOTFOUND',
                `a fetch, a lookup and a TLS socket to our domains each fail as an unresolvable name (${fetched}, ${looked}, ${socket})`);
            assert(seen.length === 3 && seen.every((c) => c.domain === 'beanpool.org'), `…and each is counted against beanpool.org (${describeOutsideCalls(seen).join('; ')})`);
        });
        // Those three were this check's own: the count is of everything after it.
        countFrom = Date.now();

        // The three nodes. S boots on B's genesis, as setup-backup.mjs and `beanpool pair` set a standby up.
        const [A, B] = await Promise.all([startNode(root, 'A'), startNode(root, 'B')]);
        nodes.push(A, B);
        need(await A.up() && await B.up(), `A and B boot as a self-hoster's node boots (${((Date.now() - started) / 1000).toFixed(1)} s)`);
        fs.mkdirSync(path.join(root, 'S'), { recursive: true });
        fs.copyFileSync(path.join(B.dir, 'genesis.json'), path.join(root, 'S', 'genesis.json'));
        // The standby pulls every second here, not every minute: the condition waits below are for its copy.
        const S = await startNode(root, 'S', { NODE_ROLE: 'backup', BACKUP_PULL_INTERVAL_MS: '1000' });
        nodes.push(S);

        const olive = Phone.fresh('Olive', A.base);
        const ann = Phone.fresh('Ann', A.base);
        const bo = Phone.fresh('Bo', A.base);
        const cy = Phone.fresh('Cy', B.base);
        let oliveAdmin: Record<string, string> = {};
        let cyAdmin: Record<string, string> = {};
        let bRecoveryCode = '';

        // ── 1. Genesis and claim ──
        await step('1. genesis and claim: each owner claims their node and names the community', async () => {
            for (const [node, owner, community] of [[A, olive, 'Riverbend'], [B, cy, 'Hilltop']] as const) {
                await claim(node, owner);
                const session = await owner.adminSession();
                const named = await owner.admin('/api/local/update-identity', { communityName: community }, session);
                need(ok(named), `${owner.name} names the community ${community} from Settings (${brief(named)})`);
                assert(ok(await owner.post('/api/profile/update', { avatar: TINY_PNG })), `${owner.name} sets a profile photo, as the app asks before the market`);
                if (node === A) oliveAdmin = session;
                else cyAdmin = session;
            }
            // B's owner makes the take-over code now: its keys are sealed to it, and the standby holds those keys (step 8).
            const code = await cy.admin('/api/local/admin/takeover/recovery-code', {}, cyAdmin);
            need(ok(code) && /^BPRC-1 /.test(code.body?.code ?? ''), `Cy makes B's recovery code (${code.status})`);
            bRecoveryCode = code.body.code;
            // …and pairs the standby as `beanpool pair` does: the code from Replication Access, left for S in pair-request.json.
            const pairing = await cy.admin('/api/local/admin/replication-token/generate', {}, cyAdmin);
            need(ok(pairing) && /^bpair1-/.test(pairing.body?.pairingCode ?? ''), `Cy makes a pairing code for a standby (${pairing.status})`);
            need(await S.up(), 'S boots as a standby');
            writePairRequestFile({ v: 1, id: crypto.randomBytes(8).toString('hex'), code: pairing.body.pairingCode, followNewServer: false, at: Date.now() }, S.dir);
            const answered = await until('S to answer the pairing', () => fs.existsSync(path.join(S.dir, 'pair-answer.json')), 10_000);
            const answer = answered ? JSON.parse(fs.readFileSync(path.join(S.dir, 'pair-answer.json'), 'utf-8')) : null;
            assert(answer?.ok === true && answer.outcome === 'paired', `S pairs with B (${answer?.lines?.join(' ') ?? 'no answer'})`);
        });

        // ── 2. An invite join ──
        await step('2. an invite join: Ann and Bo join A with Olive\'s invites', async () => {
            for (const who of [ann, bo]) {
                const inv = await olive.post('/api/invite/generate', { publicKey: olive.pk });
                need(ok(inv) && inv.body?.invite?.code, `Olive makes an invite (${brief(inv)})`);
                const joined = await who.post('/api/invite/redeem', { code: inv.body.invite.code, publicKey: who.pk, callsign: who.name });
                need(ok(joined) && joined.body?.success, `${who.name} joins with it (${brief(joined)})`);
                const token = await who.post('/api/push-tokens', { publicKey: who.pk, token: `ExponentPushToken[${crypto.randomBytes(11).toString('hex')}]`, platform: 'android' });
                assert(ok(token), `${who.name}'s phone registers its push token (${brief(token)})`);
                assert(ok(await who.post('/api/profile/update', { avatar: TINY_PNG })), `${who.name} sets a profile photo`);
            }
        });

        // ── 3. A listing, a deal, a rating ──
        let dealId = '';
        await step('3. a listing, a deal to completion, a rating', async () => {
            const offer = (who: Phone, title: string, credits: number) => who.post('/api/marketplace/posts', {
                type: 'offer', category: 'food', title, description: `${title}, from ${who.name}`, credits, priceType: 'fixed', authorPublicKey: who.pk,
            });
            const honey = await offer(ann, 'Honey', 20);
            need(ok(honey) && honey.body?.post?.id, `Ann lists honey (${brief(honey)})`);
            assert(ok(await offer(bo, 'Sourdough', 4)), 'Bo lists sourdough');
            // Bo's credit line to buy with: an owner's grant, as the harness's buyer gets one (a new member's floor is 0).
            const elder = await olive.admin(`/api/local/admin/users/${bo.pk}/elder`, { grant: true }, oliveAdmin);
            need(ok(elder), `Olive makes Bo an Elder (${brief(elder)})`);
            const asked = await bo.post('/api/marketplace/posts/request', { postId: honey.body.post.id, buyerPublicKey: bo.pk });
            need(ok(asked) && asked.body?.transaction?.id, `Bo asks for the honey (${brief(asked)})`);
            dealId = asked.body.transaction.id;
            const approved = await ann.post('/api/marketplace/transactions/approve', { transactionId: dealId, authorPublicKey: ann.pk });
            need(ok(approved), `Ann approves: the Beans are held (${brief(approved)})`);
            const done = await bo.post('/api/marketplace/transactions/complete', { transactionId: dealId, confirmerPublicKey: bo.pk });
            need(ok(done), `Bo confirms: the Beans are Ann's (${brief(done)})`);
            const rated = await bo.post('/api/ratings', { targetPubkey: ann.pk, stars: 5, transactionId: dealId, raterPubkey: bo.pk, comment: 'Lovely honey' });
            assert(ok(rated), `Bo rates Ann (${brief(rated)})`);
            const back = await ann.post('/api/ratings', { targetPubkey: bo.pk, stars: 5, transactionId: dealId, raterPubkey: ann.pk });
            assert(ok(back), `Ann rates Bo (${brief(back)})`);
        });

        // ── 4. A DM and a group line ──
        let dmId = '';
        await step('4. a DM and a group line', async () => {
            const conv = await ann.post('/api/messages/conversation', { type: 'dm', participants: [ann.pk, bo.pk], createdBy: ann.pk });
            dmId = conv.body?.conversation?.id ?? '';
            need(ok(conv) && dmId, `Ann opens a DM with Bo (${brief(conv)})`);
            const dm = lockedDm();
            const sent = await ann.post('/api/messages/send', { conversationId: dmId, authorPubkey: ann.pk, ...dm });
            assert(ok(sent), `Ann writes to Bo (${brief(sent)})`);
            const boReads = await bo.get(`/api/messages/${dmId}`);
            assert(ok(boReads) && JSON.stringify(boReads.body).includes(dm.ciphertext), `Bo reads it (${boReads.status})`);
            const group = await ann.post('/api/groups', { name: 'Gardeners', description: 'People who grow things' });
            const groupId = group.body?.group?.id ?? group.body?.id;
            need(ok(group) && groupId, `Ann starts a group (${brief(group)})`);
            need(ok(await bo.post(`/api/groups/${groupId}/join`)), 'Bo joins it');
            const epoch = core.makeGroupEpochRecord({ myEdPrivHex: ann.seedHex, groupId, epoch: 1, reason: 'start', createdAt: new Date().toISOString(), recipients: [ann.pk, bo.pk] });
            const keyed = await ann.post(`/api/groups/${groupId}/keys/epoch`, { epoch: epoch.record });
            need(ok(keyed), `Ann makes the group chat's keys, wrapped to her and Bo (${brief(keyed)})`);
            const lineId = crypto.randomUUID();
            const line = await bo.post(`/api/groups/${groupId}/chat/message`, {
                ...core.sealGroupLine('Seedlings by the gate', { myEdPrivHex: bo.seedHex, groupKey: epoch.groupKey, groupId, epoch: 1, messageId: lineId }),
                metadata: { epoch: 1 }, clientId: lineId,
            });
            assert(ok(line), `Bo sends a sealed line to the group (${brief(line)})`);
            const chat = await ann.get(`/api/groups/${groupId}/chat`);
            assert(ok(chat) && JSON.stringify(chat.body).includes(lineId), `Ann reads it in the group chat (${chat.status})`);
        });

        // ── 5. A knock from B's member to A ──
        await step('5. a knock from node B\'s member to node A, and its answer', async () => {
            const knocked = await cy.post('/api/join/knock', { callsign: 'Cy', message: 'Hilltop is up the road: may I join Riverbend too?', fromNode: new URL(B.base).host }, A.base);
            need(knocked.status === 201 && knocked.body?.knock?.status === 'pending', `Cy, a member of B, knocks on A from his phone (${brief(knocked)})`);
            const list = await olive.get('/api/join/knocks?limit=10&offset=0');
            const k = (list.body?.knocks ?? []).find((x: any) => x.pubkey === cy.pk);
            need(ok(list) && k, `Olive sees the knock (${brief(list)})`);
            const yes = await olive.post(`/api/join/knocks/${k.id}/approve`, {});
            need(ok(yes) && yes.body?.invite?.code, `Olive lets him in (${brief(yes)})`);
            const status = await cy.get('/api/join/knock/status', A.base);
            need(ok(status) && status.body?.status === 'approved' && status.body?.invite, `Cy's phone reads the answer: approved, with his invite (${brief(status)})`);
            const code = typeof status.body.invite === 'string' ? status.body.invite : status.body.invite.code;
            const joined = await cy.post('/api/invite/redeem', { code, publicKey: cy.pk, callsign: 'Cy' }, A.base);
            assert(ok(joined) && joined.body?.success, `Cy joins A with it, one key in two communities (${brief(joined)})`);
        });

        // ── 6. A 12-words restore ──
        await step('6. a 12-words restore: Ann\'s new phone, from her words alone', async () => {
            const newPhone = new Phone('Ann', [...ann.words], A.base);
            assert(newPhone.pk === ann.pk && core.recoveryWordsMatchPublicKey(ann.words, ann.pk), 'the words make the same key, as the app makes it');
            const member = await newPhone.get(`/api/community/membership/${newPhone.pk}`);
            assert(ok(member) && member.body?.isMember === true && member.body?.callsign === 'Ann', `the node knows her: she is back in as Ann (${brief(member)})`);
            const me = await newPhone.get('/api/community/me');
            assert(ok(me) && me.body?.publicKey === ann.pk, `her own page answers (${me.status})`);
            const chats = await newPhone.get(`/api/messages/conversations/${newPhone.pk}`);
            assert(ok(chats) && JSON.stringify(chats.body).includes(dmId), `her DM with Bo is there (${chats.status})`);
            const balance = await newPhone.get(`/api/ledger/balance/${newPhone.pk}`);
            assert(ok(balance) && Number(balance.body?.balance) > 0, `and her Beans from the honey (${brief(balance)})`);
        });

        // ── 7. A sealed backup, off the box, and a restore ──
        await step('7. a sealed backup, an off-box upload to a loopback S3 stub, a restore', async () => {
            const code = await olive.admin('/api/local/admin/takeover/recovery-code', {}, oliveAdmin);
            need(ok(code) && code.body?.code, `Olive makes A's recovery code (${code.status})`);
            const recoveryCode: string = code.body.code;
            const file = await olive.call('POST', '/api/local/admin/backup', {}, { headers: oliveAdmin, bytes: true });
            assert(file.status === 200 && file.headers.get('x-backup-locked') === 'yes' && (file.bytes?.length ?? 0) > 1000,
                `she downloads a sealed backup (${file.status}, locked ${file.headers.get('x-backup-locked')}, ${file.bytes?.length} bytes)`);
            const dest = await olive.admin('/api/local/admin/offbox-backups/settings', {
                destination: { name: 'Loopback S3', endpoint: s3.endpoint, bucket: s3.bucket, region: s3.region, prefix: 'riverbend/', accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
            }, oliveAdmin);
            need(ok(dest), `she sends backups off the box, to the S3 stub (${brief(dest)})`);
            need(ok(await olive.admin('/api/local/admin/offbox-backups/run', {}, oliveAdmin)), 'she sends one now');
            let key = '';
            const landed = await until('the sealed copy in the S3 stub', async () => {
                key = [...(await s3.objects()).keys()].find((k) => k.endsWith('.bpsealed')) ?? '';
                return key !== '';
            });
            const status = await olive.admin('/api/local/admin/offbox-backups/status', {}, oliveAdmin);
            assert(landed && ok(status), `the sealed copy is in the bucket (${key})`);
            const bytes = (await s3.objects()).get(key)?.bytes;
            need(bytes && bytes.length > 1000, 'and it can be read back');
            // A change after the backup, which the restore takes back.
            const later = await olive.post('/api/marketplace/posts', { type: 'offer', category: 'food', title: 'Jam', description: 'After the backup', credits: 3, priceType: 'fixed', authorPublicKey: olive.pk });
            need(ok(later), 'Olive lists jam after the backup');
            const startsBefore = A.exits.length;
            const restored = await olive.call('POST', '/api/local/admin/restore', undefined, {
                raw: bytes!, headers: { ...oliveAdmin, 'X-Recovery-Code': recoveryCode, 'Content-Type': 'application/x-www-form-urlencoded' },
            });
            need(ok(restored) && restored.body?.success && restored.body?.sealed, `the off-box copy restores, opened with the recovery code (${brief(restored)})`);
            need(await until('A to restart after the restore', () => A.exits.length > startsBefore, 20_000) && await A.up(), `A restarts itself on the restored data (exit ${A.exits.at(-1)})`);
            oliveAdmin = await olive.adminSession();
            const posts = await olive.get('/api/marketplace/posts');
            const titles = JSON.stringify(posts.body);
            assert(ok(posts) && titles.includes('Sourdough') && !titles.includes('After the backup'), `the community is as backed up: the sourdough is listed, the jam is not (${posts.status})`);
            const annBack = await ann.get(`/api/community/membership/${ann.pk}`);
            assert(annBack.body?.isMember === true, 'and Ann is still a member');
        });

        // ── 8. A standby copy and a take-over by code ──
        await step('8. a standby copy and a take-over by code', async () => {
            // S has B's community once its whole copy is swapped in (one restart) and holds B's sealed keys.
            const held = () => { try { return fs.readdirSync(path.join(S.dir, HELD_ENVELOPES_DIR)).filter((n) => n.endsWith('.bpseal')).length; } catch { return 0; } };
            need(await until('S to copy B and hold its keys', async () => S.exits.length >= 1 && S.isUp() && held() > 0, 30_000),
                `S copied B (swapped in at a restart, exit ${S.exits[0]}) and holds B's take-over keys (${held()})`);
            // A standby has no owner of its own: node_roles travels only inside the take-over keys (engine/replication-manifest.ts),
            // and a claim is refused on a standby (claimNode meets the standby's ledger gate). Cy, on S's shell, makes
            // himself its owner as an operator whose owners cannot sign in does: `beanpool recover --key` (recover-command.ts).
            const recovered = await S.beanpool(['recover', '--key', cy.pk]);
            need(recovered.status === 0, `Cy makes himself S's owner from its shell with \`beanpool recover\` (exit ${recovered.status}${recovered.status === 0 ? '' : `: ${recovered.output.slice(-300)}`})`);
            // B's main server dies.
            await B.stop('SIGKILL');
            cy.home = S.base;
            const session = await cy.adminSession(S.base);
            const opened = await cy.admin('/api/local/admin/takeover/open', { code: bRecoveryCode }, session, S.base);
            need(ok(opened) && opened.body?.preview?.sessionId, `Cy opens B's keys on S with the recovery code (${brief(opened)})`);
            const exitsBefore = S.exits.length;
            const confirmed = await cy.admin('/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, session, S.base);
            need(ok(confirmed), `and confirms the take-over (${brief(confirmed)})`);
            need(await until('S to restart as the main server', () => S.exits.length > exitsBefore, 20_000) && await S.up(),
                `S restarts itself (exit ${S.exits.at(-1)})`);
            assert(fs.readFileSync(path.join(S.dir, 'libp2p_key')).equals(fs.readFileSync(path.join(B.dir, 'libp2p_key'))), 'S has B\'s node key: it is B now');
            const me = await cy.get('/api/community/me');
            assert(ok(me) && me.body?.publicKey === cy.pk, `Cy's phone, at S, is home (${me.status})`);
            const listed = await cy.post('/api/marketplace/posts', { type: 'offer', category: 'tools', title: 'Ladder', description: 'On the new server', credits: 2, priceType: 'fixed', authorPublicKey: cy.pk });
            assert(ok(listed), `and he lists a ladder: S takes members' writes as the main server (${brief(listed)})`);
        });

        // ── 9. An update check that gets no answer ──
        await step('9. an update check that gets no answer', async () => {
            const from = Date.now();
            const checked = await olive.admin('/api/admin/check-update', {}, oliveAdmin);
            assert([500, 502].includes(checked.status) && checked.body?.updateAvailable === false && checked.body?.error,
                `Olive's update check says it could not check (${brief(checked)})`);
            const asked = allCalls().filter((c) => c.at >= from && c.host === 'api.github.com');
            assert(asked.length > 0, `…because GitHub did not resolve (${describeOutsideCalls(asked).join('; ') || 'not asked'})`);
            const version = await olive.get('/api/version');
            assert(ok(version) && version.body?.updateAvailable === undefined, `and A goes on: its version answers, with no update notice (${brief(version)})`);
        });

        // ── 10. The node's own timers ──
        // index.ts arms its first timed calls 30 s after a start (the release check, the app-store lookup, the publisher's
        // first push, the registrar name watch's first look). The walk is over sooner, so it waits, for those to have run
        // on A since its last start, rather than for a time: then the count covers them too.
        await step('10. A\'s own timers, 30 s after its start', async () => {
            const since = A.liveSince();
            need(since !== null, 'A is running');
            // Not step 9's own check, which asked GitHub from Olive's Settings.
            const asked = steps.find((s) => s.title.startsWith('9.'));
            const timed = () => readOutsideCalls(A.callsFile).filter((c) => c.at >= since! && !(asked && c.at >= asked.from && c.at <= asked.to));
            const ran = await until('A\'s 30-second timers', () => ['itunes.apple.com', 'play.google.com', 'api.github.com'].every((h) => timed().some((c) => c.host === h)), 45_000);
            assert(ran, `A's timed release check and app-store lookup ran, and got no answer (${describeOutsideCalls(timed()).join('; ') || 'none'})`);
            const me = await ann.get('/api/community/me');
            assert(ok(me), `and Ann's phone is still served (${me.status})`);
        });
    } catch (e: any) {
        assert(false, e?.message || String(e));
    } finally {
        for (const n of nodes) await n.stop('SIGTERM').catch(() => {});
        await s3.stop().catch(() => {});
    }

    // ── The count ──
    console.log('\n— the count: every call past this machine, by every process —');
    const calls = allCalls().filter((c) => c.at >= countFrom);
    assert(countFrom !== Number.POSITIVE_INFINITY, 'the count starts after the trap\'s own check');
    const { ours, unexpected, allowed } = checkOutsideCalls(calls, ALLOWED);
    for (const [entry, cs] of allowed) console.log(`  allowed ${entry.host} ×${cs.length}: ${entry.why}`);
    const stepOf = (c: OutsideCall) => steps.find((s) => c.at >= s.from && c.at <= s.to)?.title.split(':')[0] ?? 'between steps';
    const say = (cs: OutsideCall[]) => cs.slice(0, 8).map((c) => `${c.host} (${c.via}, ${stepOf(c)}, ${c.from ?? 'no line of ours on the stack'})`).join('; ');
    assert(ours.length === 0, `no process asked for any of our domains (${ours.length === 0 ? 'none' : say(ours)})`);
    assert(unexpected.length === 0, `no process asked for a host outside the allowed list (${unexpected.length === 0 ? 'none' : say(unexpected)})`);
    const watched = calls.filter((c) => c.domain);
    console.log(`  watched (${WATCHED_DOMAINS.join(', ')}): ${watched.length === 0 ? 'none' : describeOutsideCalls(watched).join('; ')}`);
    assert(nodes.every((n) => n.exits.every((code) => code === 0) && n.bootFailures.every((f) => f === 'a port was taken')),
        `no node stopped by itself except to restart (${nodes.map((n) => `${n.name} exits [${n.exits.join(',')}]${n.bootFailures.length ? `, failed starts [${n.bootFailures.join(', ')}]` : ''}`).join('; ')})`);

    if (passed !== run) {
        // Each node's own output beside its data dir, for a look after a failure.
        for (const n of nodes) { try { fs.writeFileSync(path.join(root, `${n.name}.log`), n.output()); } catch { /* the dir is gone */ } }
        console.error(`  (each node's output: ${root}/<A|B|S>.log)`);
    }
    console.log(`\n${passed}/${run} passed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    process.exit(passed === run ? 0 : 1);
}

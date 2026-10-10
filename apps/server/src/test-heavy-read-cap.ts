/**
 * The heavy-read cap (heavy-reads.ts; docs/global-heavy-lists.md §5(c), slice 1): a burst of heavy list reads can't kill
 * the node any more.
 *
 * Measured in the design (30,000 members with photos, one core): every heavy answer is held whole until its last byte
 * leaves, about 57 MB a directory in flight. On a 256 MB heap, 12 full directory reads at once ended the process (V8:
 * Reached heap limit). On the global node's 1 GB droplet the kernel killed it at 20 to 24.
 *
 *   1. The burst. 30,000 members with photos on a global node, its server a process of its own held to a 256 MB heap, and
 *      64 members asking for the whole directory at once. On origin/main 3c581fb that server died (FATAL ERROR: Reached
 *      heap limit). Now:
 *      - every answer is 200 or 503;
 *      - each 503 carries Retry-After, no-store, no ETag and `code: heavy_read_busy`;
 *      - every 200 is the whole directory, the same bytes as a read made afterwards;
 *      - the server lives and answers;
 *      - then 512 at once, from 16 reader processes (readersAtOnce says why), all served the one shared directory
 *        (members-snapshot.ts), byte for byte, the heap under 75% of its 256 MB.
 *      How many are told "busy" depends on how fast the machine builds and sends (here, 24 to 40 of the 64).
 *  1b. Readers of the shared directory who stop reading (24 and 48 plain, 48 gzip), from a process of their own, each on
 *      a fresh server: its RSS, not only its heap, grows by no more than the 48 MB budget, and each reader is served or
 *      told "busy". Before the snapshot was sent a window at a time: +183, +445 and +107 MB.
 *  1c. The same, with the version moved before each reader (24 and 48, plain and gzip), on the shared directory and on a
 *      20,000-member roster: each reader holds a snapshot no longer current, which the cap counts once at its full size
 *      for as long as any send holds it. What they hold (live buffers) stays within the budget and is all counted, the
 *      readers past it are told "busy", and RSS no longer grows with the readers. Weighed only at the send's window,
 *      every one was served: 48 grew RSS +571 MB (directory) and +410 MB (roster) with the cap counting 6 to 14 MB.
 *   2. The same server, the gate before the cap.
 *      - An unsigned read, a bad signature and a key that isn't a member are refused before the cap: no budget taken.
 *      - A delta isn't capped.
 *      - A reader who stops reading holds exactly its answer's size, and gives it back when it hangs up mid-answer.
 *      - With the default budget filled by readers who stop reading, the next waits its 6 s and is told "busy" (503
 *        with Retry-After). The log says it refused, in one line a minute, not one for each.
 *   3. The cap itself, on a small Koa app of its own:
 *      - HEAVY_READ_BUDGET_MB sets the budget; empty or junk keeps the default;
 *      - the weight is given back on finish, on close and when the build throws;
 *      - a route's weight is its last answer's size, an object body's too;
 *      - readers waiting are let in the order they came, as weight frees;
 *      - a reader is refused after the wait, or at once with the line full, with Retry-After, no-store and no ETag;
 *      - a reader who leaves the line leaves it and isn't counted;
 *      - a light answer goes past the line, and an answer bigger than the whole budget is served alone;
 *      - the log gets one line, not one per refusal;
 *      - an answer let in has 180 s to be sent: a reader who stops reading is cut off when it is up, its weight comes
 *        back, and the one waiting behind it is served;
 *      - a send at a fixed weight (a ready snapshot's) is weighed at that, never light, its size never learned, and is
 *        refused and cut off as any other.
 *
 * Every server binds port 0. The children use directories under this run's data dir, and the runner's TMPDIR.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) TMPDIR=$(mktemp -d) node --import tsx src/test-heavy-read-cap.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
// The orchestrator's own environment, which its children inherit before child() adds theirs: not in a child, where it
// would take the global profile away again.
if (process.argv[2] !== 'seed' && process.argv[2] !== 'serve') {
    delete process.env.CF_RECORD_NAME;
    delete process.env.NODE_PROFILE;
    delete process.env.ENFORCE_READ_AUTH;
    delete process.env.HEAVY_READ_BUDGET_MB;
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const HERE = fileURLToPath(import.meta.url);
const MB = 2 ** 20;
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

type Key = { pk: string; priv: crypto.KeyObject };
function newKey(): Key {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey };
}

// ── The children ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** `n` members, `readers` first, each with a photo by its one writer (setMemberPhoto, as a profile save puts it there). */
async function seed(a: { n: number; readers: string[]; group?: number }): Promise<void> {
    const se = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const { setMemberPhoto } = await import('@beanpool/engine');
    se.initStateEngine();
    const insert = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invite_code, status) VALUES (?, ?, ?, ?, 'active')`);
    const BATCH = 1000;
    for (let start = 0; start < a.n; start += BATCH) {
        db.transaction(() => {
            for (let i = start; i < Math.min(a.n, start + BATCH); i++) {
                const pk = a.readers[i] ?? crypto.createHash('sha256').update(`heavy-read member ${i}`).digest('hex');
                insert.run(pk, `Heavy${i}`, new Date(Date.UTC(2026, 0, 2) + i * 1000).toISOString(), `INV-HEAVY-${i}`);
                setMemberPhoto(db as any, pk, PNG_1PX);
            }
        })();
    }
    // An open group of the first `group` members, the first its convenor: a big roster.
    if (a.group) {
        const g = se.createGroup({ name: 'Heavy roster', createdBy: a.readers[0], joinPolicy: 'open' } as any);
        const join = db.prepare(`INSERT OR IGNORE INTO group_members (group_id, member_pubkey, role, status, joined_at, updated_at) VALUES (?, ?, 'member', 'active', ?, ?)`);
        db.transaction(() => {
            for (let i = 1; i < a.group!; i++) {
                const pk = a.readers[i] ?? crypto.createHash('sha256').update(`heavy-read member ${i}`).digest('hex');
                join.run(g.id, pk, new Date(Date.UTC(2026, 0, 3) + i * 1000).toISOString(), new Date(Date.UTC(2026, 0, 3) + i * 1000).toISOString());
            }
        })();
    }
    db.pragma('wal_checkpoint(TRUNCATE)');
}

/** The real server, on port 0: its heap's peak (sampled every 5 ms) and the cap's counts when asked on stdin. */
async function serve(): Promise<void> {
    const { initTls } = await import('./services/tls.js');
    const { initAdminPassword } = await import('./config/local-config.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    initAdminPassword();
    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    let peak = 0;
    setInterval(() => { const h = process.memoryUsage().heapUsed; if (h > peak) peak = h; }, 5).unref();
    const say = (m: unknown) => process.stdout.write(`@@ ${JSON.stringify(m)}\n`);
    say({ ready: true, port });
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
        if (line === 'peak') { say({ peak }); peak = process.memoryUsage().heapUsed; }
        // Imported here so that the burst in 1 runs on a server from before the cap too (the fail-first run).
        if (line === 'stats') import('./heavy-reads.js').then((m) => say({ stats: m.heavyReadStats() }), () => say({ stats: null }));
        // The whole process, not only the heap: TLS keeps each socket's ciphertext off the V8 heap.
        if (line === 'mem') { const m = process.memoryUsage(); say({ mem: { rss: m.rss, heap: m.heapUsed, buffers: m.arrayBuffers, footprint: footprint() } }); }
        // The same after a full collection: what is held, not the garbage of the builds before it (1c builds one each version).
        if (line === 'mem-gc') { (globalThis as any).gc?.(); (globalThis as any).gc?.(); const m = process.memoryUsage(); say({ mem: { rss: m.rss, heap: m.heapUsed, buffers: m.arrayBuffers } }); }
        // A write somewhere moves the version: the directory's (members) or every roster's (groups).
        if (line === 'bump-members') import('./engine/versions.js').then((m) => { m.bumpMembersVersion(); say({ bumped: true }); });
        if (line === 'bump-groups') { se.bumpGroupsVersion(); say({ bumped: true }); }
        if (line === 'group') import('./db/db.js').then(({ db }) => say({ group: (db.prepare(`SELECT id FROM groups WHERE name = 'Heavy roster'`).get() as { id: string } | undefined)?.id ?? null }));
        if (line === 'exit') process.exit(0);
    });
}

/**
 * macOS only: this process's phys_footprint, its dirty memory wherever it is. On a Mac short of memory the compressor
 * takes pages out of the RSS: 384 readers who stop reading measured RSS 217 → 52 MB with 48 MB counted in flight
 * (#1524). Elsewhere null, and RSS is the measure.
 */
function footprint(): number | null {
    if (process.platform !== 'darwin') return null;
    try {
        const m = /phys_footprint: (\d+) B/.exec(execFileSync('footprint', ['-p', String(process.pid), '-f', 'bytes', '--noCategories'], { encoding: 'utf8' }));
        return m ? Number(m[1]) : null;
    } catch {
        return null;
    }
}

/** `count` directory reads at once from this process when the orchestrator says go (a line on stdin): what each got. */
async function read(a: { port: number; keys: { pk: string; der: string }[]; count: number }): Promise<void> {
    const keys: Key[] = a.keys.map((k) => ({ pk: k.pk, priv: crypto.createPrivateKey({ key: Buffer.from(k.der, 'hex'), format: 'der', type: 'pkcs8' }) }));
    const say = (m: unknown) => new Promise((r) => process.stdout.write(`@@ ${JSON.stringify(m)}\n`, r));
    await say({ ready: true });
    await new Promise((r) => process.stdin.once('data', r));
    const answers = await Promise.all(Array.from({ length: a.count }, (_, i) => open({ port: a.port, tls: true }, '/api/members', signed('/api/members', keys[i % keys.length])).done));
    await say(answers.map(({ status, bytes, sha, ms, error }) => ({ status, bytes, sha, ms, error })));
}

/**
 * `count` directory reads that stop reading after the headers, as a phone put away mid-download (or one doing it on
 * purpose), from a process of their own so that the server's memory is the server's. Says what each got once the
 * orchestrator asks, and hangs up all of them when it says so.
 */
async function stall(a: { port: number; keys: { pk: string; der: string }[]; count: number; gzip: boolean }): Promise<void> {
    const keys: Key[] = a.keys.map((k) => ({ pk: k.pk, priv: crypto.createPrivateKey({ key: Buffer.from(k.der, 'hex'), format: 'der', type: 'pkcs8' }) }));
    const say = (m: unknown) => new Promise((r) => process.stdout.write(`@@ ${JSON.stringify(m)}\n`, r));
    const opens = Array.from({ length: a.count }, (_, i) =>
        open({ port: a.port, tls: true }, '/api/members', { ...signed('/api/members', keys[i % keys.length]), ...(a.gzip ? { 'Accept-Encoding': 'gzip' } : {}) }, { hold: true }));
    const answers = opens.map((o) => o.headers.then(async (res) => (res?.statusCode === 200 ? { status: 200 } : { ...(await o.done), sha: '' })));
    const lines = readline.createInterface({ input: process.stdin });
    for await (const line of lines) {
        if (line === 'report') await say((await Promise.all(answers)).map((x: any) => ({ status: x.status, text: x.text, headers: x.headers, ms: x.ms, error: x.error })));
        if (line === 'bye') { for (const o of opens) o.hangUp(); await say({ bye: true }); return; }
    }
}

/**
 * Readers of `route` who stop reading after the headers, one each time the orchestrator says 'open' (answering with what
 * it got: 200 once the headers are in, or the whole refusal) or 'open-nowait' (answering at once). Says what each got
 * on 'report', and hangs up all of them on 'bye'.
 */
async function stallOneByOne(a: { port: number; keys: { pk: string; der: string }[]; route: string; gzip: boolean }): Promise<void> {
    const keys: Key[] = a.keys.map((k) => ({ pk: k.pk, priv: crypto.createPrivateKey({ key: Buffer.from(k.der, 'hex'), format: 'der', type: 'pkcs8' }) }));
    const say = (m: unknown) => new Promise((r) => process.stdout.write(`@@ ${JSON.stringify(m)}
`, r));
    const opens: Open[] = [];
    const answers: Promise<any>[] = [];
    for await (const line of readline.createInterface({ input: process.stdin })) {
        if (line === 'open' || line === 'open-nowait') {
            const o = open({ port: a.port, tls: true }, a.route, { ...signed(a.route, keys[opens.length % keys.length]), ...(a.gzip ? { 'Accept-Encoding': 'gzip' } : {}) }, { hold: true });
            opens.push(o);
            const answer = o.headers.then(async (res) => (res?.statusCode === 200 ? { status: 200 } : await o.done));
            answers.push(answer);
            if (line === 'open') { const x = await answer; await say({ status: x.status }); } else await say({ status: 'opened' });
        }
        if (line === 'report') await say((await Promise.all(answers)).map((x: any) => ({ status: x.status, text: x.text, headers: x.headers, ms: x.ms, error: x.error })));
        if (line === 'bye') { for (const o of opens) o.hangUp(); await say({ bye: true }); return; }
    }
}

const role = process.argv[2];
if (role === 'seed' || role === 'serve' || role === 'read' || role === 'stall' || role === 'stall1') {
    (role === 'seed' ? seed(JSON.parse(process.argv[3])) : role === 'read' ? read(JSON.parse(process.argv[3])) : role === 'stall' ? stall(JSON.parse(process.argv[3]))
        : role === 'stall1' ? stallOneByOne(JSON.parse(process.argv[3])) : serve()).then(
        () => { if (role !== 'serve') process.exit(0); },
        (e) => { console.error(e); process.exit(1); },
    );
} else {
    main().catch((e) => { console.error(e); process.exit(1); });
}

// ── The orchestrator ─────────────────────────────────────────────────────────────────────────────────────────────────

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    for (;;) {
        if (await check()) return true;
        if (Date.now() > end) return false;
        await sleep(20);
    }
}

/** This file again, as a child: `role`, its args, on `dataDir`, on the global profile; the node flags it runs with (tsx's) and `nodeFlags`. */
function child(role: string, dataDir: string, args: unknown, nodeFlags: string[] = []): ChildProcess {
    return spawn(process.execPath, [...nodeFlags, ...process.execArgv, HERE, role, ...(args === null ? [] : [JSON.stringify(args)])], {
        cwd: path.dirname(path.dirname(HERE)),
        env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, NODE_PROFILE: 'global' },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
}

async function runToEnd(role: string, dataDir: string, args: unknown): Promise<void> {
    const p = child(role, dataDir, args);
    let out = '';
    p.stdout!.on('data', (b) => { out += b; });
    p.stderr!.on('data', (b) => { out += b; });
    const code = await new Promise<number | null>((r) => p.on('exit', r));
    if (code !== 0) throw new Error(`${role} exited ${code}:\n${out.slice(-3000)}`);
}

interface Server { port: number; ask: (line: string) => Promise<any>; output: () => string; exited: () => boolean; stop: () => Promise<void> }

async function startServer(dataDir: string, heapMb: number): Promise<Server> {
    const p = child('serve', dataDir, null, [`--max-old-space-size=${heapMb}`, '--expose-gc']);
    let out = '';
    let dead = false;
    const replies: ((m: any) => void)[] = [];
    let readyResolve!: (m: any) => void;
    const ready = new Promise<any>((r) => { readyResolve = r; });
    const exited = new Promise<void>((r) => p.on('exit', () => { dead = true; r(); }));
    readline.createInterface({ input: p.stdout! }).on('line', (line) => {
        out += line + '\n';
        if (!line.startsWith('@@ ')) return;
        const m = JSON.parse(line.slice(3));
        if (m.ready) readyResolve(m); else replies.shift()?.(m);
    });
    p.stderr!.on('data', (b) => { out += b; });
    const first = await Promise.race([ready, exited.then(() => null)]);
    if (!first) throw new Error(`the server exited before it was ready:\n${out.slice(-3000)}`);
    return {
        port: first.port,
        ask: (line) => new Promise((r) => { replies.push(r); p.stdin!.write(line + '\n'); }),
        output: () => out,
        exited: () => dead,
        stop: async () => { if (!dead) { p.stdin!.write('exit\n'); await Promise.race([exited, sleep(5000)]); if (!dead) p.kill('SIGKILL'); } },
    };
}

/** A member's signature on a GET, as the apps send one (the older request format, which every node still takes). */
function signed(route: string, key: Key, badSignature = false): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`GET\n${route.split('?')[0]}\n${ts}\n${nonce}\n`), key.priv);
    if (badSignature) sig[0] ^= 0xff;
    return { 'X-Public-Key': key.pk, 'X-Signature': sig.toString('base64'), 'X-Timestamp': String(ts), 'X-Nonce': nonce };
}

interface Answer { status: number | 'error'; headers: http.IncomingHttpHeaders; bytes: number; sha: string; text: string; ms: number; error?: string }
interface Open { headers: Promise<http.IncomingMessage | null>; done: Promise<Answer>; resume: () => void; hangUp: () => void }

/**
 * One GET, its body counted and hashed as it arrives, its first `keep` bytes kept. `hold`: read nothing after the
 * headers until resume(), as a phone on a slow link. hangUp() drops the connection.
 */
function open(target: { port: number; tls: boolean }, route: string, headers: Record<string, string>, o: { hold?: boolean; keep?: number } = {}): Open {
    const keep = o.keep ?? 4096;
    const t0 = performance.now();
    let req!: http.ClientRequest;
    let response: http.IncomingMessage | null = null;
    let headersResolve!: (r: http.IncomingMessage | null) => void;
    const headersP = new Promise<http.IncomingMessage | null>((r) => { headersResolve = r; });
    const done = new Promise<Answer>((resolve) => {
        const hash = crypto.createHash('sha256');
        const kept: Buffer[] = [];
        let keptBytes = 0, bytes = 0, over = false;
        const finish = (status: number | 'error', error?: string) => {
            if (over) return;
            over = true;
            resolve({ status, headers: response?.headers ?? {}, bytes, sha: hash.digest('hex'), text: Buffer.concat(kept).toString('utf8'), ms: performance.now() - t0, error });
        };
        const opts = { host: 'localhost', port: target.port, path: route, method: 'GET', headers, agent: false, rejectUnauthorized: false };
        req = (target.tls ? https : http).request(opts, (res) => {
            response = res;
            // Only an answer is held: a refusal is read at once, as any app reads one.
            if (o.hold && res.statusCode === 200) res.pause();
            headersResolve(res);
            res.on('data', (c: Buffer) => {
                bytes += c.length;
                hash.update(c);
                if (keptBytes < keep) { kept.push(c); keptBytes += c.length; }
            });
            res.on('end', () => finish(res.statusCode!));
            res.on('close', () => finish(res.complete ? res.statusCode! : 'error', res.complete ? undefined : 'cut off'));
        });
        req.setTimeout(120_000, () => req.destroy(new Error('timeout')));
        req.on('error', (e: any) => { headersResolve(null); finish('error', e.code || e.message); });
        req.end();
    });
    return { headers: headersP, done, resume: () => response?.resume(), hangUp: () => { response?.destroy(); req.destroy(); } };
}

/** A 503 from the cap: why (code heavy_read_busy), when to come back (Retry-After), not to be kept, and no ETag. */
function isBusy(a: Answer): boolean {
    let code: unknown = null;
    try { code = JSON.parse(a.text).code; } catch { /* not JSON: not the cap's */ }
    return a.status === 503 && code === 'heavy_read_busy' && /^\d+$/.test(String(a.headers['retry-after'])) && Number(a.headers['retry-after']) >= 1
        && a.headers['cache-control'] === 'no-store' && a.headers.etag === undefined;
}

type Got = Pick<Answer, 'status' | 'bytes' | 'sha' | 'ms' | 'error'>;

/**
 * `count` directory reads at once, made by `procs` processes of this file (`read`), each started and ready before any
 * reads, so all of them go together. Measured 2026-10-03 on macOS: one Node process (22, 24 and 26 alike) reading 11 MB
 * answers over more than about 100 TLS sockets at once loses most of them to its own decryption
 * (ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC): a bare https server with none of this node's code, 512 readers in one
 * process, served 3 to 41 of them, with or without an agent or one shared TLS context. The same server, the same 512
 * spread over 8 processes of 64, served all 512. So 512 phones are played by many processes, as they would be.
 */
async function readersAtOnce(port: number, readers: Key[], count: number, procs: number, dataDir: string): Promise<{ answers: Got[]; ms: number }> {
    const keys = readers.map((r) => ({ pk: r.pk, der: r.priv.export({ type: 'pkcs8', format: 'der' }).toString('hex') }));
    const kids = Array.from({ length: procs }, (_, i) => {
        const share = Math.floor(count / procs) + (i < count % procs ? 1 : 0);
        const p = child('read', dataDir, { port, keys: keys.filter((_, k) => k % procs === i), count: share });
        const lines: ((m: any) => void)[] = [];
        const said: Promise<any>[] = [0, 1].map(() => new Promise((r) => lines.push(r)));
        let err = '';
        p.stderr!.on('data', (b) => { err += b; });
        readline.createInterface({ input: p.stdout! }).on('line', (line) => { if (line.startsWith('@@ ')) lines.shift()?.(JSON.parse(line.slice(3))); });
        p.on('exit', (code) => { if (lines.length) for (const r of lines.splice(0)) r({ died: code, err: err.slice(-2000) }); });
        return { p, ready: said[0], answers: said[1] };
    });
    for (const k of kids) {
        const m = await k.ready;
        if (!m.ready) throw new Error(`a reader process died before it was ready (${m.died}): ${m.err}`);
    }
    const t0 = performance.now();
    for (const k of kids) k.p.stdin!.write('go\n');
    const got = await Promise.all(kids.map((k) => k.answers));
    const ms = performance.now() - t0;
    const died = got.find((g) => !Array.isArray(g));
    if (died) throw new Error(`a reader process died (${died.died}): ${died.err}`);
    return { answers: got.flat(), ms };
}

const tally = (answers: Got[]) => {
    const t: Record<string, number> = {};
    for (const a of answers) t[String(a.status)] = (t[String(a.status)] || 0) + 1;
    return t;
};

async function main(): Promise<void> {
    const root = fs.mkdtempSync(path.join(process.env.BEANPOOL_DATA_DIR || os.tmpdir(), 'heavy-read-cap-'));

    // ── 1. The burst ─────────────────────────────────────────────────────────────────────────────────────────────────
    const N = 30_000, HEAP_MB = 256, BURST = 64, ROSTER_N = 20_000;
    console.log(`\n— 1. ${N.toLocaleString('en')} members with photos, a ${HEAP_MB} MB heap, ${BURST} directory reads at once —`);
    const readers = Array.from({ length: BURST + 2 }, newKey);
    const dir = path.join(root, 'burst');
    fs.mkdirSync(dir, { recursive: true });
    const t0 = Date.now();
    await runToEnd('seed', dir, { n: N, readers: readers.map((r) => r.pk), group: ROSTER_N });
    console.log(`  (seeded in ${Date.now() - t0} ms; state.db ${(fs.statSync(path.join(dir, 'state.db')).size / MB).toFixed(0)} MB)`);
    // HEAVY_READ_CAP_ONLY=1c: section 1c alone, its own run in CI (scripts/server-suites.mjs VARIANTS).
    if (process.env.HEAVY_READ_CAP_ONLY === '1c') {
        console.log(`\n— 1c. readers who stop reading, the version moved before each: the directory and a ${ROSTER_N}-member roster —`);
        await stalledAcrossVersions(dir, readers, BURST, HEAP_MB);
        console.log(`\n${passed}/${run} passed`);
        process.exit(passed === run ? 0 : 1);
    }
    // HEAVY_READ_CAP_ONLY=1d: section 1d alone, its own run in CI (scripts/server-suites.mjs VARIANTS).
    if (process.env.HEAVY_READ_CAP_ONLY === '1d') {
        console.log(`\n— 1d. ${STALLED_AT_THE_BOUND} readers of the shared directory who stop reading, more than the budget lets in —`);
        await stalledReaders(dir, readers, BURST, HEAP_MB, [[STALLED_AT_THE_BOUND, false], [STALLED_AT_THE_BOUND, true]]);
        console.log(`\n${passed}/${run} passed`);
        process.exit(passed === run ? 0 : 1);
    }
    const server = await startServer(dir, HEAP_MB);
    const target = { port: server.port, tls: true };
    try {
        await server.ask('peak');
        const b0 = performance.now();
        const burst = await Promise.all(readers.slice(0, BURST).map((r) => open(target, '/api/members', signed('/api/members', r)).done));
        const burstMs = performance.now() - b0;
        await sleep(300);
        const died = server.exited();
        const fatal = server.output().split('\n').filter((l) => /FATAL|heap out of memory|Reached heap limit/.test(l)).slice(0, 2).join(' | ');
        const ok = burst.filter((a) => a.status === 200);
        const busy = burst.filter((a) => a.status === 503);
        const p95 = ok.length ? Math.round(ok.map((a) => a.ms).sort((x, y) => x - y)[Math.ceil(0.95 * ok.length) - 1]) : null;
        console.log(`  (${BURST} at once: ${JSON.stringify(tally(burst))} in ${Math.round(burstMs)} ms; served p95 ${p95} ms)`);
        assert(!died, `the server lives through ${BURST} directory reads at once${died ? `: it died (${fatal || 'no FATAL line'})` : ''}`);
        assert(ok.length + busy.length === BURST, `every reader is answered 200 or 503 (${JSON.stringify(tally(burst))}${burst.some((a) => a.status === 'error') ? `: ${[...new Set(burst.filter((a) => a.status === 'error').map((a) => `${a.error} after ${Math.round(a.ms)} ms, ${a.bytes} bytes`))].slice(0, 4).join('; ')}` : ''})`);
        if (died) {
            // Origin/main ends here: there is no cap to look at.
            console.log(`\n${passed}/${run} passed`);
            process.exit(1);
        }
        const peak = (await server.ask('peak')).peak / MB;
        assert(ok.length >= 1, `some are served (${ok.length} of ${BURST}), and the heap peaked at ${peak.toFixed(0)} MB of ${HEAP_MB} MB`);
        // How many are told "busy" depends on how fast this machine builds and sends: 2 below makes one for certain.
        console.log(`  (${busy.length} of ${BURST} told "busy": more than the budget's worth asked at once)`);
        assert(busy.every(isBusy), `every 503 here says why and when to come back: code heavy_read_busy, Retry-After, no-store, no ETag (${busy.length})`);
        const after = await open(target, '/api/members', signed('/api/members', readers[BURST]), { keep: Infinity }).done;
        let list: any[] = [];
        try { list = JSON.parse(after.text); } catch { /* asserted below */ }
        const seeded = list.filter((m) => /^Heavy\d+$/.test(m.callsign));
        assert(after.status === 200 && seeded.length === N && readers.slice(0, BURST).every((r) => list.some((m) => m.publicKey === r.pk)),
            `afterwards the server answers the whole directory (${after.status}, ${seeded.length} members, ${(after.bytes / MB).toFixed(1)} MB)`);
        assert(seeded.every((m) => new RegExp(`^/api/avatar/${m.publicKey}\\?size=thumb&v=[^&]+&k=[A-Za-z0-9_-]{22}$`).test(m.avatarUrl)),
            `every member has a photo, behind its key, as on the global node (${seeded[0]?.avatarUrl})`);
        assert(ok.every((a) => a.sha === after.sha && a.bytes === after.bytes), 'every 200 in the burst was that same whole directory, byte for byte');

        // The shared directory (members-snapshot.ts; slice 2): 512 at once on the same 256 MB heap, every one served the
        // one snapshot (the design measured its prototype at 512 on the emulated 1 GB droplet: docs/global-heavy-lists.md §5(d)).
        // The readers are 16 processes of 32 (readersAtOnce: one process can't read this many big TLS answers at once). A
        // reader lost to its own process's decryption is counted apart: it says nothing about the server. Anything else
        // that isn't the whole directory (busy, an error, cut off, other bytes) fails.
        const BIG = 512;
        await server.ask('peak');
        const { answers: big, ms: bigMs } = await readersAtOnce(server.port, readers.slice(0, BURST), BIG, 16, dir);
        await sleep(300);
        const bigOk = big.filter((a) => a.status === 200);
        const bigP95 = bigOk.length ? Math.round(bigOk.map((a) => a.ms).sort((x, y) => x - y)[Math.ceil(0.95 * bigOk.length) - 1]) : null;
        const bigPeak = (await server.ask('peak')).peak / MB;
        const clientLost = big.filter((a) => a.status === 'error' && a.error === 'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC');
        const wrong = big.filter((a) => !(a.status === 200 && a.sha === after.sha && a.bytes === after.bytes) && !clientLost.includes(a));
        console.log(`  (${BIG} at once from 16 processes: ${JSON.stringify(tally(big))} in ${Math.round(bigMs)} ms; served p95 ${bigP95} ms; heap peak ${bigPeak.toFixed(0)} MB; ${clientLost.length} lost to a reader process's own TLS decryption)`);
        assert(!server.exited(), `the server lives through ${BIG} directory reads at once`);
        assert(wrong.length === 0, `every one is served the whole directory, byte for byte: none told "busy", none cut off (${bigOk.length} served, ${clientLost.length} lost on the reader's side${wrong.length ? `; wrong: ${[...new Set(wrong.map((a) => `${a.status} ${a.error ?? ''}`))].slice(0, 4).join('; ')}` : ''})`);
        assert(bigOk.length > BURST, `more served at once than the ${BURST} of the burst above (${bigOk.length} of ${BIG})`);
        assert(bigPeak < HEAP_MB * 0.75, `and the heap peaked at ${bigPeak.toFixed(0)} MB of ${HEAP_MB} MB`);

        // ── 2. The gate before the cap ───────────────────────────────────────────────────────────────────────────────
        console.log('\n— 2. the same server: the read gate before the cap; a delta uncapped; readers who stop reading —');
        const stats = async () => (await server.ask('stats')).stats as { inFlightBytes: number; waiting: number; admitted: number; refused: number };
        await until(async () => (await stats()).inFlightBytes === 0, 5000);
        const s0 = await stats();
        assert(s0.inFlightBytes === 0 && s0.waiting === 0, `nothing in flight or waiting once the burst is over (${JSON.stringify(s0)})`);
        const unsigned = await open(target, '/api/members', {}).done;
        const forged = await open(target, '/api/members', signed('/api/members', readers[0], true)).done;
        const stranger = await open(target, '/api/members', signed('/api/members', newKey())).done;
        const s1 = await stats();
        assert(unsigned.status === 401, `an unsigned read is refused by the gate (${unsigned.status})`);
        assert(forged.status === 401 || forged.status === 403, `so is a member's key with a bad signature (${forged.status})`);
        assert(stranger.status === 403 || stranger.status === 401, `and a key that isn't a member here (${stranger.status})`);
        assert(s1.admitted === s0.admitted && s1.refused === s0.refused && s1.inFlightBytes === 0,
            `none of the three reached the cap: nothing taken, nothing refused (${s0.admitted} → ${s1.admitted} admitted)`);
        const delta = await open(target, '/api/members?updatedAfter=2099-01-01T00:00:00.000Z', signed('/api/members?updatedAfter=2099-01-01T00:00:00.000Z', readers[1])).done;
        const s2 = await stats();
        assert(delta.status === 200 && delta.text === '[]' && s2.admitted === s1.admitted, `a delta goes straight through, uncapped (${delta.status} ${delta.text})`);

        // The whole directory is one shared answer now (members-snapshot.ts): a reader of it who stops reading holds only
        // its socket, never budget. A delta from a cursor long past is the whole directory too, built for each read under
        // the cap, so that is the read held here.
        const WHOLE_DELTA = '/api/members?updatedAfter=1970-01-01T00:00:00.000Z';
        const held = open(target, WHOLE_DELTA, signed(WHOLE_DELTA, readers[2]), { hold: true });
        const heldRes = await held.headers;
        const length = Number(heldRes?.headers['content-length']);
        const holding = await until(async () => (await stats()).inFlightBytes === length, 5000);
        const s3 = await stats();
        assert(heldRes?.statusCode === 200 && holding && s3.admitted === s2.admitted + 1,
            `a reader who stops reading holds exactly its answer's size until its last byte is written (${(s3.inFlightBytes / MB).toFixed(1)} MB of ${(length / MB).toFixed(1)} MB)`);
        held.hangUp();
        const gaveBack = await until(async () => (await stats()).inFlightBytes === 0, 5000);
        assert(gaveBack, `and gives it all back when it hangs up mid-answer (${(await stats()).inFlightBytes} bytes in flight)`);

        // The budget filled by readers who stop reading, one after another until the next has to wait: that one is told
        // "busy" when its wait is up (6 s), and the budget comes back when they hang up.
        const holders: Open[] = [];
        for (let i = 0; i < 8 && (await stats()).waiting === 0; i++) {
            const h = open(target, WHOLE_DELTA, signed(WHOLE_DELTA, readers[3 + i]), { hold: true });
            holders.push(h);
            await Promise.race([h.headers, until(async () => (await stats()).waiting > 0, 5000)]);
        }
        const full = await stats();
        const waiter = full.waiting === 1 ? holders.pop()! : null;
        if (!waiter) for (const h of holders) h.hangUp();
        const refused = waiter ? await waiter.done : { status: 'error', headers: {}, bytes: 0, sha: '', text: 'nobody had to wait', ms: 0 } as Answer;
        assert(full.waiting === 1 && holders.length >= 1 && isBusy(refused) && refused.ms >= 5500,
            `with ${holders.length} readers holding ${(full.inFlightBytes / MB).toFixed(1)} MB of the 48 MB budget, the next waits its 6 s and is told "busy" (${refused.status} after ${Math.round(refused.ms)} ms, Retry-After ${refused.headers['retry-after']}, ${refused.text})`);
        for (const h of holders) h.hangUp();
        assert(await until(async () => (await stats()).inFlightBytes === 0, 5000), 'and the holders give the budget back when they hang up');
        const lines = server.output().split('\n').filter((l) => l.includes('Heavy list reads:'));
        const refusals = (await stats()).refused;
        const minutes = Math.ceil((performance.now() - b0) / 60_000);
        assert(lines.length >= 1 && lines.length <= minutes && /\d+ answered "busy" \(503\) in the last minute/.test(lines[0]),
            `the log says it refused: ${lines.length} line(s) for ${refusals} refusals in ${minutes} minute(s) (${stripVTControlCharacters(lines[0] ?? '').trim().slice(0, 200)})`);
        assert(!server.exited(), 'the server still runs');
    } finally {
        await server.stop();
    }

    // ── 1b. Readers of the shared directory who stop reading ───────────────────────────────────────────────────────
    console.log('\n— 1b. the same members, readers of the shared directory who stop reading, from a process of their own —');
    await stalledReaders(dir, readers, BURST, HEAP_MB);

    // ── 1c. The same, with the version moved before each reader: its own run (scripts/server-suites.mjs VARIANTS,
    // HEAVY_READ_CAP_ONLY=1c), since the whole file together passes CI's 300 s per run only on a quiet machine. ──────

    // ── 3. The cap itself ────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 3. the cap itself, on a small server of its own —');
    await theCapItself();

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

/**
 * Section 1d: more readers who stop reading than the budget lets in at once, so that the cap, not the count, is what
 * stops them. 384 is the 48 MB budget over the 128 KB a send was weighed at before #1524, so it is past the bound at
 * that weight or any heavier one.
 */
const STALLED_AT_THE_BOUND = 384;

/** The shared directory's readers who stop reading, on servers of their own (main's section 1b; 1d at the bound). */
async function stalledReaders(dir: string, readers: Key[], BURST: number, HEAP_MB: number,
    cases: readonly (readonly [number, boolean])[] = [[24, false], [48, false], [48, true]]): Promise<void> {
        // Readers of the shared directory who stop reading, from a process of their own, as the deciding review of #1523
        // measured them: before this, each was sent the whole snapshot at once and its socket held about one encrypted
        // copy in native memory (11 MB plain, 2 MB gzip), off the heap, uncapped and with no deadline: 24 plain readers
        // +266 MB of RSS, 48 +532 MB. Now the server's whole memory stays within the cap's budget, and any reader past
        // what the budget allows is told "busy".
        const BUDGET_MB = 48;
        for (const [n, gzip] of cases) {
          // A fresh server for each: memory a process has freed is reused before its RSS grows, so after a burst, or after
          // the case before, RSS hides what readers hold. Its snapshot is built, and the gzip copy made, before the baseline.
          const server = await startServer(dir, HEAP_MB);
          try {
            for (const enc of [{}, { 'Accept-Encoding': 'gzip' }] as Record<string, string>[]) await open({ port: server.port, tls: true }, '/api/members', { ...signed('/api/members', readers[0]), ...enc }).done;
            await sleep(1000);
            // The baseline after a full collection: the builds' garbage, freed later, would hide what the readers hold.
            await server.ask('mem-gc');
            const before = (await server.ask('mem')).mem as { rss: number; heap: number; footprint: number | null };
            const keys = readers.slice(0, BURST).map((r) => ({ pk: r.pk, der: r.priv.export({ type: 'pkcs8', format: 'der' }).toString('hex') }));
            const p = child('stall', dir, { port: server.port, keys, count: n, gzip });
            const said: ((m: any) => void)[] = [];
            readline.createInterface({ input: p.stdout! }).on('line', (line) => { if (line.startsWith('@@ ')) said.shift()?.(JSON.parse(line.slice(3))); });
            const ask = (line: string) => new Promise<any>((r) => { said.push(r); p.stdin!.write(line + '\n'); });
            const got: Answer[] = await ask('report');
            await sleep(3000);
            const after = (await server.ask('mem')).mem as { rss: number; heap: number; footprint: number | null };
            const held = (await server.ask('stats')).stats;
            await ask('bye');
            await new Promise((r) => p.once('exit', r));
            const served = got.filter((a) => a.status === 200).length;
            const busy = got.filter((a) => a.status === 503);
            // RSS, or on macOS the footprint (footprint()).
            const resident = (m: typeof before) => m.footprint ?? m.rss, RSS = before.footprint === null ? 'RSS' : 'footprint';
            const grew = (resident(after) - resident(before)) / MB;
            console.log(`  (${n} ${gzip ? 'gzip' : 'plain'} readers who stop reading: ${served} served, ${busy.length} told "busy"; ${RSS} ${(resident(before) / MB).toFixed(0)} → ${(resident(after) / MB).toFixed(0)} MB (${grew >= 0 ? '+' : ''}${grew.toFixed(0)}), heap ${(after.heap / MB).toFixed(0)} MB, ${(held.inFlightBytes / MB).toFixed(1)} MB counted in flight; ${served ? (grew / served).toFixed(2) : '-'} MB of ${RSS} a send served; RSS ${(before.rss / MB).toFixed(0)} → ${(after.rss / MB).toFixed(0)} MB)`);
            assert(served + busy.length === n && busy.every(isBusy), `${n} ${gzip ? 'gzip' : 'plain'} readers who stop reading: each is served or told "busy" with Retry-After (${served} served, ${busy.length} busy)`);
            assert(grew <= BUDGET_MB, `and the server's ${RSS} grows by no more than the ${BUDGET_MB} MB budget (${grew >= 0 ? '+' : ''}${grew.toFixed(0)} MB)`);
            assert(held.inFlightBytes <= BUDGET_MB * MB, `and what they hold is counted within the budget (${(held.inFlightBytes / MB).toFixed(1)} MB)`);
          } finally {
            await server.stop();
          }
        }

}

/**
 * Readers who stop reading, each on a version of its own (section 1c): the version moved, one whole read (which builds
 * the new snapshot), then a reader who stops reading it, a ready snapshot's send. Once the budget is full, the whole
 * read is told "busy" and the rest are opened together, a version move before each.
 *
 * Memory is read after a full collection, so that it is what is held, not garbage. What the readers hold is the live
 * buffers: every snapshot body is one, and each is counted. RSS is reported too, but on macOS it is a high-water mark: a
 * bare Node process that frees 200 MB of Buffers and collects keeps them in its RSS and phys_footprint, and here nothing
 * of it comes back when every reader hangs up. Each version is a build of its own (a control, the same version moves and
 * whole reads with nobody who stops reading, gives the builds' own growth), and with gzip each body held also keeps
 * about its size of the builds' memory from being reused. So for RSS the check is that it no longer grows with the
 * readers: 48 grow it by no more than 24 did, and the extra connections and bodies served. Before, it grew linearly:
 * +252 MB for 24 plain directory readers, +571 MB for 48.
 */
async function stalledAcrossVersions(dir: string, readers: Key[], BURST: number, HEAP_MB: number): Promise<void> {
    const BUDGET_MB = 48;
    // A send's window over what its weight said before it was built (heavy-reads.ts: a build is weighed at its last size):
    // members-snapshot.ts SNAPSHOT_SEND_WEIGHT.
    const WINDOW_MB = 0.1875;
    // What the connections themselves cost: TLS sockets held open, about 0.17 MB each (the deciding review of #1526: 192
    // readers of one snapshot grew RSS as much as 192 connections with nothing to send).
    const PER_CONNECTION_MB = 0.25;
    type Mem = { rss: number; heap: number; buffers: number };
    // HEAVY_READ_CAP_1C=directory|roster: one half per CI run (each fits the 300 s per run); unset: both.
    const only1c = process.env.HEAVY_READ_CAP_1C;
    for (const what of (['directory', 'roster'] as const).filter((w) => !only1c || w === only1c)) {
        const at24 = new Map<boolean, { grew: number; served: number }>();
        for (const [n, gzip, stalls] of [[48, true, false], [24, false, true], [48, false, true], [24, true, true], [48, true, true]] as const) {
            const server = await startServer(dir, HEAP_MB);
            try {
                const route = what === 'directory' ? '/api/members' : `/api/groups/${(await server.ask('group')).group}/members`;
                const bump = what === 'directory' ? 'bump-members' : 'bump-groups';
                const enc: Record<string, string> = gzip ? { 'Accept-Encoding': 'gzip' } : {};
                let whole = 0;
                const readWhole = async () => open({ port: server.port, tls: true }, route, { ...signed(route, readers[whole++ % BURST]), ...enc }).done;
                const first = await readWhole();
                const size = first.bytes / MB;
                await sleep(1000);
                const before = (await server.ask('mem-gc')).mem as Mem;
                const keys = readers.slice(0, BURST).map((r) => ({ pk: r.pk, der: r.priv.export({ type: 'pkcs8', format: 'der' }).toString('hex') }));
                const p = child('stall1', dir, { port: server.port, keys, route, gzip });
                const said: ((m: any) => void)[] = [];
                readline.createInterface({ input: p.stdout! }).on('line', (line) => { if (line.startsWith('@@ ')) said.shift()?.(JSON.parse(line.slice(3))); });
                const ask = (line: string) => new Promise<any>((r) => { said.push(r); p.stdin!.write(line + '\n'); });
                let full = false;
                const wholeReads: (number | 'error')[] = [];
                for (let i = 0; i < n; i++) {
                    await server.ask(bump);
                    if (!full) {
                        const w = await readWhole();
                        wholeReads.push(w.status);
                        if (w.status !== 200) full = true;
                    }
                    if (!stalls) continue;
                    if (!full && (await ask('open')).status !== 200) full = true;
                    else if (full) await ask('open-nowait');
                }
                const got: Answer[] = await ask('report');
                await sleep(3000);
                const raw = (await server.ask('mem')).mem as Mem;
                const after = (await server.ask('mem-gc')).mem as Mem;
                const held = (await server.ask('stats')).stats;
                await ask('bye');
                await new Promise((r) => p.once('exit', r));
                await until(async () => (await server.ask('stats')).stats.inFlightBytes === 0, 5000);
                const heldAfter = (await server.ask('stats')).stats;
                const grew = (after.rss - before.rss) / MB;
                const wholeLine = `whole reads ${wholeReads.filter((x) => x === 200).length}×200 ${wholeReads.filter((x) => x !== 200).length}×busy`;
                if (!stalls) {
                    console.log(`  (${what}, ${size.toFixed(2)} MB ${gzip ? 'gzip' : 'plain'}, control: ${n} version moves, ${wholeLine}, nobody stops reading; RSS after a full GC ${(before.rss / MB).toFixed(0)} → ${(after.rss / MB).toFixed(0)} MB (+${grew.toFixed(0)}): the builds' own growth)`);
                    assert(wholeReads.every((x) => x === 200) && held.inFlightBytes === 0, `${what}, control: ${n} versions read whole, each served, nothing left in flight (${(held.inFlightBytes / MB).toFixed(1)} MB)`);
                    continue;
                }
                const served = got.filter((a) => a.status === 200).length;
                const busy = got.filter((a) => a.status === 503);
                const buffersGrew = (after.buffers - before.buffers) / MB;
                const allowed = BUDGET_MB + n * PER_CONNECTION_MB;
                console.log(`  (${what}, ${size.toFixed(2)} MB ${gzip ? 'gzip' : 'plain'}, ${n} readers who stop reading, a version each: ${served} served, ${busy.length} told "busy"; ${wholeLine}; `
                    + `RSS after a full GC ${(before.rss / MB).toFixed(0)} → ${(after.rss / MB).toFixed(0)} MB (+${grew.toFixed(0)}; before the GC +${((raw.rss - before.rss) / MB).toFixed(0)}); `
                    + `buffers ${(before.buffers / MB).toFixed(0)} → ${(after.buffers / MB).toFixed(0)} MB; heap ${(after.heap / MB).toFixed(0)} MB; ${(held.inFlightBytes / MB).toFixed(1)} MB counted in flight in ${held.sharedBodies ?? '?'} bodies)`);
                assert(first.status === 200 && served + busy.length === n && busy.every(isBusy),
                    `${what}, ${n} ${gzip ? 'gzip' : 'plain'} readers on ${n} versions: each is served or told "busy" with Retry-After (${served} served, ${busy.length} busy)`);
                assert(held.inFlightBytes <= (BUDGET_MB + WINDOW_MB) * MB && buffersGrew <= allowed + WINDOW_MB,
                    `and every body they hold is counted, within the budget: ${(held.inFlightBytes / MB).toFixed(1)} MB counted, live buffers +${buffersGrew.toFixed(1)} MB (of ${allowed.toFixed(0)} with the connections)`);
                const base = at24.get(gzip);
                if (n === 24) at24.set(gzip, { grew, served });
                else if (base) {
                    // Each extra body served may keep about its size again from being reused (above); 32 MB for noise: a
                    // fresh server's RSS before the readers varies that much (315 and 338 MB measured, the same case).
                    // A 24-reader run whose RSS SHRANK (the OS took pages back: -45 MB on CI, run 37145036026) is no
                    // baseline below zero: it once made the bound -7 MB and failed a 48-reader run that also shrank (-4).
                    const flat = Math.max(0, base.grew) + 24 * PER_CONNECTION_MB + Math.max(0, served - base.served) * size * 2 + 32;
                    assert(grew <= flat, `and the server's RSS no longer grows with the readers: 48 grow it +${grew.toFixed(0)} MB, 24 grew it +${base.grew.toFixed(0)} (at most ${flat.toFixed(0)})`);
                }
                assert(heldAfter.inFlightBytes === 0 && heldAfter.sharedBodies === 0, `and once they hang up nothing is counted or held (${heldAfter.inFlightBytes} bytes, ${heldAfter.sharedBodies} bodies)`);
            } finally {
                await server.stop();
            }
        }
    }
}

async function theCapItself(): Promise<void> {
    const { heavyRead, heavyReadSettings, heavyReadStats, heavyReadWeight, heavyReadKeptKeyCharsForTests, setHeavyReadsForTests } = await import('./heavy-reads.js');
    const { db } = await import('./db/db.js');
    const { initStateEngine } = await import('./state-engine.js');
    const { default: Koa } = await import('koa');
    initStateEngine(); // the schema, so the log's lines land in system_logs

    // GET /?key=K&size=BYTES&tag=T: an answer of BYTES under the cap, weighed as K. &object=ROWS: an array body, as a
    // roster's (its size known only as it is sent). &throw=1: the build throws. &fixed=BYTES: weighed at BYTES, as a
    // ready snapshot's send is (members-snapshot.ts).
    const built: string[] = [];
    const app = new Koa();
    app.silent = true;
    app.use(async (ctx) => {
        const q = ctx.query as Record<string, string>;
        ctx.set('ETag', '"an-answer"');
        await heavyRead(ctx, q.key, () => {
            built.push(q.tag ?? '');
            if (q.throw) throw new Error('the build failed');
            ctx.status = 200;
            if (q.object) { ctx.body = Array.from({ length: Number(q.object) }, (_, i) => ({ row: i, name: `Member ${i}` })); return; }
            ctx.type = 'application/json';
            ctx.body = `"${'x'.repeat(Number(q.size) - 2)}"`;
        }, q.fixed ? Number(q.fixed) : undefined);
    });
    const httpServer = http.createServer(app.callback());
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', () => r()));
    const target = { port: (httpServer.address() as { port: number }).port, tls: false };
    const get = (q: string, o: { hold?: boolean } = {}) => open({ ...target }, `/?${q}`, {}, o);
    const stats = heavyReadStats;
    const inFlight = () => stats().inFlightBytes;
    const free = () => until(() => inFlight() === 0, 3000);
    const BUDGET = 8 * MB;

    try {
        // The budget from the .env: a whole number of MB above 0, else the default (48) with a warning.
        const budgetWith = (value: string | undefined) => {
            if (value === undefined) delete process.env.HEAVY_READ_BUDGET_MB; else process.env.HEAVY_READ_BUDGET_MB = value;
            setHeavyReadsForTests(undefined);
            return heavyReadSettings().budgetBytes / MB;
        };
        const fromEnv = { unset: budgetWith(undefined), empty: budgetWith(''), '96': budgetWith('96'), ' 200 ': budgetWith(' 200 '), '0': budgetWith('0'), lots: budgetWith('lots'), '-5': budgetWith('-5'), '1.5': budgetWith('1.5') };
        budgetWith(undefined);
        assert(JSON.stringify(fromEnv) === JSON.stringify({ unset: 48, empty: 48, '96': 96, ' 200 ': 200, '0': 48, lots: 48, '-5': 48, '1.5': 48 }),
            `HEAVY_READ_BUDGET_MB sets the budget in MB; empty or anything but a whole number above 0 keeps 48 (${JSON.stringify(fromEnv)})`);

        // Weight given back: on finish, on close, on a build that throws.
        setHeavyReadsForTests({ budgetBytes: BUDGET, waitMs: 1500, maxQueue: 3 });
        const one = await get(`key=a&size=${MB}&tag=a`).done;
        assert(one.status === 200 && one.bytes === MB && await free() && stats().admitted === 1,
            `an answer read to its end gives its weight back when its last byte is written (${one.status}, ${inFlight()} in flight)`);
        assert(heavyReadWeight('a') === MB, `and its size is the route's weight from now on (${heavyReadWeight('a')} bytes)`);
        const rows = await get('key=rows&object=20000&tag=rows').done;
        assert(rows.status === 200 && await free() && heavyReadWeight('rows') === rows.bytes,
            `an object body's size is learned as it is sent (${heavyReadWeight('rows')} of ${rows.bytes} bytes)`);

        const big = get(`key=big&size=${24 * MB}&tag=big`, { hold: true });
        await big.headers;
        assert(await until(() => inFlight() === 24 * MB, 3000),
            `an answer three times the budget is served alone, nothing else in flight (${(inFlight() / MB).toFixed(0)} MB in flight)`);
        big.hangUp();
        assert(await free(), `a reader who hangs up mid-answer gives all of it back ('close': ${inFlight()} in flight)`);
        assert(heavyReadWeight('big') === 24 * MB, 'and the size it was is still learned');

        // A key holds its request's inputs in full; what is kept for it must not (r4170590800: 10,000 keys of 42,454
        // characters each held 406 MB). 200 answers under 8,000-character keys keep a digest each, not the key.
        const before = heavyReadKeptKeyCharsForTests();
        for (let i = 0; i < 200; i++) {
            const long = `${i}-${'c'.repeat(8000)}`;
            const r = await get(`key=${long}&size=1000&tag=long`).done;
            if (r.status !== 200) { assert(false, `a long key's answer is served (${r.status})`); break; }
        }
        const kept = heavyReadKeptKeyCharsForTests() - before;
        assert(kept <= 200 * 64 && heavyReadWeight(`7-${'c'.repeat(8000)}`) === 1000,
            `200 answers under 8,000-character keys keep ${kept} characters of keys (a digest each, at most ${200 * 64}), and each key's size is still found`);

        const boom = await get('key=boom&size=1000&throw=1&tag=boom').done;
        assert(boom.status === 500 && built.includes('boom') && await free(), `a build that throws gives its weight back (${boom.status}, ${inFlight()} in flight)`);

        // In order, as weight frees: each 5 MB, room for one in 8 MB.
        setHeavyReadsForTests({ budgetBytes: BUDGET, waitMs: 5000, maxQueue: 3 });
        built.length = 0;
        await get(`key=five&size=${5 * MB}&tag=first`).done;
        const holder = get(`key=five&size=${5 * MB}&tag=H`, { hold: true });
        await holder.headers;
        const waiting: Open[] = [];
        for (const tag of ['A', 'B', 'C']) {
            waiting.push(get(`key=five&size=${5 * MB}&tag=${tag}`));
            await until(() => stats().waiting === waiting.length, 3000);
        }
        assert(stats().waiting === 3 && built.join(',') === 'first,H', `three wait their turn while one holds the budget (${stats().waiting} waiting; built ${built.join(',')})`);
        holder.resume();
        const served = await Promise.all(waiting.map((w) => w.done));
        assert(served.every((a) => a.status === 200 && a.bytes === 5 * MB) && built.join(',') === 'first,H,A,B,C',
            `as weight frees they are let in, in the order they came (built ${built.join(',')}; ${JSON.stringify(tally(served))})`);
        await holder.done;
        assert(await free() && stats().waiting === 0, 'and nothing is left in flight or waiting');

        // Refused after the wait, and at once with the line full.
        setHeavyReadsForTests({ budgetBytes: BUDGET, waitMs: 1500, maxQueue: 2 });
        const logLines = () => (db.prepare(`SELECT COUNT(*) AS n FROM system_logs WHERE message LIKE 'Heavy list reads:%'`).get() as { n: number }).n;
        const linesBefore = logLines();
        built.length = 0;
        await get(`key=five&size=${5 * MB}&tag=first`).done;
        const hold2 = get(`key=five&size=${5 * MB}&tag=H`, { hold: true });
        await hold2.headers;
        const w1 = get(`key=five&size=${5 * MB}&tag=W1`);
        await until(() => stats().waiting === 1, 3000);
        const w2 = get(`key=five&size=${5 * MB}&tag=W2`);
        await until(() => stats().waiting === 2, 3000);
        const full = await get(`key=five&size=${5 * MB}&tag=W3`).done;
        assert(full.status === 503 && full.ms < 1000 && JSON.parse(full.text).code === 'heavy_read_busy',
            `with the line full, the next is told "busy" at once (${full.status} in ${Math.round(full.ms)} ms)`);
        const timedOut = await w1.done;
        const body = JSON.parse(timedOut.text || '{}');
        assert(timedOut.status === 503 && timedOut.ms >= 1400 && body.code === 'heavy_read_busy',
            `one that waited its time is told "busy" (${timedOut.status} after ${Math.round(timedOut.ms)} ms; ${timedOut.text})`);
        const ra = String(timedOut.headers['retry-after']);
        assert(/^\d+$/.test(ra) && Number(ra) >= 10 && Number(ra) <= 30, `with Retry-After: ${ra}`);
        assert(timedOut.headers['cache-control'] === 'no-store' && timedOut.headers.etag === undefined,
            `no-store, and not the ETag the route had set (${timedOut.headers['cache-control']}, ${timedOut.headers.etag})`);
        await w2.done;
        assert(!built.some((t) => t.startsWith('W')) && stats().refused === 3, `none of the refused was built (built ${built.join(',')}; ${stats().refused} refused)`);
        assert(logLines() - linesBefore === 1, `the log got one line for those refusals, not one each (${logLines() - linesBefore})`);

        // A reader who leaves the line.
        const leaver = get(`key=five&size=${5 * MB}&tag=L`);
        await until(() => stats().waiting === 1, 3000);
        leaver.hangUp();
        assert(await until(() => stats().waiting === 0, 3000) && stats().refused === 3,
            `a reader who hangs up while waiting leaves the line, and isn't counted as refused (${stats().waiting} waiting, ${stats().refused} refused)`);

        // A light answer goes straight through, past the line (its route measured first: unmeasured, it would count as a
        // quarter of the budget and wait).
        await get('key=light&size=10000&tag=light-first').done;
        const queued = get(`key=five&size=${5 * MB}&tag=Q`);
        await until(() => stats().waiting === 1, 3000);
        const light = await get('key=light&size=10000&tag=light').done;
        assert(light.status === 200 && light.ms < 1000 && stats().waiting === 1,
            `an answer whose route was last under 512 KB isn't heavy: it goes past the line (${light.status} in ${Math.round(light.ms)} ms, ${stats().waiting} still waiting)`);
        hold2.hangUp();
        const q = await queued.done;
        assert(q.status === 200 && built.includes('L') === false, `and the one waiting is served once the budget frees (${q.status})`);
        assert(await free() && stats().waiting === 0, `nothing is left in flight (${inFlight()}) or waiting (${stats().waiting})`);

        // A deadline on every answer let in: a reader who stops reading is cut off when it is up, so its weight comes
        // back and the one waiting behind it is served. Without it, readers who stop reading held the budget for as long
        // as they kept the connection open (#1492's deciding review: 4 of them, 45 MB of 48 MB, 45 s and more).
        setHeavyReadsForTests(undefined);
        const deadline = heavyReadSettings().deadlineMs;
        assert(deadline === 180_000, `an answer let in has 180 s to be sent, 12 MB at 0.56 Mbit/s (${deadline} ms)`);
        setHeavyReadsForTests({ budgetBytes: BUDGET, waitMs: 5000, maxQueue: 3, deadlineMs: 1500 });
        const cutLines = () => (db.prepare(`SELECT COUNT(*) AS n FROM system_logs WHERE message LIKE 'Heavy list reads:%cut off%'`).get() as { n: number }).n;
        const cutLinesBefore = cutLines();
        built.length = 0;
        await get(`key=stall&size=${7 * MB}&tag=first`).done;
        const stalledAt = performance.now();
        const stalled = get(`key=stall&size=${7 * MB}&tag=S`, { hold: true });
        await stalled.headers;
        const stalling = await until(() => inFlight() === 7 * MB, 3000);
        const behind = get(`key=stall&size=${7 * MB}&tag=B`);
        await until(() => stats().waiting === 1, 3000);
        const cutInTime = await until(() => stats().cutOff === 1, 4500);
        const cutMs = performance.now() - stalledAt;
        assert(stalling && cutInTime && cutMs >= 1400 && cutMs < 4000,
            `a reader who stops reading holds its 7 MB until its 1.5 s are up, and is then cut off (${cutInTime ? `after ${Math.round(cutMs)} ms` : 'still held after 4.5 s'}; ${stats().cutOff} cut off)`);
        const next = await behind.done;
        assert(next.status === 200 && next.bytes === 7 * MB && next.ms < 4500 && built.join(',') === 'first,S,B',
            `its weight comes back, and the one waiting behind it is served before its own 5 s wait is up (${next.status} after ${Math.round(next.ms)} ms; built ${built.join(',')})`);
        // A phone that reads again finds the answer cut short, never a whole one: what was on its way, then the end.
        stalled.resume();
        const cut = await Promise.race([stalled.done, sleep(3000).then(() => null)]);
        assert(cut !== null && cut.status === 'error' && cut.bytes < 7 * MB,
            `the reader cut off, reading again, gets an answer cut short (${cut ? `${cut.status}, ${(cut.bytes / MB).toFixed(1)} of 7 MB` : 'nothing within 3 s'})`);
        assert(cutLines() - cutLinesBefore === 1, `the log says one was cut off (${cutLines() - cutLinesBefore} line)`);
        stalled.hangUp();
        assert(await free() && stats().waiting === 0, `nothing is left in flight (${inFlight()}) or waiting (${stats().waiting})`);

        // A send at a fixed weight (a ready snapshot's, members-snapshot.ts): weighed at that whatever its size, never
        // light and its size never learned; only as many in flight as the budget holds of it, the next told "busy", and
        // one who stops reading cut off at the deadline as any other.
        // The wait (1 s) is up before the deadline (2.5 s) frees anything.
        setHeavyReadsForTests({ budgetBytes: BUDGET, waitMs: 1000, maxQueue: 3, deadlineMs: 2500 });
        const W = 3 * MB;
        const f1 = get(`key=fixed&size=${6 * MB}&fixed=${W}`, { hold: true });
        const f2 = get(`key=fixed&size=${6 * MB}&fixed=${W}`, { hold: true });
        await Promise.all([f1.headers, f2.headers]);
        const twoIn = inFlight();
        const f3 = await get(`key=fixed&size=100&fixed=${W}`).done;
        assert(twoIn === 2 * W && isBusy(f3) && heavyReadWeight('fixed') === undefined,
            `sends at a fixed 3 MB: two hold 6 MB of the 8 MB budget (${(twoIn / MB).toFixed(1)} MB) though each is 6 MB, the third, a 100-byte one, waits and is told "busy" (${f3.status}), and no size is learned (${heavyReadWeight('fixed')})`);
        const cutBoth = await until(() => stats().cutOff === 2, 4000);
        assert(cutBoth && await free(), `and the two who stopped reading are cut off at the deadline, their weight given back (${stats().cutOff} cut off, ${inFlight()} in flight)`);
        f1.hangUp();
        f2.hangUp();
    } finally {
        setHeavyReadsForTests(undefined);
        await new Promise((r) => httpServer.close(r));
    }
}

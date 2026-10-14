#!/usr/bin/env node
/**
 * The heavy lists under concurrency (docs/global-heavy-lists.md): boots the real server (apps/server/dist, NODE_PROFILE
 * =global) on a fresh copy of a seeded data directory, under a given heap, and reads one list with 1, 2, 4 … members at
 * once, each burst a fresh set of signed requests sent together, until the server dies or the burst's p95 passes the
 * stop line. Each level records the answers, their size and latency, and the server's heap, external memory and RSS peaks
 * (scripts/load/heavy-lists-probe.mjs, and /proc for RSS).
 *
 * It refuses to run unless this process cannot reach any other host: run it through scripts/load/fenced.sh, which starts
 * it in a network namespace of its own with only loopback up.
 *
 *   scripts/load/fenced.sh node scripts/load/heavy-lists.mjs --template DIR --work DIR --heap 256 --list members \
 *       --trials 2 --out results.jsonl
 *
 * --cpu N pins the server to one core (the droplet has one vCPU; GC and libuv threads then share it with the event loop).
 * --mem-limit MB holds the server to that much RAM, page cache included, in a memory cgroup of its own (cgroup v1, as
 * root): what is left for it on a droplet after the OS, Docker and cloudflared. Past it the kernel kills it, as the
 * droplet's would.
 *
 * --hold MS makes each reader stop reading for MS after the first bytes (a slow phone): the server then holds every
 * answer in flight, and each level also records the memory half-way through the hold.
 * --expect 200,503 lists the answers that count as served (404 for the crowdfund list on global, where crowdfunds are
 * off; 503 for a server that sheds load): any other answer, or a death, ends the ramp.
 * LOAD_PROTO in the environment reaches the server: with scripts/load/heavy-lists-prototypes.mjs applied to the local
 * build, it switches on one of the design options measured in the doc.
 *
 * --profile DIR does no ramp: it takes V8's sampling heap profile of one read (objects already freed counted too), and a
 * heap snapshot while two readers hold their answers undrained, writes both to DIR, and prints what allocated the most
 * and what keeps each large string alive.
 *
 * Lists: members (GET /api/members, the full directory every phone reads on its first sync and hourly), community
 * (GET /api/community/members, the web app's People, Messages, Marketplace and Ledger pages' directory, built per
 * reader), roster (GET /api/groups/:id/members as one of the big group's convenors), groups (GET /api/groups as the apps
 * send it, 50 a page), groups200 (the same at the most the server gives, limit=200), crowdfund (GET
 * /api/crowdfund/projects?limit=1000 as the native app sends it).
 */
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { memberKey } from './heavy-lists-seed.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SERVER_DIR = path.join(ROOT, 'apps/server');
const PORT_HTTP = 18080, PORT_HTTPS = 18443, PORT_P2P = 14001, PORT_PROBE = 18999;

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]] : acc), []));
const heap = Number(args.heap || 256);
const list = args.list || 'members';
const trials = Number(args.trials || 2);
const firstTrial = Number(args['first-trial'] || 1); // to number a later invocation's trials on from an earlier one's
const levels = (args.levels || '1,2,4,8,12,16,20,24,32,40,48,64,80,96,128,160,192,256').split(',').map(Number);
const stopP95 = Number(args['stop-p95'] || 60_000);
const hold = Number(args.hold || 0); // ms each reader stops reading after the first bytes: a slow phone (socket buffers)
// The answers that count as served (see --expect above).
const expect = new Set(String(args.expect || '200').split(',').map(Number));
const out = args.out;
const cpu = args.cpu;
const memLimitMb = args['mem-limit'] ? Number(args['mem-limit']) : null;
const template = args.template;
const work = args.work;
if (!template || !work || !out) throw new Error('--template, --work and --out are required');

/** This process can reach no other host: a connect to a public address fails at once, and a name resolves to nothing. */
async function assertFenced() {
    const connected = await new Promise((resolve) => {
        const s = net.connect({ host: '192.0.2.1', port: 443, timeout: 2000 }); // TEST-NET-1: routable nowhere, but a route must exist to try
        s.on('connect', () => { s.destroy(); resolve(true); });
        s.on('timeout', () => { s.destroy(); resolve('timeout'); });
        s.on('error', (e) => resolve(e.code));
    });
    let resolved = null;
    try { resolved = await dns.lookup('example.org'); } catch { /* expected */ }
    if (connected !== 'ENETUNREACH' || resolved) throw new Error(`not fenced (connect: ${connected}, dns: ${JSON.stringify(resolved)}); run through scripts/load/fenced.sh`);
}

const readerFor = memberKey;

/** The seeded big group's id (heavy-lists-seed.mjs names it Everyone). */
function bigGroupId() {
    const read = `const D=require('better-sqlite3');const d=new D(${JSON.stringify(path.join(template, 'state.db'))},{readonly:true});process.stdout.write(d.prepare("SELECT id FROM groups WHERE name='Everyone'").get().id)`;
    return execFileSync(process.execPath, ['-e', read], { cwd: SERVER_DIR }).toString();
}

/** A member's signed GET, in the older request format every node takes (the server suites' own). */
function signedGet(route, reader, ip) {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`GET\n${route.split('?')[0]}\n${ts}\n${nonce}\n`), reader.priv).toString('base64');
    return {
        method: 'GET', host: '127.0.0.1', port: PORT_HTTP, path: route, agent: false,
        headers: { 'X-Public-Key': reader.pk, 'X-Signature': sig, 'X-Timestamp': String(ts), 'X-Nonce': nonce, 'CF-Connecting-IP': ip },
    };
}

/** One request, its body counted and dropped: status, bytes, time to first byte and to the end. */
function fire(opts, timeoutMs = 120_000, holdMs = hold) {
    return new Promise((resolve) => {
        const t0 = performance.now();
        let ttfb = null, bytes = 0, first = null, done = false;
        const hash = crypto.createHash('sha256');
        const finish = (r) => { if (!done) { done = true; resolve({ ...r, ms: performance.now() - t0, ttfb, bytes, sha: hash.digest('hex').slice(0, 16) }); } };
        const req = http.request(opts, (res) => {
            ttfb = performance.now() - t0;
            if (holdMs) { res.pause(); setTimeout(() => res.resume(), holdMs); }
            res.on('data', (c) => { bytes += c.length; hash.update(c); if (!first) first = c.subarray(0, 200).toString(); });
            res.on('end', () => finish({ status: res.statusCode, first }));
            res.on('error', (e) => finish({ status: 'error', error: e.code || e.message }));
        });
        req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
        req.on('error', (e) => finish({ status: e.message === 'timeout' ? 'timeout' : 'error', error: e.code || e.message }));
        req.end();
    });
}

const getJson = (port, p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, agent: false }, (res) => {
        let s = '';
        res.on('data', (c) => { s += c; });
        res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null; };
const mb = (b) => (b == null ? null : Math.round((b / 2 ** 20) * 10) / 10);

function rssPeakKb(pid) {
    const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmHWM:\s+(\d+) kB/);
    return m ? Number(m[1]) : null;
}
function resetRssPeak(pid) { try { fs.writeFileSync(`/proc/${pid}/clear_refs`, '5'); } catch { /* not root: the peak is since boot */ } }

/** A memory cgroup (v1) under this process's own, holding `limitMb`; null without a limit. */
function memoryCgroup(limitMb) {
    if (!limitMb) return null;
    const own = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((l) => /:memory:/.test(l))?.split(':')[2];
    if (own === undefined) throw new Error('no cgroup v1 memory controller here');
    const dir = path.join('/sys/fs/cgroup/memory', own, `heavy-lists-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'memory.limit_in_bytes'), String(limitMb * 2 ** 20));
    try { fs.writeFileSync(path.join(dir, 'memory.swappiness'), '0'); } catch { /* no swap here anyway */ }
    return dir;
}

async function boot(dataDir, logFile) {
    const log = fs.createWriteStream(logFile);
    const env = {
        ...process.env,
        BEANPOOL_DATA_DIR: dataDir, TMPDIR: dataDir, NODE_PROFILE: 'global',
        PORT_HTTP: String(PORT_HTTP), PORT_HTTPS: String(PORT_HTTPS), PORT_P2P: String(PORT_P2P), LOAD_PROBE_PORT: String(PORT_PROBE),
        DISABLE_UPDATE_CHECK: 'true',
        // Belt and braces inside the fence: every outside address the server might call is a closed local port.
        DIRECTORY_MIRROR_URL: 'http://127.0.0.1:9/rest/v1/directory_nodes?select=*',
    };
    for (const k of ['ADMIN_PASSWORD', 'CF_RECORD_NAME', 'CF_API_TOKEN', 'CF_ZONE_ID', 'ENFORCE_READ_AUTH', 'NODE_OPTIONS', 'PUBLIC_ADDRESS_AUTO', 'PUBLIC_ADDRESS_NAME', 'BACKUP_PRIMARY_URL']) delete env[k];
    const nodeArgs = [`--max-old-space-size=${heap}`, '--trace-gc', '--import', pathToFileURL(path.join(HERE, 'heavy-lists-probe.mjs')).href, 'dist/index.js'];
    const cg = memoryCgroup(memLimitMb);
    // The shell puts itself in the cgroup, then becomes the server: so the server is in it from its first byte.
    const launch = `${cg ? `echo $$ > ${cg}/cgroup.procs && ` : ''}exec ${cpu !== undefined ? `taskset -c ${cpu} ` : ''}"$0" "$@"`;
    const child = spawn('sh', ['-c', launch, process.execPath, ...nodeArgs], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let dead = false, live = false, tail = '';
    let maxGcMb = 0;
    const onLine = (line) => {
        log.write(line + '\n');
        if (/BeanPool Node is live/.test(line)) live = true;
        if (/FATAL|heap out of memory|Reached heap limit/i.test(line)) tail += line + '\n';
        const gc = line.match(/(?:Mark-Compact|Scavenge|Mark-Compact \(reduce\))[^\d]*([\d.]+) \(([\d.]+)\) ->/);
        if (gc && Number(gc[1]) > maxGcMb) maxGcMb = Number(gc[1]);
    };
    readline.createInterface({ input: child.stdout }).on('line', onLine);
    readline.createInterface({ input: child.stderr }).on('line', onLine);
    let exit = null;
    const exited = new Promise((r) => child.on('exit', (code, signal) => { dead = true; exit = { code, signal }; r(exit); }));
    const t0 = Date.now();
    while (!live && !dead && Date.now() - t0 < 300_000) await sleep(200);
    if (!live) throw new Error(`server did not come up (dead=${dead}); see ${logFile}`);
    for (;;) {
        const r = await fire({ host: '127.0.0.1', port: PORT_HTTP, path: '/api/community/health', agent: false, headers: { 'CF-Connecting-IP': '10.255.255.254' } }, 10_000);
        if (r.status === 200) break;
        if (dead || Date.now() - t0 > 300_000) throw new Error('health never answered');
        await sleep(500);
    }
    return {
        pid: child.pid, bootMs: Date.now() - t0, dead: () => dead, exited, fatal: () => tail, exit: () => exit,
        cgroupPeakMb: () => (cg ? Math.round(Number(fs.readFileSync(path.join(cg, 'memory.max_usage_in_bytes'), 'utf8')) / 2 ** 20) : null),
        cgroupResetPeak: () => { if (cg) fs.writeFileSync(path.join(cg, 'memory.max_usage_in_bytes'), '0'); },
        gcPeakMb: () => { const v = maxGcMb; maxGcMb = 0; return v; },
        stop: async () => {
            if (!dead) { child.kill('SIGTERM'); await Promise.race([exited, sleep(15_000)]); if (!dead) child.kill('SIGKILL'); await exited; }
            log.end();
            if (cg) { await sleep(500); try { fs.rmdirSync(cg); } catch { /* still emptying */ } }
        },
    };
}

function routeFor(name, groupId) {
    if (name === 'members') return '/api/members';
    if (name === 'community') return '/api/community/members';
    if (name === 'roster') return `/api/groups/${groupId}/members`;
    if (name === 'groups') return '/api/groups';
    if (name === 'groups200') return '/api/groups?limit=200';
    if (name === 'crowdfund') return '/api/crowdfund/projects?limit=1000';
    if (name === 'page500') return '/api/members?limit=500'; // one page of a paged directory (LOAD_PROTO=page, heavy-lists-prototypes.mjs)
    throw new Error(`unknown list ${name}`);
}

/** The functions that allocated the most in a sampling heap profile (DevTools' .heapprofile), by self size. */
function topAllocators(profile, n = 12) {
    const byFn = new Map();
    const walk = (node) => {
        const f = node.callFrame;
        const key = `${f.functionName || '(anonymous)'} ${f.url ? `${f.url.replace(/^.*\/(apps|packages|node_modules)\//, '$1/')}:${f.lineNumber + 1}` : ''}`.trim();
        byFn.set(key, (byFn.get(key) || 0) + node.selfSize);
        for (const c of node.children) walk(c);
    };
    walk(profile.head);
    const total = [...byFn.values()].reduce((a, b) => a + b, 0);
    return { totalMb: mb(total), top: [...byFn].sort((a, b) => b[1] - a[1]).slice(0, n).map(([fn, size]) => ({ fn, mb: mb(size), pct: Math.round((size / total) * 100) })) };
}

/** The objects of at least `minBytes` in a heap snapshot, each with the chain of what holds it (nearest first). */
function bigRetained(file, minBytes = 2 ** 20) {
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { node_fields: nf, edge_fields: ef, node_types: [nodeTypes], edge_types: [edgeTypes] } = snap.snapshot.meta;
    const N = nf.length, E = ef.length, nodes = snap.nodes, edges = snap.edges, strings = snap.strings;
    const [nType, nName, nSize, nEdges] = ['type', 'name', 'self_size', 'edge_count'].map((f) => nf.indexOf(f));
    const [eType, eName, eTo] = ['type', 'name_or_index', 'to_node'].map((f) => ef.indexOf(f));
    const retainers = new Map();
    for (let i = 0, e = 0; i < nodes.length; i += N) {
        for (let k = 0; k < nodes[i + nEdges]; k++, e += E) {
            const to = edges[e + eTo];
            const t = edgeTypes[edges[e + eType]];
            if (t === 'weak') continue;
            if (!retainers.has(to)) retainers.set(to, []);
            retainers.get(to).push({ from: i, edge: t === 'element' || t === 'hidden' ? `[${edges[e + eName]}]` : strings[edges[e + eName]] });
        }
    }
    const label = (i) => `${nodeTypes[nodes[i + nType]]}:${String(strings[nodes[i + nName]]).slice(0, 40)}`;
    const out = [];
    for (let i = 0; i < nodes.length; i += N) {
        if (nodes[i + nSize] < minBytes) continue;
        const chain = [];
        let at = i;
        for (let d = 0; d < 8; d++) {
            const r = (retainers.get(at) || []).find((x) => !chain.some((c) => c.from === x.from));
            if (!r) break;
            chain.push({ from: r.from, text: `${r.edge} of ${label(r.from)}` });
            at = r.from;
        }
        out.push({ object: `${nodeTypes[nodes[i + nType]]} ${mb(nodes[i + nSize])} MB`, heldBy: chain.map((c) => c.text) });
    }
    return out;
}

async function profileOnce(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const run = path.join(work, `profile-${list}-${heap}`);
    fs.rmSync(run, { recursive: true, force: true });
    execFileSync('cp', ['-a', template, run]);
    const route = routeFor(list, bigGroupId());
    const server = await boot(run, `${run}.log`);
    try {
        await fire(signedGet(route, readerFor(0), '10.0.0.1')); // warm: compiled statements, the keyer
        await sleep(1000);
        await getJson(PORT_PROBE, '/prof/start');
        const one = await fire(signedGet(route, readerFor(1), '10.0.0.2'));
        await sleep(500);
        const profFile = path.join(dir, `${list}-one-read.heapprofile`);
        await getJson(PORT_PROBE, `/prof/stop?out=${encodeURIComponent(profFile)}`);
        console.log(JSON.stringify({ kind: 'profile', list, heap, status: one.status, bytes: one.bytes, ms: Math.round(one.ms), allocated: topAllocators(JSON.parse(fs.readFileSync(profFile, 'utf8'))) }, null, 1));
        // Two readers that stop reading after the first bytes: what the server keeps for them while they wait.
        const held = [2, 3].map((i) => fire(signedGet(route, readerFor(i), `10.0.0.${i + 1}`), 120_000, 15_000));
        await sleep(4000);
        const snapFile = path.join(dir, `${list}-two-held.heapsnapshot`);
        await getJson(PORT_PROBE, `/snapshot?out=${encodeURIComponent(snapFile)}`);
        console.log(JSON.stringify({ kind: 'snapshot', list, heap, big: bigRetained(snapFile) }, null, 1));
        await Promise.all(held);
    } finally {
        await server.stop();
        fs.rmSync(run, { recursive: true, force: true });
    }
}

async function main() {
    await assertFenced();
    if (args.profile) return profileOnce(args.profile);
    fs.mkdirSync(work, { recursive: true });
    const route = routeFor(list, bigGroupId());
    const readers = Array.from({ length: Math.max(...levels) }, (_, i) => readerFor(i));
    const write = (o) => { fs.appendFileSync(out, JSON.stringify(o) + '\n'); console.log(JSON.stringify(o)); };

    for (let trial = firstTrial; trial < firstTrial + trials; trial++) {
        const dir = path.join(work, `run-${list}-${heap}-${trial}`);
        fs.rmSync(dir, { recursive: true, force: true });
        execFileSync('cp', ['-a', template, dir]);
        const server = await boot(dir, `${dir}.log`);
        await sleep(2000);
        const idle = await getJson(PORT_PROBE, '/mem');
        write({ kind: 'boot', list, heap, memLimitMb, proto: process.env.LOAD_PROTO || null, cpu: cpu ?? null, trial, bootMs: server.bootMs, idleHeapMb: mb(idle.heapUsed), idleRssMb: mb(idle.rss), heapLimitMb: mb(idle.heapLimit) });
        let slowAt = null, diedAt = null, lastOk = null;
        for (const c of levels) {
            await getJson(PORT_PROBE, '/peak');
            server.gcPeakMb();
            resetRssPeak(server.pid);
            server.cgroupResetPeak();
            const reqs = readers.slice(0, c).map((r, i) => signedGet(route, r, `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`));
            const t0 = performance.now();
            const pending = Promise.all(reqs.map((o) => fire(o, 120_000 + hold)));
            // While slow readers hold their answers: what the server holds for them, half-way through.
            let midHold = null;
            if (hold) { await sleep(hold / 2); midHold = await getJson(PORT_PROBE, '/mem').catch(() => null); }
            const results = await pending;
            const wallMs = performance.now() - t0;
            await sleep(300);
            const died = server.dead();
            const statuses = {};
            for (const r of results) statuses[r.status] = (statuses[r.status] || 0) + 1;
            const ok = results.filter((r) => expect.has(r.status));
            const ms = results.map((r) => r.ms);
            const row = {
                kind: 'level', list, heap, memLimitMb, proto: process.env.LOAD_PROTO || null, trial, c, died, statuses, sha: results.find((r) => r.status === 200)?.sha,
                bytes: (results.find((r) => r.status === 200) ?? ok[0] ?? results[0])?.bytes,
                p95served: results.some((r) => r.status === 200) ? Math.round(pct(results.filter((r) => r.status === 200).map((r) => r.ms), 95)) : null, p50: Math.round(pct(ms, 50)), p95: Math.round(pct(ms, 95)), max: Math.round(Math.max(...ms)), wallMs: Math.round(wallMs),
            };
            if (!died) {
                const p = await getJson(PORT_PROBE, '/peak');
                Object.assign(row, { cgroupPeakMb: server.cgroupPeakMb(), heapPeakMb: mb(p.heapUsed), gcPeakMb: server.gcPeakMb(), externalPeakMb: mb(p.external), arrayBuffersPeakMb: mb(p.arrayBuffers), rssPeakMb: Math.round((rssPeakKb(server.pid) ?? 0) / 1024), loopMaxMs: Math.round(p.loopMaxMs) });
            } else {
                await Promise.race([server.exited, sleep(5000)]);
                row.fatal = server.fatal().split('\n').filter(Boolean).slice(0, 2).join(' | ');
                row.exit = server.exit();
                row.gcPeakMb = server.gcPeakMb();
            }
            if (c === 1 && ok[0]) row.sample = ok[0].first;
            if (midHold) Object.assign(row, { hold, midHoldHeapMb: mb(midHold.heapUsed), midHoldArrayBuffersMb: mb(midHold.arrayBuffers), midHoldRssMb: mb(midHold.rss) });
            write(row);
            if (died) { diedAt = c; break; }
            if (row.p95 > 5000 && slowAt === null) slowAt = c;
            if (ok.length === c && row.p95 <= 5000) lastOk = c;
            if (row.p95 > stopP95 || ok.length < c) break;
            await sleep(1500);
        }
        write({ kind: 'trial', list, heap, memLimitMb, proto: process.env.LOAD_PROTO || null, trial, lastOkUnder5s: lastOk, firstOver5s: slowAt, diedAt });
        await server.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

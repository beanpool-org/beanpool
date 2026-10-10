/**
 * What the /api gzip (api-compression.ts) costs: latency and the server's CPU for a 1 MB and a 26 MB JSON answer, sent
 * plain (main before it, and any reader that doesn't ask) and gzipped, and zlib's levels on the same bodies.
 *
 * The server is a child process: a Koa app with the real middleware in front of one route that answers a JSON object,
 * as the listing routes do (Koa serializes it). Its CPU is read from the child (process.cpuUsage covers zlib's pool
 * threads too) before and after each series, so the client's own reading isn't in it. The rows are shaped like a sync
 * page's (ids, a member's key, a title and a ~200-character description, a place, photo URLs); their random keys and
 * hashes compress worse than real text, so the ratio here is on the low side of the load test's 6.3× (26.6 → 4.2 MB).
 *
 * Run: node --import tsx src/bench-api-compression.ts
 */
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';

const WORDS = ('sourdough bread eggs honey firewood bike repair tutoring lawn mowing childcare vegetables seedlings tomatoes '
    + 'pumpkins carpentry plumbing lift ride to town sewing mending fresh organic local free swap help wanted offer need '
    + 'weekend morning afternoon garden tools ladder trailer compost manure chickens goats milk cheese jam preserves '
    + 'lessons guitar piano maths english Spanish 手作り 野菜 ขนมปัง community hall market stall Saturday').split(' ');

function words(rand: () => number, n: number): string {
    return Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' ');
}

/** About `bytes` of JSON rows shaped like a sync page's, the same every run. */
export function rows(bytes: number): object[] {
    let seed = 42;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    const hex = (n: number) => crypto.createHash('sha256').update(String(rand())).digest('hex').slice(0, n);
    const out: object[] = [];
    let size = 2;
    while (size < bytes) {
        const author = hex(64);
        const at = new Date(Date.UTC(2026, 8, 1) + Math.floor(rand() * 40 * 86_400_000)).toISOString();
        const row = {
            id: crypto.randomUUID(), type: rand() < 0.7 ? 'offer' : 'need', category: ['food', 'services', 'goods', 'skills'][Math.floor(rand() * 4)],
            title: words(rand, 3 + Math.floor(rand() * 4)), description: words(rand, 30 + Math.floor(rand() * 10)),
            credits: Math.floor(rand() * 50), priceType: 'fixed', status: 'active', authorPublicKey: author,
            authorCallsign: `member${Math.floor(rand() * 20000)}`, authorAvatarUrl: `/api/avatar/${author}?v=${hex(12)}`,
            lat: Number((rand() * 140 - 70).toFixed(4)), lng: Number((rand() * 360 - 180).toFixed(4)),
            photos: Array.from({ length: 1 + Math.floor(rand() * 3) }, () => `/api/photos/${hex(32)}.jpg`),
            createdAt: at, updatedAt: at, authorTrades: Math.floor(rand() * 30), active: true, repeatable: rand() < 0.2,
        };
        size += JSON.stringify(row).length + 1;
        out.push(row);
    }
    return out;
}

async function serve(): Promise<void> {
    const { default: Koa } = await import('koa');
    const { apiCompression } = await import('./api-compression.js');
    const bodies: Record<string, object[]> = { '1mb': rows(1_000_000), '26mb': rows(26_600_000) };
    const loop = monitorEventLoopDelay({ resolution: 5 });
    loop.enable();
    const app = new Koa();
    app.use(apiCompression());
    app.use(async (ctx) => {
        if (ctx.path === '/cpu') {
            const c = process.cpuUsage();
            ctx.body = JSON.stringify({ us: c.user + c.system, loopMaxMs: loop.max / 1e6, loopP99Ms: loop.percentile(99) / 1e6 });
            loop.reset();
            return;
        }
        const body = bodies[ctx.path.replace('/api/', '')];
        if (!body) { ctx.status = 404; return; }
        ctx.set('ETag', 'W/"bench"');
        ctx.body = body;
    });
    const server = app.listen(0, '127.0.0.1', () => process.send!({ port: (server.address() as any).port }));
}

function get(port: number, path: string, gzip: boolean): Promise<{ ms: number; bytes: number; text: string }> {
    const t0 = performance.now();
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path, agent: false, headers: gzip ? { 'Accept-Encoding': 'gzip' } : {} }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
                const b = Buffer.concat(chunks);
                resolve({ ms: performance.now() - t0, bytes: b.length, text: path === '/cpu' ? b.toString() : '' });
            });
        }).on('error', reject);
    });
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const load = () => os.loadavg().map((x) => x.toFixed(2)).join(' ');

async function main(): Promise<void> {
    if (process.argv[2] === 'serve') return serve();
    console.log(`Node ${process.version}, ${os.cpus()[0]?.model}, ${os.cpus().length} cores. Load average at start: ${load()}\n`);

    console.log('zlib levels (gzipSync, best of 3, this process):');
    for (const [name, size] of [['1 MB', 1_000_000], ['26 MB', 26_600_000]] as const) {
        const raw = Buffer.from(JSON.stringify(rows(size)));
        for (const level of [1, 4, 6, 9]) {
            let best = Infinity, out = 0;
            for (let i = 0; i < 3; i++) { const t = performance.now(); out = gzipSync(raw, { level }).length; best = Math.min(best, performance.now() - t); }
            console.log(`  ${name} (${(raw.length / 1e6).toFixed(2)} MB raw) level ${level}: ${(out / 1e6).toFixed(3)} MB (${(raw.length / out).toFixed(2)}×), ${best.toFixed(1)} ms`);
        }
    }

    const child = fork(fileURLToPath(import.meta.url), ['serve'], { execArgv: process.execArgv });
    const port: number = await new Promise((r) => child.once('message', (m: any) => r(m.port)));
    const cpu = async () => JSON.parse((await get(port, '/cpu', false)).text) as { us: number; loopMaxMs: number; loopP99Ms: number };

    const { GZIP_LEVEL } = await import('./api-compression.js');
    console.log(`\nThrough the middleware at level ${GZIP_LEVEL} (sequential requests over loopback; server CPU from the child):`);
    console.log('| answer | sent | n | wire MB | p50 ms | p99 ms | server CPU ms / answer | event loop max ms | load 1m |');
    console.log('|---|---|---|---|---|---|---|---|---|');
    for (const [path, n] of [['/api/1mb', 100], ['/api/26mb', 30]] as const) {
        for (const gzip of [false, true]) {
            for (let i = 0; i < 2; i++) await get(port, path, gzip);
            const before = await cpu();
            const ms: number[] = [];
            let bytes = 0;
            for (let i = 0; i < n; i++) { const r = await get(port, path, gzip); ms.push(r.ms); bytes = r.bytes; }
            const after = await cpu();
            console.log(`| ${path.slice(5)} | ${gzip ? 'gzip' : 'plain (main)'} | ${n} | ${(bytes / 1e6).toFixed(2)} | ${pct(ms, 50).toFixed(1)} | ${pct(ms, 99).toFixed(1)} `
                + `| ${((after.us - before.us) / 1000 / n).toFixed(1)} | ${after.loopMaxMs.toFixed(1)} | ${os.loadavg()[0].toFixed(2)} |`);
        }
    }
    child.kill();
    console.log(`\nLoad average at end: ${load()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

/**
 * What an idle TLS connection keeps after a large answer (#1746, tls-send-window.ts), through the real node: its HTTPS
 * listener and every middleware, the pricing guide (a public read) seeded to about 1.5 MB of JSON.
 *
 *  1. No write handed to a TLS connection is larger than the 64 KB window (and the headers beside it), for the answer
 *     plain and gzipped. Before, the whole answer went in one write, and the TLS layer kept a buffer its size with the
 *     connection until it closed. A count, not a size in MB: it doesn't move with the machine or its load.
 *  2. The memory an idle keep-alive connection holds after reading that answer whole is a small multiple of what it
 *     holds after a 1 KB answer (Node's and OpenSSL's own state for an open TLS connection), not the answer's size. A
 *     ratio measured on the same server in the same run, of the memory outside the JS heap, so neither the machine nor
 *     its load moves it (#1740's lesson: an absolute RSS on CI is). Readers are a process of their own.
 *
 * On origin/main both fail: one write of the whole answer, and ~15× the light connection's memory (1.6 MB against
 * 0.11 MB a connection, Node 26 on a Mac).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-tls-send-window.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import { execFileSync, fork } from 'node:child_process';
import crypto from 'node:crypto';
import tls from 'node:tls';
import v8 from 'node:v8';
import vm from 'node:vm';

const MB = 1024 * 1024;
const WINDOW = 64 * 1024;
const HEADERS_ALLOWANCE = 8 * 1024;
const READERS = Number(process.env.TLS_SEND_WINDOW_READERS || 256);
const HEAVY_PATH = '/api/pricing-guide';
const LIGHT_PATH = '/api/pricing-guide?q=no-such-item-anywhere';

/** A reader process: `count` connections, each reads one whole answer of `path`, then stays open and idle. */
async function reader(): Promise<void> {
    const port = Number(process.env.TLS_SEND_WINDOW_PORT);
    const socks: tls.TLSSocket[] = [];
    // Each connection its own address, forwarded from loopback (a trusted proxy: client-ip.ts), so the pricing guide's
    // 15 a minute for an address (auth-rate-limit.ts) counts each reader once.
    let readers = 0;
    const readOne = (path: string, encoding: string) => new Promise<number>((resolve, reject) => {
        const s = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false });
        socks.push(s);
        let head = Buffer.alloc(0);
        let want = -1;
        let got = 0;
        const n = ++readers;
        const from = `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
        s.on('secureConnect', () => s.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: ${encoding}\r\nConnection: keep-alive\r\nX-Forwarded-For: ${from}\r\n\r\n`));
        s.on('data', (d: Buffer) => {
            if (want === -2) return;
            if (want < 0) {
                head = Buffer.concat([head, d]);
                const at = head.indexOf('\r\n\r\n');
                if (at < 0) return;
                const lines = head.subarray(0, at).toString();
                const length = /\r\ncontent-length:\s*(\d+)/i.exec(lines);
                if (!/^HTTP\/1\.1 200/.test(lines) || !length) return reject(new Error(`not a 200 with a length: ${lines.split('\r\n')[0]}`));
                want = Number(length[1]);
                got = head.length - at - 4;
            } else got += d.length;
            if (got >= want) { const n = want; want = -2; resolve(n); }
        });
        s.on('error', reject);
    });
    // A reader who stops reading: it takes the headers and the first bytes, then reads no more and keeps the connection.
    const stallOne = (path: string, encoding: string) => new Promise<void>((resolve, reject) => {
        const s = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false });
        socks.push(s);
        const n = ++readers;
        const from = `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
        s.on('secureConnect', () => s.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: ${encoding}\r\nConnection: keep-alive\r\nX-Forwarded-For: ${from}\r\n\r\n`));
        s.once('data', () => { s.pause(); resolve(); });
        s.on('error', reject);
    });
    process.on('message', async (m: { path: string; encoding: string; count: number; stall?: boolean } | 'close') => {
        if (m !== 'close' && m.stall) {
            try {
                await Promise.all(Array.from({ length: m.count }, () => stallOne(m.path, m.encoding)));
                process.send!({ open: m.count });
            } catch (e) {
                process.send!({ error: String(e) });
            }
            return;
        }
        if (m === 'close') {
            for (const s of socks) s.destroy();
            socks.length = 0;
            process.send!({ closed: true });
            return;
        }
        try {
            let bytes = 0;
            // A few at a time, so what the server holds while it builds answers is gone before it is measured.
            for (let i = 0; i < m.count; i += 8) {
                const sizes = await Promise.all(Array.from({ length: Math.min(8, m.count - i) }, () => readOne(m.path, m.encoding)));
                bytes = sizes[0];
            }
            process.send!({ open: m.count, bytes });
        } catch (e) {
            process.send!({ error: String(e) });
        }
    });
    process.send!('ready');
}

let failures = 0;
let checks = 0;
function assert(ok: boolean, what: string): void {
    checks++;
    console.log(`  ${ok ? '✅' : '❌'} ${what}`);
    if (!ok) failures++;
}

/** A Mac's live malloc for this process, in bytes: the ALLOCATED column of vmmap's MALLOC ZONE total. */
function liveMalloc(): number {
    const v = execFileSync('vmmap', ['-summary', String(process.pid)], { encoding: 'utf8', maxBuffer: 64 * MB });
    const t = /TOTAL\s+\S+\s+\S+\s+\S+\s+\S+\s+\d+\s+([\d.]+)([KMG])/.exec(v.slice(v.lastIndexOf('MALLOC ZONE')));
    if (!t) throw new Error('vmmap printed no MALLOC ZONE total');
    return Number(t[1]) * { K: 1024, M: MB, G: 1024 * MB }[t[2] as 'K' | 'M' | 'G'];
}

async function main(): Promise<void> {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const svl: any = await import('./server-limits.js');
    // Idle connections stay open while they are measured, whatever the time the measuring takes.
    svl.setServerLimitsForTests({ keepAliveTimeoutMs: 600_000 });

    const { initTls } = await import('./services/tls.js');
    const se: any = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } = await import('./config/local-config.js');
    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 1_000_000 } });

    // About 1.5 MB of JSON that gzip can't make small: 1,500 items with 1,000 characters of hex each.
    const insert = db.prepare(`INSERT INTO pricing_guide_items (id, category, emoji, name, description, price_beans, unit, is_pinned, confidence_count, trend, updated_at)
                               VALUES (?, 'food', '🥕', ?, ?, 5, 'each', 0, 0, 'stable', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
    db.transaction(() => {
        for (let i = 0; i < 1500; i++) insert.run(`item-${i}`, `Item ${i}`, crypto.randomBytes(500).toString('hex'));
    })();

    // Every write the server makes to a TLS connection, its size: the largest per connection, for section 1.
    const serverSide = (s: any) => !!(s?._tlsOptions?.isServer);
    const largest = new Map<object, number>();
    const proto: any = tls.TLSSocket.prototype;
    const write1 = proto._write;
    const writev = proto._writev;
    const note = (s: object, n: number) => { if (serverSide(s)) largest.set(s, Math.max(largest.get(s) ?? 0, n)); };
    proto._write = function (chunk: any, encoding: any, cb: any) { note(this, Buffer.byteLength(chunk, encoding)); return write1.call(this, chunk, encoding, cb); };
    proto._writev = function (chunks: { chunk: any; encoding: any }[], cb: any) {
        note(this, chunks.reduce((n, c) => n + Buffer.byteLength(c.chunk, c.encoding), 0));
        return writev.call(this, chunks, cb);
    };

    const child = fork(new URL(import.meta.url).pathname, [], { env: { ...process.env, TLS_SEND_WINDOW_ROLE: 'reader', TLS_SEND_WINDOW_PORT: String(port) } });
    await new Promise((r) => child.once('message', r));
    const ask = <T>(m: unknown) => new Promise<T>((resolve) => { child.once('message', (a) => resolve(a as T)); child.send(m as any); });

    try {
        console.log('\n— 1. no write to a TLS connection larger than the window, for a ~1.5 MB answer —');
        for (const encoding of ['identity', 'gzip']) {
            largest.clear();
            const a = await ask<{ open?: number; bytes?: number; error?: string }>({ path: HEAVY_PATH, encoding, count: 2 });
            await ask('close');
            const most = Math.max(0, ...largest.values());
            console.log(`  (${encoding}: a ${((a.bytes ?? 0) / MB).toFixed(2)} MB answer, the largest write ${(most / 1024).toFixed(0)} KB, over ${largest.size} connections)`);
            assert(!a.error && (a.bytes ?? 0) > 8 * WINDOW, `${encoding}: the answer is many windows long (${a.error ?? `${a.bytes} bytes`})`);
            assert(most > 0 && most <= WINDOW + HEADERS_ALLOWANCE, `${encoding}: the largest write to a TLS connection is at most the 64 KB window and its headers (${most} bytes)`);
        }
        proto._write = write1;
        proto._writev = writev;

        // Readers who stop reading after the first bytes: what the window holds for each beyond the answer's own body is
        // at most one window and its headers, by the middleware's own count (tlsSendWindowStats), not the RSS. The most
        // ahead is over every window handed out in this suite, the whole reads above included.
        console.log('\n— 1b. readers who stop reading: at most one window ahead of the TLS layer —');
        const { tlsSendWindowStats } = await import('./tls-send-window.js');
        for (const encoding of ['identity', 'gzip']) {
            const STALLED = 8;
            const a = await ask<{ open?: number; error?: string }>({ path: HEAVY_PATH, encoding, count: STALLED, stall: true });
            await new Promise((r) => setTimeout(r, 1000));
            const st = tlsSendWindowStats();
            await ask('close');
            await new Promise((r) => setTimeout(r, 300));
            console.log(`  (${encoding}: ${STALLED} readers stopped, ${st.sends} sends still in flight, ${st.aheadBytes} bytes ahead of the TLS layer in all; the most one send held ahead ${st.mostAheadBytes} bytes)`);
            assert(!a.error, `${encoding}: ${STALLED} readers took the first bytes and stopped (${a.error ?? 'ok'})`);
            assert(st.aheadBytes <= st.sends * (WINDOW + HEADERS_ALLOWANCE) && st.mostAheadBytes <= WINDOW + HEADERS_ALLOWANCE,
                `${encoding}: each send holds at most one window and its headers ahead of the TLS layer (${st.aheadBytes} bytes over ${st.sends} sends; at most ${st.mostAheadBytes} in one)`);
        }
        assert(tlsSendWindowStats().sends === 0, `every windowed send is let go once its reader hangs up (${tlsSendWindowStats().sends} left)`);

        console.log(`\n— 2. what ${READERS} idle keep-alive connections hold after a ~1.5 MB answer, against after a light one —`);
        // The memory outside the JS heap: on Linux the RSS less the heap; on a Mac, whose RSS keeps pages already freed until
        // the system wants them back, what malloc holds live (vmmap), which the RSS there is not.
        const offHeap = () => { gc(); gc(); const m = process.memoryUsage(); return { rss: m.rss, offHeap: process.platform === 'darwin' ? liveMalloc() : m.rss - m.heapTotal }; };
        const held = async (path: string) => {
            const before = offHeap();
            const a = await ask<{ open?: number; bytes?: number; error?: string }>({ path, encoding: 'identity', count: READERS });
            await new Promise((r) => setTimeout(r, 200));
            const after = offHeap();
            await ask('close');
            await new Promise((r) => setTimeout(r, 500));
            const per = (after.offHeap - before.offHeap) / READERS;
            console.log(`  (${path}: ${a.error ?? `${a.open} open, ${((a.bytes ?? 0) / 1024).toFixed(0)} KB each`}; RSS ${(before.rss / MB).toFixed(0)} → ${(after.rss / MB).toFixed(0)} MB, outside the heap +${((after.offHeap - before.offHeap) / MB).toFixed(1)} MB, ${(per / 1024).toFixed(1)} KB a connection)`);
            return { per, error: a.error };
        };
        // Once each first, unmeasured: what the server allocates once (pools, caches, the heap's size) is then there
        // before either is measured, so neither is charged for it.
        await held(HEAVY_PATH);
        await held(LIGHT_PATH);
        const light = await held(LIGHT_PATH);
        const heavy = await held(HEAVY_PATH);
        const ratio = heavy.per / Math.max(light.per, 1024);
        console.log(`  (a connection after the heavy answer holds ${ratio.toFixed(1)}× one after the light answer)`);
        assert(!light.error && !heavy.error, 'every reader read its whole answer');
        // Only a Mac measures live malloc (vmmap). On Linux the measure is RSS − heap, and glibc reuses the warm-up's freed pages, so
        // the ratio can come out negative and would pass without measuring anything (#1775 review, finding 2): there it is printed,
        // and section 1 (the largest TLS write, a count) is the check.
        if (process.platform === 'darwin') {
            assert(!light.error && !heavy.error && ratio < 5, `an idle connection after a ~1.5 MB answer holds under 5× one after a light answer, not the answer's size (${ratio.toFixed(1)}×)`);
        } else {
            console.log(`  (not asserted on ${process.platform}: the memory measure is only sound on a Mac; section 1 is the check here)`);
        }
    } finally {
        child.kill();
    }

    console.log(`\n${checks - failures}/${checks} passed`);
    process.exit(failures ? 1 : 0);
}

if (process.env.TLS_SEND_WINDOW_ROLE === 'reader') reader();
else main().catch((e) => { console.error(e); process.exit(1); });

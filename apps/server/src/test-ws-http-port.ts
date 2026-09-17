/**
 * WebSocket upgrades on the plain HTTP port (the Cloudflare tunnel's origin).
 *
 * cloudflared sends everything to http://beanpool-node:8080. HTTP requests there are delegated to
 * the HTTPS Koa app, but the upgrade handler used to be attached to the HTTPS server only, so a
 * /ws upgrade through the tunnel fell through to Koa and got a 404 — tunnel-mode nodes had no live
 * updates. This suite starts both servers (HTTP first, as index.ts does) and checks that both ports
 * give the same answer for every upgrade path:
 *
 *   /ws           → 101, and a broadcast reaches the socket
 *   /ws (ENFORCE_WS_AUTH=true) unsigned → 401, validly signed → 101
 *   /ws/logs      without admin auth → 401; with a valid ticket → 101
 *   anything else → socket destroyed, no response
 *
 * ENFORCE_WS_AUTH is a module const read at import, so run it once per value:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-ws-http-port.ts
 *   ENFORCE_WS_AUTH=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-ws-http-port.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import net from 'node:net';
import WebSocket from 'ws';
import { initTls } from './services/tls.js';
import { initStateEngine, broadcast } from './state-engine.js';
import { startHttpServer } from './http-server.js';
import { startHttpsServer } from './https-server.js';
import { issueWsTicket } from './admin-auth.js';
import { db } from './db/db.js';

const ENFORCE_WS_AUTH = process.env.ENFORCE_WS_AUTH === 'true';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address() as net.AddressInfo;
            s.close(() => resolve(port));
        });
    });
}

function makeMember(callsign: string) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pubKeyHex, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
    return { pubKeyHex, privateKey };
}

function signedWsQuery(id: { pubKeyHex: string; privateKey: crypto.KeyObject }): string {
    const ts = Date.now(), nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.privateKey).toString('base64');
    return `pubkey=${id.pubKeyHex}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
}

type Outcome =
    | { kind: 'open'; ws: WebSocket; events: any[] }
    | { kind: 'status'; status: number }
    | { kind: 'destroyed'; error: string };

/** Attempt an upgrade and report what the server did with it. */
function upgrade(url: string, headers: Record<string, string> = {}): Promise<Outcome> {
    return new Promise((resolve) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false, headers });
        const events: any[] = [];
        let settled = false;
        const done = (o: Outcome) => { if (!settled) { settled = true; resolve(o); } };
        ws.on('message', (d) => { try { events.push(JSON.parse(d.toString())); } catch { /* */ } });
        ws.on('open', () => done({ kind: 'open', ws, events }));
        ws.on('unexpected-response', (_req, res) => {
            done({ kind: 'status', status: res.statusCode || 0 });
            res.resume();
            ws.terminate();
        });
        ws.on('error', (e) => done({ kind: 'destroyed', error: e.message }));
        setTimeout(() => done({ kind: 'destroyed', error: 'timeout' }), 3000);
    });
}

function describe(o: Outcome): string {
    return o.kind === 'open' ? '101' : o.kind === 'status' ? String(o.status) : `destroyed (${o.error})`;
}

async function main() {
    console.log(`Running WebSocket-on-both-ports tests (ENFORCE_WS_AUTH=${ENFORCE_WS_AUTH})...\n`);
    await initTls();
    initStateEngine();

    const httpPort = await freePort();
    const httpsPort = await freePort();
    // Same order as index.ts: the HTTP server exists before the HTTPS app it delegates to.
    await startHttpServer(httpPort);
    await startHttpsServer(httpsPort);

    const ports = [
        { name: 'HTTP (tunnel origin)', base: `ws://localhost:${httpPort}` },
        { name: 'HTTPS', base: `wss://localhost:${httpsPort}` },
    ];
    // What cloudflared adds to a proxied request.
    const tunnelHeaders = { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '203.0.113.7' };
    const member = makeMember('Listener');

    for (const p of ports) {
        console.log(`\n— ${p.name} —`);

        // /ws: the member's live feed.
        const query = ENFORCE_WS_AUTH ? `?${signedWsQuery(member)}` : '';
        const feed = await upgrade(`${p.base}/ws${query}`, tunnelHeaders);
        assert(feed.kind === 'open', `${p.name}: /ws${ENFORCE_WS_AUTH ? ' (signed)' : ''} upgrade → 101 (got ${describe(feed)})`);
        if (feed.kind === 'open') {
            await sleep(100);
            assert(feed.events.some(e => e.type === 'state_snapshot'), `${p.name}: /ws sends the initial state_snapshot`);
            feed.events.length = 0;
            const marker = crypto.randomBytes(6).toString('hex');
            broadcast({ type: 'test_ping', marker });
            await sleep(200);
            assert(feed.events.some(e => e.type === 'test_ping' && e.marker === marker), `${p.name}: a broadcast reaches the /ws socket`);
            feed.ws.close();
        }

        if (ENFORCE_WS_AUTH) {
            const unsigned = await upgrade(`${p.base}/ws`, tunnelHeaders);
            assert(unsigned.kind === 'status' && unsigned.status === 401, `${p.name}: unsigned /ws under ENFORCE_WS_AUTH → 401 (got ${describe(unsigned)})`);
            if (unsigned.kind === 'open') unsigned.ws.close();

            // A replayed connect token must not be reusable on the other port either.
            const q = signedWsQuery(member);
            const first = await upgrade(`${p.base}/ws?${q}`);
            if (first.kind === 'open') first.ws.close();
            const other = ports.find(o => o !== p)!;
            const replay = await upgrade(`${other.base}/ws?${q}`);
            assert(replay.kind === 'status' && replay.status === 401, `${p.name}: a connect token used here is refused on ${other.name} (got ${describe(replay)})`);
            if (replay.kind === 'open') replay.ws.close();
        }

        // /ws/logs: admin only.
        const logsNoAuth = await upgrade(`${p.base}/ws/logs`, tunnelHeaders);
        assert(logsNoAuth.kind === 'status' && logsNoAuth.status === 401, `${p.name}: /ws/logs without admin auth → 401 (got ${describe(logsNoAuth)})`);
        if (logsNoAuth.kind === 'open') logsNoAuth.ws.close();

        const logsBadTicket = await upgrade(`${p.base}/ws/logs?ticket=${'0'.repeat(64)}`, tunnelHeaders);
        assert(logsBadTicket.kind === 'status' && logsBadTicket.status === 401, `${p.name}: /ws/logs with a made-up ticket → 401 (got ${describe(logsBadTicket)})`);
        if (logsBadTicket.kind === 'open') logsBadTicket.ws.close();

        const logsTicket = await upgrade(`${p.base}/ws/logs?ticket=${issueWsTicket()}`, tunnelHeaders);
        assert(logsTicket.kind === 'open', `${p.name}: /ws/logs with a valid admin ticket → 101 (got ${describe(logsTicket)})`);
        if (logsTicket.kind === 'open') logsTicket.ws.close();

        // Anything else: the socket is destroyed without a response.
        for (const bad of ['/nope', '/api/version', '/ws/other', '/']) {
            const o = await upgrade(`${p.base}${bad}`, tunnelHeaders);
            assert(o.kind === 'destroyed', `${p.name}: upgrade on ${bad} → destroyed (got ${describe(o)})`);
            if (o.kind === 'open') o.ws.close();
        }
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ WebSocket-on-both-ports checks PASSED.');
}
main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });

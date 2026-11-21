/**
 * Who may tell this server a visitor's address (security inventory 17 Nov 2026, risk 5).
 *
 * Docker's port proxy hands an IPv6 visitor on to an IPv4-only container FROM the bridge gateway, and a neighbouring
 * container on beanpool-shared sits on one of this container's private subnets. client-ip.ts trusted both as "our proxy",
 * so either could name a fresh address per request in CF-Connecting-IP / X-Forwarded-For: past every per-address limit
 * and the admin address allowlist. Now only loopback (cloudflared run inside this container), TRUSTED_PROXIES by address,
 * and with TRUSTED_PROXIES=docker-host the gateway (a tunnel or web server on the host, ports published on 127.0.0.1)
 * are believed; Cloudflare's edge for CF-Connecting-IP only, as before.
 *
 *   1. The class, by source: every server file that reads a socket's address or a header that names a client is in
 *      READERS below with the rule it keeps. Everything else reads the address through client-ip.ts (clientIp,
 *      clientLimiterKey). A new reader fails here until it is added, and gets a row in 2 if it decides anything.
 *   2. The table, through the real listeners (the plain listener's test hook gives each accepted socket the remote address
 *      of the row): from the gateway with a forged address, each sink keys on the gateway by default and on the forged
 *      address only with docker-host; a neighbour, a public peer (direct mode) and loopback (the tunnel in this container)
 *      are the same either way.
 *
 * The gateway is taken from one of this machine's own private subnets where it has one (as it is in a container), so on
 * code that trusted those subnets the rows fail here as they would on a node.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-client-ip-trust.ts
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const dataDir = fs.mkdtempSync(path.join(process.env.BEANPOOL_DATA_DIR || process.env.TMPDIR || os.tmpdir(), 'client-ip-trust-'));
process.env.BEANPOOL_DATA_DIR = dataDir;
for (const k of ['CF_RECORD_NAME', 'CF_API_TOKEN', 'CF_ZONE_ID', 'NODE_ROLE', 'PUBLIC_IP', 'TRUSTED_PROXIES', 'BEANPOOL_ADDRESSES']) delete process.env[k];

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = '') {
    if (ok) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── 1. The class, by source ──────────────────────────────────────────────────────────────────────────────────────────
console.log('\n1. Every server file that reads a client address itself is listed with its rule');
/** File (under apps/server/src) → the rule it keeps; the rows in 2 that prove it. */
const READERS: Record<string, string> = {
    'client-ip.ts': 'the resolver: forwarding headers only from isTrustedProxy (loopback, TRUSTED_PROXIES, docker-host) and CF-Connecting-IP from Cloudflare\'s edge',
    'https-server.ts': 'the live-updates upgrade and the dashboard label call resolveClientIp; every request\'s ctx.request.ip is clientIp(ctx) (rows: socket, allowlist)',
    'http-server.ts': 'cf-connecting-ip only routes a request on to the HTTPS app, which resolves the address itself; the tests\' socket hook',
    'plain-http-gate.ts': 'a tunnel\'s or proxy\'s claim only from isTrustedProxy; the hall only by direct-lan.ts (row: plain port)',
    'direct-lan.ts': 'the hall and the APK: a private source that is not a default gateway, with no proxy header at all (row: hall)',
    'forwarded-host.ts': 'the scheme a request reached: X-Forwarded-Proto or Forwarded: proto= only from isTrustedProxy, by the socket\'s address (test-forwarded-host.ts)',
    // agent/mcp-route.ts read the socket's address to decide whether to believe X-Forwarded-Host; it now reads Koa's ctx.host,
    // which believes X-Forwarded-Host from no one (forwarded-host.ts, test-forwarded-host.ts; row: assistant metadata).
};
const ADDRESS_READ = /\bremoteAddress\b|\bctx\.(?:request\.)?ips?\b|\breq(?:uest)?\.ips?\b|['"`](?:x-forwarded-for|x-real-ip|cf-connecting-ip|cf-connecting-ipv6|true-client-ip|x-client-ip|forwarded)['"`]/i;
const withoutComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
function serverSources(dir: string, rel = ''): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') out.push(...serverSources(path.join(dir, e.name), r)); continue; }
        if (!e.name.endsWith('.ts') || e.name.endsWith('.d.ts') || /^test-|\.test\.ts$|-test-helper\.ts$/.test(e.name)) continue;
        out.push(r);
    }
    return out;
}
{
    const sources = serverSources(HERE);
    check('the scan sees the server\'s sources', sources.length > 100 && sources.includes('client-ip.ts'), String(sources.length));
    const readers = sources.filter((f) => ADDRESS_READ.test(withoutComments(fs.readFileSync(path.join(HERE, f), 'utf8'))));
    const unlisted = readers.filter((f) => !READERS[f]);
    check('no file reads a socket address or a client-address header outside the listed readers', unlisted.length === 0,
        `unlisted: ${unlisted.join(', ')} (read it through client-ip.ts clientIp/clientLimiterKey, or list it here with its rule and a row below)`);
    const gone = Object.keys(READERS).filter((f) => !readers.includes(f));
    check('every listed reader still reads one (the list is not stale)', gone.length === 0, `no longer reading: ${gone.join(', ')}`);
}

// ── 2. The table, through the real listeners ─────────────────────────────────────────────────────────────────────────
const tlsMod = await import('./services/tls.js');
const se = await import('./state-engine.js');
const { startHttpServer, _setPlainConnectionHookForTests } = await import('./http-server.js');
const { startHttpsServer } = await import('./https-server.js');
const { updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } = await import('./config/local-config.js');
const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
const { resolveClientIp, isTrustedProxy, standsForMany, setTrustConfigForTests } = await import('./client-ip.js');
const { _setDefaultGatewaysForTests } = await import('./default-gateways.js');
const { isDirectLanRequest } = await import('./direct-lan.js');

await tlsMod.initTls();
se.initStateEngine();
const httpPort = await startHttpServer(0);
await startHttpsServer(0);

/** A private subnet of this machine (a container's docker network), and its first address as the bridge gateway. */
function gatewayAndNeighbour(): { gateway: string; neighbour: string; onOwnSubnet: boolean } {
    for (const i of Object.values(os.networkInterfaces()).flat()) {
        if (!i || i.internal || i.family !== 'IPv4' || !i.cidr || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)) continue;
        const bits = Number(i.cidr.split('/')[1]);
        if (!(bits >= 8 && bits <= 29)) continue;
        const n = i.address.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
        const base = (n & (bits === 32 ? 0xffffffff : (~0 << (32 - bits)))) >>> 0;
        const ip = (x: number) => [x >>> 24, (x >>> 16) & 255, (x >>> 8) & 255, x & 255].join('.');
        const pick = (k: number) => (base + k === n ? base + k + 1 : base + k);
        return { gateway: ip(pick(1)), neighbour: ip(pick(4)), onOwnSubnet: true };
    }
    return { gateway: '172.18.0.1', neighbour: '172.18.0.5', onOwnSubnet: false };
}
const { gateway: GATEWAY, neighbour: NEIGHBOUR, onOwnSubnet } = gatewayAndNeighbour();
_setDefaultGatewaysForTests([GATEWAY]);
console.log(`\n2. The table (gateway ${GATEWAY}${onOwnSubnet ? ', on this machine\'s own private subnet' : ', no private subnet here'}; neighbour ${NEIGHBOUR})`);

/** The remote address the plain listener's next accepted sockets get (null: the real loopback one). */
let fakeRemote: string | null = null;
_setPlainConnectionHookForTests((socket) => {
    if (fakeRemote !== null) Object.defineProperty(socket, 'remoteAddress', { value: fakeRemote, configurable: true });
});
const BASE = `http://127.0.0.1:${httpPort}`;
/** One GET on a socket of its own (agent: false), so the hook gives it the row's address; fetch would reuse a socket. */
function get(from: string | null, p: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
    fakeRemote = from;
    return new Promise((resolve, reject) => {
        const req = http.request(`${BASE}${p}`, { method: 'GET', headers, agent: false }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (d) => { text += d; });
            res.on('end', () => {
                let body: any = text;
                try { body = JSON.parse(text); } catch { /* not JSON */ }
                resolve({ status: res.statusCode ?? 0, body });
            });
        });
        req.setTimeout(10_000, () => req.destroy(new Error('timed out')));
        req.on('error', reject);
        req.end();
    });
}
/** A live-updates socket's first answer line through the plain listener (it hands upgrades on to the HTTPS app). */
function upgrade(from: string, headers: Record<string, string>): Promise<number> {
    fakeRemote = from;
    return new Promise((resolve, reject) => {
        const sock = net.connect(httpPort, '127.0.0.1');
        let data = '';
        sock.setTimeout(10_000, () => { sock.destroy(); reject(new Error('timed out')); });
        sock.on('data', (d) => { data += d.toString('latin1'); if (data.includes('\r\n')) sock.destroy(); });
        sock.on('error', () => { /* destroyed after the first line */ });
        sock.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0)));
        sock.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n`
            + `Sec-WebSocket-Key: ${Buffer.from('0123456789abcdef').toString('base64')}\r\n`
            + Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n');
    });
}
/** What a forged hop says: a fresh address per request, as an attacker would send it. */
const forged = (i: number) => ({ 'cf-connecting-ip': `203.0.113.${i + 1}`, 'x-forwarded-for': `198.51.100.${i + 1}` });
const LIMIT = 5;
const limited = { ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: true, maxRequestsPerMinute: LIMIT } };
const unlimited = { ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: LIMIT } };

/** TRUSTED_PROXIES as an operator sets it; the gateway limiter starts empty. (The name and invite checks have no reset: each
 *  mode's rows use keys no earlier row filled.) */
function trusting(entries: string | null) {
    if (entries === null) delete process.env.TRUSTED_PROXIES; else process.env.TRUSTED_PROXIES = entries;
    setTrustConfigForTests(undefined);
    resetGatewayRateLimit();
}
/** One GET to the plain listener over a raw socket (fetch won't send a Host of our choosing): its status. */
function rawStatus(from: string, p: string, headers: Record<string, string>): Promise<number> {
    fakeRemote = from;
    return new Promise((resolve, reject) => {
        const sock = net.connect(httpPort, '127.0.0.1');
        let data = '';
        sock.setTimeout(10_000, () => { sock.destroy(); reject(new Error('timed out')); });
        sock.on('data', (d) => { data += d.toString('latin1'); });
        sock.on('error', reject);
        sock.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0)));
        sock.write(`GET ${p} HTTP/1.1\r\n` + Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('') + 'Connection: close\r\n\r\n');
    });
}
async function statuses(n: number, make: (i: number) => Promise<number>): Promise<number[]> {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(await make(i));
    return out;
}

for (const mode of ['TRUSTED_PROXIES empty (every node as it starts)', 'TRUSTED_PROXIES=docker-host'] as const) {
    const host = mode.endsWith('docker-host');
    console.log(`\n— ${mode} —`);
    trusting(host ? 'docker-host' : null);

    // resolver rows: who is believed at all
    check(`resolver: the gateway with a forged CF-Connecting-IP is ${host ? 'believed' : 'its own address'}`,
        resolveClientIp(GATEWAY, forged(0)) === (host ? '203.0.113.1' : GATEWAY), resolveClientIp(GATEWAY, forged(0)));
    check('resolver: …written ::ffff:-mapped, the same', resolveClientIp(`::ffff:${GATEWAY}`, forged(0)) === (host ? '203.0.113.1' : GATEWAY));
    check('resolver: a neighbour on the same private subnet is never believed', !isTrustedProxy(NEIGHBOUR) && resolveClientIp(NEIGHBOUR, forged(0)) === NEIGHBOUR);
    check('resolver: a unique-local IPv6 neighbour is never believed', resolveClientIp('fd00::7', forged(0)) === 'fd00::7');
    check('resolver: a public peer (direct mode) is its own address', resolveClientIp('192.0.2.44', forged(0)) === '192.0.2.44');
    check('resolver: loopback (the tunnel in this container) is believed', resolveClientIp('127.0.0.1', forged(0)) === '203.0.113.1');
    check('resolver: Cloudflare\'s edge (proxied direct mode) for CF-Connecting-IP only', resolveClientIp('162.158.1.1', forged(0)) === '203.0.113.1'
        && resolveClientIp('162.158.1.1', { 'x-forwarded-for': '198.51.100.1' }) === '162.158.1.1');
    check('standsForMany (Settings\' "same network"): the gateway stands for many', standsForMany(GATEWAY));
    check('hall and APK (direct-lan.ts): the gateway is never the hall Wi-Fi', !isDirectLanRequest({ remoteAddress: GATEWAY, headers: { host: '192.168.1.10' } }));

    // gateway limiter (gateway-rate-limit.ts), through both listeners
    updateGatewayConfig(limited);
    trusting(host ? 'docker-host' : null);
    {
        const s = await statuses(LIMIT + 1, async (i) => (await get(GATEWAY, '/api/gateway-limit-probe', forged(i))).status);
        check(host ? `gateway limiter: ${LIMIT + 1} forwarded visitors are ${LIMIT + 1} buckets (no 429)` : `gateway limiter: a fresh forged address per request from the gateway still meets 429 on ${LIMIT + 1}`,
            host ? !s.includes(429) : s[LIMIT] === 429, s.join(','));
    }
    trusting(host ? 'docker-host' : null);
    {
        const s = await statuses(LIMIT + 1, async (i) => (await get(NEIGHBOUR, '/api/gateway-limit-probe', forged(i))).status);
        check(`gateway limiter: a neighbour's forged addresses meet 429 on ${LIMIT + 1}`, s[LIMIT] === 429, s.join(','));
    }
    trusting(host ? 'docker-host' : null);
    {
        const s = await statuses(LIMIT + 1, async () => (await get('192.0.2.44', '/api/gateway-limit-probe')).status);
        check(`gateway limiter, direct mode unchanged: one public address meets 429 on ${LIMIT + 1}`, s.slice(0, LIMIT).every((x) => x !== 429) && s[LIMIT] === 429, s.join(','));
    }
    trusting(host ? 'docker-host' : null);
    {
        const s = await statuses(LIMIT + 1, (i) => upgrade(GATEWAY, forged(i)));
        check(host ? 'live-updates sockets: forwarded visitors each have their own bucket' : `live-updates sockets: forged addresses from the gateway meet 429 on ${LIMIT + 1}`,
            host ? !s.includes(429) : s[LIMIT] === 429, s.join(','));
    }

    // auth-attempt limiter (auth-rate-limit.ts, the name check: 15 a minute) and the invite check (30 a minute)
    updateGatewayConfig(unlimited);
    trusting(host ? 'docker-host' : null);
    {
        const s = await statuses(16, async (i) => (await get(GATEWAY, `/api/members/callsign-available/nobody${i}`, forged(i))).status);
        check(host ? 'name check: 16 forwarded visitors are not one bucket' : 'name check: forged addresses from the gateway meet 429 on 16',
            host ? !s.includes(429) : s[15] === 429, s.join(','));
    }
    trusting(host ? 'docker-host' : null);
    {
        const s = await statuses(31, async (i) => (await get(GATEWAY, `/api/invite/check?code=x${i}`, forged(i))).status);
        check(host ? 'invite check: 31 forwarded visitors are not one bucket' : 'invite check: forged addresses from the gateway meet 429 on 31',
            host ? !s.includes(429) : s[30] === 429, s.slice(-3).join(','));
    }

    // admin address allowlist (https-server.ts)
    trusting(host ? 'docker-host' : null);
    {
        const ADMIN = '/api/local/dashboard';
        updateGatewayConfig({ ...unlimited, adminIpAllowlist: ['203.0.113.1'] });
        const named = await get(GATEWAY, ADMIN, forged(0));
        check(host ? 'admin allowlist: the forwarded visitor 203.0.113.1 is the one matched' : 'admin allowlist: the gateway naming the allowed 203.0.113.1 is refused',
            host ? named.status !== 403 : named.status === 403, String(named.status));
        const neighbour = await get(NEIGHBOUR, ADMIN, forged(0));
        check('admin allowlist: a neighbour naming the allowed address is refused', neighbour.status === 403, String(neighbour.status));
        updateGatewayConfig({ ...unlimited, adminIpAllowlist: [GATEWAY] });
        const own = await get(GATEWAY, ADMIN, forged(0));
        check(host ? 'admin allowlist: listing the gateway admits no forwarded visitor' : 'admin allowlist: the gateway is matched by its own address',
            host ? own.status === 403 : own.status !== 403, String(own.status));
        updateGatewayConfig(unlimited);
    }

    // the assistant door's metadata (agent/mcp-route.ts): X-Forwarded-Host from no one, a trusted proxy included (Cloudflare
    // passes a visitor's on through the tunnel: forwarded-host.ts); the host named is the Host header the request carried
    trusting(host ? 'docker-host' : null);
    {
        const meta = await get(GATEWAY, '/.well-known/oauth-authorization-server', { ...forged(0), 'x-forwarded-host': 'elsewhere.example' });
        const issuer = String(meta.body?.issuer ?? '');
        check(host ? 'assistant metadata: X-Forwarded-Host from the trusted host moves nothing either' : 'assistant metadata: X-Forwarded-Host from the gateway moves nothing',
            meta.status === 200 && !!issuer && !issuer.includes('elsewhere.example'), `${meta.status} ${issuer}`);
    }
}

// the plain port (plain-http-gate.ts), on a server that holds a certificate of its own
console.log('\n— the plain port, with a certificate of its own —');
{
    const OWN = 'beans.example.org';
    process.env.BEANPOOL_ADDRESSES = OWN;
    const made = selfsigned.generate([{ name: 'commonName', value: OWN }], {
        days: 30, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: OWN }] }],
    });
    check('the test certificate is served', tlsMod.serveCertificate(OWN, { cert: made.cert, key: made.private }) === null);
    check('the server now holds a certificate of its own', tlsMod.holdsOwnCertificate(() => [OWN]));
    const plain = (from: string, hostHeader: string, extra: Record<string, string> = {}) => rawStatus(from, '/api/version', { Host: hostHeader, ...extra });
    const TUNNEL_NAME = 'riverside.beanpool.org';
    trusting(null);
    let s = await plain(GATEWAY, TUNNEL_NAME);
    check('the gateway naming a beanpool.org host is redirected', s === 301, String(s));
    s = await plain(GATEWAY, OWN, { 'X-Forwarded-Proto': 'https' });
    check('the gateway saying X-Forwarded-Proto: https is redirected', s === 301, String(s));
    s = await plain(NEIGHBOUR, TUNNEL_NAME);
    check('a neighbour naming a beanpool.org host is redirected', s === 301, String(s));
    s = await plain('127.0.0.1', TUNNEL_NAME);
    check('loopback (the tunnel in this container) is served', s === 200, String(s));
    trusting('docker-host');
    s = await plain(GATEWAY, TUNNEL_NAME);
    check('with docker-host: the host\'s tunnel naming a beanpool.org host is served', s === 200, String(s));
    s = await plain(NEIGHBOUR, TUNNEL_NAME);
    check('with docker-host: a neighbour is still redirected', s === 301, String(s));
    trusting(null);
}

_setPlainConnectionHookForTests(null);
_setDefaultGatewaysForTests(null);
setTrustConfigForTests(undefined);
updateGatewayConfig(DEFAULT_GATEWAY_CONFIG);
console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

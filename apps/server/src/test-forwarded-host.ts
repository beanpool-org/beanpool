/**
 * The host and the scheme a request reached (security inventory 17 Nov 2026, risk 5, split off from #3293).
 *
 * Koa's `app.proxy = true` took ctx.host / ctx.origin from X-Forwarded-Host and ctx.protocol / ctx.secure (and each cookie's
 * Secure flag) from X-Forwarded-Proto, from ANY peer. forwarded-host.ts now holds the one rule for every Koa app this server
 * makes: the Host header the request carried, from everyone (X-Forwarded-Host from no one: Cloudflare passes a visitor's on
 * through our tunnel untouched), and https from a TLS socket, or from a proxy this server trusts (client-ip.ts isTrustedProxy)
 * that says so.
 *
 *   1. The class, by source: every server file that reads a request's host or scheme (Koa's ctx.host, hostname, protocol,
 *      secure, origin, href, URL, subdomains; a Host, :authority, X-Forwarded-* or Forwarded header) is in READERS below,
 *      with how many reads and what a forged header could do there. A new read, in a new file or a listed one, fails here
 *      until it is listed; a read that went away fails too, so the list can't go stale. Only the rule itself, the plain
 *      port's gate and the hall's test read a forwarding header. No `app.proxy = true`, and every Koa app takes the rule.
 *   2. The table, through the real listeners (the plain listener's test hook gives each accepted socket the row's address):
 *      a forged X-Forwarded-Host changes nothing from anyone; a forged X-Forwarded-Proto changes nothing from an untrusted
 *      peer, and from the tunnel in this container (loopback) or, with TRUSTED_PROXIES=docker-host, the host's tunnel, it
 *      does. Three sinks: the assistant door's issuer (host), the Apple probe's redirect address (scheme and host), the
 *      Settings sign-in cookie's Secure flag (scheme).
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-forwarded-host.ts
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const dataDir = fs.mkdtempSync(path.join(process.env.BEANPOOL_DATA_DIR || process.env.TMPDIR || os.tmpdir(), 'forwarded-host-'));
process.env.BEANPOOL_DATA_DIR = dataDir;
for (const k of ['CF_RECORD_NAME', 'CF_API_TOKEN', 'CF_ZONE_ID', 'NODE_ROLE', 'PUBLIC_IP', 'TRUSTED_PROXIES', 'BEANPOOL_ADDRESSES', 'APPLE_PROBE_REDIRECT_URI']) delete process.env[k];
// The Apple probe (routes/apple-probe.ts) is mounted only with this set: an anonymous page that prints scheme and host.
process.env.APPLE_PROBE = '1';

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = '') {
    if (ok) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── 1. The class, by source ──────────────────────────────────────────────────────────────────────────────────────────
console.log('\n1. Every server file that reads a request\'s host or scheme is listed, with what a forged header could do there');
/**
 * File (under apps/server/src) → how many reads the scan finds in it, and the rule. "Before" is #3293's code, where Koa's
 * app.proxy believed X-Forwarded-Host and X-Forwarded-Proto from any peer; "now" is forwarded-host.ts's rule.
 */
const READERS: Record<string, { reads: number; rule: string }> = {
    'forwarded-host.ts': { reads: 2, rule: 'the rule: X-Forwarded-Proto and Forwarded: proto= only from isTrustedProxy on a plain socket; X-Forwarded-Host never' },
    'plain-http-gate.ts': { reads: 7, rule: 'the plain port\'s gate (#3293): the Host header, and https claimed only from isTrustedProxy (saysHttpsBefore, shared with the rule); unchanged' },
    'direct-lan.ts': { reads: 6, rule: 'the hall and the APK: ANY forwarding header means not the hall; the Host header must name a local-network host; unchanged' },
    'client-ip.ts': { reads: 1, rule: 'a Forwarded header from an untrusted peer marks it as a forwarder (the address rule, #3293); names no host or scheme' },
    'https-server.ts': { reads: 1, rule: '/trust on the HTTPS app (ctx.hostname): before, a forged X-Forwarded-Host chose CA file or app page for the forger\'s own answer (the CA is public); now the Host' },
    'http-server.ts': { reads: 3, rule: 'the plain app\'s trust page and /trust (ctx.host, ctx.hostname): that app never had app.proxy, so the Host before and now; it now takes the rule too' },
    'agent/mcp-route.ts': { reads: 1, rule: 'the assistant door\'s issuer, resource and sign-in address (ctx.host): before, X-Forwarded-Host from isTrustedProxy, so through our tunnel a visitor could have a node with no public address name any host to them; with one, only a listed address. Now the Host (row: issuer)' },
    'routes/apple-probe.ts': { reads: 2, rule: 'the Apple probe (APPLE_PROBE=1 only): before, any peer chose the scheme and host of the redirect address on its own page; now the Host and the rule\'s scheme (row: probe)' },
    'routes/backup.ts': { reads: 4, rule: 'enrolment\'s primaryUrl (ctx.protocol, ctx.host: before, raw X-Forwarded-Host/Proto from ANY peer, not even app.proxy), the pairing code and the restore unlock address (ctx.origin): an admin\'s or owner\'s own request, answered to them; now the rule' },
    'routes/owner-unlock.ts': { reads: 1, rule: 'the take-over unlock address (ctx.origin), when the owner\'s browser names none: the owner\'s own request; now the rule' },
    'routes/check-page.ts': { reads: 1, rule: '/check names the host asked only when it is one of this community\'s own (audienceStanding), never stored (no-store); before a forged host could pick another own one; now the Host' },
    'routes/forum-public.ts': { reads: 1, rule: 'the open forum\'s "open in the app" address (ctx.origin) on a node with no public address, on a page a shared cache may keep 60 s (s-maxage): before, any peer\'s forged host and scheme could be handed to the next visitors; now the rule' },
    'routes/peek.ts': { reads: 1, rule: 'a peek page\'s origin when the card names no host (ctx.origin), no-store: the forger\'s own page; now the rule' },
    'routes/web-push.ts': { reads: 1, rule: 'the push contact for the subscription a member is making (ctx.host): their own subscription; now the Host' },
    'routes/knocks.ts': { reads: 1, rule: 'addressed here (ctx.request.host) for a home-network or unconfigured host: before, through our tunnel, X-Forwarded-Host could make a knock signed for another server look addressed here; now the Host Cloudflare routed by' },
    'routes/node-claim.ts': { reads: 1, rule: 'a claim signed for a home-network or unconfigured host must name the host reached (ctx.request.host): the same as knocks; now the Host' },
    'routes/marketplace.ts': { reads: 2, rule: 'a standing deal\'s signed host for a home-network or unconfigured host (requestHost, engine/standing-deals.ts hostIsOurs): the same as knocks; now the Host' },
    'storage/s3-image-store.ts': { reads: 1, rule: 'an outgoing request to the S3 store (its own Host header), not a request this server answers' },
    'storage/s3-sigv4.ts': { reads: 1, rule: 'an outgoing request to the S3 store (signs its Host header), not a request this server answers' },
};
/** Files that may read a forwarding header (X-Forwarded-*, Forwarded) themselves: everyone else asks Koa's ctx.host / ctx.protocol. */
const READS_FORWARDING = new Set(['forwarded-host.ts', 'plain-http-gate.ts', 'direct-lan.ts', 'client-ip.ts']);
/** Koa's host and scheme getters, read off a context or a request (case matters: ctx.url is the path, not URL). */
const PROPERTY_READ = /\b(?:ctx|context|koaCtx)(?:\s+as\s+any\))?\??\.(?:request\??\.)?(?:host|hostname|protocol|secure|origin|href|URL|subdomains)\b|\.request\??\.(?:host|hostname|protocol|secure|origin|href|URL|subdomains)\b/g;
/** The headers that name them. */
const HEADER_READ = /\bheaders?\??\.host\b|\bheaders?\??\[\s*['"`](?:host|:authority)['"`]\s*\]|\.get\(\s*['"`](?:host|:authority)['"`]/gi;
const FORWARDING_READ = /\bheaders?\??\.forwarded\b|['"`](?:x-forwarded-(?:host|proto|port|prefix|server|ssl|scheme)|forwarded|x-url-scheme|front-end-https)['"`]/gi;

// Comments out by TypeScript's own parser and printer: a regex or a string holding "/*" or "//" can't hide code from it.
const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
const printer = ts.createPrinter({ removeComments: true });
const codeOf = (file: string) => printer.printFile(ts.createSourceFile(file, fs.readFileSync(path.join(HERE, file), 'utf8'), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS));
function serverSources(dir: string, rel = ''): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') out.push(...serverSources(path.join(dir, e.name), r)); continue; }
        // Tests, and the harnesses and helpers only tests import (a harness's Koa app of its own serves only its suite).
        if (!e.name.endsWith('.ts') || e.name.endsWith('.d.ts') || /^test-|\.test\.ts$|-test-(?:helper|harness)\.ts$/.test(e.name)) continue;
        out.push(r);
    }
    return out;
}
{
    const sources = serverSources(HERE);
    check('the scan sees the server\'s sources', sources.length > 100 && sources.includes('https-server.ts') && sources.includes('routes/backup.ts'), String(sources.length));
    const found = new Map<string, { reads: number; forwarding: number; koa: boolean; useRule: boolean; proxyOn: boolean }>();
    for (const f of sources) {
        const code = codeOf(f);
        const forwarding = (code.match(FORWARDING_READ) ?? []).length;
        const reads = (code.match(PROPERTY_READ) ?? []).length + (code.match(HEADER_READ) ?? []).length + forwarding;
        found.set(f, { reads, forwarding, koa: /\bnew\s+Koa\s*\(/.test(code), useRule: /\buseOwnHostAndScheme\s*\(/.test(code), proxyOn: /\.proxy\s*=\s*true\b/.test(code) });
    }
    check('the parser keeps the code a comment-stripper by pattern lost (https-server.ts: its /trust reader)', (found.get('https-server.ts')?.reads ?? 0) >= 1, String(found.get('https-server.ts')?.reads));
    const readers = [...found].filter(([, v]) => v.reads > 0).map(([f]) => f);
    const unlisted = readers.filter((f) => !READERS[f]);
    check('no file reads a request\'s host or scheme outside the listed readers', unlisted.length === 0,
        `unlisted: ${unlisted.map((f) => `${f} (${found.get(f)!.reads})`).join(', ')} (read it through ctx.host / ctx.protocol, or list it here with what a forged header could do there)`);
    const moved = Object.entries(READERS).filter(([f, r]) => readers.includes(f) && found.get(f)!.reads !== r.reads);
    check('each listed reader reads as many times as listed (a new read in a listed file is listed too)', moved.length === 0,
        moved.map(([f, r]) => `${f}: ${found.get(f)!.reads}, listed ${r.reads}`).join('; '));
    const gone = Object.keys(READERS).filter((f) => !readers.includes(f));
    check('every listed reader still reads one (the list is not stale)', gone.length === 0, `no longer reading: ${gone.join(', ')}`);
    const ownForwarding = [...found].filter(([f, v]) => v.forwarding > 0 && !READS_FORWARDING.has(f)).map(([f]) => f);
    check('only the rule, the plain port\'s gate, the hall\'s test and the address rule read a forwarding header themselves', ownForwarding.length === 0, ownForwarding.join(', '));
    const proxyOn = [...found].filter(([, v]) => v.proxyOn).map(([f]) => f);
    check('no Koa app turns app.proxy on', proxyOn.length === 0, proxyOn.join(', '));
    // bench-api-compression.ts times gzip on a Koa app of its own, in a child process; it never serves anyone.
    const withoutRule = [...found].filter(([f, v]) => v.koa && !v.useRule && f !== 'bench-api-compression.ts').map(([f]) => f);
    check('every Koa app the server makes takes the rule (useOwnHostAndScheme)', withoutRule.length === 0 && found.get('https-server.ts')!.useRule && found.get('http-server.ts')!.useRule,
        withoutRule.join(', '));
}

// ── 2. The table, through the real listeners ─────────────────────────────────────────────────────────────────────────
const tlsMod = await import('./services/tls.js');
const se = await import('./state-engine.js');
const { startHttpServer, _setPlainConnectionHookForTests } = await import('./http-server.js');
const { startHttpsServer } = await import('./https-server.js');
const { updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } = await import('./config/local-config.js');
const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
const { setTrustConfigForTests } = await import('./client-ip.js');
const { _setDefaultGatewaysForTests } = await import('./default-gateways.js');
const { reachedScheme } = await import('./forwarded-host.js');

await tlsMod.initTls();
se.initStateEngine();
const httpPort = await startHttpServer(0);
const httpsPort = await startHttpsServer(0);
updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 1000 } });

/** A private subnet of this machine (a container's docker network), and its first address as the bridge gateway (as test-client-ip-trust). */
function gatewayAndNeighbour(): { gateway: string; neighbour: string } {
    for (const i of Object.values(os.networkInterfaces()).flat()) {
        if (!i || i.internal || i.family !== 'IPv4' || !i.cidr || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)) continue;
        const bits = Number(i.cidr.split('/')[1]);
        if (!(bits >= 8 && bits <= 29)) continue;
        const n = i.address.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
        const base = (n & (~0 << (32 - bits))) >>> 0;
        const ip = (x: number) => [x >>> 24, (x >>> 16) & 255, (x >>> 8) & 255, x & 255].join('.');
        const pick = (k: number) => (base + k === n ? base + k + 1 : base + k);
        return { gateway: ip(pick(1)), neighbour: ip(pick(4)) };
    }
    return { gateway: '172.18.0.1', neighbour: '172.18.0.5' };
}
const { gateway: GATEWAY, neighbour: NEIGHBOUR } = gatewayAndNeighbour();
const PUBLIC = '203.0.113.9';
_setDefaultGatewaysForTests([GATEWAY]);
console.log(`\n2. The table (gateway ${GATEWAY}, neighbour ${NEIGHBOUR}, public ${PUBLIC})`);

/** The remote address the plain listener's next accepted sockets get (null: the real loopback one). */
let fakeRemote: string | null = null;
_setPlainConnectionHookForTests((socket) => {
    if (fakeRemote !== null) Object.defineProperty(socket, 'remoteAddress', { value: fakeRemote, configurable: true });
});

interface Answer { status: number; headers: http.IncomingHttpHeaders; text: string; body: any }
/** One request on a socket of its own (agent: false), so the hook gives it the row's address; fetch can't send our Host. */
function send(tls: boolean, from: string | null, method: string, p: string, headers: Record<string, string>): Promise<Answer> {
    fakeRemote = from;
    const lib = tls ? https : http;
    const url = `${tls ? 'https' : 'http'}://127.0.0.1:${tls ? httpsPort : httpPort}${p}`;
    return new Promise((resolve, reject) => {
        const body = method === 'POST' ? '{}' : undefined;
        const req = lib.request(url, {
            method, agent: false, rejectUnauthorized: false,
            headers: { ...headers, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': String(body.length) } : {}) },
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (d) => { text += d; });
            res.on('end', () => {
                let parsed: any = null;
                try { parsed = JSON.parse(text); } catch { /* a page */ }
                resolve({ status: res.statusCode ?? 0, headers: res.headers, text, body: parsed });
            });
        });
        req.setTimeout(10_000, () => req.destroy(new Error('timed out')));
        req.on('error', reject);
        req.end(body);
    });
}

const HOST = 'riverside.example';
const FORGED_HOST = 'elsewhere.example';
let visitor = 0;
/**
 * What a request carries, as a tunnel or a forger sends it: the Host, a forged X-Forwarded-Host, the scheme header(s) given,
 * and a CF-Connecting-IP (cloudflared always sends one; the plain listener hands such a request to the HTTPS app), a fresh
 * one each time so no row meets another's sign-in pairing limit.
 */
const carrying = (scheme: Record<string, string>) => ({ Host: HOST, 'X-Forwarded-Host': FORGED_HOST, 'CF-Connecting-IP': `198.51.100.${(++visitor % 250) + 1}`, ...scheme });

/** The three sinks: the issuer's host, the probe's scheme and host, the sign-in cookie's Secure flag. */
async function sinks(tls: boolean, from: string | null, scheme: Record<string, string>) {
    resetGatewayRateLimit();
    const meta = await send(tls, from, 'GET', '/.well-known/oauth-authorization-server', carrying(scheme));
    const probe = await send(tls, from, 'GET', '/apple-probe', carrying(scheme));
    const pairing = await send(tls, from, 'POST', '/api/local/admin/auth/pairing', carrying(scheme));
    const cookie = ([] as string[]).concat(pairing.headers['set-cookie'] ?? []).find((c) => /^bp_signin_/.test(c)) ?? '';
    const probeAt = /(https?):\/\/([a-z0-9.:-]+)\/apple-probe/i.exec(probe.text);
    return {
        issuer: String(meta.body?.issuer ?? `(${meta.status})`),
        probe: probeAt ? `${probeAt[1]}://${probeAt[2]}` : `(${probe.status})`,
        forgedShown: meta.text.includes(FORGED_HOST) || probe.text.includes(FORGED_HOST),
        cookie: cookie ? (/;\s*secure\b/i.test(cookie) ? 'Secure' : 'not Secure') : `(no cookie, ${pairing.status})`,
    };
}

function trusting(entries: string | null) {
    if (entries === null) delete process.env.TRUSTED_PROXIES; else process.env.TRUSTED_PROXIES = entries;
    setTrustConfigForTests(undefined);
    resetGatewayRateLimit();
}

const PEERS: Array<{ name: string; from: string | null; trusted: (dockerHost: boolean) => boolean }> = [
    { name: 'loopback (the tunnel in this container)', from: null, trusted: () => true },
    { name: 'the gateway (a tunnel on the host, or whoever Docker\'s port proxy hands on)', from: GATEWAY, trusted: (d) => d },
    { name: 'a neighbouring container', from: NEIGHBOUR, trusted: () => false },
    { name: 'a public peer (direct mode)', from: PUBLIC, trusted: () => false },
];

for (const dockerHost of [false, true]) {
    trusting(dockerHost ? 'docker-host' : null);
    console.log(`\n— TRUSTED_PROXIES ${dockerHost ? '= docker-host' : 'unset'}: X-Forwarded-Host: ${FORGED_HOST}, X-Forwarded-Proto: https —`);
    for (const peer of PEERS) {
        const trusted = peer.trusted(dockerHost);
        const got = await sinks(false, peer.from, { 'X-Forwarded-Proto': 'https' });
        const scheme = trusted ? 'https' : 'http';
        check(`${peer.name}: the issuer names the Host, never X-Forwarded-Host`, got.issuer === `https://${HOST}` && !got.forgedShown, `${got.issuer}${got.forgedShown ? ', forged host shown' : ''}`);
        check(`${peer.name}: the probe's address is ${scheme}://${HOST} (X-Forwarded-Proto ${trusted ? 'believed: a trusted proxy' : 'ignored'})`, got.probe === `${scheme}://${HOST}`, got.probe);
        check(`${peer.name}: the sign-in cookie is ${trusted ? 'Secure' : 'not Secure'}`, got.cookie === (trusted ? 'Secure' : 'not Secure'), got.cookie);
    }
}

trusting(null);
console.log('\n— the scheme a trusted proxy names, from loopback —');
for (const [label, scheme, want] of [
    ['no scheme header', {}, 'http'],
    ['X-Forwarded-Proto: http', { 'X-Forwarded-Proto': 'http' }, 'http'],
    ['X-Forwarded-Proto: HTTPS', { 'X-Forwarded-Proto': 'HTTPS' }, 'https'],
    ['X-Forwarded-Proto: http, https (only the first hop counts)', { 'X-Forwarded-Proto': 'http, https' }, 'http'],
    ['Forwarded: for=198.51.100.4;proto=https (Caddy, Traefik)', { Forwarded: 'for=198.51.100.4;proto=https' }, 'https'],
] as Array<[string, Record<string, string>, string]>) {
    const got = await sinks(false, null, scheme);
    check(`${label}: ${want}`, got.probe === `${want}://${HOST}` && got.cookie === (want === 'https' ? 'Secure' : 'not Secure'), `${got.probe}, ${got.cookie}`);
}

console.log('\n— the HTTPS listener: the socket\'s own scheme wins —');
{
    const got = await sinks(true, null, { 'X-Forwarded-Proto': 'http' });
    check('TLS with X-Forwarded-Proto: http is https, and the Host names it', got.probe === `https://${HOST}` && got.issuer === `https://${HOST}` && got.cookie === 'Secure' && !got.forgedShown,
        `${got.probe}, ${got.issuer}, ${got.cookie}`);
}

console.log('\n— the rule on its own —');
{
    const req = (remoteAddress: string | undefined, headers: Record<string, string>, encrypted = false) => ({ headers, socket: { remoteAddress, encrypted } });
    check('a handler-level stand-in without a socket is http', reachedScheme({ headers: { 'x-forwarded-proto': 'https' } }) === 'http');
    check('loopback in its ::ffff: spelling is trusted', reachedScheme(req('::ffff:127.0.0.1', { 'x-forwarded-proto': 'https' })) === 'https');
    check('a public peer is http whatever it says', reachedScheme(req(PUBLIC, { 'x-forwarded-proto': 'https', forwarded: 'proto=https' })) === 'http');
    check('TLS is https whatever anyone says', reachedScheme(req(PUBLIC, { 'x-forwarded-proto': 'http' }, true)) === 'https');
}

_setPlainConnectionHookForTests(null);
_setDefaultGatewaysForTests(null);
setTrustConfigForTests(undefined);
updateGatewayConfig(DEFAULT_GATEWAY_CONFIG);
console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

/**
 * Port 80 to the Internet (plain-http-gate.ts, design scratch/global-node/DESIGN-https-anywhere-fable.md D9 and §7 S6),
 * through the real plain listener (http-server.ts) and the real HTTPS app behind it. No BeanPool node, CA, DNS or tunnel
 * is contacted. A test hook gives an accepted socket another remote address, so a request from the Internet, from Docker's
 * bridge gateway and from IPv6 can be made here; one check also connects for real from a non-loopback address of this
 * machine with no hook at all.
 *
 *   1. a node with no certificate of its own answers as it always has, to the Internet too: /api, the trust page at /,
 *      /trust, a live-updates socket;
 *   2. with a certificate of its own: from a public source, /api, /settings, /app, /, /trust, a POST and a live-updates
 *      socket get a 301 to https and nothing else (no body, no cookie; a POST is answered before any route): to the same host when it is one of
 *      the community's addresses, else to its main one; the path and query kept, `//elsewhere` kept on the host;
 *   3. from loopback (cloudflared in this container, the registrar's watch) all of that is served as before, IPv4-mapped
 *      loopback too;
 *   4. a host-level tunnel (Docker's bridge gateway naming a beanpool.org host) is served as before; the same source
 *      naming any other host is redirected, and a public source naming a beanpool.org host is redirected; a proxy of the
 *      operator's own (a private source saying X-Forwarded-Proto: https or Forwarded: proto=https) is served, a public
 *      source sending the same headers is redirected;
 *   5. IPv6: a public source is redirected, a unique-local one naming a beanpool.org host is served;
 *   6. the ACME challenge route answers from the Internet on a node with a certificate, unknown tokens 404, never a
 *      redirect;
 *   7. a certificate that expires before it is renewed keeps the redirect: a lapse never reopens port 80 in cleartext;
 *   8. a real connection from a non-loopback address of this machine is not loopback (the remoteAddress assumption);
 *   9. what the loopback rule rests on: the tunnel's origin is 127.0.0.1, and docker-compose.yml pins beanpool-node to
 *      127.0.0.1 and runs no host network, so nothing outside the container reaches it from loopback.
 *
 * Run: BEANPOOL_SUITE_ENV_PASSWORD=1 BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx apps/server/src/test-plain-http-gate.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';

const dataDir = fs.mkdtempSync(path.join(process.env.BEANPOOL_DATA_DIR || process.env.TMPDIR || os.tmpdir(), 'plain-http-gate-'));
process.env.BEANPOOL_DATA_DIR = dataDir;
for (const k of ['CF_RECORD_NAME', 'CF_API_TOKEN', 'CF_ZONE_ID', 'NODE_ROLE', 'PUBLIC_IP']) delete process.env[k];
// localhost too, as an operator lists it for an SSH tunnel: accepted, never an address to send anyone to.
process.env.BEANPOOL_ADDRESSES = 'beans.example.org,localhost';
process.env.ADMIN_PASSWORD ??= 'Plain-Http-Gate-Suite-Pw-4417!';

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = '') {
    if (ok) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const { initAdminPassword } = await import('./config/local-config.js');
const tlsMod = await import('./services/tls.js');
const se = await import('./state-engine.js');
const { startHttpServer, _setPlainConnectionHookForTests } = await import('./http-server.js');
const { startHttpsServer } = await import('./https-server.js');
const { primaryAddress } = await import('./engine/own-addresses.js');
const challenge = await import('./services/acme/challenge.js');
const store = await import('./services/acme/store.js');
const gate = await import('./plain-http-gate.js');
const { LOOPBACK_ORIGIN } = await import('./services/tunnel-connector.js');

initAdminPassword();
await tlsMod.initTls();
se.initStateEngine();
const httpPort = await startHttpServer(0);
await startHttpsServer(0);

/** The remote address the next accepted sockets are given (null: the real one). */
let fakeRemote: string | null = null;
_setPlainConnectionHookForTests((socket) => {
    if (fakeRemote !== null) Object.defineProperty(socket, 'remoteAddress', { value: fakeRemote, configurable: true });
});

interface Answer { status: number; headers: Record<string, string>; body: string }
/** One raw HTTP/1.1 request to the plain listener, as `from` (null: the real loopback socket), to `connectTo`. */
function raw(from: string | null, request: string, connectTo = '127.0.0.1', untilHead = false): Promise<Answer> {
    fakeRemote = from;
    return new Promise((resolve, reject) => {
        const sock = net.connect(httpPort, connectTo);
        let data = '';
        sock.setTimeout(10_000, () => { sock.destroy(); reject(new Error('timed out')); });
        // A socket that was upgraded stays open: its answer is the head alone.
        sock.on('data', (d) => { data += d.toString('latin1'); if (untilHead && data.includes('\r\n\r\n')) sock.destroy(); });
        sock.on('error', reject);
        sock.on('close', () => {
            const [head, ...rest] = data.split('\r\n\r\n');
            const lines = head.split('\r\n');
            const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(lines[0] ?? '')?.[1] ?? 0);
            const headers: Record<string, string> = {};
            for (const l of lines.slice(1)) {
                const i = l.indexOf(':');
                if (i > 0) {
                    const k = l.slice(0, i).trim().toLowerCase();
                    headers[k] = headers[k] ? `${headers[k]}, ${l.slice(i + 1).trim()}` : l.slice(i + 1).trim();
                }
            }
            resolve({ status, headers, body: rest.join('\r\n\r\n') });
        });
        sock.write(request);
    });
}
const get = (from: string | null, p: string, host: string, connectTo?: string) =>
    raw(from, `GET ${p} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`, connectTo);
const upgrade = (from: string | null, host: string) => raw(from, `GET /ws HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\n`
    + `Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${Buffer.from('0123456789abcdef').toString('base64')}\r\n\r\n`,
    '127.0.0.1', true);

const PUBLIC = '203.0.113.9';
const OWN = 'beans.example.org';

// ── 1. No certificate of its own: as always ─────────────────────────────────────────────────────────────────────
console.log('\n1. A node with no certificate of its own answers port 80 as it always has');
check('no certificate of its own at the start', !tlsMod.holdsOwnCertificate());
{
    const api = await get(PUBLIC, '/api/version', OWN);
    check('/api from the Internet is served (as today)', api.status === 200 && api.body.includes('version'), `${api.status} ${api.body.slice(0, 80)}`);
    const root = await get(PUBLIC, '/', OWN);
    check('/ from the Internet is the LAN trust page (as today)', root.status === 200 && root.body.includes('Trust the Network'), String(root.status));
    const trust = await get(PUBLIC, '/trust', '192.168.1.10');
    check('/trust hands out the CA (as today)', trust.status === 200 && trust.body.includes('BEGIN CERTIFICATE'), String(trust.status));
    const ws = await upgrade(PUBLIC, OWN);
    check('a live-updates socket from the Internet is upgraded (as today)', ws.status === 101, String(ws.status));
}

// ── A certificate of its own ─────────────────────────────────────────────────────────────────────────────────────
const made = selfsigned.generate([{ name: 'commonName', value: OWN }], {
    days: 30, keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: OWN }] }],
});
const problem = tlsMod.serveCertificate(OWN, { cert: made.cert, key: made.private });
check('the test certificate is served', problem === null, problem ?? '');
check('the node now holds a certificate of its own', tlsMod.holdsOwnCertificate());
check('its main address is the configured name', primaryAddress() === OWN, String(primaryAddress()));

function redirected(a: Answer, to: string): boolean {
    return a.status === 301 && a.headers.location === to && a.body === '' && !a.headers['set-cookie'];
}

console.log('\n2. With one, the Internet gets a 301 to https and nothing else');
for (const p of ['/api/version', '/api/community/info?x=1', '/settings', '/app/', '/', '/trust', '/check', '/manifest.json']) {
    const a = await get(PUBLIC, p, OWN);
    check(`${p} → 301 https://${OWN}${p}`, redirected(a, `https://${OWN}${p}`), `${a.status} ${a.headers.location} ${a.body.slice(0, 60)}`);
}
{
    const other = await get(PUBLIC, '/api/version', '198.51.100.7');
    check('a host that is not the community\'s goes to its main address', redirected(other, `https://${OWN}/api/version`), `${other.status} ${other.headers.location}`);
    const port = await get(PUBLIC, '/settings', `${OWN}:8080`);
    check('the Host header\'s port is dropped (https is 443)', redirected(port, `https://${OWN}/settings`), `${port.headers.location}`);
    const loop = await get(PUBLIC, '/settings', 'localhost');
    check('a listed loopback name is never kept: localhost goes to the main address', redirected(loop, `https://${OWN}/settings`), `${loop.headers.location}`);
    const slashes = await get(PUBLIC, '//elsewhere.example.net/x', OWN);
    check('`//elsewhere` stays a path on the community\'s host', redirected(slashes, `https://${OWN}//elsewhere.example.net/x`), `${slashes.headers.location}`);
    const cookie = await get(PUBLIC, '/api/version', OWN);
    check('no cookie on the redirect', !cookie.headers['set-cookie']);
    const tunnelHeader = await raw(PUBLIC, `GET /api/version HTTP/1.1\r\nHost: ${OWN}\r\ncf-connecting-ip: 1.2.3.4\r\nConnection: close\r\n\r\n`);
    check('a cf-connecting-ip header from the Internet changes nothing', redirected(tunnelHeader, `https://${OWN}/api/version`), String(tunnelHeader.status));
    // /api/version answers GET only: a POST that reached the app would be a 404/405, so the 301 is the gate's own answer.
    const post = await raw(PUBLIC, `POST /api/version HTTP/1.1\r\nHost: ${OWN}\r\nContent-Type: application/json\r\n`
        + `Content-Length: 2\r\nConnection: close\r\n\r\n{}`);
    check('a POST is a 301 too, answered before any route', redirected(post, `https://${OWN}/api/version`), `${post.status}`);
    const ws = await upgrade(PUBLIC, OWN);
    check('a live-updates socket from the Internet is refused with a 301', ws.status === 301 && ws.headers.location === `https://${OWN}/ws`, `${ws.status} ${ws.headers.location}`);
}

console.log('\n3. From loopback (the tunnel in this container) as before');
{
    const api = await get(null, '/api/version', 'mullum.beanpool.org');
    check('/api from 127.0.0.1 is served', api.status === 200 && api.body.includes('version'), `${api.status}`);
    const own = await get(null, '/api/version', OWN);
    check('/api from 127.0.0.1 naming the own address is served', own.status === 200, `${own.status}`);
    const mapped = await get('::ffff:127.0.0.1', '/api/version', 'mullum.beanpool.org');
    check('/api from ::ffff:127.0.0.1 is served', mapped.status === 200, `${mapped.status}`);
    const v6 = await get('::1', '/settings', 'localhost');
    check('/settings from ::1 is served, not redirected', v6.status !== 301, `${v6.status}`);
    const ws = await upgrade(null, 'mullum.beanpool.org');
    check('a live-updates socket from loopback is upgraded', ws.status === 101, String(ws.status));
}

console.log('\n4. A host-level tunnel (Docker\'s bridge gateway) naming a beanpool.org host, as before');
{
    const tunnel = await get('172.18.0.1', '/api/version', 'mullum.beanpool.org');
    check('/api from 172.18.0.1 naming mullum.beanpool.org is served', tunnel.status === 200, `${tunnel.status}`);
    const mapped = await get('::ffff:172.18.0.1', '/api/version', 'byron.beanpool.org');
    check('the same from ::ffff:172.18.0.1 is served', mapped.status === 200, `${mapped.status}`);
    const lan = await get('172.18.0.1', '/api/version', OWN);
    check('the same source naming the own domain is redirected', redirected(lan, `https://${OWN}/api/version`), `${lan.status}`);
    const lanIp = await get('192.168.1.20', '/settings', '192.168.1.10');
    check('a LAN member at a LAN address is sent to the main address', redirected(lanIp, `https://${OWN}/settings`), `${lanIp.status} ${lanIp.headers.location}`);
    const spoof = await get(PUBLIC, '/api/version', 'mullum.beanpool.org');
    check('a public source naming a beanpool.org host is redirected', spoof.status === 301, `${spoof.status}`);
    const wsSpoof = await upgrade('172.18.0.1', OWN);
    check('a live-updates socket from the gateway naming the own domain is refused', wsSpoof.status === 301, `${wsSpoof.status}`);
}

console.log('\n4b. A web server or proxy of the operator\'s own in front, saying the visitor came over https');
{
    const via = (from: string, header: string, host = OWN) =>
        raw(from, `GET /api/version HTTP/1.1\r\nHost: ${host}\r\n${header}\r\nConnection: close\r\n\r\n`);
    const xfp = await via('172.18.0.1', 'X-Forwarded-Proto: https');
    check('the gateway with X-Forwarded-Proto: https is served (no loop)', xfp.status === 200, `${xfp.status}`);
    const fwd = await via('172.18.0.1', 'Forwarded: for=198.51.100.2;proto=https;host=beans.example.org');
    check('the gateway with Forwarded: proto=https is served', fwd.status === 200, `${fwd.status}`);
    const v6 = await via('fd12::3', 'X-Forwarded-Proto: HTTPS', '127.0.0.1:8080');
    check('a unique-local proxy with X-Forwarded-Proto: HTTPS (nginx\'s Host) is served', v6.status === 200, `${v6.status}`);
    const http = await via('172.18.0.1', 'X-Forwarded-Proto: http');
    check('the gateway with X-Forwarded-Proto: http is redirected', http.status === 301, `${http.status}`);
    const chain = await via('172.18.0.1', 'X-Forwarded-Proto: http, https');
    check('only the first hop\'s X-Forwarded-Proto counts', chain.status === 301, `${chain.status}`);
    const pub = await via(PUBLIC, 'X-Forwarded-Proto: https');
    check('a public source with X-Forwarded-Proto: https is redirected', redirected(pub, `https://${OWN}/api/version`), `${pub.status}`);
    const pubFwd = await via('2001:db8::7', 'Forwarded: proto=https');
    check('a public IPv6 source with Forwarded: proto=https is redirected', pubFwd.status === 301, `${pubFwd.status}`);
    const wsProxy = await raw('172.18.0.1', `GET /ws HTTP/1.1\r\nHost: ${OWN}\r\nX-Forwarded-Proto: https\r\nConnection: Upgrade\r\n`
        + `Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${Buffer.from('0123456789abcdef').toString('base64')}\r\n\r\n`,
        '127.0.0.1', true);
    check('a live-updates socket through the proxy saying https is upgraded', wsProxy.status === 101, `${wsProxy.status}`);
}

console.log('\n5. IPv6');
{
    const pub = await get('2001:db8::5', '/api/version', OWN);
    check('a public IPv6 source is redirected', redirected(pub, `https://${OWN}/api/version`), `${pub.status}`);
    const ula = await get('fd00::1', '/api/version', 'mullum.beanpool.org');
    check('a unique-local IPv6 source naming a beanpool.org host is served', ula.status === 200, `${ula.status}`);
    const ulaOwn = await get('fd00::1', '/api/version', OWN);
    check('the same naming the own domain is redirected', ulaOwn.status === 301, `${ulaOwn.status}`);
}

console.log('\n6. The ACME challenge route from the Internet');
{
    const token = 'tok_' + 'A'.repeat(40);
    challenge.putChallenge(token, `${token}.thumbprint`);
    const a = await get(PUBLIC, `${challenge.CHALLENGE_PREFIX}${token}`, OWN);
    check('a token this node made is answered, not redirected', a.status === 200 && a.body === `${token}.thumbprint`, `${a.status} ${a.body}`);
    const unknown = await get(PUBLIC, `${challenge.CHALLENGE_PREFIX}${'B'.repeat(40)}`, OWN);
    check('an unknown token is 404 with an empty body', unknown.status === 404 && unknown.body === '', `${unknown.status}`);
    challenge.removeChallenge(token);
}

console.log('\n7. A certificate that lapses keeps the redirect');
{
    const times = store.certTimes(made.cert)!;
    store.writeState(dataDir, { ...store.emptyState(OWN), validUntil: times.notAfter, lastSuccessAt: times.notBefore });
    tlsMod.setPreferredOrder([OWN]);
    tlsMod.noteChecked(OWN);
    tlsMod._setTlsClockForTests(() => times.notAfter + 60_000);
    check('the certificate is no longer served', !tlsMod.servesCaCertificateFor(OWN));
    check('the node still counts as holding one', tlsMod.holdsOwnCertificate());
    const a = await get(PUBLIC, '/api/version', OWN);
    check('/api from the Internet is still a 301', a.status === 301, `${a.status}`);
    tlsMod._setTlsClockForTests(null);
}

console.log('\n8. A real connection from a non-loopback address of this machine');
{
    const mine = Object.values(os.networkInterfaces()).flat()
        .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    if (!mine) {
        // GitHub's runners have one; a machine with none cannot make this connection, and says so rather than pass.
        check('this machine has a non-loopback IPv4 address to connect from', !process.env.CI, 'none found on CI');
    } else {
        check(`${mine} is not loopback to the gate`, !gate.isLoopbackSource(mine) && !gate.isLoopbackSource(`::ffff:${mine}`));
        const a = await get(null, '/api/version', OWN, mine);
        check(`a real connection to ${mine} (no hook) is redirected`, redirected(a, `https://${OWN}/api/version`), `${a.status} ${a.headers.location}`);
    }
}

console.log('\n9. What the loopback rule rests on');
{
    check('the tunnel\'s origin is 127.0.0.1', new URL(LOOPBACK_ORIGIN).hostname === '127.0.0.1', LOOPBACK_ORIGIN);
    const here = path.dirname(fileURLToPath(import.meta.url));
    const compose = fs.readFileSync(path.join(here, '..', '..', '..', 'docker-compose.yml'), 'utf8');
    check('docker-compose.yml pins beanpool-node to 127.0.0.1', /-\s*"beanpool-node:127\.0\.0\.1"/.test(compose));
    check('docker-compose.yml runs no host network', !/network_mode:\s*"?host/.test(compose));
    for (const [addr, want] of [['127.0.0.1', true], ['127.5.6.7', true], ['::1', true], ['::ffff:127.0.0.1', true],
        ['172.17.0.1', false], ['::ffff:172.17.0.1', false], ['10.0.0.2', false], ['203.0.113.9', false], ['', false], [undefined, false]] as const) {
        check(`isLoopbackSource(${String(addr)}) is ${want}`, gate.isLoopbackSource(addr) === want);
    }
}

_setPlainConnectionHookForTests(null);
console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

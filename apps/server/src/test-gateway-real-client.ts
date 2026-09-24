/**
 * The IP-keyed limiters key on the real client, not on whoever opened the socket.
 *
 * In tunnel mode cloudflared opens every connection, so the socket peer is the same container for the whole
 * community. The gateway limiter keyed on that peer, so a community shared one 120-a-minute bucket. Koa's
 * ctx.ip (app.proxy on) went the other way: the leftmost X-Forwarded-For from ANY peer, so the auth-attempt
 * and invite-check limiters could be dodged by a client naming a fresh address per request.
 *
 * Part 1 checks the resolver (client-ip.ts) on explicit peers. Part 2 drives the real servers over HTTP on the
 * tunnel-origin port: the test client connects from loopback, which is exactly where a local cloudflared
 * connects from; "a peer we do not trust" is simulated by switching trust off (setTrustConfigForTests).
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-gateway-real-client.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import os from 'node:os';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpServer } from './http-server.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } from './config/local-config.js';
import { resolveClientIp, isTrustedProxy, setTrustConfigForTests } from './client-ip.js';
import { resetGatewayRateLimit, SIGNED_CEILING_FACTOR } from './gateway-rate-limit.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

function makeMember(callsign: string) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pubKeyHex, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
    return { pubKeyHex, privateKey };
}

function signedHeaders(id: { pubKeyHex: string; privateKey: crypto.KeyObject }, method: string, path: string): Record<string, string> {
    const ts = String(Date.now()), nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`${method}\n${path}\n${ts}\n${nonce}\n`), id.privateKey).toString('base64');
    return { 'X-Public-Key': id.pubKeyHex, 'X-Signature': sig, 'X-Timestamp': ts, 'X-Nonce': nonce };
}

/** What cloudflared forwards for a member at `ip` (Cloudflare's edge sets both). */
const viaTunnel = (ip: string) => ({ 'cf-connecting-ip': ip, 'x-forwarded-for': ip });

const LIMIT = 5;
let BASE = '';

async function get(path: string, headers: Record<string, string> = {}): Promise<number> {
    const r = await fetch(`${BASE}${path}`, { headers, redirect: 'manual' });
    await r.arrayBuffer();
    return r.status;
}

/** Status of each of `n` sequential requests built by `make(i)`. */
async function burst(n: number, make: (i: number) => [string, Record<string, string>]): Promise<number[]> {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(await get(...make(i)));
    return out;
}

function part1Resolver() {
    console.log('— resolver (client-ip.ts) —');
    setTrustConfigForTests(undefined);
    const spoof = { 'cf-connecting-ip': '203.0.113.50', 'x-forwarded-for': '203.0.113.51' };

    assert(resolveClientIp('198.51.100.7', spoof) === '198.51.100.7',
        'a public peer that sends CF-Connecting-IP / X-Forwarded-For keeps its own address (spoof ignored)');
    assert(resolveClientIp('::ffff:198.51.100.7', {}) === '198.51.100.7', 'an IPv4-mapped peer is normalised');
    assert(resolveClientIp('127.0.0.1', spoof) === '203.0.113.50', 'loopback peer (local proxy): CF-Connecting-IP wins');
    assert(resolveClientIp('127.0.0.1', { 'x-forwarded-for': '203.0.113.51' }) === '203.0.113.51',
        'loopback peer without CF-Connecting-IP: X-Forwarded-For');
    assert(resolveClientIp('127.0.0.1', { 'x-forwarded-for': '1.2.3.4, 203.0.113.51' }) === '203.0.113.51',
        'X-Forwarded-For is read from the right: a client-written leftmost entry is not believed');
    assert(resolveClientIp('127.0.0.1', { 'cf-connecting-ip': 'not-an-ip' }) === '127.0.0.1',
        'a CF-Connecting-IP that is not an address is ignored');
    assert(resolveClientIp('162.158.1.1', spoof) === '203.0.113.50',
        'a Cloudflare edge peer (proxied direct mode): CF-Connecting-IP wins');
    assert(resolveClientIp('162.158.1.1', { 'x-forwarded-for': '203.0.113.51' }) === '162.158.1.1',
        'a Cloudflare edge peer: X-Forwarded-For alone is NOT believed (Cloudflare passes client entries through)');

    // The subnets of this machine's own private interfaces (in a container: the docker networks).
    const own = Object.values(os.networkInterfaces()).flat()
        .find(i => i && !i.internal && i.family === 'IPv4' && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address));
    if (own) {
        assert(isTrustedProxy(own.address), `a peer on this machine's own private subnet (${own.cidr}) is a trusted proxy`);
    } else {
        console.log('  (no private interface on this machine; own-subnet trust not exercised)');
    }
    assert(!isTrustedProxy('10.255.255.254') || !!own?.cidr?.startsWith('10.'),
        'a private address NOT on one of our subnets is not trusted');

    setTrustConfigForTests({ extra: ['198.51.100.0/24'] });
    assert(resolveClientIp('198.51.100.7', spoof) === '203.0.113.50', 'TRUSTED_PROXIES adds a proxy range');
    setTrustConfigForTests({ loopback: false, localSubnets: false });
    assert(resolveClientIp('127.0.0.1', spoof) === '127.0.0.1', 'with loopback untrusted, its headers are ignored');
    setTrustConfigForTests(undefined);
}

async function part2Http() {
    await initTls();
    initStateEngine();
    // Bind once and read the port back, rather than probing for two free ports and handing them on:
    // the probe closed its listener before returning, so the second probe could be given the port the
    // first had just released and the second server died with EADDRINUSE.
    const httpPort = await startHttpServer(0);
    const httpsPort = await startHttpsServer(0);
    BASE = `http://127.0.0.1:${httpPort}`; // the tunnel origin cloudflared talks to

    const limited = { ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: true, maxRequestsPerMinute: LIMIT } };
    const unlimited = { ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: LIMIT } };
    const fresh = (trust?: Parameters<typeof setTrustConfigForTests>[0]) => { setTrustConfigForTests(trust); resetGatewayRateLimit(); };
    const TRUST_NOBODY = { loopback: false, localSubnets: false, cloudflare: false };
    const PROBE = '/api/gateway-limit-probe';

    console.log('\n— gateway limiter, tunnel mode —');
    updateGatewayConfig(limited);
    fresh();
    {
        // 12 members, 3 requests each: 36 requests, 7× the per-client limit, through one tunnel peer.
        const statuses = await burst(36, i => [PROBE, viaTunnel(`203.0.113.${10 + (i % 12)}`)]);
        assert(!statuses.includes(429), `12 members through the tunnel don't share a bucket (429s: ${statuses.filter(s => s === 429).length}/36)`);
        const one = await burst(LIMIT + 1, () => [PROBE, viaTunnel('203.0.113.99')]);
        assert(one.slice(0, LIMIT).every(s => s !== 429) && one[LIMIT] === 429,
            `one member through the tunnel still gets 429 on request ${LIMIT + 1} (got ${one.join(',')})`);
    }

    console.log('\n— gateway limiter, peer we do not trust —');
    fresh(TRUST_NOBODY);
    {
        const statuses = await burst(LIMIT + 1, i => [PROBE, viaTunnel(`203.0.113.${100 + i}`)]);
        assert(statuses[LIMIT] === 429, `a fresh CF-Connecting-IP / X-Forwarded-For per request from an untrusted peer is ignored: 429 on ${LIMIT + 1} (got ${statuses.join(',')})`);
    }
    fresh(TRUST_NOBODY);
    {
        const statuses = await burst(LIMIT + 3, () => [PROBE, {}]);
        assert(statuses.slice(0, LIMIT).every(s => s !== 429) && statuses.slice(LIMIT).every(s => s === 429),
            `an unsigned flood from one address gets 429 after ${LIMIT} (got ${statuses.join(',')})`);
    }

    console.log('\n— gateway limiter, signed members behind one address (shared NAT) —');
    const alice = makeMember('LimitAlice');
    const bob = makeMember('LimitBob');
    fresh(TRUST_NOBODY);
    {
        const unsigned = await burst(LIMIT + 1, () => [PROBE, {}]);
        assert(unsigned[LIMIT] === 429, 'the shared address\'s unsigned bucket is full');
        const a = await burst(LIMIT, () => [PROBE, signedHeaders(alice, 'GET', PROBE)]);
        assert(a.every(s => s !== 429 && s !== 401 && s !== 403),
            `a signed member is not locked out by the address's unsigned traffic (got ${a.join(',')})`);
        const aOver = await get(PROBE, signedHeaders(alice, 'GET', PROBE));
        assert(aOver === 429, `the member's own bucket still limits them: request ${LIMIT + 1} → 429 (got ${aOver})`);
        const b = await get(PROBE, signedHeaders(bob, 'GET', PROBE));
        assert(b !== 429, `another member behind the same address has their own bucket (got ${b})`);
        const stillUnsigned = await get(PROBE);
        assert(stillUnsigned === 429, 'unsigned traffic from that address is still limited');
    }

    fresh(TRUST_NOBODY);
    {
        // Forged signatures: rejected by the signature check, and charged to the address's unsigned bucket.
        const forged = await burst(LIMIT, () => {
            const h = signedHeaders(alice, 'GET', PROBE);
            h['X-Signature'] = crypto.randomBytes(64).toString('base64');
            return [PROBE, h];
        });
        assert(forged.every(s => s === 403), `forged signatures are refused (got ${forged.join(',')})`);
        const after = await get(PROBE);
        assert(after === 429, `forged signatures were charged to the address's unsigned bucket: the next unsigned request → 429 (got ${after})`);
    }

    fresh(TRUST_NOBODY);
    {
        // A fresh keypair per request (members can mint keys) is bounded by the per-address ceiling.
        const ceiling = LIMIT * SIGNED_CEILING_FACTOR;
        const statuses = await burst(ceiling + 1, () => {
            const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
            const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
            return [PROBE, signedHeaders({ pubKeyHex, privateKey }, 'GET', PROBE)];
        });
        assert(!statuses.slice(0, ceiling).includes(429) && statuses[ceiling] === 429,
            `signed requests from one address stop at the ceiling (${ceiling}): 429 on ${ceiling + 1} (got ${statuses[ceiling]})`);
    }

    console.log('\n— admin IP allowlist —');
    updateGatewayConfig(unlimited);
    const ADMIN = '/api/local/dashboard';
    {
        // Direct mode (the peer is the client): unchanged.
        fresh(TRUST_NOBODY);
        updateGatewayConfig({ ...unlimited, adminIpAllowlist: ['127.0.0.1'] });
        assert(await get(ADMIN) !== 403, 'direct: allowlist 127.0.0.1, request from 127.0.0.1 → allowed');
        updateGatewayConfig({ ...unlimited, adminIpAllowlist: ['203.0.113.7'] });
        assert(await get(ADMIN) === 403, 'direct: allowlist 203.0.113.7, request from 127.0.0.1 → 403');
        assert(await get(ADMIN, viaTunnel('203.0.113.7')) === 403,
            'direct: an untrusted peer claiming to be 203.0.113.7 in forwarding headers → still 403');
        updateGatewayConfig({ ...unlimited, adminIpAllowlist: ['127.*'] });
        assert(await get(ADMIN) !== 403, 'direct: wildcard 127.* still matches');
        updateGatewayConfig({ ...unlimited, adminIpAllowlist: [] });
        assert(await get(ADMIN, viaTunnel('203.0.113.7')) !== 403, 'an empty allowlist admits everyone (unchanged)');

        // Tunnel mode: the list now matches the person, not the cloudflared container.
        fresh();
        updateGatewayConfig({ ...unlimited, adminIpAllowlist: ['203.0.113.7'] });
        assert(await get(ADMIN, viaTunnel('203.0.113.7')) !== 403, 'tunnel: the allowlisted operator\'s address is admitted');
        assert(await get(ADMIN, viaTunnel('198.51.100.9')) === 403, 'tunnel: anyone else is refused');
        updateGatewayConfig({ ...unlimited, adminIpAllowlist: ['127.0.0.1'] });
        assert(await get(ADMIN, viaTunnel('198.51.100.9')) === 403,
            'tunnel: allowlisting the local peer no longer admits the whole internet through the tunnel');
        assert(await get(ADMIN) !== 403, 'a local request with no forwarding headers still matches 127.0.0.1');
        updateGatewayConfig(unlimited);
    }

    console.log('\n— auth-attempt limiter (recovery lookup, 15/min) —');
    updateGatewayConfig(unlimited);
    const LOOKUP = (i: number) => `/api/recovery/lookup/nobody${i}`;
    fresh(TRUST_NOBODY);
    {
        const s = await burst(16, i => [LOOKUP(i), { 'x-forwarded-for': `203.0.113.${i + 1}` }]);
        assert(s[15] === 429, `a fresh X-Forwarded-For per attempt no longer dodges the auth limiter: 429 on 16 (got ${s[15]})`);
    }
    fresh();
    {
        const s = await burst(32, i => [LOOKUP(i), viaTunnel(`203.0.113.${(i % 4) + 1}`)]);
        assert(!s.includes(429), `4 people doing recovery lookups through the tunnel don't share a bucket (429s: ${s.filter(x => x === 429).length}/32)`);
    }

    console.log('\n— invite-check limiter (30/min) —');
    fresh(TRUST_NOBODY);
    {
        const s = await burst(31, i => [`/api/invite/check?code=x${i}`, { 'x-forwarded-for': `203.0.113.${i + 1}` }]);
        assert(s[30] === 429, `a fresh X-Forwarded-For per request no longer dodges the invite check limiter (got ${s[30]})`);
    }
    fresh();
    {
        const s = await burst(60, i => [`/api/invite/check?code=x${i}`, viaTunnel(`203.0.113.${(i % 2) + 1}`)]);
        assert(!s.includes(429), `2 invitees checking codes through the tunnel don't share a bucket (429s: ${s.filter(x => x === 429).length}/60)`);
    }

    setTrustConfigForTests(undefined);
    updateGatewayConfig(DEFAULT_GATEWAY_CONFIG);
}

async function main() {
    console.log('Running gateway real-client tests...\n');
    part1Resolver();
    await part2Http();
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
});

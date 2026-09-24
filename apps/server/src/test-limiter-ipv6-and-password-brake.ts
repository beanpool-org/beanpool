/**
 * IPv6 rotation, a gap left after #935. Every per-IP limiter keyed on the full /128, and an IPv6 subscriber owns a
 * whole /64, so a client could take a fresh address (a fresh, empty bucket) per request. Limiters now key on the /64
 * (limiterKeyForIp). IPv4 stays per address; IPv4-mapped spellings fold to the IPv4 address.
 *
 * #937's node-wide password brake was tested here too. It let anyone lock the owner out (eleven wrong passwords
 * from anywhere refused the right one from everywhere), so it was replaced by a per-source brake; its tests live in
 * test-password-brake-no-lockout.ts.
 *
 * Part 2 drives the real servers over HTTP on the tunnel-origin port: the test client connects from loopback (a
 * trusted local proxy), so CF-Connecting-IP names the client, as cloudflared does.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-limiter-ipv6-and-password-brake.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import { randomBytes } from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpServer } from './http-server.js';
import { startHttpsServer } from './https-server.js';
import { updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } from './config/local-config.js';
import { resolveClientIp, limiterKeyForIp, setTrustConfigForTests } from './client-ip.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const viaTunnel = (ip: string) => ({ 'cf-connecting-ip': ip, 'x-forwarded-for': ip });
let BASE = '';

async function req(path: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
    const r = await fetch(`${BASE}${path}`, {
        method: opts.method || 'GET',
        headers: { ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        redirect: 'manual',
    });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, headers: r.headers, json };
}

async function burst(n: number, make: (i: number) => [string, Record<string, string>]): Promise<number[]> {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
        const [p, h] = make(i);
        out.push((await req(p, { headers: h })).status);
    }
    return out;
}

function part1Keys() {
    console.log('— limiter key (client-ip.ts limiterKeyForIp) —');
    const k = limiterKeyForIp;
    assert(k('2001:db8:1:2::1') === k('2001:db8:1:2:ffff:abcd:1234:5678'), 'two addresses in one /64 share a key');
    assert(k('2001:db8:1:2::1') !== k('2001:db8:1:3::1'), 'addresses in different /64s get different keys');
    assert(k('2001:0DB8:0001:0002:0000:0000:0000:0001') === k('2001:db8:1:2::1'), 'expanded, upper-case and compressed spellings share a key');
    assert(k('fe80::1%eth0') === k('fe80::2'), 'a zone id is stripped');
    assert(k('::ffff:203.0.113.5') === '203.0.113.5', 'IPv4-mapped (dotted) folds to the IPv4 address');
    assert(k('::ffff:cb00:7105') === '203.0.113.5', 'IPv4-mapped (hex) folds to the IPv4 address');
    assert(k('0:0:0:0:0:FFFF:203.0.113.5') === '203.0.113.5', 'IPv4-mapped (expanded) folds to the IPv4 address');
    assert(k('203.0.113.5') === '203.0.113.5' && k('203.0.113.6') === '203.0.113.6', 'IPv4 stays per address');
    assert(k('unknown') === 'unknown' && k('') === 'unknown', 'a non-address passes through');
    // Only the bucket widens: the client's own address, as logged and allowlisted, is the full address.
    setTrustConfigForTests(undefined);
    assert(resolveClientIp('127.0.0.1', viaTunnel('2001:db8:1:2::abcd')) === '2001:db8:1:2::abcd',
        'the resolved client address (logging, allowlist) is still the full /128');
}

async function part2Limiters() {
    const LIMIT = 5;
    const limited = { ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: true, maxRequestsPerMinute: LIMIT } };
    const unlimited = { ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: LIMIT } };
    const PROBE = '/api/gateway-limit-probe';
    const inPrefix = (prefix: string, i: number) => `${prefix}:${(i + 1).toString(16)}:${randomBytes(2).toString('hex')}:0:${(i * 7 + 1).toString(16)}`;

    console.log('\n— gateway limiter over IPv6 —');
    updateGatewayConfig(limited);
    resetGatewayRateLimit();
    {
        const s = await burst(50, i => [PROBE, viaTunnel(inPrefix('2001:db8:1:2', i))]);
        const n429 = s.filter(x => x === 429).length;
        assert(s.slice(0, LIMIT).every(x => x !== 429) && n429 === 50 - LIMIT,
            `50 requests rotating inside one /64 get 429 after ${LIMIT} (429s: ${n429}/50; was 0 before)`);
    }
    resetGatewayRateLimit();
    {
        const s = await burst(2 * LIMIT, i => [PROBE, viaTunnel(inPrefix(i % 2 ? '2001:db8:1:3' : '2001:db8:1:4', i))]);
        assert(!s.includes(429), `two /64s get separate buckets: ${LIMIT} each, no 429 (got ${s.join(',')})`);
    }
    resetGatewayRateLimit();
    {
        const s = await burst(LIMIT + 1, i => [PROBE, viaTunnel(i % 2 ? '::ffff:203.0.113.5' : '203.0.113.5')]);
        assert(s[LIMIT] === 429, `203.0.113.5 and ::ffff:203.0.113.5 share one bucket: 429 on ${LIMIT + 1} (got ${s.join(',')})`);
    }

    console.log('\n— auth-attempt limiter (15/min) over IPv6 —');
    updateGatewayConfig(unlimited);
    {
        const s = await burst(16, i => [`/api/recovery/lookup/nobody${i}`, viaTunnel(inPrefix('2001:db8:2:2', i))]);
        assert(s.slice(0, 15).every(x => x !== 429) && s[15] === 429, `recovery lookups rotating inside one /64: 429 on 16 (got ${s[15]})`);
        const other = await req('/api/recovery/lookup/nobody', { headers: viaTunnel('2001:db8:2:3::1') });
        assert(other.status !== 429, `a neighbouring /64 has its own auth bucket (got ${other.status})`);
    }

    console.log('\n— invite-check limiter (30/min) over IPv6 —');
    {
        const s = await burst(31, i => [`/api/invite/check?code=x${i}`, viaTunnel(inPrefix('2001:db8:3:2', i))]);
        assert(s.slice(0, 30).every(x => x !== 429) && s[30] === 429, `invite checks rotating inside one /64: 429 on 31 (got ${s[30]})`);
    }
}

async function main() {
    console.log('Running IPv6 limiter-key tests...\n');
    part1Keys();
    await initTls();
    initStateEngine();
    // Bind once and read the port back (two probes in a row could be handed the same port).
    const httpPort = await startHttpServer(0);
    const httpsPort = await startHttpsServer(0);
    BASE = `http://127.0.0.1:${httpPort}`;
    await part2Limiters();
    setTrustConfigForTests(undefined);
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
});

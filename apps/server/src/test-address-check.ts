/**
 * A node checks each of its addresses from outside and says what it found (services/address-check.ts, routes/check-page.ts;
 * design scratch/fable-design/DESIGN-dns-robustness-fable.md §5, §8 slice 1).
 *
 * The node is a REAL server in its own process (takeover-test-harness.ts), with its real HTTPS and HTTP servers and
 * middleware. Cloudflare's edge is a mock (BEANPOOL_TEST_EDGE_ORIGIN, the name watch's seam), and so is DNS: a real UDP
 * server here (BEANPOOL_TEST_DNS_SERVER) that real `node:dns` asks, so a real NXDOMAIN, a real SERVFAIL. The asks go down
 * ssrfSafeFetch's whole pipeline, with its host pinned to the mock (BEANPOOL_SSRF_TEST_HOOK). NODE_TLS_REJECT_UNAUTHORIZED
 * is left alone, so TLS is as strict here as it is on a node. No node reaches Cloudflare, any BeanPool node, a public
 * resolver or the live registrar.
 *
 * Node P (a self-hoster's own domain, plus BeanPool names; every case is one address in BEANPOOL_ADDRESSES or a claim):
 *  1. the name leads to this server → `reach.answers === 'own'`, the words "Nothing to do", DNS kept (main: no `reach`).
 *  2. nothing answers → 'silence' and the words; and a Cloudflare 530 is silence too.
 *  3. the name doesn't resolve: a name made minutes ago says so, with its age; 31 minutes on it no longer does; an old name
 *     says what to do, an own domain and a BeanPool name each its own. A name the record doesn't hold never reads as new. A
 *     real SERVFAIL is a resolver that couldn't say, not a name that isn't there: nobody is sent to fix a record for it.
 *  4. another key answers → 'other'; a page → 'other-origin'; a redirect → 'silence'. A wrong answer drops nothing: the
 *     name is still accepted and still published.
 *  5. a certificate strict TLS refuses → 'tls' (a real one: the node's own self-signed port), and its words. So do a port
 *     that speaks plain HTTP and a fatal TLS alert, as an edge with no certificate for the name sends. A port that hangs up
 *     in the handshake stays silence.
 *  6. not asked at all: a `.lan` name or a private number, which no outside reader can reach, and a name that points at a
 *     home-network address from here, whose words claim only that (split DNS: phones outside may reach it perfectly well).
 *  7. own domain, no answer here, certificate held → the "checked from inside" words (the rule alone: stepOf, the suite
 *     holds no certificate); without a certificate, and at a BeanPool name, the plain words.
 *  8. Check now through the real route: an owner's session reaches it, a stranger's doesn't, and a second press inside
 *     30 seconds asks nothing more. Only the main server asks.
 *  9. the numbers a name pointed at go after 7 days, and out of every copy, and the rest of the row stays.
 * 10. /check: name, host, key fingerprint, time, and nothing else, for a Host header that isn't ours too; no script; never
 *     cached; in the reader's language; answers over the plain-HTTP listener too.
 * 11. a former or lost name (through the real report): whatever answers there, nothing sends the owner after it; this
 *     server's own key still answering there is still said.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx apps/server/src/test-address-check.ts
 */

import crypto from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnNode, runNodeChild, type NodeProc } from './takeover-test-harness.js';

const SCRIPT = fileURLToPath(import.meta.url);
const PW = 'Address-Check-P-Pw-8862!';
const SECRET_MEMBER = 'SecretCallsignAnna';

// ── The node process ───────────────────────────────────────────────────────────────────────

let servers: { https: string; http: string } | null = null;

async function start(): Promise<{ https: string; http: string }> {
    if (servers) return servers;
    delete process.env.CF_RECORD_NAME;
    const { initTls } = await import('./services/tls.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { startHttpServer } = await import('./http-server.js');
    await initTls();
    const httpsPort = await startHttpsServer(0);
    const httpPort = await startHttpServer(0);
    servers = { https: `https://localhost:${httpsPort}`, http: `http://127.0.0.1:${httpPort}` };
    return servers;
}

const checkModule = () => import('./services/address-check.js').catch(() => null);

async function child(): Promise<void> {
    await runNodeChild({
        setup: async (a: { ownerSeedHex: string }) => {
            const { ed25519 } = await import('@noble/curves/ed25519.js');
            const se = await import('./state-engine.js');
            se.seedGenesisMember(Buffer.from(ed25519.getPublicKey(Buffer.from(a.ownerSeedHex, 'hex'))).toString('hex'), SECRET_MEMBER);
            const { nodePubkeyHex } = await import('./services/registrar-client.js');
            return { pubkey: nodePubkeyHex(), ...(await start()) };
        },
        // One round now, with the gateway's limit emptied first: this server's own asks share it with the edge's.
        round: async () => {
            const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
            resetGatewayRateLimit();
            const check = await checkModule();
            await check?.runAddressCheckRound();
            return !!check;
        },
        step: async (a: { host: string; certified: string[] }) => {
            const check = await checkModule();
            const dns = { outcome: 'answers', a: ['203.0.113.7'], aaaa: [], cname: [] } as const;
            return check?.stepOf(a.host, { checkedAt: 0, answers: 'silence', ownAt: null, dns: { ...dns, a: [...dns.a], aaaa: [], cname: [] } }, undefined, new Set(a.certified), 0, false).step ?? null;
        },
        // What the report says of each address, at a time on its clock (ms from now).
        reaches: async (a: { offsetMs?: number }) => {
            const check = await checkModule();
            return Object.fromEntries(check?.addressReaches(Date.now() + (a.offsetMs ?? 0)) ?? []);
        },
        env: async (a: { set: Record<string, string | null> }) => {
            for (const [k, v] of Object.entries(a.set)) {
                if (v === null) delete process.env[k]; else process.env[k] = v;
            }
            return true;
        },
        registrarNames: async (a: { set: unknown; publicAddress?: unknown }) => {
            const { updateNodeConfig } = await import('./state-engine.js');
            const { forgetOwnAddresses } = await import('./engine/own-addresses.js');
            updateNodeConfig({ registrarNames: a.set, publicAddress: a.publicAddress ?? null } as any);
            forgetOwnAddresses();
            return true;
        },
        name: async (a: { name: string }) => {
            const { updateLocalConfig } = await import('./config/local-config.js');
            updateLocalConfig({ communityName: a.name } as any);
            return true;
        },
        role: async (a: { role: string }) => {
            (await import('./config/node-role.js')).setNodeRole(a.role as any);
            return true;
        },
        // The row as stored, after forgetting at a time on the clock; and a copy of the database, as a backup is made.
        retention: async (a: { offsetMs: number; copyTo: string }) => {
            const { db } = await import('./db/db.js');
            const retention = await import('./services/address-retention.js');
            const read = (conn: any) => JSON.parse((conn.prepare("SELECT value FROM node_config WHERE key = 'addressChecks'").get() as { value: string }).value);
            const Database = (await import('better-sqlite3')).default;
            retention.copyWithoutAddresses(db as any, a.copyTo);
            const copy = new Database(a.copyTo, { readonly: true });
            const copied = read(copy);
            copy.close();
            const before = read(db);
            retention.forgetOldAddresses(Date.now() + a.offsetMs);
            return { before, after: read(db), copied };
        },
    });
}

// ── The orchestrator ───────────────────────────────────────────────────────────────────────

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

async function section(n: string, body: () => Promise<void>): Promise<void> {
    try {
        await body();
    } catch (e: any) {
        assert(false, `section ${n} ran to the end (${e?.message || e})`);
    }
}

interface Reply { status: number; body: any; text: string; headers: http.IncomingHttpHeaders }

function call(base: string, method: string, route: string, headers: Record<string, string> = {}, body?: unknown): Promise<Reply> {
    const url = new URL(route, base);
    const text = body === undefined ? undefined : JSON.stringify(body);
    const client = url.protocol === 'https:' ? https : http;
    return new Promise((resolve) => {
        const req = client.request({
            host: url.hostname, port: url.port, path: url.pathname + url.search, method, ...(url.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
            headers: { ...(text !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(text)) } : {}), ...headers },
        }, (res) => {
            let out = '';
            res.on('data', (c) => { out += c; });
            res.on('end', () => {
                let parsed: any = out;
                try { parsed = JSON.parse(out); } catch { /* not JSON */ }
                resolve({ status: res.statusCode || 0, body: parsed, text: out, headers: res.headers });
            });
        });
        req.on('error', (e) => resolve({ status: 0, body: { networkError: e.message }, text: '', headers: {} }));
        if (text !== undefined) req.write(text);
        req.end();
    });
}

// ── The mock DNS ───────────────────────────────────────────────────────────────────────────

type DnsMode = { rcode: number } | { a?: string[]; cname?: string };

interface Dns { address: string; modes: Map<string, DnsMode>; asks: Map<string, number>; close: () => void }

function questionOf(msg: Buffer): { name: string; type: number; end: number } {
    const labels: string[] = [];
    let i = 12;
    while (msg[i] !== 0) {
        labels.push(msg.subarray(i + 1, i + 1 + msg[i]).toString());
        i += msg[i] + 1;
    }
    return { name: labels.join('.').toLowerCase(), type: msg.readUInt16BE(i + 1), end: i + 5 };
}

const encodeName = (name: string) => Buffer.concat([...name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);

function answerRecord(type: number, rdata: Buffer): Buffer {
    const head = Buffer.alloc(12);
    head.writeUInt16BE(0xc00c, 0);        // the question's name
    head.writeUInt16BE(type, 2);
    head.writeUInt16BE(1, 4);             // IN
    head.writeUInt32BE(60, 6);
    head.writeUInt16BE(rdata.length, 10);
    return Buffer.concat([head, rdata]);
}

async function startDns(): Promise<Dns> {
    const dns: Dns = { address: '', modes: new Map(), asks: new Map(), close: () => {} };
    const socket = dgram.createSocket('udp4');
    socket.on('message', (msg, peer) => {
        const q = questionOf(msg);
        dns.asks.set(q.name, (dns.asks.get(q.name) ?? 0) + 1);
        const mode = dns.modes.get(q.name) ?? { rcode: 3 };
        const rcode = 'rcode' in mode ? mode.rcode : 0;
        const answers: Buffer[] = [];
        if (!('rcode' in mode)) {
            if (q.type === 1) for (const ip of mode.a ?? []) answers.push(answerRecord(1, Buffer.from(ip.split('.').map(Number))));
            if (q.type === 5 && mode.cname) answers.push(answerRecord(5, encodeName(mode.cname)));
        }
        const head = Buffer.alloc(12);
        msg.copy(head, 0, 0, 2);
        head.writeUInt16BE(0x8180 | rcode, 2);
        head.writeUInt16BE(1, 4);
        head.writeUInt16BE(answers.length, 6);
        socket.send(Buffer.concat([head, msg.subarray(12, q.end), ...answers]), peer.port, peer.address);
    });
    await new Promise<void>((r) => socket.bind(0, '127.0.0.1', () => r()));
    dns.address = `127.0.0.1:${socket.address().port}`;
    dns.close = () => socket.close();
    return dns;
}

// ── The mock edge ──────────────────────────────────────────────────────────────────────────

type EdgeMode =
    | { kind: 'ours'; base: string }
    | { kind: 'key'; seed: Uint8Array; pk: string }
    | { kind: 'page' }
    | { kind: 'redirect' }
    | { kind: 'status'; code: number; body: string }
    | { kind: 'drop' };

interface Edge { origin: string; modes: Map<string, EdgeMode>; asks: Map<string, number>; total: () => number; close: () => void }

async function startEdge(sign: (seed: Uint8Array, nonce: string, ts: number) => string): Promise<Edge> {
    const edge: Edge = { origin: '', modes: new Map(), asks: new Map(), total: () => [...edge.asks.values()].reduce((a, b) => a + b, 0), close: () => {} };
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || '/', 'http://edge');
        const [, host, ...rest] = url.pathname.split('/');
        const nonce = url.searchParams.get('nonce') || '';
        edge.asks.set(host, (edge.asks.get(host) ?? 0) + 1);
        const mode = edge.modes.get(host) ?? { kind: 'drop' };
        if (`/${rest.join('/')}` !== '/api/attest' || mode.kind === 'drop') { req.socket.destroy(); return; }
        if (mode.kind === 'ours') {
            const got = await fetch(`${mode.base}/api/attest?nonce=${encodeURIComponent(nonce)}`).catch(() => null);
            if (!got) { req.socket.destroy(); return; }
            res.writeHead(got.status, { 'Content-Type': 'application/json' });
            res.end(await got.text());
        } else if (mode.kind === 'key') {
            const timestamp = Math.floor(Date.now() / 1000);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ pubkey: mode.pk, nonce, timestamp, signature: sign(mode.seed, nonce, timestamp) }));
        } else if (mode.kind === 'page') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<!doctype html><title>Welcome</title><p>Somebody else&apos;s site.</p>');
        } else if (mode.kind === 'redirect') {
            res.writeHead(302, { Location: 'https://elsewhere.example.org/' });
            res.end();
        } else {
            res.writeHead(mode.code, { 'Content-Type': 'text/plain' });
            res.end(mode.body);
        }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    edge.origin = `http://127.0.0.1:${(server.address() as any).port}`;
    edge.close = () => { server.closeAllConnections(); server.close(); };
    return edge;
}

// ── A port with no TLS behind it ───────────────────────────────────────────────────────────

/** A fatal `handshake_failure` alert (TLS 1.2 record, level 2, description 40), as an edge with no certificate for the name sends. */
const FATAL_ALERT = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28]);

/** A port that gets a ClientHello and answers it with `reply`, or hangs up with nothing. */
async function startBarePort(reply: Buffer | null): Promise<{ origin: string; close: () => void }> {
    const server = net.createServer((s) => {
        s.on('error', () => {});
        s.once('data', () => { if (reply) s.end(reply); else s.end(); });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return { origin: `https://localhost:${(server.address() as net.AddressInfo).port}`, close: () => server.close() };
}

// ── The suite ──────────────────────────────────────────────────────────────────────────────

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const OK_IP = '203.0.113.7';

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const { ed25519 } = await import('@noble/curves/ed25519.js');
    const { attestMessage } = await import('./services/registrar-client.js');
    const sign = (seed: Uint8Array, nonce: string, ts: number) =>
        Buffer.from(ed25519.sign(new TextEncoder().encode(attestMessage('v1', nonce, ts)), seed)).toString('hex');
    const seed = new Uint8Array(crypto.randomBytes(32));
    const K = { seed, pk: Buffer.from(ed25519.getPublicKey(seed)).toString('hex') };

    const dns = await startDns();
    const edge = await startEdge(sign);
    const addresses = [
        'fine.beanpool.org', 'quiet.beanpool.org', 'cf530.beanpool.org', 'gone.beanpool.org', 'oldname.example.org', 'otherkey.beanpool.org',
        'apage.beanpool.org', 'moved.beanpool.org', 'badcert.example.org', 'nas.lan', '192.168.1.20', 'splitview.example.org',
        'servfail.example.org',
    ];
    const nodes: NodeProc[] = [];
    try {
        console.log('A node checks each of its addresses from outside\n');
        const P = await spawnNode(SCRIPT, path.join(root, 'p'), {
            ADMIN_PASSWORD: PW, NODE_ROLE: 'primary', BEANPOOL_ADDRESSES: addresses.join(','), PUBLIC_ADDRESS_AUTO: undefined, PUBLIC_ADDRESS_NAME: undefined,
            CF_RECORD_NAME: undefined, CF_API_TOKEN: undefined, CF_ZONE_ID: undefined, BEANPOOL_TEST_EDGE_ORIGIN: edge.origin, BEANPOOL_SSRF_TEST_HOOK: '1',
            BEANPOOL_TEST_DNS_SERVER: dns.address, NODE_TLS_REJECT_UNAUTHORIZED: undefined,
        });
        nodes.push(P);
        const setup = await P.send('setup', { ownerSeedHex: crypto.randomBytes(32).toString('hex') });
        const pAdmin: Record<string, string> = await P.send('owner-session');
        const answered = () => ({ a: [OK_IP] });

        edge.modes.set('fine.beanpool.org', { kind: 'ours', base: setup.http });
        dns.modes.set('fine.beanpool.org', { a: ['104.21.93.179'], cname: 'edge.cloudflare.example.org' });
        dns.modes.set('quiet.beanpool.org', answered());
        dns.modes.set('cf530.beanpool.org', answered());
        edge.modes.set('cf530.beanpool.org', { kind: 'status', code: 530, body: 'error code: 1033' });
        dns.modes.set('otherkey.beanpool.org', answered());
        edge.modes.set('otherkey.beanpool.org', { kind: 'key', seed: K.seed, pk: K.pk });
        dns.modes.set('apage.beanpool.org', answered());
        edge.modes.set('apage.beanpool.org', { kind: 'page' });
        dns.modes.set('moved.beanpool.org', answered());
        edge.modes.set('moved.beanpool.org', { kind: 'redirect' });
        dns.modes.set('splitview.example.org', { a: ['192.168.1.20'] });
        dns.modes.set('servfail.example.org', { rcode: 2 });

        const ranRound = await P.send('round');
        assert(ranRound === true, `a round runs on the main server (${ranRound}; main: no such module)`);
        const report = await call(setup.https, 'GET', '/api/local/admin/app-addresses', pAdmin);
        const row = (host: string) => (report.body?.addresses ?? []).find((a: any) => a.address === host);
        const reach = (host: string) => row(host)?.reach;

        console.log('\n— 1. the name leads to this server —');
        await section('1', async () => {
            const r = reach('fine.beanpool.org');
            assert(r?.answers === 'own', `reach.answers === 'own' (${JSON.stringify(r ?? null)}; main: no reach)`);
            assert(r?.nextStep === 'Answers as this server. Nothing to do.', `and the words (${r?.nextStep})`);
            assert(r?.dns?.outcome === 'answers' && r?.dns?.a?.[0] === '104.21.93.179' && r?.dns?.cname?.[0] === 'edge.cloudflare.example.org',
                `what it points at is kept, from a real DNS answer (${JSON.stringify(r?.dns ?? null)})`);
            assert(r?.ownAt === r?.checkedAt && !Number.isNaN(Date.parse(r?.checkedAt)), `when it last answered as this server (${r?.ownAt})`);
            assert((edge.asks.get('fine.beanpool.org') ?? 0) === 1, `one ask is enough (${edge.asks.get('fine.beanpool.org')})`);
        });

        console.log('\n— 2. nothing answers —');
        await section('2', async () => {
            const r = reach('quiet.beanpool.org');
            assert(r?.answers === 'silence', `a dropped connection: 'silence' (${r?.answers})`);
            assert(r?.step === 'no-answer' && r?.nextStep === 'No answer here, checked from this server. Open the check link on your phone, on mobile data, to see what members see.',
                `and the words (${r?.nextStep})`);
            assert(reach('cf530.beanpool.org')?.answers === 'silence', `Cloudflare's 530 is silence, not a page (${reach('cf530.beanpool.org')?.answers})`);
            assert((edge.asks.get('quiet.beanpool.org') ?? 0) === 3, `three asks before it says so, as the name watch does (${edge.asks.get('quiet.beanpool.org')})`);
            assert(row('quiet.beanpool.org')?.lost !== true, 'nothing is lost by it');
        });

        console.log('\n— 3. the name does not resolve —');
        await section('3', async () => {
            const r = reach('gone.beanpool.org');
            assert(r?.dns?.outcome === 'no-such-name' && r?.answers === 'silence', `a real NXDOMAIN (${JSON.stringify(r?.dns ?? null)})`);
            assert(r?.step === 'no-dns-beanpool' && /Ask the BeanPool project/.test(r?.nextStep), `a BeanPool name the record doesn't hold never reads as new (${r?.step})`);
            assert(reach('oldname.example.org')?.step === 'no-dns-own' && /your domain's DNS/.test(reach('oldname.example.org')?.nextStep) && !/BeanPool/.test(reach('oldname.example.org')?.nextStep),
                `an own domain is pointed at its own DNS, and at nothing of ours (${reach('oldname.example.org')?.nextStep})`);
            const failed = reach('servfail.example.org');
            assert((dns.asks.get('servfail.example.org') ?? 0) >= 3, `the resolver was asked, once for each kind of record (${dns.asks.get('servfail.example.org')})`);
            assert(failed?.dns?.outcome === 'failed' && failed?.answers === 'silence', `a real SERVFAIL: 'failed', not 'no-such-name' (${JSON.stringify(failed?.dns ?? null)})`);
            assert(failed?.step === 'no-answer' && !/A record/.test(failed?.nextStep), `so a DNS outage sends nobody to fix a record (${failed?.step}: ${failed?.nextStep})`);

            const made = new Date(Date.now() - 12 * MIN).toISOString();
            const entry = (status: string) => [{ address: 'gone.beanpool.org', role: 'current', status, reason: null, since: made, formerSince: null, heldUntil: null, releasedByUsAt: null, renamedByUsAt: null, lost: null }];
            await P.send('registrarNames', { set: entry('live') });
            const fresh = (await P.send('reaches', {}))['gone.beanpool.org'];
            assert(fresh?.step === 'new-name' && fresh?.minutes === 12
                && fresh?.nextStep === "Made 12 minutes ago. Some networks remember 'no such name' for up to 30 minutes. Try mobile data, or wait.",
            `made 12 minutes ago: it says so (${fresh?.nextStep})`);
            const later = (await P.send('reaches', { offsetMs: 19 * MIN }))['gone.beanpool.org'];
            assert(later?.step === 'no-dns-beanpool', `31 minutes on it no longer does (${later?.step})`);
            await P.send('registrarNames', { set: entry('pending') });
            const pending = (await P.send('reaches', {}))['gone.beanpool.org'];
            assert(pending?.step === 'no-dns-beanpool', `a name still waiting for its record is no new name (${pending?.step})`);
            // An old node: the name stored as its address, not yet on the record, which stamps such a name as made now.
            await P.send('registrarNames', { set: [], publicAddress: { name: 'gone', hostname: 'gone.beanpool.org', status: 'live' } });
            const stored = (await P.send('reaches', {}))['gone.beanpool.org'];
            assert(stored?.step === 'no-dns-beanpool', `a name stored before the record never reads as made just now (${stored?.step})`);
            await P.send('registrarNames', { set: [] });
        });

        console.log('\n— 4. something else answers, and nothing is dropped —');
        await section('4', async () => {
            assert(reach('otherkey.beanpool.org')?.answers === 'other' && reach('otherkey.beanpool.org')?.step === 'another-server',
                `another key: 'other' (${JSON.stringify(reach('otherkey.beanpool.org') ?? null)})`);
            assert(reach('apage.beanpool.org')?.answers === 'other-origin', `a page: 'other-origin' (${reach('apage.beanpool.org')?.answers})`);
            assert(reach('moved.beanpool.org')?.answers === 'silence', `a redirect is not followed, and reads as silence (${reach('moved.beanpool.org')?.answers})`);
            assert((edge.asks.get('elsewhere.example.org') ?? 0) === 0, 'nothing asked where it pointed');
            assert(row('otherkey.beanpool.org')?.lost !== true, 'another key answering here marks nothing lost: only the name watch\'s proof does');
            const info = await call(setup.https, 'GET', '/api/community/info');
            assert((info.body?.addresses ?? []).includes('otherkey.beanpool.org'), 'and it is still published');
        });

        console.log('\n— 5. a certificate strict TLS refuses —');
        await section('5', async () => {
            dns.modes.set('badcert.example.org', answered());
            // The node's own HTTPS port: a certificate from its own CA, which no phone trusts.
            await P.send('env', { set: { BEANPOOL_TEST_EDGE_ORIGIN: setup.https } });
            await P.send('round');
            await P.send('env', { set: { BEANPOOL_TEST_EDGE_ORIGIN: edge.origin } });
            const r = (await P.send('reaches', {}))['badcert.example.org'];
            assert(r?.answers === 'tls' && r?.step === 'certificate', `'tls', from a real refused certificate (${JSON.stringify(r ?? null)})`);
            assert(/port 80/.test(r?.nextStep), `and what to open (${r?.nextStep})`);

            // Node raises EPROTO for the next two, on 22, 24 and 26: neither carries a certificate code.
            const answerAt = async (origin: string) => {
                await P.send('env', { set: { BEANPOOL_TEST_EDGE_ORIGIN: origin } });
                await P.send('round');
                await P.send('env', { set: { BEANPOOL_TEST_EDGE_ORIGIN: edge.origin } });
                return (await P.send('reaches', {}))['badcert.example.org'];
            };
            const plain = await answerAt(edge.origin.replace('http://127.0.0.1', 'https://localhost'));
            assert(plain?.answers === 'tls' && plain?.step === 'certificate', `plain HTTP on the TLS port: 'tls', not silence (${plain?.answers}, ${plain?.step})`);
            assert(plain?.nextStep === 'Answers, but not with a certificate phones trust. Check that port 80 is open and this address points at this server.',
                `and words that hold with no certificate on offer at all (${plain?.nextStep})`);
            for (const [what, reply, answer, step] of [
                ['a fatal TLS alert', FATAL_ALERT, 'tls', 'certificate'],
                ['a hang-up in the handshake', null, 'silence', 'no-answer'],
            ] as const) {
                const port = await startBarePort(reply);
                try {
                    const got = await answerAt(port.origin);
                    assert(got?.answers === answer && got?.step === step, `${what}: '${answer}' (${got?.answers}, ${got?.step})`);
                } finally {
                    port.close();
                }
            }
            await P.send('round');
        });

        console.log('\n— 6. a home-network address is not asked —');
        await section('6', async () => {
            const all = await P.send('reaches', {});
            for (const host of ['nas.lan', '192.168.1.20']) {
                assert(all[host]?.answers === null && all[host]?.step === 'home-network' && (edge.asks.get(host) ?? 0) === 0,
                    `${host}: not asked, and it says why (${JSON.stringify({ answers: all[host]?.answers, step: all[host]?.step, asks: edge.asks.get(host) ?? 0 })})`);
                assert(all[host]?.nextStep === "On a home network: nothing outside can reach it, so this server doesn't check it.", `${host}: nothing outside can reach that (${all[host]?.nextStep})`);
            }
            assert((dns.asks.get('nas.lan') ?? 0) === 0, 'a `.lan` name goes to no resolver either');
            const split = all['splitview.example.org'];
            assert(split?.answers === null && (edge.asks.get('splitview.example.org') ?? 0) === 0 && split?.dns?.a?.[0] === '192.168.1.20',
                `a name that points at one from here: not asked (${JSON.stringify({ answers: split?.answers, a: split?.dns?.a, asks: edge.asks.get('splitview.example.org') ?? 0 })})`);
            assert(split?.step === 'home-network-from-here'
                && split?.nextStep === "From this server this name points at a home-network address, so it can't be checked from here. Open the check link on your phone, on mobile data.",
            `and it claims only what this server can know: split DNS may serve phones outside perfectly well (${split?.step}: ${split?.nextStep})`);
        });

        console.log('\n— 7. no answer from here, at an own domain —');
        await section('7', async () => {
            const own = 'beans.example.org';
            assert((await P.send('step', { host: own, certified: [own] })) === 'from-inside', 'certificate held: checked from inside, a home router can fail this');
            assert((await P.send('step', { host: own, certified: [] })) === 'no-answer', 'no certificate: the plain words');
        });

        console.log('\n— 8. Check now —');
        await section('8', async () => {
            const stranger = await call(setup.https, 'POST', '/api/local/admin/app-addresses/check', {}, {});
            assert(stranger.status === 401 || stranger.status === 403, `a stranger is refused (${stranger.status})`);
            await new Promise((r) => setTimeout(r, 200));
            const pressed = await call(setup.https, 'POST', '/api/local/admin/app-addresses/check', pAdmin, {});
            const fine = (pressed.body?.addresses ?? []).find((a: any) => a.address === 'fine.beanpool.org');
            assert(pressed.status === 200, `an owner's press answers (${pressed.status} ${pressed.text.slice(0, 120)})`);
            assert(fine?.reach?.answers === 'own' && pressed.body?.checking === false, `with the report (${JSON.stringify(fine?.reach ?? null).slice(0, 120)})`);
            const asks = edge.total();
            const again = await call(setup.https, 'POST', '/api/local/admin/app-addresses/check', pAdmin, {});
            assert(again.status === 200 && edge.total() === asks, `a second press inside 30 seconds asks nothing more (${edge.total() - asks})`);
            await P.send('role', { role: 'backup' });
            await P.send('round');
            assert(edge.total() === asks, `a standby asks nothing (${edge.total() - asks})`);
            await P.send('role', { role: 'primary' });
        });

        console.log('\n— 9. the numbers go with the 7-day rule —');
        await section('9', async () => {
            const held = await P.send('retention', { offsetMs: 8 * DAY, copyTo: path.join(root, 'copy.db') });
            const host = 'fine.beanpool.org';
            assert(held.before[host]?.dns?.a?.length === 1, `the row holds what it pointed at today (${JSON.stringify(held.before[host]?.dns)})`);
            assert(held.after[host]?.dns?.a?.length === 0 && held.after[host]?.answers === 'own' && held.after[host]?.dns?.cname?.length === 1,
                `8 days on the number is gone, the rest stays (${JSON.stringify(held.after[host])})`);
            assert(!JSON.stringify(held.copied).includes(OK_IP) && !JSON.stringify(held.copied).includes('104.21.93.179') && held.copied[host]?.answers === 'own',
                `a copy of the database holds no number at all, whatever its age (${JSON.stringify(held.copied[host])})`);
            const split = (await P.send('reaches', {}))['splitview.example.org'];
            assert(split?.dns?.a?.length === 0 && split?.step === 'home-network-from-here', `with its number gone a split name still says what it said (${JSON.stringify(split?.dns)}, ${split?.step})`);
        });

        console.log('\n— 10. /check —');
        await section('10', async () => {
            await P.send('name', { name: 'Byron <b>Shire</b>' });
            const key = `····${String(setup.pubkey).slice(-4)}`;
            const visible = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<title>[\s\S]*?<\/title>/, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
            const page = await call(setup.https, 'GET', '/check', { Host: 'fine.beanpool.org' });
            const words = visible(page.text);
            const time = /Time (\d{4}-\d\d-\d\d \d\d:\d\d UTC)$/.exec(words)?.[1] ?? '';
            assert(page.status === 200 && /text\/html/.test(String(page.headers['content-type'])), `an HTML page (${page.status} ${page.headers['content-type']})`);
            assert(words === `This is Byron &lt;b&gt;Shire&lt;/b&gt; at fine.beanpool.org. Server key ${key} Time ${time}`,
                `name, host, key fingerprint, time, and nothing else: "${words}" (main: no such page)`);
            assert(Math.abs(Date.parse(`${time.replace(' UTC', '')}:00Z`) - Date.now()) < 2 * MIN, `the time is now (${time})`);
            assert(!/<script/i.test(page.text), 'no script');
            assert(!page.text.includes(setup.pubkey) && !page.text.includes(SECRET_MEMBER), 'not the whole key, and no member');
            assert(/no-store/.test(String(page.headers['cache-control'])), `never cached (${page.headers['cache-control']})`);
            const stranger = visible((await call(setup.https, 'GET', '/check', { Host: 'evil.example.com' })).text);
            assert(!stranger.includes('evil.example.com') && stranger.startsWith('This is Byron'), `a Host header that isn't one of ours is not repeated (${stranger})`);
            const ar = await call(setup.https, 'GET', '/check?lang=ar', { Host: 'fine.beanpool.org' });
            assert(/<html lang="ar" dir="rtl">/.test(ar.text), `the reader's language, right to left for Arabic (${ar.text.slice(0, 60).replace(/\n/g, ' ')})`);
            assert(String(page.headers.vary).includes('Accept-Language'), `by language (${page.headers.vary})`);
            const plain = await call(setup.http, 'GET', '/check', { Host: 'fine.beanpool.org' });
            assert(plain.status === 200 && visible(plain.text).startsWith('This is Byron'), `the plain-HTTP listener answers it too, for a proxy in front (${plain.status})`);
            const tunnel = await call(setup.http, 'GET', '/check', { Host: 'fine.beanpool.org', 'cf-connecting-ip': '198.51.100.9' });
            assert(tunnel.status === 200 && visible(tunnel.text).startsWith('This is Byron'), `and as the tunnel reaches it (${tunnel.status})`);
        });

        console.log('\n— 11. a name this community let go —');
        await section('11', async () => {
            // None of these is in BEANPOOL_ADDRESSES: a name listed there counts as listed, whatever the record says of it.
            const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
            const entry = (address: string, role: string, status: string, more: Record<string, unknown> = {}) => ({
                address, role, status, reason: null, since: ago(90 * DAY), formerSince: role === 'former' ? ago(40 * DAY) : null,
                heldUntil: null, releasedByUsAt: null, renamedByUsAt: null, lost: null, ...more,
            });
            for (const host of ['takenover.beanpool.org', 'lostname.beanpool.org', 'stillhere.beanpool.org']) dns.modes.set(host, answered());
            dns.modes.set('athome.beanpool.org', { a: ['192.168.1.21'] });
            edge.modes.set('takenover.beanpool.org', { kind: 'key', seed: K.seed, pk: K.pk });
            edge.modes.set('lostname.beanpool.org', { kind: 'key', seed: K.seed, pk: K.pk });
            edge.modes.set('stillhere.beanpool.org', { kind: 'ours', base: setup.http });
            await P.send('registrarNames', {
                set: [
                    entry('lostname.beanpool.org', 'current', 'none', { lost: { since: ago(DAY), why: 'another-key', holderKey: K.pk } }),
                    entry('letgo.beanpool.org', 'former', 'released'),
                    entry('takenover.beanpool.org', 'former', 'none'),
                    entry('justmoved.beanpool.org', 'former', 'live', { since: ago(12 * MIN) }),
                    entry('athome.beanpool.org', 'former', 'none'),
                    entry('stillhere.beanpool.org', 'former', 'none'),
                ],
            });
            await P.send('round');
            const list = (await call(setup.https, 'GET', '/api/local/admin/app-addresses', pAdmin)).body?.addresses ?? [];
            const at = (host: string) => list.find((a: any) => a.address === host);
            assert(at('letgo.beanpool.org')?.former === true && at('letgo.beanpool.org')?.reach?.dns?.outcome === 'no-such-name',
                `a real NXDOMAIN at a former name (${JSON.stringify(at('letgo.beanpool.org') ?? null)})`);
            for (const [host, why] of [
                ['letgo.beanpool.org', 'no DNS answer: no record to keep, and nobody to ask'],
                ['takenover.beanpool.org', 'another key answers: nothing to check'],
                ['justmoved.beanpool.org', 'a former name made minutes ago is no new name'],
                ['athome.beanpool.org', 'it points at a home network from here'],
                ['lostname.beanpool.org', 'a lost name, another key answering'],
            ] as const) {
                const r = at(host)?.reach;
                assert(r?.step === 'no-longer-ours' && r?.nextStep === "No longer this community's address. Nothing to do.", `${host}, ${why} (${r?.step}: ${r?.nextStep})`);
            }
            assert(at('lostname.beanpool.org')?.lost === true && at('lostname.beanpool.org')?.former !== true, 'and that one is lost, not former');
            assert(at('stillhere.beanpool.org')?.reach?.step === 'fine', `this server's key still answering at a former name is still said (${at('stillhere.beanpool.org')?.reach?.step})`);
            assert(at('otherkey.beanpool.org')?.reach?.step === 'another-server' && at('gone.beanpool.org')?.reach?.step === 'no-dns-beanpool',
                `a name in use, with the same answers, keeps its next step (${at('otherkey.beanpool.org')?.reach?.step}, ${at('gone.beanpool.org')?.reach?.step})`);
            await P.send('registrarNames', { set: [] });
        });
    } finally {
        for (const n of nodes) await n.kill('SIGKILL').catch(() => {});
        edge.close();
        dns.close();
    }
    console.log(`\n${passed}/${run} checks passed`);
    if (run === 0 || passed !== run) process.exitCode = 1;
}

if (process.argv.includes('--child')) {
    void child();
} else {
    main().catch((e) => { console.error(e); process.exit(1); }).finally(() => process.exit());
}

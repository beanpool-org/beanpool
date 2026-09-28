/**
 * Proof drops a name, and its own key brings it back (lost-name L3: services/registrar-name-watch.ts; design
 * scratch/registrar/DESIGN-lost-name-audience-opus.md §3, §4.2-4.4, §8 L3; Marty's answers, 2026-09-28). His rule of
 * 2026-09-24 over everything: a community never loses its own name through a check, a bug or a stale address service.
 *
 * Every node is a REAL server in its own process (takeover-test-harness.ts) with its real HTTPS and HTTP servers and
 * signature middleware. A member's request is signed (format 2) for a host, as an app that reached the community by that
 * name signs it, and sent over HTTPS. The registrar is a mock in this process (REGISTRAR_URL): status, claim, release, and
 * "who holds this name?" (/holder, design §5.1, built in parallel). So is Cloudflare's edge (BEANPOOL_TEST_EDGE_ORIGIN):
 * it answers /api/attest at each name as a step sets it: this server's own attestation (the name leads here, so the ask
 * is passed on to the node's own HTTP listener), another key's, a page, 530 "error code: 1033", a dropped connection. No
 * node reaches Docker, Cloudflare, any BeanPool node or the live registrar.
 *
 * The rule's clock is the test's: each round runs at a chosen time (its asks are real), from 50 hours ago on. K is the key
 * the mock registrar names as another community's holder; F is some other key.
 *
 * Node P (BEANPOOL_ADDRESSES=p2.test,envname.beanpool.org) holds one registrar name per case:
 *  1. fail-first: the registrar names K and K's own attestation answers at the name, on rounds at T and T+9 min → still
 *     200; at T+10 min → 421 wrong_community (main: 200).
 *  2. must stay 200: the registrar names K, but THIS server's attestation answers at the name, hourly for 48 h; Settings
 *     calls it a contradiction.
 *  3. must stay 200: every registrar answer alone, with K's attestation at the name for 48 h: none, revoked, released,
 *     blocked (written on the name by Settings, and answered by /holder), 401, a timeout, 404 (an older registrar), 5xx.
 *  4. must stay 200: the registrar names K and nothing answers at the name for 48 h: a dropped connection, a DNS failure,
 *     Cloudflare's 530.
 *  5. must stay 200: the registrar calls the name reserved (the fleet's names), K answers there, 48 h.
 *  6. must stay 200: this server's own attest fails over loopback, while the registrar names K and K answers, 48 h.
 *  7. a page answers at the name (E3), the registrar names K: 200 for 23 h of hourly rounds, 421 at 24 h (main: 200).
 *  8. another key than the one the registrar named answers (E2): no fast drop after 10 minutes.
 *  9. after a drop: a name also listed in BEANPOOL_ADDRESSES is refused (main: 200) and p2.test still accepted; Settings'
 *     confirm refuses a lost name (409, main: 200); members' refused apps are counted for Settings (`lost`, "n apps tried
 *     today"), a stranger's not; Settings says why; the drop is logged once, however many rounds follow.
 * 10. back: this server's attestation answering at a lost name restores it on the next round; a refused request asks for
 *     a round at once, and at most once in the rate limit.
 * 11. own release (decision D-B): Take offline, then 29 days on → 200; 30 days on, the registrar saying free → 421 (main:
 *     200); claiming it again → 200. Taken back inside the hold → 200 at 31 days. An older registrar (404) → 200.
 * Node U (its only name is its registrar name):
 * 12. before it has a name it asks the registrar nothing; its live name is asked about every 6 hours. After the drop: uname → 421 (main: 200); random.example → 421,
 *     never accepted as an unconfigured node's; Settings says it knows its names and offers nothing; uname is no longer
 *     published (main: published) nor its public address.
 * The take-over:
 * 13. N drops sname; its standby takes over with the recovery code and refuses sname at once (main: 200); this server's
 *     attestation at sname (the promoted standby's own key) brings it back on the next round.
 * A claim that lands during a round, on P:
 * 14. race is lost; a round starts, K's answer at the name taking 1.5 s, and 0.7 s in the admin claims race back: accepted
 *     on every request, during the round and after it (07535a17: 421 once the round ends). A claim, or a status holding the
 *     name, that brings it back between rounds starts the evidence again: 10 more minutes of K before it is lost again
 *     (07535a17: lost on the next round).
 * Node Q (its only name is its registrar name):
 * 15. a status that doesn't hold the name, newer than the registrar's last `you`: asked about every 5 minutes again
 *     (07535a17: 6 hours). The registrar naming K, with nothing answering at the name, for 48 h: never dropped. After a
 *     `you`, Settings' status check says none and K answers there: Settings says so at once, and it is dropped 15 minutes
 *     on (07535a17: nothing due for 6 hours, and Settings says nothing).
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx apps/server/src/test-registrar-name-watch.ts
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { spawnNode, post, runNodeChild, type NodeProc } from './takeover-test-harness.js';

const SCRIPT = fileURLToPath(import.meta.url);
const PW_P = 'Name-Watch-P-Pw-3317!';
const PW_U = 'Name-Watch-U-Pw-4428!';
const PW_N = 'Name-Watch-N-Pw-5539!';
const PW_STANDBY = 'Name-Watch-Standby-Pw-6640!';
const PW_Q = 'Name-Watch-Q-Pw-7751!';
/** The Cloudflare edge Settings' probe asks (routes/public-address.ts verifyEdgeStatus). */
const CF_EDGE_IP = '104.21.93.179';

// ── The node processes' commands ───────────────────────────────────────────────────────────

/**
 * No test node reaches Docker (writeToken restarts a cloudflared container through the Docker socket, and this machine
 * may have one) or Cloudflare's edge (Settings' claim and Take offline probe it). Their requests fail at once instead.
 */
function refuseDockerAndEdge(): void {
    const real = http.request;
    (http as any).request = function (this: unknown, ...args: any[]) {
        const o = args[0];
        const opts = o && typeof o === 'object' && !(o instanceof URL) ? o : null;
        if (opts && (opts.socketPath || opts.hostname === CF_EDGE_IP || opts.host === CF_EDGE_IP)) {
            const req: any = new EventEmitter();
            req.setTimeout = () => req;
            req.destroy = () => req;
            req.write = () => true;
            req.end = () => { setImmediate(() => req.emit('error', new Error('refused in tests'))); return req; };
            return req;
        }
        return (real as any).apply(this, args);
    };
}

let servers: { https: string; http: string } | null = null;

/**
 * This process's real HTTPS server (every route and the signature middleware a node runs) and its plain-HTTP listener
 * (which serves /api as the tunnel reaches it, and this server's own /api/attest over loopback), started once; then the
 * name watch, with rounds on demand only (the suite runs them at chosen times), and re-checks for refused requests.
 * The watch is loaded when needed, so the servers boot on a tree without it (the fail-first run on origin/main).
 */
async function start(): Promise<{ https: string; http: string; watch: boolean }> {
    if (!servers) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        delete process.env.CF_RECORD_NAME;
        const { initTls } = await import('./services/tls.js');
        const { startHttpsServer } = await import('./https-server.js');
        const { startHttpServer } = await import('./http-server.js');
        await initTls();
        const httpsPort = await startHttpsServer(0);
        const httpPort = await startHttpServer(0);
        servers = { https: `https://localhost:${httpsPort}`, http: `http://127.0.0.1:${httpPort}` };
    }
    const watch = await watchModule();
    watch?.startRegistrarNameWatch({ loopbackOrigin: servers.http, timer: false });
    return { ...servers, watch: !!watch };
}

const watchModule = () => import('./services/registrar-name-watch.js').catch(() => null);

async function child(): Promise<void> {
    refuseDockerAndEdge();
    await runNodeChild({
        setup: async (a: { ownerSeedHex: string; replicationToken?: string }) => {
            const { ed25519 } = await import('@noble/curves/ed25519.js');
            const se = await import('./state-engine.js');
            const anna = Buffer.from(ed25519.getPublicKey(Buffer.from(a.ownerSeedHex, 'hex'))).toString('hex');
            se.seedGenesisMember(anna, 'Anna');
            let code: string | null = null;
            if (a.replicationToken) {
                const { setReplicationToken } = await import('./config/local-config.js');
                const { makeRecoveryCode, flushTakeoverChecks } = await import('./services/takeover-envelope.js');
                setReplicationToken(a.replicationToken);
                code = (await makeRecoveryCode()).code;
                await flushTakeoverChecks();
            }
            const { nodePubkeyHex } = await import('./services/registrar-client.js');
            return { anna, code, pubkey: nodePubkeyHex(), ...(await start()) };
        },
        start: async () => start(),
        // One round per item, in order, each at its own time on the rule's clock (its asks are real). The rounds run far
        // faster than a real node's (one per name every 5 minutes at most), so the gateway's per-address limit, which
        // this server's own asks over loopback share with the edge passing asks on, is emptied before each: it is not
        // what's under test (a limited self-check only makes a round count for nothing).
        rounds: async (a: { list: { host: string; now: number; loopback?: string }[] }) => {
            const watch = await watchModule();
            if (!watch) return a.list.map((r) => ({ host: r.host, missing: true }));
            const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
            const out: unknown[] = [];
            for (const r of a.list) {
                resetGatewayRateLimit();
                out.push(await watch.checkRegistrarName(r.host, { now: r.now, ...(r.loopback !== undefined ? { loopbackOrigin: r.loopback } : {}) }));
            }
            return out;
        },
        due: async (a: { now: number }) => {
            const watch = await watchModule();
            if (!watch) return null;
            const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
            resetGatewayRateLimit();
            return watch.checkDueRegistrarNames({ now: a.now });
        },
        resetRecheck: async () => {
            (await watchModule())?.resetNameRecheckLimitForTests();
            return true;
        },
        env: async (a: { set: Record<string, string | null> }) => {
            for (const [k, v] of Object.entries(a.set)) {
                if (v === null) delete process.env[k]; else process.env[k] = v;
            }
            return true;
        },
        flush: async () => {
            const { flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            return { envelopeId: (await flushTakeoverChecks()).envelopeId };
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { addConnector } = await import('./connector-manager.js');
            const { updateLocalConfig } = await import('./config/local-config.js');
            addConnector(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`, 'mirror', 'main-server', undefined, false);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        pull: async () => {
            const { requestResync, pullTakeoverEnvelopeNow } = await import('./services/backup-puller.js');
            const { listHeldEnvelopes } = await import('./services/standby-envelopes.js');
            const resync = await requestResync();
            const envelope = await pullTakeoverEnvelopeNow();
            return { resync, envelope, held: listHeldEnvelopes().map((h) => h.envelopeId) };
        },
        // What the node holds, as stored, and its names as a request now sees them.
        inspect: async () => {
            const { db } = await import('./db/db.js');
            const se = await import('./state-engine.js');
            const { configuredAddresses, publishedAddresses, knowsItsNames, forgetOwnAddresses } = await import('./engine/own-addresses.js');
            const row = db.prepare("SELECT value FROM node_config WHERE key = 'node_config'").get() as { value?: string } | undefined;
            const stored = row?.value ? JSON.parse(row.value) : {};
            forgetOwnAddresses();
            return {
                registrarNames: stored.registrarNames ?? null,
                ownerAddresses: stored.ownerAddresses ?? null,
                configured: configuredAddresses(),
                published: publishedAddresses(),
                named: knowsItsNames(),
                publicUrl: se.resolvePublicNodeUrl(),
            };
        },
        // Anna's app (or a stranger's) reads its own standing here, signed (format 2) for each host, over this node's
        // real HTTPS server: each host's status, and a 421's code.
        bound: async (a: { seedHex: string; hosts: string[] }) => {
            const core = await import('@beanpool/core');
            const { ed25519 } = await import('@noble/curves/ed25519.js');
            const base = (servers ?? (await start())).https;
            const seed = new Uint8Array(Buffer.from(a.seedHex, 'hex'));
            const pk = Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
            const status: Record<string, number> = {};
            const code: Record<string, string | null> = {};
            for (const host of a.hosts) {
                const headers = await core.buildBoundRequestHeaders({ method: 'GET', url: `https://${host}/api/community/me`, body: '', publicKeyHex: pk, sign: core.ed25519Signer(seed) });
                const res = await fetch(`${base}/api/community/me`, { headers });
                const body: any = await res.json().catch(() => null);
                status[host] = res.status;
                code[host] = body?.code ?? null;
            }
            return { status, code };
        },
    });
}

// ── The orchestrator ───────────────────────────────────────────────────────────────────────

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

/** One numbered section: an error in it fails it and the next one still runs. */
async function section(n: string, body: () => Promise<void>): Promise<void> {
    try {
        await body();
    } catch (e: any) {
        assert(false, `section ${n} ran to the end (${e?.message || e})`);
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Reply { status: number; body: any }

/** A request to a node's HTTPS server (its certificate is self-signed), as Settings makes it. */
function call(base: string, method: string, route: string, headers: Record<string, string> = {}, body?: unknown): Promise<Reply> {
    const url = new URL(route, base);
    const text = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve) => {
        const req = https.request({
            host: url.hostname, port: url.port, path: url.pathname + url.search, method, rejectUnauthorized: false,
            headers: { ...(text !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(text)) } : {}), ...headers },
        }, (res) => {
            let out = '';
            res.on('data', (c) => { out += c; });
            res.on('end', () => {
                let parsed: any = out;
                try { parsed = JSON.parse(out); } catch { /* not JSON */ }
                resolve({ status: res.statusCode || 0, body: parsed });
            });
        });
        req.on('error', (e) => resolve({ status: 0, body: { networkError: e.message } }));
        if (text !== undefined) req.write(text);
        req.end();
    });
}
const show = (r: Reply) => `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`;

// ── The mock registrar ────────────────────────────────────────────────────────────────────

type HolderMode = { code: number; body?: unknown } | 'hang';

interface Registrar {
    url: string;
    status: any;
    release: any;
    /** /holder's answer per name (a bare label); by default `you`, live. */
    holder: Map<string, HolderMode>;
    holderCalls: Map<string, number>;
    calls: string[];
    close: () => void;
}

async function startRegistrar(): Promise<Registrar> {
    const reg: Registrar = { url: '', status: { status: 'none' }, release: { status: 'none' }, holder: new Map(), holderCalls: new Map(), calls: [], close: () => {} };
    const server = http.createServer((req, res) => {
        let text = '';
        req.on('data', (c) => { text += c; });
        req.on('end', () => {
            const send = (code: number, body: unknown) => {
                res.writeHead(code, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(body));
            };
            const p = new URL(req.url || '/', 'http://registrar').pathname;
            reg.calls.push(`${req.method} ${p}`);
            if (!req.headers['x-bp-pubkey'] || !req.headers['x-bp-timestamp'] || !req.headers['x-bp-signature']) return send(401, { error: 'unsigned' });
            if (req.method === 'GET' && p === '/api/registrar/status') return send(200, reg.status);
            if (req.method === 'POST' && p === '/api/registrar/claim') {
                const name = String(JSON.parse(text || '{}').name || '');
                // One token for every name, so a claim never waits for the tunnel sidecar to restart.
                return send(200, { status: 'live', name, hostname: `${name}.beanpool.org`, tunnelToken: 'T-shared' });
            }
            if (req.method === 'POST' && (p === '/api/registrar/offline' || p === '/api/registrar/release')) return send(200, reg.release);
            if (req.method === 'POST' && p === '/api/registrar/holder') {
                const name = String(JSON.parse(text || '{}').name || '');
                reg.holderCalls.set(name, (reg.holderCalls.get(name) ?? 0) + 1);
                const mode = reg.holder.get(name) ?? { code: 200, body: { name, held: 'you', state: 'live', since: 1 } };
                if (mode === 'hang') return; // never answers: the node gives up after 5 s
                return send(mode.code, mode.body ?? { error: `HTTP ${mode.code}` });
            }
            send(404, { error: 'not found' });
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    reg.url = `http://127.0.0.1:${(server.address() as any).port}`;
    reg.close = () => { server.closeAllConnections(); server.close(); };
    return reg;
}

// ── The mock edge ─────────────────────────────────────────────────────────────────────────

type EdgeMode =
    | { kind: 'ours'; base: string }
    /** `delayMs`: the answer takes that long. */
    | { kind: 'key'; seed: Uint8Array; pk: string; delayMs?: number }
    | { kind: 'page' }
    | { kind: 'status'; code: number; body: string }
    | { kind: 'drop' };

interface Edge { origin: string; modes: Map<string, EdgeMode>; asks: Map<string, number>; close: () => void }

async function startEdge(sign: (seed: Uint8Array, nonce: string, ts: number) => string): Promise<Edge> {
    const edge: Edge = { origin: '', modes: new Map(), asks: new Map(), close: () => {} };
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || '/', 'http://edge');
        const [, host, ...rest] = url.pathname.split('/');
        const nonce = url.searchParams.get('nonce') || '';
        edge.asks.set(host, (edge.asks.get(host) ?? 0) + 1);
        const mode = edge.modes.get(host) ?? { kind: 'drop' };
        if (`/${rest.join('/')}` !== '/api/attest' || mode.kind === 'drop') {
            req.socket.destroy();
            return;
        }
        if (mode.kind === 'ours') {
            // The name leads to this server: the ask reaches its own listener, as the tunnel would pass it on.
            const got = await fetch(`${mode.base}/api/attest?nonce=${encodeURIComponent(nonce)}`).catch(() => null);
            if (!got) { req.socket.destroy(); return; }
            res.writeHead(got.status, { 'Content-Type': 'application/json' });
            res.end(await got.text());
            return;
        }
        if (mode.kind === 'key') {
            if (mode.delayMs) await sleep(mode.delayMs);
            const timestamp = Math.floor(Date.now() / 1000);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ pubkey: mode.pk, nonce, timestamp, signature: sign(mode.seed, nonce, timestamp) }));
            return;
        }
        if (mode.kind === 'page') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<!doctype html><title>Welcome</title><p>Somebody else&apos;s site.</p>');
            return;
        }
        res.writeHead(mode.code, { 'Content-Type': 'text/plain' });
        res.end(mode.body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    edge.origin = `http://127.0.0.1:${(server.address() as any).port}`;
    edge.close = () => { server.closeAllConnections(); server.close(); };
    return edge;
}

// ── The suite ─────────────────────────────────────────────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** The rule's clock starts here, so a re-check a refused request asks for (at the real time) comes after every round. */
const T0 = Date.now() - 50 * HOUR;
/** Hourly rounds from T0 for `hours` hours, both ends included. */
const hourly = (hours: number, from = T0) => Array.from({ length: hours + 1 }, (_, i) => from + i * HOUR);
const host = (label: string) => `${label}.beanpool.org`;

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const { ed25519 } = await import('@noble/curves/ed25519.js');
    const { attestMessage } = await import('./services/registrar-client.js');
    const sign = (seed: Uint8Array, nonce: string, ts: number) =>
        Buffer.from(ed25519.sign(new TextEncoder().encode(attestMessage('v1', nonce, ts)), seed)).toString('hex');
    const keyOf = () => {
        const seed = new Uint8Array(crypto.randomBytes(32));
        return { seed, pk: Buffer.from(ed25519.getPublicKey(seed)).toString('hex') };
    };
    const K = keyOf();
    const F = keyOf();

    const dirs = { p: path.join(root, 'p'), u: path.join(root, 'u'), n: path.join(root, 'n'), standby: path.join(root, 'standby'), q: path.join(root, 'q') };
    const nodes: NodeProc[] = [];
    const ownerSeedHex = crypto.randomBytes(32).toString('hex');
    const strangerSeedHex = crypto.randomBytes(32).toString('hex');
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const reg = await startRegistrar();
    const edge = await startEdge(sign);
    const noAgent = {
        PUBLIC_ADDRESS_AUTO: undefined, PUBLIC_ADDRESS_NAME: undefined, CF_RECORD_NAME: undefined, CF_API_TOKEN: undefined, CF_ZONE_ID: undefined,
        REGISTRAR_URL: reg.url, BEANPOOL_TEST_EDGE_ORIGIN: edge.origin, BEANPOOL_TEST_IDENTITY_EPOCH_URL: undefined,
    };

    const other = (label: string, key = K.pk) => reg.holder.set(label, { code: 200, body: { name: label, held: 'other', holder_key: key, state: 'live', since: 1 } });
    const holderSays = (label: string, body: Record<string, unknown>) => reg.holder.set(label, { code: 200, body: { name: label, ...body } });
    const edgeKey = (label: string, k = K) => edge.modes.set(host(label), { kind: 'key', seed: k.seed, pk: k.pk });
    const rounds = (node: NodeProc, label: string, times: number[], loopback?: string): Promise<any[]> =>
        node.send('rounds', { list: times.map((now) => ({ host: host(label), now, ...(loopback !== undefined ? { loopback } : {}) })) });
    const bound = async (node: NodeProc, hosts: string[], seedHex = ownerSeedHex) => node.send('bound', { seedHex, hosts });
    const statusOf = async (node: NodeProc, h: string) => (await bound(node, [h])).status[h];
    const noneLost = (rs: any[]) => rs.every((r) => !r?.lost);
    const sum = (rs: any[]) => [...new Set(rs.map((r) => (r?.missing ? 'no watch' : `${r?.registrar}/${r?.edge ?? '-'}${r?.selfOk === false ? '/self-failed' : ''}`)))].join(', ');

    try {
        console.log('Proof drops a name, and its own key brings it back\n');

        // ── Node P ──
        const P = await spawnNode(SCRIPT, dirs.p, { ...noAgent, ADMIN_PASSWORD: PW_P, NODE_ROLE: 'primary', BEANPOOL_ADDRESSES: 'p2.test,envname.beanpool.org' });
        nodes.push(P);
        const pSetup = await P.send('setup', { ownerSeedHex });
        const pBase: string = pSetup.https;
        const pAdmin = { 'X-Admin-Password': PW_P };
        const claim = (base: string, admin: Record<string, string>, name: string) => call(base, 'POST', '/api/local/admin/public-address/claim', admin, { name, mode: 'tunnel' });
        const statusOpen = (base: string, admin: Record<string, string>) => call(base, 'GET', '/api/local/admin/public-address/status', admin);

        console.log('— P claims one registrar name per case —');
        // r-none first: the registrar's `none` names no name, so Settings writes it on the current one.
        const first = await claim(pBase, pAdmin, 'r-none');
        reg.status = { status: 'none' };
        const none = await statusOpen(pBase, pAdmin);
        const labels = ['fast', 'ours48', 'r-revoked', 'r-released', 'r-blocked', 'h-401', 'h-timeout', 'h-404', 'h-5xx',
            'e-drop', 'e-dns', 'e-530', 'reserved', 'self-fail', 'epage', 'foreign', 'recheck', 'envname', 'pcurrent'];
        const claimed = [first];
        for (const l of labels) claimed.push(await claim(pBase, pAdmin, l));
        for (const w of ['revoked', 'released', 'blocked']) {
            reg.status = { status: w, name: `r-${w}`, hostname: host(`r-${w}`) };
            await statusOpen(pBase, pAdmin);
        }
        const pNames = (await P.send('inspect')).registrarNames ?? [];
        const statusOfName = (l: string) => pNames.find((e: any) => e.address === host(l))?.status;
        assert(claimed.every((c) => c.status === 200) && none.status === 200 && pNames.length === labels.length + 1,
            `P holds ${pNames.length} registrar names, pcurrent current (${claimed.filter((c) => c.status !== 200).map(show).join('; ')})`);
        assert(['none', 'revoked', 'released', 'blocked'].every((w) => statusOfName(`r-${w}`) === w),
            `Settings wrote none, revoked, released and blocked on their names (${['none', 'revoked', 'released', 'blocked'].map((w) => statusOfName(`r-${w}`)).join(', ')})`);
        assert(pSetup.watch === true, `the name watch is running on P (${pSetup.watch}; main: no such module)`);

        // ── 1 ──
        console.log('\n— 1. the registrar names K and K answers at the name: dropped after 10 minutes, not before —');
        await section('1', async () => {
            other('fast');
            edgeKey('fast');
            const early = await rounds(P, 'fast', [T0, T0 + 9 * MIN]);
            assert(noneLost(early) && early.every((r) => r.missing || (r.registrar === 'other' && r.edge === 'holder' && r.counted === true)),
                `two counting rounds 9 minutes apart: not dropped (${sum(early)})`);
            assert((await statusOf(P, host('fast'))) === 200, 'fast.beanpool.org is still accepted');
            const at10 = await rounds(P, 'fast', [T0 + 10 * MIN]);
            assert(at10[0]?.lost?.why === 'another-key' && at10[0]?.lost?.holderKey === K.pk && at10[0]?.changed === 'lost',
                `at 10 minutes: lost, K named as its holder (${JSON.stringify(at10[0])})`);
            const r = await bound(P, [host('fast'), 'p2.test', host('pcurrent')]);
            assert(r.status[host('fast')] === 421 && r.code[host('fast')] === 'wrong_community',
                `a request signed for fast.beanpool.org → 421 wrong_community (${r.status[host('fast')]} ${r.code[host('fast')]}; main: 200)`);
            assert(r.status['p2.test'] === 200 && r.status[host('pcurrent')] === 200, `p2.test and pcurrent are still accepted (${r.status['p2.test']}, ${r.status[host('pcurrent')]})`);
        });

        // ── 2 ──
        console.log('\n— 2. the registrar names K, but this server answers at the name: 48 hours —');
        await section('2', async () => {
            other('ours48');
            edge.modes.set(host('ours48'), { kind: 'ours', base: pSetup.http });
            const rs = await rounds(P, 'ours48', hourly(48));
            assert(noneLost(rs) && rs.every((r) => r.missing || r.edge === 'own'), `49 hourly rounds, this server's key at the name on each: never dropped (${sum(rs)})`);
            assert((await statusOf(P, host('ours48'))) === 200, 'ours48.beanpool.org is accepted');
            const report = await call(pBase, 'GET', '/api/local/admin/app-addresses', pAdmin);
            const row = (report.body?.addresses ?? []).find((a: any) => a.address === host('ours48'));
            assert(row?.standing?.state === 'contradiction' && row?.standing?.leadsHere === true && !row?.lost,
                `Settings: the address service says another community holds it, but it still leads here (${JSON.stringify(row?.standing ?? null)})`);
        });

        // ── 3 ──
        console.log('\n— 3. every registrar answer alone, with K answering at the name: 48 hours —');
        await section('3', async () => {
            for (const w of ['none', 'revoked', 'released', 'blocked']) {
                holderSays(`r-${w}`, { held: w });
                edgeKey(`r-${w}`);
            }
            reg.holder.set('h-401', { code: 401, body: { error: 'bad signature', accepted_proto: ['v1'] } });
            reg.holder.set('h-404', { code: 404, body: { error: 'not found' } });
            reg.holder.set('h-5xx', { code: 503, body: { error: 'unavailable' } });
            reg.holder.set('h-timeout', 'hang');
            for (const l of ['h-401', 'h-404', 'h-5xx', 'h-timeout']) edgeKey(l);
            for (const l of ['r-none', 'r-revoked', 'r-released', 'r-blocked', 'h-401', 'h-404', 'h-5xx']) {
                const rs = await rounds(P, l, hourly(48));
                assert(noneLost(rs) && (await statusOf(P, host(l))) === 200, `${l}: 49 hourly rounds, never dropped, still accepted (${sum(rs)})`);
            }
            // Five rounds of a registrar that never answers (5 s each), at the moments the rule could act.
            const rs = await rounds(P, 'h-timeout', [T0, T0 + 10 * MIN, T0 + 20 * MIN, T0 + DAY, T0 + 2 * DAY]);
            assert(noneLost(rs) && rs.every((r) => r.missing || r.registrar === 'none') && (await statusOf(P, host('h-timeout'))) === 200,
                `h-timeout: the registrar times out on every round, never dropped, still accepted (${sum(rs)})`);
        });

        // ── 4 ──
        console.log('\n— 4. the registrar names K and nothing answers at the name: 48 hours —');
        await section('4', async () => {
            for (const l of ['e-drop', 'e-dns', 'e-530']) other(l);
            edge.modes.set(host('e-drop'), { kind: 'drop' });
            edge.modes.set(host('e-530'), { kind: 'status', code: 530, body: 'error code: 1033' });
            for (const l of ['e-drop', 'e-530']) {
                const rs = await rounds(P, l, hourly(48));
                assert(noneLost(rs) && rs.every((r) => r.missing || r.edge === 'silence') && (await statusOf(P, host(l))) === 200,
                    `${l}: silence at the name on 49 hourly rounds, never dropped, still accepted (${sum(rs)})`);
            }
            // A name that doesn't resolve: the node's asks go to a .invalid host (RFC 2606: never resolves).
            await P.send('env', { set: { BEANPOOL_TEST_EDGE_ORIGIN: 'http://edge-dns-failure.invalid' } });
            try {
                const rs = await rounds(P, 'e-dns', hourly(48));
                assert(noneLost(rs) && rs.every((r) => r.missing || r.edge === 'silence') && (await statusOf(P, host('e-dns'))) === 200,
                    `e-dns: a DNS failure at the name on 49 hourly rounds, never dropped, still accepted (${sum(rs)})`);
            } finally {
                await P.send('env', { set: { BEANPOOL_TEST_EDGE_ORIGIN: edge.origin } });
            }
        });

        // ── 5 ──
        console.log('\n— 5. the registrar calls the name reserved, K answers at it: 48 hours —');
        await section('5', async () => {
            holderSays('reserved', { held: 'reserved' });
            edgeKey('reserved');
            const rs = await rounds(P, 'reserved', hourly(48));
            assert(noneLost(rs) && (await statusOf(P, host('reserved'))) === 200, `never dropped, still accepted (${sum(rs)})`);
        });

        // ── 6 ──
        console.log("\n— 6. this server's own attest fails over loopback: 48 hours —");
        await section('6', async () => {
            other('self-fail');
            edgeKey('self-fail');
            const rs = await rounds(P, 'self-fail', hourly(48), 'http://127.0.0.1:1');
            assert(noneLost(rs) && rs.every((r) => r.missing || (r.selfOk === false && r.counted === false)) && (await statusOf(P, host('self-fail'))) === 200,
                `the registrar names K and K answers, but no round counts: never dropped, still accepted (${sum(rs)})`);
        });

        // ── 7 ──
        console.log('\n— 7. a page answers at the name (not an attestation): 23 hours kept, dropped at 24 —');
        await section('7', async () => {
            other('epage');
            edge.modes.set(host('epage'), { kind: 'page' });
            const rs = await rounds(P, 'epage', hourly(23));
            assert(noneLost(rs) && rs.every((r) => r.missing || (r.edge === 'other-origin' && r.counted)), `24 hourly rounds over 23 hours: not dropped (${sum(rs)})`);
            assert((await statusOf(P, host('epage'))) === 200, 'epage.beanpool.org is still accepted at 23 hours');
            const at24 = await rounds(P, 'epage', [T0 + 24 * HOUR]);
            assert(at24[0]?.lost?.why === 'another-key', `at 24 hours: lost (${JSON.stringify(at24[0])})`);
            assert((await statusOf(P, host('epage'))) === 421, `a request signed for epage.beanpool.org → 421 (main: 200)`);
        });

        // ── 8 ──
        console.log('\n— 8. a different key from the one the registrar named answers at the name —');
        await section('8', async () => {
            other('foreign');
            edgeKey('foreign', F);
            const rs = await rounds(P, 'foreign', [T0, T0 + 10 * MIN, T0 + 20 * MIN]);
            assert(noneLost(rs) && rs.every((r) => r.missing || r.edge === 'foreign') && (await statusOf(P, host('foreign'))) === 200,
                `the minutes rule needs both channels to name the same key: not dropped (${sum(rs)})`);
        });

        // ── 9 ──
        console.log('\n— 9. after a drop: every source, Settings, the counts, the log —');
        await section('9', async () => {
            other('envname');
            edgeKey('envname');
            const rs = await rounds(P, 'envname', [T0, T0 + 10 * MIN]);
            assert(rs[1]?.lost?.why === 'another-key', `envname is lost (${sum(rs)})`);
            const r = await bound(P, [host('envname'), 'p2.test']);
            assert(r.status[host('envname')] === 421, `envname.beanpool.org → 421 though BEANPOOL_ADDRESSES lists it (${r.status[host('envname')]}; main: 200)`);
            assert(r.status['p2.test'] === 200, `p2.test is still accepted (${r.status['p2.test']})`);

            const confirm = await call(pBase, 'POST', '/api/local/admin/app-addresses/confirm', pAdmin, { address: host('epage') });
            assert(confirm.status === 409 && confirm.body?.code === 'lost_address' && /another community/i.test(confirm.body?.error ?? ''),
                `Settings' confirm refuses the lost epage.beanpool.org (${show(confirm)}; main: 200)`);
            const s = await P.send('inspect');
            assert(!(s.ownerAddresses ?? []).includes(host('epage')), `and adds nothing (${JSON.stringify(s.ownerAddresses)})`);

            // Anna's app was refused at epage in section 7. A stranger's app is refused too, and not counted.
            const stranger = await bound(P, [host('epage')], strangerSeedHex);
            assert(stranger.status[host('epage')] === 421, `a stranger's request for epage → 421 (${stranger.status[host('epage')]})`);
            await statusOf(P, host('epage'));
            const report = await call(pBase, 'GET', '/api/local/admin/app-addresses', pAdmin);
            const row = (report.body?.addresses ?? []).find((a: any) => a.address === host('epage'));
            assert(row?.lost === true && row?.tried?.today === 1, `Settings: epage lost, 1 member's app tried today, the stranger's not counted (${JSON.stringify(row ?? null)})`);
            assert(row?.standing?.state === 'lost' && row?.standing?.why === 'another-key' && typeof row?.standing?.lostSince === 'string',
                `and says since when, and why (${JSON.stringify(row?.standing ?? null)})`);
            assert(report.body?.named === true, `P still knows its names (${report.body?.named})`);
            const env = (report.body?.addresses ?? []).find((a: any) => a.address === host('envname'));
            assert(env?.lost === true && env?.source === 'env', `envname is listed as BEANPOOL_ADDRESSES', and lost (${JSON.stringify(env ?? null)})`);

            const logged = P.output().split(`[Names] ${host('fast')}: the address service names another community's key`).length - 1;
            assert(logged === 1, `the drop of fast.beanpool.org is logged once, whatever rounds followed (${logged})`);
        });

        // ── 10 ──
        console.log("\n— 10. back: this server's key at a lost name, and a refused request asking for a look —");
        await section('10', async () => {
            edge.modes.set(host('fast'), { kind: 'ours', base: pSetup.http });
            const rs = await rounds(P, 'fast', [T0 + 11 * MIN]);
            assert(rs[0]?.changed === 'restored' && !rs[0]?.lost, `the next round sees this server's key at fast.beanpool.org: restored (${JSON.stringify(rs[0])})`);
            assert((await statusOf(P, host('fast'))) === 200, 'fast.beanpool.org is accepted again');
            const restoredLogs = P.output().split(`[Names] ${host('fast')}: the address service says another community's key`).length - 1;
            assert(restoredLogs === 2 && P.output().includes('but it still leads to this server. It stays accepted.'),
                `and logged once: still said to be another's, but leading here (${restoredLogs} lines: at risk, then this)`);

            other('recheck');
            edgeKey('recheck');
            const dropped = await rounds(P, 'recheck', [T0, T0 + 10 * MIN]);
            assert(dropped[1]?.lost, `recheck is lost (${sum(dropped)})`);
            await P.send('resetRecheck');
            const calls = () => reg.holderCalls.get('recheck') ?? 0;
            const waitFor = async (cond: () => boolean | Promise<boolean>) => {
                for (let i = 0; i < 60; i++) {
                    if (await cond()) return true;
                    await sleep(100);
                }
                return false;
            };
            const c0 = calls();
            assert((await statusOf(P, host('recheck'))) === 421, 'a request for recheck.beanpool.org → 421');
            assert(await waitFor(() => calls() === c0 + 1), `and the refusal asks the registrar again at once (${calls() - c0} ask(s); main: none)`);
            await sleep(500);
            assert((await statusOf(P, host('recheck'))) === 421, 'K still answers there: still 421');
            await sleep(800);
            assert(calls() === c0 + 1, `a second refusal inside 5 minutes asks nothing more (${calls() - c0})`);

            edge.modes.set(host('recheck'), { kind: 'ours', base: pSetup.http });
            assert((await statusOf(P, host('recheck'))) === 421, 'the name leads here now, but the refusal is inside the limit: 421');
            await sleep(800);
            assert(calls() === c0 + 1, `and asks nothing (${calls() - c0})`);
            await P.send('resetRecheck');
            assert((await statusOf(P, host('recheck'))) === 421, 'past the limit, the first request is still refused…');
            const back = await waitFor(async () => (await statusOf(P, host('recheck'))) === 200);
            assert(back, `…and within seconds recheck.beanpool.org is accepted again (main: never lost)`);
        });

        // ── 11 ──
        console.log('\n— 11. own release: accepted for the 30-day hold, then not —');
        await section('11', async () => {
            const NOW = Date.now();
            const heldUntilS = Math.floor(NOW / 1000) + 30 * 86_400;
            assert((await claim(pBase, pAdmin, 'tname')).status === 200, 'P claims tname');
            reg.release = { status: 'released', name: 'tname', held_until: heldUntilS };
            const off = await call(pBase, 'POST', '/api/local/admin/public-address/offline', pAdmin, {});
            assert(off.status === 200, `and takes it offline (${show(off)})`);
            holderSays('tname', { held: 'you', state: 'released', held_until: heldUntilS });
            const d29 = await rounds(P, 'tname', [NOW + 29 * DAY]);
            assert(noneLost(d29) && (await statusOf(P, host('tname'))) === 200, `29 days on, held for this community: accepted (${sum(d29)})`);
            holderSays('tname', { held: 'free' });
            const d30 = await rounds(P, 'tname', [NOW + 30 * DAY + MIN]);
            assert(d30[0]?.lost?.why === 'released', `30 days on, the registrar says free: lost, released by this community (${JSON.stringify(d30[0])})`);
            assert((await statusOf(P, host('tname'))) === 421, 'a request signed for tname.beanpool.org → 421 (main: 200)');
            assert((await claim(pBase, pAdmin, 'tname')).status === 200 && (await statusOf(P, host('tname'))) === 200,
                'claiming it again brings it back: 200');

            // Taken back inside the hold: no timer.
            await claim(pBase, pAdmin, 'tback');
            reg.release = { status: 'released', name: 'tback', held_until: heldUntilS };
            await call(pBase, 'POST', '/api/local/admin/public-address/offline', pAdmin, {});
            assert((await claim(pBase, pAdmin, 'tback')).status === 200, 'P releases tback, then takes it back inside the hold');
            holderSays('tback', { held: 'free' });
            const tb = await rounds(P, 'tback', [NOW + 31 * DAY]);
            assert(noneLost(tb) && (await statusOf(P, host('tback'))) === 200, `31 days on, even with the registrar saying free: accepted (${sum(tb)})`);

            // An older registrar can't say: nothing is dropped.
            await claim(pBase, pAdmin, 'told');
            reg.release = { status: 'released', name: 'told', held_until: heldUntilS };
            await call(pBase, 'POST', '/api/local/admin/public-address/offline', pAdmin, {});
            reg.holder.set('told', { code: 404, body: { error: 'not found' } });
            const to = await rounds(P, 'told', [NOW + 31 * DAY]);
            assert(noneLost(to) && (await statusOf(P, host('told'))) === 200, `released, 31 days on, an older registrar (404): accepted (${sum(to)})`);
        });

        // ── 12 ──
        console.log('\n— 12. a node whose only name is its registrar name —');
        await section('12', async () => {
            const U = await spawnNode(SCRIPT, dirs.u, { ...noAgent, ADMIN_PASSWORD: PW_U, NODE_ROLE: 'primary', BEANPOOL_ADDRESSES: undefined });
            nodes.push(U);
            const uSetup = await U.send('setup', { ownerSeedHex });
            const uAdmin = { 'X-Admin-Password': PW_U };
            const holderAsks = () => [...reg.holderCalls.values()].reduce((a, b) => a + b, 0);
            const before = holderAsks();
            const due = await U.send('due', { now: Date.now() });
            assert((due === null || (Array.isArray(due) && due.length === 0)) && holderAsks() === before,
                `with no registrar name, it asks the registrar nothing (${JSON.stringify(due)})`);

            reg.status = { status: 'live', name: 'uname', hostname: host('uname'), mode: 'tunnel', tunnelToken: 'T-shared' };
            const opened = await statusOpen(uSetup.https, uAdmin);
            assert(opened.status === 200 && opened.body?.hostname === host('uname'), `U stores uname (${show(opened)})`);
            const firstDue = await U.send('due', { now: Date.now() });
            assert(Array.isArray(firstDue) && firstDue.length === 1 && firstDue[0]?.registrar === 'you' && !firstDue[0]?.lost,
                `now it asks, and the registrar says uname is its own (${JSON.stringify(firstDue)})`);
            // Its current, live name, which the registrar says is its own: asked about every 6 hours, not every 5 minutes.
            const quiet = await U.send('due', { now: Date.now() + 10 * MIN });
            const later = await U.send('due', { now: Date.now() + 6 * HOUR + MIN });
            assert(Array.isArray(quiet) && quiet.length === 0 && Array.isArray(later) && later.length === 1,
                `ten minutes on nothing is due; six hours on it is (${JSON.stringify(quiet)}, ${JSON.stringify(later)})`);

            other('uname');
            edgeKey('uname');
            const rs = await rounds(U, 'uname', [T0, T0 + 10 * MIN]);
            assert(rs[1]?.lost?.why === 'another-key', `uname is lost (${sum(rs)})`);
            const r = await bound(U, [host('uname'), 'random.example']);
            assert(r.status[host('uname')] === 421, `uname.beanpool.org → 421 (${r.status[host('uname')]}; main: 200)`);
            assert(r.status['random.example'] === 421, `random.example → 421: never accepted as an unconfigured node's (${r.status['random.example']})`);
            const report = await call(uSetup.https, 'GET', '/api/local/admin/app-addresses?host=random.example', uAdmin);
            assert(report.body?.named === true && (report.body?.unconfirmed ?? []).length === 0 && (report.body?.heldBack ?? []).length === 0,
                `Settings: U knows its names and offers no address (named ${report.body?.named}, ${JSON.stringify(report.body?.unconfirmed)}, ${JSON.stringify(report.body?.heldBack)})`);
            const info = await call(uSetup.https, 'GET', '/api/community/info');
            assert(Array.isArray(info.body?.addresses) && !info.body.addresses.includes(host('uname')),
                `/api/community/info no longer publishes uname (${JSON.stringify(info.body?.addresses)}; main: published)`);
            const s = await U.send('inspect');
            assert(s.publicUrl === null, `nor is it this community's public address (${s.publicUrl}; main: https://uname.beanpool.org)`);
            await U.kill('SIGKILL');
        });

        // ── 13 ──
        console.log('\n— 13. a promoted standby refuses a lost name at once, and restores it on its own key —');
        await section('13', async () => {
            const N = await spawnNode(SCRIPT, dirs.n, { ...noAgent, ADMIN_PASSWORD: PW_N, NODE_ROLE: 'primary', BEANPOOL_ADDRESSES: undefined });
            nodes.push(N);
            const nSetup = await N.send('setup', { ownerSeedHex, replicationToken });
            const nAdmin = { 'X-Admin-Password': PW_N };
            assert((await claim(nSetup.https, nAdmin, 'sname')).status === 200, 'N claims sname');

            fs.mkdirSync(dirs.standby, { recursive: true });
            fs.copyFileSync(path.join(dirs.n, 'genesis.json'), path.join(dirs.standby, 'genesis.json'));
            let standby = await spawnNode(SCRIPT, dirs.standby, { ...noAgent, ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', BEANPOOL_ADDRESSES: undefined });
            nodes.push(standby);
            await standby.send('setup-standby', { primaryUrl: N.base, replicationToken, primaryPeerId: N.ready.peerId });

            other('sname');
            edgeKey('sname');
            const rs = await rounds(N, 'sname', [T0, T0 + 10 * MIN]);
            assert(rs[1]?.lost?.why === 'another-key' && (await statusOf(N, host('sname'))) === 421, `N drops sname (${sum(rs)})`);

            const flushed = await N.send('flush');
            const pulled = await standby.send('pull');
            assert(pulled.envelope === 'stored' && pulled.held.at(-1) === flushed.envelopeId, `the standby holds N's newest keys (${pulled.envelope}, ${flushed.envelopeId})`);
            await N.kill('SIGKILL');
            const opened = await post(standby.base, '/api/local/admin/takeover/open', { code: nSetup.code }, { 'X-Admin-Password': PW_STANDBY });
            assert(opened.status === 200 && opened.body?.preview?.sessionId, `the recovery code opens the keys (${opened.status})`);
            const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body?.preview?.sessionId, confirm: true }, { 'X-Admin-Password': PW_STANDBY });
            assert(confirmed.status === 200, `the take-over is confirmed (${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 160)})`);
            assert((await standby.exited) === 0, 'the standby restarts itself');
            standby = await spawnNode(SCRIPT, dirs.standby, { ...noAgent, ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', BEANPOOL_ADDRESSES: undefined });
            nodes.push(standby);
            assert(standby.ready.role === 'primary', 'it is the main server now');
            const sStart = await standby.send('start');
            const s = await standby.send('inspect');
            const sname = (s.registrarNames ?? []).find((e: any) => e.address === host('sname'));
            assert(sname?.lost?.why === 'another-key', `the lost mark came with the keys (${JSON.stringify(sname ?? null)})`);
            assert((await statusOf(standby, host('sname'))) === 421, 'the promoted standby refuses sname.beanpool.org at once (main: 200)');

            // The refusal above asked for a round too: whichever comes first sees this server's key there.
            edge.modes.set(host('sname'), { kind: 'ours', base: sStart.http });
            const back = await rounds(standby, 'sname', [T0 + 20 * MIN]);
            assert(back[0]?.edge === 'own' && back[0]?.lost === null && (await statusOf(standby, host('sname'))) === 200,
                `its own key answering at sname brings it back by the next round (${JSON.stringify(back[0])})`);
        });

        // ── 14 ──
        console.log('\n— 14. a claim that lands while a round is still asking: that round never undoes it —');
        await section('14', async () => {
            assert((await claim(pBase, pAdmin, 'race')).status === 200, 'P claims race');
            other('race');
            edgeKey('race');
            const dropped = await rounds(P, 'race', [T0, T0 + 10 * MIN]);
            assert(dropped[1]?.lost?.why === 'another-key', `race is lost (${sum(dropped)})`);
            // The refusal asks for a round (it sees K again) and uses the re-check limit: from now on a refusal waits for
            // the next round, as it would where the old holder relays members' requests here.
            assert((await statusOf(P, host('race'))) === 421, 'a request signed for race.beanpool.org → 421');
            await rounds(P, 'race', [T0 + 11 * MIN]);

            // K's answer at the name now takes 1.5 s, so the round spends about 4.5 s asking there; the admin claims the
            // name back 0.7 s in, and the registrar now says it is this key's.
            edge.modes.set(host('race'), { kind: 'key', seed: K.seed, pk: K.pk, delayMs: 1500 });
            let done = false;
            const inFlight = rounds(P, 'race', [T0 + 20 * MIN]).finally(() => { done = true; });
            await sleep(700);
            holderSays('race', { held: 'you', state: 'live' });
            const back = await claim(pBase, pAdmin, 'race');
            assert(back.status === 200 && !done, `0.7 s into the round, the admin claims race again (${show(back)}; the round still asking: ${!done})`);
            const seen: number[] = [];
            while (!done) {
                seen.push(await statusOf(P, host('race')));
                await sleep(200);
            }
            const raced = await inFlight;
            for (let i = 0; i < 3; i++) seen.push(await statusOf(P, host('race')));
            assert(seen.length > 6 && seen.every((s) => s === 200),
                `accepted on every request from the claim until after the round (${seen.join(' ')}; 07535a17: 421 once the round ends)`);
            assert(raced[0]?.registrar === 'other' && raced[0]?.edge === 'holder' && !raced[0]?.lost && raced[0]?.changed !== 'lost',
                `the round that was still asking (the registrar named K, K answered) did not mark it lost (${JSON.stringify(raced[0])})`);
            const s = await P.send('inspect');
            const entry = (s.registrarNames ?? []).find((e: any) => e.address === host('race'));
            assert(entry?.lost === null && entry?.role === 'current', `the record keeps race as the current name, not lost (${JSON.stringify(entry ?? null)})`);

            // The registrar naming K again at once, K answering: the evidence from before the claim starts again from
            // nothing, so it takes 10 more minutes of both.
            edgeKey('race');
            other('race');
            const again = await rounds(P, 'race', [T0 + 21 * MIN, T0 + 30 * MIN]);
            assert(noneLost(again) && (await statusOf(P, host('race'))) === 200,
                `two rounds 9 minutes apart after the claim: still accepted (${sum(again)}; 07535a17: lost)`);
            const at31 = await rounds(P, 'race', [T0 + 31 * MIN]);
            assert(at31[0]?.lost?.why === 'another-key', `10 minutes of both channels after the claim: lost again (${JSON.stringify(at31[0])})`);

            // A claim between rounds does the same.
            assert((await claim(pBase, pAdmin, 'race')).status === 200 && (await statusOf(P, host('race'))) === 200, 'claimed back between rounds: 200');
            const afterClaim = await rounds(P, 'race', [T0 + 32 * MIN]);
            assert(noneLost(afterClaim) && (await statusOf(P, host('race'))) === 200,
                `the next round, the registrar still naming K and K answering: not lost at once (${JSON.stringify(afterClaim[0])}; 07535a17: lost)`);
            const at42 = await rounds(P, 'race', [T0 + 42 * MIN]);
            assert(at42[0]?.lost?.why === 'another-key', `10 minutes on: lost (${JSON.stringify(at42[0])})`);

            // So does a status holding the name for this key (Settings' status check: paused, naming race).
            reg.status = { status: 'paused', name: 'race', hostname: host('race') };
            assert((await statusOpen(pBase, pAdmin)).status === 200 && (await statusOf(P, host('race'))) === 200,
                'a status holding race for this key brings it back: 200');
            const afterStatus = await rounds(P, 'race', [T0 + 43 * MIN]);
            assert(noneLost(afterStatus) && (await statusOf(P, host('race'))) === 200,
                `the next round, the registrar naming K and K answering: not lost at once (${JSON.stringify(afterStatus[0])}; 07535a17: lost)`);
            const at53 = await rounds(P, 'race', [T0 + 53 * MIN]);
            assert(at53[0]?.lost?.why === 'another-key', `10 minutes on: lost (${JSON.stringify(at53[0])})`);
        });

        // ── 15 ──
        console.log("\n— 15. a status newer than the registrar's last `you`: watched every 5 minutes again —");
        await section('15', async () => {
            const Q = await spawnNode(SCRIPT, dirs.q, { ...noAgent, ADMIN_PASSWORD: PW_Q, NODE_ROLE: 'primary', BEANPOOL_ADDRESSES: undefined });
            nodes.push(Q);
            const qSetup = await Q.send('setup', { ownerSeedHex });
            const qAdmin = { 'X-Admin-Password': PW_Q };
            const due = async (at: number) => ((await Q.send('due', { now: at })) ?? []) as any[];
            const qname = host('qname');
            const standing = async () => {
                const report = await call(qSetup.https, 'GET', '/api/local/admin/app-addresses', qAdmin);
                return (report.body?.addresses ?? []).find((a: any) => a.address === qname)?.standing ?? null;
            };

            reg.status = { status: 'live', name: 'qname', hostname: qname, mode: 'tunnel', tunnelToken: 'T-shared' };
            const opened = await statusOpen(qSetup.https, qAdmin);
            assert(opened.status === 200 && opened.body?.hostname === qname, `Q stores qname, live (${show(opened)})`);
            const t1 = Date.now();
            const r0 = await due(t1);
            assert(r0.length === 1 && r0[0]?.registrar === 'you', `the registrar says qname is Q's own (${JSON.stringify(r0)})`);
            const quiet = await due(t1 + 5 * MIN + 1_000);
            assert(quiet.length === 0, `current, live, and the registrar's own: nothing due 5 minutes on (${JSON.stringify(quiet)})`);

            // The registrar's word alone: Settings' status check says revoked, /holder names K, nothing answers at the name.
            reg.status = { status: 'revoked', name: 'qname', hostname: qname };
            await statusOpen(qSetup.https, qAdmin);
            other('qname');
            edge.modes.set(qname, { kind: 'drop' });
            const w10 = await due(t1 + 10 * MIN + 1_000);
            assert(w10.length === 1 && w10[0]?.registrar === 'other' && w10[0]?.edge === 'silence' && !w10[0]?.lost,
                `revoked after the registrar's \`you\`: a round is due, and hears nothing at the name (${JSON.stringify(w10)}; 07535a17: nothing due)`);
            const words: any[] = [];
            for (const at of [20 * MIN, HOUR, 6 * HOUR, DAY, 2 * DAY]) words.push(...(await due(t1 + at)));
            assert(words.length === 5 && noneLost(words) && (await statusOf(Q, qname)) === 200,
                `the registrar naming K, silence at the name, rounds over 48 hours: never dropped, still accepted (${sum(words)})`);

            // The registrar says `you` again; then Settings' status check says none, and it names K, who answers there.
            holderSays('qname', { held: 'you', state: 'live' });
            const t2 = t1 + 2 * DAY + 10 * MIN;
            const yours = await due(t2);
            assert(yours.length === 1 && yours[0]?.registrar === 'you', `the registrar says qname is Q's again (${JSON.stringify(yours)})`);
            reg.status = { status: 'none' };
            await statusOpen(qSetup.https, qAdmin);
            const said = await standing();
            assert(said?.state === 'at-risk' && said?.registrarSays === 'none',
                `Settings says at once that the address service says none (${JSON.stringify(said)}; 07535a17: nothing)`);
            other('qname');
            edgeKey('qname');
            const d5 = await due(t2 + 5 * MIN + 1_000);
            assert(d5.length === 1 && d5[0]?.registrar === 'other' && d5[0]?.edge === 'holder' && d5[0]?.counted === true && !d5[0]?.lost,
                `5 minutes on, a round is due and sees K there (${JSON.stringify(d5)}; 07535a17: nothing due until 6 hours on)`);
            const d10 = await due(t2 + 10 * MIN + 2_000);
            assert(d10.length === 1 && noneLost(d10), `10 minutes on: K again, not yet lost (${JSON.stringify(d10)})`);
            const d15 = await due(t2 + 15 * MIN + 3_000);
            assert(d15.length === 1 && d15[0]?.lost?.why === 'another-key' && d15[0]?.lost?.holderKey === K.pk,
                `15 minutes on: lost, K its holder (${JSON.stringify(d15)}; 07535a17: 6 hours 10 minutes)`);
            assert((await statusOf(Q, qname)) === 421, 'a request signed for qname.beanpool.org → 421');
            await Q.kill('SIGKILL');
        });

        assert(!reg.calls.some((c) => !/^(GET|POST) \/api\/registrar\/(status|claim|offline|holder)$/.test(c)),
            `the nodes asked the mock registrar only for status, claim, release and holder (${[...new Set(reg.calls)].join(', ')})`);
    } catch (e: any) {
        assert(false, `the suite ran to the end (${e?.message || e})`);
        for (const n of nodes) console.error(`--- node output (tail) ---\n${n.output().slice(-2500)}`);
    } finally {
        for (const n of nodes) await n.kill('SIGKILL').catch(() => {});
        reg.close();
        edge.close();
    }
    console.log(`\n${passed}/${run} checks passed.`);
    process.exit(process.exitCode ?? 0);
}

if (process.argv.includes('--child')) {
    child().catch((e) => { console.error(e); process.exit(1); });
} else {
    main().catch((e) => { console.error(e); process.exit(1); });
}

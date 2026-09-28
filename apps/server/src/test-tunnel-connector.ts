/**
 * The tunnel runs inside the server (services/tunnel-connector.ts; design
 * scratch/global-node/DESIGN-tunnel-without-docker-socket-opus.md §3.4, §4).
 *
 * On main no connector exists: the server wrote data/tunnel-token and restarted a cloudflared container through Docker's
 * control socket. Every check below fails there (the module doesn't exist).
 *
 * One server in this process, its registrar a mock (REGISTRAR_URL), its cloudflared the fake
 * (__fixtures__/fake-cloudflared.mjs): no suite ever starts the real binary, and nothing here reaches Docker, Cloudflare's
 * edge or the live registrar.
 *
 *  1. No publicAddress → no child. 8. A leftover data/tunnel-token (the fleet token deploy.sh wrote) is deleted at boot and
 *     never run. And the warning when Docker's socket is still mounted.
 *  9. The binary missing → state `missing`, one log line, no crash loop.
 *  2. A live tunnel address → a child with TUNNEL_TOKEN = the token; --no-autoupdate, metrics on 127.0.0.1, --loglevel info;
 *     the token never in argv; only the allowlisted environment (no ADMIN_PASSWORD, CF_API_TOKEN, IMAGE_S3_*, …).
 *     Its log: warnings forwarded once with repeats counted, never debug, never the token.
 * 10. A saved live name without an origin → one heal claim with the loopback origin once /ready says connected, recorded,
 *     not repeated after a restart of the tunnel or of the process.
 *  3. The registrar answers a new token → the agent's refresh (no human) restarts the child on it; `none` claims nothing.
 *  4. "Unauthorized" past the threshold: a new token from /status → restart; the same token → exactly one claim of the
 *     saved name, then its token; more Unauthorized inside the debounce → no second claim.
 *  5. The child crashes over and over → respawned with growing, capped backoff; never two at once.
 *  6. A standby (role backup) with a publicAddress → no child. A take-over waiting on its tunnel step holds it; the step
 *     starts it.
 * 11. Two syncs in the same tick with different tokens → never two children.
 *  7. Settings: the claim sends the loopback origin; status shows the tunnel; Take offline stops the child and clears
 *     the address; Restart tunnel with no address says so.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-tunnel-connector.ts
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import Koa from 'koa';
import { initStateEngine, getNodeConfig, updateNodeConfig } from './state-engine.js';
import { setNodeRole } from './config/node-role.js';
import { startP2P } from './p2p.js';
import { db } from './db/db.js';
import {
    initTunnelConnector, syncTunnel, restartTunnel, startTunnelForTakeover, persistAddress, getTunnelStatus, dockerSocketMounted,
    setTunnelConnectorForTests, tunnelConnectorForTests, resetTunnelConnectorForTests, LOOPBACK_ORIGIN,
} from './services/tunnel-connector.js';
import { reconcile } from './services/public-address-agent.js';
import { createPublicAddressRoutes } from './routes/public-address.js';
import { useFakeCloudflared, type FakeTunnel } from './tunnel-test-fake.js';
import type { RouteDeps } from './routes/types.js';

const DATA = process.env.BEANPOOL_DATA_DIR;
if (!DATA) { console.error('Set BEANPOOL_DATA_DIR to a throwaway directory'); process.exit(1); }

// Secrets the server's environment holds: none may reach the child.
const SENTINELS: Record<string, string> = {
    ADMIN_PASSWORD: 'SENTINEL-admin-pw-7c1f93',
    CF_API_TOKEN: 'SENTINEL-cf-api-4d2a18',
    IMAGE_S3_SECRET_ACCESS_KEY: 'SENTINEL-s3-9e0b44',
    IMAGE_S3_ACCESS_KEY_ID: 'SENTINEL-s3-id-51c2',
    INSTAGRAM_APP_SECRET: 'SENTINEL-ig-3a5577',
    TIKTOK_CLIENT_SECRET: 'SENTINEL-tt-80be12',
};
Object.assign(process.env, SENTINELS);
delete process.env.PUBLIC_ADDRESS_AUTO;
delete process.env.PUBLIC_ADDRESS_NAME;

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}
async function section(name: string, body: () => Promise<void>): Promise<void> {
    console.log(`\n— ${name} —`);
    try { await body(); } catch (e: any) { assert(false, `section "${name}" ran to the end (${e?.stack || e})`); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5_000): Promise<boolean> {
    const end = Date.now() + ms;
    while (!cond()) { if (Date.now() > end) return false; await sleep(20); }
    return true;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Settings' edge probe (routes/public-address.ts) asks Cloudflare's edge; here it is refused at once. */
const CF_EDGE_IP = '104.21.93.179';
function refuseEdge(): void {
    const real = http.request;
    (http as any).request = function (this: unknown, ...args: any[]) {
        const o = args[0];
        const opts = o && typeof o === 'object' && !(o instanceof URL) ? o : null;
        if (opts && (opts.hostname === CF_EDGE_IP || opts.host === CF_EDGE_IP)) {
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

// ── The mock registrar ───────────────────────────────────────────────────────────────────────

interface Call { method: string; path: string; body: any }
const reg = {
    calls: [] as Call[],
    status: (): any => ({ status: 'none' }),
    claim: (b: any): any => ({ status: 'live', name: b.name, hostname: `${b.name}.beanpool.org`, mode: 'tunnel', tunnelToken: `T-claim-${b.name}` }),
    offline: (): any => ({ status: 'released' }),
};
const claims = () => reg.calls.filter((c) => c.path === '/api/registrar/claim');
const statuses = () => reg.calls.filter((c) => c.path === '/api/registrar/status');

async function startRegistrar(): Promise<http.Server> {
    const server = http.createServer((req, res) => {
        let text = '';
        req.on('data', (c) => { text += c; });
        req.on('end', () => {
            const send = (code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
            if (!req.headers['x-bp-pubkey'] || !req.headers['x-bp-signature']) return send(401, { error: 'unsigned' });
            const p = new URL(req.url || '/', 'http://registrar').pathname;
            const body = text ? JSON.parse(text) : null;
            reg.calls.push({ method: req.method || '', path: p, body });
            if (p === '/api/registrar/status') return send(200, reg.status());
            if (p === '/api/registrar/claim') return send(200, reg.claim(body));
            if (p === '/api/registrar/offline') return send(200, reg.offline());
            send(404, { error: 'not found' });
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    process.env.REGISTRAR_URL = `http://127.0.0.1:${(server.address() as any).port}`;
    return server;
}

const live = (name: string, token: string) => ({ status: 'live', name, hostname: `${name}.beanpool.org`, mode: 'tunnel', tunnelToken: token });
const pa = () => (getNodeConfig() as any).publicAddress;
const tunnelLogs = () => (db.prepare(`SELECT level, message FROM system_logs WHERE message LIKE '%[Tunnel]%' ORDER BY id`).all() as { level: string; message: string }[]);
const UNAUTHORIZED = { level: 'error', connIndex: 0, error: 'Unauthorized: Tunnel not found', message: 'Register tunnel error from server side' };

async function main(): Promise<void> {
    refuseEdge();
    initStateEngine();
    const p2p = await startP2P(0, 0);
    const registrar = await startRegistrar();
    const envDir = path.join(DATA!, 'fake-env');
    fs.mkdirSync(envDir, { recursive: true });
    const marker = path.join(envDir, 'dockerenv');
    const socket = path.join(envDir, 'docker.sock');
    const fake: FakeTunnel = await useFakeCloudflared(path.join(DATA!, 'fake-cloudflared'), {
        pollStartingMs: 40, pollConnectedMs: 80, deadAfterMs: 400, healDebounceMs: 2_000,
        backoffBaseMs: 100, backoffMaxMs: 400, backoffResetMs: 60_000, killGraceMs: 3_000, collapseMs: 60_000,
        containerMarkers: [marker], dockerSocket: socket,
    });
    const fakes = () => fake.runs().filter((r) => alive(r.pid));
    /** Until exactly one fake runs, it is the connector's child, and it was started with `token` (it records itself as it starts). */
    const upOn = (token: string) => until(() => {
        const f = fakes();
        return f.length === 1 && f[0].env.TUNNEL_TOKEN === token && tunnelConnectorForTests().pid === f[0].pid;
    });
    const T1 = 'eyJhIjoiYWxwaGEtMSJ9.token-one-4f1c9a2e';
    let app: http.Server | null = null;

    try {
        await section('1, 8. at boot: no address, no child; a leftover token file is deleted and never run', async () => {
            const leftover = path.join(DATA!, 'tunnel-token');
            fs.writeFileSync(leftover, 'FLEET-TOKEN-deploy-sh-should-never-run');
            fs.writeFileSync(marker, '');
            fs.writeFileSync(socket, '');
            const st = await initTunnelConnector();
            assert(!fs.existsSync(leftover), 'data/tunnel-token is deleted at boot (main: the sidecar ran it)');
            assert(fake.runs().length === 0 && st.state === 'off', `no publicAddress → no child (${fake.runs().length} runs, ${st.state})`);
            assert(!fake.runs().some((r) => JSON.stringify(r).includes('FLEET-TOKEN')), 'the file\'s token was never run');
            assert(dockerSocketMounted(), 'inside a container with /var/run/docker.sock mounted, the server knows');
            const warned = db.prepare(`SELECT level FROM system_logs WHERE message LIKE '%still mounts Docker''s control socket%'`).all() as { level: string }[];
            assert(warned.length === 1 && warned[0].level === 'SECURITY', `and says so once at boot, as a security line (${JSON.stringify(warned)})`);
            fs.rmSync(socket);
            assert(!dockerSocketMounted(), 'no socket mounted → no warning');
            fs.rmSync(marker);
            fs.writeFileSync(socket, '');
            assert(!dockerSocketMounted(), 'a socket on a machine that is not a container (a developer\'s) → no warning');
            fs.rmSync(socket);
        });

        await section('9. the binary missing: state missing, one log line, no crash loop', async () => {
            setTunnelConnectorForTests({ command: path.join(DATA!, 'no-such-dir', 'cloudflared') });
            const st = await persistAddress(live('alpha', T1));
            assert(st.state === 'missing' && /not in this server's image/.test(st.reason || ''), `state missing (${st.state}: ${st.reason})`);
            await syncTunnel();
            await sleep(400);
            const lines = tunnelLogs().filter((l) => l.message.includes("not in this server's image"));
            assert(fake.runs().length === 0 && getTunnelStatus().state === 'missing', `nothing started, still missing after 400 ms (${fake.runs().length} runs)`);
            assert(lines.length === 1 && lines[0].level === 'ERROR', `one log line, not a loop (${lines.length})`);
            setTunnelConnectorForTests({ command: process.execPath });
        });

        await section('2. a live tunnel address → one child on that token, with nothing else of the server\'s', async () => {
            const st = await syncTunnel();
            const runs = await fake.waitForRuns(1);
            const r = runs.at(-1)!;
            assert(runs.length === 1 && st.state === 'starting', `one child, starting (${runs.length} runs, ${st.state})`);
            assert(r?.env.TUNNEL_TOKEN === T1, 'its TUNNEL_TOKEN is the saved token');
            // macOS adds __CF_USER_TEXT_ENCODING to every process it starts; it is not the server's.
            const keys = Object.keys(r.env).filter((k) => !(process.platform === 'darwin' && k === '__CF_USER_TEXT_ENCODING')).sort();
            assert(keys.join() === 'HOME,PATH,TUNNEL_TOKEN', `its environment is only the allowlist (${keys.join(', ')})`);
            const envText = JSON.stringify(r.env);
            assert(Object.entries(SENTINELS).every(([k, v]) => !(k in r.env) && !envText.includes(v)),
                'none of ADMIN_PASSWORD, CF_API_TOKEN, IMAGE_S3_*, the Pulse secrets reaches it');
            assert(!r.argv.join(' ').includes(T1), 'the token is not in its argv (ps and /proc show argv)');
            assert(r.argv[0] === 'tunnel' && r.argv.at(-1) === 'run' && r.argv.includes('--no-autoupdate'), `cloudflared tunnel … run, --no-autoupdate (${r.argv.join(' ')})`);
            assert(r.argv[r.argv.indexOf('--metrics') + 1] === `127.0.0.1:${fake.port}`, 'metrics on loopback only (never 0.0.0.0, which every stack on beanpool-shared reaches)');
            assert(r.argv[r.argv.indexOf('--loglevel') + 1] === 'info' && !r.argv.includes('debug'), 'log level info, never debug (debug logs request headers)');
            assert(tunnelConnectorForTests().runningToken === T1 && tunnelConnectorForTests().pid === r.pid, 'the connector runs that child');
        });

        await section('2. its log: warnings once, repeats counted, never debug, never the token', async () => {
            const before = tunnelLogs().length;
            fake.say({ level: 'info', message: 'Version 2026.9.3 (Checksum 0123abcd)' });
            fake.say({ level: 'debug', message: 'request headers: Cookie SECRET-HEADER-cookie-77' });
            for (let i = 0; i < 20; i++) fake.say({ level: 'error', error: 'dial tcp: lookup region1.v2.argotunnel.com: no such host', message: 'Failed to dial' });
            fake.say({ level: 'warn', message: `echoing ${T1} back` });
            await until(() => tunnelLogs().some((l) => l.message.includes('echoing')), 3_000);
            const rows = tunnelLogs().slice(before);
            assert(getTunnelStatus().version === '2026.9.3', `the version it printed is known (${getTunnelStatus().version})`);
            assert(rows.filter((l) => l.message.includes('no such host')).length === 1, `20 identical errors → one line (${rows.filter((l) => l.message.includes('no such host')).length})`);
            assert(!tunnelLogs().some((l) => l.message.includes('SECRET-HEADER')), 'a debug line is never forwarded');
            assert(!tunnelLogs().some((l) => l.message.includes(T1)) && rows.some((l) => l.message.includes('[tunnel token]')), 'the token is never logged');
            const st = getTunnelStatus();
            assert(st.state === 'retrying' && /no such host|echoing/.test(st.reason || ''), `not connected yet, and why (${st.state}: ${st.reason})`);
        });

        await section('10. a tunnel set before it moved inside the server moves to loopback once', async () => {
            reg.status = () => live('alpha', T1);
            reg.claim = (b) => ({ ...live(b.name, T1), changed: [] });
            assert(!pa().origin, 'the saved address records no origin (a tunnel from before)');
            const pid = tunnelConnectorForTests().pid;
            fake.ready(200, 4);
            assert(await until(() => getTunnelStatus().state === 'connected'), `/ready says connected → connected (${getTunnelStatus().state})`);
            assert(getTunnelStatus().connections === 4, `with its connections (${getTunnelStatus().connections})`);
            assert(await until(() => pa()?.origin === LOOPBACK_ORIGIN), `the origin is recorded as ${LOOPBACK_ORIGIN} (${pa()?.origin})`);
            const c = claims();
            assert(c.length === 1 && c[0].body.name === 'alpha' && c[0].body.mode === 'tunnel', `one claim of the saved name: a heal (${JSON.stringify(c.map((x) => x.body))})`);
            assert(c[0]?.body.origin === `http://127.0.0.1:${Number(process.env.PORT_HTTP ?? 8080)}`, `carrying this server's loopback as the origin (${c[0]?.body.origin})`);
            assert(!('contact' in (c[0]?.body ?? {})) && !('community_name' in (c[0]?.body ?? {})), 'and nothing else of the row\'s to change');
            assert(statuses().length >= 1, 'after asking the registrar the name is live and this key\'s');
            assert(tunnelConnectorForTests().pid === pid, 'the same token: the child is not restarted');

            const again = await restartTunnel();
            assert(again?.state === 'starting' && tunnelConnectorForTests().pid !== pid, 'Restart tunnel: a new child');
            assert(fake.exits().some((e) => e.pid === pid && e.signal === 'SIGTERM'), 'the old one got SIGTERM');
            await until(() => getTunnelStatus().state === 'connected');
            await sleep(400);
            assert(claims().length === 1, `connected again: no second claim (${claims().length})`);

            await resetTunnelConnectorForTests();
            await syncTunnel();
            await until(() => getTunnelStatus().state === 'connected');
            await sleep(400);
            assert(getTunnelStatus().state === 'connected' && claims().length === 1, `after the process restarts either: no second claim (${claims().length})`);
        });

        await section('3. the registrar has a new token → the agent\'s refresh restarts the child on it, no human', async () => {
            const T2 = 'eyJhIjoiYWxwaGEtMiJ9.token-two-88d0b1';
            const oldPid = tunnelConnectorForTests().pid!;
            const claimsBefore = claims().length;
            reg.status = () => live('alpha', T2);
            const t0 = Date.now();
            await reconcile();
            await until(() => fake.lastRun()?.env.TUNNEL_TOKEN === T2);
            assert(fake.exits().some((e) => e.pid === oldPid && e.signal === 'SIGTERM') && !alive(oldPid), 'the old child got SIGTERM and is gone');
            assert(fake.lastRun()?.env.TUNNEL_TOKEN === T2 && tunnelConnectorForTests().runningToken === T2, 'the new one runs the new token');
            assert(fakes().length === 1, `one child (${fakes().length})`);
            assert(Date.now() - t0 < 10_000, `within 10 s (${Date.now() - t0} ms)`);
            assert(claims().length === claimsBefore, 'the refresh claimed nothing (this server has no PUBLIC_ADDRESS_* set)');
            assert(pa()?.origin === LOOPBACK_ORIGIN, 'a status answer keeps the recorded origin');

            reg.status = () => ({ status: 'none' });
            const pid = tunnelConnectorForTests().pid;
            await reconcile();
            assert(claims().length === claimsBefore, `the registrar answers none: nothing is claimed (${claims().length - claimsBefore})`);
            assert(pa()?.name === 'alpha' && pa()?.tunnelToken === T2 && tunnelConnectorForTests().pid === pid, 'the address is kept and the tunnel keeps running');
        });

        await section('4. Unauthorized for longer than the threshold', async () => {
            const T3 = 'eyJhIjoiYWxwaGEtMyJ9.token-three-5e7c';
            const T4 = 'eyJhIjoiYWxwaGEtNCJ9.token-four-a93f';
            fake.ready(503);
            await until(() => getTunnelStatus().state !== 'connected');
            const spam = setInterval(() => fake.say(UNAUTHORIZED), 60);
            try {
                // a) the registrar has a new token for the name
                reg.status = () => live('alpha', T3);
                const c0 = claims().length;
                const s0 = statuses().length;
                assert(await until(() => /Unauthorized/.test(getTunnelStatus().reason || ''), 2_000),
                    `Settings sees why it isn't connected (${getTunnelStatus().state}: ${getTunnelStatus().reason})`);
                assert(statuses().length === s0, 'nothing is asked before the threshold (cloudflared\'s own retries get their 2 min)');
                assert(await until(() => tunnelConnectorForTests().runningToken === T3, 4_000), 'past it, the registrar\'s new token is run');
                assert(statuses().length > s0, 'having asked the registrar');
                assert(claims().length === c0, 'no claim for a new token');
                assert(await upOn(T3), `one child, on it (${fakes().map((f) => f.env.TUNNEL_TOKEN).join(', ')})`);

                // b) the same token: the tunnel is gone at Cloudflare though the name is live → one claim, then its token
                reg.claim = (b) => live(b.name, T4);
                assert(await until(() => claims().length === c0 + 1, 5_000), `after the debounce, one claim of the saved name (${claims().length - c0})`);
                const c = claims().at(-1)!;
                assert(c.body.name === 'alpha' && c.body.origin === LOOPBACK_ORIGIN, `the saved name, to this server's loopback (${JSON.stringify(c.body)})`);
                assert(await until(() => tunnelConnectorForTests().runningToken === T4), 'the claim\'s token is run');
                assert(pa()?.tunnelToken === T4 && pa()?.origin === LOOPBACK_ORIGIN, 'and saved');

                // c) still refused, inside the debounce window
                await sleep(1_200);
                assert(claims().length === c0 + 1, `more Unauthorized inside 30 min (the debounce) → no second claim (${claims().length - c0})`);
            } finally {
                clearInterval(spam);
            }
            // cloudflared's own line, as forwarded; a count line for its repeats comes when the window closes or it connects.
            const unauthorizedLines = tunnelLogs().filter((l) => l.message.includes('Register tunnel error from server side: Unauthorized') && !/failed \d+ times/.test(l.message));
            assert(unauthorizedLines.length === 1, `hundreds of Unauthorized lines → one in the log (${unauthorizedLines.length})`);
            reg.claim = (b) => live(b.name, T4);
            reg.status = () => live('alpha', T4);
            fake.ready(200);
            await until(() => getTunnelStatus().state === 'connected');
            const counted = tunnelLogs().filter((l) => /failed \d+ times since .*Unauthorized: Tunnel not found/.test(l.message));
            assert(counted.length === 1, `connected again: the repeats are one count line (${counted.map((l) => l.message).join(' | ')})`);
        });

        await section('5. a child that keeps crashing: growing, capped backoff; never two at once', async () => {
            const n0 = fake.runs().length;
            fake.crash(true);
            let most = 0;
            const sampler = setInterval(() => { most = Math.max(most, fakes().length); }, 10);
            await restartTunnel();
            await fake.waitForRuns(n0 + 6, 5_000);
            clearInterval(sampler);
            const starts = fake.runs().slice(n0).map((r) => r.at);
            const gaps = starts.slice(1).map((t, i) => t - starts[i]);
            assert(starts.length >= 6, `restarted after each crash (${starts.length} starts)`);
            assert(gaps[0] >= 80 && gaps[1] > gaps[0] && gaps[2] > gaps[1], `the wait grows (${gaps.join(', ')} ms)`);
            assert(gaps.every((g) => g < 400 + 600) && gaps[3] >= 350 && gaps[4] >= 350, `and is capped (${gaps.join(', ')} ms; cap 400)`);
            assert(most <= 1, `never two children at once (at most ${most})`);
            const st = getTunnelStatus();
            assert(st.state === 'retrying' && /exit code 1|has stopped \d+ times in a row/.test(st.reason || ''), `Settings says it keeps stopping (${st.reason})`);
            const fixedAt = Date.now();
            fake.crash(false);
            assert(await until(() => fake.runs().some((r) => r.at > fixedAt && alive(r.pid)), 3_000), 'fixed: it is started again after its wait');
            await sleep(300);
            const now = fakes();
            assert(now.length === 1 && now[0].at > fixedAt && tunnelConnectorForTests().pid === now[0].pid
                && tunnelConnectorForTests().runningToken === 'eyJhIjoiYWxwaGEtNCJ9.token-four-a93f', 'and stays up: one child, on the saved token');
        });

        await section('6. a standby runs no tunnel; a take-over starts it at its own step', async () => {
            const pid = tunnelConnectorForTests().pid!;
            setNodeRole('backup');
            const st = await syncTunnel();
            assert(st.state === 'off' && !alive(pid) && tunnelConnectorForTests().pid === null, `role backup with a publicAddress → no child (${st.state})`);
            const n = fake.runs().length;
            await sleep(300);
            assert(fake.runs().length === n, 'and none is started');

            setNodeRole('primary');
            const journal = path.join(DATA!, 'takeover-journal.json');
            fs.writeFileSync(journal, JSON.stringify({ v: 1, id: 'test-journal', state: 'restarting', steps: { restart: { at: new Date().toISOString() }, audit: { at: new Date().toISOString() } } }));
            const held = await syncTunnel();
            assert(held.state === 'off' && fake.runs().length === n, `a take-over that restarted this server and hasn't reached its tunnel step holds it (${held.state})`);
            const started = await startTunnelForTakeover();
            assert(started.state === 'starting' && (await fake.waitForRuns(n + 1)).length === n + 1, `the take-over's tunnel step starts it (${started.state})`);
            assert(fake.lastRun()?.env.TUNNEL_TOKEN === pa()?.tunnelToken, 'on the saved token');
            fs.rmSync(journal);
        });

        await section('11. two syncs in the same tick with different tokens → one child', async () => {
            const cur = pa();
            let most = 0;
            const sampler = setInterval(() => { most = Math.max(most, fakes().length); }, 5);
            updateNodeConfig({ publicAddress: { ...cur, tunnelToken: 'eyJ.token-five' } } as any);
            const a = syncTunnel();
            await new Promise((r) => setImmediate(r)); // the first is under way, on token five
            updateNodeConfig({ publicAddress: { ...cur, tunnelToken: 'eyJ.token-six' } } as any);
            const b = syncTunnel();
            const c = restartTunnel();
            await Promise.all([a, b, c]);
            await sleep(200);
            clearInterval(sampler);
            assert(most <= 1 && fakes().length === 1, `one child, never two (at most ${most}; now ${fakes().length})`);
            assert(tunnelConnectorForTests().runningToken === 'eyJ.token-six' && fakes()[0]?.env.TUNNEL_TOKEN === 'eyJ.token-six', 'on the last token');
            updateNodeConfig({ publicAddress: cur } as any);
            await syncTunnel();
            assert(await upOn(cur.tunnelToken), 'and back, still one');
        });

        await section('7. Settings: claim, status, Take offline, Restart tunnel', async () => {
            const deps = { checkAdminAuth: async () => true } as unknown as RouteDeps;
            const k = new Koa();
            k.use(async (ctx: any, next: any) => {
                if (ctx.method === 'POST') {
                    const text = await new Promise<string>((r) => { let d = ''; ctx.req.on('data', (x: any) => { d += x; }); ctx.req.on('end', () => r(d)); });
                    ctx.requestBody = text ? JSON.parse(text) : {};
                }
                await next();
            });
            const router = createPublicAddressRoutes(deps);
            k.use(router.routes());
            app = http.createServer(k.callback());
            await new Promise<void>((r) => app!.listen(0, '127.0.0.1', () => r()));
            const base = `http://127.0.0.1:${(app.address() as any).port}`;
            const post = async (p: string, body: unknown = {}) => {
                const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                return { status: res.status, body: await res.json().catch(() => null) as any };
            };

            reg.claim = (b) => live(b.name, 'eyJ.token-beta');
            const claimed = await post('/api/local/admin/public-address/claim', { name: 'beta', mode: 'tunnel' });
            const c = claims().at(-1)!;
            assert(claimed.status === 200 && c.body.name === 'beta' && c.body.origin === LOOPBACK_ORIGIN, `the claim carries this server's loopback as the origin (${c.body.origin})`);
            assert(pa()?.origin === LOOPBACK_ORIGIN && pa()?.tunnelToken === 'eyJ.token-beta', 'and records it, so the tunnel is never moved again');
            assert(tunnelConnectorForTests().runningToken === 'eyJ.token-beta' && await upOn('eyJ.token-beta'), 'the tunnel runs the claimed name\'s token, one child');
            assert(claimed.body?.tunnel?.state === 'starting' || claimed.body?.tunnel?.state === 'connected', `the answer says the tunnel is up (${claimed.body?.tunnel?.state})`);

            reg.status = () => live('beta', 'eyJ.token-beta');
            const res = await fetch(`${base}/api/local/admin/public-address/status`);
            const s: any = await res.json();
            assert(res.status === 200 && ['starting', 'connected'].includes(s.tunnel?.state) && s.dockerSocket === false,
                `Settings' status shows the tunnel's state and no socket warning (${JSON.stringify(s.tunnel)}, ${s.dockerSocket})`);

            const pid = tunnelConnectorForTests().pid!;
            reg.offline = () => ({ status: 'released', name: 'beta' });
            const off = await post('/api/local/admin/public-address/offline');
            assert(off.status === 200 && pa() === null, `Take offline clears the address (${off.status})`);
            assert(!alive(pid) && fake.exits().some((e) => e.pid === pid) && fakes().length === 0 && getTunnelStatus().state === 'off',
                `and stops the tunnel (${getTunnelStatus().state}, ${fakes().length} running)`);
            const logs = await (await fetch(`${base}/api/local/admin/public-address/logs`)).json() as any;
            assert(logs.logs.some((l: any) => l.message.includes('Tunnel stopped')) && !logs.logs.some((l: any) => /Sidecar/i.test(l.message)),
                'the progress log says what happened: the tunnel stopped (main: "Sidecar container force-restarted", which never happened)');

            const restart = await post('/api/local/admin/public-address/restart-tunnel');
            assert(restart.status === 409 && /no tunnel/i.test(restart.body?.error || ''), `Restart tunnel with no address says so (${restart.status})`);
            const old = await post('/api/local/admin/public-address/restart-sidecar');
            assert(old.status === 404 || old.status === 405, `the sidecar route is gone (${old.status})`);
        });
    } catch (e: any) {
        assert(false, `the suite ran to the end (${e?.stack || e})`);
    } finally {
        await resetTunnelConnectorForTests().catch(() => {});
        setTunnelConnectorForTests(undefined);
        app?.close();
        registrar.close();
        await p2p.stop().catch(() => {});
    }
    assert(fakes().length === 0, 'no fake cloudflared is left running');
    console.log(`\n${passed}/${run} checks passed.`);
    process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

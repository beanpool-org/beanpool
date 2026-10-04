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
 * 12. The registrar paused the name (its sweep: another key, or no BeanPool node, answered there) → the agent's tick asks
 *     for it back with a heal of the saved name (never a claim) and runs the fresh tunnel's token; so does the dead-tunnel
 *     path. The admin's pause, a block, a release, or a pause of a name this server doesn't use: nothing is asked.
 *  7. Settings: the claim sends the loopback origin; status shows the tunnel; New tunnel key (rotate) restarts the tunnel
 *     on the new token, and a refusal or a standby changes nothing; Take offline stops the child and clears the address;
 *     Restart tunnel with no address says so.
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
import { reconcile, checkAddressRequest } from './services/public-address-agent.js';
import { getLocalConfig, updateLocalConfig } from './config/local-config.js';
import { noteTurnedAway } from './config/turned-away-names.js';
import { writeAddressRequestFile } from './address-request.js';
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

interface Call { method: string; path: string; body: any; name?: string | null }
const reg = {
    calls: [] as Call[],
    /** `name`: the name the node asked about (/status?name=); an older registrar never reads it. */
    status: (_name?: string | null): any => ({ status: 'none' }),
    claim: (b: any): any => ({ status: 'live', name: b.name, hostname: `${b.name}.beanpool.org`, mode: 'tunnel', tunnelToken: `T-claim-${b.name}` }),
    offline: (): any => ({ status: 'released' }),
    holder: (b: any): any => ({ name: b?.name, held: 'free' }),
    heal: (b: any): any => ({ status: 'live', name: b.name, hostname: `${b.name}.beanpool.org`, mode: 'tunnel', changed: [] }),
    /** [HTTP status, body]: the registrar refuses a rotate with a 403, 404 or 409. */
    rotate: (b: any): [number, any] | Promise<[number, any]> => [200, { status: 'live', name: b.name, hostname: `${b.name}.beanpool.org`, mode: 'tunnel', tunnelToken: `T-rotate-${b.name}`, rotated: true }],
};
const claims = () => reg.calls.filter((c) => c.path === '/api/registrar/claim');
const statuses = () => reg.calls.filter((c) => c.path === '/api/registrar/status');
const heals = () => reg.calls.filter((c) => c.path === '/api/registrar/heal');
const rotates = () => reg.calls.filter((c) => c.path === '/api/registrar/rotate');

async function startRegistrar(): Promise<http.Server> {
    const server = http.createServer((req, res) => {
        let text = '';
        req.on('data', (c) => { text += c; });
        req.on('end', () => {
            const send = (code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
            if (!req.headers['x-bp-pubkey'] || !req.headers['x-bp-signature']) return send(401, { error: 'unsigned' });
            const u = new URL(req.url || '/', 'http://registrar');
            const p = u.pathname;
            const body = text ? JSON.parse(text) : null;
            reg.calls.push({ method: req.method || '', path: p, body, name: u.searchParams.get('name') });
            // An answer, [HTTP status, body] for one that refuses, { html: [status, page] } for a page from something in front
            // of the registrar, or a promise of one (an answer held back).
            const answer = (out: any): void => void Promise.resolve(out).then((o) => {
                if (o?.html) { res.writeHead(o.html[0], { 'Content-Type': 'text/html' }); return void res.end(o.html[1]); }
                if (Array.isArray(o)) send(o[0], o[1]);
                else send(200, o);
            });
            if (p === '/api/registrar/status') return answer(reg.status(u.searchParams.get('name')));
            if (p === '/api/registrar/claim') return answer(reg.claim(body));
            if (p === '/api/registrar/offline') return send(200, reg.offline());
            if (p === '/api/registrar/heal') return send(200, reg.heal(body));
            if (p === '/api/registrar/holder') return answer(reg.holder(body));
            if (p === '/api/registrar/rotate') return answer(reg.rotate(body));
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
    const servers: { app: http.Server | null } = { app: null };
    let settingsPost: ((p: string, body?: unknown) => Promise<{ status: number; body: any }>) | null = null;
    let settingsGet: ((p: string) => Promise<{ status: number; body: any }>) | null = null;

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
            // As the real one ends a start-up failure: the error in plain text, then a pointer to its help.
            fake.say('Provided Tunnel token is not valid.', "See 'cloudflared tunnel run --help'.");
            await until(() => tunnelLogs().some((l) => l.message.includes('not valid')), 3_000);
            const rows = tunnelLogs().slice(before);
            assert(getTunnelStatus().version === '2026.9.3', `the version it printed is known (${getTunnelStatus().version})`);
            assert(rows.filter((l) => l.message.includes('no such host')).length === 1, `20 identical errors → one line (${rows.filter((l) => l.message.includes('no such host')).length})`);
            assert(!tunnelLogs().some((l) => l.message.includes('SECRET-HEADER')), 'a debug line is never forwarded');
            assert(!tunnelLogs().some((l) => l.message.includes(T1)) && rows.some((l) => l.message.includes('[tunnel token]')), 'the token is never logged');
            await sleep(150);
            const st = getTunnelStatus();
            assert(st.state === 'retrying' && st.reason === 'Provided Tunnel token is not valid.', `not connected yet, and why: the error, not the pointer to help after it (${st.state}: ${st.reason})`);
            assert(tunnelLogs().some((l) => l.level === 'ERROR' && l.message === '[Tunnel] Provided Tunnel token is not valid.')
                && !tunnelLogs().some((l) => l.message.includes('--help')), 'a plain-text start-up failure is logged as an error; the help pointer is not');
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
            // waitForRuns resolves the moment the 6th child has STARTED; its exit (and so the retrying reason) lands slightly after.
            await until(() => getTunnelStatus().state === 'retrying', 3_000);
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

        await section('12. the registrar paused the name → this server asks for it back with a heal, never a claim', async () => {
            const T5 = 'eyJhIjoiYWxwaGEtNSJ9.token-five-healed';
            const T6 = 'eyJhIjoiYWxwaGEtNiJ9.token-six-healed';
            const before = pa();
            assert(before?.name === 'alpha' && before?.status === 'live', `the saved address is alpha, live (${before?.name}, ${before?.status})`);
            const paused = (reason: string, name = 'alpha') => ({ status: 'paused', name, hostname: `${name}.beanpool.org`, mode: 'tunnel', reason, since: 1 });
            const c0 = claims().length;
            const h0 = heals().length;
            const pid = tunnelConnectorForTests().pid;

            // Nothing this server's heal may lift: nothing asked.
            for (const st of [paused('admin'), { status: 'blocked', name: 'alpha', hostname: 'alpha.beanpool.org' },
                { status: 'released', name: 'alpha', hostname: 'alpha.beanpool.org', held_until: 9e9 }, paused('content-swap', 'elsewhere')]) {
                reg.status = () => st;
                await reconcile();
                assert(heals().length === h0 && claims().length === c0, `${st.status}${(st as any).reason ? `/${(st as any).reason}` : ''} of ${st.name}: no heal, no claim`);
            }
            assert(tunnelConnectorForTests().pid === pid && pa()?.tunnelToken === before.tunnelToken, 'and the tunnel and the saved address are as they were');

            // The sweep's pause (a content swap): one heal of the saved name, to this server's loopback; the fresh tunnel's token runs.
            reg.status = () => paused('content-swap');
            reg.heal = (b) => ({ status: 'live', name: b.name, hostname: `${b.name}.beanpool.org`, mode: 'tunnel', tunnelToken: T5, changed: ['tunnel', 'dns'] });
            await reconcile();
            const h = heals().at(-1);
            assert(heals().length === h0 + 1 && h?.body?.name === 'alpha' && h?.body?.origin === LOOPBACK_ORIGIN,
                `one heal of the saved name, to this server's loopback (${JSON.stringify(heals().slice(h0).map((x) => x.body))})`);
            assert(!('contact' in (h?.body ?? {})) && !('community_name' in (h?.body ?? {})) && !('mode' in (h?.body ?? {})), 'and nothing else of the row\'s to change');
            assert(claims().length === c0, 'never a claim (a claim of a released name would take it back)');
            assert(await upOn(T5), 'the fresh tunnel\'s token runs, one child');
            assert(pa()?.tunnelToken === T5 && pa()?.status === 'live' && pa()?.origin === LOOPBACK_ORIGIN, 'and is saved');

            // The heal can't prove the key yet (another key still answers there): nothing changes, and the next tick asks again.
            reg.status = () => paused('impostor');
            reg.heal = () => ({ status: 'paused', name: 'alpha', reason: 'impostor', attest: 'impostor', why: 'valid signature by 0123456789abcdef…', changed: ['dns'] });
            const pid5 = tunnelConnectorForTests().pid;
            await reconcile();
            assert(heals().length === h0 + 2 && claims().length === c0, `asked again: a heal, no claim (${heals().length - h0})`);
            assert(tunnelConnectorForTests().pid === pid5 && pa()?.tunnelToken === T5 && pa()?.status === 'live', 'refused: the saved address and the tunnel are as they were');
            assert(tunnelLogs().some((l) => /stays paused/.test(l.message)), 'the log says it stays paused');

            // The dead-tunnel path: Cloudflare refuses the tunnel (the pause deleted it), the registrar says paused → a heal.
            reg.heal = (b) => ({ status: 'live', name: b.name, hostname: `${b.name}.beanpool.org`, mode: 'tunnel', tunnelToken: T6, changed: ['tunnel', 'dns'] });
            reg.status = () => paused('impostor');
            fake.ready(503);
            await until(() => getTunnelStatus().state !== 'connected');
            const spam = setInterval(() => fake.say(UNAUTHORIZED), 60);
            try {
                assert(await until(() => heals().length === h0 + 3, 6_000), `Unauthorized past the threshold, status paused → one heal (${heals().length - h0})`);
                assert(await until(() => tunnelConnectorForTests().runningToken === T6, 4_000), 'its fresh token is run');
                assert(claims().length === c0, 'still never a claim');
            } finally {
                clearInterval(spam);
            }
            reg.status = () => live('alpha', T6);
            fake.ready(200);
            await until(() => getTunnelStatus().state === 'connected');
            assert(await upOn(T6), 'one child, on it');
        });

        await section('7. Settings: claim, status, Take offline, Restart tunnel', async () => {
            // Owner level, as the real checkAdminAuth gives the admin password (an admin is test-tunnel-token-owner-only's).
            const deps = { checkAdminAuth: async (ctx: any) => { ctx.state.adminRole = 'owner'; return true; } } as unknown as RouteDeps;
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
            const app = servers.app = http.createServer(k.callback());
            await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
            const base = `http://127.0.0.1:${(app.address() as any).port}`;
            const post = async (p: string, body: unknown = {}) => {
                const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                return { status: res.status, body: await res.json().catch(() => null) as any };
            };
            settingsPost = post;
            settingsGet = async (p: string) => {
                const res = await fetch(base + p);
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

            // New tunnel key: the registrar's rotate, of the saved name to this server's loopback; the child restarts on it.
            const T_ROT = 'eyJ.token-beta-rotated';
            reg.rotate = (b) => [200, { status: 'live', name: b.name, hostname: `${b.name}.beanpool.org`, mode: 'tunnel', tunnelToken: T_ROT, rotated: true, changed: ['tunnel', 'dns'] }];
            const r0 = rotates().length;
            const oldPid = tunnelConnectorForTests().pid!;
            const rot = await post('/api/local/admin/public-address/rotate');
            const rq = rotates().at(-1);
            assert(rot.status === 200 && rotates().length === r0 + 1 && rq?.body?.name === 'beta' && rq?.body?.origin === LOOPBACK_ORIGIN,
                `New tunnel key asks the registrar to rotate the saved name, to this server's loopback (${rot.status}, ${JSON.stringify(rq?.body)})`);
            assert(await upOn(T_ROT) && !alive(oldPid), 'the tunnel restarts on the new key; the old child is gone');
            assert(pa()?.tunnelToken === T_ROT && pa()?.name === 'beta' && pa()?.status === 'live', 'and the new key is saved');
            assert(!JSON.stringify(rot.body).includes(T_ROT), 'the answer to the browser does not carry the token');
            // Refused by the registrar (paused by the admin): nothing changes here.
            reg.rotate = () => [403, { error: 'paused by the admin' }];
            const rotPid = tunnelConnectorForTests().pid;
            const refused = await post('/api/local/admin/public-address/rotate');
            assert(refused.status === 502 && /paused by the admin/.test(refused.body?.error || ''), `a refusal says why (${refused.status}: ${refused.body?.error})`);
            assert(pa()?.tunnelToken === T_ROT && tunnelConnectorForTests().pid === rotPid, 'and changes nothing: same key, same child');
            // An address service from before rotate existed (404): said plainly.
            reg.rotate = () => [404, { error: 'not found' }];
            const older = await post('/api/local/admin/public-address/rotate');
            assert(older.status === 502 && /doesn't offer new tunnel keys yet/.test(older.body?.error || '') && pa()?.tunnelToken === T_ROT,
                `an older address service: said plainly, nothing changed (${older.body?.error})`);
            // A standby runs no tunnel, so it never rotates the name's.
            setNodeRole('backup');
            const r1 = rotates().length;
            const standby = await post('/api/local/admin/public-address/rotate');
            setNodeRole('primary');
            assert(standby.status === 409 && rotates().length === r1, `a standby: 409, the registrar is not asked (${standby.status})`);

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
            const noKey = await post('/api/local/admin/public-address/rotate');
            assert(noKey.status === 409 && /no live tunnel address/i.test(noKey.body?.error || ''), `New tunnel key with no address says so (${noKey.status})`);
            const old = await post('/api/local/admin/public-address/restart-sidecar');
            assert(old.status === 404 || old.status === 405, `the sidecar route is gone (${old.status})`);
        });

        await section('13. a request from beanpool claim ends once this server holds any address, however it got it', async () => {
            const post = settingsPost!;
            const request = (name: string) => updateLocalConfig({ addressRequest: { name, mode: 'tunnel', contact: null, requestedAt: Date.now(), refused: null } });
            // The log line says what ended the request.
            const said: string[] = [];
            const log = console.log;
            console.log = (...a: unknown[]) => { said.push(a.map(String).join(' ')); log(...a); };
            const ended = () => said.filter((l) => l.includes("beanpool claim's request for \"install-name\" ends")).at(-1) || '';
            reg.status = () => ({ status: 'none' });
            reg.claim = (b) => live(b.name, `eyJ.token-${b.name}`);
            // The registrar did not answer during the install, so the request stood; the owner then set a name in Settings.
            request('install-name');
            const set = await post('/api/local/admin/public-address/claim', { name: 'gamma', mode: 'tunnel' });
            assert(set.status === 200 && pa()?.name === 'gamma', `Settings claimed gamma (${set.status})`);
            assert(getLocalConfig().addressRequest == null, `the Settings claim ends the request (${JSON.stringify(getLocalConfig().addressRequest)})`);
            assert(/the owner claimed "gamma" in Settings/.test(ended()), `and says so (${ended()})`);
            // An address saved any other way (this agent, a take-over): the 2 s tick ends it.
            request('install-name');
            await checkAddressRequest(Date.now());
            assert(getLocalConfig().addressRequest == null, 'the 2 s tick ends a request while any address is held');
            assert(/this server holds "gamma" now/.test(ended()) && !/Settings/.test(ended()), `and says what is held, not "Settings" (${ended()})`);
            request('install-name');
            const off = await post('/api/local/admin/public-address/offline');
            assert(off.status === 200 && pa() === null, `Take offline released gamma (${off.status})`);
            assert(getLocalConfig().addressRequest == null, 'Take offline ends a standing request too');
            assert(/the owner took the address offline in Settings/.test(ended()), `and says so (${ended()})`);
            console.log = log;
            const before = claims().length;
            await checkAddressRequest(Date.now() + 60_000);
            await reconcile();
            assert(!claims().slice(before).some((c) => c.body?.name === 'install-name') && pa() === null, 'after the release, the install name is never claimed');
        });

        await section('14. a standing request backs off while the registrar does not answer; only its word that the name can\'t be had ends it', async () => {
            let down = true;
            reg.status = () => down ? [503, { error: 'down' }] : { status: 'none' };
            const before = statuses().length;
            const asks = () => statuses().length - before;
            const t0 = Date.now() + 10 * 60_000;
            writeAddressRequestFile(DATA!, { name: 'outage-name', contact: null, at: t0 });
            await checkAddressRequest(t0);
            assert(asks() === 1, `a fresh request is asked for at once (${asks()})`);
            const seen: string[] = [];
            for (const s of [5, 11, 25, 41, 100, 162, 400, 1000, 3000]) { await checkAddressRequest(t0 + s * 1000); seen.push(`${s}s:${asks()}`); }
            assert(seen.join(' ') === '5s:1 11s:2 25s:2 41s:3 100s:3 162s:4 400s:4 1000s:4 3000s:4',
                `during the outage: 10 s, 30 s, 2 min, then only the 5-min tick (${seen.join(' ')})`);
            assert(getLocalConfig().addressRequest?.name === 'outage-name' && !getLocalConfig().addressRequest?.refused, 'the request still stands');

            down = false;
            const t1 = t0 + 10_000_000;
            const refused = () => getLocalConfig().addressRequest?.refused;
            reg.claim = () => [429, { error: 'slow down' }];
            writeAddressRequestFile(DATA!, { name: 'busy-name', contact: null, at: t1 });
            await checkAddressRequest(t1);
            assert(getLocalConfig().addressRequest?.name === 'busy-name' && !refused(), `a 429 is no refusal: the request stands (${refused()})`);
            reg.claim = () => [401, { error: 'bad signature' }];
            await checkAddressRequest(t1 + 11_000);
            assert(!refused(), `nor a 401 (a clock out of step) (${refused()})`);
            reg.claim = () => [408, { error: 'timeout' }];
            await checkAddressRequest(t1 + 42_000);
            assert(!refused(), `nor a 408 (${refused()})`);
            reg.claim = () => [409, { error: 'name taken', owner: 'other' }];
            const n = claims().length;
            await checkAddressRequest(t1 + 163_000);
            assert(claims().length === n + 1 && /name taken/.test(refused() || ''), `the registrar's 409 is its word: refused, with its reason (${refused()})`);
            await checkAddressRequest(t1 + 1_000_000);
            await reconcile();
            assert(claims().length === n + 1, 'and never asked for again');
            updateLocalConfig({ addressRequest: null });
            reg.claim = (b) => live(b.name, `eyJ.token-${b.name}`);
        });

        await section('15. the agent\'s claim answered after the owner set a name in Settings: the owner\'s name stays', async () => {
            const post = settingsPost!;
            reg.status = () => ({ status: 'none' });
            const offlines = () => reg.calls.filter((c) => c.path === '/api/registrar/offline').length;
            // The registrar holds back its answer to the install's name until the owner has claimed theirs.
            let answerAgent: () => void = () => {};
            reg.claim = (b) => b.name !== 'install-race' ? live(b.name, `eyJ.token-${b.name}`)
                : new Promise((r) => { answerAgent = () => r(live(b.name, 'eyJ.token-install-race')); });
            const t2 = Date.now() + 20_000_000;
            const off0 = offlines();
            writeAddressRequestFile(DATA!, { name: 'install-race', contact: null, at: t2 });
            const agent = checkAddressRequest(t2);
            assert(await until(() => claims().some((c) => c.body?.name === 'install-race')), 'the agent asked for the install\'s name');
            const set = await post('/api/local/admin/public-address/claim', { name: 'owner-pick', mode: 'tunnel' });
            assert(set.status === 200 && pa()?.name === 'owner-pick', `Settings claimed owner-pick while the agent waited (${set.status})`);
            answerAgent();
            await agent;
            assert(pa()?.name === 'owner-pick' && pa()?.tunnelToken === 'eyJ.token-owner-pick',
                `the agent's late answer does not move the community off the owner's name (${pa()?.name})`);
            assert(tunnelConnectorForTests().runningToken === 'eyJ.token-owner-pick', 'the tunnel still runs the owner\'s name');
            assert(getLocalConfig().addressRequest == null, 'the request stays ended');
            assert(offlines() === off0, 'nothing is released: the owner\'s name is never touched');
            // The 5-min tick's own claim (not under the 2 s check) is held to the same rule.
            updateNodeConfig({ publicAddress: null } as any);
            await syncTunnel();
            updateLocalConfig({ addressRequest: { name: 'install-race', mode: 'tunnel', contact: null, requestedAt: t2, refused: null } });
            const n = claims().length;
            const tick = reconcile();
            assert(await until(() => claims().length > n), 'the tick asked for the install\'s name');
            const set2 = await post('/api/local/admin/public-address/claim', { name: 'owner-two', mode: 'tunnel' });
            assert(set2.status === 200 && pa()?.name === 'owner-two', `Settings claimed owner-two while the tick waited (${set2.status})`);
            answerAgent();
            await tick;
            assert(pa()?.name === 'owner-two', `nor does the tick's late answer (${pa()?.name})`);
            reg.claim = (b) => live(b.name, `eyJ.token-${b.name}`);
            const off = await post('/api/local/admin/public-address/offline');
            assert(off.status === 200 && pa() === null, `and Take offline clears it for the next section (${off.status})`);
        });

        await section('16. a 400 or 403 page from something in front of the registrar is no refusal: the request stands', async () => {
            reg.status = () => ({ status: 'none' });
            const refused = () => getLocalConfig().addressRequest?.refused;
            const t3 = Date.now() + 30_000_000;
            const page = (code: number, title: string) => ({ html: [code, `<!DOCTYPE html><html><head><title>${title}</title></head><body>no</body></html>`] });
            reg.claim = () => page(403, 'Attention Required! | Cloudflare');
            writeAddressRequestFile(DATA!, { name: 'behind-proxy', contact: null, at: t3 });
            await checkAddressRequest(t3);
            assert(getLocalConfig().addressRequest?.name === 'behind-proxy' && !refused(), `a firewall's 403 page: the request stands (${refused()})`);
            reg.claim = () => page(400, '400 Bad Request');
            await checkAddressRequest(t3 + 11_000);
            assert(!refused(), `nor a proxy's 400 page (${refused()})`);
            const n = claims().length;
            reg.claim = (b) => live(b.name, `eyJ.token-${b.name}`);
            await checkAddressRequest(t3 + 42_000);
            assert(claims().length === n + 1 && pa()?.name === 'behind-proxy' && getLocalConfig().addressRequest == null,
                `asked again on the back-off, and claimed once the registrar answers (${pa()?.name})`);
            const off = await settingsPost!('/api/local/admin/public-address/offline');
            assert(off.status === 200 && pa() === null, `and Take offline clears it (${off.status})`);
            // The registrar's own JSON 403 (a reserved name) still ends a request.
            reg.claim = () => [403, { error: 'name reserved' }];
            writeAddressRequestFile(DATA!, { name: 'reserved-one', contact: null, at: t3 + 1_000_000 });
            await checkAddressRequest(t3 + 1_000_000);
            assert(/name reserved/.test(refused() || ''), `the registrar's own JSON 403 is its word: refused (${refused()})`);
            updateLocalConfig({ addressRequest: null });
            reg.claim = (b) => live(b.name, `eyJ.token-${b.name}`);
        });

        await section('17. the key holds a second name (the install\'s, claimed late): no answer moves the community onto it', async () => {
            const post = settingsPost!;
            // The owner's pick waits for approval; the install's late claim is live for the same key. An older registrar
            // answers /status about the key's first name (live outranks pending) whatever was asked.
            reg.claim = (b) => b.name === 'owner-pick' ? { status: 'pending', name: b.name, hostname: `${b.name}.beanpool.org`, mode: 'tunnel' } : live(b.name, `eyJ.token-${b.name}`);
            const set = await post('/api/local/admin/public-address/claim', { name: 'owner-pick', mode: 'tunnel' });
            assert(set.status === 200 && pa()?.name === 'owner-pick' && pa()?.status === 'pending', `the owner's pick is stored, pending (${set.status} ${pa()?.status})`);
            reg.status = () => live('install-race', 'eyJ.token-install-race');
            const n = statuses().length;
            await reconcile();
            assert(statuses().length === n + 1 && statuses()[n].name === 'owner-pick', `the tick asks about the stored name (${statuses()[n]?.name})`);
            assert(pa()?.name === 'owner-pick' && pa()?.status === 'pending', `an answer about the other name is not stored by the tick (${pa()?.name})`);
            assert(tunnelConnectorForTests().runningToken !== 'eyJ.token-install-race', 'the tunnel never runs the other name\'s token');
            const shown = await settingsGet!('/api/local/admin/public-address/status');
            assert(shown.status === 200 && pa()?.name === 'owner-pick', `nor by Settings' status read (${pa()?.name})`);
            assert(tunnelLogs().filter((l) => /answered about "install-race" when asked about "owner-pick"/.test(l.message)).length === 1, 'said once');
            // The owner's pick is approved: a registrar that reads the name answers about it, and that is stored.
            reg.status = (name) => name === 'owner-pick' ? live('owner-pick', 'eyJ.token-owner-pick') : live('install-race', 'eyJ.token-install-race');
            await reconcile();
            assert(pa()?.name === 'owner-pick' && pa()?.status === 'live' && pa()?.tunnelToken === 'eyJ.token-owner-pick', `the same name's state is stored (${pa()?.status})`);
            // Paused by the sweep: the older registrar names the live install name, never the owner's paused one.
            reg.status = () => live('install-race', 'eyJ.token-install-race');
            await reconcile();
            assert(pa()?.name === 'owner-pick' && pa()?.tunnelToken === 'eyJ.token-owner-pick', `still the owner's name (${pa()?.name})`);
            // New tunnel key answered after the owner claimed another name in another tab: that claim stands.
            let answerRotate: () => void = () => {};
            reg.rotate = (b) => new Promise((r) => { answerRotate = () => r([200, { ...live(b.name, 'eyJ.token-rotated-late'), rotated: true }]); });
            const r0 = rotates().length;
            const rotating = post('/api/local/admin/public-address/rotate');
            assert(await until(() => rotates().length > r0), 'the rotate was asked');
            const next = await post('/api/local/admin/public-address/claim', { name: 'owner-next', mode: 'tunnel' });
            assert(next.status === 200 && pa()?.name === 'owner-next', `the owner claimed owner-next meanwhile (${next.status})`);
            answerRotate();
            const rot = await rotating;
            assert(rot.status === 409 && pa()?.name === 'owner-next' && pa()?.tunnelToken === 'eyJ.token-owner-next',
                `the rotate's late answer is not stored over it (${rot.status} ${pa()?.name} ${pa()?.tunnelToken})`);
            assert(tunnelConnectorForTests().runningToken === 'eyJ.token-owner-next', 'the tunnel runs the newer claim\'s token');
            // Any write meanwhile answers so, the agent's own re-store of the same name too: never "a claim elsewhere".
            assert(/the address was written meanwhile/.test(rot.body?.error || '') && /open Settings again/.test(rot.body?.error || '') && !/elsewhere/.test(rot.body?.error || ''),
                `and says the address was written meanwhile (${rot.body?.error})`);
            reg.rotate = (b) => [200, { ...live(b.name, `T-rotate-${b.name}`), rotated: true }];
            // Take offline names the name it releases.
            const offs = reg.calls.filter((c) => c.path === '/api/registrar/offline').length;
            const off = await post('/api/local/admin/public-address/offline');
            const sent = reg.calls.filter((c) => c.path === '/api/registrar/offline')[offs];
            assert(off.status === 200 && sent?.body?.name === 'owner-next', `Take offline releases the stored name by name (${JSON.stringify(sent?.body)})`);
            // A claim that gets no answer here in time but completes at the registrar: said, so the owner sees the key holds it.
            let finish: () => void = () => {};
            reg.claim = (b) => new Promise((r) => { finish = () => r(live(b.name, 'eyJ.token-slow')); });
            reg.holder = (b) => ({ name: b?.name, held: 'you', state: 'live' });
            const slow = await post('/api/local/admin/public-address/claim', { name: 'slow-one', mode: 'tunnel' });
            assert(slow.status === 400 && /timed out/.test(slow.body?.error || '') && pa() === null, `the claim timed out here (${slow.status} ${slow.body?.error})`);
            assert(await until(() => tunnelLogs().some((l) => /claim of "slow-one" got no answer in time, but the address service gives it to this server's key/.test(l.message))),
                'the log says the key holds the name the timed-out claim asked for');
            finish();
            reg.holder = (b) => ({ name: b?.name, held: 'free' });
            reg.status = () => ({ status: 'none' });
            reg.claim = (b) => live(b.name, `eyJ.token-${b.name}`);
        });

        await section('18. after Take offline, no status answer brings the community back on a name nobody chose', async () => {
            const post = settingsPost!;
            updateNodeConfig({ publicAddress: null } as any);
            await syncTunnel();
            // beanpool claim asked for install-race; the owner picked owner-pick3 in Settings before the registrar answered
            // the install's claim, which then completed: both are live for the same key.
            updateLocalConfig({ addressRequest: { name: 'install-race', mode: 'tunnel', contact: null, requestedAt: Date.now(), refused: null } });
            const set = await post('/api/local/admin/public-address/claim', { name: 'owner-pick3', mode: 'tunnel' });
            assert(set.status === 200 && pa()?.name === 'owner-pick3' && getLocalConfig().addressRequest == null, `the owner's pick is stored, the request ends (${set.status})`);
            reg.status = (name) => name === 'owner-pick3' ? live('owner-pick3', 'eyJ.token-owner-pick3') : live('install-race', 'eyJ.token-install-race');
            const off = await post('/api/local/admin/public-address/offline');
            assert(off.status === 200 && pa() == null, `Take offline: nothing stored (${off.status})`);
            await reconcile();
            assert(pa() == null, `the tick stores nothing (${pa()?.name})`);
            // Settings opens: its status read asks with no name, and every registrar answers the key's live late name.
            const shown = await settingsGet!('/api/local/admin/public-address/status');
            assert(shown.status === 200 && pa() == null, `Settings' status read stores nothing (${shown.status} ${pa()?.name}/${pa()?.status})`);
            assert(shown.body?.name !== 'install-race' && shown.body?.status !== 'live', `and shows no live address (${shown.body?.name}/${shown.body?.status})`);
            assert(!tunnelConnectorForTests().runningToken, `no tunnel runs (${tunnelConnectorForTests().runningToken})`);
            // An older registrar that kept the released name live (it ignored the release's name): not brought back either.
            reg.status = () => live('owner-pick3', 'eyJ.token-owner-pick3');
            await settingsGet!('/api/local/admin/public-address/status');
            assert(pa() == null && !tunnelConnectorForTests().runningToken, `nor on the name the owner took offline (${pa()?.name})`);
            // A request from beanpool claim that still stands: another name's live answer is not stored, the requested name
            // is claimed; and the requested name's own live answer (its claim completed unanswered) is stored, as before.
            updateLocalConfig({ addressRequest: { name: 'asked-name', mode: 'tunnel', contact: null, requestedAt: Date.now(), refused: null } });
            reg.status = () => live('install-race', 'eyJ.token-install-race');
            const n = claims().length;
            await reconcile();
            assert(pa()?.name === 'asked-name' && claims().length === n + 1 && claims()[n].body?.name === 'asked-name',
                `while it stands, another name's answer is not stored: the requested name is claimed (${pa()?.name})`);
            assert(tunnelConnectorForTests().runningToken === 'eyJ.token-asked-name', `and its tunnel runs (${tunnelConnectorForTests().runningToken})`);
            await post('/api/local/admin/public-address/offline');
            updateLocalConfig({ addressRequest: { name: 'asked-name', mode: 'tunnel', contact: null, requestedAt: Date.now(), refused: null } });
            reg.status = () => live('asked-name', 'eyJ.token-asked-name-2');
            const m = claims().length;
            await reconcile();
            assert(pa()?.name === 'asked-name' && pa()?.tunnelToken === 'eyJ.token-asked-name-2' && claims().length === m,
                `the requested name's own live answer is stored, with no claim (${pa()?.name} ${claims().length - m})`);
            await post('/api/local/admin/public-address/offline');
            updateLocalConfig({ addressRequest: null });
            // A fresh server learns a name made for its key elsewhere (a name it never left): stored, as before.
            reg.status = () => live('made-elsewhere', 'eyJ.token-made-elsewhere');
            await settingsGet!('/api/local/admin/public-address/status');
            assert(pa()?.name === 'made-elsewhere', `a name this server never left is stored (${pa()?.name})`);
            await post('/api/local/admin/public-address/offline');
            reg.status = () => ({ status: 'none' });
        });

        await section('19. a Settings claim that timed out, then another pick and Take offline: never revived', async () => {
            const post = settingsPost!;
            updateNodeConfig({ publicAddress: null } as any);
            await syncTunnel();
            // The registrar completes the claim after the node gave up (5 s): the key holds slow-pick live, nothing records it.
            let finish: () => void = () => {};
            reg.claim = (b) => b.name === 'slow-pick' ? new Promise((r) => { finish = () => r(live(b.name, 'eyJ.token-slow-pick')); }) : live(b.name, `eyJ.token-${b.name}`);
            reg.holder = (b) => ({ name: b?.name, held: 'you', state: 'live' });
            const slow = await post('/api/local/admin/public-address/claim', { name: 'slow-pick', mode: 'tunnel' });
            assert(slow.status === 400 && /timed out/.test(slow.body?.error || '') && pa() == null, `the claim timed out here (${slow.status})`);
            finish();
            // Nothing else chosen yet: the timed-out claim is the owner's latest choice, and its live answer is stored.
            reg.status = () => live('slow-pick', 'eyJ.token-slow-pick');
            const first = await settingsGet!('/api/local/admin/public-address/status');
            assert(first.status === 200 && pa()?.name === 'slow-pick', `alone, the timed-out pick's live answer is stored (${pa()?.name})`);
            await post('/api/local/admin/public-address/offline');
            // Again, then the owner picks another name and takes it offline: the registrar's newest live row is slow-pick2.
            reg.claim = (b) => b.name === 'slow-pick2' ? new Promise((r) => { finish = () => r(live(b.name, 'eyJ.token-slow-pick2')); }) : live(b.name, `eyJ.token-${b.name}`);
            const slow2 = await post('/api/local/admin/public-address/claim', { name: 'slow-pick2', mode: 'tunnel' });
            assert(slow2.status === 400 && pa() == null, `the second claim timed out too (${slow2.status})`);
            finish();
            const pick = await post('/api/local/admin/public-address/claim', { name: 'owner-pick4', mode: 'tunnel' });
            assert(pick.status === 200 && pa()?.name === 'owner-pick4', `the owner picks owner-pick4 (${pick.status})`);
            const off = await post('/api/local/admin/public-address/offline');
            assert(off.status === 200 && pa() == null, `Take offline (${off.status})`);
            reg.status = () => live('slow-pick2', 'eyJ.token-slow-pick2');
            await reconcile();
            assert(pa() == null, `the tick does not revive the timed-out pick (${pa()?.name})`);
            const shown = await settingsGet!('/api/local/admin/public-address/status');
            assert(shown.status === 200 && pa() == null && shown.body?.status !== 'live', `nor does Settings' status read (${pa()?.name}/${shown.body?.status})`);
            assert(!tunnelConnectorForTests().runningToken, `no tunnel runs (${tunnelConnectorForTests().runningToken})`);
            // A request from beanpool claim replaced by another one: the replaced name is turned away too.
            updateLocalConfig({ addressRequest: { name: 'first-ask', mode: 'tunnel', contact: null, requestedAt: Date.now(), refused: null } });
            reg.claim = () => [503, { error: 'busy' }];
            await reconcile();
            writeAddressRequestFile(DATA!, { name: 'second-ask', contact: null, at: Date.now() });
            await checkAddressRequest();
            assert(getLocalConfig().addressRequest?.name === 'second-ask', `the second request replaces the first (${getLocalConfig().addressRequest?.name})`);
            reg.status = () => live('first-ask', 'eyJ.token-first-ask');
            const m = claims().length;
            await reconcile();
            assert(pa()?.name !== 'first-ask' && claims()[m]?.body?.name === 'second-ask', `the replaced request's late name is not stored; the new one is claimed (${pa()?.name} ${claims()[m]?.body?.name})`);
            updateLocalConfig({ addressRequest: null });
            await post('/api/local/admin/public-address/offline');
            // A node from before the list: its one ended request is still turned away; the list keeps the latest 8.
            updateLocalConfig({ turnedAwayNames: null, endedAddressRequest: { name: 'old-ended', at: 1 } } as any);
            reg.status = () => live('old-ended', 'eyJ.token-old-ended');
            await reconcile();
            assert(pa() == null, `an older node's ended request is still turned away (${pa()?.name})`);
            for (let i = 0; i < 9; i++) noteTurnedAway(`gone-${i}`, 'taken-offline');
            const kept = (getLocalConfig() as any).turnedAwayNames as { name: string }[];
            assert(kept.length === 8 && kept[kept.length - 1].name === 'gone-8' && !kept.some((e) => e.name === 'gone-0' || e.name === 'old-ended')
                && getLocalConfig().endedAddressRequest == null, `the list keeps the latest 8, the old field moved into it (${kept.map((e) => e.name).join(',')})`);
            reg.holder = (b) => ({ name: b?.name, held: 'free' });
            reg.status = () => ({ status: 'none' });
            reg.claim = (b) => live(b.name, `eyJ.token-${b.name}`);
        });

        await section('20. the key holds a name it does not use: Settings shows it, and releases it by name, never the stored one', async () => {
            const post = settingsPost!;
            const set = await post('/api/local/admin/public-address/claim', { name: 'owner-pick5', mode: 'tunnel' });
            assert(set.status === 200 && pa()?.name === 'owner-pick5', `the owner's pick is stored (${set.status})`);
            assert(await upOn('eyJ.token-owner-pick5'), 'its tunnel runs');
            noteTurnedAway('late-one', 'late-claim');
            const holds = new Set(['late-one', 'owner-pick5']);
            reg.holder = (b) => holds.has(b?.name) ? { name: b.name, held: 'you', state: 'live', since: 1 } : { name: b?.name, held: 'free' };
            const offlines = () => reg.calls.filter((c) => c.path === '/api/registrar/offline');
            const extra = await settingsGet!('/api/local/admin/public-address/extra-names');
            assert(extra.status === 200 && JSON.stringify(extra.body?.names?.map((n: any) => [n.name, n.releasable])) === '[["late-one",true]]',
                `Settings lists the unused name, releasable, and not the stored one (${extra.status} ${JSON.stringify(extra.body?.names)})`);
            const o0 = offlines().length;
            const mine = await post('/api/local/admin/public-address/release-name', { name: 'owner-pick5' });
            assert(mine.status === 409 && offlines().length === o0 && pa()?.name === 'owner-pick5', `the stored name is never released here (${mine.status} ${offlines().length - o0})`);
            const rel = await post('/api/local/admin/public-address/release-name', { name: 'late-one' });
            assert(rel.status === 200 && offlines().length === o0 + 1 && offlines()[o0].body?.name === 'late-one',
                `the unused name is released by name (${rel.status} ${JSON.stringify(offlines()[o0]?.body)})`);
            assert(pa()?.name === 'owner-pick5' && pa()?.status === 'live' && tunnelConnectorForTests().runningToken === 'eyJ.token-owner-pick5',
                `the stored address and its tunnel are untouched (${pa()?.name} ${tunnelConnectorForTests().runningToken})`);
            holds.delete('late-one');
            const after = await settingsGet!('/api/local/admin/public-address/extra-names');
            assert(after.status === 200 && after.body?.names?.length === 0, `once released, nothing is listed (${JSON.stringify(after.body?.names)})`);
            // A name this key does not hold: refused, nothing asked of the release.
            const free = await post('/api/local/admin/public-address/release-name', { name: 'gone-3' });
            assert(free.status === 409 && offlines().length === o0 + 1, `a name the registrar does not give this key is not released (${free.status})`);
            // An older registrar (no /holder) can't say what it would release: the agent's late claim is shown, never released.
            noteTurnedAway('late-two', 'late-claim');
            reg.holder = () => [404, { error: 'not found' }];
            const old = await settingsGet!('/api/local/admin/public-address/extra-names');
            assert(old.status === 200 && JSON.stringify(old.body?.names?.map((n: any) => [n.name, n.releasable])) === '[["late-two",false]]',
                `an older registrar: the late claim is shown, with no release (${JSON.stringify(old.body?.names)})`);
            const oldRel = await post('/api/local/admin/public-address/release-name', { name: 'late-two' });
            assert(oldRel.status === 409 && offlines().length === o0 + 1 && pa()?.name === 'owner-pick5',
                `and a release by name is refused, so an older release never lets go of the stored name (${oldRel.status})`);
            reg.holder = (b) => ({ name: b?.name, held: 'free' });
            await post('/api/local/admin/public-address/offline');
        });
    } catch (e: any) {
        assert(false, `the suite ran to the end (${e?.stack || e})`);
    } finally {
        await resetTunnelConnectorForTests().catch(() => {});
        setTunnelConnectorForTests(undefined);
        servers.app?.close();
        registrar.close();
        await Promise.resolve(p2p.stop()).catch(() => {});
    }
    assert(fakes().length === 0, 'no fake cloudflared is left running');
    console.log(`\n${passed}/${run} checks passed.`);
    process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

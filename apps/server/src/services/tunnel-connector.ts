// The community's Cloudflare tunnel, run by this server as its own child process (design
// scratch/global-node/DESIGN-tunnel-without-docker-socket-opus.md §3.4).
//
// Until 2026-09-28 a separate `cloudflared` container read data/tunnel-token, and the server restarted it through Docker's
// control socket, which it had mounted. Anything that can use that socket controls the whole machine, and cloudflared never
// exits on a dead token (it retries "Unauthorized" forever), so Docker's restart policy could not stand in for the socket.
// Now the server runs cloudflared itself: it starts, stops and restarts its own child, and needs no power beyond its own
// container.
//
// - The token comes ONLY from node_config's publicAddress (the registrar's answer). A token found in a file is never run:
//   data/tunnel-token is deleted at start (deploy.sh wrote the fleet token there).
// - A tunnel runs only on the main server (a standby holds a copy of publicAddress and must not answer for the name), and
//   not while a take-over is still waiting on its tunnel step (takeover.ts keeps that order).
// - The child gets an explicit environment: the token, PATH and HOME. Never process.env, which holds ADMIN_PASSWORD,
//   CF_API_TOKEN, IMAGE_S3_* and the Pulse secrets. The token goes in the environment, never argv (ps and /proc show argv).
// - Metrics on loopback. The official binary's default is 0.0.0.0, which inside this container every other stack on
//   beanpool-shared could reach, and it serves /debug/pprof and /config. Never the debug log level, which logs headers.
// - A dead tunnel ("Unauthorized" for 2 min) asks the registrar: a new token is run at once; the same token (or none)
//   means the tunnel is gone at Cloudflare though the name is live, so the saved name is claimed again, which is a heal
//   that re-makes the tunnel. At most once per 30 min, never two at once.
// - A tunnel whose ingress still names the old compose service (http://beanpool-node:8080) is moved to this server's
//   loopback once, by the same heal, when it first connects. docker-compose.yml pins beanpool-node to 127.0.0.1 so the old
//   origin reaches this server meanwhile, never another community's on beanpool-shared.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { getNodeRole, getNodeConfig, updateNodeConfig } from '../state-engine.js';
import { recordRegistrarAnswer } from '../engine/registrar-names.js';
import { addressStatus, claimAddress } from './registrar-client.js';
import { takeoverHoldsTunnel } from './takeover.js';
import { logger } from '../logger.js';

const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');

/**
 * Where the tunnel sends visitors: this server's own plain-HTTP listener over loopback, which serves /api and the web app
 * as it always has for the tunnel (http-server.ts). The same address the registrar name watch attests over (index.ts).
 */
export const LOOPBACK_ORIGIN = `http://127.0.0.1:${Number(process.env.PORT_HTTP ?? 8080)}`;

/** What earlier deploys and the compose sidecar left in the data folder. Nothing reads it now; it is deleted at start. */
export const LEFTOVER_TOKEN_FILE = 'tunnel-token';

export type TunnelState = 'off' | 'starting' | 'connected' | 'retrying' | 'missing';

export interface TunnelStatus {
    state: TunnelState;
    /** When the state last changed (ISO). */
    since: string;
    /** Connections to Cloudflare's edge, from cloudflared's /ready. */
    connections: number;
    /** Why it is retrying, not running, or missing; null when connected or off. */
    reason: string | null;
    /** cloudflared's version, as it printed it at start. */
    version: string | null;
}

interface Options {
    command: string;
    /** Test only: arguments before cloudflared's own (the fake's script and its control folder). */
    prefixArgs: string[];
    metricsPort: number;
    pollStartingMs: number;
    pollConnectedMs: number;
    deadAfterMs: number;
    healDebounceMs: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
    backoffResetMs: number;
    killGraceMs: number;
    collapseMs: number;
    dockerSocket: string;
    containerMarkers: string[];
}

const DEFAULTS: Options = {
    command: '/usr/local/bin/cloudflared',
    prefixArgs: [],
    metricsPort: 20241,
    pollStartingMs: 5_000,
    pollConnectedMs: 30_000,
    deadAfterMs: 2 * 60_000,
    healDebounceMs: 30 * 60_000,
    backoffBaseMs: 1_000,
    backoffMaxMs: 60_000,
    backoffResetMs: 10 * 60_000,
    killGraceMs: 10_000,
    collapseMs: 10 * 60_000,
    dockerSocket: '/var/run/docker.sock',
    containerMarkers: ['/.dockerenv', '/run/.containerenv'],
};

let opts: Options = { ...DEFAULTS };

const cloudflaredArgs = (port: number) => [
    'tunnel', '--no-autoupdate', '--metrics', `127.0.0.1:${port}`, '--output', 'json', '--loglevel', 'info', '--grace-period', '5s', 'run',
];

interface Running {
    child: ChildProcess;
    token: string;
    pid: number;
    startedAt: number;
    stopping: boolean;
    exited: Promise<void>;
}

let running: Running | null = null;
let status: TunnelStatus = { state: 'off', since: new Date().toISOString(), connections: 0, reason: null, version: null };
let chain: Promise<unknown> = Promise.resolve();
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let respawnTimer: ReturnType<typeof setTimeout> | null = null;
let crashes = 0;
/** The token the last child was started with: a crashed child's respawn waits for its backoff only on the same token. */
let lastToken: string | null = null;
let lastError: string | null = null;
let unauthorizedSince: number | null = null;
let registrarBusy = false;
let lastHealAt = 0;
let lastOriginAttemptAt = 0;
let missingLogged = false;
/** Set by the take-over's own tunnel step: from then on its journal no longer holds the tunnel back in this process. */
let takeoverReleased = false;
let exitHookInstalled = false;

function setStatus(state: TunnelState, reason: string | null = null, connections = 0): void {
    if (status.state !== state || status.reason !== reason || status.connections !== connections) {
        const since = status.state === state ? status.since : new Date().toISOString();
        status = { ...status, state, since, reason, connections };
    }
}

export function getTunnelStatus(): TunnelStatus {
    return { ...status };
}

/** node_config's address when it is a live tunnel with a token: the only thing a tunnel is run from. */
function savedTunnelAddress(): any | null {
    const pa = (getNodeConfig() as any).publicAddress;
    if (!pa || typeof pa !== 'object' || pa.status !== 'live' || pa.mode === 'direct') return null;
    return typeof pa.tunnelToken === 'string' && pa.tunnelToken.trim() ? pa : null;
}

/** The token a tunnel should run with now, or null for none. */
function wantedToken(): string | null {
    if (getNodeRole() !== 'primary') return null;
    if (!takeoverReleased && takeoverHoldsTunnel()) return null;
    return savedTunnelAddress()?.tunnelToken.trim() ?? null;
}

// ── Logs ─────────────────────────────────────────────────────────────────────────────────────

const recent = new Map<string, { level: 'warn' | 'error'; firstAt: number; more: number }>();

function scrub(text: string): string {
    let out = text;
    for (const t of [running?.token, savedTunnelAddress()?.tunnelToken]) {
        if (typeof t === 'string' && t.length >= 8) out = out.split(t).join('[tunnel token]');
    }
    return out.length > 400 ? `${out.slice(0, 400)}…` : out;
}

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

function say(level: 'info' | 'warn' | 'error', text: string): void {
    const line = `[Tunnel] ${text}`;
    if (level === 'error') logger.error('SYS', line);
    else if (level === 'warn') logger.warn('SYS', line);
    else logger.info('SYS', line);
}

/** One count line for each repeated message whose window is over (or all of them). */
function flushRepeats(all = false): void {
    const now = Date.now();
    for (const [text, r] of recent) {
        if (!all && now - r.firstAt < opts.collapseMs) continue;
        if (r.more > 0) say(r.level, `failed ${r.more + 1} times since ${hhmm(r.firstAt)} UTC: ${text}`);
        recent.delete(text);
    }
}

/** A warning or error from cloudflared, logged once per 10 min; repeats inside that window become a count. */
function forward(level: 'warn' | 'error', text: string): void {
    const r = recent.get(text);
    if (r && Date.now() - r.firstAt < opts.collapseMs) { r.more++; return; }
    if (r) flushRepeats();
    if (recent.size >= 50) flushRepeats(true);
    recent.set(text, { level, firstAt: Date.now(), more: 0 });
    say(level, text);
}

function onLine(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    let entry: any = null;
    try { entry = JSON.parse(line); } catch { /* cloudflared prints a start-up failure as plain text */ }
    // After a start-up failure it prints a pointer to its help: the line before it says what went wrong.
    if (!entry && /^See 'cloudflared\b.*--help'\.?$/.test(line)) return;
    const level = typeof entry?.level === 'string' ? entry.level : (entry ? 'info' : 'error');
    if (level === 'debug' || level === 'trace') return;
    const message = entry ? String(entry.message ?? '') : line;
    const error = entry && entry.error !== undefined ? String(entry.error) : '';
    if (level === 'info') {
        const v = /^Version (\S+)/.exec(message);
        if (v && status.version !== v[1]) {
            status = { ...status, version: v[1] };
            say('info', `cloudflared ${v[1]}`);
        }
        if (/Registered tunnel connection/i.test(message)) schedulePoll(0);
        return;
    }
    const reason = scrub(error || message || line);
    forward(level === 'warn' ? 'warn' : 'error', scrub(error && message ? `${message}: ${error}` : reason));
    lastError = reason;
    if (/unauthorized/i.test(reason) && unauthorizedSince === null) unauthorizedSince = Date.now();
    if (status.state !== 'connected' && running) setRetrying(reason);
    maybeHeal();
}

/** Not connected, and why. A child started after crashes says so too: its newest line alone would hide that it keeps stopping. */
function setRetrying(reason: string): void {
    const streak = !!running && crashes > 0 && Date.now() - running.startedAt < opts.backoffResetMs;
    setStatus('retrying', streak ? `${reason} (cloudflared has stopped ${crashes} time${crashes === 1 ? '' : 's'} in a row)` : reason);
}

// ── The child ────────────────────────────────────────────────────────────────────────────────

function childEnv(token: string): NodeJS.ProcessEnv {
    return { TUNNEL_TOKEN: token, PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: os.homedir() };
}

function installExitHook(): void {
    if (exitHookInstalled) return;
    exitHookInstalled = true;
    // In a container the kernel ends the child with the node (it is PID 1). Run any other way, a node that exits would
    // leave its tunnel running on its own, and the next start's would fail to bind its metrics port.
    process.on('exit', () => { try { running?.child.kill('SIGTERM'); } catch { /* already gone */ } });
}

async function spawnChild(token: string): Promise<void> {
    if (!fs.existsSync(opts.command)) {
        setStatus('missing', `cloudflared is not in this server's image (${opts.command}), so the tunnel can't run. Update the image.`);
        if (!missingLogged) { missingLogged = true; say('error', status.reason!); }
        return;
    }
    missingLogged = false;
    installExitHook();
    let child: ChildProcess;
    try {
        child = spawn(opts.command, [...opts.prefixArgs, ...cloudflaredArgs(opts.metricsPort)], {
            env: childEnv(token),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (e: any) {
        setStatus('missing', `cloudflared could not be started: ${e?.message || e}`);
        say('error', status.reason!);
        return;
    }
    const started = await new Promise<Error | null>((resolve) => {
        child.once('spawn', () => resolve(null));
        child.once('error', (e) => resolve(e));
    });
    if (started) {
        const code = (started as NodeJS.ErrnoException).code;
        setStatus(code === 'ENOENT' || code === 'EACCES' ? 'missing' : 'retrying', `cloudflared could not be started: ${started.message}`);
        say('error', status.reason!);
        return;
    }
    let exitedResolve: () => void;
    const r: Running = {
        child, token, pid: child.pid!, startedAt: Date.now(), stopping: false,
        exited: new Promise<void>((res) => { exitedResolve = res; }),
    };
    running = r;
    lastError = null;
    unauthorizedSince = null;
    setStatus('starting');
    for (const stream of [child.stdout!, child.stderr!]) readline.createInterface({ input: stream }).on('line', onLine);
    child.on('error', () => { /* reported by exit */ });
    child.on('exit', (code, signal) => {
        exitedResolve();
        if (running !== r) return;
        running = null;
        stopPoll();
        if (r.stopping) return;
        const ran = Date.now() - r.startedAt;
        if (ran >= opts.backoffResetMs) crashes = 0;
        crashes++;
        const delay = Math.min(opts.backoffBaseMs * 2 ** (crashes - 1), opts.backoffMaxMs);
        const how = signal ? `was stopped by ${signal}` : `stopped (exit code ${code})`;
        const wait = delay < 1_000 ? `${delay} ms` : `${Math.round(delay / 1000)} s`;
        setStatus('retrying', `cloudflared ${how}${lastError ? `: ${lastError}` : ''}; starting it again in ${wait}`);
        say('warn', status.reason!);
        if (respawnTimer) clearTimeout(respawnTimer);
        respawnTimer = setTimeout(() => { respawnTimer = null; void syncTunnel(); }, delay);
        respawnTimer.unref?.();
    });
    schedulePoll(opts.pollStartingMs);
}

async function stopChild(): Promise<void> {
    const r = running;
    if (!r) return;
    r.stopping = true;
    try { r.child.kill('SIGTERM'); } catch { /* gone */ }
    const killed = await Promise.race([r.exited.then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), opts.killGraceMs).unref?.())]);
    if (!killed) {
        try { r.child.kill('SIGKILL'); } catch { /* gone */ }
        await r.exited;
    }
    if (running === r) running = null;
    stopPoll();
}

function clearRespawn(): void {
    if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
}

async function doSync(): Promise<void> {
    const want = wantedToken();
    if (!want) {
        clearRespawn();
        crashes = 0;
        if (running) await stopChild();
        setStatus('off');
        flushRepeats(true);
        return;
    }
    if (running && running.token === want) return;
    // A crashed child is started again by its own timer, after its backoff; a new token starts at once.
    if (!running && respawnTimer && lastToken === want) return;
    if (lastToken !== want) { clearRespawn(); crashes = 0; }
    if (running) await stopChild();
    lastToken = want;
    await spawnChild(want);
}

function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
}

/** Start, stop or restart the child so it runs node_config's token, or nothing. Serialised: never two children. */
export function syncTunnel(): Promise<TunnelStatus> {
    return serial(async () => { await doSync(); return getTunnelStatus(); });
}

/** Settings' "Restart tunnel": a fresh child on the same token. Returns null when this server runs no tunnel. */
export function restartTunnel(): Promise<TunnelStatus | null> {
    return serial(async () => {
        const want = wantedToken();
        if (!want) { await doSync(); return null; }
        clearRespawn();
        crashes = 0;
        if (running) await stopChild();
        lastToken = want;
        await spawnChild(want);
        return getTunnelStatus();
    });
}

/** The take-over's tunnel step (takeover.ts): the journal no longer holds the tunnel back. */
export function startTunnelForTakeover(): Promise<TunnelStatus> {
    takeoverReleased = true;
    return syncTunnel();
}

// ── Health ───────────────────────────────────────────────────────────────────────────────────

function stopPoll(): void {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

function schedulePoll(ms: number): void {
    stopPoll();
    pollTimer = setTimeout(() => { pollTimer = null; void poll(); }, ms);
    pollTimer.unref?.();
}

async function readyConnections(): Promise<number | null> {
    try {
        const res = await fetch(`http://127.0.0.1:${opts.metricsPort}/ready`, { signal: AbortSignal.timeout(3_000) });
        const body: any = await res.json().catch(() => ({}));
        return res.status === 200 ? Math.max(1, Number(body?.readyConnections) || 1) : 0;
    } catch {
        return null;
    }
}

async function poll(): Promise<void> {
    const r = running;
    if (!r) return;
    const n = await readyConnections();
    if (running !== r) return;
    if (n && n > 0) {
        if (status.state !== 'connected') {
            say('info', `connected to Cloudflare (${n} connection${n === 1 ? '' : 's'})`);
            flushRepeats(true);
        }
        lastError = null;
        unauthorizedSince = null;
        setStatus('connected', null, n);
        maybeMoveOrigin();
    } else if (status.state === 'connected') {
        setRetrying(lastError || (n === null ? 'cloudflared does not answer its health check' : 'lost its connection to Cloudflare'));
        say('warn', `no longer connected to Cloudflare (${status.reason})`);
    } else if (lastError) {
        setRetrying(lastError);
    }
    flushRepeats();
    maybeHeal();
    schedulePoll(status.state === 'connected' ? opts.pollConnectedMs : opts.pollStartingMs);
}

// ── The registrar: a dead tunnel, and the move to loopback ──────────────────────────────────

/**
 * Save a registrar answer as the node's address and run what it says. The record of names (engine/registrar-names.ts) is
 * written first, so a name stored until now is kept as a former one when the answer names another. `claim`: the node's
 * own claim answered.
 */
export function persistAddress(pa: any, use: 'stored' | 'claim' = 'stored'): Promise<TunnelStatus> {
    recordRegistrarAnswer(pa, use);
    const prev = (getNodeConfig() as any).publicAddress;
    updateNodeConfig({ publicAddress: withKeptOrigin(withKeptTunnelToken(pa, prev), prev) } as any);
    return syncTunnel();
}

/**
 * Save the registrar's answer. The registrar leaves `tunnelToken` out of its status when its own call to Cloudflare
 * fails (apps/registrar/src/index.js), so saving the answer as it came would drop a token that still works, and
 * the take-over keys would be re-locked without it until the next good answer (967 follow-up #2). So a missing
 * token keeps the one already saved for the same name.
 */
export function withKeptTunnelToken(next: any, prev: any): any {
    if (!next || typeof next !== 'object' || (typeof next.tunnelToken === 'string' && next.tunnelToken)) return next;
    const kept = prev && typeof prev === 'object' && typeof prev.tunnelToken === 'string' && prev.tunnelToken ? prev.tunnelToken : null;
    const sameName = !next.name || !prev?.name || next.name === prev.name;
    return kept && sameName ? { ...next, tunnelToken: kept } : next;
}

/** The registrar's status never says where the tunnel points; the node records it when it sets it (same name only). */
function withKeptOrigin(next: any, prev: any): any {
    if (!next || typeof next !== 'object' || next.origin || !prev?.origin) return next;
    const sameName = !next.name || !prev.name || next.name === prev.name;
    return sameName ? { ...next, origin: prev.origin } : next;
}

function maybeHeal(): void {
    if (unauthorizedSince === null || registrarBusy || !running) return;
    const now = Date.now();
    if (now - unauthorizedSince < opts.deadAfterMs || now - lastHealAt < opts.healDebounceMs) return;
    void healDeadTunnel();
}

/** The saved name, claimed again: the registrar's heal (its own name) re-asserts the tunnel, ingress and DNS. */
async function reclaimSaved(pa: any, why: string): Promise<boolean> {
    say('info', `${why}: asking the address service to re-make ${pa.hostname || pa.name} (a heal of this server's own name)`);
    const res = await claimAddress(pa.name, 'tunnel', LOOPBACK_ORIGIN);
    if (res?.status === 'live') {
        const { changed: _changed, ...answer } = res;
        await persistAddress({ ...pa, ...answer, name: pa.name, mode: 'tunnel', origin: LOOPBACK_ORIGIN }, 'stored');
        return true;
    }
    recordRegistrarAnswer({ name: pa.name, hostname: pa.hostname, ...res }, 'status');
    say('warn', `the address service answered "${res?.status ?? 'nothing'}" for ${pa.hostname || pa.name}; Settings shows it`);
    return false;
}

async function healDeadTunnel(): Promise<void> {
    registrarBusy = true;
    lastHealAt = Date.now();
    try {
        const pa = savedTunnelAddress();
        if (!pa?.name || getNodeRole() !== 'primary') return;
        const st = await addressStatus();
        if (st?.status === 'live') {
            const token = typeof st.tunnelToken === 'string' ? st.tunnelToken.trim() : '';
            if ((st.name && st.name !== pa.name) || (token && token !== running?.token)) {
                say('info', `Cloudflare refuses the tunnel; the address service has a new token for ${st.hostname || st.name}: running it`);
                await persistAddress(st, 'stored');
                return;
            }
            // Live, on the same token (or the registrar couldn't read it from Cloudflare): the tunnel is gone at
            // Cloudflare though the name is still this server's.
            await reclaimSaved(pa, 'Cloudflare refuses the tunnel although the address service has the name live');
            return;
        }
        // Any other answer is written on the name it concerns; the agent, the name watch and Settings act on it.
        recordRegistrarAnswer(st, 'status');
        say('warn', `Cloudflare refuses the tunnel, and the address service answers "${st?.status ?? 'nothing'}" for ${pa.hostname || pa.name}; Settings shows it`);
    } catch (e: any) {
        say('warn', `could not ask the address service about the refused tunnel: ${e?.message || e}`);
    } finally {
        registrarBusy = false;
    }
}

function maybeMoveOrigin(): void {
    if (registrarBusy || getNodeRole() !== 'primary') return;
    const pa = savedTunnelAddress();
    if (!pa?.name || pa.origin === LOOPBACK_ORIGIN) return;
    if (Date.now() - lastOriginAttemptAt < opts.healDebounceMs) return;
    void moveOriginToLoopback();
}

/**
 * A tunnel whose ingress was set before the tunnel ran inside this server names the compose service
 * (http://beanpool-node:8080). Re-claim the saved name once with this server's loopback: a heal (the registrar re-PUTs
 * the ingress with the origin it is sent), then record it so it is never asked again.
 */
async function moveOriginToLoopback(): Promise<void> {
    registrarBusy = true;
    lastOriginAttemptAt = Date.now();
    try {
        const pa = savedTunnelAddress();
        if (!pa?.name) return;
        // Only a name the registrar says is live and this key's: a claim of a released one would take it back.
        const st = await addressStatus();
        if (st?.status !== 'live' || (st.name && st.name !== pa.name)) {
            say('info', `not moving ${pa.hostname || pa.name} to ${LOOPBACK_ORIGIN} yet: the address service answers "${st?.status ?? 'nothing'}"`);
            return;
        }
        if (await reclaimSaved(pa, `moving the tunnel's destination to ${LOOPBACK_ORIGIN}`)) {
            say('info', `${pa.hostname || pa.name} now leads to ${LOOPBACK_ORIGIN} inside this server`);
        }
    } catch (e: any) {
        say('warn', `could not move the tunnel's destination to ${LOOPBACK_ORIGIN}: ${e?.message || e}; tried again in 30 min`);
    } finally {
        registrarBusy = false;
    }
}

// ── Start ────────────────────────────────────────────────────────────────────────────────────

/** Docker's control socket inside this container: this server never uses it, and whatever can use it owns the machine. */
export function dockerSocketMounted(): boolean {
    try {
        return opts.containerMarkers.some((m) => fs.existsSync(m)) && fs.existsSync(opts.dockerSocket);
    } catch {
        return false;
    }
}

export const DOCKER_SOCKET_WARNING = "docker-compose.yml still mounts Docker's control socket (/var/run/docker.sock). This server doesn't use it; "
    + 'remove that line (or git pull the new docker-compose.yml) and start the server again: anything that can use the socket controls the whole machine.';

/**
 * At start, on every server: delete a leftover data/tunnel-token (a copy of a secret in the folder owners copy and hand
 * to helpers; on our servers the fleet token deploy.sh wrote), warn about a mounted Docker socket, and start the tunnel
 * where one is wanted. Never throws.
 */
export function initTunnelConnector(): Promise<TunnelStatus> {
    try {
        const leftover = path.join(DATA_DIR, LEFTOVER_TOKEN_FILE);
        if (fs.existsSync(leftover)) {
            fs.rmSync(leftover, { force: true });
            say('info', 'deleted data/tunnel-token: the tunnel now runs inside this server, on the token in its settings');
        }
    } catch (e: any) {
        say('warn', `could not delete data/tunnel-token: ${e?.message || e}`);
    }
    if (dockerSocketMounted()) logger.security('SYS', `⚠️ ${DOCKER_SOCKET_WARNING}`);
    return syncTunnel().catch((e) => {
        say('error', `could not start: ${e?.message || e}`);
        return getTunnelStatus();
    });
}

// ── Tests ────────────────────────────────────────────────────────────────────────────────────

/** Tests only: replace the binary (a fake), its metrics port and the timings. `undefined` restores the defaults. */
export function setTunnelConnectorForTests(o: Partial<Options> | undefined): void {
    opts = o ? { ...opts, ...o } : { ...DEFAULTS };
}

/** Tests only: what the connector wants and runs. */
export function tunnelConnectorForTests(): { wantedToken: string | null; runningToken: string | null; pid: number | null; crashes: number; status: TunnelStatus } {
    return { wantedToken: wantedToken(), runningToken: running?.token ?? null, pid: running?.pid ?? null, crashes, status: getTunnelStatus() };
}

/** Tests only: stop any child and forget everything, as a fresh process. */
export async function resetTunnelConnectorForTests(): Promise<void> {
    await serial(async () => {
        clearRespawn();
        if (running) await stopChild();
    });
    stopPoll();
    recent.clear();
    crashes = 0;
    lastError = null;
    lastToken = null;
    unauthorizedSince = null;
    registrarBusy = false;
    lastHealAt = 0;
    lastOriginAttemptAt = 0;
    missingLogged = false;
    takeoverReleased = false;
    status = { state: 'off', since: new Date().toISOString(), connections: 0, reason: null, version: null };
}

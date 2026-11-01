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
// - A name the registrar paused (its sweep saw another node's key, or something that is no BeanPool node, answer at it;
//   the pause removes the tunnel) is asked back with a heal, never a claim: on the agent's next tick, or once the dead
//   tunnel is noticed. The registrar routes it again once this server proves its key. Nobody has to do anything.
// - A tunnel whose ingress still names the old compose service (http://beanpool-node:8080) is moved to this server's
//   loopback once, by the same heal, when it first connects. docker-compose.yml pins beanpool-node to 127.0.0.1 so the old
//   origin reaches this server meanwhile, never another community's on beanpool-shared.
// - One child per live name this key holds (rename S2, design scratch/fable-design/DESIGN-rename-primary-name-fable.md §1):
//   the stored address's, and each name the community moved off that the record of names still calls live (otherHosts), so
//   an old name keeps answering after a claim of a new one, and while a gated one waits. Each has its own metrics port,
//   crash back-off and token; one name's crash or new token touches no other. A moved-off name's token is the one its child
//   already runs, then what /status?name= answers on the agent's tick (askAboutOtherNames). It is only ever held in memory:
//   a start asks again, so a take-over needs nothing new and no second secret is at rest. A server with one name asks
//   nothing more of the registrar and runs as it always did. Settings' claim, rotate, status and origin stay the stored
//   name's; a moved-off name is only kept up, and let go by Release.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { getNodeRole, getNodeConfig, updateNodeConfig, publicAddressGeneration } from '../state-engine.js';
import { recordRegistrarAnswer, registrarNames, registrarHostOf, REGISTRAR_ZONE } from '../engine/registrar-names.js';
import { claimReplacesAddress, tellMembersOfNewAddress } from './address-notice.js';
import { settleUnansweredClaims, turnedAwayList } from '../config/turned-away-names.js';
import { addressStatus, askNameHolder, claimAddress, healAddress } from './registrar-client.js';
import { takeoverHoldsTunnel } from './takeover.js';
import { logger } from '../logger.js';
import { redactPhotoLinks } from '../sanitize-message.js';

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
    /** The tunnels of the other names this key holds; left out on a server with one name. The fields above are the stored name's. */
    others?: OtherTunnelStatus[];
}

export interface OtherTunnelStatus {
    host: string;
    state: TunnelState;
    since: string;
    connections: number;
    reason: string | null;
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
    /** How long an unanswered claim's ask-again waits before its one retry (reclaimUnanswered). */
    reclaimRetryMs: number;
    /** The most children this server runs: a bound on what a long record of names can cost (each cloudflared is its own process). */
    maxTunnels: number;
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
    // The registrar keeps working on a claim up to 30 s after its node stops waiting (waitUntil): past that, it is done.
    reclaimRetryMs: 35_000,
    // The registrar's claim_limit_per_key (apps/registrar settings.js): a key holds no more than this.
    maxTunnels: 3,
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

/** One name's cloudflared: its child and all that is known of it. Nothing here is shared with another name's. */
interface Tunnel {
    host: string;
    metricsPort: number;
    running: Running | null;
    status: Omit<TunnelStatus, 'version' | 'others'>;
    pollTimer: ReturnType<typeof setTimeout> | null;
    respawnTimer: ReturnType<typeof setTimeout> | null;
    crashes: number;
    /** The token the last child was started with: a crashed child's respawn waits for its backoff only on the same token. */
    lastToken: string | null;
    lastError: string | null;
    unauthorizedSince: number | null;
    lastHealAt: number;
}

/** Every name's tunnel, by host. A name is here while a tunnel is wanted for it, child or none (crashed, binary missing). */
const tunnels = new Map<string, Tunnel>();
/** The tokens /status gave for the other names (askAboutOtherNames). In memory only: a start asks again. */
const otherTokens = new Map<string, string>();
/** When the stored name last had no tunnel. */
let offSince = new Date().toISOString();
/** cloudflared's version, as a child printed it: one binary, whichever name. */
let version: string | null = null;
let chain: Promise<unknown> = Promise.resolve();
let registrarBusy = false;
let askingAboutOthers = false;
let lastOriginAttemptAt = 0;
let missingLogged = false;
/** Set by the take-over's own tunnel step: from then on its journal no longer holds the tunnel back in this process. */
let takeoverReleased = false;
let exitHookInstalled = false;

function setStatus(t: Tunnel, state: TunnelState, reason: string | null = null, connections = 0): void {
    const s = t.status;
    if (s.state !== state || s.reason !== reason || s.connections !== connections) {
        t.status = { ...s, state, since: s.state === state ? s.since : new Date().toISOString(), reason, connections };
    }
}

/** The stored name's tunnel, which Settings, a claim and the members' notice go by; null when it has none. */
function mainTunnel(): Tunnel | null {
    const pa = savedTunnelAddress();
    return pa ? tunnels.get(tunnelHost(pa)) ?? null : null;
}

/** The stored name's tunnel, as Settings reads it, and any other name's beside it. */
export function getTunnelStatus(): TunnelStatus {
    const main = mainTunnel();
    const others = [...tunnels.values()].filter((t) => t !== main).map((t) => ({ host: t.host, ...t.status }));
    return {
        ...(main ? main.status : { state: 'off' as const, since: offSince, connections: 0, reason: null }),
        version,
        ...(others.length ? { others } : {}),
    };
}

/** node_config's address when it is a live tunnel with a token: the only thing a tunnel is run from. */
function savedTunnelAddress(): any | null {
    const pa = (getNodeConfig() as any).publicAddress;
    if (!pa || typeof pa !== 'object' || pa.status !== 'live' || pa.mode === 'direct') return null;
    return typeof pa.tunnelToken === 'string' && pa.tunnelToken.trim() ? pa : null;
}

/** Whether this server runs tunnels now: the main server, not while a take-over is still waiting on its tunnel step. */
const tunnelsMayRun = (): boolean => getNodeRole() === 'primary' && (takeoverReleased || !takeoverHoldsTunnel());

/** The token the stored name's tunnel should run with now, or null for none. */
function wantedToken(): string | null {
    return tunnelsMayRun() ? savedTunnelAddress()?.tunnelToken.trim() ?? null : null;
}

/** The key a stored address's tunnel goes by: the host the record of names knows it by, or what it says of itself. */
const tunnelHost = (pa: any): string => registrarHostOf(pa) ?? String(pa.hostname || pa.name || 'stored address').toLowerCase();

const WANTED_STATES: ReadonlySet<string> = new Set(['live']);
const ASKED_STATES: ReadonlySet<string> = new Set(['live', 'paused']);

/**
 * The names this community moved off that its key may still hold, whose last word from the registrar is one of `states`,
 * newest first, no more than this server can run: former in the record of names, and neither lost nor let go by Take offline
 * or Release. Never a name the community never went by: a claim that only waited, or a late one, is not `live` here.
 */
function otherHosts(states: ReadonlySet<string>): string[] {
    return registrarNames().filter((e) => e.role === 'former' && !e.lost && !e.releasedByUsAt && states.has(e.status))
        .sort((a, b) => (b.formerSince ?? '').localeCompare(a.formerSince ?? '')).slice(0, opts.maxTunnels).map((e) => e.address);
}

/**
 * The tunnels wanted now, host → token: the stored name's first, then each other live name whose token is known. That is
 * what its child already runs from the moment a claim moves the community off it, or what /status answered. Never two
 * children on one token: a token is a tunnel.
 */
function wantedTunnels(): Map<string, string> {
    const want = new Map<string, string>();
    if (!tunnelsMayRun()) return want;
    const saved = savedTunnelAddress();
    if (saved) want.set(tunnelHost(saved), saved.tunnelToken.trim());
    for (const host of otherHosts(WANTED_STATES)) {
        if (want.size >= opts.maxTunnels) break;
        const token = otherTokens.get(host) ?? tunnels.get(host)?.lastToken;
        if (token && !want.has(host) && ![...want.values()].includes(token)) want.set(host, token);
    }
    return want;
}

// ── Logs ─────────────────────────────────────────────────────────────────────────────────────

const recent = new Map<string, { level: 'warn' | 'error'; firstAt: number; more: number }>();

/** What cloudflared said, for a log line and the status Settings shows: a request's address in it may be a photo link's. */
function scrub(text: string): string {
    let out = redactPhotoLinks(text);
    for (const t of [...[...tunnels.values()].map((x) => x.running?.token), ...otherTokens.values(), savedTunnelAddress()?.tunnelToken]) {
        if (typeof t === 'string' && t.length >= 8) out = out.split(t).join('[tunnel token]');
    }
    return out.length > 400 ? `${out.slice(0, 400)}…` : out;
}

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

/** A log line about `t`: which name, once there is more than one to tell apart. */
const about = (t: Tunnel, text: string): string => (t === mainTunnel() ? text : `${t.host}: ${text}`);

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

function onLine(t: Tunnel, raw: string): void {
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
        if (v && version !== v[1]) {
            version = v[1];
            say('info', `cloudflared ${v[1]}`);
        }
        if (/Registered tunnel connection/i.test(message)) schedulePoll(t, 0);
        return;
    }
    const reason = scrub(error || message || line);
    forward(level === 'warn' ? 'warn' : 'error', about(t, scrub(error && message ? `${message}: ${error}` : reason)));
    t.lastError = reason;
    if (/unauthorized/i.test(reason) && t.unauthorizedSince === null) t.unauthorizedSince = Date.now();
    if (t.status.state !== 'connected' && t.running) setRetrying(t, reason);
    maybeHeal(t);
}

/** Not connected, and why. A child started after crashes says so too: its newest line alone would hide that it keeps stopping. */
function setRetrying(t: Tunnel, reason: string): void {
    const streak = !!t.running && t.crashes > 0 && Date.now() - t.running.startedAt < opts.backoffResetMs;
    setStatus(t, 'retrying', streak ? `${reason} (cloudflared has stopped ${t.crashes} time${t.crashes === 1 ? '' : 's'} in a row)` : reason);
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
    process.on('exit', () => { for (const t of tunnels.values()) { try { t.running?.child.kill('SIGTERM'); } catch { /* already gone */ } } });
}

async function spawnChild(t: Tunnel, token: string): Promise<void> {
    if (!fs.existsSync(opts.command)) {
        setStatus(t, 'missing', `cloudflared is not in this server's image (${opts.command}), so the tunnel can't run. Update the image.`);
        if (!missingLogged) { missingLogged = true; say('error', t.status.reason!); }
        return;
    }
    missingLogged = false;
    installExitHook();
    let child: ChildProcess;
    try {
        child = spawn(opts.command, [...opts.prefixArgs, ...cloudflaredArgs(t.metricsPort)], {
            env: childEnv(token),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (e: any) {
        setStatus(t, 'missing', `cloudflared could not be started: ${e?.message || e}`);
        say('error', about(t, t.status.reason!));
        return;
    }
    const started = await new Promise<Error | null>((resolve) => {
        child.once('spawn', () => resolve(null));
        child.once('error', (e) => resolve(e));
    });
    if (started) {
        const code = (started as NodeJS.ErrnoException).code;
        setStatus(t, code === 'ENOENT' || code === 'EACCES' ? 'missing' : 'retrying', `cloudflared could not be started: ${started.message}`);
        say('error', about(t, t.status.reason!));
        return;
    }
    let exitedResolve: () => void;
    const r: Running = {
        child, token, pid: child.pid!, startedAt: Date.now(), stopping: false,
        exited: new Promise<void>((res) => { exitedResolve = res; }),
    };
    t.running = r;
    t.lastError = null;
    t.unauthorizedSince = null;
    setStatus(t, 'starting');
    for (const stream of [child.stdout!, child.stderr!]) readline.createInterface({ input: stream }).on('line', (line) => onLine(t, line));
    child.on('error', () => { /* reported by exit */ });
    child.on('exit', (code, signal) => {
        exitedResolve();
        if (t.running !== r) return;
        t.running = null;
        stopPoll(t);
        if (r.stopping) return;
        const ran = Date.now() - r.startedAt;
        if (ran >= opts.backoffResetMs) t.crashes = 0;
        t.crashes++;
        const delay = Math.min(opts.backoffBaseMs * 2 ** (t.crashes - 1), opts.backoffMaxMs);
        const how = signal ? `was stopped by ${signal}` : `stopped (exit code ${code})`;
        const wait = delay < 1_000 ? `${delay} ms` : `${Math.round(delay / 1000)} s`;
        setStatus(t, 'retrying', `cloudflared ${how}${t.lastError ? `: ${t.lastError}` : ''}; starting it again in ${wait}`);
        say('warn', about(t, t.status.reason!));
        if (t.respawnTimer) clearTimeout(t.respawnTimer);
        t.respawnTimer = setTimeout(() => { t.respawnTimer = null; void syncTunnel(); }, delay);
        t.respawnTimer.unref?.();
    });
    schedulePoll(t, opts.pollStartingMs);
}

async function stopChild(t: Tunnel): Promise<void> {
    const r = t.running;
    if (!r) return;
    r.stopping = true;
    try { r.child.kill('SIGTERM'); } catch { /* gone */ }
    const killed = await Promise.race([r.exited.then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), opts.killGraceMs).unref?.())]);
    if (!killed) {
        try { r.child.kill('SIGKILL'); } catch { /* gone */ }
        await r.exited;
    }
    if (t.running === r) t.running = null;
    stopPoll(t);
}

function clearRespawn(t: Tunnel): void {
    if (t.respawnTimer) { clearTimeout(t.respawnTimer); t.respawnTimer = null; }
}

/** `host`'s tunnel, made when there is none: on the first metrics port no other tunnel holds, so a lone name keeps the usual one. */
function tunnelFor(host: string): Tunnel {
    const had = tunnels.get(host);
    if (had) return had;
    const taken = new Set([...tunnels.values()].map((x) => x.metricsPort));
    let metricsPort = opts.metricsPort;
    while (taken.has(metricsPort)) metricsPort++;
    const t: Tunnel = {
        host, metricsPort, running: null, status: { state: 'off', since: new Date().toISOString(), connections: 0, reason: null },
        pollTimer: null, respawnTimer: null, crashes: 0, lastToken: null, lastError: null, unauthorizedSince: null, lastHealAt: 0,
    };
    tunnels.set(host, t);
    return t;
}

/** No tunnel is wanted for this name any more: its child is stopped, and all that was known of it goes. */
async function retire(t: Tunnel): Promise<void> {
    clearRespawn(t);
    if (t.running) await stopChild(t);
    stopPoll(t);
    tunnels.delete(t.host);
    offSince = new Date().toISOString();
}

/** One name's child onto `want`: a token it already runs changes nothing. */
async function syncOne(t: Tunnel, want: string): Promise<void> {
    if (t.running && t.running.token === want) return;
    // A crashed child is started again by its own timer, after its backoff; a new token starts at once.
    if (!t.running && t.respawnTimer && t.lastToken === want) return;
    if (t.lastToken !== want) { clearRespawn(t); t.crashes = 0; }
    if (t.running) await stopChild(t);
    t.lastToken = want;
    await spawnChild(t, want);
}

async function doSync(): Promise<void> {
    const want = wantedTunnels();
    const saved = savedTunnelAddress();
    for (const host of otherTokens.keys()) if (!want.has(host) || (saved && host === tunnelHost(saved))) otherTokens.delete(host);
    for (const t of [...tunnels.values()]) if (!want.has(t.host)) await retire(t);
    for (const [host, token] of want) await syncOne(tunnelFor(host), token);
    if (!want.size) flushRepeats(true);
}

function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
}

/** Start, stop or restart the children so each name runs its token, or nothing. Serialised: never two children on a name. */
export function syncTunnel(): Promise<TunnelStatus> {
    return serial(async () => { await doSync(); return getTunnelStatus(); });
}

/** Settings' "Restart tunnel": a fresh child on the same token, for each name. Returns null when this server runs no tunnel. */
export function restartTunnel(): Promise<TunnelStatus | null> {
    return serial(async () => {
        const want = wantedTunnels();
        if (!want.size) { await doSync(); return null; }
        for (const t of [...tunnels.values()]) if (!want.has(t.host)) await retire(t);
        for (const [host, token] of want) {
            const t = tunnelFor(host);
            clearRespawn(t);
            t.crashes = 0;
            if (t.running) await stopChild(t);
            t.lastToken = token;
            await spawnChild(t, token);
        }
        const st = getTunnelStatus();
        // Only other names run (the stored one waits for approval): what Settings reads of the restart is theirs.
        return mainTunnel() ? st : { ...st, ...[...tunnels.values()][0].status };
    });
}

/** The take-over's tunnel step (takeover.ts): the journal no longer holds the tunnel back. */
export function startTunnelForTakeover(): Promise<TunnelStatus> {
    takeoverReleased = true;
    return syncTunnel().then((st) => { void askAboutOtherNames(); return st; });
}

// ── Health ───────────────────────────────────────────────────────────────────────────────────

function stopPoll(t: Tunnel): void {
    if (t.pollTimer) { clearTimeout(t.pollTimer); t.pollTimer = null; }
}

function schedulePoll(t: Tunnel, ms: number): void {
    stopPoll(t);
    t.pollTimer = setTimeout(() => { t.pollTimer = null; void poll(t); }, ms);
    t.pollTimer.unref?.();
}

async function readyConnections(port: number): Promise<number | null> {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(3_000) });
        const body: any = await res.json().catch(() => ({}));
        return res.status === 200 ? Math.max(1, Number(body?.readyConnections) || 1) : 0;
    } catch {
        return null;
    }
}

async function poll(t: Tunnel): Promise<void> {
    const r = t.running;
    if (!r) return;
    const n = await readyConnections(t.metricsPort);
    if (t.running !== r) return;
    if (n && n > 0) {
        if (t.status.state !== 'connected') {
            say('info', about(t, `connected to Cloudflare (${n} connection${n === 1 ? '' : 's'})`));
            flushRepeats(true);
        }
        t.lastError = null;
        t.unauthorizedSince = null;
        setStatus(t, 'connected', null, n);
        if (t === mainTunnel()) maybeMoveOrigin();
        tellMembersWhenReachable();
    } else if (t.status.state === 'connected') {
        setRetrying(t, t.lastError || (n === null ? 'cloudflared does not answer its health check' : 'lost its connection to Cloudflare'));
        say('warn', about(t, `no longer connected to Cloudflare (${t.status.reason})`));
    } else if (t.lastError) {
        setRetrying(t, t.lastError);
    }
    flushRepeats();
    maybeHeal(t);
    schedulePoll(t, t.status.state === 'connected' ? opts.pollConnectedMs : opts.pollStartingMs);
}

// ── The registrar: a dead tunnel, and the move to loopback ──────────────────────────────────

/**
 * Save a registrar answer as the node's address and run what it says. The record of names (engine/registrar-names.ts) is
 * written first, so a name stored until now is kept as a former one when the answer names another. `claim`: the node's
 * own claim answered, so the address it replaces stays this community's (services/address-notice.ts). A name that goes
 * live here is told to the members if a claim left that due, once they can reach it (tellMembersWhenReachable).
 */
export function persistAddress(pa: any, use: 'stored' | 'claim' = 'stored'): Promise<TunnelStatus> {
    const claimed = use === 'claim' ? registrarHostOf(pa) : null;
    if (claimed) claimReplacesAddress(claimed);
    recordRegistrarAnswer(pa, use);
    const prev = (getNodeConfig() as any).publicAddress;
    updateNodeConfig({ publicAddress: withKeptOrigin(withKeptTunnelToken(pa, prev), prev) } as any);
    return syncTunnel().then((st) => { tellMembersWhenReachable(); return st; });
}

/**
 * Tells the members of a new name, if a notice is due and they can reach it (services/address-notice.ts). A name on this
 * server's tunnel has no route until that tunnel connects, whatever the registrar says, and syncTunnel only starts it, so
 * poll() tells then. Goes by the stored address, not the token: the registrar answers live with no token when its
 * Cloudflare call fails (withLiveToken). Runs after syncTunnel, never before: a notice for a tunnel that can't start stays
 * due, and the next start's tunnel tells. A standby tells nobody.
 */
export function tellMembersWhenReachable(): void {
    if (getNodeRole() !== 'primary') return;
    const pa = (getNodeConfig() as any).publicAddress;
    const want = wantedToken();
    const onTunnel = !!pa?.name && pa.mode !== 'direct';
    const main = mainTunnel();
    if (onTunnel && !(want && main?.running?.token === want && main.status.state === 'connected')) return;
    tellMembersOfNewAddress();
}

/**
 * persistAddress for the answer to a registrar call that began when the address's write count was `since`
 * (publicAddressGeneration): stored only if nothing wrote the address meanwhile (Settings' claim or Take offline, a
 * take-over, another check's answer). Checked and written with no await between, so nothing can land in the gap.
 * null: not stored, and nothing else done.
 */
export function persistAddressIfUnchanged(pa: any, use: 'stored' | 'claim', since: number, asked: string | null = null): Promise<TunnelStatus> | null {
    if (publicAddressGeneration() !== since) return null;
    if (use === 'stored' && answersAboutAnotherName(pa, (getNodeConfig() as any).publicAddress, asked)) return null;
    return persistAddress(pa, use);
}

const otherNamesSaid = new Set<string>();
/**
 * With nothing stored: does `answer` name a name this server left? One its record keeps as former (taken offline, or
 * moved off by a claim of another; engine/registrar-names.ts), or one on its turned-away list (config/turned-away-names.ts:
 * an install request that ended without being given here, a Settings claim that got no answer and was then replaced, a
 * replaced `beanpool claim` request, a name taken offline). Never `asked`, nor the record's current name.
 */
function turnedAwayHere(answer: any, asked: string | null): boolean {
    const host = registrarHostOf(answer);
    if (!host || (asked && registrarHostOf({ name: asked }) === host)) return false;
    const entry = registrarNames().find((e) => e.address === host);
    if (entry) return entry.role !== 'current';
    return turnedAwayList().some((e) => e.why !== 'unanswered' && registrarHostOf({ name: e.name }) === host);
}
/**
 * Does the registrar's `answer` (a status or heal) name another name than the one `stored` here? Then it is never stored:
 * a key can hold two names (an install's claim answered after the owner's pick), and a registrar older than the one that
 * reads /status's `name` answers about the key's first name, whichever was asked. Storing it would move the community
 * onto a name nobody chose. Said once per pair.
 *
 * With nothing stored (Take offline, a fresh server) every registrar answers about the key's first name, which can be one
 * the owner took offline or the install's late claim. Then a name this server turned away is never stored (turnedAwayHere);
 * any other is, as a fresh server learns a name made for its key elsewhere. `asked`: the name the public-address agent
 * asks for (its env's, or `beanpool claim`'s request while it stands), never turned away.
 */
export function answersAboutAnotherName(answer: any, stored: any, asked: string | null = null): boolean {
    if (!stored?.name) {
        if (!turnedAwayHere(answer, asked)) return false;
        const pair = `→${answer?.name ?? ''}`;
        if (!otherNamesSaid.has(pair)) {
            otherNamesSaid.add(pair);
            say('warn', `the address service answered that this server's key holds "${answer?.name}", a name this server left `
                + '(taken offline, moved off, or asked for at install and then dropped): not stored; this server stays offline. Claim it in Settings to use it.');
        }
        return true;
    }
    if (answer?.name === stored.name) return false;
    const pair = `${stored.name}→${answer?.name ?? ''}`;
    if (!otherNamesSaid.has(pair)) {
        otherNamesSaid.add(pair);
        say('warn', `the address service answered about ${answer?.name ? `"${answer.name}"` : 'no name'} when asked about "${stored.name}": `
            + `not stored; this server stays on "${stored.name}"`);
    }
    return true;
}

/**
 * A claim of `name` that got no answer in time (registrar-client gives up after 25 s) can still complete at the registrar:
 * then this key holds the name, and nothing here says so. Asks who holds it. Held by this key and still pending — the
 * registrar still making it, or a gated claim waiting for approval — while this server holds no other address: asked for
 * again at once (reclaimUnanswered), never left for the owner to. Held by this key otherwise: said. An older registrar (no
 * /holder) or none answering: said as a maybe. `err`: the claim's error; anything but a timeout is no concern here.
 */
export async function noteUnansweredClaim(name: string, err: any): Promise<void> {
    if (!/timed out/.test(String(err?.message || ''))) return;
    const since = publicAddressGeneration();
    try {
        const r = await askNameHolder(name);
        if (r.json && r.data?.held === 'you') {
            if (r.data.state === 'pending' && holdsNoOtherAddress(name) && await reclaimUnanswered(name, since)) return;
            say('warn', `the claim of "${name}" got no answer in time, but the address service gives it to this server's key `
                + `(${r.data.state || 'held'}); it is not used here: claim "${name}" in Settings to use it`);
            return;
        }
        if (r.ok && r.json && typeof r.data?.held === 'string') return;   // not this key's: nothing is held
    } catch { /* nothing answered */ }
    say('warn', `the claim of "${name}" got no answer in time; the address service may still give it to this server's key`);
}

/**
 * A heal's live answer for tunnel name `name`, with the tunnel's token: a heal answers one only for a tunnel it made, and
 * one its claim made meanwhile (the registrar finishes a claim its node stopped waiting for) is in /status. As it came
 * when /status can't say: the agent's next check asks again.
 */
export async function withLiveToken(answer: any, name: string): Promise<any> {
    if (answer?.status !== 'live' || answer.mode === 'direct' || answer.tunnelToken) return answer;
    try {
        const st = await addressStatus(name);
        if (st?.status === 'live' && st.name === name && typeof st.tunnelToken === 'string' && st.tunnelToken) return { ...answer, tunnelToken: st.tunnelToken };
    } catch { /* nothing answered */ }
    return answer;
}

/** No address is stored here that this community uses (live, pending or paused) but `name` itself. */
function holdsNoOtherAddress(name: string): boolean {
    const pa = (getNodeConfig() as any).publicAddress;
    return !pa?.name || pa.name === name || !['live', 'pending', 'paused'].includes(pa.status);
}

/**
 * The unanswered claim's name, asked for again: a heal of this key's own name (never a claim: a heal can't take a new
 * name or take back a release), which finishes one the registrar is still making, or answers a gated one as waiting for
 * approval. While the claim itself is still being made at the registrar (it goes on after its node stops waiting), the
 * heal finds its tunnel in the way (503) or waits as long: asked once more when that work has had its time
 * (opts.reclaimRetryMs). Stored as the claim's answer would have been, only if nothing wrote the address since the claim's
 * answer was given up on (`since`). True when the registrar answered it, or the address was written meanwhile; false
 * when it did not answer, and the caller says what it would have said.
 */
async function reclaimUnanswered(name: string, since: number): Promise<boolean> {
    say('info', `the claim of "${name}" got no answer in time, and the address service holds it for this server's key, not finished: asking for it again`);
    let res: any;
    for (let tries = 2; ; tries--) {
        try { res = await healAddress(name, LOOPBACK_ORIGIN); break; }
        catch (e: any) {
            const busy = Number(e?.status) === 503 || /timed out/.test(String(e?.message || ''));
            if (!busy || tries === 1) { say('warn', `asking for "${name}" again failed: ${e?.message || e}`); return false; }
            await new Promise((r) => setTimeout(r, opts.reclaimRetryMs));
            if (publicAddressGeneration() !== since) return true;   // the owner (or the agent) wrote the address meanwhile: that stands
        }
    }
    if (res?.status !== 'live' && res?.status !== 'pending') return false;
    const { changed: _changed, attest: _attest, ...healed } = res;
    const answer = await withLiveToken(healed, name);
    const stored = persistAddressIfUnchanged({ ...answer, name, ...(answer.mode === 'direct' ? {} : { origin: LOOPBACK_ORIGIN }) }, 'claim', since);
    if (!stored) { addressChangedMeanwhile({ name, hostname: answer.hostname }); return true; }
    await stored;
    settleUnansweredClaims(name);   // as the claim's own answer would: this name is the owner's pick, stored
    say('info', res.status === 'live'
        ? `${answer.hostname || name} is live`
        : `"${name}" is ${res.reason === 'provisioning' ? 'still being set up by the address service' : 'awaiting approval'}; Settings shows it`);
    return true;
}

/** A heal's answer that came after the address was written another way: the newer write stands, the next tick looks again. */
function addressChangedMeanwhile(pa: any): void {
    say('info', `the address changed while the address service was asked about ${pa.hostname || pa.name}; its answer is not stored`);
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

function maybeHeal(t: Tunnel): void {
    if (t.unauthorizedSince === null || registrarBusy || !t.running) return;
    const now = Date.now();
    if (now - t.unauthorizedSince < opts.deadAfterMs || now - t.lastHealAt < opts.healDebounceMs) return;
    void (t === mainTunnel() ? healDeadTunnel(t) : healDeadOtherName(t));
}

/** The saved name, claimed again: the registrar's heal (its own name) re-asserts the tunnel, ingress and DNS. */
async function reclaimSaved(pa: any, why: string, since: number): Promise<boolean> {
    say('info', `${why}: asking the address service to re-make ${pa.hostname || pa.name} (a heal of this server's own name)`);
    const res = await claimAddress(pa.name, 'tunnel', LOOPBACK_ORIGIN);
    if (res?.status === 'live') {
        const { changed: _changed, ...answer } = res;
        const stored = persistAddressIfUnchanged({ ...pa, ...answer, name: pa.name, mode: 'tunnel', origin: LOOPBACK_ORIGIN }, 'stored', since);
        if (!stored) { addressChangedMeanwhile(pa); return false; }
        await stored;
        return true;
    }
    recordRegistrarAnswer({ name: pa.name, hostname: pa.hostname, ...res }, 'status');
    say('warn', `the address service answered "${res?.status ?? 'nothing'}" for ${pa.hostname || pa.name}; Settings shows it`);
    return false;
}

async function healDeadTunnel(t: Tunnel): Promise<void> {
    registrarBusy = true;
    t.lastHealAt = Date.now();
    try {
        const pa = savedTunnelAddress();
        const since = publicAddressGeneration();
        if (!pa?.name || getNodeRole() !== 'primary') return;
        const st = await addressStatus(pa.name);
        if (answersAboutAnotherName(st, pa)) return;
        if (st?.status === 'live') {
            const token = typeof st.tunnelToken === 'string' ? st.tunnelToken.trim() : '';
            if (token && token !== t.running?.token) {
                const stored = persistAddressIfUnchanged(st, 'stored', since);
                if (!stored) { addressChangedMeanwhile(pa); return; }
                say('info', `Cloudflare refuses the tunnel; the address service has a new token for ${st.hostname || st.name}: running it`);
                await stored;
                return;
            }
            // Live, on the same token (or the registrar couldn't read it from Cloudflare): the tunnel is gone at
            // Cloudflare though the name is still this server's.
            await reclaimSaved(pa, 'Cloudflare refuses the tunnel although the address service has the name live', since);
            return;
        }
        // Paused by the registrar's sweep (it removes the tunnel too): this server takes it back by proving its key.
        if (healable(st, pa)) { await healPaused(pa, st, since); return; }
        // Any other answer is written on the name it concerns; the agent, the name watch and Settings act on it.
        recordRegistrarAnswer(st, 'status');
        say('warn', `Cloudflare refuses the tunnel, and the address service answers "${st?.status ?? 'nothing'}" for ${pa.hostname || pa.name}; Settings shows it`);
    } catch (e: any) {
        say('warn', `could not ask the address service about the refused tunnel: ${e?.message || e}`);
    } finally {
        registrarBusy = false;
    }
}

// ── A paused name: this server takes it back ─────────────────────────────────────────────────

/**
 * Is the registrar's `st` a pause of this server's own tunnel name (the one saved in its settings) that its heal lifts?
 * Every pause but the admin's: the sweep's (another node's key, or something that is no BeanPool node, answered at the
 * name: 'impostor', 'content-swap'), a take-back not yet proved ('unverified'), the 2026-09-24 incident's. The admin's
 * pause is the BeanPool project's to lift; a blocked or released name is never taken back by a heal.
 */
function healable(st: any, pa: any): boolean {
    return st?.status === 'paused' && st.reason !== 'admin' && !!pa?.name && (!st.name || st.name === pa.name);
}

/**
 * The heal (never a claim): the registrar routes the name again only once this server proves its key, on a fresh tunnel
 * whose token only this signed request gets, or through an attestation at the name. A live answer is saved and run; any
 * other is written on the name, and the next tick asks again. Never throws.
 */
async function healPaused(pa: any, st: any, since: number): Promise<void> {
    say('info', `the address service paused ${pa.hostname || pa.name} (${st.reason || 'no reason given'}): asking for it back, which proves this server's key`);
    try {
        const res = await healAddress(pa.name, LOOPBACK_ORIGIN);
        if (res?.status === 'live') {
            const { changed: _changed, attest: _attest, ...answer } = res;
            const stored = persistAddressIfUnchanged({ ...pa, ...answer, name: pa.name, mode: 'tunnel', origin: LOOPBACK_ORIGIN }, 'stored', since);
            if (!stored) { addressChangedMeanwhile(pa); return; }
            await stored;
            say('info', `${pa.hostname || pa.name} is live again${res.tunnelToken ? ', on a fresh tunnel' : ''}`);
            return;
        }
        recordRegistrarAnswer({ name: pa.name, hostname: pa.hostname, ...res }, 'status');
        say('warn', `${pa.hostname || pa.name} stays paused: ${res?.why || res?.reason || res?.status || 'no answer'}; this server asks again in a few minutes`);
    } catch (e: any) {
        say('warn', `could not ask for ${pa.hostname || pa.name} back: ${e?.message || e}; this server asks again in a few minutes`);
    }
}

/**
 * The public-address agent's tick (every 5 min): if the registrar's status `st` is a pause of this server's own tunnel
 * name that its heal lifts, heal it. True when it was one (healed or not). Not two at once with the dead-tunnel heal.
 * `since`: the address's write count when the tick began (publicAddressGeneration); a heal answered after another write
 * is not stored.
 */
export async function healPausedAddress(st: any, since = publicAddressGeneration()): Promise<boolean> {
    const pa = savedTunnelAddress();
    if (!healable(st, pa) || getNodeRole() !== 'primary') return false;
    if (registrarBusy) return true;
    registrarBusy = true;
    try { await healPaused(pa, st, since); } finally { registrarBusy = false; }
    return true;
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
        const since = publicAddressGeneration();
        if (!pa?.name) return;
        // Only a name the registrar says is live and this key's: a claim of a released one would take it back.
        const st = await addressStatus(pa.name);
        if (st?.status !== 'live' || st.name !== pa.name) {
            say('info', `not moving ${pa.hostname || pa.name} to ${LOOPBACK_ORIGIN} yet: the address service answers "${st?.status ?? 'nothing'}"`);
            return;
        }
        if (await reclaimSaved(pa, `moving the tunnel's destination to ${LOOPBACK_ORIGIN}`, since)) {
            say('info', `${pa.hostname || pa.name} now leads to ${LOOPBACK_ORIGIN} inside this server`);
        }
    } catch (e: any) {
        say('warn', `could not move the tunnel's destination to ${LOOPBACK_ORIGIN}: ${e?.message || e}; tried again in 30 min`);
    } finally {
        registrarBusy = false;
    }
}

// ── The other names this key holds ──────────────────────────────────────────────────────────

const labelOf = (host: string): string => host.slice(0, -(REGISTRAR_ZONE.length + 1));

/** Is `host` still a name this community moved off? A claim or a release may have changed that while the registrar was asked. */
const stillOther = (host: string): boolean => registrarNames().some((e) => e.address === host && e.role === 'former');

const tokenIn = (answer: any): string | null =>
    (typeof answer?.tunnelToken === 'string' && answer.tunnelToken.trim() ? answer.tunnelToken.trim() : null);

/**
 * A heal of `host`, one of the other names: never a claim, which could take back a release. The registrar routes it again
 * only once this server proves its key. Its answer is written on the name, and a new token run by the sync that follows.
 */
async function healOtherName(host: string): Promise<void> {
    if (registrarBusy) return;
    registrarBusy = true;
    try {
        say('info', `${host}: asking the address service to bring it back, which proves this server's key`);
        const res = await healAddress(labelOf(host), LOOPBACK_ORIGIN);
        const { changed: _changed, attest: _attest, ...healed } = res ?? {};
        const answer = await withLiveToken(healed, labelOf(host));
        if (!stillOther(host) || typeof answer?.status !== 'string') return;
        recordRegistrarAnswer({ ...answer, name: labelOf(host), hostname: host }, 'status');
        const token = tokenIn(answer);
        if (token) otherTokens.set(host, token);
    } catch (e: any) {
        say('warn', `${host}: asking for it back failed: ${e?.message || e}; this server asks again in a few minutes`);
    } finally {
        registrarBusy = false;
    }
}

/**
 * Asks the registrar about `host`, one of the other names, and acts on it. `refused`: Cloudflare refuses its tunnel.
 *  - Live: a new token is run by the sync that follows; a refused tunnel on the same token is healed.
 *  - Paused by the sweep: healed, as the stored name is (healable).
 *  - Any other word about this name (the admin's pause, released, revoked, blocked): written on the name, which stops its
 *    tunnel. The record keeps the name; the admin's pause is asked about again, and the rest come back by a claim.
 *  - No word about it: `none` (a registrar that lost its data says that to every key), an answer about another name (a
 *    registrar that does not read `name`, or a key that holds this one no more), or `pending` (the registrar re-making it).
 *    What runs keeps running. A refused tunnel is stopped: nothing can bring it back until the registrar speaks of the
 *    name, and the next tick asks.
 * Throws when nothing answered.
 */
async function askAbout(host: string, refused = false): Promise<void> {
    const st = await addressStatus(labelOf(host));
    if (!stillOther(host)) return;
    if (registrarHostOf(st) !== host || typeof st?.status !== 'string' || st.status === 'pending') {
        if (!refused) return;
        say('warn', `${host}: Cloudflare refuses its tunnel, and the address service says nothing of it: stopping that tunnel`);
        otherTokens.delete(host);
        const t = tunnels.get(host);
        if (t) t.lastToken = null;
        return;
    }
    if (st.status === 'live') {
        recordRegistrarAnswer(st, 'status');
        const token = tokenIn(st);
        const same = !token || token === (otherTokens.get(host) ?? tunnels.get(host)?.lastToken);
        if (token) otherTokens.set(host, token);
        if (refused && same) await healOtherName(host);
        return;
    }
    if (healable(st, { name: labelOf(host) })) { await healOtherName(host); return; }
    recordRegistrarAnswer(st, 'status');
}

/** Cloudflare has refused this name's tunnel past the threshold: what the registrar says of it decides. */
async function healDeadOtherName(t: Tunnel): Promise<void> {
    t.lastHealAt = Date.now();
    try { await askAbout(t.host, true); }
    catch (e: any) { say('warn', `${t.host}: could not ask the address service about the refused tunnel: ${e?.message || e}`); }
    await syncTunnel();
}

/**
 * The public-address agent's tick, and a take-over's tunnel step: asks the registrar about each other name (nothing, on a
 * server with one name) and runs what it says. A name it does not answer about keeps what it runs. Never throws.
 */
export async function askAboutOtherNames(): Promise<void> {
    if (askingAboutOthers || !tunnelsMayRun()) return;
    askingAboutOthers = true;
    try {
        for (const host of otherHosts(ASKED_STATES)) {
            try { await askAbout(host); }
            catch (e: any) { say('warn', `${host}: could not ask the address service about it: ${e?.message || e}`); }
        }
        await syncTunnel();
    } finally {
        askingAboutOthers = false;
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

/** Tests only: what the connector wants and runs. All but `tunnels` is the stored name's. */
export function tunnelConnectorForTests(): {
    wantedToken: string | null; runningToken: string | null; pid: number | null; crashes: number; status: TunnelStatus;
    tunnels: { host: string; token: string | null; pid: number | null; crashes: number; port: number; state: TunnelState }[];
} {
    const t = mainTunnel();
    return {
        wantedToken: wantedToken(), runningToken: t?.running?.token ?? null, pid: t?.running?.pid ?? null, crashes: t?.crashes ?? 0, status: getTunnelStatus(),
        tunnels: [...tunnels.values()].map((x) => ({ host: x.host, token: x.running?.token ?? null, pid: x.running?.pid ?? null, crashes: x.crashes, port: x.metricsPort, state: x.status.state })),
    };
}

/** Tests only: stop any child and forget everything, as a fresh process. */
export async function resetTunnelConnectorForTests(): Promise<void> {
    await serial(async () => { for (const t of [...tunnels.values()]) await retire(t); });
    otherTokens.clear();
    recent.clear();
    registrarBusy = false;
    askingAboutOthers = false;
    lastOriginAttemptAt = 0;
    missingLogged = false;
    takeoverReleased = false;
    version = null;
    offSince = new Date().toISOString();
}

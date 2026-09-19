/**
 * Shared by test-takeover-by-code.ts and test-takeover-crash-resume.ts (not a suite itself).
 *
 * Each BeanPool node in those suites is its OWN PROCESS with its own data dir, booted in the order index.ts boots:
 * genesis, admin password, database, the take-over resume at boot (which may finish steps and run the audit),
 * libp2p (on port 0), the envelope service in the node's role, the take-over's after-boot steps; then the real
 * backup and take-over routes over HTTP with the real admin auth. A take-over's restart is the real
 * `process.exit(0)`, and the orchestrator starts the process again on the same data dir, as Docker would.
 *
 * The orchestrator talks to a node over HTTP like Settings does, and over stdin for what only a test does (set up
 * members, pull now, look inside). Replies are `@@ {json}` lines on stdout.
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';

// ── Orchestrator side ──────────────────────────────────────────────────────────────────────

export interface NodeProc {
    proc: ChildProcess;
    port: number;
    base: string;
    ready: any;
    /** Everything the process printed, stdout and stderr. */
    output: () => string;
    send: (cmd: string, args?: Record<string, unknown>) => Promise<any>;
    exited: Promise<number | null>;
    kill: (signal?: NodeJS.Signals) => Promise<void>;
}

let seq = 0;

/**
 * Start a node process on `dataDir`. Resolves when it prints `ready`, or rejects with its output when it exits
 * first (a crash injected at a boot-time step exits before ready).
 */
export function spawnNode(script: string, dataDir: string, env: Record<string, string | undefined>): Promise<NodeProc> {
    const proc = spawn(process.execPath, [...process.execArgv, script, '--child'], {
        env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, TAKEOVER_RESEAL_DEBOUNCE_MS: '40', ...env } as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    const waiting = new Map<number, (v: any) => void>();
    let readyResolve: (v: any) => void;
    const readyP = new Promise<any>((r) => { readyResolve = r; });
    const rl = readline.createInterface({ input: proc.stdout! });
    rl.on('line', (line) => {
        out += line + '\n';
        if (!line.startsWith('@@ ')) return;
        const msg = JSON.parse(line.slice(3));
        if (msg.ready) readyResolve(msg);
        else if (typeof msg.reply === 'number') waiting.get(msg.reply)?.(msg);
    });
    proc.stderr!.on('data', (d) => { out += d.toString(); });
    const exited = new Promise<number | null>((resolve) => proc.on('exit', (code, signal) => resolve(code ?? (signal ? -1 : null))));
    return new Promise((resolve, reject) => {
        exited.then((code) => reject(Object.assign(new Error(`node exited (${code}) before it was ready`), { output: out, code })));
        readyP.then((ready) => {
            const base = `http://127.0.0.1:${ready.port}`;
            resolve({
                proc, port: ready.port, base, ready, exited,
                output: () => out,
                send: (cmd, args = {}) => new Promise((res, rej) => {
                    const id = ++seq;
                    waiting.set(id, (m) => {
                        waiting.delete(id);
                        if (m.error) rej(new Error(`${cmd}: ${m.error}`));
                        else res(m.result);
                    });
                    proc.stdin!.write(JSON.stringify({ id, cmd, args }) + '\n');
                }),
                kill: async (signal = 'SIGKILL') => {
                    if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
                    await exited;
                },
            });
        });
    });
}

export async function post(base: string, route: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
    try {
        const res = await fetch(base + route, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body ?? {}),
        });
        const text = await res.text();
        let json: any = null;
        try { json = JSON.parse(text); } catch { json = text; }
        return { status: res.status, body: json };
    } catch (e: any) {
        return { status: 0, body: { networkError: e?.message || String(e) } };
    }
}

export function copyDir(from: string, to: string): void {
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true });
}

// ── Child side ─────────────────────────────────────────────────────────────────────────────

function reply(msg: Record<string, unknown>): void {
    process.stdout.write('@@ ' + JSON.stringify(msg) + '\n');
}

/** Boot as index.ts does, serve the routes, then answer commands. Never returns. */
export async function runNodeChild(commands: Record<string, (args: any) => Promise<unknown>> = {}): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR!;
    fs.mkdirSync(dataDir, { recursive: true });
    const Koa = (await import('koa')).default;
    const { ensureGenesis } = await import('./genesis.js');
    const { initAdminPassword } = await import('./config/local-config.js');
    const { initStateEngine, getNodeRole } = await import('./state-engine.js');
    const { resumeTakeoverAtBoot, finishTakeoverAfterBoot } = await import('./services/takeover.js');
    const { startP2P } = await import('./p2p.js');
    const { loadConnectors } = await import('./connector-manager.js');
    const { startTakeoverEnvelopeService } = await import('./services/takeover-envelope.js');
    const { createBackupRoutes } = await import('./routes/backup.js');
    const { createTakeoverEnvelopeRoutes } = await import('./routes/takeover-envelope.js');
    const { checkAdminAuth } = await import('./admin-auth.js');
    const { identityReadOnlyGuard, startIdentityEpochWatch } = await import('./services/identity-epoch.js');

    await ensureGenesis();
    initAdminPassword();
    initStateEngine();
    const boot = resumeTakeoverAtBoot();
    const node = await startP2P(0, 0);
    loadConnectors();
    await startTakeoverEnvelopeService({ standby: getNodeRole() === 'backup', checkIntervalMs: 3_600_000 });
    await finishTakeoverAfterBoot();
    // As index.ts does, but awaited so a suite can see the first answer, and only when the suite says where this
    // node's "public address" is: the suites' main servers have real-looking hostnames that must never be asked.
    const epochCheck = process.env.BEANPOOL_TEST_IDENTITY_EPOCH_URL ? await startIdentityEpochWatch() : null;

    const deps: any = {
        checkAdminAuth: async (ctx: any) => checkAdminAuth(ctx),
        rateLimit: () => true, clampLimit: (_v: unknown, d = 20) => d, clampOffset: () => 0,
        activeConnections: new Map(), calculateAnalytics: () => ({}), enforceReadAuth: false, broadcast: () => {},
    };
    const app = new Koa();
    app.use(async (ctx, next) => {
        if (ctx.method === 'POST' && (ctx.get('content-type') || '').includes('json')) {
            const chunks: Buffer[] = [];
            for await (const c of ctx.req) chunks.push(c as Buffer);
            try { (ctx as any).requestBody = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'); } catch { (ctx as any).requestBody = {}; }
        } else {
            (ctx as any).requestBody = {};
        }
        (ctx.request as any).body = (ctx as any).requestBody;
        await next();
    });
    // The split-brain guard, where https-server.ts has it: before the routes. And one write a member could make,
    // to see it refused or let through.
    app.use(identityReadOnlyGuard);
    app.use(async (ctx, next) => {
        if (ctx.method === 'POST' && ctx.path === '/api/test/member-write') {
            ctx.body = { written: true };
            return;
        }
        await next();
    });
    app.use(createBackupRoutes(deps).routes());
    app.use(createTakeoverEnvelopeRoutes(deps).routes());
    const server = http.createServer(app.callback());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));

    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', async (line) => {
        let id = 0;
        try {
            const msg = JSON.parse(line);
            id = msg.id;
            const fn = commands[msg.cmd];
            if (!fn) throw new Error(`no such command ${msg.cmd}`);
            reply({ reply: id, result: await fn(msg.args || {}) });
        } catch (e: any) {
            reply({ reply: id, error: e?.message || String(e) });
        }
    });
    rl.on('close', () => process.exit(0));

    reply({
        ready: true,
        port: (server.address() as AddressInfo).port,
        peerId: node.peerId.toString(),
        role: getNodeRole(),
        auditRan: boot.auditRan,
        resumed: boot.resumed,
        epochCheck,
    });
}

/** What a test looks at on a node after a take-over. Runs inside the node's process. */
export async function inspectNode(args: { ownerSeedHex?: string }): Promise<Record<string, unknown>> {
    const dataDir = process.env.BEANPOOL_DATA_DIR!;
    const { db } = await import('./db/db.js');
    const { getLocalConfig } = await import('./config/local-config.js');
    const { getNodeRole, getNodeConfig } = await import('./state-engine.js');
    const { getConnectors } = await import('./connector-manager.js');
    const { getPrivateKey } = await import('./p2p.js');
    const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
    const { getTakeoverProgress } = await import('./services/takeover.js');
    const { getTakeoverStatus } = await import('./services/takeover-envelope.js');
    const auth = await import('./admin-key-auth.js');
    const { ed25519 } = await import('@noble/curves/ed25519.js');

    let keySignIn: Record<string, unknown> = { tried: false };
    if (args.ownerSeedHex) {
        const seed = Buffer.from(args.ownerSeedHex, 'hex');
        const pub = Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
        const ch = auth.createAdminChallenge();
        const sig = Buffer.from(ed25519.sign(new TextEncoder().encode(ch.challenge), seed)).toString('hex');
        const solved = auth.verifyAndSolveChallenge({ challengeId: ch.challengeId, memberPubkey: pub, signature: sig });
        const consumed = solved.ok ? auth.consumeHandshakeToken(solved.handshakeToken!) : null;
        const sessionId = (consumed as any)?.sessionId ?? (consumed as any)?.session?.sessionId ?? null;
        const valid = sessionId ? auth.validateAdminSession(sessionId) : null;
        keySignIn = {
            tried: true, solved: solved.ok, role: solved.role ?? null, error: solved.error ?? null,
            session: !!valid?.valid, sessionRole: (valid as any)?.session?.role ?? null,
        };
    }
    const config = getLocalConfig();
    const status = await getTakeoverStatus();
    const tokenFile = path.join(dataDir, 'tunnel-token');
    return {
        role: getNodeRole(),
        peerId: peerIdFromPrivateKey(getPrivateKey()).toString(),
        roles: db.prepare('SELECT member_pubkey, role FROM node_roles ORDER BY member_pubkey').all(),
        connectors: getConnectors().map((c: any) => ({ address: c.address, trustLevel: c.trustLevel })),
        keySignIn,
        promotionAuditPending: !!config.promotionAuditPending,
        lastPromotionAudit: config.lastPromotionAudit ?? null,
        configNodeRole: config.nodeRole ?? null,
        backupPrimaryUrl: config.backupPrimaryUrl ?? null,
        backupReplicationToken: config.backupReplicationToken ? 'set' : null,
        publicAddress: (getNodeConfig() as any).publicAddress ?? null,
        tunnelTokenFile: fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf-8') : null,
        heldDirExists: fs.existsSync(path.join(dataDir, 'held-takeover-envelopes')),
        bundleFileExists: fs.existsSync(path.join(dataDir, 'takeover-bundle.json')),
        preTakeoverDirs: fs.readdirSync(dataDir).filter((n) => n.startsWith('pre-takeover-')),
        envelope: { state: status.state, envelopeId: status.envelopeId, owners: status.recipients.owners.map((o) => o.callsign), codes: status.recipients.codes.map((c) => c.codeId) },
        progress: getTakeoverProgress(),
    };
}

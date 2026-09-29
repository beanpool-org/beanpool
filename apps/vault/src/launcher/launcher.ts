import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { SwitchRequest } from '../api/updater.js';
import { resolveChain, sha256Hex } from '../shared/release.js';

/**
 * vault-launcher (key vault design §3, "starts the new API beside itself and hands over traffic"): the process systemd
 * starts for the API. It is part of the image and changes only with it, at a monthly restart. It runs one vault-api
 * bundle as its child, and on that child's request runs a newer one:
 *
 *   1. the request's release must be in the chain from the launcher's own pinned keys, and the bundle file's SHA-256
 *      the one that release names (the API checked both; this checks again, from its own copy of the keys);
 *   2. the bundle's self-test (`--self-test`) must pass, and report the same pinned keys and its own hash;
 *   3. the new API starts beside the old one and, once it listens, points the API socket at itself: new connections
 *      go to it from that moment;
 *   4. the old one is told to drain: it stops taking connections, finishes what it has, and exits.
 *
 * The keyholder is another service: it stays unlocked throughout. Any failure before step 3 leaves the old API
 * serving, and it tries again at its next hourly check. An API that dies is started again (after a pause that grows);
 * one that keeps dying soon after a switch gives way to the image's own bundle.
 *
 * Messages over the child's IPC channel: `{type: 'ready'}` and `{type: 'switch', id, request}` from a child;
 * `{type: 'switch-result', id, ok, reason?}` and `{type: 'drain'}` to it.
 */

export interface LauncherOptions {
    /** The Node binary and its flags for an API bundle. */
    node: string;
    nodeArgs: string[];
    /** The API bundle in the image: run at start, and the fallback. */
    imageBundle: string;
    /** What every API is started with (`--config <file>`). */
    apiArgs: string[];
    rootKeys: readonly string[];
    readyTimeoutMs?: number;
    selfTestTimeoutMs?: number;
    drainTimeoutMs?: number;
    log?: (line: string) => void;
    env?: NodeJS.ProcessEnv;
}

type ChildMessage = { type: 'ready' } | { type: 'switch'; id: number; request: SwitchRequest };

interface Running {
    child: ChildProcess;
    bundle: string;
    startedAt: number;
}

export interface SelfTestReport {
    ok: boolean;
    rootKeys?: string[];
    bundleSha256?: string;
    failed?: string[];
}

function parseReport(out: string): SelfTestReport | null {
    try {
        return JSON.parse(out.trim().split('\n').pop() ?? '') as SelfTestReport;
    } catch {
        return null;
    }
}

function sameKeys(a: readonly string[] | undefined, b: readonly string[]): boolean {
    return !!a && a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

export class Launcher {
    private current: Running | null = null;
    private switching = false;
    private stopping = false;
    private restartDelayMs = 1000;
    private recentFailures: number[] = [];
    private readonly log: (line: string) => void;

    constructor(private readonly opts: LauncherOptions) {
        this.log = opts.log ?? (line => console.log(`vault-launcher: ${line}`));
    }

    get currentPid(): number | null {
        return this.current?.child.pid ?? null;
    }

    get currentBundle(): string | null {
        return this.current?.bundle ?? null;
    }

    /** Starts the image's API and resolves once it listens. */
    async start(): Promise<void> {
        await this.run(this.opts.imageBundle);
    }

    private spawnApi(bundle: string): ChildProcess {
        const child = spawn(this.opts.node, [...this.opts.nodeArgs, bundle, ...this.opts.apiArgs], {
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            env: { ...(this.opts.env ?? process.env), BEANPOOL_VAULT_LAUNCHER: '1' },
        });
        child.on('message', (m: ChildMessage) => {
            if (m?.type === 'switch' && typeof m.id === 'number') void this.onSwitch(child, m.id, m.request);
        });
        child.on('error', () => undefined);
        return child;
    }

    private waitReady(child: ChildProcess): Promise<void> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => done(new Error('it did not say it was listening in time')), this.opts.readyTimeoutMs ?? 60_000);
            const onMessage = (m: ChildMessage) => {
                if (m?.type === 'ready') done();
            };
            const onExit = (code: number | null) => done(new Error(`it exited (${code}) before it was listening`));
            const done = (e?: Error) => {
                clearTimeout(timer);
                child.off('message', onMessage);
                child.off('exit', onExit);
                if (e) reject(e);
                else resolve();
            };
            child.on('message', onMessage);
            child.once('exit', onExit);
        });
    }

    /** Starts `bundle` as the API in service; restarts it (or the image's) when it dies. */
    private async run(bundle: string): Promise<void> {
        const child = this.spawnApi(bundle);
        this.log(`started the API (${bundle}) as pid ${child.pid}`);
        this.current = { child, bundle, startedAt: Date.now() };
        this.watch(this.current);
        await this.waitReady(child);
        this.log(`the API (pid ${child.pid}) is listening`);
    }

    private watch(r: Running): void {
        r.child.once('exit', (code, signal) => {
            if (this.stopping || this.current !== r) return;
            this.log(`the API (pid ${r.child.pid}) exited (${code ?? signal}); starting it again in ${this.restartDelayMs} ms`);
            const now = Date.now();
            this.recentFailures = [...this.recentFailures.filter(t => t > now - 10 * 60_000), now];
            const bundle = this.recentFailures.length >= 3 && r.bundle !== this.opts.imageBundle ? this.opts.imageBundle : r.bundle;
            if (bundle !== r.bundle) this.log('it keeps failing: back to the image\'s own API');
            const delay = this.restartDelayMs;
            this.restartDelayMs = Math.min(this.restartDelayMs * 2, 60_000);
            setTimeout(() => {
                if (this.stopping || this.current !== r) return;
                this.run(bundle).then(() => { this.restartDelayMs = 1000; }, e => this.log(`the API did not start: ${(e as Error).message}`));
            }, delay).unref();
        });
    }

    /** Step 1: the release from the launcher's own keys, and the bundle file it names. */
    verify(req: SwitchRequest): { ok: true } | { ok: false; reason: string } {
        if (!req || typeof req.bundlePath !== 'string' || !req.release || !Array.isArray(req.chain)) return { ok: false, reason: 'not a switch request' };
        const chain = resolveChain(req.chain, this.opts.rootKeys);
        const hash = sha256Hex(String(req.release.manifestText));
        const release = chain.releases.find(r => r.hash === hash);
        if (!release) return { ok: false, reason: 'that release is not in the chain from the pinned keys' };
        let bytes: Buffer;
        try {
            bytes = readFileSync(req.bundlePath);
        } catch {
            return { ok: false, reason: 'the bundle file can\'t be read' };
        }
        if (sha256Hex(bytes) !== release.manifest.apiBundleHash) return { ok: false, reason: 'the bundle is not the one its release names' };
        return { ok: true };
    }

    /** Step 2: `node <bundle> --self-test` passes and reports the same pinned keys and its own hash. */
    selfTest(bundle: string): Promise<{ ok: true } | { ok: false; reason: string }> {
        return new Promise(resolve => {
            const child = spawn(this.opts.node, [...this.opts.nodeArgs, bundle, '--self-test'], { stdio: ['ignore', 'pipe', 'pipe'], env: this.opts.env ?? process.env });
            let out = '';
            child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
            child.stderr?.on('data', () => undefined);
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                resolve({ ok: false, reason: 'the self-test did not finish in time' });
            }, this.opts.selfTestTimeoutMs ?? 30_000);
            child.once('exit', code => {
                clearTimeout(timer);
                const report = parseReport(out);
                if (code !== 0 || !report?.ok) return resolve({ ok: false, reason: `the self-test failed${report?.failed?.length ? `: ${report.failed.join(', ')}` : ''}` });
                if (!sameKeys(report.rootKeys, this.opts.rootKeys)) return resolve({ ok: false, reason: 'the new API is built with other custodian keys' });
                let own: string;
                try {
                    own = sha256Hex(readFileSync(bundle));
                } catch {
                    return resolve({ ok: false, reason: 'the bundle file can\'t be read' });
                }
                if (report.bundleSha256 !== own) return resolve({ ok: false, reason: 'the self-test ran from another file' });
                resolve({ ok: true });
            });
        });
    }

    private async onSwitch(from: ChildProcess, id: number, req: SwitchRequest): Promise<void> {
        const reply = (ok: boolean, reason?: string) => {
            if (from.connected) from.send({ type: 'switch-result', id, ok, ...(reason ? { reason } : {}) });
        };
        if (!this.current || this.current.child !== from) return reply(false, 'only the API in service may ask');
        if (this.switching) return reply(false, 'a switch is already under way');
        this.switching = true;
        try {
            const checked = this.verify(req);
            if (!checked.ok) return reply(false, checked.reason);
            const tested = await this.selfTest(req.bundlePath);
            if (!tested.ok) return reply(false, tested.reason);
            const old = this.current;
            const next = this.spawnApi(req.bundlePath);
            this.log(`switching: started ${req.bundlePath} as pid ${next.pid} beside pid ${old.child.pid}`);
            try {
                await this.waitReady(next);
            } catch (e) {
                if (next.exitCode === null && next.signalCode === null) next.kill('SIGKILL');
                this.log(`the new API did not take over: ${(e as Error).message}`);
                return reply(false, `the new API did not start: ${(e as Error).message}`);
            }
            this.current = { child: next, bundle: req.bundlePath, startedAt: Date.now() };
            this.watch(this.current);
            reply(true);
            this.log(`pid ${next.pid} is serving; pid ${old.child.pid} drains and exits`);
            if (old.child.connected) old.child.send({ type: 'drain' });
            const kill = setTimeout(() => {
                if (old.child.exitCode === null && old.child.signalCode === null) old.child.kill('SIGKILL');
            }, this.opts.drainTimeoutMs ?? 60_000);
            kill.unref();
            old.child.once('exit', () => clearTimeout(kill));
        } finally {
            this.switching = false;
        }
    }

    /** SIGTERM to the API in service (and any still draining), and wait for it. */
    async stop(): Promise<void> {
        this.stopping = true;
        const child = this.current?.child;
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        await new Promise<void>(resolve => {
            child.once('exit', () => resolve());
            child.kill('SIGTERM');
        });
    }
}

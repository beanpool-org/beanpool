/**
 * The fake cloudflared (__fixtures__/fake-cloudflared.mjs), wired into the tunnel connector for a test process. Not a suite
 * itself: test-tunnel-connector.ts, test-public-address.ts and takeover-test-harness.ts (every node process it starts) use
 * it, so no test ever starts a real cloudflared, whatever this machine has installed.
 *
 * FAKE_CLOUDFLARED_START_DELAY_MS (in the suite's environment): every fake waits that long before it records itself, as
 * one does on a loaded CI runner, to show a suite waits for its child rather than for a fixed time.
 * FAKE_CLOUDFLARED_SAY_POLL_MS: every fake looks for the lines a suite asked it to print that often (default 25), as a loaded
 * runner's late reader does, to show a suite waits for the line it said rather than for a fixed time.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTunnelConnectorForTests } from './services/tunnel-connector.js';

export const FAKE_CLOUDFLARED = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'fake-cloudflared.mjs');

/** `at`: when it recorded itself; `started`: when its process began (a loaded machine's start-up lies between). */
export interface FakeRun { pid: number; argv: string[]; env: Record<string, string>; at: number; started: number }

export interface FakeTunnel {
    dir: string;
    port: number;
    runs: () => FakeRun[];
    exits: () => { pid: number; signal: string }[];
    lastRun: () => FakeRun | null;
    /** What /ready answers from now on. */
    ready: (status: 200 | 503, readyConnections?: number) => void;
    /** Lines the running fake prints to stderr, as cloudflared's JSON log. */
    say: (...entries: unknown[]) => void;
    /** While on, every start exits at once with code 1. */
    crash: (on: boolean) => void;
    /** `ready`, `say` and `crash` for the children on `token` alone: the others go on as they were. */
    readyFor: (token: string, status: 200 | 503, readyConnections?: number) => void;
    sayTo: (token: string, ...entries: unknown[]) => void;
    crashFor: (token: string, on: boolean) => void;
    /** Until `n` runs are recorded (or `ms` pass): the runs. */
    waitForRuns: (n: number, ms?: number) => Promise<FakeRun[]>;
}

const lines = (file: string): any[] => {
    try { return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

/** The fake's per-token files (fake-cloudflared.mjs tokenFileId: keep the same). */
const tokenFileId = (token: string) => token.replace(/[^A-Za-z0-9_-]/g, '_');

let saidCount = 0;
/**
 * `entries` as one file the fake takes whole: written under a name it does not look for, then renamed into place
 * (fake-cloudflared.mjs SAID). An append to the file it takes by renaming could land after the fake had renamed the empty
 * file the append had just created, and that line went with the renamed file: said, never printed.
 */
export function saidFile(dir: string, id: string | null, entries: unknown[]): void {
    const seq = `${String(Date.now()).padStart(14, '0')}-${String(++saidCount).padStart(6, '0')}`;
    const tmp = path.join(dir, `.say-${process.pid}-${saidCount}.tmp`);
    fs.writeFileSync(tmp, entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e)) + '\n').join(''));
    fs.renameSync(tmp, path.join(dir, id === null ? `say.${seq}.jsonl` : `say.${id}.${seq}.jsonl`));
}

/**
 * A free port for the fake's metrics, from 20000-32767: below the ports any OS hands out on its own (Linux 32768-60999,
 * macOS 49152-65535), so between this check and the fake's own listen no other process is given it by a listen(0) or an
 * outgoing connection. One from listen(0) was, once: CI run 36816140050, the fake's start failed with EADDRINUSE and
 * test-public-address read the connector's pid while it waited a second to start the fake again (pid null).
 */
async function freePort(): Promise<number> {
    for (;;) {
        const port = 20_000 + crypto.randomInt(12_768);
        if (port === 20241) continue; // cloudflared's own default, the connector's outside the suites
        const s = net.createServer();
        const free = await new Promise<boolean>((r) => {
            s.once('error', () => r(false));
            s.listen(port, '127.0.0.1', () => r(true));
        });
        if (free) {
            await new Promise<void>((r) => s.close(() => r()));
            return port;
        }
    }
}

/** A fresh control folder at `dir`, a free metrics port, and the connector pointed at the fake. `timings`: the connector's. */
export async function useFakeCloudflared(dir: string, timings: Parameters<typeof setTunnelConnectorForTests>[0] = {}): Promise<FakeTunnel> {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const startDelayMs = Number(process.env.FAKE_CLOUDFLARED_START_DELAY_MS) || 0;
    if (startDelayMs > 0) fs.writeFileSync(path.join(dir, 'start-delay-ms'), String(startDelayMs));
    const sayPollMs = Number(process.env.FAKE_CLOUDFLARED_SAY_POLL_MS) || 0;
    if (sayPollMs > 0) fs.writeFileSync(path.join(dir, 'say-poll-ms'), String(sayPollMs));
    const port = await freePort();
    setTunnelConnectorForTests({ command: process.execPath, prefixArgs: [FAKE_CLOUDFLARED, dir], metricsPort: port, ...timings });
    const runs = () => lines(path.join(dir, 'runs.jsonl')) as FakeRun[];
    return {
        dir, port, runs,
        exits: () => lines(path.join(dir, 'exits.jsonl')),
        lastRun: () => runs().at(-1) ?? null,
        ready: (status, readyConnections = status === 200 ? 4 : 0) =>
            fs.writeFileSync(path.join(dir, 'ready.json'), JSON.stringify({ status, readyConnections })),
        say: (...entries) => saidFile(dir, null, entries),
        crash: (on) => (on ? fs.writeFileSync(path.join(dir, 'crash'), '1') : fs.rmSync(path.join(dir, 'crash'), { force: true })),
        readyFor: (token, status, readyConnections = status === 200 ? 4 : 0) =>
            fs.writeFileSync(path.join(dir, `ready.${tokenFileId(token)}.json`), JSON.stringify({ status, readyConnections })),
        sayTo: (token, ...entries) => saidFile(dir, tokenFileId(token), entries),
        crashFor: (token, on) => {
            const f = path.join(dir, `crash.${tokenFileId(token)}`);
            if (on) fs.writeFileSync(f, '1'); else fs.rmSync(f, { force: true });
        },
        waitForRuns: async (n, ms = 5_000) => {
            const until = Date.now() + ms;
            while (runs().length < n && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
            return runs();
        },
    };
}

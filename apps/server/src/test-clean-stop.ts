/**
 * Test Suite: a normal stop is clean; a kill is still reported.
 *
 * WHY THIS EXISTS. Every deploy showed owners "The node restarted after an unclean shutdown" (admin queue + Home), measured on
 * mullum and test, 2026-10-04: deploy.sh removed the node with `docker rm -f`, which is SIGKILL, so the node never saw a stop
 * signal (scripts/test-deploy-health.sh checks deploy.sh now stops it first). This suite is the node's half: the REAL entry
 * point (index.ts) runs as a child process, as `node dist/index.js` runs in the container, and is stopped as Docker stops it.
 *
 *   1. SIGTERM: the node exits 0 within a few seconds, the database is closed (its WAL folded in and gone), and the sentinel
 *      says running:false. On main the sentinel was marked but the database was never closed: state.db-wal stayed behind.
 *   2. The next start reports no unclean shutdown.
 *   3. SIGKILL (a crash, power loss, Docker's kill after the grace period): the next start STILL reports it, with the
 *      integrity check's reassurance. A clean stop must never hide a real unclean one.
 *   4. SIGINT (Ctrl-C) is as clean as SIGTERM.
 *
 * Run (from apps/server): mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-clean-stop" node ../../scripts/run-server-suites.mjs
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getShutdownSentinelPath, getShutdownReportPath } from './engine/shutdown-recovery.js';

const SCRIPT = fileURLToPath(import.meta.url);
/** The real entry point beside this file, run the way this suite is run (src/index.ts under the loader, or dist/index.js). */
const ENTRY = SCRIPT.replace(/test-clean-stop\.(m?[tj]s)$/, 'index.$1');
const READY_LINE = 'BeanPool Node is live';
/** Docker waits 10 s by default (20 s with docker-compose.yml's stop_grace_period) before it kills. */
const STOP_BUDGET_MS = 5_000;

let passed = 0;
let run = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const port = (s.address() as net.AddressInfo).port;
            s.close(() => resolve(port));
        });
    });
}

function canListen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.once('error', () => resolve(false));
        s.listen(port, '0.0.0.0', () => s.close(() => resolve(true)));
    });
}

/** index.ts listens on PORT_HTTP, PORT_HTTPS, PORT_P2P and PORT_P2P + 1: four free ports, none fixed. */
async function freePorts(): Promise<Record<string, string>> {
    const http = await freePort();
    const https = await freePort();
    for (let tries = 0; tries < 50; tries++) {
        const p2p = await freePort();
        if (p2p < 65_000 && ![http, https].includes(p2p + 1) && await canListen(p2p + 1)) {
            return { PORT_HTTP: String(http), PORT_HTTPS: String(https), PORT_P2P: String(p2p) };
        }
    }
    throw new Error('no free pair of ports for libp2p');
}

interface Node { child: ChildProcess; output: () => string; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }

async function startNode(dataDir: string): Promise<Node> {
    const child = spawn(process.execPath, [...process.execArgv, ENTRY], {
        env: {
            ...process.env,
            ...(await freePorts()),
            BEANPOOL_DATA_DIR: dataDir,
            ADMIN_PASSWORD: 'Clean-Stop-Suite-1!',
            DISABLE_UPDATE_CHECK: 'true',
            // Nothing leaves this machine: the directory push (first at 30 s) goes to a port nothing listens on.
            DIRECTORY_REGISTRY_URL: 'http://127.0.0.1:9/',
            CF_API_TOKEN: '', CF_ZONE_ID: '', CF_RECORD_NAME: '', PUBLIC_ADDRESS_AUTO: '', PUBLIC_ADDRESS_NAME: '',
        } as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout!.on('data', (d) => { out += d.toString(); });
    child.stderr!.on('data', (d) => { out += d.toString(); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on('exit', (code, signal) => resolve({ code, signal }));
    });
    const startedAt = Date.now();
    while (!out.includes(READY_LINE)) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`the node exited before it was ready\n${out.slice(-3000)}`);
        if (Date.now() - startedAt > 90_000) {
            child.kill('SIGKILL');
            throw new Error(`the node was not ready in 90 s\n${out.slice(-3000)}`);
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    return { child, output: () => out, exited };
}

/** Send `signal` and wait for the exit; a node still running after 30 s is killed so the suite never hangs. */
async function stopNode(node: Node, signal: NodeJS.Signals): Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }> {
    const sentAt = Date.now();
    node.child.kill(signal);
    const guard = setTimeout(() => node.child.kill('SIGKILL'), 30_000);
    const result = await node.exited;
    clearTimeout(guard);
    return { ...result, ms: Date.now() - sentAt };
}

function readJson(file: string): any {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function walBytes(dataDir: string): number {
    const wal = path.join(dataDir, 'state.db-wal');
    return fs.existsSync(wal) ? fs.statSync(wal).size : 0;
}

async function main(): Promise<void> {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || '.', 'clean-stop-'));
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const sentinelPath = getShutdownSentinelPath(dataDir);
    const reportPath = getShutdownReportPath(dataDir);
    const nodes: Node[] = [];
    try {
        console.log('\n— 1. SIGTERM, as docker stop and docker compose up send it, is a clean stop —');
        const first = await startNode(dataDir);
        nodes.push(first);
        assert(readJson(sentinelPath)?.running === true, 'while the node runs, the sentinel says running');
        const term = await stopNode(first, 'SIGTERM');
        assert(term.code === 0 && term.signal === null, `the node exits 0 on SIGTERM (code ${term.code}, signal ${term.signal})`);
        assert(term.ms < STOP_BUDGET_MS, `within ${STOP_BUDGET_MS / 1000} s, well inside Docker's 10 s (took ${term.ms} ms)`);
        const afterTerm = readJson(sentinelPath);
        assert(afterTerm?.running === false && typeof afterTerm?.stoppedAt === 'string', 'the sentinel says running:false, with the time it stopped');
        assert(walBytes(dataDir) === 0,
            `the database was closed before the stop was marked clean: no WAL left behind (${walBytes(dataDir)} bytes)`);
        assert(first.output().includes('Stopped cleanly'), 'the log says the stop was clean');

        console.log('\n— 2. the next start after a clean stop reports nothing —');
        const second = await startNode(dataDir);
        nodes.push(second);
        assert(!second.output().includes('Recovered from power loss'), 'the boot log has no power-loss line');
        assert(!fs.existsSync(reportPath) || readJson(reportPath)?.uncleanShutdown !== true,
            'and no unclean-shutdown report is written, so owners see no "unclean shutdown" card');

        console.log('\n— 3. SIGKILL is still an unclean stop, and the next start says so —');
        const kill = await stopNode(second, 'SIGKILL');
        assert(kill.signal === 'SIGKILL', 'the node was killed');
        assert(readJson(sentinelPath)?.running === true, 'a kill leaves the sentinel saying running');
        const third = await startNode(dataDir);
        nodes.push(third);
        const report = readJson(reportPath);
        assert(report?.uncleanShutdown === true && report?.ok === true,
            'the next start reports the unclean shutdown, with the database checked and verified');
        assert(third.output().includes('Recovered from power loss'), 'and its boot log says so');

        console.log('\n— 4. SIGINT (Ctrl-C) is as clean as SIGTERM —');
        const int = await stopNode(third, 'SIGINT');
        assert(int.code === 0, `the node exits 0 on SIGINT (code ${int.code}, signal ${int.signal})`);
        assert(readJson(sentinelPath)?.running === false, 'the sentinel says running:false');
        assert(walBytes(dataDir) === 0, 'and the database was closed');
        assert(readJson(reportPath)?.uncleanShutdown === true,
            'the earlier kill\'s report stays until an owner acknowledges it: a clean stop never clears a real one');
    } finally {
        for (const n of nodes) {
            if (n.child.exitCode === null && n.child.signalCode === null) n.child.kill('SIGKILL');
        }
        fs.rmSync(root, { recursive: true, force: true });
    }

    console.log(`\n${passed}/${run} passed`);
    console.log('⭐️ Clean stop PASSED.\n');
}

main().then(() => process.exit(0), (err) => {
    console.error('Test failed:', err);
    process.exit(1);
});

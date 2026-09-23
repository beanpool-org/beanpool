/**
 * Test Suite: a stray rejected promise no longer restarts the node; a true crash still does.
 *
 * Until now the server installed no process-level handler, so any error nothing else caught ended the
 * process, Docker restarted the container, and every connected member was dropped for about a minute.
 * One async call that failed cost the whole community a minute offline. The policy (2026-09-24) is to
 * log rejections and restart only on true exceptions, and to leave a record in the data dir either way.
 *
 * Verifies, in real child processes rather than by calling the handler directly — the thing under test is
 * what NODE does with the process, which cannot be observed from inside a single one:
 *   1. an unhandled `Promise.reject(new Error(...))` leaves the child alive, exiting 0, with one line in
 *      <dataDir>/unhandled-rejections.log and a count of 1;
 *   2. `Promise.reject(undefined)`, a bare string and a plain object do not make the handler itself throw;
 *   3. a burst of 50 identical rejections writes ONE full entry plus a count, not 50 entries;
 *   4. a synchronous `throw` still kills the child (non-zero exit) AND leaves a diagnostic report in the
 *      data dir — wherever --report-directory points, and only one report when Node writes one itself.
 *   5. the count, last time and last message reach the admin diagnostics response, a health flag appears,
 *      and the message carries no secrets.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-process-handlers.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installProcessHandlers, getUnhandledRejectionSummary, getUnhandledRejectionLogPath } from './process-handlers.js';

const SCRIPT = fileURLToPath(import.meta.url);
const CHILD_FLAG = '--child';
/** A 64-char hex string is exactly what sanitizeMessage redacts, so it stands in for a key in an error. */
const SECRET_HEX = 'deadbeef'.repeat(8);

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

// ============================================================================
// CHILD — runs one scenario in its own process, then reports and exits.
// ============================================================================

/** Long enough for the rejection to be reported as unhandled and for the node to prove it is still there. */
const SETTLE_MS = 250;

function reportAndExit(): void {
    setTimeout(() => {
        console.log(`@@ ${JSON.stringify({ alive: true, ...getUnhandledRejectionSummary() })}`);
        process.exit(0);
    }, SETTLE_MS);
}

function runChild(mode: string): void {
    installProcessHandlers();
    switch (mode) {
        case 'single':
            void Promise.reject(new Error('a stray rejected promise'));
            reportAndExit();
            break;
        case 'weird':
            // Anything can be rejected with. On each of these, a handler that reads `.message` or `.stack`
            // without care throws from inside itself — which is the failure this whole file exists to stop.
            void Promise.reject(undefined);
            void Promise.reject('a bare string reason');
            void Promise.reject({ plain: 'object' });
            reportAndExit();
            break;
        case 'burst':
            // Same message, same line, so the same signature 50 times over — a loop that rejects on every
            // tick is the shape that would otherwise fill the disk.
            for (let i = 0; i < 50; i++) void Promise.reject(new Error('the same stray rejection'));
            reportAndExit();
            break;
        case 'boom':
            // Synchronous and uncaught: the process must still die. `uncaughtExceptionMonitor` only watches.
            setImmediate(() => { throw new Error('a true uncaught exception'); });
            break;
        default:
            console.error(`unknown child mode: ${mode}`);
            process.exit(2);
    }
}

// ============================================================================
// PARENT
// ============================================================================

interface ChildResult { code: number | null; stdout: string; stderr: string; dataDir: string; }

/**
 * Re-spawn this very file with `--child <mode>`. `process.execArgv` carries whatever loader is running the
 * TypeScript, so the child runs the same way the suite does (the takeover suites spawn nodes the same way).
 */
function spawnChild(mode: string, dataDir: string, extraEnv: Record<string, string> = {}): Promise<ChildResult> {
    fs.mkdirSync(dataDir, { recursive: true });
    const child = spawn(process.execPath, [...process.execArgv, SCRIPT, CHILD_FLAG, mode], {
        env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, ...extraEnv } as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    return new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, 30_000);
        child.on('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({ code: code ?? (signal ? -1 : null), stdout, stderr, dataDir });
        });
    });
}

function summaryFrom(result: ChildResult): { alive?: boolean; count?: number; lastAt?: string | null; lastMessage?: string | null } {
    const line = result.stdout.split('\n').find((l) => l.startsWith('@@ '));
    if (!line) return {};
    try { return JSON.parse(line.slice(3)); } catch { return {}; }
}

function logEntries(dataDir: string): Record<string, any>[] {
    const file = getUnhandledRejectionLogPath(dataDir);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function logSize(dataDir: string): number {
    const file = getUnhandledRejectionLogPath(dataDir);
    return fs.existsSync(file) ? fs.statSync(file).size : 0;
}

function reportFiles(dataDir: string): string[] {
    return fs.readdirSync(dataDir).filter((f) => f.startsWith('report') && f.endsWith('.json'));
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address() as net.AddressInfo;
            s.close(() => resolve(port));
        });
    });
}

async function childProcessTests(root: string): Promise<void> {
    console.log('\n— 1. one stray rejection: the node keeps serving —');
    const single = await spawnChild('single', path.join(root, 'single'));
    assert(single.code === 0, `the child is still alive after an unhandled rejection and exits cleanly (code ${single.code})`);
    const singleSummary = summaryFrom(single);
    assert(singleSummary.alive === true, 'the child ran work AFTER the rejection, so the process really did survive');
    assert(singleSummary.count === 1, `the count reads 1 (got ${singleSummary.count})`);
    assert(typeof singleSummary.lastAt === 'string' && !Number.isNaN(Date.parse(singleSummary.lastAt!)), 'the last rejection time is a real timestamp');
    assert(singleSummary.lastMessage === 'a stray rejected promise', `the last message is the error text (got ${JSON.stringify(singleSummary.lastMessage)})`);
    const singleEntries = logEntries(single.dataDir);
    assert(singleEntries.length === 1, `one line was written to unhandled-rejections.log (got ${singleEntries.length})`);
    assert(singleEntries[0]?.msg === 'a stray rejected promise', 'the line carries the message');
    assert(Array.isArray(singleEntries[0]?.frames) && singleEntries[0].frames.length > 0, 'the line carries stack frames');
    assert(typeof singleEntries[0]?.sig === 'string' && singleEntries[0].sig.length > 0, 'the line carries a signature');
    assert(single.stderr.includes('unhandledRejection'), 'and it was logged at error level on the way past');

    console.log('\n— 2. a reason that is not an Error does not break the handler —');
    const weird = await spawnChild('weird', path.join(root, 'weird'));
    assert(weird.code === 0, `undefined, a bare string and a plain object all leave the child alive (code ${weird.code})`);
    const weirdSummary = summaryFrom(weird);
    assert(weirdSummary.count === 3, `all three were recorded (got ${weirdSummary.count})`);
    const weirdEntries = logEntries(weird.dataDir);
    assert(weirdEntries.length === 3, `three lines were written (got ${weirdEntries.length})`);
    assert(weirdEntries.every((e) => typeof e.msg === 'string' && e.msg.length > 0), 'every line has a usable message, including the one rejected with undefined');
    assert(weirdEntries.some((e) => e.msg === 'a bare string reason'), 'a string reason is kept as the message');
    assert(!weird.stderr.includes('TypeError'), 'the handler itself never threw');

    console.log('\n— 3. a rejecting loop cannot fill the disk —');
    const burst = await spawnChild('burst', path.join(root, 'burst'));
    assert(burst.code === 0, `a burst of 50 identical rejections leaves the child alive (code ${burst.code})`);
    const burstSummary = summaryFrom(burst);
    assert(burstSummary.count === 50, `all 50 are counted (got ${burstSummary.count})`);
    const burstEntries = logEntries(burst.dataDir);
    const fullEntries = burstEntries.filter((e) => Array.isArray(e.frames));
    assert(fullEntries.length === 1, `exactly one FULL entry was written, not 50 (got ${fullEntries.length})`);
    const repeated = burstEntries.reduce((n, e) => n + (typeof e.repeated === 'number' ? e.repeated : 0), 0);
    assert(repeated === 49, `the 49 suppressed repeats are still counted in the file (got ${repeated})`);
    assert(burstEntries.length <= 3, `the file holds a handful of lines, not one per rejection (got ${burstEntries.length})`);
    const singleSize = logSize(single.dataDir);
    assert(logSize(burst.dataDir) < singleSize * 3, `50x the rejections is nowhere near 50x the file (${logSize(burst.dataDir)}B vs ${singleSize}B for one)`);
    assert(burst.stderr.split('unhandledRejection').length - 1 === 1, 'and the console was not flooded either — Docker logs share the same disk');

    console.log('\n— 4. a true uncaught exception still crashes, and leaves a report —');
    const boom = await spawnChild('boom', path.join(root, 'boom'));
    assert(boom.code !== 0 && boom.code !== null, `the child exits non-zero, so Docker restarts the node as before (code ${boom.code})`);
    assert(boom.stderr.includes('a true uncaught exception'), 'the exception was logged on the way out');
    const boomReports = reportFiles(boom.dataDir);
    assert(boomReports.length === 1, `a diagnostic report was written to the data dir (got ${JSON.stringify(boomReports)})`);
    assert(boomReports[0]?.startsWith('report-uncaught-'), 'named so the owner can tell a crash report from a freeze report');
    assert(logEntries(boom.dataDir).length === 0, 'and nothing was added to the rejection log: an exception is not a rejection');

    console.log('\n— 4b. the report lands in the data dir even when --report-directory points elsewhere —');
    // Nodes run with --report-directory. Node joins a report filename onto that directory, and joins it
    // naively, so an absolute path is silently unopenable: the report is lost and only a line in Docker's
    // log says so. This case fails if the handler ever goes back to passing an absolute path.
    const elsewhere = path.join(root, 'report-directory-elsewhere');
    const ownDir = path.join(root, 'boom-own-dir');
    fs.mkdirSync(elsewhere, { recursive: true });
    const redirected = await spawnChild('boom', ownDir, {
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --report-directory=${elsewhere}`.trim(),
    });
    assert(redirected.code !== 0, `the child still crashes (code ${redirected.code})`);
    const redirectedReports = reportFiles(ownDir);
    assert(redirectedReports.length === 1 && redirectedReports[0].startsWith('report-uncaught-'),
        `the report is in the data dir, not wherever --report-directory points (got ${JSON.stringify(redirectedReports)})`);
    assert(fs.readdirSync(elsewhere).length === 0, 'and nothing was written to the flag’s directory instead');
    assert(!redirected.stderr.includes('Failed to open Node.js report file'), 'Node did not refuse to open the path it was given');

    console.log('\n— 4c. on a node where Node writes the report itself, only one is written —');
    const boomDir = path.join(root, 'boom-node-report');
    fs.mkdirSync(boomDir, { recursive: true });
    const nodeReport = await spawnChild('boom', boomDir, {
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --report-uncaught-exception --report-directory=${boomDir}`.trim(),
    });
    assert(nodeReport.code !== 0, `the child still crashes (code ${nodeReport.code})`);
    const nodeReports = reportFiles(boomDir);
    assert(nodeReports.length === 1, `exactly one report, not two — a crash loop must not cost a small disk double (got ${JSON.stringify(nodeReports)})`);
    assert(!nodeReports.some((f) => f.startsWith('report-uncaught-')), 'and the one written is Node’s own, since it lands in the data dir anyway');
}

async function diagnosticsAndHealthTests(): Promise<void> {
    console.log('\n— 5. owners can see it: diagnostics and a health flag —');
    const { initTls } = await import('./services/tls.js');
    const { initStateEngine, getCommunityHealth } = await import('./state-engine.js');
    const { startHttpServer } = await import('./http-server.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { updateLocalConfig, updateGatewayConfig, hashPassword, DEFAULT_GATEWAY_CONFIG } = await import('./config/local-config.js');
    const { setTrustConfigForTests } = await import('./client-ip.js');

    await initTls();
    initStateEngine();
    setTrustConfigForTests(undefined);
    const PW = 'Stray-Error-Test-Pw-1!';
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt, breakGlassMode: false, totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [] } as any);
    updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 600 } });

    const httpPort = await freePort();
    const httpsPort = await freePort();
    await startHttpServer(httpPort);
    await startHttpsServer(httpsPort);
    const BASE = `http://127.0.0.1:${httpPort}`;

    // Only now, so that anything the boot itself rejected is already counted and the delta below is exact.
    installProcessHandlers();
    const before = getUnhandledRejectionSummary().count;
    void Promise.reject(new Error(`a background task failed with key ${SECRET_HEX}`));
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    const summary = getUnhandledRejectionSummary();
    assert(summary.count - before === 1, `the in-process count moved by exactly one (${before} → ${summary.count})`);
    assert(!summary.lastMessage?.includes(SECRET_HEX), 'the stored message does not carry the key that was in the error text');
    assert(summary.lastMessage?.includes('[REDACTED_HEX_KEY_64]') === true, 'it was redacted, not dropped, so the shape of the failure is still readable');

    const res = await fetch(`${BASE}/api/local/admin/diagnostics`, { headers: { 'x-admin-password': PW } });
    const body = await res.json() as any;
    assert(res.status === 200, `admin diagnostics answers 200 (got ${res.status})`);
    assert(body?.unhandledRejections?.count === summary.count, `diagnostics reports the count (got ${body?.unhandledRejections?.count})`);
    assert(typeof body?.unhandledRejections?.lastAt === 'string', 'diagnostics reports when the last one happened');
    assert(body?.unhandledRejections?.lastMessage?.includes('background task failed') === true, 'diagnostics reports the last message');
    // `?? null` so that a MISSING field fails this assertion rather than throwing out of the suite and
    // taking every assertion after it with it — a failure must not hide its neighbours.
    assert(!JSON.stringify(body.unhandledRejections ?? null).includes(SECRET_HEX), 'and the response carries no secret');

    const health = getCommunityHealth();
    const flag = health.flags.find((f) => f.type === 'unhandled_rejections');
    assert(!!flag, 'a health flag appears once the count is non-zero');
    assert(flag?.severity === 'warning', `the flag follows the existing shape (severity ${flag?.severity})`);
    assert(Array.isArray(flag?.members) && flag!.members.length === 0, 'the flag names no members: this is a process fault, not a person');
    assert(flag?.description.includes(String(summary.count)) === true, 'the flag says how many');
    assert(!flag?.description.includes(SECRET_HEX) && !flag?.description.includes('[REDACTED'), 'the flag carries no error text at all — that lives behind the admin diagnostics screen');

    const publicHealth = await (await fetch(`${BASE}/api/community/health`)).json() as any;
    assert(publicHealth.flags === undefined, 'and the unauthenticated health route still serves no flags at all');
}

async function main(): Promise<void> {
    console.log('\n=== Testing the process-level error policy ===');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-stray-error-'));
    try {
        await childProcessTests(root);
        await diagnosticsAndHealthTests();
    } finally {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

const childIndex = process.argv.indexOf(CHILD_FLAG);
if (childIndex !== -1) {
    runChild(process.argv[childIndex + 1] ?? '');
} else {
    main().catch((err) => {
        console.error('Test execution failed:', err);
        process.exit(1);
    });
}

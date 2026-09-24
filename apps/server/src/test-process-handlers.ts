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
 *   5. no report written after install carries the environment — not ours, not Node's own — so the node's
 *      ADMIN_PASSWORD and CF_API_TOKEN no longer land in a file owners copy and hand to a stranger; and
 *      neither does the report Node writes when the REAL entry point crashes while it is still importing,
 *      before a statement of it has run — the crash-loop case, where no boot ever reaches the scrub;
 *   6. the reports ALREADY in the data dir, written before this existed, are scrubbed in place at install:
 *      atomically, idempotently, owner-only, and without deleting a single one of them;
 *   7. the count, last time and last message reach the admin diagnostics response, a health flag appears,
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
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installProcessHandlers, getUnhandledRejectionSummary, getUnhandledRejectionLogPath } from './process-handlers.js';

const SCRIPT = fileURLToPath(import.meta.url);
/**
 * The REAL entry point, beside this file. Case 5c runs it rather than a stand-in, because what is under
 * test there is the order of `index.ts`'s own imports — a copy of that file would only test the copy.
 */
const ENTRY = SCRIPT.replace(/test-process-handlers\.(m?[tj]s)$/, 'index.$1');
const CHILD_FLAG = '--child';
/** A 64-char hex string is exactly what sanitizeMessage redacts, so it stands in for a key in an error. */
const SECRET_HEX = 'deadbeef'.repeat(8);
/**
 * Put in the child's ENVIRONMENT only — never in its argv — so that finding this string anywhere in a
 * report file means the environment reached the file. It is deliberately unlike anything else in the
 * process, so a hit cannot be a coincidence.
 */
const ENV_MARKER = 'BEANPOOL-ENV-MARKER-7f3a9c21-must-never-reach-a-report';

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
        case 'idle':
            // Installs and does nothing else. What is under test is what INSTALLING did to the data dir.
            reportAndExit();
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

/**
 * Spawn the real entry point the same way `spawnChild` spawns this file. Used only by case 5c, where the
 * point is that the entry point crashes while it is still IMPORTING — before any statement of its body,
 * including the one that installs the handlers, has had a chance to run.
 */
function spawnEntry(dataDir: string, extraEnv: Record<string, string> = {}): Promise<ChildResult> {
    fs.mkdirSync(dataDir, { recursive: true });
    const child = spawn(process.execPath, [...process.execArgv, ENTRY], {
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

/**
 * A diagnostic report Node writes by default carries an `environmentVariables` section holding the whole
 * of `process.env` in plaintext. On a node that is ADMIN_PASSWORD, BACKUP_ADMIN_PASSWORD,
 * BACKUP_REPLICATION_TOKEN, CF_API_TOKEN and the Instagram and TikTok secrets, written into the data dir —
 * the directory owners copy, mount and hand to someone else for help, and the one the manual sends them
 * into to find the report. Measured on the test node before this: 46 world-readable report files, 28 of
 * them holding the admin password and the Cloudflare token.
 */
async function reportPrivacyTests(root: string): Promise<void> {
    console.log('\n— 5. no report written after install carries the environment —');

    // Ours, written by the handler. The marker is in the environment and nowhere else.
    const ourDir = path.join(root, 'report-privacy-ours');
    const ours = await spawnChild('boom', ourDir, { BEANPOOL_ENV_MARKER: ENV_MARKER });
    assert(ours.code !== 0, `the child still crashes (code ${ours.code})`);
    const ourNames = reportFiles(ourDir);
    assert(ourNames.length === 1, `one report was written (got ${JSON.stringify(ourNames)})`);
    const ourPath = path.join(ourDir, ourNames[0] ?? 'missing.json');
    const ourRaw = fs.existsSync(ourPath) ? fs.readFileSync(ourPath, 'utf8') : '';
    assert(ourRaw.length > 0, 'and it can be read back');
    assert(!ourRaw.includes(ENV_MARKER), 'the environment marker is nowhere in the report file — not in any section, not in the command line');
    let ourReport: any = null;
    try { ourReport = JSON.parse(ourRaw); } catch { /* asserted next */ }
    assert(ourReport !== null, 'the report is still valid JSON');
    assert(ourReport?.environmentVariables === undefined, 'it has no environmentVariables section at all');
    assert(Array.isArray(ourReport?.javascriptStack?.stack) || typeof ourReport?.javascriptStack === 'object', 'and it still carries the JavaScript stack, which is the whole reason to keep reports');
    assert((fs.statSync(ourPath).mode & 0o777) === 0o600, `the report is owner-only (mode ${(fs.statSync(ourPath).mode & 0o777).toString(8)})`);

    // Node's own, written by --report-uncaught-exception: what every compose node actually produces.
    const nodesDir = path.join(root, 'report-privacy-nodes-own');
    fs.mkdirSync(nodesDir, { recursive: true });
    const nodes = await spawnChild('boom', nodesDir, {
        BEANPOOL_ENV_MARKER: ENV_MARKER,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --report-uncaught-exception --report-directory=${nodesDir}`.trim(),
    });
    assert(nodes.code !== 0, `the child still crashes (code ${nodes.code})`);
    const nodeNames = reportFiles(nodesDir);
    assert(nodeNames.length === 1 && !nodeNames[0].startsWith('report-uncaught-'), `Node wrote its own single report (got ${JSON.stringify(nodeNames)})`);
    const nodeRaw = fs.readFileSync(path.join(nodesDir, nodeNames[0] ?? 'missing.json'), 'utf8');
    assert(JSON.parse(nodeRaw).environmentVariables === undefined, 'Node’s own report has no environmentVariables section either — the flag is on the process, so it covers --report-uncaught-exception and the watchdog’s --report-on-signal freeze reports as well');
    // MEASURED, and the reason the scrub is not only about old files: `excludeEnv` is per THREAD. A report
    // written with it set still carries the whole environment once per worker thread, nested under
    // `workers[]`. `node dist/index.js` has no workers; this suite runs under a loader that does, and so
    // does `pnpm dev`. Node writes its own report as the process dies, after anything of ours can touch
    // it, so the file it leaves is cleaned by the next boot — which is what the rest of this checks.
    const nodeWorkers = JSON.parse(nodeRaw).workers;
    const nodePath = path.join(nodesDir, nodeNames[0] ?? 'missing.json');
    const bootAfterCrash = await spawnChild('idle', nodesDir);
    assert(bootAfterCrash.code === 0, `the node boots again after the crash (code ${bootAfterCrash.code})`);
    assert(!fs.readFileSync(nodePath, 'utf8').includes(ENV_MARKER),
        `after that boot the environment is nowhere in Node's own report either${Array.isArray(nodeWorkers) && nodeWorkers.length > 0 ? ` (it had ${nodeWorkers.length} worker section(s) carrying it)` : ''}`);
    assert(fs.existsSync(nodePath), 'and the report itself is still there — a scrub never deletes the only record of a crash');

    console.log('\n— 6. the reports already on disk are scrubbed at install —');

    // The fixture is shaped like a real report: the sections an owner or we would actually read, plus the
    // environment section as Node wrote it before any of this existed.
    const oldDir = path.join(root, 'report-privacy-existing');
    fs.mkdirSync(oldDir, { recursive: true });
    const oldReportPath = path.join(oldDir, 'report.20260714.031200.1.0.001.json');
    const fixture = {
        header: {
            event: 'Signal',
            trigger: 'SIGUSR2',
            processId: 1,
            // A flag keeps its value; a bare NAME=value word does not.
            commandLine: ['node', '--report-on-signal', '--report-directory=/data', 'dist/index.js', `LEGACY_TOKEN=${ENV_MARKER}`],
            nodejsVersion: 'v22.21.1',
        },
        javascriptStack: { message: 'No stack.', stack: ['Unavailable'] },
        libuv: [{ type: 'tcp', is_active: true }],
        environmentVariables: {
            PATH: '/usr/local/bin',
            ADMIN_PASSWORD: `admin-${ENV_MARKER}`,
            CF_API_TOKEN: `cf-${ENV_MARKER}`,
        },
        sharedObjects: ['/usr/lib/libc.so'],
        // A worker thread's own nested section. `excludeEnv` is per thread, so this is exactly where a
        // report written WITH the flag set still carries the environment.
        workers: [
            {
                header: { threadId: 1 },
                javascriptStack: { message: 'No stack.' },
                environmentVariables: { ADMIN_PASSWORD: `worker-${ENV_MARKER}` },
            },
        ],
    };
    fs.writeFileSync(oldReportPath, JSON.stringify(fixture, null, 2), { mode: 0o644 });
    fs.chmodSync(oldReportPath, 0o644);
    // Something that is NOT a report, sitting under a name the sweep matches. It must come out untouched:
    // a sweep that mangles a file it does not understand is worse than the leak it was fixing.
    const notJsonPath = path.join(oldDir, 'report-foo.json');
    const notJsonBefore = 'this is not JSON at all, and it holds ' + ENV_MARKER + '\n';
    fs.writeFileSync(notJsonPath, notJsonBefore);
    const namesBefore = fs.readdirSync(oldDir).sort();

    const first = await spawnChild('idle', oldDir);
    assert(first.code === 0, `the child installed the handlers and exited cleanly (code ${first.code})`);

    const scrubbedRaw = fs.readFileSync(oldReportPath, 'utf8');
    const scrubbed = JSON.parse(scrubbedRaw);
    assert(scrubbed.environmentVariables === undefined, 'the environmentVariables section is gone from the report that was already there');
    assert(scrubbed.workers?.[0]?.environmentVariables === undefined, 'and so is the copy nested inside the worker thread’s own section');
    assert(scrubbed.workers?.[0]?.header?.threadId === 1 && scrubbed.workers?.[0]?.javascriptStack?.message === 'No stack.', 'the rest of the worker section is intact');
    assert(!scrubbedRaw.includes(`admin-${ENV_MARKER}`) && !scrubbedRaw.includes(`cf-${ENV_MARKER}`) && !scrubbedRaw.includes(`worker-${ENV_MARKER}`), 'neither the admin password nor the Cloudflare token is anywhere in the file any more, in any section');
    assert(!scrubbedRaw.includes(ENV_MARKER), 'and neither is the assignment that was sitting in the command line');
    assert(scrubbed.header?.commandLine?.includes('--report-directory=/data') === true, 'a flag with a value is left as it was — it is not a secret and it says how the node was run');
    assert(scrubbed.header?.commandLine?.some((w: string) => w.startsWith('LEGACY_TOKEN=')) === true, 'the redacted word is still there by name, so the report still shows what was on the command line');
    assert(scrubbed.header?.trigger === 'SIGUSR2' && scrubbed.header?.processId === 1, 'the header is otherwise intact — this is a July freeze capture and it is the only record of that freeze');
    assert(JSON.stringify(scrubbed.javascriptStack) === JSON.stringify(fixture.javascriptStack), 'the JavaScript stack is intact');
    assert(JSON.stringify(scrubbed.libuv) === JSON.stringify(fixture.libuv), 'the libuv handles are intact');
    assert(JSON.stringify(scrubbed.sharedObjects) === JSON.stringify(fixture.sharedObjects), 'the shared objects are intact');
    assert((fs.statSync(oldReportPath).mode & 0o777) === 0o600, `the scrubbed report is owner-only, not world-readable as it was (mode ${(fs.statSync(oldReportPath).mode & 0o777).toString(8)})`);

    assert(fs.readFileSync(notJsonPath, 'utf8') === notJsonBefore, 'a file under a matching name that is not a report is left byte-for-byte alone');
    assert(JSON.stringify(fs.readdirSync(oldDir).sort()) === JSON.stringify(namesBefore), `nothing was deleted and no temp file was left behind (${JSON.stringify(fs.readdirSync(oldDir).sort())})`);

    // Idempotent: a node that restarts, or updates twice, must not rewrite 46 files on every boot.
    const mtimeAfterFirst = fs.statSync(oldReportPath).mtimeMs;
    const second = await spawnChild('idle', oldDir);
    assert(second.code === 0, `a second install exits cleanly too (code ${second.code})`);
    assert(fs.readFileSync(oldReportPath, 'utf8') === scrubbedRaw, 'the second install leaves the already-scrubbed report byte-for-byte as it was');
    assert(fs.statSync(oldReportPath).mtimeMs === mtimeAfterFirst, 'and does not even rewrite it — the scrub is a no-op once there is nothing left to take out');
    assert(JSON.stringify(fs.readdirSync(oldDir).sort()) === JSON.stringify(namesBefore), 'and still nothing was deleted');
}

/**
 * THE CASE THAT MOTIVATES report-privacy.ts, and the one every case above misses.
 *
 * Every child above installs the handlers and then does something. A real node does not get that far when
 * the failure is in the import graph itself: `index.ts` imports the whole application, `db/db.ts` opens
 * SQLite at import, and ES modules evaluate all of that BEFORE the first statement of `index.ts` runs. So
 * `state.db` unopenable, a native binding missing from the image, a migration throwing at import — the
 * shape of #1075 — ends the process with `installProcessHandlers()` never called and `excludeEnv` never
 * set. Nodes run `--report-uncaught-exception --report-directory=/data`, so Node writes its own report
 * right then, with the whole environment in it. And a node in that state CRASH-LOOPS: every restart adds
 * another such file and no boot ever reaches the scrub, so nothing ever cleans them.
 *
 * Measured on the entry point before `report-privacy.ts` existed: `environmentVariables` present, marker
 * present. This runs the real `index.ts`, not a stand-in, because the order of its imports is the subject.
 */
async function importCrashTests(root: string): Promise<void> {
    console.log('\n— 5c. a crash while the entry point is still importing carries no environment either —');

    /** `new Database(path)` cannot open a DIRECTORY, so db/db.ts throws at import — no code change needed. */
    function unopenableDataDir(name: string): string {
        const dir = path.join(root, name);
        fs.mkdirSync(path.join(dir, 'state.db'), { recursive: true });
        return dir;
    }
    /** The marker's only legitimate hiding place is a worker thread's own section; see below. */
    function outsideWorkers(report: any): string {
        return JSON.stringify({ ...report, workers: undefined });
    }

    const crashDir = unopenableDataDir('import-crash');
    const crash = await spawnEntry(crashDir, {
        BEANPOOL_ENV_MARKER: ENV_MARKER,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --report-uncaught-exception --report-directory=${crashDir}`.trim(),
    });
    assert(crash.code !== 0 && crash.code !== null, `the node dies (code ${crash.code})`);
    assert(crash.stderr.includes('SQLITE_CANTOPEN') || crash.stderr.includes('unable to open database file'),
        'and it died opening the database AT IMPORT, which is the failure being reproduced');
    assert(!crash.stderr.includes('[uncaughtException]'),
        'our own handler never ran — proof the process never reached a single statement of index.ts');

    const crashNames = reportFiles(crashDir);
    assert(crashNames.length === 1, `Node wrote its own report anyway (got ${JSON.stringify(crashNames)})`);
    assert(!crashNames[0]?.startsWith('report-uncaught-'), 'it is Node’s, not ours: ours needs handlers that were never installed');
    const crashRaw = fs.readFileSync(path.join(crashDir, crashNames[0] ?? 'missing.json'), 'utf8');
    let crashReport: any = null;
    try { crashReport = JSON.parse(crashRaw); } catch { /* asserted next */ }
    assert(crashReport !== null, 'the report is valid JSON');
    assert(crashReport?.environmentVariables === undefined,
        'it has NO environmentVariables section — set by report-privacy.ts, the entry point’s first import, before db/db.ts could throw');
    assert(!outsideWorkers(crashReport).includes(ENV_MARKER),
        'and the marker appears nowhere in it outside a worker thread’s own section — not in the command line, not anywhere');
    assert(crashReport?.javascriptStack !== undefined || crashReport?.nativeStack !== undefined,
        'and it still carries the stack, which is the whole reason to keep the file');

    // The one place the environment can still survive this crash, and why nodes ALSO pass the flag. A
    // worker thread holds its own copy of `excludeEnv`, so the main thread setting it does not speak for
    // the loader's worker (MEASURED: this suite's own runtime has one; `node dist/index.js` has none).
    // `--report-exclude-env` is applied per thread from the command line, so it does reach them — and it
    // is the only thing that does here, because a crash-looping node never reaches the scrub.
    const flaggedDir = unopenableDataDir('import-crash-flagged');
    const flagged = await spawnEntry(flaggedDir, {
        BEANPOOL_ENV_MARKER: ENV_MARKER,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --report-uncaught-exception --report-exclude-env --report-directory=${flaggedDir}`.trim(),
    });
    assert(flagged.code !== 0 && flagged.code !== null, `the node dies the same way with the flag set (code ${flagged.code})`);
    const flaggedNames = reportFiles(flaggedDir);
    assert(flaggedNames.length === 1, `one report again (got ${JSON.stringify(flaggedNames)})`);
    const flaggedRaw = fs.readFileSync(path.join(flaggedDir, flaggedNames[0] ?? 'missing.json'), 'utf8');
    assert(!flaggedRaw.includes(ENV_MARKER),
        'with --report-exclude-env — which docker-compose.yml now sets — the marker is nowhere in the file AT ALL, worker sections included');
    assert(JSON.parse(flaggedRaw).javascriptStack !== undefined || JSON.parse(flaggedRaw).nativeStack !== undefined,
        'and that report still carries the stack too');
}

async function diagnosticsAndHealthTests(): Promise<void> {
    console.log('\n— 7. owners can see it: diagnostics and a health flag —');
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

    // Bind once and read the port back (two probes in a row could be handed the same port).
    const httpPort = await startHttpServer(0);
    const httpsPort = await startHttpsServer(0);
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
        await reportPrivacyTests(root);
        await importCrashTests(root);
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

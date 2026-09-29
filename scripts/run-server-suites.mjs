#!/usr/bin/env node
// run-server-suites.mjs — runs every apps/server/src/test-*.ts run listed in scripts/server-suites.mjs, several at a time.
//
// WHY. test-all.sh used to run these one after another: on CI run 36611636008 that stage was 39m49s of a 42m15s job.
// Every run is already its own process with a fresh data dir, so the only thing that kept two of them from running side
// by side was fixed ports, and those are port 0 now. Local runs are the merge gate (Marty, 2026-09-30), so the stage has
// to fit in a few minutes on a laptop.
//
// EACH RUN gets its own mkdtemp BEANPOOL_DATA_DIR and TMPDIR, runs as `tsx src/<suite>.ts` from apps/server (PATH as
// `pnpm exec` sets it) in a process group of its own, and has SERVER_SUITES_TIMEOUT seconds (300). A run past that is
// killed: its process group, and every process descended from it, by PID. Never by name or pattern: other worktrees
// run the same suites on this machine. Anything its group left behind when it exited normally is killed too.
//
// The limit does not fix a hang; it turns one into a named failure. A suite that leaves the engine's timers open and
// returns instead of calling process.exit never ends, and runs here have been cancelled at 14, 17, 22 and 360 minutes
// for that, indistinguishable from a slow day until someone gave up. test-all.sh's old guard was timeout(1), which
// this Mac does not have, so locally it guarded nothing. The slowest suite takes about 3 minutes (test-2fa-reenrol-
// needs-code, on this Mac and on CI alike), so 300 s is room for it and not much more: a suite that grows past it
// should be split or made quicker rather than the limit raised.
//
// ORDER. Longest first, from the durations the last run recorded in <git common dir>/server-suite-durations.json (shared
// by every worktree of the checkout, never tracked). A run with no recorded duration goes first, so a new suite is never
// the one holding up the end. SERIAL runs in the manifest go last, one at a time, with no other suite beside them.
//
// NO RETRIES. A failure is red. The report lists every failing run with its log, then one roll-up line that
// scripts/test-all-lib.sh reads (`❌ Server suites failed: test-x test-y(on) test-z(TIMEOUT)`).
//
// Env:
//   TEST_ALL_JOBS           runs at a time. Default 3 on CI, else the core count minus 4, at least 1.
//   SERVER_SUITES_ONLY      run only these (run ids or suite names, space or comma separated), e.g. to reproduce one.
//   SERVER_SUITES_TIMEOUT   seconds per run, default 300.
//   SERVER_SUITES_SUMMARY   file to write the short timing summary to (test-all.sh prints it in its report).
//   TEST_ALL_LOG_DIR        when set (CI), the logs of failing runs are copied to $TEST_ALL_LOG_DIR/server-suites/.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ENV, SUITES, VARIANTS, SERIAL } from './server-suites.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.join(ROOT, 'apps/server');
const TSX = path.join(ROOT, 'node_modules/.bin/tsx');
const TIMEOUT_S = Number(process.env.SERVER_SUITES_TIMEOUT || 300);
const KILL_GRACE_MS = 10_000;
const FAILED_LOG_LINES = 300; // a failing run's whole log up to this; past it, its ✗ lines and the last 200
const SUMMARY_TOP = 15;

/**
 * Never handed to a suite: a shell that sourced a node's .env would otherwise run the suites as that node, with its
 * admin password and a live Cloudflare token (services/tls.ts reads CF_* at import). The same set as test-all-lib.sh's
 * scrub_test_env; CI has none of them.
 */
const SECRET_ENV = /^(CF_.*|CLOUDFLARE_.*|ADMIN_PASSWORD|BACKUP_ADMIN_PASSWORD|ADMIN_SECRET|BACKUP_REPLICATION_TOKEN|TIKTOK_CLIENT_SECRET|INSTAGRAM_APP_SECRET|INSTAGRAM_CLIENT_SECRET)$/;

const cores = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
const JOBS = Math.max(1, Number(process.env.TEST_ALL_JOBS) || (process.env.CI ? 3 : cores - 4));

// ── The runs ─────────────────────────────────────────────────────────────────────────────────────────────────────

function buildRuns() {
    const runs = [
        ...SUITES.map((name) => ({ id: name, name, label: '', env: {} })),
        ...VARIANTS.map((v) => ({ id: v.tag ? `${v.name}(${v.tag})` : v.name, name: v.name, tag: v.tag, label: v.label || '', env: v.env || {} })),
    ];
    const problems = [];
    const seen = new Set();
    for (const r of runs) {
        if (seen.has(r.id)) problems.push(`${r.id} is listed twice`);
        seen.add(r.id);
        if (!fs.existsSync(path.join(SERVER_DIR, 'src', `${r.name}.ts`))) problems.push(`${r.id}: no apps/server/src/${r.name}.ts`);
    }
    for (const id of Object.keys(SERIAL)) if (!seen.has(id)) problems.push(`SERIAL names ${id}, which is not a run`);
    if (problems.length) {
        console.log(`❌ scripts/server-suites.mjs is wrong:\n  ${problems.join('\n  ')}`);
        process.exit(2);
    }
    const only = (process.env.SERVER_SUITES_ONLY || '').split(/[\s,]+/).filter(Boolean);
    if (only.length === 0) return runs;
    const picked = runs.filter((r) => only.includes(r.id) || only.includes(r.name));
    if (picked.length === 0) {
        console.log(`❌ SERVER_SUITES_ONLY matched no run: ${only.join(' ')}`);
        process.exit(2);
    }
    return picked;
}

// ── Recorded durations ───────────────────────────────────────────────────────────────────────────────────────────

function durationsFile() {
    try {
        const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        return common ? path.join(common, 'server-suite-durations.json') : null;
    } catch {
        return null;
    }
}

function readDurations(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

/** Merges this run's durations over the file as it is NOW (another worktree may have written it meanwhile). */
function writeDurations(file, results) {
    if (!file) return;
    const all = readDurations(file);
    for (const r of results) if (r.status === 'pass' || r.status === 'timeout') all[r.id] = Math.round(r.seconds * 10) / 10;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(all, Object.keys(all).sort(), 1) + '\n');
        fs.renameSync(tmp, file);
    } catch {
        try { fs.unlinkSync(tmp); } catch { /* none */ }
    }
}

// ── Running one ──────────────────────────────────────────────────────────────────────────────────────────────────

const live = new Map(); // pid -> the run, while it runs
const pendingKills = []; // the SIGKILLs a timed-out run is still owed after its grace

/** pid -> { ppid, pgid } for every process on the machine. */
function processTable() {
    const table = new Map();
    let out = '';
    try { out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8' }); } catch { return table; }
    for (const line of out.split('\n')) {
        const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
        if (pid) table.set(pid, { ppid, pgid });
    }
    return table;
}

/**
 * Every process descended from `rootPid`, found by parent PID, with its process group. Taken BEFORE a kill, because an
 * orphan is re-parented to 1 and can no longer be traced. It reaches the children a suite started in groups of their
 * own (detached), which a kill of the run's group would miss.
 */
function descendants(rootPid) {
    const table = processTable();
    const children = new Map();
    for (const [pid, { ppid }] of table) {
        if (!children.has(ppid)) children.set(ppid, []);
        children.get(ppid).push(pid);
    }
    const out = [];
    const queue = [rootPid];
    while (queue.length) {
        for (const kid of children.get(queue.shift()) || []) { out.push({ pid: kid, pgid: table.get(kid).pgid }); queue.push(kid); }
    }
    return out;
}

/**
 * Signals the run's process group, then each listed process that is STILL in the group it was in when it was listed,
 * so a PID the system has since given to some other process is never touched.
 */
function signal(pgid, members, sig) {
    try { process.kill(-pgid, sig); } catch { /* the group is gone */ }
    const now = processTable();
    for (const m of members) {
        if (now.get(m.pid)?.pgid !== m.pgid) continue;
        try { process.kill(m.pid, sig); } catch { /* gone */ }
    }
}

function runOne(run, workDir) {
    return new Promise((resolve) => {
        const dataDir = path.join(workDir, 'data');
        const tmpDir = path.join(workDir, 'tmp');
        fs.mkdirSync(dataDir, { recursive: true });
        fs.mkdirSync(tmpDir, { recursive: true });
        const env = { ...process.env, ...DEFAULT_ENV };
        for (const k of Object.keys(env)) if (SECRET_ENV.test(k)) delete env[k];
        for (const [k, v] of Object.entries(run.env)) {
            if (v === null) delete env[k]; else env[k] = v;
        }
        env.BEANPOOL_DATA_DIR = dataDir;
        env.TMPDIR = tmpDir;
        env.PATH = [path.join(SERVER_DIR, 'node_modules/.bin'), path.join(ROOT, 'node_modules/.bin'), process.env.PATH].join(path.delimiter);

        run.log = path.join(workDir, 'output.log');
        const fd = fs.openSync(run.log, 'w');
        const started = Date.now();
        const child = spawn(TSX, [`src/${run.name}.ts`], { cwd: SERVER_DIR, env, stdio: ['ignore', fd, fd], detached: true });
        fs.closeSync(fd);
        live.set(child.pid, run);

        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            const tree = descendants(child.pid);
            signal(child.pid, tree, 'SIGTERM');
            // Awaited before the report, so the runner never exits with a SIGKILL still owed to a child that
            // ignored the SIGTERM.
            pendingKills.push(new Promise((done) => setTimeout(() => {
                signal(child.pid, [...tree, ...descendants(child.pid)], 'SIGKILL');
                done();
            }, KILL_GRACE_MS)));
        }, TIMEOUT_S * 1000);

        const finish = (code, sig) => {
            clearTimeout(timer);
            live.delete(child.pid);
            // Whatever the run left running in its own group goes with it (a suite that forgot a child).
            try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is gone, as it should be */ }
            const seconds = (Date.now() - started) / 1000;
            const status = timedOut ? 'timeout' : code === 0 ? 'pass' : 'fail';
            resolve({ ...run, status, code, signal: sig, seconds });
        };
        child.on('exit', finish);
        child.on('error', (err) => {
            fs.appendFileSync(run.log, `\nrun-server-suites: could not start ${TSX}: ${err.message}\n`);
            finish(127, null);
        });
    });
}

// ── The pool ─────────────────────────────────────────────────────────────────────────────────────────────────────

const fmt = (s) => {
    if (s < 60) return `${s.toFixed(1)}s`;
    const whole = Math.round(s);
    return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, '0')}s`;
};
const header = (r) => `━━━ ${r.name}${r.label ? ` (${r.label})` : ''} ━━━`;
const rollupName = (r) => (r.status === 'timeout' ? (r.tag ? `${r.name}(${r.tag},TIMEOUT)` : `${r.name}(TIMEOUT)`) : r.id);

async function runAll(runs, jobs, root, results) {
    const queue = [...runs];
    let n = results.length;
    const worker = async () => {
        while (queue.length) {
            const run = queue.shift();
            const workDir = path.join(root, String(++n));
            const r = await runOne(run, workDir);
            results.push(r);
            // ✘, not ✗: scripts/test-all-lib.sh counts every ✗ line as a failing assertion of the suite above it.
            const mark = r.status === 'pass' ? '✓' : '✘';
            const why = r.status === 'timeout' ? ` TIMEOUT after ${TIMEOUT_S}s` : r.status === 'fail' ? ` exit ${r.code ?? r.signal}` : '';
            console.log(`${mark} ${r.id}${why}  ${fmt(r.seconds)}  [${results.length}/${total}]`);
            if (r.status === 'pass') fs.rmSync(workDir, { recursive: true, force: true });
        }
    };
    await Promise.all(Array.from({ length: Math.min(jobs, runs.length) }, worker));
}

let total = 0;
let root = null;

function cleanupAndExit(sig) {
    for (const [pid] of live) signal(pid, descendants(pid), 'SIGKILL');
    if (root) fs.rmSync(root, { recursive: true, force: true });
    console.log(`\nrun-server-suites: ${sig}, killed ${live.size} running suite(s)`);
    process.exit(130);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => cleanupAndExit(sig));

async function main() {
    if (!fs.existsSync(TSX)) {
        console.log(`❌ ${path.relative(ROOT, TSX)} is missing: run pnpm install`);
        process.exit(2);
    }
    const runs = buildRuns();
    total = runs.length;
    const file = durationsFile();
    const known = file ? readDurations(file) : {};
    const weight = (r) => known[r.id] ?? Infinity;
    const pooled = runs.filter((r) => !SERIAL[r.id]).sort((a, b) => weight(b) - weight(a));
    const serial = runs.filter((r) => SERIAL[r.id]);

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
    console.log(`Server suites: ${pooled.length} runs, ${JOBS} at a time (${cores} cores), then ${serial.length} serial; ${TIMEOUT_S}s limit each`);
    if (Object.keys(known).length === 0) console.log('  (no recorded durations yet, so manifest order; the next run goes longest first)');

    const results = [];
    const t0 = Date.now();
    await runAll(pooled, JOBS, root, results);
    const poolSeconds = (Date.now() - t0) / 1000;
    const t1 = Date.now();
    if (serial.length) {
        console.log(`\nSerial tail: ${serial.map((r) => r.id).join(' ')}`);
        await runAll(serial, 1, root, results);
    }
    const serialSeconds = (Date.now() - t1) / 1000;
    const wall = (Date.now() - t0) / 1000;
    await Promise.all(pendingKills);
    writeDurations(file, results);

    // ── Report ──
    const failed = results.filter((r) => r.status !== 'pass');
    const byTime = [...results].sort((a, b) => b.seconds - a.seconds);
    const cpu = results.reduce((s, r) => s + r.seconds, 0);
    const line = `Server suites: ${results.length - failed.length}/${results.length} passed in ${fmt(wall)}`
        + ` (pool ${fmt(poolSeconds)} at ${JOBS} jobs${serial.length ? `, serial tail ${fmt(serialSeconds)}` : ''}; ${fmt(cpu)} of suite time)`;

    console.log(`\n──── Time per run, slowest first ────`);
    for (const r of byTime) console.log(`  ${fmt(r.seconds).padStart(7)}  ${r.status === 'pass' ? ' ' : '✘'} ${r.id}${SERIAL[r.id] ? '  [serial]' : ''}`);
    console.log(`\n${line}`);

    if (process.env.SERVER_SUITES_SUMMARY) {
        const top = byTime.slice(0, SUMMARY_TOP).map((r) => `    ${fmt(r.seconds).padStart(7)}  ${r.id}`).join('\n');
        fs.writeFileSync(process.env.SERVER_SUITES_SUMMARY, `${line}\n  Slowest ${Math.min(SUMMARY_TOP, byTime.length)}:\n${top}\n`);
    }

    if (failed.length === 0) {
        fs.rmSync(root, { recursive: true, force: true });
        return 0;
    }

    console.log(`\n──── Failing server suites (${failed.length}) ────`);
    for (const r of failed) {
        console.log(`\n${header(r)}`);
        const text = fs.readFileSync(r.log, 'utf8').replace(/\n$/, '');
        const lines = text.split('\n');
        if (lines.length <= FAILED_LOG_LINES) {
            console.log(text);
        } else {
            const marked = lines.filter((l) => /^\s*(✗|FAIL\s|❌)/.test(l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')));
            console.log(`(${lines.length} lines; its ✗ lines, then the last 200)`);
            if (marked.length) console.log(marked.join('\n'));
            console.log('…');
            console.log(lines.slice(-200).join('\n'));
        }
        const how = r.status === 'timeout' ? `killed after ${TIMEOUT_S}s` : `exit ${r.code ?? r.signal}`;
        console.log(`── ${r.id}: ${how}, ${fmt(r.seconds)}; log ${r.log}`);
    }
    if (process.env.TEST_ALL_LOG_DIR) {
        const dest = path.join(process.env.TEST_ALL_LOG_DIR, 'server-suites');
        fs.mkdirSync(dest, { recursive: true });
        for (const r of failed) fs.copyFileSync(r.log, path.join(dest, `${r.id}.log`));
        console.log(`\nLogs of the failing runs copied to ${dest}`);
    }
    console.log(`\n❌ Server suites failed: ${failed.map(rollupName).join(' ')}`);
    return 1;
}

main().then((code) => process.exit(code), (err) => {
    console.log(`run-server-suites crashed: ${err?.stack || err}`);
    cleanupAndExit('crash');
});

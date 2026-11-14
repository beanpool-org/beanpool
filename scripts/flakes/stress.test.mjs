// stress.sh in a throwaway git repo with a fake runner (STRESS_CMD) and `sleep` standing in for the CPU load (no CPU is
// burned here), the clock faked through STRESS_NOW_HHMMSS so a CI run at 03:20 UTC still tests the same thing. Each rule
// has a check and a MUTANT, a copy of stress.sh with that rule broken, which the same check must reject.
//   node --test scripts/flakes/stress.test.mjs        (test-all.sh's flake_tools check)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `stress-${p}-`));
const write = (root, rel, text = '') => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const STRAYS = new Set();
after(() => { for (const p of STRAYS) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } });

// ── the repo: main changed four tests in the last day (one only beside its source), others older or out of scope ──
const REPO = tmp('repo');
const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: REPO, encoding: 'utf8', env: { ...process.env, ...git.env } });
git('init', '-q');
write(REPO, 'lib/util.test.mjs', '// beside lib/util.mjs\n');
write(REPO, 'b/__tests__/thing.test.mjs', '// beside b/thing.mjs, in __tests__\n');
write(REPO, 'old/old.test.mjs', '// changed three days ago\n');
git('add', '.');
const OLD = new Date(Date.now() - 3 * 86400e3).toISOString();
git.env = { GIT_AUTHOR_DATE: OLD, GIT_COMMITTER_DATE: OLD };
git('commit', '-q', '-m', 'old');
git.env = {};
for (const f of ['a/flaky.test.mjs', 'a/solid.test.mjs', 'a/slow.test.mjs', 'lib/util.mjs', 'b/thing.mjs', 'e2e/skip.test.mjs', 'notes.md']) write(REPO, f, `// ${f}\n`);
git('add', '.');
git('commit', '-q', '-m', 'recent');
git('update-ref', 'refs/remotes/origin/main', 'HEAD');
// The ledger's two first, then by how often changed (once each), then by path.
const EXPECTED_ORDER = ['a/flaky.test.mjs', 'a/solid.test.mjs', 'a/slow.test.mjs', 'b/__tests__/thing.test.mjs', 'lib/util.test.mjs'];

// The fake runner: counts runs per file, notes whether every load process was alive, fails flaky.test.mjs on every
// second run with a vitest-shaped FAIL line, and keeps slow.test.mjs going for 16 s.
const RUNNER = path.join(tmp('runner'), 'runner.mjs');
fs.writeFileSync(RUNNER, `import fs from 'node:fs'; import path from 'node:path';
const f = process.argv[2]; const S = process.env.STRESS_TEST_STATE; const base = path.basename(f);
const cf = path.join(S, 'count-' + base);
const n = (fs.existsSync(cf) ? Number(fs.readFileSync(cf, 'utf8')) : 0) + 1; fs.writeFileSync(cf, String(n));
fs.appendFileSync(path.join(S, 'order'), f + '\\n');
const pids = (process.env.STRESS_HOG_PIDS || '').trim().split(/\\s+/).filter(Boolean);
const on = pids.length > 0 && pids.every((p) => { try { process.kill(Number(p), 0); return true; } catch { return false; } });
fs.appendFileSync(path.join(S, 'load'), (on ? 'on' : 'off') + '\\n');
if (base === 'slow.test.mjs') { fs.writeFileSync(path.join(S, 'slow-pid'), String(process.pid)); setTimeout(() => {}, 16000); }
else if (base === 'flaky.test.mjs' && n % 2 === 0) { console.log(' FAIL  a/flaky.test.mjs > group > sometimes'); console.log('AssertionError: expected 1 to be 2'); process.exit(1); }
`);

function setup(extra = {}) {
    const W = tmp('work');
    const lock = path.join(W, 'heavy-test.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner'), `pid=${process.pid} since=0 test\n`);
    const state = path.join(W, 'state');
    fs.mkdirSync(state);
    const ledger = path.join(W, 'flakes.jsonl');
    const now = Date.now();
    fs.writeFileSync(ledger, [
        { test: 'a/solid.test.mjs > g > never', file: 'a/solid.test.mjs', pr: 40, run: 1, job: 1, time: new Date(now - 2 * 86400e3).toISOString(), touched: 'not-seen' },
        { test: 'a/flaky.test.mjs > group > sometimes', file: 'a/flaky.test.mjs', pr: 41, run: 2, job: 2, time: new Date(now - 86400e3).toISOString(), touched: 'not-seen' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const env = {
        ...process.env, STRESS_ROOT: REPO, STRESS_LOCK: lock, STRESS_CMD: `${process.execPath} ${RUNNER}`,
        STRESS_HOG_CMD: 'sleep 300', STRESS_HOGS: '1', STRESS_RUNS: '4', STRESS_BUDGET_SECS: '14', STRESS_FILE_SECS: '2',
        STRESS_OUT: path.join(W, 'out'), STRESS_NOW_HHMMSS: '120000', FLAKE_LEDGER: ledger, FLAKE_ROOT: REPO, STRESS_TEST_STATE: state,
        ...extra,
    };
    return { W, lock, state, env, read: (n) => { try { return fs.readFileSync(path.join(state, n), 'utf8'); } catch { return ''; } } };
}
const hogPids = (out) => (/pids((?: \d+)+);/.exec(out)?.[1] ?? '').trim().split(/\s+/).filter(Boolean).map(Number);

function runStress(script, s, args = []) {
    const t0 = Date.now();
    const r = spawnSync('bash', [script, ...args], { env: s.env, encoding: 'utf8', timeout: 60000 });
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    const hogs = hogPids(out);
    hogs.forEach((p) => STRAYS.add(p));
    return { out, code: r.status, secs: (Date.now() - t0) / 1000, hogs };
}

const RULES = {
    'refuses without the heavy-test lock, and runs nothing': (script) => {
        const s = setup();
        s.env.STRESS_LOCK = path.join(s.W, 'not-held');
        const r = runStress(script, s);
        assert.equal(r.code, 2, r.out);
        assert.match(r.out, /REFUSED: the heavy-test lock .* is not held/);
        assert.equal(s.read('order'), '');
    },
    'refuses when the lock belongs to someone who is not its caller': (script) => {
        const s = setup();
        const other = spawn('sleep', ['30']);
        STRAYS.add(other.pid);
        fs.writeFileSync(path.join(s.lock, 'owner'), `pid=${other.pid} since=0 another run\n`);
        const r = runStress(script, s);
        other.kill();
        assert.equal(r.code, 2, r.out);
        assert.match(r.out, new RegExp(`held by pid ${other.pid}, which is not my caller`));
        assert.equal(s.read('order'), '');
    },
    'refuses to start inside 03:15-03:40': (script) => {
        for (const hms of ['031500', '033959']) {
            const r = runStress(script, setup({ STRESS_NOW_HHMMSS: hms }), ['--list']);
            assert.equal(r.code, 2, `${hms}: ${r.out}`);
            assert.match(r.out, /inside 03:15-03:40/);
        }
        const r = runStress(script, setup({ STRESS_NOW_HHMMSS: '034000' }), ['--list']);
        assert.equal(r.code, 0, r.out);
    },
    'stops at 03:15 when the budget would cross it': (script) => {
        const s = setup({ STRESS_NOW_HHMMSS: '031457' });
        const r = runStress(script, s);
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /not reached \(03:15 \(macOS temp clean-up\)\): 5 file\(s\)/);
        assert.equal(s.read('order'), '', 'no run starts 3 s before 03:15');
    },
    'picks the tests main changed in the window, and the tests beside changed source': (script) => {
        const r = runStress(script, setup(), ['--list']);
        assert.equal(r.code, 0, r.out);
        const listed = r.out.split('\n').filter((l) => /\.test\.mjs$/.test(l));
        assert.deepEqual([...listed].sort(), [...EXPECTED_ORDER].sort(), r.out);
        assert.match(r.out, /5 test file\(s\) \(3 changed, 2 beside changed source\)/);
    },
    'files the ledger holds go first': (script) => {
        const r = runStress(script, setup(), ['--list']);
        assert.deepEqual(r.out.split('\n').filter((l) => /\.test\.mjs$/.test(l)), EXPECTED_ORDER, r.out);
    },
    // One full run: the counts, the cross-check, the budget, the load.
    'a red is SUSPECT with its count': (script) => {
        const s = setup();
        const r = runStress(script, s);
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /^SUSPECT a\/flaky\.test\.mjs red 2\/4 /m);
        assert.match(r.out, /^clean {3}a\/solid\.test\.mjs 4\/4$/m);
        assert.match(r.out, /^clean {3}lib\/util\.test\.mjs 4\/4$/m);
        assert.match(r.out, /^clean {3}b\/__tests__\/thing\.test\.mjs 4\/4$/m);
        assert.match(r.out, /stress: 5 of 5 file\(s\) run in \d+s; 1 SUSPECT\(s\)/);
        assert.equal(s.read('order').split('\n').filter(Boolean).filter((f) => f === 'a/flaky.test.mjs').length, 4, 'each file runs N times');
    },
    'a suspect seen on CI says SEEN-ON-CI': (script) => {
        const r = runStress(script, setup());
        assert.match(r.out, /^SUSPECT a\/flaky\.test\.mjs[^\n]*\n {2}SEEN-ON-CI PR #41 \S+ run 2: a\/flaky\.test\.mjs > group > sometimes/m, r.out);
    },
    'never exceeds the budget: a run still going is stopped and counted as cut': (script) => {
        const s = setup();
        const r = runStress(script, s);
        assert.ok(r.secs <= 14, `took ${r.secs}s against a 14 s budget\n${r.out}`);
        assert.match(r.out, /^cut {5}a\/slow\.test\.mjs/m);
        const slow = Number(s.read('slow-pid'));
        assert.ok(slow > 0 && !alive(slow), 'the cut run is gone');
    },
    'the load runs during every run and is gone after': (script) => {
        const s = setup({ STRESS_HOGS: '2' });
        const r = runStress(script, s);
        assert.equal(r.hogs.length, 2, r.out);
        assert.ok(s.read('load').split('\n').filter(Boolean).every((l) => l === 'on'), 'every load process was alive for every run');
        for (const p of r.hogs) assert.ok(!alive(p), `load process ${p} outlived stress.sh`);
    },
    'a signal stops the run and the load': async (script) => {
        const s = setup({ STRESS_FILE_SECS: '30', STRESS_BUDGET_SECS: '60' });
        const child = spawn('bash', [script], { env: s.env });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        const closed = new Promise((res) => child.on('close', res));
        for (let i = 0; i < 100 && !s.read('slow-pid'); i++) await new Promise((res) => setTimeout(res, 100));
        const slow = Number(s.read('slow-pid'));
        assert.ok(slow > 0, `the slow run started\n${out}`);
        STRAYS.add(slow);
        child.kill('SIGTERM');
        await closed;
        await new Promise((res) => setTimeout(res, 300));
        const hogs = hogPids(out);
        hogs.forEach((p) => STRAYS.add(p));
        assert.ok(hogs.length >= 1, out);
        assert.ok(!alive(slow), 'the running test is stopped');
        for (const p of hogs) assert.ok(!alive(p), `load process ${p} outlived the signal`);
    },
};

const MUTANTS = [
    ['refuses without the heavy-test lock, and runs nothing', '[ -d "$LOCK" ] || refuse', 'true || refuse'],
    ['refuses when the lock belongs to someone who is not its caller', '&& ! is_ancestor "$OWNER_PID"; then', '&& false; then'],
    ['refuses to start inside 03:15-03:40', 'if [ $TOD -ge $CLEAN_FROM ] && [ $TOD -lt $CLEAN_TO ]; then', 'if false; then'],
    ['stops at 03:15 when the budget would cross it', 'if [ $TO_CLEAN -lt $WINDOW ]; then', 'if false; then'],
    ['picks the tests main changed in the window, and the tests beside changed source', '--since="$SINCE" ', ''],
    ['picks the tests main changed in the window, and the tests beside changed source', 'e2e/*|*/e2e/*|', ''],
    ['picks the tests main changed in the window, and the tests beside changed source', ' "$dir/__tests__/$stem".test.{ts,tsx,js,mjs}; do', '; do'],
    ['picks the tests main changed in the window, and the tests beside changed source', 'for cand in "$dir/$stem".test.{ts,tsx,js,mjs} ', 'for cand in '],
    ['files the ledger holds go first', 'print ((f in inl) ? 0 : 1)', 'print 1'],
    ['a red is SUSPECT with its count', 'if [ $rc -ne 0 ]; then reds=$((reds + 1));', 'if false; then reds=$((reds + 1));'],
    ['a suspect seen on CI says SEEN-ON-CI', 'node "$SCRIPT_DIR/record.mjs" --seen', 'true'],
    ['never exceeds the budget: a run still going is stopped and counted as cut', 'if [ "$(date +%s)" -ge "$until" ]; then stop_run; return 124; fi', ':'],
    ['the load runs during every run and is gone after', '  for p in $HOG_PIDS; do kill "$p" 2>/dev/null; done\n  for p in $HOG_PIDS; do wait "$p" 2>/dev/null; done', '  :'],
    // bash runs the EXIT trap when a signal ends it too (the INT/TERM trap only adds the line and the 130), so the EXIT
    // trap is what a signal depends on.
    ['a signal stops the run and the load', 'trap cleanup EXIT', ':'],
];

function mutant(from, to) {
    const dir = tmp('mutant');
    for (const f of ['lib.mjs', 'record.mjs', 'stress.sh']) fs.copyFileSync(path.join(HERE, f), path.join(dir, f));
    const p = path.join(dir, 'stress.sh');
    const src = fs.readFileSync(p, 'utf8');
    assert.equal(src.split(from).length - 1, 1, `the mutant's text must occur once in stress.sh: ${from}`);
    fs.writeFileSync(p, src.replace(from, to));
    return p;
}

for (const [name, check] of Object.entries(RULES)) test(name, async () => { await check(path.join(HERE, 'stress.sh')); });
for (const [rule, from, to] of MUTANTS) {
    test(`mutant goes red: ${rule} (${from.slice(0, 50).replace(/\n/g, ' ')})`, async () => {
        const script = mutant(from, to);
        await assert.rejects(async () => RULES[rule](script), (err) => err?.code === 'ERR_ASSERTION',
            `the check passed (or crashed) against a copy with "${from}" broken`);
    });
}
test('every rule has a mutant', () => {
    assert.deepEqual([...new Set(MUTANTS.map((m) => m[0]))].sort(), Object.keys(RULES).sort());
});

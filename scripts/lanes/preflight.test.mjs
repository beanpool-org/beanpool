// preflight.test.mjs — scripts/lanes/preflight-plan.mjs (which steps a diff calls for) and scripts/lanes/preflight.sh (the
// runner: a red step fails it, the heavy-test lock is waited for and never taken). Runs in test-all's `workflows` check.
//
//   node --test scripts/lanes/preflight.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { readChecksShard, parseDiff, planSteps, gitRepo, REPO_ROOT } from './preflight-plan.mjs';

const RUNNER = path.join(REPO_ROOT, 'scripts/lanes/preflight.sh');
const real = gitRepo();
const names = steps => steps.map(s => s.name);
const step = (steps, name) => steps.find(s => s.name === name);

/** A one-hunk -U0 diff adding (and optionally removing) lines in each file. */
function diff(files) {
  return Object.entries(files).map(([f, lines]) => [
    `diff --git a/${f} b/${f}`, `--- a/${f}`, `+++ b/${f}`, '@@ -1,0 +1 @@',
    ...[].concat(lines).map(l => (l.startsWith('-') ? l : `+${l}`)),
  ].join('\n')).join('\n') + '\n';
}
const plan = (files, repo = real) => planSteps(parseDiff(diff(files)), repo);

// ── the checks shard is read from ci.yml, never copied ──

test('the checks step runs exactly the names in ci.yml\'s "checks" matrix entry', () => {
  const line = real.ciYml.split('\n').find(l => l.includes('name: checks,'));
  const want = line.slice(line.indexOf('checks: "') + 'checks: "'.length).split('"')[0].trim();
  assert.equal(readChecksShard(real.ciYml), want);
  for (const guard of ['no_node_names', 'native_dark_contrast', 'typecheck', 'lint', 'no_google_fonts', 'words']) {
    assert.ok(` ${want} `.includes(` ${guard} `), `ci.yml's checks shard still has ${guard}`);
  }
  assert.equal(step(plan({}), 'checks').cmd, `TEST_ALL_ONLY='${want}' bash scripts/test-all.sh`);
});

test('a check added to or dropped from ci.yml\'s shard changes the plan with it', () => {
  const line = real.ciYml.split('\n').find(l => l.includes('name: checks,'));
  const ciYml = real.ciYml.replace(line, line.replace(/checks: "[^"]*"/, 'checks: "lint brand_new_check"'));
  const cmd = step(planSteps(new Map(), { ...real, ciYml }), 'checks').cmd;
  assert.equal(cmd, "TEST_ALL_ONLY='lint brand_new_check' bash scripts/test-all.sh");
});

test('every check in the shard is a check test-all.sh has (TEST_ALL_ONLY refuses an unknown one)', () => {
  const have = new Set([...real.testAllText.matchAll(/^ *(?:run|skip)_check "([a-z0-9_]+)"/gm)].map(m => m[1]));
  for (const n of readChecksShard(real.ciYml).split(' ')) assert.ok(have.has(n), `test-all.sh has a check named ${n}`);
});

test('no "checks" entry, an empty one, or two of them: no plan', () => {
  const line = real.ciYml.split('\n').find(l => l.includes('name: checks,'));
  assert.throws(() => readChecksShard(real.ciYml.replace(line, '')), /0 matrix entries/);
  assert.throws(() => readChecksShard(real.ciYml.replace(line, line.replace(/checks: "[^"]*"/, 'checks: ""'))), /names no checks/);
  assert.throws(() => readChecksShard(real.ciYml.replace(line, `${line}\n${line}`)), /2 matrix entries/);
});

// ── the map: a fake diff -> the suites chosen ──

test('a diff that touches only docs runs the checks shard and words, nothing else', () => {
  assert.deepEqual(names(plan({ 'docs/merge-gate.md': 'a new line' })), ['checks', 'words']);
  assert.deepEqual(names(plan({})), ['checks', 'words']);
});

test('a new server route runs test-guest-view and test-health-cors, each alone', () => {
  const steps = plan({ 'apps/server/src/routes/forum.ts': "    router.get('/api/forum/new-thing', async (ctx) => {" });
  assert.deepEqual(names(steps), ['checks', 'words', 'server:test-guest-view', 'server:test-health-cors']);
  assert.equal(step(steps, 'server:test-guest-view').cmd, 'SERVER_SUITES_ONLY=test-guest-view TEST_ALL_JOBS=1 node scripts/run-server-suites.mjs');
  // A removed or renamed route is a touched line too.
  assert.ok(names(plan({ 'apps/server/src/routes/forum.ts': "-    router.post('/api/forum/old', h);" })).includes('server:test-guest-view'));
  // Another receiver with a path, and a router mount.
  assert.ok(names(plan({ 'apps/server/src/https-server.ts': "  ann.post('/api/announce', h);" })).includes('server:test-health-cors'));
  assert.ok(names(plan({ 'apps/server/src/https-server.ts': '  app.use(adminRouter.routes());' })).length === 2, 'a .routes() call is no route line');
  assert.ok(names(plan({ 'apps/server/src/https-server.ts': '  localRouter.use(mw);' })).includes('server:test-guest-view'));
});

test('a route line in a server suite or a fixture is no new route', () => {
  assert.deepEqual(names(plan({ 'apps/server/src/test-forum.ts': "router.get('/api/x', h);" })), ['checks', 'words']);
  assert.deepEqual(names(plan({ 'apps/server/src/__fixtures__/x.ts': "router.get('/api/x', h);" })), ['checks', 'words']);
});

test('a new table or column runs test-standby-health and test-replica-hashes', () => {
  const want = ['checks', 'words', 'server:test-standby-health', 'server:test-replica-hashes'];
  assert.deepEqual(names(plan({ 'apps/server/src/db/db.ts': '  CREATE TABLE IF NOT EXISTS forum_new (id TEXT PRIMARY KEY);' })), want);
  assert.deepEqual(names(plan({ 'apps/server/src/db/upgrade.ts': "db.exec('ALTER TABLE posts ADD COLUMN pinned INTEGER');" })), want);
  assert.deepEqual(names(plan({ 'apps/server/src/db/schema.sql': '-- a comment only' })), want, 'any schema.sql change');
  assert.deepEqual(names(plan({ 'apps/server/src/engine/replica-hashes.ts': 'export const X = 1;' })), want);
  assert.deepEqual(names(plan({ 'apps/server/src/engine/copied-tables.ts': "  'forum_new'," })), want);
});

test('a route and a table in one diff run all four, each once', () => {
  const steps = plan({
    'apps/server/src/routes/forum.ts': "router.get('/api/forum/a', h);",
    'apps/server/src/routes/forum2.ts': "router.post('/api/forum/b', h);",
    'apps/server/src/db/db.ts': 'CREATE TABLE forum_b (id TEXT);',
  });
  assert.deepEqual(names(steps), ['checks', 'words', 'server:test-guest-view', 'server:test-health-cors',
    'server:test-standby-health', 'server:test-replica-hashes']);
});

test('a new profile door on the web runs EnterpriseNotAProfile with the other web tree scanners', () => {
  const s = step(plan({ 'apps/pwa/src/pages/LedgerPage.tsx': '  <Row onOpenProfile={onOpenProfile} />' }), 'vitest:@beanpool/pwa');
  assert.ok(s, 'a web vitest step');
  assert.match(s.cmd, /^pnpm --filter @beanpool\/pwa exec vitest run --maxWorkers=2 --passWithNoTests /);
  for (const t of ['src/pages/EnterpriseNotAProfile.test.tsx', 'src/darkModeHover.test.ts', 'src/components/ListPhoto.slots.test.ts',
    'src/lib/signing-source-rule.test.ts']) {
    assert.ok(s.cmd.split(' ').includes(t), `runs ${t}`);
  }
  // Co-located tests of the touched page too.
  assert.ok(s.cmd.includes('src/pages/LedgerPage.'), 'runs LedgerPage\'s own tests');
});

test('a phone style change runs the phone tree scanners (colour ceiling, dark sources); contrast is in the checks shard', () => {
  const steps = plan({ 'apps/native/components/BeansText.tsx': "  style={{ color: dark ? '#fff' : '#000' }}" });
  const s = step(steps, 'vitest:beanpool-pillar');
  assert.ok(s.cmd.startsWith('TEST_ALL_TIMEOUT_MS=30000 pnpm --filter beanpool-pillar exec vitest run'));
  for (const t of ['utils/__tests__/static-colours-ceiling.test.ts', 'utils/__tests__/dark-mode-sources.test.ts']) {
    assert.ok(s.cmd.split(' ').includes(t), `runs ${t}`);
  }
  assert.ok(step(steps, 'checks').cmd.includes('native_dark_contrast'));
  assert.equal(step(steps, 'vitest:@beanpool/pwa'), undefined, 'no web step for a phone-only change');
});

test('a test that pins a touched file\'s source runs (recovery-kit.test.ts reads app/_layout.tsx)', () => {
  const s = step(plan({ 'apps/native/app/_layout.tsx': '  useEffect(() => { sweepPrintedPdfs(); }, []);' }), 'vitest:beanpool-pillar');
  assert.ok(s.cmd.split(' ').includes('utils/__tests__/recovery-kit.test.ts'));
});

test('a touched test runs; a deleted one does not', () => {
  const s = step(plan({ 'apps/pwa/src/pages/LedgerPage.words.test.tsx': 'it("x", () => {});' }), 'vitest:@beanpool/pwa');
  assert.ok(s.cmd.split(' ').includes('src/pages/LedgerPage.words.test.tsx'));
  const gone = step(plan({ 'apps/pwa/src/pages/NoSuchPage.test.tsx': '-it("x", () => {});' }), 'vitest:@beanpool/pwa');
  assert.ok(!gone || !gone.cmd.includes('NoSuchPage'), 'a test file that no longer exists is not passed to vitest');
});

/** A small fake tree for the cases the real one does not pin down. */
function fakeRepo(files, testAllText = '') {
  return {
    ciYml: real.ciYml,
    testAllText,
    tests: dir => Object.keys(files).filter(f => f.startsWith(dir + '/') && /\.test\.\w+$/.test(f)),
    read: f => files[f] ?? '',
    exists: f => f in files,
  };
}

test('past the cap, importers are left to CI but scanners and pins still run', () => {
  const files = { 'apps/manager/src/api.ts': 'export {}', 'apps/manager/src/scan.test.ts': 'fs.readdirSync(dir)',
    'apps/manager/src/api.pin.test.ts': "readFileSync('api.ts')" };
  for (let i = 0; i < 120; i++) files[`apps/manager/src/p${i}.test.ts`] = "import { x } from './api';";
  const s = step(plan({ 'apps/manager/src/api.ts': 'export const y = 1;' }, fakeRepo(files)), 'vitest:@beanpool/manager');
  assert.equal(s.cmd, 'pnpm --filter @beanpool/manager exec vitest run --maxWorkers=2 --passWithNoTests src/api.pin.test.ts src/scan.test.ts');
  assert.match(s.why, /120 importers left to CI/);
  // Under the cap, importers run.
  const few = { ...files };
  for (let i = 3; i < 120; i++) delete few[`apps/manager/src/p${i}.test.ts`];
  const s2 = step(plan({ 'apps/manager/src/api.ts': 'export const y = 1;' }, fakeRepo(few)), 'vitest:@beanpool/manager');
  assert.equal(s2.cmd.split(' ').filter(a => /^src\/p\d\.test\.ts$/.test(a)).length, 3);
});

test('a guide page runs the guide tests; a script runs its sibling test unless test-all already does', () => {
  assert.ok(names(plan({ 'packages/beanpool-guide/content/en/joining.md': 'A new sentence.' })).includes('guide'));
  const repo = fakeRepo({ 'scripts/foo.mjs': '', 'scripts/foo.test.mjs': '', 'scripts/bar.mjs': '', 'scripts/bar.test.mjs': '' },
    'run_check "bar" node --test scripts/bar.test.mjs');
  const steps = plan({ 'scripts/foo.mjs': 'x', 'scripts/bar.mjs': 'y' }, repo);
  assert.equal(step(steps, 'script-tests').cmd, 'node --test scripts/foo.test.mjs');
});

// ── the runner ──

const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
function tmpdir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-test-')); made.push(d); return d; }
function planFile(dir, rows) {
  const f = path.join(dir, 'plan.tsv');
  fs.writeFileSync(f, rows.map(r => r.join('\t')).join('\n') + '\n');
  return f;
}
/** The runner on a given plan; its logs (kept on a red) go under the plan's temp dir, removed after the tests. */
function run(planPath, env = {}, runner = RUNNER, args = []) {
  const r = spawnSync('bash', [runner, ...args], {
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: path.dirname(planPath), PREFLIGHT_PLAN_FILE: planPath,
      PREFLIGHT_LOCK: path.join(path.dirname(planPath), 'no-lock-here'), ...env },
  });
  return { rc: r.status, out: r.stdout + r.stderr };
}

test('every step green: exit 0, one PASS line per step', () => {
  const d = tmpdir();
  const r = run(planFile(d, [['one', 'first', 'true'], ['two', 'second', `touch ${d}/two-ran`]]));
  assert.equal(r.rc, 0, r.out);
  assert.match(r.out, /^PASS  one\s/m);
  assert.match(r.out, /^PASS  two\s/m);
  assert.match(r.out, /all 2 steps passed/);
  assert.ok(fs.existsSync(`${d}/two-ran`));
});

test('a red step fails the script, names the step, shows its log, and the steps after it still run', () => {
  const d = tmpdir();
  const r = run(planFile(d, [['one', 'first', 'true'], ['bad', 'a red guard', 'echo the-red-reason; exit 3'],
    ['three', 'third', `touch ${d}/three-ran`]]));
  assert.equal(r.rc, 1, r.out);
  assert.match(r.out, /^FAIL  bad\s.*a red guard \(exit 3\)/m);
  assert.match(r.out, /^PASS  three\s/m);
  assert.match(r.out, /the-red-reason/);
  assert.match(r.out, /1 of 3 steps RED/);
  assert.ok(fs.existsSync(`${d}/three-ran`));
});

test('MUTANT: a runner that does not count a red step passes the red plan, so the test above can fail', () => {
  const d = tmpdir();
  const src = fs.readFileSync(RUNNER, 'utf8');
  assert.ok(src.includes('RED=$((RED + 1))'), 'the line this mutant removes is in the runner');
  fs.mkdirSync(path.join(d, 'scripts/lanes'), { recursive: true });
  const mutant = path.join(d, 'scripts/lanes/preflight.sh');
  fs.writeFileSync(mutant, src.replace('RED=$((RED + 1))', ':'));
  const r = run(planFile(d, [['bad', 'a red guard', 'exit 3']]), {}, mutant);
  assert.equal(r.rc, 0, 'the mutant lets the red through');
  const real = run(planFile(d, [['bad', 'a red guard', 'exit 3']]));
  assert.equal(real.rc, 1, 'the real runner does not');
});

test('a step that reads stdin gets nothing and cannot eat the plan', () => {
  const d = tmpdir();
  const r = run(planFile(d, [['reader', 'reads stdin', 'cat'], ['after', 'after', `touch ${d}/after-ran`]]));
  assert.equal(r.rc, 0, r.out);
  assert.ok(fs.existsSync(`${d}/after-ran`));
});

test('--plan prints the steps and runs none', () => {
  const d = tmpdir();
  const r = run(planFile(d, [['one', 'first', `touch ${d}/ran`]]), {}, RUNNER, ['--plan']);
  assert.equal(r.rc, 0, r.out);
  assert.match(r.out, /one\s+first/);
  assert.ok(!fs.existsSync(`${d}/ran`));
});

test('an empty plan is no pass', () => {
  const d = tmpdir();
  const f = path.join(d, 'plan.tsv');
  fs.writeFileSync(f, '');
  assert.equal(run(f).rc, 2);
});

test('the heavy-test lock held past the budget: exit 75, the step never ran, the lock left exactly as it was', () => {
  const d = tmpdir();
  const lock = path.join(d, 'heavy-test.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner'), 'someone else');
  const r = run(planFile(d, [['one', 'first', `touch ${d}/ran`]]),
    { PREFLIGHT_LOCK: lock, PREFLIGHT_LOCK_WAIT_SECS: '1', PREFLIGHT_LOCK_POLL_SECS: '1' });
  assert.equal(r.rc, 75, r.out);
  assert.match(r.out, /NOT RUN/);
  assert.ok(!fs.existsSync(`${d}/ran`));
  assert.equal(fs.readFileSync(path.join(lock, 'owner'), 'utf8'), 'someone else');
});

test('a red before the lock stops the run is still reported as red (exit 1, not 75)', () => {
  const d = tmpdir();
  const lock = path.join(d, 'heavy-test.lock');
  const r = run(planFile(d, [['bad', 'red', `mkdir ${lock}; exit 4`], ['two', 'second', `touch ${d}/two-ran`]]),
    { PREFLIGHT_LOCK: lock, PREFLIGHT_LOCK_WAIT_SECS: '1', PREFLIGHT_LOCK_POLL_SECS: '1' });
  assert.equal(r.rc, 1, r.out);
  assert.match(r.out, /^FAIL  bad/m);
  assert.ok(!fs.existsSync(`${d}/two-ran`));
});

test('the step waits while the lock is held and runs once it is gone', async () => {
  const d = tmpdir();
  const lock = path.join(d, 'heavy-test.lock');
  fs.mkdirSync(lock);
  const child = spawn('bash', [RUNNER], { env: { ...process.env, PREFLIGHT_PLAN_FILE: planFile(d, [['one', 'first', `touch ${d}/ran`]]),
    PREFLIGHT_LOCK: lock, PREFLIGHT_LOCK_WAIT_SECS: '30', PREFLIGHT_LOCK_POLL_SECS: '1' } });
  let out = '';
  child.stdout.on('data', b => { out += b; });
  await new Promise(r => setTimeout(r, 1500));
  assert.ok(!fs.existsSync(`${d}/ran`), 'not run while the lock is held');
  fs.rmdirSync(lock);
  const rc = await new Promise(r => child.on('close', r));
  assert.equal(rc, 0, out);
  assert.match(out, /waiting: the heavy-test lock is held/);
  assert.ok(fs.existsSync(`${d}/ran`));
});
